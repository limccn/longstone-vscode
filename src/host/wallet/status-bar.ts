/**
 * Wallet status bar (design §7.3).
 *
 * Three visible states and one absent state. The item is injected so this
 * module stays testable under `node --test`: Phase D passes a factory that
 * wraps `vscode.window.createStatusBarItem(StatusBarAlignment.Right, 100)`.
 *
 * A locked wallet never renders an address, an account count, or a label
 * (I-4); the `LOCKED` state carries no fields that could leak.
 */
import {
  COMMAND_WALLET_MANAGE,
  WALLET_STATUS_ICON_UNLOCKED,
  WALLET_STATUS_TEXT_LOCKED,
  WALLET_STATUS_TEXT_NO_VAULT,
  WALLET_STATUS_TOOLTIP_LOCKED,
  WALLET_STATUS_TOOLTIP_NO_VAULT,
  WALLET_STATUS_TOOLTIP_UNLOCKED,
} from '../../shared/constants.ts';

export type WalletStatusState =
  | { readonly status: 'UNAVAILABLE' }
  | { readonly status: 'NO_VAULT' }
  | { readonly status: 'LOCKED' }
  | {
      readonly status: 'UNLOCKED';
      readonly address: string;
      readonly accountLabel: string;
    };

export type WalletStatusPresentation =
  | { readonly visible: false }
  | {
      readonly visible: true;
      readonly text: string;
      readonly tooltip: string;
      readonly command: string;
    };

/** First 6 + last 4 characters; the full address only leaves via copy. */
export function truncateAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function walletStatusPresentation(state: WalletStatusState): WalletStatusPresentation {
  switch (state.status) {
    case 'UNAVAILABLE':
      return { visible: false };
    case 'NO_VAULT':
      return {
        visible: true,
        text: WALLET_STATUS_TEXT_NO_VAULT,
        tooltip: WALLET_STATUS_TOOLTIP_NO_VAULT,
        command: COMMAND_WALLET_MANAGE,
      };
    case 'LOCKED':
      return {
        visible: true,
        text: WALLET_STATUS_TEXT_LOCKED,
        tooltip: WALLET_STATUS_TOOLTIP_LOCKED,
        command: COMMAND_WALLET_MANAGE,
      };
    case 'UNLOCKED':
      return {
        visible: true,
        text: `${WALLET_STATUS_ICON_UNLOCKED} ${truncateAddress(state.address)}`,
        tooltip: `${state.accountLabel} · ${WALLET_STATUS_TOOLTIP_UNLOCKED}`,
        command: COMMAND_WALLET_MANAGE,
      };
  }
}

/** The subset of `vscode.StatusBarItem` this module drives. */
export interface WalletStatusItem {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface WalletStatusBar {
  update(state: WalletStatusState): void;
  dispose(): void;
}

export interface WalletStatusBarOptions {
  /** `false` in a remote window: no item is ever created (design §5.4). */
  available: boolean;
  /** Phase D: `() => vscode.window.createStatusBarItem(...)`. */
  createItem: () => WalletStatusItem;
}

export function createWalletStatusBar(options: WalletStatusBarOptions): WalletStatusBar {
  let item: WalletStatusItem | null = null;
  let disposed = false;

  if (options.available) item = options.createItem();

  return {
    update(state) {
      if (disposed || item === null) return;
      const presentation = walletStatusPresentation(state);
      if (!presentation.visible) {
        item.hide();
        return;
      }
      item.text = presentation.text;
      item.tooltip = presentation.tooltip;
      item.command = presentation.command;
      item.show();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      item?.dispose();
      item = null;
    },
  };
}
