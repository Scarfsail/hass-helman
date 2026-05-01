export type InspectorPoint = { timestamp: string; valueWh: number };
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
export type TrainingSlotExplainability = {
  factor: number | null;
  rawRatio: number | null;
  clamped: boolean;
  forecastSumWh: number;
  actualSumWh: number;
  rows: ContributionRow[];
};
export type TrainingExplainability = {
  trainedAt: string;
  aggregationMethod: string;
  slots: Record<string, TrainingSlotExplainability>;
};

export function chooseDefaultImpactSlot(impacts: ImpactPoint[]): string | null {
  let selected: ImpactPoint | null = null;
  for (const point of impacts) {
    if (point.impactWh === null || !Number.isFinite(point.impactWh)) continue;
    if (
      selected === null ||
      Math.abs(point.impactWh) > Math.abs(selected.impactWh ?? 0)
    ) {
      selected = point;
    }
  }
  return selected?.slot ?? null;
}

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
  return chooseDefaultImpactSlot(impacts);
}

export function findImpactForSlot(
  impacts: ImpactPoint[],
  slot: string | null,
): ImpactPoint | null {
  if (!slot) return null;
  return impacts.find((point) => point.slot === slot) ?? null;
}

export function findPointForSlot(
  points: InspectorPoint[],
  slot: string | null,
): InspectorPoint | null {
  if (!slot) return null;
  return points.find((point) => point.timestamp.slice(11, 16) === slot) ?? null;
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
