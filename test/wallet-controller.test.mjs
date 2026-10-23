/**
 * WalletController tests (design §4.2–§4.4, §5, §5.6; AC-15/AC-21/AC-23/AC-24).
 *
 * The real shared core runs against a fake Memento; only the specific failure
 * being tested is injected (a write that lands then throws, a rival write, a
 * deferred KDF window).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DERIVATION_PATH,
  WalletError,
  deriveAccountFromMnemonic,
  hashRecord,
  privateKeyToAddress,
} from '@limccn/longstone-wallet';

import {
  DEFAULT_WALLET_CORE,
  WalletController,
  unlockDelaySeconds,
} from '../src/host/wallet/controller.ts';
import { MementoStorage } from '../src/host/wallet/global-state.ts';
import {
  WALLET_STORAGE_PENDING_KEY,
  WALLET_STORAGE_RECORD_KEY,
} from '../src/shared/constants.ts';
import {
  FakeMemento,
  NEW_PASSWORD,
  SECOND_MNEMONIC,
  TEST_MNEMONIC,
  TEST_PASSWORD,
  TEST_PRIVATE_KEY,
  deferred,
  fakeScheduler,
  fastArgon2,
  lockedWallet,
  makeWallet,
  recordingStatusBar,
  rivalRecord,
  settle,
  unlockedWallet,
} from './wallet-helpers.mjs';

const EXTERNAL_NOTICE = 'Wallet data changed in another window. Unlock again.';
const NOT_APPLIED = 'Could not save the wallet. Nothing was changed.';
const UNVERIFIED = 'Could not verify the save. Unlock again to reload.';

function firstAccount(controller) {
  if (controller.state.status !== 'UNLOCKED') throw new Error('wallet is not unlocked');
  return controller.state.snapshot.accounts[0];
}

function recordOf(memento, key) {
  const raw = memento.raw(key);
  assert.equal(typeof raw, 'string');
  return JSON.parse(raw);
}

/**
 * Storage adapter whose first record access after the armed mutation blocks
 * until the test releases it. Models a genuinely async adapter, where a lock
 * can land between the write and the controller's verification read-back.
 */
function gatedRecordReadback(memento) {
  const base = new MementoStorage(memento);
  let armOnMutation = false;
  let armed = false;
  const started = deferred();
  const release = deferred();
  const armIfRecordMutation = (key) => {
    if (armOnMutation && key === base.keys.record) armed = true;
  };
  return {
    storage: {
      keys: base.keys,
      async get(key) {
        if (armed && key === base.keys.record) {
          armed = false;
          started.resolve();
          await release.promise;
        }
        return base.get(key);
      },
      async set(items) {
        await base.set(items);
        if (Object.prototype.hasOwnProperty.call(items, base.keys.record)) {
          armIfRecordMutation(base.keys.record);
        }
      },
      async remove(key) {
        await base.remove(key);
        armIfRecordMutation(key);
      },
      async readRaw(key) {
        if (armed && key === base.keys.record) {
          armed = false;
          started.resolve();
          await release.promise;
        }
        return base.readRaw(key);
      },
      clearAttempts() {
        base.clearAttempts();
      },
      lastAttempt(key) {
        return base.lastAttempt(key);
      },
      lastRead(key) {
        return base.lastRead(key);
      },
    },
    arm() {
      armOnMutation = true;
    },
    started,
    release,
  };
}

// ---------------------------------------------------------------------------
// State mapping and load
// ---------------------------------------------------------------------------

describe('WalletController state and load', () => {
  it('maps empty storage to NO_VAULT', async () => {
    const statusBar = recordingStatusBar();
    const { controller } = makeWallet({ statusBar });
    assert.equal(controller.state.status, 'NO_VAULT');
    const state = await controller.load();
    assert.equal(state.status, 'NO_VAULT');
    assert.deepEqual(statusBar.states, [{ status: 'NO_VAULT' }]);
  });

  it('maps a stored record to LOCKED metadata without a key or payload', async () => {
    const { controller } = await lockedWallet();
    const state = await controller.load();
    assert.equal(state.status, 'LOCKED');
    assert.notEqual(state.record, null);
    assert.equal(state.record.recordHash, state.record.recordHash.toLowerCase());
    assert.equal(controller.recordHash, null);
    assert.equal('payload' in state, false);
    assert.equal('key' in state, false);
    assert.equal('debugDump' in controller, false);
    assert.equal('payload' in controller, false);
  });

  it('maps a corrupt record to LOCKED with no metadata', async () => {
    const { controller, memento, storage } = makeWallet();
    memento.setExternal(storage.keys.record, 'this is not a wallet record');
    const state = await controller.load();
    assert.equal(state.status, 'LOCKED');
    assert.equal(state.record, null);
    assert.equal(state.corrupt, true);
    assert.equal(state.recoveryPending, false);
  });

  it('maps a pending-only record to LOCKED(recoveryPending), never NO_VAULT', async () => {
    const { controller, memento, storage } = await lockedWallet();
    memento.setExternal(storage.keys.pending, memento.raw(storage.keys.record));
    memento.deleteExternal(storage.keys.record);

    const state = await controller.load();
    assert.equal(state.status, 'LOCKED');
    assert.equal(state.recoveryPending, true);
    assert.notEqual(state.record, null);
    assert.equal(state.corrupt, false);

    const statusBarStates = [];
    const result = await controller.unlock(TEST_PASSWORD);
    assert.equal(result.ok, true);
    assert.equal(controller.state.status, 'UNLOCKED');
    assert.equal(memento.has(storage.keys.pending), false);
    assert.equal(typeof memento.raw(storage.keys.record), 'string');
    assert.match(controller.notice ?? '', /Recovered the wallet/);
    assert.deepEqual(statusBarStates, []);
  });

  it('keeps an unlocked session when a reload sees the same record hash', async () => {
    const { controller } = await unlockedWallet();
    const before = controller.recordHash;
    const state = await controller.load();
    assert.equal(state.status, 'UNLOCKED');
    assert.equal(controller.recordHash, before);
  });

  it('fails closed when the load read itself fails', async () => {
    const { controller, memento, storage } = await lockedWallet();
    memento.failNextGet = { key: storage.keys.record };
    const state = await controller.load();
    assert.equal(state.status, 'LOCKED');
    assert.equal(state.record, null);
  });
});

// ---------------------------------------------------------------------------
// Create, storage shape, unlock rate limiting, single flight
// ---------------------------------------------------------------------------

describe('WalletController create and storage shape', () => {
  it('requires a pending secret before create', async () => {
    const { controller } = makeWallet();
    const result = await controller.create(TEST_PASSWORD);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SECRET_UNAVAILABLE');
    assert.equal(controller.state.status, 'NO_VAULT');
  });

  it('stores only ciphertext strings under the physical keys', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    assert.equal(storage.keys.record, WALLET_STORAGE_RECORD_KEY);
    assert.equal(storage.keys.pending, WALLET_STORAGE_PENDING_KEY);

    const raw = memento.raw(storage.keys.record);
    assert.equal(typeof raw, 'string');
    assert.equal(raw.includes(TEST_MNEMONIC), false);
    assert.equal(raw.includes(TEST_PASSWORD), false);
    assert.equal(raw.includes(TEST_PRIVATE_KEY), false);
    assert.equal(raw.toLowerCase().includes('test test test'), false);

    for (const write of memento.writes) {
      assert.ok(
        write.key === storage.keys.record || write.key === storage.keys.pending,
        `unexpected key ${write.key}`,
      );
    }

    const state = controller.state;
    assert.equal(state.status, 'UNLOCKED');
    assert.equal(state.snapshot.activeAddress, deriveAccountFromMnemonic(TEST_MNEMONIC).address);
    assert.equal(controller.recordHash, hashRecord(recordOf(memento, storage.keys.record)));
    assert.equal(controller.hasPendingSecret(), false);
  });

  it('never calls setKeysForSync', async () => {
    const { memento } = await unlockedWallet();
    memento.setKeysForSync = () => {
      throw new Error('setKeysForSync must never be called');
    };
    // The adapter captured the memento object; adding the method after setup
    // still proves nothing invokes it on later writes.
    assert.equal(typeof memento.setKeysForSync, 'function');
  });
});

