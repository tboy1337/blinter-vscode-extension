const fs = require('fs');
const path = require('path');

const SAMPLE_RELATIVE = ['tmp', 'sample1.cmd'];

const SAMPLE_CONTENT = '@echo off\nset FO=1\necho Hello %FO%\ncall missing.bat\n';

/**
 * Ensures the integration smoke sample exists under repo-root/tmp (gitignored).
 * @param {string} repoRoot
 * @returns {string} Absolute path to sample1.cmd
 */
function ensureIntegrationSampleFile(repoRoot) {
  const tmpDir = path.join(repoRoot, SAMPLE_RELATIVE[0]);
  const samplePath = path.join(tmpDir, SAMPLE_RELATIVE[1]);

  if (!fs.existsSync(samplePath)) {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(samplePath, SAMPLE_CONTENT, 'utf8');
  }

  return samplePath;
}

/**
 * @param {string} testFileDir Directory containing the calling test file (usually test/)
 * @param {string} fileName
 * @param {string[]} lines
 * @returns {string} Absolute path to the written batch file
 */
function createIntegrationTempBatch(testFileDir, fileName, lines) {
  const repoRoot = path.resolve(testFileDir, '..');
  const tmpDir = path.join(repoRoot, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, fileName);
  const content = `${lines.join('\r\n')}\r\n`;
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/**
 * @param {string} testFileDir Directory containing the calling test file (usually test/)
 * @returns {string} Absolute path to sample1.cmd
 */
function integrationSamplePath(testFileDir) {
  const repoRoot = path.resolve(testFileDir, '..');
  return ensureIntegrationSampleFile(repoRoot);
}

module.exports = {
  ensureIntegrationSampleFile,
  integrationSamplePath,
  createIntegrationTempBatch,
  SAMPLE_CONTENT,
};
