const assert = require('assert');
const vscode = require('vscode');
const { integrationSamplePath } = require('./support/integration-fixtures');
const {
  activateBlinter,
  openBatchFile,
  pollBlinterDiagnostics
} = require('./support/integration-helpers');

suite('Integration (lint) - manual run command', () => {
  test('blinter.run analyzes the active batch file and publishes diagnostics', async function () {
    this.timeout(60000);

    await activateBlinter();
    const samplePath = integrationSamplePath(__dirname);
    const doc = await openBatchFile(samplePath);

    await vscode.commands.executeCommand('blinter.run');

    const diagnostics = await pollBlinterDiagnostics(doc.uri, {
      timeoutMs: 30000,
      label: 'blinter.run diagnostics'
    });

    assert.ok(
      diagnostics.some((d) => typeof d.message === 'string' && d.message.length > 0),
      'Expected blinter diagnostics with messages after blinter.run'
    );
    assert.ok(
      diagnostics.some((d) => d.severity === vscode.DiagnosticSeverity.Warning
        || d.severity === vscode.DiagnosticSeverity.Information
        || d.severity === vscode.DiagnosticSeverity.Error),
      'Expected at least one warning, information, or error diagnostic'
    );
  });

  test('hover provider returns content on a line with blinter diagnostics', async function () {
    this.timeout(60000);

    await activateBlinter();
    const samplePath = integrationSamplePath(__dirname);
    const doc = await openBatchFile(samplePath);

    await vscode.commands.executeCommand('blinter.run');
    const diagnostics = await pollBlinterDiagnostics(doc.uri, {
      timeoutMs: 30000,
      label: 'hover precondition diagnostics'
    });

    const target = diagnostics[0];
    assert.ok(target, 'Expected a diagnostic to hover over');
    const position = new vscode.Position(target.range.start.line, target.range.start.character);

    const hovers = await vscode.commands.executeCommand(
      'vscode.executeHoverProvider',
      doc.uri,
      position
    );

    assert.ok(Array.isArray(hovers) && hovers.length > 0, 'Expected hover content for blinter diagnostic line');

    let text = '';
    for (const hover of hovers) {
      const parts = hover && Array.isArray(hover.contents) ? hover.contents : [];
      for (const part of parts) {
        if (typeof part === 'string') {
          text += part;
        } else if (part && typeof part.value === 'string') {
          text += part.value;
        }
      }
    }

    assert.ok(text.length > 0, `Expected non-empty hover text, got: ${JSON.stringify(hovers)}`);
  });
});
