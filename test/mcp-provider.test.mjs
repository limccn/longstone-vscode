import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildServerDefinition,
  keyPresence,
  providerEnv,
  resolveCliCommand,
} from '../src/host/mcp-provider.ts';
import {
  LONGSTONE_CLI_VERSION,
  OWNER_KEY_ENV,
  READ_ONLY_ENV,
} from '../src/shared/constants.ts';

const READ_ONLY_INPUT = { allowWriteTools: false, cliPath: 'longstone' };

test('read-only is the default provider mode (PS-2)', () => {
  assert.deepEqual(providerEnv(READ_ONLY_INPUT), {
    [READ_ONLY_ENV]: '1',
    [OWNER_KEY_ENV]: null,
  });
});

test('write mode sets the variable to 0, never leaves it unset', () => {
  // Longstone treats unset as writable, but inheriting an ambient value is
  // exactly what the setting must override. '0' is explicit both ways.
  assert.deepEqual(providerEnv({ allowWriteTools: true, cliPath: 'longstone' }), {
    [READ_ONLY_ENV]: '0',
    [OWNER_KEY_ENV]: null,
  });
});

test('the provider env carries no key value and removes the owner key', () => {
  const env = providerEnv({ allowWriteTools: true, cliPath: 'longstone' });
  // VS Code merges env over the extension-host environment, so `null` is the
  // only way to remove an ambient LONGSTONE_OWNER_KEY without reading it.
  assert.equal(Object.hasOwn(env, 'LONGSTONE_KEY'), false);
  assert.equal(env[OWNER_KEY_ENV], null);
  for (const value of Object.values(env)) {
    assert.ok(value === '0' || value === '1' || value === null, String(value));
  }
});

test('the server definition launches the installed CLI with serve', () => {
  const definition = buildServerDefinition(READ_ONLY_INPUT);
  assert.equal(definition.command, 'longstone');
  assert.deepEqual(definition.args, ['serve']);
  assert.equal(definition.env[READ_ONLY_ENV], '1');
  assert.equal(definition.env[OWNER_KEY_ENV], null);
  assert.equal(definition.version, `${LONGSTONE_CLI_VERSION}+read-only`);
});

test('a configured cliPath becomes the command', () => {
  const cliPath = 'C:\\tools\\longstone\\longstone.cmd';
  const definition = buildServerDefinition({ allowWriteTools: true, cliPath });
  assert.equal(definition.command, cliPath);
  assert.deepEqual(definition.args, ['serve']);
  assert.equal(definition.env[READ_ONLY_ENV], '0');
  assert.equal(definition.version, `${LONGSTONE_CLI_VERSION}+write-on`);
});

test('the definition carries no runtime download command', () => {
  for (const allowWriteTools of [false, true]) {
    const serialized = JSON.stringify(buildServerDefinition({ allowWriteTools, cliPath: 'longstone' }));
    assert.doesNotMatch(serialized, /\bnpx\b/);
    assert.equal(serialized.includes('"-y"'), false);
  }
});

test('the version string changes with the tool surface', () => {
  const readOnly = buildServerDefinition({ allowWriteTools: false, cliPath: 'longstone' }).version;
  const writable = buildServerDefinition({ allowWriteTools: true, cliPath: 'longstone' }).version;
  assert.notEqual(readOnly, writable);
});

test('key presence is a boolean and never the value', () => {
  const secret = `0x${'cd'.repeat(32)}`;
  const presence = keyPresence({ LONGSTONE_KEY: secret });
  assert.deepEqual(presence, { keyPresent: true, ownerKeyPresent: false });
  assert.doesNotMatch(JSON.stringify(presence), /0xcd/);

  assert.deepEqual(keyPresence({}), { keyPresent: false, ownerKeyPresent: false });
  assert.deepEqual(keyPresence({ LONGSTONE_KEY: '' }), { keyPresent: false, ownerKeyPresent: false });
  assert.deepEqual(keyPresence({ LONGSTONE_OWNER_KEY: secret }), {
    keyPresent: false,
    ownerKeyPresent: true,
  });
});

