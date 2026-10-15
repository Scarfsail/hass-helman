"""Resolve tolerant mapping and list paths in configuration documents."""

from collections.abc import Mapping, Sequence
from typing import Any

PathSegment = str | int


def get(document: Any, path: str | Sequence[PathSegment]) -> Any:
    """The value at ``path``, or ``None`` where the document does not go there.

    Never raises. This is polled every couple of seconds against a draft the
    user is halfway through editing, so a path that runs into a string, a
    missing key or a short list is an ordinary Tuesday, not an error.
    """
    if isinstance(path, str):
        path = path.split(".")
    current = document
    for segment in path:
        if (
            isinstance(segment, str)
            and segment.isdecimal()
            and isinstance(current, (list, tuple))
        ):
            segment = int(segment)
        if isinstance(segment, int):
            if not isinstance(current, Sequence) or isinstance(current, (str, bytes)):
                return None
            if segment < 0 or segment >= len(current):
                return None
            current = current[segment]
            continue
        if not isinstance(current, Mapping):
            return None
        if segment not in current:
            return None
        current = current[segment]
    return current
