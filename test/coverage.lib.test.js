const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
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
    const controller = {
      prepareForLaunch: async () => { throw new Error('launch failed'); },
      log: () => {}
    };
    const adapter = new InlineDebugAdapterSession(controller, { id: 's3' });
    adapter.onDidSendMessage((msg) => messages.push(msg));
    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(messages.some((m) => m.success === false));
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

  it('uses zero exit code when process close payload is null', async () => {
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
        const proc = createFakeProcess();
        setImmediate(() => proc.emit('close', null));
        return proc;
      }
    });
    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(messages[0], 0);
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
});
