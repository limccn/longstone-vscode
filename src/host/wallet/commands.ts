/**
 * The eight wallet commands and their flows (design §7.2, §8; ux-flows §2-§9).
 *
 * This module is host-neutral: `vscode` stays in `extension.ts`, which injects
 * small functions for input, QuickPick, notifications, progress, clipboard and
 * timers. `node --test` exercises the state dispatch and the flows directly.
 *
 * Discipline enforced here, on top of the controller's own guards:
 *
 * - every command re-decides from the live state, so a menu opened before a
 *   lock can never trigger a stale action;
 * - `epoch` is captured before each `await` and compared afterwards; a lock
 *   during a prompt, panel or controller call drops the continuation before it
 *   can open a panel, write the clipboard, or claim success. The reset flow is
 *   the deliberate exception (D-2): it holds no session, so after each prompt it
 *   re-checks `state.status === 'LOCKED'` instead of the epoch;
 * - create/import additionally hold a per-controller flow guard because both
 *   own `pendingFlowSecret` while no KDF is running (`busy` is `null` then);
 * - `lock` is the one command allowed to run while `busy !== null`: design
 *   §5.3 requires it to invalidate an in-flight KDF instead of being rejected;
 * - failure copy is always a static string from `errors.ts` or the controller;
 *   no prompt title, progress title or notification contains a secret.
 */
import { generateWalletMnemonic } from '@limccn/longstone-wallet';

import {
  COMMAND_WALLET_CHANGE_PASSWORD,
  COMMAND_WALLET_COPY_ADDRESS,
  COMMAND_WALLET_CREATE,
  COMMAND_WALLET_EXPORT_SECRET,
  COMMAND_WALLET_IMPORT,
  COMMAND_WALLET_LOCK,
  COMMAND_WALLET_MANAGE,
  COMMAND_WALLET_RESET,
} from '../../shared/constants.ts';
import type { SecretKind } from '../../shared/wallet-protocol.ts';
import {
  accountActionItems,
  accountQuickPickItems,
  confirmDelete,
  exportKindItems,
  manageEmptyItems,
  manageLockedItems,
  manageUnlockedItems,
  pickExportKind,
  pickImportKind,
  promptAccountLabel,
  type WalletShowQuickPick,
  type WalletShowWarningMessage,
} from './account-menu.ts';
import type {
  WalletAccountView,
  WalletController,
  WalletState,
} from './controller.ts';
import {
  walletErrorMessage,
  walletRateLimitMessage,
  walletResetIncompleteMessage,
} from './errors.ts';
import {
  DEFAULT_PASSWORD_PROMPT,
  WEAK_PASSWORD_CONFIRM,
  WEAK_PASSWORD_REJECT,
  WEAK_PASSWORD_WARNING,
  promptConfirm,
  promptNewPassword,
  promptPassword,
  promptText,
  type WalletInputBoxSpec,
  type WalletShowInputBox,
} from './password-input.ts';
import type {
  SecretPanelCloseOutcome,
  SecretPanelOpenOptions,
  SecretPanelOpenResult,
  SecretPanelRequest,
} from './secret-panel.ts';
import { truncateAddress } from './status-bar.ts';

// ---------------------------------------------------------------------------
// Host seam and secret-panel seam
// ---------------------------------------------------------------------------

export interface WalletCommandHost {
  readonly showInputBox: WalletShowInputBox;
  readonly showQuickPick: WalletShowQuickPick;
  showErrorMessage(message: string): Promise<string | undefined>;
  showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>;
  readonly showWarningMessage: WalletShowWarningMessage;
  showProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
  writeClipboard(text: string): Promise<void>;
  delay(ms: number): Promise<void>;
}

/** The single `SecretPanel` instance, injected by `extension.ts`. */
export interface WalletSecretPanel {
  open(request: SecretPanelRequest, options?: SecretPanelOpenOptions): SecretPanelOpenResult;
  dispose(): void;
}

export interface WalletCommandDeps {
  readonly controller: WalletController;
  readonly panel: WalletSecretPanel;
  readonly host: WalletCommandHost;
}

// ---------------------------------------------------------------------------
// Command ids and pure dispatch table
// ---------------------------------------------------------------------------

export type WalletCommandId =
  | typeof COMMAND_WALLET_MANAGE
  | typeof COMMAND_WALLET_CREATE
  | typeof COMMAND_WALLET_IMPORT
  | typeof COMMAND_WALLET_LOCK
  | typeof COMMAND_WALLET_COPY_ADDRESS
  | typeof COMMAND_WALLET_EXPORT_SECRET
  | typeof COMMAND_WALLET_CHANGE_PASSWORD
  | typeof COMMAND_WALLET_RESET;

