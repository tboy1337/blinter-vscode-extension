const path = require('path');
const { spawnSync } = require('child_process');
const unitTests = require('./unit-test-files');

const repoRoot = path.join(__dirname, '..');
const mochaBin = require.resolve('mocha/bin/mocha.js');

const result = spawnSync(process.execPath, [mochaBin, ...unitTests], {
  cwd: repoRoot,
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
