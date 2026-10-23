/**
 * Wallet session, lock and storage-reconciliation controller (design §4.2,
 * §4.3, §4.4, §5, §5.6; DR-01/DR-19; AC-15/AC-21/AC-23/AC-24).
 *
 * The controller owns the `UnlockedVault` — the non-extractable AES key, the
 * decrypted payload and the record hash — and never hands any of them out.
 * Callers see read-only account views, addresses, failure codes and (only from
 * `verifyAndReveal`) a secret the caller must display and drop.
 *
 * Three disciplines keep it honest:
 *
 * - **One queue.** Every storage read/write, including polling and the core's
 *   own writes, runs through one promise chain. A successful write adopts the
 *   new record hash inside the same task, so the controller's own write can
 *   never be mistaken for another window's (DR-01).
 * - **One epoch.** `lock()` bumps `epoch` before dropping the session. Every
 *   `await` rechecks it; a result from a previous lock is discarded — no
 *   session, no secret, no status-bar update (DR-19/AC-21).
 * - **Read-back before claiming anything.** Every successful write is read
 *   back and hash-checked before its result is adopted or reported, and a
 *   failed write is classified against the exact value the core attempted;
 *   only a confirmed old value may be reported as "nothing was changed"
 *   (design §4.2 step 7 / AC-23).
 *
 * No `vscode` import: adapters are injected so the module runs under
 * `node --test`.
 */
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DERIVATION_PATH,
  WalletError,
  addAccount,
  changePassword as changePasswordOp,
  createVault,
  decryptJson,
  deleteAccount as deleteAccountOp,
  deriveAccountFromMnemonic,
  hashRecord,
  isWalletError,
  kdfParamsOf,
  loadVault,
  parseWalletRecord,
  privateKeyToAddress,
  renameAccount as renameAccountOp,
  resetVault,
  setActiveAccount as setActiveAccountOp,
  setIdleTimeout as setIdleTimeoutOp,
  unlockVault,
  validateVaultPayload,
  type AccountSource,
  type Argon2Runner,
  type ChangePasswordResult,
  type ChangeResolution,
  type DeleteOutcome,
  type KdfParams,
  type NewAccountInput,
  type UnlockedVault,
  type UnlockOutcome,
  type VaultAccount,
  type VaultDeps,
  type VaultLoad,
  type VaultPayload,
  type VaultResult,
  type WalletErrorCode,
} from '@limccn/longstone-wallet';

import type { WalletAvailability } from './availability.ts';
import {
  walletCreatedLockedMessage,
  walletErrorMessage,
  walletNewPasswordMessage,
  walletNotAppliedMessage,
  walletRateLimitMessage,
  walletTryNewPasswordMessage,
  walletUnverifiedMessage,
  walletWrongOldPasswordMessage,
  type WalletFailureCode,
} from './errors.ts';
import type { WalletStorageAdapter } from './global-state.ts';
import type { WalletStatusState } from './status-bar.ts';

// ---------------------------------------------------------------------------
// Public state and result shapes
// ---------------------------------------------------------------------------

export type WalletBusyKind =
  | 'unlock'
  | 'create'
  | 'change-password'
  | 'export'
  | 'account-write';

export type WalletLockReason =
  | 'explicit'
  | 'idle'
  | 'hidden'
  | 'pagehide'
  | 'focus-lost'
  | 'external-change';

export interface WalletRecordInfo {
  readonly kdf: KdfParams;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recordHash: string;
}

export interface WalletAccountView {
  readonly id: string;
  readonly address: string;
  readonly label: string;
  readonly source: AccountSource;
  readonly active: boolean;
}

export interface WalletSnapshot {
  readonly accounts: readonly WalletAccountView[];
  readonly activeAccountId: string;
  readonly activeAddress: string;
  readonly activeLabel: string;
  /** 1-based position of the active account in payload order. */
  readonly activeIndex: number;
}

export type WalletState =
  | { readonly status: 'UNAVAILABLE'; readonly code: 'remote' }
  | { readonly status: 'NO_VAULT' }
  | {
      readonly status: 'LOCKED';
      /** Public record metadata only; `null` when corrupt. */
      readonly record: WalletRecordInfo | null;
      /** A `pending` record exists without a usable primary record. */
      readonly recoveryPending: boolean;
      readonly corrupt: boolean;
    }
  | { readonly status: 'UNLOCKED'; readonly snapshot: WalletSnapshot };

export interface WalletFailure {
  readonly ok: false;
  readonly code: WalletFailureCode;
  readonly message: string;
  /** Present only for `UNLOCK_RATE_LIMITED`. */
  readonly retryAfterSeconds?: number;
  /**
   * Present on password-change failures with a determined resolution; absent
   * when the post-write read-back could not confirm any outcome.
   */
  readonly resolution?: ChangeResolution;
  /** Present on a create failure whose record did land on disk. */
  readonly walletCreated?: boolean;
}

export type WalletResult<T> = { readonly ok: true; readonly value: T } | WalletFailure;

export type PendingSecretKind = 'mnemonic' | 'privateKey';

export interface PendingFlowSecret {
  readonly kind: PendingSecretKind;
  /** A mnemonic or a `0x` private key; held until the flow consumes/cancels it. */
  readonly value: string;
}

export type RevealKind = 'mnemonic' | 'privateKey';

export interface RevealedSecret {
  readonly kind: RevealKind;
  readonly value: string;
  /** Set when a mnemonic account's private key is derived. */
  readonly derivationPath?: string;
}

export interface ChangePasswordOutcome {
  /** `true` when the wallet must be unlocked again with the new password. */
  readonly locked: boolean;
  /** The old `pending` record could not be removed; the next unlock cleans it. */
  readonly pendingCleanupFailed: boolean;
}

export interface DeleteAccountOutcome {
  readonly walletDeleted: boolean;
}

export interface AccountDeletionInfo {
  readonly accountId: string;
  readonly isLastAccount: boolean;
  /** Copy for the confirmation UI, or `null` for a non-last account. */
  readonly warning: string | null;
}

export interface ResetOutcome {
  readonly state: 'NO_VAULT' | 'LOCKED';
}

export interface CreateVaultOptions {
  readonly source?: AccountSource;
  readonly label?: string;
}

// ---------------------------------------------------------------------------
// Injected core, scheduler and status sink
// ---------------------------------------------------------------------------

/** The core's password-change input, redeclared to avoid a name clash. */
export interface WalletChangePasswordInput {
  currentPassword: string;
  newPassword: string;
  expectedRecordHash: string;
}

export interface WalletCore {
  loadVault(deps: VaultDeps): Promise<VaultLoad>;
  createVault(
    deps: VaultDeps,
    input: { password: string; account: NewAccountInput },
  ): Promise<VaultResult<UnlockedVault>>;
  unlockVault(deps: VaultDeps, password: string): Promise<VaultResult<UnlockOutcome>>;
  changePassword(deps: VaultDeps, input: WalletChangePasswordInput): Promise<ChangePasswordResult>;
  addAccount(
    deps: VaultDeps,
    vault: UnlockedVault,
    input: NewAccountInput,
  ): Promise<VaultResult<UnlockedVault>>;
  renameAccount(
    deps: VaultDeps,
    vault: UnlockedVault,
    accountId: string,
    label: string,
  ): Promise<VaultResult<UnlockedVault>>;
  setActiveAccount(
    deps: VaultDeps,
    vault: UnlockedVault,
    accountId: string,
  ): Promise<VaultResult<UnlockedVault>>;
  setIdleTimeout(
    deps: VaultDeps,
    vault: UnlockedVault,
    idleTimeoutMs: number | null,
  ): Promise<VaultResult<UnlockedVault>>;
  deleteAccount(
    deps: VaultDeps,
    vault: UnlockedVault,
    accountId: string,
  ): Promise<VaultResult<DeleteOutcome>>;
  resetVault(deps: VaultDeps): Promise<VaultResult<null>>;
  hashRecord(value: unknown): string;
}