export const WALLET_COMMAND_IDS: readonly WalletCommandId[] = [
  COMMAND_WALLET_MANAGE,
  COMMAND_WALLET_CREATE,
  COMMAND_WALLET_IMPORT,
  COMMAND_WALLET_LOCK,
  COMMAND_WALLET_COPY_ADDRESS,
  COMMAND_WALLET_EXPORT_SECRET,
  COMMAND_WALLET_CHANGE_PASSWORD,
  COMMAND_WALLET_RESET,
];

export type WalletCommandAction =
  | 'manage'
  | 'create'
  | 'import-first'
  | 'import-add'
  | 'unlock'
  | 'lock'
  | 'copy-address'
  | 'export-secret'
  | 'change-password'
  | 'reset'
  | 'message';

/**
 * Pure command/state decision (design §7.2). `message` carries static copy
 * and never requires a prompt; nothing here reads storage.
 */
export type WalletCommandDecision =
  | {
      readonly action: 'message';
      readonly severity: 'error' | 'info';
      readonly message: string;
    }
  | { readonly action: Exclude<WalletCommandAction, 'message'> };

const EXISTING_VAULT_MESSAGE = 'A wallet already exists. Unlock it to add accounts.';
const IMPORT_LOCKED_MESSAGE = 'Unlock the wallet to add an account.';
const NO_WALLET_TO_LOCK_MESSAGE = 'There is no wallet to lock.';
const ALREADY_LOCKED_MESSAGE = 'The wallet is already locked.';
const LOCK_FIRST_MESSAGE = 'Lock the wallet before resetting it.';

function messageDecision(
  severity: 'error' | 'info',
  message: string,
): WalletCommandDecision {
  return { action: 'message', severity, message };
}

export function decideWalletCommand(
  command: WalletCommandId,
  state: WalletState,
): WalletCommandDecision {
  if (state.status === 'UNAVAILABLE') {
    return messageDecision('error', walletErrorMessage('WALLET_REMOTE_UNSUPPORTED'));
  }

  const unlocked = state.status === 'UNLOCKED';
  const locked = state.status === 'LOCKED';
  const empty = state.status === 'NO_VAULT';

  switch (command) {
    case COMMAND_WALLET_MANAGE:
      return { action: 'manage' };
    case COMMAND_WALLET_CREATE:
      return empty ? { action: 'create' } : messageDecision('error', EXISTING_VAULT_MESSAGE);
    case COMMAND_WALLET_IMPORT:
      if (empty) return { action: 'import-first' };
      return unlocked ? { action: 'import-add' } : messageDecision('info', IMPORT_LOCKED_MESSAGE);
    case COMMAND_WALLET_LOCK:
      if (unlocked) return { action: 'lock' };
      return messageDecision(
        'info',
        empty ? NO_WALLET_TO_LOCK_MESSAGE : ALREADY_LOCKED_MESSAGE,
      );
    case COMMAND_WALLET_COPY_ADDRESS:
      if (unlocked) return { action: 'copy-address' };
      return messageDecision(
        locked ? 'info' : 'error',
        walletErrorMessage(locked ? 'LOCKED' : 'NO_VAULT'),
      );
    case COMMAND_WALLET_EXPORT_SECRET:
      if (unlocked) return { action: 'export-secret' };
      return messageDecision(
        locked ? 'info' : 'error',
        walletErrorMessage(locked ? 'LOCKED' : 'NO_VAULT'),
      );
    case COMMAND_WALLET_CHANGE_PASSWORD:
      if (locked || unlocked) return { action: 'change-password' };
      return messageDecision('error', walletErrorMessage('NO_VAULT'));
    case COMMAND_WALLET_RESET:
      if (locked) return { action: 'reset' };
      if (unlocked) return messageDecision('info', LOCK_FIRST_MESSAGE);
      return messageDecision('error', walletErrorMessage('NO_VAULT'));
  }
}

// ---------------------------------------------------------------------------
// Flow guard (create/import own `pendingFlowSecret` between prompts)
// ---------------------------------------------------------------------------

const activeFlows = new WeakMap<WalletController, true>();

function beginFlow(controller: WalletController): boolean {
  if (activeFlows.has(controller)) return false;
  activeFlows.set(controller, true);
  return true;
}

function endFlow(controller: WalletController): void {
  activeFlows.delete(controller);
}

// ---------------------------------------------------------------------------
// Static copy
// ---------------------------------------------------------------------------

export const RESET_WARNING =
  'This deletes the wallet and its keys permanently. There is no recovery. Make sure you have the recovery phrase offline.';
