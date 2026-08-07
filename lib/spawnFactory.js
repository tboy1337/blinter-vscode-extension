const cp = require('child_process');
const { EventEmitter } = require('events');

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import('child_process').SpawnOptions} options
 * @returns {import('child_process').ChildProcess}
 */
function createSpawnImpl(command, args, options) {
  if (process.env.BLINTER_TEST_MODE === '1') {
    const fake = /** @type {import('child_process').ChildProcess} */ (/** @type {unknown} */ (Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { setEncoding: () => { } }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: () => { } }),
      kill: function kill() { this.killed = true; },
      killed: false,
      pid: 12345
    })));
    setTimeout(() => {
      if (fake.stdout) {
        fake.stdout.emit('data', 'Line 2: Errorlevel handling difference between .bat/.cmd (W028)\n');
        fake.stdout.emit('data', 'Line 1: BAT extension used instead of CMD for newer Windows (S007)\n');
      }
      fake.emit('close', 0);
    }, 10);
    return fake;
  }
  return cp.spawn(command, args, options);
}

module.exports = {
  createSpawnImpl
};
