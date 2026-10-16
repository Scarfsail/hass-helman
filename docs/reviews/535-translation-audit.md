# P3 translation audit (before migration)

Conservative source-string audit: full key, dynamic prefix, or quoted suffix counts as usage. Unused candidates require manual review before deletion.

## card

Missing in cs: 
Missing in en: bias_correction.inspector.contribution_status.interpolated, bias_correction.inspector.interpolated_anchor_zero, bias_correction.inspector.interpolated_explanation, bias_correction.inspector.interpolated_from, bias_correction.inspector.interpolated_label, bias_correction.inspector.interpolated_meta, bias_correction.inspector.legend.battery, bias_correction.inspector.legend.correction, bias_correction.inspector.legend.house, bias_correction.inspector.legend.solar, bias_correction.inspector.untrained_label, node_detail.close, scheduling.actions.collapse_appliance_actions, scheduling.actions.collapse_day, scheduling.actions.collapse_hour, scheduling.actions.edit_hour, scheduling.actions.edit_selected, scheduling.actions.expand_appliance_actions, scheduling.actions.expand_day, scheduling.actions.expand_hour, scheduling.actions.refresh, scheduling.actions.select_hour, scheduling.actions.select_interval, scheduling.actions.select_slot, scheduling.appliance.action.generic, scheduling.appliance.climate.mode.cool, scheduling.appliance.climate.mode.heat, scheduling.appliance.climate.mode.off, scheduling.appliance.climate.projected_energy, scheduling.appliance.ev.action.no_charge, scheduling.appliance.ev.expected_soc, scheduling.appliance.ev.mode.eco, scheduling.appliance.ev.mode.fast, scheduling.appliance.generic.action.off, scheduling.appliance.generic.action.on, scheduling.appliance.generic.projected_energy, scheduling.appliance.generic.projection_method.fixed, scheduling.appliance.generic.projection_method.fixed_fallback, scheduling.appliance.generic.projection_method.history_average, scheduling.authorship.automation, scheduling.authorship.mixed, scheduling.authorship.set_by_automation, scheduling.authorship.set_by_user, scheduling.authorship.user, scheduling.automation_coverage.active, scheduling.automation_coverage.disabled_only, scheduling.automation_coverage.none, scheduling.badge.now, scheduling.copy.selected_prefix, scheduling.copy.slot_few, scheduling.copy.slot_many, scheduling.copy.slot_one, scheduling.day.today, scheduling.day.tomorrow, scheduling.day.yesterday, scheduling.dialog.action, scheduling.dialog.affects_prefix, scheduling.dialog.appliance.charge, scheduling.dialog.appliance.eco_gear, scheduling.dialog.appliance.missing_metadata, scheduling.dialog.appliance.mode, scheduling.dialog.appliance.no_action, scheduling.dialog.appliance.no_charge, scheduling.dialog.appliance.turn_off, scheduling.dialog.appliance.turn_on, scheduling.dialog.appliance.unsupported_authoring, scheduling.dialog.appliance.vehicle, scheduling.dialog.appliance_kind.climate, scheduling.dialog.appliance_kind.ev_charger, scheduling.dialog.appliance_kind.generic, scheduling.dialog.appliances, scheduling.dialog.apply, scheduling.dialog.automation_owns_action, scheduling.dialog.cancel, scheduling.dialog.choose_action, scheduling.dialog.existing_actions, scheduling.dialog.interval, scheduling.dialog.inverter, scheduling.dialog.keep_existing, scheduling.dialog.mixed_authorship_summary, scheduling.dialog.multiple_actions_defined, scheduling.dialog.overwrite_existing_actions, scheduling.dialog.replace_with_manual_action, scheduling.dialog.selection, scheduling.dialog.tab.configured, scheduling.dialog.tab.not_configured, scheduling.dialog.tabs, scheduling.dialog.target_soc, scheduling.dialog.title.edit_selection, scheduling.empty, scheduling.entity_editor.add_block, scheduling.entity_editor.blocks, scheduling.entity_editor.edit_hint, scheduling.entity_editor.explain_hint, scheduling.entity_editor.from, scheduling.entity_editor.mode_edit, scheduling.entity_editor.mode_explain, scheduling.entity_editor.next_day, scheduling.entity_editor.no_blocks, scheduling.entity_editor.open, scheduling.entity_editor.previous_day, scheduling.entity_editor.remove_block, scheduling.entity_editor.save, scheduling.entity_editor.save_elapsed, scheduling.entity_editor.save_failed, scheduling.entity_editor.schedule_changed, scheduling.entity_editor.select_entity, scheduling.entity_editor.title, scheduling.entity_editor.to, scheduling.entity_editor.unsaved, scheduling.error.appliances_unavailable, scheduling.error.execution_unavailable, scheduling.error.invalid_action, scheduling.error.invalid_slots, scheduling.error.not_configured, scheduling.error.showing_last_good, scheduling.error.unknown, scheduling.execution.toggle, scheduling.explanation.action.appliance_runtime, scheduling.explanation.action.charge_from_grid, scheduling.explanation.action.charge_hold, scheduling.explanation.action.export_price, scheduling.explanation.condition.blocked_user_owned, scheduling.explanation.condition.charge_needed, scheduling.explanation.condition.cheap_window_capacity, scheduling.explanation.condition.cheapest_rank, scheduling.explanation.condition.consecutive_skip_override, scheduling.explanation.condition.daily_minimum_remaining, scheduling.explanation.condition.day_context, scheduling.explanation.condition.day_group_matched, scheduling.explanation.condition.ensure_self_sustainability, scheduling.explanation.condition.hold_room, scheduling.explanation.condition.hold_window, scheduling.explanation.condition.max_run_price, scheduling.explanation.condition.min_soc_pct, scheduling.explanation.condition.min_solar_coverage_pct, scheduling.explanation.condition.placement_capacity, scheduling.explanation.condition.requires_appliance, scheduling.explanation.condition.reserve_floor_soc, scheduling.explanation.condition.run_when, scheduling.explanation.condition.run_window, scheduling.explanation.condition.slot_available, scheduling.explanation.condition.stop_export_supported, scheduling.explanation.condition.when_price_below, scheduling.explanation.condition.window_soc_known, scheduling.explanation.condition_detail.blocked_user_owned, scheduling.explanation.condition_detail.cheapest_rank, scheduling.explanation.condition_detail.daily_minimum_remaining, scheduling.explanation.condition_detail.ensure_self_sustainability, scheduling.explanation.condition_detail.slot_available, scheduling.explanation.diagram.context, scheduling.explanation.diagram.edit.cancel, scheduling.explanation.diagram.edit.close, scheduling.explanation.diagram.edit.discard, scheduling.explanation.diagram.edit.load_failed, scheduling.explanation.diagram.edit.loading, scheduling.explanation.diagram.edit.not_found, scheduling.explanation.diagram.edit.title, scheduling.explanation.diagram.edit_automation, scheduling.explanation.diagram.empty, scheduling.explanation.diagram.legend_and, scheduling.explanation.diagram.legend_comparison, scheduling.explanation.diagram.legend_decisive, scheduling.explanation.diagram.legend_dimmed, scheduling.explanation.diagram.legend_no_custom, scheduling.explanation.diagram.legend_not_applicable, scheduling.explanation.diagram.legend_or, scheduling.explanation.diagram.legend_override, scheduling.explanation.diagram.legend_params, scheduling.explanation.diagram.legend_params_source, scheduling.explanation.diagram.legend_stages, scheduling.explanation.diagram.matched_group, scheduling.explanation.diagram.override, scheduling.explanation.diagram.override_detail, scheduling.explanation.diagram.override_hint, scheduling.explanation.diagram.plan_decided_when, scheduling.explanation.diagram.plan_when, scheduling.explanation.diagram.stage.any_group, scheduling.explanation.diagram.stage.any_group_or_forced, scheduling.explanation.diagram.stage.conditions, scheduling.explanation.diagram.stage.custom_none, scheduling.explanation.diagram.stage.custom_other_group, scheduling.explanation.diagram.stage.custom_when, scheduling.explanation.diagram.stage.gates, scheduling.explanation.diagram.stage.plan, scheduling.explanation.diagram.stage.recheck, scheduling.explanation.diagram.stage.result, scheduling.explanation.diagram.terminal.blocked, scheduling.explanation.diagram.terminal.candidate, scheduling.explanation.diagram.terminal.execute, scheduling.explanation.diagram.terminal.not_eligible, scheduling.explanation.diagram.title, scheduling.explanation.diagram.trace.close, scheduling.explanation.diagram.trace.empty, scheduling.explanation.diagram.trace.error, scheduling.explanation.diagram.trace.loading, scheduling.explanation.diagram.trace.open_hint, scheduling.explanation.diagram.trace.run_at, scheduling.explanation.diagram.trace.title, scheduling.explanation.diagram.trace.unrendered, scheduling.explanation.diagram.unexplained, scheduling.explanation.diagram.verdict.not_planned, scheduling.explanation.diagram.verdict.planned, scheduling.explanation.empty, scheduling.explanation.error, scheduling.explanation.loading, scheduling.explanation.matrix.actual, scheduling.explanation.matrix.collapse, scheduling.explanation.matrix.configured, scheduling.explanation.matrix.custom, scheduling.explanation.matrix.custom_entry, scheduling.explanation.matrix.empty, scheduling.explanation.matrix.expand, scheduling.explanation.matrix.gates, scheduling.explanation.matrix.group, scheduling.explanation.matrix.no_conditions, scheduling.explanation.matrix.no_params, scheduling.explanation.matrix.title, scheduling.explanation.no_slot, scheduling.explanation.optimizer.appliance_runtime, scheduling.explanation.optimizer.charge_from_grid, scheduling.explanation.optimizer.charge_hold, scheduling.explanation.optimizer.export_price, scheduling.explanation.outcome.absent, scheduling.explanation.outcome.blocked, scheduling.explanation.outcome.candidate, scheduling.explanation.outcome.not_eligible, scheduling.explanation.outcome.overwritten, scheduling.explanation.outcome.step_skipped, scheduling.explanation.outcome.wrote, scheduling.explanation.param.atSlot, scheduling.explanation.param.baselineMinSoc, scheduling.explanation.param.boundBy, scheduling.explanation.param.budgetKwh, scheduling.explanation.param.classification, scheduling.explanation.param.conditionValue, scheduling.explanation.param.consecutiveSkips, scheduling.explanation.param.cost, scheduling.explanation.param.daily_minimum_minutes, scheduling.explanation.param.deltaImportKwh, scheduling.explanation.param.deltaSocPct, scheduling.explanation.param.denominatorOptimizerId, scheduling.explanation.param.doneHours, scheduling.explanation.param.end, scheduling.explanation.param.failingCondition, scheduling.explanation.param.floor, scheduling.explanation.param.marginPct, scheduling.explanation.param.matchedGroup, scheduling.explanation.param.maxConsecutiveSkips, scheduling.explanation.param.max_price, scheduling.explanation.param.max_run_price, scheduling.explanation.param.max_slots, scheduling.explanation.param.minHours, scheduling.explanation.param.min_export_price, scheduling.explanation.param.min_runtime_minutes, scheduling.explanation.param.min_soc_pct, scheduling.explanation.param.neededKwh, scheduling.explanation.param.projectedMinSoc, scheduling.explanation.param.rank, scheduling.explanation.param.rankOf, scheduling.explanation.param.rank_of, scheduling.explanation.param.releaseSlot, scheduling.explanation.param.remainingHours, scheduling.explanation.param.reserve_floor_soc_pct, scheduling.explanation.param.slotsAvailable, scheduling.explanation.param.slotsNeeded, scheduling.explanation.param.slotsPlaceable, scheduling.explanation.param.solarToConsumptionRatio, scheduling.explanation.param.spentKwh, scheduling.explanation.param.start, scheduling.explanation.param.surplusAtWindowStart, scheduling.explanation.param.target_soc_pct, scheduling.explanation.param.tolerancePct, scheduling.explanation.param.windowSlots, scheduling.explanation.param.worstChosenCost, scheduling.explanation.params_source.day_resolved, scheduling.explanation.params_source.master_fallback, scheduling.explanation.params_source.slot_matched, scheduling.explanation.params_source_detail.day_resolved, scheduling.explanation.params_source_detail.master_fallback, scheduling.explanation.params_source_detail.slot_matched, scheduling.explanation.self_sustainability.over_battery_budget, scheduling.explanation.self_sustainability.soc_floor_already_breached, scheduling.explanation.self_sustainability.would_break_soc_floor, scheduling.explanation.state.false, scheduling.explanation.state.not_applicable, scheduling.explanation.state.not_evaluated, scheduling.explanation.state.true, scheduling.explanation.status.failed, scheduling.explanation.status.skipped, scheduling.explanation.status_reason.battery_params_missing, scheduling.explanation.status_reason.condition_rails_unavailable, scheduling.explanation.status_reason.soc_forecast_unavailable, scheduling.explanation.status_reason.stop_export_unsupported, scheduling.forecast.battery_label, scheduling.forecast.export, scheduling.forecast.grid_label, scheduling.forecast.import, scheduling.forecast.net, scheduling.forecast.price_label, scheduling.forecast.surplus, scheduling.metric.export, scheduling.metric.import, scheduling.metric.soc, scheduling.metric.surplus, scheduling.now.actor.inverter, scheduling.now.actual.applied, scheduling.now.actual.failed, scheduling.now.actual.no_change, scheduling.now.actual.status_unavailable, scheduling.now.actual.stopped, scheduling.now.compliance_off, scheduling.now.compliance_ok, scheduling.now.detail.expected, scheduling.now.detail.no_scheduled_action, scheduling.now.execution_disabled, scheduling.now.reason, scheduling.now.running, scheduling.now.runtime_unavailable, scheduling.now.scheduled, scheduling.now.title, scheduling.now.unavailable, scheduling.running.label, scheduling.running.restore_all, scheduling.running.restoring, scheduling.running.unavailable, scheduling.runtime.applied, scheduling.runtime.error, scheduling.why.automation_generic, scheduling.why.manual_note, scheduling.why.no_change, scheduling.why.title

