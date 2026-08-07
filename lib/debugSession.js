const path = require('path');
const fs = require('fs');
const vscode = require('vscode');
const analysis = require('./analysis');
const { buildArgs } = require('./blinterRunner');
const { resolveBlinterExePath } = require('./executable');
const { resolveProgramPathForLaunch } = require('./documentSnapshot');
const { getBlinterConfig, getWorkspaceFolderPath, getProcessTimeoutMs } = require('./config');
const {
  getActiveOrVisibleBatchEditor,
  isBatchDocument,
  normalizeFilePath,
  isPathAllowed
} = require('./utils');

const ALLOWED_BLINTER_CLI_FLAGS = new Set(['--verbose', '--quiet', '--format', '--output']);
const BLINTER_CLI_VALUE_FLAGS = new Set(['--format', '--output']);

/**
 * @param {string[]} args
 * @param {(message: string) => void} log
 * @returns {string[]}
 */
function filterBlinterCliArgs(args, log) {
  /** @type {string[]} */
  const filtered = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      log(`[Launch] Ignoring non-flag launch arg: ${JSON.stringify(arg)}`);
      continue;
    }
    if (!ALLOWED_BLINTER_CLI_FLAGS.has(arg)) {
      log(`[Launch] Ignoring unknown Blinter CLI flag in launch.json: ${JSON.stringify(arg)}`);
      continue;
    }
    filtered.push(arg);
    if (BLINTER_CLI_VALUE_FLAGS.has(arg) && i + 1 < args.length) {
      i += 1;
      filtered.push(args[i]);
    }
  }
  return filtered;
}

/**
 * @param {import('./controller').BlinterController} controller
 * @param {Record<string, unknown>} args
 * @param {import('vscode').DebugSession | { id?: string }} session
 */
async function prepareForLaunch(controller, args, session) {
  controller.clearDebugIssues();

  if (!args || !args.program) {
    throw new Error('Launch configuration is missing the "program" field.');
  }

  const debugSession = /** @type {import('vscode').DebugSession | undefined} */ (
    session && 'workspaceFolder' in session ? session : undefined
  );

  /** @type {import('vscode').Uri | undefined} */
  let scopeUri = debugSession?.workspaceFolder?.uri;

  let workspaceFolder = debugSession?.workspaceFolder?.uri?.fsPath
    || (typeof args.workspaceFolder === 'string' ? args.workspaceFolder : undefined);

  let programPath;
  let editorPath;
  if (args.program === '${file}' || args.program === '${fileBasename}') {
    const editor = getActiveOrVisibleBatchEditor();
    if (editor && isBatchDocument(editor.document)) {
      if (editor.document.uri.scheme === 'untitled') {
        throw new Error('Save the file before linting or debugging.');
      }
      editorPath = editor.document.uri.fsPath;
      if (!scopeUri) {
        scopeUri = editor.document.uri;
      }
      programPath = args.program === '${fileBasename}'
        ? path.basename(editor.document.uri.fsPath)
        : editor.document.uri.fsPath;
    } else {
      throw new Error('No active batch file found. Open a .bat or .cmd file first.');
    }
  } else {
    if (!workspaceFolder) {
      workspaceFolder = getWorkspaceFolderPath(undefined);
    }
    programPath = resolveProgramPath(String(args.program), workspaceFolder);
  }

  const resolved = await resolveProgramPathForLaunch(programPath);
  const analysisPath = resolved.filePath;
  const displayPath = normalizeFilePath(path.isAbsolute(programPath) ? programPath : analysisPath);
  if (!displayPath) {
    throw new Error('Program path could not be resolved.');
  }

  if (!scopeUri) {
    scopeUri = vscode.Uri.file(displayPath);
  }

  const config = getBlinterConfig(scopeUri);
  if (!config.get('enabled', true)) {
    throw new Error('Blinter is disabled in settings. Enable "blinter.enabled" to run debugging.');
  }

  controller.currentEncoding = config.get('encoding', 'utf8') || 'utf8';

  if (!fs.existsSync(analysisPath)) {
    throw new Error(`Program not found: ${analysisPath}`);
  }

  if (!workspaceFolder) {
    workspaceFolder = path.dirname(displayPath);
  }

  assertProgramPathAllowed(displayPath, workspaceFolder, editorPath);

  const exePath = resolveBlinterExePath(controller.context, scopeUri);
  const cliArgs = buildArgs(config, analysisPath);
  const rawUserArgs = Array.isArray(args.args)
    ? args.args.filter((/** @type {unknown} */ value) => typeof value === 'string' && value.trim().length > 0)
    : [];
  const userArgs = filterBlinterCliArgs(rawUserArgs, (message) => controller.log(message));
  const fullArgs = [...cliArgs, ...userArgs];
  const timeoutMs = getProcessTimeoutMs(config);

  controller.currentProgramPath = displayPath;
  controller.currentWorkspaceRoot = workspaceFolder || path.dirname(displayPath);
  controller.variableIndex = analysis.buildVariableIndexFromFile(analysisPath, fs);
  controller.updateDebugStatus('running', path.basename(displayPath));
  controller.webviewProvider?.ensureVisible();
  controller.updateWebview();

  controller.log(`Launching Blinter: ${exePath} ${fullArgs.map((a) => JSON.stringify(a)).join(' ')}`);

  return {
    executable: exePath,
    args: fullArgs,
    cwd: path.dirname(analysisPath),
    timeoutMs
  };
}