export const EXPORT_WRONG_PASSWORD_COPY = 'Incorrect password. Nothing was exported.';
const RESET_CONFIRM_LABEL = 'Continue';
const RESET_PHRASE = 'RESET';
const COPY_FAILED_COPY = 'Could not copy to the clipboard.';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function showFailure(host: WalletCommandHost, failure: { readonly message: string }): void {
  void host.showErrorMessage(failure.message);
}

function showNotice(controller: WalletController, host: WalletCommandHost): void {
  const notice = controller.consumeNotice();
  if (notice !== null) void host.showInformationMessage(notice);
}

function isStateCurrent(
  controller: WalletController,
  epoch: number,
  status: WalletState['status'],
): boolean {
  return controller.epoch === epoch && controller.state.status === status;
}

function showDecision(host: WalletCommandHost, decision: WalletCommandDecision): void {
  if (decision.action !== 'message') return;
  if (decision.severity === 'error') void host.showErrorMessage(decision.message);
  else void host.showInformationMessage(decision.message);
}

function openSecretPanel(
  panel: WalletSecretPanel,
  request: SecretPanelRequest,
): { readonly result: SecretPanelOpenResult; readonly closed: Promise<SecretPanelCloseOutcome> } {
  let resolveClose!: (outcome: SecretPanelCloseOutcome) => void;
  const closed = new Promise<SecretPanelCloseOutcome>((resolve) => {
    resolveClose = resolve;
  });
  const options: SecretPanelOpenOptions = {
    onClose(outcome): void {
      resolveClose(outcome);
    },
  };
  const result = panel.open(request, options);
  return { result, closed };
}

type PasswordPairResult =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'stale' };

/**
 * New password + confirmation. A mismatch restarts the pair (ux-flows F-1
 * step 7); every completed prompt is followed by an epoch/state check.
 */
async function promptPasswordPair(
  controller: WalletController,
  host: WalletCommandHost,
  epoch: number,
  status: WalletState['status'],
  prompt: string,
): Promise<PasswordPairResult> {
  for (;;) {
    const first = await promptNewPassword(host.showInputBox, {
      prompt,
      confirmWeak: async () => {
        // In-window warning: a native modal would blur the window, fire the
        // focus-loss lock, and the epoch check below would abort the flow (D-2).
        const answer = await host.showWarningMessage(
          `${WEAK_PASSWORD_WARNING}\n\nUse it anyway?`,
          {},
          WEAK_PASSWORD_CONFIRM,
          WEAK_PASSWORD_REJECT,
        );
        return answer === WEAK_PASSWORD_CONFIRM;
      },
    });
    if (!isStateCurrent(controller, epoch, status)) return { kind: 'stale' };
    if (first.kind === 'cancelled') return { kind: 'cancelled' };
    if (first.kind === 'invalid') {
      void host.showInformationMessage(first.message);
      continue;
    }

    const second = await promptConfirm(host.showInputBox, first.value);
    if (!isStateCurrent(controller, epoch, status)) return { kind: 'stale' };
    if (second.kind === 'cancelled') return { kind: 'cancelled' };
    if (second.kind === 'invalid') {
      void host.showInformationMessage(second.message);
      continue;
    }
    return { kind: 'ok', value: first.value };
  }
}

// ---------------------------------------------------------------------------
// Flows: create and import
// ---------------------------------------------------------------------------

async function runCreate(
  controller: WalletController,
  panel: WalletSecretPanel,
  host: WalletCommandHost,
): Promise<void> {
  if (controller.state.status !== 'NO_VAULT') return;
  if (!beginFlow(controller)) {
    void host.showErrorMessage(walletErrorMessage('WALLET_BUSY'));
    return;
  }
  try {
    const epoch = controller.epoch;
    let mnemonic: string;
    try {
      mnemonic = generateWalletMnemonic();
    } catch {
      void host.showErrorMessage(walletErrorMessage('SECRET_UNAVAILABLE'));
      return;
    }
    // Derivation belongs to the controller; commands never derive keys.
    const preview = controller.previewMnemonicAddress(mnemonic);
    if (!preview.ok) {
      showFailure(host, preview);
      return;
    }

    const opened = openSecretPanel(panel, {
      mode: 'create-reveal',
      kind: 'mnemonic',
      value: mnemonic,
      address: preview.value.address,
      label: 'Account 1',
    });
    if (!opened.result.ok) {
      showFailure(host, opened.result);
      return;
    }

    const outcome = await opened.closed;
    if (!isStateCurrent(controller, epoch, 'NO_VAULT')) {
      controller.clearPendingSecret();
      showNotice(controller, host);
      return;
    }
    if (outcome !== 'saved') {
      controller.clearPendingSecret();
      return;
    }
    if (!controller.hasPendingSecret() || controller.pendingFlowKind() !== 'mnemonic') {
      controller.clearPendingSecret();
      void host.showErrorMessage(walletErrorMessage('SECRET_UNAVAILABLE'));
      return;
    }

    const password = await promptPasswordPair(
      controller,
      host,
      epoch,
      'NO_VAULT',
      DEFAULT_PASSWORD_PROMPT,
    );
    if (password.kind !== 'ok') {
      controller.clearPendingSecret();
      return;
    }

    const createEpoch = controller.epoch;
    const result = await host.showProgress('Creating wallet…', () =>
      controller.create(password.value),
    );
    controller.clearPendingSecret();
    if (!result.ok) {
      showFailure(host, result);
      showNotice(controller, host);
      return;
    }
    if (controller.epoch !== createEpoch) {
      showNotice(controller, host);
      return;
    }
    showNotice(controller, host);
    void host.showInformationMessage('Wallet created. Back up your recovery phrase offline.');
  } finally {
    controller.clearPendingSecret();
    endFlow(controller);
  }
}

