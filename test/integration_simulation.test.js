const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { createIntegrationTempBatch } = require('./support/integration-fixtures');
const {
  activateBlinter,
  getExtensionPackageJson,
  openBatchFile,
  pollBlinterDiagnostics,
  startBlinterDebug
} = require('./support/integration-helpers');
const { pollUntil } = require('./support/poll');

suite('Integration (simulation) - debugger + suppressions', () => {
  test('validates launch/debug + suppression UI contributions', async () => {
    const projectRoot = path.join(__dirname, '..');
    const commandsJsPath = path.join(projectRoot, 'lib', 'commands.js');
    const outputViewJsPath = path.join(projectRoot, 'lib', 'outputView.js');

    const packageJson = await getExtensionPackageJson();
    const commands = (packageJson.contributes && packageJson.contributes.commands) || [];
    const viewTitleMenus = (packageJson.contributes && packageJson.contributes.menus && packageJson.contributes.menus['view/title']) || [];
    const debuggers = (packageJson.contributes && packageJson.contributes.debuggers) || [];

    assert.strictEqual(
      commands.some((cmd) => cmd && cmd.command === 'blinter.removeAllSuppressions'),
      true,
      'Expected blinter.removeAllSuppressions command contribution'
    );
    assert.strictEqual(
      viewTitleMenus.some((entry) => entry && entry.command === 'blinter.removeAllSuppressions' && entry.when === 'view == blinter.outputSummary'),
      true,
      'Expected remove-all-suppressions action to be contributed to Blinter Output view title'
    );

    const blinterDebugger = debuggers.find((dbg) => dbg && dbg.type === 'blinter-debug');
    assert.ok(blinterDebugger, 'Expected blinter-debug debugger contribution');
    const matchingInitial = (blinterDebugger.initialConfigurations || []).filter((cfg) =>
      cfg
      && cfg.type === 'blinter-debug'
      && cfg.name === 'Launch Batch (Blinter)'
      && cfg.request === 'launch'
    );
    assert.strictEqual(
      matchingInitial.length,
      1,
      'Expected exactly one "Launch Batch (Blinter)" initial configuration contribution'
    );

    const commandsSource = fs.readFileSync(commandsJsPath, 'utf8');
    const outputViewSource = fs.readFileSync(outputViewJsPath, 'utf8');
    assert.strictEqual(
      commandsSource.includes("registerCommand('blinter.runAndDebug'"),
      true,
      'Expected blinter.runAndDebug to be registered in lib/commands.js'
    );
    assert.strictEqual(
      outputViewSource.includes('removeSuppressionsBtn'),
      true,
      'Expected Blinter Output webview HTML to include remove-suppressions button'
    );
  });

  test('inserts suppression via quick fix and removes it via button command path', async function () {
    this.timeout(90000);

    await activateBlinter();

    const samplePath = createIntegrationTempBatch(__dirname, 'simulation-debug-target.cmd', [
      '@echo off',
      'set FO=1',
      'echo Hello %FO%',
      'call missing.bat'
    ]);

    const doc = await openBatchFile(samplePath);

    const { started, terminated } = await startBlinterDebug(samplePath, 'Launch Batch (Blinter) - simulation');
    assert.strictEqual(started, true, 'Expected debug session to start');
    await vscode.commands.executeCommand('workbench.view.debug');
    const allCommands = await vscode.commands.getCommands(true);
    const focusCommand = allCommands.find((c) => c === 'blinter.outputSummary.focus');
    if (focusCommand) {
      await vscode.commands.executeCommand(focusCommand);
    }

    const outputViewState = await pollUntil(async () => {
      const state = await vscode.commands.executeCommand('blinter.test.getOutputViewState');
      return state && state.viewResolved ? state : null;
    }, { timeoutMs: 15000, label: 'Blinter Output view state' });
    assert.strictEqual(
      Boolean(outputViewState && outputViewState.viewResolved),
      true,
      `Blinter Output view did not resolve during debug run. State: ${JSON.stringify(outputViewState)}`
    );
    assert.strictEqual(
      Boolean(outputViewState && outputViewState.containsRemoveSuppressionsButton),
      true,
      `Remove All Suppressions button not found in webview HTML. State: ${JSON.stringify(outputViewState)}`
    );
    assert.strictEqual(
      Boolean(outputViewState && outputViewState.containsRemoveSuppressionsHandler),
      true,
      `Remove-suppressions message handler missing in webview HTML. State: ${JSON.stringify(outputViewState)}`
    );

    await terminated;

    // Debug diagnostics are cleared when the session ends; lint the active file for quick-fix coverage.
    await openBatchFile(samplePath);
    await vscode.commands.executeCommand('blinter.run');

    const diagnostics = await pollBlinterDiagnostics(doc.uri, {
      timeoutMs: 30000,
      label: 'lint diagnostics after debug'
    });

    const commands = await vscode.commands.getCommands(true);
    assert.strictEqual(
      commands.includes('blinter.removeAllSuppressions'),
      true,
      'Expected blinter.removeAllSuppressions command to be registered'
    );

    const firstDiagnostic = diagnostics.find((d) => d.source === 'blinter');
    assert.ok(firstDiagnostic, 'Expected at least one blinter diagnostic to create suppression from');

    const quickFixActions = await vscode.commands.executeCommand(
      'vscode.executeCodeActionProvider',
      doc.uri,
      firstDiagnostic.range,
      'quickfix'
    );
    const suppressAction = (quickFixActions || []).find((action) =>
      action
      && typeof action.title === 'string'
      && action.title.toLowerCase().startsWith('blinter: suppress ')
    );
    assert.ok(suppressAction, 'Expected a Blinter suppression quick fix action');

    if (suppressAction.edit) {
      const appliedSuppressEdit = await vscode.workspace.applyEdit(suppressAction.edit);
      assert.strictEqual(appliedSuppressEdit, true, 'Expected suppression quick-fix edit to apply');
    }
    if (suppressAction.command) {
      await vscode.commands.executeCommand(
        suppressAction.command.command,
        ...(Array.isArray(suppressAction.command.arguments) ? suppressAction.command.arguments : [])
      );
    }

    await pollUntil(async () => {
      const text = (await vscode.workspace.openTextDocument(samplePath)).getText();
      return /LINT:IGNORE(?:-LINE)?/i.test(text) ? text : null;
    }, { timeoutMs: 5000, label: 'suppression comment insertion' });

    const withSuppressionText = (await vscode.workspace.openTextDocument(samplePath)).getText();
    assert.strictEqual(
      /LINT:IGNORE(?:-LINE)?/i.test(withSuppressionText),
      true,
      `Expected suppression comment to be inserted by quick fix, but file was:\n${withSuppressionText}`
    );

    // The UI button posts this exact command path.
    await vscode.commands.executeCommand('blinter.removeAllSuppressions');

    const updatedText = await pollUntil(async () => {
      const text = (await vscode.workspace.openTextDocument(samplePath)).getText();
      return /LINT:IGNORE(?:-LINE)?/i.test(text) ? null : text;
    }, { timeoutMs: 5000, label: 'suppression comment removal' });

    assert.strictEqual(
      /LINT:IGNORE(?:-LINE)?/i.test(updatedText),
      false,
      `Expected suppression comments to be removed, but file was:\n${updatedText}`
    );
    assert.strictEqual(
      /\bset FO=1\b/i.test(updatedText),
      true,
      'Expected script body to remain after suppression removal'
    );
  });
});
