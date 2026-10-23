/**
 * Memory-browser owner transitions (design §8.8, prd R13).
 *
 * Pure: no `vscode`, no DOM, no network, no storage. The host validates what
 * it caches and the webview re-validates every message it receives, so a
 * malformed address can never reach the render path as an owner.
 *
 * `source` records why the filter holds its value:
 * - `empty`  — the user has not taken the filter over; the wallet may fill it;
 * - `wallet` — the value came from the unlocked wallet and follows it;
 * - `manual` — the user typed or cleared it; the wallet never overwrites it
 *   for the life of this webview document (a rebuild starts at `empty`).
 */

export type OwnerSource = 'empty' | 'wallet' | 'manual';

export interface OwnerState {
  readonly filter: string;
  readonly source: OwnerSource;
}

export interface WalletOwnerMessage {
  readonly type: 'walletOwner';
  readonly owner: string | null;
}

/** `0x` + 40 hex, case-insensitive digits; no whitespace, no checksum check. */
const WALLET_OWNER_RE = /^0x[0-9a-fA-F]{40}$/;

/** True only for the exact address shape the wallet may contribute. */
export function isWalletOwner(value: unknown): value is string {
  return typeof value === 'string' && WALLET_OWNER_RE.test(value);
}

/**
 * Apply a wallet owner to a filter/source pair.
 *
 * - `manual` is never touched, including a filter the user cleared to `''`;
 * - `wallet` + null clears back to `''`/`empty` (lock, reset, external delete);
 * - `wallet` + address follows the new active address;
 * - `empty` + address becomes `address`/`wallet`;
 * - `empty` + null is unchanged.
 *
 * `walletOwner` must already be validated (`null` or `isWalletOwner`); both
 * message edges do that before calling this.
 */
export function applyWalletOwner(
  filter: string,
  source: OwnerSource,
  walletOwner: string | null,
): OwnerState {
  if (source === 'manual') return { filter, source };
  if (walletOwner === null) {
    return source === 'wallet' ? { filter: '', source: 'empty' } : { filter, source };
  }
  return { filter: walletOwner, source: 'wallet' };
}

/**
 * Validate a `{ type: 'walletOwner', owner }` message.
 *
 * Returns `null` for anything else — another message type, an absent field, or
 * a non-null owner that is not `0x` + 40 hex. Callers must ignore `null`
 * rather than applying an owner, so an invalid value can never clear or
 * overwrite the filter.
 */
export function parseWalletOwnerMessage(data: unknown): WalletOwnerMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as { type?: unknown; owner?: unknown };
  if (record.type !== 'walletOwner') return null;
  if (record.owner === null) return { type: 'walletOwner', owner: null };
  if (!isWalletOwner(record.owner)) return null;
  return { type: 'walletOwner', owner: record.owner };
}
