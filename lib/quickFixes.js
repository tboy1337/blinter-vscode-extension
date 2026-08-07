const vscode = require('vscode');
const { isBatchLanguageId } = require('./utils');

function createQuickFixProvider() {
  return {
    provideCodeActions: (/** @type {import('vscode').TextDocument} */ document, /** @type {import('vscode').Range} */ range, /** @type {import('vscode').CodeActionContext} */ context) => {
      if (!isBatchLanguageId(document.languageId)) {
        return [];
      }

      const actions = [];
      const config = vscode.workspace.getConfiguration('blinter', document.uri);
      const allowedCodes = config.get('quickFixCodes', ['BLINTER_CASE', 'CMD_CASE', 'CASE001']);

      for (const diag of context.diagnostics) {
        const code = diag.code ? String(diag.code) : '';
        const message = diag.message ? String(diag.message).toLowerCase() : '';

        const codeMatches = code && Array.isArray(allowedCodes) && allowedCodes.includes(code);
        const messageHintsCase = message.includes('case') || message.includes('casing');
        if (!codeMatches && !messageHintsCase) {
          continue;
        }

        const lineIndex = diag.range && diag.range.start ? diag.range.start.line : range.start.line;
        if (lineIndex < 0 || lineIndex >= document.lineCount) {
          continue;
        }
        const lineText = document.lineAt(lineIndex).text;
        const match = /^\s*([A-Za-z0-9_@]+)(\b.*)$/m.exec(lineText);
        if (!match) {
          continue;
        }

        const commandToken = match[1];
        const rest = match[2] || '';
        const fixed = commandToken.toLowerCase() + rest;

        const fix = new vscode.CodeAction('Normalize command casing', vscode.CodeActionKind.QuickFix);
        fix.edit = new vscode.WorkspaceEdit();
        fix.edit.replace(document.uri, document.lineAt(lineIndex).range, fixed);
        fix.diagnostics = [diag];
        fix.isPreferred = true;
        actions.push(fix);
      }

      return actions;
    }
  };
}

function createSuppressionProvider() {
  return {
    provideCodeActions: (/** @type {import('vscode').TextDocument} */ document, /** @type {import('vscode').Range} */ range, /** @type {import('vscode').CodeActionContext} */ context) => {
      if (!isBatchLanguageId(document.languageId)) {
        return [];
      }

      const blinterDiags = context.diagnostics.filter((/** @type {vscode.Diagnostic} */ d) => d.source === 'blinter' && d.code);
      if (blinterDiags.length === 0) {
        return [];
      }

      const config = vscode.workspace.getConfiguration('blinter', document.uri);
      const commentStyle = config.get('suppressionCommentStyle', 'REM') || 'REM';
      const showAskCopilotQuickFix = config.get('showAskCopilotQuickFix', false);
      const actions = [];

      const codes = [...new Set(blinterDiags.map((/** @type {vscode.Diagnostic} */ d) => String(d.code)))];
      const codeList = codes.join(', ');

      const lineIndex = (blinterDiags[0] && blinterDiags[0].range ? blinterDiags[0].range.start.line : range.start.line);
      const lineText = document.lineAt(lineIndex).text;
      const indent = (lineText.match(/^(\s*)/) || [''])[0];
      const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

      {
        const label = codes.length === 1
          ? `Blinter: Suppress ${codes[0]} on this line`
          : `Blinter: Suppress ${codeList} on this line`;
        const action = new vscode.CodeAction(label, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.diagnostics = [...blinterDiags];

        if (lineIndex > 0) {
          const aboveLine = document.lineAt(lineIndex - 1).text;
          const ignoreMatch = aboveLine.match(/(?:REM|::)\s+LINT:IGNORE\s+(.*)/i);
          if (ignoreMatch) {
            const existingCodes = ignoreMatch[1].split(',').map((/** @type {string} */ c) => c.trim());
            const allCodes = [...new Set([...existingCodes, ...codes])];
            const newComment = `${commentStyle} LINT:IGNORE ${allCodes.join(', ')}`;
            const commentStart = aboveLine.search(/(?:REM|::)\s+LINT:IGNORE\s/i);
            const replaceRange = new vscode.Range(lineIndex - 1, commentStart, lineIndex - 1, aboveLine.length);
            action.edit.replace(document.uri, replaceRange, newComment);
            actions.push(action);
          } else {
            const insertPos = new vscode.Position(lineIndex, 0);
            action.edit.insert(document.uri, insertPos, `${indent}${commentStyle} LINT:IGNORE ${codeList}${eol}`);
            actions.push(action);
          }
        } else {
          const insertPos = new vscode.Position(lineIndex, 0);
          action.edit.insert(document.uri, insertPos, `${indent}${commentStyle} LINT:IGNORE ${codeList}${eol}`);
          actions.push(action);
        }
      }

      if (showAskCopilotQuickFix) {
        const label = codes.length === 1
          ? `Blinter: Ask Copilot about ${codes[0]}`
          : `Blinter: Ask Copilot about ${codeList}`;
        const action = new vscode.CodeAction(label, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [...blinterDiags];
        action.command = {
          title: label,
          command: 'blinter.askCopilot',
          arguments: [{
            uri: document.uri.toString(),
            codeList,
            message: blinterDiags[0] ? blinterDiags[0].message : '',
            line: lineIndex + 1,
            lineText: lineText.trim()
          }]
        };
        actions.push(action);
      }

      return actions;
    }
  };
}

module.exports = {
  createQuickFixProvider,
  createSuppressionProvider
};
