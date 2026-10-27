#!/usr/bin/env node
/**
 * Manifest assertions — the packaging contract, checked without VS Code.
 *
 * These are the properties that silently regress when someone edits
 * package.json: the provider contribution, the command, the endpoint
 * settings, the write-mode switch, and the absence of any key setting. It also
 * cross-checks the pinned CLI version against the provider module so the two
 * cannot drift apart.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const constants = await readFile(path.join(ROOT, 'src/shared/constants.ts'), 'utf8');
const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8');
const vscodeIgnore = await readFile(path.join(ROOT, '.vscodeignore'), 'utf8');

const failures = [];
function check(label, fn) {
  try {
    fn();
    process.stdout.write(`ok   ${label}\n`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    process.stdout.write(`FAIL ${label}\n`);
  }
}

const contributes = manifest.contributes ?? {};
const properties = contributes.configuration?.properties ?? {};

/** The full contributed command list: two existing plus eight wallet commands. */
const EXPECTED_COMMANDS = [
  'longstone.showMemoryBrowser',
  'longstone.reportKeyPresence',
  'longstone.wallet.manage',
  'longstone.wallet.create',
  'longstone.wallet.import',
  'longstone.wallet.lock',
  'longstone.wallet.copyAddress',
  'longstone.wallet.exportSecret',
  'longstone.wallet.changePassword',
  'longstone.wallet.reset',
];

check('the store release is version 0.2.3', () => {
  assert.equal(manifest.version, '0.2.3');
});

check('the store icon is the packaged 128x128 png', () => {
  assert.equal(manifest.icon, 'media/icon128x128.png');
});

check('main points at the built extension bundle', () => {
  assert.equal(manifest.main, './dist/extension.cjs');
});

check('engines.vscode supports the MCP provider API (>= 1.101)', () => {
  assert.match(manifest.engines.vscode, /^\^1\.(\d+)\.\d+$/);
  const minor = Number(/^\^1\.(\d+)\./.exec(manifest.engines.vscode)[1]);
  assert.ok(
    minor >= 101,
    `engines.vscode ${manifest.engines.vscode} predates registerMcpServerDefinitionProvider (1.101)`,
  );
});

check('activation events cover startup and every contributed command', () => {
  const events = manifest.activationEvents ?? [];
  assert.ok(events.includes('onStartupFinished'), 'must activate on startup to register the MCP provider');
  const commands = (contributes.commands ?? []).map((entry) => entry.command);
  for (const command of commands) {
    assert.ok(events.includes(`onCommand:${command}`), `missing onCommand:${command}`);
  }
});

check('contributes.mcpServerDefinitionProviders declares id "longstone"', () => {
  const providers = contributes.mcpServerDefinitionProviders;
  assert.ok(Array.isArray(providers) && providers.length === 1, 'exactly one provider expected');
  assert.equal(providers[0].id, 'longstone');
  assert.equal(typeof providers[0].label, 'string');
});

check('exactly the ten expected commands are contributed', () => {
  const commands = contributes.commands ?? [];
  assert.deepEqual(
    commands.map((entry) => entry.command).sort(),
    [...EXPECTED_COMMANDS].sort(),
  );
  for (const command of commands) {
    assert.equal(typeof command.title, 'string', `${command.command} needs a title`);
    assert.equal(command.category, 'Longstone', `${command.command} needs the Longstone category`);
  }
});

check('no menus or keybindings are contributed', () => {
  assert.equal(contributes.menus, undefined, 'the wallet ships no menus');
  assert.equal(contributes.keybindings, undefined, 'the wallet ships no keybindings');
});

check('exactly the four endpoint settings, the write switch and the CLI path are contributed', () => {
  assert.deepEqual(Object.keys(properties).sort(), [
    'longstone.allowWriteTools',
    'longstone.cliPath',
    'longstone.hisaishiUrl',
    'longstone.ipfsGateway',
    'longstone.registryAddress',
    'longstone.rpcUrl',
  ]);
});

