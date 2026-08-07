const assert = require('assert');
const { EventEmitter } = require('events');

const { InlineDebugAdapterSession } = require('../lib/debugAdapterCore');

function createFakeProcess() {
  const processEmitter = new EventEmitter();
  processEmitter.stdout = new EventEmitter();
  processEmitter.stderr = new EventEmitter();
  processEmitter.stdout.setEncoding = () => {};
  processEmitter.stderr.setEncoding = () => {};
  processEmitter.kill = () => {
    processEmitter.killed = true;
  };
  processEmitter.pid = 321;
  return processEmitter;
}

describe('InlineDebugAdapterSession', () => {
  it('streams output to controller and emits DAP lifecycle events', async () => {
    const capturedMessages = [];
    const accepted = [];
    const exits = [];
    const logs = [];
    const prepared = [];

    const controller = {
      currentProgramPath: 'C:/workspace/script.bat',
      prepareForLaunch: (launchArgs, session) => {
        prepared.push({ launchArgs, session });
        return {
          executable: 'blinter.exe',
          args: ['script.bat'],
          cwd: 'C:/workspace',
          displayName: 'script.bat'
        };
      },
      acceptProcessText: (text, channel) => {
        accepted.push({ text, channel });
      },
      handleProcessExit: (code) => {
        exits.push(code);
      },
      log: (message) => {
        logs.push(message);
      }
    };

    let fakeProcess;
    const adapter = new InlineDebugAdapterSession(controller, { id: 'session-1' }, {
      spawn: (command, args, options) => {
        assert.strictEqual(command, 'blinter.exe');
        assert.deepStrictEqual(args, ['script.bat']);
        assert.strictEqual(options.cwd, 'C:/workspace');
        fakeProcess = createFakeProcess();
        return fakeProcess;
      }
    });

    adapter.onDidSendMessage((message) => capturedMessages.push(message));

    adapter.handleMessage({ type: 'request', seq: 1, command: 'initialize' });
    adapter.handleMessage({ type: 'request', seq: 2, command: 'launch', arguments: { program: 'script.bat' } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(prepared.length, 1);
    assert.strictEqual(fakeProcess instanceof EventEmitter, true);

    fakeProcess.stdout.emit('data', 'first line\nsecond line\npartial');
    fakeProcess.stderr.emit('data', 'warning line\n');
    fakeProcess.stdout.emit('data', ' tail\n');

    assert.deepStrictEqual(accepted, [
      { text: 'first line', channel: 'stdout' },
      { text: 'second line', channel: 'stdout' },
      { text: 'warning line', channel: 'stderr' },
      { text: 'partial tail', channel: 'stdout' } // after concatenation across chunks
    ]);

    fakeProcess.emit('close', 0);
    assert.deepStrictEqual(exits, [0]);

    const initializeResponse = capturedMessages.find((msg) => msg.command === 'initialize');
    assert.ok(initializeResponse);
    assert.strictEqual(initializeResponse.type, 'response');

    const launchedProcessEvent = capturedMessages.find((msg) => msg.event === 'process');
    assert.ok(launchedProcessEvent);
    assert.strictEqual(launchedProcessEvent.body.systemProcessId, 321);

    const exitedEvent = capturedMessages.filter((msg) => msg.event === 'exited');
    assert.strictEqual(exitedEvent.length, 1);
    assert.strictEqual(exitedEvent[0].body.exitCode, 0);

    adapter.dispose();
    assert.strictEqual(adapter.process, undefined);
  });

  it('calls handleProcessExit when the debug process emits an error', async () => {
    const exits = [];
    const controller = {
      currentProgramPath: 'C:/workspace/script.bat',
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.bat'],
        cwd: 'C:/workspace'
      }),
      acceptProcessText: () => {},
      handleProcessExit: (code) => {
        exits.push(code);
      },
      log: () => {}
    };

    let fakeProcess;
    const adapter = new InlineDebugAdapterSession(controller, { id: 'session-error' }, {
      spawn: () => {
        fakeProcess = createFakeProcess();
        return fakeProcess;
      }
    });

    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setImmediate(resolve));

    fakeProcess.emit('error', new Error('spawn failed'));
    assert.deepStrictEqual(exits, [null]);

    adapter.dispose();
  });

  it('calls handleProcessExit when terminate is requested', async () => {
    const exits = [];
    const controller = {
      currentProgramPath: 'C:/workspace/script.bat',
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.bat'],
        cwd: 'C:/workspace'
      }),
      acceptProcessText: () => {},
      handleProcessExit: (code) => {
        exits.push(code);
      },
      log: () => {}
    };

    const adapter = new InlineDebugAdapterSession(controller, { id: 'session-terminate' }, {
      spawn: () => createFakeProcess()
    });

    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setImmediate(resolve));
    adapter.handleMessage({ type: 'request', seq: 2, command: 'terminate' });

    assert.deepStrictEqual(exits, [null]);
    adapter.dispose();
  });

  it('truncates oversized stdout and stderr output', async () => {
    const logs = [];
    const accepted = [];
    const controller = {
      currentProgramPath: 'C:/workspace/script.bat',
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.bat'],
        cwd: 'C:/workspace'
      }),
      acceptProcessText: (text, channel) => {
        accepted.push({ text, channel });
      },
      handleProcessExit: () => {},
      log: (message) => {
        logs.push(message);
      }
    };

    let fakeProcess;
    const adapter = new InlineDebugAdapterSession(controller, { id: 'session-truncate' }, {
      spawn: () => {
        fakeProcess = createFakeProcess();
        return fakeProcess;
      }
    });

    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setImmediate(resolve));

    for (let i = 0; i < 10001; i += 1) {
      fakeProcess.stdout.emit('data', `line-${i}\n`);
    }
    fakeProcess.stdout.emit('data', 'overflow line\n');
    const hugeStderr = 'x'.repeat(70 * 1024);
    fakeProcess.stderr.emit('data', hugeStderr);
    fakeProcess.stderr.emit('data', 'more stderr\n');
    adapter.stderrBuffer = 'x'.repeat(64 * 1024);
    adapter.stderrTruncated = false;
    fakeProcess.stderr.emit('data', 'after cap\n');

    assert.ok(logs.some((line) => line.includes('stdout output truncated')));
    assert.ok(logs.some((line) => line.includes('stderr output truncated')));
    assert.ok(accepted.length <= 10000);

    adapter.dispose();
  });

  it('does not spawn when disconnect happens during prepareForLaunch', async () => {
    /** @type {import('child_process').ChildProcess | undefined} */
    let spawnedProcess;
    /** @type {(() => void) | undefined} */
    let resolvePrepare;
    const preparePromise = new Promise((resolve) => {
      resolvePrepare = () => resolve({
        executable: 'blinter.exe',
        args: ['script.bat'],
        cwd: 'C:/workspace'
      });
    });

    const controller = {
      currentProgramPath: 'C:/workspace/script.bat',
      prepareForLaunch: async () => preparePromise,
      acceptProcessText: () => {},
      handleProcessExit: () => {},
      log: () => {}
    };

    const adapter = new InlineDebugAdapterSession(controller, { id: 'session-race' }, {
      spawn: () => {
        spawnedProcess = createFakeProcess();
        return spawnedProcess;
      }
    });

    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setImmediate(resolve));
    adapter.handleMessage({ type: 'request', seq: 2, command: 'disconnect' });
    resolvePrepare();
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(spawnedProcess, undefined);
    assert.strictEqual(adapter.process, undefined);
    adapter.dispose();
  });

  it('truncates oversized stdout buffer bytes before newline splitting', async () => {
    const logs = [];
    const controller = {
      currentProgramPath: 'C:/workspace/script.bat',
      prepareForLaunch: async () => ({
        executable: 'blinter.exe',
        args: ['script.bat'],
        cwd: 'C:/workspace'
      }),
      acceptProcessText: () => {},
      handleProcessExit: () => {},
      log: (message) => {
        logs.push(message);
      }
    };

    let fakeProcess;
    const adapter = new InlineDebugAdapterSession(controller, { id: 'session-stdout-cap' }, {
      spawn: () => {
        fakeProcess = createFakeProcess();
        return fakeProcess;
      }
    });

    adapter.handleMessage({ type: 'request', seq: 1, command: 'launch', arguments: {} });
    await new Promise((resolve) => setImmediate(resolve));

    const hugeStdout = 'x'.repeat(70 * 1024);
    fakeProcess.stdout.emit('data', hugeStdout);
    fakeProcess.stdout.emit('data', 'more stdout\n');

    assert.ok(logs.some((line) => line.includes('stdout output truncated')));
    assert.ok(adapter.stdoutBuffer.length <= 64 * 1024);

    adapter.dispose();
  });
});

