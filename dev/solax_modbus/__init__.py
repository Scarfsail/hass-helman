"""Dev-only stand-in for the solax_modbus integration.

Re-labels the entity registry rows that ``remote_homeassistant`` created for
prod's SolaX entities as ``solax_modbus`` rows under this entry, with prod's
unique ids. Helman's hardware profiles then resolve on dev exactly as on prod,
to the mirrored entity ids, whose writes the mirror forwards to the real device.
The stub creates no entities. See dev/README.md.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

_LOGGER = logging.getLogger(__name__)

DOMAIN = "solax_modbus"
MIRROR_PLATFORM = "remote_homeassistant"
SNAPSHOT_PATH = Path(__file__).parent / "registry_snapshot.json"


def load_snapshot() -> dict[str, dict[str, str]]:
    """Read ``{entry title: {unique_id: entity_id}}`` (blocking I/O)."""
    return json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))


@dataclass
class ClaimResult:
    claimed: list[str] = field(default_factory=list)
    already_claimed: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


def claim_rows(registry, entry_id: str, rows: dict[str, str]) -> ClaimResult:
    """Move each mirrored row in ``rows`` (unique_id -> entity_id) to this entry.

    The entity id is kept, so state and recorder history stay with it. Rows
    already owned by the entry are left alone; anything else is skipped.
    """
    result = ClaimResult()
    for unique_id, entity_id in rows.items():
        row = registry.async_get(entity_id)
        if row is None:
            result.skipped.append(entity_id)
        elif row.platform == DOMAIN and row.config_entry_id == entry_id:
            result.already_claimed.append(entity_id)
        elif row.platform != MIRROR_PLATFORM:
            result.skipped.append(entity_id)
        else:
            try:
                registry.async_update_entity_platform(
                    entity_id,
                    DOMAIN,
                    new_config_entry_id=entry_id,
                    new_unique_id=unique_id,
                )
            except ValueError:
                result.skipped.append(entity_id)
            else:
                result.claimed.append(entity_id)
    return result


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    snapshot = await hass.async_add_executor_job(load_snapshot)
    result = claim_rows(
        er.async_get(hass), entry.entry_id, snapshot.get(entry.data["name"], {})
    )
    _LOGGER.info(
        "%s: claimed %d, already claimed %d, skipped %d %s",
        entry.data["name"],
        len(result.claimed),
        len(result.already_claimed),
        len(result.skipped),
        result.skipped,
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    return True
