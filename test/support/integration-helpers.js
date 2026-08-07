const vscode = require('vscode');
const { pollUntil } = require('./poll');

const EXTENSION_ID = 'tboy1337.blinter';

/** Commands expected after activation in BLINTER_TEST_MODE. */
const CORE_COMMANDS = [
  'blinter.run',
  'blinter.runAndDebug',
  'blinter.createConfig',
  'blinter.removeAllSuppressions',
  'blinter.askCopilot',
  'blinter.test.getOutputViewState',
  'blinter.test.getController'
];

/**
 * @returns {Promise<import('vscode').Extension<unknown> | undefined>}
 */
async function activateBlinter() {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (ext && !ext.isActive) {
    await ext.activate();
  }
  return ext;
}

/**
 * @param {number} [timeoutMs]
 * @returns {Promise<import('vscode').DebugSession>}
 */
function waitForDebugTermination(timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const state = { disposable: null };
    const timer = setTimeout(() => {
      if (state.disposable) {
        state.disposable.dispose();
      }
      reject(new Error(`Timed out waiting for debug termination after ${timeoutMs}ms`));
    }, timeoutMs);

    state.disposable = vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.type !== 'blinter-debug') {
        return;
      }
      clearTimeout(timer);
      state.disposable.dispose();
      resolve(session);
    });
  });
}

/**
 * @param {string} filePath
 * @returns {Promise<import('vscode').TextDocument>}
 */
async function openBatchFile(filePath) {
  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc, { preview: false });
  return doc;
}

/**
 * @param {import('vscode').Uri} docUri
 * @param {{ minCount?: number, timeoutMs?: number, label?: string }} [options]
 * @returns {Promise<import('vscode').Diagnostic[]>}
 */
async function pollBlinterDiagnostics(docUri, options = {}) {
  const minCount = options.minCount ?? 1;
  return pollUntil(() => {
    const current = vscode.languages.getDiagnostics(docUri);
    const blinter = current.filter((d) => d.source === 'blinter');
    if (blinter.length >= minCount) {
      return blinter;
    }
    return null;
  }, {
    timeoutMs: options.timeoutMs ?? 20000,
    label: options.label ?? 'blinter diagnostics'
  });
}

/**
 * @param {string} programPath
 * @param {string} [name]
 * @returns {Promise<{ started: boolean, terminated: Promise<import('vscode').DebugSession> }>}
 */
async function startBlinterDebug(programPath, name = 'Launch Batch (Blinter)') {
  const terminated = waitForDebugTermination();
  const started = await vscode.debug.startDebugging(undefined, {
    type: 'blinter-debug',
    name,
    request: 'launch',
    program: programPath
  });
  return { started, terminated };
}

/**
 * @returns {Promise<import('vscode').Extension<unknown>['packageJSON']>}
 */
async function getExtensionPackageJson() {
  const ext = await activateBlinter();
  if (!ext) {
    throw new Error(`Extension ${EXTENSION_ID} is not available in the test host`);
  }
  return ext.packageJSON;
}

/**
 * Run blinter.run and wait for the lint command to finish.
 * @returns {Promise<void>}
 */
async function runBlinterLint() {
  await vscode.commands.executeCommand('blinter.run');
}

/**
 * @param {{ timeoutMs?: number, label?: string }} [options]
 * @returns {Promise<void>}
 */
async function waitForLintComplete(options = {}) {
  await pollUntil(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    if (!ext || !ext.isActive) {
      return null;
    }
    const controller = await vscode.commands.executeCommand('blinter.test.getController');
    if (!controller || typeof controller.getDisplayStatus !== 'function') {
      return null;
    }
    const status = controller.getDisplayStatus();
    if (status && status.state !== 'running') {
      return true;
    }
    return null;
  }, {
    timeoutMs: options.timeoutMs ?? 30000,
    label: options.label ?? 'lint completion'
  });
}

module.exports = {
  EXTENSION_ID,
  CORE_COMMANDS,
  activateBlinter,
  waitForDebugTermination,
  openBatchFile,
  pollBlinterDiagnostics,
  runBlinterLint,
  waitForLintComplete,
  startBlinterDebug,
  getExtensionPackageJson
};
