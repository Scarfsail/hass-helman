"""Pytest configuration and per-module import isolation for the test suite."""

from __future__ import annotations

import sys
from types import ModuleType

import pytest


_MODULE_PREFIXES = (
    "homeassistant",
    "custom_components",
    "voluptuous",
    "automation_",
    "_ha_stubs",
    "dev",
    "test_",
)
_collected_modules: dict[pytest.Module, dict[str, ModuleType]] = {}


def _isolated_modules() -> dict[str, ModuleType]:
    """Find modules whose imports or stubs vary between test files."""
    return {
        name: module
        for name, module in sys.modules.items()
        if name.startswith(_MODULE_PREFIXES)
    }


def _clear_isolated_modules() -> None:
    for name in _isolated_modules():
        sys.modules.pop(name, None)


@pytest.hookimpl(hookwrapper=True)
def pytest_make_collect_report(collector: pytest.Collector):
    """Collect each test module with a fresh set of importable modules."""
    if not isinstance(collector, pytest.Module):
        yield
        return

    _clear_isolated_modules()
    yield
    _collected_modules[collector] = _isolated_modules()


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_protocol(item: pytest.Item):
    """Restore the module imports captured while collecting this test file."""
    collector = item.getparent(pytest.Module)
    if collector is None or collector not in _collected_modules:
        yield
        return

    previous = _isolated_modules()
    _clear_isolated_modules()
    sys.modules.update(_collected_modules[collector])
    try:
        yield
    finally:
        _clear_isolated_modules()
        sys.modules.update(previous)


@pytest.fixture(autouse=True)
def _default_time_zone():
    """Pin ``dt_util.DEFAULT_TIME_ZONE`` to Europe/Prague for the duration of a
    test when the real Home Assistant clock helpers are importable.

    Several modules assert on local-time slot ids (e.g. ``+01:00``) produced via
    ``dt_util.as_local``; HA's default zone is UTC unless configured. Modules
    that install a lightweight ``homeassistant.util.dt`` stub (without
    ``set_default_time_zone``) are detected and left as-is.
    """
    try:
        from homeassistant.util import dt as dt_util
    except ImportError:
        yield
        return

    setter = getattr(dt_util, "set_default_time_zone", None)
    getter = getattr(dt_util, "get_time_zone", None)
    if setter is None or getter is None:
        # A test module installed a stubbed ``homeassistant.util.dt``.
        yield
        return

    previous = getattr(dt_util, "DEFAULT_TIME_ZONE", None)
    setter(getter("Europe/Prague"))
    try:
        yield
    finally:
        if previous is not None:
            setter(previous)
