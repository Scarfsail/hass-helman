"""Optimizer-neutral battery horizon simulation API.

The implementation remains in the long-standing self-sustainability module
while its callers migrate.  Keeping this facade makes the shared contract live
at the automation layer and preserves the public import used by appliance
runtime during that migration.
"""

from .optimizers.self_sustainability import HorizonSimulator, Trajectory, build_horizon_simulator

__all__ = ("HorizonSimulator", "Trajectory", "build_horizon_simulator")
