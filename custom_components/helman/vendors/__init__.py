"""Hardware profiles: config a device's vendor fills in instead of the user.

A profile lives on the device it describes, as that device's ``profile`` key,
so an inverter and a charger can come from different vendors. An
entry-bound profile names a config entry of its integration
(``{id: "solax_inverter", entry_id: "<config entry id>"}``), a device-bound
one an HA device of it (``{id: "solax_ev_charger", device_id: "<HA device
id>"}``). A device without one is "Custom" and keeps its hand-mapped slots.

:func:`resolve_vendor_config` is applied wherever the stored document becomes
the config Helman runs on or is judged by: the coordinator's load, and the
editor's validate and save. It returns a deep copy with every owned path
filled, so no consumer downstream knows a profile exists. Entities are found
in the entity registry by domain and unique id, restricted to the profile's
integration and the chosen config entry or HA device, so a renamed entity id
still resolves.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from ..const import (
    DOMAIN,
    EV_CHARGING_UNIQUE_ID_PREFIX,
    INVERTER_MODE_ENTITY_ID,
    INVERTER_MODE_UNIQUE_ID,
)
from ..controllables.config import (
    find_inverter_device,
    iter_device_paths,
    peek_controllable_id,
    peek_controllable_kind,
)
from ..controllables.spec import CONTROLLABLE_KIND_INVERTER
from .profile import (
    CHARGE_DEVICE_PATH,
    MODE_DEVICE_PATH,
    EntityTemplate,
    VendorProfile,
)
from .solax_ev_charger import PROFILE as SOLAX_EV_CHARGER
from .solax_inverter import PROFILE as SOLAX_INVERTER

#: Every profile, by id. Adding hardware is adding a module here.
PROFILES: dict[str, VendorProfile] = {
    profile.id: profile for profile in (SOLAX_INVERTER, SOLAX_EV_CHARGER)
}

PROFILE_KEY = "profile"


@dataclass(frozen=True)
class VendorIssue:
    """A finding of the resolver, shaped like a validation issue.

    ``error`` decides which list of the validation report it joins; the
    coordinator logs every issue and starts anyway.
    """

    section: str
    path: str
    code: str
    message: str
    error: bool


@dataclass(frozen=True)
class VendorDevice:
    """A device carrying a profile that applies to it, and what it binds to."""

    path: str
    device: Mapping[str, Any]
    profile: VendorProfile
    #: The config entry whose name ``{name}`` stands for: the bound entry, or
    #: the bound HA device's entry of the profile's platform. ``None`` when
    #: the binding is missing or unknown; already reported.
    entry: Any
    #: The bound HA device, for a device-bound profile.
    device_id: str | None = None


def resolve_vendor_config(
    hass: Any, config: Mapping[str, Any]
) -> tuple[dict[str, Any], list[VendorIssue]]:
    """``config`` with every device profile's paths filled in, plus issues.

    A stored value on a path the profile owns is reported as
    ``vendor_owned_key`` and then overwritten. An entity the registry does not
    have leaves its slot as stored (unset, in a valid document) and is
    reported as ``vendor_entity_unresolved``. A document without any
    ``profile`` key comes back as an unchanged copy, without touching ``hass``.
    """
    resolved = deepcopy(dict(config))
    issues: list[VendorIssue] = []
    # Walks the copy, so a device path is filled on the device itself; each
    # stored value is read before the profile writes over it.
    for vendor_device in _iter_vendor_devices(hass, resolved, issues):
        profile = vendor_device.profile
        device = vendor_device.device
        owned = [
            (path, _value_at(config, path)) for path in profile.owned_config_paths
        ] + [
            (f"{vendor_device.path}.{path}", _value_at(device, path))
            for path in profile.device_paths
        ]
        for path, value in owned:
            if value is not None:
                issues.append(
                    VendorIssue(
                        section=_section_of(path),
                        path=path,
                        code="vendor_owned_key",
                        message=(
                            f"{path} is provided by the {profile.label} profile on "
                            f"{vendor_device.path}; remove it from the config"
                        ),
                        error=True,
                    )
                )

        for path, value in profile.values.items():
            _set_value_at(resolved, path, value)
        for path, value in profile.device_values.items():
            _set_value_at(device, path, deepcopy(value))
        # Helman's own entities exist whatever the vendor binding's state.
        for path, value in _helman_controls(hass, vendor_device).items():
            _set_value_at(device, path, value)
        if vendor_device.entry is None:
            continue
        slots = _entity_slots(resolved, vendor_device)
        entity_ids = resolve_unique_ids(
            hass,
            profile,
            vendor_device.entry,
            [template for *_slot, template in slots],
            device_id=vendor_device.device_id,
        )
        for path, target, relative, template in slots:
            entity_id = entity_ids[template]
            if entity_id is not None:
                _set_value_at(target, relative, entity_id)
                continue
            profile_path = f"{vendor_device.path}.{PROFILE_KEY}"
            domain, _template = template
            issues.append(
                VendorIssue(
                    section=_section_of(profile_path),
                    path=profile_path,
                    code="vendor_entity_unresolved",
                    message=(
                        f"{path}: no {profile.platform} {domain} entity with unique "
                        f"id {_unique_id(template, vendor_device.entry)!r} "
                        + (
                            f"on device {vendor_device.device_id!r}"
                            if vendor_device.device_id is not None
                            else f"in config entry {vendor_device.entry.entry_id!r}"
                        )
                    ),
                    error=False,
                )
            )
    return resolved, issues


def resolve_unique_ids(
    hass: Any,
    profile: VendorProfile,
    entry: Any | None,
    templates: Iterable[EntityTemplate],
    *,
    device_id: str | None = None,
) -> dict[EntityTemplate, str | None]:
    """Each ``(domain, unique-id template)`` → the entity id it resolves to.

    Read from ``entry``'s registry rows, or for a device-bound profile from
    the rows on HA device ``device_id``, ``entry`` then naming ``{name}``.
    """
    if entry is None:
        return dict.fromkeys(templates)
    # Imported here so the modules that import this package can still be
    # loaded under the trimmed Home Assistant stubs of the websocket tests.
    from homeassistant.helpers import entity_registry as er

    registry = er.async_get(hass)
    rows = (
        er.async_entries_for_config_entry(registry, entry.entry_id)
        if device_id is None
        else er.async_entries_for_device(registry, device_id)
    )
    by_key = {
        (row.entity_id.partition(".")[0], row.unique_id): row.entity_id
        for row in rows
        # A disabled entity is never added to the state machine, so it would
        # resolve to an id nobody can read; report it as unresolved instead.
        if row.platform == profile.platform and row.disabled_by is None
    }
    return {
        template: by_key.get((template[0], _unique_id(template, entry)))
        for template in templates
    }


def helman_entity_id(
    hass: Any, domain: str, unique_id: str, fallback_entity_id: str
) -> str:
    """One of Helman's own entities, by unique id.

    Before the entity is first registered, the id it is created under.
    """
    from homeassistant.helpers import entity_registry as er

    return (
        er.async_get(hass).async_get_entity_id(domain, DOMAIN, unique_id)
        or fallback_entity_id
    )


def ev_charging_unique_id(device_id: str) -> str:
    """The unique id of Helman's EV charging switch for helman device ``device_id``."""
    return f"{EV_CHARGING_UNIQUE_ID_PREFIX}{device_id}"


