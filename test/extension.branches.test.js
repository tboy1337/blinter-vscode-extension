const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const cp = require('child_process');
const { createMockVscode, createRange, clearExtensionRequireCache } = require('./support/mock-vscode');

/** @param {unknown} value */
function throwLiteral(value) {
  throw value;
}

function createFakeSpawn(stdoutLines = []) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => {};
    proc.stderr.setEncoding = () => {};
    proc.kill = () => { proc.killed = true; };
    proc.killed = false;
    proc.pid = 55;
    setImmediate(() => {
      for (const line of stdoutLines) {
        proc.stdout.emit('data', `${line}\n`);
      }
      proc.emit('close', 0);
    });
    return proc;
  };
}

function loadExtension(options = {}) {
  const repoRoot = path.join(__dirname, '..');
  const extensionPath = path.join(repoRoot, 'extension.js');
  const mock = createMockVscode(options);
  const previousTestMode = process.env.BLINTER_TEST_MODE;
  process.env.BLINTER_TEST_MODE = '1';

  clearExtensionRequireCache(repoRoot);

  const originalSpawn = cp.spawn;
  cp.spawn = options.spawnImpl || createFakeSpawn(options.stdoutLines);

  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'vscode') {
      return mock.vscode;
    }
    return originalRequire.apply(this, arguments);
  };

  const ext = require(extensionPath);
  Module.prototype.require = originalRequire;

  return {
    ext,
    mock,
    context: {
      subscriptions: mock.subscriptions,
      extensionUri: { fsPath: options.extensionRoot || repoRoot },
      extensionPath: options.extensionRoot || repoRoot
    },
    restoreEnv: () => {
      cp.spawn = originalSpawn;
      if (previousTestMode === undefined) {
        delete process.env.BLINTER_TEST_MODE;
      } else {
        process.env.BLINTER_TEST_MODE = previousTestMode;
      }
    }
  };
}

async function getController(harness) {
  harness.ext.activate(harness.context);
  return harness.mock.registeredCommands.get('blinter.test.getController')();
}

function makeDocument(fsPath, lines, languageId = 'cmd') {
  return {
    languageId,
    uri: { fsPath, scheme: 'file', toString: () => fsPath },
    isDirty: false,
    lineCount: lines.length,
    eol: 2,
    getText: () => lines.join('\r\n'),
    lineAt: (line) => ({
      text: lines[line] || '',
      range: createRange(line, 0, line, (lines[line] || '').length),
      rangeIncludingLineBreak: createRange(line, 0, line + 1, 0)
    })
  };
}

