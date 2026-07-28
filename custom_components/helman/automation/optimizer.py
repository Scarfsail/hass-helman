from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any, Protocol

from .optimizers import (
    build_charge_from_grid_optimizer,
    build_charge_hold_optimizer,
    build_appliance_runtime_optimizer,
    build_export_price_optimizer,
)
from .spec import KNOWN_OPTIMIZER_KINDS

if TYPE_CHECKING:
    from ..appliances import AppliancesRuntimeRegistry
    from ..scheduling.schedule import ScheduleControlConfig, ScheduleDocument
    from .config import OptimizerInstanceConfig
    from .trace import OptimizerTrace

__all__ = ["KNOWN_OPTIMIZER_KINDS", "Optimizer", "build_optimizer"]


class Optimizer(Protocol):
    id: str
    kind: str

    def optimize(
        self,
        snapshot: Any,
        config: OptimizerInstanceConfig,
        trace: "OptimizerTrace | None" = None,
    ) -> ScheduleDocument: ...


#: Construction stays per kind: `export_price` needs the inverter's control
#: config and the two appliance kinds need the runtime registry, none of which
#: the schema can express. The registry removes the *dispatch chain*, not the
#: construction.
_BUILDERS: dict[str, Callable[..., "Optimizer"]] = {
    "export_price": build_export_price_optimizer,
    "charge_hold": build_charge_hold_optimizer,
    "charge_from_grid": build_charge_from_grid_optimizer,
    "appliance_runtime": build_appliance_runtime_optimizer,
}


def build_optimizer(
    config: "OptimizerInstanceConfig",
    *,
    control_config: "ScheduleControlConfig | None",
    appliance_registry: "AppliancesRuntimeRegistry",
    path: str = "automation.optimizers[?]",
) -> Optimizer:
    builder = _BUILDERS.get(config.kind)
    if builder is None:
        raise ValueError(f"Unsupported optimizer kind: {config.kind}")
    return builder(
        config,
        appliance_registry=appliance_registry,
        path=path,
        stop_export_supported=(
            control_config is not None and control_config.stop_export_option is not None
        ),
    )
