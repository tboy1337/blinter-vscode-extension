const fs = require('fs');
const { getExePath } = require('./blinterRunner');
const { getBlinterConfig } = require('./config');

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').Uri | undefined} [scopeUri]
 */
function resolveBlinterExePath(context, scopeUri) {
  const extensionRoot = (context && (context.extensionUri || context.extensionPath)) || undefined;
  const config = getBlinterConfig(scopeUri);
  const options = {
    binaryPath: config.get('binaryPath', ''),
    useSystemBlinter: config.get('useSystemBlinter', false)
  };
  const candidate = getExePath(extensionRoot, options);
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new Error('Blinter executable path could not be resolved.');
  }
  if (!options.useSystemBlinter && !fs.existsSync(candidate)) {
    throw new Error(`Blinter executable not found: ${candidate}`);
  }
  return candidate;
}

module.exports = {
  resolveBlinterExePath
};
