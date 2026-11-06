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

`node=ev_charger, section=history` is the charging ledger (`custom_components/helman/ev_sessions/`), offered in the overview's `sections` only for a charger whose hardware profile resolves a `run_mode`. It carries `window` (the sliding last 30 days, UTC), `totals` (kWh summed from the hourly slices starting inside the window, the segment still charging once and `provisional`; `sources` or `null` when nothing is attributed; `paid`, `forgone`, `gridPaid` and `solarForgone`, each with priced and unpriced kWh), `chargingDays`, `coveredDays` (how many of the 30 days the ledger has recorded, fewer while backfill runs or the recorder keeps less) and `perWeek` (charging days over `coveredDays`, times 7), `paidPerKwh` (paid over priced charger kWh), `gridPricePerKwh` (grid paid over priced grid kWh), `per100km` (only for a charger with one car whose SoC device holds exactly one finite positive kWh/100 km reading), `priceUnit`, the newest 20 `segments` whatever the window, `complete` and `health`. A charging segment is one recorded `Charging` stretch of the run mode, never a plug-in session. `unavailable` is `no_run_mode` for a charger the ledger does not follow and `not_loaded` without a ledger; a failed recorder read answers what is stored with `complete` false and `health.error` set.