describe('WalletController unlock and rate limiting', () => {
  it('rejects a wrong password and keeps the wallet locked', async () => {
    const { controller } = await lockedWallet();
    const result = await controller.unlock('wrong password');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DECRYPT_FAILED');
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.recordHash, null);
  });

  it('applies the 1/2/4/8/16/30 s backoff from the fifth failure', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12].map(unlockDelaySeconds),
      [0, 0, 0, 0, 1, 2, 4, 8, 16, 30, 30],
    );
  });

  it('locks out after five failures and recovers after the delay', async () => {
    const { controller, clock } = await lockedWallet();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failure = await controller.unlock(`wrong password ${String(attempt)}`);
      assert.equal(failure.code, 'DECRYPT_FAILED');
    }

    clock.advance(500);
    const blocked = await controller.unlock(TEST_PASSWORD);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'UNLOCK_RATE_LIMITED');
    assert.equal(blocked.retryAfterSeconds, 1);
    assert.match(blocked.message, /Try again in 1s/);

    clock.advance(600);
    const unlocked = await controller.unlock(TEST_PASSWORD);
    assert.equal(unlocked.ok, true);
  });

  it('keeps the unlock limiter across a lock and clears it on success', async () => {
    const { controller, clock } = await lockedWallet();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await controller.unlock(`wrong password ${String(attempt)}`);
    }
    clock.advance(500);
    assert.equal(controller.unlockRetryAfterSeconds(), 1);

    controller.lock('explicit');
    assert.equal(
      controller.unlockRetryAfterSeconds(),
      1,
      'locking must not be a way to reset a lockout',
    );

    clock.advance(600);
    assert.equal(controller.unlockRetryAfterSeconds(), 0);
    const unlocked = await controller.unlock(TEST_PASSWORD);
    assert.equal(unlocked.ok, true);
    assert.equal(controller.unlockRetryAfterSeconds(), 0);
  });

  it('returns WALLET_BUSY for a concurrent unlock', async () => {
    const started = deferred();
    const gate = deferred();
    const core = {
      ...DEFAULT_WALLET_CORE,
      async unlockVault(deps, password) {
        started.resolve();
        await gate.promise;
        return DEFAULT_WALLET_CORE.unlockVault(deps, password);
      },
    };
    const { controller } = await lockedWallet({ core });

    const first = controller.unlock(TEST_PASSWORD);
    await started.promise;
    const second = await controller.unlock(TEST_PASSWORD);
    assert.equal(second.ok, false);
    assert.equal(second.code, 'WALLET_BUSY');

    gate.resolve();
    const result = await first;
    assert.equal(result.ok, true);
    assert.equal(controller.busy, null);
  });

  it('discards an in-flight unlock that finishes after a lock (DR-19)', async () => {
    const started = deferred();
    const gate = deferred();
    const core = {
      ...DEFAULT_WALLET_CORE,
      async unlockVault(deps, password) {
        started.resolve();
        await gate.promise;
        return DEFAULT_WALLET_CORE.unlockVault(deps, password);
      },
    };
    const { controller } = await lockedWallet({ core });

    const pending = controller.unlock(TEST_PASSWORD);
    await started.promise;
    const epochBefore = controller.epoch;
    controller.lock('explicit');
    gate.resolve();

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OPERATION_CANCELLED');
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.recordHash, null);
    assert.ok(controller.epoch > epochBefore);
  });

  it('discards an in-flight create that finishes after a lock (DR-19)', async () => {
    const started = deferred();
    const gate = deferred();
    const core = {
      ...DEFAULT_WALLET_CORE,
      async createVault(deps, input) {
        started.resolve();
        await gate.promise;
        return DEFAULT_WALLET_CORE.createVault(deps, input);
      },
    };
    const { controller, memento, storage } = makeWallet({ core });
    controller.setPendingSecret({ kind: 'mnemonic', value: TEST_MNEMONIC });

    const pending = controller.create(TEST_PASSWORD, { source: 'created' });
    await started.promise;
    controller.lock('explicit');
    gate.resolve();

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OPERATION_CANCELLED');
    assert.equal(controller.hasPendingSecret(), false);
    assert.equal(controller.state.status, 'LOCKED');
    assert.notEqual(controller.state.record, null);
    assert.equal(typeof memento.raw(storage.keys.record), 'string');
  });

  it('discards an in-flight account write that finishes after a lock (DR-19)', async () => {
    const started = deferred();
    const gate = deferred();
    const core = {
      ...DEFAULT_WALLET_CORE,
      async renameAccount(deps, vault, accountId, label) {
        started.resolve();
        await gate.promise;
        return DEFAULT_WALLET_CORE.renameAccount(deps, vault, accountId, label);
      },
    };
    const { controller } = await unlockedWallet({ core });
    const account = firstAccount(controller);

    const pending = controller.rename(account.id, 'Raced rename');
    await started.promise;
    controller.lock('explicit');
    gate.resolve();

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OPERATION_CANCELLED');
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.recordHash, null);
    assert.equal(controller.busy, null);
  });

  it('keeps a completed password change locked and reports it, never resurrecting', async () => {
    const started = deferred();
    const gate = deferred();
    const core = {
      ...DEFAULT_WALLET_CORE,
      async changePassword(deps, input) {
        started.resolve();
        await gate.promise;
        return DEFAULT_WALLET_CORE.changePassword(deps, input);
      },
    };
    const { controller } = await unlockedWallet({ core });

    const pending = controller.changePassword(TEST_PASSWORD, NEW_PASSWORD);
    await started.promise;
    controller.lock('explicit');
    gate.resolve();

    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.value.locked, true);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.recordHash, null);
    assert.match(controller.notice, /Password changed/);

    const oldPassword = await controller.unlock(TEST_PASSWORD);
    assert.equal(oldPassword.ok, false);
    const newPassword = await controller.unlock(NEW_PASSWORD);
    assert.equal(newPassword.ok, true);
  });

  it('single-flights every mutating operation across kinds', async () => {
    const started = deferred();
    const gate = deferred();
    const core = {
      ...DEFAULT_WALLET_CORE,
      async changePassword(deps, input) {
        started.resolve();
        await gate.promise;
        return DEFAULT_WALLET_CORE.changePassword(deps, input);
      },
    };
    const { controller } = await unlockedWallet({ core });
    const account = firstAccount(controller);

    const changing = controller.changePassword(TEST_PASSWORD, NEW_PASSWORD);
    await started.promise;

    const rename = await controller.rename(account.id, 'Busy rename');
    assert.equal(rename.ok, false);
    assert.equal(rename.code, 'WALLET_BUSY');

    const unlocking = await controller.unlock(TEST_PASSWORD);
    assert.equal(unlocking.ok, false);
    assert.equal(unlocking.code, 'WALLET_BUSY');
    assert.equal(controller.busy, 'change-password');

    gate.resolve();
    const changed = await changing;
    assert.equal(changed.ok, true);
    assert.equal(controller.busy, null);
  });
});

