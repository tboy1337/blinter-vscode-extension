const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { BlinterOutputViewProvider } = require('./outputView');
const { BlinterDebugAdapterFactory } = require('./debugAdapter');
const { createQuickFixProvider: buildQuickFixProvider, createSuppressionProvider: buildSuppressionProvider } = require('./quickFixes');
const { lintDocument } = require('./lintService');
const { prepareForLaunch, acceptProcessText, resolveProgramPath: resolveProgramPathFromSession, addIssue: addDebugIssue } = require('./debugSession');
const { compareIssues, issueToDiagnostic } = require('./diagnostics');
const { cleanupSnapshots, releaseSnapshot, setErrorLogger: setSnapshotErrorLogger } = require('./documentSnapshot');
const { setErrorLogger: setCommandsErrorLogger } = require('./commands');
const { getBlinterConfig, getDebounceDelay, getIniPathForEditor } = require('./config');
const {
  isBatchDocument,
  normalizeFilePath,
  isInformationalSeverity,
  escapeMarkdown,
  isPathAllowed
} = require('./utils');

/** @typedef {import('../types/blinter').BlinterIssue} BlinterIssue */
/** @typedef {import('../types/blinter').SummaryGroup} SummaryGroup */
/** @typedef {import('../types/blinter').SummaryGroupItem} SummaryGroupItem */

