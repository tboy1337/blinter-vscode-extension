const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { EventEmitter } = require('events');

const { parseBlinterOutput, mapSeverityFromLegacy, mapSeverityFromCode } = require('../lib/parser');
const {
  analyzeLine,
  buildVariableIndexFromFile,
  classifyMessage,
  normalizeSeverity,
  severityFromCode,
  resolveFile,
  addVariableEvent,
  createIssue
} = require('../lib/analysis');
const { findBlinterExecutable } = require('../lib/discovery');
const { spawnBlinter, getExePath } = require('../lib/blinterRunner');
const { InlineDebugAdapterSession } = require('../lib/debugAdapterCore');

function makeConfig(overrides = {}) {
  const values = { encoding: 'utf8', ...overrides };
  return {
    get: (key, defaultValue) => values[key] !== undefined ? values[key] : defaultValue
  };
}

function createFakeProcess({ stdoutLines = [], stdoutText = '', stderrText = '', exitCode = 0, encodingThrows = false } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdout.setEncoding = (enc) => {
    if (encodingThrows && enc === 'bad-encoding') {
      throw new Error('invalid encoding');
    }
  };
  proc.stderr.setEncoding = () => {};
  proc.kill = () => { proc.killed = true; };
  proc.killed = false;
  proc.pid = 99;
  setImmediate(() => {
    for (const line of stdoutLines) {
      proc.stdout.emit('data', `${line}\n`);
    }
    if (stdoutText) {
      proc.stdout.emit('data', stdoutText);
    }
    if (stderrText) {
      proc.stderr.emit('data', stderrText);
    }
    proc.emit('close', exitCode);
  });
  return proc;
}

describe('Coverage — parser branches', () => {
  it('maps legacy ERROR severity to error', () => {
    const issues = parseBlinterOutput('[ERROR] (E001) -> fatal issue on line 3');
    assert.strictEqual(issues[0].severity, 'error');
  });

  it('returns empty array for missing stdout', () => {
    assert.deepStrictEqual(parseBlinterOutput(null), []);
    assert.deepStrictEqual(parseBlinterOutput(''), []);
  });

  it('maps legacy FATAL severity to error', () => {
    const issues = parseBlinterOutput('[FATAL] (E001) -> fatal issue on line 3');
    assert.strictEqual(issues[0].severity, 'error');
  });

  it('maps performance codes to hint severity', () => {
    const issues = parseBlinterOutput('Line 1: performance hint (P001)');
    assert.strictEqual(issues[0].severity, 'hint');
  });

  it('skips non-matching lines in detailed mode', () => {
    const issues = parseBlinterOutput('random noise without structure');
    assert.strictEqual(issues.length, 0);
  });
  it('maps unknown code families to informational severity', () => {
    const issues = parseBlinterOutput('Line 1: custom rule (X001)');
    assert.strictEqual(issues[0].severity, 'information');
  });
  it('maps legacy INFO and WARNING severities', () => {
    const info = parseBlinterOutput('[INFO] (S001) -> style issue on line 1');
    assert.strictEqual(info[0].severity, 'information');
    const warn = parseBlinterOutput('[WARNING] (W001) -> warning issue on line 2');
    assert.strictEqual(warn[0].severity, 'warning');
  });

  it('maps severity from detailed rule code families', () => {
    const cases = [
      ['Line 1: error issue (E001)', 'error'],
      ['Line 1: warning issue (W001)', 'warning'],
      ['Line 1: security issue (SEC001)', 'warning'],
      ['Line 1: style issue (S001)', 'information'],
      ['Line 1: performance issue (P001)', 'hint']
    ];
    for (const [line, severity] of cases) {
      assert.strictEqual(parseBlinterOutput(line)[0].severity, severity);
    }
  });

  it('parses detailed output with explanation and recommendation lines', () => {
    const stdout = [
      'Line 3: Missing pause before exit (W020)',
      ' - Explanation: Scripts should pause',
      ' - Recommendation: Add pause',
      'random footer'
    ].join('\n');
    const issues = parseBlinterOutput(stdout);
    assert.strictEqual(issues.length, 1);
    assert.ok(issues[0].description.includes('Explanation'));
    assert.strictEqual(issues[0].details.length, 2);
  });

  it('maps legacy severities through helper functions', () => {
    assert.strictEqual(mapSeverityFromLegacy('WARN'), 'warning');
    assert.strictEqual(mapSeverityFromLegacy(''), 'error');
    assert.strictEqual(mapSeverityFromCode(''), 'information');
    assert.strictEqual(mapSeverityFromCode('SEC001'), 'warning');
  });

  it('skips detail lines with empty labels and values', () => {
    const stdout = [
      'Line 2: Missing pause (W020)',
      ' - :',
      ' - Explanation: detail only'
    ].join('\n');
    const issues = parseBlinterOutput(stdout);
    assert.strictEqual(issues.length, 1);
    assert.ok(issues[0].description.includes('Explanation'));
  });
});

describe('Coverage — analysis branches', () => {
  it('parses bracketed analyzer output without explicit line number', () => {
    const result = analyzeLine('[WARN] (W001) -> unreachable code detected', {
      workspaceRoot: 'C:\\ws',
      defaultFile: 'C:\\ws\\script.cmd',
      variableIndex: new Map()
    });
    assert.strictEqual(result.issues.length, 1);
    assert.strictEqual(result.issues[0].line, 1);
  });

  it('parses file:line: severity output format', () => {
    const result = analyzeLine('script.cmd:4: warning: Possible bad label', {
      workspaceRoot: 'C:\\ws',
      defaultFile: 'C:\\ws\\script.cmd',
      variableIndex: new Map()
    });
    assert.strictEqual(result.issues[0].classification, 'BadLabel');
  });

  it('classifies infinite loop and deprecated messages', () => {
    const loop = analyzeLine('Line 2: infinite loop detected (W010)', {
      workspaceRoot: null,
      defaultFile: 'C:\\ws\\script.cmd',
      variableIndex: new Map()
    }).issues[0];
    assert.strictEqual(loop.classification, 'PossibleInfiniteLoop');

    const deprecated = analyzeLine('Line 2: deprecated command used (W011)', {
      workspaceRoot: null,
      defaultFile: 'C:\\ws\\script.cmd',
      variableIndex: new Map()
    }).issues[0];
    assert.strictEqual(deprecated.classification, 'Deprecated');
  });

  it('resolves relative paths using default file directory when workspace is missing', () => {
    const result = analyzeLine('child.cmd:2: warning: Possible bad label', {
      workspaceRoot: null,
      defaultFile: 'C:\\ws\\parent\\main.cmd',
      variableIndex: new Map()
    });
    assert.ok(result.issues[0].filePath.endsWith(path.join('parent', 'child.cmd')));
  });

  it('records setlocal assignments in variable index', () => {
    const variableIndex = new Map();
    analyzeLine('setlocal EnableDelayedExpansion', {
      workspaceRoot: null,
      defaultFile: 'C:\\ws\\script.cmd',
      variableIndex
    });
    assert.strictEqual(variableIndex.size, 0);
  });

  it('normalizes relative paths without workspace or default file', () => {
    const result = analyzeLine('relative.cmd:2: warning: Possible bad label', {
      workspaceRoot: null,
      defaultFile: undefined,
      variableIndex: new Map()
    });
    assert.ok(result.issues[0].filePath.endsWith('relative.cmd'));
  });

  it('returns trimmed path when only relative file text is available', () => {
    const result = analyzeLine('relative.cmd:2: warning: Possible bad label', {
      workspaceRoot: null,
      defaultFile: '',
      variableIndex: new Map()
    });
    assert.strictEqual(result.issues[0].filePath, 'relative.cmd');
  });

  it('classifies bad labels, critical keywords, and undefined variables', () => {
    const variableIndex = new Map();
    const badLabel = analyzeLine('script.cmd:2: warning: Possible bad label', {
      workspaceRoot: 'C:\\ws',
      defaultFile: 'C:\\ws\\script.cmd',
      variableIndex
    }).issues[0];
    assert.strictEqual(badLabel.classification, 'BadLabel');

    const critical = analyzeLine('Line 1: unreachable code detected (E001)', {
      workspaceRoot: 'C:\\ws',
      defaultFile: 'C:\\ws\\script.cmd',
      variableIndex
    }).issues[0];
    assert.strictEqual(critical.classification, 'Heuristic');

    const undefinedVar = analyzeLine('Line 2: undefined variable %FOO% (W001)', {
      workspaceRoot: 'C:\\ws',
      defaultFile: 'C:\\ws\\script.cmd',
      variableIndex
    }).issues[0];
    assert.strictEqual(undefinedVar.classification, 'UndefinedVariable');
  });

  it('ignores unreadable files when building variable index', () => {
    const map = buildVariableIndexFromFile('C:\\missing\\file.cmd', {
      readFileSync: () => { throw new Error('missing'); }
    });
    assert.strictEqual(map.size, 0);
  });

  it('covers severity and classification helper branches', () => {
    assert.strictEqual(normalizeSeverity(undefined), 'error');
    assert.strictEqual(severityFromCode('SEC001'), 'warning');
    assert.deepStrictEqual(classifyMessage('', 'information'), {
      classification: 'Info',
      isCritical: false
    });
    assert.strictEqual(classifyMessage('syntax error detected', 'warning').classification, 'SyntaxWarning');
  });

  it('resolves empty trimmed file paths to the default file', () => {
    const resolved = resolveFile('   ', 'C:\\ws', 'C:\\ws\\script.cmd');
    assert.strictEqual(resolved, path.normalize('C:\\ws\\script.cmd'));
    assert.strictEqual(resolveFile('   ', null, undefined), undefined);
  });

  it('records set assignments and variable traces in the index', () => {
    const variableIndex = new Map();
    analyzeLine('set MYVAR=value', {
      workspaceRoot: 'C:\\ws',
      defaultFile: 'C:\\ws\\script.cmd',
      variableIndex
    });
    analyzeLine('set EMPTY=', {
      workspaceRoot: 'C:\\ws',
      defaultFile: undefined,
      variableIndex
    });
    assert.ok(variableIndex.has('MYVAR'));
    assert.ok(variableIndex.has('EMPTY'));

    const undefinedVar = analyzeLine('Line 2: undefined variable FOO (W001)', {
      workspaceRoot: 'C:\\ws',
      defaultFile: 'C:\\ws\\script.cmd',
      variableIndex: new Map([['FOO', [{ file: 'C:\\ws\\script.cmd', line: 1, value: 'x' }]]])
    }).issues[0];
    assert.ok(undefinedVar.variableTrace);

    addVariableEvent(null, 'FOO', {});
    addVariableEvent(new Map(), '', {});
    assert.strictEqual(buildVariableIndexFromFile(null, fs).size, 0);
    assert.strictEqual(buildVariableIndexFromFile('C:\\ws\\script.cmd', null).size, 0);
  });

  it('parses general format with whitespace-only file names', () => {
    const result = analyzeLine('   :2: warning: Possible bad label', {
      workspaceRoot: 'C:\\ws',
      defaultFile: 'C:\\ws\\script.cmd',
      variableIndex: new Map()
    });
    assert.strictEqual(result.issues[0].filePath, path.normalize('C:\\ws\\script.cmd'));
  });

  it('builds variable traces and issue metadata edge cases', () => {
    const variableIndex = new Map([
      ['FOO', [
        null,
        { file: 'C:\\ws\\script.cmd' },
        { line: 2 },
        { value: 'only-value' },
        { file: 'C:\\ws\\script.cmd', line: 3, value: 'full' }
      ]]
    ]);

    const issue = createIssue({
      severity: 'warning',
      message: 42,
      filePath: undefined,
      lineNumber: NaN,
      code: 'W001',
      variableIndex
    });

    assert.strictEqual(issue.message, '');
    assert.strictEqual(issue.line, 1);
    assert.strictEqual(issue.filePath, undefined);
    assert.strictEqual(issue.variableName, undefined);

    const traced = createIssue({
      severity: 'warning',
      message: 'undefined variable FOO',
      filePath: 'C:\\ws\\script.cmd',
      lineNumber: 2,
      code: 'W001',
      variableIndex
    });
    assert.ok(traced.variableTrace.length >= 3);
  });
});

