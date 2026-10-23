/**
 * Secret-panel holder lifecycle (design §5.3, §5.6, §6.5, §7.5; AC-6, AC-21,
 * AC-24).
 *
 * `secret-panel.ts` is the only wallet module that touches `vscode.window`
 * directly, so this suite imports the real module with a minimal `vscode`
 * stub registered through Node's module hooks. `node --test` runs each file in
 * its own process, so the hook and the stub's state cannot reach other suites.
 *
 * Regression pinned here: an explicit lock or window blur closes the panel via
 * `dispose()`, and the holder must remain usable for the next command.
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const stubUrl = new URL('./support/vscode-stub.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: stubUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const vscode = await import('vscode');
const { SecretPanel } = await import(
  new URL('../src/host/wallet/secret-panel.ts', import.meta.url).href
);

const MNEMONIC_A =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MNEMONIC_B =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

/** Just enough of `WalletController` for the holder's open/close paths. */
function fakeController(status = 'NO_VAULT') {
  let generation = 0;
  let pending = null;
  return {
    state: { status },
    busy: null,
    beginPanel() {
      generation += 1;
      return generation;
    },
    isPanelCurrent(value) {
      return value === generation;
    },
    setPendingSecret(secret) {
      pending = { kind: secret.kind, value: secret.value };
      return { ok: true, value: null };
    },
    clearPendingSecret() {
      pending = null;
    },
    hasPendingSecret() {
      return pending !== null;
    },
    pendingFlowKind() {
      return pending?.kind ?? null;
    },
    /** Simulates `WalletController.lock()` bumping the panel generation. */
    bump() {
      generation += 1;
      pending = null;
    },
    get generation() {
      return generation;
    },
    get pending() {
      return pending;
    },
  };
}

function deps(controller) {
  return {
    extensionUri: new vscode.Uri('vscode-webview://test-uuid/ext'),
    controller,
  };
}

function openCreate(panel, value, onClose) {
  return panel.open({ mode: 'create-reveal', kind: 'mnemonic', value }, { onClose });
}

test.beforeEach(() => {
  vscode.reset();
});

test('dispose (lock/blur path) closes the panel but keeps the holder usable', () => {
  const controller = fakeController();
  const panel = new SecretPanel(deps(controller));
  const firstCloses = [];
  assert.equal(openCreate(panel, MNEMONIC_A, (outcome) => firstCloses.push(outcome)).ok, true);
  const first = vscode.lastPanel();

  first.send({ type: 'saved' });
  assert.deepEqual(firstCloses, ['saved'], 'saved closes the panel once');
  assert.notEqual(controller.pending, null, 'saved keeps the flow secret for the password step');

  // Exactly what `runLock` and the window-blur handler call.
  panel.dispose();
  assert.equal(first.disposed, true, 'dispose closes the live panel');

  const secondCloses = [];
  const reopened = openCreate(panel, MNEMONIC_A, (outcome) => secondCloses.push(outcome));
  assert.equal(reopened.ok, true, 'a lock-close must not disable later commands');
  assert.equal(vscode.panelCount(), 2, 'a new panel was created');

  panel.dispose();
  assert.deepEqual(secondCloses, ['cancelled'], 'dispose after reopen closes the new panel');
});

test('a second open replaces the first; the old channel is inert', () => {
  const controller = fakeController();
  const panel = new SecretPanel(deps(controller));
  const closesA = [];
  const closesB = [];
  assert.equal(openCreate(panel, MNEMONIC_A, (outcome) => closesA.push(outcome)).ok, true);
  const first = vscode.lastPanel();
  assert.equal(openCreate(panel, MNEMONIC_B, (outcome) => closesB.push(outcome)).ok, true);

  assert.equal(first.disposed, true, 'the first panel is disposed');
  assert.deepEqual(closesA, ['cancelled'], 'the first close callback runs exactly once');
  assert.equal(controller.pending.value, MNEMONIC_B, 'the pending secret is the new flow');

  first.send({ type: 'saved' });
  assert.deepEqual(closesB, [], 'a stale saved from the replaced panel is dropped');
  assert.equal(controller.pending.value, MNEMONIC_B, 'the pending secret is unchanged');

  panel.dispose();
  assert.deepEqual(closesB, ['cancelled'], 'dispose closes the live panel once');
});

test('a controller generation bump drops messages and the guard closes the panel', async () => {
  const controller = fakeController();
  const panel = new SecretPanel(deps(controller));
  const closes = [];
  assert.equal(openCreate(panel, MNEMONIC_A, (outcome) => closes.push(outcome)).ok, true);
  const live = vscode.lastPanel();

  controller.bump();
  live.send({ type: 'saved' });
  assert.deepEqual(closes, [], 'a message from the stale generation is dropped');
  assert.equal(live.disposed, false, 'the guard, not the message, closes the panel');

  // Poll instead of sleeping exactly 1.2 s: a loaded CI machine can fire the
  // guard interval late, but it must still close the panel.
  for (let attempt = 0; attempt < 30 && closes.length === 0; attempt += 1) {
    await delay(100);
  }
  assert.deepEqual(closes, ['cancelled'], 'the 1 s guard closes the stale panel');
  assert.equal(live.disposed, true);
});

test('window blur closes the panel and clears the pending flow secret', () => {
  const controller = fakeController();
  const panel = new SecretPanel(deps(controller));
  const closes = [];
  assert.equal(openCreate(panel, MNEMONIC_A, (outcome) => closes.push(outcome)).ok, true);
  const live = vscode.lastPanel();

  vscode.fireWindowBlur();
  assert.deepEqual(closes, ['cancelled']);
  assert.equal(controller.pending, null, 'blur drops the flow secret');
  assert.equal(live.disposed, true);

  // The extension's blur handler also calls `dispose()`; the holder stays usable.
  panel.dispose();
  assert.equal(openCreate(panel, MNEMONIC_A).ok, true);
  panel.dispose();
});

test('shutdown is terminal: no panel can be opened afterwards', () => {
  const controller = fakeController();
  const panel = new SecretPanel(deps(controller));
  const closes = [];
  assert.equal(openCreate(panel, MNEMONIC_A, (outcome) => closes.push(outcome)).ok, true);
  const live = vscode.lastPanel();

  panel.shutdown();
  assert.deepEqual(closes, ['cancelled']);
  assert.equal(live.disposed, true);

  const reopened = openCreate(panel, MNEMONIC_A);
  assert.equal(reopened.ok, false);
  assert.equal(reopened.code, 'OPERATION_CANCELLED');
  assert.equal(vscode.panelCount(), 1, 'no panel is created after shutdown');
});
