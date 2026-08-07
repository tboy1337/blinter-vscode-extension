const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

/**
 * @param {string} candidate
 * @param {string} rootPath
 * @returns {boolean}
 */
function isPathInsideRoot(candidate, rootPath) {
  const normalized = path.normalize(candidate);
  const root = path.normalize(rootPath);
  if (!normalized || !root) {
    return false;
  }
  const rootLower = root.toLowerCase();
  const normalizedLower = normalized.toLowerCase();
  if (normalizedLower === rootLower) {
    return true;
  }
  const prefix = rootLower.endsWith(path.sep) ? rootLower : `${rootLower}${path.sep}`;
  return normalizedLower.startsWith(prefix);
}

/**
 * @param {string} exeName
 * @param {string} [platform]
 * @returns {boolean}
 */
function isOnPath(exeName, platform) {
  const resolvedPlatform = platform || process.platform;
  if (resolvedPlatform !== 'win32') {
    return false;
  }
  try {
    const result = cp.spawnSync('where', [exeName], {
      encoding: 'utf8',
      windowsHide: true
    });
    return result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the Blinter executable using ordered fallbacks.
 * @param {string} extensionPath
 * @param {string} [platform]
 * @param {(path: string) => boolean} [existsSync]
 * @param {{ binaryPath?: string, useSystemBlinter?: boolean }} [options]
 * @returns {string|null}
 */
function findBlinterExecutable(extensionPath, platform, existsSync, options) {
  existsSync = existsSync || fs.existsSync;
  options = options || {};
  const resolvedPlatform = platform || process.platform;
  const isWindows = resolvedPlatform === 'win32';
  const exeName = isWindows ? 'blinter.exe' : 'blinter';
  const ExeName = isWindows ? 'Blinter.exe' : 'Blinter';

  // 1) User-configured binary path
  if (options.binaryPath && typeof options.binaryPath === 'string') {
    try {
      const candidate = path.isAbsolute(options.binaryPath)
        ? path.normalize(options.binaryPath)
        : path.normalize(path.join(extensionPath, options.binaryPath));
      if (!path.isAbsolute(options.binaryPath) && !isPathInsideRoot(candidate, extensionPath)) {
        return null;
      }
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore and continue
    }
  }

  // 2) Bundled vendor executable
  const vendorExe = path.join(extensionPath, 'vendor', 'Blinter', ExeName);
  if (existsSync(vendorExe)) {
    return vendorExe;
  }

  // 3) Upstream installer path (%LOCALAPPDATA%\Programs\Blinter\bin\blinter.exe)
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const installedExe = path.join(localAppData, 'Programs', 'Blinter', 'bin', exeName);
    if (existsSync(installedExe)) {
      return installedExe;
    }
    const installedExeAlt = path.join(localAppData, 'Programs', 'Blinter', 'bin', ExeName);
    if (existsSync(installedExeAlt)) {
      return installedExeAlt;
    }
  }

  // 4) Legacy bin/ and bins/ locations
  const candidates = [
    path.join(extensionPath, 'bin', exeName),
    path.join(extensionPath, 'bin', ExeName),
    path.join(extensionPath, 'bins', exeName),
    path.join(extensionPath, 'bins', ExeName)
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // 5) Versioned executables in bin/ or bins/
  if (isWindows) {
    const binDirs = [
      path.join(extensionPath, 'bin'),
      path.join(extensionPath, 'bins')
    ];

    for (const binDir of binDirs) {
      try {
        const files = fs.readdirSync(binDir);
        const versioned = files.find((fileName) =>
          /^[Bb]linter[-v]?[\d.]+\.exe$/i.test(fileName)
        );
        if (versioned) {
          const fullPath = path.join(binDir, versioned);
          if (existsSync(fullPath)) {
            return fullPath;
          }
        }
      } catch {
        // Directory missing or unreadable
      }
    }
  }

  // 6) Resolve from PATH when opted in
  if (options.useSystemBlinter && isOnPath(exeName, resolvedPlatform)) {
    return exeName;
  }

  return null;
}

module.exports = { findBlinterExecutable };
