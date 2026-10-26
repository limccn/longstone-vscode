/**
 * Content-Security-Policy construction for the memory browser webview.
 *
 * The policy is built host-side from validated settings and passed to the
 * webview in the HTML; the webview never widens it. `default-src 'none'` is
 * the baseline, the only script is the nonce'd bundle served through
 * `asWebviewUri`, and `connect-src` lists exactly the configured RPC / IPFS /
 * hisaishi origins (PS-7's spirit applied to VS Code: no blanket origins).
 */

import { parseCspSourceList } from './deep-link.ts';
import { connectOriginsFor, type LongstoneSettings } from './settings.ts';

/** 16 random bytes, hex encoded — enough for a per-load CSP nonce. */
export function generateNonce(bytes: Uint8Array): string {
  if (bytes.length < 16) {
    throw new Error('CSP nonce needs at least 16 random bytes');
  }
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export interface CspSources {
  /** `webview.cspSource` for the extension. */
  cspSource: string;
  /** Nonce placed on the single `<script>` tag. */
  nonce: string;
  /** Validated settings; `connect-src` is derived from them. */
  settings: LongstoneSettings;
  /** Extra connect origins (tests only; production passes none). */
  extraConnectOrigins?: readonly string[];
}

/**
 * Build the CSP header value.
 *
 * Directives and their reasons:
 * - `default-src 'none'` — nothing is allowed unless a directive names it.
 * - `script-src 'nonce-…'` — one bundle, no inline handlers, no `unsafe-eval`.
 * - `style-src <cspSource>` — the only stylesheet is a packaged asset served
 *   through `asWebviewUri`; no inline styles are emitted by this extension.
 * - `img-src <cspSource> data:` — icons only; no remote images.
 * - `font-src <cspSource>` — bundled fonts only.
 * - `connect-src` — the configured endpoints, and nothing else.
 * - `frame-src`, `object-src`, `base-uri`, `form-action` — closed explicitly
 *   rather than relying on `default-src` alone for the dangerous ones.
 */
export function buildContentSecurityPolicy(sources: CspSources): string {
  // `webview.cspSource` can be a single origin or a source list; rebuild it
  // from validated tokens so it cannot terminate a directive.
  const parsedSource = parseCspSourceList(sources.cspSource);
  if (parsedSource === null) {
    throw new Error('CSP source must be a non-empty list of self or http(s)/vscode-webview origins');
  }
  const cspSource = parsedSource.join(' ');
  const connect = [
    ...connectOriginsFor(sources.settings),
    ...(sources.extraConnectOrigins ?? []),
  ];
  if (connect.length === 0) {
    // No configured endpoint: keep the directive present but empty so the
    // policy is visibly "no network" rather than accidentally permissive.
    connect.push("'none'");
  }

  const directives: [string, string[]][] = [
    ['default-src', ["'none'"]],
    ['script-src', [`'nonce-${sources.nonce}'`]],
    ['style-src', [cspSource]],
    ['img-src', [cspSource, 'data:']],
    ['font-src', [cspSource]],
    ['connect-src', connect],
    ['media-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['frame-src', ["'none'"]],
    ['worker-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
  ];

  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

export interface SecretCspSources {
  /** `webview.cspSource` for the extension. */
  cspSource: string;
  /** Per-document nonce placed on the single signed-in `<script>` tag. */
  nonce: string;
}

const CSP_NONCE_TEXT = /^[A-Za-z0-9+/=_-]{16,128}$/;

/**
 * CSP for the dedicated secret webview (design §7.5).
 *
 * Deliberately not the memory-browser policy: there is no `connect-src` at
 * all, no image or font source, and no data-block or inline exception. The
 * only loadable assets are the nonce'd script and the packaged stylesheet,
 * both served through `asWebviewUri` from `cspSource`.
 *
 * Inputs are checked so a malformed nonce or source cannot terminate the
 * directive and inject another one.
 */
export function buildSecretCsp(sources: SecretCspSources): string {
  const { cspSource, nonce } = sources;
  if (!CSP_NONCE_TEXT.test(nonce)) {
    throw new Error('secret CSP nonce must be 16-128 base64/hex characters');
  }
  // Accept both the single-origin and source-list shapes VS Code uses; the
  // rebuilt list prevents directive injection through whitespace or `;`.
  const parsedSource = parseCspSourceList(cspSource);
  if (parsedSource === null) {
    throw new Error(
      'secret CSP source must be a non-empty list of self or http(s)/vscode-webview origins',
    );
  }
  const sourceText = parsedSource.join(' ');

  const directives: [string, string[]][] = [
    ['default-src', ["'none'"]],
    ['script-src', [`'nonce-${nonce}'`]],
    // Only the packaged stylesheet; no `'unsafe-inline'` and no nonce here.
    ['style-src', [sourceText]],
    ['img-src', ["'none'"]],
    ['font-src', ["'none'"]],
    ['connect-src', ["'none'"]],
    ['media-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['frame-src', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
    ['worker-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
  ];

  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

/** Meta tag for the policy, safe to interpolate into the HTML head. */
export function cspMetaTag(policy: string): string {
  if (policy.includes('"')) {
    throw new Error('CSP must not contain double quotes in an HTML attribute');
  }
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}
