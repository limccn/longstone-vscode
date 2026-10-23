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

check('activation events cover startup and both commands', () => {
  const events = manifest.activationEvents ?? [];
  assert.ok(events.includes('onStartupFinished'), 'must activate on startup to register the MCP provider');
  for (const event of ['onCommand:longstone.showMemoryBrowser', 'onCommand:longstone.reportKeyPresence']) {
    assert.ok(events.includes(event), `missing ${event}`);
  }
});

check('contributes.mcpServerDefinitionProviders declares id "longstone"', () => {
  const providers = contributes.mcpServerDefinitionProviders;
  assert.ok(Array.isArray(providers) && providers.length === 1, 'exactly one provider expected');
  assert.equal(providers[0].id, 'longstone');
  assert.equal(typeof providers[0].label, 'string');
});

check('both read-only commands are contributed', () => {
  const commands = contributes.commands ?? [];
  for (const name of ['longstone.showMemoryBrowser', 'longstone.reportKeyPresence']) {
    const command = commands.find((entry) => entry.command === name);
    assert.ok(command, `missing ${name}`);
    assert.equal(typeof command.title, 'string');
  }
});

check('exactly the four endpoint settings and the write switch are contributed', () => {
  assert.deepEqual(Object.keys(properties).sort(), [
    'longstone.allowWriteTools',
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

check('no configuration property is a key channel', () => {
  for (const name of Object.keys(properties)) {
    assert.doesNotMatch(name, /key|secret|mnemonic|private|token/i, `key-like setting: ${name}`);
    assert.doesNotMatch(JSON.stringify(properties[name]), /LONGSTONE_KEY\s*=/);
  }
});

check('no write command and no languageModelTools duplication', () => {
  for (const entry of contributes.commands ?? []) {
    assert.doesNotMatch(entry.command, /put|retract|acl|write|sign/i, entry.command);
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

check('README documents read-only default, write setting and tests', () => {
  assert.match(readme, /read-only/i);
  assert.match(readme, /longstone\.allowWriteTools/);
  assert.match(readme, /pnpm --dir longstone-vscode test/);
});

check('.vscodeignore excludes sources and tooling from the VSIX', () => {
  assert.match(vscodeIgnore, /^src\/\*\*$/m);
  assert.match(vscodeIgnore, /^test\/\*\*$/m);
  assert.match(vscodeIgnore, /^scripts\/\*\*$/m);
  assert.match(vscodeIgnore, /^node_modules\/\*\*$/m);
  // dist/ and media/ must NOT be ignored: the webview loads them.
  assert.doesNotMatch(vscodeIgnore, /^dist\//m);
  assert.doesNotMatch(vscodeIgnore, /^media\//m);
});

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} manifest assertion(s) failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}
process.stdout.write('\nmanifest assertions passed\n');
