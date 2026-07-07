# Scheduler appliance actions - first increment

## Goal

Extend the scheduling UI so the scheduler can surface and author appliance actions next to the existing inverter action.

First increment scope:

- show planned appliance actions in the scheduler action column
- keep the action column visually stable even when a row has no appliance action
- allow editing inverter action and appliance actions from the same dialog
- keep inverter action mandatory
- keep each appliance action optional and removable
- support generic appliance layout for all scheduler-capable appliances
- start with the existing appliance feature, especially `ev_charger`, as the first appliance with full authoring UI

Out of scope for this increment:

- EV SoC projection UI
- appliance runtime UI
- forecast / projection integration in the scheduler
- non-EV appliance-specific embellishments beyond the generic scaffolding needed to support them

## Backend contract this UI should assume

The backend contract is already appliance-ready and should be treated as the source of truth:

- `helman/get_schedule` and `helman/set_schedule` use composite slot domains:
  - `domains.inverter`
  - `domains.appliances`
- `domains.appliances` is a sparse object keyed by `applianceId`
- `helman/get_appliances` provides metadata, authoring capabilities, vehicle IDs, and entity mapping
- EV is the first appliance kind under the generic `appliances` umbrella

Relevant EV scheduler semantics:

- missing `domains.appliances[applianceId]` means there is no explicit appliance action for that slot
- EV action payload uses slot intent such as:
  - `vehicleId`
  - `charge`
  - `useMode`
  - `ecoGear`
- `charge = false` is the authored "no charging" state for that appliance
- `slot_stop` is runtime-only and must not be authored by FE
- v1 EV scheduling modes are `Fast` and `ECO`

Example target slot shape:

```json
{
  "id": "2026-03-20T21:00:00+01:00",
  "domains": {
    "inverter": {
      "kind": "stop_charging"
    },
    "appliances": {
      "garage-ev": {
        "vehicleId": "kona",
        "charge": true,
        "useMode": "ECO",
        "ecoGear": "10A"
      }
    }
  }
}
```

## Current frontend gap map

The FE already has the websocket seams for appliances, but the scheduler UI is still inverter-only.

### Already present

- `src/helman-api.ts`
  - `ScheduleDomainsDTO` already includes `appliances: Record<string, unknown>`
  - websocket request types already exist for `helman/get_appliances` and `helman/get_appliance_projections`
- `src/helman/client.ts`
  - thin wrappers already exist for `getAppliances()` and `getApplianceProjections()`
- `src/helman/store.ts`
  - store methods already expose those calls

### Still inverter-only

- `src/helman-scheduling/model/schedule-normalizer.ts`
  - normalizes each slot to `slot.domains.inverter` only
- `src/helman-scheduling/schedule-types.ts`
  - defines slot action as inverter `ScheduleActionDTO` only
- `src/helman-scheduling/model/schedule-hour-bucket-builder.ts`
  - groups and renders hour rows based only on inverter action identity
- `src/helman-scheduling/components/scheduling-slot-table.ts`
  - action column renders only inverter chips
- `src/helman-scheduling/dialogs/scheduling-range-edit-dialog.ts`
  - dialog offers only inverter actions
- `src/helman/models.ts`
  - write helpers intentionally build inverter-only slots and force `appliances: {}`
- `src/helman/store.ts`
  - patch application writes inverter-only slot payloads

This means the first increment needs real model changes, not just extra chips in the table.

## Confirmed product decisions

The current confirmed choices for this increment are:

- generic appliance layout for all scheduler-capable appliances
- EV charger is the only appliance with full authoring UI in this increment
- use one shared appliance area in the action column instead of fixed per-appliance lanes
- keep empty appliance space visually blank when a row has no appliance actions
- when selected slots disagree, prefill the dialog from the first selected slot
- do not show vehicle name in the scheduler table

## Recommended frontend behavior

## 1. Action column

Each row should render a stable action cell composed from:

1. inverter action lane - always present
2. one shared appliance area - present in the layout, but visually empty when no appliance action exists in that row

Implications:

- row width stays aligned because every row uses the same action-cell structure
- appliance actions do not consume their own fixed columns per appliance
- when a slot has no appliance actions, the appliance area remains blank
- hour rows should follow the same lane layout as raw slot rows

### Suggested presentation model

Introduce a row-level action model instead of treating the action cell as "one action":

```ts
type ScheduleRowActionContent = {
  inverter: ScheduleInverterAction;
  appliances: Array<{
    applianceId: string;
    applianceName: string;
    action: ScheduleApplianceAction;
  }>;
};
```

The table can then render:

- inverter first
- appliance chips after it inside one shared area
- appliance chips ordered by appliance metadata order when more than one appliance is present

### EV lane label for first increment

For the first increment, keep appliance display compact and honest:

- if no appliance action: render nothing in the shared appliance area
- if EV `charge = false`: render a compact no-charge label
- if EV `charge = true`: render mode only in the table
- include `ecoGear` only when relevant

Exact compact copy should be finalized during implementation once the desired density is confirmed.

