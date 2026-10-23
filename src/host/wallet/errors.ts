/**
 * Wallet error codes -> user copy (design §11, AC-16).
 *
 * Copy is a static table: nothing here concatenates a password, a mnemonic
 * word, a private key, or a ciphertext. Internal causes (GCM tag, KDF
 * parameters) are never shown verbatim; the code is the only diagnostic that
 * may be logged.
 */
import type { WalletErrorCode } from '@limccn/longstone-wallet';

/**
 * Host-level codes the controller returns in addition to the core's. They are
 * not `WalletError`s: no secret ever reaches them and the UI treats them like
 * any other `code`.
 */
export type WalletHostErrorCode =
  | 'WALLET_BUSY'
  | 'WALLET_REMOTE_UNSUPPORTED'
  | 'WALLET_CHANGED_EXTERNALLY'
  | 'UNLOCK_RATE_LIMITED'
  | 'OPERATION_CANCELLED'
  | 'SECRET_UNAVAILABLE';

export type WalletFailureCode = WalletErrorCode | WalletHostErrorCode;

const MESSAGES: Readonly<Record<WalletFailureCode, string>> = {
  // Core codes.
  TOO_SHORT: 'The password must be at least 8 characters.',
  TOO_LONG: 'The password must be at most 1024 characters.',
  CONFIRM_MISMATCH: 'The passwords do not match.',
  DECRYPT_FAILED: 'Incorrect password, or the wallet data is damaged.',
  KDF_UNAVAILABLE: 'Password hashing is not available in this VS Code window.',
  KDF_PARAMS_UNSUPPORTED: 'This wallet uses unsupported password-hashing parameters.',
  MNEMONIC_WORD_COUNT: 'The recovery phrase has the wrong number of words.',
  MNEMONIC_WORDLIST: 'The recovery phrase contains a word that is not in the wordlist.',
  MNEMONIC_CHECKSUM: 'The recovery phrase checksum is invalid.',
  PRIVATE_KEY_FORMAT: 'The private key must be 0x followed by 64 hex characters.',
  PRIVATE_KEY_RANGE: 'The private key is not a valid secp256k1 key.',
  ACCOUNT_EXISTS: 'An account with this address already exists in the wallet.',
  ACCOUNT_LIMIT: 'The wallet already has the maximum of 50 accounts.',
  ACCOUNT_NOT_FOUND: 'That account no longer exists in the wallet.',
  LABEL_INVALID: 'Account names are limited to 64 characters.',
  LOCKED: 'Unlock the wallet first.',
  STORAGE_FAILED: 'Could not save the wallet. Unlock again to reload.',
  VAULT_CORRUPT: 'The wallet data is damaged. Reset the wallet to start over.',
  NO_VAULT: 'No wallet exists in this window yet.',
  VAULT_EXISTS: 'A wallet already exists. Unlock it instead.',
  CONFLICT: 'Wallet data changed in another window. Unlock again.',

  // Host codes.
  WALLET_BUSY: 'Another wallet operation is still running. Try again.',
  WALLET_REMOTE_UNSUPPORTED: 'The Longstone wallet is local-only. Open a local VS Code window.',
  WALLET_CHANGED_EXTERNALLY: 'Wallet data changed in another window. Unlock again.',
  UNLOCK_RATE_LIMITED: 'Too many attempts. Try again shortly.',
  OPERATION_CANCELLED:
    'The wallet was locked before the operation finished. Unlock to check the result.',
  SECRET_UNAVAILABLE: 'That secret is not available for this account.',
};

const FALLBACK = 'The wallet operation failed. Unlock again to reload.';

/** User copy for an error code; unknown codes fall back to a safe sentence. */
export function walletErrorMessage(code: string): string {
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code as WalletFailureCode] : FALLBACK;
}

/** `Too many attempts. Try again in Ns.` with a clamped whole-second count. */
export function walletRateLimitMessage(remainingSeconds: number): string {
  const seconds = Number.isFinite(remainingSeconds)
    ? Math.max(1, Math.ceil(remainingSeconds))
    : 1;
  return `Too many attempts. Try again in ${String(seconds)}s.`;
}

/**
 * Write failure with a confirmed old value on disk. Only a successful
 * read-back comparison may use this sentence (design §4.2).
 */
export function walletNotAppliedMessage(): string {
  return 'Could not save the wallet. Nothing was changed.';
}

/** Change-password failure where the read-back confirmed the old record. */
export function walletWrongOldPasswordMessage(): string {
  return 'The current password is incorrect. Nothing was changed.';
}

/** Read-back did not settle whether a write landed; never claims either way. */
export function walletUnverifiedMessage(): string {
  return 'Could not verify the save. Unlock again to reload.';
}

/** An interrupted create that did leave a record behind. */
export function walletCreatedLockedMessage(): string {
  return 'The wallet was created. Unlock to continue.';
}

/** Change-password outcome that must be checked with the new password. */
export function walletNewPasswordMessage(): string {
  return 'Password changed. Unlock with the new password.';
}

/** Change-password state where neither password is confirmed. */
export function walletTryNewPasswordMessage(): string {
  return 'Try your new password first. If it fails, try the old one; if both fail, reset the wallet.';
}

/**
 * Reset removed the primary record but a `pending` record survived. The host
 * must not claim `NO_VAULT` (design §8.7 / VR-02).
 */
export function walletResetIncompleteMessage(): string {
  return 'The main wallet record was removed, but an interrupted change record is still present. Unlock to recover it, or reset again.';
}
