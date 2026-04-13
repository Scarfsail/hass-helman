from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol

from .optimizers import ExportPriceOptimizer

KNOWN_OPTIMIZER_KINDS: frozenset[str] = frozenset({"export_price"})

if TYPE_CHECKING:
    from .config import OptimizerInstanceConfig
    from ..scheduling.schedule import ScheduleControlConfig
    from ..scheduling.schedule import ScheduleDocument


class Optimizer(Protocol):
    id: str
    kind: str

    def optimize(
        self,
        snapshot: Any,
        config: OptimizerInstanceConfig,
    ) -> ScheduleDocument: ...


def build_optimizer(
    config: "OptimizerInstanceConfig",
    *,
    control_config: "ScheduleControlConfig | None",
) -> Optimizer:
    if config.kind == "export_price":
        return ExportPriceOptimizer(
            id=config.id,
            stop_export_supported=(
                control_config is not None and control_config.stop_export_option is not None
            ),
        )
    raise ValueError(f"Unsupported optimizer kind: {config.kind}")
