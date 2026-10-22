import { expect, test } from "@playwright/test";
import type { ApplianceMetadataDTO, EntityActualHistoryPayload } from "../cards/helman-api";
import { buildEntityLaneActualSlots } from "../cards/shared/schedule/model/entity-lane-source";

const base = { id: "test", name: "Test", primaryEntityId: "entity.test", normalState: "off", supportsAuthoring: true };
const entities: ApplianceMetadataDTO[] = [
    { ...base, kind: "inverter", actionOptions: { charge_to_target_soc: "Custom charge" } },
    { ...base, kind: "generic", metadata: { icon: "mdi:power", scheduleCapabilities: { onOffToggle: true } }, controls: { switch: { entityId: "entity.test" } } },
    { ...base, kind: "climate", metadata: { icon: "mdi:thermostat", scheduleCapabilities: { modes: ["heat"] } }, controls: { climate: { entityId: "entity.test" } } },
    { ...base, kind: "ev_charger", metadata: { icon: "mdi:car", maxChargingPowerKw: 7, scheduleCapabilities: { chargeToggle: true, useModes: [], ecoGears: [], requiresVehicleSelection: false } }, controls: { charge: { entityId: "entity.test" }, useMode: { entityId: "select.mode" }, ecoGear: { entityId: "select.gear" } }, vehicles: [] },
];

test("history consumes backend actions for every kind and preserves partial activity", () => {
    const actions: EntityActualHistoryPayload["entities"][string][number]["action"][] = [
        { kind: "charge_to_target_soc" }, { on: true }, { mode: "heat" }, { charge: true },
    ];
    entities.forEach((entity, index) => {
        const entry = { slot: "2026-07-31T08:00:00+02:00", action: actions[index], ratio: 0.333 };
        const slots = buildEntityLaneActualSlots({ entity, actualHistory: { "entity.test": [entry] }, slotDurationMs: 900_000 });
        expect(slots).toEqual([{ startMs: Date.parse(entry.slot), endMs: Date.parse(entry.slot) + 900_000, action: actions[index], ratio: 0.333 }]);
        expect(buildEntityLaneActualSlots({ entity, actualHistory: {}, slotDurationMs: 900_000 })).toEqual([]);
        expect(buildEntityLaneActualSlots({ entity, actualHistory: { "entity.test": [] }, slotDurationMs: 900_000 })).toEqual([]);
    });
});
