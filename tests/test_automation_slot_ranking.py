from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from _ha_stubs import stub_ha_dt, stub_module


TZ = timezone(timedelta(hours=1))


def _install_import_stubs() -> None:
    util_pkg = stub_module("homeassistant.util")
    util_pkg.dt = stub_ha_dt()


_install_import_stubs()

from custom_components.helman.automation.slot_ranking import (  # noqa: E402
    rank_slots_contiguous,
)


def _slot_id(hour: int, minute: int = 0) -> str:
    return datetime(2026, 11, 6, hour, minute, tzinfo=TZ).isoformat(timespec="seconds")


def _hour(hour: int) -> list[str]:
    return [_slot_id(hour, minute) for minute in (0, 15, 30, 45)]


class RankSlotsContiguousTests(unittest.TestCase):
    def test_equal_group_extends_the_cheaper_block_from_its_adjacent_end(self) -> None:
        # The 2026-11-06 shape: 12:00-12:45 at 5.459, 11:00-11:45 at 5.526.
        prices = {slot_id: 5.459 for slot_id in _hour(12)} | {
            slot_id: 5.526 for slot_id in _hour(11)
        }
        ranking = rank_slots_contiguous(prices, key=prices.__getitem__)
        self.assertEqual(ranking[:4], _hour(12))
        self.assertEqual(
            ranking[4:7], [_slot_id(11, 45), _slot_id(11, 30), _slot_id(11, 15)]
        )
        self.assertEqual(ranking[7], _slot_id(11, 0))

    def test_without_an_adjacent_slot_the_earliest_wins(self) -> None:
        slot_ids = [_slot_id(14, 0), _slot_id(10, 0), _slot_id(12, 0)]
        ranking = rank_slots_contiguous(slot_ids, key=lambda _slot_id: 1.0)
        self.assertEqual(ranking, [_slot_id(10, 0), _slot_id(12, 0), _slot_id(14, 0)])

    def test_adjacency_never_jumps_a_cheaper_group(self) -> None:
        prices = {
            _slot_id(12, 0): 5.459,
            _slot_id(12, 15): 5.527,
            _slot_id(14, 0): 5.526,
        }
        ranking = rank_slots_contiguous(prices, key=prices.__getitem__)
        self.assertEqual(ranking, [_slot_id(12, 0), _slot_id(14, 0), _slot_id(12, 15)])

    def test_a_seed_outside_the_slots_is_ignored(self) -> None:
        prices = {_slot_id(10, 0): 1.0, _slot_id(12, 30): 1.0}
        ranking = rank_slots_contiguous(
            prices, key=prices.__getitem__, seed=_slot_id(12, 15)
        )
        self.assertEqual(ranking, [_slot_id(10, 0), _slot_id(12, 30)])

    def test_a_seed_goes_first_and_seeds_adjacency(self) -> None:
        prices = {_slot_id(10, 0): 1.0, _slot_id(12, 0): 5.0, _slot_id(12, 15): 1.0}
        ranking = rank_slots_contiguous(
            prices, key=prices.__getitem__, seed=_slot_id(12, 0)
        )
        self.assertEqual(ranking, [_slot_id(12, 0), _slot_id(12, 15), _slot_id(10, 0)])

    def test_picked_slots_seed_adjacency_without_being_ordered(self) -> None:
        prices = {_slot_id(10, 0): 1.0, _slot_id(12, 15): 1.0}
        ranking = rank_slots_contiguous(
            prices, key=prices.__getitem__, picked=[_slot_id(12, 0)]
        )
        self.assertEqual(ranking, [_slot_id(12, 15), _slot_id(10, 0)])

    def test_a_group_on_both_sides_takes_the_earliest_adjacent_first(self) -> None:
        prices = {_slot_id(12, 0): 1.0} | {
            slot_id: 2.0
            for slot_id in (_slot_id(11, 30), _slot_id(11, 45), _slot_id(12, 15))
        }
        ranking = rank_slots_contiguous(prices, key=prices.__getitem__)
        self.assertEqual(
            ranking,
            [_slot_id(12, 0), _slot_id(11, 45), _slot_id(11, 30), _slot_id(12, 15)],
        )