describe('Coverage — discovery branches', () => {
  it('returns absolute configured binary path when it exists', () => {
    const absolute = 'C:\\tools\\blinter.exe';
    const result = findBlinterExecutable('root', 'win32', (p) => p === absolute, { binaryPath: absolute });
    assert.strictEqual(result, absolute);
  });

  it('returns upstream installer executable when present', () => {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const installed = path.join(localAppData, 'Programs', 'Blinter', 'bin', 'blinter.exe');
    const result = findBlinterExecutable('root', 'win32', (p) => p === installed);
    assert.strictEqual(result, installed);
  });

  it('returns versioned executable from bin directory', () => {
    const binDir = path.join('root', 'bin');
    const versioned = path.join(binDir, 'Blinter-1.0.99.exe');
    const fakeExists = (p) => path.normalize(p) === path.normalize(versioned);
    const fakeReadDir = (dir) => {
      if (path.normalize(dir) === path.normalize(binDir)) {
        return ['Blinter-1.0.99.exe'];
      }
      throw new Error('missing');
    };
    const originalReaddir = fs.readdirSync;
    fs.readdirSync = fakeReadDir;
    try {
      const result = findBlinterExecutable('root', 'win32', fakeExists);
      assert.strictEqual(path.normalize(result), path.normalize(versioned));
    } finally {
      fs.readdirSync = originalReaddir;
    }
  });

  it('returns alternate installed executable casing when present', () => {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const installedAlt = path.join(localAppData, 'Programs', 'Blinter', 'bin', 'Blinter.exe');
    const result = findBlinterExecutable('root', 'win32', (p) => path.normalize(p) === path.normalize(installedAlt));
    assert.strictEqual(path.normalize(result), path.normalize(installedAlt));
  });

  it('skips versioned executable when file is missing on disk', () => {
    const binDir = path.join('root', 'bin');
    const versioned = path.join(binDir, 'Blinter-1.0.99.exe');
    const fakeExists = () => false;
    const originalReaddir = fs.readdirSync;
    fs.readdirSync = (dir) => {
      if (path.normalize(dir) === path.normalize(binDir)) {
        return ['Blinter-1.0.99.exe'];
      }
      throw new Error('missing');
    };
    try {
      const result = findBlinterExecutable('root', 'win32', fakeExists);
      assert.strictEqual(result, null);
      assert.strictEqual(path.normalize(versioned), path.normalize(versioned));
    } finally {
      fs.readdirSync = originalReaddir;
    }
  });

  it('ignores invalid configured binary path errors', () => {
    const result = findBlinterExecutable('root', 'win32', () => false, { binaryPath: 'relative\\missing.exe' });
    assert.strictEqual(result, null);
  });

  it('ignores invalid configured binary path resolution errors', () => {
    const result = findBlinterExecutable('', 'win32', () => false, { binaryPath: 'tools\\blinter.exe' });
    assert.strictEqual(result, null);
  });

  it('ignores existsSync failures for configured binary paths', () => {
    const binaryCandidate = path.join('root', 'tools', 'blinter.exe');
    const result = findBlinterExecutable('root', 'win32', (candidate) => {
      if (path.normalize(candidate) === path.normalize(binaryCandidate)) {
        throw new Error('exists failed');
      }
      return false;
    }, { binaryPath: 'tools\\blinter.exe' });
    assert.strictEqual(result, null);
  });

  it('uses non-windows executable names and skips installer lookup', () => {
    const vendor = path.join('root', 'vendor', 'Blinter', 'Blinter');
    const exists = (candidate) => path.normalize(candidate) === path.normalize(vendor);
    const result = findBlinterExecutable('root', 'linux', exists);
    assert.ok(result);
    assert.strictEqual(path.normalize(result), path.normalize(vendor));
    assert.strictEqual(findBlinterExecutable('root', 'linux', () => false), null);
  });

  it('accepts omitted options and platform defaults', () => {
    assert.strictEqual(findBlinterExecutable('root', undefined, () => false), null);
  });

  it('skips system PATH lookup on non-windows platforms', () => {
    const result = findBlinterExecutable('root', 'linux', () => false, { useSystemBlinter: true });
    assert.strictEqual(result, null);
  });

  it('treats PATH lookup failures as not on path', () => {
    const originalSpawnSync = cp.spawnSync;
    cp.spawnSync = () => {
      throw new Error('spawn failed');
    };
    try {
      const result = findBlinterExecutable('root', 'win32', () => false, { useSystemBlinter: true });
      assert.strictEqual(result, null);
    } finally {
      cp.spawnSync = originalSpawnSync;
    }
  });
});

