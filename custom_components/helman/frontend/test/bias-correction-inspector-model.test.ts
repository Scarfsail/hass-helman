import {
  chooseDefaultImpactSlot,
  findImpactForSlot,
  findPointForSlot,
  findTrainingSlot,
  resolveSelectedImpactSlot,
  type InspectorPoint,
  type ImpactPoint,
  type TrainingExplainability,
} from "../src/bias-correction-inspector-model.js";

function assertEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
  }
}

const impacts: ImpactPoint[] = [
  { slot: "08:00", rawWh: 100, correctedWh: 150, impactWh: 50, factor: 1.5 },
  { slot: "09:00", rawWh: 200, correctedWh: 80, impactWh: -120, factor: 0.4 },
];

assertEqual(chooseDefaultImpactSlot(impacts), "09:00");
assertEqual(resolveSelectedImpactSlot(impacts, "08:00"), "08:00");
assertEqual(resolveSelectedImpactSlot(impacts, "10:00"), "09:00");
assertEqual(resolveSelectedImpactSlot(impacts, null), "09:00");
assertEqual(findImpactForSlot(impacts, "08:00")?.impactWh, 50);
assertEqual(findImpactForSlot(impacts, "10:00"), null);

const points: InspectorPoint[] = [
  { timestamp: "2026-04-25T08:00:00+02:00", valueWh: 123 },
];

assertEqual(findPointForSlot(points, "08:00")?.valueWh, 123);
assertEqual(findPointForSlot(points, "09:00"), null);

const explainability: TrainingExplainability = {
  trainedAt: "2026-04-25T03:00:00+02:00",
  aggregationMethod: "ratio_of_sums",
  slots: {
    "08:00": {
      factor: 1.5,
      rawRatio: 1.5,
      clamped: false,
      forecastSumWh: 100,
      actualSumWh: 150,
      rows: [],
    },
  },
};

assertEqual(findTrainingSlot(explainability, "08:00")?.factor, 1.5);
assertEqual(findTrainingSlot(explainability, "09:00"), null);
assertEqual(findTrainingSlot(null, "08:00"), null);
