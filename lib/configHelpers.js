/**
 * Config coercion helpers without vscode dependency (safe for lib unit tests).
 */

/**
 * @param {{ get: (key: string, defaultValue?: unknown) => unknown }} config
 */
function getDebounceDelay(config) {
  const raw = config.get('debounceDelay', 500);
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    return 500;
  }
  return raw;
}

/**
 * @param {{ get: (key: string, defaultValue?: unknown) => unknown }} config
 */
function getProcessTimeoutMs(config) {
  const raw = config.get('processTimeoutMs', 120000);
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return 120000;
  }
  return raw;
}

/**
 * @param {{ get: (key: string, defaultValue?: unknown) => unknown }} config
 */
function coerceMaxLineLength(config) {
  const raw = config.get('maxLineLength', 100);
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return 100;
  }
  return Math.floor(raw);
}

/**
 * @param {{ get: (key: string, defaultValue?: unknown) => unknown }} config
 * @param {string} key
 * @returns {string[]}
 */
function sanitizeRuleList(config, key) {
  const raw = config.get(key, []);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

module.exports = {
  getDebounceDelay,
  getProcessTimeoutMs,
  coerceMaxLineLength,
  sanitizeRuleList
};
