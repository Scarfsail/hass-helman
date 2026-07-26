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


def make_optimizer_config(**optimizer: Any):
    """Read one optimizer dict and return the resolved ``OptimizerInstanceConfig``."""
    return AutomationConfig.from_dict({"optimizers": [optimizer]}).optimizers[0]
