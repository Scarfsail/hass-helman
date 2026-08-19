"""Shared helpers for placing the solar forecast on the canonical 15-minute grid."""

from __future__ import annotations

#: The quarter-hour offsets, in minutes, that make up one hour of the canonical grid.
SUB_SLOT_OFFSETS_MIN = (0, 15, 30, 45)

#: How many canonical slots one source hour expands into.
SLOTS_PER_HOUR = len(SUB_SLOT_OFFSETS_MIN)


def split_hour_by_weights(hour_wh: float, sub_weights: list[float]) -> list[float]:
    """Split one hour's Wh across its sub-slots, weighted by ``sub_weights``.

    The weights are the upstream instantaneous-power samples, so the split
    follows the real intra-hour shape of the curve rather than flattening it.

    Falls back to an even split when the weights carry no signal — they sum to
    zero or less — which is what a night-time hour looks like.
    """
    if not sub_weights:
        return []

    total_weight = sum(sub_weights)
    if total_weight <= 0.0:
        share = hour_wh / len(sub_weights)
        return [share] * len(sub_weights)

    return [hour_wh * weight / total_weight for weight in sub_weights]
