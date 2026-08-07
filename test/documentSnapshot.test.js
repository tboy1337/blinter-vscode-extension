const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveDocumentPath,
  resolveProgramPathForLaunch,
  cleanupSnapshots,
  releaseSnapshot
} = require('../lib/documentSnapshot');

function makeDocument(overrides = {}) {
  const fsPath = overrides.fsPath || path.join(os.tmpdir(), `blinter-snap-${Date.now()}.cmd`);
  const uri = overrides.uri || {
    scheme: 'file',
    fsPath,
    toString: () => `file:///${fsPath.replace(/\\/g, '/')}`
  };
  return {
    uri,
    isDirty: overrides.isDirty ?? false,
    getText: overrides.getText || (() => '@echo off\r\n'),
    save: overrides.save || (async () => true)
  };
}

describe('documentSnapshot', () => {
  afterEach(() => {
    cleanupSnapshots();
  });

  it('returns the on-disk path for clean saved files', async () => {
    const fsPath = path.join(os.tmpdir(), `blinter-clean-${Date.now()}.cmd`);
    const doc = makeDocument({ fsPath, isDirty: false });
    const result = await resolveDocumentPath(doc, false);
    assert.strictEqual(result.isSnapshot, false);
    assert.strictEqual(result.filePath, path.normalize(fsPath));
  });

  it('rejects untitled documents', async () => {
    const doc = makeDocument({
      uri: { scheme: 'untitled', fsPath: '', toString: () => 'untitled:1' },
      isDirty: true
    });
    await assert.rejects(
      () => resolveDocumentPath(doc, false),
      /Save the file before linting/
    );
  });

  it('rejects unsupported URI schemes', async () => {
    const doc = makeDocument({
      uri: { scheme: 'git', fsPath: 'README.md', toString: () => 'git:/README.md' },
      isDirty: false
    });
    await assert.rejects(
      () => resolveDocumentPath(doc, false),
      /Unsupported document URI scheme/
    );
  });

  it('writes dirty buffer content to a reusable temp snapshot', async () => {
    const fsPath = path.join(os.tmpdir(), `blinter-dirty-${Date.now()}.cmd`);
    fs.writeFileSync(fsPath, 'old\r\n', 'utf8');
    const doc = makeDocument({
      fsPath,
      isDirty: true,
      getText: () => 'new content\r\n'
    });

    const first = await resolveDocumentPath(doc, false);
    assert.strictEqual(first.isSnapshot, true);
    assert.strictEqual(fs.readFileSync(first.filePath, 'utf8'), 'new content\r\n');

    doc.getText = () => 'updated content\r\n';
    const second = await resolveDocumentPath(doc, false);
    assert.strictEqual(second.filePath, first.filePath);
    assert.strictEqual(fs.readFileSync(second.filePath, 'utf8'), 'updated content\r\n');

    fs.unlinkSync(fsPath);
  });

  it('prompts to save when saveBeforeLint is enabled', async () => {
    const fsPath = path.join(os.tmpdir(), `blinter-save-${Date.now()}.cmd`);
    let saved = false;
    const doc = makeDocument({
      fsPath,
      isDirty: true,
      save: async () => {
        saved = true;
        return true;
      }
    });

    const result = await resolveDocumentPath(doc, true);
    assert.strictEqual(saved, true);
    assert.strictEqual(result.isSnapshot, false);
    assert.strictEqual(result.filePath, path.normalize(fsPath));
  });

  it('fails when saveBeforeLint is enabled but save is declined', async () => {
    const doc = makeDocument({
      isDirty: true,
      save: async () => false
    });
    await assert.rejects(
      () => resolveDocumentPath(doc, true),
      /Save the file before linting/
    );
  });

  it('resolves launch paths from disk when no open document exists', async () => {
    const fsPath = path.join(os.tmpdir(), `blinter-launch-${Date.now()}.cmd`);
    const result = await resolveProgramPathForLaunch(fsPath);
    assert.strictEqual(result.isSnapshot, false);
    assert.strictEqual(result.filePath, path.normalize(fsPath));
  });

  it('cleans up tracked snapshot files', async () => {
    const fsPath = path.join(os.tmpdir(), `blinter-cleanup-${Date.now()}.cmd`);
    fs.writeFileSync(fsPath, 'original\r\n', 'utf8');
    const doc = makeDocument({ fsPath, isDirty: true, getText: () => 'cleanup\r\n' });
    const snapshot = await resolveDocumentPath(doc, false);
    assert.ok(fs.existsSync(snapshot.filePath));
    cleanupSnapshots();
    assert.strictEqual(fs.existsSync(snapshot.filePath), false);
    fs.unlinkSync(fsPath);
  });

  it('releases a single snapshot when a document closes', async () => {
    const fsPath = path.join(os.tmpdir(), `blinter-release-${Date.now()}.cmd`);
    fs.writeFileSync(fsPath, 'original\r\n', 'utf8');
    const doc = makeDocument({ fsPath, isDirty: true, getText: () => 'release\r\n' });
    const snapshot = await resolveDocumentPath(doc, false);
    assert.ok(fs.existsSync(snapshot.filePath));
    releaseSnapshot(doc.uri);
    assert.strictEqual(fs.existsSync(snapshot.filePath), false);
    fs.unlinkSync(fsPath);
  });

  it('resolves dirty open documents for launch using snapshots', async () => {
    const Module = require('module');
    const { createMockVscode } = require('./support/mock-vscode');
    const fsPath = path.join(os.tmpdir(), `blinter-launch-dirty-${Date.now()}.cmd`);
    fs.writeFileSync(fsPath, 'old\r\n', 'utf8');
    const mock = createMockVscode({
      configuration: { blinter: { saveBeforeLint: false } }
    });
    mock.vscode.workspace.textDocuments = [{
      uri: { scheme: 'file', fsPath, toString: () => `file://${fsPath}` },
      isDirty: true,
      getText: () => 'dirty launch\r\n'
    }];

    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === 'vscode') {
        return mock.vscode;
      }
      return originalRequire.apply(this, arguments);
    };

    try {
      delete require.cache[require.resolve('../lib/documentSnapshot')];
      const snapshotMod = require('../lib/documentSnapshot');
      const result = await snapshotMod.resolveProgramPathForLaunch(fsPath);
      assert.strictEqual(result.isSnapshot, true);
      assert.strictEqual(fs.readFileSync(result.filePath, 'utf8'), 'dirty launch\r\n');
      snapshotMod.cleanupSnapshots();
    } finally {
      Module.prototype.require = originalRequire;
      delete require.cache[require.resolve('../lib/documentSnapshot')];
      fs.unlinkSync(fsPath);
    }
  });

  it('returns launch paths when vscode is unavailable during lookup', async () => {
    const Module = require('module');
    const fsPath = path.join(os.tmpdir(), `blinter-novscode-${Date.now()}.cmd`);
    fs.writeFileSync(fsPath, '@echo off\r\n', 'utf8');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === 'vscode') {
        throw new Error('vscode unavailable');
      }
      return originalRequire.apply(this, arguments);
    };
    try {
      delete require.cache[require.resolve('../lib/documentSnapshot')];
      const snapshotMod = require('../lib/documentSnapshot');
      const result = await snapshotMod.resolveProgramPathForLaunch(fsPath);
      assert.strictEqual(result.filePath, path.normalize(fsPath));
    } finally {
      Module.prototype.require = originalRequire;
      delete require.cache[require.resolve('../lib/documentSnapshot')];
      fs.unlinkSync(fsPath);
    }
  });
});
