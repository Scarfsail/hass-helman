# Phase 5: History Aggregation in Backend

## Goal
Move the history bucketing, source-ratio calculation, and unmeasured-power history
derivation out of the browser into the backend. The frontend requests pre-computed
history via `helman/get_history` and uses it directly without any O(buckets × entities)
processing.

## Background: Current Cost

On every card connect (or page reload), `energy-data-helper.ts` does:

1. One large WebSocket call to `history/history_during_period` fetching raw state
   history for all power sensors over the past `buckets × bucket_duration` seconds.
2. Iterates over every bucket (N=60) × every entity (M≈20+) to assign the
   "last known state" value per bucket: **O(N × M)** with string→float parsing.
3. For each non-source device node, for each bucket: computes per-source power
   ratios by dividing source power by total source power: another **O(N × sources)**
   pass.
4. Recursively derives unmeasured-node history by subtracting measured children
   from the parent: **O(N × tree_depth)**.

Total: ~60 × 20 × 3 = ~3600 arithmetic operations, plus the raw HA history payload
which can be several hundred KB of JSON.

## Deliverables

- `history_aggregator.py`: Python class that fetches and buckets history
- `websockets.py`: Add `helman/get_history` WS command
- Frontend `energy-data-helper.ts`: Replace `enrichDeviceTreeWithHistory()` with backend call

## Backend: `history_aggregator.py`

```python
from __future__ import annotations
from datetime import datetime, timedelta, timezone
from typing import Any
from homeassistant.core import HomeAssistant
from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.history import get_significant_states


class HelmanHistoryAggregator:
    """Pre-computes history buckets for all tracked power sensors."""

    def __init__(self, hass: HomeAssistant, config: dict) -> None:
        self._hass = hass
        self._config = config

    async def async_get_history(
        self,
        entity_ids: list[str],
        source_entity_ids: list[str],
        tree: dict,
    ) -> dict:
        """Fetch and bucket history. Returns a serializable dict."""
        buckets: int = self._config.get("history_buckets", 60)
        bucket_duration: int = self._config.get("history_bucket_duration", 1)

        now = datetime.now(tz=timezone.utc)
        window_seconds = buckets * bucket_duration
        start_time = now - timedelta(seconds=window_seconds)

        # Use HA recorder for efficient history access (same data source as
        # history/history_during_period WS command but in-process)
        raw_history = await get_instance(self._hass).async_add_executor_job(
            self._fetch_raw_history, entity_ids, start_time, now
        )

        bucketed = self._bucket_history(
            raw_history, entity_ids, now, buckets, bucket_duration
        )
        source_ratios = self._compute_source_ratios(
            bucketed, entity_ids, source_entity_ids, buckets
        )
        unmeasured = self._compute_unmeasured_history(
            bucketed, source_ratios, tree, buckets
        )

        return {
            "buckets": buckets,
            "bucket_duration": bucket_duration,
            "entity_history": bucketed,          # { entity_id: [float] } (oldest→newest)
            "source_ratios": source_ratios,       # { entity_id: { source_id: [float] } }
            "unmeasured_history": unmeasured,     # { node_id: [float] }
        }

    def _fetch_raw_history(
        self, entity_ids: list[str], start: datetime, end: datetime
    ) -> dict[str, list]:
        """Blocking; run in executor thread."""
        return get_significant_states(
            self._hass,
            start,
            end,
            entity_ids=entity_ids,
            significant_changes_only=False,
            minimal_response=True,
            no_attributes=True,
        )

    def _bucket_history(
        self,
        raw: dict[str, list],
        entity_ids: list[str],
        now: datetime,
        buckets: int,
        bucket_duration: int,
    ) -> dict[str, list[float]]:
        """Last-known-state bucketing: for bucket i, find last state entry
        with timestamp <= bucket_end_time."""
        result: dict[str, list[float]] = {}
        for entity_id in entity_ids:
            states = raw.get(entity_id, [])
            entity_buckets: list[float] = []
            for i in range(buckets - 1, -1, -1):  # newest→oldest
                bucket_end = now - timedelta(seconds=i * bucket_duration)
                value = 0.0
                for state in reversed(states):
                    if state.last_updated <= bucket_end:
                        try:
                            value = float(state.state)
                        except (ValueError, TypeError):
                            value = 0.0
                        break
                entity_buckets.append(value)
            result[entity_id] = entity_buckets  # oldest→newest after reversal
        return result

    def _compute_source_ratios(
        self,
        bucketed: dict[str, list[float]],
        all_entity_ids: list[str],
        source_entity_ids: list[str],
        buckets: int,
    ) -> dict[str, dict[str, list[float]]]:
        """For each non-source entity, compute what fraction of power came from
        each source entity at each bucket."""
        result: dict[str, dict[str, list[float]]] = {}
        non_source_ids = [e for e in all_entity_ids if e not in source_entity_ids]

        for entity_id in non_source_ids:
            ratios: dict[str, list[float]] = {src: [] for src in source_entity_ids}
            entity_history = bucketed.get(entity_id, [0.0] * buckets)
            for i in range(buckets):
                total_source = sum(
                    max(0.0, bucketed.get(src, [0.0] * buckets)[i])
                    for src in source_entity_ids
                )
                for src in source_entity_ids:
                    src_power = max(0.0, bucketed.get(src, [0.0] * buckets)[i])
                    ratio = (src_power / total_source) if total_source > 0 else 0.0
                    ratios[src].append(entity_history[i] * ratio)
            result[entity_id] = ratios

        return result

    def _compute_unmeasured_history(
        self, bucketed, source_ratios, tree, buckets
    ) -> dict[str, list[float]]:
        """Derive unmeasured-power history = parent - sum(measured children)."""
        # ... recursive tree walk, mirrors enrichUnmeasuredDeviceTreeWithHistory ...
        return {}
```

