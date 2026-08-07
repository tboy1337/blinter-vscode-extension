const vscode = require('vscode');

/** @typedef {import('../types/blinter').SummaryGroup} SummaryGroup */

class BlinterOutputViewProvider {
  /**
   * @param {import('vscode').Uri} extensionUri
   * @param {import('./controller').BlinterController} controller
   */
  constructor(extensionUri, controller) {
    this.extensionUri = extensionUri;
    this.controller = controller;
    this._view = undefined;
    /** @type {{ groups: SummaryGroup[] }} */
    this._data = { groups: [] };
    /** @type {{ state: string, detail: string }} */
    this._status = { state: 'idle', detail: '' };
    this._lastRenderedHtml = '';
  }

  /** @param {import('vscode').WebviewView} webviewView */
  resolveWebviewView(webviewView) {
    this._view = webviewView;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    this._lastRenderedHtml = this.renderHtml(webview);
    webview.html = this._lastRenderedHtml;

    webview.onDidReceiveMessage((/** @type {{ command?: string, path?: string, line?: number }} */ msg) => {
      if (msg?.command === 'reveal' && msg.path) {
        void this.controller.revealLocation(msg.path, msg.line);
        return;
      }
      if (msg?.command === 'removeSuppressions') {
        void this.controller.removeAllSuppressionComments().catch((/** @type {unknown} */ err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.controller.log(`[Suppressions] Error: ${message}`);
          vscode.window.showErrorMessage('Failed to remove suppression comments. Check the Blinter Output channel for details.');
        });
      }
    });

    this.postUpdate();
  }

