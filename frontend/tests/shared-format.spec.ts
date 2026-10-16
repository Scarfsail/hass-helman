import { test, expect } from "@playwright/test";
import { formatEnergyWh, formatKwh, formatMoney, orNa } from "../cards/shared/format";
import { getLocalizeFunction } from "../cards/localize/localize";

test("missing card labels render loudly", async ({ page }) => {
    const t = getLocalizeFunction({ language: "en" });
    await page.setContent(`<span>${t("card.missing_label")}</span>`);
    await expect(page.locator("span")).toHaveText("⚠ card.missing_label");
    expect(t.has("card.missing_label")).toBe(false);
    expect(t.has("editor.actions.save_and_reload")).toBe(true);
});
test("localized values fill repeated placeholders and honor locale language", () => {
    const t = getLocalizeFunction({ locale: { language: "en" } } as any);
    expect(t("editor.rename.key_exists", { key: "$&" })).toContain("$&");
});
test("energy and named precision boundaries", () => {
    expect([0.99, 9.99, 999, 1000].map(v => formatEnergyWh(v).display))
        .toEqual(["1 Wh", "10 Wh", "999 Wh", "1.0 kWh"]);
    expect(formatEnergyWh(1000, { signed: true }).display).toBe("+1.0 kWh");
    expect(formatEnergyWh(-1000, { signed: true }).display).toBe("-1.0 kWh");
    expect([0.99, 9.99, 999, 1000].map(v => formatKwh(v)))
        .toEqual(["0.99", "10.0", "999", "1000"]);
    expect(formatKwh(9.99, { precision: "gauge" })).toBe("10.0");
    expect(formatKwh(10, { precision: "gauge" })).toBe("10");
    expect(formatKwh(0.99, { precision: "axis" })).toBe("1.0");
});
test("money shares default price precision and has named compact labels", () => {
    expect([0.99, 9.99, 999, 1000].map(v => formatMoney(v, "CZK")))
        .toEqual(["0.99 CZK", "9.99 CZK", "999.00 CZK", "1000.00 CZK"]);
    expect(formatMoney(0.99, "", { precision: "axis" })).toBe("1.0");
    expect(formatMoney(12, "CZK", { precision: "ranking" })).toBe("12.0 CZK");
    expect(orNa(null, String, "n/a")).toBe("n/a");
    expect(orNa(NaN, String, "n/a")).toBe("n/a");
    expect(orNa(0, String, "n/a")).toBe("0");
});

test("dialog card overrides share template filling with the editor namespace", () => {
    const t = getLocalizeFunction({ language: "en" }, () => "{name} {name}");
    expect(t("card.custom", { name: "$&" })).toBe("$& $&");
    expect(t("editor.actions.save_and_reload")).toBe("Save and reload");
});


test("full card keys and editor-owned training and diagnostics keys resolve", () => {
    const t = getLocalizeFunction({ language: "en" });
    expect(t("card.sources_title")).toBe("Energy Sources");
    expect(t("card.loading")).toBe("Loading energy data…");
    expect(t("training.starting")).toBe("Starting");
    expect(t.has("bias_correction.status_panel.training_days_used")).toBe(true);
    const keys: string[] = [];
    getLocalizeFunction({ language: "en" }, key => { keys.push(key); return key; })("card.loading");
    expect(keys).toEqual(["card.loading"]);
});
