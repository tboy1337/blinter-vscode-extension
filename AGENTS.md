# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project summary

**Blinter for VS Code** is a Windows-only extension that lints and debugs `.bat` / `.cmd` files by spawning the native `Blinter.exe`. It contributes diagnostics, quick fixes, an inline debug adapter (`blinter-debug`), and a Blinter Output webview.

- **Entry point:** `extension.js`
- **Runtime code:** `extension.js`, `lib/**/*.js`
- **Upstream linter:** [tboy1337/Blinter](https://github.com/tboy1337/Blinter) (AGPL-3.0)
- **Bundled binary:** `vendor/Blinter/Blinter.exe` (not committed; download via `npm run setup:vendor`)
- **Detailed architecture:** [`docs/project-spec.md`](docs/project-spec.md)

## Environment

| Requirement | Version / notes |
|-------------|-----------------|
| OS | Windows 10+ only (`package.json` `"os": ["win32"]`) |
| Node.js | `>=22` |
| VS Code API | `engines.vscode` in `package.json` (currently `^1.125.0`) |
| PowerShell | Pester + PSScriptAnalyzer for `test/powershell/` |

Run all commands from the repository root in PowerShell unless noted otherwise.

## Repository layout

```
extension.js          # Activation, debug config provider, command wiring
lib/                  # All extension logic (see module map in docs/project-spec.md)
types/                # JSDoc / ambient TypeScript declarations
test/                 # Mocha unit, branch, integration, and UAT tests
test/powershell/      # Pester tests for setup-vendor.ps1 and verify-vsix.ps1
tools/                # CI helpers (coverage runner, VSIX verification, icon generation)
scripts/              # Vendor setup, build.cmd
docs/                 # Project documentation (keep new docs here, not repo root)
vendor/Blinter/       # Bundled Blinter.exe (gitignored; required for integration tests and VSIX)
```

## Code conventions

### Language and typing

- **Plain JavaScript** with **strict `checkJs`** via TypeScript (`jsconfig.json`, `jsconfig.tests.json`, `jsconfig.tools.json`).
- Do not introduce a compile step for extension code; typecheck with `npm run typecheck`.
- Prefer JSDoc `@param` / `@returns` and shared types in `types/`.
- Use `interface` shapes in JSDoc where helpful; avoid `any` — use `unknown` and narrow.
- **CommonJS** (`require` / `module.exports`) throughout runtime code.

### Style and structure

- Match existing module style: small focused files under `lib/`, controller-centric orchestration in `lib/controller.js`.
- Keep imports at the top of the file; no inline imports unless strictly required for a documented circular dependency.
- In `switch` over discriminated unions or enums, use a `never` check in the `default` case.
- Minimize diff scope — only change what the task requires.
- Comments should explain non-obvious behavior, not restate the code.
- Follow `.editorconfig` (2-space indent for JS/JSON, 4 for PowerShell, LF line endings).

### Linting

```powershell
npm run lint              # ESLint (extension.js, lib/, test/, tools/)
npm run lint:powershell   # PSScriptAnalyzer on scripts/ and test/powershell/
npm run typecheck         # tsc --noEmit on all three jsconfigs
```

## Security and path handling

Treat path validation as security-sensitive:

- **Diagnostics, webview reveal, and debug issues** must stay within workspace-scoped allowlists (`getDiagnosticAllowedPaths()` in `lib/controller.js`).
- **Launch program paths** must pass `assertProgramPathAllowed()` in `lib/debugSession.js` (relative and absolute).
- **Debug output ingestion** caps stdout/stderr volume (same limits as lint in `lib/lintService.js`).
- Do not use `shell: true`, `eval`, or dynamic code execution in runtime extension code.
- Configured `blinter.binaryPath` must not escape the extension root.

When changing path logic, add or update tests in `test/extension.branches.test.js`, `test/coverage.lib.test.js`, or `test/coverage.gaps.test.js`.

## Process spawning and test mode

- All child processes go through `lib/spawnFactory.js` (`createSpawnImpl`).
- When `BLINTER_TEST_MODE=1`, spawn returns a fake process with deterministic stdout (used by unit tests and the VS Code test host).
- Integration tests set `BLINTER_TEST_MODE=1` automatically via `test/runTest.js`.
- Test-only commands (`blinter.test.*`) register only when `BLINTER_TEST_MODE=1`.

## Vendor binary (important)

`vendor/Blinter/Blinter.exe` is required for integration tests, packaging, and local end-to-end runs.

```powershell
npm run setup:vendor
```

`scripts/setup-vendor.ps1` downloads releases from **tboy1337/Blinter** on GitHub.

**Do not corrupt the real vendor binary:**

- Pester tests must use `$TestDrive` or isolated temp roots for `Install-BlinterVendor`.
- Never run mocked vendor install against the repository root without backup/restore.
- After `npm run test:powershell`, confirm `vendor/Blinter/Blinter.exe` is a real PE executable (multi-MB), not a text stub.

## Testing

### Prerequisites

```powershell
npm ci
npm run setup:vendor   # before integration tests or VSIX packaging
```

### Common commands

```powershell
npm run test:unit          # Fast Mocha unit suite
npm run test:coverage      # Full suite + >= 95% branch/line gate on extension.js + lib/
npm run test:powershell    # Pester (27 tests, >= 95% command coverage)
npm run test:integration   # Wrapper for VS Code integration host
npm test                   # Integration tests (respects BLINTER_INTEGRATION_ONLY)
npm run test:security
npm run test:uat
npm run test:performance
npm run test:security:audit
npm run audit:dev
```

### Coverage gate

`npm run test:coverage` enforces **>= 95%** aggregate coverage (statements, branches, functions, lines) across `extension.js` and every `lib/*.js` file. New branches in core logic need matching tests.

### Integration test behavior

- Debug diagnostics are **cleared when a debug session ends** (`clearDebugIssues()` in `lib/controller.js`).
- Tests that need Problems-panel diagnostics after debug must call `blinter.run` explicitly (see `test/integration_smoke.test.js` and `test/integration_simulation.test.js`).

### CI-equivalent full check

Matches [`.github/workflows/ci.yml`](.github/workflows/ci.yml):

```powershell
npm run lint:powershell
npm run test:powershell
npm run setup:vendor
npm run lint
npm run typecheck
npm run test:security
npm run test:coverage
npm run test:performance
npm run test:uat
npm run test:security:audit
npm run audit:dev
$env:BLINTER_INTEGRATION_ONLY = "1"; npm test
npm run package:vsix
powershell -NoProfile -ExecutionPolicy Bypass -File ./tools/verify-vsix.ps1
```

`npm run test:matrix` is a manual local helper only; it is not part of CI.

## Packaging

```powershell
npm run package:vsix
powershell -NoProfile -ExecutionPolicy Bypass -File ./tools/verify-vsix.ps1
```

`tools/verify-vsix.ps1` requires every `lib/*.js` module to be present in the VSIX. If you add a new `lib/` file, update `test/powershell/build-fixtures.ps1` (`Add-RequiredVsixFiles`) so Pester fixtures stay in sync.

See [`PACKAGING.md`](PACKAGING.md) for release details.

## Making changes safely

### Before editing

1. Read the relevant `lib/` module and its tests.
2. Check `docs/project-spec.md` for intended behavior.
3. Identify whether the change affects path security, spawn behavior, or manifest contributions.

### While editing

- Keep business logic in `lib/`; keep `extension.js` thin.
- Reuse `lib/utils.js` for path normalization and allowlist checks.
- Route user-visible errors through the controller log / `showErrorMessage` patterns in `lib/commands.js`.
- Update `package.json` contributions (`capabilities`, debugger config) only when behavior requires it.

### After editing

Run at minimum:

```powershell
npm run lint
npm run typecheck
npm run test:unit
```

For logic changes in `lib/` or `extension.js`, also run:

```powershell
npm run test:coverage
```

For PowerShell script changes:

```powershell
npm run lint:powershell
npm run test:powershell
```

For manifest, integration, or vendor/VSIX changes, run the CI-equivalent block above.

## What to avoid

- Do not commit `vendor/Blinter/Blinter.exe`, `blinter.vsix`, `coverage/`, `tmp/`, or `.vscode-test/` artifacts.
- Do not add Python runtime dependencies; the extension uses only the native executable.
- Do not weaken workspace path allowlists to make tests pass.
- Do not skip the coverage gate or disable rules without a documented config justification.
- Do not create commits or pull requests unless the user explicitly asks.
- Do not add markdown files to the repo root except `README.md`, `CHANGELOG.md`, `LICENSE`, `PACKAGING.md`, and this file.

## Key files for common tasks

| Task | Start here |
|------|------------|
| New command | `lib/commands.js`, `package.json` `contributes.commands` |
| Lint behavior | `lib/lintService.js`, `lib/blinterRunner.js` |
| Debug / DAP | `lib/debugAdapterCore.js`, `lib/debugSession.js`, `lib/debugAdapter.js` |
| Diagnostics / Problems | `lib/controller.js`, `lib/diagnostics.js` |
| Quick fixes / suppressions | `lib/quickFixes.js` |
| Settings / blinter.ini | `lib/config.js`, `lib/configHelpers.js` |
| Output webview | `lib/outputView.js` |
| Executable resolution | `lib/discovery.js`, `lib/executable.js` |
| New lib module in VSIX | `lib/`, `test/powershell/build-fixtures.ps1`, `tools/verify-vsix.ps1` |
| CI workflow | `.github/workflows/ci.yml` |

## References

- [`README.md`](README.md) — user-facing setup, configuration, and commands
- [`docs/project-spec.md`](docs/project-spec.md) — architecture and module responsibilities
- [`PACKAGING.md`](PACKAGING.md) — VSIX contents and redistribution notes
- [`test/UAT_CHECKLIST.md`](test/UAT_CHECKLIST.md) — manual acceptance checklist
