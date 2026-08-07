const path = require('path');

const DETAILED_HEADER_RE = /^\s*Line\s+(\d+):\s*(.+?)\s*\(([A-Za-z0-9_+-]+)\)\s*$/i;
const DETAIL_LINE_RE = /^[-\s]+([^:]+):\s*(.*)$/;
const ERROR_LINE_RE = /^(?<file>.+?):(?<line>\d+):\s*(?<severity>error|warning|info|hint)\s*:?\s*(?<message>.+)$/i;
const BRACKETED_RE = /^\s*\[(?<severity>info|warn|warning|error|fatal|hint)\]\s*\((?<code>[^)]+)\)\s*->\s*(?<message>.+?)(?:\s+on\s+line\s+(?<line>\d+))?$/i;
const DETAILED_LINE_RE = /^\s*Line\s+(?<line>\d+):\s+(?<message>.+?)\s*\((?<code>[A-Za-z0-9_+-]+)\)\s*$/i;

/**
 * @param {unknown} value
 * @returns {string}
 */
function mapSeverityFromLegacy(value) {
  const severity = String(value || '').toUpperCase();
  if (severity === 'INFO') { return 'information'; }
  if (severity === 'WARN' || severity === 'WARNING') { return 'warning'; }
  return 'error';
}

/**
 * @param {unknown} code
 * @returns {string}
 */
function severityFromCode(code) {
  if (!code) { return 'information'; }
  const normalized = String(code).toUpperCase();
  if (normalized.startsWith('E')) { return 'error'; }
  if (normalized.startsWith('W') || normalized.startsWith('SEC')) { return 'warning'; }
  if (normalized.startsWith('S')) { return 'information'; }
  if (normalized.startsWith('P')) { return 'hint'; }
  return 'information';
}

/**
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function safeLineNumber(value, fallback = 1) {
  const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeSeverity(value) {
  if (!value) { return 'error'; }
  const severity = String(value).toLowerCase();
  if (severity === 'info' || severity === 'information') { return 'information'; }
  if (severity === 'warn' || severity === 'warning') { return 'warning'; }
  if (severity === 'hint') { return 'hint'; }
  if (severity === 'error' || severity === 'fatal') { return 'error'; }
  return 'error';
}

/**
 * @param {unknown} stdout
 * @param {AnalyzeLineOptions & { defaultFile?: string }} [context]
 * @returns {Array<{ severity: string, code: string, description: string, line: number, filePath?: string, details?: Array<{ label: string, detail: string }> }>}
 */
function parseOutput(stdout, context = {}) {
  /** @type {Array<{ severity: string, code: string, description: string, line: number, filePath?: string, details?: Array<{ label: string, detail: string }> }>} */
  const issues = [];
  if (!stdout) {
    return issues;
  }

  const rawLines = String(stdout).split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i].trim();
    if (!line) {
      continue;
    }

    const detailedMatch = DETAILED_HEADER_RE.exec(line);
    if (detailedMatch) {
      const [, lineNumber, message, code] = detailedMatch;
      const details = [];
      let description = message;

      while (i + 1 < rawLines.length && DETAIL_LINE_RE.test(rawLines[i + 1])) {
        const detailMatch = DETAIL_LINE_RE.exec(rawLines[++i]);
        const label = detailMatch && detailMatch[1] ? detailMatch[1].trim() : '';
        const detail = detailMatch && detailMatch[2] ? detailMatch[2].trim() : '';
        details.push({ label, detail });
        if (label || detail) {
          description += `\n${label}: ${detail}`;
        }
      }

      issues.push({
        severity: severityFromCode(code),
        code,
        description,
        line: safeLineNumber(lineNumber),
        filePath: resolveFile(context.defaultFile, context.workspaceRoot, context.defaultFile),
        details
      });
      continue;
    }

    const parsed = parseLine(line, context);
    if (parsed) {
      issues.push({
        severity: parsed.severity,
        code: parsed.code || '',
        description: parsed.message,
        line: parsed.line,
        filePath: parsed.filePath
      });
    }
  }

  return issues;
}

/**
 * @typedef {import('../types/blinter').AnalyzeLineOptions} AnalyzeLineOptions
 */

/**
 * @param {string} line
 * @param {AnalyzeLineOptions & { defaultFile?: string }} [context]
 * @returns {{ severity: string, code?: string, message: string, line: number, filePath?: string } | undefined}
 */
function parseLine(line, context = {}) {
  const trimmed = line.replace(/\r?\n$/, '');

  const detailed = trimmed.match(DETAILED_LINE_RE);
  if (detailed && detailed.groups) {
    return {
      severity: severityFromCode(detailed.groups.code),
      code: detailed.groups.code.trim(),
      message: detailed.groups.message.trim(),
      line: safeLineNumber(detailed.groups.line),
      filePath: resolveFile(context.defaultFile, context.workspaceRoot, context.defaultFile)
    };
  }

  const bracketed = trimmed.match(BRACKETED_RE);
  if (bracketed && bracketed.groups) {
    return {
      severity: normalizeSeverity(bracketed.groups.severity),
      code: bracketed.groups.code,
      message: bracketed.groups.message.trim(),
      line: bracketed.groups.line ? safeLineNumber(bracketed.groups.line) : 1,
      filePath: resolveFile(context.defaultFile, context.workspaceRoot, context.defaultFile)
    };
  }

  const general = trimmed.match(ERROR_LINE_RE);
  if (general && general.groups) {
    return {
      severity: normalizeSeverity(general.groups.severity),
      message: general.groups.message.trim(),
      line: safeLineNumber(general.groups.line),
      filePath: resolveFile(general.groups.file, context.workspaceRoot, context.defaultFile)
    };
  }

  return undefined;
}

/**
 * @param {unknown} fileText
 * @param {unknown} workspaceRoot
 * @param {unknown} defaultFile
 * @returns {string | undefined}
 */
function resolveFile(fileText, workspaceRoot, defaultFile) {
  const fileTextString = typeof fileText === 'string' ? fileText : '';
  if (fileTextString && path.isAbsolute(fileTextString)) {
    return path.normalize(fileTextString);
  }

  const trimmed = fileTextString.trim();
  if (!trimmed) {
    return typeof defaultFile === 'string' ? path.normalize(defaultFile) : undefined;
  }

  if (workspaceRoot && typeof workspaceRoot === 'string') {
    return path.normalize(path.join(workspaceRoot, trimmed));
  }
  if (defaultFile && typeof defaultFile === 'string') {
    return path.normalize(path.join(path.dirname(defaultFile), trimmed));
  }
  return path.normalize(trimmed);
}

module.exports = {
  parseOutput,
  parseLine,
  parseBlinterOutput: parseOutput,
  mapSeverityFromLegacy,
  mapSeverityFromCode: severityFromCode,
  severityFromCode,
  normalizeSeverity,
  safeLineNumber,
  resolveFile
};
