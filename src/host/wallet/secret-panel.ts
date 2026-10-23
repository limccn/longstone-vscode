/**
 * Single-instance holder for the dedicated secret webview (design §6.5,
 * §7.5, §8.5; AC-6, AC-21, AC-24).
 *
 * Guarantees enforced here, not in the webview:
 *
 * - **One panel.** A new request disposes the old panel and drops its secret
 *   before anything else is shown; two panels can never hold different
 *   secrets at the same time.
 * - **Two generations.** Every panel gets the controller's panel generation
 *   plus a local serial. Inbound messages, the guard timer and the reveal
 *   timeout recheck both, so a message from a replaced, hidden or locked
 *   panel is dropped even if the channel is still alive.
 * - **Secrets by mode.** `create-reveal` and `reveal-export` display a value
 *   posted only after `ready`; `import` posts no value at all. The flow secret
 *   for create/import lives in the controller's `pendingFlowSecret`; the
 *   reveal value lives only in `#revealedSecret` and is never passed to
 *   `setPendingSecret`.
 * - **Close semantics.** `saved` (create's "I saved it" or a successful import
 *   submit) keeps `pendingFlowSecret` for the following password step. Any
 *   other close cancels the flow and clears it. A reveal close never touches
 *   the flow secret.
 * - **Timers.** Reveal-export self-destructs after 60 seconds. Create-reveal
 *   has no timeout (the user needs time to write 12 words down) but closes on
 *   blur/hide/lock. A 1 s guard closes the panel within a second of a lock,
 *   even if no controller event reaches this module.
 *
 * No secret is logged, put in a notification, or included in an error string;
 * the only clipboard write copies the value currently on screen.
 */

import { parseMnemonicInput, parsePrivateKeyInput } from '@limccn/longstone-wallet';
import * as vscode from 'vscode';

import { WALLET_SECRET_VIEW_TITLE, WALLET_SECRET_VIEW_TYPE } from '../../shared/constants.ts';
import { buildSecretCsp, cspMetaTag, generateNonce } from '../../shared/csp.ts';
import { isUriInsideCspSource } from '../../shared/deep-link.ts';
import {
  isWebviewActionAllowed,
  parseHostToWebviewMessage,
  parseWebviewToHostMessage,
  type HostSecretMessage,
  type SecretKind,
  type SecretPanelMode,
  type SecretWebviewMessage,
} from '../../shared/wallet-protocol.ts';
import type { WalletResult } from './controller.ts';
import { walletErrorMessage } from './errors.ts';
import { renderSecretHtml } from './secret-html.ts';

/** Reveal secrets are displayed for 60 seconds (design §7.5). */
export const REVEAL_COUNTDOWN_SECONDS = 60;
const REVEAL_COUNTDOWN_MS = REVEAL_COUNTDOWN_SECONDS * 1000;
/** Lock detection fallback when no controller event reaches the panel. */
const GUARD_INTERVAL_MS = 1000;

/** The controller surface this module drives; `WalletController` fits. */
export interface SecretPanelController {
  readonly state: { readonly status: string };
  readonly busy: string | null;
  beginPanel(): number;
  isPanelCurrent(generation: number): boolean;
  setPendingSecret(secret: { readonly kind: SecretKind; readonly value: string }): WalletResult<null>;
  clearPendingSecret(): void;
  hasPendingSecret(): boolean;
  pendingFlowKind(): SecretKind | null;
}

export type SecretPanelRequest =
  | {
      readonly mode: 'create-reveal';
      readonly kind: 'mnemonic';
      readonly value: string;
      readonly label?: string;
      readonly address?: string;
    }
  | {
      readonly mode: 'import';
      readonly kind: SecretKind;
      readonly label?: string;
    }
  | {
      readonly mode: 'reveal-export';
      readonly kind: SecretKind;
      readonly value: string;
      readonly label?: string;
      readonly address?: string;
      readonly derivationPath?: string;
    };

