"""Inverter kind behavior independent of schedule parsing."""

from typing import Any


def inverter_action_from_state(runtime: Any, state: str) -> dict[str, Any] | None:
    """Resolve only options configured for this inverter."""
    return next(
        ({"kind": kind} for kind, option in runtime.options.items() if option == state),
        None,
    )