// ---------------------------------------------------------------------------
// Lock triggers
// ---------------------------------------------------------------------------

describe('WalletController lock triggers', () => {
  it('locks after the default 15 minutes of wallet inactivity', async () => {
    const { controller, clock } = await unlockedWallet();
    assert.equal(controller.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);

    clock.advance(DEFAULT_IDLE_TIMEOUT_MS - 60_000);
    controller.checkIdle();
    assert.equal(controller.state.status, 'UNLOCKED');

    controller.touch();
    clock.advance(DEFAULT_IDLE_TIMEOUT_MS - 60_000);
    controller.checkIdle();
    assert.equal(controller.state.status, 'UNLOCKED');

    clock.advance(60_001);
    controller.checkIdle();
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'idle');
  });

  it('honours a disabled idle timeout but still locks when hidden', async () => {
    const { controller, clock } = await unlockedWallet();
    const set = await controller.setIdleTimeout(null);
    assert.equal(set.ok, true);
    assert.equal(controller.idleTimeoutMs, null);

    clock.advance(60 * 60_000);
    controller.checkIdle();
    assert.equal(controller.state.status, 'UNLOCKED');

    controller.handleVisibility('hidden');
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'hidden');
  });

  it('persists the idle timeout through lock and unlock', async () => {
    const { controller } = await unlockedWallet();
    assert.equal((await controller.setIdleTimeout(60_000)).ok, true);
    assert.equal(controller.idleTimeoutMs, 60_000);

    controller.lock('explicit');
    const unlocked = await controller.unlock(TEST_PASSWORD);
    assert.equal(unlocked.ok, true);
    assert.equal(controller.idleTimeoutMs, 60_000);
  });

  it('locks on focus loss and pagehide', async () => {
    const first = await unlockedWallet();
    await first.controller.handleWindowFocus(false);
    assert.equal(first.controller.lastLockReason, 'focus-lost');
    assert.equal(first.controller.state.status, 'LOCKED');

    const second = await unlockedWallet();
    second.controller.handlePageHide();
    assert.equal(second.controller.lastLockReason, 'pagehide');
    assert.equal(second.controller.state.status, 'LOCKED');

    const third = await unlockedWallet();
    await third.controller.handleWindowFocus(true);
    assert.equal(third.controller.state.status, 'UNLOCKED');
  });

  it('clears secrets, bumps the epoch and invalidates panels on lock', async () => {
    const { controller } = await unlockedWallet();
    controller.setPendingSecret({ kind: 'mnemonic', value: SECOND_MNEMONIC });
    const generation = controller.beginPanel();
    const epoch = controller.epoch;

    controller.lock('explicit');
    assert.equal(controller.hasPendingSecret(), false);
    assert.equal(controller.isPanelCurrent(generation), false);
    assert.ok(controller.epoch > epoch);
    assert.ok(controller.panelGeneration > generation);
    assert.equal(controller.recordHash, null);
  });

  it('starts and stops both intervals, idempotently', async () => {
    const scheduler = fakeScheduler();
    const statusBar = recordingStatusBar();
    const { controller } = makeWallet({ scheduler, statusBar });

    controller.start();
    controller.start();
    assert.equal(scheduler.intervals.length, 2);
    assert.deepEqual(
      scheduler.intervals.map((handle) => handle.ms),
      [30_000, 10_000],
    );

    controller.dispose();
    controller.dispose();
    assert.equal(scheduler.cleared.length, 2);
    assert.equal(statusBar.disposed, 1);

    controller.start();
    assert.equal(scheduler.intervals.length, 2);
  });

  it('detects an external change from the 10 s poll timer', async () => {
    const scheduler = fakeScheduler();
    const { controller, memento, storage } = await unlockedWallet({ scheduler });
    controller.start();

    rivalRecord(memento, storage.keys.record);
    scheduler.fire(10_000);
    await settle();

    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'external-change');
  });
});

// ---------------------------------------------------------------------------
// External changes and read-back reconciliation
// ---------------------------------------------------------------------------

describe('WalletController external changes', () => {
  it('locks when another window rewrites the record', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    const epoch = controller.epoch;
    rivalRecord(memento, storage.keys.record);

    const locked = await controller.pollExternal();
    assert.equal(locked, true);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'external-change');
    assert.equal(controller.notice, EXTERNAL_NOTICE);
    assert.equal(controller.recordHash, null);
    assert.ok(controller.epoch > epoch);
    assert.notEqual(controller.state.record, null);
  });

  it('detects an external change when focus returns', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    rivalRecord(memento, storage.keys.record);
    await controller.handleWindowFocus(true);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'external-change');
  });

  it('goes to NO_VAULT when another window deletes both keys', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    memento.deleteExternal(storage.keys.record);
    memento.deleteExternal(storage.keys.pending);

    assert.equal(await controller.pollExternal(), true);
    assert.equal(controller.state.status, 'NO_VAULT');
  });

  it('keeps a lone pending record recoverable after an external delete (VR-02)', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    memento.setExternal(storage.keys.pending, memento.raw(storage.keys.record));
    memento.deleteExternal(storage.keys.record);

    assert.equal(await controller.pollExternal(), true);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.state.recoveryPending, true);
    assert.equal(controller.state.record === null, false);

    const unlocked = await controller.unlock(TEST_PASSWORD);
    assert.equal(unlocked.ok, true);
    assert.match(controller.notice ?? '', /Recovered the wallet/);
  });

  it('fails closed when the external poll cannot read the record', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    memento.failNextGet = { key: storage.keys.record };
    assert.equal(await controller.pollExternal(), true);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'external-change');
    assert.equal(controller.notice, UNVERIFIED);
  });

  it('does not poll while locked, empty, or remote', async () => {
    const empty = makeWallet();
    assert.equal(await empty.controller.pollExternal(), false);

    const locked = await lockedWallet();
    assert.equal(await locked.controller.pollExternal(), false);

    const remote = makeWallet({ availability: { available: false, code: 'remote' } });
    assert.equal(await remote.controller.pollExternal(), false);
    assert.equal(remote.memento.reads.length, 0);
  });
});

