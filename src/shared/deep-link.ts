/**
 * URL building from chain data (PS-8 applied to this shell).
 *
 * Every value that comes from the chain or from user input is validated
 * against a fixed shape before it is placed in a URL, the base is fixed
 * (never taken from input), and values are `encodeURIComponent`-ed even when
 * they already passed validation. A crafted commitment string must never be
 * able to change the host, path or query of a link the user clicks.
 */

import { ALLOWED_EXTERNAL_HOSTS, BLOCKSCOUT_ORIGIN, WEB_APP_BASE } from './constants.ts';

const COMMITMENT_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const CID_RE = /^[a-zA-Z0-9]{1,200}$/;

type Built = { ok: true; url: string } | { ok: false; error: string };

export function isCommitmentHash(value: string): boolean {
  return COMMITMENT_HASH_RE.test(value);
}

export function isTxHash(value: string): boolean {
  return TX_HASH_RE.test(value);
}

export function isAddress(value: string): boolean {
  return ADDRESS_RE.test(value);
}

/** Web app deep link to one commitment. Returns `null` for a malformed hash. */
export function commitmentDeepLink(hash: string): string | null {
  if (!COMMITMENT_HASH_RE.test(hash)) return null;
  return `${WEB_APP_BASE}/commitment/${encodeURIComponent(hash)}`;
}

/** Web app deep link to the retract route, pre-filled with the target. */
export function retractDeepLink(hash: string): string | null {
  if (!COMMITMENT_HASH_RE.test(hash)) return null;
  return `${WEB_APP_BASE}/retract?commitment=${encodeURIComponent(hash)}`;
}

export function blockscoutTxUrl(txHash: string): string | null {
  if (!isTxHash(txHash)) return null;
  return `${BLOCKSCOUT_ORIGIN}/tx/${encodeURIComponent(txHash)}`;
}

export function blockscoutAddressUrl(address: string): string | null {
  if (!ADDRESS_RE.test(address)) return null;
  return `${BLOCKSCOUT_ORIGIN}/address/${encodeURIComponent(address)}`;
}

/**
 * IPFS gateway URL for a CID. Only alphanumeric CIDs (base32/base58 bodies)
 * are accepted, matching the surface's own transport rule.
 */
export function ipfsGatewayUrl(gateway: string, cid: string): Built {
  if (!CID_RE.test(cid)) return { ok: false, error: 'CID must be alphanumeric' };
  const base = gateway.replace(/\/+$/, '');
  if (base === '') return { ok: false, error: 'no IPFS gateway configured' };
  return { ok: true, url: `${base}/${encodeURIComponent(cid)}` };
}

/**
 * Gate before handing a URL to `vscode.env.openExternal`.
 *
 * Two independent checks: the URL must parse, and its origin must be one of
 * the fixed hosts this extension is allowed to open. `javascript:`, `file:`
 * and an attacker-controlled host all fail here regardless of how the URL was
 * produced.
 */
export function isAllowedExternalUrl(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  return ALLOWED_EXTERNAL_HOSTS.includes(url.hostname.toLowerCase()) && url.port === '';
}

/**
 * Check that an `asWebviewUri` result is covered by `webview.cspSource`.
 *
 * `cspSource` has two shapes across VS Code versions:
 * - an exact origin (`vscode-webview://<uuid>`), where the URI must share it;
 * - a wildcard origin (`https://*.vscode-cdn.net`), where the URI host must
 *   end with the wildcard's suffix. Comparing the literal host would reject
 *   every legitimate asset in that case.
 */
export function isUriInsideCspSource(uri: string, cspSource: string): boolean {
  if (cspSource === '' || uri === '') return false;
  let source: URL;
  try {
    source = new URL(cspSource);
  } catch {
    return false;
  }
  let target: URL;
  try {
    target = new URL(uri);
  } catch {
    return false;
  }
  if (target.protocol !== source.protocol) return false;
  const sourceHost = source.host.toLowerCase();
  const targetHost = target.host.toLowerCase();
  if (sourceHost.startsWith('*.')) {
    const suffix = sourceHost.slice(1); // keep the leading dot
    return targetHost.endsWith(suffix) && targetHost.length > suffix.length;
  }
  return targetHost === sourceHost;
}
