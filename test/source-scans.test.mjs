/**
 * Source purity scans (design §12.3).
 *
 * The build and bundle audit inspect what esbuild produced; these scans keep
 * the same boundaries true at the source level, where the failure is easier
 * to name:
 *
 * - `src/host/wallet/**` — no console, debugger, network API or Node builtin.
 *   Host logging goes through `extension.ts` only.
 * - `src/shared/**` — pure modules shared with both webviews: no `vscode`
 *   module and no Node builtin.
 * - `src/wallet-webview/**` — imports only its protocol module: no host API,
 *   Node, viem, surface or shared wallet core, and no network/console/
 *   debugger/dynamic code.
 *
 * The MCP-boundary tokens (`LONGSTONE_KEY`, `process.env`, `SecretStorage`,
 * `setKeysForSync`, ...) are asserted in `mcp-provider.test.mjs` and are not
 * duplicated here.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WALLET_HOST = path.join(ROOT, 'src/host/wallet');
const SHARED = path.join(ROOT, 'src/shared');
const SECRET_WEBVIEW = path.join(ROOT, 'src/wallet-webview');

/** Remove comments; prose mentioning an API is not a use of it. */
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

/** Exact module specifier, including subpaths; never a prefix match. */
function importOf(moduleName) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(
    `(?:from\\s*|require\\s*\\(\\s*|import\\s*\\(\\s*)["']${escaped}(?:/[^"']*)?["']`,
  );
}

const NODE_BUILTIN = /(?:from\s*|require\s*\(\s*|import\s*\(\s*)["']node:/;

/** The network and host-output APIs the secret surface must never reach. */
const NETWORK_OR_OUTPUT = [
  ['console.', /\bconsole\s*\./],
  ['debugger', /\bdebugger\b/],
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['EventSource', /\bEventSource\b/],
  ['sendBeacon', /\bsendBeacon\b/],
];

/**
 * Runtime download / process-spawn markers. The extension launches the
 * user-installed CLI only through VS Code's MCP client; it must never fetch a
 * package or start a process itself. The bundle audit enforces the same rule
 * on `dist/`, and this scan catches it at the source level.
 */
const RUNTIME_EXECUTION = [
  ['npx', /\bnpx\b/],
  ['child_process', /\bchild_process\b/],
  ['node:child_process', /node:child_process/],
];

/** Find the first forbidden construct in `dir`; returns "file: label". */
function findForbidden(dir, rules) {
  const leaks = [];
  for (const file of sourceFiles(dir)) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const [label, pattern] of rules) {
      if (pattern.test(code)) leaks.push(`${path.relative(ROOT, file)}: ${label}`);
    }
  }
  return leaks;
}

function rules(...entries) {
  return entries.map(([label, expression]) => [
    label,
    expression instanceof RegExp ? expression : importOf(expression),
  ]);
}

test('wallet host modules never log, debug, reach the network or import Node', () => {
  const leaks = findForbidden(
    WALLET_HOST,
    rules(...NETWORK_OR_OUTPUT, ['Node builtin', NODE_BUILTIN]),
  );
  assert.deepEqual(leaks, []);
});

test('the pure shared modules import neither the host API nor Node builtins', () => {
  // Both webviews consume these modules, so a `vscode` or `node:` import would
  // either break the build or leak the host boundary into a webview.
  const leaks = findForbidden(SHARED, rules(['vscode import', 'vscode'], ['Node builtin', NODE_BUILTIN]));
  assert.deepEqual(leaks, []);
});

test('the secret webview imports no host, chain or wallet-core module', () => {
  const leaks = findForbidden(
    SECRET_WEBVIEW,
    rules(
      ['vscode import', 'vscode'],
      ['Node builtin', NODE_BUILTIN],
      ['viem import', 'viem'],
      ['surface import', '@limccn/longstone-surface'],
      ['wallet core import', '@limccn/longstone-wallet'],
    ),
  );
  assert.deepEqual(leaks, []);
});

test('the secret webview has no network, console, debugger or dynamic code', () => {
  const leaks = findForbidden(
    SECRET_WEBVIEW,
    rules(
      ...NETWORK_OR_OUTPUT,
      ['eval(', /\beval\s*\(/],
      ['new Function(', /\bnew\s+Function\s*\(/],
    ),
  );
  assert.deepEqual(leaks, []);
});

test('the extension sources contain no runtime download or process spawn', () => {
  const leaks = findForbidden(path.join(ROOT, 'src'), rules(...RUNTIME_EXECUTION));
  assert.deepEqual(leaks, []);
});

test('the scanners are non-vacuous and ignore comments', () => {
  // The real scans visit real files, so a broken directory path cannot pass.
  assert.ok(sourceFiles(WALLET_HOST).length >= 10);
  assert.ok(sourceFiles(SHARED).length >= 6);
  assert.ok(sourceFiles(SECRET_WEBVIEW).length >= 1);

  const commented = [
    '// fetch( is mentioned in prose only',
    '/* console. and vscode live in this comment */',
    "import { parseWalletOwnerMessage } from '../shared/wallet-protocol.ts';",
  ].join('\n');
  assert.deepEqual(findForbiddenIn(commented, rules(...NETWORK_OR_OUTPUT)), []);
  assert.deepEqual(
    findForbiddenIn(
      `${commented}\nconst value = await fetch(url);\nimport * as vscode from 'vscode';`,
      rules(...NETWORK_OR_OUTPUT, ['vscode import', 'vscode']),
    ),
    ['fetch(', 'vscode import'],
  );

  // The secret webview legitimately names a local `vscode` handle for the
  // webview API; only the module import is forbidden.
  const localHandle = 'const vscode: VsCodeApi = acquireVsCodeApi();';
  assert.deepEqual(findForbiddenIn(localHandle, rules(['vscode import', 'vscode'])), []);

  // Runtime download / spawn markers: prose is ignored, code is not.
  assert.deepEqual(
    findForbiddenIn('// npx is mentioned in prose only', rules(...RUNTIME_EXECUTION)),
    [],
  );
  assert.deepEqual(
    findForbiddenIn('const spawn = require("node:child_process");', rules(...RUNTIME_EXECUTION)),
    ['child_process', 'node:child_process'],
  );
});

/** Same scan as `findForbidden`, for one synthetic source string. */
function findForbiddenIn(source, scanRules) {
  const code = stripComments(source);
  return scanRules.filter(([, pattern]) => pattern.test(code)).map(([label]) => label);
}