def ev_charging_entity_id(device_id: str) -> str:
    """The entity id Helman's EV charging switch is created under."""
    from homeassistant.util import slugify

    return f"switch.{slugify(ev_charging_unique_id(device_id))}"


def find_mode_vendor(
    hass: Any, config: Mapping[str, Any]
) -> tuple[VendorProfile, Any | None] | None:
    """The profile with a mode table on a device, and its config entry.

    ``None`` when no device carries one: Helman's mode select is not created.
    The entry is ``None`` when it is missing or unknown, already reported by
    :func:`resolve_vendor_config`; the select then fails every write.
    """
    for vendor_device in _iter_vendor_devices(hass, config, []):
        if vendor_device.profile.modes:
            return vendor_device.profile, vendor_device.entry
    return None


def find_charging_devices(
    hass: Any, config: Mapping[str, Any]
) -> list[tuple[str, VendorDevice]]:
    """Every device whose profile has ``charging``, with its helman id.

    One EV charging switch is created per device. A device without an id is
    skipped, already reported by validation.
    """
    return [
        (device_id, vendor_device)
        for vendor_device in _iter_vendor_devices(hass, config, [])
        if vendor_device.profile.charging is not None
        and (device_id := peek_controllable_id(vendor_device.device)) is not None
    ]