async function runImportFirst(
  controller: WalletController,
  panel: WalletSecretPanel,
  host: WalletCommandHost,
): Promise<void> {
  if (controller.state.status !== 'NO_VAULT') return;
  if (!beginFlow(controller)) {
    void host.showErrorMessage(walletErrorMessage('WALLET_BUSY'));
    return;
  }
  try {
    const epoch = controller.epoch;
    const kind = await pickImportKind(host.showQuickPick);
    if (!isStateCurrent(controller, epoch, 'NO_VAULT')) {
      showNotice(controller, host);
      return;
    }
    if (kind === undefined) return;

    const opened = openSecretPanel(panel, { mode: 'import', kind });
    if (!opened.result.ok) {
      showFailure(host, opened.result);
      return;
    }
    const outcome = await opened.closed;
    if (!isStateCurrent(controller, epoch, 'NO_VAULT')) {
      controller.clearPendingSecret();
      showNotice(controller, host);
      return;
    }
    if (outcome !== 'saved') {
      controller.clearPendingSecret();
      return;
    }

    const preview = controller.pendingAccountPreview();
    if (!preview.ok) {
      controller.clearPendingSecret();
      showFailure(host, preview);
      return;
    }
    const answer = await host.showInformationMessage(
      `Use this address? ${preview.value.address}`,
      'Use this address',
      'Cancel',
    );
    if (!isStateCurrent(controller, epoch, 'NO_VAULT')) {
      controller.clearPendingSecret();
      showNotice(controller, host);
      return;
    }
    if (answer !== 'Use this address') {
      controller.clearPendingSecret();
      return;
    }

    const password = await promptPasswordPair(
      controller,
      host,
      epoch,
      'NO_VAULT',
      DEFAULT_PASSWORD_PROMPT,
    );
    if (password.kind !== 'ok') {
      controller.clearPendingSecret();
      return;
    }

    const createEpoch = controller.epoch;
    const result = await host.showProgress('Creating wallet…', () =>
      controller.create(password.value),
    );
    controller.clearPendingSecret();
    if (!result.ok) {
      showFailure(host, result);
      showNotice(controller, host);
      return;
    }
    if (controller.epoch !== createEpoch) {
      showNotice(controller, host);
      return;
    }
    showNotice(controller, host);
    void host.showInformationMessage(
      'Wallet imported. Back up the recovery phrase offline.',
    );
  } finally {
    controller.clearPendingSecret();
    endFlow(controller);
  }
}

async function runImportAdd(
  controller: WalletController,
  panel: WalletSecretPanel,
  host: WalletCommandHost,
): Promise<void> {
  if (controller.state.status !== 'UNLOCKED') return;
  if (!beginFlow(controller)) {
    void host.showErrorMessage(walletErrorMessage('WALLET_BUSY'));
    return;
  }
  try {
    const epoch = controller.epoch;
    const kind = await pickImportKind(host.showQuickPick);
    if (!isStateCurrent(controller, epoch, 'UNLOCKED')) {
      showNotice(controller, host);
      return;
    }
    if (kind === undefined) return;

    const opened = openSecretPanel(panel, { mode: 'import', kind });
    if (!opened.result.ok) {
      showFailure(host, opened.result);
      return;
    }
    const outcome = await opened.closed;
    if (!isStateCurrent(controller, epoch, 'UNLOCKED')) {
      controller.clearPendingSecret();
      showNotice(controller, host);
      return;
    }
    if (outcome !== 'saved') {
      controller.clearPendingSecret();
      return;
    }

    const preview = controller.pendingAccountPreview();
    if (!preview.ok) {
      controller.clearPendingSecret();
      showFailure(host, preview);
      return;
    }

    const addEpoch = controller.epoch;
    const result = await controller.addAccount();
    controller.clearPendingSecret();
    if (!result.ok) {
      showFailure(host, result);
      showNotice(controller, host);
      return;
    }
    if (!isStateCurrent(controller, addEpoch, 'UNLOCKED')) {
      showNotice(controller, host);
      return;
    }
    controller.touch();
    showNotice(controller, host);
    void host.showInformationMessage(
      `Account added: ${truncateAddress(preview.value.address)}`,
    );
  } finally {
    controller.clearPendingSecret();
    endFlow(controller);
  }
}

