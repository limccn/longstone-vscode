/**
 * Static HTML shell for the dedicated secret webview (design §7.5).
 *
 * Pure: no `vscode`, no secrets, no data. The shell contains only the CSP
 * meta tag, the nonce'd script reference and the packaged stylesheet; every
 * value that reaches the document arrives later over `postMessage`, and the
 * secret itself is posted only after the webview reports `ready`.
 *
 * The markup uses no inline `<style>`, no inline `<script>` body, no `style=`
 * attribute and no event-handler attribute, so the secret CSP needs no
 * `'unsafe-inline'` exception. The output is deterministic for a fixed input,
 * which keeps it testable without a VS Code host.
 */

import { WALLET_SECRET_VIEW_TITLE } from '../../shared/constants.ts';

export interface RenderSecretHtmlArgs {
  /** Result of `cspMetaTag(buildSecretCsp(...))`. */
  cspMeta: string;
  /** Per-document script nonce, mirrored on the `<script>` element. */
  nonce: string;
  /** `webview.asWebviewUri(dist/wallet-webview.js)`. */
  scriptUri: string;
  /** `webview.asWebviewUri(media/wallet.css)`. */
  styleUri: string;
  /** Escaped into `<title>`; defaults to the panel title. */
  title?: string;
}

const CSP_META = /^<meta http-equiv="Content-Security-Policy" content="[^"]*">$/;
const NONCE_TEXT = /^[A-Za-z0-9+/=_-]{16,128}$/;
const RESOURCE_URI = /^[^\s"'<>]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function assertResourceUri(name: string, value: string): void {
  if (value === '' || !RESOURCE_URI.test(value)) {
    throw new Error(`${name} must be a non-empty URI without quotes, whitespace or angle brackets`);
  }
}

/**
 * Full document. Attribute values are escaped even though the host validates
 * them, so a future caller cannot accidentally break out of the markup.
 */
export function renderSecretHtml(args: RenderSecretHtmlArgs): string {
  if (!CSP_META.test(args.cspMeta)) {
    throw new Error('cspMeta must be a single Content-Security-Policy meta tag');
  }
  if (!NONCE_TEXT.test(args.nonce)) {
    throw new Error('nonce must be 16-128 base64/hex characters');
  }
  assertResourceUri('scriptUri', args.scriptUri);
  assertResourceUri('styleUri', args.styleUri);

  const title = args.title ?? WALLET_SECRET_VIEW_TITLE;
  if (CONTROL_CHARS.test(title)) {
    throw new Error('title must not contain control characters');
  }

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    ${args.cspMeta}
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${escapeHtml(args.styleUri)}">
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <main id="app" class="wallet-panel" data-state="loading">
      <p class="wallet-status" role="status">Waiting for the wallet…</p>
    </main>
    <script nonce="${escapeHtml(args.nonce)}" src="${escapeHtml(args.scriptUri)}"></script>
  </body>
</html>`;
}
