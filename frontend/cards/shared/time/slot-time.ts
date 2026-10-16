export function pad2(value: number | string): string {
    return String(value).padStart(2, "0");
}

export const DEFAULT_SLOT_MINUTES = 15;
export const SLOT_MS = DEFAULT_SLOT_MINUTES * 60_000;

/** A complete HH:MM clock within a day; range-end 24:00 is formatting only. */
export function slotMinutes(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

export function minutesToSlot(minutes: number): string {
    const value = Math.max(0, Math.floor(minutes));
    return `${pad2(Math.floor(value / 60))}:${pad2(value % 60)}`;
}

export function formatClock(minutes: number, { endOfDay = "24:00" }: { endOfDay?: "24:00" | "00:00" } = {}): string {
    const value = Math.max(0, Math.min(1440, Math.round(minutes)));
    return value === 1440 ? endOfDay : minutesToSlot(value);
}

export function timestampMinutes(timestamp: string): number | null {
    const match = /T(\d{2}:\d{2})/.exec(timestamp);
    return match ? slotMinutes(match[1]) : null;
}

/** The HH:MM key shared by timestamped series and time-of-day slots. */
export function slotKey(timestamp: string): string {
    return timestamp.slice(11, 16);
}
