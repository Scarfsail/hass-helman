from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol

from .optimizers import ExportPriceOptimizer, build_surplus_appliance_optimizer

KNOWN_OPTIMIZER_KINDS: frozenset[str] = frozenset(
    {"export_price", "surplus_appliance"}
)

if TYPE_CHECKING:
    from ..appliances import AppliancesRuntimeRegistry
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
    appliance_registry: "AppliancesRuntimeRegistry",
) -> Optimizer:
    if config.kind == "export_price":
        return ExportPriceOptimizer(
            id=config.id,
            stop_export_supported=(
                control_config is not None and control_config.stop_export_option is not None
            ),
        )
    if config.kind == "surplus_appliance":
        return build_surplus_appliance_optimizer(
            config,
            appliance_registry=appliance_registry,
        )
    raise ValueError(f"Unsupported optimizer kind: {config.kind}")