def describe_vendors(hass: Any, config: Mapping[str, Any]) -> dict[str, Any]:
    """The ``helman/get_vendors`` payload for an editor draft.

    The profiles with what each can bind to: an entry-bound one its config
    entries, a device-bound one its ``candidates``, the HA devices it fully
    resolves on. For each device of the draft that carries a valid
    ``profile``, what that profile owns there, what it resolves to and the
    values it fills in, keyed by absolute path (Helman's own controls
    included, such as ``energy_nodes.inverter.controls.mode.entity_id``). This
    is the editor's only source for which paths a profile owns, so each list
    lives once, in its profile module.
    """
    return {
        "profiles": [
            {
                "id": profile.id,
                "label": profile.label,
                "deviceKind": profile.device_kind,
                "binding": profile.binding,
                "ownedConfigPaths": profile.owned_config_paths,
                "ownedDevicePaths": list(profile.device_paths),
                **(
                    {"candidates": _describe_candidates(hass, profile)}
                    if profile.binding == "device"
                    else {
                        "entries": [
                            {"entryId": entry.entry_id, "title": entry.title}
                            for entry in _usable_entries(hass, profile)
                        ]
                    }
                ),
            }
            for profile in PROFILES.values()
        ],
        "devices": {
            vendor_device.path: {
                "profile": vendor_device.profile.id,
                # What the answer was computed for, so the editor can tell a
                # stale answer from one for the device it now shows.
                "storedProfile": dict(vendor_device.device[PROFILE_KEY]),
                "ownedConfigPaths": vendor_device.profile.owned_config_paths,
                "ownedDevicePaths": list(vendor_device.profile.device_paths),
                "resolved": _describe_resolved(hass, config, vendor_device),
                "values": {
                    **vendor_device.profile.values,
                    **{
                        f"{vendor_device.path}.{path}": value
                        for path, value in vendor_device.profile.device_values.items()
                    },
                },
            }
            for vendor_device in _iter_vendor_devices(hass, config, [])
        },
    }


def _usable_entries(hass: Any, profile: VendorProfile) -> list[Any]:
    """The profile's config entries a device can bind to.

    Not an ignored discovery or a disabled entry: the editor preselects the
    first, and neither has entities.
    """
    return hass.config_entries.async_entries(
        profile.platform, include_ignore=False, include_disabled=False
    )


def _describe_candidates(hass: Any, profile: VendorProfile) -> list[dict[str, str]]:
    """The HA devices a device-bound profile fully resolves on.

    Every HA device of a usable entry of the profile's platform on which each
    of the profile's device entities, and its charging control's, resolves;
    one that lacks any would leave an owned slot empty or the switch dead.
    """
    from homeassistant.helpers import device_registry as dr

    registry = dr.async_get(hass)
    candidates = []
    for entry in _usable_entries(hass, profile):
        for ha_device in dr.async_entries_for_config_entry(registry, entry.entry_id):
            entity_ids = resolve_unique_ids(
                hass,
                profile,
                entry,
                [
                    *profile.device_entities.values(),
                    *(profile.charging.templates if profile.charging else ()),
                ],
                device_id=ha_device.id,
            )
            if None in entity_ids.values():
                continue
            candidates.append(
                {
                    "deviceId": ha_device.id,
                    "name": ha_device.name_by_user or ha_device.name or ha_device.id,
                    "entryTitle": entry.title,
                }
            )
    return candidates