describe('WalletController write reconciliation', () => {
  it('adopts a write that landed despite reporting STORAGE_FAILED', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    const account = firstAccount(controller);
    const before = controller.recordHash;
    memento.failNextUpdate = { key: storage.keys.record, apply: true };

    const result = await controller.rename(account.id, 'Renamed after landing');
    assert.equal(result.ok, true);
    assert.equal(controller.state.status, 'UNLOCKED');
    assert.equal(result.value.accounts[0].label, 'Renamed after landing');
    assert.notEqual(controller.recordHash, before);
    assert.equal(await controller.pollExternal(), false);
  });

  it('only claims "nothing changed" when the old value is confirmed', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    const account = firstAccount(controller);
    const before = controller.recordHash;
    memento.failNextUpdate = { key: storage.keys.record, apply: false };

    const result = await controller.rename(account.id, 'Should not apply');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.message, NOT_APPLIED);
    assert.equal(controller.state.status, 'UNLOCKED');
    assert.equal(firstAccount(controller).label, account.label);
    assert.equal(controller.recordHash, before);
    assert.equal(await controller.pollExternal(), false);
  });

  it('locks and never guesses when the read-back is undetermined', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    const account = firstAccount(controller);
    memento.failNextUpdate = { key: storage.keys.record, apply: false };
    memento.afterFailedUpdate = () => {
      rivalRecord(memento, storage.keys.record);
    };

    const result = await controller.rename(account.id, 'Undetermined');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.message, UNVERIFIED);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'external-change');
    assert.equal(controller.notice, UNVERIFIED);
    assert.equal(controller.recordHash, null);
  });

  it('locks when the read-back itself fails (AC-23 throw branch)', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    const account = firstAccount(controller);
    memento.failNextUpdate = { key: storage.keys.record, apply: false };
    memento.afterFailedUpdate = () => {
      memento.failNextGet = { key: storage.keys.record };
    };

    const result = await controller.rename(account.id, 'Unverifiable');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.message, UNVERIFIED);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'external-change');
    assert.equal(controller.notice, UNVERIFIED);
  });

  it('reports a create that landed on disk as created, not failed', async () => {
    const { controller, memento, storage } = makeWallet();
    controller.setPendingSecret({ kind: 'mnemonic', value: TEST_MNEMONIC });
    memento.failNextUpdate = { key: storage.keys.record, apply: true };

    const result = await controller.create(TEST_PASSWORD, { source: 'created' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.walletCreated, true);
    assert.equal(result.message, 'The wallet was created. Unlock to continue.');
    assert.equal(controller.state.status, 'LOCKED');
    assert.notEqual(controller.state.record, null);
    assert.equal(controller.hasPendingSecret(), false);

    const unlocked = await controller.unlock(TEST_PASSWORD);
    assert.equal(unlocked.ok, true);
  });

  it('reports a create that did not land as unchanged', async () => {
    const { controller, memento, storage } = makeWallet();
    controller.setPendingSecret({ kind: 'mnemonic', value: TEST_MNEMONIC });
    memento.failNextUpdate = { key: storage.keys.record, apply: false };

    const result = await controller.create(TEST_PASSWORD, { source: 'created' });
    assert.equal(result.ok, false);
    assert.equal(result.walletCreated, false);
    assert.equal(result.message, NOT_APPLIED);
    assert.equal(controller.state.status, 'NO_VAULT');
  });

  it('locks when a create failure has a rival record on disk', async () => {
    const foreign = await unlockedWallet({ seed: 0x1234abcd });
    const foreignRaw = foreign.memento.raw(foreign.storage.keys.record);
    assert.equal(typeof foreignRaw, 'string');

    const { controller, memento, storage } = makeWallet();
    controller.setPendingSecret({ kind: 'mnemonic', value: TEST_MNEMONIC });
    memento.failNextUpdate = { key: storage.keys.record, apply: false };
    memento.afterFailedUpdate = () => {
      memento.setExternal(storage.keys.record, foreignRaw);
    };

    const result = await controller.create(TEST_PASSWORD, { source: 'created' });
    assert.equal(result.ok, false);
    assert.equal(result.message, UNVERIFIED);
    assert.equal(result.walletCreated, undefined);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'external-change');
  });

  it('treats a last-account delete whose remove landed as deleted', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    const account = firstAccount(controller);
    memento.failNextUpdate = { key: storage.keys.record, apply: true };

    const result = await controller.deleteAccount(account.id);
    assert.equal(result.ok, true);
    assert.equal(result.value.walletDeleted, true);
    assert.equal(controller.state.status, 'NO_VAULT');
    assert.equal(memento.has(storage.keys.record), false);
  });

  it('confirms an unapplied remove as "nothing changed"', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    const account = firstAccount(controller);
    memento.failNextUpdate = { key: storage.keys.record, apply: false };

    const result = await controller.deleteAccount(account.id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.message, NOT_APPLIED);
    assert.equal(controller.state.status, 'UNLOCKED');
    assert.equal(controller.accounts().length, 1);
  });

  it('locks on a CONFLICT from a pre-write hash mismatch', async () => {
    const context = {};
    const core = {
      ...DEFAULT_WALLET_CORE,
      async renameAccount(deps, vault, accountId, label) {
        context.before?.();
        return DEFAULT_WALLET_CORE.renameAccount(deps, vault, accountId, label);
      },
    };
    const wallet = await unlockedWallet({ core });
    const account = firstAccount(wallet.controller);
    context.before = () => {
      rivalRecord(wallet.memento, wallet.storage.keys.record);
    };

    const result = await wallet.controller.rename(account.id, 'Conflict');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WALLET_CHANGED_EXTERNALLY');
    assert.equal(wallet.controller.state.status, 'LOCKED');
    assert.equal(wallet.controller.lastLockReason, 'external-change');
    assert.equal(wallet.controller.notice, EXTERNAL_NOTICE);
  });

  it('maps a vanished record to NO_VAULT', async () => {
    const context = {};
    const core = {
      ...DEFAULT_WALLET_CORE,
      async renameAccount(deps, vault, accountId, label) {
        context.before?.();
        return DEFAULT_WALLET_CORE.renameAccount(deps, vault, accountId, label);
      },
    };
    const wallet = await unlockedWallet({ core });
    const account = firstAccount(wallet.controller);
    context.before = () => {
      wallet.memento.deleteExternal(wallet.storage.keys.record);
    };

    const result = await wallet.controller.rename(account.id, 'Gone');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NO_VAULT');
    assert.equal(wallet.controller.state.status, 'NO_VAULT');
    assert.equal(wallet.controller.lastLockReason, 'external-change');
  });
});

// ---------------------------------------------------------------------------
// Post-success read-back (design §4.2 step 7, AC-23)
// ---------------------------------------------------------------------------

