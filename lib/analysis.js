const path = require('path');
const {
  parseLine,
  severityFromCode,
  normalizeSeverity,
  resolveFile
} = require('./issueParser');

/** @typedef {import('../types/blinter').AnalyzeLineOptions} AnalyzeLineOptions */
/** @typedef {import('../types/blinter').BlinterIssue} BlinterIssue */

const UNDEFINED_VAR_RE = /undefined\s+variable\s+'?(?<name>[A-Za-z0-9_]+)'?/i;
const SET_VAR_RE = /^\s*(?:setlocal\b.*|set\s+(?<name>[A-Za-z0-9_]+)\s*=\s*(?<value>.*))$/i;

const CRITICAL_KEYWORDS = [
  'undefined variable',
  'unreachable',
  'bad label',
  'invalid label',
  'infinite loop',
  'empty label',
  'syntax error',
  'deprecated',
  'duplicate label'
];

let issueId = 0;

function nextIssueId() {
  issueId += 1;
  return `issue-${issueId}`;
}

/** Reset issue ID counter for tests. */
function resetIssueIdCounter() {
  issueId = 0;
}

/**
 * @param {unknown} severity
 * @returns {boolean}
 */
function isInfoSeverity(severity) {
  const normalized = normalizeSeverity(severity);
  return normalized === 'information' || normalized === 'hint';
}

/**
 * @param {unknown} message
 * @param {unknown} severity
 * @returns {{ classification: string, isCritical: boolean }}
 */
function classifyMessage(message, severity) {
  const normalizedSeverity = normalizeSeverity(severity);
  const infoSeverity = isInfoSeverity(normalizedSeverity);
  if (!message) {
    return { classification: infoSeverity ? 'Info' : 'General', isCritical: normalizedSeverity === 'error' };
  }

  const normalizedMessage = String(message).toLowerCase();
  if (normalizedMessage.includes('undefined variable')) {
    return { classification: 'UndefinedVariable', isCritical: true };
  }
  if (normalizedMessage.includes('infinite loop')) {
    return { classification: 'PossibleInfiniteLoop', isCritical: true };
  }
  if (normalizedMessage.includes('bad label')
    || normalizedMessage.includes('invalid label')
    || normalizedMessage.includes('duplicate label')
    || normalizedMessage.includes('empty label')) {
    return { classification: 'BadLabel', isCritical: true };
  }
  if (normalizedMessage.includes('syntax')) {
    return { classification: 'SyntaxWarning', isCritical: true };
  }
  if (normalizedMessage.includes('deprecated')) {
    return { classification: 'Deprecated', isCritical: !infoSeverity };
  }
  if (CRITICAL_KEYWORDS.some((keyword) => normalizedMessage.includes(keyword))) {
    return { classification: 'Heuristic', isCritical: true };
  }
  if (infoSeverity) {
    return { classification: 'Info', isCritical: false };
  }
  if (normalizedSeverity === 'error') {
    return { classification: 'General', isCritical: true };
  }
  return { classification: 'General', isCritical: false };
}

/**
 * @param {string} line
 * @param {AnalyzeLineOptions} options
 * @returns {{ issues: BlinterIssue[] }}
 */
function analyzeLine(line, options) {
  const { workspaceRoot, defaultFile, variableIndex } = options;
  const trimmed = line.replace(/\r?\n$/, '');
  const issues = [];

  const setMatch = trimmed.match(SET_VAR_RE);
  if (setMatch && setMatch.groups && setMatch.groups.name) {
    const name = setMatch.groups.name.toUpperCase();
    addVariableEvent(variableIndex, name, {
      file: defaultFile ? path.normalize(defaultFile) : undefined,
      line: undefined,
      value: setMatch.groups.value ? setMatch.groups.value.trim() : ''
    });
  }

  const parsed = parseLine(trimmed, { workspaceRoot, defaultFile });
  if (parsed) {
    issues.push(createIssue({
      severity: parsed.severity,
      message: parsed.message,
      code: parsed.code,
      filePath: parsed.filePath,
      lineNumber: parsed.line,
      variableIndex
    }));
  }

  return { issues };
}

