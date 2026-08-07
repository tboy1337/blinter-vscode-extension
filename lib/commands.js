const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const { isBatchDocument, getActiveOrVisibleBatchEditor } = require('./utils');
const { getWorkspaceFolderPath, getProcessTimeoutMs } = require('./config');
const { resolveBlinterExePath } = require('./executable');

const STDERR_CAP = 64 * 1024;

/** @type {import('child_process').ChildProcess | null} */
let activeCreateConfigProcess = null;

/** @type {(message: string) => void} */
let errorLogger = (message) => {
  console.error(message);
};

/**
 * @param {(message: string) => void} logger
 */
function setErrorLogger(logger) {
  errorLogger = logger;
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {import('./controller').BlinterController} controller
 */
function registerCommands(context, controller) {
  context.subscriptions.push(vscode.commands.registerCommand('blinter.runAndDebug', async () => {
    const editor = getActiveOrVisibleBatchEditor();
    if (!editor) {
      vscode.window.showInformationMessage('Open a .bat or .cmd file to run and debug.');
      return;
    }
    const started = await vscode.debug.startDebugging(undefined, {
      type: 'blinter-debug',
      name: 'Launch Batch (Blinter)',
      request: 'launch',
      program: editor.document.uri.fsPath
    });
    if (!started) {
      vscode.window.showErrorMessage('Failed to start Blinter debug session.');
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blinter.run', async () => {
    const editor = getActiveOrVisibleBatchEditor();
    if (editor && isBatchDocument(editor.document)) {
      try {
        await controller.lintDocument(editor.document);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controller.log(`[Run] Failed to lint document: ${message}`);
      }
    } else {
      vscode.window.showInformationMessage('Open a .bat or .cmd file to run Blinter.');
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blinter.createConfig', async () => {
    const editor = vscode.window.activeTextEditor;
    const scopeUri = editor ? editor.document.uri : undefined;
    const workspaceRoot = getWorkspaceFolderPath(scopeUri);
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('No workspace folder open. Open a workspace first.');
      return;
    }
    const iniPath = path.join(workspaceRoot, 'blinter.ini');

    if (fs.existsSync(iniPath)) {
      const overwrite = await vscode.window.showWarningMessage(
        'blinter.ini already exists in the workspace root. Overwrite?',
        'Yes', 'No'
      );
      if (overwrite !== 'Yes') {
        return;
      }
    }

    let exePath;
    try {
      exePath = resolveBlinterExePath(context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      controller.log(`[CreateConfig] ${message}`);
      vscode.window.showErrorMessage(message);
      return;
    }
    const config = vscode.workspace.getConfiguration('blinter', scopeUri);
    const timeoutMs = getProcessTimeoutMs(config);
    if (activeCreateConfigProcess) {
      try {
        activeCreateConfigProcess.kill();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controller.log(`[CreateConfig] Failed to kill previous process: ${message}`);
      }
      activeCreateConfigProcess = null;
    }

    const proc = cp.spawn(exePath, ['--create-config'], {
      cwd: workspaceRoot,
      windowsHide: true
    });
    activeCreateConfigProcess = proc;

    /** @type {NodeJS.Timeout | undefined} */
    let timeoutHandle;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        controller.log(`[CreateConfig] Timed out after ${timeoutMs}ms`);
        try {
          proc.kill();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          controller.log(`[CreateConfig] Failed to kill timed-out process: ${message}`);
        }
      }, timeoutMs);
    }

    let stderr = '';
    if (proc.stderr) {
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d) => {
        const chunk = String(d);
        if (stderr.length < STDERR_CAP) {
          stderr += chunk.slice(0, STDERR_CAP - stderr.length);
        }
      });
    }

    proc.on('close', async (code) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      if (activeCreateConfigProcess === proc) {
        activeCreateConfigProcess = null;
      }
      if (code === 0 && fs.existsSync(iniPath)) {
        try {
          const doc = await vscode.workspace.openTextDocument(iniPath);
          await vscode.window.showTextDocument(doc);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          controller.log(`[CreateConfig] Created file but failed to open: ${message}`);
        }
      } else {
        controller.log(`[CreateConfig] Failed (code ${code}): ${stderr}`);
        vscode.window.showErrorMessage('Failed to create blinter.ini. Check the Blinter Output channel for details.');
      }
    });

    proc.on('error', (err) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      if (activeCreateConfigProcess === proc) {
        activeCreateConfigProcess = null;
      }
      controller.log(`[CreateConfig] Error: ${err.message}`);
      vscode.window.showErrorMessage('Failed to run Blinter. Check the Blinter Output channel for details.');
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blinter.askCopilot', async (payload) => {
    try {
      await controller.askCopilotAboutDiagnostic(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      controller.log(`[AskCopilot] Error: ${message}`);
      vscode.window.showErrorMessage('Unable to open Copilot Chat for this diagnostic.');
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blinter.removeAllSuppressions', async () => {
    try {
      await controller.removeAllSuppressionComments();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      controller.log(`[Suppressions] Error: ${message}`);
      vscode.window.showErrorMessage('Failed to remove suppression comments. Check the Blinter Output channel for details.');
    }
  }));

  if (process.env.BLINTER_TEST_MODE === '1') {
    context.subscriptions.push(vscode.commands.registerCommand('blinter.test.getOutputViewState', () => {
      return controller.getOutputViewStateForTest();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('blinter.test.getController', () => controller));
  }
}

function killCreateConfigProcess() {
  if (activeCreateConfigProcess) {
    try {
      activeCreateConfigProcess.kill();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorLogger(`[Blinter] Failed to kill create-config process: ${message}`);
    }
    activeCreateConfigProcess = null;
  }
}

module.exports = {
  registerCommands,
  killCreateConfigProcess,
  setErrorLogger
};