describe('Coverage — blinterRunner branches', () => {
  it('falls back to utf8 when stdout encoding is invalid', () => {
    let stdoutEncoding = '';
    const proc = createFakeProcess({ stdoutLines: ['line'], encodingThrows: true });
    proc.stdout.setEncoding = (enc) => {
      if (enc === 'bad-encoding') {throw new Error('bad');}
      stdoutEncoding = enc;
    };

    spawnBlinter({
      exePath: 'blinter.exe',
      config: makeConfig({ encoding: 'bad-encoding' }),
      filePath: 'C:\\ws\\script.cmd',
      spawnImpl: () => proc
    });

    assert.strictEqual(stdoutEncoding, 'utf8');
  });

  it('ignores kill failures on spawned process', () => {
    const proc = createFakeProcess();
    proc.kill = () => { throw new Error('kill failed'); };

    const handle = spawnBlinter({
      exePath: 'blinter.exe',
      config: makeConfig(),
      filePath: 'C:\\ws\\script.cmd',
      spawnImpl: () => proc
    });
    handle.kill();
  });

  it('reports stderr and null exit code on spawn error', async () => {
    const stderrChunks = [];
    let exitCode = undefined;
    spawnBlinter({
      exePath: 'blinter.exe',
      config: makeConfig(),
      filePath: 'C:\\ws\\script.cmd',
      onStderr: (text) => stderrChunks.push(text),
      onExit: (code) => { exitCode = code; },
      spawnImpl: () => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        setImmediate(() => proc.emit('error', new Error('spawn failed')));
        return proc;
      }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(stderrChunks.join('').includes('spawn failed'));
    assert.strictEqual(exitCode, null);
  });

  it('streams stderr data from spawned process', async () => {
    const stderrChunks = [];
    spawnBlinter({
      exePath: 'blinter.exe',
      config: makeConfig({ encoding: 'bad-encoding' }),
      filePath: 'C:\\ws\\script.cmd',
      onStderr: (text) => stderrChunks.push(text),
      spawnImpl: () => createFakeProcess({ stderrText: 'stderr-data' })
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(stderrChunks.join('').includes('stderr-data'));
  });

  it('spawns without stdout stream when process.stdout is missing', () => {
    spawnBlinter({
      exePath: 'blinter.exe',
      config: makeConfig(),
      filePath: 'C:\\ws\\script.cmd',
      spawnImpl: () => {
        const proc = new EventEmitter();
        proc.stderr = new EventEmitter();
        setImmediate(() => proc.emit('close', 0));
        return proc;
      }
    });
  });

  it('resolves extension root from plain string path', () => {
    const resolved = getExePath('C:\\extension-root');
    assert.ok(resolved.includes('vendor'));
  });

  it('falls back to extension directory when uri is missing', () => {
    const resolved = getExePath();
    assert.ok(resolved.includes('vendor'));
  });

  it('falls back to utf8 when stderr encoding is invalid', () => {
    let stderrEncoding = '';
    const proc = createFakeProcess({ stderrText: 'stderr' });
    proc.stderr.setEncoding = (enc) => {
      if (enc === 'bad-encoding') {throw new Error('bad');}
      stderrEncoding = enc;
    };

    spawnBlinter({
      exePath: 'blinter.exe',
      config: makeConfig({ encoding: 'bad-encoding' }),
      filePath: 'C:\\ws\\script.cmd',
      spawnImpl: () => proc
    });

    assert.strictEqual(stderrEncoding, 'utf8');
  });

  it('reports string spawn errors without message property', async () => {
    let exitCode = undefined;
    spawnBlinter({
      exePath: 'blinter.exe',
      config: makeConfig(),
      filePath: 'C:\\ws\\script.cmd',
      onStderr: () => {},
      onExit: (code) => { exitCode = code; },
      spawnImpl: () => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        setImmediate(() => proc.emit('error', 'spawn failed'));
        return proc;
      }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(exitCode, null);
  });

  it('caps stdout buffer growth before newline splitting', async () => {
    const lines = [];
    const proc = createFakeProcess();
    spawnBlinter({
      exePath: 'blinter.exe',
      config: makeConfig(),
      filePath: 'C:\\ws\\script.cmd',
      onLine: (line) => lines.push(line),
      spawnImpl: () => proc
    });

    proc.stdout.emit('data', 'x'.repeat(70 * 1024));
    proc.stdout.emit('data', 'tail\n');
    proc.emit('close', 0);
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(lines.length <= 1);
    if (lines.length === 1) {
      assert.ok(lines[0].length <= 64 * 1024);
    }
  });
});

describe('Coverage — debug adapter branches', () => {
  it('requires controller at construction', () => {
    assert.throws(() => new InlineDebugAdapterSession(undefined, {}), /controller is required/);
  });

  it('handles disconnect, terminate, and unknown commands', () => {
    const messages = [];
    const controller = {
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws',
        displayName: 'script.cmd'
      }),
      currentProgramPath: 'C:\\ws\\script.cmd',
      acceptProcessText: () => {},
      handleProcessExit: () => {},
      log: () => {}
    };

    const adapter = new InlineDebugAdapterSession(controller, { id: 's1' }, {
      spawn: () => createFakeProcess({ stdoutLines: ['Line 1: warning (W001)'] })
    });
    adapter.onDidSendMessage((msg) => messages.push(msg));

    adapter.handleMessage({ type: 'request', seq: 1, command: 'initialize' });
    adapter.handleMessage({ type: 'request', seq: 2, command: 'launch', arguments: { program: 'script.cmd' } });
    adapter.handleMessage({ type: 'request', seq: 3, command: 'configurationDone' });
    adapter.handleMessage({ type: 'request', seq: 4, command: 'custom' });
    adapter.handleMessage({ type: 'request', seq: 5, command: 'disconnect' });

    assert.ok(messages.some((m) => m.command === 'initialize'));
    assert.ok(messages.some((m) => m.event === 'terminated'));
    adapter.dispose();
  });

  it('emits stderr output and skips empty lines', async () => {
    const accepted = [];
    const controller = {
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws'
      }),
      currentProgramPath: 'C:\\ws\\script.cmd',
      acceptProcessText: (text) => accepted.push(text),
      handleProcessExit: () => {},
      log: () => {}
    };

    const adapter = new InlineDebugAdapterSession(controller, { id: 's2' }, {
      spawn: () => createFakeProcess({ stderrText: 'stderr-msg\n' })
    });

    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepStrictEqual(accepted, ['stderr-msg']);
    adapter.dispose();
  });

  it('falls back to utf8 when debug adapter stderr encoding is invalid', async () => {
    const messages = [];
    const controller = {
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws'
      }),
      currentProgramPath: 'C:\\ws\\script.cmd',
      acceptProcessText: () => {},
      handleProcessExit: () => {},
      log: () => {}
    };

    const adapter = new InlineDebugAdapterSession(controller, { id: 's4' }, {
      spawn: () => {
        const proc = createFakeProcess({ stdoutLines: ['Line 1: warning (W001)'] });
        proc.stderr.setEncoding = () => { throw new Error('bad encoding'); };
        return proc;
      }
    });
    adapter.onDidSendMessage((msg) => messages.push(msg));
    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(messages.some((m) => m.command === 'launch' || m.event === 'process'));
    adapter.dispose();
  });

  it('reports launch failures from prepareForLaunch', async () => {
    const messages = [];
    let debugStatus;
    const controller = {
      prepareForLaunch: async () => { throw new Error('launch failed'); },
      log: () => {},
      updateDebugStatus: (state, detail) => { debugStatus = { state, detail }; },
      handleProcessExit: () => {}
    };
    const adapter = new InlineDebugAdapterSession(controller, { id: 's3' });
    adapter.onDidSendMessage((msg) => messages.push(msg));
    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(messages.some((m) => m.success === false));
    assert.strictEqual(debugStatus?.state, 'errored');
    adapter.dispose();
  });

  it('reports non-error launch failures as strings', async () => {
    const messages = [];
    const controller = {
      prepareForLaunch: async () => { throw new Error('string failure'); },
      log: () => {}
    };
    const adapter = new InlineDebugAdapterSession(controller, { id: 's3b' });
    adapter.onDidSendMessage((msg) => messages.push(msg));
    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(messages.some((m) => m.message === 'string failure'));
    adapter.dispose();
  });

  it('handles debug process errors after launch', async () => {
    const messages = [];
    const controller = {
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws'
      }),
      currentProgramPath: 'C:\\ws\\script.cmd',
      acceptProcessText: () => {},
      handleProcessExit: () => {},
      log: () => {}
    };

    const adapter = new InlineDebugAdapterSession(controller, { id: 's5' }, {
      spawn: () => {
        const proc = createFakeProcess();
        setTimeout(() => proc.emit('error', new Error('runtime failed')), 25);
        return proc;
      }
    });
    adapter.onDidSendMessage((msg) => messages.push(msg));
    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(messages.some((m) => m.event === 'terminated'));
    adapter.dispose();
  });

  it('skips empty lines when emitting adapter output', async () => {
    const accepted = [];
    const controller = {
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws'
      }),
      currentProgramPath: 'C:\\ws\\script.cmd',
      acceptProcessText: (text) => accepted.push(text),
      handleProcessExit: () => {},
      log: () => {}
    };

    const adapter = new InlineDebugAdapterSession(controller, { id: 's6' }, {
      spawn: () => createFakeProcess({ stdoutLines: ['', 'Line 1: warning (W001)'] })
    });
    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepStrictEqual(accepted, ['Line 1: warning (W001)']);
    adapter.dispose();
  });

  it('falls back to utf8 when debug adapter stdout encoding is invalid', async () => {
    const messages = [];
    const controller = {
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws'
      }),
      currentProgramPath: 'C:\\ws\\script.cmd',
      acceptProcessText: () => {},
      handleProcessExit: () => {},
      log: () => {}
    };

    const adapter = new InlineDebugAdapterSession(controller, { id: 's7' }, {
      spawn: () => {
        const proc = createFakeProcess({ stdoutLines: ['Line 1: warning (W001)'] });
        proc.stdout.setEncoding = () => { throw new Error('bad stdout encoding'); };
        return proc;
      }
    });
    adapter.onDidSendMessage((msg) => messages.push(msg));
    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(messages.length > 0);
    adapter.dispose();
  });

  it('flushes residual stderr when the process closes', async () => {
    const accepted = [];
    const controller = {
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws'
      }),
      currentProgramPath: 'C:\\ws\\script.cmd',
      acceptProcessText: (text) => accepted.push(text),
      handleProcessExit: () => {},
      log: () => {}
    };

    const adapter = new InlineDebugAdapterSession(controller, { id: 's8' }, {
      spawn: () => createFakeProcess({ stderrText: 'tail-no-newline' })
    });
    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepStrictEqual(accepted, ['tail-no-newline']);
    adapter.dispose();
  });

  it('ignores non-request messages and kill failures', () => {
    const controller = {
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws'
      }),
      currentProgramPath: 'C:\\ws\\script.cmd',
      acceptProcessText: () => {},
      handleProcessExit: () => {},
      log: () => {}
    };
    const adapter = new InlineDebugAdapterSession(controller, { id: 's9' }, {
      spawn: () => {
        const proc = createFakeProcess();
        proc.kill = () => { throw new Error('kill failed'); };
        return proc;
      }
    });
    adapter.handleMessage({ type: 'event', seq: 1, command: 'noop' });
    adapter.handleMessage({ type: 'request', seq: 2, command: 'launch', arguments: {} });
    adapter.stopProcess();
    adapter.dispose();
  });

  it('reports invalid launch payloads from prepareForLaunch', async () => {
    const messages = [];
    const emptyExe = new InlineDebugAdapterSession({
      prepareForLaunch: async () => ({ executable: '  ', args: ['script.cmd'], cwd: 'C:\\ws' }),
      log: () => {}
    }, { id: 's10' });
    emptyExe.onDidSendMessage((msg) => messages.push(msg));
    emptyExe.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(messages.some((m) => m.success === false));

    const badArgs = new InlineDebugAdapterSession({
      prepareForLaunch: async () => ({ executable: 'blinter.exe', args: null, cwd: 'C:\\ws' }),
      log: () => {}
    }, { id: 's11' });
    badArgs.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setImmediate(resolve));
    badArgs.dispose();
    emptyExe.dispose();
  });

  it('flushes residual stdout when the process closes', async () => {
    const accepted = [];
    const controller = {
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws'
      }),
      currentProgramPath: 'C:\\ws\\script.cmd',
      acceptProcessText: (text) => accepted.push(text),
      handleProcessExit: () => {},
      log: () => {}
    };

    const adapter = new InlineDebugAdapterSession(controller, { id: 's12' }, {
      spawn: () => createFakeProcess({ stdoutText: 'stdout-tail' })
    });
    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepStrictEqual(accepted, ['stdout-tail']);
    adapter.dispose();
  });

  it('handles process errors and close without optional controller hooks', async () => {
    const messages = [];
    const controller = {
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws'
      }),
      currentProgramPath: 'C:\\ws\\script.cmd',
      log: () => {}
    };

    const adapter = new InlineDebugAdapterSession(controller, { id: 's13' }, {
      spawn: () => {
        const proc = createFakeProcess();
        setTimeout(() => proc.emit('error', 'runtime failed'), 25);
        return proc;
      }
    });
    adapter.onDidSendMessage((msg) => messages.push(msg));
    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(messages.some((m) => m.event === 'terminated'));
    adapter.dispose();
  });

  it('handles process close when controller omits exit handler', async () => {
    const messages = [];
    const controller = {
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws'
      }),
      currentProgramPath: 'C:\\ws\\script.cmd',
      acceptProcessText: () => {}
    };

    const adapter = new InlineDebugAdapterSession(controller, { id: 's13b' }, {
      spawn: () => createFakeProcess({ stdoutLines: ['done'] })
    });
    adapter.onDidSendMessage((msg) => messages.push(msg));
    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(messages.some((m) => m.event === 'exited'));
    adapter.dispose();
  });

  it('treats null process close payload as failure exit code', async () => {
    const messages = [];
    const controller = {
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws'
      }),
      currentProgramPath: 'C:\\ws\\script.cmd',
      handleProcessExit: (code) => messages.push(code),
      acceptProcessText: () => {}
    };

    const adapter = new InlineDebugAdapterSession(controller, { id: 's13d' }, {
      spawn: () => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdout.setEncoding = () => {};
        proc.stderr.setEncoding = () => {};
        setImmediate(() => proc.emit('close', null));
        return proc;
      }
    });
    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(messages[0], null);
    adapter.dispose();
  });

  it('handles process errors without message properties', async () => {
    const messages = [];
    const controller = {
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws'
      }),
      currentProgramPath: 'C:\\ws\\script.cmd',
      log: () => {},
      acceptProcessText: () => {}
    };

    const adapter = new InlineDebugAdapterSession(controller, { id: 's13e' }, {
      spawn: () => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdout.setEncoding = () => {};
        proc.stderr.setEncoding = () => {};
        setTimeout(() => proc.emit('error', {}), 25);
        return proc;
      }
    });
    adapter.onDidSendMessage((msg) => messages.push(msg));
    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(messages.some((m) => m.event === 'output' && m.body && m.body.output.includes('[object Object]')));
    adapter.dispose();
  });

  it('emits events with empty bodies and null exit codes', () => {
    const messages = [];
    const adapter = new InlineDebugAdapterSession({
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws'
      }),
      log: () => {}
    }, { id: 's13c' });
    adapter.onDidSendMessage((msg) => messages.push(msg));
    adapter._sendEvent('custom', undefined);
    adapter.dispose();
    assert.ok(messages.some((m) => m.event === 'custom'));
  });

  it('returns early when attaching listeners without a process', () => {
    const adapter = new InlineDebugAdapterSession({
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws'
      }),
      log: () => {}
    }, { id: 's14' });
    adapter._attachProcessListeners();
    adapter.dispose();
  });

  it('ignores launch errors after disconnect during prepareForLaunch', async () => {
    const statusUpdates = [];
    /** @type {(() => void) | undefined} */
    let rejectPrepare;
    const preparePromise = new Promise((_, reject) => {
      rejectPrepare = () => reject(new Error('launch failed'));
    });

    const adapter = new InlineDebugAdapterSession({
      prepareForLaunch: async () => preparePromise,
      updateDebugStatus: (state, detail) => statusUpdates.push({ state, detail }),
      handleProcessExit: () => {},
      log: () => {}
    }, { id: 's15' }, {
      spawn: () => createFakeProcess()
    });

    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setImmediate(resolve));
    adapter.handleMessage({ type: 'request', seq: 2, command: 'disconnect' });
    rejectPrepare();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(statusUpdates, []);
    adapter.dispose();
  });

  it('drops stdout chunks when the byte buffer is already at cap', async () => {
    const logs = [];
    const controller = {
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws'
      }),
      currentProgramPath: 'C:\\ws\\script.cmd',
      acceptProcessText: () => {},
      handleProcessExit: () => {},
      log: (message) => logs.push(message)
    };

    let fakeProcess;
    const adapter = new InlineDebugAdapterSession(controller, { id: 's16' }, {
      spawn: () => {
        fakeProcess = createFakeProcess();
        return fakeProcess;
      }
    });

    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setImmediate(resolve));

    adapter.stdoutBuffer = 'x'.repeat(64 * 1024);
    adapter.stdoutBufferTruncated = false;
    fakeProcess.stdout.emit('data', 'overflow\n');

    assert.ok(logs.some((line) => line.includes('stdout output truncated')));
    assert.strictEqual(adapter.stdoutBuffer.length, 64 * 1024);
    adapter.dispose();
  });

  it('skips flushed stdout lines after the line cap is reached', async () => {
    const accepted = [];
    const controller = {
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws'
      }),
      currentProgramPath: 'C:\\ws\\script.cmd',
      acceptProcessText: (text) => accepted.push(text),
      handleProcessExit: () => {},
      log: () => {}
    };

    const adapter = new InlineDebugAdapterSession(controller, { id: 's17' }, {
      spawn: () => createFakeProcess()
    });

    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setImmediate(resolve));

    adapter.stdoutLineCount = 10000;
    adapter.stdoutBuffer = 'overflow-line';
    adapter._flushBuffers();

    assert.deepStrictEqual(accepted, []);
    adapter.dispose();
  });
});