  ensureVisible() {
    if (this._view && typeof this._view.show === 'function') {
      try {
        this._view.show(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.controller.log(`[OutputView] Failed to show webview: ${message}`);
      }
    }
  }

  /** @param {{ groups?: SummaryGroup[] }} [data] */
  update(data) {
    this._data = {
      groups: data?.groups ?? []
    };
    this.postUpdate();
  }

  /** @param {{ state?: string, detail?: string }} [status] */
  updateStatus(status) {
    this._status = {
      state: status?.state ?? 'idle',
      detail: status?.detail ?? ''
    };
    this.postUpdate();
  }

  getUiStateForTest() {
    const html = this._lastRenderedHtml || '';
    return {
      viewResolved: Boolean(this._view),
      containsRemoveSuppressionsButton: html.includes('id="removeSuppressionsBtn"'),
      containsRemoveSuppressionsHandler: html.includes("command: 'removeSuppressions'")
    };
  }

  postUpdate() {
    if (!this._view) {
      return;
    }
    this._view.webview.postMessage({
      command: 'refresh',
      payload: {
        groups: this._data.groups || [],
        status: this._status
      }
    });
  }

  /* c8 ignore start -- static webview HTML template; covered by integration UI tests */
  /** @param {import('vscode').Webview} webview */
  renderHtml(webview) {
    const cspSource = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; script-src 'unsafe-inline'; style-src 'unsafe-inline';" />
    <style>
      body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background-color: transparent;
        padding: 12px;
      }
      h2 {
        margin: 0 0 8px 0;
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--vscode-titleBar-activeForeground);
      }
      .status {
        font-size: 12px;
        margin-bottom: 12px;
        color: var(--vscode-descriptionForeground);
      }
      .toolbar {
        display: flex;
        justify-content: flex-end;
        margin-bottom: 10px;
      }
      .toolbar button {
        border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, #6b6b6b));
        background: var(--vscode-button-background, #0e639c);
        color: var(--vscode-button-foreground, #ffffff);
        padding: 4px 10px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
      }
      .toolbar button:hover {
        background: var(--vscode-button-hoverBackground, #1177bb);
      }
      .group {
        margin-bottom: 12px;
      }
      .group-header {
        font-weight: 600;
        font-size: 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
      }
      .group-items {
        border: 1px solid var(--vscode-list-hoverBackground);
        border-radius: 4px;
        overflow: hidden;
      }
      .item {
        display: block;
        padding: 6px 8px;
        font-size: 12px;
        line-height: 1.4;
        cursor: pointer;
        border-bottom: 1px solid var(--vscode-list-hoverBackground);
      }
      .item:last-child {
        border-bottom: none;
      }
      .item:hover {
        background-color: var(--vscode-list-hoverBackground);
      }
      .item-text {
        display: inline;
        white-space: normal;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .tag {
        font-family: var(--vscode-editor-font-family);
        font-weight: 600;
      }
      .severity-error {
        color: var(--vscode-errorForeground);
      }
      .severity-warning {
        color: var(--vscode-editorWarning-foreground);
      }
      .severity-info {
        color: var(--vscode-editorInfo-foreground);
      }
      .empty {
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        padding: 12px;
        border: 1px dashed var(--vscode-list-hoverBackground);
        border-radius: 4px;
      }
    </style>
  </head>
  <body>
    <div class="toolbar">
      <button id="removeSuppressionsBtn" type="button">Remove All Suppressions</button>
    </div>
    <div class="status" id="status">Waiting for Blinter...</div>
    <div id="content"></div>
    <script>
      const vscodeApi = acquireVsCodeApi();

      function escapeHtml(value) {
        return String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function formatStatus(status) {
        if (!status) {
          return 'Waiting for Blinter...';
        }
        switch (status.state) {
          case 'running':
            return 'Running analysis' + (status.detail ? ' - ' + escapeHtml(status.detail) : '');
          case 'completed':
            return status.detail ? escapeHtml(status.detail) : 'Analysis complete';
          case 'errored':
            return status.detail ? escapeHtml(status.detail) : 'Blinter encountered an error';
          default:
            return status.detail ? escapeHtml(status.detail) : 'Idle';
        }
      }

      function render(payload) {
        const statusEl = document.getElementById('status');
        const container = document.getElementById('content');

        statusEl.textContent = formatStatus(payload.status);

        const groups = Array.isArray(payload.groups) ? payload.groups : [];
        const hasItems = groups.some(group => Array.isArray(group.items) && group.items.length > 0);

        if (!hasItems) {
          container.innerHTML = '<div class="empty">No diagnostics captured yet.</div>';
          return;
        }

        const parts = [];
        for (const group of groups) {
          if (!Array.isArray(group.items) || group.items.length === 0) {
            continue;
          }
          parts.push('<div class="group">');
          parts.push('<div class="group-header">');
          parts.push('<span>' + escapeHtml(group.label) + '</span>');
          parts.push('<span>' + group.items.length + '</span>');
          parts.push('</div>');
          parts.push('<div class="group-items">');
          for (const item of group.items) {
            const severityRaw = String(item.severity || '').toLowerCase();
            const severityClass = severityRaw === 'error'
              ? 'severity-error'
              : severityRaw === 'warning'
                ? 'severity-warning'
                : 'severity-info';
            const tagLabel = severityRaw === 'error'
              ? 'ERROR'
              : severityRaw === 'warning'
                ? 'WARN'
                : 'INFO';
            const displayLine = 'L' + escapeHtml(item.line || 0);
            parts.push('<div class="item" data-path="' + escapeHtml(item.filePath) + '" data-line="' + escapeHtml(item.line || 0) + '">');
            parts.push('<span class="item-text"><span class="tag ' + severityClass + '">[' + tagLabel + ']</span>: ' + displayLine + ' ' + escapeHtml(item.message) + '</span>');
            parts.push('</div>');
          }
          parts.push('</div></div>');
        }

        container.innerHTML = parts.join('');
      }

      document.addEventListener('click', (event) => {
        const target = event.target.closest('.item');
        if (!target) {
          return;
        }
        const path = target.getAttribute('data-path');
        const line = Number(target.getAttribute('data-line')) || 0;
        vscodeApi.postMessage({ command: 'reveal', path, line });
      });

      const removeButton = document.getElementById('removeSuppressionsBtn');
      if (removeButton) {
        removeButton.addEventListener('click', () => {
          vscodeApi.postMessage({ command: 'removeSuppressions' });
        });
      }

      window.addEventListener('message', (event) => {
        if (event.data && event.data.command === 'refresh') {
          render(event.data.payload || {});
        }
      });
    </script>
  </body>
</html>`;
  }
  /* c8 ignore end */
}

module.exports = {
  BlinterOutputViewProvider
};
