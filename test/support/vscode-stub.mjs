/**
 * Minimal `vscode` stub for suites that import the real secret-panel holder.
 *
 * Only the surface that `src/host/wallet/secret-panel.ts` touches is defined:
 * `Uri`, `ViewColumn`, `env.clipboard` and the two `window` factories. Panels
 * expose `send(message)` so tests can drive the `onDidReceiveMessage` channel
 * without a live webview.
 */

export class Uri {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
  static joinPath(base, ...parts) {
    const root = String(base).replace(/\/+$/, '');
    return new Uri(`${root}/${parts.join('/')}`);
  }
}

export const ViewColumn = { Beside: -2 };

export const env = {
  clipboard: {
    written: [],
    async writeText(text) {
      env.clipboard.written.push(text);
    },
  },
};

const panels = [];
let windowStateListener = null;

export const window = {
  createWebviewPanel(type, title, showOptions, options) {
    const messageListeners = [];
    const disposeListeners = [];
    const viewStateListeners = [];
    const webview = {
      cspSource: 'vscode-webview://test-uuid',
      html: '',
      posted: [],
      onDidReceiveMessage(callback) {
        messageListeners.push(callback);
        return { dispose() {} };
      },
      postMessage(message) {
        webview.posted.push(message);
        return Promise.resolve(true);
      },
      asWebviewUri(uri) {
        return uri;
      },
    };
    const panel = {
      webview,
      type,
      title,
      showOptions,
      options,
      disposed: false,
      visible: true,
      onDidDispose(callback) {
        disposeListeners.push(callback);
        return { dispose() {} };
      },
      onDidChangeViewState(callback) {
        viewStateListeners.push(callback);
        return { dispose() {} };
      },
      dispose() {
        if (panel.disposed) return;
        panel.disposed = true;
        panel.visible = false;
        for (const callback of disposeListeners) callback();
      },
      send(message) {
        if (panel.disposed) return;
        for (const callback of messageListeners) callback(message);
      },
      hide() {
        panel.visible = false;
        for (const callback of viewStateListeners) callback({ webviewPanel: panel });
      },
    };
    panels.push(panel);
    return panel;
  },
  onDidChangeWindowState(callback) {
    windowStateListener = callback;
    return {
      dispose() {
        if (windowStateListener === callback) windowStateListener = null;
      },
    };
  },
};

export function fireWindowBlur() {
  windowStateListener?.({ focused: false });
}

export function lastPanel() {
  return panels.at(-1);
}

export function panelCount() {
  return panels.length;
}

/** Fresh state between tests in the same file. */
export function reset() {
  panels.length = 0;
  windowStateListener = null;
  env.clipboard.written.length = 0;
}
