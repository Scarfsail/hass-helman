"""Hardware profiles: config a device's vendor fills in instead of the user.

A profile lives on the device it describes, as that device's ``vendor`` key
(``{profile: "solax_inverter", entry_id: "<config entry id>"}``), so an
inverter and a charger can come from different vendors. A device without one
is "Custom" and keeps its hand-mapped slots.

:func:`resolve_vendor_config` is applied wherever the stored document becomes
the config Helman runs on or is judged by: the coordinator's load, and the
editor's validate and save. It returns a deep copy with every owned path
filled, so no consumer downstream knows a profile exists. Entities are found
in the entity registry by unique id, restricted to the profile's integration
and the chosen config entry, so a renamed entity id still resolves.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from ..const import DOMAIN, INVERTER_MODE_ENTITY_ID, INVERTER_MODE_UNIQUE_ID
from ..controllables.config import iter_device_paths, peek_controllable_kind
from .profile import MODE_DEVICE_PATH, VendorProfile
from .solax_inverter import PROFILE as SOLAX_INVERTER

#: Every profile, by id. Adding hardware is adding a module here.
PROFILES: dict[str, VendorProfile] = {
    profile.id: profile for profile in (SOLAX_INVERTER,)
}

VENDOR_KEY = "vendor"


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
class _VendorDevice:
    path: str
    device: Mapping[str, Any]
    profile: VendorProfile
    #: ``None`` when the entry is missing or unknown; already reported.
    entry: Any


def resolve_vendor_config(
    hass: Any, config: Mapping[str, Any]
) -> tuple[dict[str, Any], list[VendorIssue]]:
    """``config`` with every device profile's paths filled in, plus issues.

    A stored value on a path the profile owns is reported as
    ``vendor_owned_key`` and then overwritten. An entity the registry does not
    have leaves its slot as stored (unset, in a valid document) and is
    reported as ``vendor_entity_unresolved``. A document without any
    ``vendor`` key comes back as an unchanged copy, without touching ``hass``.
    """
    resolved = deepcopy(dict(config))
    issues: list[VendorIssue] = []
    # Walks the copy, so a device path is filled on the device itself; each
    # stored value is read before the profile writes over it.
    for vendor_device in _iter_vendor_devices(hass, resolved, issues):
        profile = vendor_device.profile
        owned = [
            (path, _value_at(config, path)) for path in profile.owned_config_paths
        ] + [
            (f"{vendor_device.path}.{path}", _value_at(vendor_device.device, path))
            for path in profile.device_paths
        ]
        for path, value in owned:
            if value is not None:
                issues.append(
                    VendorIssue(
                        section=path.split(".", 1)[0],
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
        if profile.modes:
            # Helman's own select exists whatever the vendor entry's state.
            _set_value_at(
                vendor_device.device,
                MODE_DEVICE_PATH,
                {
                    "entity_id": inverter_mode_entity_id(hass),
                    "options": {kind: kind for kind in profile.modes},
                },
            )
        if vendor_device.entry is None:
            continue
        for path, entity_id in resolve_profile_entities(
            hass, profile, vendor_device.entry
        ).items():
            if entity_id is not None:
                _set_value_at(resolved, path, entity_id)
                continue
            issues.append(
                VendorIssue(
                    section="devices",
                    path=f"{vendor_device.path}.{VENDOR_KEY}",
                    code="vendor_entity_unresolved",
                    message=(
                        f"{path}: no {profile.platform} entity with unique id "
                        f"{_unique_id(profile.entities[path], vendor_device.entry)!r} in "
                        f"config entry {vendor_device.entry.entry_id!r}"
                    ),
                    error=False,
                )
            )
    return resolved, issues


def resolve_profile_entities(
    hass: Any, profile: VendorProfile, entry: Any | None
) -> dict[str, str | None]:
    """Each of the profile's entity paths → the entity id it resolves to."""
    by_template = resolve_unique_ids(hass, profile, entry, profile.entities.values())
    return {path: by_template[template] for path, template in profile.entities.items()}


def resolve_unique_ids(
    hass: Any, profile: VendorProfile, entry: Any | None, templates: Iterable[str]
) -> dict[str, str | None]:
    """Each unique-id template → the entity id it resolves to in ``entry``."""
    if entry is None:
        return dict.fromkeys(templates)
    # Imported here so the modules that import this package can still be
    # loaded under the trimmed Home Assistant stubs of the websocket tests.
    from homeassistant.helpers import entity_registry as er

    registry = er.async_get(hass)
    by_unique_id = {
        registry_entry.unique_id: registry_entry.entity_id
        for registry_entry in er.async_entries_for_config_entry(
            registry, entry.entry_id
        )
        # A disabled entity is never added to the state machine, so it would
        # resolve to an id nobody can read; report it as unresolved instead.
        if registry_entry.platform == profile.platform
        and registry_entry.disabled_by is None
    }
    return {
        template: by_unique_id.get(_unique_id(template, entry))
        for template in templates
    }