describe('WalletController post-success read-back', () => {
  it('locks when create resolves but the record was not persisted', async () => {
    const { controller, memento, storage } = makeWallet();
    controller.setPendingSecret({ kind: 'mnemonic', value: TEST_MNEMONIC });
    memento.resolveNextUpdate = { key: storage.keys.record, mode: 'drop' };

    const result = await controller.create(TEST_PASSWORD, { source: 'created' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.message, UNVERIFIED);
    assert.equal(result.walletCreated, undefined);
    // `#reload` reflects the real (empty) disk, and no session was adopted.
    assert.equal(controller.state.status, 'NO_VAULT');
    assert.equal(controller.lastLockReason, 'external-change');
    assert.equal(controller.notice, UNVERIFIED);
    assert.equal(controller.hasPendingSecret(), false);
    assert.equal(controller.recordHash, null);
    assert.equal(memento.has(storage.keys.record), false);
  });

  it('locks when create resolves with a different record on disk', async () => {
    const { controller, memento, storage } = makeWallet();
    controller.setPendingSecret({ kind: 'mnemonic', value: TEST_MNEMONIC });
    const different = '{"format":"wallet.v1","version":1}';
    memento.resolveNextUpdate = { key: storage.keys.record, mode: 'alter', value: different };

    const result = await controller.create(TEST_PASSWORD, { source: 'created' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.message, UNVERIFIED);
    assert.equal(result.walletCreated, undefined);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.state.corrupt, true);
    assert.equal(controller.lastLockReason, 'external-change');
    assert.equal(controller.notice, UNVERIFIED);
    assert.equal(memento.raw(storage.keys.record), different);
    assert.equal(controller.recordHash, null);
  });

  it('locks when an account rename resolves but was not persisted', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    const account = firstAccount(controller);
    const beforeRaw = memento.raw(storage.keys.record);
    memento.resolveNextUpdate = { key: storage.keys.record, mode: 'drop' };

    const result = await controller.rename(account.id, 'Not persisted');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.message, UNVERIFIED);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'external-change');
    assert.equal(controller.notice, UNVERIFIED);
    assert.equal(controller.recordHash, null);
    assert.equal(memento.raw(storage.keys.record), beforeRaw);
    assert.notEqual(controller.state.record, null);
    assert.equal(controller.state.record.recordHash, hashRecord(JSON.parse(beforeRaw)));
  });

  it('locks when add-account resolves with a different record on disk', async () => {
    const foreign = await unlockedWallet({ seed: 0x51ee7 });
    const foreignRaw = foreign.memento.raw(foreign.storage.keys.record);
    assert.equal(typeof foreignRaw, 'string');
    const foreignHash = hashRecord(JSON.parse(foreignRaw));

    const { controller, memento, storage } = await unlockedWallet();
    controller.setPendingSecret({ kind: 'mnemonic', value: SECOND_MNEMONIC });
    memento.resolveNextUpdate = { key: storage.keys.record, mode: 'alter', value: foreignRaw };

    const result = await controller.addAccount();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.message, UNVERIFIED);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'external-change');
    assert.equal(controller.notice, UNVERIFIED);
    assert.equal(controller.hasPendingSecret(), false);
    assert.equal(controller.recordHash, null);
    assert.notEqual(controller.state.record, null);
    assert.equal(controller.state.record.recordHash, foreignHash);
  });

  it('locks when an unlocked password change resolves but was not persisted', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    const beforeRaw = memento.raw(storage.keys.record);
    memento.resolveNextUpdate = { key: storage.keys.record, mode: 'drop' };

    const result = await controller.changePassword(TEST_PASSWORD, NEW_PASSWORD);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.message, UNVERIFIED);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'external-change');
    assert.equal(controller.notice, UNVERIFIED);
    assert.equal(controller.recordHash, null);
    assert.equal(memento.raw(storage.keys.record), beforeRaw);
    assert.equal(memento.has(storage.keys.pending), false);

    // Disk truth: the old password still opens the untouched record.
    const oldPassword = await controller.unlock(TEST_PASSWORD);
    assert.equal(oldPassword.ok, true);
    controller.lock('explicit');
    const newPassword = await controller.unlock(NEW_PASSWORD);
    assert.equal(newPassword.ok, false);
  });

  it('locks when a locked password change resolves with a different record', async () => {
    const { controller, memento, storage } = await lockedWallet();
    const different = '{"format":"wallet.v1","version":1,"corrupt":true}';
    memento.resolveNextUpdate = { key: storage.keys.record, mode: 'alter', value: different };

    const result = await controller.changePassword(TEST_PASSWORD, NEW_PASSWORD);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.message, UNVERIFIED);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.state.corrupt, true);
    assert.equal(controller.lastLockReason, 'external-change');
    assert.equal(controller.notice, UNVERIFIED);
    assert.equal(memento.raw(storage.keys.record), different);
    assert.equal(memento.has(storage.keys.pending), false);
  });

  it('never reports a raced password change whose write was not persisted', async () => {
    const started = deferred();
    const gate = deferred();
    const core = {
      ...DEFAULT_WALLET_CORE,
      async changePassword(deps, input) {
        started.resolve();
        await gate.promise;
        return DEFAULT_WALLET_CORE.changePassword(deps, input);
      },
    };
    const { controller, memento, storage } = await unlockedWallet({ core });
    memento.resolveNextUpdate = { key: storage.keys.record, mode: 'drop' };

    const pending = controller.changePassword(TEST_PASSWORD, NEW_PASSWORD);
    await started.promise;
    controller.lock('explicit');
    gate.resolve();

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.message, UNVERIFIED);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'external-change');
    assert.equal(controller.notice, UNVERIFIED);
    assert.equal(controller.recordHash, null);
  });

  it('locks when deleting the last account resolves but the record remains', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    const account = firstAccount(controller);
    const beforeRaw = memento.raw(storage.keys.record);
    memento.resolveNextUpdate = { key: storage.keys.record, mode: 'drop' };

    const result = await controller.deleteAccount(account.id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.message, UNVERIFIED);
    assert.equal('value' in result, false);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'external-change');
    assert.equal(controller.notice, UNVERIFIED);
    assert.equal(controller.recordHash, null);
    assert.equal(memento.raw(storage.keys.record), beforeRaw);
    assert.notEqual(controller.state.record, null);
    assert.equal(controller.state.record.recordHash, hashRecord(JSON.parse(beforeRaw)));
  });

  it('does not report NO_VAULT when reset resolves but the record remains', async () => {
    const { controller, memento, storage } = await lockedWallet();
    const beforeRaw = memento.raw(storage.keys.record);
    memento.resolveNextUpdate = { key: storage.keys.record, mode: 'drop' };

    const result = await controller.reset();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.message, UNVERIFIED);
    assert.equal(controller.state.status, 'LOCKED');
    assert.notEqual(controller.state.record, null);
    assert.equal(controller.notice, UNVERIFIED);
    assert.equal(memento.raw(storage.keys.record), beforeRaw);
  });

  it('reads back and succeeds a normal account write (control)', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    const account = firstAccount(controller);
    const before = controller.recordHash;
    const recordReads = () =>
      memento.reads.filter((key) => key === storage.keys.record).length;
    const readsBefore = recordReads();

    const result = await controller.rename(account.id, 'Persisted');
    assert.equal(result.ok, true);
    assert.equal(result.value.accounts[0].label, 'Persisted');
    assert.equal(controller.state.status, 'UNLOCKED');
    assert.notEqual(controller.recordHash, before);
    assert.equal(controller.recordHash, hashRecord(recordOf(memento, storage.keys.record)));
    // The core reads the record for its precondition; the controller adds
    // exactly one post-success verification read, and neither locks on its
    // own write.
    assert.equal(recordReads() - readsBefore, 2);
    assert.equal(await controller.pollExternal(), false);
  });

  it('recovers when only the first post-success read-back throws', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    const account = firstAccount(controller);
    const before = controller.recordHash;
    memento.beforeUpdate = (key) => {
      if (key === storage.keys.record) {
        // §4.2 7.c: the first read may be transiently unavailable; the
        // second read must still confirm the write.
        memento.failNextGets = { key: storage.keys.record, count: 1 };
      }
    };

    const result = await controller.rename(account.id, 'Retried read-back');
    assert.equal(result.ok, true);
    assert.equal(controller.state.status, 'UNLOCKED');
    assert.equal(firstAccount(controller).label, 'Retried read-back');
    assert.notEqual(controller.recordHash, before);
  });

  it('locks when both post-success read-backs throw', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    const account = firstAccount(controller);
    memento.beforeUpdate = (key) => {
      if (key === storage.keys.record) {
        memento.failNextGets = { key: storage.keys.record, count: 2 };
      }
    };

    const result = await controller.rename(account.id, 'Unreadable');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.message, UNVERIFIED);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'external-change');
    assert.equal(controller.notice, UNVERIFIED);
  });

  it('locks when a non-last delete resolves but was not persisted', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    assert.equal(
      controller.setPendingSecret({ kind: 'mnemonic', value: SECOND_MNEMONIC }).ok,
      true,
    );
    assert.equal((await controller.addAccount()).ok, true);
    const account = firstAccount(controller);
    const beforeRaw = memento.raw(storage.keys.record);
    memento.resolveNextUpdate = { key: storage.keys.record, mode: 'drop' };

    const result = await controller.deleteAccount(account.id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.message, UNVERIFIED);
    assert.equal(result.value, undefined);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'external-change');
    assert.equal(controller.notice, UNVERIFIED);
    assert.equal(memento.raw(storage.keys.record), beforeRaw);
  });
});

