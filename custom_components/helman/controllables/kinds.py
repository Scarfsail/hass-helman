"""The four controllable kind names, below everything that reads them.

:mod:`.spec` declares what each kind does and so imports the appliance readers,
normalizers and drivers; :mod:`.config` and those readers need the names too.
They live here so neither side has to import the other to spell a kind.
"""

CONTROLLABLE_KIND_INVERTER = "inverter"
CONTROLLABLE_KIND_CLIMATE = "climate"
CONTROLLABLE_KIND_EV_CHARGER = "ev_charger"
CONTROLLABLE_KIND_GENERIC = "generic"
