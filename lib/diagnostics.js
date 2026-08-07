const vscode = require('vscode');

/** @typedef {import('../types/blinter').BlinterIssue} BlinterIssue */

/**
 * @param {BlinterIssue} a
 * @param {BlinterIssue} b
 */
function compareIssues(a, b) {
  /** @type {Record<string, number>} */
  const order = { error: 0, warning: 1, information: 2, info: 2, hint: 3 };
  const severityDelta = (order[String(a.severity)] ?? 3) - (order[String(b.severity)] ?? 3);
  if (severityDelta !== 0) {
    return severityDelta;
  }
  return (a.line || 0) - (b.line || 0);
}

/**
 * @param {BlinterIssue} issue
 * @param {import('vscode').TextDocument | undefined} [document]
 */
function issueToDiagnostic(issue, document) {
  /** @type {Record<string, vscode.DiagnosticSeverity>} */
  const severityMap = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
    information: vscode.DiagnosticSeverity.Information,
    hint: vscode.DiagnosticSeverity.Hint
  };

  const lineIndex = Math.max(0, (issue.line || 1) - 1);
  const startChar = issue.range?.start?.character ?? 0;
  let endChar = issue.range?.end?.character;
  if (endChar === undefined || endChar === Number.MAX_SAFE_INTEGER) {
    if (document && lineIndex < document.lineCount) {
      endChar = document.lineAt(lineIndex).range.end.character;
    } else {
      endChar = 200;
    }
  }

  const range = new vscode.Range(lineIndex, startChar, lineIndex, endChar);
  const diagnostic = new vscode.Diagnostic(
    range,
    issue.message,
    severityMap[issue.severity] ?? vscode.DiagnosticSeverity.Error
  );
  diagnostic.source = 'blinter';
  diagnostic.code = issue.code || issue.classification;
  return diagnostic;
}

module.exports = {
  compareIssues,
  issueToDiagnostic
};
