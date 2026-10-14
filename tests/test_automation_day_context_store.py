from __future__ import annotations

import asyncio
import unittest
import pytest
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo



PRAGUE = ZoneInfo("Europe/Prague")
_NOW = datetime(2026, 7, 10, 12, 0, tzinfo=PRAGUE)


class _FakeStore:
    """Stands in for ``homeassistant.helpers.storage.Store``.

    Reproduces the one behaviour under test here: a payload written by an older
    schema version is handed to ``_async_migrate_func`` instead of being
    returned as-is.
    """

    def __init__(self, hass, version, key, **kwargs) -> None:
        self.version = version
        self.key = key
        #: ``None`` until something is written; otherwise (version, data).
        self.saved: tuple[int, object] | None = None

    async def async_load(self) -> object:
        if self.saved is None:
            return None
        stored_version, data = self.saved
        if stored_version != self.version:
            return await self._async_migrate_func(stored_version, 0, data)
        return data

    async def async_save(self, data: object) -> None:
        self.saved = (self.version, data)

    async def _async_migrate_func(self, old_major, old_minor, old_data):
        raise NotImplementedError


from custom_components.helman.automation import day_context_store
DayContextStore = day_context_store.DayContextStore


class _StoreForTest(_FakeStore):
    _async_migrate_func = day_context_store._DayBandStore._async_migrate_func


@pytest.fixture(autouse=True)
def _store(monkeypatch):
    from homeassistant.util import dt as dt_util
    monkeypatch.setattr(day_context_store, "_DayBandStore", _StoreForTest)
    monkeypatch.setattr(dt_util, "now", lambda: _NOW)


TODAY = date(2026, 7, 10)
TOMORROW = TODAY + timedelta(days=1)
YESTERDAY = TODAY - timedelta(days=1)
CHARGE_HOLD = "charge-hold"
FILTRATION = "pool-filtration"
OPTIMIZER_IDS = (CHARGE_HOLD, FILTRATION)


def _run(coro) -> None:
    asyncio.run(coro)


class DayContextStoreTests(unittest.TestCase):
    def test_bands_round_trip_per_day_and_optimizer(self) -> None:
        """Two optimizers hold their own band for the same calendar day.

        That is the whole reason the key grew an optimizer id (#264): the
        classification is computed over each optimizer's own house view, so a
        single band per date could not represent the run.
        """

        async def scenario() -> None:
            store = DayContextStore(hass=object())
            self.assertEqual(await store.async_load(), {})
            await store.async_save_and_prune(
                emitted={
                    (TODAY, CHARGE_HOLD): "deficit",
                    (TODAY, FILTRATION): "tight",
                    (TOMORROW, CHARGE_HOLD): "surplus",
                },
                today=TODAY,
                optimizer_ids=OPTIMIZER_IDS,
            )

            reloaded = DayContextStore(hass=object())
            reloaded._store = store._store
            self.assertEqual(
                await reloaded.async_load(),
                {
                    (TODAY, CHARGE_HOLD): "deficit",
                    (TODAY, FILTRATION): "tight",
                    (TOMORROW, CHARGE_HOLD): "surplus",
                },
            )

        _run(scenario())

    def test_band_of_an_optimizer_that_did_not_run_is_kept(self) -> None:
        async def scenario() -> None:
            store = DayContextStore(hass=object())
            await store.async_load()
            await store.async_save_and_prune(
                emitted={
                    (TODAY, CHARGE_HOLD): "deficit",
                    (TODAY, FILTRATION): "tight",
                },
                today=TODAY,
                optimizer_ids=OPTIMIZER_IDS,
            )
            # A run in which filtration was skipped must not cost it its damping.
            await store.async_save_and_prune(
                emitted={(TODAY, CHARGE_HOLD): "tight"},
                today=TODAY,
                optimizer_ids=OPTIMIZER_IDS,
            )

            reloaded = DayContextStore(hass=object())
            reloaded._store = store._store
            self.assertEqual(
                await reloaded.async_load(),
                {
                    (TODAY, CHARGE_HOLD): "tight",
                    (TODAY, FILTRATION): "tight",
                },
            )

        _run(scenario())

    def test_past_days_are_pruned(self) -> None:
        async def scenario() -> None:
            store = DayContextStore(hass=object())
            await store.async_load()
            await store.async_save_and_prune(
                emitted={(YESTERDAY, CHARGE_HOLD): "surplus"},
                today=YESTERDAY,
                optimizer_ids=OPTIMIZER_IDS,
            )
            await store.async_save_and_prune(
                emitted={(TODAY, CHARGE_HOLD): "tight"},
                today=TODAY,
                optimizer_ids=OPTIMIZER_IDS,
            )

            reloaded = DayContextStore(hass=object())
            reloaded._store = store._store
            self.assertEqual(
                await reloaded.async_load(),
                {(TODAY, CHARGE_HOLD): "tight"},
            )

        _run(scenario())

    def test_records_of_removed_optimizers_are_pruned(self) -> None:
        async def scenario() -> None:
            store = DayContextStore(hass=object())
            await store.async_load()
            await store.async_save_and_prune(
                emitted={
                    (TODAY, CHARGE_HOLD): "deficit",
                    (TODAY, FILTRATION): "tight",
                },
                today=TODAY,
                optimizer_ids=OPTIMIZER_IDS,
            )
            # Filtration removed from the config: its band can never be read
            # back, so it does not linger.
            await store.async_save_and_prune(
                emitted={(TODAY, CHARGE_HOLD): "deficit"},
                today=TODAY,
                optimizer_ids=(CHARGE_HOLD,),
            )

            reloaded = DayContextStore(hass=object())
            reloaded._store = store._store
            self.assertEqual(
                await reloaded.async_load(),
                {(TODAY, CHARGE_HOLD): "deficit"},
            )

        _run(scenario())

    def test_unchanged_bands_are_not_rewritten(self) -> None:
        async def scenario() -> None:
            store = DayContextStore(hass=object())
            await store.async_load()
            await store.async_save_and_prune(
                emitted={(TODAY, CHARGE_HOLD): "tight"},
                today=TODAY,
                optimizer_ids=OPTIMIZER_IDS,
            )
            written = store._store.saved
            await store.async_save_and_prune(
                emitted={(TODAY, CHARGE_HOLD): "tight"},
                today=TODAY,
                optimizer_ids=OPTIMIZER_IDS,
            )
            self.assertIs(store._store.saved, written)

        _run(scenario())

    def test_v1_freeze_records_are_discarded(self) -> None:
        """Upgrading from the freeze store costs one damping cycle, not an error.

        v1 records were keyed by date alone and carry no optimizer, so there is
        nothing to migrate them onto.
        """

        async def scenario() -> None:
            store = DayContextStore(hass=object())
            store._store.saved = (
                1,
                {
                    "records": {
                        TODAY.isoformat(): {
                            "classification": "surplus",
                            "frozenAt": "2026-07-09T13:15:01+02:00",
                        }
                    }
                },
            )
            self.assertEqual(await store.async_load(), {})

        _run(scenario())

    def test_garbage_payload_loads_as_empty(self) -> None:
        async def scenario() -> None:
            store = DayContextStore(hass=object())
            store._store.saved = (2, {"records": {"not-a-date": {"x": "tight"}}})
            self.assertEqual(await store.async_load(), {})

        _run(scenario())


if __name__ == "__main__":
    unittest.main()
