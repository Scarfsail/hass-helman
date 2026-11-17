# Development
Frontend TypeScript source lives at repo-root `frontend/` (dev-only, never shipped to users).

```bash
npm --prefix frontend ci
npm --prefix frontend run build   # → custom_components/helman/frontend_compiled/
npm --prefix frontend run watch   # dev/watch mode
```

## Running tests

**Working rule:** while making a change, run the targeted tests for it first (the backend files and frontend specs that cover what you touched). Before pushing, run both full suites once.

### Backend

The backend tests import the real Home Assistant package, so they need an interpreter with `homeassistant` installed (Python ≥3.14.2, matching HA's floor). The suite is run **one file per process** — many test modules install conflicting `sys.modules` stubs at import time, so a single `pytest tests/` invocation would cross-pollute and fail. `scripts/run_tests.sh` handles this for you, and runs the files in parallel (`$(nproc)` at a time by default; set `JOBS=…` to override, `JOBS=1` runs them serially). Results are printed in input order once every file has finished.

```bash
scripts/setup_test_venv.sh    # once — creates .venv and installs requirements-test.txt (idempotent)
scripts/run_tests.sh          # run the whole suite (auto-detects .venv)
scripts/run_tests.sh tests/test_schedule.py   # run specific files
JOBS=4 scripts/run_tests.sh   # limit how many files run at once
```

`scripts/run_tests.sh` uses the repo's `.venv` when present; override with `PYTHON=/path/to/python scripts/run_tests.sh`. To run against the Home Assistant dev container instead of a local venv, use `scripts/run_tests_in_container.sh`.

### Frontend

The frontend tests are Playwright component tests that mount the built card in a bare page; no running Home Assistant is needed. Each run rebuilds both bundles first (through `frontend/tests/global-setup.ts`), so the tests always exercise the current source.

```bash
npm --prefix frontend test                                         # run the whole suite
npm --prefix frontend test -- tests/node-detail-ev-charger.spec.ts # run specific specs
```

The node-detail specs also capture review screenshots, tagged `@screens` and left out of the default run. To capture one spec's screenshots, point `SCREENS` at a directory:

```bash
SCREENS=/tmp/shots npm --prefix frontend test -- tests/node-detail-battery.spec.ts
```

### CI

CI (`.github/workflows/release.yml`) runs both suites on every push and pull request: the backend job runs `scripts/run_tests.sh` against `requirements-test.txt` (files in parallel, pip cached), and the frontend job runs `npm --prefix frontend test` with 4 Playwright workers. The release job depends on both passing, so a red test run blocks the release.
