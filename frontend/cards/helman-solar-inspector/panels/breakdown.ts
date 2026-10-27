import { html } from "lit";
import { TreeItem } from "../../shared/data/tree-item";
import type { BucketSourceMix } from "../../shared/power-history-bars";
import { SLOT_MINUTES } from "../chart-stack";
import type { InspectorPayload } from "../inspector-day-model";
import {
  applianceKey,
  consumerBarsOverSlots,
  expandSlotsToNative,
  houseSourceMixBySlot,
  partBarsOverSlots,
  sumWhOverSlots,
} from "../slot-aggregation.js";
import type { ApplianceComponent, HouseBreakdownPoint } from "../solar-inspector-model.js";
import type { PanelContext } from "./metrics";

/**
 * The composition panels' group nodes, keyed per panel and per group, kept by
 * the card across renders so their expanded state survives picking another
 * slot. See `breakdownGroup`.
 */
export type BreakdownGroups = Map<string, TreeItem>;

/**
 * The house demand for the selected slot split into each named part plus the
 * remainder, so the single house figure above reads as a sum. Every row carries
 * a proportion bar sized to its share of the slot total, and the parts reconcile
 * with the house value by construction. Rendered only when the backend supplied
 * a breakdown, so a bare house figure simply stands alone.
 *
 * One renderer, both sides of now — the two series share a shape precisely so
 * they can share it. `variant` picks which house the panel is about: `"actual"`
 * itemises the metered consumers against the measured house, `"forecast"` the
 * scheduled appliances against the forecast one, each reading its own source
 * mix so a future slot's bars are coloured by the forecast supply rather than by
 * measurements that do not exist yet. Their remainders differ in kind and so are
 * named apart: what no meter accounted for, against the base load.
 *
 * `native` is the payload as served, not the slot-collapsed view: the bars read
 * off the backend's 15-minute grid.
 */
export function renderHouseBreakdown(
  ctx: PanelContext,
  groups: BreakdownGroups,
  breakdown: HouseBreakdownPoint | null,
  slots: readonly string[],
  variant: "actual" | "forecast",
  native: InspectorPayload["series"],
  slotMinutes: number,
) {
  if (!breakdown) return "";
  const forecast = variant === "forecast";
  // Bars read off the backend's native 15-minute grid rather than the width the
  // chart is drawn at, so selecting one hour shows the four samples inside it —
  // the shape of the consumption, not a single flat block.
  const barSlots = expandSlotsToNative(slots, slotMinutes);
  // How the house was fed in each of those samples, shared by every consumer:
  // the mix is a house-level property, so it is derived once and then rescaled
  // per consumer rather than recomputed box by box.
  const mixes = houseSourceMixBySlot(
    forecast
      ? {
          houseActual: native.houseForecast,
          gridActual: native.gridForecast,
          batteryActual: native.batteryForecast,
        }
      : native,
    barSlots,
  );
  const breakdownSeries = forecast
    ? native.houseForecastBreakdown
    : native.houseActualBreakdown;
  return renderBreakdownPanel(ctx, groups, {
    breakdown,
    barSlots,
    breakdownSeries,
    mixes,
    variant,
    barSeconds: SLOT_MINUTES * 60,
    // The forecast's remainder is the residual against the house forecast the
    // panel sits under, not the composed base alone. At the native width the
    // two are the same number — every slot the forecast covers now carries a
    // composition summing to it — but a wide bucket straddling elapsed slots
    // is only partly covered, and the residual is what keeps the parts summing
    // to the figure printed above them there.
    unmeasuredFor: forecast
      ? (itemised) =>
          Math.max(0, (sumWhOverSlots(native.houseForecast, barSlots) ?? 0) - itemised)
      : null,
  });
}

/**
 * The panel itself, over whatever buckets its caller keys the breakdown by.
 *
 * Everything above this is granularity-specific — which slots the bars are
 * drawn over, which series they come from, and how the house was fed in each —
 * and everything below is not, which is why the aggregate views reuse it
 * rather than growing a second panel that would drift from this one. `slot` is
 * an opaque key throughout: a native `"HH:MM"` in the day view, a bucket date
 * at D and M.
 *
 * `unmeasuredFor` overrides the remainder for a caller whose composed base
 * does not already reconcile with the figure printed above the boxes; a null
 * override takes the breakdown's own.
 */
