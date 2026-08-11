"""Everything Helman can drive, described once instead of four times.

The integration has always had four kinds of controllable — the inverter, and
the ``climate`` / ``ev_charger`` / ``generic`` appliances — but nothing said so.
Each kind was implied by its own config reader and its own executor, which is
why the inverter and the EV charger ended up with two copies of the same select
controller. :mod:`.spec` writes the taxonomy down; :mod:`.controllers` holds the
entity drivers that more than one kind needs.
"""
