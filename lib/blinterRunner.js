const cp = require('child_process');
const path = require('path');
const { findBlinterExecutable } = require('./discovery');
const { coerceMaxLineLength, sanitizeRuleList } = require('./configHelpers');
const { STDOUT_BUFFER_CAP } = require('./streamLimits');

/**
 * Resolve extension root from a string path or vscode.Uri-like object.
 * @param {string|{ fsPath?: string }|undefined} extensionUri
 * @returns {string}
 */
function resolveExtensionRoot(extensionUri) {
  if (extensionUri && typeof extensionUri === 'object' && extensionUri.fsPath) {
    return extensionUri.fsPath;
  }
  if (typeof extensionUri === 'string' && extensionUri.trim()) {
    return extensionUri;
  }
  return path.resolve(__dirname, '..');
}

/**
 * Resolve the Blinter executable path from the extension root.
 * @param {string|{ fsPath?: string }|undefined} extensionUri
 * @param {{ binaryPath?: string, useSystemBlinter?: boolean }} [options]
 * @returns {string}
 */
function getExePath(extensionUri, options) {
  const basePath = resolveExtensionRoot(extensionUri);
  const resolved = findBlinterExecutable(basePath, process.platform, undefined, options);
  if (resolved) {
    return resolved;
  }
  return path.join(basePath, 'vendor', 'Blinter', 'Blinter.exe');
}

/**
 * Build CLI arguments from extension settings.
 * @param {{ get: (key: string, defaultValue?: unknown) => unknown }} config
 * @param {string} filePath
 * @returns {string[]}
 */
function buildArgs(config, filePath) {
  const args = [];

  if (config.get('followCalls', false)) {
    args.push('--follow-calls');
  }

  const minSeverity = config.get('minSeverity', 'all');
  if (minSeverity && minSeverity !== 'all') {
    args.push('--min-severity', String(minSeverity));
  }

  const enabledRules = sanitizeRuleList(config, 'enabledRules');
  if (enabledRules.length > 0) {
    args.push('--enabled-rules', enabledRules.join(','));
  }

  const disabledRules = sanitizeRuleList(config, 'disabledRules');
  if (disabledRules.length > 0) {
    args.push('--disabled-rules', disabledRules.join(','));
  }

  if (config.get('useConfigFile', true) === false) {
    args.push('--no-config');
  }

  const maxLineLength = coerceMaxLineLength(config);
  if (maxLineLength !== 100) {
    args.push('--max-line-length', String(maxLineLength));
  }

  if (config.get('noRecursive', false)) {
    args.push('--no-recursive');
  }

  args.push('--summary');
  args.push(filePath);
  return args;
}

/**
 * Spawn a Blinter lint process.
 * @param {object} opts
 * @param {string} opts.exePath
 * @param {{ get: (key: string, defaultValue?: unknown) => unknown }} opts.config
 * @param {string} opts.filePath
 * @param {string} [opts.cwd]
 * @param {(line: string) => void} [opts.onLine]
 * @param {(text: string) => void} [opts.onStderr]
 * @param {(code: number|null) => void} [opts.onExit]
 * @param {(command: string, args: string[], options: import('child_process').SpawnOptions) => import('child_process').ChildProcess} [opts.spawnImpl]
 * @param {number} [opts.timeoutMs]
 * @returns {{ kill: () => void, process: import('child_process').ChildProcess }}
 */
function spawnBlinter(opts) {
  const { exePath, config, filePath, cwd, onLine, onStderr, onExit, spawnImpl, timeoutMs } = opts;
  const args = buildArgs(config, filePath);

  const spawn = spawnImpl || cp.spawn;
  const proc = spawn(exePath, args, {
    cwd: cwd || path.dirname(filePath),
    windowsHide: true
  });

  const encoding = String(config.get('encoding', 'utf8') || 'utf8');
  if (proc.stdout && typeof proc.stdout.setEncoding === 'function') {
    try {
      proc.stdout.setEncoding(/** @type {BufferEncoding} */ (encoding));
    } catch {
      proc.stdout.setEncoding('utf8');
    }
  }
  if (proc.stderr && typeof proc.stderr.setEncoding === 'function') {
    try {
      proc.stderr.setEncoding(/** @type {BufferEncoding} */ (encoding));
    } catch {
      proc.stderr.setEncoding('utf8');
    }
  }

  let settled = false;
  /** @type {NodeJS.Timeout | undefined} */
  let timeoutHandle;
  /**
   * @param {number | null | undefined} code
   */
  const finish = (code) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    if (onExit) {
      onExit(code ?? null);
    }
  };

  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      if (onStderr) {
        onStderr(`Blinter process timed out after ${timeoutMs}ms`);
      }
      try {
        proc.kill();
      } catch {
        // Ignore kill failures.
      }
      finish(null);
    }, timeoutMs);
  }

  let stdoutBuffer = '';
  if (proc.stdout) {
    proc.stdout.on('data', (data) => {
      const chunk = String(data);
      if (stdoutBuffer.length < STDOUT_BUFFER_CAP) {
        const remaining = STDOUT_BUFFER_CAP - stdoutBuffer.length;
        stdoutBuffer += chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
      }
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.substring(0, newlineIndex).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.substring(newlineIndex + 1);
        if (onLine) {
          onLine(line);
        }
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });
  }

  if (proc.stderr) {
    proc.stderr.on('data', (data) => {
      if (onStderr) {
        onStderr(String(data));
      }
    });
  }

  proc.on('close', (code) => {
    if (stdoutBuffer.length > 0) {
      const line = stdoutBuffer.replace(/\r$/, '');
      if (line && onLine) {
        onLine(line);
      }
      stdoutBuffer = '';
    }
    finish(code);
  });

  proc.on('error', (error) => {
    if (onStderr) {
      onStderr(error && error.message ? error.message : String(error));
    }
    finish(null);
  });

  return {
    kill: () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      if (proc && !proc.killed) {
        try {
          proc.kill();
        } catch {
          // Ignore kill failures.
        }
      }
    },
    process: proc
  };
}

module.exports = {
  getExePath,
  buildArgs,
  spawnBlinter
};
