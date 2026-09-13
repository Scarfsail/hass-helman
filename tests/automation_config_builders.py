"""Build optimizer configs for tests *through the real reader*.

Import AFTER a test module has installed its ``custom_components`` import stubs.

Constructing ``OptimizerInstanceConfig`` by hand lets a test assert against a
config the reader would have rejected — resolved params that never got their
defaults, a group that skipped cross-field validation, a key that moved. Going
through ``AutomationConfig.from_dict`` means every fixture in the suite is a
config a user could actually save.
"""

from __future__ import annotations

from typing import Any

from custom_components.helman.automation.config import AutomationConfig
from custom_components.helman.automation.spec import (
    OPTIMIZER_BUCKET_APPLIANCE,
    OPTIMIZER_SPECS,
)


def make_optimizer_config(**optimizer: Any):
    """Read one optimizer dict and return the resolved ``OptimizerInstanceConfig``.

    Routed into whichever bucket its kind belongs to — the flat ``optimizers``
    key the reader used to accept is gone, and a fixture that lands in the
    wrong bucket is rejected with ``wrong_bucket`` just like a hand-authored
    config would be.
    """
    bucket_key = (
        "appliance_optimizers"
        if OPTIMIZER_SPECS[optimizer["kind"]].bucket == OPTIMIZER_BUCKET_APPLIANCE
        else "system_optimizers"
    )
    return AutomationConfig.from_dict({bucket_key: [optimizer]}).all_optimizers[0]
