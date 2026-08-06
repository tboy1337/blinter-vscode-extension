const { EventEmitter } = require('events');
const path = require('path');
const childProcess = require('child_process');

/** @typedef {import('../types/blinter').InlineDebugAdapterOptions} InlineDebugAdapterOptions */
/**
 * @typedef {{
 *   prepareForLaunch: (args: Record<string, unknown>, session: import('vscode').DebugSession | { id?: string }) => Promise<{ executable: string, args: string[], cwd?: string, displayName?: string }>,
 *   currentProgramPath?: string,
 *   currentEncoding?: string,
 *   log?: (message: string) => void,
 *   handleProcessExit?: (code: number | null | undefined) => void,
 *   acceptProcessText?: (text: string, channel: string) => void
 * }} DebugController
 */

class InlineDebugAdapterSession {
  /**
   * @param {DebugController} controller
   * @param {import('vscode').DebugSession | { id?: string }} session
   * @param {InlineDebugAdapterOptions} [options]
   */
  constructor(controller, session, options = {}) {
    if (!controller) {
      throw new Error('controller is required');
    }
    this.controller = controller;
    this.session = session;
    this.spawnImpl = options.spawn || childProcess.spawn;

    this._emitter = new EventEmitter();
    this.sequence = 1;
    this.process = undefined;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
  }

  /**
   * @param {(message: object) => void} listener
   */
  onDidSendMessage(listener) {
    this._emitter.on('message', listener);
    return {
      dispose: () => this._emitter.off('message', listener)
    };
  }

  /**
   * @param {{ type?: string, command?: string, seq?: number, arguments?: object } | undefined} message
   */
  handleMessage(message) {
    if (!message || message.type !== 'request') {
      return;
    }

    switch (message.command) {
      case 'initialize':
        this._sendResponse(message, {
          supportsConfigurationDoneRequest: true,
          supportsTerminateRequest: true
        });
        this._sendEvent('initialized', {});
        break;
      case 'launch':
        void this._launch(message);
        break;
      case 'configurationDone':
        this._sendResponse(message, {});
        break;
      case 'disconnect':
      case 'terminate':
        this.stopProcess();
        this._sendResponse(message, {});
        this._sendEvent('terminated', {});
        break;
      default:
        this._sendResponse(message, {});
        break;
    }
  }

  dispose() {
    this.stopProcess();
    this._emitter.removeAllListeners();
  }

  stopProcess() {
    if (this.process && !this.process.killed) {
      try {
        this.process.kill();
      } catch {
        // Ignore kill failures.
      }
    }
    this.process = undefined;
  }