export type SecretPanelOpenResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * `saved` is the normal continue path (`I saved it` for create, a successful
 * import submit); every other close is a cancellation. Phase D waits on this
 * callback before prompting for a password.
 */
export type SecretPanelCloseOutcome = 'saved' | 'cancelled';

export interface SecretPanelOpenOptions {
  /** Called exactly once when this panel closes. */
  readonly onClose?: (outcome: SecretPanelCloseOutcome) => void;
}

export interface SecretPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly controller: SecretPanelController;
}

type CloseReason =
  | 'replaced'
  | 'saved'
  | 'cancelled'
  | 'hidden'
  | 'blur'
  | 'timeout'
  | 'locked'
  | 'disposed';

function failure(code: string): SecretPanelOpenResult {
  return { ok: false, code, message: walletErrorMessage(code) };
}

export class SecretPanel {
  #extensionUri: vscode.Uri;
  #controller: SecretPanelController;

  #panel: vscode.WebviewPanel | null = null;
  /** Controller panel generation for the live panel; `0` when closed. */
  #generation = 0;
  /** Local serial, bumped on open and close; invalidates stale closures. */
  #serial = 0;

  #mode: SecretPanelMode | null = null;
  #kind: SecretKind | null = null;
  #message: HostSecretMessage | null = null;
  #revealedSecret: { readonly kind: SecretKind; readonly value: string } | null = null;
  #displaySecret: { readonly kind: 'mnemonic'; readonly value: string } | null = null;
  #ownsPending = false;
  #ready = false;
  /** Phase D continuation hook; cleared before it is invoked. */
  #onClose: ((outcome: SecretPanelCloseOutcome) => void) | null = null;

  #countdownTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  #guardTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  #windowSubscription: vscode.Disposable | null = null;
  #listeners: vscode.Disposable[] = [];

  #disposed = false;

  constructor(deps: SecretPanelDeps) {
    this.#extensionUri = deps.extensionUri;
    this.#controller = deps.controller;
  }

  // -------------------------------------------------------------------------
  // Open / dispose
  // -------------------------------------------------------------------------

