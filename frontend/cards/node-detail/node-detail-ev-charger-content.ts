import { formatKwh, formatPower } from "../shared/format";
import { SLOT_MS } from "../shared/time/slot-time";
import { css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { fillTemplate } from "../localize/localize";
import type {
    ApplianceProjectionsPayload,
    ApplianceRuntimeDTO,
    ApplianceVehicleDTO,
    EvChargerApplianceMetadataDTO,
    EvChargerDetailPayload,
    EvChargerSegmentSectionPayload,
    EvChargerTodaySectionPayload,
    GetNodeDetailRequest,
    ScheduleEvChargerActionDTO,
} from "../helman-api";
import { helmanColorVars } from "../color-vars";
import { currencyFromPriceUnit } from "../helman-solar-inspector/money-model";
import { getSharedHelmanStore } from "../shared/data/store";

import { modeStripWindow, type ModeSegment } from "../shared/mode-strip";
import { getScheduleApplianceActionPresentation } from "../shared/schedule/model/schedule-appliance-action-presentation";
import { resolveScheduleSlotBoundaries, type ScheduleSlotBoundary } from "../shared/schedule/model/schedule-time";
import { IDLE_W, NodeDetailContentBase } from "./node-detail-base";
import { staleToday } from "./section-resource";
import { readEnergyKWh, readingNumber } from "./node-detail-readings";
import { dispatchWatchedEntities } from "../shared/hass-change";
import { powerUnitFactor } from "../shared/power-reading";
import { runtimeText, laneActionLabel, mergeRuns, runtimeFor, withinTodayTomorrow } from "./node-detail-schedule";
import { nodeDetailPictureStyles, nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import type { DeviceDetailParams } from "./node-detail-types";
import { deviceDirectControls } from "./node-detail-utils";
import { estimatedConsumerMix } from "./live-flows";
import "./detail-headline";
import "./flow-gauge";
import "./switch-tile";
import "./who-decides";
import { boldTemplate } from "./detail-section";
import { forecastWhen, holdAtSlots, renderForecastChart, stillAhead } from "./node-detail-forecast";
import {
    HistoryGraphResource, historyRow, historySummary, kwhText, renderShareBar, sectionNotReady, subTitle,
} from "./node-detail-history";
import type { DayLinePoint } from "../shared/day-line-chart";

/** Two readings further apart than this were not taken together. */
const COMPARABLE_MS = 30_000;

/** A charge window: consecutive slots with the same charging action. */
interface ChargeWindow {
    startMs: number;
    endMs: number | null;
    /** Placed by an optimizer whose condition is not met: not executed. */
    candidate: boolean;
    useMode: string | null;
    ecoGear: string | null;
    vehicleId: string | null;
}

/** Whether two charging actions are one window: the same car, mode, gear and condition. */
function sameWindow(left: ScheduleEvChargerActionDTO, right: ScheduleEvChargerActionDTO): boolean {
    return (left.conditionMet === false) === (right.conditionMet === false)
        && left.useMode === right.useMode && left.ecoGear === right.ecoGear && left.vehicleId === right.vehicleId;
}

/** The car the answers are about, and what its readings say. */
interface Vehicle {
    vehicle: ApplianceVehicleDTO;
    /** The only configured car, or the one the slot in progress names. */
    selectedBy: "only" | "plan";
    soc: number | null;
    limit: number | null;
    capacityKwh: number | null;
    /** `max(0, limit − SoC) / 100 × capacity`; `null` without all three. */
    neededKwh: number | null;
}

type VehicleSelection =
    | { kind: "selected"; car: Vehicle }
    /** Several cars and nothing names one: no car's figures are shown. */
    | { kind: "ambiguous"; count: number }
    | { kind: "none" };

/** What the plan's projection says for the selected car, or why it says nothing. */
type Completion =
    | {
        kind: "estimate"; endSoc: number; endMs: number | null; reachMs: number | null; suppliedKwh: number; shortfallKwh: number;
        /** The projected SoC at the end of each counted slot. */
        path: DayLinePoint[];
    }
    | { kind: "unsupported"; reason: string };

/**
 * The EV charger detail.
 *
 * The Overview opens on the power headline (the charger's switch as its icon,
 * the charging state and the session's energy as caption), then the estimated
 * source mix, who decides the charger now, and the selected car's tile: its
 * SoC against the limit, the energy still needed and the time at this power.
 *
 * Live readings come from `hass` and the house's live split from the card;
 * the backend overview supplies the entity ids and the charger's reported
 * status, its `segment` section today's recorded charging, read on opening
 * for the Schedule section's strip, and its `today` section what charged it
 * today, read on opening for the History header. The cars come from the
 * appliance roster (the charger's own appliance metadata), the plan from the
 * shared schedule owner and the plan's projected energy from
 * `helman/get_appliance_projections` on opening, for the Forecast header.
 *
 * Today's attribution is a whole-day figure, not the session. With several
 * cars and none named by the plan, no car's charge is shown. A projected
 * completion is an estimate under the current plan, never a guarantee.
 */
@customElement("node-detail-ev-charger-content")
export class NodeDetailEvChargerContent extends NodeDetailContentBase<EvChargerDetailPayload> {
    static styles = [helmanColorVars, nodeDetailSharedStyles, nodeDetailQuestionStyles, nodeDetailPictureStyles, css`
        .ok { color: var(--success-color, #43a047); }
        [data-car] .meter { position: relative; height: 10px; margin: 4px 0; border-radius: 5px; overflow: visible; }
        [data-car] .meter-fill { border-radius: 5px; background: var(--success-color, #43a047); }
        [data-limit-marker] { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: var(--primary-text-color); }
    `];

    protected readonly _node = "ev_charger" as const;

    /** The charger's consumer id: its appliance id and its `device_id` here. */
    @property({ attribute: false }) public deviceId!: string;
    /** The device as opened: the card's live split and the flow's scale. */
    @property({ attribute: false }) public params!: DeviceDetailParams;

    /** This charger's charging windows in progress, today and tomorrow. */
    private readonly _plan = this._useSchedule((schedule, now): ChargeWindow[] => {
        const slotsById = new Map(schedule.slots.map((slot) => [slot.id, slot]));
        const runs = mergeRuns<ScheduleEvChargerActionDTO>(this._boundaries(), slotsById, this.deviceId, (action) => action.charge, sameWindow)
            .map(({ startMs, endMs, action }) => ({
                startMs,
                endMs,
                candidate: action.conditionMet === false,
                useMode: action.useMode ?? null,
                ecoGear: action.ecoGear ?? null,
                vehicleId: action.vehicleId ?? null,
            }));
        return withinTodayTomorrow(runs, now, this._timeZone);
    });
    /** This charger's appliance metadata; `null` in the payload when the roster has no such charger. */
    private readonly _appliance = this._section<EvChargerApplianceMetadataDTO | null>("appliance", {
        fetch: async () => {
            const roster = await getSharedHelmanStore(this.hass).getControllableRoster();
            const appliance = roster.find((item) => item.id === this.deviceId && item.kind === "ev_charger");
            return (appliance as EvChargerApplianceMetadataDTO | undefined) ?? null;
        },
        shown: () => true,
        staleness: () => false,
    });
    /**
     * The plan's projection, for the completion line. A projection from an
     * earlier slot counts energy already delivered: re-read once per slot. A
     * refresh follows a plan change or a new slot: what was shown may be the
     * old plan's, so a failure replaces it.
     */
    private readonly _projection = this._section<ApplianceProjectionsPayload>("projection", {
        // Never shared: a projection is a function of the schedule, re-read because it changed.
        fetch: () => getSharedHelmanStore(this.hass).getApplianceProjections(),
        shown: () => true,
        staleness: (_payload, requestedAt) => requestedAt < Math.floor(Date.now() / SLOT_MS) * SLOT_MS,
        keepOnError: false,
    });
    /**
     * The selected car's recorded SoC since midnight, for the Forecast chart,
     * while the section is open: HA's own history of the car's SoC entity,
     * held at each slot boundary. A failed read draws no actual line.
     */
    private readonly _socHistory = this._section<DayLinePoint[]>("soc-history", {
        fetch: () => this._readSocHistory(),
        shown: () => this._forecastOpen && this._selection().kind === "selected",
        staleness: (_payload, requestedAt) => requestedAt < Math.floor(Date.now() / SLOT_MS) * SLOT_MS,
    });
    /** What charged it today, for the History header: read on opening. */
    private readonly _today = this._section<EvChargerTodaySectionPayload>("today", {
        fetch: () => this._readSection("today"),
        shown: () => this._overview.status === "ready",
    });
    /** HA's history graph of the charger's power over the last 24 hours, once History & statistics is open. */
    private readonly _chart = new HistoryGraphResource(this, () => [this._powerEntity()].filter((id): id is string => id !== null), () => this._historyOpen);
    /** The appliance answer the cars' entities were last announced for. */
    private _announcedAppliance: unknown = null;
    /** The run mode today's charging was read under; a new one re-reads it. */
    private _segmentRunMode = "";
    /** Today's recorded charging and the segment's start, for the strip, once the overview landed. */
    private readonly _segment = this._section<EvChargerSegmentSectionPayload>("segment", {
        fetch: () => this._readSection("segment"),
        shown: () => this._overview.status === "ready",
        staleness: (payload, requestedAt) => staleToday(payload, requestedAt, this.hass)
            || (this._overview.status === "ready" && this._runModeState(this._overview.payload) !== this._segmentRunMode),
        onRequest: () => {
            this._segmentRunMode = this._overview.status === "ready" ? this._runModeState(this._overview.payload) : "";
        },
    });

    /** The slot boundaries, read several times a render; cleared before each update. */
    private _boundariesCache?: ScheduleSlotBoundary[];

    willUpdate(changed: Map<string, unknown>): void {
        this._boundariesCache = undefined;
        // Another charger in the same element: nothing shown is its.
        if (changed.has("deviceId") && changed.get("deviceId") !== undefined && this._started) {
            this._overview = { status: "loading" };
            this._forecastOpen = this._historyOpen = this._technicalOpen = false;
            // The sections shown are read again in the update.
            for (const section of [...this._sections, this._chart]) section.drop();
            void this._loadOverview(true);
        }
        super.willUpdate(changed);
        if (this._started) this._chart.follow(this.hass);
    }

    protected _stop(): void {
        this._chart.cancel();
    }

    protected updated(changed: Map<string, unknown>): void {
        super.updated(changed);
        if (this._overview.status === "ready") {
            const failed = this._segment.state?.status === "error";
            this._reportLaneHistory({
                segments: this._historySegments(this._overview.payload),
                note: failed ? this._t("strip.history_failed") : null,
                retry: failed ? { label: this._t("retry"), load: () => this._segment.load() } : null,
            });
        }
        // The cars' entities are watched from the read that resolved them, once it answered.
        const appliance = this._appliance.state;
        if (appliance?.status === "ready" && appliance !== this._announcedAppliance) {
            this._announcedAppliance = appliance;
            if (this._overview.status === "ready") dispatchWatchedEntities(this, "node-detail", this._watchedEntities(this._overview.payload));
        }
    }

    /** The run mode's state now, `""` without one. */
    private _runModeState(payload: EvChargerDetailPayload): string {
        const entityId = payload.entities.run_mode;
        return entityId ? this.hass.states[entityId]?.state ?? "" : "";
    }

    protected _detailRequest(section?: string): GetNodeDetailRequest {
        return { ...super._detailRequest(section), device_id: this.deviceId };
    }

    /** The overview's entities, and every car's SoC and charge limit. */
    protected *_watchedEntities(payload: EvChargerDetailPayload): Iterable<string | null | undefined> {
        yield* Object.values(payload.entities);
        for (const vehicle of this._appliance.payload?.vehicles ?? []) {
            yield vehicle.telemetry.socEntityId;
            yield vehicle.telemetry.chargeLimitEntityId;
        }
    }

    /** The slot in progress names the car and dates the projection; the windows, which the base follows, start and end. */
    protected *_clockBoundaries(): Iterable<number> {
        yield Math.ceil((Date.now() + 1) / SLOT_MS) * SLOT_MS;
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    protected _renderOverview(overview: EvChargerDetailPayload) {
        const selection = this._selection();
        const power = this._powerW(overview);
        const charging = this._charging(overview);
        const direct = deviceDirectControls(this.params.item);
        const session = this._sessionKWh(overview);
        const caption = [direct?.switchEntityId && this.hass.states[direct.switchEntityId]?.state === "off"
            ? this.localize("node_detail.shared.ev_off") : charging ? this.localize("node_detail.shared.ev_charging") : this._waitingPreview(overview, selection)];
        if (session !== null) caption.push(fillTemplate(this.localize("node_detail.shared.ev_session_total"), { kwh: formatKwh(session) }));
        return html`
            <div class="content" data-overview>
                ${this._fault(overview) ? this._exceptionBanner(fillTemplate(this._t("exception.fault"), { fault: this._fault(overview)! })) : nothing}
                <helman-detail-headline .value=${power === null ? "—" : formatPower(power).display}
                    .entityId=${overview.entities.power ?? this.params.item.powerSensorId ?? null} .caption=${caption}>
                    ${direct?.switchEntityId ? html`<helman-switch-tile slot="icon" .hass=${this.hass} .localize=${this.localize}
                        .entityId=${direct.switchEntityId} fallbackIcon="mdi:car-electric"></helman-switch-tile>`
                        : html`<ha-icon slot="icon" icon="mdi:car-electric"></ha-icon>`}
                </helman-detail-headline>
                <helman-flow-gauge direction="from" .items=${estimatedConsumerMix(this.params.flows, power)} .estimated=${true} .localize=${this.localize}></helman-flow-gauge>
                <helman-who-decides .hass=${this.hass} .localize=${this.localize} .controllableId=${this.deviceId}></helman-who-decides>
                ${this._renderCarTile(overview, selection)}
            </div>
        `;
    }

    // Forecast ----------------------------------------------------------------

    /**
     * Whether the plan brings the selected car to its limit: the completion
     * the plan answer estimates, its SoC path after the recorded SoC today,
     * and whether a candidate window would be needed. None without an estimate.
     */
    protected _renderForecast() {
        const projection = this._projection.state;
        if (projection?.status === "error") {
            return this._forecastSection(this._t("plan.projection_failed"), () => html`
                <button class="link-button" @click=${() => this._projection.load()}>${this._t("retry")}</button>`);
        }
        const selection = this._selection();
        if (!projection || projection.status !== "ready" || selection.kind !== "selected") return nothing;
        const completion = this._completion(selection, projection.payload);
        if (completion.kind !== "estimate") return nothing;
        const car = selection.car;
        const limit = this._percent(car.limit!);
        const reached = completion.reachMs !== null;
        const forecast = (key: string) => this.localize(`node_detail.shared.forecast.${key}`);
        const context = this._chartContext;
        const summary = reached
            ? html`${boldTemplate(forecast("ev_reaches"), { limit, time: forecastWhen(completion.reachMs!, context) })} <span class="ok">✓</span>`
            : boldTemplate(forecast("ev_short"), { kwh: `${formatKwh(completion.shortfallKwh)} kWh`, limit, time: completion.endMs === null ? "?" : forecastWhen(completion.endMs, context) });
        return this._forecastSection(summary, () => this._renderForecastBody(car, completion as Extract<Completion, { kind: "estimate" }>));
    }

    private _renderForecastBody(car: Vehicle, completion: Extract<Completion, { kind: "estimate" }>) {
        const context = this._chartContext;
        const end = modeStripWindow(context.now, context.timeZone).end;
        const forecast = (key: string) => this.localize(`node_detail.shared.forecast.${key}`);
        const now = { t: context.now, v: car.soc! };
        const actual = this._socHistory.payload ?? [];
        const reached = completion.reachMs !== null;
        const endSoc = this._percent(reached ? car.limit! : Math.floor(completion.endSoc));
        const candidate = this._plan.runs.find((window) => window.candidate && window.vehicleId === car.vehicle.id && (window.endMs === null || window.endMs > context.now));
        return html`
            ${renderForecastChart(context, {
                title: forecast("ev_chart"),
                help: forecast("ev_help"),
                series: [
                    { key: "actual", label: forecast("actual"), color: "var(--success-color, #43a047)", points: actual.length ? [...actual, now] : [] },
                    { key: "planned", label: forecast("planned"), color: "var(--success-color, #43a047)", dashed: true,
                        // Held between the windows: the car keeps its charge until the next one.
                        points: [now, ...holdAtSlots(completion.path, Math.ceil(context.now / SLOT_MS) * SLOT_MS, end, car.soc!)] },
                ],
                references: [{ value: car.limit!, label: fillTemplate(forecast("ev_limit"), { limit: this._percent(car.limit!) }) }],
                formatValue: (value) => this._percent(value),
            })}
            <div class="rows">
                <div class="row" data-row="end-of-plan"><span class="label">${forecast("ev_end")}</span>
                    <span class="value">${reached ? fillTemplate(forecast("ev_end_reached"), { soc: endSoc })
                        : fillTemplate(forecast("ev_end_short"), { soc: endSoc, kwh: `${formatKwh(completion.shortfallKwh)} kWh` })}</span></div>
                ${candidate ? html`<div class="row" data-row="candidate"><span class="label">${forecast("ev_candidate")}</span>
                    <span class="value">${reached ? forecast("ev_candidate_no")
                        : fillTemplate(forecast("ev_candidate_yes"), { window: forecastWhen(candidate.startMs, context, candidate.endMs ?? undefined) })}</span></div>` : nothing}
            </div>
        `;
    }

    /**
     * The selected car's SoC since midnight from HA's history, the value in
     * force at each slot boundary up to now: a car reports when it likes, so
     * the line is held between its readings rather than broken.
     */
    private async _readSocHistory(): Promise<DayLinePoint[]> {
        const selection = this._selection();
        if (selection.kind !== "selected") return [];
        const entityId = selection.car.vehicle.telemetry.socEntityId;
        const now = Date.now();
        const { start } = modeStripWindow(now, this._timeZone);
        const result = await this.hass.callWS<Record<string, Array<{ s: string; lu: number }>>>({
            type: "history/history_during_period", start_time: new Date(start).toISOString(), end_time: new Date(now).toISOString(),
            entity_ids: [entityId], minimal_response: true, no_attributes: true, significant_changes_only: false,
        });
        const readings = (result?.[entityId] ?? [])
            .map((state) => ({ t: state.lu * 1000, v: Number(state.s) }))
            .filter((reading) => Number.isFinite(reading.v) && reading.v >= 0 && reading.v <= 100);
        return holdAtSlots(readings, start, now);
    }

    private _renderCarTile(overview: EvChargerDetailPayload, selection: VehicleSelection) {
        if (selection.kind !== "selected") return html`<div class="tile">${this._t(selection.kind === "none" ? "car.none" : "car.ambiguous")}</div>`;
        const car = selection.car;
        const power = this._powerW(overview);
        const minutes = power && power > IDLE_W && car.neededKwh !== null ? car.neededKwh / (power / 1000) * 60 : null;
        return html`<div class="tile" data-car>
            <div class="row"><span>${car.vehicle.name}</span><span><strong>${car.soc ?? "?"} %</strong> <span class="label">${this.localize("node_detail.shared.ev_of")} ${car.limit ?? "?"} % ${this.localize("node_detail.shared.ev_limit")}</span></span></div>
            <div class="meter"><span class="meter-fill" style=${`width:${Math.max(0, Math.min(100, car.soc ?? 0))}%`}></span>
                ${car.limit !== null ? html`<span data-limit-marker style=${`left:${Math.max(0, Math.min(100, car.limit))}%`}></span>` : nothing}
            </div>
            <div class="row"><span class="label">${this.localize("node_detail.shared.ev_needed")}</span><span>${car.neededKwh === null ? "—" : `${formatKwh(car.neededKwh)} kWh`}</span></div>
            ${minutes !== null ? html`<div class="row"><span class="label">${this.localize("node_detail.shared.ev_at_power")}</span><span>${fillTemplate(this.localize("node_detail.shared.ev_eta"), {
                duration: this._duration(minutes), time: this._time(Date.now() + minutes * 60_000),
            })}</span></div>` : nothing}
        </div>`;
    }

    // History & statistics -----------------------------------------------------

    /** What charged it today by source, with what the grid share cost, and its power over the last 24 hours. */
    protected _renderHistory(_overview: EvChargerDetailPayload) {
        const charger = this._today.payload?.charger ?? null;
        const summary = historySummary(this._today, this.localize, charger
            ? boldTemplate(this._h("ev_summary"), { kwh: kwhText(charger.kwh), pct: charger.kwh > 0 ? Math.round(charger.sources.solar / charger.kwh * 100) : 0 })
            : null);
        return this._historySection(summary, () => html`
            ${subTitle(this._h("charged_today"))}
            ${this._renderToday()}
            ${this._chart.render(this.localize)}
        `);
    }

    private _renderToday() {
        const notReady = sectionNotReady(this._today, this.localize);
        if (notReady) return notReady;
        const payload = this._today.payload!;
        const charger = payload.charger;
        if (!charger) return html`<p class="note" data-today-unavailable>${this._h("ev_today_unavailable")}</p>`;
        const paid = charger.money.paid;
        return html`
            ${renderShareBar(this.localize, [
                { node: "solar", kwh: charger.sources.solar }, { node: "battery", kwh: charger.sources.battery }, { node: "grid", kwh: charger.sources.grid },
                { node: "unknown", kwh: charger.sources.unattributed },
            ], this._h("source_unknown_cap"))}
            <div class="rows" data-sources>
                ${historyRow(this._h("from_solar_cap"), kwhText(charger.sources.solar), "from-solar")}
                ${historyRow(this._h("from_battery_cap"), kwhText(charger.sources.battery), "from-battery")}
                ${historyRow(this._h("from_grid_cap"), paid !== null && charger.sources.grid > 0
                    ? fillTemplate(this._h("kwh_paid"), { kwh: kwhText(charger.sources.grid), money: `≈ ${this._formatMoney(paid, currencyFromPriceUnit(payload.priceUnit))}` })
                    : kwhText(charger.sources.grid), "from-grid")}
                ${charger.sources.unattributed > 0 ? historyRow(this._h("source_unknown_cap"), kwhText(charger.sources.unattributed), "from-unknown") : nothing}
            </div>
        `;
    }

    /** The charger's power sensor: its overview's, else the device's own. */
    private _powerEntity(): string | null {
        const overview = this._overview.status === "ready" ? this._overview.payload : null;
        return overview?.entities.power ?? this.params?.item.powerSensorId ?? null;
    }

    // Technical details ---------------------------------------------------------

    /**
     * Execution and the executor's outcome, the current window's settings and
     * the charger's charge mode, when the projection was generated, the link
     * and fault state, and the total power against the sum of the phases.
     */
    protected _renderTechnical(overview: EvChargerDetailPayload) {
        const now = Date.now();
        const runtime = runtimeFor<ApplianceRuntimeDTO>(this._plan.schedule, this.deviceId, now);
        const window = this._plan.runs.find((run) => run.startMs <= now && (run.endMs === null || now < run.endMs)) ?? null;
        const projection = this._projection.payload;
        const fault = this._fault(overview);
        const comparison = this._comparison(overview);
        const t = (key: string) => this.localize(`node_detail.shared.technical.${key}`);
        const mode = window?.useMode ? this.localize(`scheduling.appliance.ev.mode.${window.useMode === "ECO" ? "eco" : "fast"}`) : null;
        const settings = window ? [mode, window.ecoGear].filter(Boolean).join(" · ") || "—" : t("no_window");
        return html`
            <div class="rows">
                ${this._plan.schedule ? this._row(this._t("plan.execution"), this._t(this._plan.schedule.executionEnabled ? "plan.execution_on_value" : "plan.execution_off_value"), "execution") : nothing}
                ${this._row(t("executor"), runtime ? runtimeText(runtime, this.localize) : t("no_runtime"), "runtime")}
                ${this._row(t("window_settings"), settings, "window")}
                ${this._optionalRow(overview, "charge_mode", "plan.charge_mode")}
                ${this._row(this._t("plan.generated"), projection ? this._time(Date.parse(projection.generatedAt)) : "—", "generated")}
            </div>
            ${subTitle(t("link"))}
            <div class="rows">
                ${this._row(this._t("trust.fault"), fault ?? (this._faultKnown(overview) ? this._t("trust.no_fault") : this._t("unavailable")), "fault")}
                ${this._optionalRow(overview, "network_status", "trust.network")}
                ${this._optionalRow(overview, "link_success_rate", "trust.link")}
            </div>
            ${subTitle(this._t("trust.comparison"))}
            <div class="rows">
                ${comparison.kind === "compared" ? html`
                    ${this._row(this._t("trust.total"), formatPower(comparison.totalW).display + " · " + this._time(comparison.totalAt), "total")}
                    ${this._row(this._t("trust.phase_sum"), formatPower(comparison.phaseSumW).display + " · " + this._time(comparison.phasesAt), "phase-sum")}
                    ${this._row(this._t("trust.difference"), formatPower(Math.abs(comparison.differenceW)).display, "difference")}
                ` : html`<p class="note" data-incomparable>${this._t(`trust.incomparable.${comparison.kind}`)}</p>`}
            </div>
        `;
    }

    // Lane history -----------------------------------------------------------

    /**
     * Today's recorded charging for the Schedule strip, the stretch still
     * going running on while the charger charges.
     */
    private _historySegments(overview: EvChargerDetailPayload): ModeSegment[] {
        const tone = getScheduleApplianceActionPresentation({
            appliance: { kind: "ev_charger", icon: "" },
            action: { charge: true },
            localize: this.localize,
        }).tone;
        return (this._segment.payload?.charging ?? []).map((stretch) => ({
            start: Date.parse(stretch.start),
            end: stretch.open && this._charging(overview) ? Infinity : Date.parse(stretch.end),
            tone,
            label: laneActionLabel({ charge: true }, this.localize),
        }));
    }

    /**
     * The selected car's charge at the end of the plan, and the end of the first
     * slot that reaches its limit, under the current plan.
     *
     * Only effective slots count: execution on, the slot's action charging this
     * car, its condition met. The threshold is crossed in the cumulative
     * projected energy against what the car needs from its live SoC, never on
     * the projection's rounded SoC. A projection from before the slot in
     * progress, or one whose points the plan no longer holds, is stale.
     *
     * The projection fills the car through candidate slots too, so a candidate
     * before an effective slot caps what that slot is projected to deliver:
     * past such a candidate the cumulative energy no longer says what the
     * effective slots alone would do, and short of the limit there is no estimate.
     */
    private _completion(selection: VehicleSelection, payload: ApplianceProjectionsPayload): Completion {
        const unsupported = (reason: string): Completion => ({ kind: "unsupported", reason });
        if (selection.kind !== "selected") return unsupported("no_vehicle");
        const car = selection.car;
        if (car.soc === null || car.limit === null || car.capacityKwh === null || car.neededKwh === null) return unsupported("no_target");
        if (car.neededKwh <= 0) return unsupported("reached");
        const schedule = this._plan.schedule;
        if (!schedule) return unsupported("no_plan");
        if (!schedule.executionEnabled) return unsupported("execution_off");
        const now = Date.now();
        const windows = this._plan.runs;
        if (!windows.some((window) => !window.candidate && window.vehicleId === car.vehicle.id)) {
            return unsupported(windows.some((window) => window.vehicleId === car.vehicle.id) ? "candidates_only" : "no_windows");
        }
        const generatedAt = Date.parse(payload.generatedAt);
        if (!Number.isFinite(generatedAt) || generatedAt < Math.floor(now / SLOT_MS) * SLOT_MS) return unsupported("stale");
        const series = payload.appliances?.[this.deviceId]?.series;
        if (!series?.length) return unsupported("no_projection");

        const boundaries = new Map(this._boundaries().map((slot) => [slot.id, slot]));
        const actions = new Map(schedule.slots.map((slot) => [slot.id, slot.controllables[this.deviceId] as ScheduleEvChargerActionDTO | undefined]));
        const firstCandidateMs = Math.min(...schedule.slots.map((slot) => {
            const action = actions.get(slot.id);
            const bounds = boundaries.get(slot.id);
            return action?.charge && action.conditionMet === false && action.vehicleId === car.vehicle.id
                && bounds && (bounds.endMs === null || bounds.endMs > now) ? bounds.startMs : Infinity;
        }));
        let suppliedKwh = 0;
        let reachMs: number | null = null;
        let endMs: number | null = null;
        let counted = 0;
        const path: DayLinePoint[] = [];
        const points = [...series].sort((a, b) => (boundaries.get(a.slotId)?.startMs ?? 0) - (boundaries.get(b.slotId)?.startMs ?? 0));
        for (const point of points) {
            if (point.vehicleId !== car.vehicle.id) continue;
            const slot = boundaries.get(point.slotId);
            // A point for a slot the plan no longer holds: computed for another plan.
            if (!slot) return unsupported("stale");
            const action = actions.get(point.slotId);
            if (!action?.charge || action.conditionMet === false || action.vehicleId !== car.vehicle.id) continue;
            if (slot.endMs !== null && slot.endMs <= now) continue;
            if (slot.startMs > firstCandidateMs) {
                if (reachMs !== null) break;
                return unsupported("candidate_first");
            }
            if (!Number.isFinite(point.energyKwh) || point.energyKwh < 0) return unsupported("no_projection");
            // The slot in progress counts only what has not been charged since the projection.
            suppliedKwh += point.energyKwh * stillAhead(slot.startMs, generatedAt, now);
            counted += 1;
            endMs = slot.endMs;
            if (slot.endMs !== null) path.push({ t: slot.endMs, v: Math.min(car.limit, car.soc + suppliedKwh / car.capacityKwh * 100) });
            if (reachMs === null && suppliedKwh >= car.neededKwh - 1e-9) reachMs = slot.endMs;
        }
        if (counted === 0) return unsupported("no_projection");
        return {
            kind: "estimate",
            endSoc: Math.min(100, car.soc + suppliedKwh / car.capacityKwh * 100),
            endMs,
            reachMs,
            suppliedKwh,
            shortfallKwh: Math.max(0, car.neededKwh - suppliedKwh),
            path,
        };
    }

    // Waiting -----------------------------------------------------------------

    /**
     * What the readings support as the reason it is not charging. A fault the
     * charger reports comes first; a reported status next; then the plan's own
     * facts. ECO surplus is context, never the established cause.
     */
    private _waiting(overview: EvChargerDetailPayload, selection: VehicleSelection):
        | { kind: "fault"; text: string }
        | { kind: "charging" }
        | { kind: "no_car" }
        | { kind: "reasons"; reasons: string[]; eco: boolean } {
        const fault = this._fault(overview);
        if (fault) return { kind: "fault", text: fault };
        if (this._charging(overview)) return { kind: "charging" };
        if (overview.status?.kind === "no_car") return { kind: "no_car" };
        const reasons: string[] = [];
        if (selection.kind === "selected" && selection.car.neededKwh !== null && selection.car.neededKwh <= 0) {
            reasons.push(fillTemplate(this._t("waiting.reached"), {
                name: selection.car.vehicle.name, soc: this._percent(selection.car.soc!), limit: this._percent(selection.car.limit!),
            }));
        }
        const schedule = this._plan.schedule;
        const now = Date.now();
        const current = this._plan.runs.find((window) => window.startMs <= now);
        let eco = false;
        if (schedule && !schedule.executionEnabled) {
            reasons.push(this._t("waiting.execution_off"));
        } else if (schedule && !current) {
            const next = this._nextEffectiveWindow();
            reasons.push(next ? fillTemplate(this._t("waiting.next_window"), { window: this._windowTime(next) }) : this._t("waiting.no_window"));
        } else if (current?.candidate) {
            reasons.push(this._t("waiting.candidate"));
        } else if (current) {
            const runtime = runtimeFor<ApplianceRuntimeDTO>(this._plan.schedule, this.deviceId, Date.now());
            if (runtime?.outcome === "failed") {
                reasons.push(fillTemplate(this._t("waiting.runtime_failed"), { message: runtime.message ?? runtime.errorCode ?? this._t("unknown") }));
            }
            eco = (current.useMode ?? this._reading(overview, "use_mode")) === "ECO";
        }
        return { kind: "reasons", reasons, eco };
    }

    private _waitingPreview(overview: EvChargerDetailPayload, selection: VehicleSelection): string {
        const waiting = this._waiting(overview, selection);
        if (waiting.kind === "fault") return this._t("waiting.fault_short");
        if (waiting.kind === "charging") return this._t("waiting.charging");
        if (waiting.kind === "no_car") return this._t("waiting.no_car_short");
        if (waiting.reasons.length === 1) return waiting.reasons[0];
        return this._t("waiting.unknown_short");
    }

    /**
     * The charger's total power against the sum of its phase powers: both its
     * own, in W, positive while charging. Compared only when every reading is
     * there and they were taken within {@link COMPARABLE_MS} of each other; a
     * difference is shown, never judged.
     */
    private _comparison(overview: EvChargerDetailPayload):
        | { kind: "compared"; totalW: number; phaseSumW: number; differenceW: number; totalAt: number; phasesAt: number }
        | { kind: "missing" | "not_together" } {
        const total = this._powerW(overview);
        const phases = this._phases(overview);
        if (total === null || phases.some((watts) => watts === null)) return { kind: "missing" };
        // When each was last read: an unchanged value moves `last_reported`, not `last_updated`.
        const times = ["power", "charge_power_l1", "charge_power_l2", "charge_power_l3"].map((key) => {
            const state = this.hass.states[overview.entities[key]!] as { last_reported?: string; last_updated?: string } | undefined;
            return Date.parse(state?.last_reported ?? state?.last_updated ?? "");
        });
        if (times.some((at) => !Number.isFinite(at))) return { kind: "missing" };
        if (Math.max(...times) - Math.min(...times) > COMPARABLE_MS) return { kind: "not_together" };
        const phaseSumW = phases.reduce((sum, watts) => sum! + watts!, 0)!;
        return {
            kind: "compared",
            totalW: total,
            phaseSumW,
            differenceW: total - phaseSumW,
            totalAt: times[0],
            phasesAt: Math.max(...times.slice(1)),
        };
    }

    // ── Readings ────────────────────────────────────────────────────────────

    /** A non-negative power reading in W, by its unit; `null` without one. */
    private _power(entityId: string | null | undefined): number | null {
        const value = readingNumber(this.hass, entityId);
        const factor = powerUnitFactor(this.hass, entityId);
        return value === null || factor === null || value * factor < 0 ? null : value * factor;
    }

    private _powerW(overview: EvChargerDetailPayload): number | null {
        return this._power(overview.entities.power);
    }

    private _phases(overview: EvChargerDetailPayload): Array<number | null> {
        return [1, 2, 3].map((phase) => this._power(overview.entities[`charge_power_l${phase}`]));
    }

    /** The hardware's session energy in kWh; a reading without a known unit is none. */
    private _sessionKWh(overview: EvChargerDetailPayload): number | null {
        const kwh = readEnergyKWh(this.hass, overview.entities.session_energy, false);
        return kwh === null || kwh < 0 ? null : kwh;
    }

    /** Charging as reported; a Custom charger without a status, by its power. */
    private _charging(overview: EvChargerDetailPayload): boolean {
        if (overview.status) return overview.status.kind === "charging";
        if (overview.entities.run_mode) return false;
        const power = this._powerW(overview);
        return power !== null && power > IDLE_W;
    }

    private _faultKnown(overview: EvChargerDetailPayload): boolean {
        return overview.status !== null || readingNumber(this.hass, overview.entities.fault_code) !== null;
    }

    /**
     * A fault the charger reports: a faulted run mode, or a non-zero fault code
     * while it is not charging (a code can outlive a recovered fault); `null` otherwise.
     */
    private _fault(overview: EvChargerDetailPayload): string | null {
        const code = readingNumber(this.hass, overview.entities.fault_code);
        const description = this._reading(overview, "fault_description");
        if (overview.status?.kind !== "fault" && (code === null || code === 0 || this._charging(overview))) return null;
        const parts = [overview.status?.kind === "fault" ? overview.status.runMode : null, description, code ? fillTemplate(this._t("trust.code"), { code: String(code) }) : null];
        return parts.filter(Boolean).join(" · ");
    }

    // ── Vehicle and plan ────────────────────────────────────────────────────

    /**
     * The car the answers are about: the only configured one, or the one the
     * slot in progress names. Several cars and nothing naming one is ambiguous:
     * no car's SoC is shown rather than possibly the wrong one's.
     */
    private _selection(): VehicleSelection {
        const appliance = this._appliance.payload;
        const vehicles = appliance?.vehicles ?? [];
        if (!vehicles.length) return { kind: "none" };
        if (vehicles.length === 1) return { kind: "selected", car: this._car(vehicles[0], "only") };
        const named = this._currentAction()?.vehicleId;
        const vehicle = vehicles.find((item) => item.id === named);
        return vehicle ? { kind: "selected", car: this._car(vehicle, "plan") } : { kind: "ambiguous", count: vehicles.length };
    }

    private _car(vehicle: ApplianceVehicleDTO, selectedBy: Vehicle["selectedBy"]): Vehicle {
        const percent = (entityId: string | undefined, allowZero: boolean) => {
            const value = readingNumber(this.hass, entityId);
            return value !== null && value <= 100 && (allowZero ? value >= 0 : value > 0) ? value : null;
        };
        const soc = percent(vehicle.telemetry.socEntityId, true);
        const limit = percent(vehicle.telemetry.chargeLimitEntityId, false);
        const capacity = vehicle.metadata.batteryCapacityKwh;
        const capacityKwh = Number.isFinite(capacity) && capacity > 0 ? capacity : null;
        return {
            vehicle,
            selectedBy,
            soc,
            limit,
            capacityKwh,
            neededKwh: soc !== null && limit !== null && capacityKwh !== null ? Math.max(0, limit - soc) / 100 * capacityKwh : null,
        };
    }

    /** This charger's action in the slot in progress. */
    private _currentAction(): ScheduleEvChargerActionDTO | null {
        const slot = this._currentSlot();
        return slot ? (this._plan.schedule!.slots.find((item) => item.id === slot.id)?.controllables[this.deviceId] as ScheduleEvChargerActionDTO | undefined) ?? null : null;
    }

    private _currentSlot() {
        const now = Date.now();
        return this._boundaries().find((slot) => slot.startMs <= now && (slot.endMs === null || now < slot.endMs)) ?? null;
    }

    private _boundaries(): ScheduleSlotBoundary[] {
        if (this._boundariesCache) return this._boundariesCache;
        const schedule = this._plan.schedule;
        return this._boundariesCache = resolveScheduleSlotBoundaries((schedule?.slots ?? []).map((slot) => slot.id))
            .map((slot) => ({ ...slot, endMs: slot.startMs + SLOT_MS }));
    }

    /** The first window that will run: execution on and its condition met. */
    private _nextEffectiveWindow(): ChargeWindow | null {
        if (!this._plan.schedule?.executionEnabled) return null;
        return this._plan.runs.find((window) => !window.candidate) ?? null;
    }

    private _windowTime(window: ChargeWindow): string {
        const start = window.startMs <= Date.now() ? this._t("now") : this._time(window.startMs);
        return start + "–" + (window.endMs === null ? "?" : this._time(window.endMs));
    }

    private _percent(value: number): string {
        return Math.round(value) + " %";
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "node-detail-ev-charger-content": NodeDetailEvChargerContent;
    }
}
