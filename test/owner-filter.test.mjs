/**
 * Memory-browser owner integration (design §8.8, prd R13/AC-14).
 *
 * The transition rules are pure and tested here; the "no scan" wiring is
 * pinned by reading the two source blocks that implement it, because the
 * webview entry needs a live DOM/VS Code host that `node --test` does not have.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyWalletOwner,
  isWalletOwner,
  parseWalletOwnerMessage,
} from '../src/host/wallet/owner-filter.ts';
import { EMPTY_BOOTSTRAP, parseBootstrap } from '../src/shared/bootstrap.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = readFileSync(path.join(ROOT, 'src/webview/main.ts'), 'utf8');
const PANEL = readFileSync(path.join(ROOT, 'src/host/webview-panel.ts'), 'utf8');

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const OTHER_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const MIXED_CASE = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';

/**
 * Extract the `{...}` body of the first block whose opening brace follows
 * `marker`. Brace counting is enough for these small, brace-free-string blocks.
 */
function extractBlock(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing marker: ${marker}`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `missing block after: ${marker}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unbalanced block after: ${marker}`);
}

// ---------------------------------------------------------------------------
// applyWalletOwner
// ---------------------------------------------------------------------------

test('manual is never touched, including a manually cleared filter', () => {
  assert.deepEqual(applyWalletOwner('', 'manual', ADDRESS), { filter: '', source: 'manual' });
  assert.deepEqual(applyWalletOwner(OTHER_ADDRESS, 'manual', ADDRESS), {
    filter: OTHER_ADDRESS,
    source: 'manual',
  });
  assert.deepEqual(applyWalletOwner(OTHER_ADDRESS, 'manual', null), {
    filter: OTHER_ADDRESS,
    source: 'manual',
  });
});

test('empty is filled from the wallet and becomes wallet-sourced', () => {
  assert.deepEqual(applyWalletOwner('', 'empty', ADDRESS), {
    filter: ADDRESS,
    source: 'wallet',
  });
});

test('empty + null is unchanged', () => {
  assert.deepEqual(applyWalletOwner('', 'empty', null), { filter: '', source: 'empty' });
  assert.deepEqual(applyWalletOwner(OTHER_ADDRESS, 'empty', null), {
    filter: OTHER_ADDRESS,
    source: 'empty',
  });
});

test('a wallet-sourced filter follows the new active address', () => {
  assert.deepEqual(applyWalletOwner(ADDRESS, 'wallet', OTHER_ADDRESS), {
    filter: OTHER_ADDRESS,
    source: 'wallet',
  });
  assert.deepEqual(applyWalletOwner(ADDRESS, 'wallet', ADDRESS), {
    filter: ADDRESS,
    source: 'wallet',
  });
});

test('lock (null) clears a wallet-sourced filter back to empty', () => {
  assert.deepEqual(applyWalletOwner(ADDRESS, 'wallet', null), { filter: '', source: 'empty' });
});

test('wallet -> manual transition: later wallet updates cannot overwrite the user', () => {
  let state = applyWalletOwner('', 'empty', ADDRESS);
  assert.deepEqual(state, { filter: ADDRESS, source: 'wallet' });

  // Unlock switches the active account: the wallet-sourced value follows.
  state = applyWalletOwner(state.filter, state.source, OTHER_ADDRESS);
  assert.deepEqual(state, { filter: OTHER_ADDRESS, source: 'wallet' });

  // The user edits (or clears) the field.
  state = { filter: '', source: 'manual' };
  assert.deepEqual(applyWalletOwner(state.filter, state.source, ADDRESS), {
    filter: '',
    source: 'manual',
  });

  // Locking and unlocking again still never refills a manual value.
  state = applyWalletOwner(state.filter, state.source, null);
  assert.deepEqual(state, { filter: '', source: 'manual' });
  state = applyWalletOwner(state.filter, state.source, ADDRESS);
  assert.deepEqual(state, { filter: '', source: 'manual' });
});

// ---------------------------------------------------------------------------
// Address validation and the walletOwner message
// ---------------------------------------------------------------------------

test('isWalletOwner accepts exactly 0x + 40 hex, any digit case', () => {
  assert.equal(isWalletOwner(ADDRESS), true);
  assert.equal(isWalletOwner(ADDRESS.toUpperCase().replace('0X', '0x')), true);
  assert.equal(isWalletOwner(MIXED_CASE), true);
  for (const bad of [
    null,
    undefined,
    42,
    '',
    '0x',
    ADDRESS.slice(0, -1),
    `${ADDRESS}00`,
    ADDRESS.replace('0x', '0X'),
    ` ${ADDRESS}`,
    `${ADDRESS} `,
    '0xzz34567890abcdef1234567890abcdef12345678',
  ]) {
    assert.equal(isWalletOwner(bad), false, String(bad));
  }
});

test('parseWalletOwnerMessage accepts null and well-formed addresses only', () => {
  assert.deepEqual(parseWalletOwnerMessage({ type: 'walletOwner', owner: null }), {
    type: 'walletOwner',
    owner: null,
  });
  assert.deepEqual(parseWalletOwnerMessage({ type: 'walletOwner', owner: MIXED_CASE }), {
    type: 'walletOwner',
    owner: MIXED_CASE,
  });
});

test('parseWalletOwnerMessage ignores every invalid shape', () => {
  for (const message of [
    null,
    undefined,
    'walletOwner',
    42,
    {},
    { type: 'settings', owner: ADDRESS },
    { type: 'walletOwner' },
    { type: 'walletOwner', owner: undefined },
    { type: 'walletOwner', owner: '' },
    { type: 'walletOwner', owner: '0x' },
    { type: 'walletOwner', owner: ADDRESS.slice(0, -1) },
    { type: 'walletOwner', owner: `${ADDRESS}00` },
    { type: 'walletOwner', owner: 42 },
  ]) {
    assert.equal(parseWalletOwnerMessage(message), null, JSON.stringify(message));
  }
});

test('an invalid walletOwner can neither fill nor clear the filter', () => {
  // The handler ignores a null parse result, so the state stays untouched.
  for (const raw of ['garbage', undefined, `${ADDRESS}00`]) {
    const parsed = parseWalletOwnerMessage({ type: 'walletOwner', owner: raw });
    assert.equal(parsed, null);
  }
});

// ---------------------------------------------------------------------------
// bootstrap parsing
// ---------------------------------------------------------------------------

const BASE_MESSAGE = {
  settings: {},
  issues: [],
  keyPresence: { keyPresent: false, ownerKeyPresent: false },
};

test('parseBootstrap accepts null or 0x + 40 hex and nothing else', () => {
  assert.equal(parseBootstrap(BASE_MESSAGE).walletOwner, null);
  assert.equal(EMPTY_BOOTSTRAP.walletOwner, null);
  assert.equal(parseBootstrap({ ...BASE_MESSAGE, walletOwner: null }).walletOwner, null);
  assert.equal(parseBootstrap({ ...BASE_MESSAGE, walletOwner: ADDRESS }).walletOwner, ADDRESS);
  assert.equal(parseBootstrap({ ...BASE_MESSAGE, walletOwner: MIXED_CASE }).walletOwner, MIXED_CASE);
  for (const bad of [
    '',
    '0x',
    ADDRESS.slice(0, -1),
    `${ADDRESS}00`,
    ADDRESS.replace('0x', '0X'),
    ` ${ADDRESS}`,
    42,
    {},
    [],
    true,
  ]) {
    assert.equal(parseBootstrap({ ...BASE_MESSAGE, walletOwner: bad }).walletOwner, null, String(bad));
  }
});

test('parseBootstrap keeps the existing fields unchanged', () => {
  const parsed = parseBootstrap({
    ...BASE_MESSAGE,
    walletOwner: ADDRESS,
    issues: [{ key: 'longstone.rpcUrl', message: 'bad' }],
    keyPresence: { keyPresent: true, ownerKeyPresent: false },
  });
  assert.equal(parsed.issues.length, 1);
  assert.deepEqual(parsed.keyPresence, { keyPresent: true, ownerKeyPresent: false });
  assert.equal(parsed.walletOwner, ADDRESS);
});

test('a non-object bootstrap still yields the empty payload', () => {
  const parsed = parseBootstrap(42);
  assert.equal(parsed.walletOwner, null);
  assert.deepEqual(parsed.issues, []);
});

// ---------------------------------------------------------------------------
// Wiring: owner updates are display-only
// ---------------------------------------------------------------------------

test('the webview walletOwner handler renders and cannot start a scan', () => {
  const body = extractBlock(MAIN, 'function handleWalletOwnerMessage(');
  // Invalid shapes are ignored before any state write.
  assert.match(body, /if \(message === null\) return;/);
  assert.match(body, /\brender\(\)/);
  for (const forbidden of [
    /\bscan\s*\(/,
    /scanGeneration/,
    /state\.index\s*=/,
    /state\.cache\s*=/,
    /autoScanSuppressed/,
    /vscode\.setState/,
    /postMessage/,
  ]) {
    assert.doesNotMatch(body, forbidden, `${forbidden} in the walletOwner handler`);
  }
  // The message listener routes walletOwner to that handler.
  assert.match(MAIN, /type === 'walletOwner'\) handleWalletOwnerMessage\(data\)/);
});

test('the settings bootstrap also applies walletOwner', () => {
  const body = extractBlock(MAIN, 'function applySettings(');
  assert.match(body, /applyOwner\(next\.walletOwner\)/);
});

test('the no-scan assertion is non-vacuous', () => {
  const synthetic = [
    'function handleWalletOwnerMessage(data) {',
    '  applyOwner(null);',
    '  void scan();',
    '  render();',
    '}',
  ].join('\n');
  const body = extractBlock(synthetic, 'function handleWalletOwnerMessage(');
  assert.match(body, /\bscan\s*\(/);
});

test('user input marks the filter manual before any wallet update', () => {
  const inputHandler = extractBlock(MAIN, "ownerInput.addEventListener('input'");
  assert.match(inputHandler, /state\.ownerSource = 'manual'/);
  assert.match(inputHandler, /state\.ownerFilter = ownerInput\.value/);
  const changeHandler = extractBlock(MAIN, "ownerInput.addEventListener('change'");
  assert.match(changeHandler, /state\.ownerSource = 'manual'/);
});

test('the host setWalletOwner only caches and posts the owner message', () => {
  const body = extractBlock(PANEL, 'setWalletOwner(owner: string | null): void');
  assert.match(body, /isWalletOwner\(owner\)/);
  assert.match(body, /this\.walletOwner = owner/);
  assert.match(body, /\{ type: 'walletOwner', owner \}/);
  // No panel open: cache only, no error, and no render/scan/storage work.
  assert.match(body, /this\.panel !== undefined/);
  assert.doesNotMatch(body, /this\.render\(/);
  assert.doesNotMatch(body, /scan|refresh\(|persist|setState/);
});

test('both host settings messages carry the cached walletOwner', () => {
  const occurrences = PANEL.match(/walletOwner: this\.walletOwner/g) ?? [];
  assert.equal(occurrences.length, 2);
});
