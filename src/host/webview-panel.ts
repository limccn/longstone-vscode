/**
 * Memory browser webview: timeline, detail and verify, rendered by
 * `@limccn/longstone-surface` inside the webview bundle.
 *
 * Host responsibilities:
 * - build the CSP from validated settings and a fresh nonce per document;
 * - serve the bundle and stylesheet through `asWebviewUri`;
 * - pass settings as data (never a key);
 * - gate every `openExternal` request against the fixed host allowlist.
 *
 * The webview never talks to the host for chain reads: it uses the surface
 * package directly, so verification semantics are the shared ones and there is
 * no second implementation to drift.
 */

import * as vscode from 'vscode';

import {
  buildContentSecurityPolicy,
  cspMetaTag,
  generateNonce,
  type CspSources,
} from '../shared/csp.ts';
import { isAllowedExternalUrl, isUriInsideCspSource } from '../shared/deep-link.ts';
import { WEBVIEW_TITLE, WEBVIEW_VIEW_TYPE } from '../shared/constants.ts';
import { validateSettings, type ValidatedSettings } from '../shared/settings.ts';

export interface PanelDeps {
  extensionUri: vscode.Uri;
  readRawSettings: () => Record<string, unknown>;
  keyPresence: () => { keyPresent: boolean; ownerKeyPresent: boolean };
  log: (message: string) => void;
}

function nonce(): string {
  return generateNonce(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

export class MemoryBrowserPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly deps: PanelDeps) {}

  show(): void {
    if (this.panel !== undefined) {
      this.panel.reveal();
      this.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      WEBVIEW_VIEW_TYPE,
      WEBVIEW_TITLE,
      vscode.ViewColumn.One,
      {
        // Only the packaged bundle may run; no command URIs from HTML.
        enableScripts: true,
        enableCommandUris: false,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'dist'), vscode.Uri.joinPath(this.deps.extensionUri, 'media')],
      },
    );
    this.panel = panel;

    const messageSubscription = panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.onMessage(message);
    });
    panel.onDidDispose(() => {
      messageSubscription.dispose();
      this.panel = undefined;
    });
    this.render();
  }

  /** Re-render on settings change so CSP and endpoints follow the config. */
  refresh(): void {
    if (this.panel !== undefined) this.render();
  }

  private async onMessage(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) return;
    const typed = message as { type?: unknown; url?: unknown };
    if (typed.type === 'openExternal' && typeof typed.url === 'string') {
      // Defense in depth: the webview already validates, the host re-checks.
      if (!isAllowedExternalUrl(typed.url)) {
        this.deps.log(`refused to open external URL: ${typed.url.slice(0, 100)}`);
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(typed.url));
      return;
    }
    if (typed.type === 'requestSettings') {
      this.postSettings();
      return;
    }
    if (typed.type === 'reveal') {
      // No-op acknowledgement; the webview uses it for its loading state only.
      return;
    }
    this.deps.log(`ignored webview message type: ${String(typed.type)}`);
  }

  private validated(): ValidatedSettings {
    return validateSettings(this.deps.readRawSettings());
  }

  private postSettings(): void {
    if (this.panel === undefined) return;
    const { settings, issues } = this.validated();
    void this.panel.webview.postMessage({
      type: 'settings',
      settings,
      issues,
      keyPresence: this.deps.keyPresence(),
    });
  }

  private render(): void {
    const panel = this.panel;
    if (panel === undefined) return;

    const { settings, issues } = this.validated();
    const currentNonce = nonce();
    const policy = buildContentSecurityPolicy({
      cspSource: panel.webview.cspSource,
      nonce: currentNonce,
      settings,
    } satisfies CspSources);
    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.deps.extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.deps.extensionUri, 'media', 'webview.css'),
    );

    // The CSP allows scripts/styles only from `cspSource`; a URI outside it
    // would render a blank panel. Fail loudly instead of shipping the markup.
    for (const uri of [scriptUri, styleUri]) {
      if (!isUriInsideCspSource(uri.toString(), panel.webview.cspSource)) {
        throw new Error(`webview asset outside cspSource: ${uri.toString()}`);
      }
    }

    panel.webview.html = renderHtml({
      cspMeta: cspMetaTag(policy),
      nonce: currentNonce,
      scriptUri: scriptUri.toString(),
      styleUri: styleUri.toString(),
    });

    // Settings travel over `postMessage` after the document loads, never as an
    // inline script element: the CSP then needs no exception for data blocks.
    void panel.webview.postMessage({
      type: 'settings',
      settings,
      issues,
      keyPresence: this.deps.keyPresence(),
    });
  }
}

export interface RenderHtmlArgs {
  cspMeta: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Static document skeleton. It carries no data at all: `settings` arrives
 * over `postMessage` after load, so the CSP has exactly one script source
 * (the nonce'd bundle) and no data-block exception.
 */
export function renderHtml(args: RenderHtmlArgs): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    ${args.cspMeta}
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${escapeHtml(args.styleUri)}">
    <title>${escapeHtml(WEBVIEW_TITLE)}</title>
  </head>
  <body>
    <main id="app" data-state="loading">
      <p class="empty">Loading memory browser…</p>
    </main>
    <script nonce="${args.nonce}" src="${escapeHtml(args.scriptUri)}"></script>
  </body>
</html>`;
}
