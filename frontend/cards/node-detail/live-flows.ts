/** Below this many watts either way a flow counts as idle, on the card and in every detail. */
export const IDLE_W = 50;

/** What the live split reads: the card's own power figures, W. */
export interface LiveFlowInputs {
    solarPower: number;
    /** House consumption, never negative. */
    housePower: number;
    /** Battery power: positive charges, negative discharges. */
    batteryPower: number;
    /** The grid meter as the grid node carries it: positive imports. */
    gridPower: number;
}

/** The live power between the nodes, W, each zero or positive. */
export interface LiveFlows {
    solarToHouse: number;
    solarToBattery: number;
    solarToGrid: number;
    batteryToHouse: number;
    batteryToGrid: number;
    gridToHouse: number;
    gridToBattery: number;
    /**
     * The grid power the card shows: positive imports, negative exports. A
     * grid reading of ≈ 0 while solar or the battery clearly exports is
     * replaced by the export the balance implies.
     */
    gridPower: number;
}

/** Apply the house's currently measured source shares to a consumer without a source meter. */
export function estimatedConsumerMix(flows: LiveFlows | null | undefined, powerW: number | null): Array<{ node: "solar" | "battery" | "grid"; powerW: number }> {
    if (!flows || powerW === null || powerW <= IDLE_W) return [];
    const house = flows.solarToHouse + flows.batteryToHouse + flows.gridToHouse;
    if (house <= 0) return [];
    return ([
        ["solar", flows.solarToHouse],
        ["battery", flows.batteryToHouse],
        ["grid", flows.gridToHouse],
    ] as const).map(([node, watts]) => ({ node, powerW: powerW * watts / house }));
}

/**
 * How the live power splits between the nodes, as the card draws it.
 *
 * Solar export is inferred from the balance, so it does not depend on the
 * grid sensor's sign convention. Solar covers the house first and charges the
 * battery with what is left; a discharging battery covers the rest of the
 * house and exports any excess; the grid supplies what the house still lacks
 * and the battery charge solar did not cover. A flow at or below
 * {@link IDLE_W} counts as none.
 */
export function liveFlows({ solarPower, housePower, batteryPower, gridPower }: LiveFlowInputs): LiveFlows {
    const solarActive = solarPower > IDLE_W;
    const charging = batteryPower > IDLE_W;
    const discharging = batteryPower < -IDLE_W;

    const solarSurplus = Math.max(0, solarPower - housePower - Math.max(0, batteryPower));
    const solarToGrid = solarSurplus > IDLE_W ? solarSurplus : 0;
    const solarToHouse = solarActive ? Math.max(0, Math.min(solarPower - solarToGrid, housePower)) : 0;
    const solarToBattery = solarActive && charging
        ? Math.min(Math.max(0, solarPower - solarToHouse - solarToGrid), Math.max(0, batteryPower))
        : 0;

    const houseAfterSolar = Math.max(0, housePower - solarToHouse);
    const batteryToHouse = discharging ? Math.min(Math.abs(batteryPower), houseAfterSolar) : 0;
    const batteryToGrid = discharging ? Math.max(0, Math.abs(batteryPower) - batteryToHouse) : 0;

    const effectiveGridPower = Math.abs(gridPower) < 20 && (solarToGrid > 0 || batteryToGrid > IDLE_W)
        ? -(solarToGrid + batteryToGrid)
        : gridPower;

    const flow = (watts: number) => watts > IDLE_W ? watts : 0;
    return {
        solarToHouse: flow(solarToHouse),
        solarToBattery: flow(solarToBattery),
        solarToGrid,
        batteryToHouse: flow(batteryToHouse),
        batteryToGrid: flow(batteryToGrid),
        gridToHouse: flow(Math.max(0, housePower - solarToHouse - batteryToHouse)),
        gridToBattery: flow(charging ? Math.max(0, batteryPower - solarToBattery) : 0),
        gridPower: effectiveGridPower,
    };
}
