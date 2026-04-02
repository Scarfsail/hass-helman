# EV / Appliances Implementation Stories

Shared guide: [`../ev-charger-implementation-shared.md`](../ev-charger-implementation-shared.md)

Visual summary: [`../ev-charger-architecture-summary.md`](../ev-charger-architecture-summary.md)

Reference design: [`../ev-charger-feature-request-refined.md`](../ev-charger-feature-request-refined.md)

## Session workflow

1. Start each fresh implementation session by reading the shared guide, the visual summary, the target story, and then re-reading the reference design.
2. Work stories sequentially according to the dependency chain below unless the user explicitly changes the plan.
3. When a story is fully implemented, update this README and mark that story as done by changing its checkbox from `[ ]` to `[x]`. This is the hand-off signal for the next session to continue with the next unfinished story.
4. For websocket validation, once the user confirms local Home Assistant has been restarted and the new code is live, the session may use the `local-hass-api` skill to run the required validation calls.

## Definition of done

A story is done only when all of the following are true:

- The implemented code matches the story scope and acceptance criteria.
- The relevant automated tests and validations listed in the story were run successfully.
- If the story requires websocket validation, wait for the user to confirm that local Home Assistant was restarted, then use the `local-hass-api` skill for the validation steps.
- Any directly related docs were updated.
- This README was updated and the story checkbox was changed from `[ ]` to `[x]`.

## Cross-story consistency review

At the end of every story implementation session, review the remaining upcoming stories and the related EV/appliances documents to keep the plan consistent with what was actually learned during implementation.

At minimum, review these files when a story introduces or confirms an architectural decision, naming decision, contract adjustment, validation rule, lifecycle rule, or testing workflow change:

- [`../ev-charger-architecture-summary.md`](../ev-charger-architecture-summary.md)
- [`../ev-charger-implementation-shared.md`](../ev-charger-implementation-shared.md)
- [`../ev-charger-feature-request-refined.md`](../ev-charger-feature-request-refined.md)
- the current story document
- the remaining future story documents that depend on the current story
- this README

If implementation proves that a prior assumption should change, update the relevant docs in the same session so the next implementation session starts from the corrected architecture and story plan rather than rediscovering the mismatch.

## Ordered story list (backend phase)

- [x] [Story 01 - Break the DTO contract and scaffold the FE client](./story-01-dto-foundation.md)
- [x] [Story 02 - Read appliance config and expose metadata (backend)](./story-02-config-and-metadata.md)
- [ ] [Story 03 - Author appliance actions in backend schedule](./story-03-schedule-authoring.md)
- [ ] [Story 04 - Execute EV schedule actions in backend](./story-04-ev-execution.md)
- [ ] [Story 05 - Expose EV projections in backend API](./story-05-ev-projections.md)
- [ ] [Story 06 - Reflect appliance demand in backend forecasts](./story-06-forecast-integration.md)

There are currently no FE-only follow-up story documents in scope. The only FE work in the current plan is Story 01, and it is limited to catching up with the backend breaking websocket contract.

## Dependency chain

- Story 01 must be first.
- Story 02 depends on story 01.
- Story 03 depends on stories 01 and 02.
- Story 04 depends on stories 01, 02, and 03.
- Story 05 depends on stories 01, 02, and 03.
- Story 06 depends on stories 02, 04, and 05.

## Parallelism

No meaningful parallelism is recommended inside the backend phase because of shared touchpoints. Complete stories sequentially.
