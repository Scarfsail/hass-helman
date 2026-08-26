"""What the config editor's entity groups are told, and who decides it.

The editor shows, next to every entity picker, what that entity currently reads
and what Helman makes of it. Getting that on screen could have been done in the
frontend -- read the state, look at the polarity, pick a word -- and it is
precisely that shortcut this package exists to refuse. The interpretation
already lives on the backend, in the modules the runtime itself uses, and a
second copy in TypeScript would be a second thing to keep in step with every
change to the first.

So the editor sends a **config path** and its **draft document**. It sends no
entity id, because the entity id is at that path in that document; and no
settings, because which settings qualify an entity is exactly the knowledge
being kept here. What comes back is a list of localizable facts, which the
editor renders in order and does not read.

Draft versus saved is decided here for the same reason. The editor holds both
documents and could diff them, but only an evaluator knows which keys its
answer depends on -- so the caller sends both and gets ``saved: null`` when
nothing the reading depends on moved.

Nothing in here raises. It is polled every couple of seconds against a document
the user is in the middle of editing.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

from .context import InspectionRequest, PathSegment
from .model import Fact, Inspection, Severity, Status
from .registry import EVALUATORS, Evaluator, evaluator_for, match_key

__all__ = [
    "EVALUATORS",
    "Evaluator",
    "Fact",
    "Inspection",
    "InspectionRequest",
    "PathSegment",
    "Severity",
    "Status",
    "evaluator_for",
    "has_list_index",
    "inspect_target",
    "inspect_targets",
    "match_key",
    "normalize_path",
]

#: What a path with no registered evaluator answers, for every document.
_UNSUPPORTED = Inspection(entity_id=None, status="unsupported")


def normalize_path(raw: Iterable[Any]) -> tuple[PathSegment, ...]:
    """A path from the wire as segments this package can walk.

    Strings and integers pass through; anything else is coerced to its string
    form rather than rejected, because rejecting it would mean raising on a
    poll. A nonsensical segment simply matches no key and reads as unsupported.
    """
    segments: list[PathSegment] = []
    for segment in raw:
        if isinstance(segment, bool):
            segments.append(str(segment))
        elif isinstance(segment, (str, int)):
            segments.append(segment)
        else:
            segments.append(str(segment))
    return tuple(segments)


def inspect_target(
    hass: Any,
    config: Any,
    path: Sequence[PathSegment],
) -> Inspection:
    """One path against one document, never raising.

    An evaluator that raises anyway is contained here rather than failing the
    whole poll: one broken reading must not blank the other nineteen groups.
    """
    found = evaluator_for(path)
    if found is None:
        return _UNSUPPORTED
    evaluator, wildcards = found
    request = InspectionRequest(
        hass=hass,
        config=config,
        path=tuple(path),
        wildcards=wildcards,
    )
    try:
        return evaluator(request)
    except Exception:  # noqa: BLE001 - a polled endpoint answers, or says less
        return Inspection(entity_id=None, status="unsupported")


def inspect_targets(
    hass: Any,
    config: Any,
    targets: Iterable[Any],
    saved_config: Any = None,
) -> list[dict[str, Any]]:
    """Every target the editor asked about, in the order it asked.

    ``saved`` is non-``null`` only when the saved document would produce a
    different reading -- judged on the evaluator's own ``signature``, which is
    everything it consulted, not on a diff of the two documents. When no saved
    document was sent there is nothing to compare against and ``saved`` is
    always ``null``.

    A target that is not a mapping, or carries no usable ``path``, still gets a
    row: dropping it would leave the editor waiting forever for a key that
    never comes back.

    **A path through a list index never gets a saved reading**, however
    different the two documents are -- see :func:`has_list_index`.
    """
    results: list[dict[str, Any]] = []
    for index, target in enumerate(targets):
        key, raw_path = _read_target(target, index)
        path = normalize_path(raw_path)
        draft = inspect_target(hass, config, path)
        saved: Inspection | None = None
        if saved_config is not None and not has_list_index(path):
            candidate = inspect_target(hass, saved_config, path)
            if candidate.signature != draft.signature:
                saved = candidate
        results.append(
            {
                "key": key,
                "draft": draft.to_dict(),
                "saved": saved.to_dict() if saved is not None else None,
            }
        )
    return results


def has_list_index(path: Sequence[PathSegment]) -> bool:
    """Whether this path reaches its value through a position in a list.

    Such a path names *where a value sits*, not *which value it is*, and the
    difference is what makes a saved comparison unanswerable for it. Delete the
    first of three entity ids and every later one shifts up a place: the
    document at index 1 now holds what index 2 held, and the saved document at
    index 1 holds something the user deliberately removed. Offering that as
    "the saved reading" invites a revert that writes the deleted entity back
    over a kept one -- and reordering two entries invites one that duplicates a
    sensor. Neither is an edit anybody asked for.

    So a list target gets ``saved: null``, always. The reading itself is still
    live and still correct; the only thing withheld is a comparison against a
    document that has no way to say which entry it is talking about.

    This lives here rather than in the editor because it is the same kind of
    knowledge as "what does this path mean": the backend owns what can be
    compared, and the frontend renders whatever comparison comes back.
    """
    return any(isinstance(segment, int) for segment in path)


def _read_target(target: Any, index: int) -> tuple[str, tuple[Any, ...]]:
    """The caller's key and raw path, tolerating a malformed entry."""
    if not isinstance(target, dict):
        return f"#{index}", ()
    key = target.get("key")
    raw_path = target.get("path")
    return (
        key if isinstance(key, str) and key else f"#{index}",
        tuple(raw_path) if isinstance(raw_path, (list, tuple)) else (),
    )
