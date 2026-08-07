const vscode = require('vscode');
const path = require('path');
const {
  getDebounceDelay,
  getProcessTimeoutMs,
  coerceMaxLineLength,
  sanitizeRuleList
} = require('./configHelpers');

/** @param {import('vscode').Uri | undefined} [scopeUri] */
function getBlinterConfig(scopeUri) {
  return vscode.workspace.getConfiguration('blinter', scopeUri);
}

/** @param {import('vscode').Uri | undefined} documentUri */
function getWorkspaceFolderPath(documentUri) {
  if (!documentUri) {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
  }
  const folder = vscode.workspace.getWorkspaceFolder(documentUri);
  return folder ? folder.uri.fsPath : undefined;
}

/** @param {import('vscode').TextEditor | undefined} editor */
function getIniPathForEditor(editor) {
  if (!editor) {
    return undefined;
  }
  const folderPath = getWorkspaceFolderPath(editor.document.uri);
  if (!folderPath) {
    return undefined;
  }
  return path.join(folderPath, 'blinter.ini');
}

module.exports = {
  getBlinterConfig,
  getDebounceDelay,
  getProcessTimeoutMs,
  coerceMaxLineLength,
  sanitizeRuleList,
  getWorkspaceFolderPath,
  getIniPathForEditor
};