/**
 * @param {{
 *   severity: unknown,
 *   message: unknown,
 *   filePath?: string,
 *   lineNumber: unknown,
 *   code?: string,
 *   variableIndex?: Map<string, Array<{ file?: string, line?: number, value?: string }>>
 * }} params
 * @returns {BlinterIssue}
 */
function createIssue({ severity, message, filePath, lineNumber, code = undefined, variableIndex }) {
  const normalizedSeverity = normalizeSeverity(severity);
  const safeMessage = typeof message === 'string' ? message : '';
  const { classification, isCritical } = classifyMessage(safeMessage, normalizedSeverity);

  let variableName;
  const variableMatch = safeMessage.toLowerCase().match(UNDEFINED_VAR_RE);
  if (variableMatch && variableMatch.groups && variableMatch.groups.name) {
    variableName = variableMatch.groups.name.toUpperCase();
  }

  let variableTrace;
  if (variableName && variableIndex) {
    const trace = variableIndex.get(variableName);
    if (trace && trace.length) {
      variableTrace = trace
        .map((entry) => {
          if (!entry) { return ''; }
          const parts = [];
          if (entry.file) { parts.push(path.basename(entry.file)); }
          if (entry.line != null) { parts.push(`line ${entry.line}`); }
          if (entry.value) { parts.push(`= ${entry.value}`); }
          return parts.join(' ');
        })
        .filter(Boolean);
    }
  }

  const normalizedLine = Number.isFinite(Number(lineNumber)) ? Math.max(1, Number(lineNumber)) : 1;
  const lineIndex = normalizedLine - 1;

  return {
    id: nextIssueId(),
    severity: normalizedSeverity,
    classification,
    isCritical,
    message: safeMessage,
    code,
    filePath: filePath ? path.normalize(filePath) : undefined,
    line: normalizedLine,
    range: {
      start: { line: lineIndex, character: 0 },
      end: { line: lineIndex, character: Number.MAX_SAFE_INTEGER }
    },
    variableName,
    variableTrace
  };
}

/**
 * @param {Map<string, Array<{ file?: string, line?: number, value?: string }>> | undefined} variableIndex
 * @param {string} variableName
 * @param {{ file?: string, line?: number, value?: string }} record
 */
function addVariableEvent(variableIndex, variableName, record) {
  if (!variableName || !variableIndex) {
    return;
  }
  const key = variableName.toUpperCase();
  if (!variableIndex.has(key)) {
    variableIndex.set(key, []);
  }
  const entries = variableIndex.get(key);
  if (entries) {
    entries.push(record);
  }
}

/**
 * @param {unknown} filePath
 * @param {typeof import('fs')} fsModule
 * @returns {Map<string, Array<{ file?: string, line?: number, value?: string }>>}
 */
function buildVariableIndexFromFile(filePath, fsModule) {
  const map = new Map();
  if (!filePath || typeof filePath !== 'string' || !fsModule) {
    return map;
  }

  try {
    const content = fsModule.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((/** @type {string} */ line, /** @type {number} */ index) => {
      const match = line.match(/\bset\b\s+([A-Za-z0-9_]+)\s*=\s*(.*)$/i);
      if (!match) {
        return;
      }
      addVariableEvent(map, match[1].toUpperCase(), {
        file: path.normalize(filePath),
        line: index + 1,
        value: match[2].trim()
      });
    });
  } catch (error) {
    if (process.env.BLINTER_TEST_MODE === '1') {
      console.debug(`[analysis] Failed to build variable index for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return map;
}

module.exports = {
  analyzeLine,
  buildVariableIndexFromFile,
  classifyMessage,
  normalizeSeverity,
  severityFromCode,
  resolveFile,
  addVariableEvent,
  createIssue,
  resetIssueIdCounter
};