check('every endpoint setting defaults to https or empty', () => {
  for (const key of ['longstone.rpcUrl', 'longstone.ipfsGateway']) {
    assert.equal(new URL(properties[key].default).protocol, 'https:', key);
  }
  assert.equal(properties['longstone.hisaishiUrl'].default, '');
  assert.equal(properties['longstone.allowWriteTools'].default, false);
});

check('the registry address has a shape pattern', () => {
  assert.equal(properties['longstone.registryAddress'].pattern, '^0x[0-9a-fA-F]{40}$');
});

check('write mode is application-scoped, so a workspace cannot enable it', () => {
  assert.equal(properties['longstone.allowWriteTools'].scope, 'application');
});

check('the CLI path defaults to longstone and is application-scoped', () => {
  const cliPath = properties['longstone.cliPath'];
  assert.ok(cliPath, 'longstone.cliPath is missing');
  assert.equal(cliPath.type, 'string');
  assert.equal(cliPath.default, 'longstone');
  assert.equal(cliPath.scope, 'application');
});

check('no configuration property is a key channel', () => {
  for (const name of Object.keys(properties)) {
    assert.doesNotMatch(name, /key|secret|mnemonic|private|token/i, `key-like setting: ${name}`);
    assert.doesNotMatch(JSON.stringify(properties[name]), /LONGSTONE_KEY\s*=/);
  }
});

check('no command can sign, send, write or manipulate access control', () => {
  for (const entry of contributes.commands ?? []) {
    assert.doesNotMatch(entry.command, /sign|send|write|put|retract|acl/i, entry.command);
  }
  assert.equal(contributes.languageModelTools, undefined);
});

check('the pinned CLI version in constants.ts is an exact semver', () => {
  const match = /LONGSTONE_CLI_VERSION\s*=\s*'([^']+)'/.exec(constants);
  assert.ok(match, 'LONGSTONE_CLI_VERSION not found');
  assert.match(match[1], /^\d+\.\d+\.\d+$/);
});

check('the provider pins the same version the README documents', () => {
  const match = /LONGSTONE_CLI_VERSION\s*=\s*'([^']+)'/.exec(constants);
  assert.ok(readme.includes(`@limccn/longstone@${match[1]}`), `README must name @limccn/longstone@${match[1]}`);
});

check('README documents the global CLI install and no runtime download', () => {
  assert.doesNotMatch(readme, /\bnpx\b/, 'README must not mention npx');
  assert.match(readme, /npm install -g @limccn\/longstone@0\.1\.1/);
  assert.match(readme, /longstone\.cliPath/);
  assert.match(readme, /longstone serve/);
});

check('README documents read-only default, write setting and tests', () => {
  assert.match(readme, /read-only/i);
  assert.match(readme, /longstone\.allowWriteTools/);
  assert.match(readme, /pnpm --dir longstone-vscode test/);
});

check('README describes the local-only, non-signing wallet and the MCP boundary', () => {
  assert.match(readme, /wallet/i);
  assert.match(readme, /local-only/i);
  assert.match(readme, /never signs/i);
  assert.match(
    readme,
    /never injected into the MCP server environment/i,
    'README must state that wallet secrets are not injected into MCP',
  );
  assert.doesNotMatch(readme, /no\s+wallet/i, 'README must not claim there is no wallet');
});

check('.vscodeignore excludes sources and tooling from the VSIX', () => {
  assert.match(vscodeIgnore, /^src\/\*\*$/m);
  assert.match(vscodeIgnore, /^test\/\*\*$/m);
  assert.match(vscodeIgnore, /^scripts\/\*\*$/m);
  assert.match(vscodeIgnore, /^node_modules\/\*\*$/m);
  // dist/ and media/ must NOT be ignored wholesale: the webview loads them.
  // A specific media file may be excluded (the large icon source is one).
  assert.doesNotMatch(vscodeIgnore, /^dist\//m);
  assert.doesNotMatch(vscodeIgnore, /^media(\/\*\*)?\/?$/m);
});

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} manifest assertion(s) failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}
process.stdout.write('\nmanifest assertions passed\n');
