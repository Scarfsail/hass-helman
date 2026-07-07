export type ForecastPriceToneClass = "price-positive" | "price-negative" | "price-neutral";

const CONSUMER_COLOR_PERCENTS = [95, 70, 50, 35] as const;

export function formatForecastDayLabel({
    dayKey,
    isToday,
    isTomorrow,
    locale,
    todayLabel,
    tomorrowLabel,
}: {
    dayKey: string;
    isToday: boolean;
    isTomorrow: boolean;
    locale: string;
    todayLabel: string;
    tomorrowLabel: string;
}): string {
    if (isToday) {
        return todayLabel;
    }

    if (isTomorrow) {
        return tomorrowLabel;
    }

    return new Date(`${dayKey}T00:00:00Z`).toLocaleDateString(locale, {
        timeZone: "UTC",
        weekday: "short",
        day: "numeric",
        month: "numeric",
    });
}

export function formatForecastHour(
    timestamp: string,
    locale: string,
    timeZone: string,
): string {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
        return timestamp;
    }

    return date.toLocaleTimeString(locale, {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function formatForecastHourRange(
    startTimestamp: string,
    endTimestamp: string,
    locale: string,
    timeZone: string,
): string {
    return `${formatForecastHour(startTimestamp, locale, timeZone)}–${formatForecastHour(endTimestamp, locale, timeZone)}`;
}

export function getForecastPriceToneClass(value: number): ForecastPriceToneClass {
    if (value > 0) {
        return "price-positive";
    }

    if (value < 0) {
        return "price-negative";
    }

    return "price-neutral";
}

export function getForecastConsumerColorMix(index: number): string {
    const pct = CONSUMER_COLOR_PERCENTS[index % CONSUMER_COLOR_PERCENTS.length];
    return `color-mix(in srgb, var(--primary-color) ${pct}%, transparent)`;
}
