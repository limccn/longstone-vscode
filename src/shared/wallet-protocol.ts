/**
 * Message protocol for the dedicated secret webview (design §7.5).
 *
 * This module is imported by the extension host and by the secret webview
 * bundle, so it must stay pure: no `vscode`, no `node:` builtin, and no
 * `@limccn/longstone-wallet` import — the shared core is banned from the
 * secret bundle, and the webview only receives what the host posted after
 * `ready`.
 *
 * Guards are strict and side-effect free:
 * - unknown message types and unknown fields are rejected;
 * - `mode`/`kind` pairs and mode/action pairs are checked explicitly;
 * - mnemonic text is bounded at 1 KiB of UTF-8 and private keys must be
 *   exactly `0x` + 64 hex characters;
 * - labels and UI copy are bounded and may not contain control/bidi
 *   characters.
 *
 * Nothing here composes an error message from input, so a rejected payload can
 * never echo a secret into copy, a notification, or a log.
 */

export type SecretPanelMode = 'create-reveal' | 'import' | 'reveal-export';
export type SecretKind = 'mnemonic' | 'privateKey';

/** Same bound as the core (`MAX_MNEMONIC_BYTES`); kept local, not imported. */
export const MAX_MNEMONIC_BYTES = 1024;
/** Same bound as the core (`MAX_LABEL_CODEPOINTS`); kept local, not imported. */
export const MAX_LABEL_CODEPOINTS = 64;
export const MAX_UI_MESSAGE_CODEPOINTS = 512;
export const MIN_COUNTDOWN_SECONDS = 1;
export const MAX_COUNTDOWN_SECONDS = 3600;

/** Removed from labels by the core; rejected here before they reach the UI. */
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/;
const PRIVATE_KEY_TEXT = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_TEXT = /^0x[0-9a-fA-F]{40}$/;
const DERIVATION_PATH_TEXT = /^m(?:\/[0-9]+'?)+$/;

// ---------------------------------------------------------------------------
// Host -> webview
// ---------------------------------------------------------------------------

export interface HostSecretMessage {
  readonly type: 'secret';
  readonly mode: SecretPanelMode;
  readonly kind: SecretKind;
  /** Absent for `import`: the webview starts from an empty form. */
  readonly value?: string;
  readonly label?: string;
  readonly address?: string;
  /** Only for a mnemonic account's exported private key. */
  readonly derivationPath?: string;
  /** Only for `reveal-export`; the panel disposes when it reaches zero. */
  readonly countdownSeconds?: number;
}

export interface HostErrorMessage {
  readonly type: 'error';
  /** Safe, host-generated copy; never contains a secret value. */
  readonly message: string;
}

export interface HostClearMessage {
  readonly type: 'clear';
}

export type HostToWebviewMessage =
  | HostSecretMessage
  | HostErrorMessage
  | HostClearMessage;

// ---------------------------------------------------------------------------
// Webview -> host
// ---------------------------------------------------------------------------

export type SecretWebviewMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'copy' }
  | { readonly type: 'saved' }
  | { readonly type: 'cancel' }
  | { readonly type: 'submit-mnemonic'; readonly value: string }
  | { readonly type: 'submit-private-key'; readonly value: string };

// ---------------------------------------------------------------------------
// Small guards
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function hasOnlyKeys(record: JsonRecord, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function isMode(value: unknown): value is SecretPanelMode {
  return value === 'create-reveal' || value === 'import' || value === 'reveal-export';
}

function isKind(value: unknown): value is SecretKind {
  return value === 'mnemonic' || value === 'privateKey';
}

/** UTF-8 byte length, matching the core's `MAX_MNEMONIC_BYTES` check. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Non-empty mnemonic input within the core's 1 KiB bound. */
export function isMnemonicText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && utf8ByteLength(value) <= MAX_MNEMONIC_BYTES;
}

/** `0x` + exactly 64 hex characters (66 total); the core checks the range. */
export function isPrivateKeyText(value: unknown): value is string {
  return typeof value === 'string' && PRIVATE_KEY_TEXT.test(value);
}

export function isAddressText(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS_TEXT.test(value);
}

function isDerivationPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && DERIVATION_PATH_TEXT.test(value);
}

function isBoundedLabel(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (CONTROL_OR_BIDI.test(value)) return false;
  const trimmed = value.trim();
  if (trimmed === '') return false;
  return [...trimmed].length <= MAX_LABEL_CODEPOINTS;
}

function isUiMessage(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !CONTROL_OR_BIDI.test(value) &&
    [...value].length <= MAX_UI_MESSAGE_CODEPOINTS
  );
}

function isCountdownSeconds(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_COUNTDOWN_SECONDS &&
    value <= MAX_COUNTDOWN_SECONDS
  );
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

const SECRET_KEYS = [
  'type',
  'mode',
  'kind',
  'value',
  'label',
  'address',
  'derivationPath',
  'countdownSeconds',
] as const;

