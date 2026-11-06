"""The charging ledger's own versioned store: never the user's config, never the forecast snapshot.

One document, ``{"chargers": {consumer id: ledger}}``. A charger removed from
the config keeps its ledger here: it is no longer tracked, its history not
deleted. Writes are coalesced: a reconciliation marks the document dirty and
the store writes it a few seconds later, or at once on unload.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import storage

from ..const import EV_SESSIONS_STORAGE_KEY, EV_SESSIONS_STORAGE_VERSION
from .ledger import Segment, _at, _iso, segment_from_dict, segment_to_dict

_LOGGER = logging.getLogger(__name__)

#: How long a write waits for the next one to join it.
SAVE_DELAY_SECONDS = 10


@dataclass
class ChargerLedger:
    """One charger's segments, and how far the run mode has been read."""

    segments: list[Segment] = field(default_factory=list)
    #: The live read reached here: the next one starts a little before it.
    cursor: datetime | None = None
    #: Where the live reads began; backfill reads the retained days before it.
    live_since: datetime | None = None
    #: Backfill has read every day from here on; it goes on before it.
    backfill_before: datetime | None = None
    backfill_done: bool = False
    #: The day chunks backfill has read.
    backfill_days: int = 0
    #: The last backfill chunk failed; it is read again, its cursor unmoved.
    backfill_failed: bool = False
    #: The oldest local date the recorder still holds the run mode for, once probed.
    backfill_floor: date | None = None


def _parsed(parse: Callable[[Any], Any], value: Any) -> Any:
    """``parse(value)``; ``None`` for a value missing or unreadable, as a segment that does not parse is dropped."""
    try:
        return parse(value) if value else None
    except (TypeError, ValueError):
        _LOGGER.warning("Dropping an unreadable charging ledger value: %r", value)
        return None


def ledger_to_dict(ledger: ChargerLedger) -> dict[str, Any]:
    return {
        "segments": [segment_to_dict(segment) for segment in ledger.segments],
        "cursor": _iso(ledger.cursor),
        "live_since": _iso(ledger.live_since),
        "backfill_before": _iso(ledger.backfill_before),
        "backfill_done": ledger.backfill_done,
        "backfill_days": ledger.backfill_days,
        "backfill_failed": ledger.backfill_failed,
        "backfill_floor": None if ledger.backfill_floor is None else ledger.backfill_floor.isoformat(),
    }


def ledger_from_dict(raw: Any) -> ChargerLedger:
    """A stored ledger; a segment that does not parse is dropped, the rest kept."""
    if not isinstance(raw, dict):
        return ChargerLedger()
    segments = []
    for item in raw.get("segments") or []:
        try:
            segments.append(segment_from_dict(item))
        except (KeyError, TypeError, ValueError):
            _LOGGER.warning("Dropping an unreadable charging segment: %r", item)
    return ChargerLedger(
        segments=sorted(segments, key=lambda segment: segment.start),
        cursor=_parsed(_at, raw.get("cursor")),
        live_since=_parsed(_at, raw.get("live_since")),
        backfill_before=_parsed(_at, raw.get("backfill_before")),
        backfill_done=bool(raw.get("backfill_done")),
        backfill_days=int(raw.get("backfill_days") or 0),
        backfill_failed=bool(raw.get("backfill_failed")),
        backfill_floor=_parsed(date.fromisoformat, raw.get("backfill_floor")),
    )


class EvSessionStore:
    def __init__(self, hass: HomeAssistant) -> None:
        self._store = storage.Store(hass, EV_SESSIONS_STORAGE_VERSION, EV_SESSIONS_STORAGE_KEY)
        self.chargers: dict[str, ChargerLedger] = {}
        self._dirty = False

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        chargers = stored.get("chargers") if isinstance(stored, dict) else None
        self.chargers = {
            str(consumer_id): ledger_from_dict(raw)
            for consumer_id, raw in (chargers or {}).items()
        }

    def ledger(self, consumer_id: str) -> ChargerLedger:
        return self.chargers.setdefault(consumer_id, ChargerLedger())

    def _document(self) -> dict[str, Any]:
        self._dirty = False
        return {
            "chargers": {
                consumer_id: ledger_to_dict(ledger) for consumer_id, ledger in self.chargers.items()
            }
        }

    def schedule_save(self) -> None:
        """Write the document soon; writes in between join this one."""
        self._dirty = True
        self._store.async_delay_save(self._document, SAVE_DELAY_SECONDS)

    async def async_flush(self) -> None:
        """Write a pending change now."""
        if self._dirty:
            await self._store.async_save(self._document())
