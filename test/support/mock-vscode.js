const fs = require('fs');

function createRange(startLine, startChar, endLine, endChar) {
  return {
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar }
  };
}

function createMockVscode(options = {}) {
  const subscriptions = [];
  const registeredCommands = new Map();
  const configuration = { ...(options.configuration || {}) };
  const workspaceFolders = options.workspaceFolders || [{ uri: { fsPath: options.workspaceRoot || 'C:\\workspace' } }];
  const outputLines = [];
  const messages = { errors: [], warnings: [], infos: [] };
  let activeEditor = options.activeEditor || null;
  let visibleEditors = options.visibleEditors || (activeEditor ? [activeEditor] : []);
  const diagnosticsByUri = new Map();
  const documents = new Map();
  const hoverProviders = [];
  const codeActionProviders = [];
  let webviewViewProvider = null;
  const debugConfigProviders = new Map();
  const debugAdapterFactories = new Map();
  const eventHandlers = {
    onDidCloseTextDocument: [],
    onDidChangeConfiguration: [],
    onDidSaveTextDocument: [],
    onDidOpenTextDocument: [],
    onDidChangeTextDocument: [],
    onDidCreateFiles: [],
    onDidDeleteFiles: [],
    onDidChangeVisibleTextEditors: [],
    onDidChangeActiveTextEditor: [],
    onDidStartDebugSession: [],
    onDidTerminateDebugSession: []
  };

  const DiagnosticSeverity = {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3
  };

  const EndOfLine = { LF: 1, CRLF: 2 };
  const OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 };
  const TextEditorRevealType = { Default: 0, InCenter: 2 };
  const CodeActionKind = { QuickFix: { value: 'quickfix' } };

  class Position {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  }

  class Range {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  }

  class Diagnostic {
    constructor(range, message, severity) {
      this.range = range;
      this.message = message;
      this.severity = severity;
    }
  }

  class CodeAction {
    constructor(title, kind) {
      this.title = title;
      this.kind = kind;
    }
  }

  class WorkspaceEdit {
    replace(uri, range, newText) {
      this._replace = { uri, range, newText };
    }
    insert(uri, position, newText) {
      this._insert = { uri, position, newText };
    }
    delete(uri, range) {
      this._deletes = this._deletes || [];
      this._deletes.push({ uri, range });
    }
  }

  class Hover {
    constructor(contents) {
      this.contents = contents;
    }
  }

  class MarkdownString {
    constructor(value, supportThemeIcons) {
      this.value = value || '';
      this.supportThemeIcons = supportThemeIcons;
      this.isTrusted = false;
    }
    appendMarkdown(text) {
      this.value += text;
    }
  }

  class Selection {
    constructor(anchor, active) {
      this.anchor = anchor;
      this.active = active;
    }
  }

  class MockEventEmitter {
    constructor() {
      this._listeners = [];
    }

    get event() {
      const emitter = this;
      return (listener) => {
        emitter._listeners.push(listener);
        return {
          dispose: () => {
            const index = emitter._listeners.indexOf(listener);
            if (index >= 0) {
              emitter._listeners.splice(index, 1);
            }
          }
        };
      };
    }

    fire(data) {
      for (const listener of this._listeners) {
        listener(data);
      }
    }

    dispose() {
      this._listeners = [];
    }
  }

  const vscode = {
    DiagnosticSeverity,
    EndOfLine,
    OverviewRulerLane,
    TextEditorRevealType,
    CodeActionKind,
    Position,
    Range,
    Diagnostic,
    CodeAction,
    WorkspaceEdit,
    Hover,
    MarkdownString,
    Selection,
    Uri: {
      file: (fsPath) => ({ fsPath, toString: () => fsPath }),
      parse: (value) => ({ fsPath: value.replace(/^file:\/\//i, ''), toString: () => value })
    },
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    workspace: {
      workspaceFolders,
      textDocuments: [],
      getConfiguration: (section) => ({
        get: (key, defaultValue) => {
          const sectionConfig = configuration[section] || configuration;
          return sectionConfig[key] !== undefined ? sectionConfig[key] : defaultValue;
        }
      }),
      openTextDocument: async (uriOrPath) => {
        if (options.openTextDocumentThrows) {
          throw new Error('open failed');
        }
        const fsPath = typeof uriOrPath === 'string' ? uriOrPath : uriOrPath.fsPath;
        if (options.strictOpen && !fs.existsSync(fsPath)) {
          throw new Error(`ENOENT: ${fsPath}`);
        }
        if (documents.has(fsPath)) {
          return documents.get(fsPath);
        }
        const lineCount = options.lineCount || (options.lines ? options.lines.length : 3);
        const doc = {
          uri: { fsPath },
          languageId: options.documentLanguageId || 'cmd',
          lineCount,
          eol: EndOfLine.CRLF,
          getText: () => {
            if (options.lines) {
              return options.lines.join('\r\n');
            }
            return options.documentText || '@echo off\r\necho test\r\n';
          },
          lineAt: (line) => {
            const text = options.lines && options.lines[line] ? options.lines[line] : 'echo test';
            return {
              text,
              range: createRange(line, 0, line, text.length),
              rangeIncludingLineBreak: createRange(line, 0, line + 1, 0)
            };
          }
        };
        documents.set(fsPath, doc);
        return doc;
      },
      applyEdit: async (edit) => {
        if (edit && edit._replace) {
          const { uri, range, newText } = edit._replace;
          const fsPath = uri.fsPath;
          const doc = documents.get(fsPath);
          if (doc && options.lines) {
            const line = range.start.line;
            options.lines[line] = newText;
            doc.lineCount = options.lines.length;
          }
        }
        if (edit && edit._insert) {
          const { uri, position, newText } = edit._insert;
          const fsPath = uri.fsPath;
          if (options.lines) {
            const insertLines = newText.replace(/\r\n/g, '\n').split('\n');
            options.lines.splice(position.line, 0, ...insertLines);
            const doc = documents.get(fsPath);
            if (doc) {
              doc.lineCount = options.lines.length;
            }
          }
        }
        if (edit && edit._deletes) {
          for (const del of edit._deletes) {
            const line = del.range.start.line;
            if (options.lines) {
              options.lines.splice(line, 1);
            }
          }
        }
        return options.applyEditResult !== false;
      },
      onDidCloseTextDocument: (handler) => {
        eventHandlers.onDidCloseTextDocument.push(handler);
        return { dispose: () => {} };
      },
      onDidChangeConfiguration: (handler) => {
        eventHandlers.onDidChangeConfiguration.push(handler);
        return { dispose: () => {} };
      },
      onDidSaveTextDocument: (handler) => {
        eventHandlers.onDidSaveTextDocument.push(handler);
        return { dispose: () => {} };
      },
      onDidOpenTextDocument: (handler) => {
        eventHandlers.onDidOpenTextDocument.push(handler);
        return { dispose: () => {} };
      },
      onDidChangeTextDocument: (handler) => {
        eventHandlers.onDidChangeTextDocument.push(handler);
        return { dispose: () => {} };
      },
      onDidCreateFiles: (handler) => {
        eventHandlers.onDidCreateFiles.push(handler);
        return { dispose: () => {} };
      },
      onDidDeleteFiles: (handler) => {
        eventHandlers.onDidDeleteFiles.push(handler);
        return { dispose: () => {} };
      }
    },
    window: {
      activeTextEditor: activeEditor,
      visibleTextEditors: visibleEditors,
      createOutputChannel: () => ({
        appendLine: (line) => outputLines.push(String(line)),
        show: () => {},
        dispose: () => {}
      }),
      createTextEditorDecorationType: () => ({ dispose: () => {} }),
      createStatusBarItem: () => ({
        text: '',
        tooltip: '',
        command: undefined,
        show: () => {},
        hide: () => {},
        dispose: () => {}
      }),
      registerWebviewViewProvider: (_id, provider) => {
        webviewViewProvider = provider;
        return { dispose: () => { webviewViewProvider = null; } };
      },
      showErrorMessage: (msg) => { messages.errors.push(msg); },
      showWarningMessage: async (msg, ...items) => {
        messages.warnings.push(msg);
        if (options.warningChoice !== undefined) {
          return options.warningChoice;
        }
        return items.length > 0 ? items[0] : undefined;
      },
      showInformationMessage: (msg) => { messages.infos.push(msg); },
      showTextDocument: async (doc) => {
        const editor = {
          document: doc,
          revealRange: () => {},
          selection: {},
          setDecorations: () => {}
        };
        activeEditor = editor;
        visibleEditors = [editor];
        vscode.window.activeTextEditor = activeEditor;
        vscode.window.visibleTextEditors = visibleEditors;
        return activeEditor;
      },
      onDidChangeVisibleTextEditors: (handler) => {
        eventHandlers.onDidChangeVisibleTextEditors.push(handler);
        return { dispose: () => {} };
      },
      onDidChangeActiveTextEditor: (handler) => {
        eventHandlers.onDidChangeActiveTextEditor.push(handler);
        return { dispose: () => {} };
      }
    },
    languages: {
      createDiagnosticCollection: () => ({
        set: (uri, diags) => diagnosticsByUri.set(uri.fsPath || uri, diags),
        delete: (uri) => diagnosticsByUri.delete(uri.fsPath || uri),
        clear: () => diagnosticsByUri.clear(),
        dispose: () => {}
      }),
      registerHoverProvider: (_selector, provider) => {
        hoverProviders.push(provider);
        return { dispose: () => {} };
      },
      registerCodeActionsProvider: (_selector, provider) => {
        codeActionProviders.push(provider);
        return { dispose: () => {} };
      },
      getDiagnostics: (uri) => diagnosticsByUri.get(uri.fsPath) || []
    },
    commands: {
      registerCommand: (id, handler) => {
        registeredCommands.set(id, handler);
        return { dispose: () => registeredCommands.delete(id) };
      },
      executeCommand: async (id, ...args) => {
        if (options.externalCommands && options.externalCommands[id]) {
          return options.externalCommands[id](...args);
        }
        const handler = registeredCommands.get(id);
        if (!handler) {
          throw new Error(`Command not registered: ${id}`);
        }
        return handler(...args);
      },
      getCommands: async () => {
        const external = options.externalCommands ? Object.keys(options.externalCommands) : [];
        return [...new Set([...Array.from(registeredCommands.keys()), ...external])];
      }
    },
    debug: {
      registerDebugConfigurationProvider: (type, provider) => {
        debugConfigProviders.set(type, provider);
        return { dispose: () => debugConfigProviders.delete(type) };
      },
      registerDebugAdapterDescriptorFactory: (type, factory) => {
        debugAdapterFactories.set(type, factory);
        return { dispose: () => debugAdapterFactories.delete(type) };
      },
      startDebugging: async () => options.startDebuggingResult !== false,
      onDidStartDebugSession: (handler) => {
        eventHandlers.onDidStartDebugSession.push(handler);
        return { dispose: () => {} };
      },
      onDidTerminateDebugSession: (handler) => {
        eventHandlers.onDidTerminateDebugSession.push(handler);
        return { dispose: () => {} };
      },
      activeDebugSession: undefined
    },
    EventEmitter: MockEventEmitter,
    DebugAdapterInlineImplementation: class {
      constructor(implementation) {
        this.implementation = implementation;
        this.adapter = implementation;
      }
    },
    ViewColumn: { One: 1 },
    StatusBarAlignment: { Left: 1 }
  };

  return {
    vscode,
    subscriptions,
    registeredCommands,
    outputLines,
    messages,
    diagnosticsByUri,
    documents,
    hoverProviders,
    codeActionProviders,
    debugConfigProviders,
    debugAdapterFactories,
    eventHandlers,
    getWebviewViewProvider: () => webviewViewProvider,
    setActiveEditor(editor) {
      activeEditor = editor;
      visibleEditors = editor ? [editor] : [];
      vscode.window.activeTextEditor = editor;
      vscode.window.visibleTextEditors = visibleEditors;
    },
    fireDidSaveTextDocument(doc) {
      for (const handler of eventHandlers.onDidSaveTextDocument) {
        handler(doc);
      }
    },
    fireDidChangeTextDocument(doc) {
      for (const handler of eventHandlers.onDidChangeTextDocument) {
        handler({ document: doc });
      }
    },
    fireDidCloseTextDocument(doc) {
      for (const handler of eventHandlers.onDidCloseTextDocument) {
        handler(doc);
      }
    },
    fireDidChangeConfiguration(affects) {
      for (const handler of eventHandlers.onDidChangeConfiguration) {
        handler({ affectsConfiguration: (key) => affects.includes(key) });
      }
    },
    fireDidChangeVisibleTextEditors() {
      for (const handler of eventHandlers.onDidChangeVisibleTextEditors) {
        handler(visibleEditors);
      }
    },
    fireDidChangeActiveTextEditor(editor) {
      for (const handler of eventHandlers.onDidChangeActiveTextEditor) {
        handler(editor);
      }
    },
    fireDidCreateFiles() {
      for (const handler of eventHandlers.onDidCreateFiles) {
        handler();
      }
    },
    fireDidDeleteFiles() {
      for (const handler of eventHandlers.onDidDeleteFiles) {
        handler();
      }
    },
    fireDidStartDebugSession(session) {
      for (const handler of eventHandlers.onDidStartDebugSession) {
        handler(session);
      }
    },
    fireDidTerminateDebugSession(session) {
      for (const handler of eventHandlers.onDidTerminateDebugSession) {
        handler(session);
      }
    },
    resolveWebviewView(webviewOptions = {}) {
      const provider = webviewViewProvider;
      if (!provider) {
        return null;
      }
      const postedMessages = [];
      const receivedHandlers = [];
      const webview = {
        cspSource: 'vscode-webview://test',
        options: {},
        html: '',
        postMessage: (msg) => postedMessages.push(msg),
        onDidReceiveMessage: (handler) => {
          receivedHandlers.push(handler);
          webview._handlers = receivedHandlers;
          return { dispose: () => {} };
        }
      };
      const webviewView = {
        webview,
        show: webviewOptions.showThrows ? () => { throw new Error('show failed'); } : () => {}
      };
      provider.resolveWebviewView(webviewView);
      return { webview, webviewView, postedMessages, receivedHandlers };
    },
    sendWebviewMessage(msg) {
      const provider = webviewViewProvider;
      if (!provider || !provider._view) {
        return;
      }
      const handlers = provider._view.webview._handlers || [];
      for (const handler of handlers) {
        handler(msg);
      }
    }
  };
}

module.exports = { createMockVscode, createRange };
