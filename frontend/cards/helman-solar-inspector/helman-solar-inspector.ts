import { LatestRequest } from "../shared/data/latest-request";
import { callHelman } from "../shared/data/helman-commands";
import { formatClock, pad2 } from "../shared/time/slot-time";
import { LitElement, css, html, unsafeCSS, type PropertyValues } from "lit";
import { property, query, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import type { SocBar } from "./chart-soc";
import { CHART_COLORS } from "./chart-colors";
import {
  HoverTooltipController,
  hoverTooltipStyles,
  type TooltipCell,
  type TooltipContent,
  type TooltipRow,
} from "../shared/hover-tooltip";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import { dispatchWatchedEntities } from "../shared/hass-change";
import { todayKey } from "../shared/time/day-key";
import "./helman-solar-schedule-band-strip";
import "../shared/schedule/dialogs/scheduling-day-editor-host";
import type {
  OpenScheduleEditorDetail,
  SchedulingDayEditorHost,
} from "../shared/schedule/dialogs/scheduling-day-editor-host";
import "./helman-solar-day-pills";
import type {
  DayPillHoverDetail,
  DayPillOpenDetail,
  DayPillSelectDetail,
} from "./helman-solar-day-pills";
import "./helman-solar-span-pills";
import type {
  SpanPillHoverDetail,
  SpanPillOpenDetail,
  SpanPillSelectDetail,
} from "./helman-solar-span-pills";
import "../shared/forecast-health-banner";
import { buildForecastHealthItems } from "../shared/forecast-health-banner";
import { fetchDayAggregates, type ForecastPayload } from "../helman-api";
import {
  buildHistoryDaysFromAggregates,
  resolveFirstWeekdayIndex,
  type SolarInspectorHistoryDay,
} from "./day-pill-model";
import "./helman-solar-day-chart";
import { chartGridTicks, type DayChartTooltipDetail } from "./helman-solar-day-chart";
import "./helman-solar-price-strip";
import "./helman-solar-money-strip";
import "./helman-solar-aggregate-chart";
import type {
  AggregateBucketOpenDetail,
  AggregateBucketSelectDetail,
  AggregateBucketHoverDetail,
  SpanAggregatePayload,
  SpanAggregateRow,
} from "./helman-solar-aggregate-chart";
import { currencyFromPriceUnit } from "./money-model";
import "../helman/tree-item-list";
import "../node-detail/node-detail-dialog";
import type { NodeDetailDialog } from "../node-detail/node-detail-dialog";
import type { NodeDetailParams } from "../node-detail/node-detail-types";
import { TreeItem } from "../shared/data/tree-item";
import type { ShowControllableDetailDetail } from "../shared/schedule/components/scheduling-entity-day-band";
import { getSharedHelmanStore } from "../shared/data/store";
import { hydrateDeviceTree } from "../shared/data/tree-item-hydrator";
import { readEnergyReadings, resolveEnergyNodes } from "../node-detail/node-detail-readings";
import { buildNodeDetailContext, buildNodeDetailParams } from "../node-detail/node-detail-params-builder";
import { deviceForControllable } from "../node-detail/node-control-rollup";
import { findTrainingSlot, resolveSelectedTrainingDate } from "./solar-inspector-model.js";
import { minutesToSlot, snapSlotToGrid } from "./slot-aggregation.js";
import {
  EMPTY_SLOT_SELECTION,
  applySlotSelection,
  reconcileSlotSelection,
  type SlotPickDetail,
  type SlotSelectionMode,
  type SlotSelectionState,
} from "./slot-selection.js";
import { helmanColorVars } from "../color-vars";
import { schedulingSharedStyles } from "../shared/schedule/styles/scheduling-shared-styles";
import { DataChangedController } from "../shared/data/data-changed";
import { startNowClock } from "../shared/now-clock";
import { getSharedScheduleOwner, type SharedScheduleOwner } from "../shared/schedule/schedule-owner";
import type { NormalizedScheduleModel, ScheduleOwnerSnapshot } from "../shared/schedule/schedule-types";
import { EMPTY_NORMALIZED_SCHEDULE } from "../shared/schedule/model/schedule-normalizer";
import { ForecastLoader } from "../shared/data/forecast-loader";
import { resolveLocale } from "../shared/resolve-locale";
import type { ScheduleHoverTooltipContent } from "./helman-solar-schedule-band-strip";
import { EMPTY_SELECTED_MINUTES, type ScheduleStripGeometry } from "./strip-geometry";
import { memoOne } from "../shared/memo-one";
import {
  EMPTY_DAY_COVERAGE,
  buildDayView,
  buildStacks,
  chartLayout,
  dayCoverage,
  dayHasSeries,
  isSeriesEnabled,
  isSeriesVisible,
  payloadGranularity,
  selectedMinutes,
  socBars,
  stripGeometry,
  type ChartLayout,
  type ChartStacks,
  type DayCoverage,
  type DayView,
  type InspectorPayload,
  type SeriesKey,
} from "./inspector-day-model";
import {
  monthBounds,
  parseOrToday as navigationParseOrToday,
  pillWindow as navigationPillWindow,
  spanBounds,
  viewStopGroups,
  type InspectorViewMode,
  type NavigationRange,
} from "./inspector-navigation";
import { formatWh } from "./inspector-format";
import { chartFrameStyles, panelStyles } from "./inspector-styles";
import type { PanelContext } from "./panels/metrics";
import { renderSelectedSlotDetails } from "./panels/selection";
import { renderTotals } from "./panels/totals";
import { formatSocRange, formatSpanMoney, renderSelectedBucket, renderSpanTotals, spanMoney } from "./panels/span";

/** Slot widths the header toggle and card config offer, in minutes. */
const SLOT_SIZE_OPTIONS = [15, 30, 60] as const;

/** Below this page width the chart opens at the coarser default. */
const NARROW_VIEWPORT_PX = 768;

/**
 * The slot width to open at when the card configures no explicit default: a
 * phone-width page opens at 60 minutes, anything wider (laptop) at 30. 15 is
 * never auto-chosen — it stays a deliberate pick on the header toggle.
 */
function defaultSlotMinutesForViewport(): number {
  const width = typeof window !== "undefined" ? window.innerWidth : 0;
  return width > 0 && width < NARROW_VIEWPORT_PX ? 60 : 30;
}

const DEFAULT_HIDDEN_SERIES: readonly SeriesKey[] = ["raw"];

/**
 * One array for every "no measured days" answer.
 *
 * `historyDays` crosses into `helman-solar-day-pills`, where the model memo is
 * keyed on its identity. A fresh `[]` per assignment would make that memo
 * structurally unable to hit and reproject the whole forecast horizon on every
 * render, so the empty case is a single frozen value instead. Read-only at both
 * consumers (`day-pill-model.ts` iterates it, the pills only read `.length`).
 */
const EMPTY_HISTORY_DAYS: readonly SolarInspectorHistoryDay[] = Object.freeze([]);

/**
 * The empty chart selection, for a pill row whose pills are not the columns.
 *
 * Same reason as `EMPTY_HISTORY_DAYS`: `selectedBuckets` is a property Lit
 * compares by identity, and a fresh `[]` per render would re-render both pill
 * rows on every pointer move over the day chart -- where the answer is always
 * "no buckets", the columns being slots there rather than days.
 */
const EMPTY_BUCKET_KEYS: readonly string[] = Object.freeze([]);

/** The empty SoC model, for a day whose columns have not been derived yet. */
const EMPTY_SOC_BARS: readonly SocBar[] = Object.freeze([]);

const EMPTY_SCHEDULE_SNAPSHOT: ScheduleOwnerSnapshot = {
  schedule: null,
  loading: false,
  refreshing: false,
  writing: false,
  togglingExecution: false,
  error: null,
  updatedAt: null,
  stale: false,
};

/**
 * Floor for the content shell on a cold mount, where there is no stale
 * payload to hold the box open: the day chart's fixed 260px (`.chart-wrap svg`
 * in `helman-solar-day-chart`) plus the strips and totals a day view typically
 * draws below it.
 */
const INSPECTOR_CONTENT_MIN_HEIGHT = 520;

export class HelmanSolarInspector extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  /** Solar power (W) at or above which a slot counts as carrying sun energy. */
  @property({ attribute: false }) daylightThresholdW = 100;
  /** Whether the daylight-only view starts on; the header toggle overrides it. */
  @property({ attribute: false }) daylightOnlyDefault = true;
  /**
   * Slot width the chart opens at, in minutes; the header toggle overrides it.
   * When unset the width is chosen from the page width — a phone opens coarser
   * (60) than a laptop (30) — so this is only for pinning an explicit default.
   */
  @property({ attribute: false }) slotMinutesDefault?: number;
  /**
   * Whether the bias-correction diagnostics start visible: the uncorrected
   * ("raw") forecast overlay, the correction-impact strip below the chart, and
   * with them the fitted per-slot factor (the actual-over-forecast bias ratio)
   * and the training-contribution table in the slot detail. The chart legend and
   * the strip's own switch still hide them again at runtime, so this only seeds
   * the opening state.
   */
  @property({ attribute: false }) biasRatioDefault = false;
  /**
   * Whether a column short of readings is drawn dimmed. Unlike the properties
   * above this is not an opening state the card can move away from — there is
   * no runtime control for it — so it stays true unless a config turns it off.
   *
   * It governs the dimming alone. The daily total of an incomplete series keeps
   * its marker and the slot panel keeps its note either way: those qualify a
   * number rather than colour the chart, and a total quietly reading low is
   * worth knowing however the columns are drawn.
   */
  @property({ attribute: false }) dimIncompleteSlots = true;
  /**
   * The day-chart series this card is allowed to draw, or undefined for all of
   * them. Unlike `biasRatioDefault` this is not an opening state: a series left
   * out is not drawn, gets no legend tile and no metric tile, and there is no
   * runtime control that brings it back.
   */
  @property({ attribute: false }) chartSeries?: readonly SeriesKey[];
  /** Whether the scheduled-actions row is dropped entirely. */
  @property({ attribute: false }) hideScheduleStrip = false;
  /** Whether the import/export price rails are dropped entirely. */
  @property({ attribute: false }) hidePriceStrip = false;
  /** Whether the money rails and the money tiles are dropped entirely. */
  @property({ attribute: false }) hideMoneyStrip = false;
  /** Whether the "D" and "M" aggregate view stops are dropped entirely. */
  @property({ attribute: false }) hideAggregateViews = false;
  /**
   * Whether the card judges the house forecast: house day pills (actual vs
   * predicted) and the forecast-error tiles in the totals and slot detail.
   */
  @property({ attribute: false }) houseFocus = false;

  @state() private _selectedDate = "";
  /**
   * The clock behind the "now" line on every chart. Coarse on purpose: it is
   * advanced by a timer owned by `connectedCallback`, and each move of it
   * redraws the whole stack -- which is why `_tickNow` only moves it when
   * something on screen is reading it.
   */
  @state() private _nowMs = Date.now();
  /** The one day editor this card opens, however it was asked for. */
  @query("scheduling-day-editor-host")
  private _editorHostElement?: SchedulingDayEditorHost;
  @state() private _editorHost: SchedulingDayEditorHost | null = null;
  /**
   * The node detail dialog open over the card (e.g. from the composition panel
   * or a lane icon in the schedule strip).
   */
  @state() private _nodeDetail: NodeDetailParams | null = null;
  @state() private _payload: InspectorPayload | null = null;
  /**
   * The composition panels' group nodes, kept across renders so their
   * expanded state survives picking another slot. Not `@state`: the nodes are
   * mutated in place and re-handed to the same containers, and the render that
   * rebuilds their children is always driven by something else changing.
   */
  private readonly _breakdownGroups = new Map<string, TreeItem>();
  /**
   * How far navigation may travel, as each view's own payload last stated it.
   *
   * The two now agree: the day view used to stop shallower, because its actuals
   * could only come from raw states and the recorder purges those, but a day
   * past the purge horizon is drawn back from the same long-term statistics the
   * aggregate views read — coarser, never absent. Still one field per view
   * rather than one shared field, because each is assigned by its own load and a
   * shared one would go stale in whichever direction loaded last: arriving from
   * a month onto an already-loaded day skips the day's fetch entirely.
   *
   * Kept apart from the payload so the day pills stay put while the next day
   * loads — the payload is cleared for the duration, and a header that emptied
   * on every click would reflow the whole card under the pointer.
   *
   * Only the bounds. The day payload's `canGoPrevious`/`isToday` and friends
   * describe one particular day and are read from that payload where they are
   * needed.
   */
  @state() private _dayRange: NavigationRange | null = null;
  @state() private _spanRange: NavigationRange | null = null;
  /** Whole-day measurements for the past days the pill row is showing. */
  @state() private _historyDays: readonly SolarInspectorHistoryDay[] = EMPTY_HISTORY_DAYS;
  /**
   * The `start..end` those measurements were decided for.
   *
   * Every decided window stamps it, including a forward one that has no
   * measurements — re-entering the same window is then a genuine no-op. Only
   * "no connection yet" leaves it null, because that has decided nothing and
   * the fetch must still happen when `hass` arrives.
   */
  private readonly _historyRequest = new LatestRequest<string>();
  /**
   * Today, and the window the pill row is showing, derived once per update
   * cycle in `willUpdate`. `render()` reads them; it never computes them, and
   * never assigns to state.
   */
  private _todayKey = "";
  private _pillWindowStart = "";
  private _pillWindowEnd = "";
  /**
   * The span request in flight, keyed by what it asks for.
   *
   * Same discipline as `_loadDayAggregates`: a response that no longer matches
   * the key wins nothing, so a fast click through three months cannot let the
   * first answer land last.
   */
  private readonly _spanRequest = new LatestRequest<string>();
  @state() private _loading = false;
  @state() private _error = "";
  /**
   * The forecast the day pills draw their gauges from, and the health banner's
   * only view of how fresh it is. Read here, once the schedule has slots to
   * draw it against, rather than by the pills -- so it is current whichever
   * view is on screen, the ones that draw no pills included.
   */
  @state() private _forecast: ForecastPayload | null = null;
  private readonly _forecastLoader = new ForecastLoader();
  /**
   * The one slot selection every surface shares: the charts highlight each selected
   * slot, and the schedule-actions strip both renders it and bulk-edits it.
   */
  @state() private _slotSelection: SlotSelectionState = EMPTY_SLOT_SELECTION;
  @state() private _selectedTrainingDate: string | null = null;
  @state() private _trainingTableCollapsed = true;
  @state() private _impactStripVisible = false;
  @state() private _daylightOnly = true;
  @state() private _slotMinutes = 30;
  /**
   * Which width the toggle is on: the day view, or one of the two aggregate
   * ones. Its own state rather than a wider `_slotMinutes`, for the reason
   * `VIEW_STOP_GROUPS` in `inspector-navigation.ts` gives.
   */
  @state() private _viewMode: InspectorViewMode = "day";
  /**
   * Whether the picker is showing everything it has.
   *
   * One flag for all three views, because it means the same thing in each --
   * *show more of the picker* -- even though what "more" is differs. In the day
   * view the span rows are the extra, and the day row widens from a rolling
   * week to the whole selected month; in the aggregate views the span rows are
   * always up and the day row itself is the extra. Two flags would let those
   * disagree, and there is nothing for them to disagree about: the reader
   * either wants the whole picker or does not.
   */
  @state() private _navExpanded = false;
  @state() private _browsedMonth = "";
  @state() private _calendarAnchor = "";
  @state() private _calendarReveal = 0;
  private _calendarSelection = "";
  private _calendarWasOpen = false;
  /** The span the aggregate views draw, or null before the first load. */
  @state() private _span: SpanAggregatePayload | null = null;
  @state() private _spanLoading = false;
  @state() private _spanError = "";
  /**
   * The buckets picked in the aggregate views, as one selection.
   *
   * The same {@link SlotSelectionState} the day view keeps over its slots, over
   * bucket keys instead: `slot-selection.ts` only ever compares and orders
   * strings against an ordered universe, and a span's buckets are exactly that.
   * So a column at D or M selects with the modifiers a column at 15/30/60 does,
   * and there is one implementation of what a click means rather than two.
   */
  @state() private _bucketSelection: SlotSelectionState = EMPTY_SLOT_SELECTION;
  /**
   * The day under the pointer, wherever the pointer is.
   *
   * The card owns it rather than either element, because two elements are
   * drawing the same day: at D the chart's columns *are* the pill row's days,
   * and a highlight that each worked out for itself would be two answers to one
   * question -- pointing at a column could not light its pill, and the two
   * could disagree about which day is hot. So both report into this and both
   * are handed it back.
   *
   * A bucket key, whatever a bucket is in the view on screen: a day at D, a
   * month at M. The chart always wants it raw; each nav row is handed it only
   * where that row's pills are the same shape -- see `_correlatedRow`.
   */
  @state() private _hoveredBucketKey: string | null = null;
  @state() private _chartWidth = 720;
  @state() private _hiddenSeries: ReadonlySet<SeriesKey> = new Set(DEFAULT_HIDDEN_SERIES);
  @state() private _hoveredMinutes: number | null = null;
  /**
   * The floating popup that follows the cursor over a chart or strip, and the
   * frame the hovered minute lands in with it. Shown only once the pointer sits
   * over a bar/band's own rendered area, not just its slot's x-range, so a hover
   * over empty space above a short column shows nothing.
   */
  private readonly _tooltip = new HoverTooltipController(this);
  /**
   * The card's one subscription to the shared schedule owner: the execution
   * switch in the scheduled-actions header reads the snapshot, the day pills
   * the schedule normalized on the owner's clock, and a new schedule is what
   * re-reads the forecast. The band strip draws its day off the editor host.
   *
   * Not reactive: only the execution switch renders it, so an owner refresh
   * asks for an update only when what that switch shows moved -- see
   * `_applyScheduleSnapshot`.
   */
  private _scheduleSnapshot: ScheduleOwnerSnapshot = EMPTY_SCHEDULE_SNAPSHOT;
  @state() private _normalizedSchedule: NormalizedScheduleModel = EMPTY_NORMALIZED_SCHEDULE;
  /** The zone and locale `_normalizedSchedule` was built in: a change of either rebuilds it. */
  private _normalizedFor = "";
  /** Bumped per forecast load: only the latest one may write `_forecast`. */
  private _forecastRequest = 0;
  /** The day view the open popup describes: a new one hides it. */
  private _tooltipView: DayView | null = null;

  /** Whether the opening slot width has been seeded from config or page width. */
  private _slotMinutesInitialized = false;
  private _fallbackLocalize: LocalizeFunction = (key: string) => key;
  /**
   * The day view's derived model.
   *
   * Everything below the payload -- the re-bucketed view, the coverage marks,
   * the two stacks, the axis, the SoC columns, the strips' geometry and the
   * selection the strips band -- used to be built inside `render()`, so a
   * pointer report over the chart rebuilt the whole day at the rate a mouse
   * moves. It is built in `willUpdate` instead, each step a pure function of
   * `inspector-day-model.ts` remembered on exactly the arguments it reads: a
   * resize does not re-bucket the day, a legend toggle does not re-derive an
   * axis it cannot move, and a hover rebuilds nothing at all.
   *
   * Every argument is itself identity-stable -- see `../README.md`, "Card
   * rendering discipline".
   */
  private _view: DayView | null = null;
  private _stacks: ChartStacks | null = null;
  private _layout: ChartLayout | null = null;
  /** The x scale the three strips share, one object per layout. */
  private _stripGeometry: ScheduleStripGeometry | null = null;
  private _socBarsModel: readonly SocBar[] = EMPTY_SOC_BARS;
  private _selectedMinutesModel: readonly number[] = EMPTY_SELECTED_MINUTES;
  private readonly _viewOf = memoOne(buildDayView);
  private readonly _coverageOf = memoOne(dayCoverage);
  private readonly _stacksOf = memoOne(buildStacks);
  private readonly _layoutOf = memoOne(chartLayout);
  private readonly _stripGeometryOf = memoOne(stripGeometry);
  private readonly _socBarsOf = memoOne(socBars);
  private readonly _selectedMinutesOf = memoOne(selectedMinutes);
  /**
   * The day's coverage, as `dayCoverage` last returned it: the wider-bucket
   * starts the current view drew over a hole, per short series, with the
   * native width those counts were taken at, and the totals series short
   * anywhere in the day. The chart's scrim, the selected-slot panel's caveat
   * and the totals' marks read off this one computation rather than several
   * that could drift apart.
   */
  private _coverage: DayCoverage = EMPTY_DAY_COVERAGE;
  private readonly _dayRequest = new LatestRequest<string>();
  private _loadedConnection: unknown = null;
  private _stopNowClock?: () => void;
  /**
   * The day view's payload no longer matches the backend.
   *
   * Set when a change is announced while an aggregate view is up: the day is
   * not on screen, so re-reading it then would be a full day's series fetched
   * for nobody. Returning to the day view is what spends the request.
   */
  private _dayStale = false;
  private _chartResizeObserver: ResizeObserver | null = null;
  private _observedChartWrap: HTMLElement | null = null;
  private _scheduleOwner?: SharedScheduleOwner;
  private _unsubscribeScheduleOwner?: () => void;

  static styles = [helmanColorVars, schedulingSharedStyles, hoverTooltipStyles, chartFrameStyles, panelStyles, css`
    :host {
      display: block;
      width: 100%;
    }

    .body {
      display: grid;
      /* An auto track grows to its widest child, so one row that cannot get
         narrower — the day pills, on a phone — would widen the column and take
         every chart below it past the card's edge. Capping the track at the
         card's own width makes each row fit or scroll inside itself. */
      grid-template-columns: minmax(0, 1fr);
      gap: 12px;
      min-width: 0;
      width: 100%;
    }

    .nav {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }

    /* The day row keeps the first line to itself and the toolbar drops below
       it, rather than the other way round: picking a day is what the header is
       for, and the pills are the widest thing in it. The min-width is the point
       at which that happens — below it the pills scroll instead of shrinking
       the toolbar out of reach. */
    /* Sized from its content, so the wrap happens exactly when the days stop
       fitting beside the toolbar — the toolbar drops to a second line and gives
       the whole width back to the pills. Shrinking below that is still allowed
       (min-width: 0): a hard floor would push the card wider than its column
       and take every chart under it along. */
    .day-nav {
      display: flex;
      /* Stacked, because the picker can now show both rows at once: years and
         months over the days they hold, which is the order they are read in.
         Collapsed there is only ever one child and the direction is moot. */
      flex-direction: column;
      /* Only as wide as the days, never growing to fill the line: the controls
         belong against the last pill, where the hand already is, rather than
         out at the card's far edge. */
      flex: 0 1 auto;
      align-items: stretch;
      gap: 8px;
      min-width: 0;
    }

    /* Only as wide as the days it holds, so the toolbar stays against the last
       pill rather than drifting to the far edge. Shrinking is still allowed —
       the row scrolls inside itself. */
    .day-pills {
      flex: 0 1 auto;
      min-width: 0;
    }

    /* At the head of the toolbar, where the week buttons used to be: it is the
       control that reaches days the row is not showing, so it belongs against
       the last pill rather than out among the settings. */
    .nav-more {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* The one icon-button drawn from mdi rather than a glyph, so it needs the
       centering the text buttons get from their line box. Sized to sit level
       with the ☀ and ⟳ next to it. */
    .nav-more ha-icon {
      --mdc-icon-size: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* Takes the rest of the line, so what is inside it can split: the picker's
       own control stays against the days it opens, and the settings ride the
       far edge. On a line with no slack to give they simply sit together. */
    .nav-actions {
      display: flex;
      flex: 1 1 auto;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .icon-button.active {
      border-color: var(--primary-color, #2563eb);
      background: color-mix(in srgb, var(--primary-color, #2563eb) 18%, var(--card-background-color));
      color: var(--primary-color, #2563eb);
    }

    /* Everything from here on is a setting rather than a way through the days,
       so it goes to the opposite end of the header. */
    /* The outer frame is the toggle as one control; the gap inside it is what
       separates the three groups. Kept as one bordered box rather than three
       loose ones so the reader reads "one axis, three levels" rather than
       three unrelated controls that happen to sit together. */
    .slot-size-toggle {
      margin-inline-start: auto;
      display: inline-flex;
      align-items: stretch;
      gap: 4px;
      /* A stop is 32 and this padding adds 4, which is the 36 the toolbar's
         icon buttons stand at: grouping the stops must not make the toggle the
         tallest thing on the row. */
      padding: 2px;
      border: 1px solid var(--divider-color);
      border-radius: 8px;
    }

    /* One read of one subject: the day view's three widths, a month of days, a
       year of months. The border and the clip the outer box used to carry live
       here now, so the group is the thing that looks like a segmented control. */
    .stop-group {
      display: inline-flex;
      align-items: stretch;
      border: 1px solid var(--divider-color);
      border-radius: 5px;
      overflow: hidden;
    }

    .slot-size-button {
      min-width: 30px;
      min-height: 32px;
      padding: 0 6px;
      border: none;
      border-left: 1px solid var(--divider-color);
      background: var(--card-background-color);
      color: var(--secondary-text-color);
      font: inherit;
      font-size: 0.85rem;
      cursor: pointer;
    }

    .stop-group .slot-size-button:first-child {
      border-left: none;
    }

    .slot-size-button.active {
      background: color-mix(in srgb, var(--primary-color, #2563eb) 18%, var(--card-background-color));
      color: var(--primary-color, #2563eb);
      font-weight: 600;
    }

    /* A width the loaded day has no data for. The stop stays in the row -- the
       toggle must not change length between days -- so the dimming and the
       pointer are the whole of what says it cannot be pressed. Last, so it
       outranks .active: a coarser day can leave the active stop disabled, and
       the reader has to see that before wondering why pressing does nothing. */
    .slot-size-button:disabled {
      cursor: not-allowed;
      opacity: 0.4;
    }

    /* The aggregate views' pill row, on the line the day row occupies so the
       toolbar wraps the same way whichever view is on screen. */
    .span-pills {
      flex: 1 1 auto;
      min-width: 0;
    }

    .icon-button {
      min-width: 40px;
      min-height: 36px;
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      background: var(--card-background-color);
      color: var(--primary-text-color);
      cursor: pointer;
    }

    .icon-button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .note {
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--divider-color);
      color: var(--secondary-text-color);
      background: var(--secondary-background-color);
      line-height: 1.35;
    }

    /* Holds the card's height across a navigation: the shell keeps rendering
       whatever content it had -- dimmed and inert -- instead of collapsing to
       the loading note, and only supplies its own height (INSPECTOR_CONTENT_
       MIN_HEIGHT, sized off the day chart's svg height) on a cold mount that
       has nothing stale to hold open. */
    .content-shell {
      position: relative;
    }

    /* Only when there is nothing at all to hold the box open -- see the
       "empty" comment above _renderBody -- not on every loading or errored
       render: a stale render that happens to be shorter than the floor is
       already anchoring the height on its own, and forcing it up as well
       would reintroduce the jump this shell exists to remove. */
    .content-shell.is-empty {
      min-height: ${unsafeCSS(INSPECTOR_CONTENT_MIN_HEIGHT)}px;
    }

    /* :not(.loading-overlay) rather than dimming the shell itself, so the
       overlay's own chip stays fully readable over the dimmed content. No
       transition on the dimming: the overlay above already fades in, and an
       animated opacity would make the dim state something a test -- or a
       reader -- can catch mid-way rather than simply on or off. */
    .content-shell.is-loading > *:not(.loading-overlay) {
      opacity: 0.45;
      pointer-events: none;
    }

    /* A scrim rather than an opaque panel: what is underneath is the previous
       day, and keeping it legible through the veil is the whole point of not
       blanking the card. color-mix against the card's own background keeps it
       correct in both light and dark themes without a second variable. */
    .loading-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      /* Near the top of the chart rather than the middle of the shell: the
         shell is as tall as the whole day view, so a vertically centred chip
         lands somewhere around the price rail -- far from where the reader is
         looking and moving with whatever strips happen to be expanded. */
      align-items: flex-start;
      justify-content: center;
      padding-top: 20px;
      box-sizing: border-box;
      pointer-events: none;
      border-radius: 6px;
      background: color-mix(in srgb, var(--card-background-color, #fff) 55%, transparent);
      backdrop-filter: blur(2px);
      animation: helman-inspector-fade-in 160ms ease-out;
    }

    /* The message is a floating chip, sized to its text, rather than a box
       stretched over the whole shell -- a full-bleed panel reads as an error
       state, and hides the content it is supposed to be veiling. */
    .loading-chip {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      border-radius: 999px;
      color: var(--primary-text-color);
      font-size: 0.9rem;
      background: var(--card-background-color);
      border: 1px solid var(--divider-color);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    }

    .loading-chip::before {
      content: "";
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 2px solid var(--divider-color);
      border-top-color: var(--primary-color, #2563eb);
      animation: helman-inspector-spin 700ms linear infinite;
    }

    @keyframes helman-inspector-spin {
      to {
        transform: rotate(360deg);
      }
    }

    @keyframes helman-inspector-fade-in {
      from {
        opacity: 0;
      }
    }

    /* The spinner is decoration; the chip still says what is happening. */
    @media (prefers-reduced-motion: reduce) {
      .loading-chip::before,
      .loading-overlay {
        animation: none;
      }
    }

    .strip-section {
      display: grid;
      gap: 2px;
      width: 100%;
    }

    .strip-header-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 4px 12px;
      position: relative;
      overflow: hidden;
    }

    .schedule-header-hour {
      position: absolute;
      top: 50%;
      z-index: 0;
      color: var(--secondary-text-color);
      font-size: 11px;
      line-height: 1;
      pointer-events: none;
      transform: translate(-50%, -50%);
    }

    .schedule-header-title,
    .execution-toggle {
      position: relative;
      z-index: 1;
    }

    .execution-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--secondary-text-color);
      font-size: 0.85em;
      white-space: nowrap;
      cursor: pointer;
    }
  `];

  constructor() {
    super();
    new DataChangedController(this, () => this.hass, {}, () => this._refreshActiveView(true));
  }

  connectedCallback() {
    super.connectedCallback();
    // The wall clock owns a timer, because `hass` churn is not a clock. The card
    // above filters `hass` down to the entities this subtree actually reads, so
    // advancing "now" from the setter would freeze the now-marker on every chart
    // and stop the card ever rolling over to the next day (`_todayIso()` is read
    // at render time, and with no render there is no rollover). Coarse on
    // purpose, and the same resolution the schedule band uses, so the two lines
    // never disagree about where "now" is -- and stopped while the page is
    // hidden, which is `now-clock`'s half of the arrangement. `_tickNow` owns
    // the other half: which ticks are worth a render.
    this._stopNowClock = startNowClock(this._tickNow);
    // HA reinserts a card on a view switch with no fresh `hass` to resubscribe
    // on, and the pills and the banner read the schedule behind this one.
    if (this.hass) this._syncScheduleOwner();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopNowClock?.();
    this._stopNowClock = undefined;
    this._disconnectChartResizeObserver();
    this._unsubscribeScheduleOwner?.();
    this._unsubscribeScheduleOwner = undefined;
    this._scheduleOwner = undefined;
  }

  /**
   * The clock moved. Whether that is a change *this card* has to draw is a
   * second question, and it is asked here.
   *
   * `_nowMs` is reactive, so writing it re-renders the whole stack -- every
   * chart, both strips and the schedule band. Two things on screen read it: the
   * "now" line, which only today's day view draws, and the day rollover, which
   * moves the pill window, the navigation bounds and which day counts as today
   * wherever the card happens to be. A past day and the aggregate views mark no
   * moment at all, so between two midnights the clock reaches nothing there and
   * the tick is dropped.
   */
  private _tickNow = (): void => {
    const today = this._todayIso();
    if (today !== this._todayKey
      || (this._viewMode === "day" && this._selectedDate === today)) {
      this._nowMs = Date.now();
    }
  };

  /**
   * Derive the pill window once per cycle, before anything renders.
   *
   * The window is a render *input* — the pills are handed it — so it cannot be
   * computed in `updated()` without either showing a one-frame-stale row or
   * spending a second update cycle to correct it. And it is a function of the
   * selection, the loaded range and the wall clock at once, so driving it from
   * the mutation sites would mean keeping six triggers in step with one derived
   * value. Here Lit folds anything written into the current cycle, so the only
   * extra update left is the one `_loadDayAggregates` asks for when data
   * actually lands.
   */
  protected willUpdate(_changed: PropertyValues<this>) {
    this._todayKey = this._todayIso();
    // Hidden while the reader is in one, the aggregate view would leave no
    // stop to get back out by.
    if (_changed.has("hideAggregateViews") && this.hideAggregateViews && this._viewMode !== "day") {
      this._selectViewStop({ mode: "day", minutes: this._slotMinutes });
    }
    const open = this._viewMode === "day" && this._navExpanded;
    if (open && (!this._calendarWasOpen || this._calendarSelection !== this._selectedDate)) {
      this._slideDayCalendar(this._selectedDate || this._todayKey);
    }
    this._calendarWasOpen = open;
    this._calendarSelection = this._selectedDate;
    const pillWindow = navigationPillWindow({
      today: this._todayKey,
      selectedDate: this._selectedDate,
      mode: this._viewMode,
      expanded: this._navExpanded,
      calendarAnchor: this._calendarAnchor,
      focusBucket: this._navExpanded && this._viewMode !== "day" ? this._focusBucket() : null,
      dayRange: this._dayRange,
      firstWeekday: this._navExpanded && this._viewMode === "day"
        ? resolveFirstWeekdayIndex(this.hass?.locale)
        : 0,
      houseFocus: this.houseFocus,
    });
    this._pillWindowStart = pillWindow.start;
    this._pillWindowEnd = pillWindow.end;
    // Only for a row that is going to be drawn. At M there is none, and the
    // window still moves under it -- it is anchored on the selected month --
    // so fetching here would spend a websocket read per column pressed on a
    // calendar nobody sees.
    if (this._dayPillsVisible()) {
      void this._loadDayAggregates(pillWindow.start, pillWindow.end);
    }
    this._rebuildDayModelIfNeeded();
    if (this._view !== this._tooltipView) {
      this._tooltipView = this._view;
      if (this._tooltip.content !== null) this._tooltip.hide();
    }
    if (this._scheduleOwner && this._normalizedFor !== this._normalizationKey()) {
      this._renormalizeSchedule();
    }
  }

  /**
   * Which days the row may offer, and why the answer differs by view.
   *
   * In the day view a press opens the day, so the bound is what the day view
   * can draw: the recorder's floor and the forecast's horizon.
   *
   * At D a press picks a column, so the bound is which columns exist. That is
   * not the same question -- the backend clamps a span's end to today, so the
   * back half of the current month has no bucket at all, and a pill pressed
   * there would light amber while the panel it claims to select vanished.
   *
   * Empty on either side means no bound, which is what an unloaded span says.
   */
  private _pillReach(): { from: string; to: string } {
    if (this._viewMode === "day") {
      return { from: this._dayRange?.minDate ?? "", to: this._dayRange?.maxDate ?? "" };
    }
    const rows = this._span?.days ?? [];
    if (rows.length === 0) {
      return { from: "", to: "" };
    }
    return { from: rows[0].date, to: rows[rows.length - 1].date };
  }

  /**
   * Whether the day row is on screen.
   *
   * Never at M: the chart there is drawing a whole year a month at a time, so
   * there is no one month a calendar would be about, and the row would be
   * offering days at a granularity that has no day in it.
   *
   * Asked in `willUpdate` as well as in the render, because what the row costs
   * is not the drawing -- it is the aggregates read behind it.
   */
  private _dayPillsVisible(): boolean {
    return this._viewMode === "day"
      || (this._navExpanded && this._viewMode === "month");
  }

  protected updated(changed: Map<string, unknown>) {
    // The band strip is handed the host as a property, so the element has to
    // exist before it can be passed: it is picked up on the render after the
    // one that created it, which is one frame the strip renders no band.
    if (this._editorHost !== (this._editorHostElement ?? null)) {
      this._editorHost = this._editorHostElement ?? null;
    }
    // Seed the view from the configured default. `changed` only carries this when
    // the config value actually changes, so the runtime toggle — which touches
    // `_daylightOnly`, not this property — is never overridden.
    if (changed.has("daylightOnlyDefault")) {
      this._daylightOnly = this.daylightOnlyDefault;
    }
    // Seed the opening slot width once: an explicit config default wins,
    // otherwise it is chosen from the page width so a phone opens coarser than a
    // laptop. As with the daylight default, the runtime toggle touches
    // `_slotMinutes` alone, so this never overrides a manual pick.
    if (!this._slotMinutesInitialized || changed.has("slotMinutesDefault")) {
      const explicit = this._explicitSlotDefault();
      if (explicit !== null) {
        this._slotMinutes = explicit;
      } else if (!this._slotMinutesInitialized) {
        this._slotMinutes = defaultSlotMinutesForViewport();
      }
      this._slotMinutesInitialized = true;
    }
    // Seed the raw-forecast diagnostic's visibility from config. Like the
    // daylight default, this only fires when the config value changes, so the
    // legend toggle — which edits `_hiddenSeries` directly — and the impact
    // strip's own switch keep the last word at runtime.
    if (changed.has("biasRatioDefault")) {
      const next = new Set(this._hiddenSeries);
      if (this.biasRatioDefault) {
        next.delete("raw");
      } else {
        next.add("raw");
      }
      this._hiddenSeries = next;
      // The impact strip is part of the same diagnostic set, so it opens with
      // the raw overlay rather than needing its checkbox flipped separately.
      this._impactStripVisible = this.biasRatioDefault;
    }
    if (changed.has("hass") && this.hass) {
      if (!this._selectedDate) {
        this._selectedDate = this._todayIso();
      }
      if (this._loadedConnection !== this.hass.connection) {
        this._loadedConnection = this.hass.connection;
        this._load();
      }

    }
    // Held whatever the strip flags say: the day pills and the forecast behind
    // the health banner read the schedule too, and they are on every card.
    if (changed.has("hass")) {
      this._syncScheduleOwner();
    }
    this._syncChartResizeObserver();
  }

  render() {
    return this._renderBody();
  }

  /**
   * The day payload the card may draw, or null.
   *
   * Stale is still drawable, and it stays drawable a beat past the request
   * itself: a failed load leaves `_selectedDate` already moved but nothing
   * new to show for it, and the error note reads as a lie next to a card
   * that has gone blank under it. So the payload is kept up, dimmed, for
   * the error too -- not only while the request that would replace it is
   * still in flight.
   *
   * Asked in `willUpdate` as well as in the render, because the whole day
   * model is derived from it and that derivation does not belong in a render.
   */
  private _drawablePayload(): InspectorPayload | null {
    const stale = this._viewLoading() || !!(this._viewMode === "day" ? this._error : this._spanError);
    return this._payload?.date === this._selectedDate || (stale && this._payload)
      ? this._payload
      : null;
  }

  private _renderBody() {
    const loading = this._viewLoading();
    const error = this._viewMode === "day" ? this._error : this._spanError;
    const stale = loading || !!error;
    const content = this._renderContent(this._drawablePayload());
    // The empty string is the sentinel both branches of `_renderContent` use
    // for "nothing to draw at all" -- a payload-less day, or a span with no
    // rows. Only that state gets the height floor: a *stale* render, however
    // short that particular day happens to be, is already holding the box
    // open on its own, and forcing it up to the floor as well would be
    // exactly the jump this shell exists to remove.
    const empty = content === "";
    return html`
      <div
        class="body"
        @helman-open-schedule-editor=${this._handleOpenScheduleEditor}
        @show-device-detail=${this._handleShowDeviceDetail}
        @show-controllable-detail=${this._handleShowControllableDetail}
      >
        <!-- One editor for the whole card. The band strip draws its day off
             this host and opens it on a lane press; a badge in the composition
             panel opens the same instance, so the two never disagree about
             which day is on screen.

             It holds a schedule subscription and loads appliances,
             controllable entities, history and projections of its own, so it
             is mounted only where something can actually reach it -- see
             _scheduleEditorReachable, which owns that question.

             It cannot be created on demand instead: openFor returns early
             until the owner has synced, so a host built at click time would
             swallow the first press. -->
        ${this._scheduleEditorReachable()
          ? html`
              <scheduling-day-editor-host
                .hass=${this.hass}
                .preload=${!this.hideScheduleStrip}
                .timeZone=${this._haTimeZone() ?? "UTC"}
              ></scheduling-day-editor-host>
            `
          : ""}
        ${this._nodeDetail
          ? html`
              <node-detail-dialog
                .hass=${this.hass}
                .localize=${this._localize}
                .open=${true}
                .params=${this._nodeDetail}
                @closed=${() => { this._nodeDetail = null; }}
              ></node-detail-dialog>
            `
          : ""}
        ${this._renderNavigation()}
        <!-- One per card, over the forecast this card reads for the pills:
             the warning is about the card's data as a whole, so it is drawn
             here and in every view rather than inside the pill row. The house
             embed judges the house forecast alone, so it keeps that half. -->
        <helman-forecast-health-banner
          .items=${buildForecastHealthItems(this._forecast, this._localize).filter((item) =>
            !this.houseFocus || item.label === this._localize("forecast_health.source.house"))}
          .localize=${this._localize}
        ></helman-forecast-health-banner>
        ${error ? html`<div class="note">${error}</div>` : ""}
        <!-- The loading note used to be its own row above this one, so its
             appearance and disappearance was a second jump on top of the one
             this shell exists to remove. It now overlays whatever is already
             drawn instead of displacing it. aria-busy tracks loading rather
             than stale: an error is done, not in progress. -->
        <div
          class="content-shell ${stale ? "is-loading" : ""} ${empty ? "is-empty" : ""}"
          aria-busy=${loading ? "true" : "false"}
        >
          ${content}
          ${loading
            ? html`<div class="loading-overlay">
                <div class="loading-chip">${this._t("bias_correction.inspector.loading")}</div>
              </div>`
            : ""}
        </div>
      </div>
    `;
  }

  /**
   * A badge in the composition panel asked for the day editor.
   *
   * Routed to the same host the band strip opens, so pressing a lane and
   * pressing a badge land in one dialog. It opens on today rather than on the
   * browsed day, because today is what the badge is about: it reports the slot
   * running now. The browsed day is often one the schedule no longer holds —
   * the backend prunes what has gone — and the dialog would quietly land
   * somewhere else anyway.
   */
  private _handleOpenScheduleEditor = (event: CustomEvent<OpenScheduleEditorDetail>): void => {
    event.stopPropagation();
    this._editorHost?.openFor(event.detail.target);
  };

  private _handleShowDeviceDetail = (event: CustomEvent<{ item: TreeItem }>): void => {
    event.stopPropagation();
    this._nodeDetail = { nodeType: "device", item: event.detail.item };
  };

  private _handleShowControllableDetail = async (event: CustomEvent<ShowControllableDetailDetail>): Promise<void> => {
    event.stopPropagation();
    const { controllableId, entityId } = event.detail;
    if (this.hass) {
      try {
        const payload = await getSharedHelmanStore(this.hass).getDeviceTree();
        const tree = hydrateDeviceTree(payload, this._localize);
        const energyNodes = resolveEnergyNodes(tree);
        const target = deviceForControllable(energyNodes.houseNode, controllableId);
        if (target !== null) {
          let params: NodeDetailParams;
          if (target instanceof TreeItem) {
            params = { nodeType: "device", item: target };
          } else {
            const readings = readEnergyReadings(this.hass, energyNodes);
            const context = buildNodeDetailContext(readings, {
              houseNode: energyNodes.houseNode,
              gridPowerEntityId:
                energyNodes.gridProducerNode?.powerSensorId ??
                energyNodes.gridConsumerNode?.powerSensorId ??
                null,
              historyBuckets: payload.uiConfig.history_buckets,
              historyBucketDuration: payload.uiConfig.history_bucket_duration,
            });
            params = buildNodeDetailParams(context, "inverter");
          }
          if (this._nodeDetail !== null) {
            await this.shadowRoot?.querySelector<NodeDetailDialog>("node-detail-dialog")?.releaseHistory();
            this._nodeDetail = null;
            await this.updateComplete;
          }
          this._nodeDetail = params;
          return;
        }
      } catch {
        // Fall back to more-info below.
      }
    }
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      bubbles: true,
      composed: true,
      detail: { entityId },
    }));
  };

  private _renderNavigation() {
    // Computed in `willUpdate`; nothing is derived or assigned here.
    const today = this._todayKey;
    // What the toggle reveals, per view. The day row is the aggregate views'
    // extra and the span rows are the day view's, so a single flag drives both
    // conditions from opposite sides -- see `_navExpanded`.
    const showSpanRows = this._viewMode !== "day" || this._navExpanded;
    const showDayPills = this._dayPillsVisible();
    return html`
      <div class="nav">
        <div class="day-nav">
          <!-- Years over months, above the days they hold. The aggregate views
               always show them because a span is what those views browse; the
               day view shows them once the reader asks for more than the week
               in front of them. -->
          ${!showSpanRows ? "" : html`<helman-solar-span-pills
            class="span-pills"
            .hass=${this.hass}
            .viewMode=${this._viewMode === "year" ? "year" : "month"}
            .selectedDate=${this._viewMode === "day" ? this._browsedMonth : this._selectedDate}
            .minDate=${this._viewMode === "day" ? this._dayRange?.minDate ?? "" : this._navFloor()}
            .todayKey=${this._viewMode === "day" ? this._dayRange?.maxDate ?? today : today}
            .hoveredKey=${this._shapedKey("month", this._hoveredBucketKey)}
            .selectedBuckets=${this._shapedKeys("month")}
            .selectsSlot=${this._correlatedRow() === "month"}
            @span-pill-select=${this._handleSpanPillSelect}
            @span-pill-open=${this._handleSpanPillOpen}
            @span-pill-hover=${this._handleSpanPillHover}
          ></helman-solar-span-pills>`}
          <!-- Detail browsing uses a bounded continuous calendar. Aggregate D
               keeps its existing single-month calendar and column selection. -->
          ${!showDayPills ? "" : html`<helman-solar-day-pills
            class="day-pills"
            .hass=${this.hass}
            .layout=${this._navExpanded ? "calendar" : "row"}
            .continuous=${this._viewMode === "day" && this._navExpanded}
            .browsedMonth=${this._browsedMonth}
            .revealMonth=${this._calendarAnchor}
            .revealVersion=${this._calendarReveal}
            @calendar-month=${(event: CustomEvent<{ month: string }>) => { this._browsedMonth = event.detail.month; }}
            @calendar-buffer=${(event: CustomEvent<{ month: string }>) => { this._calendarAnchor = event.detail.month; }}
            @calendar-return=${() => this._slideDayCalendar(this._selectedDate)}
            .selectedDate=${this._viewMode === "day" ? this._selectedDate : ""}
            .currentDate=${today}
            .startDate=${this._pillWindowStart}
            .endDate=${this._pillWindowEnd}
            .reachableFrom=${this._pillReach().from}
            .reachableTo=${this._pillReach().to}
            .hoveredDate=${this._shapedKey("day", this._hoveredBucketKey)}
            .selectedBuckets=${this._shapedKeys("day")}
            .selectsSlot=${this._correlatedRow() === "day"}
            .historyDays=${this._historyDays}
            .normalizedSchedule=${this._normalizedSchedule}
            .forecast=${this._forecast}
            .houseFocus=${this.houseFocus}
            .timeZone=${this._haTimeZone() ?? "UTC"}
            @day-pill-select=${this._handleDayPillSelect}
            @day-pill-open=${this._handleDayPillOpen}
            @day-pill-hover=${this._handleDayPillHover}
          ></helman-solar-day-pills>`}
        </div>
        <div class="nav-actions">
          <!-- The one way through the days that are not on screen, in the place
               the week arrows held.

               It leads the toolbar rather than standing beside the pills, so
               that when the header runs out of width the row keeps a line to
               itself and every control drops to the next one together. -->
          <!-- Not at M, where it has nothing to open. The span rows are always
               up there and the day row never is, so the toggle would be a
               control that changes nothing -- and a control that does nothing
               is worse than no control, because it invites the press. -->
          ${this._viewMode === "year" ? "" : html`<button
            class="icon-button nav-more ${this._navExpanded ? "active" : ""}"
            type="button"
            title=${this._t("bias_correction.inspector.more_days")}
            aria-expanded=${this._navExpanded ? "true" : "false"}
            @click=${() => { this._navExpanded = !this._navExpanded; }}
          ><ha-icon icon="mdi:calendar-month"></ha-icon></button>`}
          <div class="slot-size-toggle" role="group" title=${this._t("bias_correction.inspector.slot_size")}>
            ${viewStopGroups(this.hideAggregateViews).map((group) => html`
              <div class="stop-group">${group.map((stop) => {
                const active = stop.minutes === undefined
                  ? this._viewMode === stop.mode
                  : this._viewMode === "day" && this._slotMinutes === stop.minutes;
                // A width the loaded day has no data for is offered disabled
                // rather than hidden: the toggle would otherwise change length
                // between days, and the reader could not tell a missing stop from
                // one that is simply unavailable here. The aggregate stops are
                // never affected -- they read their own statistics.
                const tooCoarse =
                  stop.minutes !== undefined && stop.minutes < this._slotMinutesFloor();
                return html`
                <button
                  class="slot-size-button ${active ? "active" : ""}"
                  type="button"
                  aria-pressed=${active ? "true" : "false"}
                  ?disabled=${tooCoarse}
                  title=${tooCoarse ? this._t("bias_correction.inspector.hourly_only_stop") : ""}
                  @click=${() => this._selectViewStop(stop)}
                >${stop.label}</button>
              `;
              })}</div>
            `)}
          </div>
          ${this._viewMode !== "day" ? "" : html`<button
            class="icon-button ${this._daylightOnly ? "active" : ""}"
            title=${this._t("bias_correction.inspector.daylight_only")}
            aria-pressed=${this._daylightOnly ? "true" : "false"}
            @click=${() => { this._daylightOnly = !this._daylightOnly; }}
          >☀</button>`}
          <button
            class="icon-button"
            title=${this._t("bias_correction.inspector.refresh")}
            ?disabled=${this._loading || this._spanLoading}
            @click=${() => this._refreshActiveView(false)}
          >⟳</button>
        </div>
      </div>
    `;
  }

  private _renderContent(payload: InspectorPayload | null) {
    // The one branch, and it is the first thing here for a reason: `buildDayView`
    // below takes an `InspectorPayload`, and the span payload is not one. Every
    // day-shaped strip -- price, schedule actions, SoC, impact, the house
    // breakdown, the now marker -- lives past this line and never runs for an
    // aggregate view, which is what makes "the day view does not move" a
    // structural property rather than a promise.
    if (this._viewMode !== "day") {
      return this._renderAggregateContent();
    }
    // Everything below renders from the slot-collapsed view; only the daily
    // totals it carries through are slot-width independent. All three were
    // derived in `willUpdate` from this same payload; nothing is built or
    // assigned here.
    const view = this._view;
    if (!payload || !view) {
      return "";
    }
    const stacks = this._stacks;
    const layout = this._layout;
    const hasAnySeries = stacks !== null && layout !== null;
    const panel = this._panelContext();

    return html`
      ${payloadGranularity(payload) > 15
        ? html`<div class="note">${this._t("bias_correction.inspector.hourly_only")}</div>`
        : ""}
      ${!view.availability.hasProfile && !this.houseFocus
        ? html`<div class="note">${this._t("bias_correction.inspector.no_profile")}</div>`
        : ""}
      ${hasAnySeries && stacks && layout
        ? html`
            <!-- Solar, battery, price, then the schedule read against all
                 three -- the order the day editor stacks the same four things
                 in, so moving between the two is not a re-read. -->
            ${this._renderTooltip()}
            <helman-solar-day-chart
              .hass=${this.hass}
              .view=${view}
              .stacks=${stacks}
              .layout=${layout}
              .socBars=${this._socBarsModel}
              .slotMinutes=${this._slotMinutes}
              .hiddenSeries=${this._hiddenSeries}
              .chartSeries=${this.chartSeries}
              .selection=${this._slotSelection}
              .hoverMinutes=${this._hoveredMinutes}
              .coverage=${this._coverage}
              .dimIncompleteSlots=${this.dimIncompleteSlots}
              .impactVisible=${this._impactStripVisible}
              .houseFocus=${this.houseFocus}
              .date=${this._selectedDate}
              .timeZone=${this._haTimeZone() ?? "UTC"}
              .nowMs=${this._nowMs}
              @slot-pick=${(event: CustomEvent<SlotPickDetail>) => this._handleStripSlotPick(event)}
              @slot-hover=${this._handleStripHover}
              @slot-tooltip=${this._handleChartTooltip}
            ></helman-solar-day-chart>
            ${this.hidePriceStrip ? "" : this._renderPriceStrip(view)}
            ${this.hideMoneyStrip ? "" : this._renderMoneyStrip(view)}
            ${this.hideScheduleStrip ? "" : this._renderScheduleActionsStrip(view, layout)}
            ${renderSelectedSlotDetails(panel, view, {
              slots: this._selectedSlotsIn(view),
              focusSlot: this._selectedSlot,
              slotMinutes: this._slotMinutes,
              coverage: this._coverage,
              native: payload.series,
              houseFocus: this.houseFocus,
              hidePriceStrip: this.hidePriceStrip,
              hideMoneyStrip: this.hideMoneyStrip,
              groups: this._breakdownGroups,
              contribution: {
                collapsed: this._trainingTableCollapsed,
                impactStripVisible: this._impactStripVisible,
                selectedDate: this._selectedDate,
                selectedTrainingDate: this._selectedTrainingDate,
                toggleCollapsed: () => { this._trainingTableCollapsed = !this._trainingTableCollapsed; },
                toggleImpactStrip: () => { this._impactStripVisible = !this._impactStripVisible; },
                selectTrainingDate: (date) => this._selectTrainingDate(date),
              },
            })}
            ${renderTotals(panel, view, {
              coverage: this._coverage,
              past: view.date < this._todayIso(),
              houseFocus: this.houseFocus,
              hideMoneyStrip: this.hideMoneyStrip,
            })}
          `
        : html`<div class="note">${this._t("bias_correction.inspector.no_data", { date: this._formatDay(view.date) })}</div>`}
    `;
  }

  /** The floor the width toggle may not go below on the day currently loaded. */
  private _slotMinutesFloor(): number {
    return this._viewMode === "day" ? payloadGranularity(this._payload) : 15;
  }

  /** The configured opening slot width, or null when the card leaves it to auto. */
  private _explicitSlotDefault(): number | null {
    const value = this.slotMinutesDefault;
    return value != null && SLOT_SIZE_OPTIONS.includes(value as 15 | 30 | 60) ? value : null;
  }

  /**
   * Switch the chart's slot width, keeping any selection on the new grid so the
   * highlight and detail panel stay put rather than clearing on every toggle.
   */
  private _setSlotMinutes(minutes: number) {
    if (this._slotMinutes === minutes) return;
    this._slotMinutes = minutes;
    // Re-grid the whole selection onto the new width, dropping anything it has no
    // slot for. Distinct slots can snap onto one; reconcile dedupes them.
    this._applySelection(reconcileSlotSelection(
      this._orderedSlots(null),
      this._slotSelection,
      (slot) => snapSlotToGrid(slot, minutes),
    ));
  }

  /**
   * A stop of the width toggle was pressed.
   *
   * A minutes stop is exactly what it always was -- including the selection
   * re-gridding, which is why it goes through `_setSlotMinutes` rather than
   * assigning the field. The two wider stops leave `_slotMinutes` alone, so
   * coming back to a minutes stop restores the day view as it was rather than
   * rebuilding it from a default.
   *
   * `minutes` is a plain number rather than the toggle's three literals because
   * {@link _openBucket} arrives here with `_slotMinutes` -- the width last used
   * -- and that field is a number everywhere else too. The toggle's own stops
   * still only ever hand over one of the three.
   */
  private _selectViewStop(stop: { mode: InspectorViewMode; minutes?: number }) {
    if (stop.minutes !== undefined) {
      // The day the aggregate views left selected, not whatever `_selectedDate`
      // happens to hold: span navigation parks it on a span start, so arriving
      // from M without this opened the 1st of January.
      this._selectedDate = this._dayForMinutesStop();
      this._clearChartFocus();
      this._viewMode = "day";
      this._setSlotMinutes(stop.minutes);
      this._ensureDayLoaded();
      return;
    }
    if (this._viewMode === stop.mode) return;
    // Worked out before the mode moves, because every helper it leans on reads
    // `_viewMode` to decide what a span is.
    const carried = this._spanForViewStop(stop.mode);
    this._viewMode = stop.mode;
    this._selectedDate = carried.date;
    this._bucketSelection = carried.bucket === null
      ? EMPTY_SLOT_SELECTION
      : { selectedSlots: [carried.bucket], focusSlot: carried.bucket, anchorSlot: carried.bucket };
    this._hoveredBucketKey = null;
    this._loadSpan();
  }

  /**
   * What the next granularity should be showing, and which of its columns
   * should still be picked.
   *
   * A change of stop is a change of *scale*, not of subject: the reader is
   * asking to see the same thing coarser or finer. So whatever was picked
   * carries across, reshaped to whatever a column is on the other side --
   * a month selected at M opens as the month D draws, and the day being read
   * at 15/30/60 arrives at D as the column already selected.
   *
   * Where nothing was picked there is nothing to carry, and the browsed date
   * decides on its own -- which is the case the reader means when they leave a
   * month unselected.
   */
  private _spanForViewStop(mode: InspectorViewMode): { date: string; bucket: string | null } {
    const today = this._todayIso();
    const anchor = this._focusBucket() ?? (this._selectedDate || today);
    if (mode === "month") {
      // Into D, whose columns are days. A month picked at M names the month to
      // draw and leaves no day picked inside it; a day carries as itself.
      const day = this._correlatedRow() === "day" || this._viewMode === "day"
        ? anchor
        : null;
      return day !== null
        ? { date: day, bucket: day }
        : { date: monthBounds(anchor, today).start, bucket: null };
    }
    // Into M, whose columns are months: the month around whatever was picked.
    return { date: anchor, bucket: monthBounds(anchor, today).start };
  }

  /**
   * Which day a minutes stop should open, given where the reader is coming
   * from.
   *
   * At D the picked column is itself a day and is the obvious answer. At M the
   * columns are months, so the answer is whichever day the calendar was
   * offering: the one already selected when it falls inside the picked month,
   * and that month's first day otherwise -- a day from some other month would
   * be a jump nobody asked for.
   *
   * Then clamped into what the day view can actually open. The recorder purges
   * raw states from under the aggregates, so a month the year view draws
   * happily can be entirely beyond the day view; landing on the floor is the
   * first day that has anything to show, which beats an empty chart.
   */
  private _dayForMinutesStop(): string {
    const today = this._todayIso();
    const column = this._shapedKey("day", this._focusBucket());
    const month = this._correlatedRow() === "month" ? this._focusBucket() : null;
    const selected = this._selectedDate || today;
    let day = column ?? selected;
    if (column === null && month !== null) {
      const bounds = monthBounds(month, today);
      day = selected >= bounds.start && selected <= bounds.end ? selected : bounds.start;
    }
    const floor = this._dayRange?.minDate ?? "";
    const horizon = this._dayRange?.maxDate ?? "";
    if (floor !== "" && day < floor) return floor;
    if (horizon !== "" && day > horizon) return horizon;
    return day;
  }

  /**
   * Whether the view on screen is waiting on its own fetch.
   *
   * The two views have separate in-flight flags, and a control that reads the
   * wrong one lies in both directions: the span arrows would stay live through
   * a span load, and freeze during a day load that has nothing to do with what
   * is drawn.
   */
  private _viewLoading(): boolean {
    return this._viewMode === "day" ? this._loading : this._spanLoading;
  }

  /** What one column is in the current view; the day view has no aggregate. */
  private _spanBucket(): "day" | "month" {
    return this._viewMode === "year" ? "month" : "day";
  }

  /**
   * Put a span on screen, whichever pill asked for it.
   *
   * The ways in must agree on what changing span means -- the date moves,
   * the bucket the panel was describing is no longer in view, and the new span
   * has to be fetched -- so they share this rather than each doing it. Landing
   * on the span already shown is a no-op, which is what keeps a pill click on
   * the current span from reloading it.
   *
   * The comparison is between *spans*, not dates. `_selectedDate` is a span
   * start only after span navigation put it there; arriving from the day view
   * on the 14th leaves it on the 14th, and comparing raw dates would treat a
   * click on the already-lit pill as a move -- dropping the selected column and
   * rewriting the date, so that returning to the day view landed on the 1st
   * rather than the day the reader came from.
   */
  private _showSpan(spanKey: string, mode: InspectorViewMode = this._viewMode) {
    const today = this._todayIso();
    // The mode is checked first and separately: picking a month from the year
    // view lands on a span the year view would call unchanged, and it is still
    // a move -- to a different view of it.
    if (mode === this._viewMode
      && spanKey === spanBounds(this._viewMode, this._selectedDate || today, today).start) {
      return;
    }
    this._viewMode = mode;
    this._selectedDate = spanKey;
    this._clearChartFocus();
    this._loadSpan();
  }

  /**
   * The oldest date the picker may offer, wherever the card currently is.
   *
   * The two payloads state the same floor, so this is about which one has
   * *arrived*: `_spanRange` is only ever assigned by `_loadSpan`, which never
   * runs while the card sits in its opening day view. Falling back to the day
   * view's floor is what keeps the expanded picker from collapsing to the
   * current month on a card nobody has taken to D or M yet, which since the
   * arrows went is a dead end.
   */
  private _navFloor(): string {
    return this._spanRange?.minDate ?? this._dayRange?.minDate ?? "";
  }

  private _handleSpanPillSelect = (event: CustomEvent<SpanPillSelectDetail>): void => {
    event.stopPropagation();
    // In the day view the rows are a calendar's header, not a view switch: the
    // reader opened them to reach a further month and then pick a day out of
    // it. The element cannot know that -- it emits the mode an aggregate view
    // would want -- so the card, which already owns the question of whether a
    // pill click is a move, answers it here.
    if (this._viewMode === "day") {
      this._slideDayCalendar(event.detail.date);
      return;
    }
    // At M the month row *is* the chart's columns, so pressing one picks the
    // bucket rather than opening it -- the same press the column takes. Every
    // other press moves the span the view is showing, and the view it is
    // showing in stays what it was.
    if (event.detail.row === "months" && this._correlatedRow() === "month") {
      this._pickBucket(event.detail.date);
      return;
    }
    this._showSpan(event.detail.date, this._viewMode);
  };

  /** Explicit browsing reveals a month; viewport feedback only updates its highlight. */
  private _slideDayCalendar(spanKey: string): void {
    const floor = this._dayRange?.minDate?.slice(0, 7) ?? "";
    const horizon = this._dayRange?.maxDate?.slice(0, 7) ?? "";
    let month = spanKey.slice(0, 7);
    if (floor && month < floor) month = floor;
    if (horizon && month > horizon) month = horizon;
    this._browsedMonth = this._calendarAnchor = `${month}-01`;
    this._calendarReveal++;
  }

  /**
   * One bucket in words -- a date in the month view, a month in the year view.
   *
   * The panel states what its numbers are for, so a month's totals must not be
   * headed with the 1st of that month, which is merely the key they arrive
   * under.
   */
  private _formatBucket(dateKey: string): string {
    if (this._spanBucket() === "day") return this._formatDay(dateKey);
    const { year, month } = this._parseIsoDate(dateKey);
    return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, {
      timeZone: "UTC",
      year: "numeric",
      month: "long",
    });
  }

  /** The span on screen, in words: "July 2026" or "2026". */
  private _spanLabel(): string {
    const anchor = this._selectedDate || this._todayIso();
    const { year, month } = this._parseIsoDate(anchor);
    if (this._viewMode === "year") return String(year);
    return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, {
      timeZone: "UTC",
      year: "numeric",
      month: "long",
    });
  }

  /**
   * Fetch the span the aggregate views draw.
   *
   * The same command the day pills use, with the bucket the view needs. Keyed
   * by what it asks for and checked again on arrival, so paging quickly through
   * months cannot let an older answer land on top of a newer one -- the
   * discipline `_loadDayAggregates` established for the pills, which share this
   * endpoint.
   */
  private async _loadSpan(silent = false) {
    if (!this.hass) return;
    if (!this._selectedDate) this._selectedDate = this._todayIso();
    const bucket = this._spanBucket();
    const { start, end } = spanBounds(this._viewMode, this._selectedDate, this._todayIso());
    const key = `${bucket}:${start}..${end}`;
    const request = this._spanRequest.begin(key);
    if (request === null) {
      // The span already on screen is the right one, but the selection may not
      // be: a stop change carries a focus bucket in, and one that this span has
      // no column for -- a future day the backend clamped away -- would light a
      // pill the chart cannot draw and head a panel with no rows behind it.
      this._bucketSelection = reconcileSlotSelection(
        this._orderedBuckets(),
        this._bucketSelection,
      );
      return;
    }
    // An announced change must not flash an overlay over the span the reader is
    // studying, exactly as it must not disturb the day view.
    if (!silent) this._spanLoading = true;
    this._spanError = "";
    // The previous span stays put -- see the matching comment in `_load` --
    // and is overwritten below on success or left in place under the error
    // note on failure.
    try {
      const result = await fetchDayAggregates(this.hass, {
        start_date: start,
        end_date: end,
        bucket,
        // Only this composition panel needs the per-consumer statistics read.
        house_breakdown: true,
      });
      if (!this._spanRequest.isCurrent(request)) return;
      this._span = { bucket, priceUnit: result?.priceUnit ?? null, days: result?.days ?? [] };
      // Drop anything the new span has no column for, exactly as the day load
      // re-grids its slot selection: a selection the chart cannot draw is a
      // panel describing buckets that are not on screen.
      this._bucketSelection = reconcileSlotSelection(this._orderedBuckets(), this._bucketSelection);
      // Same stale-request guard as the payload above: a span view is a way into
      // the card, so this is where the floor arrives when no day was ever loaded.
      if (result?.range) this._spanRange = result.range;
    } catch (err: any) {
      if (!this._spanRequest.isCurrent(request)) return;
      this._spanError = err?.message || this._t("bias_correction.inspector.load_failed");
    } finally {
      if (this._spanRequest.isCurrent(request)) this._spanLoading = false;
      this.requestUpdate();
    }
  }

  /**
   * The aggregate views: a chart, the clicked bucket, and the span's totals.
   *
   * Everything a day has and a span does not is simply absent -- no forecast to
   * compare against, no price rail, no planned actions, no SoC trajectory, no
   * house composition. They are not hidden here; they are on the other side of
   * the branch at the top of `_renderContent` and never run.
   */
  private _renderAggregateContent() {
    // A stale span is only stale, not wrong-shaped: month <-> year also
    // switches the bucket a row means, and drawing last month's daily rows
    // as though they were this year's monthly ones would label every column
    // with the wrong unit for as long as the new span takes to arrive. Rows
    // whose bucket no longer matches the view are treated as nothing to fall
    // back on, same as a cold mount.
    const rows = this._span?.bucket === this._spanBucket() ? this._span?.days ?? [] : [];
    if (rows.length === 0) {
      // Nothing stale to fall back on. Loading or errored, the note above
      // already says which; a second empty frame here would only flicker.
      // Only the "no data" case gets a note of its own, and only once the
      // request that would explain an empty span either way has finished.
      return this._spanLoading || this._spanError
        ? ""
        : html`<div class="note">${this._t("bias_correction.inspector.no_span_data", { span: this._spanLabel() })}</div>`;
    }
    const selected = this._selectedBucketRows(rows);
    const currency = currencyFromPriceUnit(this._span?.priceUnit);
    const panel = this._panelContext();
    return html`
      ${this._renderTooltip()}
      <div class="chart-wrap">
        <helman-solar-aggregate-chart
          .hass=${this.hass}
          .rows=${rows}
          .bucket=${this._spanBucket()}
          .selectedKeys=${this._bucketSelection.selectedSlots}
          .hoveredKey=${this._hoveredBucketKey}
          .currency=${currency}
          .width=${this._chartWidth}
          @aggregate-bucket-select=${this._handleBucketSelect}
          @aggregate-bucket-open=${this._handleBucketOpen}
          @aggregate-bucket-hover=${this._handleBucketHover}
        ></helman-solar-aggregate-chart>
      </div>
      ${renderSelectedBucket(panel, this._breakdownGroups, selected, {
        heading: this._formatBucketRange(selected.map((row) => row.date)),
        currency,
        bucket: this._spanBucket(),
      })}
      ${renderSpanTotals(panel, rows, currency)}
    `;
  }

  /**
   * A bucket key the day pills can act on, or null.
   *
   * A row is handed the key only where its pills are the same shape as the
   * chart's columns, and otherwise null. Handing the day row a month key would
   * either light nothing -- its pills are keyed by day -- or, worse, light the
   * 1st, claiming a correspondence that is not there.
   */
  private _shapedKey(row: "day" | "month", key: string | null): string | null {
    return this._correlatedRow() === row ? key : null;
  }

  /**
   * The whole chart selection, for the pill row whose pills are its columns.
   *
   * The plural of `_shapedKey` and shaped by the same rule: a row only lights
   * keys it is keyed by. The rows take the set rather than the focus bucket
   * because a multi-column selection that lit one pill would read as the chart
   * and the row disagreeing about what is picked.
   */
  private _shapedKeys(row: "day" | "month"): readonly string[] {
    return this._correlatedRow() === row ? this._bucketSelection.selectedSlots : EMPTY_BUCKET_KEYS;
  }

  /**
   * Which navigation row the chart's columns line up with, if any.
   *
   * The picker has two rows of pills and the chart has one shape of column, so
   * exactly one row can correspond at a time: at D the columns are days and the
   * day pills match, at M they are months and the month row matches. The day
   * view matches nothing -- it draws no bucket chart at all, only slots inside
   * a single day -- which is why this is narrower than `_spanBucket()`, whose
   * answer there is "day".
   *
   * The year row never correlates. A year is not a bucket in either view.
   */
  private _correlatedRow(): "day" | "month" | null {
    if (this._viewMode === "month") return "day";
    if (this._viewMode === "year") return "month";
    return null;
  }

  /** Store the hovered bucket, skipping redundant updates. */
  private _setHoveredBucket(key: string | null) {
    if (this._hoveredBucketKey === key) return;
    this._hoveredBucketKey = key;
  }

  /** Drop whatever the chart was focused on; nothing survives a change of view. */
  private _clearChartFocus() {
    this._bucketSelection = EMPTY_SLOT_SELECTION;
    // The hovered key has no `mouseleave` to rely on here: a node removed from
    // under the pointer never fires one, so a view change that unmounts the
    // chart or the row would otherwise leave a phantom amber column waiting on
    // the next visit.
    this._hoveredBucketKey = null;
  }

  /**
   * The pill row's own hover, which is the other half of the correlation.
   *
   * It carries no pointer position and raises no popup. The popup belongs to
   * the thing being pointed *at* -- a column has numbers behind it, a pill is
   * already showing its own -- so a pill hover sets the key and stops there.
   */
  private _handleDayPillHover = (event: CustomEvent<DayPillHoverDetail>) => {
    event.stopPropagation();
    // Ignored outright in the day view, where the row is on screen with no
    // bucket chart beside it. Routing the hover through the card there would
    // buy a whole-card render per pill crossed -- thirty-one of them across an
    // open calendar -- to arrive back at the highlight `.pill:hover` had
    // already drawn for free.
    if (this._correlatedRow() !== "day") return;
    this._setHoveredBucket(event.detail.date);
  };

  /**
   * The month row's hover, which is the same correlation one granularity up.
   *
   * At M a column *is* a month pill, so the two behave exactly as the day pills
   * and the day columns do at D -- same key, same amber, same both-directions.
   * The guard is the mirror of the day row's: a month pill at D is a navigation
   * control with no column behind it.
   */
  private _handleSpanPillHover = (event: CustomEvent<SpanPillHoverDetail>) => {
    event.stopPropagation();
    if (this._correlatedRow() !== "month") return;
    this._setHoveredBucket(event.detail.date);
  };

  /**
   * A column was pressed, or the gutter beside them was.
   *
   * The chart reports which and with which modifiers; what that does to the
   * selection is decided here and only here, by the same two calls the day
   * view's slot press makes -- `applySlotSelection` for a column,
   * an empty selection for a press that missed them all.
   */
  private _handleBucketSelect = (event: CustomEvent<AggregateBucketSelectDetail>) => {
    event.stopPropagation();
    if (event.detail.key === null) {
      this._bucketSelection = EMPTY_SLOT_SELECTION;
      return;
    }
    this._selectBucket(event.detail.key, event.detail.mode);
  };

  /* The three ways to ask for a drill -- the chart (its columns and the row
     strips' hit rects alike), the month row at M, the day row at D -- all
     landing on the one place that decides what one is. Which of them the
     reader double-clicked says nothing about what they want, so none of them
     is allowed its own answer. */
  private _handleBucketOpen = (event: CustomEvent<AggregateBucketOpenDetail>) => {
    event.stopPropagation();
    this._openBucket(event.detail.key);
  };

  private _handleSpanPillOpen = (event: CustomEvent<SpanPillOpenDetail>): void => {
    event.stopPropagation();
    this._openBucket(event.detail.date);
  };

  private _handleDayPillOpen = (event: CustomEvent<DayPillOpenDetail>): void => {
    event.stopPropagation();
    this._openBucket(event.detail.date);
  };

  /** The bucket the pill rows light and the width toggle carries across. */
  private _focusBucket(): string | null {
    return this._bucketSelection.focusSlot;
  }

  /** The span's buckets in the order they are drawn -- the selection's universe. */
  private _orderedBuckets(): string[] {
    return this._span?.days.map((row) => row.date) ?? [];
  }

  /** Run one bucket press through the day view's own selection semantics. */
  private _selectBucket(key: string, mode: SlotSelectionMode) {
    this._bucketSelection = applySlotSelection({
      orderedSlots: this._orderedBuckets(),
      selection: this._bucketSelection,
      target: key,
      mode,
    });
  }

  /**
   * Pick a bucket from its pill.
   *
   * The column and its pill are two hit targets for one act, so a pill press is
   * a plain column press: it replaces the selection. A pill carries no modifier
   * keys of its own -- the chart is where a selection is built up and the
   * gutter is where it is emptied.
   */
  private _pickBucket(key: string) {
    this._selectBucket(key, "replace");
  }

  /**
   * Open a bucket: the view one level finer, showing the bucket that was
   * double-clicked.
   *
   * At M a column is a month, and the level below it is that month drawn as
   * days: exactly the span `D` would load, so `_showSpan` does it. At D a
   * column is a day, and the level below it is the day view at whatever width
   * the reader last had it -- `_slotMinutes` is untouched by the aggregate
   * stops, so it still holds that. Picking the bucket first is what makes the
   * arrival land on the double-clicked day: `_selectViewStop` reads the focus
   * bucket to decide which day a minutes stop opens, and clamps it into what
   * the day view can actually draw.
   *
   * The day view has no level below a slot, so a double-click there means
   * nothing and is never routed here.
   */
  private _openBucket(key: string) {
    if (this._viewMode === "year") {
      this._showSpan(key, "month");
      return;
    }
    if (this._viewMode === "month") {
      this._pickBucket(key);
      // A day the day view cannot draw is not opened at all. `_selectViewStop`
      // would clamp it into `_dayRange` and land somewhere else, which is the
      // right answer for the width toggle -- it names no column, so the nearest
      // day it can honour is what the reader asked for -- and the wrong one
      // here, where the reader named this day by pointing at it. The recorder
      // purges raw states from under the aggregates, so at D there are real
      // columns below the floor; picking the bucket still stands, and the panel
      // it opens is what that column has to say.
      if (!this._dayIsReachable(key)) return;
      this._selectViewStop({ mode: "day", minutes: this._slotMinutes });
    }
  }

  /** Whether the day view can draw a day at all: inside the range it reported. */
  private _dayIsReachable(dayKey: string): boolean {
    const floor = this._dayRange?.minDate ?? "";
    const horizon = this._dayRange?.maxDate ?? "";
    return (floor === "" || dayKey >= floor) && (horizon === "" || dayKey <= horizon);
  }

  /** The selected buckets, in the order the span draws them. */
  private _selectedBucketRows(rows: readonly SpanAggregateRow[]): SpanAggregateRow[] {
    const wanted = new Set(this._bucketSelection.selectedSlots);
    return rows.filter((row) => wanted.has(row.date));
  }

  /**
   * The selection in words: the bucket-key analogue of `formatSlotRange`.
   *
   * Adjacent buckets merge into one run, because a selection that reads
   * "3 Mar – 7 Mar" says what its sums are for where a list of five dates makes
   * the reader do the merging. A gap breaks the run and the runs are listed, so
   * the heading can never imply a bucket that is not selected. One bucket keeps
   * `_formatBucket`'s own wording -- a month is named as a month, not as its
   * first day.
   */
  private _formatBucketRange(keys: readonly string[]): string {
    if (keys.length === 1) return this._formatBucket(keys[0]);
    const ordered = this._orderedBuckets();
    const runs: Array<[string, string]> = [];
    let previousIndex: number | null = null;
    for (const key of keys) {
      const index = ordered.indexOf(key);
      const last = runs[runs.length - 1];
      if (last && previousIndex !== null && index !== -1 && index === previousIndex + 1) {
        last[1] = key;
      } else {
        runs.push([key, key]);
      }
      previousIndex = index === -1 ? null : index;
    }
    return runs
      .map(([start, end]) => (start === end
        ? this._formatBucket(start)
        : `${this._formatBucket(start)} – ${this._formatBucket(end)}`))
      .join(", ");
  }

  /**
   * Draw the card's one hover popup for an aggregate bucket.
   *
   * The same popup the day view uses, deliberately: the aggregate chart reports
   * which bucket and where the pointer is, and the rows are built here so both
   * views share one popup, one position rule and one set of styles. A bucket is
   * measured history with nothing to compare against, so `hasActual` is false
   * and each reading sits in the single guaranteed column -- the shape
   * `TooltipRow` already describes for a slot with only one vintage.
   */
  private _handleBucketHover = (event: CustomEvent<AggregateBucketHoverDetail>) => {
    event.stopPropagation();
    const { key, x, y } = event.detail;
    // Before either bail: the highlight is about which column the pointer is
    // over, and a bucket the span has no row for is still a column. Only the
    // popup needs the numbers.
    this._setHoveredBucket(key);
    if (key === null) {
      this._tooltip.hide();
      return;
    }
    const row = (this._span?.days ?? []).find((candidate) => candidate.date === key);
    if (!row) {
      this._tooltip.hide();
      return;
    }
    const kwhToWh = (value: number | null) => (value === null ? null : value * 1000);
    const cell = (wh: number | null, color: string): TooltipCell =>
      wh === null ? null : { value: formatWh(this._localize, wh), color };
    const measured = (label: string, wh: number | null, color: string): TooltipRow => ({
      label,
      actual: null,
      forecast: cell(wh, color),
    });
    const rows: TooltipRow[] = [
      measured(this._t("bias_correction.inspector.merged.solar"), row.solarWh, CHART_COLORS.corrected),
      measured(this._t("bias_correction.inspector.merged.house"), row.houseWh, CHART_COLORS.house),
      measured(this._t("bias_correction.inspector.grid_import"), kwhToWh(row.gridImportKwh), CHART_COLORS.gridImport),
      measured(this._t("bias_correction.inspector.grid_export"), kwhToWh(row.gridExportKwh), CHART_COLORS.gridExport),
      measured(this._t("bias_correction.inspector.battery_charge"), row.batteryChargeWh, CHART_COLORS.battery),
      measured(this._t("bias_correction.inspector.battery_discharge"), row.batteryDischargeWh, CHART_COLORS.battery),
    ].filter((candidate) => candidate.forecast !== null);
    // The popup says everything the three panels below it do, or hovering a
    // column would answer half the question and leave the reader to click for
    // the rest. The SoC range and the money are formatted rather than passed
    // through `formatWh`, so each carries its own unit.
    const socRange = formatSocRange([row]);
    if (socRange !== null) {
      rows.push({
        label: this._t("bias_correction.inspector.soc_range"),
        actual: null,
        forecast: { value: socRange, color: CHART_COLORS.battery },
      });
    }
    const money = spanMoney([row], [row.date]);
    if (money !== null) {
      const amount = (labelKey: string, value: number | null, color: string) => rows.push({
        label: this._t(`bias_correction.inspector.${labelKey}`),
        actual: null,
        forecast: { value: formatSpanMoney(value, currencyFromPriceUnit(this._span?.priceUnit)), color },
      });
      amount("import_cost", money.cost, CHART_COLORS.gridImport);
      amount("export_gain", money.gain, CHART_COLORS.gridExport);
      // The net too, or the popup stops one row short of the panel it claims to
      // repeat -- and the net is the figure a reader is usually after.
      amount("net_cost", money.net, CHART_COLORS.grid);
    }
    this._tooltip.showAt({ x, y }, { title: this._formatBucket(key), hasActual: false, rows }, event.currentTarget);
  };

  /**
   * Fetch the day view's payload unless it already holds the selected day.
   *
   * A minutes stop can arrive with `_selectedDate` already equal to the day it
   * wants, because span navigation moves it to a span start. Guarding on
   * `_selectedDate` therefore skips the load in exactly the case that needs it.
   * A mismatched date is not, on its own, a reason to skip the fetch this
   * method exists to issue -- `_renderBody` keeps drawing that payload, dimmed,
   * while the fetch is in flight, but the fetch still has to be asked for. The
   * payload's own date is the only thing that answers "does the day view have
   * what it needs".
   */
  private _ensureDayLoaded() {
    if (this._dayStale || this._payload?.date !== this._selectedDate) {
      this._load();
    }
  }

  /**
   * Derive everything the day view draws from, once per change of its inputs.
   *
   * Called from `willUpdate`, so the render only reads. Each step is keyed on
   * what that step actually reads -- the re-bucketing on the payload and the
   * slot width, the coverage marks on those plus the legend, the stacks on the
   * view and the legend, the axis on the stacks and the box they have to fit
   * in, the SoC columns on the view and the seam the stacks put the forecast
   * at -- so a resize does not re-bucket the day and a pointer report rebuilds
   * nothing at all.
   */
  private _rebuildDayModelIfNeeded(): void {
    const payload = this._viewMode === "day" ? this._drawablePayload() : null;
    if (payload === null) {
      this._view = null;
      this._stacks = null;
      this._layout = null;
      this._stripGeometry = null;
      this._socBarsModel = EMPTY_SOC_BARS;
      this._selectedMinutesModel = EMPTY_SELECTED_MINUTES;
      return;
    }

    const slot = this._slotMinutes;
    const hidden = this._hiddenSeries;
    // Visibility reads the allowlist as well as the legend, so every step
    // handed `hidden` is handed this too.
    const enabled = this.chartSeries;

    const view = this._viewOf(payload, slot);
    this._view = view;

    this._coverage = this._coverageOf(payload, slot, hidden, enabled);

    // "Nothing to draw" is a fact about the payload alone, so it is decided
    // here with the stacks rather than beside them in the render.
    const stacks = dayHasSeries(payload, this.houseFocus)
      ? this._stacksOf(view, slot, hidden, enabled)
      : null;
    this._stacks = stacks;

    if (stacks === null) {
      this._layout = null;
      this._stripGeometry = null;
    } else {
      this._layout = this._layoutOf(
        view, stacks, slot, this._chartWidth, this._daylightOnly, this.daylightThresholdW, hidden, enabled,
      );
      // One object per layout: the three strips compare it by identity, and a
      // fresh literal per render would re-render all three on every hover.
      this._stripGeometry = this._stripGeometryOf(this._layout);
    }

    // Off the seam the stacks put the forecast at, so the SoC columns turn
    // forecast where the stacks above turn hatched.
    this._socBarsModel = this._socBarsOf(view, hidden, enabled, stacks?.fillFromMinutes ?? Number.NEGATIVE_INFINITY);
    this._selectedMinutesModel = this._selectedMinutesOf(view, this._slotSelection.selectedSlots);
  }

  /** What the panels read off the card. */
  private _panelContext(): PanelContext {
    return {
      hass: this.hass,
      t: this._localize,
      isSeriesEnabled: (series) => this._isSeriesEnabled(series),
      isSeriesVisible: (series) => this._isSeriesVisible(series),
      toggleSeries: (series) => this._toggleSeries(series),
      toggleSeriesGroup: (series, visible) => this._toggleSeriesGroup(series, visible),
    };
  }

  /** Whether the config allows this series at all; see `isSeriesEnabled`. */
  private _isSeriesEnabled(series: SeriesKey) {
    return isSeriesEnabled(this.chartSeries, series);
  }

  /**
   * Whether the slot detail can still draw a house breakdown -- and with it the
   * device boxes whose schedule badges open the day editor. The same two series
   * the breakdown itself is gated on, named once so the two cannot drift.
   */
  private _houseBreakdownReachable() {
    return this._isSeriesEnabled("houseActual") || this._isSeriesEnabled("houseForecast");
  }

  /**
   * Whether anything on the card can still open the day editor: the band, or a
   * schedule badge on one of the device boxes a breakdown panel draws. The day
   * view's breakdown follows the house series; the aggregate views' does not,
   * because `chart_series` deliberately governs the day chart alone.
   */
  private _scheduleEditorReachable() {
    if (!this.hideScheduleStrip) return true;
    if (this._viewMode !== "day") return true;
    return this._houseBreakdownReachable();
  }

  private _isSeriesVisible(series: SeriesKey) {
    return isSeriesVisible(this._hiddenSeries, this.chartSeries, series);
  }

  private _toggleSeries(series: SeriesKey) {
    const next = new Set(this._hiddenSeries);
    if (!next.delete(series)) {
      next.add(series);
    }
    this._hiddenSeries = next;
  }

  /** Hide or show a merged card's series together, driven off its shown state. */
  private _toggleSeriesGroup(series: SeriesKey[], visible: boolean) {
    const next = new Set(this._hiddenSeries);
    for (const key of series) {
      if (visible) next.add(key);
      else next.delete(key);
    }
    this._hiddenSeries = next;
  }

  /** The schedule row under the charts: one track per entity. */
  private _renderScheduleActionsStrip(payload: InspectorPayload, layout: ChartLayout) {
    const executionLabel = this._t("scheduling.execution.toggle");
    const snapshot = this._scheduleSnapshot;
    return html`
      <div class="strip-section chart-separator">
        <div class="strip-header-row">
          ${this._renderScheduleHeaderHours(layout)}
          <span class="schedule-header-title">${this._t("bias_correction.inspector.scheduled_actions")}</span>
          <label class="execution-toggle">
            <span>${executionLabel}</span>
            <ha-switch
              .checked=${snapshot.schedule?.executionEnabled ?? false}
              ?disabled=${snapshot.schedule === null || snapshot.loading || snapshot.togglingExecution}
              aria-label=${executionLabel}
              @change=${this._handleToggleExecution}
            ></ha-switch>
          </label>
        </div>
        ${this._renderScheduleBand(payload, layout)}
      </div>
    `;
  }

  /** The schedule header repeats the chart axis's labelled ticks behind its controls. */
  private _renderScheduleHeaderHours(layout: ChartLayout) {
    return chartGridTicks(layout, this._slotMinutes).map((tick) => {
      if (tick.hour === null) return "";
      const left = (layout.xForMinutes(tick.minutes) / layout.width) * 100;
      return html`
        <span class="schedule-header-hour" aria-hidden="true" style=${`left: ${left}%`}>
          ${pad2(tick.hour)}
        </span>
      `;
    });
  }

  /**
   * Subscribe to the same schedule owner the scheduling card writes through, so
   * the execution switch here and the one there are one state, not two.
   */
  private _syncScheduleOwner(): void {
    const hass = this.hass;
    if (!hass) {
      return;
    }

    const owner = getSharedScheduleOwner(hass);
    if (this._scheduleOwner === owner) {
      this._applyScheduleSnapshot(owner.getSnapshot());
      return;
    }

    this._unsubscribeScheduleOwner?.();
    this._scheduleOwner = owner;
    this._unsubscribeScheduleOwner = owner.subscribe((snapshot) => this._applyScheduleSnapshot(snapshot));
  }

  /**
   * Take the owner's latest word. A clock tick hands back the same snapshot,
   * and the normalized model is the same object until the current slot or day
   * moves, so a tick that moved neither writes nothing reactive.
   */
  private _applyScheduleSnapshot(snapshot: ScheduleOwnerSnapshot): void {
    const previous = this._scheduleSnapshot;
    const scheduleChanged = snapshot.schedule !== previous.schedule;
    this._scheduleSnapshot = snapshot;
    if (!this.hideScheduleStrip && (
      scheduleChanged
      || snapshot.loading !== previous.loading
      || snapshot.togglingExecution !== previous.togglingExecution
    )) {
      this.requestUpdate();
    }
    this._renormalizeSchedule();
    if (scheduleChanged && snapshot.schedule !== null) {
      void this._loadForecast();
    }
  }

  /** The zone and locale the pills' schedule is normalized in. */
  private _normalizationKey(): string {
    return `${this._haTimeZone() ?? "UTC"}|${resolveLocale(this.hass)}`;
  }

  /** The schedule on the owner's clock, in the zone and locale the pills are drawn in. */
  private _renormalizeSchedule(): void {
    this._normalizedFor = this._normalizationKey();
    this._normalizedSchedule = this._scheduleOwner?.getNormalized(this._haTimeZone() ?? "UTC", resolveLocale(this.hass))
      ?? EMPTY_NORMALIZED_SCHEDULE;
  }

  /** The forecast, once the schedule has slots to draw it against. */
  private async _loadForecast(): Promise<void> {
    const hass = this.hass;
    if (!hass || !this._scheduleSnapshot.schedule?.slots?.length) {
      return;
    }
    const request = ++this._forecastRequest;
    try {
      const forecast = await this._forecastLoader.load(hass);
      if (request === this._forecastRequest && this.hass?.connection === hass.connection) {
        this._forecast = forecast;
      }
    } catch (error) {
      console.error("helman-solar-inspector: failed to load forecast", error);
    }
  }

  /**
   * Whichever view is on screen, asked for again -- and whatever is not, marked.
   *
   * Both ways in land here: the refresh button, which is a navigation and shows
   * itself (`silent` false), and the announced change, which must not disturb
   * the day the reader is on. What they share is the decision of *which* of the
   * three loads the card owns is worth a round trip. At D or M the day view is
   * not drawn, and asking for a full day of series, actuals and training so
   * that nothing can read it is the request this exists to stop; the day is
   * marked instead, and `_ensureDayLoaded` spends the request when the reader
   * comes back to it.
   *
   * Both request keys are cleared rather than left standing, because they
   * answer "is this the window we asked for" and the answer is still yes -- it
   * is the *contents* that moved. Without this the guard in `_loadSpan` reads
   * the announcement as nothing to do, which is exactly the case that needs the
   * fetch. The pills are keyed the same way and re-read on the next update, but
   * only where they are drawn: `willUpdate` asks that question already.
   */
  private _refreshActiveView(silent: boolean): void {
    this._spanRequest.reset();
    this._historyRequest.reset();
    if (this._viewMode === "day") {
      void this._load({ silent });
      return;
    }
    this._dayStale = true;
    void this._loadSpan(silent);
  }

  private _handleToggleExecution = (event: Event): void => {
    const target = event.currentTarget as unknown as { checked: boolean };
    void this._scheduleOwner?.setExecutionEnabled(target.checked);
  };

  private _renderScheduleBand(payload: InspectorPayload, layout: ChartLayout) {
    return html`
      <helman-solar-schedule-band-strip
        .hass=${this.hass}
        .editorHost=${this._editorHost}
        .date=${payload.date}
        .timeZone=${this._haTimeZone() ?? "UTC"}
        .slotMinutes=${this._slotMinutes}
        .geometry=${this._stripGeometry}
        .selectedMinutes=${this._selectedMinutesModel}
        .hoverMinutes=${this._hoveredMinutes}
        @slot-hover=${this._handleStripHover}
        @slot-tooltip=${this._handleScheduleTooltip}
      ></helman-solar-schedule-band-strip>
    `;
  }

  /** Store the hovered minute at whole-minute resolution, skipping redundant updates. */
  private _setHoverMinutes(minutes: number | null) {
    const next = minutes === null ? null : Math.round(minutes);
    if (this._hoveredMinutes === next) return;
    this._hoveredMinutes = next;
  }

  /**
   * Publish the minute under the pointer, in the popup's own frame.
   *
   * A mouse reports far more often than the screen repaints, and the rows
   * report the minute and the popup as two separate events on one move; both
   * land in the controller's next frame, as one update.
   */
  private _hover(minutes: number | null) {
    this._tooltip.inNextFrame(() => this._setHoverMinutes(minutes));
  }

  /** A popup some other element measured, at the viewport point it reported. */
  private _showReported(content: TooltipContent | null, anchor: EventTarget | null) {
    if (content === null) {
      this._tooltip.hide();
      return;
    }
    const { x, y, ...body } = content;
    this._tooltip.showAt({ x, y }, body, anchor);
  }

  /** A strip reported the minute under its pointer. */
  private _handleStripHover = (event: CustomEvent<{ minutes: number | null }>): void => {
    this._hover(event.detail?.minutes ?? null);
  };

  /**
   * The day chart's popup, shown off the pointer event it follows: a hover
   * shows it and a tap toggles it -- and the tap that closes it takes the
   * hover band with it.
   */
  private _handleChartTooltip = (event: CustomEvent<DayChartTooltipDetail | null>): void => {
    const detail = event.detail;
    if (detail === null) {
      this._tooltip.hide();
    } else if (!detail.tap) {
      this._tooltip.show(detail.event, detail.body);
    } else if (!this._tooltip.toggle(detail.event, detail.body)) {
      this._hover(null);
    }
  };

  /** A strip reported its own popup, already in the shared shape. */
  private _handleStripTooltip = (event: CustomEvent<TooltipContent | null>): void => {
    this._showReported(event.detail ?? null, event.currentTarget);
  };

  /**
   * The schedule band's own popup shape (one row per lane, no actual/forecast
   * duality) mapped onto the shared table -- always the forecast-only layout,
   * same as price's, with the tone class carrying the row's colour.
   */
  private _handleScheduleTooltip = (event: CustomEvent<ScheduleHoverTooltipContent | null>): void => {
    const content = event.detail ?? null;
    this._showReported(
      content === null
        ? null
        : {
            x: content.x,
            y: content.y,
            title: content.title,
            hasActual: false,
            rows: content.rows.map((row) => ({
              label: row.label,
              actual: null,
              forecast: { value: row.value, toneClass: row.toneClass },
            })),
          },
      event.currentTarget,
    );
  };

  /** The shared popup, its two columns captioned actual and forecast. */
  private _renderTooltip() {
    return this._tooltip.render(
      [this._t("bias_correction.inspector.column_actual"), this._t("bias_correction.inspector.column_forecast")],
    );
  }

  /** The two-rail price and money strips. */
  private _renderPriceStrip(payload: DayView) {
    return html`
      <div class="compact-strip-section chart-separator">
        <span class="compact-strip-label">${this._t("bias_correction.inspector.price_strip_compact")}</span>
        <helman-solar-price-strip
          .hass=${this.hass}
          .importColumns=${payload.importPriceColumns}
          .exportColumns=${payload.exportPriceColumns}
          .unit=${payload.priceUnit ?? ""}
          .date=${payload.date}
          .timeZone=${this._haTimeZone() ?? "UTC"}
          .selectedMinutes=${this._selectedMinutesModel}
          .geometry=${this._stripGeometry}
          .hoverMinutes=${this._hoveredMinutes}
          .slotMinutes=${this._slotMinutes}
          .nowMs=${this._nowMs}
          @slot-pick=${(event: CustomEvent<SlotPickDetail>) =>
            this._handleStripSlotPick(event)}
          @slot-hover=${this._handleStripHover}
          @slot-tooltip=${this._handleStripTooltip}
        ></helman-solar-price-strip>
      </div>
    `;
  }

  /** The money rails, split out so `hide_money_strip` can drop them alone. */
  private _renderMoneyStrip(payload: InspectorPayload) {
    return html`
      <div class="compact-strip-section chart-separator">
        <span class="compact-strip-label">${this._t("bias_correction.inspector.money_strip_compact")}</span>
        <helman-solar-money-strip
          .hass=${this.hass}
          .moneyActual=${payload.series.moneyActual}
          .moneyForecast=${payload.series.moneyForecast}
          .currency=${currencyFromPriceUnit(payload.priceUnit)}
          .date=${payload.date}
          .timeZone=${this._haTimeZone() ?? "UTC"}
          .selectedMinutes=${this._selectedMinutesModel}
          .geometry=${this._stripGeometry}
          .hoverMinutes=${this._hoveredMinutes}
          .slotMinutes=${this._slotMinutes}
          .nowMs=${this._nowMs}
          @slot-pick=${(event: CustomEvent<SlotPickDetail>) =>
            this._handleStripSlotPick(event)}
          @slot-hover=${this._handleStripHover}
          @slot-tooltip=${this._handleStripTooltip}
        ></helman-solar-money-strip>
      </div>
    `;
  }

  /** Resolve a strip click to the slot it lands in, or clear the selection. */
  private _handleStripSlotPick(event: CustomEvent<SlotPickDetail>) {
    const minutes = event.detail?.minutes ?? null;
    if (minutes === null) {
      this._deselectSlot();
      return;
    }
    this._selectSlot(
      this._slotLabelForMinutes(minutes),
      event.detail?.mode ?? "replace",
    );
  }

  /** The slot the detail panel and training table follow. */
  private get _selectedSlot(): string | null {
    return this._slotSelection.focusSlot;
  }

  /**
   * The day's impact slots in chronological order — the selection's universe.
   * Always on the active slot width, so a selection can never hold a slot the
   * charts aren't drawing.
   */
  /**
   * Every slot of the day, in chronological order. The day's grid, not a
   * summary of what happens to have data.
   *
   * Deliberately not derived from any series, though it once was. Impact is
   * built per *forecast* slot, and the forecast no longer necessarily spans the
   * day: it is read back from Helman's own recorded entity, so a restart at
   * noon leaves the morning without one. Selecting from impact made those slots
   * silently unclickable -- `applySlotSelection` drops a click on a slot it
   * does not recognise, so the selection just stayed put.
   *
   * Widening it to "impact plus actuals" fixed that case and left the rule
   * wrong: a slot is selectable because it is a slot of the day, not because
   * some series reaches it. A reader clicks a gap precisely to ask what is in
   * it, and the detail panel answers that honestly with dashes.
   */
  private _orderedSlots(_payload: InspectorPayload | null): string[] {
    const width = this._slotMinutes;
    if (!(width > 0)) return [];
    const slots: string[] = [];
    for (let minutes = 0; minutes < 24 * 60; minutes += width) {
      slots.push(minutesToSlot(minutes));
    }
    return slots;
  }

  private _selectSlot(
    slot: string,
    mode: SlotSelectionMode = "replace",
  ) {
    this._applySelection(applySlotSelection({
      orderedSlots: this._orderedSlots(null),
      selection: this._slotSelection,
      target: slot,
      mode,
    }));
  }

  private _deselectSlot() {
    this._applySelection(EMPTY_SLOT_SELECTION);
  }

  /** Commit a selection and re-derive everything that hangs off the focus slot. */
  private _applySelection(next: SlotSelectionState) {
    if (next === this._slotSelection) {
      return;
    }
    const focusChanged = next.focusSlot !== this._slotSelection.focusSlot;
    this._slotSelection = next;
    if (focusChanged) {
      this._selectedTrainingDate = next.focusSlot === null
        ? null
        : this._resolveSelectedTrainingDate(next.focusSlot);
      // The contribution table's open state is the reader's to keep: once it is
      // expanded, moving to another slot swaps the rows underneath rather than
      // folding it shut and making them re-open it every slot.
    }
  }

  /**
   * The selection, narrowed to slots of the day's own grid, in chronological
   * order.
   *
   * Narrowed against `_orderedSlots`, not `series.impact`: a slot belongs to the
   * day because the day has that slot, not because some series reaches it. Past
   * a few days back the forecast curve — and with it impact — is gone (the
   * recorded entity is purged), but the per-slot training contributions are
   * keyed by slot-of-day and are there for every date. Filtering on impact hid
   * the whole slot detail, the contribution table included, on exactly the days
   * a reader opens to see what a slot contributed to the fit.
   */
  private _selectedSlotsIn(_payload: InspectorPayload): string[] {
    const available = new Set(this._orderedSlots(null));
    return this._slotSelection.selectedSlots.filter((slot) => available.has(slot));
  }

  /**
   * The switch entities the house-composition panel draws a live badge for,
   * bubbled up so the card at the top can watch them. This is the inspector's
   * own contribution to the watch set — the ids come from the payload, not from
   * the schedule band — and without it, toggling one of these appliances
   * anywhere else in Home Assistant would leave its badge stale indefinitely.
   *
   * Taken from the *unfiltered* breakdown, not from the `wh > 0` subset
   * `renderHouseBreakdown` draws: the backend's consumer roster is built from
   * config and takes no date, so the unfiltered set is the same on every day,
   * while the rendered subset is not. Dispatching the rendered subset would make
   * the card's union grow as the user pages through days.
   */
  private _emitWatchedEntities(payload: InspectorPayload) {
    const ids = new Set<string>();
    for (const point of payload.series.houseActualBreakdown) {
      for (const appliance of point.appliances) {
        if (appliance.switchEntityId) ids.add(appliance.switchEntityId);
      }
    }
    dispatchWatchedEntities(this, "house-breakdown", [...ids]);
  }

  /**
   * Fetch the selected day.
   *
   * `silent` is the difference between a navigation and a background refresh.
   * A navigation is *asked for*: blanking the card and saying "loading" is the
   * honest answer, because what is drawn is about to be a different day. A
   * refresh is not asked for -- it happens because the backend re-planned --
   * so it must leave the day, the selection and the scroll position alone and
   * swap the payload underneath only once the new one has arrived.
   */
  private async _load(options: { silent?: boolean } = {}) {
    if (!this.hass) return;
    if (!this._selectedDate) {
      this._selectedDate = this._todayIso();
    }
    const silent = options.silent === true;
    const requestedDate = this._selectedDate;
    const request = this._dayRequest.begin(requestedDate);
    if (request === null) return;
    this._error = "";
    if (!silent) {
      // The previous payload is kept rather than nulled: `_renderBody` still
      // draws it, dimmed, under the loading overlay, instead of the card
      // collapsing and re-expanding around the request.
      this._loading = true;
    }
    try {
      const payload = await callHelman(this.hass, "helman/solar_bias/inspector", { date: requestedDate });
      if (this._dayRequest.isCurrent(request) && requestedDate === this._selectedDate) {
        // Cleared here rather than on the way out: a request dropped as a
        // duplicate or one that fails leaves the day owed, so returning to it
        // asks again instead of drawing what the announcement superseded.
        this._dayStale = false;
        this._payload = payload;
        this._emitWatchedEntities(payload);
        this._dayRange = payload.range;
        // A day drawn from hourly statistics has nothing finer to show, so the
        // width comes down to what the data is. Through `_setSlotMinutes` rather
        // than by assignment, so the selection is re-gridded onto the coarser
        // grid the same way a manual press does it -- otherwise a selection
        // carried in from a 15-minute day would point at slots this day has no
        // columns for.
        if (payloadGranularity(payload) > this._slotMinutes) {
          this._setSlotMinutes(payloadGranularity(payload));
        }
        const reconciled = reconcileSlotSelection(
          this._orderedSlots(null),
          this._slotSelection,
        );
        this._slotSelection = reconciled;
        this._selectedTrainingDate = this._resolveSelectedTrainingDate(
          reconciled.focusSlot,
          payload,
          requestedDate,
        );
      }
    } catch (err: any) {
      if (this._dayRequest.isCurrent(request) && requestedDate === this._selectedDate) {
        this._error = err?.message || this._t("bias_correction.inspector.load_failed");
      }
    } finally {
      if (this._dayRequest.isCurrent(request) && requestedDate === this._selectedDate) {
        this._loading = false;
        this._dayRequest.reset();
      }
      this.requestUpdate();
    }
  }

  /**
   * Fill the past days of a window with what was measured for them.
   *
   * The schedule and the forecast only reach forward, so without this every
   * pill of a past week would be a bare label — the row would be a picker and
   * stop being a comparison. One backend read covers the whole window: asking
   * for an inspector day per pill would be seven full days of actuals,
   * forecast history and training to end up with three numbers each.
   *
   * Keyed by the window, so paging is one request and clicking a pill inside
   * the week is none.
   */
  private async _loadDayAggregates(start: string, end: string) {
    // No connection yet: decide nothing, so the window is still fetched once
    // `hass` arrives. This is the one branch that must not stamp the key.
    if (!this.hass) {
      return;
    }
    // Never ask past today: nothing after it has been measured, so the days
    // beyond are always an empty answer. Clamping here rather than filtering the
    // reply is what makes the collapsed row one read instead of two -- its
    // window is today to the forecast's end, and it widens the moment the day
    // range lands, which under an unclamped key was a second request for the
    // same single measurable day.
    const floor = this._viewMode === "day" ? this._dayRange?.minDate : this._spanRange?.minDate;
    if (floor && start < floor) start = floor;
    const measuredEnd = end > this._todayKey ? this._todayKey : end;
    // The house focus asks for a field the plain pills do not, so it is part of
    // what the answer is for.
    const key = `${start}..${measuredEnd}${this.houseFocus ? ":house" : ""}`;
    const request = this._historyRequest.begin(key);
    if (request === null) return;
    this._historyDays = this._historyDays.filter((day) => day.dayKey >= start && day.dayKey <= end);
    if (start > measuredEnd) {
      // A window that begins after today has no measured days. Clearing keeps a
      // past week's measurements from lingering after paging forward again; Lit
      // drops the assignment on `===` once the constant is already in place.
      //
      // `>` and not `>=`: today itself has been measured up to now, and a
      // window that opens on it must fetch that. The collapsed row starts on
      // today and the expanded calendar starts on the 1st, so the stricter test
      // made today's own pill measured in one and forecast in the other --
      // dashed, solid, dashed as the picker opened and closed.
      this._historyDays = EMPTY_HISTORY_DAYS;
      return;
    }
    try {
      const result = await fetchDayAggregates(this.hass, {
        start_date: start,
        end_date: measuredEnd,
        ...(this.houseFocus ? { house_forecast: true } : {}),
      });
      if (!this._historyRequest.isCurrent(request)) {
        return;
      }
      this._historyDays = buildHistoryDaysFromAggregates((result?.days ?? []).filter((day) => day.date >= start && day.date <= measuredEnd));
    } catch {
      // Keep overlapping measurements available if the replacement read fails.
    }
    this.requestUpdate();
  }

  /**
   * A day pill was pressed. What that means depends on what the chart is
   * drawing, and in no case is it a change of granularity.
   *
   * At D the columns *are* these days, so the press is the column press: it
   * picks the bucket the panel describes, exactly as clicking the column does.
   * The only other view that draws this row is the day view, where there is no
   * column for a day and the press simply opens it.
   */
  private _handleDayPillSelect = (event: CustomEvent<DayPillSelectDetail>) => {
    event.stopPropagation();
    if (this._correlatedRow() === "day") {
      this._pickBucket(event.detail.date);
      return;
    }
    if (event.detail.date === this._selectedDate) {
      return;
    }
    this._calendarSelection = event.detail.date;
    this._selectedDate = event.detail.date;
    this._load();
  };

  private _selectTrainingDate(date: string) {
    this._selectedTrainingDate = date;
    if (date === this._selectedDate) {
      this.requestUpdate();
      return;
    }
    this._selectedDate = date;
    this._load();
  }

  private _syncChartResizeObserver() {
    // The aggregate chart's frame, or the day chart: either spans the card.
    const chartWrap = this.renderRoot.querySelector<HTMLElement>(".chart-wrap, helman-solar-day-chart");
    if (!chartWrap) {
      this._disconnectChartResizeObserver();
      return;
    }
    if (chartWrap === this._observedChartWrap) {
      return;
    }
    this._disconnectChartResizeObserver();
    this._observedChartWrap = chartWrap;
    this._chartResizeObserver = new ResizeObserver(() => this._updateChartWidth(chartWrap));
    this._chartResizeObserver.observe(chartWrap);
    this._updateChartWidth(chartWrap);
  }

  private _disconnectChartResizeObserver() {
    this._chartResizeObserver?.disconnect();
    this._chartResizeObserver = null;
    this._observedChartWrap = null;
  }

  private _updateChartWidth(chartWrap: HTMLElement) {
    // No floor: the viewBox is the card's width, so a unit is a pixel on every
    // row. A floored viewBox either spills past a narrow card or, squeezed to
    // fit under a fixed CSS height, letterboxes -- both break the stack's
    // one-hour-one-column alignment and gap the "now" line between rows.
    const width = Math.round(chartWrap.clientWidth || chartWrap.getBoundingClientRect().width);
    if (width > 0 && Math.abs(width - this._chartWidth) > 1) {
      this._chartWidth = width;
    }
  }

  private _resolveSelectedTrainingDate(
    slot: string | null,
    payload: InspectorPayload | null = this._payload,
    preferredDate: string | null = this._selectedDate,
  ) {
    const trainingSlot = findTrainingSlot(payload?.trainingExplainability ?? null, slot);
    return resolveSelectedTrainingDate(
      trainingSlot?.rows ?? [],
      preferredDate,
      this._selectedTrainingDate,
    );
  }

  /** Today's day key in the time zone this card reads dates in. See `shared/time/day-key`. */
  private _todayIso() {
    return todayKey(this._haTimeZone());
  }

  private _parseIsoDate(value: string): { year: number; month: number; day: number } {
    return navigationParseOrToday(value, this._todayIso());
  }

  private _formatDay(value: string) {
    const parsed = this._parseIsoDate(value);
    return new Date(
      Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12),
    ).toLocaleDateString(undefined, {
      timeZone: "UTC",
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  private _haTimeZone(): string | undefined {
    return this._payload?.timezone ?? this.hass?.config?.time_zone;
  }

  /**
   * The slot of the day a pointer minute falls in, as an `HH:MM` label.
   *
   * This used to snap to the nearest *impact* slot, which was invisible while
   * impact spanned every day whole. It does not any more -- impact is built per
   * forecast slot, and the forecast is read back from Helman's own recorded
   * entity, so a restart at noon leaves the morning without one. Snapping then
   * collapsed every morning click onto the first slot that had impact: clicking
   * 07:00, 08:00 or 09:00 all selected 09:30, which reads as "selection is
   * stuck on the current slot".
   *
   * A pointer minute already names its slot; nothing needs to be searched for.
   */
  private _slotLabelForMinutes(minutes: number): string {
    const width = this._slotMinutes > 0 ? this._slotMinutes : 15;
    const start = Math.floor(minutes / width) * width;
    return formatClock(start);
  }

  /** `_t` as a stable function reference, for components taking a localizer. */
  private _localize: LocalizeFunction = (key: string, values?: Record<string, string | number>) => this._t(key, values);

  private _t(key: string, values?: Record<string, string | number>): string {
    return (this.hass ? getLocalizeFunction(this.hass) : this._fallbackLocalize)(key, values);
  }

}

declare global {
  interface HTMLElementTagNameMap {
    "helman-solar-inspector": HelmanSolarInspector;
  }
}

if (!customElements.get("helman-solar-inspector")) {
  customElements.define("helman-solar-inspector", HelmanSolarInspector);
}
