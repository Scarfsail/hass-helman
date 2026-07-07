# Migration Plan: Merge `hass-helman-card` frontend into `hass-helman`

> Status: **Implemented on `feat/merge-frontend`** (uncommitted, pending owner review/testing before merge
> to `main`). All decisions below are agreed with the repo owner. See §8 for a reusable checklist/lessons
> section if repeating this for another `*-card` repo.
> Do all work on branch **`feat/merge-frontend`**; merge to `main` only after manual testing.

## 1. Goal

Collapse the two HACS repositories into one:

- **Backend (this repo):** `hass-helman` — Python integration, HACS category **Integration**.
- **Card (separate):** `hass-helman-card` — Lovelace card, HACS category **Lovelace**.

After the merge, the integration serves the card's built JS itself and **auto-registers the Lovelace
resource** on setup (the `quick_timer` pattern), so users install one thing and the card appears with no
manual resource step. This eliminates card/backend version drift.

**Target user experience:** UI (storage) mode only — auto-registration is not expected to work in YAML
mode, and that is explicitly out of scope.

## 2. Confirmed decisions

| Topic | Decision |
|---|---|
| Repo that survives | `hass-helman` (this one); card repo gets archived afterwards |
| HACS category | Integration (card stops being a separate HACS item) |
| Compiled JS location (disk) | `custom_components/helman/frontend_compiled/` |
| Served path (URL prefix) | `/helman_frontend/` |
| Card bundle | **Single** `helman-card.js` — `app.ts` already imports all card types (main, simple, forecast, scheduling, solar-inspector). Drop the legacy standalone simple build. |
| Config editor bundle | `helman-config-editor.js` (unchanged mechanism, source relocated) |
| Frontend TS source | Lives at repo-root `frontend/` — **dev-only, never shipped to users** |
| Built JS in git | **Not committed.** Built in CI, shipped via release zip (`zip_release`). |
| `hass-frontend` (HA types) | Git **submodule** under `frontend/hass-frontend`, dev-only |
| Toolchain | **One** `frontend/package.json` / one `node_modules` / one lockfile |
| Branch strategy | Everything on `feat/merge-frontend`; merge to `main` after owner tests |
| Git history | **Preserved** for moved frontend code (via `git subtree`) |

## 3. Target repository layout

```
hass-helman/
├── custom_components/helman/          ← the ONLY thing shipped to users
│   ├── __init__.py                    ← setup: serve frontend_compiled + register card resource
│   ├── manifest.json                  ← add "frontend" + "http" to dependencies
│   ├── panel.py                       ← config-editor panel (path updated to frontend_compiled)
│   ├── frontend.py                    ← NEW: serve static dir + auto-register Lovelace card resource
│   ├── const.py                       ← updated/added frontend constants
│   ├── automation/  scheduling/  solar_bias_correction/  appliances/
│   ├── translations/
│   └── frontend_compiled/             ← BUILD OUTPUT, gitignored; served at /helman_frontend/
│       ├── helman-card.js
│       └── helman-config-editor.js
│
├── frontend/                          ← ALL TypeScript source (dev-only, NOT shipped)
│   ├── package.json                   ← single toolchain (card + config-editor deps merged)
│   ├── vite.config.ts                 ← card build (app.ts → helman-card.js)
│   ├── vite.config.editor.ts          ← config-editor build (→ helman-config-editor.js)
│   ├── tsconfig.json
│   ├── hass-frontend/                 ← git submodule (dev-only; card imports ../../hass-frontend)
│   ├── cards/                         ← card source, moved verbatim from hass-helman-card/src, renamed
│   │   ├── app.ts                     (single card entry — registers ALL card elements)
│   │   ├── helman-api.ts  color-utils.ts  power-format.ts
│   │   ├── helman/  helman-simple/  helman-forecast/
│   │   ├── helman-scheduling/  helman-solar-inspector/  node-detail/  shared/
│   │   └── localize/
│   └── config-editor/                 ← moved from custom_components/helman/frontend/src
│       ├── helman-config-editor.ts  index.ts  (+ modules)
│       └── localize/
│
├── tests/                             ← Python tests (unchanged)
├── docs/                              ← merged docs from both repos (this file lives here)
├── .github/workflows/release.yml      ← build JS → zip custom_components/helman → release
├── hacs.json                          ← "zip_release": true, "filename": "helman.zip"
└── README.md
```

