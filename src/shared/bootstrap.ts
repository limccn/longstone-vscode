/**
 * Bootstrap payload parsing.
 *
 * The host sends `{ settings, issues, keyPresence }` over `postMessage`; this
 * module validates it at the webview edge and falls back to safe defaults for
 * anything missing or malformed. It is pure (no DOM, no `vscode`) so the
 * fallback behaviour is covered by plain Node tests.
 */

import {
  DEFAULT_SETTINGS,
  validateEndpointUrl,
  validateRegistryAddress,
  type LongstoneSettings,
  type SettingsIssue,
} from './settings.ts';

export interface KeyPresence {
  keyPresent: boolean;
  ownerKeyPresent: boolean;
}

export interface Bootstrap {
  settings: LongstoneSettings;
  issues: SettingsIssue[];
  keyPresence: KeyPresence;
}

export const EMPTY_BOOTSTRAP: Bootstrap = {
  settings: { ...DEFAULT_SETTINGS },
  issues: [],
  keyPresence: { keyPresent: false, ownerKeyPresent: false },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeIssues(raw: unknown): SettingsIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (issue): issue is SettingsIssue =>
      isRecord(issue) && typeof issue.key === 'string' && typeof issue.message === 'string',
  );
}

/**
 * Parse a message from the host. Re-validation here is deliberate: the host
 * already validated, but the webview must not depend on that to stay safe if
 * a future message path skips it.
 */
export function parseBootstrap(message: unknown): Bootstrap {
  if (!isRecord(message)) return { ...EMPTY_BOOTSTRAP };
  const rawSettings = isRecord(message.settings) ? message.settings : {};
  const settings: LongstoneSettings = { ...DEFAULT_SETTINGS };

  const rpc = validateEndpointUrl(rawSettings.rpcUrl, { allowEmpty: false });
  if (rpc.ok) settings.rpcUrl = rpc.value;
  const gateway = validateEndpointUrl(rawSettings.ipfsGateway, { allowEmpty: false });
  if (gateway.ok) settings.ipfsGateway = gateway.value;
  const hisaishi = validateEndpointUrl(rawSettings.hisaishiUrl, { allowEmpty: true });
  if (hisaishi.ok) settings.hisaishiUrl = hisaishi.value;
  const registry = validateRegistryAddress(rawSettings.registryAddress, { allowEmpty: true });
  if (registry.ok) settings.registryAddress = registry.value;
  // `allowWriteTools` is intentionally not part of webview state: the panel is
  // read-only regardless of the MCP tool surface.

  const presence = isRecord(message.keyPresence) ? message.keyPresence : {};
  return {
    settings,
    issues: sanitizeIssues(message.issues),
    keyPresence: {
      keyPresent: presence.keyPresent === true,
      ownerKeyPresent: presence.ownerKeyPresent === true,
    },
  };
}
