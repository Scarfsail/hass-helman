# Upstream Solar Forecast Provider Design

## Goal

Replace Helman's current day-by-day solar forecast entity configuration with a single upstream solar forecast provider selection based on a Home Assistant config entry. Helman will consume one external provider, correct that provider's forecast using its trained bias model, and expose the corrected result as its own Energy-platform solar forecast.

This design keeps Helman independent from Home Assistant Energy preferences to avoid circular configuration once Helman itself is selected as an Energy solar forecast provider.

## Current State

Today Helman stores the upstream solar forecast under:

- `power_devices.solar.forecast.daily_energy_entity_ids`

The runtime interprets this list positionally:

- index `0` = today
- index `1` = tomorrow
- and so on

`HelmanForecastBuilder._build_solar_forecast(...)` reads each entity, extracts its `wh_period` attribute, and maps the daily entity list into Helman's internal `points` payload.

This has several problems:

- configuration is tied to entity layout rather than the forecast provider abstraction
- setup is brittle because users must manually provide one entity per day
- the model does not match Home Assistant's own Energy-platform solar forecast contract
- migration to a different provider is harder than necessary

## Target Outcome

Helman stores one upstream solar forecast provider config entry in its own config and uses that provider's Energy-platform `async_get_solar_forecast(hass, config_entry_id)` contract as the raw forecast input.

The corrected Helman forecast remains the only downstream forecast exposed by Helman itself. From Helman's point of view, this is still one logical upstream source feeding one corrected internal solar forecast.

## Non-Goals

- supporting multiple upstream providers
- reading the upstream provider from Home Assistant Energy preferences
- keeping `daily_energy_entity_ids` as an active runtime fallback after migration
- changing the solar bias correction model or downstream forecast consumers
- changing the role of `power_devices.solar.forecast.total_energy_entity_id`

## Configuration Model

### New field

Add a single upstream provider reference under the solar forecast config:

- `power_devices.solar.forecast.source_config_entry_id`

This field stores the config entry ID of one external integration that implements the Energy solar forecast contract.

### Retained fields

Keep:

- `power_devices.solar.forecast.total_energy_entity_id`

This field continues to represent the cumulative actual solar production entity used for actual-history overlay and training-related actuals. It is not the upstream forecast source.

### Removed field

Remove:

- `power_devices.solar.forecast.daily_energy_entity_ids`

This field is migrated away and must no longer drive runtime forecast construction.

## Runtime Architecture

### Boundary choice

The upstream-provider adaptation belongs at the raw solar forecast builder boundary, replacing the current entity-list reader inside `HelmanForecastBuilder._build_solar_forecast(...)`.

This keeps the rest of the system stable:

- solar bias correction still receives Helman's standard solar payload
- coordinator and downstream forecast consumers still read `solar_forecast["points"]`
- Energy-platform exposure of Helman's corrected forecast remains unchanged

### Runtime flow

1. Read `power_devices.solar.forecast.source_config_entry_id`.
2. Resolve the config entry from Home Assistant.
3. Validate that the config entry exists, is not Helman itself, and its domain exposes the Energy-platform solar forecast contract.
4. Call the upstream integration's `async_get_solar_forecast(hass, config_entry_id)`.
5. Read the returned hourly `wh_hours` mapping.
6. Convert that mapping into Helman's internal solar forecast `points` shape.
7. Continue through the existing correction and downstream forecast pipeline unchanged.

### Adapter contract

The upstream Energy provider returns:

```python
{"wh_hours": {"<iso-timestamp>": <wh-value>, ...}}
```

Helman adapts that into its internal point shape:

```python
{
  "status": "...",
  "unit": "...",
  "remainingTodayEnergyEntityId": "...",
  "actualHistory": [...],
  "points": [
    {"timestamp": "<iso-timestamp>", "value": <wh-value>},
    ...
  ],
}
```

The adapter is responsible for:

- sorting timestamps chronologically
- filtering invalid timestamps or non-numeric values
- keeping values in Wh to match Helman's existing solar `points` convention
- deriving `status` from provider availability and parsed-point success

### Status semantics

If no upstream provider is configured:

- return `status: "not_configured"`

If a provider is configured but cannot be resolved or does not expose the Energy forecast contract:

- return `status: "unavailable"`

If a provider returns a forecast with at least some valid hourly points:

- return `status: "available"`

If a provider call succeeds but yields no usable points:

- return `status: "unavailable"`

This keeps the status model simple and avoids a second compatibility path after migration.

## Provider Discovery

### Validation rule

A selectable upstream source must satisfy all of the following:

- it is a Home Assistant config entry
- its domain exposes an Energy platform with `async_get_solar_forecast`
- it is not Helman's own config entry

### Frontend source list

Helman needs a custom source list for the config editor. A generic `config_entry` selector is not sufficient because the valid choices are not one integration domain; they are all config entries whose domains implement the Energy solar forecast contract.

