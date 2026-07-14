"""Pytest configuration for the helman test suite.

IMPORTANT: this suite is NOT meant to be run as a single in-process
``pytest tests/`` invocation. Many test modules install their own conflicting
``sys.modules`` stubs at import time (some need the real ``homeassistant``
package present, others need it absent), so importing them all into one process
causes cross-file pollution and spurious failures. Run each file in its own
process instead -- use ``scripts/run_tests.sh`` locally and in CI.

This conftest is intentionally minimal: it only pins Home Assistant's default
time zone for modules that use the *real* ``homeassistant`` package. It never
imports ``homeassistant`` at collection time, so modules that stub it themselves
are left untouched.
"""

from __future__ import annotations

import pytest


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
