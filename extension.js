const path = require('path');
const vscode = require('vscode');
const { BlinterController } = require('./lib/controller');
const { registerCommands, killCreateConfigProcess } = require('./lib/commands');
const { isBatchDocument, getActiveOrVisibleBatchEditor } = require('./lib/utils');

/** @type {import('./lib/controller').BlinterController | undefined} */
let activeController;

/** @param {import('vscode').ExtensionContext} context */
function activate(context) {
  if (process.platform !== 'win32') {
    vscode.window.showErrorMessage('Blinter only supports Windows OS. Extension will not be activated.');
    return;
  }

  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('blinter-debug', {
      resolveDebugConfiguration(_workspaceFolder, config) {
        if (!config || typeof config !== 'object') {
          config = { type: '', name: '', request: '' };
        }

        if (!config.type && !config.request && !config.name) {
          const editor = getActiveOrVisibleBatchEditor();
          if (editor) {
            config.type = 'blinter-debug';
            config.name = 'Launch Batch (Blinter)';
            config.request = 'launch';
            config.program = editor.document.uri.fsPath;
          } else {
            return undefined;
          }
        }

        if (!config.type) {
          config.type = 'blinter-debug';
        }

        if (config.program === '${file}' || config.program === '${fileBasename}') {
          const editor = getActiveOrVisibleBatchEditor();
          if (editor && isBatchDocument(editor.document)) {
            config.program = config.program === '${fileBasename}'
              ? path.basename(editor.document.uri.fsPath)
              : editor.document.uri.fsPath;
          } else {
            vscode.window.showErrorMessage('No active batch file found. Open a .bat or .cmd file first to use ${file}.');
            return undefined;
          }
        }

        if (!config.program) {
          vscode.window.showErrorMessage('No batch file specified. Open a .bat or .cmd file, or set "program" in launch.json.');
          return undefined;
        }

        if (!config.request) {
          config.request = 'launch';
        }

        return config;
      }
    })
  );

  const controller = new BlinterController(context);
  activeController = controller;
  controller.initialize();
  registerCommands(context, controller);
}

function deactivate() {
  killCreateConfigProcess();
  if (activeController) {
    activeController.dispose();
    activeController = undefined;
  }
}

module.exports = {
  activate,
  deactivate,
  getActiveController: () => activeController,
  __test__: require('./lib/utils')
};
