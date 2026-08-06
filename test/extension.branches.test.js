const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const cp = require('child_process');
const { createMockVscode, createRange } = require('./support/mock-vscode');

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

  delete require.cache[extensionPath];
  delete require.cache[path.join(repoRoot, 'lib', 'blinterRunner.js')];

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
    uri: { fsPath, toString: () => fsPath },
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
});
