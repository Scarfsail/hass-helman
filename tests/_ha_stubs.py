"""Shared ``sys.modules`` stub moves for the backend test files.

Each test file decides which helman modules it stubs. Home Assistant imports
always use the real installed modules.
"""

from __future__ import annotations

import importlib
import sys
import types
from datetime import datetime
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]


def stub_module(name: str, **attrs) -> types.ModuleType:
    """Stub a helman module, or return an unmodified real Home Assistant module."""
    if name == "homeassistant" or name.startswith("homeassistant."):
        return importlib.import_module(name)

    module = sys.modules.get(name)
    if module is None:
        module = types.ModuleType(name)
        sys.modules[name] = module
    for attr, value in attrs.items():
        setattr(module, attr, value)
    return module


def install_helman_packages(*subpackages: str) -> None:
    """Register ``custom_components``, ``custom_components.helman`` and the
    named helman subpackages (e.g. ``"scheduling"``) with ``__path__``
    pointing into the repo, so their real submodules import from disk."""
    path = _REPO_ROOT / "custom_components"
    stub_module("custom_components", __path__=[str(path)])
    stub_module("custom_components.helman", __path__=[str(path / "helman")])
    for subpackage in subpackages:
        stub_module(
            f"custom_components.helman.{subpackage}",
            __path__=[str(path / "helman" / subpackage.replace(".", "/"))],
        )


def stub_ha_dt(now: datetime | None = None) -> types.ModuleType:
    """Use Home Assistant's datetime helpers with an optional fixed clock."""
    module = importlib.import_module("homeassistant.util.dt")
    if now is not None:
        module.now = lambda: now
    return module


def snapshot_modules(names) -> dict[str, types.ModuleType | None]:
    """Record the current ``sys.modules`` entry (or ``None``) for each name."""
    return {name: sys.modules.get(name) for name in names}


def restore_modules(snapshot: dict[str, types.ModuleType | None]) -> None:
    """Put back the entries recorded by ``snapshot_modules``; names that were
    absent are removed again."""
    for name, module in snapshot.items():
        if module is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module
