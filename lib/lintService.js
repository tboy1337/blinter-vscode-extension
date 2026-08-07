const path = require('path');
const fs = require('fs');
const vscode = require('vscode');
const { spawnBlinter, buildArgs } = require('./blinterRunner');
const { parseBlinterOutput } = require('./parser');
const { resolveBlinterExePath } = require('./executable');
const { resolveDocumentPath } = require('./documentSnapshot');
const { buildVariableIndexFromFile, createIssue } = require('./analysis');
const { getBlinterConfig, getProcessTimeoutMs, getWorkspaceFolderPath } = require('./config');
const { isFileDocument, normalizeFilePath, isPathAllowed } = require('./utils');

const STDERR_CAP = 64 * 1024;
const STDOUT_MAX_LINES = 10000;

/**
 * @param {import('./controller').BlinterController} controller
 * @returns {string[]}
 */
function getLintIssueKeys(controller) {
  if (controller.lintIssuesByFile instanceof Map) {
    return [...controller.lintIssuesByFile.keys()];
  }
  return [];
}

/**
 * @param {import('./controller').BlinterController} controller
 * @param {string} filePath
 * @param {import('../types/blinter').BlinterIssue[]} issues
 */
function setLintIssuesForFile(controller, filePath, issues) {
  const lintMap = controller.lintIssuesByFile;
  if (lintMap instanceof Map) {
    lintMap.set(filePath, issues);
    return;
  }
  const fallbackMap = /** @type {{ set?: (key: string, value: import('../types/blinter').BlinterIssue[]) => void }} */ (lintMap);
  if (fallbackMap && typeof fallbackMap.set === 'function') {
    fallbackMap.set(filePath, issues);
  }
}

/**
 * @param {import('./controller').BlinterController} controller
 * @param {string} displayPath
 * @param {string} workspaceFolder
 * @returns {string[]}
 */
function getLintAllowedPaths(controller, displayPath, workspaceFolder) {
  if (typeof controller.getDiagnosticAllowedPaths === 'function') {
    return controller.getDiagnosticAllowedPaths();
  }
  if (typeof controller.getAllowedRevealPaths === 'function') {
    return controller.getAllowedRevealPaths();
  }
  return [displayPath, workspaceFolder];
}

/**
 * @param {import('./controller').BlinterController} controller
 * @param {import('vscode').TextDocument} document
 * @returns {Promise<void>}
 */