/** @exports BlinterController */
class BlinterController {
  /** @param {import('vscode').ExtensionContext} context */
  constructor(context) {
    this.context = context;
    this.output = vscode.window.createOutputChannel('Blinter');
    this.lintDiagnostics = vscode.languages.createDiagnosticCollection('blinter');
    /** @type {Map<string, BlinterIssue[]>} */
    this.lintIssuesByFile = new Map();
    /** @type {Map<string, BlinterIssue[]>} */
    this.debugIssuesByFile = new Map();
    this.variableIndex = new Map();
    this.currentProgramPath = /** @type {string | undefined} */ (undefined);
    this.currentWorkspaceRoot = /** @type {string | undefined} */ (undefined);
    this.currentEncoding = 'utf8';
    this.currentSessionId = undefined;
    this.pendingUpdateTimer = undefined;
    /** @type {{ state: string, detail: string }} */
    this.lintStatus = { state: 'idle', detail: '' };
    /** @type {{ state: string, detail: string }} */
    this.debugStatus = { state: 'idle', detail: '' };
    this.lastExitCode = null;
    this._hasAutoShownOutputView = false;
    /** @type {vscode.StatusBarItem | undefined} */
    this.statusBarItem = undefined;
    /** @type {InstanceType<typeof BlinterOutputViewProvider> | undefined} */
    this.webviewProvider = undefined;
    this._currentLintHandle = /** @type {{ runId: number, filePath?: string, kill: () => void, cancel?: () => void } | null} */ (null);
    this._lintRunId = 0;
    /** @type {Map<string, NodeJS.Timeout>} */
    this._debounceTimers = new Map();

    this.decorationType = this.createDecorationType();
    this.suppressionDecorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(128, 128, 128, 0.12)',
      overviewRulerColor: 'rgba(128, 128, 128, 0.3)',
      overviewRulerLane: vscode.OverviewRulerLane.Center
    });
    this._decorationDisposable = this.decorationType;

    context.subscriptions.push(this.output);
    context.subscriptions.push(this.lintDiagnostics);
  }

  initialize() {
    const { context } = this;
    const logError = (/** @type {string} */ message) => this.log(message);
    setSnapshotErrorLogger(logError);
    setCommandsErrorLogger(logError);

    this.webviewProvider = new BlinterOutputViewProvider(context.extensionUri, this);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('blinter.outputSummary', this.webviewProvider));

    context.subscriptions.push(
      vscode.languages.registerHoverProvider(['bat', 'cmd'], {
        provideHover: (document, position) => this.provideHover(document, position)
      })
    );

    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(['bat', 'cmd'], buildQuickFixProvider(), {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
      })
    );

    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(['bat', 'cmd'], buildSuppressionProvider(), {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
      })
    );

    context.subscriptions.push(
      vscode.debug.registerDebugAdapterDescriptorFactory('blinter-debug', new BlinterDebugAdapterFactory(this))
    );

    context.subscriptions.push(
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.refreshDecorations();
        this.refreshSuppressionDecorations();
      })
    );

    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument((doc) => this.clearDocument(doc.uri))
    );

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('blinter.criticalHighlightColor')) {
          this.resetDecorationStyle();
        }
      })
    );

    context.subscriptions.push(
      vscode.debug.onDidStartDebugSession((session) => {
        if (session.type === 'blinter-debug') {
          this.lastExitCode = undefined;
          this.currentSessionId = session.id;
          this.webviewProvider?.ensureVisible();
        }
      })
    );

    context.subscriptions.push(
      vscode.debug.onDidTerminateDebugSession((session) => {
        if (session.type === 'blinter-debug') {
          if (this.debugStatus.state === 'running') {
            this.updateDebugStatus('errored', 'Debug session terminated');
          }
          this.clearDebugIssues();
          this.refreshDecorations();
          this.updateWebview();
          if (this.webviewProvider) {
            this.webviewProvider.updateStatus(this.getDisplayStatus());
          }
          this.currentSessionId = undefined;
        }
      })
    );

    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const config = getBlinterConfig(doc.uri);
        if (!config.get('enabled', true)) { return; }
        if (config.get('runOn', 'onSave') === 'onSave' && isBatchDocument(doc)) {
          void this.lintDocument(doc).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`[Linter] Save-triggered lint failed: ${message}`);
          });
        }
      })
    );

    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        const config = getBlinterConfig(e.document.uri);
        if (!config.get('enabled', true)) { return; }
        if (String(config.get('runOn', 'onSave')) !== 'onType') { return; }
        const doc = e.document;
        if (!isBatchDocument(doc)) { return; }

        const key = doc.uri.toString();
        if (this._debounceTimers.has(key)) {
          clearTimeout(this._debounceTimers.get(key));
        }
        const timeout = setTimeout(() => {
          void this.lintDocument(doc).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`[Linter] Type-triggered lint failed: ${message}`);
          });
          this._debounceTimers.delete(key);
        }, getDebounceDelay(config));
        this._debounceTimers.set(key, timeout);
      })
    );

    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    context.subscriptions.push(this.statusBarItem);
    this._updateConfigStatusBar();

    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this._updateConfigStatusBar();
        this.maybeEnsureOutputViewVisible(editor);
      })
    );
    context.subscriptions.push(vscode.workspace.onDidCreateFiles(() => this._updateConfigStatusBar()));
    context.subscriptions.push(vscode.workspace.onDidDeleteFiles(() => this._updateConfigStatusBar()));

    this.updateLintStatus('idle');
    this.updateWebview();
    this.refreshDecorations();
    this.maybeEnsureOutputViewVisible(vscode.window.activeTextEditor);
  }

  isDebugSessionActive() {
    return this.currentSessionId !== undefined;
  }

  /** Backward-compatible accessors for tests and integrations. */
  get issuesByFile() {
    return this.getActiveIssueMap();
  }

  get diagnostics() {
    return this.lintDiagnostics;
  }

  get status() {
    return this.getDisplayStatus();
  }

  /** @param {string} state @param {string} [detail] */
  updateStatus(state, detail) {
    if (this.isDebugSessionActive()) {
      this.updateDebugStatus(state, detail);
    } else {
      this.updateLintStatus(state, detail);
    }
  }

  clearIssues() {
    this.lintIssuesByFile.clear();
    this.debugIssuesByFile.clear();
    this.lintDiagnostics.clear();
    this.refreshDecorations();
    this.refreshSuppressionDecorations();
    this.updateWebview();
  }

  /** @param {string} program @param {string | undefined} workspaceFolder */
  resolveProgramPath(program, workspaceFolder) {
    return resolveProgramPathFromSession(program, workspaceFolder);
  }

  /** @param {import('vscode').TextEditor | undefined} editor */
  maybeEnsureOutputViewVisible(editor) {
    if (this._hasAutoShownOutputView) {
      return;
    }
    if (!editor || !isBatchDocument(editor.document)) {
      return;
    }
    this._hasAutoShownOutputView = true;
    this.webviewProvider?.ensureVisible();
  }

  _updateConfigStatusBar() {
    const statusBarItem = this.statusBarItem;
    if (!statusBarItem) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || !isBatchDocument(editor.document)) {
      statusBarItem.hide();
      return;
    }

    const iniPath = getIniPathForEditor(editor);
    if (!iniPath) {
      statusBarItem.hide();
      return;
    }

    if (fs.existsSync(iniPath)) {
      statusBarItem.text = '$(gear) blinter.ini';
      statusBarItem.tooltip = 'Workspace Blinter config active';
      statusBarItem.command = {
        command: 'vscode.open',
        arguments: [vscode.Uri.file(iniPath)],
        title: 'Open blinter.ini'
      };
    } else {
      statusBarItem.text = '$(circle-slash) No blinter.ini';
      statusBarItem.tooltip = 'Click to create a Blinter config file';
      statusBarItem.command = 'blinter.createConfig';
    }
    statusBarItem.show();
  }

  /** @param {Record<string, unknown>} [payload] */
  async askCopilotAboutDiagnostic(payload) {
    const info = payload || {};
    const codeList = typeof info.codeList === 'string' && info.codeList.trim() ? info.codeList.trim() : 'this Blinter issue';
    const message = typeof info.message === 'string' ? info.message.trim() : '';
    const line = typeof info.line === 'number' ? info.line : undefined;
    const lineText = typeof info.lineText === 'string' ? info.lineText : '';
    const uri = typeof info.uri === 'string' ? info.uri : '';

    const promptParts = [`Help me fix ${codeList} in my batch script.`];
    if (message) { promptParts.push(`Blinter message: ${message}`); }
    if (line) { promptParts.push(`Line: ${line}`); }
    if (lineText) { promptParts.push(`Code: ${lineText}`); }
    if (uri) { promptParts.push(`File: ${uri}`); }
    const prompt = promptParts.join('\n');

    const commands = await vscode.commands.getCommands(true);
    const has = (/** @type {string} */ id) => commands.includes(id);

    if (has('github.copilot.chat.open')) {
      await vscode.commands.executeCommand('github.copilot.chat.open', { query: prompt });
      return;
    }
    if (has('workbench.action.chat.open')) {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
      return;
    }
    if (has('workbench.action.chat.openInSidebar')) {
      await vscode.commands.executeCommand('workbench.action.chat.openInSidebar', prompt);
      return;
    }

    vscode.window.showWarningMessage('Copilot Chat command is unavailable. Install/enable GitHub Copilot Chat to use this quick fix.');
  }

  async resolveSuppressionTargetDocument() {
    const isBatchDoc = (/** @type {import('vscode').TextDocument | undefined} */ doc) => Boolean(
      doc
      && doc.uri
      && (
        doc.languageId === 'bat'
        || doc.languageId === 'cmd'
        || /\.(bat|cmd)$/i.test(doc.uri.fsPath || '')
      )
    );

    const activeDocument = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
    if (isBatchDoc(activeDocument)) {
      return activeDocument;
    }

    const visibleEditor = vscode.window.visibleTextEditors.find((editor) => isBatchDoc(editor.document));
    if (visibleEditor) {
      return visibleEditor.document;
    }

    const candidatePaths = [];
    if (this.currentProgramPath) {
      candidatePaths.push(this.currentProgramPath);
    }
    for (const filePath of this.getMergedIssuesByFile().keys()) {
      candidatePaths.push(filePath);
    }

    for (const candidatePath of [...new Set(candidatePaths)]) {
      if (typeof candidatePath !== 'string' || !candidatePath.trim()) {
        continue;
      }
      if (!/\.(bat|cmd)$/i.test(candidatePath)) {
        continue;
      }
      if (!fs.existsSync(candidatePath)) {
        continue;
      }
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(candidatePath));
        if (isBatchDoc(doc)) {
          return doc;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`[OpenDocument] Failed to open candidate ${candidatePath}: ${message}`);
      }
    }

    return undefined;
  }

  async removeAllSuppressionComments() {
    const doc = await this.resolveSuppressionTargetDocument();
    if (!doc) {
      vscode.window.showInformationMessage('Open a .bat or .cmd file to remove suppression comments.');
      return;
    }

    const suppressionLineRegex = /^\s*(?:REM|::)\s+LINT:IGNORE(?:-LINE)?(?:\b|\s)/i;
    const rangesToDelete = [];
    for (let i = 0; i < doc.lineCount; i += 1) {
      const line = doc.lineAt(i);
      if (!suppressionLineRegex.test(line.text)) {
        continue;
      }
      rangesToDelete.push(line.rangeIncludingLineBreak);
    }

    if (rangesToDelete.length === 0) {
      vscode.window.showInformationMessage(`No suppression comments found in ${path.basename(doc.uri.fsPath)}.`);
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    for (const range of rangesToDelete) {
      edit.delete(doc.uri, range);
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      vscode.window.showErrorMessage('Unable to apply suppression removal edits.');
      return;
    }

    this.log(`[Suppressions] Removed ${rangesToDelete.length} suppression comment(s) from ${doc.uri.fsPath}`);
    this.refreshSuppressionDecorations();
    const suffix = rangesToDelete.length === 1 ? '' : 's';
    vscode.window.showInformationMessage(`Removed ${rangesToDelete.length} suppression comment${suffix} from ${path.basename(doc.uri.fsPath)}.`);
  }

  getOutputViewStateForTest() {
    if (!this.webviewProvider) {
      return {
        viewResolved: false,
        containsRemoveSuppressionsButton: false,
        containsRemoveSuppressionsHandler: false
      };
    }
    return this.webviewProvider.getUiStateForTest();
  }

  resetDecorationStyle() {
    const newDecoration = this.createDecorationType();
    if (this._decorationDisposable) {
      this._decorationDisposable.dispose();
    }
    this.decorationType = newDecoration;
    this._decorationDisposable = newDecoration;
    this.refreshDecorations();
  }

  createDecorationType() {
    const color = this.getHighlightColor();
    return vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: color,
      overviewRulerColor: color,
      overviewRulerLane: vscode.OverviewRulerLane.Full,
      light: { backgroundColor: color },
      dark: { backgroundColor: color }
    });
  }

  getHighlightColor() {
    const scopeUri = vscode.window.activeTextEditor?.document.uri;
    const colorFromConfig = getBlinterConfig(scopeUri).get('criticalHighlightColor', '#5a1124');
    if (typeof colorFromConfig === 'string') {
      const trimmed = colorFromConfig.trim();
      const hexMatch = trimmed.match(/^#?([0-9A-Fa-f]{6})$/);
      if (hexMatch) {
        const value = hexMatch[1];
        const r = parseInt(value.slice(0, 2), 16);
        const g = parseInt(value.slice(2, 4), 16);
        const b = parseInt(value.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, 0.35)`;
      }
    }
    return new vscode.ThemeColor('editorError.background');
  }

  /** @param {Record<string, unknown>} args @param {import('vscode').DebugSession | { id?: string }} session */
  async prepareForLaunch(args, session) {
    return prepareForLaunch(this, args, session);
  }

  /** @param {string} line @param {string} channel */
  acceptProcessText(line, channel) {
    acceptProcessText(this, line, channel);
  }

  getMergedIssuesByFile() {
    /** @type {Map<string, BlinterIssue[]>} */
    const merged = new Map();
    for (const [filePath, issues] of this.lintIssuesByFile.entries()) {
      merged.set(filePath, [...issues]);
    }
    for (const [filePath, issues] of this.debugIssuesByFile.entries()) {
      const existing = merged.get(filePath) || [];
      merged.set(filePath, [...existing, ...issues]);
    }
    return merged;
  }

  getActiveIssueMap() {
    return this.isDebugSessionActive() ? this.debugIssuesByFile : this.lintIssuesByFile;
  }

  getDisplayStatus() {
    return this.isDebugSessionActive() ? this.debugStatus : this.lintStatus;
  }

  scheduleDiagnosticsUpdate() {
    if (this.pendingUpdateTimer) {
      return;
    }
    this.pendingUpdateTimer = setTimeout(() => {
      this.pendingUpdateTimer = undefined;
      this.flushDiagnostics();
    }, 75);
  }

  flushDiagnostics() {
    const entries = [];
    const merged = this.getMergedIssuesByFile();
    const allowedPaths = this.getDiagnosticAllowedPaths();
    for (const [filePath, list] of merged.entries()) {
      if (!isPathAllowed(filePath, allowedPaths)) {
        this.log(`[Diagnostics] Skipping unauthorized path: ${filePath}`);
        continue;
      }
      const uri = vscode.Uri.file(filePath);
      let document;
      try {
        document = vscode.workspace.textDocuments.find((doc) =>
          doc.uri.scheme === 'file' && normalizeFilePath(doc.uri.fsPath) === filePath
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`[Diagnostics] Failed to resolve open document for ${filePath}: ${message}`);
        document = undefined;
      }
      const diagnostics = list
        .sort((a, b) => compareIssues(a, b))
        .map((issue) => issueToDiagnostic(issue, document));
      entries.push({ uri, diagnostics });
    }

    this.lintDiagnostics.clear();
    for (const entry of entries) {
      this.lintDiagnostics.set(entry.uri, entry.diagnostics);
    }

    this.refreshDecorations();
    this.refreshSuppressionDecorations();
    this.updateWebview();
  }

  refreshDecorations() {
    if (!this.decorationType) {
      return;
    }

    const issueMap = this.getMergedIssuesByFile();
    for (const editor of vscode.window.visibleTextEditors) {
      const filePath = normalizeFilePath(editor.document.uri.fsPath);
      if (!filePath) {
        continue;
      }
      const issues = issueMap.get(filePath) || [];
      const criticalRanges = [];

      for (const issue of issues) {
        if (!issue.isCritical) {
          continue;
        }
        const lineIndex = Math.max(0, (issue.line || 1) - 1);
        if (lineIndex >= editor.document.lineCount) {
          continue;
        }
        criticalRanges.push(editor.document.lineAt(lineIndex).range);
      }

      editor.setDecorations(this.decorationType, criticalRanges);
    }
  }

  refreshSuppressionDecorations() {
    if (!this.suppressionDecorationType) {
      return;
    }

    const SUPPRESSION_RE = /(?:REM|::)\s+LINT:IGNORE(?:-LINE)?\s/i;
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.languageId !== 'bat' && editor.document.languageId !== 'cmd') {
        editor.setDecorations(this.suppressionDecorationType, []);
        continue;
      }

      const ranges = [];
      const lines = editor.document.getText().split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (SUPPRESSION_RE.test(lines[i])) {
          ranges.push(editor.document.lineAt(i).range);
          if (/LINT:IGNORE\s/i.test(lines[i]) && !/LINT:IGNORE-LINE/i.test(lines[i])) {
            if (i + 1 < lines.length) {
              ranges.push(editor.document.lineAt(i + 1).range);
            }
          }
        }
      }
      editor.setDecorations(this.suppressionDecorationType, ranges);
    }
  }

  updateWebview() {
    if (!this.webviewProvider) {
      return;
    }
    this.webviewProvider.updateStatus(this.getDisplayStatus());
    this.webviewProvider.update(this.collectSummary());
  }

  collectSummary() {
    const definitions = [
      { id: 'errors', label: 'Errors', filter: (/** @type {BlinterIssue} */ issue) => issue.severity === 'error' },
      { id: 'warnings', label: 'Warnings', filter: (/** @type {BlinterIssue} */ issue) => issue.severity === 'warning' },
      { id: 'info', label: 'Info', filter: (/** @type {BlinterIssue} */ issue) => isInformationalSeverity(issue.severity) },
      { id: 'undefined', label: 'Undefined Variables', filter: (/** @type {BlinterIssue} */ issue) => issue.classification === 'UndefinedVariable' },
      { id: 'critical', label: 'Critical Issues', filter: (/** @type {BlinterIssue} */ issue) => issue.isCritical }
    ];

    /** @type {SummaryGroup[]} */
    const groups = definitions.map((definition) => ({
      id: definition.id,
      label: definition.label,
      items: /** @type {SummaryGroupItem[]} */ ([])
    }));

    const issueMap = this.getMergedIssuesByFile();
    for (const [filePath, list] of issueMap.entries()) {
      for (const issue of list) {
        for (let i = 0; i < definitions.length; i += 1) {
          const definition = definitions[i];
          if (!definition.filter(issue)) {
            continue;
          }
          groups[i].items.push({
            id: issue.id,
            filePath,
            fileName: path.basename(filePath),
            line: issue.line,
            message: issue.message,
            severity: issue.severity,
            classification: issue.classification
          });
        }
      }
    }

    return { groups, status: this.getDisplayStatus() };
  }

  /** @param {import('vscode').TextDocument} document @param {import('vscode').Position} position */
  provideHover(document, position) {
    const filePath = normalizeFilePath(document.uri.fsPath);
    if (!filePath) {
      return undefined;
    }
    const issues = this.getMergedIssuesByFile().get(filePath) || [];
    const lineNumber = position.line + 1;
    const hits = issues.filter((issue) => issue.line === lineNumber);
    if (!hits.length) {
      return undefined;
    }

    hits.sort((a, b) => compareIssues(a, b));

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;

    hits.forEach((issue) => {
      const title = issue.classification || String(issue.severity || 'info').toUpperCase();
      md.appendMarkdown(`- **${escapeMarkdown(title)}** - ${escapeMarkdown(issue.message)}\n`);
      if (issue.variableTrace && issue.variableTrace.length) {
        md.appendMarkdown(`  - Trace: ${escapeMarkdown(issue.variableTrace.join(' -> '))}\n`);
      }
    });

    return new vscode.Hover(md);
  }

  /** @param {import('vscode').Uri} uri */
  clearDocument(uri) {
    const key = uri.toString();
    if (this._debounceTimers.has(key)) {
      clearTimeout(this._debounceTimers.get(key));
      this._debounceTimers.delete(key);
    }

    const filePath = normalizeFilePath(uri.fsPath);
    if (this._currentLintHandle && this._currentLintHandle.filePath === filePath) {
      this._currentLintHandle.kill();
      this._currentLintHandle = null;
    }

    releaseSnapshot(uri);
    if (!filePath) {
      return;
    }
    let changed = false;
    if (this.lintIssuesByFile.has(filePath)) {
      this.lintIssuesByFile.delete(filePath);
      changed = true;
    }
    if (this.debugIssuesByFile.has(filePath)) {
      this.debugIssuesByFile.delete(filePath);
      changed = true;
    }
    if (changed) {
      this.scheduleDiagnosticsUpdate();
    }
  }

  clearDebugIssues() {
    this.debugIssuesByFile.clear();
    this.flushDiagnostics();
  }

  /** @param {number | null | undefined} code @param {'lint' | 'debug'} [source] */
  handleProcessExit(code, source = 'debug') {
    this.lastExitCode = code;
    const { status, detail } = this.resolveExitStatus(code);

    if (source === 'lint') {
      this.updateLintStatus(status, detail);
    } else {
      this.updateDebugStatus(status, detail);
    }
    this.flushDiagnostics();
  }

  /** @param {number | null | undefined} code */
  resolveExitStatus(code) {
    if (code === 0) {
      return { status: 'completed', detail: 'Blinter completed' };
    }
    if (code === 1) {
      return { status: 'completed', detail: 'Blinter finished with findings' };
    }
    if (code === 2) {
      return { status: 'errored', detail: 'Blinter internal error (exit code 2)' };
    }
    if (code === null || code === undefined) {
      return { status: 'errored', detail: 'Blinter process failed or timed out' };
    }
    return { status: 'errored', detail: `Exited with code ${code}` };
  }

  /** @param {string} state @param {string} [detail] */
  updateLintStatus(state, detail) {
    this.lintStatus = { state, detail: detail || '' };
    if (!this.isDebugSessionActive() && this.webviewProvider) {
      this.webviewProvider.updateStatus(this.lintStatus);
    }
  }

  /** @param {string} state @param {string} [detail] */
  updateDebugStatus(state, detail) {
    this.debugStatus = { state, detail: detail || '' };
    if (this.webviewProvider) {
      this.webviewProvider.updateStatus(this.debugStatus);
    }
  }

  getAllowedRevealPaths() {
    const allowed = [];
    for (const filePath of this.getActiveIssueMap().keys()) {
      allowed.push(filePath);
    }
    const folders = vscode.workspace.workspaceFolders || [];
    for (const folder of folders) {
      allowed.push(folder.uri.fsPath);
    }
    return allowed;
  }

  getDiagnosticAllowedPaths() {
    /** @type {string[]} */
    const allowed = [];
    const folders = vscode.workspace.workspaceFolders || [];
    for (const folder of folders) {
      allowed.push(folder.uri.fsPath);
    }
    if (typeof this.currentWorkspaceRoot === 'string' && this.currentWorkspaceRoot) {
      allowed.push(this.currentWorkspaceRoot);
    }
    if (typeof this.currentProgramPath === 'string' && this.currentProgramPath) {
      allowed.push(path.dirname(this.currentProgramPath));
    }
    return allowed;
  }

  /** @param {string} filePath @param {number | undefined} line */
  async revealLocation(filePath, line) {
    if (!filePath) {
      return;
    }
    const normalized = normalizeFilePath(filePath);
    if (!normalized || !isPathAllowed(normalized, this.getDiagnosticAllowedPaths())) {
      this.log(`[Navigate] Rejected navigation to unauthorized path: ${filePath}`);
      vscode.window.showWarningMessage('Unable to open the requested file location.');
      return;
    }

    const uri = vscode.Uri.file(normalized);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const targetLine = Math.max(0, (line || 1) - 1);
      const position = new vscode.Position(targetLine, 0);
      const range = new vscode.Range(position, position);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(position, position);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[Navigate] Unable to open ${normalized}: ${message}`);
      vscode.window.showWarningMessage(`Unable to open ${normalized}`);
    }
  }

  /** @param {string} message */
  log(message) {
    this.output.appendLine(message);
  }

  /** @param {import('../types/blinter').BlinterIssue} issue */
  addIssue(issue) {
    if (this.isDebugSessionActive()) {
      addDebugIssue(this, issue);
      return;
    }

    const targetFile = normalizeFilePath(issue.filePath || this.currentProgramPath);
    if (!targetFile) {
      return;
    }

    issue.filePath = targetFile;
    if (!this.lintIssuesByFile.has(issue.filePath)) {
      this.lintIssuesByFile.set(issue.filePath, []);
    }
    const fileIssues = this.lintIssuesByFile.get(issue.filePath);
    if (fileIssues) {
      fileIssues.push(issue);
    }
    this.scheduleDiagnosticsUpdate();
  }

  createQuickFixProvider() {
    return buildQuickFixProvider();
  }

  createSuppressionProvider() {
    return buildSuppressionProvider();
  }

  /**
   * @param {import('../types/blinter').BlinterIssue} a
   * @param {import('../types/blinter').BlinterIssue} b
   */
  compareIssues(a, b) {
    return compareIssues(a, b);
  }

  /**
   * @param {import('../types/blinter').BlinterIssue} issue
   */
  toDiagnostic(issue) {
    return issueToDiagnostic(issue);
  }

  /** @param {import('vscode').TextDocument} document */
  async lintDocument(document) {
    return lintDocument(this, document);
  }

  dispose() {
    if (this._currentLintHandle) {
      this._currentLintHandle.kill();
      this._currentLintHandle = null;
    }
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();
    if (this.pendingUpdateTimer) {
      clearTimeout(this.pendingUpdateTimer);
      this.pendingUpdateTimer = undefined;
    }
    if (this._decorationDisposable) {
      this._decorationDisposable.dispose();
    }
    if (this.suppressionDecorationType) {
      this.suppressionDecorationType.dispose();
    }
    cleanupSnapshots();
  }
}

exports.BlinterController = BlinterController;
