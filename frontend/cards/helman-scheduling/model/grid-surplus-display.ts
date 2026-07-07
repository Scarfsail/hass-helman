export const GRID_SURPLUS_DISPLAY_ZERO_THRESHOLD_KWH = 0.05;

export interface ScheduleGridPositiveDisplay {
    kind: "export" | "surplus" | null;
    valueKwh: number;
}

export function getScheduleGridPositiveDisplay({
    exportKwh,
    availableSurplusKwh,
}: {
    exportKwh: number | null | undefined;
    availableSurplusKwh: number | null | undefined;
}): ScheduleGridPositiveDisplay {
    const normalizedExportKwh = _normalizePositiveDisplayValue(exportKwh);
    const normalizedAvailableSurplusKwh = _normalizePositiveDisplayValue(availableSurplusKwh);

    if (normalizedExportKwh === 0 && normalizedAvailableSurplusKwh > 0) {
        return {
            kind: "surplus",
            valueKwh: normalizedAvailableSurplusKwh,
        };
    }

    if (normalizedExportKwh > 0) {
        return {
            kind: "export",
            valueKwh: normalizedExportKwh,
        };
    }

    return {
        kind: null,
        valueKwh: 0,
    };
}

export function getScheduleGridScaleMagnitude({
    gridNetKwh,
    gridImportKwh,
    gridExportKwh,
    availableSurplusKwh,
}: {
    gridNetKwh: number | null | undefined;
    gridImportKwh: number | null | undefined;
    gridExportKwh: number | null | undefined;
    availableSurplusKwh: number | null | undefined;
}): number {
    const positiveDisplay = getScheduleGridPositiveDisplay({
        exportKwh: gridExportKwh,
        availableSurplusKwh,
    });

    return Math.max(
        Math.abs(gridNetKwh ?? 0),
        Math.abs(gridImportKwh ?? 0),
        positiveDisplay.valueKwh,
    );
}

function _normalizePositiveDisplayValue(value: number | null | undefined): number {
    if (value === null || value === undefined || Number.isFinite(value) === false || value <= 0) {
        return 0;
    }

    return Math.abs(value) < GRID_SURPLUS_DISPLAY_ZERO_THRESHOLD_KWH ? 0 : value;
}