/**
 * @param {string} programPath
 * @param {string | undefined} workspaceFolder
 * @param {string | undefined} editorPath
 */
function assertProgramPathAllowed(programPath, workspaceFolder, editorPath) {
  const normalized = normalizeFilePath(programPath);
  if (!normalized) {
    throw new Error('Program path could not be resolved.');
  }

  /** @type {string[]} */
  const allowed = [];
  if (workspaceFolder) {
    allowed.push(workspaceFolder);
  }
  for (const folder of vscode.workspace.workspaceFolders || []) {
    allowed.push(folder.uri.fsPath);
  }
  if (editorPath) {
    allowed.push(path.dirname(editorPath));
  }
  if (allowed.length === 0) {
    allowed.push(path.dirname(normalized));
  }

  if (!isPathAllowed(normalized, allowed)) {
    throw new Error(`Program path is outside the allowed workspace: ${normalized}`);
  }
}

/**
 * @param {string} program
 * @param {string | undefined} workspaceFolder
 */
function resolveProgramPath(program, workspaceFolder) {
  if (path.isAbsolute(program)) {
    return path.normalize(program);
  }
  if (workspaceFolder) {
    return path.normalize(path.join(workspaceFolder, program));
  }
  return path.normalize(path.resolve(process.cwd(), program));
}

/**
 * @param {import('./controller').BlinterController} controller
 * @param {string} line
 * @param {string} channel
 */
function acceptProcessText(controller, line, channel) {
  const text = line.replace(/\r?$/, '');
  if (!text) {
    return;
  }

  controller.log(`[${channel}] ${text}`);

  const { issues } = analysis.analyzeLine(text, {
    workspaceRoot: typeof controller.currentWorkspaceRoot === 'string' ? controller.currentWorkspaceRoot : undefined,
    defaultFile: typeof controller.currentProgramPath === 'string' ? controller.currentProgramPath : undefined,
    variableIndex: controller.variableIndex
  });

  if (!issues || issues.length === 0) {
    return;
  }

  for (const issue of issues) {
    addIssue(controller, issue);
  }
}

/**
 * @param {import('./controller').BlinterController} controller
 * @returns {string[]}
 */
function getDebugAllowedPaths(controller) {
  if (typeof controller.getDiagnosticAllowedPaths === 'function') {
    return controller.getDiagnosticAllowedPaths();
  }
  /** @type {string[]} */
  const allowed = [];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    allowed.push(folder.uri.fsPath);
  }
  if (typeof controller.currentWorkspaceRoot === 'string' && controller.currentWorkspaceRoot) {
    allowed.push(controller.currentWorkspaceRoot);
  }
  if (typeof controller.currentProgramPath === 'string' && controller.currentProgramPath) {
    allowed.push(path.dirname(controller.currentProgramPath));
  }
  return allowed;
}

/**
 * @param {import('./controller').BlinterController} controller
 * @param {import('../types/blinter').BlinterIssue} issue
 */
function addIssue(controller, issue) {
  let targetFile = normalizeFilePath(issue.filePath || controller.currentProgramPath);
  if (!targetFile) {
    return;
  }

  const allowedPaths = getDebugAllowedPaths(controller);
  if (!isPathAllowed(targetFile, allowedPaths)) {
    const fallback = typeof controller.currentProgramPath === 'string'
      ? normalizeFilePath(controller.currentProgramPath)
      : '';
    if (!fallback || !isPathAllowed(fallback, allowedPaths)) {
      return;
    }
    targetFile = fallback;
  }

  issue.filePath = targetFile;
  if (!controller.debugIssuesByFile.has(issue.filePath)) {
    controller.debugIssuesByFile.set(issue.filePath, []);
  }
  const fileIssues = controller.debugIssuesByFile.get(issue.filePath);
  if (!fileIssues) {
    return;
  }

  const dedupeKey = `${issue.line || 0}|${issue.code || ''}|${issue.message}`;
  const exists = fileIssues.some((/** @type {import('../types/blinter').BlinterIssue} */ existing) =>
    `${existing.line || 0}|${existing.code || ''}|${existing.message}` === dedupeKey
  );
  if (exists) {
    return;
  }

  fileIssues.push(issue);
  controller.scheduleDiagnosticsUpdate();
}

module.exports = {
  prepareForLaunch,
  resolveProgramPath,
  assertProgramPathAllowed,
  acceptProcessText,
  addIssue,
  filterBlinterCliArgs
};
