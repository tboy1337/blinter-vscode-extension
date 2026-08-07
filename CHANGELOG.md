# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed

- Debug disconnect during `prepareForLaunch` no longer leaves an orphaned Blinter child process
- Cap debug and lint stdout byte buffers at 64 KB before newline splitting (matches stderr cap)
- Correct upstream Blinter repository URLs from non-existent `14ag/Blinter` to `tboy1337/Blinter`

### Changed

- `blinter.run` and `lintDocument` now await the Blinter process before returning, fixing intermittent integration diagnostic timeouts
- Lint results preserve per-file paths when `blinter.followCalls` is enabled
- Debug launch failures reset debug status and webview state; webview status refreshes when debug sessions end
- Relative `blinter.binaryPath` values cannot escape the extension root; relative launch `program` paths must stay within the workspace
- Diagnostics are filtered to workspace/program directories instead of trusting arbitrary CLI output paths
- Resource-scoped settings resolve using the launch program URI when no workspace folder is available

### Changed

- `tools/verify-vsix.ps1` verifies every `lib/*.js` module is packaged
- `scripts/publish.cmd` and `scripts/publish_ovsx.cmd` prefer `OVSX_PAT` / `VSCE_PAT` environment variables
- `scripts/build.cmd` creates `releases/` and uses `/Y` when archiving prior VSIX files
- CI runs `npm run test:performance`
- Added `ovsx` devDependency for publishing

## [v1.26.80700]

### Added

- Resource scope on all `blinter.*` configuration settings
- Breakpoint support for `.cmd` files
- Debug adapter process timeout using `blinter.processTimeoutMs`
- `releaseSnapshot()` cleanup when batch documents close

### Fixed

- Clear debug diagnostics when a `blinter-debug` session ends (revert to lint-only Problems/decorations)
- Debug adapter timeout no longer double-calls `handleProcessExit` or emits duplicate `terminated` events
- Cancel pending on-type lint debounce and in-flight lint when a batch document closes
- Debug launch and executable resolution now honor workspace-scoped `blinter.*` settings
- Cap lint stdout/stderr buffer growth to prevent unbounded memory use during noisy runs
- `blinter.run` now uses the same visible-batch-editor resolution as `blinter.runAndDebug`
- `${fileBasename}` in launch configuration resolves to the file basename (not the full path)

### Changed

- Removed redundant `test:unit` CI step; unified unit test file list for `test:unit` and `test:coverage`
- Unified unit test file list shared by `test:unit` and `test:coverage`
- `test:integration` sets `BLINTER_INTEGRATION_ONLY=1` automatically; added `npm run setup:vendor`
- Root helper scripts moved to `scripts/` (`setup-vendor`, `build`, `publish`, `run_tests`)
- Integration test runner prefers project-local `.vscode-test` VS Code cache before downloading
- Exit code 1 (lint findings) no longer reported as errored status; only code 2 and process failures are errored
- Blinter Output webview and critical decorations now use merged lint + debug issues (consistent with Problems panel)
- `launch.json` `args` documented and validated as Blinter CLI flags only
- Decoration disposables cleaned up on extension deactivate
- `create-config` command respects `blinter.processTimeoutMs`
- Updated `docs/project-spec.md` to reflect native executable architecture (removed obsolete `progress.txt` agent workflow)

## [v1.26.80600]

### Added

- Modular extension architecture (`lib/controller`, `lib/lintService`, `lib/debugSession`, and related modules)
- Unified issue parsing via `lib/issueParser.js` with consistent severity mapping across lint and debug
- Dirty-buffer snapshots for lint/debug when files have unsaved changes (`blinter.saveBeforeLint` to opt into save-first behavior)
- `blinter.processTimeoutMs` setting to terminate hung Blinter processes
- Multi-root workspace support for configuration, status bar, and `blinter.ini` creation
- Expanded coverage gate across all `lib/*.js` modules

### Fixed

- Lint no longer corrupts an active debug session (separate lint/debug state)
- `deactivate()` now cancels in-flight lint runs, debounce timers, and temp snapshots
- Webview navigation validates file paths against workspace/issue allowlists
- Issue deduplication during debug streaming
- Non-error diagnostics are no longer over-classified as critical
- Debug adapter now treats null/undefined process exit codes as failures (consistent with lint)

### Changed

- **Breaking:** Run and Debug default keybinding is now `Ctrl+F5` (was `F5` in v1.26.38560) to avoid overriding VS Code's built-in debug shortcut
- Test-only commands register only when `BLINTER_TEST_MODE=1`
- Removed unimplemented `attach` request from the `blinter-debug` schema
- CI runs UAT checks and uses `BLINTER_INTEGRATION_ONLY=1` for the VS Code test runner; vendor binary comes from the latest stable Blinter release unless `BLINTER_VERSION` is set

## [v1.26.38560]

### Fixed

- Register `blinter.runAndDebug` command for `.bat` and `.cmd` files (default keybinding was `F5`; superseded by `Ctrl+F5` in v1.26.80600)
- Use upstream Blinter icon (`icons/blinter_icon.ico`) and generate marketplace PNG via `prepare:icons`
- Fix vendor setup to download release `Blinter.exe` instead of source zip
- Register quick fixes and suppressions for `.cmd` files
- Unify executable discovery (vendor, upstream installer path, legacy `bin/`, PATH)

### Changed

- CI downloads vendor binary, runs typecheck/unit tests, and verifies VSIX contents
- Documentation aligned with `vendor/Blinter/Blinter.exe` layout
- Added `blinter.binaryPath` and `blinter.useSystemBlinter` settings

## [v1.26.15680]

- new icon
- fixed blinter output view
- fixed quick fix
- exposed more settings for `blinter-debug` and output view
- fixed launch config generation