async function lintDocument(controller, document) {
  if (controller.isDebugSessionActive()) {
    controller.log('[Linter] Skipping lint while debug session is active.');
    return;
  }

  const config = getBlinterConfig(document.uri);
  if (!config.get('enabled', true)) {
    return;
  }

  if (!isFileDocument(document)) {
    vscode.window.showWarningMessage('Save the file before linting or debugging.');
    return;
  }

  const saveBeforeLint = config.get('saveBeforeLint') === true;
  let resolved;
  try {
    resolved = await resolveDocumentPath(document, saveBeforeLint);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    controller.log(`[Linter] ${message}`);
    vscode.window.showWarningMessage(message);
    return;
  }

  const displayPath = normalizeFilePath(document.uri.fsPath);
  const analysisPath = resolved.filePath;
  if (!displayPath || !analysisPath) {
    return;
  }

  if (controller._currentLintHandle) {
    controller._currentLintHandle.cancel?.();
    controller._currentLintHandle.kill();
    controller._currentLintHandle = null;
  }

  const workspaceFolder = getWorkspaceFolderPath(document.uri) || path.dirname(displayPath);
  controller.currentProgramPath = displayPath;
  controller.currentWorkspaceRoot = workspaceFolder;
  controller.variableIndex = buildVariableIndexFromFile(analysisPath, fs);
  controller.updateLintStatus('running', path.basename(displayPath));

  for (const key of [...getLintIssueKeys(controller)]) {
    if (!(controller.debugIssuesByFile instanceof Map) || !controller.debugIssuesByFile.has(key)) {
      if (controller.lintIssuesByFile instanceof Map) {
        controller.lintIssuesByFile.delete(key);
      }
    }
  }
  if (controller.lintIssuesByFile instanceof Map) {
    controller.lintIssuesByFile.set(displayPath, []);
  } else {
    setLintIssuesForFile(controller, displayPath, []);
  }
  if (controller.lintDiagnostics && typeof controller.lintDiagnostics.delete === 'function') {
    controller.lintDiagnostics.delete(document.uri);
  }

  let exePath;
  try {
    exePath = resolveBlinterExePath(controller.context, document.uri);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    controller.log(`[Linter] Failed to resolve executable: ${message}`);
    controller.updateLintStatus('errored', message);
    vscode.window.showErrorMessage(`Failed to resolve Blinter executable: ${message}`);
    return;
  }

  const fullArgs = buildArgs(config, analysisPath);
  controller.log(`[Linter] Running: ${exePath} ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);

  const runId = controller._lintRunId + 1;
  controller._lintRunId = runId;

  /** @type {string[]} */
  const stdoutLines = [];
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    /**
     * @param {number | null | undefined} exitCodeRaw
     */
    const finalize = (exitCodeRaw) => {
      if (!controller._currentLintHandle || controller._currentLintHandle.runId !== runId) {
        finish();
        return;
      }
      controller._currentLintHandle = null;

      if (stdoutTruncated) {
        controller.log(`[Linter] stdout truncated after ${STDOUT_MAX_LINES} lines`);
      }
      if (stderrTruncated) {
        controller.log(`[Linter] stderr truncated after ${STDERR_CAP} bytes`);
      }
      if (stderr && stderr.trim()) {
        controller.log(`[Linter] stderr: ${stderr}`);
      }

      const parseContext = {
        workspaceRoot: workspaceFolder,
        defaultFile: displayPath
      };
      const parsed = parseBlinterOutput(stdoutLines.join('\n'), parseContext);
      const allowedPaths = getLintAllowedPaths(controller, displayPath, workspaceFolder);
      /** @type {Map<string, import('../types/blinter').BlinterIssue[]>} */
      const issuesByFile = new Map();
      let issueIndex = 0;

      for (const item of parsed) {
        let targetPath = normalizeFilePath(item.filePath) || displayPath;
        if (!isPathAllowed(targetPath, allowedPaths)) {
          targetPath = displayPath;
        }
        const issue = createIssue({
          severity: item.severity,
          message: item.description,
          filePath: targetPath,
          lineNumber: item.line,
          code: item.code,
          variableIndex: controller.variableIndex
        });
        issueIndex += 1;
        const withId = {
          ...issue,
          id: `lint-${runId}-${issueIndex}`
        };
        const existing = issuesByFile.get(targetPath) || [];
        existing.push(withId);
        issuesByFile.set(targetPath, existing);
      }

      if (issuesByFile.size === 0) {
        setLintIssuesForFile(controller, displayPath, []);
      } else {
        for (const [filePath, issues] of issuesByFile.entries()) {
          setLintIssuesForFile(controller, filePath, issues);
        }
      }

      const exitCode = typeof exitCodeRaw === 'number' ? exitCodeRaw : null;
      controller.handleProcessExit(exitCode, 'lint');
      finish();
    };

    try {
      const handle = spawnBlinter({
        exePath,
        config,
        filePath: analysisPath,
        cwd: path.dirname(analysisPath),
        timeoutMs: getProcessTimeoutMs(config),
        onLine: (line) => {
          if (stdoutLines.length < STDOUT_MAX_LINES) {
            stdoutLines.push(line);
          } else if (!stdoutTruncated) {
            stdoutTruncated = true;
          }
        },
        onStderr: (text) => {
          const chunk = String(text);
          if (stderr.length >= STDERR_CAP) {
            if (!stderrTruncated) {
              stderrTruncated = true;
            }
            return;
          }
          const remaining = STDERR_CAP - stderr.length;
          stderr += chunk.slice(0, remaining);
          if (chunk.length > remaining) {
            stderrTruncated = true;
          }
        },
        onExit: (exitCode) => {
          finalize(exitCode);
        }
      });

      controller._currentLintHandle = {
        runId,
        filePath: displayPath,
        kill: () => handle.kill(),
        cancel: finish
      };
    } catch (error) {
      if (controller._currentLintHandle && controller._currentLintHandle.runId === runId) {
        controller._currentLintHandle = null;
      }
      const message = error instanceof Error ? error.message : String(error);
      controller.log(`[Linter] Failed to start process: ${message}`);
      controller.updateLintStatus('errored', message);
      vscode.window.showErrorMessage(`Failed to run Blinter: ${message}`);
      finish();
    }
  });
}

module.exports = {
  lintDocument,
  getLintAllowedPaths
};
