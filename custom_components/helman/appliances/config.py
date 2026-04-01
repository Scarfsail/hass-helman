from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class AppliancesRuntimeRegistry:
    appliances: dict[str, Any] = field(default_factory=dict)


def build_appliances_runtime_registry(
    config: Mapping[str, Any] | None,
) -> AppliancesRuntimeRegistry:
    del config
    return AppliancesRuntimeRegistry()