  open(request: SecretPanelRequest, options: SecretPanelOpenOptions = {}): SecretPanelOpenResult {
    if (this.#disposed) return failure('OPERATION_CANCELLED');
    if (this.#controller.state.status === 'UNAVAILABLE') {
      return failure('WALLET_REMOTE_UNSUPPORTED');
    }
    if (this.#controller.busy !== null) return failure('WALLET_BUSY');

    // Validate and normalize before touching the live panel: an invalid new
    // request must not destroy a panel that is still being read.
    const hostMessage = this.#hostMessageFor(request);
    if (hostMessage === null) {
      return {
        ok: false,
        code: 'SECRET_UNAVAILABLE',
        message: 'The secret panel request was invalid.',
      };
    }
    if (request.mode === 'reveal-export' && this.#controller.state.status !== 'UNLOCKED') {
      return failure('LOCKED');
    }

    // Single instance: the previous panel and its secret go first.
    this.#close('replaced');

    if (request.mode === 'create-reveal') {
      const pending = this.#controller.setPendingSecret({
        kind: 'mnemonic',
        value: request.value,
      });
      if (!pending.ok) return { ok: false, code: pending.code, message: pending.message };
      this.#ownsPending = true;
      this.#displaySecret = { kind: 'mnemonic', value: request.value };
    }
    if (request.mode === 'reveal-export') {
      this.#revealedSecret = { kind: request.kind, value: request.value };
    }

    this.#mode = request.mode;
    this.#kind = request.kind;
    this.#message = hostMessage;
    this.#ready = false;

    const generation = this.#controller.beginPanel();
    this.#generation = generation;
    this.#serial += 1;
    const serial = this.#serial;

    let panel: vscode.WebviewPanel;
    try {
      panel = vscode.window.createWebviewPanel(
        WALLET_SECRET_VIEW_TYPE,
        WALLET_SECRET_VIEW_TITLE,
        { viewColumn: vscode.ViewColumn.Beside },
        {
          // Only the nonce'd bundle may run. Forms and command URIs are off:
          // the secret panel never submits a document and never opens a link.
          enableScripts: true,
          enableCommandUris: false,
          enableForms: false,
          retainContextWhenHidden: false,
          localResourceRoots: [
            vscode.Uri.joinPath(this.#extensionUri, 'dist'),
            vscode.Uri.joinPath(this.#extensionUri, 'media'),
          ],
        },
      );
    } catch {
      this.#resetLocalState();
      if (this.#ownsPending) this.#controller.clearPendingSecret();
      this.#ownsPending = false;
      return {
        ok: false,
        code: 'SECRET_UNAVAILABLE',
        message: 'The secret panel could not be opened.',
      };
    }

    this.#panel = panel;
    // Set before any listener or render path can close the panel; `#close`
    // clears and invokes it exactly once.
    this.#onClose = options.onClose ?? null;
    this.#listeners.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        this.#onMessage(generation, serial, raw);
      }),
      panel.onDidDispose(() => {
        this.#onPanelDisposed(panel, generation, serial);
      }),
      panel.onDidChangeViewState((event) => {
        if (!event.webviewPanel.visible) this.#onHidden(panel, generation, serial);
      }),
    );

    this.#windowSubscription = vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) this.#onBlur(panel, generation, serial);
    });

    // Lock may bump the controller generation without any message reaching
    // this module; poll the generation (no storage access, no secret).
    this.#guardTimer = globalThis.setInterval(() => {
      if (this.#panel !== panel) return;
      if (!this.#controller.isPanelCurrent(generation)) this.#close('locked');
    }, GUARD_INTERVAL_MS);

    if (request.mode === 'reveal-export') {
      // Started at open, not at `ready`: the value must be dropped even if the
      // webview never finishes loading.
      this.#countdownTimer = globalThis.setTimeout(() => {
        if (!this.#isCurrent(generation, serial)) return;
        this.#post({ type: 'clear' });
        this.#close('timeout');
      }, REVEAL_COUNTDOWN_MS);
    }

    try {
      panel.webview.html = this.#renderHtml(panel);
    } catch {
      this.#close('cancelled');
      return {
        ok: false,
        code: 'SECRET_UNAVAILABLE',
        message: 'The secret panel could not be opened.',
      };
    }

    return { ok: true };
  }

  /**
   * Called from the lock and window-blur paths. Closes the live panel and
   * cancels any flow secret it owns, but leaves the holder usable: an explicit
   * lock is not the end of the extension, so a later command must be able to
   * open a fresh panel. Safe to call more than once.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#close('disposed');
  }

  /**
   * Terminal teardown for `deactivate`. Closes the panel and refuses every
   * later `open()`; only the extension shutting down uses this.
   */
  shutdown(): void {
    if (this.#disposed) return;
    this.#close('disposed');
    this.#disposed = true;
  }

  // -------------------------------------------------------------------------
  // Inbound messages
  // -------------------------------------------------------------------------

  #onMessage(generation: number, serial: number, raw: unknown): void {
    if (!this.#isCurrent(generation, serial)) return;
    const message = parseWebviewToHostMessage(raw);
    if (message === null) return; // unknown shape: drop, never echo

    const mode = this.#mode;
    const kind = this.#kind;
    if (mode === null || kind === null) return;
    if (!isWebviewActionAllowed(mode, kind, message)) return;

    switch (message.type) {
      case 'ready':
        this.#sendSecret(generation, serial);
        return;
      case 'copy':
        void this.#copy(generation, serial);
        return;
      case 'submit-mnemonic':
      case 'submit-private-key':
        this.#submit(message, mode);
        return;
      case 'saved':
        this.#close('saved');
        return;
      case 'cancel':
        this.#close('cancelled');
        return;
    }
  }

  #sendSecret(generation: number, serial: number): void {
    if (!this.#isCurrent(generation, serial) || this.#ready) return;
    const panel = this.#panel;
    const message = this.#message;
    if (panel === null || message === null) return;
    this.#ready = true;
    void panel.webview.postMessage(message);
  }

  async #copy(generation: number, serial: number): Promise<void> {
    if (!this.#isCurrent(generation, serial)) return;

    const mode = this.#mode;
    let value: string | null = null;
    if (mode === 'create-reveal') {
      if (
        !this.#controller.hasPendingSecret() ||
        this.#controller.pendingFlowKind() !== 'mnemonic'
      ) {
        this.#close('locked');
        return;
      }
      value = this.#displaySecret?.value ?? null;
    } else if (mode === 'reveal-export') {
      if (this.#controller.state.status !== 'UNLOCKED') {
        this.#close('locked');
        return;
      }
      value = this.#revealedSecret?.value ?? null;
    }
    if (value === null) return;

    try {
      await vscode.env.clipboard.writeText(value);
    } catch {
      if (this.#isCurrent(generation, serial)) {
        this.#postError('Could not copy to the clipboard.');
      }
      return;
    }
    // The value may have been cleared while the clipboard write was pending;
    // nothing else is written or posted here.
    if (!this.#isCurrent(generation, serial)) return;
  }

  #submit(message: SecretWebviewMessage, mode: SecretPanelMode): void {
    if (mode !== 'import') return;

    let value: string;
    let kind: SecretKind;
    if (message.type === 'submit-mnemonic') {
      const parsed = parseMnemonicInput(message.value);
      if (!parsed.ok) {
        this.#postError(walletErrorMessage(parsed.error.code));
        return;
      }
      value = parsed.words;
      kind = 'mnemonic';
    } else if (message.type === 'submit-private-key') {
      const parsed = parsePrivateKeyInput(message.value);
      if (!parsed.ok) {
        this.#postError(walletErrorMessage(parsed.error.code));
        return;
      }
      value = parsed.hex;
      kind = 'privateKey';
    } else {
      return;
    }

    const pending = this.#controller.setPendingSecret({ kind, value });
    if (!pending.ok) {
      // The input stays in the webview for retry; the copy is safe.
      this.#postError(pending.message);
      return;
    }
    this.#ownsPending = true;
    // Import continues with address confirmation and the password step, so
    // this is a normal close: `pendingFlowSecret` survives.
    this.#close('saved');
  }

  #postError(message: string): void {
    const panel = this.#panel;
    if (panel === null) return;
    const frame = parseHostToWebviewMessage({ type: 'error', message });
    if (frame === null) return;
    void panel.webview.postMessage(frame);
  }

  #post(message: { readonly type: 'clear' }): void {
    const panel = this.#panel;
    if (panel === null) return;
    void panel.webview.postMessage(message);
  }

  // -------------------------------------------------------------------------
  // Panel lifecycle
  // -------------------------------------------------------------------------

  #onPanelDisposed(panel: vscode.WebviewPanel, generation: number, serial: number): void {
    if (this.#panel !== panel || this.#generation !== generation || this.#serial !== serial) {
      return; // closed by us, or already replaced
    }
    this.#close('cancelled');
  }

  #onHidden(panel: vscode.WebviewPanel, generation: number, serial: number): void {
    if (this.#panel !== panel || this.#generation !== generation || this.#serial !== serial) {
      return;
    }
    this.#close('hidden');
  }

  #onBlur(panel: vscode.WebviewPanel, generation: number, serial: number): void {
    if (this.#panel !== panel || this.#generation !== generation || this.#serial !== serial) {
      return;
    }
    this.#close('blur');
  }

  #isCurrent(generation: number, serial: number): boolean {
    return (
      !this.#disposed &&
      this.#panel !== null &&
      this.#generation === generation &&
      this.#serial === serial &&
      this.#controller.isPanelCurrent(generation)
    );
  }

  /**
   * The single teardown path. Local references are dropped before
   * `panel.dispose()` so the panel's own `onDidDispose` is recognized as stale
   * and cannot clear the next flow's pending secret.
   */
  #close(reason: CloseReason): void {
    const panel = this.#panel;
    const ownsPending = this.#ownsPending;
    const onClose = this.#onClose;
    this.#onClose = null;
    const outcome: SecretPanelCloseOutcome = reason === 'saved' ? 'saved' : 'cancelled';

    this.#serial += 1;
    this.#panel = null;
    this.#generation = 0;
    this.#mode = null;
    this.#kind = null;
    this.#message = null;
    this.#revealedSecret = null;
    this.#displaySecret = null;
    this.#ownsPending = false;
    this.#ready = false;
    this.#stopTimers();

    this.#windowSubscription?.dispose();
    this.#windowSubscription = null;
    const listeners = this.#listeners;
    this.#listeners = [];
    for (const listener of listeners) listener.dispose();

    // A normal close (`saved`) is the only one that keeps the flow secret:
    // create and import continue into the password step.
    if (ownsPending && reason !== 'saved') this.#controller.clearPendingSecret();

    if (panel !== null) panel.dispose();
    onClose?.(outcome);
  }

  #stopTimers(): void {
    if (this.#countdownTimer !== null) {
      globalThis.clearTimeout(this.#countdownTimer);
      this.#countdownTimer = null;
    }
    if (this.#guardTimer !== null) {
      globalThis.clearInterval(this.#guardTimer);
      this.#guardTimer = null;
    }
  }

  #resetLocalState(): void {
    this.#serial += 1;
    this.#panel = null;
    this.#generation = 0;
    this.#mode = null;
    this.#kind = null;
    this.#message = null;
    this.#revealedSecret = null;
    this.#displaySecret = null;
    this.#ready = false;
    this.#onClose = null;
    this.#stopTimers();
    this.#windowSubscription?.dispose();
    this.#windowSubscription = null;
    const listeners = this.#listeners;
    this.#listeners = [];
    for (const listener of listeners) listener.dispose();
  }

  // -------------------------------------------------------------------------
  // Request -> host message and HTML
  // -------------------------------------------------------------------------

  #hostMessageFor(request: SecretPanelRequest): HostSecretMessage | null {
    const base = { type: 'secret' as const, mode: request.mode, kind: request.kind };
    const label = request.label === undefined ? {} : { label: request.label };
    let candidate: unknown;
    if (request.mode === 'create-reveal') {
      const address = request.address === undefined ? {} : { address: request.address };
      candidate = { ...base, value: request.value, ...label, ...address };
    } else if (request.mode === 'import') {
      candidate = { ...base, ...label };
    } else {
      const address = request.address === undefined ? {} : { address: request.address };
      const derivationPath =
        request.derivationPath === undefined ? {} : { derivationPath: request.derivationPath };
      candidate = {
        ...base,
        value: request.value,
        countdownSeconds: REVEAL_COUNTDOWN_SECONDS,
        ...label,
        ...address,
        ...derivationPath,
      };
    }
    const parsed = parseHostToWebviewMessage(candidate);
    return parsed !== null && parsed.type === 'secret' ? parsed : null;
  }

  #renderHtml(panel: vscode.WebviewPanel): string {
    const nonce = generateNonce(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const cspSource = panel.webview.cspSource;
    const policy = buildSecretCsp({ cspSource, nonce });
    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.#extensionUri, 'dist', 'wallet-webview.js'),
    );
    const styleUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.#extensionUri, 'media', 'wallet.css'),
    );

    // The CSP allows scripts/styles only from `cspSource`; an asset outside it
    // would render a blank panel. Fail loudly instead of shipping the markup.
    for (const uri of [scriptUri, styleUri]) {
      if (!isUriInsideCspSource(uri.toString(), cspSource)) {
        throw new Error('secret webview asset outside cspSource');
      }
    }

    return renderSecretHtml({
      cspMeta: cspMetaTag(policy),
      nonce,
      scriptUri: scriptUri.toString(),
      styleUri: styleUri.toString(),
    });
  }
}

export function createSecretPanel(deps: SecretPanelDeps): SecretPanel {
  return new SecretPanel(deps);
}
