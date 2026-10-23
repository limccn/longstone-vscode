/** Command/state dispatch and wallet flows (design §7.2, §8; ux-flows §2-§9). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMAND_WALLET_CHANGE_PASSWORD,
  COMMAND_WALLET_COPY_ADDRESS,
  COMMAND_WALLET_CREATE,
  COMMAND_WALLET_EXPORT_SECRET,
  COMMAND_WALLET_IMPORT,
  COMMAND_WALLET_LOCK,
  COMMAND_WALLET_MANAGE,
  COMMAND_WALLET_RESET,
} from '../src/shared/constants.ts';
import {
  createWalletCommandHandlers,
  decideWalletCommand,
  EXPORT_WRONG_PASSWORD_COPY,
  RESET_WARNING,
  runWalletCommand,
  WALLET_COMMAND_IDS,
} from '../src/host/wallet/commands.ts';
import { DEFAULT_WALLET_CORE } from '../src/host/wallet/controller.ts';
import { walletErrorMessage, walletRateLimitMessage } from '../src/host/wallet/errors.ts';
import {
  deferred,
  lockedWallet,
  makeWallet,
  settle,
  TEST_PASSWORD,
  TEST_PRIVATE_KEY,
  NEW_PASSWORD,
  unlockedWallet,
} from './wallet-helpers.mjs';

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const SECOND_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const NO_VAULT = { status: 'NO_VAULT' };
const LOCKED = { status: 'LOCKED', record: null, recoveryPending: false, corrupt: false };
const UNLOCKED = {
  status: 'UNLOCKED',
  snapshot: {
    accounts: [],
    activeAccountId: 'a'.repeat(32),
    activeAddress: ADDRESS,
    activeLabel: 'Account 1',
    activeIndex: 1,
  },
};
const UNAVAILABLE = { status: 'UNAVAILABLE', code: 'remote' };

function makeHost(overrides = {}) {
  const calls = {
    errors: [],
    infos: [],
    warnings: [],
    inputs: [],
    quickPicks: [],
    progress: [],
    clipboard: [],
    delays: [],
  };
  const host = {
    async showInputBox(spec) {
      calls.inputs.push(spec);
      return undefined;
    },
    async showQuickPick(items, options) {
      calls.quickPicks.push({ items, options });
      return undefined;
    },
    async showErrorMessage(message) {
      calls.errors.push(message);
      return undefined;
    },
    async showInformationMessage(message, ...items) {
      calls.infos.push({ message, items });
      return undefined;
    },
    async showWarningMessage(message, options, ...items) {
      calls.warnings.push({ message, options, items });
      return undefined;
    },
    async showProgress(title, task) {
      calls.progress.push(title);
      return task();
    },
    async writeClipboard(text) {
      calls.clipboard.push(text);
    },
    async delay(ms) {
      calls.delays.push(ms);
    },
    ...overrides,
  };
  return { host, calls };
}

function fakePanel(controller) {
  const state = { opens: [], disposed: 0, current: null };
  return {
    state,
    open(request, options) {
      state.opens.push(request);
      state.current = { request, options };
      if (request.mode === 'create-reveal') {
        controller.setPendingSecret({ kind: 'mnemonic', value: request.value });
      }
      return { ok: true };
    },
    dispose() {
      state.disposed += 1;
      state.current = null;
    },
    close(outcome = 'cancelled') {
      const current = state.current;
      state.current = null;
      current?.options?.onClose?.(outcome);
    },
  };
}

function inputMap(map) {
  return async (spec) => {
    const queue = map[spec.prompt];
    if (queue === undefined) return undefined;
    return queue.shift();
  };
}

describe('decideWalletCommand', () => {
  const cases = [
    // command, NO_VAULT action, LOCKED action, UNLOCKED action
    [COMMAND_WALLET_MANAGE, 'manage', 'manage', 'manage'],
    [COMMAND_WALLET_CREATE, 'create', 'message', 'message'],
    [COMMAND_WALLET_IMPORT, 'import-first', 'message', 'import-add'],
    [COMMAND_WALLET_LOCK, 'message', 'message', 'lock'],
    [COMMAND_WALLET_COPY_ADDRESS, 'message', 'message', 'copy-address'],
    [COMMAND_WALLET_EXPORT_SECRET, 'message', 'message', 'export-secret'],
    [COMMAND_WALLET_CHANGE_PASSWORD, 'message', 'change-password', 'change-password'],
    [COMMAND_WALLET_RESET, 'message', 'reset', 'message'],
  ];

  for (const [command, empty, locked, unlocked] of cases) {
    it(`${command} follows the §7.2 table`, () => {
      assert.equal(decideWalletCommand(command, NO_VAULT).action, empty);
      assert.equal(decideWalletCommand(command, LOCKED).action, locked);
      assert.equal(decideWalletCommand(command, UNLOCKED).action, unlocked);
    });
  }

  it('every command reports the local-only copy in a remote window', () => {
    for (const command of WALLET_COMMAND_IDS) {
      const decision = decideWalletCommand(command, UNAVAILABLE);
      assert.equal(decision.action, 'message', command);
      assert.equal(decision.severity, 'error', command);
      assert.equal(decision.message, walletErrorMessage('WALLET_REMOTE_UNSUPPORTED'));
    }
  });

  it('locked-state messages never contain an address or account data', () => {
    for (const command of WALLET_COMMAND_IDS) {
      const decision = decideWalletCommand(command, LOCKED);
      if (decision.action !== 'message') continue;
      assert.equal(decision.message.includes('0x'), false, command);
      assert.equal(decision.message.includes('Account'), false, command);
    }
  });

  it('reset asks to lock first when unlocked', () => {
    const decision = decideWalletCommand(COMMAND_WALLET_RESET, UNLOCKED);
    assert.equal(decision.action, 'message');
    assert.equal(decision.message, 'Lock the wallet before resetting it.');
  });

  it('import asks to unlock when locked', () => {
    const decision = decideWalletCommand(COMMAND_WALLET_IMPORT, LOCKED);
    assert.equal(decision.action, 'message');
    assert.equal(decision.message, 'Unlock the wallet to add an account.');
  });
});

describe('createWalletCommandHandlers', () => {
  it('registers exactly the eight manifest commands', () => {
    const { host } = makeHost();
    const handlers = createWalletCommandHandlers({
      controller: { state: NO_VAULT, busy: null, epoch: 0 },
      panel: { open: () => ({ ok: true }), dispose() {} },
      host,
    });
    assert.deepEqual(Object.keys(handlers).sort(), [...WALLET_COMMAND_IDS].sort());
    assert.equal(WALLET_COMMAND_IDS.length, 8);
  });
});

describe('busy and lock', () => {
  it('rejects non-lock commands while the controller is busy', async () => {
    const { host, calls } = makeHost();
    const controller = { state: UNLOCKED, busy: 'unlock', epoch: 3 };
    await runWalletCommand(COMMAND_WALLET_COPY_ADDRESS, {
      controller,
      panel: fakePanel({ setPendingSecret() {} }),
      host,
    });
    assert.deepEqual(calls.errors, [walletErrorMessage('WALLET_BUSY')]);
  });

  it('lock is allowed while busy and disposes the panel first', async () => {
    const { host, calls } = makeHost();
    const order = [];
    const controller = {
      state: UNLOCKED,
      busy: 'create',
      epoch: 7,
      lock(reason) {
        order.push(`lock:${reason}`);
        this.state = LOCKED;
        this.epoch += 1;
      },
      consumeNotice() {
        return null;
      },
    };
    const panel = {
      open() {
        throw new Error('not used');
      },
      dispose() {
        order.push('panel');
      },
    };
    await runWalletCommand(COMMAND_WALLET_LOCK, { controller, panel, host });
    assert.deepEqual(order, ['panel', 'lock:explicit']);
    assert.ok(calls.infos.some(({ message }) => message === 'Wallet locked.'));
  });
});

describe('create flow', () => {
  it('starts a wallet after the reveal panel saves and the password pair matches', async () => {
    const { controller } = makeWallet();
    const panel = fakePanel(controller);
    const { host, calls } = makeHost({
      showInputBox: inputMap({
        'Wallet password': [TEST_PASSWORD],
        'Confirm password': [TEST_PASSWORD],
      }),
    });

    const running = runWalletCommand(COMMAND_WALLET_CREATE, { controller, panel, host });
    await settle();
    assert.equal(panel.state.opens.length, 1);
    assert.equal(panel.state.opens[0].mode, 'create-reveal');
    assert.equal(panel.state.opens[0].kind, 'mnemonic');
    assert.equal(panel.state.opens[0].address.length, 42);

    panel.close('saved');
    await running;

    assert.equal(controller.state.status, 'UNLOCKED');
    assert.equal(controller.hasPendingSecret(), false);
    assert.deepEqual(calls.progress, ['Creating wallet…']);
    assert.ok(calls.infos.some(({ message }) => message === 'Wallet created. Back up your recovery phrase offline.'));
  });

  it('clears the pending secret when the reveal panel is cancelled', async () => {
    const { controller } = makeWallet();
    const panel = fakePanel(controller);
    const { host, calls } = makeHost();

    const running = runWalletCommand(COMMAND_WALLET_CREATE, { controller, panel, host });
    await settle();
    panel.close('cancelled');
    await running;

    assert.equal(controller.state.status, 'NO_VAULT');
    assert.equal(controller.hasPendingSecret(), false);
    assert.deepEqual(calls.errors, []);
    assert.deepEqual(calls.infos, []);
  });

  it('re-prompts after a policy failure and never writes early', async () => {
    const { controller, memento } = makeWallet();
    const panel = fakePanel(controller);
    const { host, calls } = makeHost({
      showInputBox: inputMap({
        'Wallet password': ['short', TEST_PASSWORD],
        'Confirm password': [TEST_PASSWORD],
      }),
    });

    const running = runWalletCommand(COMMAND_WALLET_CREATE, { controller, panel, host });
    await settle();
    panel.close('saved');
    await running;

    assert.equal(controller.state.status, 'UNLOCKED');
    assert.ok(calls.infos.some(({ message }) => message === walletErrorMessage('TOO_SHORT')));
    assert.equal(memento.reads.length > 0, true);
  });

  it('discards a successful create that finishes after a lock (no success message)', async () => {
    const gate = deferred();
    const started = deferred();
    const core = {
      ...DEFAULT_WALLET_CORE,
      async createVault(deps, input) {
        started.resolve();
        await gate.promise;
        return DEFAULT_WALLET_CORE.createVault(deps, input);
      },
    };
    const { controller } = makeWallet({ core });
    const panel = fakePanel(controller);
    const { host, calls } = makeHost({
      showInputBox: inputMap({
        'Wallet password': [TEST_PASSWORD],
        'Confirm password': [TEST_PASSWORD],
      }),
    });

    const running = runWalletCommand(COMMAND_WALLET_CREATE, { controller, panel, host });
    await settle();
    panel.close('saved');
    await started.promise;
    controller.lock('focus-lost');
    gate.resolve();
    await running;

    assert.notEqual(controller.state.status, 'UNLOCKED');
    assert.equal(controller.hasPendingSecret(), false);
    assert.equal(
      calls.infos.some(({ message }) => message.includes('Wallet created')),
      false,
    );
  });
});

describe('import flow', () => {
  it('imports a private key after address confirmation', async () => {
    const { controller } = makeWallet();
    const panel = fakePanel(controller);
    const { host, calls } = makeHost({
      showQuickPick: async (items) => items.find((item) => item.value === 'privateKey'),
      showInputBox: inputMap({
        'Wallet password': [TEST_PASSWORD],
        'Confirm password': [TEST_PASSWORD],
      }),
    });
    host.showInformationMessage = async (message, ...items) => {
      calls.infos.push({ message, items });
      return items.includes('Use this address') ? 'Use this address' : undefined;
    };

    const running = runWalletCommand(COMMAND_WALLET_IMPORT, { controller, panel, host });
    await settle();
    assert.equal(panel.state.opens.length, 1);
    assert.equal(panel.state.opens[0].mode, 'import');
    assert.equal(panel.state.opens[0].kind, 'privateKey');

    const pending = controller.setPendingSecret({
      kind: 'privateKey',
      value: TEST_PRIVATE_KEY,
    });
    assert.equal(pending.ok, true);
    panel.close('saved');
    await running;

    assert.equal(controller.state.status, 'UNLOCKED');
    assert.equal(controller.accounts()[0].source, 'private-key');
    assert.ok(
      calls.infos.some(({ message }) => message === 'Wallet imported. Back up the recovery phrase offline.'),
    );
    assert.ok(
      calls.infos.some(({ message }) => message.startsWith('Use this address? 0x')),
    );
  });

  it('cancels at the address confirmation and clears the secret', async () => {
    const { controller } = makeWallet();
    const panel = fakePanel(controller);
    const { host } = makeHost({
      showQuickPick: async (items) => items.find((item) => item.value === 'mnemonic'),
    });
    const running = runWalletCommand(COMMAND_WALLET_IMPORT, { controller, panel, host });
    await settle();
    controller.setPendingSecret({
      kind: 'mnemonic',
      value: 'test test test test test test test test test test test junk',
    });
    panel.close('saved');
    await running;

    assert.equal(controller.state.status, 'NO_VAULT');
    assert.equal(controller.hasPendingSecret(), false);
    assert.equal(controller.accounts().length, 0);
  });

  it('adds an account while unlocked without a password prompt', async () => {
    const { controller } = await unlockedWallet();
    const panel = fakePanel(controller);
    const { host, calls } = makeHost({
      showQuickPick: async (items) => items.find((item) => item.value === 'mnemonic'),
    });

    const running = runWalletCommand(COMMAND_WALLET_IMPORT, { controller, panel, host });
    await settle();
    controller.setPendingSecret({ kind: 'mnemonic', value: SECOND_MNEMONIC });
    panel.close('saved');
    await running;

    assert.equal(controller.state.status, 'UNLOCKED');
    assert.equal(controller.accounts().length, 2);
    assert.deepEqual(calls.inputs, []);
    assert.deepEqual(calls.progress, []);
    assert.ok(calls.infos.some(({ message }) => message.startsWith('Account added: 0x')));
  });
});

describe('export flow', () => {
  it('does not open a reveal panel when a lock races the password verify', async () => {
    const gate = deferred();
    const started = deferred();
    let deferUnlock = false;
    const core = {
      ...DEFAULT_WALLET_CORE,
      async unlockVault(deps, password) {
        if (deferUnlock) {
          started.resolve();
          await gate.promise;
        }
        return DEFAULT_WALLET_CORE.unlockVault(deps, password);
      },
    };
    const { controller } = await unlockedWallet({ core });
    deferUnlock = true;
    const panel = fakePanel(controller);
    const { host } = makeHost({
      showQuickPick: async (items) => items[0],
      async showInputBox(spec) {
        return spec.prompt.startsWith('Enter the wallet password') ? TEST_PASSWORD : undefined;
      },
    });

    const running = runWalletCommand(COMMAND_WALLET_EXPORT_SECRET, { controller, panel, host });
    await started.promise;
    controller.lock('focus-lost');
    gate.resolve();
    await running;

    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(panel.state.opens.length, 0);
  });

  it('refuses to export with the wrong password and says nothing was exported', async () => {
    const { controller } = await unlockedWallet();
    const panel = fakePanel(controller);
    const { host, calls } = makeHost({
      showQuickPick: async (items) => items[0],
      async showInputBox(spec) {
        return spec.prompt.startsWith('Enter the wallet password') ? 'wrong password' : undefined;
      },
    });

    await runWalletCommand(COMMAND_WALLET_EXPORT_SECRET, { controller, panel, host });

    assert.equal(panel.state.opens.length, 0);
    assert.deepEqual(calls.errors, [EXPORT_WRONG_PASSWORD_COPY]);
  });
});

describe('copy address', () => {
  it('copies the active address and announces the public value', async () => {
    const { controller } = await unlockedWallet();
    const { host, calls } = makeHost();
    await runWalletCommand(COMMAND_WALLET_COPY_ADDRESS, {
      controller,
      panel: fakePanel(controller),
      host,
    });
    assert.deepEqual(calls.clipboard, [controller.activeAccount().address]);
    assert.deepEqual(
      calls.infos.map(({ message }) => message),
      [`Address copied: ${controller.activeAccount().address}`],
    );
  });

  it('suppresses the confirmation when a lock wins the clipboard await', async () => {
    const clipboardGate = deferred();
    const clipboardStarted = deferred();
    const { controller } = await unlockedWallet();
    const { host, calls } = makeHost();
    host.writeClipboard = async () => {
      clipboardStarted.resolve();
      await clipboardGate.promise;
    };

    const running = runWalletCommand(COMMAND_WALLET_COPY_ADDRESS, {
      controller,
      panel: fakePanel(controller),
      host,
    });
    await clipboardStarted.promise;
    controller.lock('focus-lost');
    clipboardGate.resolve();
    await running;

    assert.equal(calls.infos.length, 0);
  });
});

describe('unlock flow', () => {
  it('waits out the rate limit, then unlocks with the retry copy', async () => {
    const { controller, clock } = await lockedWallet();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await controller.unlock('wrong password');
    }
    assert.equal(controller.unlockRetryAfterSeconds(), 1);

    const { host, calls } = makeHost({
      async showQuickPick(items) {
        return items.find((item) => item.action === 'unlock');
      },
      async showInputBox(spec) {
        return spec.prompt === 'Wallet password' ? TEST_PASSWORD : undefined;
      },
      async delay(ms) {
        calls.delays.push(ms);
        clock.advance(ms);
      },
    });
    await runWalletCommand(COMMAND_WALLET_MANAGE, {
      controller,
      panel: fakePanel(controller),
      host,
    });

    assert.deepEqual(calls.delays, [1000]);
    assert.equal(calls.infos[0].message, walletRateLimitMessage(1));
    assert.equal(controller.state.status, 'UNLOCKED');
    assert.ok(calls.infos.some(({ message }) => message === 'Wallet unlocked.'));
  });
});

describe('change password flow', () => {
  it('changes a locked wallet and reports the new-password instruction', async () => {
    const { controller } = await lockedWallet();
    const { host, calls } = makeHost({
      showInputBox: inputMap({
        'Current wallet password': [TEST_PASSWORD],
        'New wallet password': [NEW_PASSWORD],
        'Confirm password': [NEW_PASSWORD],
      }),
    });

    await runWalletCommand(COMMAND_WALLET_CHANGE_PASSWORD, {
      controller,
      panel: fakePanel(controller),
      host,
    });

    assert.equal(controller.state.status, 'LOCKED');
    assert.ok(
      calls.infos.some(({ message }) => message === 'Password changed. Unlock with the new password.'),
    );

    const unlocked = await controller.unlock(NEW_PASSWORD);
    assert.equal(unlocked.ok, true);
  });
});

describe('reset flow', () => {
  it('requires the exact RESET phrase and deletes the wallet', async () => {
    const { controller } = await lockedWallet();
    const { host, calls } = makeHost({
      async showWarningMessage(message, options, ...items) {
        calls.warnings.push({ message, options, items });
        return 'Continue';
      },
      async showInputBox(spec) {
        calls.inputs.push(spec);
        return 'RESET';
      },
    });

    await runWalletCommand(COMMAND_WALLET_RESET, {
      controller,
      panel: fakePanel(controller),
      host,
    });

    assert.equal(calls.warnings[0].message, RESET_WARNING);
    assert.deepEqual(calls.warnings[0].items, ['Continue', 'Cancel']);
    assert.equal(controller.state.status, 'NO_VAULT');
    assert.ok(calls.infos.some(({ message }) => message === 'Wallet deleted.'));
  });

  it('does nothing when the phrase does not match', async () => {
    const { controller } = await lockedWallet();
    const { host, calls } = makeHost({
      async showWarningMessage() {
        return 'Continue';
      },
      async showInputBox() {
        return 'reset';
      },
    });

    await runWalletCommand(COMMAND_WALLET_RESET, {
      controller,
      panel: fakePanel(controller),
      host,
    });

    assert.equal(controller.state.status, 'LOCKED');
    assert.deepEqual(calls.infos, []);
    assert.deepEqual(calls.errors, []);
  });
});

describe('manage menu', () => {
  it('deletes the last account through the account menu with the extra warning', async () => {
    const { controller } = await unlockedWallet();
    let pick = 0;
    const { host, calls } = makeHost({
      async showQuickPick(items) {
        pick += 1;
        if (pick === 1) return items.find((item) => item.kind === 'account');
        return items.find((item) => item.action === 'delete');
      },
      async showWarningMessage(message, options, ...items) {
        calls.warnings.push({ message, options, items });
        return 'Delete';
      },
    });

    await runWalletCommand(COMMAND_WALLET_MANAGE, {
      controller,
      panel: fakePanel(controller),
      host,
    });

    assert.match(calls.warnings[0].message, /This is the last account/);
    assert.equal(controller.state.status, 'NO_VAULT');
    assert.ok(calls.infos.some(({ message }) => message === 'Wallet deleted.'));
  });

  it('does not show account data in the locked menu', async () => {
    const { controller } = await lockedWallet();
    const { host, calls } = makeHost();
    await runWalletCommand(COMMAND_WALLET_MANAGE, {
      controller,
      panel: fakePanel(controller),
      host,
    });
    assert.equal(calls.quickPicks.length, 1);
    assert.deepEqual(
      calls.quickPicks[0].items.map((item) => item.action),
      ['unlock', 'changePassword', 'reset'],
    );
    assert.equal(JSON.stringify(calls.quickPicks[0].items).includes('0x'), false);
  });
});