## 2. Edit dialog

The current dialog models one shared inverter action. It needs to become a composite domain editor.

### Required structure

The dialog should be split into:

1. **Inverter**
   - always present
   - always required
   - keeps the current action picker behavior

2. **Appliances**
   - one section per scheduler-capable appliance
   - each section is optional
   - each section can be removed independently

### EV appliance section

For `ev_charger`, the first increment should support:

- no action / remove action
- `charge = false`
- `charge = true` with selected `vehicleId`
- `useMode` selection
- `ecoGear` selection when mode requires it

The UI should be driven from backend metadata:

- appliance name
- supported modes
- supported eco gears
- whether vehicle selection is required
- available vehicles

The UI should not hardcode these from current local HA state alone.

### Dialog result shape

The dialog should return authored domains, not only inverter action:

```ts
type ScheduleDialogResult = {
  domains: {
    inverter: ScheduleInverterAction;
    appliances: Record<string, ScheduleApplianceAction>;
  };
};
```

This keeps the write path aligned with `helman/set_schedule`.

## 3. Write path

The current write path always rebuilds slots as inverter-only payloads. That must change.

### Needed changes

- replace inverter-only patch helpers with full-domain patch helpers
- preserve sparse `domains.appliances`
- remove an appliance action by omitting that `applianceId` from the authored slot payload
- continue sending only changed selected slots

The write path should build:

```ts
{
  id,
  domains: {
    inverter,
    appliances,
  },
}
```

instead of forcing `appliances: {}`

## 4. Data loading

The scheduler card currently loads schedule and forecast only. This increment should also load appliance metadata.

### Minimum needed data

- schedule from `helman/get_schedule`
- appliance metadata from `helman/get_appliances`

The table and dialog need the metadata for:

- stable appliance ordering
- labels
- kind
- authoring capabilities
- vehicle list

Projection data should stay out of this increment.

### Integration options

Two reasonable options:

1. extend the scheduling owner to also own appliance metadata
2. load appliance metadata separately in the scheduling card

Recommendation: keep ownership close to the scheduling card surface, but avoid mixing metadata fetch logic directly into render code.

## 5. Frontend type changes

The first increment should introduce explicit frontend schedule domain types instead of leaving appliances as `Record<string, unknown>`.

### Needed type layers

- typed schedule domains for FE scheduling
- typed appliance metadata DTOs at least for the fields needed by the scheduler
- typed EV appliance action model

Suggested direction:

```ts
type ScheduleDomains = {
  inverter: ScheduleInverterAction;
  appliances: Record<string, ScheduleApplianceAction>;
};

type ScheduleApplianceAction =
  | ScheduleEvChargerAction;

type ScheduleEvChargerAction = {
  kind: "ev_charger";
  vehicleId?: string;
  charge: boolean;
  useMode?: string;
  ecoGear?: string;
};
```

Whether the backend already includes `kind` inside each appliance action should be confirmed before implementation. If it does not, FE should model the action shape in a way that still preserves the appliance kind from metadata without inventing a conflicting contract.

## 6. Table/model files likely to change

Most likely FE touchpoints for this increment:

- `src/helman-api.ts`
- `src/helman/models.ts`
- `src/helman/store.ts`
- `src/helman-scheduling/schedule-types.ts`
- `src/helman-scheduling/model/schedule-normalizer.ts`
- `src/helman-scheduling/model/schedule-hour-bucket-builder.ts`
- `src/helman-scheduling/model/schedule-table-builder.ts`
- `src/helman-scheduling/schedule-table-types.ts`
- `src/helman-scheduling/components/scheduling-slot-table.ts`
- `src/helman-scheduling/dialogs/scheduling-range-edit-dialog.ts`
- `src/localize/translations/cs.json`

Potentially also:

- a new appliance metadata helper / owner file inside `src/helman-scheduling/`
- a new EV-specific action presentation helper if keeping action-chip logic clean requires it

## 7. Architecture options

### Option A - minimal patch-on-top

Change the existing scheduler just enough to stop losing appliance data and bolt EV editing onto the current dialog.

Shape:

- keep most current models intact
- change `ScheduleSlot` to carry full `domains`
- keep rendering logic mostly inline in `scheduling-slot-table.ts`
- keep one dialog component and extend it with an EV section
- replace inverter-only write helpers with full-domain helpers

Pros:

- smallest code churn
- fastest path to working UI

Cons:

- keeps more appliance-specific logic inside large existing files
- higher risk of dialog and table logic getting crowded quickly
- weaker reuse if more appliance kinds arrive soon

### Option B - pragmatic balanced approach

Introduce a small composite scheduling model and one small appliance metadata layer, but keep the existing scheduler component structure.

Shape:

- extend FE schedule types from single `action` to composite `domains`
- introduce typed appliance metadata for the fields the scheduler needs
- add a small row-action helper/view-model that derives:
  - inverter action
  - shared appliance chip list
