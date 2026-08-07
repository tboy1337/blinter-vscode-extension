const fs = require('fs');
const path = require('path');

const THRESHOLD = 95;
const lcovPath = path.join(__dirname, '..', 'coverage', 'lcov.info');
const libDir = path.join(__dirname, '..', 'lib');

const targets = [
  'extension.js',
  ...fs.readdirSync(libDir)
    .filter((file) => file.endsWith('.js'))
    .sort()
    .map((file) => `lib/${file}`)
];

/**
 * @typedef {{ lines: { hit: number, total: number }, branches: { hit: number, total: number }, functions: { hit: number, total: number } }} FileMetrics
 */

/**
 * @param {string} content
 * @returns {Map<string, FileMetrics>}
 */
function parseLcov(content) {
  const files = new Map();
  let currentFile = null;

  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      currentFile = line.slice(3).replace(/\\/g, '/');
      files.set(currentFile, {
        lines: { hit: 0, total: 0 },
        branches: { hit: 0, total: 0 },
        functions: { hit: 0, total: 0 }
      });
      continue;
    }
    if (!currentFile || !files.has(currentFile)) {
      continue;
    }
    const metrics = files.get(currentFile);
    if (!metrics) {
      continue;
    }
    if (line.startsWith('DA:')) {
      const [, hitFlag] = line.slice(3).split(',');
      metrics.lines.total += 1;
      if (Number(hitFlag) > 0) {
        metrics.lines.hit += 1;
      }
    } else if (line.startsWith('BRDA:')) {
      const parts = line.slice(5).split(',');
      const taken = Number(parts[3]);
      metrics.branches.total += 1;
      if (taken > 0) {
        metrics.branches.hit += 1;
      }
    } else if (line.startsWith('FNDA:')) {
      const match = line.match(/^FNDA:(\d+),(.*)$/);
      if (match) {
        metrics.functions.total += 1;
        if (Number(match[1]) > 0) {
          metrics.functions.hit += 1;
        }
      }
    } else if (line === 'end_of_record') {
      currentFile = null;
    }
  }

  return files;
}

/**
 * @param {number} hit
 * @param {number} total
 * @returns {number}
 */
function percent(hit, total) {
  if (total === 0) {
    return 100;
  }
  return (hit / total) * 100;
}

/**
 * @param {string} label
 * @param {number} hit
 * @param {number} total
 */
function reportMetrics(label, hit, total) {
  const value = percent(hit, total);
  console.log(`${label}: ${value.toFixed(2)}% (${hit}/${total})`);
}

/**
 * @param {string} label
 * @param {number} hit
 * @param {number} total
 * @param {number} [threshold]
 * @returns {boolean}
 */
function checkMetrics(label, hit, total, threshold = THRESHOLD) {
  const value = percent(hit, total);
  const pass = value >= threshold;
  console.log(`${label}: ${value.toFixed(2)}% (${hit}/${total}) ${pass ? 'OK' : 'FAIL'}`);
  return pass;
}

if (!fs.existsSync(lcovPath)) {
  console.error(`Missing coverage report at ${lcovPath}`);
  process.exit(1);
}

const files = parseLcov(fs.readFileSync(lcovPath, 'utf8'));

let ok = true;
const aggregate = {
  lines: { hit: 0, total: 0 },
  branches: { hit: 0, total: 0 },
  functions: { hit: 0, total: 0 }
};

for (const [filePath, metrics] of files.entries()) {
  const normalized = filePath.replace(/\\/g, '/');
  if (!targets.some((target) => normalized.endsWith(target))) {
    continue;
  }
  console.log(`\n${normalized}`);
  reportMetrics('  lines', metrics.lines.hit, metrics.lines.total);
  reportMetrics('  statements', metrics.lines.hit, metrics.lines.total);
  reportMetrics('  branches', metrics.branches.hit, metrics.branches.total);
  reportMetrics('  functions', metrics.functions.hit, metrics.functions.total);

  aggregate.lines.hit += metrics.lines.hit;
  aggregate.lines.total += metrics.lines.total;
  aggregate.branches.hit += metrics.branches.hit;
  aggregate.branches.total += metrics.branches.total;
  aggregate.functions.hit += metrics.functions.hit;
  aggregate.functions.total += metrics.functions.total;
}

console.log('\nAggregate included files');
ok = checkMetrics('lines', aggregate.lines.hit, aggregate.lines.total) && ok;
ok = checkMetrics('statements', aggregate.lines.hit, aggregate.lines.total) && ok;
ok = checkMetrics('branches', aggregate.branches.hit, aggregate.branches.total) && ok;
ok = checkMetrics('functions', aggregate.functions.hit, aggregate.functions.total) && ok;

if (!ok) {
  process.exit(1);
}
