"""The Helman card's settings, under ``visualization`` since config version 18."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

#: One default per key, and the only place they are spelled. Before v18 these
#: sat at the top level, where the shallow load merge filled each one in on its
#: own; nested, a partial ``visualization`` object would replace the whole set,
#: so every reader resolves through :func:`read_visualization` instead of
#: carrying a fallback of its own -- which is also how the tick and the history
#: payload once disagreed on the bucket duration (5 s against 1 s).
#:
#: ``power_sensor_name_cleaner_regex`` has no entry on purpose: absent means
#: "clean nothing", and an empty string is not a value validation accepts, so
#: filling one in on load would make an untouched document fail to save.
VISUALIZATION_DEFAULTS: dict[str, Any] = {
    "history_buckets": 60,
    "history_bucket_duration": 5,
    "sources_title": "Energy Sources",
    "consumers_title": "Energy Consumers",
    "groups_title": "Group by:",
    "others_group_label": "Others",
    "show_empty_groups": False,
    "show_others_group": True,
    "device_label_text": {},
}


def read_visualization(config: Mapping[str, Any]) -> dict[str, Any]:
    """``config["visualization"]`` with every omitted key filled from the defaults.

    A shallow merge: the result shares the default ``device_label_text``, so a
    caller that stores it in a document copies it first.
    """
    visualization = config.get("visualization")
    if not isinstance(visualization, Mapping):
        visualization = {}
    return {**VISUALIZATION_DEFAULTS, **visualization}
