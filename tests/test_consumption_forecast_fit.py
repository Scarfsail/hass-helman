"""Direct coverage for the pure house-consumption fit.

The fit -- hour-of-week bucketing, the sparse-bucket fallback, winsorising,
the history-day count and the negative-residual drop -- had no direct tests at
all: every reference to it in the suite was a ``patch`` that replaced it. These
tests pin its actual output so the extraction of the fit out of
``ConsumptionForecastBuilder`` can be shown to preserve every value.

The fit is reached through the ``_fit`` adapter below rather than directly, so
that moving the fit to a new home changes the adapter and nothing else -- the
expected numbers stay where they are.
"""

from __future__ import annotations

import json
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from custom_components.helman.consumption_forecast_profiles import (
    ConsumerHistoryData,
    HourOfWeekWinsorizedMeanProfile,
    fit_house_profile,
    profile_from_dict,
    profile_to_dict,
)
from custom_components.helman.consumption_forecast_statistics import (
    ForecastBand,
    percentile,
    summarize_winsorized_values,
    winsorized_mean,
)

TZ = ZoneInfo("Europe/Prague")


def _ts(year: int, month: int, day: int, hour: int) -> float:
    """Unix timestamp of a local wall-clock hour, as the Recorder rows carry it."""
    return datetime(year, month, day, hour, tzinfo=TZ).timestamp()


def _rows(*samples: tuple[float, float]) -> list[dict]:
    return [{"start": ts, "change": change} for ts, change in samples]


def _consumer(entity_id: str, values_by_ts: dict[float, float]) -> ConsumerHistoryData:
    return ConsumerHistoryData(
        entity_id=entity_id,
        label=entity_id,
        values_by_ts=values_by_ts,
        query_succeeded=True,
    )


class _FitResult:
    """Uniform view over the fit, whatever shape it is returned in."""

    def __init__(self, profile) -> None:
        self._profile = profile
        self.history_days = profile.history_days

    def non_deferrable_band(self, weekday: int, hour: int) -> ForecastBand:
        return self._profile.non_deferrable[_slot(weekday, hour)]

    def consumer_band(self, entity_id: str, weekday: int, hour: int) -> ForecastBand:
        return self._profile.consumers[entity_id][_slot(weekday, hour)]


def _slot(weekday: int, hour: int) -> int:
    return HourOfWeekWinsorizedMeanProfile.slot_index(weekday, hour)


def _fit(
    house_rows: list[dict],
    consumer_histories: list[ConsumerHistoryData],
    *,
    today_local,
) -> _FitResult:
    return _FitResult(
        fit_house_profile(house_rows, consumer_histories, today_local=today_local)
    )


class ForecastStatisticsTests(unittest.TestCase):
    def test_percentile_interpolates_between_neighbours(self) -> None:
        self.assertAlmostEqual(percentile([1.0, 2.0, 3.0, 4.0, 5.0, 100.0], 0.10), 1.5)
        self.assertAlmostEqual(percentile([1.0, 2.0, 3.0, 4.0, 5.0, 100.0], 0.90), 52.5)

    def test_percentile_degenerate_inputs(self) -> None:
        self.assertEqual(percentile([], 0.5), 0.0)
        self.assertEqual(percentile([7.0], 0.9), 7.0)

    def test_winsorized_mean_clips_to_bounds(self) -> None:
        self.assertAlmostEqual(winsorized_mean([1.0, 2.0, 100.0], 1.5, 10.0), 4.5)
        self.assertEqual(winsorized_mean([], 0.0, 1.0), 0.0)

    def test_summarize_winsorizes_center_but_reports_raw_percentiles(self) -> None:
        band = summarize_winsorized_values([1.0, 2.0, 3.0, 4.0, 5.0, 100.0])

        # The outlier is clipped to the 90th percentile for the center, but the
        # spread still reports the raw percentiles.
        self.assertEqual(band.lower, 1.5)
        self.assertEqual(band.upper, 52.5)
        self.assertEqual(band.value, 11.3333)

    def test_summarize_empty_is_a_zero_band(self) -> None:
        self.assertEqual(summarize_winsorized_values([]), ForecastBand(0.0, 0.0, 0.0))