Unused candidates (94):
- `scheduling.actions.collapse_appliance_actions`
- `scheduling.actions.collapse_day`
- `scheduling.actions.collapse_hour`
- `scheduling.actions.edit_hour`
- `scheduling.actions.edit_selected`
- `scheduling.actions.expand_appliance_actions`
- `scheduling.actions.expand_day`
- `scheduling.actions.expand_hour`
- `scheduling.actions.refresh`
- `scheduling.actions.select_hour`
- `scheduling.actions.select_interval`
- `scheduling.actions.select_slot`
- `scheduling.copy.selected_prefix`
- `scheduling.copy.slot_few`
- `scheduling.copy.slot_many`
- `scheduling.copy.slot_one`
- `scheduling.dialog.affects_prefix`
- `scheduling.dialog.appliance.missing_metadata`
- `scheduling.dialog.automation_owns_action`
- `scheduling.dialog.choose_action`
- `scheduling.dialog.existing_actions`
- `scheduling.dialog.interval`
- `scheduling.dialog.keep_existing`
- `scheduling.dialog.mixed_authorship_summary`
- `scheduling.dialog.multiple_actions_defined`
- `scheduling.dialog.overwrite_existing_actions`
- `scheduling.dialog.replace_with_manual_action`
- `scheduling.dialog.selection`
- `scheduling.dialog.title.edit_selection`
- `scheduling.entity_editor.mode_edit`
- `scheduling.entity_editor.mode_explain`
- `scheduling.error.appliances_unavailable`
- `scheduling.error.execution_unavailable`
- `scheduling.error.invalid_action`
- `scheduling.error.invalid_slots`
- `scheduling.error.showing_last_good`
- `scheduling.explanation.condition.charge_needed`
- `scheduling.explanation.condition.day_group_matched`
- `scheduling.explanation.condition.slot_available`
- `scheduling.explanation.condition.stop_export_supported`
- `scheduling.explanation.condition.window_soc_known`
- `scheduling.explanation.condition_detail.slot_available`
- `scheduling.explanation.matrix.collapse`
- `scheduling.explanation.matrix.custom_entry`
- `scheduling.explanation.matrix.expand`
- `scheduling.explanation.matrix.no_params`
- `scheduling.explanation.param.boundBy`
- `scheduling.explanation.param.classification`
- `scheduling.explanation.param.conditionValue`
- `scheduling.explanation.param.consecutiveSkips`
- `scheduling.explanation.param.daily_minimum_minutes`
- `scheduling.explanation.param.deltaImportKwh`
- `scheduling.explanation.param.denominatorOptimizerId`
- `scheduling.explanation.param.failingCondition`
- `scheduling.explanation.param.marginPct`
- `scheduling.explanation.param.matchedGroup`
- `scheduling.explanation.param.maxConsecutiveSkips`
- `scheduling.explanation.param.max_price`
- `scheduling.explanation.param.max_slots`
- `scheduling.explanation.param.minHours`
- `scheduling.explanation.param.min_export_price`
- `scheduling.explanation.param.min_runtime_minutes`
- `scheduling.explanation.param.neededKwh`
- `scheduling.explanation.param.rankOf`
- `scheduling.explanation.param.rank_of`
- `scheduling.explanation.param.releaseSlot`
- `scheduling.explanation.param.remainingHours`
- `scheduling.explanation.param.reserve_floor_soc_pct`
- `scheduling.explanation.param.slotsAvailable`
- `scheduling.explanation.param.slotsNeeded`
- `scheduling.explanation.param.slotsPlaceable`
- `scheduling.explanation.param.solarToConsumptionRatio`
- `scheduling.explanation.param.surplusAtWindowStart`
- `scheduling.explanation.param.target_soc_pct`
- `scheduling.explanation.param.tolerancePct`
- `scheduling.explanation.param.windowSlots`
- `scheduling.explanation.param.worstChosenCost`
- `scheduling.explanation.pipeline.phase_1`
- `scheduling.explanation.pipeline.phase_2`
- `scheduling.explanation.pipeline.phase_3`
- `scheduling.explanation.status_reason.battery_params_missing`
- `scheduling.explanation.status_reason.condition_rails_unavailable`
- `scheduling.explanation.status_reason.soc_forecast_unavailable`
- `scheduling.explanation.status_reason.stop_export_unsupported`
- `scheduling.now.actual.status_unavailable`
- `scheduling.now.compliance_off`
- `scheduling.now.compliance_ok`
- `scheduling.now.detail.no_scheduled_action`
- `scheduling.now.execution_disabled`
- `scheduling.now.runtime_unavailable`
- `scheduling.running.restore_all`
- `scheduling.running.restoring`
- `scheduling.why.automation_generic`
- `scheduling.why.manual_note`

