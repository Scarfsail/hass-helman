import { expect, test } from "@playwright/test";
import { explanationRows } from "./support/payload-builders";
import { parseScheduleExplanation } from "../cards/shared/schedule/model/schedule-explanation-model";
import { buildLogicDiagram } from "../cards/shared/schedule/model/logic-diagram-model";

test("derives recorded outcomes and decisive blocks from explanation rows", () => {
    const slotIds = ["2026-07-31T13:00:00+02:00", "2026-07-31T13:15:00+02:00",
        "2026-07-31T13:30:00+02:00"];
    const payload = explanationRows({
        slotIds,
        optimizers: [{
            optimizerId: "appliance_runtime",
            slots: slotIds.map((slotId, index) => ({
                slotId,
                verdict: index === 1 ? "candidate" : "execute",
                winningOptimizer: index === 0 ? "appliance_runtime" : undefined,
                matchedGroupIndex: 0,
                groups: [{
                    label: "Day",
                    customResults: index === 1 ? [false] : [],
                    conditions: [{ key: "max_run_price", scope: "slot", state: "true",
                        actual: 1.5, value: 2 }],
                }],
                gates: index === 2 ? [{ key: "blocked_user_owned", state: "false" }] : [],
            })),
        }],
    });
    const parsed = parseScheduleExplanation(payload)!;
    const diagrams = parsed.columns[0].cells.map((cell) => buildLogicDiagram(cell));

    expect(diagrams.map((model) => model.terminal)).toEqual(["execute", "candidate", "blocked"]);
    expect(diagrams.map((model) => model.planState)).toEqual(["true", "true", "false"]);
    expect(diagrams.map((model) => model.customState)).toEqual(["n/a", "false", "n/a"]);
    expect(diagrams[0].blocks.find((block) => block.key === "max_run_price"))
        .toMatchObject({ state: "true", decisive: true,
            comparison: { actual: "1.50", operator: "<", value: "2" } });
    expect(diagrams[1].blocks.find((block) => block.id === "custom"))
        .toMatchObject({ state: "false", decisive: true });
    expect(diagrams[2].blocks.find((block) => block.key === "blocked_user_owned"))
        .toMatchObject({ state: "false", decisive: true });
});
