const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/** @type {Map<string, { tempPath: string }>} */
const snapshotsByUri = new Map();

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
 * @param {import('vscode').TextDocument} document
 * @param {boolean} saveBeforeLint
 * @returns {Promise<{ filePath: string, isSnapshot: boolean }>}
 */
async function resolveDocumentPath(document, saveBeforeLint) {
  if (document.uri.scheme === 'untitled') {
    throw new Error('Save the file before linting or debugging.');
  }
  if (document.uri.scheme !== 'file') {
    throw new Error(`Unsupported document URI scheme: ${document.uri.scheme}`);
  }

  const originalPath = path.normalize(document.uri.fsPath);

  if (!document.isDirty) {
    return { filePath: originalPath, isSnapshot: false };
  }

  if (saveBeforeLint) {
    const saved = await document.save();
    if (!saved) {
      throw new Error('Save the file before linting or debugging.');
    }
    return { filePath: path.normalize(document.uri.fsPath), isSnapshot: false };
  }

  const snapshotDir = path.join(os.tmpdir(), 'blinter-snapshots');
  fs.mkdirSync(snapshotDir, { recursive: true });

  const uriKey = document.uri.toString();
  const existing = snapshotsByUri.get(uriKey);
  if (existing && fs.existsSync(existing.tempPath)) {
    fs.writeFileSync(existing.tempPath, document.getText(), 'utf8');
    return { filePath: existing.tempPath, isSnapshot: true };
  }

  const hash = crypto.createHash('sha1').update(uriKey).digest('hex').slice(0, 12);
  const ext = path.extname(originalPath) || '.bat';
  const tempPath = path.join(snapshotDir, `snapshot-${hash}${ext}`);
  fs.writeFileSync(tempPath, document.getText(), 'utf8');
  snapshotsByUri.set(uriKey, { tempPath });
  return { filePath: tempPath, isSnapshot: true };
}

function getTextDocuments() {
  try {
    // Deferred require: documentSnapshot is loaded in unit tests without the vscode module.
    const vscode = require('vscode');
    return vscode.workspace.textDocuments || [];
  } catch {
    return [];
  }
}

/** @param {string} filePath */
function findOpenDocument(filePath) {
  const normalized = path.normalize(filePath).toLowerCase();
  for (const doc of getTextDocuments()) {
    if (doc.uri.scheme === 'file' && path.normalize(doc.uri.fsPath).toLowerCase() === normalized) {
      return doc;
    }
  }
  return undefined;
}

/**
 * @param {string} programPath
 * @returns {Promise<{ filePath: string, isSnapshot: boolean }>}
 */
async function resolveProgramPathForLaunch(programPath) {
  const normalized = path.normalize(programPath);
  const openDoc = findOpenDocument(normalized);
  if (openDoc && openDoc.isDirty) {
    let saveBeforeLint = false;
    try {
      // Deferred require: documentSnapshot is loaded in unit tests without the vscode module.
      const vscode = require('vscode');
      const config = vscode.workspace.getConfiguration('blinter', openDoc.uri);
      saveBeforeLint = config.get('saveBeforeLint') === true;
    } catch {
      saveBeforeLint = false;
    }
    return resolveDocumentPath(openDoc, saveBeforeLint);
  }
  return { filePath: normalized, isSnapshot: false };
}

function cleanupSnapshots() {
  for (const entry of snapshotsByUri.values()) {
    try {
      if (fs.existsSync(entry.tempPath)) {
        fs.unlinkSync(entry.tempPath);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorLogger(`[Blinter] Failed to remove snapshot ${entry.tempPath}: ${message}`);
    }
  }
  snapshotsByUri.clear();
}

/**
 * @param {import('vscode').Uri} uri
 */
function releaseSnapshot(uri) {
  const uriKey = uri.toString();
  const entry = snapshotsByUri.get(uriKey);
  if (!entry) {
    return;
  }
  snapshotsByUri.delete(uriKey);
  try {
    if (fs.existsSync(entry.tempPath)) {
      fs.unlinkSync(entry.tempPath);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errorLogger(`[Blinter] Failed to remove snapshot ${entry.tempPath}: ${message}`);
  }
}

module.exports = {
  resolveDocumentPath,
  resolveProgramPathForLaunch,
  cleanupSnapshots,
  releaseSnapshot,
  setErrorLogger
};
