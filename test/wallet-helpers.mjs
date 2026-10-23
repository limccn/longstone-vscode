/**
 * Shared fakes for the VS Code wallet controller tests: no `vscode`, no timers
 * on the real clock, no disk.
 *
 * `MementoStorage` converts record objects to JSON strings; `FakeMemento`
 * therefore stores strings only, exactly like `context.globalState`.
 */
import { WalletController, DEFAULT_WALLET_CORE } from '../src/host/wallet/controller.ts';
import { MementoStorage } from '../src/host/wallet/global-state.ts';

export const TEST_PASSWORD = 'correct horse battery staple';
export const NEW_PASSWORD = 'a completely different passphrase';

/** Public BIP-39 test phrases (valid checksums). */
export const TEST_MNEMONIC =
  'test test test test test test test test test test test junk';
export const SECOND_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** A valid secp256k1 scalar (Hardhat account #1). */
export const TEST_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const encoder = new TextEncoder();

/** Deterministic, cheap KDF; only its determinism matters to these tests. */
export async function fastArgon2({ password, salt, params }) {
  const tag = encoder.encode(`test-kdf:${String(params.m)}/${String(params.t)}/${String(params.p)}:`);
  const input = new Uint8Array(tag.length + password.length + salt.length);
  input.set(tag, 0);
  input.set(password, tag.length);
  input.set(salt, tag.length + password.length);
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
}

/** Deterministic bytes (xorshift32), same stream as the core's test helper. */
export function counterRng(seed = 0x9e3779b9) {
  let state = seed >>> 0;
  return (length) => {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state ^= (state << 13) >>> 0;
      state ^= state >>> 17;
      state ^= (state << 5) >>> 0;
      state >>>= 0;
      out[index] = state & 0xff;
    }
    return out;
  };
}

export class FakeMemento {
  data = new Map();
  reads = [];
  writes = [];
  /** `{ key, apply }`: next `update(key, ...)` rejects, optionally applying first. */
  failNextUpdate = null;
  /**
   * `{ key, mode: 'drop' } | { key, mode: 'alter', value }`: next
   * `update(key, ...)` resolves successfully but the store keeps the old
   * value (or a different one). Models a `set`/`remove` that resolves without
   * persisting, which only a post-write read-back can detect (design §4.2
   * step 7).
   */
  resolveNextUpdate = null;
  /** `{ key }`: next `get(key)` throws (a read failure, not corruption). */
  failNextGet = null;
  /**
   * `{ key, count }`: the next `count` `get(key)` calls throw. Models a read
   * failure that survives the controller's retry-once read-back check.
   */
  failNextGets = null;
  /** Runs after an injected update failure, before the rejection is returned. */
  afterFailedUpdate = null;
  /** Runs before a successful update is applied. */
  beforeUpdate = null;

  get(key) {
    this.reads.push(key);
    const repeated = this.failNextGets;
    if (repeated !== null && repeated.key === key) {
      repeated.count -= 1;
      if (repeated.count <= 0) this.failNextGets = null;
      throw new Error('simulated read failure');
    }
    const failure = this.failNextGet;
    if (failure !== null && failure.key === key) {
      this.failNextGet = null;
      throw new Error('simulated read failure');
    }
    return this.data.get(key);
  }

  update(key, value) {
    this.writes.push({ key, value });
    const resolved = this.resolveNextUpdate;
    if (resolved !== null && resolved.key === key) {
      this.resolveNextUpdate = null;
      if (resolved.mode === 'alter') this.data.set(key, resolved.value);
      return Promise.resolve();
    }
    if (value === undefined) {
      const failure = this.failNextUpdate;
      if (failure !== null && failure.key === key) {
        this.failNextUpdate = null;
        if (failure.apply) this.data.delete(key);
        this.afterFailedUpdate?.(key);
        return Promise.reject(new Error('simulated remove failure'));
      }
      this.data.delete(key);
      return Promise.resolve();
    }

    const failure = this.failNextUpdate;
    if (failure !== null && failure.key === key) {
      this.failNextUpdate = null;
      if (failure.apply) this.data.set(key, value);
      this.afterFailedUpdate?.(key);
      return Promise.reject(new Error('simulated write failure'));
    }

    this.beforeUpdate?.(key, value);
    this.data.set(key, value);
    return Promise.resolve();
  }

  raw(key) {
    return this.data.get(key);
  }

  has(key) {
    return this.data.has(key);
  }

  setExternal(key, value) {
    this.data.set(key, value);
  }

  deleteExternal(key) {
    this.data.delete(key);
  }
}

/** Rewrites the stored record with a bumped `updatedAt` (a valid rival record). */
export function rivalRecord(memento, key) {
  const raw = memento.raw(key);
  if (typeof raw !== 'string') throw new Error('no stored record to rewrite');
  const record = JSON.parse(raw);
  record.updatedAt = (record.updatedAt ?? 0) + 1;
  const next = JSON.stringify(record);
  memento.setExternal(key, next);
  return next;
}

export function fakeClock(start = 1_750_000_000_000) {
  let time = start;
  return {
    now: () => time,
    advance(ms) {
      time += ms;
    },
    set(value) {
      time = value;
    },
  };
}

export function fakeScheduler() {
  const intervals = [];
  const cleared = [];
  return {
    intervals,
    cleared,
    setInterval(callback, ms) {
      const handle = { callback, ms };
      intervals.push(handle);
      return handle;
    },
    clearInterval(handle) {
      cleared.push(handle);
    },
    fire(ms) {
      for (const handle of intervals) {
        if (handle.ms === ms) handle.callback();
      }
    },
  };
}

export function recordingStatusBar() {
  const states = [];
  let disposed = 0;
  return {
    states,
    get disposed() {
      return disposed;
    },
    update(state) {
      states.push(state);
    },
    dispose() {
      disposed += 1;
    },
  };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets queued microtasks and one macrotask run (poll timers are fire-and-forget). */
export async function settle() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

export function makeWallet(options = {}) {
  const memento = options.memento ?? new FakeMemento();
  const clock = options.clock ?? fakeClock();
  const storage = options.storage ?? new MementoStorage(memento);
  const controller = new WalletController({
    storage,
    availability: options.availability ?? { available: true },
    now: clock.now,
    rng: counterRng(options.seed ?? 0x9e3779b9),
    argon2: options.argon2 ?? fastArgon2,
    core: options.core ?? DEFAULT_WALLET_CORE,
    ...(options.statusBar === undefined ? {} : { statusBar: options.statusBar }),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.idleCheckMs === undefined ? {} : { idleCheckMs: options.idleCheckMs }),
  });
  return { controller, memento, storage, clock };
}

/** Creates a wallet with TEST_MNEMONIC and leaves it unlocked. */
export async function unlockedWallet(options = {}) {
  const context = makeWallet(options);
  const secret = options.secret ?? { kind: 'mnemonic', value: TEST_MNEMONIC };
  const source =
    options.source ?? (secret.kind === 'mnemonic' ? 'created' : 'private-key');
  const pending = context.controller.setPendingSecret(secret);
  if (!pending.ok) throw new Error(`pending secret rejected: ${pending.code}`);
  const created = await context.controller.create(TEST_PASSWORD, { source });
  if (!created.ok) throw new Error(`create failed: ${created.code}`);
  return { ...context, created };
}

/** Creates a wallet and locks it. */
export async function lockedWallet(options = {}) {
  const context = await unlockedWallet(options);
  context.controller.lock('explicit');
  return context;
}
