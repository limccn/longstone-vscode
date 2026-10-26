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
// must allow in the host and memory bundles: sendRawTransaction /
// prepareTransactionRequest (already-signed payloads), a noble `privateKey`
// parameter, the "Signing Message" prefix, the LONGSTONE_KEY presence read,
// console output, and the explicit owner-key null marker.
const CLEAN_EXTENSION = [
  'var OWNER_KEY_ENV = "LONGSTONE_OWNER_KEY";',
  'var KEY_ENV = "LONGSTONE_KEY";',
  'function providerEnv() { return { [OWNER_KEY_ENV]: null }; }',
  'function keyPresence(env) { return (env.LONGSTONE_KEY ?? "") !== ""; }',
  'console.log("host log");',
  '',
].join('\n');

const CLEAN_MEMORY = [
  'function sendRawTransaction() {}',
  'function prepareTransactionRequest() {}',
  'function fromPrivateKey(privateKey) {}',
  'var presignMessagePrefix = "Ethereum Signed Message:\\n";',
  'function load(url) { return fetch(url); }',
  '',
].join('\n');

// The secret bundle may not fetch, log, debug, or carry shared-core markers.
const CLEAN_SECRET = [
  'var mode = "create-reveal";',
  'function renderSecret(value) { return String(value); }',
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

async function writeBundles(dir, extension, memory, secret = CLEAN_SECRET) {
  await writeFile(path.join(dir, 'dist', 'extension.cjs'), extension);
  await writeFile(path.join(dir, 'dist', 'webview.js'), memory);
  await writeFile(path.join(dir, 'dist', 'wallet-webview.js'), secret);
}

function runAudit(dir) {
  return spawnSync(process.execPath, [AUDIT, dir], { encoding: 'utf8' });
}

test('clean bundles pass with allowed viem/noble internals and the owner-key null marker', async () => {
  await withTempRoot(async (dir) => {
    await writeBundles(dir, CLEAN_EXTENSION, CLEAN_MEMORY);
    const result = runAudit(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Bundle audit passed/);
  });
});

test('each forbidden entry point fails the audit in the memory bundle', async () => {
  const cases = [
    ['node:child_process', 'require("node:child_process");'],
    ['child_process', 'var cp = require("child_process");'],
    ['npx', 'var command = "npx";'],
    ['window.ethereum', 'var x = window.ethereum;'],
    ['createWalletClient', 'createWalletClient();'],
    ['privateKeyToAccount', 'privateKeyToAccount("0x");'],
    ['signMessage', 'signMessage();'],
    ['signTypedData', 'signTypedData();'],
    ['signTransaction', 'signTransaction();'],
    ['eth_sendTransaction', 'request({ method: "eth_sendTransaction" });'],
    ['eth_signTypedData', 'request({ method: "eth_signTypedData_v4" });'],
    ['eval(', 'eval("x");'],
    ['new Function(', 'new Function("return 1");'],
  ];
  for (const [label, line] of cases) {
    await withTempRoot(async (dir) => {
      await writeBundles(dir, CLEAN_EXTENSION, `${CLEAN_MEMORY}\n${line}\n`);
      const result = runAudit(dir);
      assert.equal(result.status, 1, `${label} should fail the audit`);
      assert.match(result.stderr, /bundle:memory/);
      assert.match(result.stderr, new RegExp(label.replace(/[()]/g, '\\$&')));
    });
  }
});

test('key-material assignments fail while the approved null marker passes', async () => {
  await withTempRoot(async (dir) => {
    await writeBundles(
      dir,
      `${CLEAN_EXTENSION}\nvar LONGSTONE_KEY = "0x${'ab'.repeat(32)}";\n`,
      CLEAN_MEMORY,
    );
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /LONGSTONE_KEY literal/);
    assert.match(result.stderr, /bundle:extension/);
  });

  await withTempRoot(async (dir) => {
    await writeBundles(
      dir,
      `${CLEAN_EXTENSION}\nvar LONGSTONE_OWNER_KEY = "0x${'cd'.repeat(32)}";\n`,
      CLEAN_MEMORY,
    );
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /LONGSTONE_OWNER_KEY literal/);
  });

  await withTempRoot(async (dir) => {
    await writeBundles(
      dir,
      CLEAN_EXTENSION,
      `${CLEAN_MEMORY}\nvar privateKey = "0x${'ef'.repeat(32)}";\n`,
    );
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /privateKey hex literal/);
  });

  await withTempRoot(async (dir) => {
    await writeBundles(
      dir,
      CLEAN_EXTENSION,
      `${CLEAN_MEMORY}\nfromPrivateKey("0x${'12'.repeat(32)}");\n`,
    );
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /key-literal argument/);
  });

  await withTempRoot(async (dir) => {
    await writeBundles(
      dir,
      `${CLEAN_EXTENSION}\nvar PRIVATE_KEY = "0x${'34'.repeat(32)}";\n`,
      CLEAN_MEMORY,
    );
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private-key environment literal/);
  });

  await withTempRoot(async (dir) => {
    await writeBundles(
      dir,
      `${CLEAN_EXTENSION}\nvar private_key = "0x${'56'.repeat(32)}";\n`,
      CLEAN_MEMORY,
    );
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private-key environment literal/);
  });
});

