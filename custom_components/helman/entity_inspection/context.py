"""Everything an evaluator is given, and nothing more.

An evaluator receives a *document* and a *path into it* -- never an entity id
and never a settings value. That asymmetry is the whole design: the request the
editor sends names only where to look, so "which settings does this reading
depend on?" stays knowledge of this package rather than being split across the
websocket boundary into TypeScript. An evaluator that wants the polarity reads
it from the same document, at a path it decides.

``wildcards`` carries the segments the registry key matched with ``*``, in
order, so the polarity evaluator learns which power device it is looking at
from the path itself.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

#: A config path segment: a mapping key or a list index.
PathSegment = str | int


def value_at(document: Any, path: Sequence[PathSegment]) -> Any:
    """The value at ``path``, or ``None`` where the document does not go there.

    Never raises. This is polled every couple of seconds against a draft the
    user is halfway through editing, so a path that runs into a string, a
    missing key or a short list is an ordinary Tuesday, not an error.
    """
    current = document
    for segment in path:
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


@dataclass(frozen=True)
class InspectionRequest:
    """One target, resolved against one document.

    ``hass`` is here because a reading is by definition live; everything else
    an evaluator needs comes out of ``config``.
    """

    hass: Any
    config: Any
    path: tuple[PathSegment, ...]
    wildcards: tuple[str, ...]

    def value(self, *path: PathSegment) -> Any:
        """The value at an absolute path in this request's document."""
        return value_at(self.config, path)

    def target_value(self) -> Any:
        """The value at the target path itself -- normally the entity id."""
        return value_at(self.config, self.path)

    def entity_id(self) -> str | None:
        """The target as an entity id, or ``None`` when it is not one yet."""
        value = self.target_value()
        if isinstance(value, str) and value.strip():
            return value.strip()
        return None
