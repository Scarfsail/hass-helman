"""What each controllable kind is — one declaration per kind, read by everyone.

Helman drives four kinds of thing: the inverter, and the ``climate`` /
``ev_charger`` / ``generic`` appliances. Until this registry existed that fact
was written nowhere. It was *implied* by four config readers, four executors and
a handful of ``getattr`` probes that guessed at a runtime object's shape, so
nothing could iterate over the kinds and every new consumer grew its own fork on
"is this the inverter or an appliance?".

This mirrors :mod:`..automation.spec`, which records the same lesson for
optimizer kinds: a kind is a *declaration*, not a set of parallel
implementations. The registry is closed — no plugin loading, no dynamic
registration, no user-defined kinds. Adding a fifth kind is an entry here plus
its executor.

**What lives here and what does not.** The registry describes a kind: where to
find its control entity on a runtime object, what counts as at rest, and what it
affects. For an appliance kind it also names the kind's behaviour — its config
reader, action normalizer, running predicate, roster metadata, projection config
and driver — so a caller asks :func:`spec_for` instead of forking on the runtime
type. The implementations stay in the kind's own modules, which import nothing
from here; the decision logic of the executors stays in the executors.

``affects_consumption``
    Only the appliance kinds appear in
    :func:`..appliances.projection_builder.build_appliance_projection_plan`, and
    only they carry the projection config (``hourly_energy_kwh``, history
    averaging) it needs. The inverter has no demand of its own to project.

``optimizer_kinds``
    Which optimizer kinds may target this controllable kind. Enforced by
    ``_validate_automation_config``, which reads it through
    :func:`controllable_kinds_for_optimizer_kind` — so "what the editor offers"
    and "what validation accepts" come from this one table. Note ``ev_charger``
    accepts nothing: ``resolve_appliance_target`` (``automation/base.py``)
    authors an action only for generic and climate appliances and rejects
    everything else, so no optimizer can target a charger. Enforcing the flag
    turns that build-time failure into a config finding, which is the point;
    making chargers automatable is a feature, not a flag flip.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ..appliances.climate_appliance import (
    build_climate_appliance_metadata_dict,
    read_climate_appliance,
)
from ..appliances.climate_schedule import (
    is_climate_action_running,
    climate_action_from_state,
    normalize_climate_appliance_schedule_action,
)
from ..appliances.drivers import (
    ApplianceDriverOptions,
    ClimateApplianceDriver,
    EvChargerDriver,
    GenericApplianceDriver,
)
from ..appliances.ev_charger import (
    build_ev_charger_metadata_dict,
    read_ev_charger_appliance,
)
from ..appliances.ev_schedule import (
    is_ev_charger_action_running,
    ev_action_from_state,
    normalize_ev_charger_schedule_action,
)
from ..appliances.generic_appliance import (
    build_generic_appliance_metadata_dict,
    read_generic_appliance,
)
from ..appliances.generic_schedule import (
    is_generic_action_running,
    generic_action_from_state,
    normalize_generic_appliance_schedule_action,
)
from .inverter import inverter_action_from_state
from .config import RUNNING_ACTIVITY_BY_CONTROL
from .kinds import (
    CONTROLLABLE_KIND_CLIMATE,
    CONTROLLABLE_KIND_EV_CHARGER,
    CONTROLLABLE_KIND_GENERIC,
    CONTROLLABLE_KIND_INVERTER,
)

if TYPE_CHECKING:
    from ..appliances._read import ProjectionConfig
    from ..appliances.drivers import ApplianceActionDriver


def _no_projection(runtime: Any) -> None:
    return None


def _projection_config(runtime: Any) -> ProjectionConfig:
    return runtime.projection


@dataclass(frozen=True)
class ControllableSpec:
    """One kind of thing Helman can drive.

    Two halves. The declarative half names attributes read off whichever
    object carries this kind's runtime state:
    :class:`..scheduling.schedule.ScheduleControlConfig` for the inverter, and
    the per-kind appliance runtime dataclass otherwise. The behavioural half,
    set only for appliance kinds, points at callables in the kind's own modules
    — its config reader, action normalizer, running predicate, roster
    metadata, projection config and driver factory — so a caller asks the spec
    instead of forking on the runtime type.
    """

    kind: str
    #: The attribute holding the entity whose state says whether this
    #: controllable is running. Replaces probing a runtime object for whichever
    #: of ``climate_entity_id`` / ``charge_entity_id`` / ``switch_entity_id``
    #: happens to exist.
    control_entity_attr: str
    #: Inverse mapping for recorder states; includes only observed settings.
    action_from_state: Callable[[Any, str], dict[str, Any] | None]
    #: Resting state, as "the attribute that holds it, falling back to a
    #: constant". The two halves cover the three real cases in one shape: the
    #: inverter's rest is configured (``normal_option``, no default — an
    #: inverter without one is not a valid control config); climate's is
    #: configured with a fallback (``stop_hvac_mode``, else off); everything
    #: else is simply off.
    resting_state_attr: str | None = None
    resting_state_default: str | None = None
    #: Shown when the runtime object carries no ``name`` of its own. Only the
    #: inverter needs it — it is a singleton the user never named.
    default_name: str | None = None
    #: See the module docstring — these record verified asymmetries, not
    #: guesses about which kind feels more like an appliance.
    affects_consumption: bool = False
    optimizer_kinds: tuple[str, ...] = ()
    #: The device ``controls`` key whose entity says this kind is running —
    #: the key :func:`.config.running_signal` reads, whose activity comes from
    #: :data:`.config.RUNNING_ACTIVITY_BY_CONTROL`.
    running_control: str | None = None

    # An appliance kind's behaviour; the inverter has its own reader and
    # executor and declares none of it.

    #: ``read(config, *, path)``: the kind's runtime from its config entry.
    read: Callable[..., Any] | None = None
    #: ``normalize_action(value, *, appliance, context, mode)``: one slot
    #: action, validated against the appliance it is for.
    normalize_action: Callable[..., Any] | None = None
    #: Whether a normalized action means "this appliance is running" — the one
    #: definition the snapshot readers, the driver, the projection builder and
    #: the projected-history filter all ask.
    is_running: Callable[[Mapping[str, Any]], bool] | None = None
    #: ``metadata(runtime, roster)``: the kind's ``helman/get_appliances`` entry.
    metadata: Callable[..., Any] | None = None
    #: The runtime's projection config, or ``None`` for a kind not projected
    #: at a constant hourly rate: the EV charger follows the solar surplus.
    projection: Callable[[Any], ProjectionConfig | None] = _no_projection
    #: Builds the kind's executor driver.
    driver: Callable[[ApplianceDriverOptions], ApplianceActionDriver] | None = None

    def running_signal(self, runtime: Any) -> tuple[str, str] | None:
        """``(entity id, running activity)`` telling when ``runtime`` runs.

        The runtime counterpart of :func:`.config.running_signal`, which reads
        the same pair off a raw device.
        """
        entity_id = self.control_entity_id(runtime)
        if entity_id is None or self.running_control is None:
            return None
        return entity_id, RUNNING_ACTIVITY_BY_CONTROL[self.running_control]

    def control_entity_id(self, source: Any) -> str | None:
        """The entity that decides whether this controllable is running."""
        entity_id = getattr(source, self.control_entity_attr, None)
        if isinstance(entity_id, str) and entity_id:
            return entity_id
        return None

    def resting_state(self, source: Any) -> str | None:
        """The state that counts as "at rest" for this configured instance."""
        if self.resting_state_attr is None:
            return self.resting_state_default
        value = getattr(source, self.resting_state_attr, None)
        if isinstance(value, str) and value:
            return value
        return self.resting_state_default

    def name(self, source: Any) -> str | None:
        """What to call this instance in the UI."""
        value = getattr(source, "name", None)
        if isinstance(value, str) and value:
            return value
        return self.default_name

    def action_options(self, source: Any) -> dict[str, str]:
        """The option each schedule action kind selects, for configured ones.

        Action kinds the installation configured no option for are left out
        rather than mapped to a placeholder, so a consumer can tell "not
        available here" apart from "selects this option".
        """
        options = getattr(source, "options", None)
        if isinstance(options, Mapping):
            return dict(options)
        return {}


CONTROLLABLE_SPECS: dict[str, ControllableSpec] = {
    spec.kind: spec
    for spec in (
        ControllableSpec(
            kind=CONTROLLABLE_KIND_INVERTER,
            control_entity_attr="mode_entity_id",
            action_from_state=inverter_action_from_state,
            resting_state_attr="normal_option",
            default_name="Inverter",
            optimizer_kinds=("charge_hold", "export_price", "charge_from_grid"),
        ),
        ControllableSpec(
            kind=CONTROLLABLE_KIND_CLIMATE,
            control_entity_attr="climate_entity_id",
            action_from_state=climate_action_from_state,
            resting_state_attr="stop_hvac_mode",
            resting_state_default="off",
            affects_consumption=True,
            optimizer_kinds=("appliance_runtime",),
            running_control="climate",
            read=read_climate_appliance,
            normalize_action=normalize_climate_appliance_schedule_action,
            is_running=is_climate_action_running,
            metadata=build_climate_appliance_metadata_dict,
            projection=_projection_config,
            driver=lambda options: ClimateApplianceDriver(),
        ),
        ControllableSpec(
            kind=CONTROLLABLE_KIND_EV_CHARGER,
            # The charge switch, not the use-mode or eco-gear selects: charging
            # is what makes a charger "running", the selects only shape how.
            control_entity_attr="charge_entity_id",
            action_from_state=ev_action_from_state,
            resting_state_default="off",
            affects_consumption=True,
            running_control="charge",
            read=read_ev_charger_appliance,
            normalize_action=normalize_ev_charger_schedule_action,
            is_running=is_ev_charger_action_running,
            metadata=build_ev_charger_metadata_dict,
            driver=lambda options: EvChargerDriver(
                charge_on_wait_seconds=options.charge_on_wait_seconds,
                poll_interval_seconds=options.poll_interval_seconds,
                sleep=options.sleep,
            ),
        ),
        ControllableSpec(
            kind=CONTROLLABLE_KIND_GENERIC,
            control_entity_attr="switch_entity_id",
            action_from_state=generic_action_from_state,
            resting_state_default="off",
            affects_consumption=True,
            optimizer_kinds=("appliance_runtime",),
            running_control="switch",
            read=read_generic_appliance,
            normalize_action=normalize_generic_appliance_schedule_action,
            is_running=is_generic_action_running,
            metadata=build_generic_appliance_metadata_dict,
            projection=_projection_config,
            driver=lambda options: GenericApplianceDriver(),
        ),
    )
}

KNOWN_CONTROLLABLE_KINDS: frozenset[str] = frozenset(CONTROLLABLE_SPECS)


def spec_for(kind: str) -> ControllableSpec:
    """The declaration of ``kind`` — what every per-kind fork asks instead."""
    return CONTROLLABLE_SPECS[kind]


def appliance_controllable_kinds() -> frozenset[str]:
    """The kinds that are appliances rather than the inverter.

    Derived from ``affects_consumption`` — the declared marker for "has demand
    of its own" — rather than from ``kind != inverter``, which is the guess this
    registry exists to stop. A fifth kind added to the table is classified by
    its own declaration, not by a list here.
    """
    return frozenset(
        spec.kind for spec in CONTROLLABLE_SPECS.values() if spec.affects_consumption
    )


def controllable_kinds_for_optimizer_kind(optimizer_kind: str) -> tuple[str, ...]:
    """Which controllable kinds an optimizer kind may drive, in registry order.

    The inverse of :attr:`ControllableSpec.optimizer_kinds`, computed rather
    than declared a second time: the two directions cannot disagree, and adding
    a kind stays one edit. Registry order rather than sorted, so the editor's
    target picker offers kinds in the order the registry lists them.

    An optimizer kind no controllable accepts gets an empty tuple — which reads
    as "nothing may be targeted" everywhere it is used, and is the honest answer
    rather than a lookup error.
    """
    return tuple(
        spec.kind
        for spec in CONTROLLABLE_SPECS.values()
        if optimizer_kind in spec.optimizer_kinds
    )
