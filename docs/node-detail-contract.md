# Node detail contract

`helman/get_device_tree` may put `applianceKind` on a house device node when
`controllableIds` contains exactly one schedulable controllable. The value is
read from that device's configured kind. Shared meters, virtual groups and
remainders have no kind. An older tree without the field opens the generic
device detail; the dialog does not fetch the appliance roster to classify it.

`helman/get_node_detail` answers `node=grid, section=money` with today's local
inspector span aggregate, projected to `priceUnit`, `importCost`,
`exportRevenue`, `importKwh`, `exportKwh`, `importPricedKwh` and
`exportPricedKwh`. Each amount is nullable. A measured zero kWh with no priced
amount is a known zero; missing energy or a positive unpriced amount stays
unknown. `unavailable` is `no_day_aggregate` when no day row exists. The
section is loaded when grid detail opens and uses the normal section refresh
and stale reply lifecycle.

`node=house, section=ranking` carries `report`, the existing ranking device
report for today's local date, plus `unavailable` when that report cannot be
built. The full report is requested only while the consumers evidence is open.
House `today` and `ranking` use the same report provider and date query.

`node=ev_charger` offers the sections `segment` and, conditionally, `history`. `node=ev_charger, section=history` is the charging ledger (`custom_components/helman/ev_sessions/`), offered in the overview's `sections` only for a charger whose hardware profile resolves a `run_mode` and whose config names its `consumption.power_entity_id`. It carries `priceUnit`, the newest 20 `segments` (each with its kWh, `sources` or `null` when nothing is attributed, and the money sides `paid`, `forgone`, `gridPaid`, `batteryPaid`, `solarForgone` and `virtual`, each with priced and unpriced kWh; `batteryPaid` and `virtual` are derived by `Attribution`), `complete` (every returned segment closed and settled, and the last read did not fail) and `health`. The period's totals, rates and how often are not the ledger's: the detail reads them from `helman/get_node_history` by the charger's tree node id, with optional `start_date`/`end_date` and `navigationRange`, like every consumer (`docs/device-reports.md`, *Node history*). Its figures are the charger's alone: nothing of any car is read into them. A charging segment is one continuous recorded stretch in which the charge power is above 1 kW (standby draw is not charging; a non-numeric reading is a gap, bridged up to the segment gap limit), never a plug-in session; it follows the power, not the run mode, so it need not match the `segment` section's run-mode `charging` stretches. `health.powerEntityId` names the power entity it follows. `unavailable` is `not_tracked` for a charger the ledger does not follow and `not_loaded` without a ledger; a failed recorder read answers what is stored with `complete` false and `health.error` set.
