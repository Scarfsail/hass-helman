import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { ForecastHealthDTO, ForecastPayload } from "../helman-api";
import type { LocalizeFunction } from "../localize/localize";

/**
 * The one warning strip a card shows when the data behind it is not healthy.
 *
 * Forecast reads never rebuild anything: the backend serves its last snapshot
 * however old it is, because an aging forecast is old rather than wrong and
 * blanking a card is worse than showing good data with a warning. That makes a
 * broken refresh loop invisible — this strip is the entire signal that it is
 * broken, which is why it names *which* half went quiet and *how* long ago it
 * last succeeded rather than just saying "stale".
 *
 * It renders nothing at all while everything is healthy, so a card can mount it
 * unconditionally and never pay a pixel for it.
 *
 * Deliberately knows nothing about forecasts specifically: it takes a list of
 * already-named health blocks, so the same strip carries any other health
 * signal a card grows.
 */

/** One thing whose health is being reported, named for the user. */
export interface ForecastHealthItem {
    /** Localized name of what this is about, e.g. "Solar forecast". */
    label: string;
    health?: ForecastHealthDTO | null;
}

/**
 * The wording for a health block.
 *
 * Keyed off `reason` — a stable machine string — the same way schedule errors
 * are keyed off their `code`, so the strip reads in the user's language. The
 * backend's own `hint` is English prose and serves only as the fallback for a
 * reason this frontend has not been taught yet.
 */
function healthMessage(health: ForecastHealthDTO, localize: LocalizeFunction): string {
    switch (health.reason) {
        case "stale_forecast":
            return localize("forecast_health.reason.stale_forecast");
        default: {
            const hint = health.hint?.trim();
            return hint ? hint : localize("forecast_health.reason.unknown");
        }
    }
}

/** How long ago the snapshot was built, at the coarsest useful unit. */
function formatAge(generatedAt: string | null, nowMs: number, localize: LocalizeFunction): string | null {
    if (!generatedAt) {
        return localize("forecast_health.age.never");
    }

    const generatedMs = Date.parse(generatedAt);
    if (Number.isNaN(generatedMs)) {
        return null;
    }

    const minutes = Math.max(0, Math.round((nowMs - generatedMs) / 60_000));
    if (minutes < 60) {
        return `${minutes} ${localize("forecast_health.age.minutes")}`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 48) {
        return `${hours} ${localize("forecast_health.age.hours")}`;
    }
    return `${Math.floor(hours / 24)} ${localize("forecast_health.age.days")}`;
}

/**
 * The forecast payload's two health blocks, named. Both cards mount the banner
 * off this so they cannot name the same halves differently.
 */
export function buildForecastHealthItems(
    forecast: ForecastPayload | null | undefined,
    localize: LocalizeFunction,
): ForecastHealthItem[] {
    if (!forecast) {
        return [];
    }
    return [
        { label: localize("forecast_health.source.solar"), health: forecast.solar?.staleness },
        { label: localize("forecast_health.source.house"), health: forecast.house_consumption?.staleness },
    ];
}

@customElement("helman-forecast-health-banner")
export class HelmanForecastHealthBanner extends LitElement {
    static styles = css`
        :host {
            display: block;
        }

        .banner {
            display: flex;
            align-items: flex-start;
            gap: 6px;
            padding: 4px 8px;
            border: 1px solid color-mix(in srgb, var(--warning-color, #ffa726) 40%, var(--divider-color));
            border-radius: 8px;
            background: color-mix(in srgb, var(--warning-color, #ffa726) 12%, var(--card-background-color));
            font-size: 0.75rem;
            line-height: 1.3;
        }

        .icon {
            color: var(--warning-color, #ffa726);
            flex: 0 0 auto;
        }

        .messages {
            display: flex;
            flex-direction: column;
            gap: 2px;
            min-width: 0;
        }

        .source {
            font-weight: 700;
        }

        .age {
            color: var(--secondary-text-color);
            white-space: nowrap;
        }
    `;

    /** Everything whose health this card reports; healthy entries are dropped. */
    @property({ attribute: false }) public items: ForecastHealthItem[] = [];
    @property({ attribute: false }) public localize!: LocalizeFunction;

    render() {
        const localize = this.localize;
        if (!localize) {
            return nothing;
        }

        const unhealthy = (this.items ?? []).filter(
            (item): item is ForecastHealthItem & { health: ForecastHealthDTO } =>
                item.health != null && item.health.isStale,
        );
        if (unhealthy.length === 0) {
            return nothing;
        }

        const nowMs = Date.now();
        return html`
            <div class="banner" role="status">
                <span class="icon" aria-hidden="true">⚠</span>
                <div class="messages">
                    ${unhealthy.map((item) => {
                        const age = formatAge(item.health.generatedAt, nowMs, localize);
                        return html`
                            <div class="message" title=${item.health.generatedAt ?? ""}>
                                <span class="source">${item.label}:</span>
                                ${healthMessage(item.health, localize)}
                                ${age ? html`<span class="age">(${age})</span>` : nothing}
                            </div>
                        `;
                    })}
                </div>
            </div>
        `;
    }
}
