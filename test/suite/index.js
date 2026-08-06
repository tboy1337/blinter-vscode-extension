const fs = require('fs');
const path = require('path');
const Mocha = require('mocha');

function collectTestFiles(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

function run() {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true
  });

  try {
    require('mocha/lib/interfaces/bdd')(mocha.suite);
    require('mocha/lib/interfaces/tdd')(mocha.suite);
  } catch {
    if (typeof global.describe === 'function') {global.suite = global.describe;}
    if (typeof global.it === 'function') {global.test = global.it;}
  }

  const testsRoot = path.resolve(__dirname, '..');
  let files = collectTestFiles(testsRoot);
  if (process.env.BLINTER_INTEGRATION_ONLY === '1') {
    files = files.filter((filePath) => /integration|bugfix-auto-focus/.test(filePath));
  }

  return new Promise((resolve, reject) => {
    try {
      files.forEach((filePath) => mocha.addFile(filePath));

      mocha.run(failures => {
        if (failures > 0) {
          reject(new Error(`${failures} tests failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      console.error(err);
      reject(err);
    }
  });
}

module.exports = { run };
