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
affects. It deliberately does *not* own config reading — the per-kind readers
stay where they are and the ``controllables:`` config shape is a later phase —
nor the decision logic of the executors. It is the vocabulary, not the machinery.

The capability flags are not decoration; they record real, verified asymmetries:

``affects_battery``
    Only the inverter's actions reach :mod:`..battery_slot_simulation`. The
    simulator takes one ``ScheduleAction``, and every caller sources it from the
    slot's ``inverter`` entry — the forecast builder from the schedule map, the
    ``ensure_self_sustainability`` condition from the schedule overlay, which is
    built from the same field. An appliance moves the battery too, but only
    *indirectly*, by adding house demand — which is what ``affects_consumption``
    says. Nothing lets an appliance select an inverter mode.

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

from dataclasses import dataclass, field
from typing import Any

from ..const import (
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_NORMAL,
    SCHEDULE_ACTION_STOP_CHARGING,
    SCHEDULE_ACTION_STOP_DISCHARGING,
    SCHEDULE_ACTION_STOP_EXPORT,
)

CONTROLLABLE_KIND_INVERTER = "inverter"
CONTROLLABLE_KIND_CLIMATE = "climate"
CONTROLLABLE_KIND_EV_CHARGER = "ev_charger"
CONTROLLABLE_KIND_GENERIC = "generic"


@dataclass(frozen=True)
class ControllableSpec:
    """One kind of thing Helman can drive.

    The attribute names are read off whichever object carries this kind's
    runtime state: :class:`..scheduling.schedule.ScheduleControlConfig` for the
    inverter, and the per-kind appliance runtime dataclass otherwise. Naming
    attributes rather than holding accessor callables keeps the registry a plain
    data declaration that a test can read and a reviewer can check against the
    dataclasses in one pass.
    """

    kind: str
    #: The attribute holding the entity whose state says whether this
    #: controllable is running. Replaces probing a runtime object for whichever
    #: of ``climate_entity_id`` / ``charge_entity_id`` / ``switch_entity_id``
    #: happens to exist.
    control_entity_attr: str
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
    #: For a kind driven by picking an option on a select entity: which
    #: attribute supplies the option for each schedule action kind. Insertion
    #: order is the order the roster emits, so it is part of the wire payload.
    action_option_attrs: dict[str, str] = field(default_factory=dict)
    #: See the module docstring — these three record verified asymmetries, not
    #: guesses about which kind feels more like an appliance.
    affects_battery: bool = False
    affects_consumption: bool = False
    optimizer_kinds: tuple[str, ...] = ()

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
        options = {
            action_kind: getattr(source, attribute, None)
            for action_kind, attribute in self.action_option_attrs.items()
        }
        return {kind: option for kind, option in options.items() if option}


CONTROLLABLE_SPECS: dict[str, ControllableSpec] = {
    spec.kind: spec
    for spec in (
        ControllableSpec(
            kind=CONTROLLABLE_KIND_INVERTER,
            control_entity_attr="mode_entity_id",
            resting_state_attr="normal_option",
            default_name="Inverter",
            action_option_attrs={
                SCHEDULE_ACTION_NORMAL: "normal_option",
                SCHEDULE_ACTION_STOP_CHARGING: "stop_charging_option",
                SCHEDULE_ACTION_STOP_DISCHARGING: "stop_discharging_option",
                SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC: "charge_to_target_soc_option",
                SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC: (
                    "discharge_to_target_soc_option"
                ),
                SCHEDULE_ACTION_STOP_EXPORT: "stop_export_option",
            },
            affects_battery=True,
            optimizer_kinds=("charge_hold", "export_price", "charge_from_grid"),
        ),
        ControllableSpec(
            kind=CONTROLLABLE_KIND_CLIMATE,
            control_entity_attr="climate_entity_id",
            resting_state_attr="stop_hvac_mode",
            resting_state_default="off",
            affects_consumption=True,
            optimizer_kinds=("appliance_runtime",),
        ),
        ControllableSpec(
            kind=CONTROLLABLE_KIND_EV_CHARGER,
            # The charge switch, not the use-mode or eco-gear selects: charging
            # is what makes a charger "running", the selects only shape how.
            control_entity_attr="charge_entity_id",
            resting_state_default="off",
            affects_consumption=True,
        ),
        ControllableSpec(
            kind=CONTROLLABLE_KIND_GENERIC,
            control_entity_attr="switch_entity_id",
            resting_state_default="off",
            affects_consumption=True,
            optimizer_kinds=("appliance_runtime",),
        ),
    )
}

KNOWN_CONTROLLABLE_KINDS: frozenset[str] = frozenset(CONTROLLABLE_SPECS)


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
