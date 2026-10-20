import { expect, test } from "@playwright/test";
import { forecastPayload } from "./support/payload-builders";
import { buildSlotForecastProjection } from "../cards/shared/schedule/model/slot-forecast-model";
import type { ScheduleDisplaySlot } from "../cards/shared/schedule/schedule-types";

const start = Date.parse("2026-01-01T00:00:00Z");
const quarter = 15 * 60_000;
const at = (index: number) => new Date(start + index * quarter).toISOString();
const slot = (index: number, quarters = 1): ScheduleDisplaySlot => ({
    id: at(index), startMs: start + index * quarter,
    endMs: start + (index + quarters) * quarter, dayKey: "2026-01-01",
    timeLabel: "", endLabel: null, rangeLabel: "", isCurrent: false,
    source: "forecast_only", scheduleSlot: null,
});

test("preserves hourly and quarter-hour forecast values through a feed gap", () => {
    const defaults = forecastPayload();
    const forecast = forecastPayload({
        battery_capacity: {
            ...defaults.battery_capacity, status: "partial", currentSoc: 49,
            actualHistory: [{ timestamp: at(0), startSocPct: 40, socPct: 41 }],
            series: [{ timestamp: at(4), durationHours: 0.25, solarKwh: 0,
                baselineHouseKwh: 0, netKwh: 0, chargedKwh: 0,
                dischargedKwh: 0, remainingEnergyKwh: 0, socPct: 55,
                importedFromGridKwh: 0, exportedToGridKwh: 0,
                hitMinSoc: false, hitMaxSoc: false, limitedByChargePower: false,
                limitedByDischargePower: false }],
        },
        solar: {
            ...defaults.solar, status: "available",
            actualHistory: [{ timestamp: at(0), value: 8 }],
            points: [{ timestamp: at(4), value: 10 }],
            adjustedPoints: [{ timestamp: at(4), value: 12 }],
        },
        grid: {
            ...defaults.grid, status: "available", currentExportPrice: 1.5,
            exportPriceUnit: "CZK/kWh",
            exportPricePoints: [{ timestamp: at(0), value: 1 }, { timestamp: at(4), value: 2 }],
            series: [
                { timestamp: at(0), durationHours: 1, importedFromGridKwh: 4,
                    exportedToGridKwh: 2, availableSurplusKwh: 3 },
                { timestamp: at(4), durationHours: 0.25, importedFromGridKwh: 0,
                    exportedToGridKwh: 0.5 },
            ],
        },
    });

    const quarters = buildSlotForecastProjection(forecast, [slot(0), slot(1), slot(4), slot(5)]);
    expect(quarters.points.get(at(0))).toEqual({ socPct: 41, solarWh: 8,
        gridNetKwh: -0.5, gridImportKwh: 1, gridExportKwh: 0.5,
        availableSurplusKwh: 0.75, price: 1 });
    expect(quarters.points.get(at(1))?.price).toBeNull();
    expect(quarters.points.get(at(4))).toEqual({ socPct: 55, solarWh: 12,
        gridNetKwh: 0.5, gridImportKwh: 0, gridExportKwh: 0.5,
        availableSurplusKwh: null, price: 2 });
    expect(quarters.points.get(at(5))).toEqual({ socPct: null, solarWh: null,
        gridNetKwh: null, gridImportKwh: null, gridExportKwh: null,
        availableSurplusKwh: null, price: null });
    expect(quarters.solarMaxWh).toBe(12);
    expect(quarters.gridMaxAbsKwh).toBe(1);
    expect(quarters.priceMaxAbs).toBe(2);
    expect(quarters.priceDisplayUnit).toBe("CZK/kWh");
    expect([quarters.batteryAvailable, quarters.solarAvailable,
        quarters.gridAvailable, quarters.priceAvailable]).toEqual([true, true, true, true]);

    const hourly = buildSlotForecastProjection(forecast, [slot(0, 4), slot(4, 4)]);
    expect(hourly.points.get(at(0))?.gridImportKwh).toBe(4);
    expect(hourly.points.get(at(0))?.gridExportKwh).toBe(2);
    expect(hourly.points.get(at(0))?.availableSurplusKwh).toBe(3);
    expect(hourly.points.get(at(4))?.gridExportKwh).toBe(0.5);
    expect(hourly.gridMaxAbsKwh).toBe(4);
});
