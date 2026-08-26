"""The wire shape of an entity inspection: facts, not sentences.

The whole point of this package is that the config editor learns nothing about
what an entity *means*. So an inspection carries no rendered text, no sign, no
unit-aware formatting decision and no branch for the frontend to take -- only a
list of :class:`Fact`, each naming a translation token, the placeholders that
token takes, and how prominently to draw it. The editor localizes the token and
renders the list in order.

That is what keeps a new evaluation kind (history depth, staleness, whatever
comes next) backend work plus translation strings. If a change here would make
the frontend branch on the *content* of a fact rather than on its severity, the
fact is carrying meaning it should have resolved itself.

``severity`` deliberately does not include an "error": the group *shows*, the
validator *judges*. A reading that looks wrong is still a reading, and telling
the user it is invalid is ``helman/validate_config``'s job, not this one's.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from .context import PathSegment

#: How prominently the editor draws a fact. Chooses a badge class and nothing
#: else -- the frontend never reads it to decide *what* to render.
Severity = Literal["neutral", "info", "ok", "warn"]

#: Where an inspection got to. ``unsupported`` is the honest answer for a path
#: with no registered evaluator: a group can be placed anywhere, and one whose
#: path nothing knows about simply shows its picker.
Status = Literal["ok", "unset", "unavailable", "unsupported"]


@dataclass(frozen=True)
class Fact:
    """One localizable statement about a picked entity.

    ``id`` is stable across polls so the editor can key a list on it; ``token``
    is a key suffix under ``editor.entity_status.`` in the editor's own
    translation files. The two are separate because the same slot can carry
    different tokens between polls -- the ``reading`` fact says ``charging``
    now and ``discharging`` in two seconds, and it is the same fact.
    """

    id: str
    token: str
    params: dict[str, Any] = field(default_factory=dict)
    severity: Severity = "neutral"

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "token": self.token,
            "params": dict(self.params),
            "severity": self.severity,
        }


@dataclass(frozen=True)
class Inspection:
    """What one config path currently amounts to.

    ``consulted`` is every ``(path, value)`` the evaluator actually looked at --
    the entity id and each setting that shaped these facts -- and it answers two
    different questions from one list, which is the point of it being one list.

    * :attr:`signature` is its values, and lets the *backend* decide whether the
      draft and the saved document differ in anything that matters here. The
      editor holds both documents and could diff them, but only the evaluator
      knows which keys its answer depends on.
    * :attr:`depends_on` is its paths, and reaches the frontend as ``dependsOn``
      so that a revert restores exactly what the reading depended on. Anything
      else in the group -- a training window that rides in the same slot because
      it is the same entity's setting -- is untouched by a revert, because
      resetting a value that could never have caused the revert control to
      appear is a silent edit the user never asked for.

    Keeping them as one list is what stops those two answers from drifting: a
    setting cannot enter the comparison without also becoming revertible, and a
    path cannot be offered for revert unless it really was read.
    """

    entity_id: str | None
    status: Status
    facts: tuple[Fact, ...] = ()
    consulted: tuple[tuple[tuple[PathSegment, ...], Any], ...] = ()

    @property
    def signature(self) -> tuple[Any, ...]:
        """The values behind these facts, for the draft-versus-saved comparison."""
        return tuple(value for _path, value in self.consulted)

    @property
    def depends_on(self) -> tuple[tuple[PathSegment, ...], ...]:
        """The config paths behind these facts, in the order they were read."""
        return tuple(path for path, _value in self.consulted)

    def to_dict(self) -> dict[str, Any]:
        return {
            "entityId": self.entity_id,
            "status": self.status,
            "facts": [fact.to_dict() for fact in self.facts],
            "dependsOn": [list(path) for path in self.depends_on],
        }