// ---------------------------------------------------------------------------
// Flows: unlock, lock, copy
// ---------------------------------------------------------------------------

async function runUnlock(
  controller: WalletController,
  host: WalletCommandHost,
): Promise<void> {
  if (controller.state.status !== 'LOCKED') return;
  let epoch = controller.epoch;

  const retryAfter = controller.unlockRetryAfterSeconds();
  if (retryAfter > 0) {
    // Design §5.2: show the remaining delay, wait, then prompt. The limiter is
    // never reset by locking; this is display only, not a security boundary.
    void host.showInformationMessage(walletRateLimitMessage(retryAfter));
    await host.delay(retryAfter * 1000);
    if (!isStateCurrent(controller, epoch, 'LOCKED')) return;
  }
  epoch = controller.epoch;

  const password = await promptPassword(host.showInputBox, {
    prompt: DEFAULT_PASSWORD_PROMPT,
  });
  if (!isStateCurrent(controller, epoch, 'LOCKED')) {
    showNotice(controller, host);
    return;
  }
  if (password.kind !== 'ok') return;

  const unlockEpoch = controller.epoch;
  const result = await host.showProgress('Unlocking…', () =>
    controller.unlock(password.value),
  );
  if (!result.ok) {
    showFailure(host, result);
    showNotice(controller, host);
    return;
  }
  if (!isStateCurrent(controller, unlockEpoch, 'UNLOCKED')) {
    showNotice(controller, host);
    return;
  }
  controller.touch();
  showNotice(controller, host);
  void host.showInformationMessage('Wallet unlocked.');
}

function runLock(
  controller: WalletController,
  panel: WalletSecretPanel,
  host: WalletCommandHost,
): void {
  if (controller.state.status !== 'UNLOCKED') return;
  // Explicit lock: close the reveal/create panel first so its close hook
  // resolves any waiting flow, then invalidate the session synchronously.
  panel.dispose();
  controller.lock('explicit');
  showNotice(controller, host);
  void host.showInformationMessage('Wallet locked.');
}

async function copyAddressFor(
  controller: WalletController,
  host: WalletCommandHost,
  account: WalletAccountView,
): Promise<void> {
  const epoch = controller.epoch;
  if (controller.state.status !== 'UNLOCKED') return;
  try {
    await host.writeClipboard(account.address);
  } catch {
    if (isStateCurrent(controller, epoch, 'UNLOCKED')) {
      void host.showErrorMessage(COPY_FAILED_COPY);
    }
    return;
  }
  if (!isStateCurrent(controller, epoch, 'UNLOCKED')) return;
  controller.touch();
  void host.showInformationMessage(`Address copied: ${account.address}`);
}

// ---------------------------------------------------------------------------
// Flow: export secret
// ---------------------------------------------------------------------------

async function exportAccount(
  controller: WalletController,
  panel: WalletSecretPanel,
  host: WalletCommandHost,
  account: WalletAccountView,
): Promise<void> {
  const epoch = controller.epoch;
  const kind = await pickExportKind(host.showQuickPick, exportKindItems(account));
  if (!isStateCurrent(controller, epoch, 'UNLOCKED')) {
    showNotice(controller, host);
    return;
  }
  if (kind === undefined) return;

  const password = await promptPassword(host.showInputBox, {
    prompt: `Enter the wallet password to export “${account.label}”.`,
  });
  if (!isStateCurrent(controller, epoch, 'UNLOCKED')) {
    showNotice(controller, host);
    return;
  }
  if (password.kind !== 'ok') return;

  const verifyEpoch = controller.epoch;
  const result = await controller.verifyAndReveal(kind, account.id, password.value);
  if (!result.ok) {
    if (result.code === 'DECRYPT_FAILED') {
      void host.showErrorMessage(EXPORT_WRONG_PASSWORD_COPY);
    } else {
      showFailure(host, result);
    }
    showNotice(controller, host);
    return;
  }
  // Lock or external record change after verification: never open a panel.
  if (!isStateCurrent(controller, verifyEpoch, 'UNLOCKED')) {
    showNotice(controller, host);
    return;
  }

  const base = {
    mode: 'reveal-export' as const,
    kind: result.value.kind,
    value: result.value.value,
    label: account.label,
    address: account.address,
  };
  const request: SecretPanelRequest =
    result.value.derivationPath === undefined
      ? base
      : { ...base, derivationPath: result.value.derivationPath };
  const opened = panel.open(request);
  if (!opened.ok) {
    showFailure(host, opened);
    return;
  }
  controller.touch();
}

