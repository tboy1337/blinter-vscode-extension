const assert = require('assert');
const vscode = require('vscode');
const { integrationSamplePath } = require('./support/integration-fixtures');
const {
  activateBlinter,
  openBatchFile,
  pollBlinterDiagnostics,
  startBlinterDebug
} = require('./support/integration-helpers');
const { pollUntil } = require('./support/poll');

suite('Integration (smoke) - Run & Debug single file', () => {
  test('starts debug session, completes, and leaves blinter diagnostics', async function () {
    this.timeout(60000);

    await activateBlinter();
    const samplePath = integrationSamplePath(__dirname);
    const doc = await openBatchFile(samplePath);

    const { started, terminated } = await startBlinterDebug(samplePath, 'Launch Batch (Blinter) - smoke');
    assert.strictEqual(started, true, 'Expected vscode.debug.startDebugging to return true');

    await pollUntil(
      () => (vscode.debug.activeDebugSession && vscode.debug.activeDebugSession.type === 'blinter-debug'
        ? vscode.debug.activeDebugSession
        : null),
      { timeoutMs: 10000, label: 'active blinter-debug session' }
    );

    await terminated;

    // Debug diagnostics are cleared when the session ends; lint the active file for Problems coverage.
    await vscode.commands.executeCommand('blinter.run');

    const diagnostics = await pollBlinterDiagnostics(doc.uri, {
      timeoutMs: 20000,
      label: 'post-debug blinter diagnostics'
    });
    assert.ok(diagnostics.length > 0, 'Expected at least one blinter diagnostic after debug session');
  });
});
