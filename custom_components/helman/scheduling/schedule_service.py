"""The stored schedule: its lock, its one prune, its writes and its executor."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from datetime import datetime
from typing import TYPE_CHECKING

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..automation.ownership import (
    merge_automation_result,
    strip_automation_owned_actions,
)
from ..const import SCHEDULE_SLOT_MINUTES
from .runtime_status import schedule_execution_status_to_dict
from .schedule import (
    ScheduleActionSetBy,
    ScheduleControlConfig,
    ScheduleDocument,
    ScheduleError,
    ScheduleExecutionUnavailableError,
    ScheduleResponseDict,
    ScheduleSlot,
    apply_slot_patches,
    build_horizon_start,
    format_slot_id,
    materialize_schedule_slots,
    normalize_schedule_document_for_registry,
    normalize_slot_patch_request,
    prune_expired_slots,
    schedule_document_from_dict,
    schedule_document_to_dict,
    slot_to_dict,
    with_slot_set_by,
)
from .schedule_executor import ScheduleExecutor, ScheduleExecutorDependencies

if TYPE_CHECKING:
    from ..appliances.registry_holder import AppliancesRegistryHolder
    from ..battery_state import BatteryLiveState, BatterySocBounds
    from ..storage import HelmanStorage

# Logged under the coordinator's name, where these lines have always appeared:
# log filters, and the schedule execution tests, key on it.
_LOGGER = logging.getLogger(f"{__package__.rpartition('.')[0]}.coordinator")


class ScheduleService:
    """The schedule document, the lock serializing it, and the executor.

    **Lock discipline.** ``asyncio.Lock`` is not reentrant, so every method
    belongs to exactly one of three groups:

    - *Takes the lock*: :meth:`locked`, :meth:`read`, :meth:`get`,
      :meth:`set_slots`, :meth:`set_execution`,
      :meth:`cleanup_automation_owned_actions`. Never call one of these while
      holding :meth:`locked`.
    - *Requires the lock*: :meth:`save` and :meth:`persist_automation_result`.
      Call them only inside ``async with schedule.locked(...)``; they never take
      it themselves.
    - *Lock-free*: :meth:`load`, :meth:`request_reconcile`, :meth:`async_start`,
      :meth:`async_unload`, :meth:`async_normalize` (setup only, before anything
      else can hold the lock).

    The writes never call the forecast side back: the forecast pipeline cache
    keys on the schedule signature, so the next read rebuilds only when what it
    draws actually changed.
    """

    def __init__(
        self,
        hass: HomeAssistant,
        storage: HelmanStorage,
        registry: AppliancesRegistryHolder,
        *,
        read_battery_soc_bounds: Callable[[], BatterySocBounds | None],
        announce_changed: Callable[[], None],
        read_control_config: Callable[[], ScheduleControlConfig | None],
        read_battery_state: Callable[[], BatteryLiveState | None],
        check_reality_and_maybe_replan: Callable[[datetime], Awaitable[bool]],
    ) -> None:
        self._storage = storage
        self._registry = registry
        self._read_battery_soc_bounds = read_battery_soc_bounds
        self._announce_changed = announce_changed
        self._lock = asyncio.Lock()
        # Guards execution-flag transitions only; never held while the executor
        # or hardware is awaited.
        self._execution_lock = asyncio.Lock()
        # Bumped by every flag transition -- enable, disable, and a failed
        # enable's rollback -- so a failed enable only rolls the flag back when
        # no newer transition has been made since.
        self._execution_generation = 0
        self.executor = ScheduleExecutor(
            hass,
            ScheduleExecutorDependencies(
                read_schedule_document=self.read,
                load_schedule_document=self.load,
                read_schedule_control_config=read_control_config,
                read_battery_state=read_battery_state,
                read_appliances_registry=lambda: registry.current,
                check_reality_and_maybe_replan=check_reality_and_maybe_replan,
                announce_schedule_changed=announce_changed,
            ),
        )

    # -- lock-scoped reads ---------------------------------------------------

    @asynccontextmanager
    async def locked(self, reference_time: datetime) -> AsyncIterator[ScheduleDocument]:
        """Hold the schedule lock and yield the pruned document as of ``reference_time``."""
        async with self._lock:
            yield await self._load_pruned_locked(reference_time)

    async def read(self, reference_time: datetime) -> ScheduleDocument:
        """The pruned document as of ``reference_time``; the lock is released on return."""
        async with self.locked(reference_time) as document:
            return document

    def load(self) -> ScheduleDocument:
        """The stored document as it is: not pruned, not normalized, lock-free."""
        return schedule_document_from_dict(self._storage.schedule_document)

    def _prune(self, reference_time: datetime) -> tuple[ScheduleDocument, ScheduleDocument]:
        """The one prune: (stored document, document every reader works from).

        Every reader -- the card, the forecast, the automation run and the
        executor -- sees the stored document normalized against the current
        appliance registry (actions for appliances no longer configured are
        dropped, and a slot left empty goes with them) and with every slot
        that has ended removed.
        """
        self._registry.refresh()
        loaded_document = self.load()
        normalized_document = normalize_schedule_document_for_registry(
            loaded_document,
            appliances_registry=self._registry.current,
        )
        pruned_document = ScheduleDocument(
            execution_enabled=normalized_document.execution_enabled,
            slots=prune_expired_slots(
                stored_slots=normalized_document.slots,
                reference_time=reference_time,
            ),
        )
        return loaded_document, pruned_document

    async def _load_pruned_locked(self, reference_time: datetime) -> ScheduleDocument:
        loaded_document, pruned_document = self._prune(reference_time)
        if pruned_document != loaded_document:
            # Quietly: dropping what has expired changes nothing a card draws.
            await self.save(pruned_document, notify=False)
        return pruned_document

    # -- writes that require the lock ----------------------------------------

    async def save(self, document: ScheduleDocument, *, notify: bool = True) -> None:
        """Persist ``document``. The caller holds :meth:`locked`."""
        await self._storage.async_save_schedule_document(
            schedule_document_to_dict(document)
        )
        if notify:
            self._announce_changed()

    async def persist_automation_result(
        self,
        *,
        automation_result: ScheduleDocument,
        reference_time: datetime | None = None,
    ) -> bool:
        """Merge an automation run's plan into the stored document.

        The caller holds :meth:`locked`. Returns whether anything was written.
        """
        request_now = reference_time or dt_util.now()
        latest_document = await self._load_pruned_locked(request_now)
        normalized_automation_result = self._normalize_for_strict_write(
            ScheduleDocument(
                execution_enabled=latest_document.execution_enabled,
                slots=automation_result.slots,
            ),
            reference_time=request_now,
        )
        merged_document = merge_automation_result(
            baseline=latest_document,
            automation_result=normalized_automation_result,
        )
        canonical_document = normalize_schedule_document_for_registry(
            merged_document,
            appliances_registry=self._registry.current,
        )
        if canonical_document == latest_document:
            return False

        await self.save(canonical_document)
        return True

    def _normalize_for_strict_write(
        self,
        schedule_document: ScheduleDocument,
        *,
        reference_time: datetime,
    ) -> ScheduleDocument:
        if not schedule_document.slots:
            return ScheduleDocument(
                execution_enabled=schedule_document.execution_enabled,
                slots={},
            )

        normalized_slots = normalize_slot_patch_request(
            slots=[
                ScheduleSlot(id=slot_id, controllables=actions)
                for slot_id, actions in schedule_document.slots.items()
            ],
            reference_time=reference_time,
            battery_soc_bounds=self._read_battery_soc_bounds(),
            appliances_registry=self._registry.current,
        )
        return ScheduleDocument(
            execution_enabled=schedule_document.execution_enabled,
            slots=apply_slot_patches(stored_slots={}, slot_patches=normalized_slots),
        )

    # -- requests that take the lock -----------------------------------------

    async def get(self, *, reference_time: datetime | None = None) -> ScheduleResponseDict:
        request_now = reference_time or dt_util.now()
        return self._response(await self.read(request_now), reference_time=request_now)

    async def set_slots(
        self,
        *,
        slots: Sequence[ScheduleSlot],
        reference_time: datetime,
        set_by: ScheduleActionSetBy | None = None,
    ) -> tuple[ScheduleResponseDict, bool]:
        """Patch ``slots`` into the document; returns (response, whether it changed)."""
        document_changed = False
        async with self.locked(reference_time) as schedule_document:
            normalized_slots = normalize_slot_patch_request(
                slots=slots,
                reference_time=reference_time,
                battery_soc_bounds=self._read_battery_soc_bounds(),
                appliances_registry=self._registry.current,
            )
            stamped_slots = [
                with_slot_set_by(slot, set_by=set_by) for slot in normalized_slots
            ]
            updated_document = ScheduleDocument(
                execution_enabled=schedule_document.execution_enabled,
                slots=apply_slot_patches(
                    stored_slots=schedule_document.slots,
                    slot_patches=stamped_slots,
                ),
            )
            if updated_document != schedule_document:
                await self.save(updated_document)
                document_changed = True
            response = self._response(updated_document, reference_time=reference_time)
        return response, document_changed

    async def set_execution(
        self,
        *,
        enabled: bool,
        reference_time: datetime | None = None,
    ) -> tuple[ScheduleResponseDict, bool]:
        """Switch execution on or off.

        Returns the response and whether this request made the off-to-on
        transition that is still the newest one -- the caller's cue to plan
        right away.
        """
        request_now = reference_time or dt_util.now()

        # Only the flag transition is serialized. The enable reconcile below is
        # awaited outside this lock, so a disable issued while hardware is slow
        # still persists at once.
        async with self._execution_lock:
            async with self.locked(request_now) as current_document:
                was_enabled = current_document.execution_enabled

                if enabled and not self.executor.is_running:
                    # Home Assistant is still starting (or the entry is going
                    # away): nothing could validate an enable now. Decide before
                    # touching storage; an already-enabled flag is applied by
                    # the startup reconcile anyway.
                    if was_enabled:
                        return (
                            self._response(current_document, reference_time=request_now),
                            False,
                        )
                    raise ScheduleExecutionUnavailableError(
                        "Schedule execution is not running yet; try again once "
                        "Home Assistant has started"
                    )

                if enabled and not was_enabled:
                    await self.save(
                        ScheduleDocument(
                            execution_enabled=True,
                            slots=current_document.slots,
                        )
                    )
            # Only a real flag change is a newer decision: a repeated enable
            # must not cancel the rollback of the first one still in flight.
            if enabled != was_enabled:
                self._execution_generation += 1
            generation = self._execution_generation

            if not enabled:
                # Disabling execution is passive: Helman stops touching hardware
                # and leaves the inverter and every appliance exactly as they
                # are. The user restores normal state explicitly, whenever they
                # choose, via the scheduling card. Disabling therefore cannot
                # fail and never rolls back.
                #
                # The executor keeps running so its tick still drives the
                # pre-execution reality check; it just stops applying anything.
                # Runtime status is dropped right away so the card does not keep
                # showing what was executing a moment ago.
                self.executor.reset_runtime()

                if not was_enabled:
                    return (
                        self._response(current_document, reference_time=request_now),
                        False,
                    )

                await self._persist_execution_disabled(reference_time=request_now)
                return await self.get(reference_time=request_now), False

        try:
            await self.executor.async_reconcile_and_wait(reason="enable_request")
        except ScheduleError as err:
            if generation != self._execution_generation:
                # A newer flag change superseded this request -- typically a
                # disable, whose gate then aborted this attempt. Its outcome is
                # moot; report the flag as persisted, as the success path does.
                _LOGGER.debug(
                    "Superseded enable reconcile ended with: %s (%s)",
                    err,
                    err.code,
                )
                return await self.get(reference_time=reference_time), False
            if not was_enabled:
                _LOGGER.warning(
                    "Failed to enable schedule execution: %s (%s); rolling back persisted execution flag",
                    err,
                    err.code,
                )
                await self._roll_back_failed_enable(
                    generation=generation,
                    reference_time=request_now,
                )
            else:
                _LOGGER.warning(
                    "Failed to reconcile already-enabled schedule execution: %s (%s)",
                    err,
                    err.code,
                )
            raise
        # Report the flag as persisted, not as requested: a disable or another
        # enable's rollback may have landed while this one waited on hardware.
        # A fresh clock, not `request_now`: the reconcile above may have run
        # across a slot edge.
        response = await self.get(reference_time=reference_time)
        # Announce only the enable that made the transition, and only if no
        # newer transition has superseded it.
        transitioned_on = (
            response["executionEnabled"]
            and not was_enabled
            and generation == self._execution_generation
        )
        return response, transitioned_on

    async def _persist_execution_disabled(self, *, reference_time: datetime) -> None:
        """Persist ``executionEnabled=false``; caller holds the flag lock."""
        async with self.locked(reference_time) as latest_document:
            if latest_document.execution_enabled:
                # Keep the plan intact: automation keeps planning while
                # execution is off, so the card and the inspectors show what
                # Helman would be doing. Only the apply step is suppressed.
                await self.save(
                    ScheduleDocument(
                        execution_enabled=False,
                        slots=latest_document.slots,
                    )
                )

    async def _roll_back_failed_enable(
        self,
        *,
        generation: int,
        reference_time: datetime,
    ) -> None:
        async with self._execution_lock:
            # A newer enable or disable has decided the flag since; this old
            # failure must not undo it.
            if generation != self._execution_generation:
                return
            # The rollback is itself a flag transition: an overlapping enable
            # still waiting must report the persisted state, not success.
            # Bumped before the save, which yields on disk I/O, so such a
            # waiter sees the transition however it interleaves with it.
            self._execution_generation += 1
            await self._persist_execution_disabled(reference_time=reference_time)
            self.executor.reset_runtime()

    async def cleanup_automation_owned_actions(self, *, reference_time: datetime) -> bool:
        """Strip every automation-owned action; returns whether anything was written."""
        async with self.locked(reference_time) as schedule_document:
            cleaned_document = ScheduleDocument(
                execution_enabled=schedule_document.execution_enabled,
                slots=strip_automation_owned_actions(schedule_document).slots,
            )
            if cleaned_document == schedule_document:
                return False
            await self.save(cleaned_document)
            return True

    def _response(
        self,
        schedule_document: ScheduleDocument,
        *,
        reference_time: datetime,
    ) -> ScheduleResponseDict:
        response: ScheduleResponseDict = {
            "executionEnabled": schedule_document.execution_enabled,
            "slotMinutes": SCHEDULE_SLOT_MINUTES,
            "slots": [
                slot_to_dict(slot)
                for slot in materialize_schedule_slots(
                    stored_slots=schedule_document.slots,
                    reference_time=reference_time,
                )
            ],
        }
        if schedule_document.execution_enabled:
            current_slot_id = format_slot_id(build_horizon_start(reference_time))
            execution_status = self.executor.get_execution_status()
            if execution_status.active_slot_id == current_slot_id:
                runtime = schedule_execution_status_to_dict(execution_status)
                if runtime is not None:
                    response["runtime"] = runtime
        return response

    # -- lock-free -----------------------------------------------------------

    def request_reconcile(self, *, reason: str) -> None:
        """Ask the executor to apply the schedule, without waiting for it.

        A write is already persisted when this is called; execution is only
        requested, so a websocket reply or automation run never waits behind
        hardware. The worker reads the time and the schedule afresh when it
        starts.
        """
        self.executor.request_reconcile(reason=reason)

    async def async_start(self) -> None:
        await self.executor.async_start()
        self.executor.request_reconcile(reason="startup")

    async def async_unload(self) -> None:
        await self.executor.async_unload()

    async def async_normalize(self) -> None:
        """Bring the stored document in line with the registry at setup."""
        self._registry.refresh()
        raw_document = self._storage.schedule_document
        if raw_document is None:
            return

        try:
            schedule_document = normalize_schedule_document_for_registry(
                schedule_document_from_dict(raw_document),
                appliances_registry=self._registry.current,
            )
        except ScheduleError as err:
            # The slots are what became incompatible; whether the user had
            # execution switched on is a preference, not slot data, and losing
            # it would silently stop the automation after an upgrade.
            execution_enabled = (
                raw_document.get("executionEnabled")
                if isinstance(raw_document, Mapping)
                else None
            )
            _LOGGER.warning(
                "Resetting persisted schedule slots because they are invalid or "
                "do not match the configured slot duration (execution stays %s): %s",
                "on" if execution_enabled is True else "off",
                err,
            )
            await self.save(ScheduleDocument(execution_enabled=execution_enabled is True))
            return

        if schedule_document_to_dict(schedule_document) != raw_document:
            await self.save(schedule_document)
