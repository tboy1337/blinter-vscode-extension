# Packaging and VSIX inclusion notes for Blinter extension

This document explains how to package the extension so Windows users receive the bundled native `Blinter.exe`.

## Checklist before packaging

- Run vendor setup so `vendor/Blinter/Blinter.exe` exists:
  ```powershell
  .\setup-vendor.cmd
  ```
  or
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-vendor.ps1
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
  (for example via upstream [install_blinter.cmd](https://raw.githubusercontent.com/tboy1337/Blinter/refs/heads/main/scripts/install_blinter.cmd))
  and set `blinter.binaryPath` or `blinter.useSystemBlinter`.
- Provide a post-install download step that fetches the binary from upstream releases.

## Packaging steps (local)

1. Install dependencies:

```powershell
npm ci
```

2. Populate vendor binary and run checks:

```powershell
.\setup-vendor.cmd
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

## Troubleshooting

- If `Blinter.exe` is missing from the VSIX, run `setup-vendor.ps1` before packaging.
- If the extension fails to execute the binary after install, verify the file is not blocked
  by Windows (Properties → Unblock) and matches your CPU architecture.
- Some antivirus software may flag PyInstaller-built executables as false positives.