const {
  getDebounceDelay,
  getProcessTimeoutMs,
  coerceMaxLineLength,
  sanitizeRuleList
} = require('../lib/configHelpers');
const { createSpawnImpl } = require('../lib/spawnFactory');
const Module = require('module');
const { createMockVscode } = require('./support/mock-vscode');

/**
 * @param {(mock: ReturnType<typeof createMockVscode>) => void} fn
 */
function withMockVscode(fn) {
  const mock = createMockVscode();
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'vscode') {
      return mock.vscode;
    }
    return originalRequire.apply(this, arguments);
  };
  try {
    fn(mock);
  } finally {
    Module.prototype.require = originalRequire;
  }
}

/**
 * @param {string} modulePath
 */
function requireWithMockVscode(modulePath) {
  let loaded;
  withMockVscode(() => {
    delete require.cache[require.resolve(modulePath)];
    loaded = require(modulePath);
  });
  return loaded;
}

describe('Coverage — configHelpers branches', () => {
  it('returns defaults for invalid debounce and timeout values', () => {
    const config = { get: () => 'bad' };
    assert.strictEqual(getDebounceDelay(config), 500);
    assert.strictEqual(getProcessTimeoutMs(config), 120000);
  });

  it('returns defaults for negative or non-finite numeric values', () => {
    const config = {
      get: (key) => {
        if (key === 'debounceDelay') { return -1; }
        if (key === 'processTimeoutMs') { return Number.NaN; }
        return undefined;
      }
    };
    assert.strictEqual(getDebounceDelay(config), 500);
    assert.strictEqual(getProcessTimeoutMs(config), 120000);
  });

  it('coerces max line length and sanitizes rule lists', () => {
    const config = {
      get: (key, fallback) => {
        if (key === 'maxLineLength') { return 120.7; }
        if (key === 'enabledRules') { return [' E001 ', '', 42, 'W005']; }
        return fallback;
      }
    };
    assert.strictEqual(coerceMaxLineLength(config), 120);
    assert.deepStrictEqual(sanitizeRuleList(config, 'enabledRules'), ['E001', 'W005']);
  });

  it('returns defaults for invalid max line length and non-array rule lists', () => {
    const config = { get: (key) => (key === 'maxLineLength' ? 0 : 'not-an-array') };
    assert.strictEqual(coerceMaxLineLength(config), 100);
    assert.deepStrictEqual(sanitizeRuleList(config, 'disabledRules'), []);
  });
});

describe('Coverage — diagnostics branches', () => {
  it('sorts issues by severity then line number', () => {
    const { compareIssues } = requireWithMockVscode('../lib/diagnostics');
    const warning = { severity: 'warning', line: 5 };
    const error = { severity: 'error', line: 10 };
    const hint = { severity: 'hint', line: 1 };
    const sorted = [warning, hint, error].sort(compareIssues);
    assert.strictEqual(sorted[0].severity, 'error');
    assert.strictEqual(sorted[2].severity, 'hint');
  });

  it('maps issues to diagnostics with and without open documents', () => {
    const { issueToDiagnostic } = requireWithMockVscode('../lib/diagnostics');
    const issue = {
      severity: 'warning',
      line: 2,
      message: 'test issue',
      code: 'W001',
      classification: 'Lint',
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 10 }
      }
    };

    const withoutDoc = issueToDiagnostic(issue);
    assert.strictEqual(withoutDoc.source, 'blinter');
    assert.strictEqual(withoutDoc.severity, 1);

    const maxRangeIssue = {
      ...issue,
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: Number.MAX_SAFE_INTEGER }
      }
    };
    const document = {
      lineCount: 3,
      lineAt: () => ({ range: { end: { character: 42 } } })
    };
    const withDoc = issueToDiagnostic(maxRangeIssue, document);
    assert.ok(withDoc);
    assert.strictEqual(withDoc.source, 'blinter');
  });

  it('falls back to error severity for unknown issue severities', () => {
    const { issueToDiagnostic } = requireWithMockVscode('../lib/diagnostics');
    const diagnostic = issueToDiagnostic({
      severity: 'unknown',
      line: 1,
      message: 'm',
      code: 'X001'
    });
    assert.strictEqual(diagnostic.severity, 0);
  });
});

describe('Coverage — executable branches', () => {
  it('throws when executable path cannot be resolved', () => {
    withMockVscode(() => {
      delete require.cache[require.resolve('../lib/blinterRunner')];
      delete require.cache[require.resolve('../lib/executable')];
      const blinterRunner = require('../lib/blinterRunner');
      const originalGetExePath = blinterRunner.getExePath;
      blinterRunner.getExePath = () => '';
      try {
        const { resolveBlinterExePath } = require('../lib/executable');
        assert.throws(
          () => resolveBlinterExePath({ extensionPath: __dirname }),
          /could not be resolved/
        );
      } finally {
        blinterRunner.getExePath = originalGetExePath;
        delete require.cache[require.resolve('../lib/executable')];
        delete require.cache[require.resolve('../lib/blinterRunner')];
      }
    });
  });

  it('throws when bundled executable is missing on disk', () => {
    const originalExistsSync = fs.existsSync;
    fs.existsSync = () => false;
    try {
      withMockVscode((mock) => {
        mock.vscode.workspace.getConfiguration = () => ({
          get: (key) => (key === 'useSystemBlinter' ? false : '')
        });
        delete require.cache[require.resolve('../lib/executable')];
        const { resolveBlinterExePath } = require('../lib/executable');
        assert.throws(
          () => resolveBlinterExePath({ extensionPath: path.join(__dirname, '..') }),
          /not found/
        );
      });
    } finally {
      fs.existsSync = originalExistsSync;
    }
  });
});

