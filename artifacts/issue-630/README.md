# Issue #630 visual review

Captured with the `@screens` cases in `frontend/tests/simple-card-live-flows.spec.ts` against the bundled card in Chromium. The screenshots use the mock Home Assistant data from the same spec. The overridden palette is solar purple, grid orange, battery teal, house lavender, with distinct grid import and export accents. The default source palette is yellow, blue, and green.

| Scenario | Evidence | Observation |
| --- | --- | --- |
| Light, default, solar export and charge | [light-export.png](light-export.png) | Solar ribbons connect the grid, house, and battery. |
| Dark, overridden, solar export and charge | [dark-export-themed.png](dark-export-themed.png) | Source, ribbons, battery charge glow, and grid export wires use the overridden solar purple; the grid pole and label use the export accent. The light band is visible on horizontal and diagonal paths. |
| Light, default, grid import and charge | [light-grid-charge.png](light-grid-charge.png) | Grid flow runs down to the battery and diagonally toward the house. |
| Dark, overridden, grid import and charge | [dark-grid-charge-themed.png](dark-grid-charge-themed.png) | Grid node, ribbons, and battery charge glow use the overridden orange. Import dots use the separate import accent. |
| Light, default, battery discharge and export | [light-battery-discharge.png](light-battery-discharge.png) | Battery flow runs toward the house and up to the grid. |
| Dark, overridden, mixed sources | [dark-mixed-themed.png](dark-mixed-themed.png) | Solar, grid, and battery flows keep distinct colors while all three feed the house. |
| Standalone illustrations and two instances | [standalone-and-two-cards.png](standalone-and-two-cards.png) | The active standalone house has no source attribution and uses the lavender house hook; the standalone grid shows the export accent with source-colored wires. Two cards render their own sweeping bands. The spec also checks that mask and gradient IDs are unique across instances. |

These screenshots are still frames of an animation. The behavioral spec verifies that the band transform changes over time and that width, duration, opacity, and direction match the shared flow constants.
