/**
 * Secret webview entry (design §7.5, ux-flows §11).
 *
 * Rendering only. The bundle never imports `vscode`, a `node:` builtin, viem,
 * the surface package or the shared wallet core; it performs no network or
 * clipboard access and writes no console output. Those properties are checked
 * on the built bundle by `scripts/build.mjs` and `scripts/audit-bundle.mjs`.
 *
 * The host posts the secret only after this document sends `ready`. Displayed
 * values live in the DOM; import input is read from the DOM on submit and is
 * never copied into a JavaScript state object or persisted (`setState` is not
 * called). Closing, saving, clearing or unloading empties the fields.
 */

import {
  parseHostToWebviewMessage,
  type HostSecretMessage,
  type SecretKind,
  type SecretPanelMode,
} from '../shared/wallet-protocol.ts';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

function acquireApi(): VsCodeApi {
  const acquire = (globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi;
  if (typeof acquire !== 'function') {
    throw new Error('the secret panel must run inside a VS Code webview');
  }
  return acquire();
}

function requireRoot(): HTMLElement {
  const found = document.getElementById('app');
  if (found === null) throw new Error('missing #app');
  return found;
}

const vscode: VsCodeApi = acquireApi();
const root: HTMLElement = requireRoot();

interface ViewState {
  mode: SecretPanelMode | null;
  kind: SecretKind | null;
  label: string | null;
  address: string | null;
  derivationPath: string | null;
  countdown: number | null;
  error: string | null;
  notice: string | null;
  keyVisible: boolean;
}

const state: ViewState = {
  mode: null,
  kind: null,
  label: null,
  address: null,
  derivationPath: null,
  countdown: null,
  error: null,
  notice: null,
  keyVisible: false,
};

let countdownTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeButton(label: string, secondary: boolean, onClick: () => void): HTMLButtonElement {
  const node = make('button', secondary ? 'secondary' : undefined, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function setError(message: string | null): void {
  state.error = message;
  // A failed copy must not leave the optimistic "Copied…" notice on screen.
  if (message !== null) setNotice(null);
  const node = document.getElementById('wallet-error');
  if (node instanceof HTMLElement) {
    node.textContent = message ?? '';
    node.hidden = message === null;
  }
}

function setNotice(message: string | null): void {
  state.notice = message;
  const node = document.getElementById('wallet-notice');
  if (node instanceof HTMLElement) {
    node.textContent = message ?? '';
    node.hidden = message === null;
  }
}

function appendErrorRegion(): void {
  const error = make('p', 'wallet-error', state.error ?? '');
  error.id = 'wallet-error';
  error.setAttribute('role', 'alert');
  error.hidden = state.error === null;
  root.append(error);
}

function appendNoticeRegion(fallback: string): void {
  const notice = make('p', 'wallet-status', state.notice ?? fallback);
  notice.id = 'wallet-notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  notice.hidden = state.notice === null && fallback === '';
  root.append(notice);
}

// ---------------------------------------------------------------------------
// Countdown (reveal-export only; the host disposes at zero)
// ---------------------------------------------------------------------------

function stopCountdownTimer(): void {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function updateCountdown(): void {
  const node = document.getElementById('wallet-countdown');
  if (!(node instanceof HTMLElement)) return;
  const seconds = state.countdown;
  if (seconds === null) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.textContent = seconds > 0 ? `Hiding in ${String(seconds)}s` : 'Hiding…';
}

function startCountdown(seconds: number): void {
  stopCountdownTimer();
  state.countdown = seconds;
  updateCountdown();
  countdownTimer = setInterval(() => {
    if (state.countdown === null) {
      stopCountdownTimer();
      return;
    }
    state.countdown = Math.max(0, state.countdown - 1);
    updateCountdown();
    if (state.countdown === 0) stopCountdownTimer();
  }, 1000);
}

// ---------------------------------------------------------------------------
// Sensitive DOM cleanup
// ---------------------------------------------------------------------------

function wipeSensitiveDom(): void {
  for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input, textarea',
  )) {
    field.value = '';
  }
  for (const node of document.querySelectorAll('.wallet-secret, .wallet-mnemonic')) {
    node.replaceChildren();
  }
}

function closeLocally(notice: string): void {
  stopCountdownTimer();
  state.mode = null;
  state.kind = null;
  state.label = null;
  state.address = null;
  state.derivationPath = null;
  state.countdown = null;
  state.error = null;
  state.notice = notice;
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function heading(): string {
  if (state.mode === 'create-reveal') return 'Save your recovery phrase';
  if (state.mode === 'import') {
    return state.kind === 'mnemonic' ? 'Import a recovery phrase' : 'Import a private key';
  }
  if (state.mode === 'reveal-export') {
    return state.kind === 'mnemonic' ? 'Recovery phrase' : 'Private key';
  }
  return 'Longstone Wallet';
}

function appendWarning(): void {
  if (state.mode === 'create-reveal') {
    root.append(
      make(
        'p',
        'wallet-warning',
        'Write these words down offline. Anyone with them can take the account. Longstone cannot recover them. If you leave this window, the phrase is discarded and you will need to create a new one.',
      ),
    );
    return;
  }
  if (state.mode === 'reveal-export') {
    root.append(
      make(
        'p',
        'wallet-warning',
        'Anyone with this phrase or key can take the account. Never share it.',
      ),
    );
  }
}

function appendMeta(): void {
  if (state.label !== null) {
    const line = make('p', 'wallet-meta');
    line.append(make('span', 'wallet-muted', 'Account: '));
    line.append(document.createTextNode(state.label));
    root.append(line);
  }
  if (state.address !== null) {
    const line = make('p', 'wallet-address');
    line.append(make('span', 'wallet-muted', 'Address: '));
    line.append(make('code', 'wallet-address-value', state.address));
    root.append(line);
  }
  if (state.derivationPath !== null) {
    const line = make('p', 'wallet-meta');
    line.append(make('span', 'wallet-muted', 'Derived at: '));
    line.append(make('code', undefined, state.derivationPath));
    root.append(line);
  }
}

function appendSecret(secretValue: string | null): void {
  if (secretValue === null) return;
  if (state.kind === 'mnemonic') {
    const list = make('ol', 'wallet-mnemonic');
    list.setAttribute('aria-label', 'Recovery phrase words');
    for (const word of secretValue.split(/\s+/).filter((entry) => entry !== '')) {
      list.append(make('li', undefined, word));
    }
    root.append(list);
    return;
  }
  root.append(make('code', 'wallet-secret', secretValue));
}

function appendCountdown(): void {
  const countdown = make('p', 'wallet-countdown', '');
  countdown.id = 'wallet-countdown';
  countdown.setAttribute('aria-live', 'polite');
  countdown.hidden = state.countdown === null;
  root.append(countdown);
  updateCountdown();
}

function submitImport(): void {
  if (state.kind === 'mnemonic') {
    const input = document.getElementById('wallet-mnemonic-input');
    if (!(input instanceof HTMLTextAreaElement)) return;
    const value = input.value;
    if (value.trim() === '') {
      setError('Enter the recovery phrase first.');
      input.focus();
      return;
    }
    vscode.postMessage({ type: 'submit-mnemonic', value });
    return;
  }
  const input = document.getElementById('wallet-private-key-input');
  if (!(input instanceof HTMLInputElement)) return;
  const value = input.value;
  if (value.trim() === '') {
    setError('Enter a private key first.');
    input.focus();
    return;
  }
  vscode.postMessage({ type: 'submit-private-key', value });
}

function appendImportForm(): HTMLElement {
  const field = make('div', 'wallet-field');
  let focusTarget: HTMLElement;

  if (state.kind === 'mnemonic') {
    const label = make('label', undefined, 'Recovery phrase');
    label.htmlFor = 'wallet-mnemonic-input';
    const input = make('textarea', undefined);
    input.id = 'wallet-mnemonic-input';
    input.rows = 4;
    input.spellcheck = false;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('aria-describedby', 'wallet-hint');
    input.addEventListener('input', () => {
      if (state.error !== null) setError(null);
    });
    field.append(label, input);
    root.append(field);
    const hint = make(
      'p',
      'wallet-hint',
      'Enter 12, 15, 18, 21 or 24 words, separated by spaces.',
    );
    hint.id = 'wallet-hint';
    root.append(hint);
    focusTarget = input;
  } else {
    const label = make('label', undefined, 'Private key');
    label.htmlFor = 'wallet-private-key-input';
    const input = make('input', undefined);
    input.id = 'wallet-private-key-input';
    input.type = state.keyVisible ? 'text' : 'password';
    input.spellcheck = false;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('aria-describedby', 'wallet-hint');
    input.addEventListener('input', () => {
      if (state.error !== null) setError(null);
    });
    const toggle = makeButton(state.keyVisible ? 'Hide' : 'Show', true, () => {
      state.keyVisible = !state.keyVisible;
      input.type = state.keyVisible ? 'text' : 'password';
      toggle.textContent = state.keyVisible ? 'Hide' : 'Show';
      toggle.setAttribute('aria-pressed', String(state.keyVisible));
    });
    toggle.setAttribute('aria-pressed', String(state.keyVisible));
    toggle.setAttribute('aria-label', 'Show or hide the private key');
    const row = make('div', 'wallet-field-row');
    row.append(input, toggle);
    field.append(label, row);
    root.append(field);
    const hint = make(
      'p',
      'wallet-hint',
      'Enter 0x followed by 64 hex characters. The secret stays in this panel until you continue.',
    );
    hint.id = 'wallet-hint';
    root.append(hint);
    focusTarget = input;
  }
  return focusTarget;
}

function appendPrimaryAction(
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = makeButton(label, false, onClick);
  return button;
}

function render(secretValue: string | null = null): void {
  root.replaceChildren();
  root.dataset['state'] = state.mode === null ? 'idle' : 'ready';

  const title = make('h1', 'wallet-title', heading());
  title.id = 'wallet-title';
  root.append(title);

  if (state.mode === null) {
    appendNoticeRegion('Waiting for the wallet…');
    appendErrorRegion();
    root.setAttribute('aria-labelledby', 'wallet-title');
    return;
  }

  let focusTarget: HTMLElement | null = null;

  appendWarning();
  appendMeta();

  if (state.mode === 'create-reveal' || state.mode === 'reveal-export') {
    appendSecret(secretValue);
    if (state.mode === 'reveal-export') appendCountdown();
  }

  if (state.mode === 'import') {
    focusTarget = appendImportForm();
  }

  appendErrorRegion();
  appendNoticeRegion('');

  const actions = make('div', 'wallet-actions');

  if (state.mode === 'create-reveal') {
    const saved = appendPrimaryAction('I saved it', () => {
      wipeSensitiveDom();
      vscode.postMessage({ type: 'saved' });
      closeLocally('Saved. Continue in the wallet.');
    });
    actions.append(
      makeButton('Copy', true, () => {
        vscode.postMessage({ type: 'copy' });
        setNotice('Copied. Clipboard history may retain it.');
      }),
      saved,
      makeButton('Cancel', true, () => {
        wipeSensitiveDom();
        vscode.postMessage({ type: 'cancel' });
        closeLocally('Closing…');
      }),
    );
    focusTarget = saved;
  } else if (state.mode === 'reveal-export') {
    const copy = appendPrimaryAction('Copy', () => {
      vscode.postMessage({ type: 'copy' });
      setNotice('Copied. Clipboard history may retain it.');
    });
    actions.append(
      copy,
      makeButton('Close', true, () => {
        wipeSensitiveDom();
        vscode.postMessage({ type: 'cancel' });
        closeLocally('Closing…');
      }),
    );
    focusTarget = copy;
  } else {
    actions.append(
      appendPrimaryAction('Continue', submitImport),
      makeButton('Cancel', true, () => {
        wipeSensitiveDom();
        vscode.postMessage({ type: 'cancel' });
        closeLocally('Closing…');
      }),
    );
  }

  root.append(actions);
  root.setAttribute('aria-labelledby', 'wallet-title');

  if (focusTarget !== null) focusTarget.focus();
}

// ---------------------------------------------------------------------------
// Host messages
// ---------------------------------------------------------------------------

function applySecret(message: HostSecretMessage): void {
  state.mode = message.mode;
  state.kind = message.kind;
  state.label = message.label ?? null;
  state.address = message.address ?? null;
  state.derivationPath = message.derivationPath ?? null;
  state.error = null;
  state.notice = null;
  if (message.mode === 'reveal-export' && message.countdownSeconds !== undefined) {
    startCountdown(message.countdownSeconds);
  } else {
    stopCountdownTimer();
    state.countdown = null;
  }
  render(message.value ?? null);
}

function handleClear(): void {
  wipeSensitiveDom();
  stopCountdownTimer();
  state.mode = null;
  state.kind = null;
  state.label = null;
  state.address = null;
  state.derivationPath = null;
  state.countdown = null;
  state.error = null;
  state.notice = 'The secret was cleared.';
  render();
}

function wipeOnUnload(): void {
  wipeSensitiveDom();
  stopCountdownTimer();
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = parseHostToWebviewMessage(event.data);
  if (message === null) return;
  switch (message.type) {
    case 'secret':
      applySecret(message);
      return;
    case 'error':
      setError(message.message);
      return;
    case 'clear':
      handleClear();
      return;
  }
});

window.addEventListener('beforeunload', wipeOnUnload);
window.addEventListener('pagehide', wipeOnUnload);

render();
// The host posts the secret only after this handshake (design §7.5).
vscode.postMessage({ type: 'ready' });
