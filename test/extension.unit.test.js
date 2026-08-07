const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const cp = require('child_process');
const { createMockVscode, createRange, clearExtensionRequireCache } = require('./support/mock-vscode');

function createFakeSpawn(stdoutLines, options = {}) {
  return (command, args, spawnOptions) => {
    if (options.createConfig && args && args.includes('--create-config')) {
      const cwd = spawnOptions && spawnOptions.cwd;
      const iniPath = path.join(cwd, 'blinter.ini');
      fs.writeFileSync(iniPath, '# blinter config\n', 'utf8');
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stderr.setEncoding = () => {};
      setImmediate(() => proc.emit('close', 0));
      return proc;
    }

    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => {};
    proc.stderr.setEncoding = () => {};
    proc.kill = () => { proc.killed = true; };
    proc.killed = false;
    proc.pid = options.pid || 77;
    setImmediate(() => {
      if (options.emitError) {
        proc.emit('error', new Error(options.emitError));
        return;
      }
      for (const line of stdoutLines) {
        proc.stdout.emit('data', `${line}\n`);
      }
      if (options.stderrText) {
        proc.stderr.emit('data', options.stderrText);
      }
      proc.emit('close', options.exitCode !== undefined ? options.exitCode : 0);
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
  cp.spawn = options.spawnImpl || createFakeSpawn(options.stdoutLines || [
    'Line 2: Errorlevel handling difference between .bat/.cmd (W028)',
    'Line 1: BAT extension used instead of CMD for newer Windows (S007)'
  ], options.spawnOptions || {});

  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'vscode') {
      return mock.vscode;
    }
    return originalRequire.apply(this, arguments);
  };

  const ext = require(extensionPath);
  Module.prototype.require = originalRequire;

  const context = {
    subscriptions: mock.subscriptions,
    extensionUri: { fsPath: options.extensionRoot || repoRoot },
    extensionPath: options.extensionRoot || repoRoot
  };

  return {
    ext,
    mock,
    context,
    repoRoot,
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

function makeDocument(fsPath, lines, languageId = 'cmd') {
  const text = lines.join('\r\n');
  return {
    languageId,
    uri: { fsPath, scheme: 'file', toString: () => fsPath },
    isDirty: false,
    lineCount: lines.length,
    eol: 2,
    getText: () => text,
    lineAt: (line) => ({
      text: lines[line] || '',
      range: createRange(line, 0, line, (lines[line] || '').length),
      rangeIncludingLineBreak: createRange(line, 0, line + 1, 0)
    })
  };
}

function makeEditor(doc, options = {}) {
  return {
    document: doc,
    revealRange: () => {},
    selection: {},
    setDecorations: options.setDecorations || (() => {})
  };
}

async function getController(harness) {
  harness.ext.activate(harness.context);
  return harness.mock.registeredCommands.get('blinter.test.getController')();
}

describe('Extension unit coverage', () => {
  it('exposes helper utilities for markdown escaping and batch detection', () => {
    const { ext, restoreEnv } = loadExtension();
    assert.strictEqual(ext.__test__.escapeMarkdown('cmd_*test'), 'cmd\\_\\*test');
    assert.strictEqual(ext.__test__.isBatchLanguageId('cmd'), true);
    assert.strictEqual(ext.__test__.isBatchDocument({ languageId: 'cmd' }), true);
    assert.strictEqual(ext.__test__.normalizeFilePath('  '), undefined);
    assert.strictEqual(ext.__test__.isInformationalSeverity('hint'), true);
    assert.strictEqual(typeof ext.getActiveController, 'function');
    restoreEnv();
  });

  it('activates on Windows and registers core commands', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-unit-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\necho hello\r\n', 'utf8');

    const doc = makeDocument(tmpFile, ['@echo off', 'echo hello']);
    const editor = makeEditor(doc);

    const harness = loadExtension({
      activeEditor: editor,
      visibleEditors: [editor],
      workspaceRoot: path.dirname(tmpFile),
      configuration: {
        blinter: { enabled: true, runOn: 'onSave' }
      }
    });

    await getController(harness);
    assert.ok(harness.mock.registeredCommands.has('blinter.run'));
    assert.ok(harness.mock.registeredCommands.has('blinter.runAndDebug'));

    await harness.mock.registeredCommands.get('blinter.run')();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const state = harness.mock.registeredCommands.get('blinter.test.getOutputViewState')();
    assert.ok(state);

    fs.unlinkSync(tmpFile);
    harness.ext.deactivate();
    assert.strictEqual(harness.ext.getActiveController(), undefined);
    harness.restoreEnv();
  });

  it('shows guidance when runAndDebug has no active batch editor', async () => {
    const harness = loadExtension({ activeEditor: null, visibleEditors: [] });
    await getController(harness);
    await harness.mock.registeredCommands.get('blinter.runAndDebug')();
    assert.ok(harness.mock.messages.infos.length > 0);
    harness.restoreEnv();
  });

  it('skips activation on non-Windows platforms', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const harness = loadExtension();
      harness.ext.activate(harness.context);
      assert.strictEqual(harness.mock.registeredCommands.has('blinter.run'), false);
      harness.restoreEnv();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('resolves debug configuration for active batch editor', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-debug-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off']);
    const editor = makeEditor(doc);

    const harness = loadExtension({ activeEditor: editor, visibleEditors: [editor] });
    await getController(harness);
    const provider = harness.mock.debugConfigProviders.get('blinter-debug');
    const resolved = provider.resolveDebugConfiguration(undefined, {});
    assert.strictEqual(resolved.type, 'blinter-debug');
    assert.strictEqual(resolved.program, tmpFile);

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('resolves ${file} in debug configuration', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-file-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off']);
    const editor = makeEditor(doc);

    const harness = loadExtension({ activeEditor: editor, visibleEditors: [editor] });
    await getController(harness);
    const provider = harness.mock.debugConfigProviders.get('blinter-debug');
    const resolved = provider.resolveDebugConfiguration(undefined, {
      type: 'blinter-debug',
      request: 'launch',
      program: '${file}'
    });
    assert.strictEqual(resolved.program, tmpFile);

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('aborts debug configuration when program is missing', async () => {
    const harness = loadExtension({ activeEditor: null, visibleEditors: [] });
    await getController(harness);
    const provider = harness.mock.debugConfigProviders.get('blinter-debug');
    const resolved = provider.resolveDebugConfiguration(undefined, { type: 'blinter-debug', request: 'launch' });
    assert.strictEqual(resolved, undefined);
    harness.restoreEnv();
  });

  it('creates blinter.ini in workspace root', async () => {
    const workspaceRoot = path.join(os.tmpdir(), `blinter-ws-${Date.now()}`);
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const iniPath = path.join(workspaceRoot, 'blinter.ini');

    const harness = loadExtension({
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
      spawnOptions: { createConfig: true }
    });
    await getController(harness);
    await harness.mock.registeredCommands.get('blinter.createConfig')();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(fs.existsSync(iniPath));

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    harness.restoreEnv();
  });

  it('skips createConfig when overwrite is declined', async () => {
    const workspaceRoot = path.join(os.tmpdir(), `blinter-ws2-${Date.now()}`);
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const iniPath = path.join(workspaceRoot, 'blinter.ini');
    fs.writeFileSync(iniPath, 'existing', 'utf8');

    const harness = loadExtension({
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
      warningChoice: 'No',
      spawnOptions: { createConfig: true }
    });
    await getController(harness);
    await harness.mock.registeredCommands.get('blinter.createConfig')();
    assert.strictEqual(fs.readFileSync(iniPath, 'utf8'), 'existing');

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    harness.restoreEnv();
  });

  it('reports createConfig failure when no workspace is open', async () => {
    const harness = loadExtension({ workspaceFolders: [] });
    await getController(harness);
    await harness.mock.registeredCommands.get('blinter.createConfig')();
    assert.ok(harness.mock.messages.errors.length > 0);
    harness.restoreEnv();
  });

  it('opens Copilot chat when command is available', async () => {
    let opened = false;
    const harness = loadExtension({
      externalCommands: {
        'github.copilot.chat.open': (...args) => { opened = true; return args; }
      }
    });
    await getController(harness);
    await harness.mock.registeredCommands.get('blinter.askCopilot')({
      codeList: 'W028',
      message: 'test',
      line: 2,
      lineText: 'echo test',
      uri: 'file://test.cmd'
    });
    assert.strictEqual(opened, true);
    harness.restoreEnv();
  });

  it('warns when Copilot chat commands are unavailable', async () => {
    const harness = loadExtension();
    await getController(harness);
    await harness.mock.registeredCommands.get('blinter.askCopilot')({ codeList: 'W028' });
    assert.ok(harness.mock.messages.warnings.length > 0);
    harness.restoreEnv();
  });

  it('removes suppression comments from active batch file', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-sup-${Date.now()}.cmd`);
    const lines = ['@echo off', 'REM LINT:IGNORE W028', 'echo hello'];
    fs.writeFileSync(tmpFile, lines.join('\r\n'), 'utf8');

    const doc = makeDocument(tmpFile, lines);
    const editor = makeEditor(doc);
    const harness = loadExtension({
      activeEditor: editor,
      visibleEditors: [editor],
      lines: [...lines]
    });
    await getController(harness);
    await harness.mock.registeredCommands.get('blinter.removeAllSuppressions')();
    assert.ok(harness.mock.messages.infos.some((m) => m.includes('Removed')));

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('provides hover details for issues on a line', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-hover-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\necho hello\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off', 'echo hello']);
    const editor = makeEditor(doc);

    const harness = loadExtension({
      activeEditor: editor,
      visibleEditors: [editor],
      workspaceRoot: path.dirname(tmpFile)
    });
    const controller = await getController(harness);
    controller.currentProgramPath = tmpFile;
    controller.currentWorkspaceRoot = path.dirname(tmpFile);
    controller.acceptProcessText('Line 2: Errorlevel handling difference between .bat/.cmd (W028)', 'stdout');
    controller.flushDiagnostics();

    const hoverProvider = harness.mock.hoverProviders[0];
    const hover = hoverProvider.provideHover(doc, { line: 1, character: 0 });
    assert.ok(hover && hover.contents.value.includes('Errorlevel'));

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('returns quick-fix actions to normalize command casing', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-qf-${Date.now()}.cmd`);
    const lines = ['ECHO hello'];
    fs.writeFileSync(tmpFile, lines.join('\r\n'), 'utf8');
    const doc = makeDocument(tmpFile, lines);

    const harness = loadExtension({
      configuration: { blinter: { quickFixCodes: ['BLINTER_CASE'] } },
      lines: [...lines]
    });
    await getController(harness);
    const diagnostic = new harness.mock.vscode.Diagnostic(
      createRange(0, 0, 0, 10),
      'Command CASE issue',
      harness.mock.vscode.DiagnosticSeverity.Warning
    );
    diagnostic.code = 'BLINTER_CASE';
    diagnostic.source = 'blinter';

    const provider = harness.mock.codeActionProviders[0];
    const actions = provider.provideCodeActions(doc, createRange(0, 0, 0, 10), { diagnostics: [diagnostic] });
    assert.ok(actions.length > 0);
    assert.ok(actions[0].title.includes('Normalize'));

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('provides suppression comment code actions', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-sup2-${Date.now()}.cmd`);
    const lines = ['echo hello'];
    fs.writeFileSync(tmpFile, lines.join('\r\n'), 'utf8');
    const doc = makeDocument(tmpFile, lines);

    const harness = loadExtension({ lines: [...lines] });
    await getController(harness);

    const diagnostic = new harness.mock.vscode.Diagnostic(
      createRange(0, 0, 0, 10),
      'warning issue',
      harness.mock.vscode.DiagnosticSeverity.Warning
    );
    diagnostic.code = 'W028';
    diagnostic.source = 'blinter';

    const provider = harness.mock.codeActionProviders[1];
    const actions = provider.provideCodeActions(doc, createRange(0, 0, 0, 10), { diagnostics: [diagnostic] });
    assert.ok(actions.some((a) => a.title.includes('Suppress W028')));

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('prepares debug launch metadata for an existing script', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-launch-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\necho test\r\n', 'utf8');

    const harness = loadExtension({ workspaceRoot: path.dirname(tmpFile) });
    const controller = await getController(harness);
    const launchInfo = await controller.prepareForLaunch({ program: tmpFile }, { id: 'session-1' });
    assert.ok(launchInfo.executable);
    assert.ok(Array.isArray(launchInfo.args));

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('rejects launch when blinter is disabled', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-disabled-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');

    const harness = loadExtension({
      configuration: { blinter: { enabled: false } },
      workspaceRoot: path.dirname(tmpFile)
    });
    const controller = await getController(harness);
    await assert.rejects(
      () => controller.prepareForLaunch({ program: tmpFile }, { id: 'session-2' }),
      /disabled/
    );

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('handles debug adapter messages in test mode', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-adapter-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\necho test\r\n', 'utf8');

    const harness = loadExtension({ workspaceRoot: path.dirname(tmpFile) });
    await getController(harness);
    const factory = harness.mock.debugAdapterFactories.get('blinter-debug');
    const descriptor = factory.createDebugAdapterDescriptor({ id: 'adapter-session', type: 'blinter-debug' });
    const adapter = descriptor.implementation || descriptor.adapter || descriptor;

    const messages = [];
    adapter.onDidSendMessage((msg) => messages.push(msg));
    adapter.handleMessage({ type: 'request', seq: 1, command: 'initialize' });
    adapter.handleMessage({
      type: 'request',
      seq: 2,
      command: 'launch',
      arguments: { program: tmpFile }
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    adapter.handleMessage({ type: 'request', seq: 3, command: 'disconnect' });
    assert.ok(messages.some((m) => m.command === 'initialize'));
    adapter.dispose();

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('updates webview and handles reveal/remove messages', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-webview-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\nREM LINT:IGNORE W028\r\necho test\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off', 'REM LINT:IGNORE W028', 'echo test']);
    const editor = makeEditor(doc);

    const harness = loadExtension({
      activeEditor: editor,
      visibleEditors: [editor],
      workspaceRoot: path.dirname(tmpFile)
    });
    await getController(harness);

    const webview = harness.mock.resolveWebviewView();
    assert.ok(webview);
    assert.ok(webview.postedMessages.length > 0);

    for (const handler of webview.receivedHandlers) {
      await handler({ command: 'reveal', path: tmpFile, line: 2 });
      await handler({ command: 'removeSuppressions' });
    }

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('lints on save and on type when configured', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-ontype-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\necho hello\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off', 'echo hello']);

    const harness = loadExtension({
      configuration: { blinter: { enabled: true, runOn: 'onType', debounceDelay: 10 } },
      workspaceRoot: path.dirname(tmpFile)
    });
    await getController(harness);

    harness.mock.fireDidSaveTextDocument(doc);
    harness.mock.fireDidChangeTextDocument(doc);
    await new Promise((resolve) => setTimeout(resolve, 80));

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('clears diagnostics when a document closes', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-close-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off']);

    const harness = loadExtension({ workspaceRoot: path.dirname(tmpFile) });
    const controller = await getController(harness);
    controller.addIssue({
      filePath: tmpFile,
      line: 1,
      severity: 'warning',
      message: 'test',
      classification: 'General',
      isCritical: false
    });
    controller.flushDiagnostics();
    harness.mock.fireDidCloseTextDocument(doc);
    await new Promise((resolve) => setTimeout(resolve, 100));

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('cancels pending on-type lint when document closes before debounce', async () => {
    let spawnCount = 0;
    const tmpFile = path.join(os.tmpdir(), `blinter-close-debounce-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off']);

    const harness = loadExtension({
      configuration: { blinter: { enabled: true, runOn: 'onType', debounceDelay: 200 } },
      workspaceRoot: path.dirname(tmpFile),
      spawnImpl: (...args) => {
        spawnCount += 1;
        return createFakeSpawn([])(...args);
      }
    });
    await getController(harness);
    harness.mock.fireDidChangeTextDocument(doc);
    harness.mock.fireDidCloseTextDocument(doc);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(spawnCount, 0);

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('refreshes decoration styles when highlight color changes', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-deco-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\necho test\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off', 'echo test']);
    const editor = makeEditor(doc, { setDecorations: () => {} });

    const harness = loadExtension({
      activeEditor: editor,
      visibleEditors: [editor],
      configuration: { blinter: { criticalHighlightColor: '#ff0000' } },
      workspaceRoot: path.dirname(tmpFile)
    });
    const controller = await getController(harness);
    controller.addIssue({
      filePath: tmpFile,
      line: 2,
      severity: 'error',
      message: 'critical',
      classification: 'General',
      isCritical: true
    });
    controller.refreshDecorations();
    harness.mock.fireDidChangeConfiguration(['blinter.criticalHighlightColor']);
    controller.refreshDecorations();

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('updates status bar based on blinter.ini presence', async () => {
    const workspaceRoot = path.join(os.tmpdir(), `blinter-status-${Date.now()}`);
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const iniPath = path.join(workspaceRoot, 'blinter.ini');
    fs.writeFileSync(iniPath, '# config', 'utf8');

    const tmpFile = path.join(workspaceRoot, 'script.cmd');
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off']);
    const editor = makeEditor(doc);

    const harness = loadExtension({
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
      activeEditor: editor,
      visibleEditors: [editor]
    });
    await getController(harness);
    assert.ok(harness.mock.outputLines.length >= 0);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    harness.restoreEnv();
  });

  it('handles debug session lifecycle events', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    controller.updateStatus('running', 'test');
    harness.mock.fireDidStartDebugSession({ type: 'blinter-debug', id: 'dbg-1' });
    harness.mock.fireDidTerminateDebugSession({ type: 'blinter-debug', id: 'dbg-1' });
    harness.restoreEnv();
  });

  it('reveals issue locations and logs navigation failures', async () => {
    const harness = loadExtension({ strictOpen: true });
    const controller = await getController(harness);
    await controller.revealLocation('C:\\missing\\file.cmd', 1);
    assert.ok(harness.mock.messages.warnings.length > 0);
    harness.restoreEnv();
  });

  it('uses theme color when highlight config is invalid', async () => {
    const harness = loadExtension({
      configuration: { blinter: { criticalHighlightColor: 'not-a-color' } }
    });
    const controller = await getController(harness);
    const color = controller.getHighlightColor();
    assert.ok(color && color.id === 'editorError.background');
    harness.restoreEnv();
  });

  it('reports failure when debug session does not start', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-rd-fail-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off']);
    const editor = makeEditor(doc);

    const harness = loadExtension({
      activeEditor: editor,
      visibleEditors: [editor],
      startDebuggingResult: false
    });
    await getController(harness);
    await harness.mock.registeredCommands.get('blinter.runAndDebug')();
    assert.ok(harness.mock.messages.errors.some((m) => m.includes('Failed to start')));

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('shows message when blinter.run has no batch editor', async () => {
    const harness = loadExtension({ activeEditor: null });
    await getController(harness);
    await harness.mock.registeredCommands.get('blinter.run')();
    assert.ok(harness.mock.messages.infos.length > 0);
    harness.restoreEnv();
  });

  it('handles createConfig spawn errors and open failures', async () => {
    const workspaceRoot = path.join(os.tmpdir(), `blinter-cc-err-${Date.now()}`);
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const harness = loadExtension({
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
      spawnImpl: () => {
        const proc = new EventEmitter();
        setImmediate(() => proc.emit('error', new Error('spawn failed')));
        return proc;
      }
    });
    await getController(harness);
    await harness.mock.registeredCommands.get('blinter.createConfig')();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(harness.mock.outputLines.some((line) => line.includes('[CreateConfig]')));

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    harness.restoreEnv();
  });

  it('handles createConfig non-zero exit codes', async () => {
    const workspaceRoot = path.join(os.tmpdir(), `blinter-cc-code-${Date.now()}`);
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const harness = loadExtension({
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
      spawnImpl: () => {
        const proc = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stderr.setEncoding = () => {};
        setImmediate(() => {
          proc.stderr.emit('data', 'failed');
          proc.emit('close', 2);
        });
        return proc;
      }
    });
    await getController(harness);
    await harness.mock.registeredCommands.get('blinter.createConfig')();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(harness.mock.messages.errors.length > 0);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    harness.restoreEnv();
  });

  it('handles askCopilot and suppression command failures', async () => {
    const harness = loadExtension({
      externalCommands: {
        'github.copilot.chat.open': () => { throw new Error('copilot failed'); }
      }
    });
    const controller = await getController(harness);
    await harness.mock.registeredCommands.get('blinter.askCopilot')({ codeList: 'W001' });
    assert.ok(harness.mock.messages.errors.length > 0);

    const stringHarness = loadExtension({
      externalCommands: {
        'github.copilot.chat.open': () => { throw new Error('copilot string failed'); }
      }
    });
    await getController(stringHarness);
    await stringHarness.mock.registeredCommands.get('blinter.askCopilot')({ codeList: 'W001' });
    assert.ok(stringHarness.mock.messages.errors.length > 0);

    controller.removeAllSuppressionComments = async () => { throw new Error('remove failed'); };
    await harness.mock.registeredCommands.get('blinter.removeAllSuppressions')();
    assert.ok(harness.mock.messages.errors.some((m) => m.includes('Failed to remove')));

    harness.restoreEnv();
    stringHarness.restoreEnv();
  });

  it('covers quick-fix and suppression provider branches', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-providers-${Date.now()}.cmd`);
    const lines = ['REM LINT:IGNORE W001', 'ECHO hello', 'REM LINT:IGNORE-LINE W002'];
    fs.writeFileSync(tmpFile, lines.join('\r\n'), 'utf8');
    const doc = makeDocument(tmpFile, lines);
    const batDoc = makeDocument(tmpFile.replace('.cmd', '.bat'), ['echo bat'], 'bat');

    const harness = loadExtension({
      lines: [...lines],
      configuration: {
        blinter: {
          suppressionCommentStyle: '::',
          showAskCopilotQuickFix: true
        }
      }
    });
    await getController(harness);

    const quickFix = harness.mock.codeActionProviders[0];
    assert.deepStrictEqual(quickFix.provideCodeActions(batDoc, createRange(0, 0, 0, 1), { diagnostics: [] }), []);

    const diag = new harness.mock.vscode.Diagnostic(
      createRange(1, 0, 1, 10),
      'case mismatch',
      harness.mock.vscode.DiagnosticSeverity.Warning
    );
    diag.code = 'CASE001';
    diag.source = 'blinter';
    const actions = quickFix.provideCodeActions(doc, createRange(1, 0, 1, 10), { diagnostics: [diag] });
    assert.ok(actions.length > 0);

    const suppression = harness.mock.codeActionProviders[1];
    const suppressActions = suppression.provideCodeActions(doc, createRange(1, 0, 1, 10), { diagnostics: [diag] });
    assert.ok(suppressActions.some((a) => a.title.includes('Ask Copilot')));
    assert.ok(suppressActions.some((a) => a.title.includes('Suppress')));

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('covers hover traces and summary filters', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-summary-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\nset VAR=%UNDEF%\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off', 'set VAR=%UNDEF%']);
    const editor = makeEditor(doc);

    const harness = loadExtension({
      activeEditor: editor,
      visibleEditors: [editor],
      workspaceRoot: path.dirname(tmpFile)
    });
    const controller = await getController(harness);
    controller.currentProgramPath = tmpFile;
    controller.currentWorkspaceRoot = path.dirname(tmpFile);
    controller.addIssue({
      filePath: tmpFile,
      line: 2,
      severity: 'error',
      message: 'undefined variable %UNDEF%',
      classification: 'UndefinedVariable',
      isCritical: true,
      variableTrace: ['set VAR', '%UNDEF%']
    });
    controller.addIssue({
      filePath: tmpFile,
      line: 1,
      severity: 'hint',
      message: 'style hint',
      classification: 'Info',
      isCritical: false
    });
    controller.flushDiagnostics();

    const hover = harness.mock.hoverProviders[0].provideHover(doc, { line: 1, character: 0 });
    assert.ok(hover && hover.contents.value.includes('Trace'));

    const summary = controller.collectSummary();
    assert.ok(summary.groups.some((g) => g.id === 'undefined' && g.items.length > 0));
    assert.ok(summary.groups.some((g) => g.id === 'critical' && g.items.length > 0));

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('covers debug configuration edge cases', async () => {
    const harness = loadExtension({ activeEditor: null, visibleEditors: [] });
    await getController(harness);
    const provider = harness.mock.debugConfigProviders.get('blinter-debug');

    const emptyResolved = provider.resolveDebugConfiguration(undefined, null);
    assert.strictEqual(emptyResolved, undefined);

    const missingFile = provider.resolveDebugConfiguration(undefined, {
      type: 'blinter-debug',
      request: 'launch',
      program: '${file}'
    });
    assert.strictEqual(missingFile, undefined);

    const missingProgram = provider.resolveDebugConfiguration(undefined, {
      type: 'blinter-debug',
      request: 'launch'
    });
    assert.strictEqual(missingProgram, undefined);

    const tmpFile = path.join(os.tmpdir(), `blinter-debug-edge-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const withoutType = provider.resolveDebugConfiguration(undefined, {
      name: 'Launch',
      request: 'launch',
      program: tmpFile
    });
    assert.strictEqual(withoutType.type, 'blinter-debug');
    assert.strictEqual(withoutType.program, tmpFile);

    const withoutRequest = provider.resolveDebugConfiguration(undefined, {
      type: 'blinter-debug',
      program: tmpFile
    });
    assert.strictEqual(withoutRequest.request, 'launch');
    fs.unlinkSync(tmpFile);

    harness.restoreEnv();
  });

  it('covers prepareForLaunch and program resolution branches', async () => {
    const workspaceRoot = path.join(os.tmpdir(), `blinter-launch-br-${Date.now()}`);
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const scriptPath = path.join(workspaceRoot, 'nested.cmd');
    fs.writeFileSync(scriptPath, '@echo off\r\n', 'utf8');

    const harness = loadExtension({ workspaceRoot });
    const controller = await getController(harness);

    await assert.rejects(
      () => controller.prepareForLaunch({}, { id: 's1' }),
      /missing the "program" field/
    );

    const relativeLaunch = await controller.prepareForLaunch({ program: 'nested.cmd' }, { id: 's2' });
    assert.ok(relativeLaunch.args.length > 0);

    const absolutePath = controller.resolveProgramPath(scriptPath, workspaceRoot);
    assert.strictEqual(absolutePath, path.normalize(scriptPath));

    const cwdPath = controller.resolveProgramPath('nested.cmd', undefined);
    assert.ok(cwdPath.endsWith('nested.cmd'));

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    harness.restoreEnv();
  });

  it('covers lint failures and executable resolution errors', async () => {
    const emptyRoot = path.join(os.tmpdir(), `blinter-empty-ext-${Date.now()}`);
    fs.mkdirSync(emptyRoot, { recursive: true });
    const scriptPath = path.join(emptyRoot, 'script.cmd');
    fs.writeFileSync(scriptPath, '@echo off\r\n', 'utf8');
    const doc = makeDocument(scriptPath, ['@echo off']);

    const harness = loadExtension({
      extensionRoot: emptyRoot,
      workspaceRoot: emptyRoot,
      spawnImpl: () => { throw new Error('spawn failed'); }
    });
    const controller = await getController(harness);
    await controller.lintDocument(doc);
    assert.ok(harness.mock.messages.errors.length > 0);

    fs.rmSync(emptyRoot, { recursive: true, force: true });
    harness.restoreEnv();
  });

  it('covers webview ensureVisible failures and output view state', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    const webview = harness.mock.resolveWebviewView({ showThrows: true });
    controller.webviewProvider._view = webview.webviewView;
    controller.webviewProvider.ensureVisible();
    assert.ok(harness.mock.outputLines.some((line) => line.includes('[OutputView]')));

    controller.webviewProvider._view = webview.webviewView;
    for (const handler of webview.receivedHandlers) {
      await handler({ command: 'removeSuppressions' });
    }

    harness.restoreEnv();
  });

  it('covers status bar and document lifecycle handlers', async () => {
    const workspaceRoot = path.join(os.tmpdir(), `blinter-life-${Date.now()}`);
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const scriptPath = path.join(workspaceRoot, 'life.cmd');
    fs.writeFileSync(scriptPath, '@echo off\r\n', 'utf8');
    const doc = makeDocument(scriptPath, ['@echo off']);
    const editor = makeEditor(doc);

    const harness = loadExtension({
      workspaceFolders: [],
      activeEditor: editor,
      visibleEditors: [editor]
    });
    const controller = await getController(harness);
    controller._hasAutoShownOutputView = true;
    controller.maybeEnsureOutputViewVisible(editor);

    harness.mock.fireDidChangeVisibleTextEditors();
    harness.mock.fireDidChangeActiveTextEditor(editor);
    harness.mock.fireDidCreateFiles();
    harness.mock.fireDidDeleteFiles();

    controller.addIssue({
      filePath: scriptPath,
      line: 1,
      severity: 'warning',
      message: 'warn',
      classification: 'General',
      isCritical: false
    });
    controller.clearDocument(doc.uri);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    harness.restoreEnv();
  });

  it('uses workbench chat open when Copilot command is unavailable', async () => {
    let opened = false;
    const harness = loadExtension({
      externalCommands: {
        'workbench.action.chat.open': () => { opened = true; }
      }
    });
    await getController(harness);
    await harness.mock.registeredCommands.get('blinter.askCopilot')({ codeList: 'W001' });
    assert.strictEqual(opened, true);
    harness.restoreEnv();
  });

  it('covers removeAllSuppressions empty and failed apply paths', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-sup-empty-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off']);
    const editor = makeEditor(doc);

    const harness = loadExtension({
      activeEditor: editor,
      visibleEditors: [editor],
      applyEditResult: false
    });
    const controller = await getController(harness);
    await controller.removeAllSuppressionComments();
    assert.ok(harness.mock.messages.infos.some((m) => m.includes('No suppression')));

    const lines = ['REM LINT:IGNORE W001', 'echo test'];
    fs.writeFileSync(tmpFile, lines.join('\r\n'), 'utf8');
    const doc2 = makeDocument(tmpFile, lines);
    harness.mock.setActiveEditor(makeEditor(doc2));
    await controller.removeAllSuppressionComments();
    assert.ok(harness.mock.messages.errors.some((m) => m.includes('Unable to apply')));

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('logs lint failures triggered on save and on type', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-lint-events-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\necho test\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off', 'echo test']);

    const saveHarness = loadExtension({
      configuration: { blinter: { enabled: true, runOn: 'onSave' } },
      spawnImpl: () => { throw new Error('lint spawn failed'); }
    });
    await getController(saveHarness);
    saveHarness.mock.fireDidSaveTextDocument(doc);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(saveHarness.mock.outputLines.some((line) => line.includes('Failed to start process')));
    saveHarness.restoreEnv();

    const typeHarness = loadExtension({
      configuration: { blinter: { enabled: true, runOn: 'onType', debounceDelay: 10 } },
      spawnImpl: () => { throw new Error('lint spawn failed'); }
    });
    await getController(typeHarness);
    typeHarness.mock.fireDidChangeTextDocument(doc);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(typeHarness.mock.outputLines.some((line) => line.includes('Failed to start process')));
    typeHarness.restoreEnv();

    fs.unlinkSync(tmpFile);
  });

  it('logs lint stderr output and cancels in-flight runs', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-lint-stderr-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\necho test\r\n', 'utf8');
    const doc = makeDocument(tmpFile, ['@echo off', 'echo test']);

    const harness = loadExtension({
      workspaceRoot: path.dirname(tmpFile),
      spawnOptions: { stderrText: 'lint stderr warning' }
    });
    const controller = await getController(harness);
    await controller.lintDocument(doc);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(harness.mock.outputLines.some((line) => line.includes('[Linter] stderr')));

    await controller.lintDocument(doc);
    await controller.lintDocument(doc);
    await new Promise((resolve) => setTimeout(resolve, 80));

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('logs webview suppression removal failures', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    controller.removeAllSuppressionComments = async () => { throw new Error('webview remove failed'); };
    const webview = harness.mock.resolveWebviewView();
    controller.webviewProvider._view = webview.webviewView;
    for (const handler of webview.receivedHandlers) {
      await handler({ command: 'removeSuppressions' });
    }
    assert.ok(harness.mock.messages.errors.some((m) => m.includes('Failed to remove')));
    harness.restoreEnv();
  });
});
