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
