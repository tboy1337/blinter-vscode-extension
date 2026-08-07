const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const runTest = path.join(repoRoot, 'test', 'runTest.js');

const result = spawnSync(process.execPath, [runTest], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    BLINTER_INTEGRATION_ONLY: '1'
  }
});

process.exit(result.status ?? 1);