export function renderBreakdownPanel(
  ctx: PanelContext,
  groups: BreakdownGroups,
  options: {
    breakdown: HouseBreakdownPoint;
    barSlots: readonly string[];
    breakdownSeries: readonly HouseBreakdownPoint[];
    mixes: Map<string, BucketSourceMix>;
    variant: "actual" | "forecast";
    barSeconds: number;
    unmeasuredFor: ((itemisedWh: number) => number) | null;
  },
) {
  const {
    breakdown,
    barSlots,
    breakdownSeries,
    mixes,
    variant,
    barSeconds,
    unmeasuredFor,
  } = options;
  const forecast = variant === "forecast";
  // Every box reads the same series over the same samples; only which part it
  // asks for differs.
  const barsFor = (part: ApplianceComponent | null | undefined) =>
    consumerBarsOverSlots(breakdownSeries, barSlots, part, mixes);

  const consumers = breakdown.appliances.filter(
    (appliance) => Number.isFinite(appliance.wh) && appliance.wh > 0,
  );
  // What no meter claimed. This is deliberately not the forecast's
  // non-deferrable base load — it is the same idea as the power card's
  // "unmeasured" node, so it reads that node's very label. Like the
  // consumer boxes it is dropped when it carries nothing, so an empty slot — or
  // one whose whole demand is metered — shows no dead box.
  //
  const composedBase = Number.isFinite(breakdown.unmeasuredWh) ? breakdown.unmeasuredWh : 0;
  const unmeasuredWh = unmeasuredFor
    ? unmeasuredFor(consumers.reduce((sum, c) => sum + c.wh, 0))
    : composedBase;
  const total = consumers.reduce((sum, c) => sum + c.wh, 0) + Math.max(0, unmeasuredWh);
  if (total <= 0) return "";

  const consumerNodes: TreeItem[] = consumers.map((appliance) =>
    breakdownNode(
      appliance.entityId,
      appliance.label,
      appliance.wh,
      appliance.switchEntityId ?? null,
      appliance.powerEntityId ?? null,
      false,
      barsFor(appliance),
      appliance.deferrable,
      appliance.controllableIds ?? [],
      // The identity the rows were merged and the bars drawn by, so four
      // scheduled air conditioners behind one meter stay four distinct nodes
      // rather than colliding on the entityId they share.
      applianceKey(appliance),
    ),
  );
  if (unmeasuredWh > 0) {
    consumerNodes.push(
      breakdownNode(
        null,
        forecast
          ? ctx.t("bias_correction.inspector.house_base_load")
          : ctx.t("house_section.unmeasured"),
        unmeasuredWh,
        null,
        null,
        true,
        barsFor(null),
      ),
    );
  }
  // Ranked heaviest first so the slot's dominant load reads at a glance. The
  // remainder sorts by size like any other box rather than being pinned last,
  // or a large unmetered block would sit below trivial named ones. Groups sort
  // their own children the same way, one level down.
  consumerNodes.sort((a, b) => (b.powerValue ?? 0) - (a.powerValue ?? 0));

  // The two groups the panel actually lists. What is shiftable is the question
  // the whole feature is about, so it is the axis the rows are filed under
  // rather than something the eye has to reassemble from colours; the
  // remainder is not shiftable and so files under the base, whichever kind of
  // remainder this panel's is.
  const nodes = [
    breakdownGroup(
      ctx,
      groups,
      variant,
      "base",
      consumerNodes.filter((node) => !node.deferrable),
      partBarsOverSlots(breakdownSeries, barSlots, mixes, (point) =>
        point.appliances.reduce((sum, a) => (a.deferrable ? sum : sum + a.wh), 0) +
        point.unmeasuredWh,
      ),
    ),
    breakdownGroup(
      ctx,
      groups,
      variant,
      "deferrable",
      consumerNodes.filter((node) => node.deferrable),
      partBarsOverSlots(breakdownSeries, barSlots, mixes, (point) =>
        point.appliances.reduce((sum, a) => (a.deferrable ? sum + a.wh : sum), 0),
      ),
    ),
    // A group with nothing in it is not a story about this slot, it is an empty
    // box; a day with nothing shiftable keeps the single list it always had.
  ].filter((group) => group.children.length > 0);

  // The house's own per-sample energy. Handing it down as the parent scales
  // every box's bars against the house exactly as the power card scales a child
  // against its parent, and gives each box its share-of-parent figure.
  const houseBars = barsFor(undefined);

  return html`
    <!-- No more-info handler here: helman-tree-item already turns its children's
         show-more-info into the hass-more-info request HA listens for when an item
         has no deviceKey, while an item with a deviceKey emits show-device-detail
         which bubbles to the inspector host. Re-handling show-more-info here would
         open every dialog twice. -->
    <div class="house-breakdown">
      <div class="house-breakdown-title">
        ${ctx.t(
          forecast
            ? "bias_correction.inspector.house_composition_forecast"
            : "bias_correction.inspector.house_composition",
        )}
      </div>
      <helman-tree-item-list
        .hass=${ctx.hass}
        .devices=${nodes}
        .currentParentPower=${total}
        .parentPowerHistory=${houseBars.values}
        .historyBuckets=${barSlots.length}
        .historyBucketDuration=${barSeconds}
        .devices_full_width=${true}
      ></helman-tree-item-list>
    </div>
  `;
}

