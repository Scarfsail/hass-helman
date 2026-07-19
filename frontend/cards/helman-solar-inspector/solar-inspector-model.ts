export type InspectorPoint = { timestamp: string; valueWh: number };
export type ApplianceComponent = {
  entityId: string;
  label: string;
  wh: number;
  /** The device's controlling switch, where the power card knows one. */
  switchEntityId: string | null;
};
export type HouseBreakdownPoint = {
  slot: string;
  unmeasuredWh: number;
  appliances: ApplianceComponent[];
};
export type FactorPoint = { slot: string; factor: number };
export type ImpactPoint = {
  slot: string;
  rawWh: number | null;
  correctedWh: number | null;
  impactWh: number | null;
  factor: number | null;
};
export type ContributionRow = {
  date: string;
  forecastWh: number | null;
  actualWh: number | null;
  ratio: number | null;
  status: string;
  reason: string | null;
};
export type InterpolationAnchors = {
  left: string | null;
  right: string | null;
};
export type TrainingSlotExplainability = {
  factor: number | null;
  rawRatio: number | null;
  clamped: boolean;
  forecastSumWh: number;
  actualSumWh: number;
  rows: ContributionRow[];
  interpolated?: boolean;
  interpolationAnchors?: InterpolationAnchors | null;
};
export type TrainingExplainability = {
  trainedAt: string;
  aggregationMethod: string;
  slots: Record<string, TrainingSlotExplainability>;
};

export function resolveSelectedImpactSlot(
  impacts: ImpactPoint[],
  selectedSlot: string | null,
): string | null {
  if (
    selectedSlot &&
    impacts.some((point) => point.slot === selectedSlot)
  ) {
    return selectedSlot;
  }
  return null;
}

export function findTrainingSlot(
  explainability: TrainingExplainability | null,
  slot: string | null,
): TrainingSlotExplainability | null {
  if (!explainability || !slot) return null;
  return explainability.slots[slot] ?? null;
}

export function resolveSelectedTrainingDate(
  rows: ContributionRow[],
  preferredDate: string | null,
  selectedTrainingDate: string | null,
): string | null {
  if (
    preferredDate &&
    rows.some((row) => row.date === preferredDate)
  ) {
    return preferredDate;
  }
  if (
    selectedTrainingDate &&
    rows.some((row) => row.date === selectedTrainingDate)
  ) {
    return selectedTrainingDate;
  }
  return null;
}

export type BatterySocPoint = { slot: string; pct: number };

