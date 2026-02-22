from __future__ import annotations

from datetime import datetime, timedelta, timezone

from homeassistant.helpers.recorder import get_instance
from homeassistant.components.recorder.history import get_significant_states
from homeassistant.core import HomeAssistant


class HelmanHistoryAggregator:
    """Pre-computes history buckets for all tracked power sensors."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def async_get_history(
        self,
        entity_ids: list[str],
        source_entity_ids: list[str],
        source_value_types: dict[str, str],
        config: dict,
    ) -> dict:
        """Fetch and bucket history. Returns a serializable dict."""
        buckets: int = config.get("history_buckets", 60)
        bucket_duration: int = config.get("history_bucket_duration", 1)

        now = datetime.now(tz=timezone.utc)
        window_seconds = buckets * bucket_duration
        start_time = now - timedelta(seconds=window_seconds)

        raw_history = await get_instance(self._hass).async_add_executor_job(
            self._fetch_raw_history, entity_ids, start_time, now
        )

        bucketed = self._bucket_history(
            raw_history, entity_ids, now, buckets, bucket_duration
        )
        source_ratios = self._compute_source_ratios(
            bucketed, entity_ids, source_entity_ids, source_value_types, buckets
        )

        return {
            "buckets": buckets,
            "bucket_duration": bucket_duration,
            "entity_history": bucketed,
            "source_ratios": source_ratios,
        }

    def _fetch_raw_history(
        self,
        entity_ids: list[str],
        start: datetime,
        end: datetime,
    ) -> dict:
        """Blocking; run in executor thread."""
        return get_significant_states(
            self._hass,
            start,
            end,
            entity_ids=entity_ids,
            significant_changes_only=False,
            minimal_response=True,
            no_attributes=True,
            compressed_state_format=True,
        )

    @staticmethod
    def _state_last_updated(state) -> datetime:
        """Return last_updated from a State object or compressed minimal-response dict.

        With compressed_state_format=True, ALL states (including the first) are dicts
        with keys "s" (state string) and "lu" (Unix float timestamp). Without
        compressed_state_format, the first element is a full State object and subsequent
        elements are plain dicts with "state" and "last_updated" keys.
        """
        if isinstance(state, dict):
            return datetime.fromtimestamp(state["lu"], tz=timezone.utc)
        return state.last_updated

    @staticmethod
    def _state_value(state) -> str:
        """Return state string from a State object or compressed minimal-response dict."""
        if isinstance(state, dict):
            return state["s"]
        return state.state

    def _bucket_history(
        self,
        raw: dict,
        entity_ids: list[str],
        now: datetime,
        buckets: int,
        bucket_duration: int,
    ) -> dict[str, list[float]]:
        """Last-known-state bucketing: oldest bucket first in result array.

        With compressed_state_format=True (used here), all elements are compressed
        dicts {"s": state_str, "lu": unix_float}. The helpers handle both compressed
        dicts and plain State objects for forward-compatibility.
        """
        result: dict[str, list[float]] = {}
        for entity_id in entity_ids:
            states = raw.get(entity_id, [])
            entity_buckets: list[float] = []
            state_idx = -1
            last_value = 0.0

            # Outer loop: i descends so bucket_end ascends (oldest → newest)
            for i in range(buckets - 1, -1, -1):
                bucket_end = now - timedelta(seconds=i * bucket_duration)

                # Advance pointer to the last state with last_updated <= bucket_end
                while (
                    state_idx + 1 < len(states)
                    and self._state_last_updated(states[state_idx + 1]) <= bucket_end
                ):
                    state_idx += 1
                    try:
                        last_value = float(self._state_value(states[state_idx]))
                    except (ValueError, TypeError):
                        pass

                entity_buckets.append(last_value)

            result[entity_id] = entity_buckets  # index 0 = oldest bucket
        return result

    @staticmethod
    def _normalize_source_value(raw: float, value_type: str) -> float:
        """Convert a raw sensor reading to an absolute positive power contribution.

        Sources may report power with different sign conventions:
        - "default": raw value is already a positive wattage (e.g. solar)
        - "positive": clamp to ≥0 (value is positive when supplying, negative otherwise)
        - "negative": take the absolute value of the negative part
          (value is negative when supplying, positive when consuming/charging)
        """
        if value_type == "negative":
            return abs(min(0.0, raw))
        if value_type == "positive":
            return max(0.0, raw)
        # "default" — trust the raw value; guard against negatives just in case
        return max(0.0, raw)

    def _compute_source_ratios(
        self,
        bucketed: dict[str, list[float]],
        all_entity_ids: list[str],
        source_entity_ids: list[str],
        source_value_types: dict[str, str],
        buckets: int,
    ) -> dict[str, dict[str, list[float]]]:
        """For each non-source entity, compute absolute power from each source
        per bucket (entity_power × source_fraction_of_total).

        Source values are first normalized according to their value_type so that
        sensors which are negative-by-convention (e.g. grid, battery) are converted
        to positive wattages before the fraction is calculated.
        """
        result: dict[str, dict[str, list[float]]] = {}
        non_source_ids = [e for e in all_entity_ids if e not in source_entity_ids]
        empty = [0.0] * buckets

        for entity_id in non_source_ids:
            entity_hist = bucketed.get(entity_id, empty)
            ratios: dict[str, list[float]] = {src: [] for src in source_entity_ids}

            for i in range(buckets):
                normalized: dict[str, float] = {
                    src: self._normalize_source_value(
                        bucketed.get(src, empty)[i],
                        source_value_types.get(src, "default"),
                    )
                    for src in source_entity_ids
                }
                total_source = sum(normalized.values())
                for src in source_entity_ids:
                    fraction = (normalized[src] / total_source) if total_source > 0 else 0.0
                    ratios[src].append(entity_hist[i] * fraction)

            result[entity_id] = ratios

        return result