test('the key value never enters a server definition', () => {
  const secret = `0x${'ef'.repeat(32)}`;
  process.env.LONGSTONE_KEY = secret;
  try {
    const serialized = JSON.stringify(buildServerDefinition(READ_ONLY_INPUT));
    assert.doesNotMatch(serialized, /0xef/);
    assert.doesNotMatch(serialized, /LONGSTONE_KEY/);
    // The owner-key name is present only as an explicit removal marker.
    assert.match(serialized, /"LONGSTONE_OWNER_KEY":null/);
  } finally {
    delete process.env.LONGSTONE_KEY;
  }
});

// ---------------------------------------------------------------------------
// Filesystem-only CLI lookup (design §3.4). No process is spawned and no
// version command runs: the fake `exists` is the only side channel.
// ---------------------------------------------------------------------------

test('resolveCliCommand accepts an existing absolute path', () => {
  const command = '/opt/longstone/bin/longstone';
  let calls = 0;
  const result = resolveCliCommand({
    command,
    platform: 'linux',
    env: {},
    exists: (candidate) => {
      calls += 1;
      return candidate === command;
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 1);
});

test('resolveCliCommand finds a bare command on PATH and skips empty entries', () => {
  const seen = [];
  const result = resolveCliCommand({
    command: 'longstone',
    platform: 'linux',
    env: { PATH: '/usr/local/bin::/opt/bin' },
    exists: (candidate) => {
      seen.push(candidate);
      return candidate === '/opt/bin/longstone';
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen, ['/usr/local/bin/longstone', '/opt/bin/longstone']);
});

test('resolveCliCommand falls back to env.Path when PATH is absent', () => {
  assert.deepEqual(
    resolveCliCommand({
      command: 'longstone',
      platform: 'linux',
      env: { Path: '/opt/bin' },
      exists: (candidate) => candidate === '/opt/bin/longstone',
    }),
    { ok: true },
  );
});

test('a relative command containing a separator is checked directly', () => {
  assert.deepEqual(
    resolveCliCommand({
      command: './bin/longstone',
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      exists: (candidate) => candidate === './bin/longstone',
    }),
    { ok: true },
  );
});

test('Windows PATHEXT variants are checked for a bare command', () => {
  const seen = [];
  const result = resolveCliCommand({
    command: 'longstone',
    platform: 'win32',
    env: { PATH: 'C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    exists: (candidate) => {
      seen.push(candidate);
      // Windows filesystems are case-insensitive: .CMD matches longstone.cmd.
      return candidate.toLowerCase() === 'c:\\tools\\longstone.cmd';
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.ok(seen.some((candidate) => candidate.toLowerCase() === 'c:\\tools\\longstone.cmd'));
});

test('a Windows path without an extension tries PATHEXT variants', () => {
  const seen = [];
  const result = resolveCliCommand({
    command: 'C:\\tools\\longstone',
    platform: 'win32',
    env: { PATHEXT: '.CMD' },
    exists: (candidate) => {
      seen.push(candidate);
      return candidate.toLowerCase() === 'c:\\tools\\longstone.cmd';
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen, ['C:\\tools\\longstone', 'C:\\tools\\longstone.CMD']);
});

test('Windows quoted PATH entries are stripped before lookup', () => {
  // Windows writes/accepts quoted PATH entries when a directory contains
  // spaces. The quotes are separators, not part of the directory: keeping them
  // would report the CLI as missing even though it is installed.
  const seen = [];
  const result = resolveCliCommand({
    command: 'longstone',
    platform: 'win32',
    env: {
      PATH: 'C:\\Windows; "C:\\Users\\John Smith\\AppData\\Roaming\\npm"',
      PATHEXT: '.CMD',
    },
    exists: (candidate) => {
      seen.push(candidate);
      return (
        candidate.toLowerCase() ===
        'c:\\users\\john smith\\appdata\\roaming\\npm\\longstone.cmd'
      );
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.ok(
    seen.includes('C:\\Users\\John Smith\\AppData\\Roaming\\npm\\longstone.CMD'),
    'quotes must not survive into the candidate path',
  );
});

test('a missing CLI names the global install and the cliPath setting', () => {
  const result = resolveCliCommand({
    command: 'longstone',
    platform: 'linux',
    env: { PATH: '/usr/bin:/bin' },
    exists: () => false,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /npm install -g @limccn\/longstone@0\.1\.1/);
  assert.match(result.message, /longstone\.cliPath/);
});

test('an empty command fails before consulting the filesystem', () => {
  let calls = 0;
  const result = resolveCliCommand({
    command: '   ',
    platform: 'win32',
    env: { PATH: 'C:\\tools' },
    exists: () => {
      calls += 1;
      return true;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.match(result.message, /npm install -g @limccn\/longstone@0\.1\.1/);
});

// ---------------------------------------------------------------------------
// MCP/wallet boundary invariants (design §9, prd R12/AC-10).
//
// The wallet must never become an MCP key channel. These tests pin the provider
// env exactly and scan the sources for the ways a key could leak across the
// boundary. The provider module itself is not modified.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Remove comments before scanning. The invariant is about real API/token use;
 * prose that says "SecretStorage is never used" must not count as a use.
 * URLs inside strings are truncated by the `//` rule, which is harmless here:
 * only identifier-shaped tokens are searched for.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Every `.ts` file under `dir`, sorted, as absolute paths. */
function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found.sort();
}

/** Forbidden tokens that survive comment stripping. */
function leakedTokens(source, tokens) {
  const code = stripComments(source);
  return tokens.filter((token) => code.includes(token));
}

function sourceLeaks(root, tokens) {
  const leaks = [];
  for (const file of sourceFiles(root)) {
    const found = leakedTokens(readFileSync(file, 'utf8'), tokens);
    for (const token of found) leaks.push(`${path.relative(ROOT, file)}: ${token}`);
  }
  return leaks;
}

test('providerEnv has exactly the two read-only keys and no signing key', () => {
  for (const allowWriteTools of [false, true]) {
    const env = providerEnv({ allowWriteTools, cliPath: 'longstone' });
    assert.deepEqual(Object.keys(env).sort(), [OWNER_KEY_ENV, READ_ONLY_ENV].sort());
    assert.equal(Object.hasOwn(env, 'LONGSTONE_KEY'), false, String(allowWriteTools));
    assert.equal(env[OWNER_KEY_ENV], null, String(allowWriteTools));
  }
});

test('keyPresence reports booleans only', () => {
  for (const env of [
    {},
    { LONGSTONE_KEY: '0xdeadbeef' },
    { LONGSTONE_OWNER_KEY: '0xdeadbeef' },
    { LONGSTONE_KEY: '', LONGSTONE_OWNER_KEY: '' },
  ]) {
    const presence = keyPresence(env);
    assert.equal(typeof presence.keyPresent, 'boolean');
    assert.equal(typeof presence.ownerKeyPresent, 'boolean');
  }
});

test('the wallet sources never touch the MCP key channel', () => {
  const leaks = sourceLeaks(path.join(ROOT, 'src/host/wallet'), [
    'LONGSTONE_KEY',
    'OWNER_KEY_ENV',
    'process.env',
    'mcp-provider',
  ]);
  assert.deepEqual(leaks, []);
});

test('the extension uses no second key store and registers no LM tool', () => {
  // `global-state.ts` and `extension.ts` mention these names only in prose;
  // stripComments makes this assertion about actual code usage.
  const leaks = sourceLeaks(path.join(ROOT, 'src'), [
    'SecretStorage',
    'setKeysForSync',
    'globalStorageUri',
    'vscode.lm.registerTool',
  ]);
  assert.deepEqual(leaks, []);
});

test('the source scanner is non-vacuous: it finds code and ignores comments', () => {
  const synthetic = [
    '// process.env is mentioned in prose only',
    '/* SecretStorage and LONGSTONE_KEY live in this comment */',
    "const label = 'src/host/mcp-provider.ts';",
    'const leaked = process.env.LONGSTONE_KEY;',
    'vscode.lm.registerTool(...)',
  ].join('\n');
  assert.deepEqual(
    leakedTokens(synthetic, ['process.env', 'SecretStorage', 'LONGSTONE_KEY', 'mcp-provider']),
    ['process.env', 'LONGSTONE_KEY', 'mcp-provider'],
  );
  assert.deepEqual(leakedTokens(synthetic, ['vscode.lm.registerTool']), [
    'vscode.lm.registerTool',
  ]);
  // The real scan is not empty: it actually visits the wallet sources.
  assert.ok(sourceFiles(path.join(ROOT, 'src/host/wallet')).length >= 10);
  assert.ok(sourceFiles(path.join(ROOT, 'src')).length >= 20);
});
