const vscode = require('vscode');
const path = require('path');

/** @param {string} languageId */
function isBatchLanguageId(languageId) {
  return languageId === 'bat' || languageId === 'cmd';
}

/** @param {import('vscode').TextDocument | undefined} document */
function isBatchDocument(document) {
  return Boolean(document && isBatchLanguageId(document.languageId));
}

function getActiveOrVisibleBatchEditor() {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && isBatchDocument(activeEditor.document)) {
    return activeEditor;
  }
  return vscode.window.visibleTextEditors.find((editor) => isBatchDocument(editor.document));
}

/** @param {string | undefined} filePath */
function normalizeFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return undefined;
  }
  return path.normalize(filePath);
}

/** @param {string} severity */
function isInformationalSeverity(severity) {
  return severity === 'info' || severity === 'information' || severity === 'hint';
}

/** @param {import('vscode').TextDocument} document */
function isFileDocument(document) {
  return document.uri.scheme === 'file';
}

/** @param {unknown} value */
function escapeMarkdown(value) {
  return String(value || '')
    .replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
}

/** @param {string} filePath @param {string} rootPath */
function isPathInsideRoot(filePath, rootPath) {
  const normalized = normalizeFilePath(filePath);
  const root = normalizeFilePath(rootPath);
  if (!normalized || !root) {
    return false;
  }
  return isPathAllowed(normalized, [root]);
}

/** @param {string} filePath @param {string[]} allowedPaths */
function isPathAllowed(filePath, allowedPaths) {
  const normalized = normalizeFilePath(filePath);
  if (!normalized) {
    return false;
  }
  const normalizedLower = normalized.toLowerCase();
  for (const allowed of allowedPaths) {
    const normalizedAllowed = normalizeFilePath(allowed);
    if (!normalizedAllowed) {
      continue;
    }
    const allowedLower = normalizedAllowed.toLowerCase();
    if (normalizedLower === allowedLower) {
      return true;
    }
    const prefix = allowedLower.endsWith(path.sep) ? allowedLower : `${allowedLower}${path.sep}`;
    if (normalizedLower.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

module.exports = {
  isBatchLanguageId,
  isBatchDocument,
  getActiveOrVisibleBatchEditor,
  normalizeFilePath,
  isInformationalSeverity,
  isFileDocument,
  escapeMarkdown,
  isPathAllowed,
  isPathInsideRoot
};