/**
 * The real core. Exported so tests can wrap a single operation with a deferred
 * while every other operation stays real.
 */
export const DEFAULT_WALLET_CORE: WalletCore = {
  loadVault,
  createVault,
  unlockVault,
  changePassword: changePasswordOp,
  addAccount,
  renameAccount: renameAccountOp,
  setActiveAccount: setActiveAccountOp,
  setIdleTimeout: setIdleTimeoutOp,
  deleteAccount: deleteAccountOp,
  resetVault,
  hashRecord,
};

export interface WalletScheduler {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const DEFAULT_SCHEDULER: WalletScheduler = {
  setInterval(callback, ms) {
    return globalThis.setInterval(callback, ms);
  },
  clearInterval(handle) {
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
  },
};

export interface WalletStatusSink {
  update(state: WalletStatusState): void;
  dispose?(): void;
}

export interface WalletControllerDeps {
  readonly storage: WalletStorageAdapter;
  readonly availability: WalletAvailability;
  readonly now?: () => number;
  readonly rng?: (length: number) => Uint8Array;
  readonly argon2?: Argon2Runner;
  readonly core?: WalletCore;
  readonly statusBar?: WalletStatusSink;
  readonly scheduler?: WalletScheduler;
  /** Idle poll cadence; defaults to 30 s (design §5.3). */
  readonly idleCheckMs?: number;
  /** External-write poll cadence; defaults to 10 s (design §4.4). */
  readonly pollMs?: number;
}

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

const BACKOFF_SECONDS = [1, 2, 4, 8, 16, 30] as const;
const IDLE_CHECK_MS = 30_000;
const EXTERNAL_POLL_MS = 10_000;
const LAST_ACCOUNT_WARNING =
  'Deleting the last account deletes the wallet. This cannot be undone.';

/** Delay before the next unlock attempt; failures 1-4 are immediate. */
export function unlockDelaySeconds(failures: number): number {
  if (failures < 5) return 0;
  const index = Math.min(failures - 5, BACKOFF_SECONDS.length - 1);
  return BACKOFF_SECONDS[index] ?? 30;
}

function ok<T>(value: T): WalletResult<T> {
  return { ok: true, value };
}

function fail(
  code: WalletFailureCode,
  options: {
    message?: string;
    retryAfterSeconds?: number;
    resolution?: ChangeResolution;
    walletCreated?: boolean;
  } = {},
): WalletFailure {
  const extra: {
    retryAfterSeconds?: number;
    resolution?: ChangeResolution;
    walletCreated?: boolean;
  } = {};
  if (options.retryAfterSeconds !== undefined) extra.retryAfterSeconds = options.retryAfterSeconds;
  if (options.resolution !== undefined) extra.resolution = options.resolution;
  if (options.walletCreated !== undefined) extra.walletCreated = options.walletCreated;
  return {
    ok: false,
    code,
    message: options.message ?? walletErrorMessage(code),
    ...extra,
  };
}

function recordInfoOf(vault: UnlockedVault): WalletRecordInfo {
  return {
    kdf: kdfParamsOf(vault.kdf),
    createdAt: vault.createdAt,
    updatedAt: vault.updatedAt,
    recordHash: vault.recordHash,
  };
}

function accountsOf(payload: VaultPayload): WalletAccountView[] {
  return payload.accounts.map((account) => ({
    id: account.id,
    address: account.address,
    label: account.label,
    source: account.source,
    active: account.id === payload.activeAccountId,
  }));
}

type WriteVerdict = 'new' | 'old' | 'unknown';

type AccountOutcome =
  | { readonly kind: 'ok'; readonly value: UnlockedVault }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'no-session' }
  | { readonly kind: 'unverified' }
  | { readonly kind: 'fail'; readonly error: WalletError };

