# Agent instructions

## Keep the documentation in step with the code

The user manual is an MkDocs site in `docs/`, published to GitHub Pages from `main` (https://scarfsail.github.io/hass-helman/). It is part of the feature: a change that adds, changes or removes user-visible behaviour updates the manual **in the same PR**.

That includes a new or changed feature, optimizer, condition, card, card option, config field, default value, entity, action or UI flow, and a removed one. Pure refactors and internal fixes with no visible effect need no docs change.

Where things live:

| Change | Page(s) |
| --- | --- |
| Concepts every feature builds on (devices, forecasts, schedule, day types) | `docs/concepts/` |
| A card or dialog: what it shows and how to use it | `docs/using/` |
| An optimizer kind, its settings or conditions | `docs/automation/<kind>.md`, the table in `docs/automation/condition-groups.md`, and `docs/automation/recipes.md` if a recipe is affected |
| Device tree, appliance kinds, EV charger, groupings, hardware profiles | `docs/devices/` |
| Training and learned models | `docs/learning/index.md` |
| Card options, entities, actions, background jobs, troubleshooting | `docs/reference/` |
| A main selling point or a new use case | also `docs/index.md` and `README.md` |
| A new page | add it to `nav` in `mkdocs.yml` |

How to write it:

- Answer **why** and **how**: what problem it solves, what the user sees, what to set. Brief and factual, no marketing filler.
- Check every default and behaviour you state against the code (`const.py`, `config_defaults.py`, the optimizer modules). Don't copy it from older text.
- One line per paragraph, no hard wrapping.
- `README.md` is a short landing page with the selling points. Details belong in the manual, not there.
- Screenshots (`docs/assets/images/`) are English UI, dark theme, with device names translated to English. Replace any screenshot that a UI change makes wrong.

Before pushing, check the build: `python3 -m mkdocs build --strict` (broken links and anchors fail it, as in CI). To preview with live reload: `scripts/docs_serve.sh`, which serves on http://127.0.0.1:8100/hass-helman/.
