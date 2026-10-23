/**
 * Settings schema + validation.
 *
 * Pure module: no `vscode`, no network. The host feeds it
 * `vscode.workspace.getConfiguration('longstone')` values; the webview feeds
 * it the JSON-serialized result. Invalid values never reach a fetch or a CSP
 * directive — they fall back to the default and produce a visible issue.
 *
 * Workspace settings are deliberately NOT a key channel: there is no key
 * setting, and a key-looking value is rejected rather than stored.
 */

export const SETTINGS_SECTION = 'longstone';

export const SETTING_KEYS = {
  rpcUrl: 'longstone.rpcUrl',
  registryAddress: 'longstone.registryAddress',
  ipfsGateway: 'longstone.ipfsGateway',
  hisaishiUrl: 'longstone.hisaishiUrl',
  allowWriteTools: 'longstone.allowWriteTools',
} as const;

export interface LongstoneSettings {
  rpcUrl: string;
  /** Empty string means "not configured" — the timeline renders an empty state. */
  registryAddress: string;
  ipfsGateway: string;
  /** Empty string means "IPFS only"; no silent fallback to a public gateway. */
  hisaishiUrl: string;
  /** Opt-in write tools. The only setting that widens the MCP tool surface. */
  allowWriteTools: boolean;
}

export const DEFAULT_SETTINGS: LongstoneSettings = {
  rpcUrl: 'https://sepolia.base.org',
  registryAddress: '0xC85ed11d3065739F1829A114e420584bEC3FDFEF',
  ipfsGateway: 'https://gateway.pinata.cloud/ipfs',
  hisaishiUrl: '',
  allowWriteTools: false,
};

export interface SettingsIssue {
  /** Configuration key, e.g. `longstone.rpcUrl`. */
  key: string;
  message: string;
}

export interface ValidatedSettings {
  settings: LongstoneSettings;
  issues: SettingsIssue[];
}

const MAX_URL_LENGTH = 2048;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/**
 * Hostname characters allowed in an endpoint origin.
 *
 * `new URL()` percent-decodes some encoded characters into the hostname
 * (`%3B` → `;`, `%22` → `"`), and these origins are interpolated into the
 * CSP. Reject anything that is not a plain DNS name, IPv4 address, or
 * bracketed IPv6 literal, so an origin can never contain a CSP directive
 * separator or a quote that breaks the meta tag.
 */
const HOST_RE = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9._-]+)$/;
/** A 32-byte hex blob in a settings value is key material, not configuration. */
const KEY_LIKE_RE = /0x[0-9a-fA-F]{64}/;

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

export type UrlCheck = { ok: true; value: string } | { ok: false; error: string };

/**
 * One endpoint URL rule: https everywhere, plain http only on loopback.
 *
 * Query strings and fragments are rejected: every endpoint is a base URL that
 * the surface appends a path to, so `?x=1` would silently produce a wrong
 * request URL rather than an error.
 */
export function validateEndpointUrl(
  raw: unknown,
  options: { allowEmpty: boolean },
): UrlCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'must be a string' };
  const value = raw.trim();
  if (value === '') {
    return options.allowEmpty
      ? { ok: true, value: '' }
      : { ok: false, error: 'is required' };
  }
  if (value.length > MAX_URL_LENGTH) {
    return { ok: false, error: `must be at most ${MAX_URL_LENGTH} characters` };
  }
  if (KEY_LIKE_RE.test(value)) {
    return { ok: false, error: 'looks like key material; keys come from the environment only' };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: 'is not an absolute URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'must use https:// (or http:// on loopback)' };
  }
  if (!HOST_RE.test(url.hostname)) {
    return { ok: false, error: 'host contains characters that are not valid in an endpoint origin' };
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return {
      ok: false,
      error: `plain http:// is only allowed on loopback hosts; ${url.hostname} is remote`,
    };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'must not embed credentials in the URL' };
  }
  if (url.search !== '') {
    return { ok: false, error: 'must not carry a query string (it is a base URL)' };
  }
  if (url.hash !== '') {
    return { ok: false, error: 'must not carry a fragment (it is a base URL)' };
  }
  return { ok: true, value: value.replace(/\/+$/, '') };
}

export type AddressCheck = { ok: true; value: string } | { ok: false; error: string };

export function validateRegistryAddress(raw: unknown, options: { allowEmpty: boolean }): AddressCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'must be a string' };
  const value = raw.trim();
  if (value === '') {
    return options.allowEmpty
      ? { ok: true, value: '' }
      : { ok: false, error: 'is required' };
  }
  if (!ADDRESS_RE.test(value)) {
    return { ok: false, error: 'must be 0x followed by 40 hex characters' };
  }
  return { ok: true, value };
}

function readString(raw: Record<string, unknown>, key: string): unknown {
  return raw[key];
}

/**
 * Validate a raw settings record. Every invalid field falls back to its
 * default and is reported once, so the panel can show what is wrong without
 * ever using the bad value.
 */
export function validateSettings(raw: unknown): ValidatedSettings {
  const source: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const issues: SettingsIssue[] = [];
  const settings: LongstoneSettings = { ...DEFAULT_SETTINGS };

  const checkUrl = (
    field: 'rpcUrl' | 'ipfsGateway' | 'hisaishiUrl',
    allowEmpty: boolean,
  ): void => {
    const value = readString(source, field);
    if (value === undefined) {
      // Unset means "use the default"; the configuration default is applied
      // by the host before this runs.
      return;
    }
    const check = validateEndpointUrl(value, { allowEmpty });
    if (check.ok) {
      settings[field] = check.value;
      return;
    }
    issues.push({ key: `longstone.${field}`, message: `${field} ${check.error}` });
  };

  checkUrl('rpcUrl', false);
  checkUrl('ipfsGateway', false);
  checkUrl('hisaishiUrl', true);

  const registry = readString(source, 'registryAddress');
  if (registry !== undefined) {
    const check = validateRegistryAddress(registry, { allowEmpty: true });
    if (check.ok) settings.registryAddress = check.value;
    else issues.push({ key: 'longstone.registryAddress', message: check.error });
  }

  const writeTools = readString(source, 'allowWriteTools');
  if (writeTools !== undefined) {
    if (typeof writeTools === 'boolean') {
      settings.allowWriteTools = writeTools;
    } else {
      issues.push({
        key: 'longstone.allowWriteTools',
        message: 'must be a boolean; staying read-only',
      });
      settings.allowWriteTools = false;
    }
  } else {
    settings.allowWriteTools = false;
  }

  return { settings, issues };
}

/**
 * CSP `connect-src` origins for the configured endpoints.
 *
 * Origin only (scheme + host + port): a path is never a CSP source expression,
 * and keeping the list narrow is what makes the strict CSP useful.
 */
export function connectOriginsFor(settings: LongstoneSettings): string[] {
  const seen = new Set<string>();
  for (const value of [settings.rpcUrl, settings.ipfsGateway, settings.hisaishiUrl]) {
    if (value === '') continue;
    try {
      seen.add(new URL(value).origin);
    } catch {
      // Validation already ran; an unparseable value simply contributes nothing.
    }
  }
  return [...seen];
}