async function runExport(
  controller: WalletController,
  panel: WalletSecretPanel,
  host: WalletCommandHost,
): Promise<void> {
  const state = controller.state;
  if (state.status !== 'UNLOCKED') return;
  const epoch = controller.epoch;

  let account: WalletAccountView | undefined;
  if (state.snapshot.accounts.length === 1) {
    account = state.snapshot.accounts[0];
  } else {
    const picked = await host.showQuickPick(accountQuickPickItems(state.snapshot.accounts), {
      placeHolder: 'Choose an account to export',
    });
    if (!isStateCurrent(controller, epoch, 'UNLOCKED')) {
      showNotice(controller, host);
      return;
    }
    if (picked === undefined) return;
    account = controller.accounts().find((entry) => entry.id === picked.accountId);
  }
  if (account === undefined) return;
  await exportAccount(controller, panel, host, account);
}

// ---------------------------------------------------------------------------
// Flow: change password
// ---------------------------------------------------------------------------

async function runChangePassword(
  controller: WalletController,
  host: WalletCommandHost,
): Promise<void> {
  const initialStatus = controller.state.status;
  if (initialStatus !== 'LOCKED' && initialStatus !== 'UNLOCKED') return;
  const epoch = controller.epoch;

  const current = await promptPassword(host.showInputBox, {
    prompt: 'Current wallet password',
  });
  if (!isStateCurrent(controller, epoch, initialStatus)) {
    showNotice(controller, host);
    return;
  }
  if (current.kind !== 'ok') return;

  const pair = await promptPasswordPair(
    controller,
    host,
    epoch,
    initialStatus,
    'New wallet password',
  );
  if (pair.kind !== 'ok') {
    showNotice(controller, host);
    return;
  }

  const changeEpoch = controller.epoch;
  const result = await host.showProgress('Changing password…', () =>
    controller.changePassword(current.value, pair.value),
  );
  if (!result.ok) {
    if (controller.epoch !== changeEpoch) {
      // The controller reconciled the outcome across the lock; its notice is
      // the authoritative instruction for which password to try.
      showNotice(controller, host);
      return;
    }
    showFailure(host, result);
    return;
  }
  if (controller.epoch !== changeEpoch) {
    showNotice(controller, host);
    return;
  }
  if (result.value.locked) {
    // The controller already stored the "unlock with the new password" notice.
    showNotice(controller, host);
    return;
  }
  controller.touch();
  showNotice(controller, host);
  void host.showInformationMessage('Password changed.');
}

// ---------------------------------------------------------------------------
// Flow: reset
// ---------------------------------------------------------------------------

async function runReset(
  controller: WalletController,
  host: WalletCommandHost,
): Promise<void> {
  if (controller.state.status !== 'LOCKED') return;

  // In-window warning, never a native modal (D-2): a modal takes OS focus,
  // fires the focus-loss lock, and the state check below would abort.
  const answer = await host.showWarningMessage(
    RESET_WARNING,
    {},
    RESET_CONFIRM_LABEL,
    'Cancel',
  );
  // Reset only cares that the wallet is still locked. It holds no secrets and
  // `reset()` bumps the epoch itself, so the epoch is not compared here.
  if (controller.state.status !== 'LOCKED') {
    showNotice(controller, host);
    return;
  }
  if (answer !== RESET_CONFIRM_LABEL) return;

  const phrase = await promptText(host.showInputBox, {
    prompt: 'Type RESET to confirm',
    placeHolder: RESET_PHRASE,
    validate: (value) => (value === RESET_PHRASE ? undefined : 'Type RESET exactly.'),
  });
  if (controller.state.status !== 'LOCKED') {
    showNotice(controller, host);
    return;
  }
  if (phrase.kind !== 'ok' || phrase.value !== RESET_PHRASE) return;

  // `reset()` bumps the epoch itself before the first await, so a post-await
  // epoch comparison would always differ. The outcome (NO_VAULT vs LOCKED)
  // is the authoritative fact, and it is read back from `loadVault`.
  const result = await controller.reset();
  if (!result.ok) {
    showFailure(host, result);
    showNotice(controller, host);
    return;
  }
  if (result.value.state === 'NO_VAULT') {
    void host.showInformationMessage('Wallet deleted.');
    return;
  }
  void host.showInformationMessage(walletResetIncompleteMessage());
}