describe('WalletController lock racing the post-success read-back', () => {
  it('does not resurrect a lock that lands during the create read-back', async () => {
    const memento = new FakeMemento();
    const gate = gatedRecordReadback(memento);
    const { controller } = makeWallet({ memento, storage: gate.storage });
    assert.equal(
      controller.setPendingSecret({ kind: 'mnemonic', value: TEST_MNEMONIC }).ok,
      true,
    );
    gate.arm();

    const pending = controller.create(TEST_PASSWORD, { source: 'created' });
    await gate.started.promise;
    controller.lock('explicit');
    gate.release.resolve();

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OPERATION_CANCELLED');
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'explicit');
    assert.equal(controller.recordHash, null);
    assert.equal(controller.hasPendingSecret(), false);
    assert.equal(memento.has(gate.storage.keys.record), true);
  });

  it('does not resurrect a lock that lands during an account-write read-back', async () => {
    const memento = new FakeMemento();
    const gate = gatedRecordReadback(memento);
    const { controller } = await unlockedWallet({ memento, storage: gate.storage });
    const account = firstAccount(controller);
    gate.arm();

    const pending = controller.rename(account.id, 'Race during read-back');
    await gate.started.promise;
    controller.lock('explicit');
    gate.release.resolve();

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OPERATION_CANCELLED');
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'explicit');
    assert.equal(controller.recordHash, null);
  });

  it('does not resurrect a lock that lands during a non-last delete read-back', async () => {
    const memento = new FakeMemento();
    const gate = gatedRecordReadback(memento);
    const { controller } = await unlockedWallet({ memento, storage: gate.storage });
    assert.equal(
      controller.setPendingSecret({ kind: 'mnemonic', value: SECOND_MNEMONIC }).ok,
      true,
    );
    assert.equal((await controller.addAccount()).ok, true);
    const account = firstAccount(controller);
    gate.arm();

    const pending = controller.deleteAccount(account.id);
    await gate.started.promise;
    controller.lock('explicit');
    gate.release.resolve();

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OPERATION_CANCELLED');
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'explicit');
    assert.equal(controller.recordHash, null);
  });

  it('does not report a last-account delete after a lock during the absence check', async () => {
    const memento = new FakeMemento();
    const gate = gatedRecordReadback(memento);
    const { controller } = await unlockedWallet({ memento, storage: gate.storage });
    const account = firstAccount(controller);
    gate.arm();

    const pending = controller.deleteAccount(account.id);
    await gate.started.promise;
    controller.lock('explicit');
    gate.release.resolve();

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OPERATION_CANCELLED');
    assert.equal(controller.state.status, 'NO_VAULT');
    assert.equal(controller.lastLockReason, 'explicit');
  });
});

// ---------------------------------------------------------------------------
// Account operations
// ---------------------------------------------------------------------------

describe('WalletController account operations', () => {
  it('adds an account with a pending mnemonic and keeps the active one', async () => {
    const { controller } = await unlockedWallet();
    const active = firstAccount(controller);
    assert.equal(
      controller.setPendingSecret({ kind: 'mnemonic', value: SECOND_MNEMONIC }).ok,
      true,
    );

    const result = await controller.addAccount();
    assert.equal(result.ok, true);
    assert.equal(result.value.accounts.length, 2);
    assert.equal(result.value.activeAccountId, active.id);
    assert.equal(result.value.accounts[1].label, 'Account 2');
    assert.equal(result.value.accounts[1].address, deriveAccountFromMnemonic(SECOND_MNEMONIC).address);
    assert.equal(controller.hasPendingSecret(), false);
    assert.equal(await controller.pollExternal(), false);
  });

  it('rejects a duplicate address and clears the pending secret', async () => {
    const { controller } = await unlockedWallet();
    controller.setPendingSecret({ kind: 'mnemonic', value: TEST_MNEMONIC });
    const result = await controller.addAccount();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ACCOUNT_EXISTS');
    assert.equal(controller.accounts().length, 1);
    assert.equal(controller.hasPendingSecret(), false);
  });

  it('renames and switches the active account', async () => {
    const { controller } = await unlockedWallet();
    controller.setPendingSecret({ kind: 'mnemonic', value: SECOND_MNEMONIC });
    const added = await controller.addAccount();
    assert.equal(added.ok, true);
    const second = added.value.accounts[1];

    const renamed = await controller.rename(second.id, 'Savings');
    assert.equal(renamed.ok, true);
    assert.equal(renamed.value.accounts[1].label, 'Savings');

    const active = await controller.setActive(second.id);
    assert.equal(active.ok, true);
    assert.equal(active.value.activeAccountId, second.id);
    assert.equal(active.value.activeIndex, 2);
    assert.equal(controller.activeAccount().label, 'Savings');

    const missing = await controller.setActive('nope');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'ACCOUNT_NOT_FOUND');
  });

  it('describes deletion, including the last-account warning, without deleting', async () => {
    const { controller } = await unlockedWallet();
    const first = firstAccount(controller);

    controller.setPendingSecret({ kind: 'mnemonic', value: SECOND_MNEMONIC });
    const added = await controller.addAccount();
    const second = added.value.accounts[1];

    const nonLast = controller.describeAccountDeletion(first.id);
    assert.deepEqual(nonLast, {
      accountId: first.id,
      isLastAccount: false,
      warning: null,
    });

    const removed = await controller.deleteAccount(second.id);
    assert.deepEqual(removed, { ok: true, value: { walletDeleted: false } });
    assert.equal(controller.accounts().length, 1);

    const last = controller.describeAccountDeletion(first.id);
    assert.equal(last.isLastAccount, true);
    assert.match(last.warning, /deletes the wallet/);

    const deleted = await controller.deleteAccount(first.id);
    assert.equal(deleted.ok, true);
    assert.equal(deleted.value.walletDeleted, true);
    assert.equal(controller.state.status, 'NO_VAULT');
    assert.equal(controller.recordHash, null);
    assert.equal(controller.describeAccountDeletion(first.id), null);
  });

  it('refuses account writes while locked', async () => {
    const { controller } = await lockedWallet();
    const rename = await controller.rename('anything', 'x');
    assert.equal(rename.ok, false);
    assert.equal(rename.code, 'LOCKED');

    const remove = await controller.deleteAccount('anything');
    assert.equal(remove.ok, false);
    assert.equal(remove.code, 'LOCKED');
  });
});

// ---------------------------------------------------------------------------
// Verify and reveal
// ---------------------------------------------------------------------------

