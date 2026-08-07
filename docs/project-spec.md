# Blinter VS Code Extension — Project Specification

Source engine: [https://github.com/tboy1337/Blinter](https://github.com/tboy1337/Blinter)

## Purpose

Professional VS Code extension for linting and debugging Windows batch scripts (`.bat`, `.cmd`) using the native Blinter executable. The extension integrates with Run & Debug, Problems, hovers, quick fixes, and a Blinter Output webview.

## Canonical architecture

- **Debugger type:** `blinter-debug` (inline debug adapter via `lib/debugAdapterCore.js`)
- **Bundled binary:** `vendor/Blinter/Blinter.exe` (downloaded by `scripts/setup-vendor.ps1`; not committed to git)
- **Workspace config:** `blinter.ini` in the workspace root (created via `Blinter: Create Config File`)
- **No Python dependency:** the extension does not use `blinter.py`, `pythonPath`, or `rulesPath`

## Module map

| Module | Responsibility |
|--------|----------------|
| `extension.js` | Activation, debug configuration provider, command registration |
| `lib/controller.js` | Diagnostics, decorations, webview, hover, status bar, issue stores |
| `lib/commands.js` | Command palette handlers (`run`, `createConfig`, Copilot, suppressions) |
| `lib/config.js` | VS Code settings and workspace folder resolution |
| `lib/configHelpers.js` | Numeric coercion and rule-list sanitization for settings |
| `lib/lintService.js` | On-save / on-type lint orchestration |
| `lib/debugSession.js` | Launch preparation, debug output ingestion |
| `lib/debugAdapter.js` | VS Code inline debug adapter factory |
| `lib/debugAdapterCore.js` | Inline DAP session, process spawn, timeout handling |
| `lib/spawnFactory.js` | Spawn abstraction with test-mode fake process |
| `lib/issueParser.js` | Unified Blinter stdout parsing (`parseOutput`, `parseLine`) |
| `lib/parser.js` | Backward-compat re-export shim for `issueParser` |
| `lib/analysis.js` | Line analysis, variable index, issue classification |
| `lib/diagnostics.js` | Issue-to-VS Code diagnostic conversion |
| `lib/blinterRunner.js` | CLI arg building, lint process spawn with timeout |
| `lib/discovery.js` | Blinter executable resolution chain |
| `lib/executable.js` | Executable path resolution with error context |
| `lib/documentSnapshot.js` | Dirty-buffer snapshots under `%TEMP%/blinter-snapshots` |
| `lib/quickFixes.js` | Command casing and suppression code actions |
| `lib/outputView.js` | Blinter Output webview in Run & Debug sidebar |
| `lib/utils.js` | Shared helpers (path normalization, markdown escape) |

## User-facing features

### Automatic linting

- `blinter.enabled` — toggle extension
- `blinter.runOn` — `onSave` (default) or `onType`
- `blinter.debounceDelay` — debounce for on-type linting (ms)
- `blinter.saveBeforeLint` — prompt to save dirty files instead of using snapshots
- `blinter.processTimeoutMs` — kill hung Blinter processes (lint, debug, create-config)

All `blinter.*` settings use `"scope": "resource"` for per-workspace-folder configuration.

### Run & Debug

- Contributes `blinter-debug` debugger with default `Launch Batch (Blinter)` configuration
- `Ctrl+F5` runs and debugs the active batch file
- `launch.json` `args` are **Blinter CLI flags** (e.g. `--verbose`), not batch script arguments; unknown flags are filtered with a log warning
- Breakpoints supported for `bat` and `cmd` language IDs

### Commands

- `blinter.run` — on-demand lint of active batch file
- `blinter.runAndDebug` — start debug session
- `blinter.createConfig` — create `blinter.ini` in workspace root
- `blinter.askCopilot` — optional Copilot handoff for diagnostics
- `blinter.removeAllSuppressions` — remove all `LINT:IGNORE` comments

### Diagnostics and UI

- Problems panel, editor squiggles, critical-line decorations, suppression highlights
- Blinter Output webview groups issues (errors, warnings, info, undefined variables, critical)
- Lint and debug issues are merged in Problems, decorations, and the webview during debug sessions

### Exit code semantics

Blinter CLI exit codes (see upstream docs):

| Code | Meaning | Extension status |
|------|---------|------------------|
| 0 | No error/security findings | `completed` |
| 1 | Findings or path errors | `completed` (findings reported) |
| 2 | Internal error | `errored` |
| null | Timeout / spawn failure | `errored` |

## Testing and CI

Local and CI workflow (see `.github/workflows/ci.yml`):

```powershell
npm ci
.\scripts\setup-vendor.ps1
npm run lint:powershell
npm run test:powershell
npm run lint
npm run typecheck
npm run test:security
npm run test:coverage    # aggregate >= 95% on extension.js + lib/*.js
npm run test:uat
npm run test:security:audit
npm run audit:dev
$env:BLINTER_INTEGRATION_ONLY = "1"; npm test
npm run package:vsix
.\tools\verify-vsix.ps1
```

Helper script `scripts/run_tests.cmd` runs lint + unit tests and logs to `project_logs.log`.

Test-only commands (`blinter.test.*`) register only when `BLINTER_TEST_MODE=1`.

## Packaging

See `PACKAGING.md`. VSIX includes `extension.js`, `lib/**`, `icons/**`, `vendor/Blinter/Blinter.exe`, `README.md`, `LICENSE`, `CHANGELOG.md`, and `.vscodeignore`. Build with `npm run package:vsix` after vendor setup.

## Deliverables checklist

- [x] Inline debug adapter (`lib/debugAdapterCore.js`)
- [x] Modular `lib/` architecture with unified issue parsing
- [x] Resource-scoped configuration contributions
- [x] Process timeouts for lint, debug, and create-config
- [x] Dirty-buffer snapshots with per-document cleanup
- [x] CI pipeline with coverage gate, UAT, integration tests, VSIX verification
- [x] `scripts/run_tests.cmd` for local lint + unit automation
- [x] README and PACKAGING.md
