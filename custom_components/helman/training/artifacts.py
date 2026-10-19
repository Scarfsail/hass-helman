"""The training artifacts store and the state adopted from it."""

from __future__ import annotations

import functools
from collections.abc import Awaitable, Callable, Coroutine
from typing import TYPE_CHECKING, Any, NamedTuple

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..consumption_forecast_profiles import HouseConsumptionProfile, profile_from_dict
from ..storage import TrainingArtifactsStore
from .appliance_energy import (
    ApplianceEnergyTrainingJob,
    ApplianceEnergyTrainingRequest,
)
from .house_consumption import HouseConsumptionTrainingJob, HouseTrainingRequest

if TYPE_CHECKING:
    from .batch import TrainingBatch

# When a stored house consumption profile is due for a refit. Long on purpose:
# the batch runs nightly, so anything under two days is a slipped timer rather
# than a fault, and the profile keeps being served either way.
_HOUSE_PROFILE_STALE_AFTER_SECONDS = 48 * 3600


class _Adoption(NamedTuple):
    """One store section's policy, run by the plumbing they share."""

    #: Adopt the stored section; return why a refit is due, or None.
    adopt: Callable[[], str | None]
    #: The batch entry point that refits the section.
    refit: Callable[[TrainingBatch], Callable[..., Coroutine[Any, Any, None]]]
    #: The forecast refresh reason once a fresh result has been adopted.
    adopted_reason: str


