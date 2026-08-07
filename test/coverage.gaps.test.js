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

function createFakeSpawn(stdoutLines = [], options = {}) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => {};
    proc.stderr.setEncoding = () => {};
    proc.kill = () => { proc.killed = true; };
    proc.killed = false;
    proc.pid = 55;
    if (!options.hang) {
      setImmediate(() => {
        for (const line of stdoutLines) {
          proc.stdout.emit('data', `${line}\n`);
        }
        if (options.stderrText) {
          proc.stderr.emit('data', options.stderrText);
        }
        proc.emit('close', options.exitCode !== undefined ? options.exitCode : 0);
      });
    }
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
  cp.spawn = options.spawnImpl || createFakeSpawn(options.stdoutLines, options.spawnOptions || {});

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

describe('Coverage gaps — extension integration', () => {
  it('exercises controller compatibility getters and clearIssues', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    assert.ok(controller.diagnostics);
    assert.ok(controller.status);
    controller.clearIssues();
    harness.restoreEnv();
  });

  it('routes updateStatus through debug and lint paths', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    controller.updateStatus('running', 'lint path');
    controller.currentSessionId = 'debug-1';
    controller.updateStatus('running', 'debug path');
    harness.restoreEnv();
  });

  it('handles debug session termination while running', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    const tmpFile = path.normalize(path.join(os.tmpdir(), `blinter-terminate-${Date.now()}.cmd`));
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    controller.updateDebugStatus('running', 'active');
    controller.debugIssuesByFile.set(tmpFile, [{
      id: 'debug-1',
      severity: 'error',
      classification: 'Debug',
      isCritical: true,
      message: 'debug issue',
      code: 'E001',
      filePath: tmpFile,
      line: 1
    }]);
    harness.mock.fireDidTerminateDebugSession({ type: 'blinter-debug', id: 's1' });
    assert.strictEqual(controller.debugIssuesByFile.size, 0);
    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('auto-shows output view on first batch editor activation', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-auto-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const harness = loadExtension();
    await getController(harness);
    harness.mock.fireDidChangeActiveTextEditor({
      document: makeDocument(tmpFile, ['@echo off'])
    });
    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('covers command error paths and createConfig kill branch', async function () {
    this.timeout(15000);
    const repoRoot = path.join(__dirname, '..');
    const tmpRoot = path.join(os.tmpdir(), `blinter-cmd-${Date.now()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    const iniPath = path.join(tmpRoot, 'blinter.ini');
    const scriptPath = path.join(tmpRoot, 'a.cmd');
    fs.writeFileSync(scriptPath, '@echo off\r\n', 'utf8');

    let spawnCount = 0;
    const harness = loadExtension({
      extensionRoot: repoRoot,
      spawnImpl: () => {
        spawnCount += 1;
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdout.setEncoding = () => {};
        proc.stderr.setEncoding = () => {};
        proc.kill = () => {
          if (spawnCount === 1) {
            throwLiteral('kill string failed');
          }
          proc.killed = true;
        };
        if (spawnCount === 1) {
          return proc;
        }
        setImmediate(() => {
          if (spawnCount === 2) {
            fs.writeFileSync(iniPath, '# config\n', 'utf8');
          }
          proc.emit('close', 0);
        });
        return proc;
      }
    });
    harness.mock.vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    harness.mock.vscode.window.activeTextEditor = {
      document: makeDocument(scriptPath, ['@echo off'])
    };
    harness.mock.vscode.window.showWarningMessage = async () => 'Yes';
    await getController(harness);

    await harness.mock.registeredCommands.get('blinter.createConfig')();
    await harness.mock.registeredCommands.get('blinter.createConfig')();

    cp.spawn = createFakeSpawn([
      'Line 1: Sample issue (E001)'
    ]);

    await harness.mock.registeredCommands.get('blinter.run')();
    harness.mock.vscode.window.activeTextEditor = {
      document: makeDocument(path.join(tmpRoot, 'a.txt'), ['echo'], 'plaintext')
    };
    await harness.mock.registeredCommands.get('blinter.run')();

    const originalLint = (await getController(harness)).lintDocument;
    const controller = await getController(harness);
    controller.lintDocument = async () => { throwLiteral('lint string failure'); };
    harness.mock.vscode.window.activeTextEditor = {
      document: makeDocument(path.join(tmpRoot, 'a.cmd'), ['@echo off'])
    };
    await harness.mock.registeredCommands.get('blinter.run')();
    controller.lintDocument = originalLint;

    harness.mock.vscode.window.activeTextEditor = null;
    harness.mock.vscode.window.visibleTextEditors = [];
    await harness.mock.registeredCommands.get('blinter.runAndDebug')();

    harness.mock.vscode.window.activeTextEditor = {
      document: makeDocument(path.join(tmpRoot, 'a.cmd'), ['@echo off'])
    };
    harness.mock.vscode.debug.startDebugging = async () => false;
    await harness.mock.registeredCommands.get('blinter.runAndDebug')();

    controller.askCopilotAboutDiagnostic = async () => { throwLiteral('copilot string fail'); };
    await harness.mock.registeredCommands.get('blinter.askCopilot')({ codeList: 'E001' });

    controller.removeAllSuppressionComments = async () => { throwLiteral('suppress string fail'); };
    await harness.mock.registeredCommands.get('blinter.removeAllSuppressions')();

    harness.ext.deactivate();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    harness.restoreEnv();
  });

  it('covers save and type lint failure handlers', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-lintfail-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const harness = loadExtension({
      configuration: { blinter: { enabled: true, runOn: 'onType', debounceDelay: 1 } }
    });
    const controller = await getController(harness);
    const doc = makeDocument(tmpFile, ['@echo off']);
    const original = controller.lintDocument.bind(controller);
    controller.lintDocument = async () => { throw new Error('save lint failed'); };
    harness.mock.fireDidSaveTextDocument(doc);
    await new Promise((resolve) => setTimeout(resolve, 10));

    harness.mock.fireDidChangeTextDocument(doc);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.lintDocument = original;

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('covers lint service warning and spawn failure paths', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-lintsvc-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const harness = loadExtension({
      spawnImpl: () => { throw new Error('spawn failed'); }
    });
    const controller = await getController(harness);
    await controller.lintDocument({
      uri: { scheme: 'untitled', fsPath: tmpFile },
      languageId: 'bat',
      lineCount: 1,
      getText: () => '@echo off',
      lineAt: () => ({ text: '@echo off', range: createRange(0, 0, 0, 9) })
    });
    await controller.lintDocument(makeDocument(tmpFile, ['@echo off']));
    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('covers prepareForLaunch success and argument branches', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-launch-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const harness = loadExtension();
    const controller = await getController(harness);
    harness.mock.vscode.window.activeTextEditor = {
      document: makeDocument(tmpFile, ['@echo off'])
    };
    const launch = await controller.prepareForLaunch(
      { program: '${file}', args: ['  ', '--verbose'] },
      { workspaceFolder: { uri: { fsPath: path.dirname(tmpFile) } } }
    );
    assert.ok(launch.executable);
    assert.ok(launch.args.includes('--verbose'));

    harness.mock.vscode.window.activeTextEditor = null;
    harness.mock.vscode.window.visibleTextEditors = [];
    await assert.rejects(
      () => controller.prepareForLaunch({ program: '${fileBasename}' }, {}),
      /No active batch file/
    );

    harness.mock.vscode.window.activeTextEditor = {
      document: makeDocument(tmpFile, ['@echo off'])
    };
    await assert.rejects(
      () => controller.prepareForLaunch(
        { program: 'definitely-missing-file.cmd', workspaceFolder: path.dirname(tmpFile) },
        {}
      ),
      /Program not found/
    );

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('covers output view reveal and empty update branches', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    const provider = controller.webviewProvider;
    provider.postUpdate();
    provider.update(undefined);
    provider.updateStatus(undefined);

    const tmpFile = path.join(os.tmpdir(), `blinter-reveal-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    controller.lintIssuesByFile.set(path.normalize(tmpFile), [{
      severity: 'warning',
      line: 1,
      message: 'test',
      code: 'W001',
      filePath: path.normalize(tmpFile)
    }]);

    provider._view = {
      show: () => {},
      webview: {
        postMessage: () => {},
        onDidReceiveMessage: (cb) => {
          cb({ command: 'reveal', path: tmpFile, line: 1 });
          return { dispose: () => {} };
        }
      }
    };
    provider.resolveWebviewView(provider._view);
    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });
});

describe('Coverage gaps — pure modules', () => {
  it('covers diagnostics ordering and severity branches', () => {
    const ModuleRef = require('module');
    const mock = createMockVscode();
    const originalRequire = ModuleRef.prototype.require;
    ModuleRef.prototype.require = function (id) {
      if (id === 'vscode') {
        return mock.vscode;
      }
      return originalRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve('../lib/diagnostics')];
    const { compareIssues, issueToDiagnostic } = require('../lib/diagnostics');
    ModuleRef.prototype.require = originalRequire;

    assert.strictEqual(compareIssues({ severity: 'info', line: 1 }, { severity: 'information', line: 1 }), 0);
    const diagnostic = issueToDiagnostic({
      severity: 'hint',
      line: 1,
      message: 'm',
      code: 'H001',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }
    });
    assert.strictEqual(diagnostic.severity, 3);
  });

  it('covers utils allowlist continue and prefix branches', () => {
    const ModuleRef = require('module');
    const mock = createMockVscode();
    const originalRequire = ModuleRef.prototype.require;
    ModuleRef.prototype.require = function (id) {
      if (id === 'vscode') {
        return mock.vscode;
      }
      return originalRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve('../lib/utils')];
    const utils = require('../lib/utils');
    ModuleRef.prototype.require = originalRequire;

    assert.strictEqual(utils.isPathAllowed('C:\\ws\\nested\\a.cmd', ['', 'C:\\ws']), true);
    assert.strictEqual(utils.isPathAllowed('C:\\ws\\a.cmd', ['C:\\other']), false);
  });

  it('covers issueParser severity and detail branches', () => {
    const issueParser = require('../lib/issueParser');
    assert.strictEqual(issueParser.normalizeSeverity('hint'), 'hint');
    assert.strictEqual(issueParser.mapSeverityFromLegacy('FATAL'), 'error');
    const detailed = issueParser.parseOutput([
      'Line 1: sample issue (S007)',
      '  Explanation:',
      '  Recommendation: fix'
    ].join('\n'));
    assert.ok(detailed.length > 0);

    const bracketed = issueParser.parseOutput('[ERROR] (E001) -> Missing label on line 3');
    assert.strictEqual(bracketed.length, 1);
    assert.strictEqual(bracketed[0].code, 'E001');

    const general = issueParser.parseOutput('script.cmd:12: warning: trailing space');
    assert.strictEqual(general.length, 1);
    assert.strictEqual(general[0].severity, 'warning');
    assert.strictEqual(general[0].line, 12);
  });

  it('covers analysis classification and unreadable index branches', () => {
    const analysis = require('../lib/analysis');
    const infoClass = analysis.classifyMessage('style note', 'information');
    assert.strictEqual(infoClass.isCritical, false);
    const errorClass = analysis.classifyMessage('generic issue', 'error');
    assert.strictEqual(errorClass.isCritical, true);
    const map = analysis.buildVariableIndexFromFile('C:\\missing-file-that-does-not-exist.cmd', fs);
    assert.ok(map);
  });

  it('covers blinterRunner process timeout branch', (done) => {
    const { spawnBlinter } = require('../lib/blinterRunner');
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => {};
    proc.stderr.setEncoding = () => {};
    proc.kill = () => { throw new Error('kill failed'); };
    proc.killed = false;

    spawnBlinter({
      exePath: 'blinter.exe',
      config: { get: (_k, d) => d },
      filePath: 'C:\\repo\\sample.bat',
      timeoutMs: 5,
      spawnImpl: () => proc,
      onStderr: () => {},
      onExit: (code) => {
        assert.strictEqual(code, null);
        done();
      }
    });
  });

  it('covers quickFixes merge, :: style, and copilot branches', () => {
    const ModuleRef = require('module');
    const mock = createMockVscode();
    const originalRequire = ModuleRef.prototype.require;
    ModuleRef.prototype.require = function (id) {
      if (id === 'vscode') {
        return mock.vscode;
      }
      return originalRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve('../lib/quickFixes')];
    const { createQuickFixProvider, createSuppressionProvider } = require('../lib/quickFixes');
    ModuleRef.prototype.require = originalRequire;

    mock.vscode.workspace.getConfiguration = () => ({
      get: (key, fallback) => {
        if (key === 'quickFixCodes') { return ['CASE001']; }
        if (key === 'suppressionCommentStyle') { return '::'; }
        if (key === 'showAskCopilotQuickFix') { return true; }
        return fallback;
      }
    });

    const quickFix = createQuickFixProvider();
    const suppression = createSuppressionProvider();
    const doc = {
      languageId: 'bat',
      uri: { fsPath: 'C:\\ws\\a.bat', toString: () => 'file:///C:/ws/a.bat' },
      lineCount: 2,
      eol: 2,
      lineAt: (line) => ({
        text: line === 0 ? ':: LINT:IGNORE W001' : 'ECHO hello',
        range: { start: { line }, end: { line } }
      })
    };
    const diag = {
      source: 'blinter',
      code: 'CASE001',
      message: 'normalize casing',
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }
    };
    assert.ok(quickFix.provideCodeActions(doc, { start: { line: 1 } }, { diagnostics: [diag] }).length > 0);
    const actions = suppression.provideCodeActions(doc, { start: { line: 1 } }, { diagnostics: [diag, { ...diag, code: 'W002' }] });
    assert.ok(actions.length >= 2);
  });

  it('covers executable extensionUri-only context branch', () => {
    const ModuleRef = require('module');
    const mock = createMockVscode();
    const originalRequire = ModuleRef.prototype.require;
    ModuleRef.prototype.require = function (id) {
      if (id === 'vscode') {
        return mock.vscode;
      }
      return originalRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve('../lib/blinterRunner')];
    delete require.cache[require.resolve('../lib/executable')];
    const blinterRunner = require('../lib/blinterRunner');
    const originalGetExePath = blinterRunner.getExePath;
    blinterRunner.getExePath = () => path.join(__dirname, '..', 'vendor', 'Blinter', 'Blinter.exe');
    const { resolveBlinterExePath } = require('../lib/executable');
    ModuleRef.prototype.require = originalRequire;
    blinterRunner.getExePath = originalGetExePath;
    assert.ok(resolveBlinterExePath({ extensionUri: { fsPath: path.join(__dirname, '..') } }));
  });

  it('covers debugSession acceptProcessText with no issues returned', () => {
    const ModuleRef = require('module');
    const mock = createMockVscode();
    const originalRequire = ModuleRef.prototype.require;
    ModuleRef.prototype.require = function (id) {
      if (id === 'vscode') {
        return mock.vscode;
      }
      return originalRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve('../lib/debugSession')];
    const { acceptProcessText } = require('../lib/debugSession');
    ModuleRef.prototype.require = originalRequire;

    const controller = {
      currentWorkspaceRoot: 'C:\\ws',
      currentProgramPath: 'C:\\ws\\a.cmd',
      variableIndex: {},
      debugIssuesByFile: new Map(),
      log: () => {},
      scheduleDiagnosticsUpdate: () => {}
    };
    acceptProcessText(controller, 'plain text without issue structure', 'stdout');
  });

  it('covers documentSnapshot config fallback when vscode is unavailable', async () => {
    const tmpFile = path.join(os.tmpdir(), `blinter-snap-fallback-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === 'vscode') {
        throw new Error('vscode unavailable');
      }
      return originalRequire.apply(this, arguments);
    };
    try {
      delete require.cache[require.resolve('../lib/documentSnapshot')];
      const reloaded = require('../lib/documentSnapshot');
      const result = await reloaded.resolveProgramPathForLaunch(tmpFile);
      assert.strictEqual(result.isSnapshot, false);
    } finally {
      Module.prototype.require = originalRequire;
      delete require.cache[require.resolve('../lib/documentSnapshot')];
      fs.unlinkSync(tmpFile);
    }
  });

  it('filters unknown launch.json Blinter CLI flags', () => {
    const { filterBlinterCliArgs } = require('../lib/debugSession');
    const logs = [];
    const filtered = filterBlinterCliArgs(['--verbose', '--no-config', '--format', 'json'], (message) => logs.push(message));
    assert.deepStrictEqual(filtered, ['--verbose', '--format', 'json']);
    assert.ok(logs.some((entry) => entry.includes('--no-config')));
  });

  it('maps Blinter exit codes to completed vs errored status', () => {
    const mock = createMockVscode();
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === 'vscode') {
        return mock.vscode;
      }
      return originalRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve('../lib/controller')];
    const { BlinterController: ReloadedController } = require('../lib/controller');
    Module.prototype.require = originalRequire;

    const controller = new ReloadedController({ subscriptions: { push: () => {} }, extensionUri: { fsPath: path.join(__dirname, '..') } });
    assert.strictEqual(controller.resolveExitStatus(0).status, 'completed');
    assert.strictEqual(controller.resolveExitStatus(1).status, 'completed');
    assert.strictEqual(controller.resolveExitStatus(2).status, 'errored');
    assert.strictEqual(controller.resolveExitStatus(null).status, 'errored');
  });

  it('kills debug adapter processes after timeoutMs', async () => {
    const { InlineDebugAdapterSession } = require('../lib/debugAdapterCore');
    const exits = [];
    const logs = [];
    let killed = false;
    const controller = {
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws',
        timeoutMs: 5
      }),
      currentProgramPath: 'C:\\ws\\script.cmd',
      handleProcessExit: (code) => exits.push(code),
      acceptProcessText: () => {},
      log: (message) => logs.push(message)
    };

    const adapter = new InlineDebugAdapterSession(controller, { id: 'timeout-test' }, {
      spawn: () => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdout.setEncoding = () => {};
        proc.stderr.setEncoding = () => {};
        proc.kill = () => { killed = true; };
        return proc;
      }
    });

    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(killed, true);
    assert.deepStrictEqual(exits, [null]);
    assert.ok(logs.some((entry) => entry.includes('timed out')));
    adapter.dispose();
  });
});

describe('Coverage gaps — controller depth', () => {
  it('covers reveal, hover, summary, and copilot branches', async () => {
    let sidebarOpened = false;
    const tmpFile = path.join(os.tmpdir(), `blinter-depth-${Date.now()}.cmd`);
    const lines = ['@echo off', 'echo hello'];
    fs.writeFileSync(tmpFile, lines.join('\r\n'), 'utf8');

    const harness = loadExtension({
      configuration: { blinter: { criticalHighlightColor: 'not-a-color' } },
      stdoutLines: ['Line 1: BAT extension used instead of CMD for newer Windows (S007)'],
      externalCommands: {
        'workbench.action.chat.openInSidebar': () => { sidebarOpened = true; }
      }
    });
    const controller = await getController(harness);
    const doc = makeDocument(tmpFile, lines);
    harness.mock.vscode.window.activeTextEditor = { document: doc };
    harness.mock.vscode.workspace.workspaceFolders = [{ uri: { fsPath: path.dirname(tmpFile) } }];

    controller.lintIssuesByFile.set(path.normalize(tmpFile), [{
      id: '1',
      severity: 'error',
      classification: 'Lint',
      isCritical: true,
      message: 'critical',
      code: 'E001',
      filePath: path.normalize(tmpFile),
      line: 1,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }
    }]);
    controller.refreshDecorations();
    controller.refreshSuppressionDecorations();
    controller.collectSummary();
    controller.updateWebview();

    const hover = controller.provideHover(doc, { line: 0, character: 0 });
    assert.ok(hover);

    harness.mock.vscode.workspace.openTextDocument = async () => doc;
    harness.mock.vscode.window.showTextDocument = async () => ({
      revealRange: () => {},
      selection: {},
      document: doc
    });
    await controller.revealLocation(tmpFile, 1);
    await controller.revealLocation('', 1);

    await controller.askCopilotAboutDiagnostic({
      codeList: 'E001',
      message: 'issue',
      line: 1,
      lineText: 'echo hello',
      uri: doc.uri.toString()
    });
    assert.strictEqual(sidebarOpened, true);
    await controller.askCopilotAboutDiagnostic({});

    assert.ok(controller.issuesByFile);
    controller.handleProcessExit(1, 'debug');
    controller.handleProcessExit(0, 'lint');

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('includes lint and debug issues in summary while debugging', async () => {
    const tmpFile = path.normalize(path.join(os.tmpdir(), `blinter-merge-${Date.now()}.cmd`));
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const harness = loadExtension({ stdoutLines: [] });
    const controller = await getController(harness);
    controller.currentSessionId = 'debug-session';
    controller.lintIssuesByFile.set(tmpFile, [{
      id: 'lint-1',
      severity: 'warning',
      classification: 'Lint',
      isCritical: false,
      message: 'lint issue',
      code: 'W001',
      filePath: tmpFile,
      line: 1
    }]);
    controller.debugIssuesByFile.set(tmpFile, [{
      id: 'debug-1',
      severity: 'error',
      classification: 'Debug',
      isCritical: true,
      message: 'debug issue',
      code: 'E001',
      filePath: tmpFile,
      line: 2
    }]);

    const summary = controller.collectSummary();
    const errorItems = summary.groups.find((group) => group.id === 'errors')?.items || [];
    const warningItems = summary.groups.find((group) => group.id === 'warnings')?.items || [];
    assert.ok(errorItems.some((item) => item.message === 'debug issue'));
    assert.ok(warningItems.some((item) => item.message === 'lint issue'));

    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('covers createConfig stderr, spawn error, and kill on deactivate', async () => {
    const repoRoot = path.join(__dirname, '..');
    const tmpRoot = path.join(os.tmpdir(), `blinter-cmd2-${Date.now()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });

    const harness = loadExtension({
      extensionRoot: repoRoot,
      spawnImpl: () => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdout.setEncoding = () => {};
        proc.stderr.setEncoding = () => {};
        proc.kill = () => {};
        setImmediate(() => {
          proc.stderr.emit('data', 'failed to write config');
          proc.emit('close', 2);
        });
        return proc;
      }
    });
    harness.mock.vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    harness.mock.vscode.window.activeTextEditor = {
      document: makeDocument(path.join(tmpRoot, 'a.cmd'), ['@echo off'])
    };
    await getController(harness);
    await harness.mock.registeredCommands.get('blinter.createConfig')();

    const harness2 = loadExtension({
      extensionRoot: repoRoot,
      spawnImpl: () => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdout.setEncoding = () => {};
        proc.stderr.setEncoding = () => {};
        setImmediate(() => proc.emit('error', new Error('spawn boom')));
        return proc;
      }
    });
    harness2.mock.vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    harness2.mock.vscode.window.activeTextEditor = {
      document: makeDocument(path.join(tmpRoot, 'b.cmd'), ['@echo off'])
    };
    await getController(harness2);
    await harness2.mock.registeredCommands.get('blinter.createConfig')();

    const harness3 = loadExtension({ extensionRoot: repoRoot });
    harness3.mock.vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    harness3.mock.vscode.window.activeTextEditor = {
      document: makeDocument(path.join(tmpRoot, 'c.cmd'), ['@echo off'])
    };
    let hangingProc;
    cp.spawn = () => {
      hangingProc = new EventEmitter();
      hangingProc.stdout = new EventEmitter();
      hangingProc.stderr = new EventEmitter();
      hangingProc.stdout.setEncoding = () => {};
      hangingProc.stderr.setEncoding = () => {};
      hangingProc.kill = () => { throw new Error('kill failed'); };
      return hangingProc;
    };
    await getController(harness3);
    await harness3.mock.registeredCommands.get('blinter.createConfig')();
    harness3.ext.deactivate();

    fs.rmSync(tmpRoot, { recursive: true, force: true });
    harness.restoreEnv();
    harness2.restoreEnv();
    harness3.restoreEnv();
  });

  it('covers debug session untitled and workspace folder branches', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    harness.mock.vscode.window.activeTextEditor = {
      document: {
        languageId: 'bat',
        uri: { scheme: 'untitled', fsPath: 'untitled:1' },
        lineCount: 1,
        getText: () => '@echo off',
        lineAt: () => ({ text: '@echo off', range: createRange(0, 0, 0, 9) })
      }
    };
    await assert.rejects(
      () => controller.prepareForLaunch({ program: '${file}' }, {}),
      /Save the file/
    );

    const tmpFile = path.join(os.tmpdir(), `blinter-ws-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    const launch = await controller.prepareForLaunch(
      { program: path.basename(tmpFile) },
      { workspaceFolder: { uri: { fsPath: path.dirname(tmpFile) } } }
    );
    assert.ok(launch.executable);
    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('covers lint service save-before-lint and empty path branches', async () => {
    const harness = loadExtension({
      configuration: { blinter: { saveBeforeLint: true } }
    });
    const controller = await getController(harness);
    const tmpFile = path.join(os.tmpdir(), `blinter-save2-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
    await controller.lintDocument({
      uri: { scheme: 'file', fsPath: '   ' },
      languageId: 'bat',
      isDirty: false,
      lineCount: 1,
      save: async () => false,
      getText: () => '@echo off',
      lineAt: () => ({ text: '@echo off', range: createRange(0, 0, 0, 9) })
    });
    await controller.lintDocument({
      uri: { scheme: 'file', fsPath: tmpFile },
      languageId: 'bat',
      isDirty: true,
      lineCount: 1,
      save: async () => false,
      getText: () => 'dirty',
      lineAt: () => ({ text: 'dirty', range: createRange(0, 0, 0, 5) })
    });
    fs.unlinkSync(tmpFile);
    harness.restoreEnv();
  });

  it('covers quickFixes insert branch and output view suppression catch', async () => {
    const ModuleRef = require('module');
    const mock = createMockVscode();
    const originalRequire = ModuleRef.prototype.require;
    ModuleRef.prototype.require = function (id) {
      if (id === 'vscode') {
        return mock.vscode;
      }
      return originalRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve('../lib/quickFixes')];
    const { createSuppressionProvider } = require('../lib/quickFixes');
    ModuleRef.prototype.require = originalRequire;

    mock.vscode.workspace.getConfiguration = () => ({
      get: (key, fallback) => {
        if (key === 'suppressionCommentStyle') { return 'REM'; }
        if (key === 'showAskCopilotQuickFix') { return false; }
        return fallback;
      }
    });
    const doc = {
      languageId: 'cmd',
      uri: { fsPath: 'C:\\ws\\only.cmd' },
      lineCount: 1,
      eol: 2,
      lineAt: () => ({ text: 'ECHO hello', range: { start: { line: 0 }, end: { line: 0 } } })
    };
    const actions = createSuppressionProvider().provideCodeActions(
      doc,
      { start: { line: 0 } },
      { diagnostics: [{ source: 'blinter', code: 'W001', message: 'warn', range: { start: { line: 0 } } }] }
    );
    assert.ok(actions.length > 0);

    const harness = loadExtension();
    const controller = await getController(harness);
    const provider = controller.webviewProvider;
    controller.removeAllSuppressionComments = async () => { throw new Error('remove failed'); };
    provider._view = {
      show: () => {},
      webview: {
        postMessage: () => {},
        onDidReceiveMessage: (cb) => {
          cb({ command: 'removeSuppressions' });
          return { dispose: () => {} };
        }
      }
    };
    provider.resolveWebviewView(provider._view);
    await new Promise((resolve) => setTimeout(resolve, 10));
    harness.restoreEnv();
  });

  it('covers isPathInsideRoot and parseOutput filePath context', () => {
    const ModuleRef = require('module');
    const mock = createMockVscode();
    const originalRequire = ModuleRef.prototype.require;
    ModuleRef.prototype.require = function (id) {
      if (id === 'vscode') {
        return mock.vscode;
      }
      return originalRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve('../lib/utils')];
    const utils = require('../lib/utils');
    ModuleRef.prototype.require = originalRequire;

    assert.strictEqual(utils.isPathInsideRoot('C:\\ext\\vendor\\blinter.exe', 'C:\\ext'), true);
    assert.strictEqual(utils.isPathInsideRoot('C:\\other\\blinter.exe', 'C:\\ext'), false);
    assert.strictEqual(utils.isPathInsideRoot('', 'C:\\ext'), false);

    const issueParser = require('../lib/issueParser');
    const parsed = issueParser.parseOutput('called.cmd:4: error: missing label', {
      workspaceRoot: 'C:\\ws',
      defaultFile: 'C:\\ws\\main.cmd'
    });
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].filePath, path.normalize('C:\\ws\\called.cmd'));
  });

  it('rejects relative launch program paths outside workspace', () => {
    const ModuleRef = require('module');
    const mock = createMockVscode();
    const originalRequire = ModuleRef.prototype.require;
    ModuleRef.prototype.require = function (id) {
      if (id === 'vscode') {
        return mock.vscode;
      }
      return originalRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve('../lib/debugSession')];
    const { assertProgramPathAllowed } = require('../lib/debugSession');
    ModuleRef.prototype.require = originalRequire;

    assert.throws(() => {
      assertProgramPathAllowed(
        path.normalize('C:\\outside\\evil.cmd'),
        'C:\\ws',
        undefined
      );
    }, /outside the allowed workspace/);
    assert.doesNotThrow(() => {
      assertProgramPathAllowed(
        path.normalize('C:\\ws\\scripts\\run.cmd'),
        'C:\\ws',
        undefined
      );
    });
  });

  it('skips unauthorized diagnostic paths during flush', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    controller.lintIssuesByFile.set('C:\\outside\\secret.cmd', [{
      id: 'x1',
      severity: 'error',
      message: 'blocked',
      filePath: 'C:\\outside\\secret.cmd',
      line: 1
    }]);
    controller.currentWorkspaceRoot = 'C:\\ws';
    controller.currentProgramPath = 'C:\\ws\\main.cmd';
    controller.flushDiagnostics();
    assert.ok(harness.mock.outputLines.some((line) => line.includes('Skipping unauthorized path')));
    harness.ext.deactivate();
    harness.restoreEnv();
  });

  it('covers diagnostic allowed paths helper branches', async () => {
    const harness = loadExtension();
    const controller = await getController(harness);
    harness.mock.vscode.workspace.workspaceFolders = [{ uri: { fsPath: 'C:\\ws' } }];
    controller.currentWorkspaceRoot = 'C:\\proj';
    controller.currentProgramPath = 'C:\\proj\\run.cmd';
    controller.lintIssuesByFile.set('C:\\outside\\tracked.cmd', []);
    const allowed = controller.getDiagnosticAllowedPaths();
    const revealPaths = controller.getAllowedRevealPaths();
    assert.ok(allowed.includes('C:\\ws'));
    assert.ok(allowed.includes('C:\\proj'));
    assert.ok(revealPaths.includes('C:\\outside\\tracked.cmd'));
    harness.ext.deactivate();
    harness.restoreEnv();
  });

  it('reports createConfig failure when executable cannot be resolved', async () => {
    const emptyRoot = path.join(os.tmpdir(), `blinter-no-vendor-${Date.now()}`);
    fs.mkdirSync(emptyRoot, { recursive: true });
    const harness = loadExtension({
      extensionRoot: emptyRoot,
      workspaceFolders: [{ uri: { fsPath: 'C:\\ws' } }],
      configuration: { blinter: { useSystemBlinter: false } }
    });
    await getController(harness);
    await harness.mock.registeredCommands.get('blinter.createConfig')();
    assert.ok(harness.mock.outputLines.some((line) => line.includes('[CreateConfig]')));
    assert.ok(harness.mock.messages.errors.length > 0);
    fs.rmSync(emptyRoot, { recursive: true, force: true });
    harness.restoreEnv();
  });
});