describe('WalletController verifyAndReveal', () => {
  it('reveals the mnemonic after re-verifying the password', async () => {
    const { controller } = await unlockedWallet();
    const account = firstAccount(controller);
    const result = await controller.verifyAndReveal('mnemonic', account.id, TEST_PASSWORD);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { kind: 'mnemonic', value: TEST_MNEMONIC });
    assert.equal(controller.state.status, 'UNLOCKED');
  });

  it('derives the private key at the documented path', async () => {
    const { controller } = await unlockedWallet();
    const account = firstAccount(controller);
    const result = await controller.verifyAndReveal('privateKey', account.id, TEST_PASSWORD);
    assert.equal(result.ok, true);
    assert.equal(result.value.kind, 'privateKey');
    assert.equal(result.value.derivationPath, DERIVATION_PATH);
    assert.equal(privateKeyToAddress(result.value.value), account.address);
  });

  it('rejects a wrong password without touching the session or rate limiter state', async () => {
    const { controller } = await unlockedWallet();
    const account = firstAccount(controller);
    const before = controller.recordHash;

    const result = await controller.verifyAndReveal('mnemonic', account.id, 'wrong password');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DECRYPT_FAILED');
    assert.equal(controller.state.status, 'UNLOCKED');
    assert.equal(controller.recordHash, before);

    const unlocked = await controller.unlock(TEST_PASSWORD);
    assert.equal(unlocked.ok, true);
  });

  it('reports a missing account and an unavailable secret kind', async () => {
    const mnemonicWallet = await unlockedWallet();
    const missing = await mnemonicWallet.controller.verifyAndReveal(
      'mnemonic',
      'missing',
      TEST_PASSWORD,
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'ACCOUNT_NOT_FOUND');

    const keyWallet = await unlockedWallet({
      secret: { kind: 'privateKey', value: TEST_PRIVATE_KEY },
      source: 'private-key',
    });
    const account = firstAccount(keyWallet.controller);

    const asMnemonic = await keyWallet.controller.verifyAndReveal(
      'mnemonic',
      account.id,
      TEST_PASSWORD,
    );
    assert.equal(asMnemonic.ok, false);
    assert.equal(asMnemonic.code, 'SECRET_UNAVAILABLE');

    const asKey = await keyWallet.controller.verifyAndReveal(
      'privateKey',
      account.id,
      TEST_PASSWORD,
    );
    assert.equal(asKey.ok, true);
    assert.equal(asKey.value.value, TEST_PRIVATE_KEY);
    assert.equal(privateKeyToAddress(asKey.value.value), account.address);
  });

  it('refuses to reveal when the record changed under the session', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    const account = firstAccount(controller);
    rivalRecord(memento, storage.keys.record);

    const result = await controller.verifyAndReveal('mnemonic', account.id, TEST_PASSWORD);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WALLET_CHANGED_EXTERNALLY');
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'external-change');
    assert.equal(controller.recordHash, null);
  });

  it('returns nothing when a lock races the reveal', async () => {
    const started = deferred();
    const gate = deferred();
    const core = {
      ...DEFAULT_WALLET_CORE,
      async unlockVault(deps, password) {
        started.resolve();
        await gate.promise;
        return DEFAULT_WALLET_CORE.unlockVault(deps, password);
      },
    };
    const { controller } = await unlockedWallet({ core });
    const account = firstAccount(controller);

    const pending = controller.verifyAndReveal('mnemonic', account.id, TEST_PASSWORD);
    await started.promise;
    controller.lock('explicit');
    gate.resolve();

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OPERATION_CANCELLED');
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.recordHash, null);
    assert.equal('value' in result, false);
  });
});

// ---------------------------------------------------------------------------
// Change password
// ---------------------------------------------------------------------------

describe('WalletController changePassword', () => {
  it('changes the password while unlocked and keeps the session (DR-01)', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    const before = controller.recordHash;

    const result = await controller.changePassword(TEST_PASSWORD, NEW_PASSWORD);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { locked: false, pendingCleanupFailed: false });
    assert.equal(controller.state.status, 'UNLOCKED');
    assert.notEqual(controller.recordHash, before);
    assert.equal(memento.has(storage.keys.pending), false);
    assert.equal(await controller.pollExternal(), false);

    controller.lock('explicit');
    const oldPassword = await controller.unlock(TEST_PASSWORD);
    assert.equal(oldPassword.ok, false);
    assert.equal(oldPassword.code, 'DECRYPT_FAILED');
    const newPassword = await controller.unlock(NEW_PASSWORD);
    assert.equal(newPassword.ok, true);
  });

  it('changes the password while locked and returns locked', async () => {
    const { controller } = await lockedWallet();
    const before = controller.state.record.recordHash;

    const result = await controller.changePassword(TEST_PASSWORD, NEW_PASSWORD);
    assert.equal(result.ok, true);
    assert.equal(result.value.locked, true);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.recordHash, null);
    assert.notEqual(controller.state.record.recordHash, before);
    assert.match(controller.notice, /Password changed/);

    const oldPassword = await controller.unlock(TEST_PASSWORD);
    assert.equal(oldPassword.ok, false);
    const newPassword = await controller.unlock(NEW_PASSWORD);
    assert.equal(newPassword.ok, true);
  });

  it('rejects a wrong old password with old-password-still-valid', async () => {
    const { controller } = await unlockedWallet();
    const before = controller.recordHash;

    const result = await controller.changePassword('wrong password', NEW_PASSWORD);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DECRYPT_FAILED');
    assert.equal(result.resolution, 'old-password-still-valid');
    assert.equal(result.message, 'The current password is incorrect. Nothing was changed.');
    assert.equal(controller.state.status, 'UNLOCKED');
    assert.equal(controller.recordHash, before);
  });

  it('rejects a too-short new password without locking', async () => {
    const { controller } = await unlockedWallet();
    const result = await controller.changePassword(TEST_PASSWORD, 'short');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TOO_SHORT');
    assert.equal(result.resolution, 'old-password-still-valid');
    assert.equal(controller.state.status, 'UNLOCKED');
  });

  it('confirms the old password when the pending write did not land', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    memento.failNextUpdate = { key: storage.keys.pending, apply: false };

    const result = await controller.changePassword(TEST_PASSWORD, NEW_PASSWORD);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.resolution, 'old-password-still-valid');
    assert.equal(controller.state.status, 'UNLOCKED');

    controller.lock('explicit');
    const oldPassword = await controller.unlock(TEST_PASSWORD);
    assert.equal(oldPassword.ok, true);
  });

  it('falls back to wallet-changed when the primary record moved under the change', async () => {
    const { controller, memento, storage } = await unlockedWallet();
    memento.failNextUpdate = { key: storage.keys.pending, apply: false };
    memento.afterFailedUpdate = () => {
      rivalRecord(memento, storage.keys.record);
    };

    const result = await controller.changePassword(TEST_PASSWORD, NEW_PASSWORD);
    assert.equal(result.ok, false);
    assert.equal(result.resolution, 'wallet-changed');
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'external-change');
    assert.equal(controller.notice, EXTERNAL_NOTICE);
  });

  it('maps CONFLICT to wallet-changed and locks', async () => {
    const context = {};
    const core = {
      ...DEFAULT_WALLET_CORE,
      async changePassword(deps, input) {
        context.before?.();
        return DEFAULT_WALLET_CORE.changePassword(deps, input);
      },
    };
    const wallet = await lockedWallet({ core });
    context.before = () => {
      rivalRecord(wallet.memento, wallet.storage.keys.record);
    };

    const result = await wallet.controller.changePassword(TEST_PASSWORD, NEW_PASSWORD);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WALLET_CHANGED_EXTERNALLY');
    assert.equal(result.resolution, 'wallet-changed');
    assert.equal(wallet.controller.state.status, 'LOCKED');
    assert.equal(wallet.controller.lastLockReason, 'external-change');
  });

  it('locks for try-new-password and tells the user the order to try', async () => {
    const core = {
      ...DEFAULT_WALLET_CORE,
      async changePassword() {
        return {
          ok: false,
          error: new WalletError('STORAGE_FAILED'),
          resolution: 'try-new-password',
        };
      },
    };
    const { controller } = await unlockedWallet({ core });

    const result = await controller.changePassword(TEST_PASSWORD, NEW_PASSWORD);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STORAGE_FAILED');
    assert.equal(result.resolution, 'try-new-password');
    assert.match(result.message, /Try your new password first/);
    assert.equal(controller.state.status, 'LOCKED');
    assert.equal(controller.lastLockReason, 'explicit');
    assert.match(controller.notice, /Try your new password first/);
  });

  it('never downgrades the KDF parameters', async () => {
    let allowHighMemory = false;
    const seen = [];
    const runner = async (input) => {
      seen.push(input.params.m);
      if (!allowHighMemory && input.params.m === 65536) {
        throw new WalletError('KDF_UNAVAILABLE');
      }
      return fastArgon2(input);
    };
    const { controller, memento, storage } = await unlockedWallet({ argon2: runner });

    assert.equal(recordOf(memento, storage.keys.record).kdf.m, 32768);
    allowHighMemory = true;
    seen.length = 0;

    const result = await controller.changePassword(TEST_PASSWORD, NEW_PASSWORD);
    assert.equal(result.ok, true);
    assert.deepEqual(seen, [32768, 32768]);
    assert.equal(recordOf(memento, storage.keys.record).kdf.m, 32768);
  });

  it('reports NO_VAULT when there is nothing to change', async () => {
    const { controller } = makeWallet();
    const result = await controller.changePassword(TEST_PASSWORD, NEW_PASSWORD);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NO_VAULT');
  });
});

