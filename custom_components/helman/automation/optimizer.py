from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol

KNOWN_OPTIMIZER_KINDS: frozenset[str] = frozenset()

if TYPE_CHECKING:
    from .config import OptimizerInstanceConfig
    from ..scheduling.schedule import ScheduleDocument


class Optimizer(Protocol):
    id: str
    kind: str

    def optimize(
        self,
        snapshot: Any,
        config: OptimizerInstanceConfig,
    ) -> ScheduleDocument: ...