class HourOfWeekProfileTests(unittest.TestCase):
    def test_slot_index_maps_weekday_and_hour(self) -> None:
        self.assertEqual(HourOfWeekWinsorizedMeanProfile.slot_index(0, 0), 0)
        self.assertEqual(HourOfWeekWinsorizedMeanProfile.slot_index(3, 5), 77)
        self.assertEqual(HourOfWeekWinsorizedMeanProfile.slot_index(6, 23), 167)

    def test_values_land_in_their_own_weekday_bucket(self) -> None:
        profile = HourOfWeekWinsorizedMeanProfile()
        profile.add(0, 10, 1.0)
        profile.add(0, 10, 3.0)
        profile.add(1, 10, 5.0)
        profile.add(1, 10, 7.0)

        self.assertEqual(profile.forecast(0, 10), ForecastBand(2.0, 1.2, 2.8))
        self.assertEqual(profile.forecast(1, 10), ForecastBand(6.0, 5.2, 6.8))

    def test_bucket_at_min_slot_points_does_not_pool(self) -> None:
        """Exactly ``min_slot_points`` samples is enough -- no fallback."""
        profile = HourOfWeekWinsorizedMeanProfile(min_slot_points=2)
        profile.add(0, 10, 1.0)
        profile.add(0, 10, 3.0)
        profile.add(1, 10, 100.0)
        profile.add(1, 10, 200.0)

        self.assertEqual(profile.forecast(0, 10), ForecastBand(2.0, 1.2, 2.8))

    def test_sparse_bucket_pools_raw_values_of_all_days_at_that_hour(self) -> None:
        """Below ``min_slot_points`` the raw same-hour values of all seven days
        are pooled and re-winsorised -- which is not a function of the per-day
        summaries."""
        profile = HourOfWeekWinsorizedMeanProfile(min_slot_points=2)
        profile.add(2, 10, 1.0)  # the sparse bucket under test
        profile.add(0, 10, 3.0)
        profile.add(1, 10, 5.0)
        profile.add(3, 10, 7.0)
        profile.add(3, 11, 999.0)  # a different hour must not be pooled in

        # summarize([1, 3, 5, 7]) -- pooled and re-winsorised from scratch.
        self.assertEqual(profile.forecast(2, 10), ForecastBand(4.0, 1.6, 6.4))

    def test_empty_bucket_and_empty_hour_returns_zero_band(self) -> None:
        profile = HourOfWeekWinsorizedMeanProfile()
        profile.add(0, 10, 1.0)

        self.assertEqual(profile.forecast(4, 3), ForecastBand(0.0, 0.0, 0.0))


