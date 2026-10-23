/**
 * `globalState` adapter for the shared wallet core (design §4.1/§4.5).
 *
 * Values are stored as **strings**, never structured objects: the record is a
 * JSON document, and keeping it as a string preserves its exact bytes, keeps
 * the hash stable, and means a `state.vscdb` dump contains only ciphertext
 * fields. `get` decodes the string back to an object because the core parses
 * the record envelope itself.
 *
 * The adapter also records the last value read and the last value written per
 * key. The controller uses those (design §4.2 step 7) to decide, after a
 * failed `set`, whether the new value landed, the old value is still there, or
 * the outcome is unknown.
 *
 * `setKeysForSync` is never called and `SecretStorage` is never used: the
 * wallet does not sync across machines and does not live in the OS keychain.
 */
import { WalletError, type StorageKeys, type WalletStorage } from '@limccn/longstone-wallet';
import type { Memento } from 'vscode';

import {
  WALLET_LOGICAL_PENDING_KEY,
  WALLET_LOGICAL_RECORD_KEY,
  WALLET_STORAGE_PENDING_KEY,
  WALLET_STORAGE_RECORD_KEY,
} from '../../shared/constants.ts';

/** The two physical keys, in the shape the core takes via `VaultDeps.keys`. */
export const WALLET_STORAGE_KEYS: StorageKeys = {
  record: WALLET_STORAGE_RECORD_KEY,
  pending: WALLET_STORAGE_PENDING_KEY,
};

const LOGICAL_TO_PHYSICAL: Readonly<Record<string, string>> = {
  [WALLET_LOGICAL_RECORD_KEY]: WALLET_STORAGE_RECORD_KEY,
  [WALLET_LOGICAL_PENDING_KEY]: WALLET_STORAGE_PENDING_KEY,
};

/**
 * Logical keys map to the `longstone.*` namespace; a physical key (what this
 * host passes to the core) maps to itself, so callers cannot accidentally read
 * a second copy under a prefixed name.
 */
export function physicalWalletKey(key: string): string {
  return LOGICAL_TO_PHYSICAL[key] ?? key;
}

/** The subset of `vscode.Memento` the adapter needs; tests pass a fake. */
export interface GlobalStateLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export type WalletStorageAttempt = { readonly kind: 'set'; readonly raw: string } | { readonly kind: 'remove' };

export interface WalletStorageAdapter extends WalletStorage {
  /** Physical keys for `VaultDeps.keys` (design §4.1). */
  readonly keys: StorageKeys;
  /** The stored string, without decoding; used only by reconciliation. */
  readRaw(key: string): Promise<string | null>;
  /** Forgets attempted values; called when a new mutation starts. */
  clearAttempts(): void;
  /** The last value this adapter attempted to write for `key`. */
  lastAttempt(key: string): WalletStorageAttempt | undefined;
  /**
   * The last value the core read or successfully wrote for `key`.
   * `undefined` means "never observed"; `null` means "observed absent".
   */
  lastRead(key: string): string | null | undefined;
}

function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  const raw = JSON.stringify(value);
  if (raw === undefined) throw new WalletError('STORAGE_FAILED');
  return raw;
}

function decode(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // A non-JSON string is corruption, not a crash: the core's strict parser
    // reports VAULT_CORRUPT, which is the accurate copy for the user.
    return value;
  }
}

/** `Memento` values are strings under our keys; anything else is defensive. */
function rawOf(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

export class MementoStorage implements WalletStorageAdapter {
  readonly keys: StorageKeys = WALLET_STORAGE_KEYS;

  #memento: GlobalStateLike;
  #lastAttempt = new Map<string, WalletStorageAttempt>();
  #lastRead = new Map<string, string | null>();

  constructor(memento: GlobalStateLike) {
    this.#memento = memento;
  }

  async get(key: string): Promise<Record<string, unknown>> {
    const value = this.#memento.get<unknown>(physicalWalletKey(key));
    this.#lastRead.set(key, rawOf(value));
    return { [key]: decode(value) };
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      const raw = serialize(value);
      this.#lastAttempt.set(key, { kind: 'set', raw });
      try {
        await this.#memento.update(physicalWalletKey(key), raw);
      } catch {
        // The disk state is unknown at this point; reconciliation decides.
        throw new WalletError('STORAGE_FAILED');
      }
      this.#lastRead.set(key, raw);
    }
  }

  async remove(key: string): Promise<void> {
    this.#lastAttempt.set(key, { kind: 'remove' });
    try {
      await this.#memento.update(physicalWalletKey(key), undefined);
    } catch {
      throw new WalletError('STORAGE_FAILED');
    }
    this.#lastRead.set(key, null);
  }

  async readRaw(key: string): Promise<string | null> {
    return rawOf(this.#memento.get<unknown>(physicalWalletKey(key)));
  }

  clearAttempts(): void {
    this.#lastAttempt.clear();
  }

  lastAttempt(key: string): WalletStorageAttempt | undefined {
    return this.#lastAttempt.get(key);
  }

  lastRead(key: string): string | null | undefined {
    return this.#lastRead.get(key);
  }
}