test('derived camelCase key locals are not key material', async () => {
  // The shared wallet core derives `const privateKey = `0x${hex}`` after
  // BIP-32 derivation. It is computed output, not a bundled key literal; the
  // env-literal rule must not flag it (all literal-hex rules still apply).
  await withTempRoot(async (dir) => {
    await writeBundles(
      dir,
      `${CLEAN_EXTENSION}\nconst privateKey = \`0x\${bytesToHex(privateKeyBytes)}\`;\n`,
      CLEAN_MEMORY,
    );
    const result = runAudit(dir);
    assert.equal(result.status, 0, result.stderr);
  });

  // The same name with a literal key is still caught by the hex rules.
  await withTempRoot(async (dir) => {
    await writeBundles(
      dir,
      `${CLEAN_EXTENSION}\nconst privateKey = "0x${'78'.repeat(32)}";\n`,
      CLEAN_MEMORY,
    );
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /privateKey hex literal/);
  });

  // A mnemonic in a camelCase key-named local has no hex form; the env rule no
  // longer sees it after the narrowing, so a word-shape rule must.
  await withTempRoot(async (dir) => {
    await writeBundles(
      dir,
      `${CLEAN_EXTENSION}\nconst privateKey = "${'abandon '.repeat(11)}about";\n`,
      CLEAN_MEMORY,
    );
    const result = runAudit(dir);
    assert.equal(result.status, 1, 'a camelCase key-name mnemonic must fail');
    assert.match(result.stderr, /key-named mnemonic literal/);
  });
});

test('a missing bundle or a missing owner-key removal marker fails', async () => {
  await withTempRoot(async (dir) => {
    await writeBundles(dir, 'var KEY_ENV = "LONGSTONE_KEY";\n', CLEAN_MEMORY);
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /removal marker/);
    assert.match(result.stderr, /bundle:extension/);
  });

  await withTempRoot(async (dir) => {
    // The secret bundle is required too; omitting it names the bundle.
    await writeFile(path.join(dir, 'dist', 'extension.cjs'), CLEAN_EXTENSION);
    await writeFile(path.join(dir, 'dist', 'webview.js'), CLEAN_MEMORY);
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dist\/wallet-webview\.js \(bundle:secret\): missing bundle/);
  });

  await withTempRoot(async (dir) => {
    await writeFile(path.join(dir, 'dist', 'webview.js'), CLEAN_MEMORY);
    await writeFile(path.join(dir, 'dist', 'wallet-webview.js'), CLEAN_SECRET);
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dist\/extension\.cjs \(bundle:extension\): missing bundle/);
  });
});

test('secret-webview bans do not leak into the other bundles', async () => {
  // fetch( is legitimate in the memory browser (chain/gateway reads) ...
  await withTempRoot(async (dir) => {
    await writeBundles(
      dir,
      CLEAN_EXTENSION,
      `${CLEAN_MEMORY}\nfetch("https://sepolia.base.org");\n`,
    );
    const result = runAudit(dir);
    assert.equal(result.status, 0, result.stderr);
  });

  // ... and forbidden in the secret bundle.
  await withTempRoot(async (dir) => {
    await writeBundles(
      dir,
      CLEAN_EXTENSION,
      CLEAN_MEMORY,
      `${CLEAN_SECRET}\nfetch("https://sepolia.base.org");\n`,
    );
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bundle:secret/);
    assert.match(result.stderr, /forbidden fetch\(/);
  });

  // console. is required host logging, never allowed in the secret bundle.
  await withTempRoot(async (dir) => {
    await writeBundles(
      dir,
      CLEAN_EXTENSION,
      CLEAN_MEMORY,
      `${CLEAN_SECRET}\nconsole.log("x");\n`,
    );
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bundle:secret/);
    assert.match(result.stderr, /forbidden console\./);
  });

  // debugger is a secret-bundle-only ban (the host bundle is not scanned for it).
  await withTempRoot(async (dir) => {
    await writeBundles(dir, CLEAN_EXTENSION, CLEAN_MEMORY, `${CLEAN_SECRET}\ndebugger;\n`);
    const result = runAudit(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bundle:secret/);
    assert.match(result.stderr, /forbidden debugger/);
  });
});

test('the shared wallet core and its markers are banned only in the secret bundle', async () => {
  const markers = [
    ['@limccn/longstone-wallet', 'var pkg = "@limccn/longstone-wallet";'],
    ['argon2id', 'var kdf = "argon2id";'],
    ['longstone/wallet.v1', 'var domain = "longstone/wallet.v1";'],
  ];
  for (const [, line] of markers) {
    await withTempRoot(async (dir) => {
      await writeBundles(dir, CLEAN_EXTENSION, CLEAN_MEMORY, `${CLEAN_SECRET}\n${line}\n`);
      const result = runAudit(dir);
      assert.equal(result.status, 1, `${line} should fail in the secret bundle`);
      assert.match(result.stderr, /bundle:secret/);
    });

    // The host bundle is where the core is allowed to run.
    await withTempRoot(async (dir) => {
      await writeBundles(dir, `${CLEAN_EXTENSION}\n${line}\n`, CLEAN_MEMORY);
      const result = runAudit(dir);
      assert.equal(result.status, 0, result.stderr);
    });
  }
});