def _describe_resolved(
    hass: Any, config: Mapping[str, Any], vendor_device: VendorDevice
) -> dict[str, str | None]:
    """Each entity path the profile fills on this device → its entity id."""
    slots = _entity_slots(config, vendor_device)
    entity_ids = resolve_unique_ids(
        hass,
        vendor_device.profile,
        vendor_device.entry,
        [template for *_slot, template in slots],
        device_id=vendor_device.device_id,
    )
    return {
        **{path: entity_ids[template] for path, _target, _rel, template in slots},
        **{
            f"{vendor_device.path}.{path}.entity_id": control["entity_id"]
            for path, control in _helman_controls(hass, vendor_device).items()
        },
    }


def _entity_slots(
    config: Any, vendor_device: VendorDevice
) -> list[tuple[str, Any, str, EntityTemplate]]:
    """The profile's entity slots on this device.

    Each as ``(absolute path, document the slot is written in, path in that
    document, template)``: a config path in the whole document, a device path
    on the device itself, whose absolute path may hold a list index.
    """
    profile = vendor_device.profile
    return [
        (path, config, path, template) for path, template in profile.entities.items()
    ] + [
        (f"{vendor_device.path}.{path}", vendor_device.device, path, template)
        for path, template in profile.device_entities.items()
    ]


def _helman_controls(hass: Any, vendor_device: VendorDevice) -> dict[str, Any]:
    """The device controls the profile points at Helman's own entities."""
    profile = vendor_device.profile
    controls: dict[str, Any] = {}
    if profile.modes:
        controls[MODE_DEVICE_PATH] = {
            "entity_id": helman_entity_id(
                hass, "select", INVERTER_MODE_UNIQUE_ID, INVERTER_MODE_ENTITY_ID
            ),
            "options": {kind: kind for kind in profile.modes},
        }
    device_id = peek_controllable_id(vendor_device.device)
    if profile.charging is not None and device_id is not None:
        controls[CHARGE_DEVICE_PATH] = {
            "entity_id": helman_entity_id(
                hass,
                "switch",
                ev_charging_unique_id(device_id),
                ev_charging_entity_id(device_id),
            )
        }
    return controls


def _iter_vendor_devices(
    hass: Any, config: Mapping[str, Any], issues: list[VendorIssue]
) -> Iterator[VendorDevice]:
    """Every device carrying a ``profile`` that applies to it.

    The inverter first, at ``energy_nodes.inverter`` and of kind ``inverter``
    by location, then the consumers. A malformed ``profile`` is reported and
    skipped; a missing or unknown binding is reported and yielded with
    ``entry=None``, so the profile still owns its paths.
    """
    inverter = find_inverter_device(config)
    candidates = [("energy_nodes.inverter", inverter, CONTROLLABLE_KIND_INVERTER)] + [
        (device_path, device, peek_controllable_kind(device))
        for device_path, device, _parent in iter_device_paths(config)
    ]
    bound_devices: set[tuple[str, str]] = set()
    for device_path, device, kind in candidates:
        if not isinstance(device, Mapping) or PROFILE_KEY not in device:
            continue
        profile_path = f"{device_path}.{PROFILE_KEY}"
        stored = device[PROFILE_KEY]
        if not isinstance(stored, Mapping):
            issues.append(
                _device_error(
                    profile_path, "invalid_type", f"{profile_path} must be an object"
                )
            )
            continue
        profile_id = stored.get("id")
        profile = PROFILES.get(profile_id) if isinstance(profile_id, str) else None
        if profile is None or profile.device_kind != kind:
            choices = sorted(
                profile_id
                for profile_id, candidate in PROFILES.items()
                if candidate.device_kind == kind
            )
            issues.append(
                _device_error(
                    f"{profile_path}.id",
                    "invalid_choice",
                    f"{profile_path}.id must be one of {choices!r}"
                    if choices
                    else f"no hardware profile applies to this device; remove {profile_path}",
                )
            )
            continue

        if profile.binding == "device":
            ha_device_id = stored.get("device_id")
            entry = _bound_device_entry(
                hass, profile, profile_path, ha_device_id, issues
            )
            if entry is not None:
                if (profile.id, ha_device_id) in bound_devices:
                    issues.append(
                        _device_error(
                            f"{profile_path}.device_id",
                            "duplicate_profile_device",
                            f"another device is already bound to {ha_device_id!r} "
                            f"under the {profile.label} profile",
                        )
                    )
                    # Unbound, as an unknown device is: two devices driving
                    # one charger would fight over it.
                    entry = None
                bound_devices.add((profile.id, ha_device_id))
            yield VendorDevice(
                path=device_path,
                device=device,
                profile=profile,
                entry=entry,
                device_id=ha_device_id if entry is not None else None,
            )
            continue

        entry_id = stored.get("entry_id")
        entry = None
        if not isinstance(entry_id, str) or not entry_id.strip():
            issues.append(
                _device_error(
                    f"{profile_path}.entry_id",
                    "required",
                    f"{profile_path}.entry_id must name a {profile.platform} config entry",
                )
            )
        else:
            entry = hass.config_entries.async_get_entry(entry_id)
            if not _is_usable_entry(entry, profile):
                entry = None
                issues.append(
                    _device_error(
                        f"{profile_path}.entry_id",
                        "invalid_choice",
                        f"{entry_id!r} is not a {profile.platform} config entry",
                    )
                )
        yield VendorDevice(
            path=device_path, device=device, profile=profile, entry=entry
        )