## editor

Missing in cs: 
Missing in en: editor.tabs.general

Unused candidates (16):
- `common.yes`
- `editor.actions.add_appliance_runtime_optimizer`
- `editor.actions.add_charge_from_grid_optimizer`
- `editor.actions.add_charge_hold_optimizer`
- `editor.actions.add_export_price_optimizer`
- `editor.card.daily_energy_entity`
- `editor.card.import_window`
- `editor.helpers.appliance_runtime_max_consecutive_skips`
- `editor.messages.enter_yaml_failed`
- `editor.tabs.general`
- `editor.training_depth.appliance_entity_charge`
- `editor.training_depth.appliance_entity_climate`
- `editor.training_depth.appliance_entity_meter`
- `editor.training_depth.appliance_entity_power`
- `editor.training_depth.appliance_entity_submeter`
- `editor.training_depth.appliance_entity_switch`

## Resolution

No statically used full translation key is missing from both supported languages. English-only gaps listed above already resolve through Czech fallback and remain unchanged; no redundant Czech copies were added to English. Dynamic families were checked in scheduling explanation `_labelled`/`_conditionDetail`/pipeline templates, entity-editor mode templates, optimizer add-action templates, and training-depth templates.

Confirmed unused leaves deleted from both language tables where present (54):
- `scheduling.actions.collapse_appliance_actions`
- `scheduling.actions.collapse_day`
- `scheduling.actions.collapse_hour`
- `scheduling.actions.edit_hour`
- `scheduling.actions.edit_selected`
- `scheduling.actions.expand_appliance_actions`
- `scheduling.actions.expand_day`
- `scheduling.actions.expand_hour`
- `scheduling.actions.refresh`
- `scheduling.actions.select_hour`
- `scheduling.actions.select_interval`
- `scheduling.actions.select_slot`
- `scheduling.copy.selected_prefix`
- `scheduling.copy.slot_few`
- `scheduling.copy.slot_many`
- `scheduling.copy.slot_one`
- `scheduling.dialog.affects_prefix`
- `scheduling.dialog.appliance.missing_metadata`
- `scheduling.dialog.automation_owns_action`
- `scheduling.dialog.choose_action`
- `scheduling.dialog.existing_actions`
- `scheduling.dialog.interval`
- `scheduling.dialog.keep_existing`
- `scheduling.dialog.mixed_authorship_summary`
- `scheduling.dialog.multiple_actions_defined`
- `scheduling.dialog.overwrite_existing_actions`
- `scheduling.dialog.replace_with_manual_action`
- `scheduling.dialog.selection`
- `scheduling.dialog.title.edit_selection`
- `scheduling.error.appliances_unavailable`
- `scheduling.error.execution_unavailable`
- `scheduling.error.invalid_action`
- `scheduling.error.invalid_slots`
- `scheduling.error.showing_last_good`
- `scheduling.explanation.matrix.collapse`
- `scheduling.explanation.matrix.custom_entry`
- `scheduling.explanation.matrix.expand`
- `scheduling.explanation.matrix.no_params`
- `scheduling.now.actual.status_unavailable`
- `scheduling.now.compliance_off`
- `scheduling.now.compliance_ok`
- `scheduling.now.detail.no_scheduled_action`
- `scheduling.now.execution_disabled`
- `scheduling.now.runtime_unavailable`
- `scheduling.running.restore_all`
- `scheduling.running.restoring`
- `scheduling.why.automation_generic`
- `scheduling.why.manual_note`
- `common.yes`
- `editor.card.daily_energy_entity`
- `editor.card.import_window`
- `editor.helpers.appliance_runtime_max_consecutive_skips`
- `editor.messages.enter_yaml_failed`
- `editor.tabs.general`

