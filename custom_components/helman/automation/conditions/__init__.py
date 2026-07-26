"""Condition types and the OR/AND algebra over them.

A condition is a function ``(snapshot, value, target, master_params) -> SlotMask``.
That one signature absorbs every scope: per-slot conditions compute a real mask,
per-day conditions produce a mask constant within each local date, and per-run
conditions produce an all-true or all-false mask. Group semantics are then pure
set algebra, written once in :mod:`.evaluation` instead of five times in the
optimizers.
"""

from .evaluation import (
    Eligibility,
    GroupResolution,
    SlotEligibility,
    build_eligibility,
)
from .types import (
    CONDITION_TYPES,
    CUSTOM_KEY,
    ConditionType,
    MaskInputs,
    Scope,
    condition_type,
)

__all__ = [
    "CONDITION_TYPES",
    "CUSTOM_KEY",
    "ConditionType",
    "Eligibility",
    "GroupResolution",
    "MaskInputs",
    "Scope",
    "SlotEligibility",
    "build_eligibility",
    "condition_type",
]
