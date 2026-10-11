import { css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { fillTemplate } from "../../localize/localize";
import {
    getEffectiveSolarForecastPoints,
    type ScheduleActionDTO,
    type SchedulePayload,
    type SolarDestinationsSectionPayload,
    type SolarDetailPayload,
    type SolarProductionSectionPayload,
    type SolarStringsSectionPayload,
} from "../../helman-api";
import type { HelmanSolarInspectorCardConfig } from "../../helman-solar-inspector/HelmanSolarInspectorCardConfig";
import { currencyFromPriceUnit } from "../../helman-solar-inspector/money-model";
import { BATT_COLOR, GRID_EXPORT_COLOR, HOUSE_COLOR, NEUTRAL_LIGHT_COLOR } from "../../color-utils";
import { getSharedHelmanStore } from "../../helman/store";
import { formatPower } from "../../power-format";
import { formatGridEnergy, formatPriceValue } from "../../shared/forecast-value-format";
import { addDaysToDayKey } from "../../shared/schedule/model/schedule-time";
import { getSharedScheduleOwner } from "../../shared/schedule/schedule-owner";
import "../../shared/day-line-chart";
import type { DayLineSeries } from "../../shared/day-line-chart";
import { IDLE_W, NodeDetailContentBase, TODAY_REFRESH_MS, type SectionState } from "./node-detail-base";
import { readEnergyKWh } from "./node-detail-readings";
import {
    currentRun,
    currentRuntime,
    dayKey,
    renderCurrentSlot,
    runtimeText,
    scheduleRuns,
    type ScheduleRun,
} from "./node-detail-schedule";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import type { SolarDetailParams } from "./node-detail-types";

type QuestionId = "production" | "destinations" | "limits" | "strings" | "outlook";
type SectionName = "production" | "strings" | "destinations";
type SectionPayload = SolarProductionSectionPayload | SolarStringsSectionPayload | SolarDestinationsSectionPayload;

/** The history section each question's answer reads, when it reads one. */
const SECTION_OF: Partial<Record<QuestionId, SectionName>> = {
    production: "production",
    strings: "strings",
    destinations: "destinations",
};

/** The forecast's canonical slot. */
const SLOT_MS = 15 * 60_000;

/** How many calendar days the outlook shows, today first. */
const OUTLOOK_DAYS = 7;

/** One colour per string; every chart and row also names the string in text. */
const STRING_COLORS: Record<string, string> = { "1": "#fb8c00", "2": "#3949ab" };

/** Power units a reading converts from, to W; any other is no reading. */
const WATTS: Record<string, number> = { W: 1, kW: 1000, MW: 1_000_000 };

/**
 * The inspector under "Is today's production meeting expectations?": today's
 * measured production against the corrected forecast, nothing else. The raw
 * forecast and the bias diagnostics are evidence, behind the second disclosure.
 */
export const SOLAR_FORECAST_INSPECTOR_CONFIG: HelmanSolarInspectorCardConfig = {
    type: "custom:helman-solar-inspector-card",
    transparent_background: true,
    hide_schedule_strip: true,
    hide_price_strip: true,
    hide_money_strip: true,
    hide_aggregate_views: true,
    show_bias_ratio: false,
    chart_series: ["actual", "corrected"],
};

/** The same day with the raw forecast and the bias correction revealed: the evidence. */
export const SOLAR_BIAS_INSPECTOR_CONFIG: HelmanSolarInspectorCardConfig = {
    ...SOLAR_FORECAST_INSPECTOR_CONFIG,
    show_bias_ratio: true,
    chart_series: ["actual", "corrected", "raw"],
};

/** A forecast slot: its start and its energy, Wh. */
interface Slot {
    start: number;
    wh: number;
}

/** The forecast as the answers read it, for the slot in progress. */
interface ForecastModel {
    /** Today's elapsed slots that have a measured value, against the forecast for the same slots. */
    comparison: { startMs: number; endMs: number; actualKwh: number; forecastKwh: number; rawKwh: number | null } | null;
    /** Forecast energy from now to the end of today, the slot in progress by its remaining part. */
    remainingKwh: number;
    /** The slot in progress, as an average power, W; `null` without one. */
    slotW: number | null;
    /** When today's forecast production next starts or ends, if it does. */
    startsAt: number | null;
    endsAt: number | null;
    /** Today and the next days: their forecast total, `null` for a day without one. */
    days: Array<{ key: string; firstMs: number | null; kwh: number | null }>;
    /** Whether the totals are the bias-corrected forecast. */
    corrected: boolean;
    /** The slot boundaries of today that are still ahead. */
    boundaries: number[];
}

/**
 * The solar detail: whether today's production meets the forecast, where it
 * went, whether anything limits it, how the strings contribute and what to
 * expect, as an overview and five questions.
 *
 * Live readings come from `hass`; the backend overview supplies the entity ids,
 * the string mapping and the configured capacity. The forecast is loaded with
 * the overview, because the overview compares against it; today's peak, string
 * history and destinations are requested only while their question is open,
 * and the inspector embeds are mounted only behind their answers. Nothing here
 * is a diagnosis: power above the AC rating is not measured clipping, a cap is
 * a setting rather than lost energy, and unequal strings are not a fault.
 */
@customElement("node-detail-solar-content")
export class NodeDetailSolarContent extends NodeDetailContentBase<SolarDetailPayload, QuestionId> {
    static styles = [nodeDetailSharedStyles, nodeDetailQuestionStyles, css`
        .swatch {
            display: inline-block;
            width: 10px;
            height: 10px;
            margin-right: 6px;
            vertical-align: baseline;
            border-radius: 2px;
        }
        .split {
            display: flex;
            height: 12px;
            border-radius: 6px;
            overflow: hidden;
            background: var(--secondary-background-color, rgba(0, 0, 0, 0.06));
        }
        .split > span {
            height: 100%;
        }
        .days {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
            gap: 6px;
        }
        .day {
            display: flex;
            flex-direction: column;
            gap: 2px;
            padding: 6px;
            border-radius: 6px;
            background: var(--secondary-background-color, rgba(0, 0, 0, 0.04));
            font-size: 0.82rem;
            min-width: 0;
        }
        .day-label {
            color: var(--secondary-text-color);
        }
        .day-value {
            font-weight: 600;
            overflow-wrap: anywhere;
        }
        .muted {
            color: var(--secondary-text-color);
        }
    `];

    protected readonly _node = "solar" as const;

    @property({ attribute: false }) public params!: SolarDetailParams;

    @state() private _schedule: SchedulePayload | null = null;
    /** The open answer's history section, `null` while no open answer reads one. */
    @state() private _section: SectionState<SectionPayload> | null = null;

    private _unsubscribeSchedule?: () => void;
    private _sectionRequest = 0;
    private _sectionRequestedAt = 0;
    private _modelCache?: { forecast: unknown; slot: number; model: ForecastModel | null };
    private _stringsChart?: { payload: SolarStringsSectionPayload; series: DayLineSeries[] };

    willUpdate(changed: Map<string, unknown>): void {
        super.willUpdate(changed);
        // The open answer's history is "today so far": re-read it on a new day,
        // and otherwise at most every few minutes, only while the page is visible.
        const section = this._section;
        if (section?.status === "ready" && !document.hidden
            && (!this._isToday(section.payload.period.start) || Date.now() - this._sectionRequestedAt > TODAY_REFRESH_MS)) {
            void this._loadSection();
        }
    }

    protected _start(): void {
        this._unsubscribeSchedule = getSharedScheduleOwner(this.hass).subscribe((snapshot) => {
            this._schedule = snapshot.schedule;
        });
        super._start();
        // The overview compares today's production with the forecast.
        void this._loadForecast();
    }

    protected _stop(): void {
        this._unsubscribeSchedule?.();
        this._unsubscribeSchedule = undefined;
        this._sectionRequest += 1;
    }

    protected _onDataChanged(): void {
        // The base reloads the overview and the forecast; the schedule owner reloads itself.
        super._onDataChanged();
        if (this._section !== null) void this._loadSection();
    }

    /** The run mode the overview's condition was computed from. */
    protected _overviewSignature(payload: SolarDetailPayload): string {
        const entityId = payload.entities.run_mode;
        return entityId ? this.hass.states[entityId]?.state ?? "" : "";
    }

    protected _overviewLoaded(payload: SolarDetailPayload): void {
        // An answer may already be open, waiting for the overview's sections.
        if (this._section === null && this._sectionName(payload) !== null) void this._loadSection();
    }

    /**
     * The comparison, the slot in progress and the rest of today's forecast
     * move at each forecast slot boundary; the control intent at each plan run.
     */
    protected *_clockBoundaries(): Iterable<number> {
        yield* this._model()?.boundaries ?? [];
        for (const run of this._runs()) {
            yield run.startMs;
            if (run.endMs !== null) yield run.endMs;
        }
    }

    // ── Data ────────────────────────────────────────────────────────────────

    /** The section the open answer reads, if the overview offers it. */
    private _sectionName(overview: SolarDetailPayload | null = this._overview.status === "ready" ? this._overview.payload : null): SectionName | null {
        const name = this._open ? SECTION_OF[this._open] : undefined;
        return name && overview?.sections.includes(name) ? name : null;
    }

    private async _loadSection(): Promise<void> {
        const name = this._sectionName();
        if (name === null) return;
        const request = ++this._sectionRequest;
        // A refresh keeps the answer on screen until the new figures land.
        const shown = this._section?.status === "ready" ? this._section.payload : null;
        if (!shown || shown.section !== name || !this._isToday(shown.period.start)) this._section = { status: "loading" };
        this._sectionRequestedAt = Date.now();
        try {
            const payload = await getSharedHelmanStore(this.hass)
                .getNodeDetail<SectionPayload>({ node: "solar", section: name }, { fresh: true });
            if (request !== this._sectionRequest) return;
            this._section = { status: "ready", payload };
        } catch (error) {
            if (request !== this._sectionRequest) return;
            console.error(`node-detail-solar: failed to load the ${name} section`, error);
            if (this._section?.status !== "ready") this._section = { status: "error" };
        }
    }

    /** The open answer's section payload, when it has landed. */
    private _ready<T extends SectionPayload>(name: T["section"]): T | null {
        const section = this._section;
        return section?.status === "ready" && section.payload.section === name ? section.payload as T : null;
    }

    // ── Disclosure ──────────────────────────────────────────────────────────

    protected _setOpen(id: QuestionId | null): void {
        super._setOpen(id);
        // A closed answer's request is obsolete; it is re-read on reopen.
        this._sectionRequest += 1;
        this._section = null;
        if (this._sectionName() !== null) void this._loadSection();
        // An opened forecast answer shows the forecast as it is now.
        if (id === "production" || id === "outlook") void this._loadForecast();
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    render() {
        const notReady = this._renderNotReady();
        if (notReady || this._overview.status !== "ready") return notReady;
        const overview = this._overview.payload;
        const model = this._model();
        return html`
            <div class="content">
                ${this._renderSummary(overview, model)}
                ${this._question("production", this._productionPreview(model), () => this._renderProduction(overview, model), () => this._renderProductionEvidence(overview, model), "evidence")}
                ${this._question("destinations", this._destinationsPreview(overview), () => this._renderDestinations(), () => this._renderDestinationsEvidence(overview), "evidence")}
                ${this._question("limits", this._limitsPreview(overview), () => this._renderLimits(overview), () => this._renderLimitsEvidence(overview), "technical")}
                ${overview.strings.length >= 2 ? this._question("strings", this._stringsPreview(overview), () => this._renderStrings(overview), () => this._renderStringsEvidence(overview), "technical") : nothing}
                ${this._question("outlook", this._outlookPreview(model), () => this._renderOutlook(overview, model), () => this._renderOutlookEvidence(overview), "evidence")}
            </div>
        `;
    }

    private _renderSummary(overview: SolarDetailPayload, model: ForecastModel | null) {
        const power = this._powerNow();
        const status = power === null
            ? this._t("status.unavailable")
            : power > IDLE_W
            ? fillTemplate(this._t("status.producing"), { power: formatPower(power).display })
            : this._t("status.not_producing");

        // The status sentence already says the power now.
        const figures: Array<[string, string, string]> = [];
        const today = readEnergyKWh(this.hass, overview.entities.today_energy);
        if (today !== null) figures.push([this._t("figure.today"), formatGridEnergy(today), "today"]);
        const comparison = model?.comparison;
        if (comparison && comparison.forecastKwh > 0) {
            figures.push([
                fillTemplate(this._t("figure.vs_forecast"), { time: this._time(comparison.endMs) }),
                this._share(comparison.actualKwh / comparison.forecastKwh),
                "vs-forecast",
            ]);
        }
        if (model) figures.push([this._t("figure.remaining"), formatGridEnergy(model.remainingKwh), "remaining"]);

        const next = this._nextLine(model);
        return html`
            <div class="summary" data-overview>
                <p class="status">${status}</p>
                ${figures.length ? html`
                    <div class="figures">
                        ${figures.map(([label, value, key]) => html`
                            <div class="figure" data-figure=${key}><span class="figure-label">${label}</span><span class="figure-value">${value}</span></div>
                        `)}
                    </div>
                ` : nothing}
                ${next ? html`<p class="next" data-next>${next}</p>` : nothing}
                ${this._renderException(overview)}
            </div>
        `;
    }

    /** When forecast production next starts or ends, today or tomorrow. */
    private _nextLine(model: ForecastModel | null): string | null {
        if (!model) return null;
        if (model.endsAt !== null && (model.startsAt === null || model.endsAt < model.startsAt)) {
            return fillTemplate(this._t("next.until"), { time: this._time(model.endsAt) });
        }
        if (model.startsAt !== null) return fillTemplate(this._t("next.from"), { time: this._time(model.startsAt) });
        const tomorrow = model.days[1];
        if (tomorrow?.kwh != null && tomorrow.kwh > 0) {
            return fillTemplate(this._t("next.tomorrow"), { kwh: formatGridEnergy(tomorrow.kwh) });
        }
        return this._t("next.none_today");
    }

    /** At most one: off-grid operation or a fault the inverter reports. */
    private _renderException(overview: SolarDetailPayload) {
        if (!overview.condition) return nothing;
        return html`
            <div class="exception" role="status" data-exception>
                <span>${fillTemplate(this._t(`exception.${overview.condition.kind}`), { state: overview.condition.runMode })}</span>
                <button class="link-button" @click=${() => this._setOpen("limits")}>${this._t("exception.details")}</button>
            </div>
        `;
    }

    // Production --------------------------------------------------------------

    private _productionPreview(model: ForecastModel | null): string | null {
        if (!model) return this._forecastFailed ? this.localize("node_detail.forecast_failed") : this._forecastMissing();
        const comparison = model.comparison;
        if (!comparison) return this._t("production.no_comparison");
        if (comparison.forecastKwh <= 0) {
            return fillTemplate(this._t("production.zero_forecast_short"), { time: this._time(comparison.endMs), actual: formatGridEnergy(comparison.actualKwh) });
        }
        return fillTemplate(this._t("production.share_short"), {
            share: this._share(comparison.actualKwh / comparison.forecastKwh),
            time: this._time(comparison.endMs),
        });
    }

    private _renderProduction(overview: SolarDetailPayload, model: ForecastModel | null) {
        const today = readEnergyKWh(this.hass, overview.entities.today_energy);
        const comparison = model?.comparison ?? null;
        const forecastLabel = this._t(model?.corrected === false ? "production.forecast_raw" : "production.forecast");
        return html`
            ${model ? html`
                ${comparison ? html`
                    ${this._row(this._t("production.period_label"), this._periodText(comparison.startMs, comparison.endMs), "period")}
                    ${this._row(this._t("production.actual"), formatGridEnergy(comparison.actualKwh), "actual")}
                    ${this._row(forecastLabel, formatGridEnergy(comparison.forecastKwh), "forecast")}
                    ${this._row(this._t("production.difference"), comparison.forecastKwh > 0
                        ? fillTemplate(this._t("production.difference_value"), {
                            share: this._share(comparison.actualKwh / comparison.forecastKwh),
                            kwh: this._signedKwh(comparison.actualKwh - comparison.forecastKwh),
                        })
                        : this._t("production.zero_forecast"), "difference")}
                ` : html`<p class="note" data-no-comparison>${this._t("production.no_comparison_long")}</p>`}
                ${this._row(this._t("production.now"), this._slotText(model), "now")}
                ${this._row(this._t("production.remaining"), formatGridEnergy(model.remainingKwh), "remaining", this._t("production.remaining_scope"))}
                ${this._row(this._t("production.projection"), today === null
                    ? this._t("unknown")
                    : formatGridEnergy(today + model.remainingKwh), "projection", this._t("production.projection_scope"))}
            ` : this._forecastFailed ? this._renderForecastFailed() : html`<p class="note">${this._forecastMissing()}</p>`}
            ${this._row(this._t("production.peak"), this._peakText(overview), "peak")}
            ${this._section?.status === "error" ? html`<button class="link-button" @click=${() => this._loadSection()}>${this._t("retry")}</button>` : nothing}
            <p class="note">${this._t("production.explain")}</p>
            <div class="plan" data-forecast-inspector>${this._inspector("production", SOLAR_FORECAST_INSPECTOR_CONFIG)}</div>
        `;
    }

    /** This slot's production against its forecast, both as power: like with like. */
    private _slotText(model: ForecastModel): string {
        const power = this._powerNow();
        if (power === null) return this._t("unavailable");
        const now = formatPower(Math.max(0, power)).display;
        if (model.slotW === null || model.slotW <= 0) return fillTemplate(this._t("production.now_no_forecast"), { power: now });
        return fillTemplate(this._t("production.now_value"), {
            power: now,
            share: this._share(Math.max(0, power) / model.slotW),
            forecast: formatPower(model.slotW).display,
        });
    }

    private _peakText(overview: SolarDetailPayload): string {
        if (!overview.sections.includes("production")) return this._t("production.peak_no_sensor");
        const section = this._section;
        if (section === null || section.status === "loading") return this._t("loading_history");
        if (section.status === "error") return this._t("history_failed");
        const power = this._ready<SolarProductionSectionPayload>("production")?.power;
        if (power === undefined) return this._t("loading_history");
        if (power === null) return this._t("production.peak_unit");
        if (power.max === null || power.maxAt === null || power.max <= 0) return this._t("production.peak_none");
        return fillTemplate(this._t("production.peak_value"), { power: formatPower(power.max).display, time: this._time(Date.parse(power.maxAt)) });
    }

    private _renderProductionEvidence(overview: SolarDetailPayload, model: ForecastModel | null) {
        const comparison = model?.comparison;
        const bias = this._forecast?.solar.biasCorrection;
        const power = this._ready<SolarProductionSectionPayload>("production")?.power;
        return html`
            ${comparison?.rawKwh != null ? html`
                ${this._row(this._t("production.raw"), formatGridEnergy(comparison.rawKwh), "raw")}
                ${comparison.rawKwh > 0 ? this._row(this._t("production.correction"), "× " + (comparison.forecastKwh / comparison.rawKwh).toFixed(2), "correction") : nothing}
            ` : nothing}
            ${bias ? html`
                ${this._row(this._t("production.bias_status"), this._t(bias.effectiveVariant === "adjusted" ? "production.bias_applied" : "production.bias_not_applied"), "bias-status")}
                ${this._row(this._t("production.bias_days"), String(bias.explainability.usableDays), "bias-days")}
                ${bias.explainability.trainedAt ? this._row(this._t("production.bias_trained"), this._dateTime(Date.parse(bias.explainability.trainedAt)), "bias-trained") : nothing}
            ` : nothing}
            ${power ? this._row(this._t("production.peak_source"), fillTemplate(this._t(power.extrema === "recorded" ? "production.peak_recorded" : "production.peak_bucket"), {
                coverage: this._share(power.coverage),
            }), "peak-source") : nothing}
            <p class="note">${this._t("production.evidence_note")}</p>
            ${overview.entities.power ? this._row(this._t("production.power_sensor"), this._name(overview.entities.power), "power-sensor") : nothing}
            <div class="plan" data-bias-inspector>${this._inspector("production-bias", SOLAR_BIAS_INSPECTOR_CONFIG)}</div>
        `;
    }

    // Destinations ------------------------------------------------------------

    private _destinationsPreview(overview: SolarDetailPayload): string | null {
        const destinations = this._ready<SolarDestinationsSectionPayload>("destinations")?.destinations;
        if (destinations) {
            if (destinations.producedKwh <= 0) return this._t("destinations.none_today");
            return fillTemplate(this._t("destinations.short"), {
                house: formatGridEnergy(destinations.houseKwh),
                battery: formatGridEnergy(destinations.batteryKwh),
                export: formatGridEnergy(destinations.exportKwh),
            });
        }
        // Before the answer opens: today's production from the solar meter.
        const today = readEnergyKWh(this.hass, overview.entities.today_energy);
        return today === null ? null : fillTemplate(this._t("destinations.produced_short"), { kwh: formatGridEnergy(today) });
    }

    private _renderDestinations() {
        const section = this._section;
        if (section === null || section.status === "loading") {
            return html`<p class="note" data-destinations-loading>${this._t("destinations.loading")}</p>`;
        }
        if (section.status === "error") {
            return html`
                <p class="note">${this._t("destinations.failed")}</p>
                <button class="link-button" @click=${() => this._loadSection()}>${this._t("retry")}</button>
            `;
        }
        const payload = this._ready<SolarDestinationsSectionPayload>("destinations");
        if (!payload) return html`<p class="note">${this._t("destinations.loading")}</p>`;
        const period = this._row(this._t("destinations.period_label"), this._periodText(Date.parse(payload.period.start), Date.parse(payload.asOf)), "period");
        const destinations = payload.destinations;
        if (!destinations) {
            const reason = ["no_house_node", "no_house_meter", "no_solar_meter"].includes(payload.unavailable ?? "")
                ? `destinations.unavailable_${payload.unavailable}`
                : "destinations.unavailable_not_loaded";
            return html`${period}<p class="note" data-destinations-unavailable>${this._t(reason)}</p>`;
        }
        if (destinations.producedKwh <= 0) {
            return html`${period}<p class="note" data-no-production>${this._t("destinations.none_long")}</p>`;
        }
        const produced = destinations.producedKwh;
        const parts: Array<[string, number, string]> = [
            ["house", destinations.houseKwh, HOUSE_COLOR],
            ["battery", destinations.batteryKwh, BATT_COLOR],
            ["export", destinations.exportKwh, GRID_EXPORT_COLOR],
            ["unresolved", destinations.unresolvedKwh, NEUTRAL_LIGHT_COLOR],
        ];
        const share = (kwh: number) => fillTemplate(this._t("destinations.share"), { kwh: formatGridEnergy(kwh), share: this._share(kwh / produced) });
        return html`
            ${period}
            ${this._row(this._t("destinations.produced"), formatGridEnergy(produced), "produced")}
            <div class="split" aria-hidden="true">
                ${parts.filter(([, kwh]) => kwh > 0).map(([key, kwh, color]) => html`<span data-split=${key} style="width: ${Math.min(100, kwh / produced * 100)}%; background: ${color}"></span>`)}
            </div>
            ${parts.map(([key, kwh, color]) => key === "unresolved" && kwh <= 0 ? nothing : html`
                <div class="row" data-row=${key}>
                    <span class="label"><span class="swatch" style="background: ${color}"></span>${this._t(`destinations.${key}`)}${key === "export" ? html`<br><span class="note">${this._t("destinations.export_scope")}</span>` : nothing}</span>
                    <span class="value">${share(kwh)}</span>
                </div>
            `)}
            <p class="note">${this._t("destinations.explain")}</p>
        `;
    }

    private _renderDestinationsEvidence(overview: SolarDetailPayload) {
        const payload = this._ready<SolarDestinationsSectionPayload>("destinations");
        const destinations = payload?.destinations;
        const meterToday = readEnergyKWh(this.hass, overview.entities.today_energy);
        const exportToday = readEnergyKWh(this.hass, overview.entities.today_export);
        const charge = payload?.charge;
        return html`
            ${destinations ? html`
                <div class="section-title">${this._t("destinations.coverage")}</div>
                ${this._row(this._t("destinations.attributed"), destinations.producedKwh > 0
                    ? fillTemplate(this._t("destinations.attributed_value"), {
                        share: this._share(destinations.attributedKwh / destinations.producedKwh),
                        kwh: formatGridEnergy(destinations.attributedKwh),
                    })
                    : this._t("unknown"), "attributed")}
                ${destinations.unattributedKwh > 0 ? this._row(this._t("destinations.unattributed"), formatGridEnergy(destinations.unattributedKwh), "unattributed") : nothing}
                ${this._row(this._t("destinations.measured_export"), formatGridEnergy(destinations.measuredExportKwh), "measured-export")}
                ${destinations.otherExportKwh > 0 ? this._row(this._t("destinations.other_export"), formatGridEnergy(destinations.otherExportKwh), "other-export", this._t("destinations.other_export_scope")) : nothing}
                ${!payload!.complete ? html`<p class="note" data-incomplete>${this._t("destinations.incomplete")}</p>` : nothing}
                <div class="section-title">${this._t("destinations.reconcile")}</div>
                ${this._row(this._t("destinations.meter_today"), meterToday === null ? this._t("unavailable") : formatGridEnergy(meterToday), "meter-today")}
                ${this._row(this._t("destinations.export_today"), exportToday === null ? this._t("unavailable") : formatGridEnergy(exportToday), "export-today")}
                <p class="note">${this._t("destinations.reconcile_note")}</p>
            ` : nothing}
            <div class="section-title">${this._t("destinations.dc_split")}</div>
            ${this._dcSplit()}
            ${charge && charge.solarKwh > 0 ? html`
                <div class="section-title">${this._t("destinations.value")}</div>
                ${this._row(this._t("destinations.forgone"), charge.forgoneValue === null
                    ? this._t("unknown")
                    : this._formatMoney(charge.forgoneValue, currencyFromPriceUnit(payload!.currency)), "forgone", this._t("destinations.forgone_scope"))}
                ${charge.forgoneRate !== null ? this._row(this._t("destinations.forgone_rate"), formatPriceValue(charge.forgoneRate, payload!.currency), "forgone-rate") : nothing}
                ${charge.solarUnpricedKwh > 0 ? this._row(this._t("destinations.solar_unpriced"), formatGridEnergy(charge.solarUnpricedKwh), "solar-unpriced") : nothing}
            ` : nothing}
            <p class="note">${this._t("destinations.value_note")}</p>
        `;
    }

    /**
     * Where the PV input goes now: into the battery while it charges, the rest
     * through the inverter's AC side. Both are the card's live figures; the
     * AC side is the remainder, so it includes the conversion loss. While the
     * grid imports as the battery charges, the grid may be charging it too, and
     * live figures cannot tell how much of the charge is PV: the split is not
     * given then.
     */
    private _dcSplit() {
        const pv = this._powerNow();
        const battery = this.params.batteryPower;
        const grid = this.params.gridPower;
        if (pv === null) return html`<p class="note">${this._t("destinations.dc_unavailable")}</p>`;
        const input = Math.max(0, pv);
        const charges = battery !== null && battery > IDLE_W;
        if (charges && (grid === null || grid > IDLE_W)) {
            return html`
                ${this._row(this._t("destinations.dc_input"), formatPower(input).display, "dc-input")}
                ${this._row(this._t("destinations.dc_battery"), this._t("destinations.dc_mixed"), "dc-battery")}
            `;
        }
        const charging = charges ? Math.min(battery!, input) : battery === null ? null : 0;
        return html`
            ${this._row(this._t("destinations.dc_input"), formatPower(input).display, "dc-input")}
            ${this._row(this._t("destinations.dc_battery"), charging === null ? this._t("unavailable") : formatPower(charging).display, "dc-battery")}
            ${charging !== null ? this._row(this._t("destinations.dc_ac"), formatPower(Math.max(0, input - charging)).display, "dc-ac", this._t("destinations.dc_ac_scope")) : nothing}
        `;
    }

    // Limits ------------------------------------------------------------------

    /** The inverter's AC rating, W; `null` without a valid reading. */
    private _ratedW(overview: SolarDetailPayload): number | null {
        const watts = this._watts(overview, "rated_power");
        return watts !== null && watts > 0 ? watts : null;
    }

    private _limitsPreview(overview: SolarDetailPayload): string {
        const parts: string[] = [];
        const exportLimit = this._watts(overview, "export_limit");
        if (exportLimit !== null) parts.push(fillTemplate(this._t("limits.export_short"), { power: formatPower(exportLimit).display }));
        const pvLimit = this._watts(overview, "pv_power_limit");
        if (pvLimit !== null) parts.push(fillTemplate(this._t("limits.pv_short"), { power: formatPower(pvLimit).display }));
        const rated = this._ratedW(overview);
        if (rated !== null) parts.push(fillTemplate(this._t("limits.rating_short"), { power: formatPower(rated).display }));
        if (!parts.length && overview.maxAllowedExportPower !== null) {
            parts.push(fillTemplate(this._t("limits.export_short"), { power: formatPower(overview.maxAllowedExportPower).display }));
        }
        return parts.length ? parts.join(" · ") : this._t("limits.none");
    }

    private _renderLimits(overview: SolarDetailPayload) {
        const rated = this._ratedW(overview);
        const power = this._powerNow();
        const input = power === null ? null : Math.max(0, power);
        const exportLimit = this._watts(overview, "export_limit");
        const pvLimit = this._watts(overview, "pv_power_limit");
        const run = this._currentRun();
        const inputText = input === null
            ? this._t("unavailable")
            : rated === null
            ? formatPower(input).display
            : fillTemplate(this._t("limits.input_of_rating"), { power: formatPower(input).display, share: this._share(input / rated) });
        return html`
            ${this._row(this._t("limits.input"), inputText, "input")}
            ${rated !== null ? this._row(this._t("limits.rating"), formatPower(rated).display, "rating", this._t("limits.scope_rating")) : nothing}
            ${input !== null && rated !== null && input > rated ? html`
                <p class="note" data-above-rating>${this._t("limits.above_rating")}</p>
            ` : nothing}
            ${pvLimit !== null ? this._row(this._t("limits.pv_limit"), formatPower(pvLimit).display, "pv-limit", this._t("limits.scope_remote")) : nothing}
            ${exportLimit !== null ? this._row(this._t("limits.export_limit"), formatPower(exportLimit).display, "export-limit", this._t("limits.scope_inverter")) : nothing}
            ${overview.maxAllowedExportPower !== null ? this._row(this._t("limits.export_cap"), formatPower(overview.maxAllowedExportPower).display, "export-cap", this._t("limits.scope_helman")) : nothing}
            ${exportLimit === 0 ? html`<p class="note" data-export-zero>${this._t("limits.export_zero")}</p>` : nothing}
            ${this._row(this._t("limits.intent"), run
                ? this._actionLabel(run.action) + (run.action.conditionMet === false ? " – " + this._t("limits.candidate") : "")
                : this._t("limits.nothing_scheduled"), "intent", this._t("limits.scope_plan"))}
            <p class="note">${this._t(overview.profile ? "limits.explain" : "limits.explain_custom")}</p>
        `;
    }

    private _renderLimitsEvidence(overview: SolarDetailPayload) {
        const runtime = this._currentRuntime();
        const battery = this.params.batteryPower;
        const settings = [
            this._optionalRow(overview, "use_mode", "limits.use_mode"),
            this._optionalRow(overview, "manual_mode", "limits.manual_mode"),
            this._optionalRow(overview, "run_mode", "limits.run_mode"),
            ...overview.strings.map((string) => {
                const value = this._reading(overview, `shade_fix_pv${string}`);
                return value === null ? nothing : this._row(fillTemplate(this._t("limits.shade_fix"), { n: String(string) }), value, `shade_fix_pv${string}`);
            }),
            this._optionalRow(overview, "mppt_count", "limits.mppt_count"),
            this._optionalRow(overview, "rated_power", "limits.rated_power"),
            this._optionalRow(overview, "pv_power_limit", "limits.pv_power_limit"),
        ];
        return html`
            <div class="section-title">${this._t("limits.settings")}</div>
            ${settings.every((row) => row === nothing) ? html`<p class="note">${this._t("limits.no_settings")}</p>` : settings}
            <div class="section-title">${this._t("limits.flows")}</div>
            ${this._row(this._t("limits.input"), this._powerNow() === null ? this._t("unavailable") : formatPower(Math.max(0, this._powerNow()!)).display, "flow-input")}
            ${this._row(this._t("limits.battery"), battery === null
                ? this._t("unavailable")
                : Math.abs(battery) <= IDLE_W
                ? fillTemplate(this._t("limits.battery_idle"), { power: formatPower(Math.abs(battery)).display })
                : fillTemplate(this._t(battery > 0 ? "limits.battery_charging" : "limits.battery_discharging"), { power: formatPower(Math.abs(battery)).display }), "flow-battery")}
            ${renderCurrentSlot(this._currentRun(), runtime, this.localize, (label, value) => this._row(label, value))}
            ${this._row(this._t("limits.executor"), runtime ? runtimeText(runtime, this.localize) : this._t("limits.no_runtime"), "executor")}
            <p class="note">${this._t("limits.evidence_note")}</p>
        `;
    }

    // Strings -----------------------------------------------------------------

    private _stringsPreview(overview: SolarDetailPayload): string {
        const parts = overview.strings.flatMap((string) => {
            const watts = this._watts(overview, `pv_power_${string}`);
            return watts === null ? [] : [fillTemplate(this._t("strings.now_short"), { n: String(string), power: formatPower(Math.max(0, watts)).display })];
        });
        return parts.length ? parts.join(" · ") : this._t("strings.unavailable");
    }

    private _renderStrings(overview: SolarDetailPayload) {
        const live = overview.strings.map((string) => ({ string, watts: this._watts(overview, `pv_power_${string}`) }));
        const total = live.reduce((sum, { watts }) => sum + Math.max(0, watts ?? 0), 0);
        const allKnown = live.every(({ watts }) => watts !== null);
        return html`
            <div class="section-title">${this._t("strings.now")}</div>
            ${live.map(({ string, watts }) => html`
                <div class="row" data-row=${`now-${string}`}>
                    <span class="label"><span class="swatch" style="background: ${STRING_COLORS[String(string)] ?? NEUTRAL_LIGHT_COLOR}"></span>${fillTemplate(this._t("strings.string"), { n: String(string) })}</span>
                    <span class="value">${watts === null
                        ? this._t("unavailable")
                        : allKnown && total > IDLE_W
                        ? fillTemplate(this._t("strings.now_value"), { power: formatPower(Math.max(0, watts)).display, share: this._share(Math.max(0, watts) / total) })
                        : formatPower(Math.max(0, watts)).display}</span>
                </div>
            `)}
            <div class="section-title">${this._t("strings.today")}</div>
            ${this._renderStringsToday()}
            <p class="note">${this._t("strings.explain")}</p>
        `;
    }

    private _renderStringsToday() {
        const section = this._section;
        if (section === null || section.status === "loading") {
            return html`<p class="note" data-strings-loading>${this._t("loading_history")}</p>`;
        }
        if (section.status === "error") {
            return html`
                <p class="note">${this._t("history_failed")}</p>
                <button class="link-button" @click=${() => this._loadSection()}>${this._t("retry")}</button>
            `;
        }
        const payload = this._ready<SolarStringsSectionPayload>("strings");
        if (!payload) return html`<p class="note">${this._t("loading_history")}</p>`;
        const common = payload.energy.common;
        const kwh = common.kwh;
        const sum = kwh ? Object.values(kwh).reduce((total, value) => total + value, 0) : 0;
        const chart = this._stringsChartFor(payload);
        return html`
            ${kwh && sum > 0 ? html`
                ${common.strings.map((string) => this._row(
                    fillTemplate(this._t("strings.string"), { n: String(string) }),
                    fillTemplate(this._t("strings.share_value"), { kwh: formatGridEnergy(kwh[String(string)]), share: this._share(kwh[String(string)] / sum) }),
                    `share-${string}`,
                ))}
                ${this._row(this._t("strings.common"), fillTemplate(this._t("strings.common_value"), { coverage: this._share(common.coverage) }), "common")}
            ` : html`<p class="note" data-no-common>${this._t("strings.no_common")}</p>`}
            ${chart.series.length ? html`
                <helman-day-line-chart
                    data-strings-chart
                    .series=${chart.series}
                    .start=${Date.parse(payload.period.start)}
                    .end=${Date.parse(payload.period.end)}
                    .bucketMs=${300_000}
                    .timeZone=${this._timeZone}
                    .locale=${this._locale}
                    .formatValue=${this._formatWatts}
                    .summary=${this._t("strings.chart_summary")}
                ></helman-day-line-chart>
            ` : nothing}
        `;
    }

    /** The chart's inputs, kept while the payload is the same one. */
    private _stringsChartFor(payload: SolarStringsSectionPayload): { series: DayLineSeries[] } {
        if (this._stringsChart?.payload !== payload) {
            const series = Object.entries(payload.strings).flatMap(([string, entry]) => {
                const points = entry?.day?.points ?? [];
                return points.length ? [{
                    key: "pv" + string,
                    label: fillTemplate(this._t("strings.string"), { n: string }),
                    color: STRING_COLORS[string] ?? NEUTRAL_LIGHT_COLOR,
                    points: points.map((point) => ({ t: Date.parse(point.start), v: point.mean, min: point.min, max: point.max })),
                }] : [];
            });
            this._stringsChart = { payload, series };
        }
        return this._stringsChart;
    }

    private _renderStringsEvidence(overview: SolarDetailPayload) {
        const payload = this._ready<SolarStringsSectionPayload>("strings");
        const dash = "–";
        return html`
            <table data-string-table>
                <thead><tr>
                    <th>${this._t("strings.string_column")}</th><th>W</th><th>V</th><th>A</th>
                </tr></thead>
                <tbody>
                    ${overview.strings.map((string) => html`
                        <tr data-string=${string}>
                            <td>${string}</td>
                            <td>${this._reading(overview, `pv_power_${string}`) ?? dash}</td>
                            <td>${this._reading(overview, `pv_voltage_${string}`) ?? dash}</td>
                            <td>${this._reading(overview, `pv_current_${string}`) ?? dash}</td>
                        </tr>
                    `)}
                </tbody>
            </table>
            ${payload ? html`
                <div class="section-title">${this._t("strings.coverage")}</div>
                ${Object.entries(payload.strings).map(([string, entry]) => {
                    const energy = payload.energy.strings[string];
                    if (!entry) return nothing;
                    const value = entry.day === null
                        ? fillTemplate(this._t("strings.unit_unknown"), { unit: entry.unit ?? "?" })
                        : fillTemplate(this._t("strings.coverage_value"), {
                            kwh: energy?.kwh == null ? "?" : formatGridEnergy(energy.kwh),
                            coverage: this._share(energy?.coverage ?? 0),
                        });
                    return this._row(fillTemplate(this._t("strings.string"), { n: string }), value, `coverage-${string}`);
                })}
            ` : nothing}
            <p class="note">${this._t("strings.calculation")}</p>
            <p class="note" data-normalization>${this._t("strings.no_normalization")}</p>
        `;
    }

    // Outlook -----------------------------------------------------------------

    private _outlookPreview(model: ForecastModel | null): string | null {
        if (!model) return this._forecastFailed ? this.localize("node_detail.forecast_failed") : this._forecastMissing();
        const tomorrow = model.days[1];
        return tomorrow?.kwh != null
            ? fillTemplate(this._t("outlook.tomorrow_short"), { kwh: formatGridEnergy(tomorrow.kwh) })
            : this._t("outlook.no_tomorrow");
    }

    private _renderOutlook(overview: SolarDetailPayload, model: ForecastModel | null) {
        const lifetime = readEnergyKWh(this.hass, overview.entities.lifetime_energy);
        return html`
            ${model ? html`
                <div class="days" data-outlook>
                    ${model.days.map((day, index) => html`
                        <div class="day" data-day=${day.key}>
                            <span class="day-label">${index === 0 ? this._t("outlook.today") : this._dayLabel(day.key, day.firstMs)}</span>
                            <span class="day-value">${day.kwh === null ? this._t("outlook.no_forecast") : formatGridEnergy(day.kwh)}</span>
                        </div>
                    `)}
                </div>
                <p class="note">${this._t(model.corrected ? "outlook.explain" : "outlook.explain_raw")}</p>
            ` : this._forecastFailed ? this._renderForecastFailed() : html`<p class="note">${this._forecastMissing()}</p>`}
            ${lifetime !== null ? this._row(this._t("outlook.lifetime"), formatGridEnergy(lifetime), "lifetime", this._t("outlook.lifetime_scope")) : nothing}
        `;
    }

    private _renderOutlookEvidence(overview: SolarDetailPayload) {
        const lifetime = readEnergyKWh(this.hass, overview.entities.lifetime_energy);
        const kwp = overview.configuredMaxPowerW === null ? null : overview.configuredMaxPowerW / 1000;
        const bias = this._forecast?.solar.biasCorrection;
        const days = this._model()?.days.filter((day) => day.kwh !== null).length ?? 0;
        return html`
            ${this._row(this._t("outlook.capacity"), kwp === null ? this._t("outlook.capacity_none") : fillTemplate(this._t("outlook.kwp"), { kwp: kwp.toFixed(1) }), "capacity", this._t("outlook.capacity_scope"))}
            ${lifetime !== null && kwp !== null ? html`
                ${this._row(this._t("outlook.per_kwp"), fillTemplate(this._t("outlook.per_kwp_value"), {
                    value: Math.round(lifetime / kwp).toString(),
                    lifetime: formatGridEnergy(lifetime),
                    kwp: kwp.toFixed(1),
                }), "per-kwp")}
                <p class="note" data-per-kwp-note>${this._t("outlook.per_kwp_note")}</p>
            ` : nothing}
            ${this._row(this._t("outlook.horizon"), fillTemplate(this._t("outlook.horizon_value"), { days: String(days) }), "horizon")}
            ${bias ? this._row(this._t("outlook.training"), fillTemplate(this._t("outlook.training_value"), { days: String(bias.explainability.usableDays) }), "training") : nothing}
            <p class="note">${this._t("outlook.evidence_note")}</p>
        `;
    }

    // ── The forecast ────────────────────────────────────────────────────────

    /** The forecast model for the slot in progress, rebuilt only when either changes. */
    private _model(): ForecastModel | null {
        const solar = this._forecast?.solar;
        const now = Date.now();
        const slot = Math.floor(now / SLOT_MS);
        const cache = this._modelCache;
        if (cache && cache.forecast === solar && cache.slot === slot) return cache.model;
        const model = solar && solar.status !== "not_configured" ? this._buildModel(now) : null;
        this._modelCache = { forecast: solar, slot, model };
        return model;
    }

    private _buildModel(now: number): ForecastModel {
        const solar = this._forecast!.solar;
        const timeZone = this._timeZone;
        const toSlots = (points: Array<{ timestamp: string; value: number }>): Slot[] =>
            points.map((point) => ({ start: Date.parse(point.timestamp), wh: point.value })).filter((slot) => Number.isFinite(slot.start) && Number.isFinite(slot.wh));
        const effective = toSlots(getEffectiveSolarForecastPoints(solar));
        const corrected = !!solar.adjustedPoints;
        const raw = corrected ? new Map(toSlots(solar.points).map((slot) => [slot.start, slot.wh])) : null;
        const today = dayKey(now, timeZone);
        const isToday = (ms: number) => dayKey(ms, timeZone) === today;

        // Only the elapsed slots with a measured value, against the forecast for
        // exactly those slots: the in-progress slot and a gap are left out of both.
        const forecastAt = new Map(effective.map((slot) => [slot.start, slot.wh]));
        let comparison: ForecastModel["comparison"] = null;
        for (const actual of toSlots(solar.actualHistory)) {
            const forecast = forecastAt.get(actual.start);
            if (forecast === undefined || !isToday(actual.start) || actual.start + SLOT_MS > now) continue;
            const rawWh = raw?.get(actual.start);
            if (comparison === null) {
                comparison = { startMs: actual.start, endMs: actual.start + SLOT_MS, actualKwh: 0, forecastKwh: 0, rawKwh: raw ? 0 : null };
            }
            comparison.startMs = Math.min(comparison.startMs, actual.start);
            comparison.endMs = Math.max(comparison.endMs, actual.start + SLOT_MS);
            comparison.actualKwh += Math.max(0, actual.wh) / 1000;
            comparison.forecastKwh += Math.max(0, forecast) / 1000;
            if (comparison.rawKwh !== null) comparison.rawKwh = rawWh === undefined ? null : comparison.rawKwh + Math.max(0, rawWh) / 1000;
        }

        let remainingKwh = 0;
        let slotW: number | null = null;
        let startsAt: number | null = null;
        let endsAt: number | null = null;
        const boundaries: number[] = [];
        let producingBefore = false;
        const byDay = new Map<string, { firstMs: number; kwh: number }>();
        for (const slot of effective) {
            const key = dayKey(slot.start, timeZone);
            if (key === null) continue;
            const day = byDay.get(key) ?? { firstMs: slot.start, kwh: 0 };
            day.kwh += Math.max(0, slot.wh) / 1000;
            byDay.set(key, day);
            if (key !== today) continue;
            const end = slot.start + SLOT_MS;
            const producing = slot.wh / (SLOT_MS / 3_600_000) > IDLE_W;
            if (end > now) {
                boundaries.push(end);
                remainingKwh += Math.max(0, slot.wh) / 1000 * Math.min(1, (end - Math.max(slot.start, now)) / SLOT_MS);
                if (slot.start <= now) slotW = Math.max(0, slot.wh) / (SLOT_MS / 3_600_000);
                // The first slot ahead where forecast production starts, or stops.
                if (slot.start > now && producing && !producingBefore && startsAt === null) startsAt = slot.start;
                if (slot.start >= now && !producing && producingBefore && endsAt === null) endsAt = slot.start;
            }
            producingBefore = producing;
        }
        // Production that runs to the last slot of the day ends there.
        if (endsAt === null && producingBefore && boundaries.length) endsAt = boundaries[boundaries.length - 1];

        const days: ForecastModel["days"] = [];
        for (let offset = 0; today !== null && offset < OUTLOOK_DAYS; offset += 1) {
            const key = addDaysToDayKey(today, offset);
            const day = byDay.get(key);
            days.push({ key, firstMs: day?.firstMs ?? null, kwh: day ? day.kwh : null });
        }
        return { comparison, remainingKwh, slotW, startsAt, endsAt, days, corrected, boundaries };
    }

    /** Why there is no forecast model: still loading, or not configured. */
    private _forecastMissing(): string {
        if (this._forecast === null) return this._t("forecast_loading");
        return this._t("forecast_not_configured");
    }

    // ── Schedule ────────────────────────────────────────────────────────────

    private _runs(): ScheduleRun[] {
        return scheduleRuns(this._schedule, Date.now());
    }

    private _currentRun(): ScheduleRun | null {
        return currentRun(this._runs(), Date.now());
    }

    private _currentRuntime() {
        return currentRuntime(this._schedule, Date.now());
    }

    // ── Readings and formatting ─────────────────────────────────────────────

    /** A power reading in W, `null` when missing, not numeric or in another unit. */
    /**
     * The card's live solar reading in W. The card passes the sensor's value
     * as read, so the sensor's unit converts it; a unit-less sensor is W, as on
     * the card, and an unknown unit is no reading.
     */
    private _powerNow(): number | null {
        const power = this.params.power;
        if (power === null) return null;
        const entityId = this._overview.status === "ready" ? this._overview.payload.entities.power : null;
        const unit = entityId ? this.hass.states[entityId]?.attributes.unit_of_measurement as string | undefined : undefined;
        const factor = unit ? WATTS[unit] : 1;
        return factor === undefined ? null : power * factor;
    }

    private _watts(overview: SolarDetailPayload, key: string): number | null {
        return this._scaled(overview, key, WATTS);
    }

    private _periodText(startMs: number, endMs: number): string {
        return fillTemplate(this._t("period"), { start: this._time(startMs), end: this._time(endMs) });
    }

    private _dayLabel(key: string, firstMs: number | null): string {
        // A day's first slot is inside it in HA's time zone; the key alone is not.
        const at = firstMs ?? Date.parse(`${key}T12:00:00Z`);
        return new Intl.DateTimeFormat(this._locale, { weekday: "short", day: "numeric", month: "numeric", timeZone: this._timeZone }).format(at);
    }

    private _dateTime(ms: number): string {
        return new Intl.DateTimeFormat(this._locale, { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: this._timeZone }).format(ms);
    }

    private _signedKwh(kwh: number): string {
        return (kwh < 0 ? "−" : "+") + formatGridEnergy(kwh);
    }

    private _share(share: number): string {
        return Math.round(share * 100) + " %";
    }

    private readonly _formatWatts = (value: number): string => formatPower(Math.max(0, value)).display;
}

declare global {
    interface HTMLElementTagNameMap {
        "node-detail-solar-content": NodeDetailSolarContent;
    }
}