> **Why card source is a top-level dir directly under `frontend/`, sibling to `config-editor/`** (originally
> named `src/`, renamed to **`cards/`** for readability — see §8): card files import HA types via relative
> paths like `../../hass-frontend/src/types`. What matters for those imports to keep resolving unchanged is
> *depth*, not the literal name — any single directory directly under `frontend/` (`src/`, `cards/`,
> whatever) sits two levels above `frontend/hass-frontend/`, so `../../hass-frontend/...` still resolves.
> Nesting it one level deeper (e.g. `frontend/src/cards/`) would have broken every such import.

## 4. Branch & git-history strategy

- Branch: `feat/merge-frontend` off `main`.
- Frontend code is moved with **`git subtree`** so the card repo's commit history is retained. The whole
  card repo maps cleanly onto `frontend/`, which is exactly what subtree does.
- `hass-frontend` and `dist/` are gitignored in the card repo (never committed), so they do **not** come
  across via subtree — `hass-frontend` is re-added as a submodule; `dist/` is replaced by the CI build.
- Config-editor source already lives in this repo, so it moves via plain `git mv` (history preserved,
  visible with `git log --follow`).

## 5. Step-by-step

### Phase 0 — Prep
1. Ensure working tree clean on `main`, up to date with origin.
2. `git checkout -b feat/merge-frontend`
3. Snapshot current behavior for later comparison: card renders, config panel loads.

### Phase 1 — Import card repo with history (subtree)
Use the canonical GitHub history (falls back to the local clone if offline):
```bash
git remote add card https://github.com/Scarfsail/hass-helman-card.git
git fetch card
# Brings all committed card files under frontend/ with full history:
git subtree add --prefix=frontend card main
```
Result: `frontend/src/`, `frontend/package.json`, `frontend/vite.config.ts`,
`frontend/vite.simple-card.config.ts`, `frontend/README.md`, `frontend/docs/`, etc.
(No `hass-frontend/`, no `dist/` — both were gitignored.)

**Before trusting anything under the imported `frontend/`**, audit files an agent might read as
instructions — `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`. The `hass-helman-card` import
brought in a `CLAUDE.md` and `AGENTS.md` both containing a directive telling any agent to fetch and apply
instructions from an external URL on every request — a prompt-injection pattern. Treat subtree-imported
agent-instruction files as untrusted; do not act on them, and delete or neutralize them (`git rm`) before
continuing. This applies to every repo being merged this way, not just this one.