Dynamic candidates retained (56):
- `scheduling.entity_editor.mode_edit`
- `scheduling.entity_editor.mode_explain`
- `scheduling.explanation.condition.charge_needed`
- `scheduling.explanation.condition.day_group_matched`
- `scheduling.explanation.condition.slot_available`
- `scheduling.explanation.condition.stop_export_supported`
- `scheduling.explanation.condition.window_soc_known`
- `scheduling.explanation.condition_detail.slot_available`
- `scheduling.explanation.param.boundBy`
- `scheduling.explanation.param.classification`
- `scheduling.explanation.param.conditionValue`
- `scheduling.explanation.param.consecutiveSkips`
- `scheduling.explanation.param.daily_minimum_minutes`
- `scheduling.explanation.param.deltaImportKwh`
- `scheduling.explanation.param.denominatorOptimizerId`
- `scheduling.explanation.param.failingCondition`
- `scheduling.explanation.param.marginPct`
- `scheduling.explanation.param.matchedGroup`
- `scheduling.explanation.param.maxConsecutiveSkips`
- `scheduling.explanation.param.max_price`
- `scheduling.explanation.param.max_slots`
- `scheduling.explanation.param.minHours`
- `scheduling.explanation.param.min_export_price`
- `scheduling.explanation.param.min_runtime_minutes`
- `scheduling.explanation.param.neededKwh`
- `scheduling.explanation.param.rankOf`
- `scheduling.explanation.param.rank_of`
- `scheduling.explanation.param.releaseSlot`
- `scheduling.explanation.param.remainingHours`
- `scheduling.explanation.param.reserve_floor_soc_pct`
- `scheduling.explanation.param.slotsAvailable`
- `scheduling.explanation.param.slotsNeeded`
- `scheduling.explanation.param.slotsPlaceable`
- `scheduling.explanation.param.solarToConsumptionRatio`
- `scheduling.explanation.param.surplusAtWindowStart`
- `scheduling.explanation.param.target_soc_pct`
- `scheduling.explanation.param.tolerancePct`
- `scheduling.explanation.param.windowSlots`
- `scheduling.explanation.param.worstChosenCost`
- `scheduling.explanation.pipeline.phase_1`
- `scheduling.explanation.pipeline.phase_2`
- `scheduling.explanation.pipeline.phase_3`
- `scheduling.explanation.status_reason.battery_params_missing`
- `scheduling.explanation.status_reason.condition_rails_unavailable`
- `scheduling.explanation.status_reason.soc_forecast_unavailable`
- `scheduling.explanation.status_reason.stop_export_unsupported`
- `editor.actions.add_appliance_runtime_optimizer`
- `editor.actions.add_charge_from_grid_optimizer`
- `editor.actions.add_charge_hold_optimizer`
- `editor.actions.add_export_price_optimizer`
- `editor.training_depth.appliance_entity_charge`
- `editor.training_depth.appliance_entity_climate`
- `editor.training_depth.appliance_entity_meter`
- `editor.training_depth.appliance_entity_power`
- `editor.training_depth.appliance_entity_submeter`
- `editor.training_depth.appliance_entity_switch`

