const vscode = require('vscode');
const { InlineDebugAdapterSession } = require('./debugAdapterCore');
const { createSpawnImpl } = require('./spawnFactory');

class BlinterDebugAdapterFactory {
  /** @param {import('./controller').BlinterController} controller */
  constructor(controller) {
    this.controller = controller;
  }

  /** @param {import('vscode').DebugSession} session */
  createDebugAdapterDescriptor(session) {
    return new vscode.DebugAdapterInlineImplementation(new BlinterInlineDebugAdapter(this.controller, session));
  }
}

class BlinterInlineDebugAdapter {
  /**
   * @param {import('./controller').BlinterController} controller
   * @param {import('vscode').DebugSession} session
   */
  constructor(controller, session) {
    this.controller = controller;
    this.session = session;
    this._onDidSendMessage = new vscode.EventEmitter();
    this.onDidSendMessage = this._onDidSendMessage.event;
    /** @type {vscode.Disposable | undefined} */
    this.innerSubscription = undefined;
    /** @type {InstanceType<typeof InlineDebugAdapterSession> | undefined} */
    this.inner = undefined;

    this.inner = new InlineDebugAdapterSession(controller, session, { spawn: createSpawnImpl });

    this.innerSubscription = this.inner.onDidSendMessage((/** @type {object} */ message) => {
      this._onDidSendMessage.fire(message);
    });
  }

  /** @param {object} message */
  handleMessage(message) {
    if (this.inner) {
      this.inner.handleMessage(message);
    }
  }

  dispose() {
    if (this.innerSubscription) {
      this.innerSubscription.dispose();
      this.innerSubscription = undefined;
    }
    if (this.inner) {
      this.inner.dispose();
      this.inner = undefined;
    }
    this._onDidSendMessage.dispose();
  }
}

module.exports = {
  BlinterDebugAdapterFactory,
  BlinterInlineDebugAdapter
};
