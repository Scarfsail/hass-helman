# P3 review fixtures

These are deterministic fixture renders from the existing Playwright inspector and house-detail tests, not a live Home Assistant installation. The inspector fixture shows July 18, 2026, import price 4 CZK/kWh, export price 1 CZK/kWh, and forecast cost/gain. End-of-day tooltip captures point to the final cell; the popup is centered for an unclipped review image.

| View | Original before P1 (`c8f0c9d`) | Before P3 (`af612c3`) | After P3 |
| --- | --- | --- | --- |
| Price strip | [original](535-original/inspector-price-strip.png) | [before](535-before/inspector-price-strip.png) | [after](535-after/inspector-price-strip.png) |
| Money strip | [original](535-original/inspector-money-strip.png) | [before](535-before/inspector-money-strip.png) | [after](535-after/inspector-money-strip.png) |
| Price end-of-day tooltip | [original](535-original/inspector-price-tooltip.png) | — | [after](535-after/inspector-price-tooltip.png) |
| Money end-of-day tooltip | [original](535-original/inspector-money-tooltip.png) | — | [after](535-after/inspector-money-tooltip.png) |
| House detail overview | [original](535-original/house-evening-desktop-1280-now.png) | [before](535-before/house-evening-desktop-1280-now.png) | [after](535-after/house-evening-desktop-1280-now.png) |
| House detail sources | [original](535-original/house-evening-desktop-1280-sources.png) | [before](535-before/house-evening-desktop-1280-sources.png) | [after](535-after/house-evening-desktop-1280-sources.png) |

The original money tooltip ends at `00:00`, while its price tooltip ends at `24:00`. Both now end at `24:00` (P1). Price tooltip and strip labels now show `4.00`/`1.00`, matching the inspector and node-detail default price precision (P3). Money amount labels deliberately keep the named compact precision; tooltips keep two decimals.

Capture commands:

```sh
SCREENS=<directory> npm --prefix frontend test -- inspector-strip-layout.spec.ts --grep screenshots
SCREENS=<directory> npm --prefix frontend test -- node-detail-house.spec.ts --grep screenshots
```

The original baseline used an isolated detached worktree with the same inspector screenshot fixture added; no source branch switch was required. Only representative desktop house screenshots are retained here.