type DeleteOutcomeResult =
  | { readonly kind: 'ok'; readonly value: DeleteAccountOutcome }
  | { readonly kind: 'wallet-deleted' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'no-session' }
  | { readonly kind: 'unverified' }
  | { readonly kind: 'fail'; readonly error: WalletError };

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class WalletController {
  #storage: WalletStorageAdapter;
  #availability: WalletAvailability;
  #now: () => number;
  #core: WalletCore;
  #statusBar: WalletStatusSink | undefined;
  #scheduler: WalletScheduler;
  #idleCheckMs: number;
  #pollMs: number;
  #vaultDeps: VaultDeps;

  #state: WalletState;
  #session: UnlockedVault | null = null;
  #recordInfo: WalletRecordInfo | null = null;
  #lastActivity = 0;
  #idleTimeoutMs: number | null = DEFAULT_IDLE_TIMEOUT_MS;

  #unlockFailures = 0;
  #blockedUntil = 0;

  #epoch = 0;
  #busy: WalletBusyKind | null = null;
  #pendingFlowSecret: PendingFlowSecret | null = null;
  #panelGeneration = 0;
  #notice: string | null = null;
  #lastLockReason: WalletLockReason | null = null;

  #queue: Promise<unknown> = Promise.resolve();
  #idleTimer: unknown = null;
  #pollTimer: unknown = null;
  #started = false;
  #disposed = false;

  constructor(deps: WalletControllerDeps) {
    this.#storage = deps.storage;
    this.#availability = deps.availability;
    this.#now = deps.now ?? Date.now;
    this.#core = deps.core ?? DEFAULT_WALLET_CORE;
    this.#statusBar = deps.statusBar;
    this.#scheduler = deps.scheduler ?? DEFAULT_SCHEDULER;
    this.#idleCheckMs = deps.idleCheckMs ?? IDLE_CHECK_MS;
    this.#pollMs = deps.pollMs ?? EXTERNAL_POLL_MS;
    this.#state = deps.availability.available
      ? { status: 'NO_VAULT' }
      : { status: 'UNAVAILABLE', code: 'remote' };

    const vaultDeps: VaultDeps = {
      storage: this.#storage,
      keys: this.#storage.keys,
      now: this.#now,
    };
    if (deps.rng !== undefined) vaultDeps.rng = deps.rng;
    if (deps.argon2 !== undefined) vaultDeps.argon2 = deps.argon2;
    this.#vaultDeps = vaultDeps;
  }

  // -------------------------------------------------------------------------
  // Read-only surface
  // -------------------------------------------------------------------------

  get state(): WalletState {
    return this.#state;
  }

  /** Session record hash; `null` while locked. No payload/key accessor exists. */
  get recordHash(): string | null {
    return this.#session?.recordHash ?? null;
  }

  get epoch(): number {
    return this.#epoch;
  }

  get busy(): WalletBusyKind | null {
    return this.#busy;
  }

  get panelGeneration(): number {
    return this.#panelGeneration;
  }

  get lastLockReason(): WalletLockReason | null {
    return this.#lastLockReason;
  }

  get idleTimeoutMs(): number | null {
    return this.#idleTimeoutMs;
  }

  get notice(): string | null {
    return this.#notice;
  }

  hasPendingSecret(): boolean {
    return this.#pendingFlowSecret !== null;
  }

  pendingFlowKind(): PendingSecretKind | null {
    return this.#pendingFlowSecret?.kind ?? null;
  }

  /**
   * Public address for a freshly generated mnemonic so the create panel can
   * show it before anything is stored. Derivation stays inside the
   * controller; no key or secret is returned.
   */
  previewMnemonicAddress(words: string): WalletResult<{ readonly address: string }> {
    if (!this.#availability.available) return fail('WALLET_REMOTE_UNSUPPORTED');
    if (this.#disposed) return fail('OPERATION_CANCELLED');
    try {
      return ok({ address: deriveAccountFromMnemonic(words).address });
    } catch (error) {
      return fail(isWalletError(error) ? error.code : 'SECRET_UNAVAILABLE');
    }
  }

  /**
   * Public address for the pending flow secret (import confirmation).
   * Derivation only — no KDF, no storage — and the secret itself never leaves
   * this class. Returns `SECRET_UNAVAILABLE` when nothing is pending.
   */
  pendingAccountPreview(): WalletResult<{ readonly address: string }> {
    if (!this.#availability.available) return fail('WALLET_REMOTE_UNSUPPORTED');
    if (this.#disposed) return fail('OPERATION_CANCELLED');
    const secret = this.#pendingFlowSecret;
    if (secret === null) return fail('SECRET_UNAVAILABLE');
    try {
      const address =
        secret.kind === 'mnemonic'
          ? deriveAccountFromMnemonic(secret.value).address
          : privateKeyToAddress(secret.value);
      return ok({ address });
    } catch (error) {
      return fail(isWalletError(error) ? error.code : 'SECRET_UNAVAILABLE');
    }
  }

  /**
   * Whole seconds until the unlock limiter expires; `0` means "prompt now".
   * Read-only: asking never consumes or resets the limiter.
   */
  unlockRetryAfterSeconds(): number {
    const remaining = this.#blockedUntil - this.#now();
    if (remaining <= 0) return 0;
    return Math.max(1, Math.ceil(remaining / 1000));
  }

  /** Account views (copies); empty unless unlocked. */
  accounts(): readonly WalletAccountView[] {
    return this.#state.status === 'UNLOCKED' ? this.#state.snapshot.accounts : [];
  }

  activeAccount(): WalletAccountView | null {
    if (this.#state.status !== 'UNLOCKED') return null;
    const snapshot = this.#state.snapshot;
    return snapshot.accounts.find((account) => account.id === snapshot.activeAccountId) ?? null;
  }

  consumeNotice(): string | null {
    const notice = this.#notice;
    this.#notice = null;
    return notice;
  }

  /** Panel lifecycle hook: a new panel invalidates older panel messages. */
  beginPanel(): number {
    this.#panelGeneration += 1;
    return this.#panelGeneration;
  }

  isPanelCurrent(generation: number): boolean {
    return generation === this.#panelGeneration;
  }

  /** Wallet commands call this so idle time only counts wallet activity. */
  touch(): void {
    if (this.#session !== null) this.#lastActivity = this.#now();
  }

  // -------------------------------------------------------------------------
  // Pending flow secret (create/import)
  // -------------------------------------------------------------------------

  setPendingSecret(secret: PendingFlowSecret): WalletResult<null> {
    if (!this.#availability.available) return fail('WALLET_REMOTE_UNSUPPORTED');
    if (this.#disposed) return fail('OPERATION_CANCELLED');
    if (this.#busy !== null) return fail('WALLET_BUSY');
    if (
      (secret.kind !== 'mnemonic' && secret.kind !== 'privateKey') ||
      typeof secret.value !== 'string' ||
      secret.value === ''
    ) {
      return fail('SECRET_UNAVAILABLE');
    }
    this.#pendingFlowSecret = { kind: secret.kind, value: secret.value };
    return ok(null);
  }

  clearPendingSecret(): void {
    this.#pendingFlowSecret = null;
  }

  // -------------------------------------------------------------------------
  // Load and external-change detection
  // -------------------------------------------------------------------------

  /** Reads both keys through `loadVault`; never runs the KDF. */
  async load(): Promise<WalletState> {
    if (!this.#availability.available || this.#disposed) return this.#state;
    try {
      const loaded = await this.#enqueue(() => this.#core.loadVault(this.#vaultDeps));
      this.#applyLoad(loaded);
    } catch {
      this.#applyLoadFailure();
    }
    return this.#state;
  }

  async pollExternal(): Promise<boolean> {
    if (!this.#availability.available || this.#disposed) return false;
    if (this.#state.status !== 'UNLOCKED' || this.#session === null) return false;

    return this.#enqueue(async () => {
      const session = this.#session;
      if (session === null || this.#state.status !== 'UNLOCKED') return false;

      let value: unknown;
      try {
        const read = await this.#storage.get(this.#storage.keys.record);
        value = read[this.#storage.keys.record];
      } catch {
        // Cannot verify the record: drop the key rather than keep it on trust.
        await this.#lockAndReloadNow('external-change', walletUnverifiedMessage());
        return true;
      }

      if (value === undefined || this.#core.hashRecord(value) !== session.recordHash) {
        // An external delete goes through `loadVault` so a lone `pending`
        // record stays recoverable instead of becoming NO_VAULT (VR-02).
        await this.#lockAndReloadNow(
          'external-change',
          walletErrorMessage('WALLET_CHANGED_EXTERNALLY'),
        );
        return true;
      }
      return false;
    });
  }

  /**
   * Window focus. Losing focus locks immediately (`focus-lost`); regaining it
   * re-reads and compares the record hash (design §4.4).
   */
  async handleWindowFocus(focused: boolean): Promise<void> {
    if (!focused) {
      this.lock('focus-lost');
      return;
    }
    await this.pollExternal();
  }

  /** Hidden context locks even when the idle timeout is disabled. */
  handleVisibility(visibility: 'visible' | 'hidden'): void {
    if (visibility === 'hidden') this.lock('hidden');
  }

  handlePageHide(): void {
    this.lock('pagehide');
  }

  /** Starts the idle check and the external-write poll. */
  start(): void {
    if (this.#disposed || this.#started || !this.#availability.available) return;
    this.#started = true;
    this.#idleTimer = this.#scheduler.setInterval(() => this.checkIdle(), this.#idleCheckMs);
    this.#pollTimer = this.#scheduler.setInterval(() => {
      void this.pollExternal();
    }, this.#pollMs);
  }

  checkIdle(): void {
    if (this.#state.status !== 'UNLOCKED' || this.#session === null) return;
    if (this.#idleTimeoutMs === null) return;
    const idleFor = this.#now() - this.#lastActivity;
    if (idleFor >= this.#idleTimeoutMs) this.lock('idle');
  }

  // -------------------------------------------------------------------------
  // Lock
  // -------------------------------------------------------------------------

  /**
   * Idempotent lock. Order matters: invalidate in-flight work and drop flow
   * secrets before clearing the session, so no `await` continuation can
   * observe a half-cleared state (DR-19). The unlock limiter deliberately
   * survives: locking must not be a way to reset a lockout.
   */
  lock(reason: WalletLockReason = 'explicit'): void {
    const hadSession = this.#session !== null;
    this.#epoch += 1;
    this.#pendingFlowSecret = null;
    this.#panelGeneration += 1;
    this.#lastLockReason = reason;

    this.#session = null;
    this.#clearIdleConfig();

    if (!this.#availability.available) return;

    if (hadSession) {
      this.#setState({
        status: 'LOCKED',
        record: this.#recordInfo,
        recoveryPending: false,
        corrupt: false,
      });
      return;
    }
    // Already locked (or no vault): keep its metadata untouched.
    this.#setState(this.#state);
  }

  // -------------------------------------------------------------------------
  // Create and unlock
  // -------------------------------------------------------------------------

  async create(
    password: string,
    options: CreateVaultOptions = {},
  ): Promise<WalletResult<WalletSnapshot>> {
    if (!this.#availability.available) return fail('WALLET_REMOTE_UNSUPPORTED');
    if (this.#disposed) return fail('OPERATION_CANCELLED');
    if (this.#busy !== null) return fail('WALLET_BUSY');

    const secret = this.#pendingFlowSecret;
    const source: AccountSource =
      options.source ??
      (secret === null ? 'created' : secret.kind === 'mnemonic' ? 'mnemonic' : 'private-key');
    const account = this.#accountFromSecret(secret, source, options.label);
    if (account === null) {
      this.#pendingFlowSecret = null;
      return fail('SECRET_UNAVAILABLE');
    }

    if (!this.#begin('create')) return fail('WALLET_BUSY');
    const epoch = this.#epoch;
    try {
      const outcome = await this.#enqueue(async () => {
        if (!this.#isCurrent(epoch)) return { kind: 'cancelled' as const };
        this.#storage.clearAttempts();
        const result = await this.#core.createVault(this.#vaultDeps, { password, account });
        if (!result.ok) return { kind: 'result' as const, result };
        if (!this.#isCurrent(epoch)) return { kind: 'cancelled' as const };
        // Design §4.2 step 7: a resolved `set` is not proof of persistence.
        // Read the record back and unlock the new session only from a
        // confirmed write, still inside this queued task.
        if (!(await this.#verifyRecordNow(result.value.recordHash))) {
          return { kind: 'unverified' as const };
        }
        // The read-back is another await: a lock that lands during it must
        // win, so never adopt the session after the epoch changed.
        if (!this.#isCurrent(epoch)) return { kind: 'cancelled' as const };
        this.#applySession(result.value);
        return { kind: 'result' as const, result };
      });

      if (outcome.kind === 'cancelled') {
        await this.#reload();
        return fail('OPERATION_CANCELLED');
      }
      if (outcome.kind === 'unverified') {
        // The disk does not match what the core reported: never adopt the
        // in-memory vault, and let `loadVault` describe the real state.
        this.lock('external-change');
        await this.#reload();
        this.#notify(walletUnverifiedMessage());
        return fail('STORAGE_FAILED', { message: walletUnverifiedMessage() });
      }

      const result = outcome.result;
      if (!result.ok) {
        if (result.error.code === 'VAULT_EXISTS') {
          await this.#reload();
          return fail('VAULT_EXISTS');
        }
        if (result.error.code === 'STORAGE_FAILED') {
          return this.#handleCreateStorageFailure();
        }
        return fail(result.error.code);
      }

      if (!this.#isCurrent(epoch)) {
        await this.#reload();
        return fail('OPERATION_CANCELLED');
      }

      return ok(this.#snapshotOf(result.value));
    } finally {
      this.#pendingFlowSecret = null;
      this.#end('create');
    }
  }

  async unlock(password: string): Promise<WalletResult<WalletSnapshot>> {
    if (!this.#availability.available) return fail('WALLET_REMOTE_UNSUPPORTED');
    if (this.#disposed) return fail('OPERATION_CANCELLED');

    const now = this.#now();
    if (now < this.#blockedUntil) {
      const seconds = Math.max(1, Math.ceil((this.#blockedUntil - now) / 1000));
      return fail('UNLOCK_RATE_LIMITED', {
        message: walletRateLimitMessage(seconds),
        retryAfterSeconds: seconds,
      });
    }

    if (!this.#begin('unlock')) return fail('WALLET_BUSY');
    const epoch = this.#epoch;
    try {
      const outcome = await this.#enqueue(async () => {
        if (!this.#isCurrent(epoch)) return { kind: 'cancelled' as const };
        const result = await this.#core.unlockVault(this.#vaultDeps, password);
        if (!result.ok) return { kind: 'fail' as const, error: result.error };
        if (!this.#isCurrent(epoch)) return { kind: 'cancelled' as const };
        this.#applySession(result.value.vault);
        this.#unlockFailures = 0;
        this.#blockedUntil = 0;
        if (result.value.recoveredFromPending) {
          this.#notice =
            'Recovered the wallet from an interrupted password change. Remove any backup of the old password when you can.';
        }
        return { kind: 'ok' as const, vault: result.value.vault };
      });

      if (outcome.kind === 'cancelled') {
        await this.#reload();
        return fail('OPERATION_CANCELLED');
      }
      if (outcome.kind === 'fail') {
        const code = outcome.error.code;
        if (code === 'DECRYPT_FAILED') this.#recordUnlockFailure();
        if (code === 'NO_VAULT' || code === 'VAULT_CORRUPT' || code === 'KDF_PARAMS_UNSUPPORTED') {
          await this.#reload();
        }
        return fail(code);
      }
      if (!this.#isCurrent(epoch) || this.#session === null) {
        await this.#reload();
        return fail('OPERATION_CANCELLED');
      }
      return ok(this.#snapshotOf(outcome.vault));
    } finally {
      this.#end('unlock');
    }
  }

  // -------------------------------------------------------------------------
  // Account operations
  // -------------------------------------------------------------------------

  async addAccount(): Promise<WalletResult<WalletSnapshot>> {
    if (!this.#availability.available) return fail('WALLET_REMOTE_UNSUPPORTED');
    if (this.#disposed) return fail('OPERATION_CANCELLED');
    if (this.#busy !== null) return fail('WALLET_BUSY');
    const secret = this.#pendingFlowSecret;
    if (secret === null) return fail('SECRET_UNAVAILABLE');

    const source: AccountSource = secret.kind === 'mnemonic' ? 'mnemonic' : 'private-key';
    const input = this.#accountFromSecret(secret, source, undefined);
    if (input === null) {
      this.#pendingFlowSecret = null;
      return fail('SECRET_UNAVAILABLE');
    }

    try {
      return await this.#accountWrite((vault) =>
        this.#core.addAccount(this.#vaultDeps, vault, input),
      );
    } finally {
      this.#pendingFlowSecret = null;
    }
  }

  async rename(accountId: string, label: string): Promise<WalletResult<WalletSnapshot>> {
    return this.#accountWrite((vault) =>
      this.#core.renameAccount(this.#vaultDeps, vault, accountId, label),
    );
  }

  async setActive(accountId: string): Promise<WalletResult<WalletSnapshot>> {
    return this.#accountWrite((vault) =>
      this.#core.setActiveAccount(this.#vaultDeps, vault, accountId),
    );
  }

  async setIdleTimeout(idleTimeoutMs: number | null): Promise<WalletResult<WalletSnapshot>> {
    const result = await this.#accountWrite((vault) =>
      this.#core.setIdleTimeout(this.#vaultDeps, vault, idleTimeoutMs),
    );
    if (result.ok) this.touch();
    return result;
  }

  /** Confirmation data for the delete UI; never deletes anything itself. */
  describeAccountDeletion(accountId: string): AccountDeletionInfo | null {
    if (this.#state.status !== 'UNLOCKED') return null;
    const snapshot = this.#state.snapshot;
    const account = snapshot.accounts.find((entry) => entry.id === accountId);
    if (account === undefined) return null;
    const isLastAccount = snapshot.accounts.length === 1;
    return {
      accountId,
      isLastAccount,
      warning: isLastAccount ? LAST_ACCOUNT_WARNING : null,
    };
  }

  async deleteAccount(accountId: string): Promise<WalletResult<DeleteAccountOutcome>> {
    if (!this.#availability.available) return fail('WALLET_REMOTE_UNSUPPORTED');
    if (this.#disposed) return fail('OPERATION_CANCELLED');
    if (!this.#begin('account-write')) return fail('WALLET_BUSY');
    const epoch = this.#epoch;
    try {
      const outcome = await this.#enqueue(async (): Promise<DeleteOutcomeResult> => {
        const current = this.#session;
        if (current === null || this.#state.status !== 'UNLOCKED') return { kind: 'no-session' };
        if (!this.#isCurrent(epoch)) return { kind: 'cancelled' };
        this.#storage.clearAttempts();
        const result = await this.#core.deleteAccount(this.#vaultDeps, current, accountId);
        if (!result.ok) return { kind: 'fail', error: result.error };
        if (!this.#isCurrent(epoch)) return { kind: 'cancelled' };
        if (result.value.vault === null) {
          // Design §4.2 step 7: `remove` resolving is not proof. Report a
          // deleted wallet only when both raw keys are confirmed absent.
          if (!(await this.#verifyWalletAbsentNow())) return { kind: 'unverified' };
          // A lock during the absence check still invalidates the in-flight
          // success; reload is the authority on the final state.
          if (!this.#isCurrent(epoch)) return { kind: 'cancelled' };
          return { kind: 'wallet-deleted' };
        }
        if (!(await this.#verifyRecordNow(result.value.vault.recordHash))) {
          return { kind: 'unverified' };
        }
        // Re-check after the read-back await; a lock during verification must
        // not leave an unlocked session behind.
        if (!this.#isCurrent(epoch)) return { kind: 'cancelled' };
        this.#applySession(result.value.vault);
        return { kind: 'ok', value: { walletDeleted: false } };
      });

      if (outcome.kind === 'no-session') return fail('LOCKED');
      if (outcome.kind === 'cancelled') {
        await this.#reload();
        return fail('OPERATION_CANCELLED');
      }
      if (outcome.kind === 'unverified') {
        // Never report `walletDeleted` (or anything else) on an unconfirmed
        // write; reload is the only authority.
        this.lock('external-change');
        await this.#reload();
        this.#notify(walletUnverifiedMessage());
        return fail('STORAGE_FAILED', { message: walletUnverifiedMessage() });
      }
      if (outcome.kind === 'wallet-deleted') {
        this.lock('explicit');
        await this.#reload();
        return ok({ walletDeleted: true });
      }
      if (outcome.kind === 'ok') return ok(outcome.value);

      if (outcome.error.code === 'STORAGE_FAILED') {
        const verdict = await this.#reconcileWriteFailure(epoch);
        if (verdict === 'recovered') return ok({ walletDeleted: false });
        await this.#reload();
        if (this.#state.status === 'NO_VAULT') return ok({ walletDeleted: true });
        if (verdict === 'old') {
          return fail('STORAGE_FAILED', { message: walletNotAppliedMessage() });
        }
        this.#notify(walletUnverifiedMessage());
        return fail('STORAGE_FAILED', { message: walletUnverifiedMessage() });
      }
      if (outcome.error.code === 'CONFLICT' || outcome.error.code === 'NO_VAULT') {
        const code: WalletFailureCode =
          outcome.error.code === 'CONFLICT' ? 'WALLET_CHANGED_EXTERNALLY' : 'NO_VAULT';
        this.lock('external-change');
        await this.#reload();
        this.#notify(walletErrorMessage('WALLET_CHANGED_EXTERNALLY'));
        return fail(code);
      }
      return fail(outcome.error.code);
    } finally {
      this.#end('account-write');
    }
  }

  // -------------------------------------------------------------------------
  // Verify and reveal (export)
  // -------------------------------------------------------------------------

  /**
   * Re-verifies the password against the current record, then returns the
   * requested secret from the freshly decrypted payload. The session is not
   * mutated; the caller must display the secret and drop the reference.
   */
  async verifyAndReveal(
    kind: RevealKind,
    accountId: string,
    password: string,
  ): Promise<WalletResult<RevealedSecret>> {
    if (!this.#availability.available) return fail('WALLET_REMOTE_UNSUPPORTED');
    if (this.#disposed) return fail('OPERATION_CANCELLED');
    if (this.#state.status !== 'UNLOCKED' || this.#session === null) return fail('LOCKED');
    if (!this.#begin('export')) return fail('WALLET_BUSY');

    const epoch = this.#epoch;
    const sessionHash = this.#session.recordHash;
    try {
      const outcome = await this.#enqueue(async () => {
        if (!this.#isCurrent(epoch) || this.#state.status !== 'UNLOCKED') {
          return { kind: 'cancelled' as const };
        }
        const result = await this.#core.unlockVault(this.#vaultDeps, password);
        if (!result.ok) return { kind: 'fail' as const, error: result.error };
        if (!this.#isCurrent(epoch) || this.#state.status !== 'UNLOCKED') {
          return { kind: 'cancelled' as const };
        }
        if (result.value.vault.recordHash !== sessionHash) {
          // The record changed between our last save and this verify: do not
          // show a secret that may belong to a record another window replaced.
          this.lock('external-change');
          this.#notice = walletErrorMessage('WALLET_CHANGED_EXTERNALLY');
          return { kind: 'changed' as const };
        }
        const secret = this.#revealFromPayload(result.value.vault.payload, kind, accountId);
        return secret.ok
          ? { kind: 'ok' as const, secret: secret.value }
          : { kind: 'fail' as const, failure: secret };
      });

      if (outcome.kind === 'cancelled') {
        await this.#reload();
        return fail('OPERATION_CANCELLED');
      }
      if (outcome.kind === 'changed') {
        await this.#reload();
        return fail('WALLET_CHANGED_EXTERNALLY');
      }
      if (outcome.kind === 'fail') {
        if ('failure' in outcome) return outcome.failure;
        return fail(outcome.error.code);
      }
      return ok(outcome.secret);
    } finally {
      this.#end('export');
      this.touch();
    }
  }

  // -------------------------------------------------------------------------
  // Change password and reset
  // -------------------------------------------------------------------------

  async changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<WalletResult<ChangePasswordOutcome>> {
    if (!this.#availability.available) return fail('WALLET_REMOTE_UNSUPPORTED');
    if (this.#disposed) return fail('OPERATION_CANCELLED');
    if (this.#state.status === 'NO_VAULT') return fail('NO_VAULT');
    if (this.#state.status === 'UNAVAILABLE') return fail('WALLET_REMOTE_UNSUPPORTED');
    if (!this.#begin('change-password')) return fail('WALLET_BUSY');

    const epoch = this.#epoch;
    const wasUnlocked = this.#state.status === 'UNLOCKED' && this.#session !== null;
    try {
      let expectedHash: string | null;
      if (this.#session !== null) {
        expectedHash = this.#session.recordHash;
      } else {
        try {
          expectedHash = await this.#readRecordHash();
        } catch {
          return fail('STORAGE_FAILED');
        }
      }
      if (expectedHash === null) return fail('NO_VAULT');
      const expected = expectedHash;

      const outcome = await this.#enqueue(async () => {
        if (!this.#isCurrent(epoch)) return { kind: 'cancelled' as const };
        this.#storage.clearAttempts();
        const result = await this.#core.changePassword(this.#vaultDeps, {
          currentPassword,
          newPassword,
          expectedRecordHash: expected,
        });

        if (!result.ok) {
          if (result.resolution === 'old-password-still-valid') {
            // Only a confirmed old primary record may keep this resolution.
            const verdict = await this.#classifyNow(this.#storage.keys.record);
            if (verdict !== 'old') {
              // Something else replaced the primary record during the change:
              // neither password is confirmed, so lock and reload.
              this.lock('external-change');
              this.#notice = walletErrorMessage('WALLET_CHANGED_EXTERNALLY');
              return {
                kind: 'fail' as const,
                error: result.error,
                resolution: 'wallet-changed' as const,
              };
            }
          }
          return { kind: 'fail' as const, error: result.error, resolution: result.resolution };
        }

        // Design §4.2 step 7: the core already reads back `pending`, but a
        // resolved primary `set` is still not proof. Confirm the new record
        // before reporting success, including the raced `changed-locked` path.
        if (!(await this.#verifyRecordNow(result.value.recordHash))) {
          return { kind: 'unverified' as const };
        }

        if (!this.#isCurrent(epoch)) {
          // The change succeeded but a lock raced it. Keep it locked; the
          // reload below adopts the new metadata. Never resurrect the session.
          this.#notice = walletNewPasswordMessage();
          return {
            kind: 'changed-locked' as const,
            pendingCleanupFailed: result.pendingCleanupFailed,
          };
        }

        if (wasUnlocked && this.#state.status === 'UNLOCKED') {
          this.#applySession(result.value);
          return { kind: 'changed' as const, pendingCleanupFailed: result.pendingCleanupFailed };
        }

        // Locked-state change: discard the returned key, keep metadata only.
        this.#recordInfo = recordInfoOf(result.value);
        this.#setState({
          status: 'LOCKED',
          record: this.#recordInfo,
          recoveryPending: false,
          corrupt: false,
        });
        return { kind: 'changed-locked' as const, pendingCleanupFailed: result.pendingCleanupFailed };
      });

      if (outcome.kind === 'cancelled') {
        await this.#reload();
        return fail('OPERATION_CANCELLED');
      }
      if (outcome.kind === 'unverified') {
        // The change was reported applied but cannot be confirmed on disk:
        // lock, reload, and never claim the password changed.
        this.lock('external-change');
        await this.#reload();
        this.#notify(walletUnverifiedMessage());
        return fail('STORAGE_FAILED', { message: walletUnverifiedMessage() });
      }
      if (outcome.kind === 'changed') {
        if (outcome.pendingCleanupFailed) {
          this.#notice =
            'Password changed. The old pending record could not be removed; it will be cleaned up on the next unlock.';
        }
        return ok({ locked: false, pendingCleanupFailed: outcome.pendingCleanupFailed });
      }
      if (outcome.kind === 'changed-locked') {
        this.#notice = walletNewPasswordMessage();
        await this.#reload();
        return ok({ locked: true, pendingCleanupFailed: outcome.pendingCleanupFailed });
      }

      if (outcome.resolution === 'wallet-changed') {
        const code: WalletFailureCode =
          outcome.error.code === 'CONFLICT' ? 'WALLET_CHANGED_EXTERNALLY' : outcome.error.code;
        this.lock('external-change');
        this.#notice = walletErrorMessage('WALLET_CHANGED_EXTERNALLY');
        await this.#reload();
        return fail(code, { resolution: 'wallet-changed' });
      }
      if (outcome.resolution === 'try-new-password') {
        this.lock('explicit');
        this.#notice = walletTryNewPasswordMessage();
        await this.#reload();
        return fail(outcome.error.code, {
          resolution: 'try-new-password',
          message: walletTryNewPasswordMessage(),
        });
      }
      // Old password rejected; the primary record is unchanged and the
      // session stays usable (design §5.3: a failed change does not lock).
      return fail(
        outcome.error.code,
        outcome.error.code === 'DECRYPT_FAILED'
          ? {
              resolution: 'old-password-still-valid',
              message: walletWrongOldPasswordMessage(),
            }
          : { resolution: 'old-password-still-valid' },
      );
    } finally {
      this.#end('change-password');
    }
  }

  async reset(): Promise<WalletResult<ResetOutcome>> {
    if (!this.#availability.available) return fail('WALLET_REMOTE_UNSUPPORTED');
    if (this.#disposed) return fail('OPERATION_CANCELLED');
    if (this.#state.status === 'UNLOCKED') {
      return fail('LOCKED', { message: 'Lock the wallet before resetting it.' });
    }
    if (this.#state.status === 'NO_VAULT' || this.#state.status === 'UNAVAILABLE') {
      return fail('NO_VAULT');
    }
    if (!this.#begin('account-write')) return fail('WALLET_BUSY');

    // Reset invalidates anything in flight before the first await.
    this.#epoch += 1;
    this.#pendingFlowSecret = null;
    try {
      const outcome = await this.#enqueue(async () => {
        this.#storage.clearAttempts();
        const result = await this.#core.resetVault(this.#vaultDeps);
        if (!result.ok) return { kind: 'fail' as const, error: result.error };
        // Design §4.2 step 7: `remove` resolving is not proof. Only a
        // confirmed absence of both raw keys may become NO_VAULT.
        return (await this.#verifyWalletAbsentNow())
          ? { kind: 'removed' as const }
          : { kind: 'incomplete' as const };
      });
      await this.#reload();
      if (outcome.kind === 'removed') {
        return ok({ state: this.#stateStatus() === 'NO_VAULT' ? 'NO_VAULT' : 'LOCKED' });
      }
      if (outcome.kind === 'incomplete') {
        // A key remains (or the read failed): never report NO_VAULT on an
        // unconfirmed removal.
        this.#notify(walletUnverifiedMessage());
        return fail('STORAGE_FAILED', { message: walletUnverifiedMessage() });
      }
      if (this.#stateStatus() === 'NO_VAULT') return ok({ state: 'NO_VAULT' });
      this.#notify(walletUnverifiedMessage());
      return fail('STORAGE_FAILED', { message: walletUnverifiedMessage() });
    } finally {
      this.#end('account-write');
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Clears the session, flow secret and both timers. Terminal. */
  dispose(): void {
    if (this.#disposed) return;
    this.lock('pagehide');
    if (this.#idleTimer !== null) {
      this.#scheduler.clearInterval(this.#idleTimer);
      this.#idleTimer = null;
    }
    if (this.#pollTimer !== null) {
      this.#scheduler.clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    this.#disposed = true;
    this.#statusBar?.dispose?.();
  }

  // -------------------------------------------------------------------------
  // Internals: queue, busy flag, state, session
  // -------------------------------------------------------------------------

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #begin(kind: WalletBusyKind): boolean {
    if (this.#busy !== null) return false;
    this.#busy = kind;
    return true;
  }

  #end(kind: WalletBusyKind): void {
    if (this.#busy === kind) this.#busy = null;
  }

  #isCurrent(epoch: number): boolean {
    return this.#epoch === epoch && !this.#disposed && this.#availability.available;
  }

  #notify(message: string): void {
    this.#notice = message;
  }

  #stateStatus(): WalletState['status'] {
    return this.#state.status;
  }

  #setState(next: WalletState): void {
    this.#state = next;
    this.#statusBar?.update(this.#statusView(next));
  }

  #statusView(state: WalletState): WalletStatusState {
    switch (state.status) {
      case 'UNAVAILABLE':
        return { status: 'UNAVAILABLE' };
      case 'NO_VAULT':
        return { status: 'NO_VAULT' };
      case 'LOCKED':
        return { status: 'LOCKED' };
      case 'UNLOCKED':
        return {
          status: 'UNLOCKED',
          address: state.snapshot.activeAddress,
          accountLabel: state.snapshot.activeLabel,
        };
    }
  }

  #applySession(vault: UnlockedVault): void {
    this.#session = vault;
    this.#recordInfo = recordInfoOf(vault);
    this.#applyIdleConfig();
    this.#lastActivity = this.#now();
    this.#setState({ status: 'UNLOCKED', snapshot: this.#snapshotOf(vault) });
  }

  #applyIdleConfig(): void {
    const payload = this.#session?.payload;
    if (payload === undefined) {
      this.#idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
      return;
    }
    this.#idleTimeoutMs =
      payload.idleTimeoutMs === undefined ? DEFAULT_IDLE_TIMEOUT_MS : payload.idleTimeoutMs;
  }

  #clearIdleConfig(): void {
    this.#idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
    this.#lastActivity = 0;
  }

  #snapshotOf(vault: UnlockedVault): WalletSnapshot {
    const accounts = accountsOf(vault.payload);
    const activeAccount = vault.payload.accounts.find(
      (account) => account.id === vault.payload.activeAccountId,
    );
    if (activeAccount === undefined) throw new WalletError('VAULT_CORRUPT');
    return {
      accounts,
      activeAccountId: activeAccount.id,
      activeAddress: activeAccount.address,
      activeLabel: activeAccount.label,
      activeIndex: vault.payload.accounts.indexOf(activeAccount) + 1,
    };
  }

  #applyLoad(loaded: VaultLoad): void {
    if (!this.#availability.available) return;

    if (loaded.kind === 'NO_VAULT') {
      if (this.#session !== null) this.lock('external-change');
      this.#recordInfo = null;
      this.#clearIdleConfig();
      this.#setState({ status: 'NO_VAULT' });
      return;
    }

    if (loaded.kind === 'LOCKED') {
      const info: WalletRecordInfo = {
        kdf: kdfParamsOf(loaded.kdf),
        createdAt: loaded.createdAt,
        updatedAt: loaded.updatedAt,
        recordHash: loaded.recordHash,
      };
      if (this.#session !== null && this.#session.recordHash === info.recordHash) {
        return; // Same record: keep the unlocked session.
      }
      if (this.#session !== null) this.lock('external-change');
      this.#recordInfo = info;
      this.#clearIdleConfig();
      this.#setState({
        status: 'LOCKED',
        record: info,
        recoveryPending: loaded.pendingOnly,
        corrupt: loaded.primaryCorrupt,
      });
      return;
    }

    // CORRUPT: keep an unlock/reset entry point, but expose no metadata.
    if (this.#session !== null) this.lock('external-change');
    this.#recordInfo = null;
    this.#clearIdleConfig();
    this.#setState({
      status: 'LOCKED',
      record: null,
      recoveryPending: loaded.pendingOnly,
      corrupt: true,
    });
  }

  #applyLoadFailure(): void {
    if (!this.#availability.available) return;
    this.#session = null;
    this.#recordInfo = null;
    this.#clearIdleConfig();
    this.#setState({ status: 'LOCKED', record: null, recoveryPending: false, corrupt: false });
  }

  async #lockAndReloadNow(reason: WalletLockReason, message: string): Promise<void> {
    this.lock(reason);
    this.#notify(message);
    try {
      this.#applyLoad(await this.#core.loadVault(this.#vaultDeps));
    } catch {
      this.#applyLoadFailure();
    }
  }

  async #reload(): Promise<void> {
    if (!this.#availability.available) return;
    try {
      const loaded = await this.#enqueue(() => this.#core.loadVault(this.#vaultDeps));
      this.#applyLoad(loaded);
    } catch {
      this.#applyLoadFailure();
    }
  }

  // -------------------------------------------------------------------------
  // Internals: account writes and reconciliation
  // -------------------------------------------------------------------------

  async #accountWrite(
    operation: (vault: UnlockedVault) => Promise<VaultResult<UnlockedVault>>,
  ): Promise<WalletResult<WalletSnapshot>> {
    if (!this.#availability.available) return fail('WALLET_REMOTE_UNSUPPORTED');
    if (this.#disposed) return fail('OPERATION_CANCELLED');
    if (!this.#begin('account-write')) return fail('WALLET_BUSY');
    const epoch = this.#epoch;
    try {
      const outcome = await this.#enqueue(async (): Promise<AccountOutcome> => {
        const current = this.#session;
        if (current === null || this.#state.status !== 'UNLOCKED') return { kind: 'no-session' };
        if (!this.#isCurrent(epoch)) return { kind: 'cancelled' };
        this.#storage.clearAttempts();
        const result = await operation(current);
        if (!result.ok) return { kind: 'fail', error: result.error };
        if (!this.#isCurrent(epoch) || this.#state.status !== 'UNLOCKED') {
          return { kind: 'cancelled' };
        }
        // Design §4.2 step 7: confirm the new record on disk before adopting
        // it. Verification and adoption share this queued task, so a poll can
        // never observe the stale hash (DR-01).
        if (!(await this.#verifyRecordNow(result.value.recordHash))) {
          return { kind: 'unverified' };
        }
        // The read-back is another await; re-check before adopting so a lock
        // during verification is never overwritten by a stale success.
        if (!this.#isCurrent(epoch) || this.#state.status !== 'UNLOCKED') {
          return { kind: 'cancelled' };
        }
        // Same critical section as the successful write: the new hash is
        // visible before any queued poll can read the record (DR-01).
        this.#applySession(result.value);
        return { kind: 'ok', value: result.value };
      });

      if (outcome.kind === 'no-session') return fail('LOCKED');
      if (outcome.kind === 'cancelled') {
        await this.#reload();
        return fail('OPERATION_CANCELLED');
      }
      if (outcome.kind === 'unverified') {
        // A resolved set whose read-back disagrees: the disk state is unknown.
        // Lock instead of claiming success or "nothing changed".
        this.lock('external-change');
        await this.#reload();
        this.#notify(walletUnverifiedMessage());
        return fail('STORAGE_FAILED', { message: walletUnverifiedMessage() });
      }
      if (outcome.kind === 'fail') return this.#handleAccountFailure(outcome.error, epoch);
      return ok(this.#snapshotOf(outcome.value));
    } finally {
      this.#end('account-write');
    }
  }

  async #handleAccountFailure(
    error: WalletError,
    epoch: number,
  ): Promise<WalletResult<WalletSnapshot>> {
    if (error.code === 'CONFLICT' || error.code === 'NO_VAULT') {
      const code: WalletFailureCode =
        error.code === 'CONFLICT' ? 'WALLET_CHANGED_EXTERNALLY' : 'NO_VAULT';
      this.lock('external-change');
      await this.#reload();
      this.#notify(walletErrorMessage('WALLET_CHANGED_EXTERNALLY'));
      return fail(code);
    }
    if (error.code === 'STORAGE_FAILED') {
      const verdict = await this.#reconcileWriteFailure(epoch);
      if (verdict === 'recovered') {
        return this.#state.status === 'UNLOCKED'
          ? ok(this.#state.snapshot)
          : fail('OPERATION_CANCELLED');
      }
      if (verdict === 'old') {
        return fail('STORAGE_FAILED', { message: walletNotAppliedMessage() });
      }
      this.lock('external-change');
      await this.#reload();
      this.#notify(walletUnverifiedMessage());
      return fail('STORAGE_FAILED', { message: walletUnverifiedMessage() });
    }
    return fail(error.code);
  }

  /**
   * Design §4.2 step 7. `new` means the attempted value is on disk; `old`
   * means the previously read value is still there; anything else is
   * unknown and must lock. An adopted record is only trusted if the write
   * came from this session and the epoch is unchanged.
   */
  #reconcileWriteFailure(epoch: number): Promise<'recovered' | WriteVerdict> {
    // Classification and adoption share one queued task so a 10 s poll can
    // never observe the stale hash between them and lock the window.
    return this.#enqueue(async () => {
      const verdict = await this.#classifyNow(this.#storage.keys.record);
      if (verdict !== 'new') return verdict;
      return (await this.#adoptNow(epoch)) ? 'recovered' : 'unknown';
    });
  }

  #classify(key: string): Promise<WriteVerdict> {
    return this.#enqueue(() => this.#classifyNow(key));
  }

  async #classifyNow(key: string): Promise<WriteVerdict> {
    const attempt = this.#storage.lastAttempt(key);
    const previous = this.#storage.lastRead(key);
    let current: string | null;
    try {
      current = await this.#storage.readRaw(key);
    } catch {
      return 'unknown';
    }
    if (attempt !== undefined) {
      if (attempt.kind === 'set' && current === attempt.raw) return 'new';
      if (attempt.kind === 'remove' && current === null) return 'new';
    }
    if (previous !== undefined && current === previous) return 'old';
    return 'unknown';
  }

  /**
   * Rebuilds the session from the record on disk after a write that landed
   * but reported an error. Only core primitives are used: parse, decrypt with
   * the existing key, validate. Runs inside the queue and rechecks the epoch.
   */
  async #adoptNow(epoch: number): Promise<boolean> {
    const session = this.#session;
    if (session === null || this.#state.status !== 'UNLOCKED') return false;
    try {
      const read = await this.#storage.get(this.#storage.keys.record);
      const value = read[this.#storage.keys.record];
      if (value === undefined) return false;
      const record = parseWalletRecord(value);
      const json = await decryptJson(session.key, record.cipher.iv, record.cipher.ciphertext);
      const payload = validateVaultPayload(json);
      if (!this.#isCurrent(epoch)) return false;
      const adopted: UnlockedVault = {
        payload,
        key: session.key,
        recordHash: this.#core.hashRecord(value),
        kdf: kdfParamsOf(record.kdf),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
      this.#applySession(adopted);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Design §4.2 step 7: a resolved `set` is not proof of persistence. Reads
   * the primary record back through the adapter and compares its hash with
   * the one the successful core operation reported. Total by contract: a read
   * throw, a missing record, a corrupt value or a hash mismatch is `false`,
   * never an exception. Call only inside a queued task, right after the write
   * and before the session is adopted (DR-01). Record contents are never
   * logged or returned.
   */
  async #verifyRecordNow(expectedHash: string): Promise<boolean> {
    try {
      const read = await this.#storage.get(this.#storage.keys.record);
      const value = read[this.#storage.keys.record];
      if (value === undefined) return false;
      return this.#core.hashRecord(value) === expectedHash;
    } catch {
      return false;
    }
  }

  /**
   * `true` only when both wallet keys are confirmed absent on disk. Used for
   * a deleted wallet and for reset (design §4.2 step 7); a read failure is
   * `false` so no caller can claim an unconfirmed removal.
   */
  async #verifyWalletAbsentNow(): Promise<boolean> {
    try {
      const record = await this.#storage.readRaw(this.#storage.keys.record);
      const pending = await this.#storage.readRaw(this.#storage.keys.pending);
      return record === null && pending === null;
    } catch {
      return false;
    }
  }

  #readRecordHash(): Promise<string | null> {
    return this.#enqueue(async () => {
      const read = await this.#storage.get(this.#storage.keys.record);
      const value = read[this.#storage.keys.record];
      return value === undefined ? null : this.#core.hashRecord(value);
    });
  }

  async #handleCreateStorageFailure(): Promise<WalletResult<WalletSnapshot>> {
    const verdict = await this.#classify(this.#storage.keys.record);
    if (verdict === 'unknown') {
      this.lock('external-change');
      await this.#reload();
      this.#notify(walletUnverifiedMessage());
      return fail('STORAGE_FAILED', { message: walletUnverifiedMessage() });
    }
    await this.#reload();
    if (verdict === 'new' && this.#stateStatus() !== 'NO_VAULT') {
      // The record exists: never report NO_VAULT, never claim it failed.
      this.#notify(walletCreatedLockedMessage());
      return fail('STORAGE_FAILED', {
        message: walletCreatedLockedMessage(),
        walletCreated: true,
      });
    }
    return fail('STORAGE_FAILED', { message: walletNotAppliedMessage(), walletCreated: false });
  }

  // -------------------------------------------------------------------------
  // Internals: pending secrets, reveal, rate limit
  // -------------------------------------------------------------------------

  #accountFromSecret(
    secret: PendingFlowSecret | null,
    source: AccountSource,
    label: string | undefined,
  ): NewAccountInput | null {
    if (secret === null) return null;
    const labelPart = label === undefined || label === '' ? {} : { label };
    if (source === 'private-key') {
      if (secret.kind !== 'privateKey') return null;
      return {
        source: 'private-key',
        secret: { kind: 'privateKey', hex: secret.value },
        ...labelPart,
      };
    }
    if (source !== 'created' && source !== 'mnemonic') return null;
    if (secret.kind !== 'mnemonic') return null;
    return { source, secret: { kind: 'mnemonic', words: secret.value }, ...labelPart };
  }

  #revealFromPayload(
    payload: VaultPayload,
    kind: RevealKind,
    accountId: string,
  ): { ok: true; value: RevealedSecret } | WalletFailure {
    const account: VaultAccount | undefined = payload.accounts.find(
      (entry) => entry.id === accountId,
    );
    if (account === undefined) return fail('ACCOUNT_NOT_FOUND');

    if (kind === 'mnemonic') {
      if (account.secret.kind !== 'mnemonic') return fail('SECRET_UNAVAILABLE');
      if (!this.#addressMatchesMnemonic(account, account.secret.words)) {
        return fail('VAULT_CORRUPT');
      }
      return { ok: true, value: { kind: 'mnemonic', value: account.secret.words } };
    }

    if (account.secret.kind === 'privateKey') {
      if (!this.#privateKeyMatchesAddress(account.secret.hex, account.address)) {
        return fail('VAULT_CORRUPT');
      }
      return { ok: true, value: { kind: 'privateKey', value: account.secret.hex } };
    }

    try {
      const derived = deriveAccountFromMnemonic(account.secret.words);
      if (derived.address.toLowerCase() !== account.address.toLowerCase()) {
        return fail('VAULT_CORRUPT');
      }
      return {
        ok: true,
        value: { kind: 'privateKey', value: derived.privateKey, derivationPath: DERIVATION_PATH },
      };
    } catch (error) {
      return fail(isWalletError(error) ? error.code : 'VAULT_CORRUPT');
    }
  }

  #addressMatchesMnemonic(account: VaultAccount, words: string): boolean {
    try {
      return (
        deriveAccountFromMnemonic(words).address.toLowerCase() === account.address.toLowerCase()
      );
    } catch {
      return false;
    }
  }

  #privateKeyMatchesAddress(privateKey: string, address: string): boolean {
    try {
      return privateKeyToAddress(privateKey).toLowerCase() === address.toLowerCase();
    } catch {
      return false;
    }
  }

  #recordUnlockFailure(): void {
    this.#unlockFailures += 1;
    const delay = unlockDelaySeconds(this.#unlockFailures);
    if (delay > 0) this.#blockedUntil = this.#now() + delay * 1000;
  }
}

export function createWalletController(deps: WalletControllerDeps): WalletController {
  return new WalletController(deps);
}

export type { WalletErrorCode };
