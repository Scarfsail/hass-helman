import "./device-report-ranking";
import "./device-report-over-time";

/**
 * The reports the card offers, one tab each, in tab order.
 *
 * The extension point: a report is a backend spec (`device_reports/reports.py`),
 * an entry here and an element that renders its payload. The element is handed
 * exactly `payload`, `query` and `localize`; the shell owns the period, the
 * granularity, the fetching and the freshness, so a report never does.
 */
export interface DeviceReportEntry {
    /** The backend registry key, sent as `report`. */
    id: string;
    /** The tab's label, as a translation key. */
    labelKey: string;
    /** The custom element that renders the payload. */
    tag: string;
    /** Bucketed by granularity: the shell offers the selector and sends it. */
    usesGranularity: boolean;
}

export const DEVICE_REPORTS: readonly DeviceReportEntry[] = Object.freeze([
    {
        id: "ranking",
        labelKey: "device_reports.ranking.title",
        tag: "helman-device-report-ranking",
        usesGranularity: false,
    },
    {
        id: "over_time",
        labelKey: "device_reports.over_time.title",
        tag: "helman-device-report-over-time",
        usesGranularity: true,
    },
]);
