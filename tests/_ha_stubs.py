"""Legacy import helpers for backend tests."""

from __future__ import annotations

import importlib
import types
from datetime import datetime


def stub_module(name: str, **attrs) -> types.ModuleType:
    """Return the real import for legacy test setup helpers."""
    return importlib.import_module(name)


def stub_ha_dt(now: datetime | None = None) -> types.ModuleType:
    """Use Home Assistant's datetime helpers with an optional fixed clock."""
    module = importlib.import_module("homeassistant.util.dt")
    if now is not None:
        module.now = lambda: now
    return module