def inverter_mode_entity_id(hass: Any) -> str:
    """Helman's own inverter mode select, by unique id.

    Before the select is first registered, the id it is created under.
    """
    from homeassistant.helpers import entity_registry as er

    return (
        er.async_get(hass).async_get_entity_id(
            "select", DOMAIN, INVERTER_MODE_UNIQUE_ID
        )
        or INVERTER_MODE_ENTITY_ID
    )


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


def describe_vendors(hass: Any, config: Mapping[str, Any]) -> dict[str, Any]:
    """The ``helman/get_vendors`` payload for an editor draft.

    The profiles with their candidate config entries, and for each device of
    the draft that carries a valid ``vendor``, what that profile owns there
    and what it resolves to, keyed by absolute path (the mode control's
    entity included, as ``devices.system[0].controls.mode.entity_id``). This
    is the editor's only source for which paths a profile owns, so each list
    lives once, in its profile module.
    """
    return {
        "profiles": [
            {
                "id": profile.id,
                "label": profile.label,
                "deviceKind": profile.device_kind,
                "ownedConfigPaths": profile.owned_config_paths,
                "ownedDevicePaths": list(profile.device_paths),
                "entries": [
                    {"entryId": entry.entry_id, "title": entry.title}
                    # Not an ignored discovery or a disabled entry: the editor
                    # preselects the first, and neither has entities.
                    for entry in hass.config_entries.async_entries(
                        profile.platform, include_ignore=False, include_disabled=False
                    )
                ],
            }
            for profile in PROFILES.values()
        ],
        "devices": {
            vendor_device.path: {
                "profile": vendor_device.profile.id,
                "ownedConfigPaths": vendor_device.profile.owned_config_paths,
                "ownedDevicePaths": list(vendor_device.profile.device_paths),
                "resolved": {
                    **resolve_profile_entities(
                        hass, vendor_device.profile, vendor_device.entry
                    ),
                    **(
                        {
                            f"{vendor_device.path}.{MODE_DEVICE_PATH}.entity_id": (
                                inverter_mode_entity_id(hass)
                            )
                        }
                        if vendor_device.profile.modes
                        else {}
                    ),
                },
            }
            for vendor_device in _iter_vendor_devices(hass, config, [])
        },
    }


def _iter_vendor_devices(
    hass: Any, config: Mapping[str, Any], issues: list[VendorIssue]
) -> Iterator[_VendorDevice]:
    """Every device carrying a ``vendor`` whose profile applies to it.

    A malformed ``vendor`` is reported and skipped; a missing or unknown config
    entry is reported and yielded with ``entry=None``, so the profile still
    owns its paths.
    """
    for device_path, device, _parent in iter_device_paths(config):
        if not isinstance(device, Mapping) or VENDOR_KEY not in device:
            continue
        vendor_path = f"{device_path}.{VENDOR_KEY}"
        vendor = device[VENDOR_KEY]
        if not isinstance(vendor, Mapping):
            issues.append(
                _device_error(
                    vendor_path, "invalid_type", f"{vendor_path} must be an object"
                )
            )
            continue
        profile_id = vendor.get("profile")
        profile = PROFILES.get(profile_id) if isinstance(profile_id, str) else None
        if profile is None or profile.device_kind != peek_controllable_kind(device):
            choices = sorted(
                profile_id
                for profile_id, candidate in PROFILES.items()
                if candidate.device_kind == peek_controllable_kind(device)
            )
            issues.append(
                _device_error(
                    f"{vendor_path}.profile",
                    "invalid_choice",
                    f"{vendor_path}.profile must be one of {choices!r}"
                    if choices
                    else f"no hardware profile applies to this device; remove {vendor_path}",
                )
            )
            continue

        entry_id = vendor.get("entry_id")
        entry = None
        if not isinstance(entry_id, str) or not entry_id.strip():
            issues.append(
                _device_error(
                    f"{vendor_path}.entry_id",
                    "required",
                    f"{vendor_path}.entry_id must name a {profile.platform} config entry",
                )
            )
        else:
            entry = hass.config_entries.async_get_entry(entry_id)
            # A disabled entry keeps its registry rows, but none has a state;
            # an ignored discovery has no entities at all.
            if (
                entry is None
                or entry.domain != profile.platform
                or entry.disabled_by is not None
                or entry.source == "ignore"
            ):
                entry = None
                issues.append(
                    _device_error(
                        f"{vendor_path}.entry_id",
                        "invalid_choice",
                        f"{entry_id!r} is not a {profile.platform} config entry",
                    )
                )
        yield _VendorDevice(
            path=device_path, device=device, profile=profile, entry=entry
        )


def _device_error(path: str, code: str, message: str) -> VendorIssue:
    return VendorIssue(section="devices", path=path, code=code, message=message, error=True)


def _unique_id(template: str, entry: Any) -> str:
    """The unique id a profile's entity template is registered under.

    ``{name}`` is the entry's configured name: integrations built on options
    flows keep it in ``options``, older ones in ``data``, and the entry title
    is what both default it to.
    """
    name = entry.options.get("name") or entry.data.get("name") or entry.title
    return template.format(name=name)


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