### Note on Recorder Access

HA's recorder integration exposes `get_significant_states()` from
`homeassistant.components.recorder.history`. This is the same function used by
the built-in `history` integration and the `history/history_during_period` WS
command, so the data is identical. Running it in an executor job (via
`async_add_executor_job`) avoids blocking the event loop.

## Backend: WebSocket Command

```python
@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_history",
})
@websocket_api.async_response
async def ws_get_history(hass, connection, msg):
    coordinator: HelmanCoordinator = hass.data[DOMAIN][entry_id]["coordinator"]
    history = await coordinator.get_history()
    connection.send_result(msg["id"], history)
```

The coordinator caches history and refreshes it on a configurable schedule (e.g.,
every 60 seconds) so multiple simultaneous card reloads don't hammer the recorder.

## Coordinator: History Caching

```python
import asyncio
from datetime import datetime, timedelta, timezone

class HelmanCoordinator:
    def __init__(self, ...):
        ...
        self._history_cache: dict | None = None
        self._history_expires_at: datetime | None = None
        self._aggregator = HelmanHistoryAggregator(hass, config)

    async def get_history(self) -> dict:
        now = datetime.now(tz=timezone.utc)
        if (
            self._history_cache is None
            or self._history_expires_at is None
            or now >= self._history_expires_at
        ):
            self._history_cache = await self._aggregator.async_get_history(
                self._power_sensor_ids,
                self._source_sensor_ids,
                self._cached_tree,
            )
            # Cache for one full bucket window; auto-expires so clients get
            # fresh data after enough real time has passed
            bucket_duration = self._config.get("history_bucket_duration", 1)
            self._history_expires_at = now + timedelta(seconds=bucket_duration * 2)
        return self._history_cache
```

## Frontend: Replace `enrichDeviceTreeWithHistory()`

In `energy-data-helper.ts`:

```typescript
// BEFORE: large history WS call + O(N×M) bucketing in TS
async function enrichDeviceTreeWithHistory(hass, config, deviceTree, sourceNodes) {
  const raw = await hass.connection.sendMessagePromise({
    type: 'history/history_during_period',
    entity_ids: [...allPowerSensorIds],
    start_time: ...,
    end_time: ...,
    minimal_response: true,
    no_attributes: true,
  });
  // ... 150 lines of bucketing and ratio computation ...
}

// AFTER: single backend call, assign pre-computed arrays
async function enrichDeviceTreeWithHistoryFromBackend(
  hass: HomeAssistant,
  deviceTree: DeviceNode[]
): Promise<void> {
  const history = await hass.connection.sendMessagePromise({
    type: "helman/get_history",
  });

  const { entity_history, source_ratios, unmeasured_history } = history;

  for (const node of walkTree(deviceTree)) {
    if (node.powerSensorId && entity_history[node.powerSensorId]) {
      node.powerHistory = entity_history[node.powerSensorId];
    }
    if (source_ratios[node.powerSensorId]) {
      node.sourcePowerHistory = convertSourceRatiosToNodeFormat(
        source_ratios[node.powerSensorId],
        node.powerHistory.length
      );
    }
    if (node.isUnmeasured && unmeasured_history[node.id]) {
      node.powerHistory = unmeasured_history[node.id];
    }
  }
}
```

## Payload Size Estimate

With 60 buckets and 20 entities:
- `entity_history`: 20 × 60 = 1200 floats ≈ 6–8 KB JSON
- `source_ratios` (20 consumers × 3 sources × 60 buckets): 3600 floats ≈ 18–25 KB

Total: ~30 KB per history fetch. The current `history/history_during_period`
response for the same period is typically **5–20×** larger because it includes raw
timestamped state entries. This phase should reduce history payload size
significantly.

## History Update Strategy

History is now **fetch-on-connect** only. The frontend no longer maintains a live
history ring buffer in Phase 5.

For the live power display and the 1-minute rolling window in the history bars,
the backend updates the `sensor.helman_power_summary` entity every time a power
sensor changes (Phase 4). The frontend can use `hass` setter update cadence as
its implicit history accumulation signal, and re-fetches the full history from the
backend only on connect (or on explicit user refresh).

Alternatively, the backend can push an updated history snapshot periodically via
the power summary entity's attributes (e.g., include the last N bucket values in
`extra_state_attributes`). This avoids any re-fetch on-demand but increases the
attribute payload size.

**Recommended approach**: Include the last 60-bucket history in
`sensor.helman_power_summary` attributes so the frontend has no second request to
make on connect. The WS command `helman/get_history` remains available for extended
history windows if needed in the future.

## Commit Sequence
```
feat(history): add HelmanHistoryAggregator with recorder-based bucketing and ratio calc
feat(coordinator): add cached history refresh to HelmanCoordinator
feat(websockets): add helman/get_history WS command
feat(card): replace enrichDeviceTreeWithHistory with backend history fetch
```