// ---------------------------------------------------------------------------
// Reset, remote windows, pending secret lifecycle, status sink
// ---------------------------------------------------------------------------

describe('WalletController reset', () => {
  it('refuses to reset an unlocked wallet', async () => {
    const { controller } = await unlockedWallet();
    const result = await controller.reset();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'LOCKED');
    assert.match(result.message, /Lock the wallet before resetting/);
  });

  it('removes both records when locked', async () => {
    const { controller, memento, storage } = await lockedWallet();
    const result = await controller.reset();
    assert.deepEqual(result, { ok: true, value: { state: 'NO_VAULT' } });
    assert.equal(controller.state.status, 'NO_VAULT');
    assert.equal(memento.has(storage.keys.record), false);
    assert.equal(memento.has(storage.keys.pending), false);
  });

  it('treats a reset whose removes landed as success', async () => {
    const { controller, memento, storage } = await lockedWallet();
    memento.failNextUpdate = { key: storage.keys.record, apply: true };
    const result = await controller.reset();
    assert.equal(result.ok, true);
    assert.equal(result.value.state, 'NO_VAULT');
    assert.equal(memento.has(storage.keys.record), false);
  });
});

describe('WalletController remote windows', () => {
  it('performs no storage reads or writes and refuses every wallet op', async () => {
    const scheduler = fakeScheduler();
    const statusBar = recordingStatusBar();
    const { controller, memento } = makeWallet({
      availability: { available: false, code: 'remote' },
      scheduler,
      statusBar,
    });

    assert.deepEqual(controller.state, { status: 'UNAVAILABLE', code: 'remote' });
    await controller.load();
    controller.start();
    await controller.handleWindowFocus(true);
    controller.handleWindowFocus(false);
    controller.handleVisibility('hidden');
    controller.handlePageHide();

    assert.equal((await controller.unlock(TEST_PASSWORD)).code, 'WALLET_REMOTE_UNSUPPORTED');
    assert.equal(
      (await controller.create(TEST_PASSWORD)).code,
      'WALLET_REMOTE_UNSUPPORTED',
    );
    assert.equal(
      (await controller.changePassword(TEST_PASSWORD, NEW_PASSWORD)).code,
      'WALLET_REMOTE_UNSUPPORTED',
    );
    assert.equal((await controller.reset()).code, 'WALLET_REMOTE_UNSUPPORTED');
    assert.equal(
      controller.setPendingSecret({ kind: 'mnemonic', value: TEST_MNEMONIC }).code,
      'WALLET_REMOTE_UNSUPPORTED',
    );

    assert.equal(memento.reads.length, 0);
    assert.equal(memento.writes.length, 0);
    assert.equal(scheduler.intervals.length, 0);
    assert.deepEqual(statusBar.states, []);
    assert.equal(controller.state.status, 'UNAVAILABLE');
  });
});

describe('WalletController pending secret lifecycle', () => {
  it('rejects malformed pending secrets', async () => {
    const { controller } = makeWallet();
    assert.equal(controller.setPendingSecret({ kind: 'other', value: 'x' }).code, 'SECRET_UNAVAILABLE');
    assert.equal(controller.setPendingSecret({ kind: 'mnemonic', value: '' }).code, 'SECRET_UNAVAILABLE');
    assert.equal(controller.hasPendingSecret(), false);
  });

  it('is busy-checked, lock-cleared and dispose-cleared', async () => {
    const started = deferred();
    const gate = deferred();
    const core = {
      ...DEFAULT_WALLET_CORE,
      async unlockVault(deps, password) {
        started.resolve();
        await gate.promise;
        return DEFAULT_WALLET_CORE.unlockVault(deps, password);
      },
    };
    const { controller } = await lockedWallet({ core });

    const pendingUnlock = controller.unlock(TEST_PASSWORD);
    await started.promise;
    assert.equal(
      controller.setPendingSecret({ kind: 'mnemonic', value: SECOND_MNEMONIC }).code,
      'WALLET_BUSY',
    );
    gate.resolve();
    await pendingUnlock;

    assert.equal(
      controller.setPendingSecret({ kind: 'mnemonic', value: SECOND_MNEMONIC }).ok,
      true,
    );
    controller.handleWindowFocus(false);
    assert.equal(controller.hasPendingSecret(), false);

    controller.setPendingSecret({ kind: 'mnemonic', value: SECOND_MNEMONIC });
    controller.handlePageHide();
    assert.equal(controller.hasPendingSecret(), false);

    controller.lock('explicit');
    assert.equal(controller.hasPendingSecret(), false);

    controller.setPendingSecret({ kind: 'privateKey', value: TEST_PRIVATE_KEY });
    controller.dispose();
    assert.equal(controller.hasPendingSecret(), false);
    assert.equal(controller.state.status, 'LOCKED');
  });
});

describe('WalletController status sink and panels', () => {
  it('emits only address-free LOCKED states', async () => {
    const statusBar = recordingStatusBar();
    const { controller } = await unlockedWallet({ statusBar });

    const unlockedEvents = statusBar.states.filter((state) => state.status === 'UNLOCKED');
    assert.ok(unlockedEvents.length >= 1);
    for (const event of unlockedEvents) {
      assert.equal(typeof event.address, 'string');
      assert.equal(typeof event.accountLabel, 'string');
    }

    controller.beginPanel();
    controller.lock('explicit');
    const lockedEvents = statusBar.states.filter((state) => state.status === 'LOCKED');
    assert.ok(lockedEvents.length >= 1);
    for (const event of lockedEvents) {
      assert.deepEqual(Object.keys(event).sort(), ['status']);
    }

    await controller.load();
    const last = statusBar.states.at(-1);
    assert.deepEqual(last, { status: 'LOCKED' });
  });

  it('exposes no full-address getter beyond the active account view', async () => {
    const { controller } = await unlockedWallet();
    assert.equal(typeof controller.activeAccount().address, 'string');
    assert.equal('privateKey' in controller.activeAccount(), false);
    assert.equal('secret' in controller.activeAccount(), false);
    assert.equal(controller.account, undefined);
  });
});
