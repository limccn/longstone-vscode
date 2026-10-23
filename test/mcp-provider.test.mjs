import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MCP_ARGS,
  buildServerDefinition,
  installProbeArgs,
  interpretInstallProbeResult,
  interpretProbeResult,
  keyPresence,
  probeSpawnOptions,
  providerEnv,
  resolveProbeArgs,
} from '../src/host/mcp-provider.ts';
import {
  LONGSTONE_CLI_VERSION,
  LONGSTONE_PACKAGE,
  OWNER_KEY_ENV,
  READ_ONLY_ENV,
} from '../src/shared/constants.ts';

test('read-only is the default provider mode (PS-2)', () => {
  assert.deepEqual(providerEnv({ allowWriteTools: false }), {
    [READ_ONLY_ENV]: '1',
    [OWNER_KEY_ENV]: null,
  });
});

test('write mode sets the variable to 0, never leaves it unset', () => {
  // Longstone treats unset as writable, but inheriting an ambient value is
  // exactly what the setting must override. '0' is explicit both ways.
  assert.deepEqual(providerEnv({ allowWriteTools: true }), {
    [READ_ONLY_ENV]: '0',
    [OWNER_KEY_ENV]: null,
  });
});

test('the provider env carries no key value and removes the owner key', () => {
  const env = providerEnv({ allowWriteTools: true });
  // VS Code merges env over the extension-host environment, so `null` is the
  // only way to remove an ambient LONGSTONE_OWNER_KEY without reading it.
  assert.equal(Object.hasOwn(env, 'LONGSTONE_KEY'), false);
  assert.equal(env[OWNER_KEY_ENV], null);
  for (const value of Object.values(env)) {
    assert.ok(value === '0' || value === '1' || value === null, String(value));
  }
});

test('the launch shape pins the exact package version', () => {
  assert.deepEqual(MCP_ARGS, ['-y', `${LONGSTONE_PACKAGE}@${LONGSTONE_CLI_VERSION}`, 'serve']);
  for (const arg of MCP_ARGS) {
    assert.doesNotMatch(arg, /@latest|\^|~|\s|>|<|\*/);
  }
});

test('the server definition is a stdio npx definition with the pinned args', () => {
  const definition = buildServerDefinition({ allowWriteTools: false });
  assert.equal(definition.command, 'npx');
  assert.deepEqual(definition.args, [...MCP_ARGS]);
  assert.equal(definition.env[READ_ONLY_ENV], '1');
  assert.equal(definition.env[OWNER_KEY_ENV], null);
  assert.equal(definition.version, `${LONGSTONE_CLI_VERSION}+read-only`);
});

test('the version string changes with the tool surface', () => {
  const readOnly = buildServerDefinition({ allowWriteTools: false }).version;
  const writable = buildServerDefinition({ allowWriteTools: true }).version;
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
    const serialized = JSON.stringify(buildServerDefinition({ allowWriteTools: false }));
    assert.doesNotMatch(serialized, /0xef/);
    assert.doesNotMatch(serialized, /LONGSTONE_KEY/);
    // The owner-key name is present only as an explicit removal marker.
    assert.match(serialized, /"LONGSTONE_OWNER_KEY":null/);
  } finally {
    delete process.env.LONGSTONE_KEY;
  }
});

test('resolution probes use --no-install and the exact version', () => {
  assert.deepEqual(resolveProbeArgs(), ['--no-install', `${LONGSTONE_PACKAGE}@${LONGSTONE_CLI_VERSION}`, '--version']);
});

test('Windows probes run through a shell because npx is npx.cmd', () => {
  // Verified on Windows + Node 24: spawning `npx` is ENOENT and `npx.cmd` is
  // EINVAL without a shell. Both would read as "CLI missing".
  //
  // With a shell, Node concatenates args unescaped (DEP0190), so the probe
  // uses ONE constant command line and an empty args array there.
  const expectedArgs = ['--no-install', `${LONGSTONE_PACKAGE}@${LONGSTONE_CLI_VERSION}`, '--version'];
  assert.deepEqual(probeSpawnOptions('win32'), {
    command: `npx ${expectedArgs.join(' ')}`,
    args: [],
    shell: true,
  });
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    assert.deepEqual(probeSpawnOptions(platform), {
      command: 'npx',
      args: expectedArgs,
      shell: false,
    }, platform);
  }
});

test('the Windows command line is built from constants only', () => {
  const { command } = probeSpawnOptions('win32');
  assert.doesNotMatch(command, /[&|<>^%"']/);
  assert.match(command, /^npx --no-install @limccn\/longstone@\d+\.\d+\.\d+ --version$/);
});

test('a successful probe with the right version is ok', () => {
  const result = interpretProbeResult({
    code: 0,
    signal: null,
    stdout: `(node:1) ExperimentalWarning: SQLite\n${LONGSTONE_CLI_VERSION}\n`,
    stderr: '',
    timedOut: false,
  });
  assert.equal(result.ok, true);
});

test('a wrong resolved version is a clear failure, not a silent start', () => {
  const result = interpretProbeResult({
    code: 0,
    signal: null,
    stdout: '0.0.9\n',
    stderr: '',
    timedOut: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /0\.0\.9/);
  assert.match(result.message, new RegExp(LONGSTONE_CLI_VERSION.replace(/\./g, '\\.')));
});

test('a missing package names the package and the fix', () => {
  const result = interpretProbeResult({
    code: 1,
    signal: null,
    stdout: '',
    stderr: `npm error 404 Not Found - GET https://registry.npmjs.org/${LONGSTONE_PACKAGE}`,
    timedOut: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /@limccn\/longstone@0\.1\.1/);
  assert.match(result.message, /npx -y/);
});

test('a cold npx cache is recognized as retryable with -y', () => {
  const result = interpretProbeResult({
    code: 1,
    signal: null,
    stdout: '',
    stderr: 'npm error npx canceled due to missing packages and no YES option: @limccn/longstone@0.1.1',
    timedOut: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.missingFromCache, true);
  assert.deepEqual(installProbeArgs(), ['-y', `${LONGSTONE_PACKAGE}@${LONGSTONE_CLI_VERSION}`, '--version']);
});

test('a registry 404 is not retried and says so', () => {
  const result = interpretProbeResult({
    code: 1,
    signal: null,
    stdout: '',
    stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@limccn/longstone',
    timedOut: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.missingFromCache, false);
});

test('a failed -y retry gets the fetch-specific message', () => {
  const result = interpretInstallProbeResult({
    code: 1,
    signal: null,
    stdout: '',
    stderr: 'npm error network request failed',
    timedOut: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /Could not fetch/);
  assert.match(result.message, /npm\/network/);
});

test('a successful -y retry is ok', () => {
  const result = interpretInstallProbeResult({
    code: 0,
    signal: null,
    stdout: `${LONGSTONE_CLI_VERSION}\n`,
    stderr: '',
    timedOut: false,
  });
  assert.equal(result.ok, true);
});

test('a timeout is reported as a timeout with the cache hint', () => {
  const result = interpretProbeResult({
    code: null,
    signal: 'SIGTERM',
    stdout: '',
    stderr: '',
    timedOut: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /Timed out/);
  assert.match(result.message, /npm cache/);
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
    const env = providerEnv({ allowWriteTools });
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