class HouseFitTests(unittest.TestCase):
    def test_fit_buckets_rows_by_local_weekday_and_hour(self) -> None:
        house_rows = _rows(
            (_ts(2026, 3, 2, 10), 1.0),  # Monday
            (_ts(2026, 3, 9, 10), 3.0),  # Monday
            (_ts(2026, 3, 3, 10), 5.0),  # Tuesday
            (_ts(2026, 3, 10, 10), 7.0),  # Tuesday
        )

        result = _fit(house_rows, [], today_local=datetime(2026, 3, 16).date())

        self.assertEqual(result.non_deferrable_band(0, 10), ForecastBand(2.0, 1.2, 2.8))
        self.assertEqual(result.non_deferrable_band(1, 10), ForecastBand(6.0, 5.2, 6.8))
        # Wednesday at 10:00 has no samples: pooled from all four.
        self.assertEqual(result.non_deferrable_band(2, 10), ForecastBand(4.0, 1.6, 6.4))

    def test_fit_subtracts_deferrable_consumers_from_the_house_total(self) -> None:
        ts_a = _ts(2026, 3, 2, 10)
        ts_b = _ts(2026, 3, 9, 10)
        house_rows = _rows((ts_a, 4.0), (ts_b, 6.0))
        consumers = [_consumer("sensor.washer", {ts_a: 1.0, ts_b: 2.0})]

        result = _fit(house_rows, consumers, today_local=datetime(2026, 3, 16).date())

        # Residuals 3.0 and 4.0.
        self.assertEqual(result.non_deferrable_band(0, 10), ForecastBand(3.5, 3.1, 3.9))
        self.assertEqual(
            result.consumer_band("sensor.washer", 0, 10),
            ForecastBand(1.5, 1.1, 1.9),
        )

    def test_fit_drops_materially_negative_residuals_only(self) -> None:
        """A residual below -0.01 kWh drops the whole sample -- consumer values
        included; a tiny negative is clamped to zero and kept."""
        ts_dropped = _ts(2026, 3, 2, 10)
        ts_clamped = _ts(2026, 3, 9, 10)
        house_rows = _rows((ts_dropped, 1.0), (ts_clamped, 1.0))
        consumers = [
            _consumer("sensor.washer", {ts_dropped: 1.05, ts_clamped: 1.005})
        ]

        result = _fit(house_rows, consumers, today_local=datetime(2026, 3, 16).date())

        self.assertEqual(result.non_deferrable_band(0, 10), ForecastBand(0.0, 0.0, 0.0))
        # Only the kept sample reached the consumer profile.
        self.assertEqual(
            result.consumer_band("sensor.washer", 0, 10),
            ForecastBand(1.005, 1.005, 1.005),
        )

    def test_fit_ignores_rows_without_a_change(self) -> None:
        house_rows = [
            {"start": _ts(2026, 3, 2, 10), "change": 2.0},
            {"start": _ts(2026, 3, 9, 10), "change": None},
        ]

        result = _fit(house_rows, [], today_local=datetime(2026, 3, 16).date())

        self.assertEqual(result.non_deferrable_band(0, 10), ForecastBand(2.0, 2.0, 2.0))

    def test_history_days_counts_back_to_the_oldest_row(self) -> None:
        house_rows = _rows(
            (_ts(2026, 3, 9, 10), 1.0),
            (_ts(2026, 3, 2, 10), 1.0),
            (_ts(2026, 3, 5, 10), 1.0),
        )

        result = _fit(house_rows, [], today_local=datetime(2026, 3, 16).date())

        self.assertEqual(result.history_days, 14)

    def test_history_days_is_zero_without_rows(self) -> None:
        result = _fit([], [], today_local=datetime(2026, 3, 16).date())

        self.assertEqual(result.history_days, 0)


class ProfileSerializationTests(unittest.TestCase):
    def _profile(self):
        return fit_house_profile(
            _rows((_ts(2026, 3, 2, 10), 4.0), (_ts(2026, 3, 9, 10), 6.0)),
            [_consumer("sensor.washer", {_ts(2026, 3, 2, 10): 1.0})],
            today_local=datetime(2026, 3, 16).date(),
        )

    def test_round_trip_preserves_every_band(self) -> None:
        profile = self._profile()

        restored = profile_from_dict(profile_to_dict(profile))

        self.assertEqual(restored, profile)

    def test_serialized_form_is_json_safe(self) -> None:
        raw = profile_to_dict(self._profile())

        self.assertEqual(json.loads(json.dumps(raw)), raw)
        self.assertEqual(len(raw["non_deferrable"]), 168)
        self.assertEqual(len(raw["consumers"]["sensor.washer"]), 168)

    def test_unreadable_documents_are_refused(self) -> None:
        raw = profile_to_dict(self._profile())

        self.assertIsNone(profile_from_dict(None))
        self.assertIsNone(profile_from_dict({**raw, "schema_version": 999}))
        self.assertIsNone(profile_from_dict({**raw, "history_days": "14"}))
        self.assertIsNone(
            profile_from_dict({**raw, "non_deferrable": raw["non_deferrable"][:100]})
        )
        self.assertIsNone(
            profile_from_dict({**raw, "consumers": {"sensor.washer": [[1.0, 2.0]]}})
        )


if __name__ == "__main__":
    unittest.main()