The follow-up suffix audit expanded literal `_text` calls using each component's `KEY_PREFIX`, plus node-detail `_t` calls using their node prefix; it also found no missing key in both languages.


## Verification follow-up

The 54 removed leaves were rechecked against full keys, quoted suffixes, and dynamic translation call sites. None needs restoration. The removed scheduling actions/copy/dialog selection/error leaves belong to the retired selection UI; current entity-day editing uses `scheduling.entity_editor.*`, keeping only its live appliance editor labels under `scheduling.dialog.*`. The removed matrix expand/collapse/custom-entry/no-params labels are absent from the current explanation panel and logic diagram; their live `_text` suffixes use the retained matrix labels. The removed now compliance/runtime labels, restore-all labels, and generic/manual why labels have no live full-key or suffix caller. Editor daily entity and import-window rows use `editor.dynamic.*`; the old `editor.card.*` leaves have no caller. The editor uses specific tabs and error paths rather than `editor.tabs.general` or `editor.messages.enter_yaml_failed`; the old common yes and appliance skip helper labels have no caller. Dynamic condition/parameter/status-reason, optimizer add-action, entity-editor mode, and training-depth families remain retained (56).

The failing root-title and training tests exposed bundle lookup regressions, not deleted keys: `card.*` is an existing JSON root, and `training.*` plus `bias_correction.status_panel.*` live in the editor bundle. Lookup now preserves full keys and resolves both bundles before Czech fallback. A regression spec covers those paths and preserves full keys passed to card overrides. Removal counts and lists above remain 54 deleted / 56 retained.