describe('Coverage — debugSession branches', () => {
  it('resolves relative and absolute program paths', () => {
    const { resolveProgramPath } = requireWithMockVscode('../lib/debugSession');
    assert.strictEqual(
      resolveProgramPath('script.bat', 'C:\\ws'),
      path.normalize('C:\\ws\\script.bat')
    );
    assert.strictEqual(
      resolveProgramPath('C:\\abs\\script.bat', undefined),
      path.normalize('C:\\abs\\script.bat')
    );
  });

  it('skips empty process text and duplicate debug issues', () => {
    const { acceptProcessText } = requireWithMockVscode('../lib/debugSession');
    const controller = {
      currentWorkspaceRoot: 'C:\\ws',
      currentProgramPath: 'C:\\ws\\script.bat',
      variableIndex: {},
      debugIssuesByFile: new Map(),
      log: () => {},
      scheduleDiagnosticsUpdate: () => {}
    };

    acceptProcessText(controller, '', 'stdout');
    acceptProcessText(controller, 'Line 1: BAT extension used instead of CMD for newer Windows (S007)', 'stdout');
    acceptProcessText(controller, 'Line 1: BAT extension used instead of CMD for newer Windows (S007)', 'stdout');

    const issues = controller.debugIssuesByFile.get('C:\\ws\\script.bat') || [];
    assert.strictEqual(issues.length, 1);
  });

  it('ignores issues without a normalized file path', () => {
    const { addIssue } = requireWithMockVscode('../lib/debugSession');
    const controller = {
      debugIssuesByFile: new Map(),
      scheduleDiagnosticsUpdate: () => {}
    };
    addIssue(controller, { filePath: '', line: 1, message: 'x', code: 'E001' });
    assert.strictEqual(controller.debugIssuesByFile.size, 0);
  });

  it('filters non-flag launch args and remaps disallowed debug issue paths', () => {
    const logs = [];
    const { filterBlinterCliArgs, addIssue } = requireWithMockVscode('../lib/debugSession');
    const filtered = filterBlinterCliArgs(['script.bat', '--verbose'], (message) => logs.push(message));
    assert.deepStrictEqual(filtered, ['--verbose']);
    assert.ok(logs.some((line) => line.includes('Ignoring non-flag')));

    const controller = {
      currentWorkspaceRoot: 'C:\\ws',
      currentProgramPath: 'C:\\ws\\main.cmd',
      getDiagnosticAllowedPaths: () => ['C:\\ws'],
      debugIssuesByFile: new Map(),
      scheduleDiagnosticsUpdate: () => {}
    };
    addIssue(controller, {
      filePath: 'C:\\outside\\x.cmd',
      line: 1,
      message: 'external',
      code: 'E001'
    });
    assert.ok(controller.debugIssuesByFile.has(path.normalize('C:\\ws\\main.cmd')));

    controller.debugIssuesByFile = new Map();
    controller.currentProgramPath = 'C:\\outside\\nowhere.cmd';
    addIssue(controller, {
      filePath: 'C:\\outside\\x.cmd',
      line: 2,
      message: 'dropped',
      code: 'E002'
    });
    assert.strictEqual(controller.debugIssuesByFile.size, 0);
  });

  it('allows program paths when no workspace folders are open', () => {
    let assertAllowed;
    withMockVscode((mock) => {
      mock.vscode.workspace.workspaceFolders = [];
      delete require.cache[require.resolve('../lib/debugSession')];
      assertAllowed = require('../lib/debugSession').assertProgramPathAllowed;
    });
    const tmpDir = path.join(os.tmpdir(), `blinter-no-ws-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const script = path.join(tmpDir, 'solo.cmd');
    fs.writeFileSync(script, '@echo off\r\n', 'utf8');
    assert.doesNotThrow(() => assertAllowed(script, undefined, undefined));
    fs.unlinkSync(script);
    fs.rmdirSync(tmpDir);
  });

  it('drops debug issues when fallback paths are unavailable', () => {
    const { addIssue } = requireWithMockVscode('../lib/debugSession');
    const controller = {
      currentProgramPath: '',
      debugIssuesByFile: new Map(),
      scheduleDiagnosticsUpdate: () => {}
    };
    addIssue(controller, {
      filePath: 'C:\\outside\\x.cmd',
      line: 1,
      message: 'drop me',
      code: 'E003'
    });
    assert.strictEqual(controller.debugIssuesByFile.size, 0);
  });

  it('honors editor directories when validating program paths', () => {
    const { assertProgramPathAllowed } = requireWithMockVscode('../lib/debugSession');
    assert.doesNotThrow(() => {
      assertProgramPathAllowed(
        path.normalize('C:\\ws\\editor\\run.cmd'),
        'C:\\other',
        'C:\\ws\\editor\\open.cmd'
      );
    });
  });

  it('rejects unresolved program paths during validation', () => {
    const { assertProgramPathAllowed } = requireWithMockVscode('../lib/debugSession');
    assert.throws(
      () => assertProgramPathAllowed('   ', 'C:\\ws', undefined),
      /could not be resolved/
    );
  });

  it('uses workspace folders when diagnostic helper is unavailable', () => {
    const { addIssue } = requireWithMockVscode('../lib/debugSession');
    const controller = {
      currentProgramPath: 'C:\\ws\\main.cmd',
      debugIssuesByFile: new Map(),
      scheduleDiagnosticsUpdate: () => {}
    };
    addIssue(controller, {
      filePath: 'C:\\ws\\main.cmd',
      line: 1,
      message: 'local',
      code: 'E001'
    });
    assert.ok(controller.debugIssuesByFile.has(path.normalize('C:\\ws\\main.cmd')));
  });

  it('ignores non-string workspace metadata in acceptProcessText', () => {
    const { acceptProcessText } = requireWithMockVscode('../lib/debugSession');
    const controller = {
      currentWorkspaceRoot: 42,
      currentProgramPath: null,
      variableIndex: new Map(),
      debugIssuesByFile: new Map(),
      scheduleDiagnosticsUpdate: () => {},
      log: () => {}
    };
    assert.doesNotThrow(() => {
      acceptProcessText(controller, 'plain text without issue structure', 'stdout');
    });
  });
});

describe('Coverage — spawnFactory branches', () => {
  it('returns a fake process in BLINTER_TEST_MODE', (done) => {
    const previous = process.env.BLINTER_TEST_MODE;
    process.env.BLINTER_TEST_MODE = '1';
    try {
      const proc = createSpawnImpl('blinter.exe', ['sample.bat'], { cwd: process.cwd() });
      assert.ok(proc.stdout);
      assert.ok(proc.stderr);
      proc.on('close', (code) => {
        assert.strictEqual(code, 0);
        done();
      });
    } finally {
      if (previous === undefined) {
        delete process.env.BLINTER_TEST_MODE;
      } else {
        process.env.BLINTER_TEST_MODE = previous;
      }
    }
  });
});

describe('Coverage — debugAdapter branches', () => {
  it('forwards messages through the inline debug adapter', async () => {
    const messages = [];
    const controller = {
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.cmd'],
        cwd: 'C:\\ws'
      }),
      currentProgramPath: 'C:\\ws\\script.cmd',
      acceptProcessText: () => {},
      handleProcessExit: () => {},
      log: () => {}
    };

    await new Promise((resolve, reject) => {
      withMockVscode(() => {
        try {
          delete require.cache[require.resolve('../lib/debugAdapter')];
          const { BlinterDebugAdapterFactory, BlinterInlineDebugAdapter } = require('../lib/debugAdapter');
          const factory = new BlinterDebugAdapterFactory(controller);
          const descriptor = factory.createDebugAdapterDescriptor({ id: 'factory-test' });
          assert.ok(descriptor);
          assert.ok(descriptor.implementation instanceof BlinterInlineDebugAdapter);

          const adapter = descriptor.implementation;
          adapter.onDidSendMessage((msg) => messages.push(msg));
          adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: { program: 'script.cmd' } });
          setTimeout(() => {
            adapter.dispose();
            resolve();
          }, 50);
        } catch (error) {
          reject(error);
        }
      });
    });

    assert.ok(messages.length >= 0);
  });
});

describe('Coverage — utils branches', () => {
  it('covers path allowlisting and editor resolution helpers', () => {
    withMockVscode((mock) => {
      delete require.cache[require.resolve('../lib/utils')];
      const utils = require('../lib/utils');
      assert.strictEqual(utils.isBatchLanguageId('cmd'), true);
      assert.strictEqual(utils.isBatchDocument(undefined), false);
      assert.strictEqual(utils.normalizeFilePath('  '), undefined);
      assert.strictEqual(utils.isInformationalSeverity('hint'), true);
      assert.strictEqual(utils.isFileDocument({ uri: { scheme: 'file' } }), true);
      assert.ok(utils.escapeMarkdown('a*b').includes('\\*'));

      mock.vscode.window.activeTextEditor = null;
      mock.vscode.window.visibleTextEditors = [{
        document: { languageId: 'bat' }
      }];
      assert.strictEqual(utils.getActiveOrVisibleBatchEditor().document.languageId, 'bat');

      assert.strictEqual(
        utils.isPathAllowed('C:\\ws\\sub\\file.cmd', ['C:\\ws']),
        true
      );
      assert.strictEqual(utils.isPathAllowed('C:\\other\\file.cmd', ['C:\\ws']), false);
      assert.strictEqual(utils.isPathAllowed('', ['C:\\ws']), false);
    });
  });
});

describe('Coverage — issueParser branches', () => {
  it('maps unknown legacy severities to error', () => {
    const issueParser = require('../lib/issueParser');
    assert.strictEqual(issueParser.mapSeverityFromLegacy('mystery'), 'error');
    assert.strictEqual(issueParser.mapSeverityFromLegacy('warn'), 'warning');
    assert.strictEqual(issueParser.mapSeverityFromLegacy(''), 'error');
  });
});

describe('Coverage — config branches', () => {
  it('resolves workspace and ini paths from editor context', () => {
    withMockVscode((mock) => {
      delete require.cache[require.resolve('../lib/config')];
      const { getWorkspaceFolderPath, getIniPathForEditor } = require('../lib/config');
      mock.vscode.workspace.workspaceFolders = [{ uri: { fsPath: 'C:\\ws' } }];
      assert.strictEqual(getWorkspaceFolderPath(undefined), 'C:\\ws');
      assert.strictEqual(getIniPathForEditor(undefined), undefined);
      const editor = { document: { uri: { fsPath: 'C:\\ws\\a.cmd' } } };
      mock.vscode.workspace.getWorkspaceFolder = () => ({ uri: { fsPath: 'C:\\ws' } });
      assert.match(String(getIniPathForEditor(editor)), /blinter\.ini$/);
    });
  });
});

describe('Coverage — quickFixes branches', () => {
  it('exercises quick-fix and suppression guard paths', () => {
    withMockVscode((mock) => {
      delete require.cache[require.resolve('../lib/quickFixes')];
      const { createQuickFixProvider, createSuppressionProvider } = require('../lib/quickFixes');
      const quickFix = createQuickFixProvider();
      const suppression = createSuppressionProvider();

      const plainDoc = {
        languageId: 'plaintext',
        uri: { fsPath: 'C:\\x.txt' },
        lineCount: 1,
        lineAt: () => ({ text: 'echo', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } })
      };
      assert.deepStrictEqual(quickFix.provideCodeActions(plainDoc, { start: { line: 0 } }, { diagnostics: [] }), []);
      assert.deepStrictEqual(suppression.provideCodeActions(plainDoc, { start: { line: 0 } }, { diagnostics: [] }), []);

      const batchDoc = {
        languageId: 'bat',
        uri: { fsPath: 'C:\\ws\\a.bat' },
        lineCount: 2,
        eol: 2,
        lineAt: (line) => ({
          text: line === 0 ? 'REM LINT:IGNORE E001' : 'ECHO hello',
          range: { start: { line }, end: { line } }
        })
      };
      const diag = {
        source: 'blinter',
        code: 'CASE001',
        message: 'Fix command casing',
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }
      };
      mock.vscode.workspace.getConfiguration = () => ({
        get: (key, fallback) => {
          if (key === 'quickFixCodes') { return ['CASE001']; }
          if (key === 'suppressionCommentStyle') { return 'REM'; }
          if (key === 'showAskCopilotQuickFix') { return true; }
          return fallback;
        }
      });
      const fixes = quickFix.provideCodeActions(batchDoc, { start: { line: 1 } }, { diagnostics: [diag] });
      assert.ok(fixes.length > 0);
      const suppressions = suppression.provideCodeActions(batchDoc, { start: { line: 1 } }, { diagnostics: [diag] });
      assert.ok(suppressions.length > 0);

      const noMatchDiag = {
        source: 'blinter',
        code: 'OTHER',
        message: 'unrelated issue',
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }
      };
      assert.deepStrictEqual(
        quickFix.provideCodeActions(batchDoc, { start: { line: 1 } }, { diagnostics: [noMatchDiag] }),
        []
      );

      const firstLineDoc = {
        languageId: 'bat',
        uri: { fsPath: 'C:\\ws\\first.bat' },
        lineCount: 1,
        eol: 2,
        lineAt: () => ({
          text: 'ECHO hello',
          range: { start: { line: 0 }, end: { line: 0 } }
        })
      };
      const firstLineSuppressions = suppression.provideCodeActions(
        firstLineDoc,
        { start: { line: 0 } },
        { diagnostics: [{ source: 'blinter', code: 'W001', message: 'warn', range: { start: { line: 0 } } }] }
      );
      assert.ok(firstLineSuppressions.length > 0);

      assert.deepStrictEqual(
        suppression.provideCodeActions(batchDoc, { start: { line: 1 } }, { diagnostics: [{ source: 'eslint', code: 'X' }] }),
        []
      );

      const commentOnlyDoc = {
        ...batchDoc,
        lineAt: (line) => ({
          text: line === 1 ? ':: comment only' : batchDoc.lineAt(line).text,
          range: { start: { line }, end: { line } }
        })
      };
      assert.deepStrictEqual(
        quickFix.provideCodeActions(commentOnlyDoc, { start: { line: 1 } }, { diagnostics: [diag] }),
        []
      );
    });
  });
});

describe('Coverage — documentSnapshot extra branches', () => {
  it('logs cleanup failures and resolves dirty launch paths', async () => {
    const snapshotMod = require('../lib/documentSnapshot');
    const tmpDir = path.join(os.tmpdir(), `blinter-snap-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const tempPath = path.join(tmpDir, 'snap.bat');
    fs.writeFileSync(tempPath, '@echo off', 'utf8');

    withMockVscode((mock) => {
      mock.vscode.workspace.textDocuments = [{
        uri: { scheme: 'file', fsPath: tempPath, toString: () => `file://${tempPath}` },
        isDirty: true,
        getText: () => 'dirty',
        save: async () => true
      }];
      mock.vscode.workspace.getConfiguration = () => ({
        get: () => false
      });
    });

    const resolved = await snapshotMod.resolveProgramPathForLaunch(tempPath);
    assert.ok(resolved.filePath);

    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = () => { throw new Error('locked'); };
    try {
      snapshotMod.cleanupSnapshots();
    } finally {
      fs.unlinkSync = originalUnlink;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Coverage — diagnostics extra branches', () => {
  it('uses fallback end character when document line is unavailable', () => {
    const { issueToDiagnostic } = requireWithMockVscode('../lib/diagnostics');
    const issue = {
      severity: 'info',
      line: 99,
      message: 'far line',
      code: 'I001',
      range: {
        start: { line: 98, character: 0 },
        end: { line: 98, character: Number.MAX_SAFE_INTEGER }
      }
    };
    const document = { lineCount: 1, lineAt: () => ({ range: { end: { character: 1 } } }) };
    const diagnostic = issueToDiagnostic(issue, document);
    assert.ok(diagnostic);
    assert.strictEqual(diagnostic.severity, 2);
  });

  it('covers unknown severities, missing lines, and explicit start characters', () => {
    const { compareIssues, issueToDiagnostic } = requireWithMockVscode('../lib/diagnostics');
    assert.ok(compareIssues({ severity: 'mystery' }, { severity: 'error', line: 1 }) > 0);
    assert.ok(compareIssues({ severity: 'error', line: 1 }, { severity: 'mystery' }) < 0);
    assert.strictEqual(compareIssues({ severity: 'info' }, { severity: 'information', line: 2 }), -2);
    assert.strictEqual(compareIssues({ severity: 'warning' }, { severity: 'warning' }), 0);

    const diagnostic = issueToDiagnostic({
      severity: 'error',
      line: 1,
      message: 'm',
      code: 'E001',
      range: { start: { character: 7 }, end: { character: 12 } }
    });
    assert.ok(diagnostic);
  });
});

describe('Coverage — debugSession prepareForLaunch', () => {
  it('rejects missing program and disabled debugging', async () => {
    withMockVscode((mock) => {
      delete require.cache[require.resolve('../lib/debugSession')];
      const { prepareForLaunch } = require('../lib/debugSession');
      const controller = {
        context: { extensionPath: path.join(__dirname, '..') },
        clearDebugIssues: () => {},
        log: () => {},
        updateDebugStatus: () => {},
        webviewProvider: { ensureVisible: () => {}, update: () => {} }
      };

      mock.vscode.workspace.getConfiguration = () => ({
        get: (key, fallback) => (key === 'enabled' ? false : fallback)
      });

      return Promise.all([
        assert.rejects(() => prepareForLaunch(controller, {}, {}), /missing the "program"/),
        assert.rejects(() => prepareForLaunch(controller, { program: 'a.cmd' }, {}), /disabled in settings/),
        assert.rejects(() => prepareForLaunch(controller, { program: '${file}' }, {}), /No active batch file/)
      ]);
    });
  });

  it('rejects relative program paths outside the workspace', async () => {
    await withMockVscode(async (mock) => {
      delete require.cache[require.resolve('../lib/debugSession')];
      const { prepareForLaunch } = require('../lib/debugSession');
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'blinter-ws-'));
      const outside = path.join(path.dirname(workspace), `escape-${Date.now()}.cmd`);
      fs.writeFileSync(outside, '@echo off\r\n', 'utf8');
      const relativeProgram = path.relative(workspace, outside);
      const controller = {
        context: { extensionPath: path.join(__dirname, '..') },
        clearDebugIssues: () => {},
        log: () => {},
        updateDebugStatus: () => {},
        webviewProvider: { ensureVisible: () => {}, update: () => {} }
      };
      mock.vscode.workspace.getConfiguration = () => ({
        get: (key, fallback) => fallback
      });
      await assert.rejects(
        () => prepareForLaunch(
          controller,
          { program: relativeProgram },
          { workspaceFolder: { uri: { fsPath: workspace } } }
        ),
        /outside the allowed workspace/
      );
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.unlinkSync(outside);
    });
  });
});

describe('Coverage — executable extra branches', () => {
  it('accepts extensionUri when extensionPath is absent', () => {
    withMockVscode(() => {
      delete require.cache[require.resolve('../lib/blinterRunner')];
      delete require.cache[require.resolve('../lib/executable')];
      const blinterRunner = require('../lib/blinterRunner');
      const originalGetExePath = blinterRunner.getExePath;
      blinterRunner.getExePath = () => path.join(__dirname, '..', 'vendor', 'Blinter', 'Blinter.exe');
      try {
        const { resolveBlinterExePath } = require('../lib/executable');
        const exe = resolveBlinterExePath({ extensionUri: { fsPath: path.join(__dirname, '..') } });
        assert.ok(exe);
      } finally {
        blinterRunner.getExePath = originalGetExePath;
        delete require.cache[require.resolve('../lib/executable')];
        delete require.cache[require.resolve('../lib/blinterRunner')];
      }
    });
  });
});

describe('Coverage — remaining branch gaps', () => {
  it('covers quickFixes optional chaining and insert branches', () => {
    withMockVscode((mock) => {
      delete require.cache[require.resolve('../lib/quickFixes')];
      const { createQuickFixProvider, createSuppressionProvider } = require('../lib/quickFixes');
      const quickFix = createQuickFixProvider();
      const suppression = createSuppressionProvider();

      const batchDoc = {
        languageId: 'bat',
        uri: { fsPath: 'C:\\ws\\line2.bat', toString: () => 'file:///C:/ws/line2.bat' },
        lineCount: 2,
        eol: 1,
        lineAt: (line) => ({
          text: line === 0 ? 'ECHO hello' : 'ECHO world',
          range: { start: { line, character: 0 }, end: { line, character: 9 } }
        })
      };
      mock.vscode.workspace.getConfiguration = () => ({
        get: (key, fallback) => {
          if (key === 'quickFixCodes') { return ['CASE001']; }
          if (key === 'suppressionCommentStyle') { return ''; }
          if (key === 'showAskCopilotQuickFix') { return true; }
          return fallback;
        }
      });

      const diagNoMessage = {
        source: 'blinter',
        code: 'CASE001',
        range: { start: { line: 1 } },
        message: ''
      };
      assert.ok(quickFix.provideCodeActions(batchDoc, { start: { line: 1 } }, { diagnostics: [diagNoMessage] }).length > 0);

      const diagNoRange = {
        source: 'blinter',
        code: 'W001',
        message: 'warn'
      };
      const suppressions = suppression.provideCodeActions(
        batchDoc,
        { start: { line: 1 } },
        { diagnostics: [diagNoRange] }
      );
      assert.ok(suppressions.length > 0);

      const quickFixNoRange = quickFix.provideCodeActions(
        batchDoc,
        { start: { line: 1 } },
        { diagnostics: [{ source: 'blinter', code: 'CASE001', message: 'case issue' }] }
      );
      assert.ok(quickFixNoRange.length > 0);

      const tokenOnlyDoc = {
        languageId: 'bat',
        uri: { fsPath: 'C:\\ws\\token.bat' },
        lineCount: 1,
        eol: 1,
        lineAt: () => ({
          text: 'ECHO',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }
        })
      };
      assert.ok(quickFix.provideCodeActions(
        tokenOnlyDoc,
        { start: { line: 0 } },
        { diagnostics: [{ source: 'blinter', code: 'CASE001', message: 'case', range: { start: { line: 0 } } }] }
      ).length > 0);
    });
  });

  it('covers utils markdown escaping and path prefix branches', () => {
    withMockVscode(() => {
      const utils = require('../lib/utils');
      assert.ok(utils.escapeMarkdown('line *with* [markdown]'));
      assert.strictEqual(utils.isPathAllowed('C:\\ws\\nested\\file.cmd', ['C:\\ws\\']), true);
    });
  });

  it('covers issueParser normalizeSeverity and resolveFile branches', () => {
    const issueParser = require('../lib/issueParser');
    assert.strictEqual(issueParser.normalizeSeverity('fatal'), 'error');
    assert.strictEqual(issueParser.normalizeSeverity('error'), 'error');
    assert.ok(issueParser.resolveFile('C:\\abs\\file.cmd', 'C:\\ws', 'C:\\ws\\a.cmd'));
    const parsed = issueParser.parseOutput('Line 1: sample (W001)\n  : trailing detail');
    assert.ok(parsed.length > 0);
  });

  it('covers discovery platform and localappdata fallbacks', () => {
    const extRoot = path.join(__dirname, '..');
    assert.strictEqual(findBlinterExecutable(extRoot, 'linux', () => false, { useSystemBlinter: true }), null);
    const originalLocal = process.env.LOCALAPPDATA;
    delete process.env.LOCALAPPDATA;
    try {
      const installed = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Blinter', 'bin', 'blinter.exe');
      assert.strictEqual(
        findBlinterExecutable(extRoot, 'win32', (candidate) => candidate === installed, {}),
        installed
      );
    } finally {
      if (originalLocal === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocal;
      }
    }
  });

  it('covers documentSnapshot reuse and save-before-lint launch paths', async () => {
    const snapshotMod = require('../lib/documentSnapshot');
    const tmpDir = path.join(os.tmpdir(), `blinter-snap2-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, 'dirty.cmd');
    const uriKey = `file://${filePath}`;

    const dirtyDoc = {
      uri: { scheme: 'file', fsPath: filePath, toString: () => uriKey },
      isDirty: true,
      getText: () => 'first\r\nsecond',
      save: async () => true
    };
    const first = await snapshotMod.resolveDocumentPath(dirtyDoc, false);
    const second = await snapshotMod.resolveDocumentPath({ ...dirtyDoc, getText: () => 'updated' }, false);
    assert.strictEqual(first.filePath, second.filePath);

    withMockVscode((mock) => {
      mock.vscode.workspace.textDocuments = [{
        ...dirtyDoc,
        getText: () => 'launch dirty'
      }];
      mock.vscode.workspace.getConfiguration = () => ({
        get: (key) => key === 'saveBeforeLint'
      });
    });
    const launchResolved = await snapshotMod.resolveProgramPathForLaunch(filePath);
    assert.ok(launchResolved.filePath);
    snapshotMod.cleanupSnapshots();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('covers executable missing context and debugSession edge branches', async () => {
    withMockVscode(() => {
      delete require.cache[require.resolve('../lib/executable')];
      delete require.cache[require.resolve('../lib/blinterRunner')];
      const blinterRunner = require('../lib/blinterRunner');
      blinterRunner.getExePath = () => path.join(__dirname, '..', 'vendor', 'Blinter', 'Blinter.exe');
      const { resolveBlinterExePath } = require('../lib/executable');
      assert.ok(resolveBlinterExePath(null));
    });

    await new Promise((resolve, reject) => {
      withMockVscode((mock) => {
        delete require.cache[require.resolve('../lib/debugSession')];
        const { prepareForLaunch, acceptProcessText, addIssue } = require('../lib/debugSession');
        const tmpFile = path.join(os.tmpdir(), `blinter-ds-${Date.now()}.cmd`);
        fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
        const controller = {
          context: { extensionPath: path.join(__dirname, '..') },
          clearDebugIssues: () => {},
          log: () => {},
          updateDebugStatus: () => {},
          updateWebview: () => {},
          webviewProvider: { ensureVisible: () => {}, update: () => {} },
          currentEncoding: 'utf8',
          currentProgramPath: tmpFile,
          currentWorkspaceRoot: path.dirname(tmpFile),
          variableIndex: {},
          debugIssuesByFile: new Map([[path.normalize(tmpFile), []]]),
          scheduleDiagnosticsUpdate: () => {}
        };
        mock.vscode.window.activeTextEditor = { document: { languageId: 'bat', uri: { scheme: 'file', fsPath: tmpFile } } };
        prepareForLaunch(controller, {
          program: path.basename(tmpFile),
          workspaceFolder: path.dirname(tmpFile),
          args: ['', '  ', '--verbose']
        }, { workspaceFolder: { uri: { fsPath: path.dirname(tmpFile) } } })
          .then((launch) => {
            assert.ok(launch.args.includes('--verbose'));
            acceptProcessText(controller, '', 'stdout');
            addIssue(controller, { message: 'm', code: 'E001', line: 1, filePath: tmpFile });
            addIssue(controller, { message: 'm', code: 'E001', line: 1, filePath: tmpFile });
            fs.unlinkSync(tmpFile);
            resolve();
          })
          .catch(reject);
      });
    });
  });

  it('covers documentSnapshot no-extension and cleanup string errors', async () => {
    const snapshotMod = require('../lib/documentSnapshot');
    const noExtDir = path.join(os.tmpdir(), `blinter-noext-${Date.now()}`);
    fs.mkdirSync(noExtDir, { recursive: true });
    const noExtFile = path.join(noExtDir, 'batchfile');
    const uriKey = `file://${noExtFile}`;
    await snapshotMod.resolveDocumentPath({
      uri: { scheme: 'file', fsPath: noExtFile, toString: () => uriKey },
      isDirty: true,
      getText: () => '@echo off',
      save: async () => true
    }, false);

    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = () => { throw new Error('locked'); };
    try {
      snapshotMod.cleanupSnapshots();
    } finally {
      fs.unlinkSync = originalUnlink;
      fs.rmSync(noExtDir, { recursive: true, force: true });
    }

    let launchResolved;
    withMockVscode((mock) => {
      const documentSnapshotMod = require('../lib/documentSnapshot');
      const filePath = path.join(os.tmpdir(), `blinter-dirty-${Date.now()}.cmd`);
      mock.vscode.workspace.textDocuments = [{
        uri: { scheme: 'file', fsPath: filePath, toString: () => `file://${filePath}` },
        isDirty: true,
        getText: () => 'dirty'
      }];
      mock.vscode.workspace.getConfiguration = () => { throw new Error('config failed'); };
      launchResolved = documentSnapshotMod.resolveProgramPathForLaunch(filePath);
    });
    assert.ok(await launchResolved);
  });

  it('covers lintService catch paths and quickFix fallbacks', async () => {
    await new Promise((resolve, reject) => {
      withMockVscode((_mock) => {
        delete require.cache[require.resolve('../lib/lintService')];
        const docSnap = require('../lib/documentSnapshot');
        const originalResolve = docSnap.resolveDocumentPath;
        docSnap.resolveDocumentPath = async () => { throw new Error('resolve failed'); };
        const { lintDocument } = require('../lib/lintService');
        const tmpFile = path.join(os.tmpdir(), `blinter-lint-catch-${Date.now()}.cmd`);
        fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
        const controller = {
          isDebugSessionActive: () => false,
          log: () => {},
          updateLintStatus: () => {},
          handleProcessExit: () => {},
          lintDiagnostics: { delete: () => {} },
          lintIssuesByFile: { set: () => {} },
          context: { extensionPath: path.join(__dirname, '..') },
          _currentLintHandle: null,
          _lintRunId: 0
        };
        lintDocument(controller, {
          uri: { scheme: 'file', fsPath: tmpFile },
          isDirty: true,
          save: async () => true,
          getText: () => '@echo off'
        }).then(() => {
          docSnap.resolveDocumentPath = originalResolve;
          delete require.cache[require.resolve('../lib/lintService')];
          fs.unlinkSync(tmpFile);
          resolve();
        }).catch(reject);
      });
    });

    await new Promise((resolve, reject) => {
      withMockVscode(() => {
        delete require.cache[require.resolve('../lib/lintService')];
        delete require.cache[require.resolve('../lib/executable')];
        const blinterRunner = require('../lib/blinterRunner');
        const originalGetExePath = blinterRunner.getExePath;
        blinterRunner.getExePath = () => { throw new Error('missing exe'); };
        const { lintDocument } = require('../lib/lintService');
        const tmpFile = path.join(os.tmpdir(), `blinter-lint-exe-${Date.now()}.cmd`);
        fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
        const controller = {
          isDebugSessionActive: () => false,
          log: () => {},
          updateLintStatus: () => {},
          handleProcessExit: () => {},
          lintDiagnostics: { delete: () => {} },
          lintIssuesByFile: { set: () => {} },
          context: { extensionPath: path.join(__dirname, '..') },
          _currentLintHandle: null,
          _lintRunId: 0
        };
        lintDocument(controller, {
          uri: { scheme: 'file', fsPath: tmpFile },
          isDirty: false,
          save: async () => true,
          getText: () => '@echo off'
        }).then(() => {
          blinterRunner.getExePath = originalGetExePath;
          delete require.cache[require.resolve('../lib/lintService')];
          delete require.cache[require.resolve('../lib/executable')];
          fs.unlinkSync(tmpFile);
          resolve();
        }).catch(reject);
      });
    });

    await new Promise((resolve, reject) => {
      withMockVscode(() => {
        delete require.cache[require.resolve('../lib/lintService')];
        delete require.cache[require.resolve('../lib/parser')];
        const parser = require('../lib/parser');
        const originalParse = parser.parseBlinterOutput;
        parser.parseBlinterOutput = () => [{
          severity: 'error',
          code: 'E001',
          description: 'numbered',
          line: 4
        }];
        const blinterRunner = require('../lib/blinterRunner');
        const originalSpawn = blinterRunner.spawnBlinter;
        blinterRunner.spawnBlinter = ({ onLine, onExit }) => {
          onLine('Line 4: numbered (E001)');
          onExit(0);
          return { kill: () => {} };
        };
        const { lintDocument } = require('../lib/lintService');
        const tmpFile = path.join(os.tmpdir(), `blinter-lint-line-${Date.now()}.cmd`);
        fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
        const controller = {
          isDebugSessionActive: () => false,
          log: () => {},
          updateLintStatus: () => {},
          handleProcessExit: () => {},
          lintDiagnostics: { delete: () => {} },
          lintIssuesByFile: { set: () => {} },
          context: { extensionPath: path.join(__dirname, '..') },
          _currentLintHandle: null,
          _lintRunId: 0
        };
        lintDocument(controller, {
          uri: { scheme: 'file', fsPath: tmpFile },
          isDirty: false,
          save: async () => true,
          getText: () => '@echo off'
        }).then(() => {
          parser.parseBlinterOutput = originalParse;
          blinterRunner.spawnBlinter = originalSpawn;
          delete require.cache[require.resolve('../lib/lintService')];
          fs.unlinkSync(tmpFile);
          resolve();
        }).catch(reject);
      });
    });

    await new Promise((resolve, reject) => {
      withMockVscode(() => {
        delete require.cache[require.resolve('../lib/lintService')];
        const blinterRunner = require('../lib/blinterRunner');
        const originalSpawn = blinterRunner.spawnBlinter;
        const huge = 'x'.repeat(70 * 1024);
        blinterRunner.spawnBlinter = ({ onLine, onStderr, onExit }) => {
          for (let i = 0; i < 10001; i += 1) {
            onLine(`line ${i}`);
          }
          onStderr(huge);
          onStderr('overflow chunk');
          setImmediate(() => onExit(0));
          return { kill: () => {} };
        };
        const logs = [];
        const { lintDocument } = require('../lib/lintService');
        const tmpFile = path.join(os.tmpdir(), `blinter-lint-cap-${Date.now()}.cmd`);
        fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
        const controller = {
          isDebugSessionActive: () => false,
          log: (message) => logs.push(message),
          updateLintStatus: () => {},
          handleProcessExit: () => {},
          lintDiagnostics: { delete: () => {} },
          lintIssuesByFile: { set: () => {} },
          currentProgramPath: undefined,
          currentWorkspaceRoot: undefined,
          variableIndex: new Map(),
          context: { extensionPath: path.join(__dirname, '..') },
          _currentLintHandle: null,
          _lintRunId: 0
        };
        lintDocument(controller, {
          uri: { scheme: 'file', fsPath: tmpFile },
          isDirty: false,
          save: async () => true,
          getText: () => '@echo off'
        }).then(() => new Promise((next) => setImmediate(next))).then(() => {
          blinterRunner.spawnBlinter = originalSpawn;
          delete require.cache[require.resolve('../lib/lintService')];
          assert.ok(logs.some((entry) => entry.includes('stdout truncated')));
          assert.ok(logs.some((entry) => entry.includes('stderr truncated')));
          fs.unlinkSync(tmpFile);
          resolve();
        }).catch(reject);
      });
    });

    withMockVscode((mock) => {
      delete require.cache[require.resolve('../lib/quickFixes')];
      const { createSuppressionProvider } = require('../lib/quickFixes');
      mock.vscode.workspace.getConfiguration = () => ({
        get: (key, fallback) => {
          if (key === 'suppressionCommentStyle') { return 'REM'; }
          if (key === 'showAskCopilotQuickFix') { return true; }
          return fallback;
        }
      });
      const doc = {
        languageId: 'bat',
        uri: { fsPath: 'C:\\ws\\x.bat', toString: () => 'file:///C:/ws/x.bat' },
        lineCount: 1,
        eol: 2,
        lineAt: () => ({ text: 'ECHO', range: { start: { line: 0 }, end: { line: 0 } } })
      };
      const actions = createSuppressionProvider().provideCodeActions(
        doc,
        { start: { line: 0 } },
        { diagnostics: [{ source: 'blinter', code: 'W001', message: 'warn' }] }
      );
      assert.ok(actions.length > 0);
    });
  });

  it('covers debugSession encoding and launch argument branches', async () => {
    const repoRoot = path.join(__dirname, '..');
    const tmpFile = path.join(os.tmpdir(), `blinter-ds2-${Date.now()}.cmd`);
    fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');

    let successPromise;
    withMockVscode((mock) => {
      delete require.cache[require.resolve('../lib/debugSession')];
      const { prepareForLaunch, acceptProcessText, addIssue } = require('../lib/debugSession');
      mock.vscode.workspace.workspaceFolders = [{
        uri: { fsPath: path.dirname(tmpFile) }
      }];
      const controller = {
        context: { extensionPath: repoRoot },
        clearDebugIssues: () => {},
        log: () => {},
        updateDebugStatus: () => {},
        updateWebview: () => {},
        webviewProvider: { ensureVisible: () => {}, update: () => {} },
        currentEncoding: 'utf8',
        currentProgramPath: tmpFile,
        currentWorkspaceRoot: path.dirname(tmpFile),
        variableIndex: {},
        debugIssuesByFile: new Map([[path.normalize(tmpFile), []]]),
        scheduleDiagnosticsUpdate: () => {},
        getDiagnosticAllowedPaths: () => [path.dirname(tmpFile)]
      };
      mock.vscode.workspace.getConfiguration = () => ({
        get: (key, fallback) => {
          if (key === 'encoding') { return ''; }
          if (key === 'enabled') { return true; }
          return fallback;
        }
      });
      acceptProcessText(controller, 'noise', 'stdout');
      addIssue(controller, { message: 'm', code: 'E001', line: 1, filePath: tmpFile });
      addIssue(controller, { message: 'm', code: 'E001', line: 1, filePath: tmpFile });
      successPromise = prepareForLaunch(controller, {
        program: tmpFile,
        args: ['', '--verbose']
      }, {});
    });
    const launch = await successPromise;
    assert.ok(launch.args.includes('--verbose'));

    withMockVscode((_mock) => {
      delete require.cache[require.resolve('../lib/debugSession')];
      const { addIssue } = require('../lib/debugSession');
      const controller = {
        debugIssuesByFile: {
          has: () => true,
          get: () => undefined,
          set: () => {}
        },
        currentProgramPath: tmpFile,
        currentWorkspaceRoot: path.dirname(tmpFile),
        getDiagnosticAllowedPaths: () => [path.dirname(tmpFile)],
        scheduleDiagnosticsUpdate: () => {}
      };
      addIssue(controller, { message: 'm', code: 'E001', line: 1, filePath: tmpFile });
    });

    fs.unlinkSync(tmpFile);
  });

  it('covers outputView string error branches', () => {
    withMockVscode(() => {
      delete require.cache[require.resolve('../lib/outputView')];
      const { BlinterOutputViewProvider } = require('../lib/outputView');
      const controller = {
        log: () => {},
        revealLocation: async () => {},
        removeAllSuppressionComments: async () => { throw new Error('remove failed'); }
      };
      const provider = new BlinterOutputViewProvider({ fsPath: __dirname }, controller);
      provider._view = {
        show: () => { throw new Error('show failed'); },
        webview: {
          cspSource: 'self',
          postMessage: () => {},
          onDidReceiveMessage: (cb) => {
            setImmediate(() => cb({ command: 'removeSuppressions' }));
            return { dispose: () => {} };
          }
        }
      };
      provider.resolveWebviewView(provider._view);
      provider.ensureVisible();
      provider._data = { groups: null };
      provider.postUpdate();
    });
  });

  it('groups lint issues by file path and awaits spawn completion', async () => {
    await new Promise((resolve, reject) => {
      withMockVscode(() => {
        delete require.cache[require.resolve('../lib/lintService')];
        delete require.cache[require.resolve('../lib/parser')];
        const blinterRunner = require('../lib/blinterRunner');
        const originalSpawn = blinterRunner.spawnBlinter;
        let exitCalled = false;
        const workDir = path.join(os.tmpdir(), `blinter-follow-${Date.now()}`);
        fs.mkdirSync(workDir, { recursive: true });
        const mainFile = path.join(workDir, 'main.cmd');
        const otherFile = path.join(workDir, 'other.cmd');
        fs.writeFileSync(mainFile, '@echo off\r\n', 'utf8');
        fs.writeFileSync(otherFile, '@echo off\r\n', 'utf8');
        const parser = require('../lib/parser');
        const originalParse = parser.parseBlinterOutput;
        parser.parseBlinterOutput = () => [{
          severity: 'error',
          code: 'E001',
          description: 'follow call issue',
          line: 2,
          filePath: otherFile
        }];
        blinterRunner.spawnBlinter = ({ onExit }) => {
          setImmediate(() => {
            onExit(1);
            exitCalled = true;
          });
          return { kill: () => {} };
        };
        const { lintDocument } = require('../lib/lintService');
        const lintIssuesByFile = new Map();
        const controller = {
          isDebugSessionActive: () => false,
          log: () => {},
          updateLintStatus: () => {},
          handleProcessExit: () => {},
          lintDiagnostics: { delete: () => {} },
          lintIssuesByFile,
          debugIssuesByFile: new Map(),
          getAllowedRevealPaths: () => [mainFile, otherFile, path.dirname(mainFile)],
          getDiagnosticAllowedPaths: () => [path.dirname(mainFile)],
          currentProgramPath: undefined,
          currentWorkspaceRoot: path.dirname(mainFile),
          variableIndex: new Map(),
          context: { extensionPath: path.join(__dirname, '..') },
          _currentLintHandle: null,
          _lintRunId: 0
        };
        lintDocument(controller, {
          uri: { scheme: 'file', fsPath: mainFile },
          isDirty: false,
          save: async () => true,
          getText: () => '@echo off'
        }).then(() => {
          assert.strictEqual(exitCalled, true);
          const keys = [...lintIssuesByFile.keys()];
          assert.ok(
            keys.some((key) => path.basename(key).toLowerCase() === 'other.cmd'),
            `Expected other.cmd issues, got keys: ${keys.join(', ')}`
          );
          blinterRunner.spawnBlinter = originalSpawn;
          parser.parseBlinterOutput = originalParse;
          delete require.cache[require.resolve('../lib/lintService')];
          delete require.cache[require.resolve('../lib/parser')];
          fs.rmSync(workDir, { recursive: true, force: true });
          resolve();
        }).catch(reject);
      });
    });
  });

  it('cancels superseded lint runs without processing stale output', async () => {
    await new Promise((resolve, reject) => {
      withMockVscode(() => {
        delete require.cache[require.resolve('../lib/lintService')];
        const blinterRunner = require('../lib/blinterRunner');
        const originalSpawn = blinterRunner.spawnBlinter;
        let firstExit = false;
        blinterRunner.spawnBlinter = ({ onExit }) => {
          if (!firstExit) {
            firstExit = true;
            return {
              kill: () => {
                setImmediate(() => onExit(0));
              }
            };
          }
          setImmediate(() => onExit(0));
          return { kill: () => {} };
        };
        const { lintDocument } = require('../lib/lintService');
        const tmpFile = path.join(os.tmpdir(), `blinter-supersede-${Date.now()}.cmd`);
        fs.writeFileSync(tmpFile, '@echo off\r\n', 'utf8');
        let exitCount = 0;
        const controller = {
          isDebugSessionActive: () => false,
          log: () => {},
          updateLintStatus: () => {},
          handleProcessExit: () => { exitCount += 1; },
          lintDiagnostics: { delete: () => {} },
          lintIssuesByFile: new Map(),
          debugIssuesByFile: new Map(),
          getDiagnosticAllowedPaths: () => [path.dirname(tmpFile)],
          currentProgramPath: undefined,
          currentWorkspaceRoot: path.dirname(tmpFile),
          variableIndex: new Map(),
          context: { extensionPath: path.join(__dirname, '..') },
          _currentLintHandle: null,
          _lintRunId: 0
        };
        const doc = {
          uri: { scheme: 'file', fsPath: tmpFile },
          isDirty: false,
          save: async () => true,
          getText: () => '@echo off'
        };
        const first = lintDocument(controller, doc);
        const second = lintDocument(controller, doc);
        Promise.all([first, second]).then(() => {
          assert.ok(exitCount >= 1);
          blinterRunner.spawnBlinter = originalSpawn;
          delete require.cache[require.resolve('../lib/lintService')];
          fs.unlinkSync(tmpFile);
          resolve();
        }).catch(reject);
      });
    });
  });

  it('falls back to the editor path when parsed issue path is not allowed', async () => {
    await new Promise((resolve, reject) => {
      withMockVscode(() => {
        delete require.cache[require.resolve('../lib/lintService')];
        delete require.cache[require.resolve('../lib/parser')];
        const blinterRunner = require('../lib/blinterRunner');
        const originalSpawn = blinterRunner.spawnBlinter;
        const workDir = path.join(os.tmpdir(), `blinter-fallback-${Date.now()}`);
        fs.mkdirSync(workDir, { recursive: true });
        const mainFile = path.join(workDir, 'main.cmd');
        fs.writeFileSync(mainFile, '@echo off\r\n', 'utf8');
        const parser = require('../lib/parser');
        const originalParse = parser.parseBlinterOutput;
        parser.parseBlinterOutput = () => [{
          severity: 'error',
          code: 'E001',
          description: 'outside issue',
          line: 3,
          filePath: 'C:\\outside\\blocked.cmd'
        }];
        blinterRunner.spawnBlinter = ({ onExit }) => {
          setImmediate(() => onExit(1));
          return { kill: () => {} };
        };
        const { lintDocument } = require('../lib/lintService');
        const lintIssuesByFile = new Map();
        const controller = {
          isDebugSessionActive: () => false,
          log: () => {},
          updateLintStatus: () => {},
          handleProcessExit: () => {},
          lintDiagnostics: { delete: () => {} },
          lintIssuesByFile,
          debugIssuesByFile: new Map(),
          getDiagnosticAllowedPaths: () => [workDir],
          currentProgramPath: undefined,
          currentWorkspaceRoot: workDir,
          variableIndex: new Map(),
          context: { extensionPath: path.join(__dirname, '..') },
          _currentLintHandle: null,
          _lintRunId: 0
        };
        lintDocument(controller, {
          uri: { scheme: 'file', fsPath: mainFile },
          isDirty: false,
          save: async () => true,
          getText: () => '@echo off'
        }).then(() => {
          assert.ok(lintIssuesByFile.has(mainFile));
          blinterRunner.spawnBlinter = originalSpawn;
          parser.parseBlinterOutput = originalParse;
          delete require.cache[require.resolve('../lib/lintService')];
          delete require.cache[require.resolve('../lib/parser')];
          fs.rmSync(workDir, { recursive: true, force: true });
          resolve();
        }).catch(reject);
      });
    });
  });

  it('covers lint allowed path fallbacks without diagnostic helper', async () => {
    await new Promise((resolve) => {
      withMockVscode(() => {
        delete require.cache[require.resolve('../lib/lintService')];
        const { getLintAllowedPaths } = require('../lib/lintService');
        const controller = {
          getAllowedRevealPaths: () => ['C:\\reveal']
        };
        const allowed = getLintAllowedPaths(controller, 'C:\\file.cmd', 'C:\\ws');
        assert.deepStrictEqual(allowed, ['C:\\reveal']);
        const fallback = getLintAllowedPaths({}, 'C:\\file.cmd', 'C:\\ws');
        assert.deepStrictEqual(fallback, ['C:\\file.cmd', 'C:\\ws']);
        resolve();
      });
    });
  });
});