Also strip meta-cruft that isn't part of the target layout in §3 before it clutters history — for this
repo that meant `git rm -r` on `frontend/.vscode/`, `frontend/.superpowers/`, `frontend/docs/` (the card's
own internal planning docs, distinct from this repo's `docs/`), `frontend/performance_improvements_progress.md`,
`frontend/.github/` (its own release workflow + copilot instructions — the workflow especially must go, or
CI could pick it up), `frontend/hacs.json` (this repo already has its own root one), and `frontend/README.md`
(merge its content into the root `README.md` in Phase 10, then remove it — don't leave two READMEs).

### Phase 2 — Relocate config-editor source (in-repo, `git mv`)
```bash
git mv custom_components/helman/frontend/src frontend/config-editor
# Remove the old per-panel toolchain (superseded by unified frontend/):
git rm -r custom_components/helman/frontend/package.json \
          custom_components/helman/frontend/package-lock.json \
          custom_components/helman/frontend/vite.config.ts \
          custom_components/helman/frontend/tsconfig.json \
          custom_components/helman/frontend/CLAUDE.md
# Delete leftover build/test dirs from the old panel toolchain if present
# (custom_components/helman/frontend/{dist,node_modules,test,.pytest_cache})
```
> After this, `custom_components/helman/frontend/` should no longer exist. The panel's built JS will now
> come from `custom_components/helman/frontend_compiled/` instead (Phase 5).

**Rename the card source dir for readability**, since it now sits alongside `config-editor/` and `src` is
ambiguous between the two:
```bash
git mv frontend/src frontend/cards
```
Safe because of the depth argument in §3 — the `../../hass-frontend/...` imports inside the card files are
unaffected by the rename, only by nesting depth. Update every place that names the old path: `vite.config.ts`
(`entry: "./cards/app.ts"`), `tsconfig.json` (`"include": ["cards/**/*.ts", ...]`). Grep for the old name
across the repo after renaming (`grep -rn "frontend/src\b"`) — anything left over (docs, other configs) needs
the same update.

### Phase 3 — Drop the legacy standalone simple-card build
`app.ts` already imports `helman-simple/helman-simple-card.ts`, so the single bundle registers it.
```bash
git rm frontend/vite.simple-card.config.ts
```
Remove the `helman-simple-card`-specific build script from `frontend/package.json` (Phase 4).

### Phase 4 — Unify the toolchain (`frontend/package.json`)
- Keep one `frontend/package.json`. Merge dependencies:
  - Card: `lit`, `dayjs`, `@mdi/js`, `home-assistant-js-websocket`.
  - Config-editor also uses `lit` (already covered).
- Scripts (single `node_modules`, one lockfile):
  ```json
  "scripts": {
    "build": "npm run build:card && npm run build:editor",
    "build:card": "vite build",
    "build:editor": "vite build -c vite.config.editor.ts",
    "watch": "vite build --watch --mode development"
  }
  ```
- Keep the `semantic-release` config **out** of `frontend/package.json` — release is driven from the repo
  root workflow (Phase 8). Remove the card's release block here to avoid a second release pipeline.
- `npm install` inside `frontend/` to regenerate `package-lock.json`.

### Phase 5 — Vite: output into `frontend_compiled/`
- `frontend/vite.config.ts` (card): entry `./cards/app.ts`, `fileName` → `helman-card.js`,
  `outDir: ../custom_components/helman/frontend_compiled`, `emptyOutDir: false`.
- `frontend/vite.config.editor.ts` (config-editor): entry `./config-editor/index.ts` (verify the real
  entry file), `fileName` → `helman-config-editor.js`, same `outDir`.
- Keep prod = minified, no sourcemaps; dev = sourcemaps, unminified (as today).

### Phase 6 — `hass-frontend` as a submodule
```bash
git submodule add <hass-frontend-fork-or-upstream-url> frontend/hass-frontend
# Pin to the commit currently used locally to avoid type drift.
```
**Gotcha:** the card repo's own `frontend/.gitignore` (imported via subtree in Phase 1) ignores
`/hass-frontend/` and `/dist/` — that was correct for the standalone card repo (dev-only artifacts) but it
makes `git submodule add` fail with "paths are ignored" once merged. Fix `frontend/.gitignore` to drop the
`/hass-frontend/` line (it must be **tracked** now, as a submodule gitlink) before adding the submodule;
keep ignoring `/dist/`.

**Which URL/commit to pin is a real decision, not a default** — ask the owner rather than guessing. There's
no single right answer: the official `home-assistant/frontend` repo is a reasonable default (pin to a
recent release tag matching the target HA version, e.g. `20260624.0`), but some setups pin a slimmed
types-only fork instead. If reusing this plan for a sibling repo, re-ask; don't silently copy the previous
choice — HA versions and forks used across siblings can drift.
- Add `frontend/hass-frontend` handling to `.gitignore` review (submodule dir is tracked as a gitlink; its
  contents are not). Document `git submodule update --init` in the dev setup section of the README.
- Verify card type imports resolve from `frontend/cards/**` → `../../hass-frontend/src/...`.

### Phase 7 — Python: serve + auto-register
**`const.py`** — replace panel path constants and add card/frontend serving constants:
```python
FRONTEND_COMPILED_FOLDER = "frontend_compiled"        # disk folder under custom_components/helman
FRONTEND_URL_BASE = "/helman_frontend"                 # served URL prefix
CARD_FILENAME = "helman-card.js"
CARD_URL = f"{FRONTEND_URL_BASE}/{CARD_FILENAME}"      # what gets registered as a Lovelace resource
# Panel now served from the same compiled folder:
PANEL_FILENAME = "helman-config-editor.js"
PANEL_URL = f"/api/panel_custom/{DOMAIN}-config"       # unchanged
```
- Update `panel.py` `bundle_path` to point at `FRONTEND_COMPILED_FOLDER` (not the old `frontend/dist`).

**`frontend.py`** (NEW) — mirror the `quick_timer` mechanism. Implemented and verified working end-to-end
(single auto-registered resource, correctly versioned, no duplicates — see §8):
1. Register a static path: serve the whole `frontend_compiled/` dir at `FRONTEND_URL_BASE`
   (`StaticPathConfig`, same call `panel.py` already used for the panel bundle).
2. Read integration version via `homeassistant.loader.async_get_integration(hass, DOMAIN)` →
   `integration.version`, for cache-busting (`?v=<version>`).
3. Auto-register the Lovelace resource in **storage mode**. Duck-type against `hass.data.get("lovelace")`
   rather than importing `homeassistant.components.lovelace` internals directly — those are private,
   version-sensitive APIs; the domain string `"lovelace"` and the shape (`.resources` with
   `async_create_item`/`async_update_item`/`async_delete_item`/`async_get_info`/`async_items`) are the
   stable-enough surface:
   ```python
   def _get_storage_resources(hass):
       lovelace = hass.data.get("lovelace")
       resources = getattr(lovelace, "resources", None)
       if resources is None or not hasattr(resources, "async_create_item"):
           return None  # YAML-mode dashboards: no storage collection, skip silently
       return resources

   async def _async_register_card_resource(hass):
       resources = _get_storage_resources(hass)
       if resources is None:
           return
       integration = await async_get_integration(hass, DOMAIN)
       versioned_url = f"{CARD_URL}?v={integration.version}"
       await resources.async_get_info()  # forces the collection to load — async_items() is empty until this runs
       existing = next((i for i in resources.async_items() if i["url"].startswith(CARD_URL)), None)
       if existing is not None:
           if existing["url"] != versioned_url:
               await resources.async_update_item(existing["id"], {"url": versioned_url})
           domain_data[_CARD_RESOURCE_ID] = existing["id"]
       else:
           created = await resources.async_create_item({"res_type": "module", "url": versioned_url})
           domain_data[_CARD_RESOURCE_ID] = created["id"]
   ```
   The `async_get_info()` call matters: `ResourceStorageCollection` lazy-loads from HA storage, and
   `async_items()` returns an empty list until that load has happened — skipping it makes every restart
   look like "no existing resource" and creates a duplicate.
4. On unload: track the created/updated resource's `id` in `hass.data[DOMAIN]` and call
   `resources.async_delete_item(resource_id)`; swallow errors (best-effort cleanup, matches `panel.py`'s
   style of not blocking unload on cosmetic cleanup failures).

**`__init__.py`** — call the static-path + resource registration on `async_setup` / `async_setup_entry`,
alongside the existing panel registration; unregister on unload.

**`manifest.json`** — add `frontend` and `http` to `dependencies`. Declaring `frontend` alone is enough —
core's `homeassistant/components/frontend/manifest.json` already depends on `lovelace`, so it's guaranteed
loaded transitively; no need to list `lovelace` explicitly:
```json
"dependencies": ["energy", "recorder", "frontend", "http"]
```

### Phase 8 — HACS + CI
**`hacs.json`:**
```json
{
  "name": "Helman Energy",
  "render_readme": true,
  "zip_release": true,
  "filename": "helman.zip"
}
```
**`.github/workflows/release.yml`** — insert a build step so the zip contains compiled JS:
1. `actions/setup-node@v4` (node 22) + `actions/setup-python@v5`.
2. `git submodule update --init frontend/hass-frontend`
3. `npm --prefix frontend ci`
4. `npm --prefix frontend run build`  → populates `custom_components/helman/frontend_compiled/`
5. `npm install` (root) + `npx semantic-release`.
- Delete the card repo's `main.yml` workflow (it came across under `frontend/.github` via subtree — remove
  it so it can't run; also its own `hacs.json`, superseded by the root one).

**Ordering gotcha — do the zip inside semantic-release's `prepare` step, not as a separate workflow step
before it.** The JS build (step 4 above) doesn't depend on the release version and can run any time before
`semantic-release`. But the **zip** must be built *after* `manifest.json`'s version has been bumped —
otherwise the shipped zip's `manifest.json` still says the old version, so the integration's own
`async_get_integration(...).version` (used for the card's `?v=` cache-busting query, Phase 7) is wrong for
that whole release. `@semantic-release/exec` runs its `prepareCmd` in the `prepare` lifecycle step, and
plugins run in array order — so add a **second** `@semantic-release/exec` entry, after the one that bumps
`manifest.json`, whose `prepareCmd` zips `custom_components/helman`. Then have `@semantic-release/github`
attach that zip as a release asset:
```json
"plugins": [
  ["@semantic-release/commit-analyzer", { "preset": "angular" }],
  "@semantic-release/release-notes-generator",
  ["@semantic-release/exec", { "prepareCmd": "python -c \"...bump manifest.json version...\"" }],
  ["@semantic-release/exec", {
    "prepareCmd": "cd custom_components/helman && zip -r ../../helman.zip . -x '__pycache__/*' -x '*/__pycache__/*' && cd ../.."
  }],
  ["@semantic-release/git", { "assets": ["custom_components/helman/manifest.json"], "message": "..." }],
  ["@semantic-release/github", { "assets": [{ "path": "helman.zip", "label": "helman.zip" }] }]
]
```
`zip`/`unzip` are preinstalled on the `ubuntu-latest` GitHub Actions runner image — no extra setup step
needed.

### Phase 9 — gitignore
- Add `custom_components/helman/frontend_compiled/` (build output — not committed), `helman.zip`.
- Add `frontend/node_modules/`, `frontend/dist/` (if any legacy).
- Confirm `frontend/hass-frontend/` is a submodule gitlink, not ignored. In practice this means **editing**
  the subtree-imported `frontend/.gitignore`, not just adding to the root one — see the Phase 6 gotcha.

### Phase 10 — Docs & user migration note
- There may be no root `README.md` yet (a pure-backend integration repo often doesn't have one) — in that
  case this phase is "write it", not "merge into it."
- Merge card `README.md` content into root `README.md`; update install section to **Integration**:
  1. HACS → Integrations → custom repo → category Integration.
  2. Install, restart, add integration via config flow. Card resource auto-registers.
- Add a **breaking-change / migration** note for existing card users:
  - Remove the old `hass-helman-card` HACS Lovelace entry.
  - Remove any manually-added `/hacsfiles/hass-helman-card/...` Lovelace resource (avoids duplicate).
  - Install the integration; the card element name (`custom:helman-card`) is unchanged.
- Update `documentation` / `issue_tracker` URLs in `manifest.json` if the card repo had separate ones.
- Delete `frontend/README.md` once its content is folded in — don't leave two READMEs for the same project.

### Phase 11 — Verify (before any merge)
- `npm --prefix frontend run build` produces both JS files in `frontend_compiled/`.
- **Grep `tests/` for hardcoded old paths before running the suite.** This repo's `tests/test_panel.py`
  hardcoded `.../frontend/dist/helman-config-editor.js` (the pre-migration panel bundle path) and failed
  after the Phase 7 `panel.py` update — a one-line fix, but easy to miss since it's a passing-test-turned-
  wrong-assertion, not an import error.
- Run local HA dev instance; install/point at the branch:
  - Config panel loads (served from new path).
  - Dashboard card renders; Lovelace resource appears **automatically** in Settings → Dashboards →
    Resources with a `?v=` query.
  - Reload/restart does not create duplicate resources; version bump updates the existing one.
  - Unloading the integration removes the resource.
- **Confirmed working on this repo:** built both bundles, started the local HA dev instance, `helman`
  config entry set up with no traceback, `curl`'d both `/helman_frontend/helman-card.js` and
  `/helman_frontend/helman-config-editor.js` → HTTP 200, and inspected
  `config/.storage/lovelace_resources` directly — exactly one `/helman_frontend/helman-card.js?v=1.0.0`
  entry, no duplicates. (Unload-removes-resource was verified by code review of the delete path, not by
  actually removing the config entry live — worth doing explicitly before merging to `main`.)
- Python tests pass (`pytest`).

### Phase 12 — Merge & follow-up
- Owner tests thoroughly → merge `feat/merge-frontend` to `main`.
- Cut a release; confirm HACS installs the zip and the card works end-to-end from a clean install.
- **Archive `hass-helman-card`** with a README pointer to this repo. Do not delete (preserves old issues /
  release history / external links).

## 6. Risks & notes
- **Resource registration needs storage mode.** Acceptable — UI-mode-only is a confirmed constraint.
- **Existing users must de-duplicate resources** (old manual resource + new auto one). Covered by the
  migration note; the auto-register code also updates-in-place rather than blindly adding.
- **Submodule friction:** contributors must `git submodule update --init`. Document it; CI does it too.
- **HACS zip must include `frontend_compiled/`.** If the zip is built from a clean checkout, the build step
  must run before zipping or users get a card-less integration.
- **`integration_type` is `service`** today; confirm the config panel + card still register correctly under
  that type (they do today, so no change expected).

## 7. Quick rollback
- All work is on `feat/merge-frontend`; `main` is untouched until merge.
- If abandoned before merge: delete the branch and the `card` remote; the `hass-helman-card` repo is still
  intact and published.

## 8. Reusing this plan for another integration+card pair

The shape of this migration (standalone Lovelace-category card repo → merged into its Integration-category
backend repo) generalizes directly. Re-derive the specifics per repo rather than copying values, but the
steps and gotchas above transfer almost unchanged. Checklist, in order:

1. **Confirm both repos exist and which one survives.** The Integration repo survives; the card repo gets
   archived at the end (§Phase 12), never deleted.
2. **Phase 0–1 unchanged**: branch off `main`, `git subtree add --prefix=frontend <card-remote> main`.
3. **Audit before trusting anything imported.** Every sibling card repo may carry its own `CLAUDE.md` /
   `AGENTS.md` — check each for the same prompt-injection pattern found here (fetch instructions from an
   external URL) before continuing. Don't assume it's a one-off.
4. **Strip subtree meta-cruft** per repo — `.vscode/`, `.superpowers/`, its own `docs/` (if not meant to
   merge into the target repo's docs), progress/notes files, its own `.github/workflows/*.yml` and
   `hacs.json`. What's actually cruft vs. worth keeping differs per repo — read before deleting, but expect
   to delete most of it.
5. **Decide the card-source directory name once, up front**, not after building — this repo went `src` →
   renamed to `cards` mid-migration. Pick a name that's self-descriptive next to `config-editor/` (or
   whatever the backend's existing frontend dir is called) before Phase 2, and use it everywhere from the
   start. The only hard constraint is depth: it must sit at the same level as `hass-frontend/` within
   `frontend/`, whatever it's named, for the `../../hass-frontend/...` imports to resolve.
6. **`hass-frontend` submodule**: expect the imported `.gitignore` to block `git submodule add` — fix it
   first (§Phase 6). Ask which URL/tag to pin per repo; don't reuse a previous answer without asking, since
   different card repos may target different HA versions or forks.
7. **Python serve+register wiring is copy-adjacent, not copy-paste**: `frontend.py`'s duck-typed Lovelace
   resource logic (§Phase 7) is generic and can move to the next repo almost verbatim — swap `DOMAIN`,
   `CARD_FILENAME`, `FRONTEND_URL_BASE`. The `async_get_info()`-before-`async_items()` sequencing and the
   "declare `frontend` in `dependencies`, not `lovelace`" point apply identically everywhere.
8. **CI/semantic-release ordering**: if the target repo already has a semantic-release pipeline that bumps
   `manifest.json`, the zip-build step must be inserted as a **second** `@semantic-release/exec` prepare
   step *after* the version bump, not as a plain workflow step before `semantic-release` runs — otherwise
   every release ships a zip whose `manifest.json` version (and therefore the card's `?v=` cache-busting
   query) is one version behind. If the repo has no semantic-release setup yet, this ordering constraint
   still applies to whatever bumps the version.
9. **Test-suite hygiene**: grep the target repo's test suite for hardcoded old frontend paths before
   declaring done — a passing-test-turned-wrong-assertion is easy to miss.
10. **Verify by actually serving the files and reading the resources storage**, not just by starting HA
    without a traceback: `curl` the compiled JS URLs for HTTP 200, and read
    `config/.storage/lovelace_resources` directly to confirm exactly one auto-registered entry with the
    expected `?v=` — this is strong, cheap evidence and doesn't require a browser.
11. **Phase 12 is always owner-gated** — draft the PR/branch, but merging to `main`, cutting the release,
    and archiving the old card repo are decisions the owner makes explicitly, not implied by "plan done."
