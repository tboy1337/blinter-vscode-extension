const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const unitTests = [
  'test/parser.test.js',
  'test/blinterRunner.test.js',
  'test/analysis.test.js',
  'test/debugAdapter.test.js',
  'test/discovery.test.js',
  'test/smoke.test.js',
  'test/sanity.test.js',
  'test/regression.test.js',
  'test/security.test.js',
  'test/exploratory.test.js',
  'test/coverage.lib.test.js',
  'test/extension.unit.test.js',
  'test/extension.branches.test.js'
];

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    shell: true,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

const coverageDir = path.join(repoRoot, 'coverage');
if (fs.existsSync(coverageDir)) {
  fs.rmSync(coverageDir, { recursive: true, force: true });
}

run('npx', ['c8', 'mocha', ...unitTests]);
run('node', ['./tools/check-coverage.js']);