class TrainingArtifacts:
    """What the training batch persisted, and what this entry serves from it.

    One plumbing, two policies. Each section is adopted from the store at
    setup and again whenever its job finishes, and a refit is scheduled when
    adoption says one is due. The policies differ on purpose: the house
    profile has an expiry arm and is blanked on a fingerprint change; the
    appliance estimates are kept and also carry the shared-meter weights. See
    each ``_apply_*_policy`` method.

    Lives as long as its entry: a reload builds a new one that adopts from the
    store again, so nothing adopted outlives a config change.
    """

    def __init__(
        self,
        hass: HomeAssistant,
        *,
        read_house_request: Callable[[], HouseTrainingRequest],
        read_house_fingerprint: Callable[[], str],
        read_appliance_request: Callable[[], ApplianceEnergyTrainingRequest],
        training_batch: Callable[[], TrainingBatch | None],
        run_when_started: Callable[[Callable[[], Coroutine[Any, Any, Any]]], None],
        on_adopted: Callable[[str], Awaitable[None]],
    ) -> None:
        self.store = TrainingArtifactsStore(hass)
        #: What each fit should answer, read live per run.
        self.read_house_request = read_house_request
        #: Adoption needs only the fingerprint, not a whole request.
        self._read_house_fingerprint = read_house_fingerprint
        self.read_appliance_request = read_appliance_request
        self._training_batch = training_batch
        self._run_when_started = run_when_started
        #: Called once a job's fresh result has been adopted, so it shows up
        #: at once instead of at the next quarter hour.
        self._on_adopted = on_adopted
        # The fitted house consumption model the forecast is assembled from.
        # None means "nothing to serve".
        self.house_profile: HouseConsumptionProfile | None = None
        self.house_profile_trained_at: str | None = None
        self.house_profile_last_outcome: str = "no_training_yet"
        # Per-appliance average hourly energy while running, keyed by appliance
        # id. An appliance missing from the map — never trained, no usable
        # history, or on a fixed strategy — falls back to its configured
        # hourly_energy_kwh, which is what the resolvers did for a failed
        # estimate before this was stored at all.
        self.appliance_energy_estimates: dict[str, float] = {}
        # Each shared meter member's learned power in kW, adopted from the same
        # section: the ratio the live split shares a parent's own power in. A
        # member missing from it takes the others' mean, so before the first
        # fit lands the split is even.
        self.shared_meter_weights: dict[str, float | None] = {}
        self._house = _Adoption(
            adopt=self._apply_house_consumption_policy,
            refit=lambda batch: batch.async_run_house_consumption,
            adopted_reason="house_profile_trained",
        )
        self._appliance = _Adoption(
            adopt=self._apply_appliance_energy_policy,
            refit=lambda batch: batch.async_run_appliance_energy,
            adopted_reason="appliance_energy_trained",
        )
        self.house_consumption_job = HouseConsumptionTrainingJob(
            hass,
            self.store,
            read_request=read_house_request,
            on_trained=functools.partial(self._async_on_trained, self._house),
        )
        self.appliance_energy_job = ApplianceEnergyTrainingJob(
            hass,
            self.store,
            read_request=read_appliance_request,
            on_trained=functools.partial(self._async_on_trained, self._appliance),
        )

    @property
    def served_house_profile(
        self,
    ) -> tuple[HouseConsumptionProfile | None, str | None]:
        """The fitted house profile the forecast serves, and when it was trained."""
        return self.house_profile, self.house_profile_trained_at

    async def async_load(self) -> None:
        await self.store.async_load()

    def adopt_house_consumption(self) -> str | None:
        """Adopt the stored house profile and schedule a refit when one is due.

        A config save is a restart (ws_save_config -> async_reload ->
        async_setup), which is why this one path covers startup and config
        save both, and why there is no config-save handler anywhere.
        """
        return self._adopt_and_refit(self._house)

    def adopt_appliance_energy(self) -> str | None:
        """Adopt the stored estimates and schedule a refit when one is due."""
        return self._adopt_and_refit(self._appliance)

    async def async_reload(self) -> None:
        """Re-read the store and adopt both sections, scheduling no refit.

        For artifacts a superseded entry's run wrote after this one loaded.
        """
        await self.store.async_load()
        self._house.adopt()
        self._appliance.adopt()

    def _adopt_and_refit(self, adoption: _Adoption) -> str | None:
        reason = adoption.adopt()
        if reason is not None:
            self._schedule_refit(adoption, reason)
        return reason

    def _schedule_refit(self, adoption: _Adoption, reason: str) -> None:
        """Refit once Home Assistant has finished starting.

        Deferred rather than run here. The fits read other integrations'
        entities, and on a cold start those may not be registered yet — the
        house job would see ``hass.states.get()`` return ``None``, record
        ``entity_missing``, and leave the house forecast unavailable until the
        next nightly run (observed in practice: the entity appeared about
        eighty seconds after setup); the appliance estimates would come back
        empty rather than wrong, silently pinning every appliance to its fixed
        figure for the day.

        When Home Assistant is already running — a config save reloads the
        entry — ``async_at_started`` fires immediately, so **G3** is unaffected.

        Never awaited either way: startup must not block on a multi-day
        recorder read, and the batch's single flight keeps this from colliding
        with the nightly run.
        """
        batch = self._training_batch()
        if batch is None:
            return
        self._run_when_started(functools.partial(adoption.refit(batch), reason=reason))

    async def _async_on_trained(self, adoption: _Adoption) -> None:
        """Adopt what the job just wrote, then let the forecast rebuild.

        Re-read from the store rather than handed the result directly: the
        store is where the preserve-the-previous-result-on-failure rule lives,
        so reading it back is the only way the in-memory state agrees with what
        a failed run decided.
        """
        adoption.adopt()
        await self._on_adopted(adoption.adopted_reason)

    def _apply_house_consumption_policy(self) -> str | None:
        """Adopt the stored house profile; return why a refit is due, or None.

        Three cases, and they are not the same case:

        * missing (or unreadable) — nothing to serve, refit;
        * fingerprint-stale — the stored profile answers a question the user
          has since changed, so it is blanked to make the change visible;
        * older than 48 h — keep serving it, a 56-day fit does not become
          wrong because it missed a night, and refit in the background.

        The fingerprint is the house forecast request's, the very one the
        persisted forecast snapshot is checked against, so the profile and the
        snapshot can never disagree about what is stale.
        """
        self.house_profile = None
        self.house_profile_trained_at = None
        self.house_profile_last_outcome = "no_training_yet"

        section = self.store.house_consumption
        if section is None:
            return "no_stored_profile"

        last_outcome = section.get("last_outcome")
        if isinstance(last_outcome, str):
            self.house_profile_last_outcome = last_outcome

        if section.get("fingerprint") != self._read_house_fingerprint():
            return "config_changed"

        profile = profile_from_dict(section.get("data"))
        if profile is None:
            return "unreadable_profile"

        self.house_profile = profile
        trained_at = section.get("trained_at")
        self.house_profile_trained_at = (
            trained_at if isinstance(trained_at, str) else None
        )
        if _is_house_profile_expired(self.house_profile_trained_at):
            return "profile_expired"
        return None

    def _apply_appliance_energy_policy(self) -> str | None:
        """Adopt the stored estimates; return why a refresh is due, or None.

        Mirrors ``_apply_house_consumption_policy``, minus the expiry arm: a 30-day
        average of energy-while-running does not go stale on a clock the way a
        house profile does, and the nightly run refreshes it anyway. What is
        left is missing (nothing trained yet) and fingerprint-stale (the
        appliance set, its entities or a lookback window changed).

        A fingerprint change does **not** blank the estimates the way a stale
        house profile is blanked. The map is keyed per appliance, so the entries
        for appliances that did not change are still right, and dropping them
        would push those appliances onto their fixed fallback for no reason
        until the refit lands. The same holds for the shared-meter weights,
        keyed per member.
        """
        self.appliance_energy_estimates = {}
        self.shared_meter_weights = {}

        section = self.store.appliance_energy
        if section is None:
            # A config with no history_average appliance still refits: the job
            # records "not_configured" against the current fingerprint, which is
            # what stops this from rescheduling a refit on every restart.
            return "no_stored_estimates"

        data = section.get("data")
        if isinstance(data, dict):
            self.appliance_energy_estimates = {
                appliance_id: float(value)
                for appliance_id, value in data.items()
                if isinstance(appliance_id, str)
                and isinstance(value, (int, float))
                and not isinstance(value, bool)
                and value > 0
            }

        weights = section.get("shared_meter_weights")
        if isinstance(weights, dict):
            self.shared_meter_weights = {
                member_id: float(value)
                if isinstance(value, (int, float))
                and not isinstance(value, bool)
                and value >= 0
                else None
                for member_id, value in weights.items()
                if isinstance(member_id, str)
            }

        if section.get("fingerprint") != self.read_appliance_request().fingerprint:
            return "config_changed"
        return None


def _is_house_profile_expired(trained_at: str | None) -> bool:
    trained_at_dt = (
        dt_util.parse_datetime(trained_at) if isinstance(trained_at, str) else None
    )
    if trained_at_dt is None:
        return True
    age = (
        dt_util.as_utc(dt_util.now()) - dt_util.as_utc(trained_at_dt)
    ).total_seconds()
    return age > _HOUSE_PROFILE_STALE_AFTER_SECONDS