  /**
   * @param {{ seq?: number, command?: string, arguments?: object }} request
   */
  async _launch(request) {
    try {
      const launchArgs = /** @type {Record<string, unknown>} */ (request.arguments || {});
      const launchInfo = await this.controller.prepareForLaunch(launchArgs, this.session);
      if (!launchInfo || typeof launchInfo.executable !== 'string' || !launchInfo.executable.trim()) {
        throw new Error('Blinter launch failed: executable path was not resolved.');
      }
      if (!Array.isArray(launchInfo.args)) {
        throw new Error('Blinter launch failed: args must be an array.');
      }

      this.process = this.spawnImpl(launchInfo.executable, launchInfo.args, {
        cwd: launchInfo.cwd,
        windowsHide: true
      });

      this._attachProcessListeners();

      this._sendResponse(request, {});
      this._sendEvent('loadedSource', {
        reason: 'new',
        source: {
          name: launchInfo.displayName || (this.controller.currentProgramPath && path.basename(this.controller.currentProgramPath)),
          path: this.controller.currentProgramPath
        }
      });
      this._sendEvent('process', {
        name: 'blinter',
        isLocalProcess: true,
        startMethod: 'launch',
        systemProcessId: this.process.pid
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._sendResponse(request, { success: false, message });
      this._sendEvent('output', { category: 'stderr', output: `${message}\n` });
      this._sendEvent('terminated', {});
    }
  }

  _attachProcessListeners() {
    if (!this.process) {
      return;
    }

    const processRef = this.process;
    let settled = false;
    const markSettled = () => {
      if (settled) {
        return false;
      }
      settled = true;
      return true;
    };

    const { stdout, stderr } = processRef;
    const encoding = (this.controller && this.controller.currentEncoding) || 'utf8';
    if (stdout && typeof stdout.setEncoding === 'function') {
      try {
        stdout.setEncoding(/** @type {BufferEncoding} */ (encoding));
      } catch {
        stdout.setEncoding('utf8');
      }
    }
    if (stderr && typeof stderr.setEncoding === 'function') {
      try {
        stderr.setEncoding(/** @type {BufferEncoding} */ (encoding));
      } catch {
        stderr.setEncoding('utf8');
      }
    }

    if (stdout) {
      stdout.on('data', (/** @type {string | Buffer} */ data) => this._handleData(String(data), 'stdout'));
    }
    if (stderr) {
      stderr.on('data', (/** @type {string | Buffer} */ data) => this._handleData(String(data), 'stderr'));
    }

    processRef.on('error', (/** @type {unknown} */ err) => {
      if (!markSettled()) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (this.controller.log) {
        this.controller.log(`Blinter process error: ${message}`);
      }
      this._sendEvent('output', { category: 'stderr', output: `${message}\n` });
      this.stopProcess();
      this._sendEvent('terminated', {});
    });

    processRef.on('close', (/** @type {number | null | undefined} */ code) => {
      if (!markSettled()) {
        return;
      }
      this._flushBuffers();
      if (this.controller && typeof this.controller.handleProcessExit === 'function') {
        this.controller.handleProcessExit(code ?? 0);
      }
      this._sendEvent('exited', { exitCode: code ?? 0 });
      this._sendEvent('terminated', {});
      this.stopProcess();
    });
  }

  /**
   * @param {string} data
   * @param {'stdout' | 'stderr'} channel
   */
  _handleData(data, channel) {
    if (channel === 'stdout') {
      this.stdoutBuffer += data;
      this._drainBuffer('stdout');
      return;
    }
    this.stderrBuffer += data;
    this._drainBuffer('stderr');
  }

  /**
   * @param {'stdout' | 'stderr'} channel
   */
  _drainBuffer(channel) {
    let buffer = channel === 'stdout' ? this.stdoutBuffer : this.stderrBuffer;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.substring(0, newlineIndex);
      buffer = buffer.substring(newlineIndex + 1);
      this._emitLine(line, channel);
      newlineIndex = buffer.indexOf('\n');
    }

    if (channel === 'stdout') {
      this.stdoutBuffer = buffer;
    } else {
      this.stderrBuffer = buffer;
    }
  }

  _flushBuffers() {
    if (this.stdoutBuffer.length) {
      this._emitLine(this.stdoutBuffer, 'stdout');
      this.stdoutBuffer = '';
    }
    if (this.stderrBuffer.length) {
      this._emitLine(this.stderrBuffer, 'stderr');
      this.stderrBuffer = '';
    }
  }

  /**
   * @param {string} line
   * @param {'stdout' | 'stderr'} channel
   */
  _emitLine(line, channel) {
    const text = line.replace(/\r$/, '');
    if (!text.length) {
      return;
    }
    this._sendEvent('output', { category: channel, output: `${text}\n` });
    if (this.controller && typeof this.controller.acceptProcessText === 'function') {
      this.controller.acceptProcessText(text, channel);
    }
  }

  /**
   * @param {{ seq?: number, command?: string }} request
   * @param {Record<string, unknown>} [body]
   */
  _sendResponse(request, body = {}) {
    this._emitMessage({
      type: 'response',
      seq: this.sequence++,
      request_seq: request.seq,
      command: request.command,
      success: body.success !== false,
      message: body.message,
      body: body.body ?? body
    });
  }

  /**
   * @param {string} event
   * @param {object} [body]
   */
  _sendEvent(event, body) {
    this._emitMessage({
      type: 'event',
      seq: this.sequence++,
      event,
      body: body || {}
    });
  }

  /**
   * @param {object} message
   */
  _emitMessage(message) {
    this._emitter.emit('message', message);
  }
}

module.exports = {
  InlineDebugAdapterSession
};
