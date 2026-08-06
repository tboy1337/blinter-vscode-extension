const path = require('path');

/** @typedef {import('../types/blinter').AnalyzeLineOptions} AnalyzeLineOptions */
/** @typedef {import('../types/blinter').BlinterIssue} BlinterIssue */

const ERROR_LINE_RE = /^(?<file>.+?):(?<line>\d+):\s*(?<severity>error|warning|info)\s*:?\s*(?<message>.+)$/i;
const BRACKETED_RE = /^\s*\[(?<severity>info|warn|warning|error|fatal)\]\s*\((?<code>[^)]+)\)\s*->\s*(?<message>.+?)(?:\s+on\s+line\s+(?<line>\d+))?$/i;
const DETAILED_LINE_RE = /^\s*Line\s+(?<line>\d+):\s+(?<message>.+?)\s*\((?<code>[A-Za-z0-9_+-]+)\)\s*$/i;
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

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeSeverity(value) {
    if (!value) {return 'error';}
    const severity = value.toString().toLowerCase();
    if (severity === 'info' || severity === 'information') {return 'information';}
    if (severity === 'warn' || severity === 'warning') {return 'warning';}
    return 'error';
}

/**
 * @param {unknown} code
 * @returns {string}
 */
function severityFromCode(code) {
    const normalized = String(code || '').toUpperCase();
    if (normalized.startsWith('E')) {return 'error';}
    if (normalized.startsWith('W') || normalized.startsWith('SEC')) {return 'warning';}
    return 'information';
}

/**
 * @param {unknown} severity
 * @returns {boolean}
 */
function isInfoSeverity(severity) {
    return normalizeSeverity(severity) === 'information';
}

/**
 * @param {unknown} message
 * @param {unknown} severity
 * @returns {{ classification: string, isCritical: boolean }}
 */
function classifyMessage(message, severity) {
    const infoSeverity = isInfoSeverity(severity);
    if (!message) {
        return { classification: infoSeverity ? 'Info' : 'General', isCritical: !infoSeverity };
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
    return { classification: 'General', isCritical: true };
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

/**
 * @param {string} line
 * @param {AnalyzeLineOptions} options
 * @returns {{ issues: BlinterIssue[] }}
 */
function analyzeLine(line, options) {
    const { workspaceRoot, defaultFile, variableIndex } = options;

    const trimmed = line.replace(/\r?\n$/, '');
    const issues = [];
    let consumed = false;

    const setMatch = trimmed.match(SET_VAR_RE);
    if (setMatch && setMatch.groups && setMatch.groups.name) {
        const name = setMatch.groups.name.toUpperCase();
        addVariableEvent(variableIndex, name, {
            file: defaultFile ? path.normalize(defaultFile) : undefined,
            line: undefined,
            value: setMatch.groups.value ? setMatch.groups.value.trim() : ''
        });
    }

    const detailed = trimmed.match(DETAILED_LINE_RE);
    if (detailed && detailed.groups) {
        consumed = true;
        const lineNumber = parseInt(detailed.groups.line, 10);
        const code = detailed.groups.code.trim();
        const message = detailed.groups.message.trim();
        const filePath = resolveFile(defaultFile, workspaceRoot, defaultFile);

        issues.push(createIssue({
            severity: severityFromCode(code),
            message,
            code,
            filePath,
            lineNumber,
            variableIndex
        }));
    }

    const bracketed = trimmed.match(BRACKETED_RE);
    if (!consumed && bracketed && bracketed.groups) {
        consumed = true;
        const filePath = resolveFile(defaultFile, workspaceRoot, defaultFile);
        const lineNumber = bracketed.groups.line ? parseInt(bracketed.groups.line, 10) : 1;
        issues.push(createIssue({
            severity: normalizeSeverity(bracketed.groups.severity),
            message: bracketed.groups.message.trim(),
            code: bracketed.groups.code,
            filePath,
            lineNumber,
            variableIndex
        }));
    }

    const general = trimmed.match(ERROR_LINE_RE);
    if (!consumed && general && general.groups) {
        const filePath = resolveFile(general.groups.file, workspaceRoot, defaultFile);
        const lineNumber = parseInt(general.groups.line, 10);
        issues.push(createIssue({
            severity: normalizeSeverity(general.groups.severity),
            message: general.groups.message.trim(),
            filePath,
            lineNumber,
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
                    if (!entry) {return '';}
                    const parts = [];
                    if (entry.file) {parts.push(path.basename(entry.file));}
                    if (entry.line != null) {parts.push(`line ${entry.line}`);}
                    if (entry.value) {parts.push(`= ${entry.value}`);}
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
 * @param {import('fs')} fsModule
 * @returns {Map<string, Array<{ file?: string, line?: number, value?: string }>>}
 */
function buildVariableIndexFromFile(filePath, fsModule) {
    const map = new Map();
    if (!filePath || typeof filePath !== 'string' || !fsModule) {
        return map;
    }

    const normalizedFilePath = filePath;

    try {
        const content = fsModule.readFileSync(normalizedFilePath, 'utf8');
        const lines = content.split(/\r?\n/);
        lines.forEach((line, index) => {
            const match = line.match(/\bset\b\s+([A-Za-z0-9_]+)\s*=\s*(.*)$/i);
            if (!match) {
                return;
            }
            addVariableEvent(map, match[1].toUpperCase(), {
                file: path.normalize(normalizedFilePath),
                line: index + 1,
                value: match[2].trim()
            });
        });
    } catch {
        // Ignore read failures when building variable traces.
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
    createIssue
};
