const assert = require('assert');
const path = require('path');
const { findBlinterExecutable } = require('../lib/discovery');

describe('Discovery tests', () => {
  it('returns vendor path when vendored executable exists', () => {
    const fakeExists = (p) => p.indexOf(path.join('vendor', 'Blinter', 'Blinter.exe')) !== -1;
    const res = findBlinterExecutable('root', 'win32', fakeExists);
    assert.ok(res && res.indexOf(path.join('vendor', 'Blinter', 'Blinter.exe')) !== -1, 'Expected vendor path');
  });

  it('returns bin path when vendor missing but bin contains executable', () => {
    const fakeExists = (p) => p.indexOf(path.join('bin', 'blinter.exe')) !== -1;
    const res = findBlinterExecutable('root', 'win32', fakeExists);
    assert.ok(res && res.indexOf(path.join('bin', 'blinter.exe')) !== -1, 'Expected bin path');
  });

  it('returns bins path when vendor and bin missing but bins contains executable', () => {
    const fakeExists = (p) => p.indexOf(path.join('bins', 'blinter.exe')) !== -1;
    const res = findBlinterExecutable('root', 'win32', fakeExists);
    assert.ok(res && res.indexOf(path.join('bins', 'blinter.exe')) !== -1, 'Expected bins path');
  });

  it('returns configured binaryPath when present', () => {
    const relativePath = path.join('custom', 'blinter.exe');
    const expected = path.join('root', relativePath);
    const fakeExists = (p) => p === expected;
    const res = findBlinterExecutable('root', 'win32', fakeExists, { binaryPath: relativePath });
    assert.strictEqual(res, expected);
  });

  it('returns blinter.exe when useSystemBlinter is enabled and no bundled binary exists', () => {
    const fakeExists = () => false;
    const res = findBlinterExecutable('root', 'win32', fakeExists, { useSystemBlinter: true });
    assert.strictEqual(res, 'blinter.exe');
  });

  it('returns null when no executable present', () => {
    const fakeExists = () => false;
    const res = findBlinterExecutable('root', 'win32', fakeExists);
    assert.strictEqual(res, null);
  });

  it('rejects configured binaryPath that escapes extension root', () => {
    const fakeExists = (p) => p.indexOf('outside') !== -1;
    const res = findBlinterExecutable('root', 'win32', fakeExists, {
      binaryPath: '..\\outside\\blinter.exe'
    });
    assert.strictEqual(res, null);
  });
});