The config editor should therefore request a backend-provided list of eligible forecast-provider config entries and render a single-picker control from that list.

Each option should include:

- config entry ID
- display title
- domain

### Self-selection prevention

Helman must never allow selecting its own config entry as the upstream source. That would create a direct circular dependency where Helman consumes its own corrected forecast as raw input.

This must be enforced both:

- in the frontend option list
- in backend validation/runtime checks

## Migration

### Desired behavior

Migration should be automatic and destructive with respect to the legacy field:

- try to infer the correct upstream provider from existing `daily_energy_entity_ids`
- persist the inferred provider when exactly one valid match is found
- always remove `daily_energy_entity_ids` from stored config

If inference fails, Helman does not preserve the old entity list. The user must explicitly choose a provider afterward.

### Inference algorithm

When legacy `daily_energy_entity_ids` exist:

1. Read all listed entity IDs.
2. Resolve each entity in the entity registry.
3. Collect owning config entry IDs from those entities.
4. Reduce the candidates to unique config entry IDs.
5. Check whether exactly one candidate remains.
6. Check whether that candidate is a valid Energy solar forecast provider and is not Helman.
7. If valid, store it into `source_config_entry_id`.
8. Remove `daily_energy_entity_ids` from config in all cases.

### Migration outcomes

If exactly one valid provider is inferred:

- save `source_config_entry_id`
- delete `daily_energy_entity_ids`

If no provider or multiple providers are inferred:

- leave `source_config_entry_id` empty
- delete `daily_energy_entity_ids`

### Migration timing

Migration should happen before the config is treated as the canonical active document. The practical implementation can occur during storage load, config save normalization, or both, but the persisted stored config should converge to the new shape quickly and not keep legacy forecast-source entities around.

## Validation

### Config validation rules

The new `source_config_entry_id` is optional, but if present it must satisfy:

- string type
- non-empty after trimming
- resolves to an existing config entry
- config entry is not Helman's own entry
- config entry domain supports Energy solar forecast

The absence of `source_config_entry_id` is not a config-format error. It means solar forecast is not configured.

### Legacy cleanup

Validation should no longer accept `daily_energy_entity_ids` as an active forecast input. After migration, the field should be ignored or stripped rather than preserved as a supported alternative path.

## Frontend Behavior

### Editor changes

Replace the current daily-entity list UI with one upstream provider picker.

The field should communicate that the selected provider is:

- the raw external solar forecast Helman consumes
- not Helman's own corrected forecast

The existing total-energy entity field remains in place as the actual-production history source.

### Empty state

If no eligible providers exist, the editor should show an empty state rather than a broken selector. The message should explain that Helman can only consume integrations that expose a Home Assistant Energy solar forecast provider contract.

### Migration feedback

If legacy entities were removed but no provider could be inferred, the UI should surface a clear notice after reload that the solar forecast source now needs to be selected manually.

## Error Handling

Helman should tolerate the following without crashing or silently reintroducing legacy behavior:

- selected config entry deleted
- selected config entry from unsupported domain
- selected config entry is Helman
- upstream provider returns `None`
- upstream provider returns malformed `wh_hours`

In these cases Helman should produce an unavailable or not-configured solar forecast snapshot and continue serving the rest of the system normally.

## Testing Strategy

### Backend tests

Add or update tests for:

- config validation of `source_config_entry_id`
- rejection of Helman self-selection
- rejection of unsupported config entry domains
- raw solar forecast construction from provider `wh_hours`
- malformed provider payload handling
- migration from legacy `daily_energy_entity_ids`
- migration success for one inferred provider
- migration failure with no inferred provider
- migration failure with multiple inferred providers
- confirmation that legacy entities are removed from persisted config

### Frontend tests

Add or update tests for:

- provider picker rendering
- empty-state rendering when no providers are available
- removal of daily-entity list UI
- serialization of selected provider config entry ID into the config document

## Implementation Notes

### Keep downstream contracts stable

The design deliberately limits change to the upstream acquisition seam. Internally, Helman should keep producing the same solar snapshot structure so that solar bias correction, battery forecast, appliance projection, automation, and Energy-platform exposure do not need a parallel refactor.

### Do not couple to Energy preferences

Helman must not read Home Assistant Energy preferences to discover the upstream provider. The upstream provider is Helman's own config because Energy may legitimately point back to Helman as the corrected provider.

## Open Decisions Resolved

- Upstream source ownership: Helman-owned config
- Number of upstream providers: exactly one
- Circular-reference handling: exclude Helman from valid upstream choices
- Migration policy: infer one provider when possible, always remove legacy daily entity list

## Summary

Helman should move from a positional daily-entity solar forecast config to a single upstream forecast-provider config entry. The adaptation belongs in the raw forecast builder, where the upstream Energy `wh_hours` payload is translated into Helman's existing internal `points` model. Migration should aggressively remove the old entity list, preserving only an inferred provider when one unambiguous valid source can be identified.