def _bound_device_entry(
    hass: Any,
    profile: VendorProfile,
    profile_path: str,
    ha_device_id: Any,
    issues: list[VendorIssue],
) -> Any | None:
    """The bound HA device's config entry of the profile's platform.

    ``None``, reported, when ``device_id`` is missing, names no HA device, or
    names one without a usable entry of the platform.
    """
    path = f"{profile_path}.device_id"
    if not isinstance(ha_device_id, str) or not ha_device_id.strip():
        issues.append(
            _device_error(
                path, "required", f"{path} must name a {profile.platform} device"
            )
        )
        return None
    from homeassistant.helpers import device_registry as dr

    ha_device = dr.async_get(hass).async_get(ha_device_id)
    entry = next(
        (
            entry
            for entry_id in (ha_device.config_entries if ha_device is not None else ())
            if _is_usable_entry(
                entry := hass.config_entries.async_get_entry(entry_id), profile
            )
        ),
        None,
    )
    if entry is None:
        issues.append(
            _device_error(
                path,
                "invalid_choice",
                f"{ha_device_id!r} is not a device of a {profile.platform} config entry",
            )
        )
    return entry


def _is_usable_entry(entry: Any, profile: VendorProfile) -> bool:
    """A config entry of the profile's platform that has entities with states.

    A disabled entry keeps its registry rows, but none has a state; an ignored
    discovery has no entities at all.
    """
    return (
        entry is not None
        and entry.domain == profile.platform
        and entry.disabled_by is None
        and entry.source != "ignore"
    )


def _device_error(path: str, code: str, message: str) -> VendorIssue:
    return VendorIssue(
        section=_section_of(path), path=path, code=code, message=message, error=True
    )


def _section_of(path: str) -> str:
    """The editor section a device path belongs to: its first segment."""
    return path.split(".", 1)[0]


def _unique_id(template: EntityTemplate, entry: Any) -> str:
    """The unique id a profile's entity template is registered under.

    ``{name}`` is the entry's configured name: integrations built on options
    flows keep it in ``options``, older ones in ``data``, and the entry title
    is what both default it to.
    """
    name = entry.options.get("name") or entry.data.get("name") or entry.title
    return template[1].format(name=name)


def _value_at(document: Any, dotted_path: str) -> Any:
    for key in dotted_path.split("."):
        if not isinstance(document, Mapping):
            return None
        document = document.get(key)
    return document


def _set_value_at(document: dict[str, Any], dotted_path: str, value: Any) -> None:
    """Write ``value`` at ``dotted_path``, creating missing parents.

    A parent that exists but is not an object is left for validation to name
    rather than overwritten.
    """
    *parents, key = dotted_path.split(".")
    for part in parents:
        child = document.get(part)
        if child is None:
            child = document[part] = {}
        if not isinstance(child, dict):
            return
        document = child
    document[key] = value
