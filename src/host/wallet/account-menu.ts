/**
 * Native QuickPick menus for the wallet (design §7.4, ux-flows §5).
 *
 * Pure item builders plus small injected-host helpers, so `node --test` can
 * assert the action mapping without a VS Code instance. An address only ever
 * appears truncated in a `description`; labels never contain it.
 *
 * Locked and empty states have their own item lists: the locked menu must not
 * reveal an account count, a label, or an address (I-4).
 */
import {
  DERIVATION_PATH,
  MAX_LABEL_CODEPOINTS,
  sanitizeLabel,
} from '@limccn/longstone-wallet';

import type { SecretKind } from '../../shared/wallet-protocol.ts';
import type { WalletAccountView } from './controller.ts';
import type { WalletShowInputBox } from './password-input.ts';
import { truncateAddress } from './status-bar.ts';

// ---------------------------------------------------------------------------
// Item shapes
// ---------------------------------------------------------------------------

export interface WalletQuickPickItem {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
}

export interface AccountQuickPickItem extends WalletQuickPickItem {
  readonly kind: 'account';
  readonly accountId: string;
}

export type ManageAction =
  | 'create'
  | 'import'
  | 'unlock'
  | 'addAccount'
  | 'changePassword'
  | 'lock'
  | 'reset';

export interface ActionQuickPickItem extends WalletQuickPickItem {
  readonly kind: 'action';
  readonly action: ManageAction;
}

export type AccountAction = 'copyAddress' | 'setActive' | 'rename' | 'exportSecret' | 'delete';

export interface AccountActionQuickPickItem extends WalletQuickPickItem {
  readonly kind: 'accountAction';
  readonly action: AccountAction;
}

export interface ImportKindQuickPickItem extends WalletQuickPickItem {
  readonly kind: 'importKind';
  readonly value: SecretKind;
}

export interface ExportKindQuickPickItem extends WalletQuickPickItem {
  readonly kind: 'exportKind';
  readonly value: SecretKind;
}

export type ManageQuickPickItem = AccountQuickPickItem | ActionQuickPickItem;

export interface WalletQuickPickOptions {
  readonly placeHolder?: string;
  readonly title?: string;
}

export type WalletShowQuickPick = <T extends WalletQuickPickItem>(
  items: readonly T[],
  options?: WalletQuickPickOptions,
) => Promise<T | undefined>;

export type WalletShowWarningMessage = (
  message: string,
  options: { readonly modal?: boolean },
  ...items: string[]
) => Promise<string | undefined>;

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

function actionItem(action: ManageAction, label: string): ActionQuickPickItem {
  return { kind: 'action', action, label };
}

function accountSourceLabel(source: WalletAccountView['source']): string {
  return source === 'created' ? 'Created' : 'Imported';
}

export function accountQuickPickItems(
  accounts: readonly WalletAccountView[],
): AccountQuickPickItem[] {
  return accounts.map((account) => ({
    kind: 'account',
    accountId: account.id,
    label: account.label,
    description: `${truncateAddress(account.address)}${account.active ? ' · active' : ''}`,
    detail: accountSourceLabel(account.source),
  }));
}

/** Unlocked menu: accounts first, then wallet actions (ux-flows §5.1). */
export function manageUnlockedItems(
  accounts: readonly WalletAccountView[],
): ManageQuickPickItem[] {
  return [
    ...accountQuickPickItems(accounts),
    actionItem('addAccount', 'Add account'),
    actionItem('changePassword', 'Change password'),
    actionItem('lock', 'Lock wallet'),
    actionItem('reset', 'Reset wallet'),
  ];
}

/** Locked menu (ux-flows §8.5): no account data is present in the items. */
export function manageLockedItems(): ActionQuickPickItem[] {
  return [
    actionItem('unlock', 'Unlock'),
    actionItem('changePassword', 'Change password'),
    actionItem('reset', 'Reset wallet'),
  ];
}

/** No-vault menu (ux-flows §2/§3). */
export function manageEmptyItems(): ActionQuickPickItem[] {
  return [actionItem('create', 'Create a new wallet'), actionItem('import', 'Import an existing wallet')];
}

