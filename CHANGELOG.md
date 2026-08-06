# Changelog

All notable changes to this project are documented in this file.

## [v1.26.38560]

### Fixed

- Register `blinter.runAndDebug` command (F5) for `.bat` and `.cmd` files
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
