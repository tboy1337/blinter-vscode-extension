# Packaging and VSIX inclusion notes for Blinter extension

This document explains how to package the extension so Windows users receive the bundled native `Blinter.exe`.

## Checklist before packaging

- Run vendor setup so `vendor/Blinter/Blinter.exe` exists:
  ```powershell
  .\scripts\setup-vendor.cmd
  ```
  or
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-vendor.ps1
  ```
- Ensure `icons/blinter_icon.ico` exists (upstream logo) and run `npm run prepare:icons` to generate `icons/blinter-logo.png` for the marketplace.
- Ensure `.vscodeignore` whitelists `vendor/**` and `icons/**`.
- The extension ships the native Blinter executable only (no Python runtime).

## Third-party license and redistribution notes

The bundled native executable is a third-party project (Blinter) authored by
`tboy1337` and licensed under the GNU AGPL-3.0. Upstream source is available at
https://github.com/tboy1337/Blinter.

Redistributing AGPL-licensed binaries carries copyleft obligations. If you publish a
VSIX containing the AGPL binary, ensure recipients can access the corresponding
source. Review AGPL requirements before publishing to the Marketplace or other
distribution channels.

Alternatives if bundling AGPL binaries is not acceptable:

- Do not bundle the executable; document that users must install Blinter separately
  (for example via upstream [install_blinter.cmd](https://raw.githubusercontent.com/tboy1337/Blinter/main/scripts/install_blinter.cmd))
  and set `blinter.binaryPath` or `blinter.useSystemBlinter`.
- Provide a post-install download step that fetches the binary from upstream releases.

## Packaging steps (local)

1. Install dependencies:

```powershell
npm ci
```

2. Populate vendor binary and run checks:

```powershell
.\scripts\setup-vendor.cmd
npm run lint
npm run typecheck
npm run test:unit
```

3. Build the VSIX:

```powershell
npm run package:vsix
```

4. Verify the generated `.vsix` contains required files:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-vsix.ps1
```

## CI packaging

GitHub Actions runs vendor setup, tests, `npm run package:vsix`, and `tools/verify-vsix.ps1`
before uploading the VSIX artifact.

## Release publishing

1. Run `scripts\build.cmd` to bump `package.json`, write `version.txt`, and produce a versioned `*.vsix` in the repo root (previous VSIX files are moved to `releases\`).
2. Create `release_notes.md` in the repo root with the release notes for this version.
3. Publish:
   - `scripts\publish.cmd` — OpenVSX, VS Marketplace, and GitHub release
   - `scripts\publish_ovsx.cmd` — OpenVSX only

Set tokens via environment variables (preferred):

- `OVSX_PAT` — OpenVSX personal access token
- `VSCE_PAT` — Visual Studio Marketplace personal access token

Legacy fallback: tokens may still be read from `%USERPROFILE%\sauce\notes\inline.txt` under `openVSX:` and `vsce_azureGod:` headers when env vars are unset.

## Troubleshooting

- If `Blinter.exe` is missing from the VSIX, run `scripts/setup-vendor.ps1` before packaging.
- If the extension fails to execute the binary after install, verify the file is not blocked
  by Windows (Properties → Unblock) and matches your CPU architecture.
- Some antivirus software may flag PyInstaller-built executables as false positives.
