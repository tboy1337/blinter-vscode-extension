const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const unitTests = require('./unit-test-files');

const repoRoot = path.join(__dirname, '..');

const c8Bin = require.resolve('c8/bin/c8.js');
const mochaBin = require.resolve('mocha/bin/mocha.js');

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit'
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

const coverageDir = path.join(repoRoot, 'coverage');
if (fs.existsSync(coverageDir)) {
  fs.rmSync(coverageDir, { recursive: true, force: true });
}

run(process.execPath, [c8Bin, mochaBin, ...unitTests]);
run(process.execPath, [path.join(__dirname, 'check-coverage.js')]);
