from __future__ import annotations

from typing import Literal

ScheduleActionSetBy = Literal["user", "automation"]
SCHEDULE_ACTION_SET_BY_VALUES = {"user", "automation"}


def read_optional_schedule_action_set_by(
    value: object,
    *,
    path: str,
) -> ScheduleActionSetBy | None:
    if value is None:
        return None
    if value not in SCHEDULE_ACTION_SET_BY_VALUES:
        raise ValueError(
            f"{path} must be one of {', '.join(sorted(SCHEDULE_ACTION_SET_BY_VALUES))}"
        )
    return value