/**
 * One of the panel's two groups, as the power card draws a virtual group: a
 * node whose children are the boxes, collapsed until asked.
 *
 * The node object is cached and refilled rather than rebuilt, because that is
 * where the expanded state lives — `helman-tree-item` toggles `childrenCollapsed`
 * on the node it was handed, so a group rebuilt per selection would snap shut
 * every time the user picked another slot. Cached per panel and per group, the
 * state outlives the selection exactly as the user left it.
 *
 * The group carries the sum of its children and their summed bars, so the
 * collapsed row still says how much of the slot the group accounts for and
 * what fed it.
 */
function breakdownGroup(
  ctx: PanelContext,
  groups: BreakdownGroups,
  variant: "actual" | "forecast",
  kind: "base" | "deferrable",
  children: TreeItem[],
  bars: ReturnType<typeof partBarsOverSlots>,
): TreeItem {
  const id = `house-breakdown:${variant}:${kind}`;
  let node = groups.get(id);
  if (!node) {
    node = new TreeItem(id, "", null, null, bars.values.length);
    node.children_full_width = true;
    // Collapsed until the user says otherwise, like every group the power card
    // draws: the panel's job at a glance is the two totals, not the roster.
    node.childrenCollapsed = true;
    groups.set(id, node);
  }
  node.name = ctx.t(
    kind === "deferrable"
      ? "bias_correction.inspector.house_group_deferrable"
      : "bias_correction.inspector.house_group_base",
  );
  node.displayName = node.name;
  node.deferrable = kind === "deferrable";
  node.valueKind = "energy";
  node.historyBuckets = bars.values.length;
  node.children = children;
  node.powerValue = children.reduce((sum, child) => sum + (child.powerValue ?? 0), 0);
  node.powerHistory = bars.values;
  node.sourcePowerHistory = bars.sourceHistory.map((mix) => mix ?? {});
  return node;
}

/**
 * One breakdown consumer as a power-card device node.
 *
 * The node carries no `sourceType`, so it draws no glow of its own and inherits
 * the house tint the panel sets — the same way the power card's own house
 * children do — unless it is deferrable, in which case it paints itself in the
 * lighter house shade instead and carries a tag naming it.
 *
 * Clicking the box opens the device's live power (W) sensor — the very entity
 * the power card reads — falling back to the energy stat only where the tree
 * resolved no power sensor; the unmetered remainder has neither and so stays
 * inert, exactly as it did before.
 */
function breakdownNode(
  entityId: string | null,
  label: string,
  wh: number,
  switchEntityId: string | null,
  powerEntityId: string | null,
  isUnmeasured: boolean,
  bars: ReturnType<typeof consumerBarsOverSlots>,
  deferrable: boolean = false,
  controllableIds: string[] = [],
  nodeId: string | null = null,
): TreeItem {
  // A scheduled appliance with no meter has no entity to key on and none to
  // open: it is named by its controllable, so the label is the only identity
  // there is, and the box gets no sensor rather than a dialog for an entity
  // that does not exist. A consumer passes the key its rows were merged by as
  // `nodeId`, which already folds all of that in.
  const node = new TreeItem(
    nodeId ?? entityId ?? (isUnmeasured ? "house-unmeasured" : label),
    label,
    powerEntityId ?? entityId,
    switchEntityId,
    bars.values.length,
  );
  node.displayName = label;
  node.isUnmeasured = isUnmeasured;
  // Shiftable load is marked twice over: the box takes the shared lighter house
  // shade and the card's badge channel names the shade, so the colour is not the
  // only thing carrying the meaning. Both follow from this one flag — helman-tree-item
  // paints it, helman-tree-item-info tags it — for every card that draws these boxes.
  node.deferrable = deferrable;
  // What the badge on the box asks the schedule about. The energy stat above
  // cannot stand in for it: it is a meter, not the key assignments are stored
  // under, and a scheduled appliance may have no meter at all.
  node.controllableIds = controllableIds;
  // The device this box is, for its detail dialog: the same identity
  // applianceKey keys the box by, minus the label fallback, so a scheduled
  // appliance with neither a single controllable nor a meter, and the
  // unmeasured remainder, open nothing.
  node.energyEntityId = entityId ?? undefined;
  node.deviceKey = controllableIds.length === 1 ? controllableIds[0] : entityId ?? undefined;
  node.deviceKeyIsMeter = controllableIds.length !== 1 && !!entityId;
  // Energy throughout — the selection's total on the box, each sample's own on
  // the bars — so the figures are the Wh the breakdown actually reports and no
  // unit conversion sits between the data and what is drawn.
  node.valueKind = "energy";
  node.powerValue = wh;
  node.powerHistory = bars.values;
  node.sourcePowerHistory = bars.sourceHistory.map((mix) => mix ?? {});
  node.hideChildren = true;
  node.hideChildrenIndicator = true;
  return node;
}
