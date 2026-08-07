const assert = require('assert');
const vscode = require('vscode');
const {
  activateBlinter,
  CORE_COMMANDS,
  getExtensionPackageJson
} = require('./support/integration-helpers');

suite('Integration (basic) Test Suite', () => {
  suiteSetup(async function () {
    this.timeout(15000);
    await activateBlinter();
  });

  test('extension activates and exposes expected contribution surface', async function () {
    this.timeout(10000);
    const ext = await activateBlinter();
    assert.ok(ext, 'Blinter extension should be installed in the test host');
    assert.strictEqual(ext.isActive, true, 'Blinter extension should be active');

    const packageJson = await getExtensionPackageJson();
    const commands = (packageJson.contributes && packageJson.contributes.commands) || [];
    const debuggers = (packageJson.contributes && packageJson.contributes.debuggers) || [];
    const debugViews = (packageJson.contributes && packageJson.contributes.views && packageJson.contributes.views.debug) || [];

    assert.ok(
      commands.some((entry) => entry && entry.command === 'blinter.run'),
      'package.json should contribute blinter.run'
    );
    assert.ok(
      debuggers.some((entry) => entry && entry.type === 'blinter-debug'),
      'package.json should contribute blinter-debug debugger'
    );
    assert.ok(
      debugViews.some((entry) => entry && entry.id === 'blinter.outputSummary'),
      'package.json should contribute Blinter Output view'
    );
  });

  test('core blinter commands are registered at runtime', async function () {
    this.timeout(10000);
    const commands = await vscode.commands.getCommands(true);
    for (const commandId of CORE_COMMANDS) {
      assert.strictEqual(
        commands.includes(commandId),
        true,
        `Expected command to be registered: ${commandId}`
      );
    }
  });

  test('batch language ids are associated with the extension', async function () {
    this.timeout(10000);
    const packageJson = await getExtensionPackageJson();
    const languages = packageJson.contributes && packageJson.contributes.languages;
    const languageIds = Array.isArray(languages)
      ? languages.map((entry) => entry && entry.id).filter(Boolean)
      : [];

    assert.ok(languageIds.includes('bat'), 'Expected bat language contribution');
    const batLanguage = Array.isArray(languages)
      ? languages.find((entry) => entry && entry.id === 'bat')
      : undefined;
    assert.ok(
      batLanguage && Array.isArray(batLanguage.extensions) && batLanguage.extensions.includes('.cmd'),
      'Expected .cmd files to be associated with the bat language'
    );
  });
});