function parseSecret(record: JsonRecord): HostSecretMessage | null {
  if (!hasOnlyKeys(record, SECRET_KEYS)) return null;
  const mode = record['mode'];
  const kind = record['kind'];
  if (!isMode(mode) || !isKind(kind)) return null;

  const rawValue = record['value'];
  const rawLabel = record['label'];
  const rawAddress = record['address'];
  const rawDerivationPath = record['derivationPath'];
  const rawCountdown = record['countdownSeconds'];

  let value: string | undefined;
  let address: string | undefined;
  let derivationPath: string | undefined;
  let countdownSeconds: number | undefined;

  switch (mode) {
    case 'create-reveal': {
      // Creation always produces a mnemonic; there is nothing to count down,
      // and a derived-key path has no meaning yet.
      if (kind !== 'mnemonic') return null;
      if (!isMnemonicText(rawValue)) return null;
      value = rawValue;
      if (rawDerivationPath !== undefined) return null;
      if (rawCountdown !== undefined) return null;
      if (rawAddress !== undefined) {
        if (!isAddressText(rawAddress)) return null;
        address = rawAddress;
      }
      break;
    }
    case 'import': {
      // The user supplies the secret in the webview; the host posts only the
      // form shape. An address is not known until the host derives it.
      if (rawValue !== undefined) return null;
      if (rawAddress !== undefined) return null;
      if (rawDerivationPath !== undefined) return null;
      if (rawCountdown !== undefined) return null;
      break;
    }
    case 'reveal-export': {
      if (kind === 'mnemonic') {
        if (!isMnemonicText(rawValue)) return null;
        if (rawDerivationPath !== undefined) return null;
        value = rawValue;
      } else {
        if (!isPrivateKeyText(rawValue)) return null;
        value = rawValue;
        if (rawDerivationPath !== undefined) {
          if (!isDerivationPath(rawDerivationPath)) return null;
          derivationPath = rawDerivationPath;
        }
      }
      if (!isCountdownSeconds(rawCountdown)) return null;
      countdownSeconds = rawCountdown;
      if (rawAddress !== undefined) {
        if (!isAddressText(rawAddress)) return null;
        address = rawAddress;
      }
      break;
    }
  }

  let label: string | undefined;
  if (rawLabel !== undefined) {
    if (!isBoundedLabel(rawLabel)) return null;
    label = rawLabel;
  }

  const message: {
    -readonly [K in keyof HostSecretMessage]: HostSecretMessage[K];
  } = { type: 'secret', mode, kind };
  if (value !== undefined) message.value = value;
  if (label !== undefined) message.label = label;
  if (address !== undefined) message.address = address;
  if (derivationPath !== undefined) message.derivationPath = derivationPath;
  if (countdownSeconds !== undefined) message.countdownSeconds = countdownSeconds;
  return message;
}

/** Validates one host -> webview frame; `null` means "drop it". */
export function parseHostToWebviewMessage(raw: unknown): HostToWebviewMessage | null {
  const record = asRecord(raw);
  if (record === null) return null;

  if (record['type'] === 'secret') return parseSecret(record);

  if (record['type'] === 'error') {
    if (!hasOnlyKeys(record, ['type', 'message'])) return null;
    const message = record['message'];
    if (!isUiMessage(message)) return null;
    return { type: 'error', message };
  }

  if (record['type'] === 'clear') {
    if (!hasOnlyKeys(record, ['type'])) return null;
    return { type: 'clear' };
  }

  return null;
}

/** Validates one webview -> host frame; `null` means "drop it". */
export function parseWebviewToHostMessage(raw: unknown): SecretWebviewMessage | null {
  const record = asRecord(raw);
  if (record === null) return null;

  switch (record['type']) {
    case 'ready':
      return hasOnlyKeys(record, ['type']) ? { type: 'ready' } : null;
    case 'copy':
      return hasOnlyKeys(record, ['type']) ? { type: 'copy' } : null;
    case 'saved':
      return hasOnlyKeys(record, ['type']) ? { type: 'saved' } : null;
    case 'cancel':
      return hasOnlyKeys(record, ['type']) ? { type: 'cancel' } : null;
    case 'submit-mnemonic': {
      if (!hasOnlyKeys(record, ['type', 'value'])) return null;
      const value = record['value'];
      return isMnemonicText(value) ? { type: 'submit-mnemonic', value } : null;
    }
    case 'submit-private-key': {
      if (!hasOnlyKeys(record, ['type', 'value'])) return null;
      const value = record['value'];
      return isPrivateKeyText(value) ? { type: 'submit-private-key', value } : null;
    }
    default:
      return null;
  }
}

/**
 * Mode/action matrix (design §7.5, ux-flows §11):
 * - `ready` and `cancel` are always allowed;
 * - `copy` only when a secret is displayed (create-reveal, reveal-export);
 * - `saved` only closes a create-reveal panel;
 * - import accepts exactly the submit matching its `kind`.
 */
export function isWebviewActionAllowed(
  mode: SecretPanelMode,
  kind: SecretKind,
  message: SecretWebviewMessage,
): boolean {
  switch (message.type) {
    case 'ready':
    case 'cancel':
      return true;
    case 'copy':
      return mode === 'create-reveal' || mode === 'reveal-export';
    case 'saved':
      return mode === 'create-reveal';
    case 'submit-mnemonic':
      return mode === 'import' && kind === 'mnemonic';
    case 'submit-private-key':
      return mode === 'import' && kind === 'privateKey';
  }
}
