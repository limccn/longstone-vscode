import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT = path.join(ROOT, 'scripts', 'audit-bundle.mjs');

// Minimal clean bundles. They deliberately contain the internals the audit
// must allow: sendRawTransaction / prepareTransactionRequest (already-signed
// payloads), a noble `privateKey` parameter, the "Signing Message" prefix,
// the LONGSTONE_KEY presence read, and the explicit owner-key null marker.
const CLEAN_EXTENSION = [
  'var OWNER_KEY_ENV = "LONGSTONE_OWNER_KEY";',
  'var KEY_ENV = "LONGSTONE_KEY";',
  'function providerEnv() { return { [OWNER_KEY_ENV]: null }; }',
  'function keyPresence(env) { return (env.LONGSTONE_KEY ?? "") !== ""; }',
  '',
].join('\n');

const CLEAN_WEBVIEW = [
  'function sendRawTransaction() {}',
  'function prepareTransactionRequest() {}',
  'function fromPrivateKey(privateKey) {}',
  'var presignMessagePrefix = "Ethereum Signed Message:\\n";',
  '',
].join('\n');

async function withTempRoot(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'longstone-audit-'));
  try {
    await mkdir(path.join(dir, 'dist'), { recursive: true });
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeBundles(dir, extension, webview) {
  await writeFile(path.join(dir, 'dist', 'extension.cjs'), extension);
  await writeFile(path.join(dir, 'dist', 'webview.js'), webview);
}

function runAudit(dir) {
  return spawnSync(process.execPath, [AUDIT, dir], { encoding: 'utf8' });
}

test('clean bundles pass with allowed viem/noble internals and the owner-key null marker', async () => {
  await withTempRoot(async (dir) => {
    await writeBundles(dir, CLEAN_EXTENSION, CLEAN_WEBVIEW);
    const result = runAudit(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Bundle audit passed/);
  });
});

test('each forbidden entry point fails the audit', async () => {
  const cases = [
    ['window.ethereum', 'var x = window.ethereum;'],
    ['createWalletClient', 'createWalletClient();'],
    ['privateKeyToAccount', 'privateKeyToAccount("0x");'],
    ['signMessage', 'signMessage();'],
    ['signTypedData', 'signTypedData();'],
    ['signTransaction', 'signTransaction();'],
    ['eval(', 'eval("x");'],
    ['new Function(', 'new Function("return 1");'],
  ];
  for (const [label, line] of cases) {
    await withTempRoot(async (dir) => {
      await writeBundles(dir, CLEAN_EXTENSION, `${CLEAN_WEBVIEW}\n${line}\n`);
      const result = runAudit(dir);
      assert.equal(result.status, 1, `${label} should fail the audit`);
      assert.match(result.stderr, new RegExp(label.replace(/[()]/g, '\\$&')));
    });
  }
});

test('key-material assignments fail while the approved null marker passes', async () => {
  await withTempRoot(async (dir) => {
    await writeBundles(
      dir,
      `${CLEAN_EXTENSION}\nvar LONGSTONE_KEY = "0x${'ab'.repeat(32)}";\n`,
      CLEAN_WEBVIEW,
    );
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /LONGSTONE_KEY literal/);
  });

  await withTempRoot(async (dir) => {
    await writeBundles(
      dir,
      `${CLEAN_EXTENSION}\nvar LONGSTONE_OWNER_KEY = "0x${'cd'.repeat(32)}";\n`,
      CLEAN_WEBVIEW,
    );
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /LONGSTONE_OWNER_KEY literal/);
  });

  await withTempRoot(async (dir) => {
    await writeBundles(
      dir,
      CLEAN_EXTENSION,
      `${CLEAN_WEBVIEW}\nvar privateKey = "0x${'ef'.repeat(32)}";\n`,
    );
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /privateKey hex literal/);
  });

  await withTempRoot(async (dir) => {
    await writeBundles(
      dir,
      CLEAN_EXTENSION,
      `${CLEAN_WEBVIEW}\nfromPrivateKey("0x${'12'.repeat(32)}");\n`,
    );
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /key-literal argument/);
  });

  await withTempRoot(async (dir) => {
    await writeBundles(
      dir,
      `${CLEAN_EXTENSION}\nvar PRIVATE_KEY = "0x${'34'.repeat(32)}";\n`,
      CLEAN_WEBVIEW,
    );
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private-key environment literal/);
  });
});

test('a missing bundle or a missing owner-key removal marker fails', async () => {
  await withTempRoot(async (dir) => {
    await writeBundles(dir, 'var KEY_ENV = "LONGSTONE_KEY";\n', CLEAN_WEBVIEW);
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /removal marker/);
  });

  await withTempRoot(async (dir) => {
    await writeFile(path.join(dir, 'dist', 'webview.js'), CLEAN_WEBVIEW);
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing bundle/);
  });
});
