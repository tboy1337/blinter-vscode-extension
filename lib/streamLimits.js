/** Shared caps for Blinter child-process stdout/stderr ingestion. */
const STDERR_CAP = 64 * 1024;
const STDOUT_BUFFER_CAP = 64 * 1024;
const STDOUT_MAX_LINES = 10000;

module.exports = {
  STDERR_CAP,
  STDOUT_BUFFER_CAP,
  STDOUT_MAX_LINES
};