- keep `scheduling-slot-table.ts` as the renderer, but feed it richer row action content
- keep one dialog, but split its internal UI into:
  - mandatory inverter section
  - optional appliance sections
- keep EV authoring logic in dedicated helper types/functions rather than scattering it through render code

Pros:

- fixes the model and write-path seams properly
- keeps the current scheduler architecture recognizable
- avoids over-extracting new components before they are really needed
- leaves a clean path for more appliance kinds later

Cons:

- slightly more upfront type and helper work than the minimal option
- still leaves the main dialog and table as the key extension surfaces

### Option C - cleaner subsystem extraction

Build a small appliance-scheduling subsystem now.

Shape:

- add dedicated appliance action presentation helpers
- add dedicated appliance editor helpers/components
- possibly add a metadata owner parallel to the schedule owner
- make the scheduler table and dialog compose those smaller parts

Pros:

- cleanest long-term separation
- best if scheduler appliance work is going to expand quickly

Cons:

- highest cost for this first increment
- adds more files and indirection than the current scope really needs

## 8. Recommended approach

Recommended option: **Option B - pragmatic balanced approach**

Why this is the best fit:

1. the current FE must be made domain-aware anyway, because it currently drops appliance data on read and clears it on write
2. the UI change is broader than a tiny styling tweak, but still not broad enough to justify a full subsystem extraction yet
3. the existing scheduler already has reusable seams worth keeping:
   - owner/store/client layering
   - action chip presentation helpers
   - one main dialog surface
4. this option keeps the first increment small enough to ship while still setting up the right structure for later EV SoC or non-EV appliances

### Concrete architectural decisions inside the recommendation

- keep the existing `schedule-owner` focused on schedule lifecycle only
- load `helman/get_appliances` in `helman-scheduling-card` rather than expanding the owner snapshot
- normalize loose appliance metadata in one dedicated helper file before passing it to the table or dialog
- make the scheduler FE domain-aware end to end:
  - normalized slots keep `domains.inverter` and sparse `domains.appliances`
  - table rows derive one shared appliance chip area from those domains
  - dialog returns full authored `domains`
  - patch/write helpers compare and send full domains instead of inverter-only action patches

### Recommended new helper boundaries

The first increment likely benefits from two small new helpers:

1. `schedule-appliance-metadata.ts`
   - normalize `get_appliances` payload into strict scheduler-facing definitions
   - preserve metadata order
   - filter to scheduler-capable appliances
   - expose EV authoring options needed by the dialog

2. `schedule-appliance-action-presentation.ts`
   - parse raw appliance action payloads by appliance kind
   - produce compact table labels for appliance actions
   - keep EV-specific display logic out of the table renderer

This keeps the table and dialog from becoming the place where unknown metadata bags and raw EV payload parsing are handled directly.

## 9. Recommended implementation sequence

1. type appliance metadata and schedule domains in `helman-api.ts`
2. replace inverter-only write helpers with full-domain helpers
3. extend scheduling normalization to preserve appliance actions per slot
4. load `get_appliances` metadata for scheduler use
5. introduce fixed row action lanes based on inverter + metadata-ordered appliances
6. render appliance actions in slot rows and hour rows
7. extend the dialog to edit composite domains
8. wire dialog submit back into full-domain patches
9. add localization strings for appliance labels / empty states if needed

## 9. Important implementation rules

- keep slot-native schedule truth; intervals and hour rows stay presentation models
- do not invent runtime appliance UI in this increment
- do not use projection data yet
- preserve sparse appliance semantics on write
- preserve inverter action as mandatory in all edited slots
- let each appliance action be independently removable
- keep the UI generic enough that future appliance kinds can plug into the same lane structure, even if only EV authoring is implemented first

## 10. Open questions

Resolved for this increment:

1. use one shared appliance area in the action column
2. keep it visually blank when there is no appliance action
3. prefill mixed selections from the first selected slot
4. do not show vehicle name in the scheduler table

Still optional to revisit later:

- whether future follow-up docs should stay under `docs/features/scheduling-card/` or move under a dedicated `ev-charger/` folder in this repo

## 11. Source references

- `/home/ondra/dev/hass/hass-helman/docs/features/ev-charger/ev-charger-feature-request-refined.md`
- `/home/ondra/dev/hass/hass-helman/docs/features/ev-charger/ev-charger-implementation-shared.md`
- `/home/ondra/dev/hass/hass-helman/docs/features/ev-charger/ev-charger-architecture-summary.md`
- `/home/ondra/dev/hass/hass-helman/docs/features/ev-charger/stories/story-02-config-and-metadata.md`
- `/home/ondra/dev/hass/hass-helman/docs/features/ev-charger/stories/story-03-schedule-authoring.md`
- `src/helman-api.ts`
- `src/helman/models.ts`
- `src/helman/store.ts`
- `src/helman-scheduling/model/schedule-normalizer.ts`
- `src/helman-scheduling/components/scheduling-slot-table.ts`
- `src/helman-scheduling/dialogs/scheduling-range-edit-dialog.ts`