// ---------------------------------------------------------------------------
// Account menu
// ---------------------------------------------------------------------------

async function runAccountMenu(
  controller: WalletController,
  panel: WalletSecretPanel,
  host: WalletCommandHost,
  account: WalletAccountView,
): Promise<void> {
  const epoch = controller.epoch;
  const picked = await host.showQuickPick(accountActionItems(), {
    placeHolder: account.label,
  });
  if (!isStateCurrent(controller, epoch, 'UNLOCKED')) {
    showNotice(controller, host);
    return;
  }
  if (picked === undefined) return;

  const current = controller.accounts().find((entry) => entry.id === account.id);
  if (current === undefined) {
    void host.showErrorMessage(walletErrorMessage('ACCOUNT_NOT_FOUND'));
    return;
  }

  switch (picked.action) {
    case 'copyAddress':
      await copyAddressFor(controller, host, current);
      return;
    case 'setActive': {
      const writeEpoch = controller.epoch;
      const result = await controller.setActive(current.id);
      if (!result.ok) {
        if (controller.epoch !== writeEpoch) {
          showNotice(controller, host);
          return;
        }
        showFailure(host, result);
        return;
      }
      if (!isStateCurrent(controller, writeEpoch, 'UNLOCKED')) {
        showNotice(controller, host);
        return;
      }
      controller.touch();
      void host.showInformationMessage('Active account updated.');
      return;
    }
    case 'rename': {
      const number = controller.accounts().findIndex((entry) => entry.id === current.id) + 1;
      const label = await promptAccountLabel(host.showInputBox, current.label, number);
      if (!isStateCurrent(controller, epoch, 'UNLOCKED')) {
        showNotice(controller, host);
        return;
      }
      if (label.kind === 'cancelled') return;
      if (label.kind === 'invalid') {
        void host.showErrorMessage(label.message);
        return;
      }
      const writeEpoch = controller.epoch;
      const result = await controller.rename(current.id, label.value);
      if (!result.ok) {
        if (controller.epoch !== writeEpoch) {
          showNotice(controller, host);
          return;
        }
        showFailure(host, result);
        return;
      }
      if (!isStateCurrent(controller, writeEpoch, 'UNLOCKED')) {
        showNotice(controller, host);
        return;
      }
      controller.touch();
      void host.showInformationMessage('Account renamed.');
      return;
    }
    case 'exportSecret':
      await exportAccount(controller, panel, host, current);
      return;
    case 'delete': {
      const info = controller.describeAccountDeletion(current.id);
      if (info === null) {
        void host.showErrorMessage(walletErrorMessage('ACCOUNT_NOT_FOUND'));
        return;
      }
      const confirmEpoch = controller.epoch;
      const confirmed = await confirmDelete(
        host.showWarningMessage,
        current.label,
        info.isLastAccount,
      );
      if (!isStateCurrent(controller, confirmEpoch, 'UNLOCKED')) {
        showNotice(controller, host);
        return;
      }
      if (!confirmed) return;

      const deleteEpoch = controller.epoch;
      const result = await controller.deleteAccount(current.id);
      if (!result.ok) {
        if (controller.epoch !== deleteEpoch) {
          showNotice(controller, host);
          return;
        }
        showFailure(host, result);
        showNotice(controller, host);
        return;
      }
      if (result.value.walletDeleted) {
        void host.showInformationMessage('Wallet deleted.');
        return;
      }
      if (!isStateCurrent(controller, deleteEpoch, 'UNLOCKED')) {
        showNotice(controller, host);
        return;
      }
      controller.touch();
      void host.showInformationMessage('Account deleted.');
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Manage menu
// ---------------------------------------------------------------------------

async function runManage(
  controller: WalletController,
  panel: WalletSecretPanel,
  host: WalletCommandHost,
): Promise<void> {
  const epoch = controller.epoch;
  const state = controller.state;

  if (state.status === 'NO_VAULT') {
    const picked = await host.showQuickPick(manageEmptyItems(), {
      placeHolder: 'Set up a local encrypted wallet',
    });
    if (!isStateCurrent(controller, epoch, 'NO_VAULT')) {
      showNotice(controller, host);
      return;
    }
    if (picked?.action === 'create') await runCreate(controller, panel, host);
    else if (picked?.action === 'import') await runImportFirst(controller, panel, host);
    return;
  }

  if (state.status === 'LOCKED') {
    const picked = await host.showQuickPick(manageLockedItems(), {
      placeHolder: 'Unlock or manage the wallet',
    });
    if (!isStateCurrent(controller, epoch, 'LOCKED')) {
      showNotice(controller, host);
      return;
    }
    switch (picked?.action) {
      case 'unlock':
        await runUnlock(controller, host);
        return;
      case 'changePassword':
        await runChangePassword(controller, host);
        return;
      case 'reset':
        await runReset(controller, host);
        return;
      default:
        return;
    }
  }

  if (state.status !== 'UNLOCKED') return;
  const picked = await host.showQuickPick(manageUnlockedItems(state.snapshot.accounts), {
    placeHolder: 'Manage the wallet',
  });
  if (!isStateCurrent(controller, epoch, 'UNLOCKED')) {
    showNotice(controller, host);
    return;
  }
  if (picked === undefined) return;

  if (picked.kind === 'account') {
    const current = controller.accounts().find((entry) => entry.id === picked.accountId);
    if (current === undefined) return;
    await runAccountMenu(controller, panel, host, current);
    return;
  }

  switch (picked.action) {
    case 'addAccount':
      await runImportAdd(controller, panel, host);
      return;
    case 'changePassword':
      await runChangePassword(controller, host);
      return;
    case 'lock':
      runLock(controller, panel, host);
      return;
    case 'reset':
      void host.showInformationMessage(LOCK_FIRST_MESSAGE);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function showBusy(host: WalletCommandHost): void {
  void host.showErrorMessage(walletErrorMessage('WALLET_BUSY'));
}

/**
 * Runs one command. `lock` is deliberately checked before `busy`: design §5.3
 * makes locking the way to invalidate an in-flight KDF, so it must never be
 * rejected with `WALLET_BUSY`.
 */
export async function runWalletCommand(
  command: WalletCommandId,
  deps: WalletCommandDeps,
): Promise<void> {
  const { controller, panel, host } = deps;
  const state = controller.state;

  if (state.status === 'UNAVAILABLE') {
    void host.showErrorMessage(walletErrorMessage('WALLET_REMOTE_UNSUPPORTED'));
    return;
  }

  if (command === COMMAND_WALLET_LOCK) {
    const decision = decideWalletCommand(command, state);
    if (decision.action !== 'lock') {
      showDecision(host, decision);
      return;
    }
    runLock(controller, panel, host);
    return;
  }

  if (controller.busy !== null) {
    showBusy(host);
    return;
  }

  const decision = decideWalletCommand(command, controller.state);
  if (decision.action === 'message') {
    showDecision(host, decision);
    return;
  }

  switch (decision.action) {
    case 'manage':
      await runManage(controller, panel, host);
      return;
    case 'create':
      await runCreate(controller, panel, host);
      return;
    case 'import-first':
      await runImportFirst(controller, panel, host);
      return;
    case 'import-add':
      await runImportAdd(controller, panel, host);
      return;
    case 'unlock':
      await runUnlock(controller, host);
      return;
    case 'copy-address': {
      const account = controller.activeAccount();
      if (account === null) {
        void host.showErrorMessage(walletErrorMessage('LOCKED'));
        return;
      }
      await copyAddressFor(controller, host, account);
      return;
    }
    case 'export-secret':
      await runExport(controller, panel, host);
      return;
    case 'change-password':
      await runChangePassword(controller, host);
      return;
    case 'reset':
      await runReset(controller, host);
      return;
    case 'lock':
      runLock(controller, panel, host);
      return;
  }
}

export type WalletCommandHandlers = Readonly<Record<WalletCommandId, () => Promise<void>>>;

/** The exact eight handlers `extension.ts` registers. */
export function createWalletCommandHandlers(
  deps: WalletCommandDeps,
): WalletCommandHandlers {
  return {
    [COMMAND_WALLET_MANAGE]: () => runWalletCommand(COMMAND_WALLET_MANAGE, deps),
    [COMMAND_WALLET_CREATE]: () => runWalletCommand(COMMAND_WALLET_CREATE, deps),
    [COMMAND_WALLET_IMPORT]: () => runWalletCommand(COMMAND_WALLET_IMPORT, deps),
    [COMMAND_WALLET_LOCK]: () => runWalletCommand(COMMAND_WALLET_LOCK, deps),
    [COMMAND_WALLET_COPY_ADDRESS]: () => runWalletCommand(COMMAND_WALLET_COPY_ADDRESS, deps),
    [COMMAND_WALLET_EXPORT_SECRET]: () => runWalletCommand(COMMAND_WALLET_EXPORT_SECRET, deps),
    [COMMAND_WALLET_CHANGE_PASSWORD]: () =>
      runWalletCommand(COMMAND_WALLET_CHANGE_PASSWORD, deps),
    [COMMAND_WALLET_RESET]: () => runWalletCommand(COMMAND_WALLET_RESET, deps),
  };
}