describe('Extension branch coverage', () => {
  it('skips linting for non-batch, disabled, and invalid paths', async () => {
    const harness = loadExtension({
      configuration: { blinter: { enabled: false } }
    });
    const controller = await getController(harness);

    await controller.lintDocument(makeDocument('file.txt', ['echo'], 'plaintext'));
    await controller.lintDocument({
      languageId: 'cmd',
      uri: { fsPath: '   ' },
      lineCount: 1,
      getText: () => '',
      lineAt: () => ({ text: '', range: createRange(0, 0, 0, 0) })
    });
    await controller.lintDocument(makeDocument('C:\\valid.cmd', ['@echo off']));

    harness.restoreEnv();
  });

  it('exercises quick-fix provider guard branches', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-qf-br-${Date.now()}.cmd`);
    const lines = ['REM comment', 'echo hello'];
    fs.writeFileSync(tmpFile, lines.join('\r\n'), 'utf8');
    const doc = makeDocument(tmpFile, lines);

    const harness = loadExtension({ lines: [...lines] });
    await getController(harness);
    const provider = harness.mock.codeActionProviders[0];

    assert.deepStrictEqual(
      provider.provideCodeActions(doc, createRange(0, 0, 0, 1), { diagnostics: [] }),
      []
    );

    const noMatch = new harness.mock.vscode.Diagnostic(
      createRange(1, 0, 1, 10),
      'unrelated issue',
      harness.mock.vscode.DiagnosticSeverity.Warning
    );
    noMatch.code = 'OTHER';
    noMatch.source = 'blinter';
    assert.deepStrictEqual(
      provider.provideCodeActions(doc, createRange(1, 0, 1, 10), { diagnostics: [noMatch] }),
      []
    );

    const badLine = new harness.mock.vscode.Diagnostic(
      createRange(5, 0, 5, 1),
      'case issue',
      harness.mock.vscode.DiagnosticSeverity.Warning
    );
    badLine.code = 'BLINTER_CASE';
    badLine.source = 'blinter';
    assert.deepStrictEqual(
      provider.provideCodeActions(doc, createRange(5, 0, 5, 1), { diagnostics: [badLine] }),
      []
    );

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('merges suppression comments and resolves target documents from paths', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-sup-br-${Date.now()}.cmd`);
    const lines = ['REM LINT:IGNORE W001', 'ECHO hello'];
    fs.writeFileSync(tmpFile, lines.join('\r\n'), 'utf8');
    const doc = makeDocument(tmpFile, lines);

    const harness = loadExtension({
      lines: [...lines],
      configuration: { blinter: { suppressionCommentStyle: '::', showAskCopilotQuickFix: true } }
    });
    const controller = await getController(harness);

    const diag = new harness.mock.vscode.Diagnostic(
      createRange(1, 0, 1, 10),
      'warning',
      harness.mock.vscode.DiagnosticSeverity.Warning
    );
    diag.code = 'W002';
    diag.source = 'blinter';

    const actions = harness.mock.codeActionProviders[1].provideCodeActions(
      doc,
      createRange(1, 0, 1, 10),
      { diagnostics: [diag] }
    );
    assert.ok(actions.some((a) => a.title.includes('W002')));

    controller.currentProgramPath = tmpFile;
    const resolved = await controller.resolveSuppressionTargetDocument();
    assert.strictEqual(resolved.uri.fsPath, tmpFile);

    controller.issuesByFile.set(tmpFile, []);
    const resolvedFromMap = await controller.resolveSuppressionTargetDocument();
    assert.strictEqual(resolvedFromMap.uri.fsPath, tmpFile);

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('covers askCopilot sidebar fallback and openInSidebar command', async () => {
    let sidebarOpened = false;
    const harness = loadExtension({
      externalCommands: {
        'workbench.action.chat.openInSidebar': () => { sidebarOpened = true; }
      }
    });
    await getController(harness);
    await harness.mock.registeredCommands.get('blinter.askCopilot')({ codeList: 'W003' });
    assert.strictEqual(sidebarOpened, true);
    harness.restoreEnv();
  });

  it('covers diagnostic conversion and issue ordering edge cases', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);

    controller.addIssue({
      severity: 'unknown',
      message: 'unknown severity',
      classification: 'General',
      isCritical: false,
      filePath: 'C:\\ws\\script.cmd',
      line: 1
    });

    const ordered = controller.compareIssues(
      { severity: 'hint', line: 2 },
      { severity: 'error', line: 1 }
    );
    assert.ok(ordered > 0);

    const diagnostic = controller.toDiagnostic({
      severity: 'unknown',
      message: 'msg',
      line: 1,
      code: 'X001'
    });
    assert.ok(diagnostic);

    controller.acceptProcessText('', 'stdout');
    controller.addIssue({ message: 'no path', line: 1, severity: 'warning' });

    harness.restoreEnv();
  });

  it('covers prepareForLaunch missing program and missing files', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);

    await assert.rejects(
      () => controller.prepareForLaunch({ program: 'missing.cmd' }, { id: 's-missing' }),
      /Program not found/
    );

    harness.restoreEnv();
  });

  it('covers refreshSuppressionDecorations for ignore-line comments', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-sup-deco-${Date.now()}.cmd`);
    const lines = ['@echo off', 'REM LINT:IGNORE-LINE W001', 'echo test'];
    fs.writeFileSync(tmpFile, lines.join('\r\n'), 'utf8');
    const doc = makeDocument(tmpFile, lines);
    const editor = {
      document: doc,
      setDecorations: () => {},
      revealRange: () => {},
      selection: {}
    };

    const harness = loadExtension({
      activeEditor: editor,
      visibleEditors: [editor]
    });
    await getController(harness);
    harness.mock.fireDidChangeVisibleTextEditors();

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('logs lint executable resolution failures when binary is missing', async () => {
    const emptyRoot = path.join(os.tmpdir(), `blinter-exe-fail-${Date.now()}`);
    fs.mkdirSync(emptyRoot, { recursive: true });
    const scriptPath = path.join(emptyRoot, 'script.cmd');
    fs.writeFileSync(scriptPath, '@echo off\r\n', 'utf8');

    const harness = loadExtension({
      extensionRoot: emptyRoot,
      workspaceRoot: emptyRoot
    });
    const controller = await getController(harness);
    await controller.lintDocument(makeDocument(scriptPath, ['@echo off']));
    assert.ok(harness.mock.messages.errors.some((m) => m.includes('Blinter executable not found')));

    fs.rmSync(emptyRoot, { recursive: true, force: true });
    harness.restoreEnv();
  });

  it('collects summary groups for every issue category', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    const filePath = 'C:\\ws\\script.cmd';

    controller.addIssue({ filePath, line: 1, severity: 'error', message: 'err', classification: 'General', isCritical: true });
    controller.addIssue({ filePath, line: 2, severity: 'warning', message: 'warn', classification: 'General', isCritical: true });
    controller.addIssue({ filePath, line: 3, severity: 'info', message: 'info', classification: 'Info', isCritical: false });
    controller.addIssue({
      filePath,
      line: 4,
      severity: 'warning',
      message: 'undefined %X%',
      classification: 'UndefinedVariable',
      isCritical: false
    });

    const summary = controller.collectSummary();
    assert.ok(summary.groups.every((group) => group.items.length > 0));
    harness.restoreEnv();
  });

  it('opens suppression documents from visible editors with batch file paths', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-open-${Date.now()}.bat`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off'], 'plaintext');
    const editor = {
      document: doc,
      setDecorations: () => {},
      revealRange: () => {},
      selection: {}
    };

    const harness = loadExtension({
      visibleEditors: [editor],
      activeEditor: null
    });
    const controller = await getController(harness);
    const resolved = await controller.resolveSuppressionTargetDocument();
    assert.strictEqual(resolved.uri.fsPath, tmpFile);

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('resolves ${fileBasename} in debug configuration', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-base-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off']);
    const editor = { document: doc, revealRange: () => {}, selection: {}, setDecorations: () => {} };

    const harness = loadExtension({ activeEditor: editor, visibleEditors: [editor] });
    await getController(harness);
    const provider = harness.mock.debugConfigProviders.get('blinter-debug');
    const resolved = provider.resolveDebugConfiguration(undefined, {
      type: 'blinter-debug',
      request: 'launch',
      program: '${fileBasename}'
    });
    assert.ok(resolved.program.endsWith('.cmd'));
    assert.strictEqual(resolved.program, path.basename(tmpFile));

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('covers quick-fix message hint matching without explicit code', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-qf-hint-${Date.now()}.cmd`);
    const lines = ['ECHO hello'];
    fs.writeFileSync(tmpFile, lines.join('\r\n'), 'utf8');
    const doc = makeDocument(tmpFile, lines);

    const harness = loadExtension({
      lines: [...lines],
      configuration: { blinter: { quickFixCodes: [] } }
    });
    const controller = await getController(harness);
    const provider = controller.createQuickFixProvider();
    const diag = new harness.mock.vscode.Diagnostic(
      createRange(0, 0, 0, 10),
      'Fix command CASE on this line',
      harness.mock.vscode.DiagnosticSeverity.Warning
    );
    diag.source = 'blinter';
    const actions = provider.provideCodeActions(doc, createRange(0, 0, 0, 10), { diagnostics: [diag] });
    assert.ok(actions.length > 0);

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('merges suppression codes when ignore comment already exists', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-sup-merge-${Date.now()}.cmd`);
    const lines = ['REM LINT:IGNORE W001', 'ECHO hello'];
    fs.writeFileSync(tmpFile, lines.join('\r\n'), 'utf8');
    const doc = makeDocument(tmpFile, lines);

    const harness = loadExtension({ lines: [...lines] });
    const controller = await getController(harness);
    const provider = controller.createSuppressionProvider();
    const diag = new harness.mock.vscode.Diagnostic(
      createRange(1, 0, 1, 10),
      'warning',
      harness.mock.vscode.DiagnosticSeverity.Warning
    );
    diag.code = 'W002';
    diag.source = 'blinter';
    const actions = provider.provideCodeActions(doc, createRange(1, 0, 1, 10), { diagnostics: [diag] });
    assert.ok(actions.some((a) => a.title.includes('W002')));

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('logs failures when suppression target documents cannot be opened', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-open-fail-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');

    const harness = loadExtension({ openTextDocumentThrows: true });
    const controller = await getController(harness);
    controller.currentProgramPath = tmpFile;
    const resolved = await controller.resolveSuppressionTargetDocument();
    assert.strictEqual(resolved, undefined);
    assert.ok(harness.mock.outputLines.some((line) => line.includes('[OpenDocument]')));

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('prepares launch using ${file} from active editor', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-pl-file-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off']);
    const editor = { document: doc, revealRange: () => {}, selection: {}, setDecorations: () => {} };

    const harness = loadExtension({
      activeEditor: editor,
      visibleEditors: [editor],
      workspaceRoot: path.dirname(tmpFile)
    });
    const controller = await getController(harness);
    const launchInfo = await controller.prepareForLaunch({ program: '${file}' }, { id: 'pl-file' });
    assert.ok(launchInfo.args.length > 0);

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('updates status when debug session terminates while running', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    controller.updateStatus('running', 'active');
    harness.mock.fireDidTerminateDebugSession({ type: 'blinter-debug', id: 'dbg-running' });
    harness.restoreEnv();
  });

  it('skips adding issues without normalized file paths', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    controller.addIssue({ message: 'orphan', line: 1, severity: 'warning' });
    assert.strictEqual(controller.issuesByFile.size, 0);
    harness.restoreEnv();
  });

  it('skips lint while a debug session is active', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-debug-skip-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off']);

    const harness = loadExtension({ stdoutLines: ['line:1: warning: W001: test'] });
    const controller = await getController(harness);
    controller.currentSessionId = 'active-debug';
    await controller.lintDocument(doc);
    assert.strictEqual(controller.lintIssuesByFile.size, 0);
    assert.ok(harness.mock.outputLines.some((line) => line.includes('Skipping lint while debug session is active')));

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('rejects unauthorized webview reveal paths', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    await controller.revealLocation('C:\\outside\\workspace\\evil.cmd', 1);
    assert.ok(harness.mock.outputLines.some((line) => line.includes('Rejected navigation to unauthorized path')));
    harness.restoreEnv();
  });

  it('rejects webview reveal even when path is in the issue map', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    controller.currentWorkspaceRoot = 'C:\\ws';
    controller.currentProgramPath = 'C:\\ws\\main.cmd';
    controller.debugIssuesByFile.set('C:\\outside\\workspace\\evil.cmd', [{
      id: 'ext-1',
      severity: 'error',
      message: 'external',
      filePath: 'C:\\outside\\workspace\\evil.cmd',
      line: 1
    }]);
    await controller.revealLocation('C:\\outside\\workspace\\evil.cmd', 1);
    assert.ok(harness.mock.outputLines.some((line) => line.includes('Rejected navigation to unauthorized path')));
    harness.restoreEnv();
  });

  it('covers initialize listener guard branches', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-guards-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off']);

    const harness = loadExtension({
      configuration: { blinter: { enabled: false, runOn: 'manual' } }
    });
    await getController(harness);
    harness.mock.fireDidSaveTextDocument(doc);
    harness.mock.fireDidChangeTextDocument(doc);
    harness.mock.fireDidChangeConfiguration(['other.setting']);
    harness.mock.fireDidStartDebugSession({ type: 'node-debug', id: 'other' });
    harness.mock.fireDidTerminateDebugSession({ type: 'node-debug', id: 'other' });

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('kills in-flight lint when the matching document closes', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-close-lint-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    let killed = false;

    const harness = loadExtension();
    const controller = await getController(harness);
    controller._currentLintHandle = {
      filePath: path.normalize(tmpFile),
      kill: () => { killed = true; }
    };
    controller.clearDocument({
      fsPath: tmpFile,
      toString: () => `file://${tmpFile}`
    });
    assert.strictEqual(killed, true);
    assert.strictEqual(controller._currentLintHandle, null);

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('disposes controller resources and wrapper helpers', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    controller._currentLintHandle = { kill: () => {} };
    controller._debounceTimers.set('doc', setTimeout(() => {}, 10000));
    controller.pendingUpdateTimer = setTimeout(() => {}, 10000);
    controller.dispose();
    assert.strictEqual(controller._currentLintHandle, null);
    assert.strictEqual(controller.toDiagnostic({ severity: 'error', line: 1, message: 'x' }).source, 'blinter');
    harness.restoreEnv();
  });

  it('covers output view suppression and visibility error paths', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    const provider = controller.webviewProvider;
    provider._view = {
      show: () => { throw new Error('show failed'); },
      webview: {
        postMessage: () => {},
        onDidReceiveMessage: (cb) => {
          cb({ command: 'removeSuppressions' });
          return { dispose: () => {} };
        }
      }
    };
    provider.ensureVisible();
    provider.update({ groups: [{ title: 'Errors', issues: [] }] });
    provider.updateStatus({ state: 'running', detail: 'test' });
    assert.ok(harness.mock.outputLines.some((line) => line.includes('Failed to show webview')));
    harness.restoreEnv();
  });

  it('covers controller helper wrappers', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    assert.ok(controller.createQuickFixProvider());
    assert.ok(controller.createSuppressionProvider());
    assert.strictEqual(
      controller.compareIssues({ severity: 'error', line: 1 }, { severity: 'warning', line: 2 }),
      -1
    );
    assert.ok(controller.toDiagnostic({ severity: 'hint', line: 3, message: 'm', code: 'H001' }));
    controller.handleProcessExit(0, 'lint');
    controller.scheduleDiagnosticsUpdate();
    harness.restoreEnv();
  });

  it('covers remaining controller, command, and lint branches for 95% gate', async () => {
    const repoRoot = path.join(__dirname, '..');
    const tmpRoot = path.join(os.tmpdir(), `blinter-95-${Date.now()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    const tmpFile = path.join(tmpRoot, 'script.cmd');
    const lines = [
      'REM LINT:IGNORE W001',
      'REM LINT:IGNORE E001',
      '@echo off',
      'echo hello'
    ];
    fs.writeFileSync(tmpFile, lines.join('\r\n'), 'utf8');
    const iniPath = path.join(tmpRoot, 'blinter.ini');
    fs.writeFileSync(iniPath, '[rules]\n', 'utf8');

    const harness = loadExtension({
      extensionRoot: repoRoot,
      configuration: { blinter: { runOn: 'onType', criticalHighlightColor: 'AABBCC' } },
      stdoutLines: ['Line 3: undefined variable %MISSING% (E001)']
    });
    const controller = await getController(harness);
    const doc = makeDocument(tmpFile, lines);
    harness.mock.vscode.window.activeTextEditor = { document: doc };
    harness.mock.vscode.window.visibleTextEditors = [
      { document: doc, setDecorations: () => {} },
      { document: makeDocument(path.join(tmpRoot, 'plain.txt'), ['x'], 'plaintext'), setDecorations: () => {} }
    ];
    harness.mock.vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    harness.mock.vscode.workspace.getWorkspaceFolder = () => ({ uri: { fsPath: tmpRoot } });

    controller.lintIssuesByFile.set(path.normalize(tmpFile), [{
      id: '1',
      severity: 'error',
      classification: 'UndefinedVariable',
      isCritical: true,
      message: 'undefined',
      code: 'E001',
      filePath: path.normalize(tmpFile),
      line: 999,
      variableTrace: ['A', 'B'],
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 10 } }
    }]);
    controller.currentSessionId = 'debug-1';
    controller.addIssue({
      severity: 'warning',
      message: 'dup',
      code: 'W001',
      filePath: path.normalize(tmpFile),
      line: 3
    });
    controller.addIssue({
      severity: 'warning',
      message: 'dup',
      code: 'W001',
      filePath: path.normalize(tmpFile),
      line: 3
    });
    controller.currentSessionId = undefined;

    controller.scheduleDiagnosticsUpdate();
    controller.scheduleDiagnosticsUpdate();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const savedDecoration = controller.decorationType;
    controller.decorationType = null;
    controller.refreshDecorations();
    controller.decorationType = savedDecoration;

    const savedSuppression = controller.suppressionDecorationType;
    controller.suppressionDecorationType = null;
    controller.refreshSuppressionDecorations();
    controller.suppressionDecorationType = savedSuppression;
    controller.refreshSuppressionDecorations();

    const savedProvider = controller.webviewProvider;
    controller.webviewProvider = null;
    controller.updateWebview();
    controller.updateDebugStatus('running', 'debug');
    controller.webviewProvider = savedProvider;

    assert.strictEqual(controller.provideHover(makeDocument('', ['x']), { line: 0, character: 0 }), undefined);
    const hover = controller.provideHover(doc, { line: 2, character: 0 });
    assert.ok(hover);

    controller.clearDocument(doc.uri);
    controller.debugIssuesByFile.set(path.normalize(tmpFile), [{
      severity: 'error',
      message: 'debug issue',
      code: 'E002',
      filePath: path.normalize(tmpFile),
      line: 3
    }]);
    controller.clearDocument(doc.uri);

    controller.statusBarItem = null;
    controller._updateConfigStatusBar();

    harness.mock.vscode.workspace.openTextDocument = async () => doc;
    harness.mock.vscode.window.showTextDocument = async () => ({
      revealRange: () => {},
      selection: {},
      document: doc
    });
    await controller.revealLocation(tmpFile, undefined);
    harness.mock.vscode.workspace.openTextDocument = async () => { throw new Error('open failed'); };
    await controller.revealLocation(tmpFile, 1);

    harness.mock.vscode.window.activeTextEditor = null;
    harness.mock.vscode.window.visibleTextEditors = [];
    controller.currentProgramPath = tmpFile;
    harness.mock.vscode.workspace.openTextDocument = async (uri) => makeDocument(uri.fsPath, lines);
    await controller.removeAllSuppressionComments();
    assert.ok(harness.mock.messages.infos.some((m) => m.includes('Removed 2 suppression')));

    harness.mock.vscode.window.activeTextEditor = { document: doc };
    harness.mock.fireDidChangeTextDocument(doc);
    harness.mock.fireDidChangeTextDocument(doc);
    await new Promise((resolve) => setTimeout(resolve, 350));

    const hangingProcesses = [];
    const hangingHarness = loadExtension({
      extensionRoot: repoRoot,
      warningChoice: 'Yes',
      spawnImpl: () => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdout.setEncoding = () => {};
        proc.stderr.setEncoding = () => {};
        const isFirst = hangingProcesses.length === 0;
        hangingProcesses.push(proc);
        proc.kill = () => {
          if (isFirst) {
            throw new Error('kill failed');
          }
        };
        return proc;
      }
    });
    hangingHarness.mock.vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    hangingHarness.mock.vscode.window.activeTextEditor = { document: doc };
    await getController(hangingHarness);
    await hangingHarness.mock.registeredCommands.get('blinter.createConfig')();
    await hangingHarness.mock.registeredCommands.get('blinter.createConfig')();

    const openFailHarness = loadExtension({ extensionRoot: repoRoot, warningChoice: 'Yes' });
    openFailHarness.mock.vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    openFailHarness.mock.vscode.window.activeTextEditor = { document: doc };
    openFailHarness.mock.vscode.workspace.openTextDocument = async () => { throw new Error('open ini failed'); };
    cp.spawn = () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdout.setEncoding = () => {};
      proc.stderr.setEncoding = () => {};
      proc.kill = () => {};
      setImmediate(() => proc.emit('close', 0));
      return proc;
    };
    await getController(openFailHarness);
    await openFailHarness.mock.registeredCommands.get('blinter.createConfig')();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const { killCreateConfigProcess } = require('../lib/commands');
    const killHarness = loadExtension({ extensionRoot: repoRoot, warningChoice: 'Yes' });
    killHarness.mock.vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    killHarness.mock.vscode.window.activeTextEditor = { document: doc };
    cp.spawn = () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdout.setEncoding = () => {};
      proc.stderr.setEncoding = () => {};
      proc.kill = () => { throwLiteral('kill string failed'); };
      return proc;
    };
    await getController(killHarness);
    await killHarness.mock.registeredCommands.get('blinter.createConfig')();
    killCreateConfigProcess();

    const spawnFailHarness = loadExtension({
      extensionRoot: repoRoot,
      spawnImpl: () => { throw new Error('spawn failed'); }
    });
    const spawnFailController = await getController(spawnFailHarness);
    await spawnFailController.lintDocument(doc);

    const errHarness = loadExtension({ extensionRoot: repoRoot });
    const errController = await getController(errHarness);
    errController.lintDocument = async () => { throw new Error('lint boom'); };
    errHarness.mock.vscode.window.activeTextEditor = { document: doc };
    await errHarness.mock.registeredCommands.get('blinter.run')();
    errHarness.mock.vscode.commands.executeCommand = async (id) => {
      if (id === 'blinter.askCopilot') {
        throw new Error('copilot boom');
      }
      throw new Error(`Command not registered: ${id}`);
    };
    await errHarness.mock.registeredCommands.get('blinter.askCopilot')({ codeList: 'E001' });
    errController.removeAllSuppressionComments = async () => { throw new Error('suppress boom'); };
    await errHarness.mock.registeredCommands.get('blinter.removeAllSuppressions')();

    const outputHarness = loadExtension({ extensionRoot: repoRoot });
    const outputController = await getController(outputHarness);
    const provider = outputController.webviewProvider;
    provider._view = {
      show: () => { throw new Error('show boom'); },
      webview: {
        postMessage: () => {},
        onDidReceiveMessage: (cb) => {
          cb({ command: 'removeSuppressions' });
          return { dispose: () => {} };
        }
      }
    };
    provider.resolveWebviewView(provider._view);
    provider._data = { groups: null };
    provider.postUpdate();
    outputController.removeAllSuppressionComments = async () => { throw new Error('remove boom'); };
    await new Promise((resolve) => setTimeout(resolve, 20));

    fs.rmSync(tmpRoot, { recursive: true, force: true });
    harness.restoreEnv();
    hangingHarness.restoreEnv();
    openFailHarness.restoreEnv();
    errHarness.restoreEnv();
    outputHarness.restoreEnv();
    killHarness.restoreEnv();
    spawnFailHarness.restoreEnv();
  });

  it('covers createConfig overlapping kill and open-ini failure branches', async () => {
    const repoRoot = path.join(__dirname, '..');
    const tmpRoot = path.join(os.tmpdir(), `blinter-cmd-kill-${Date.now()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    const doc = makeDocument(path.join(tmpRoot, 'x.cmd'), ['@echo off']);
    const processes = [];

    const killHarness = loadExtension({
      extensionRoot: repoRoot,
      workspaceFolders: [{ uri: { fsPath: tmpRoot } }],
      warningChoice: 'Yes',
      spawnImpl: () => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdout.setEncoding = () => {};
        proc.stderr.setEncoding = () => {};
        const index = processes.length;
        processes.push(proc);
        if (index === 0) {
          proc.kill = () => { throwLiteral('kill previous string failed'); };
        }
        return proc;
      }
    });
    killHarness.mock.vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    killHarness.mock.vscode.window.activeTextEditor = { document: doc };
    await getController(killHarness);
    await killHarness.mock.registeredCommands.get('blinter.createConfig')();
    await killHarness.mock.registeredCommands.get('blinter.createConfig')();
    assert.ok(killHarness.mock.outputLines.some((line) => line.includes('Failed to kill previous process')));

    cp.spawn = () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdout.setEncoding = () => {};
      proc.stderr.setEncoding = () => {};
      proc.kill = () => { throwLiteral('kill string failed'); };
      return proc;
    };
    await killHarness.mock.registeredCommands.get('blinter.createConfig')();
    killHarness.ext.deactivate();

    const openHarness = loadExtension({
      extensionRoot: repoRoot,
      workspaceFolders: [{ uri: { fsPath: tmpRoot } }],
      warningChoice: 'Yes'
    });
    fs.writeFileSync(path.join(tmpRoot, 'blinter.ini'), '[rules]\n', 'utf8');
    openHarness.mock.vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    openHarness.mock.vscode.window.activeTextEditor = { document: doc };
    openHarness.mock.vscode.workspace.openTextDocument = async () => { throwLiteral('open ini string failed'); };
    cp.spawn = () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdout.setEncoding = () => {};
      proc.stderr.setEncoding = () => {};
      proc.kill = () => {};
      setImmediate(() => proc.emit('close', 0));
      return proc;
    };
    await getController(openHarness);
    await openHarness.mock.registeredCommands.get('blinter.createConfig')();
    await new Promise((resolve) => setTimeout(resolve, 25));

    fs.rmSync(tmpRoot, { recursive: true, force: true });
    killHarness.restoreEnv();
    openHarness.restoreEnv();
  });

  it('covers final controller and debug session branch gaps', async () => {
    const repoRoot = path.join(__dirname, '..');
    const tmpRoot = path.join(os.tmpdir(), `blinter-final-${Date.now()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    const tmpFile = path.join(tmpRoot, 'final.cmd');
    fs.writeFileSync(tmpFile, '@echo off\r\necho test\r\n', 'utf8');

    const harness = loadExtension({
      extensionRoot: repoRoot,
      workspaceFolders: [{ uri: { fsPath: tmpRoot } }],
      configuration: { blinter: { runOn: 'onType', encoding: '' } },
      spawnImpl: () => { throw new Error('lint spawn failed'); }
    });
    const controller = await getController(harness);
    const doc = makeDocument(tmpFile, ['@echo off', 'echo test']);
    harness.mock.vscode.window.activeTextEditor = { document: doc, setDecorations: () => {} };
    harness.mock.vscode.window.visibleTextEditors = [{
      document: { ...doc, uri: { fsPath: '', scheme: 'file', toString: () => '' } },
      setDecorations: () => {}
    }];

    controller.currentSessionId = 'debug-session';
    assert.ok(controller.getDisplayStatus());
    assert.ok(controller.getActiveIssueMap());
    controller.currentSessionId = undefined;

    controller.lintIssuesByFile.set(path.normalize(tmpFile), [{
      severity: 'error',
      message: 'err',
      code: 'E001',
      filePath: path.normalize(tmpFile),
      line: 1
    }]);
    assert.strictEqual(controller.provideHover(doc, { line: 9, character: 0 }), undefined);

    Object.defineProperty(harness.mock.vscode.workspace, 'textDocuments', {
      configurable: true,
      get: () => { throw new Error('documents failed'); }
    });
    controller.scheduleDiagnosticsUpdate();
    await new Promise((resolve) => setTimeout(resolve, 100));

    harness.mock.fireDidChangeTextDocument({ document: makeDocument(path.join(tmpRoot, 'x.txt'), ['x'], 'plaintext') });
    harness.mock.fireDidChangeTextDocument(doc);
    await new Promise((resolve) => setTimeout(resolve, 400));

    await controller.askCopilotAboutDiagnostic(null);
    harness.mock.vscode.window.activeTextEditor = null;
    harness.mock.vscode.window.visibleTextEditors = [];
    controller.currentProgramPath = path.join(tmpRoot, 'notes.txt');
    controller.lintIssuesByFile.set(path.normalize(tmpFile), [{
      severity: 'error',
      message: 'err',
      code: 'E001',
      filePath: path.normalize(tmpFile),
      line: 1,
      variableTrace: ['A', 'B']
    }]);
    harness.mock.vscode.workspace.openTextDocument = async (uri) => {
      if (String(uri.fsPath).endsWith('notes.txt')) {
        throw new Error('open candidate failed');
      }
      return makeDocument(uri.fsPath, ['@echo off']);
    };
    await controller.removeAllSuppressionComments();
    controller.clearDocument({ uri: { fsPath: tmpFile } });

    controller.webviewProvider = null;
    controller.updateDebugStatus('running', 'debug');
    assert.strictEqual(controller.getOutputViewStateForTest().viewResolved, false);

    harness.mock.vscode.window.activeTextEditor = {
      document: { languageId: 'bat', uri: { scheme: 'file', fsPath: '   ' } }
    };
    await assert.rejects(
      () => controller.prepareForLaunch({ program: '${file}' }, {}),
      /could not be resolved/
    );

    harness.mock.vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    harness.mock.vscode.workspace.openTextDocument = async () => doc;
    harness.mock.vscode.window.showTextDocument = async () => ({
      revealRange: () => {},
      selection: {},
      document: doc
    });
    await controller.revealLocation(tmpFile, 1);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
    harness.restoreEnv();
  });

  it('syncs webview status when updateWebview runs', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    /** @type {{ state?: string, detail?: string } | undefined} */
    let statusPayload;
    controller.webviewProvider = {
      update: () => {},
      updateStatus: (status) => { statusPayload = status; },
      ensureVisible: () => {}
    };
    controller.lintStatus = { state: 'completed', detail: 'lint ok' };
    controller.updateWebview();
    assert.strictEqual(statusPayload?.state, 'completed');
    harness.restoreEnv();
  });

  it('exposes diagnostic allowed paths from workspace and current program', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    harness.mock.vscode.workspace.workspaceFolders = [{ uri: { fsPath: 'C:\\repo' } }];
    controller.currentWorkspaceRoot = 'C:\\repo\\pkg';
    controller.currentProgramPath = 'C:\\repo\\pkg\\run.cmd';
    const allowed = controller.getDiagnosticAllowedPaths();
    assert.ok(allowed.includes('C:\\repo'));
    assert.ok(allowed.includes('C:\\repo\\pkg'));
    harness.restoreEnv();
  });
});