export function accountActionItems(): AccountActionQuickPickItem[] {
  return [
    { kind: 'accountAction', action: 'copyAddress', label: 'Copy address' },
    { kind: 'accountAction', action: 'setActive', label: 'Set active' },
    { kind: 'accountAction', action: 'rename', label: 'Rename' },
    { kind: 'accountAction', action: 'exportSecret', label: 'Export secret' },
    { kind: 'accountAction', action: 'delete', label: 'Delete account' },
  ];
}

const IMPORT_KIND_ITEMS: readonly ImportKindQuickPickItem[] = [
  {
    kind: 'importKind',
    value: 'mnemonic',
    label: 'Recovery phrase',
    description: '12/15/18/21/24 words',
  },
  {
    kind: 'importKind',
    value: 'privateKey',
    label: 'Private key',
    description: '0x + 64 hex',
  },
];

export async function pickImportKind(
  showQuickPick: WalletShowQuickPick,
): Promise<SecretKind | undefined> {
  const picked = await showQuickPick(IMPORT_KIND_ITEMS, {
    placeHolder: 'Choose how to import the account',
  });
  return picked?.value;
}

/**
 * Export choices for one account. A mnemonic-backed account can export the
 * phrase or the derived key; a private-key account has only the key.
 */
export function exportKindItems(account: WalletAccountView): ExportKindQuickPickItem[] {
  const items: ExportKindQuickPickItem[] = [];
  if (account.source !== 'private-key') {
    items.push({ kind: 'exportKind', value: 'mnemonic', label: 'Recovery phrase' });
  }
  items.push({
    kind: 'exportKind',
    value: 'privateKey',
    label: 'Private key',
    description:
      account.source === 'private-key' ? '0x + 64 hex' : `Derived at ${DERIVATION_PATH}`,
  });
  return items;
}

export async function pickExportKind(
  showQuickPick: WalletShowQuickPick,
  items: readonly ExportKindQuickPickItem[],
): Promise<SecretKind | undefined> {
  if (items.length === 1) return items[0]?.value;
  const picked = await showQuickPick(items, { placeHolder: 'Choose what to export' });
  return picked?.value;
}

// ---------------------------------------------------------------------------
// Rename and delete confirmation
// ---------------------------------------------------------------------------

export type LabelPromptResult =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'invalid'; readonly message: string };

/**
 * Account label prompt: shared sanitizer (control/bidi/zero-width removal),
 * 64-codepoint bound, empty becomes `Account N` (ux-flows §5.4).
 */
export async function promptAccountLabel(
  showInputBox: WalletShowInputBox,
  currentLabel: string,
  accountNumber: number,
): Promise<LabelPromptResult> {
  const value = await showInputBox({
    prompt: 'Account label',
    password: false,
    ignoreFocusOut: false,
    value: currentLabel,
    validateInput(candidate: string): string | undefined {
      const cleaned = sanitizeLabel(candidate);
      return [...cleaned].length > MAX_LABEL_CODEPOINTS
        ? `Account names are limited to ${String(MAX_LABEL_CODEPOINTS)} characters.`
        : undefined;
    },
  });
  if (value === undefined) return { kind: 'cancelled' };

  const cleaned = sanitizeLabel(value);
  if ([...cleaned].length > MAX_LABEL_CODEPOINTS) {
    return {
      kind: 'invalid',
      message: `Account names are limited to ${String(MAX_LABEL_CODEPOINTS)} characters.`,
    };
  }
  return { kind: 'ok', value: cleaned === '' ? `Account ${String(accountNumber)}` : cleaned };
}

export const DELETE_CONFIRM_LABEL = 'Delete';

/** Modal delete copy; the last-account case adds the whole-wallet warning. */
export function deleteConfirmationMessage(label: string, isLastAccount: boolean): string {
  const safeLabel = sanitizeLabel(label) === '' ? 'this account' : sanitizeLabel(label);
  const base = `Delete “${safeLabel}”? The key material will be removed from this wallet.`;
  if (!isLastAccount) return base;
  return `${base}\n\nThis is the last account. Deleting it deletes the entire wallet. This cannot be undone.`;
}

export async function confirmDelete(
  showWarningMessage: WalletShowWarningMessage,
  label: string,
  isLastAccount: boolean,
): Promise<boolean> {
  const answer = await showWarningMessage(
    deleteConfirmationMessage(label, isLastAccount),
    { modal: true },
    DELETE_CONFIRM_LABEL,
    'Cancel',
  );
  return answer === DELETE_CONFIRM_LABEL;
}
