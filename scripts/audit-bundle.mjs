#!/usr/bin/env node
/**
 * Bundle audit for the three shipped bundles.
 *
 * Fails on wallet entry points, signing entry points, dynamic code execution,
 * and key-material assignments. The viem public-client internals that are
 * legitimately pulled in by `createPublicClient` (`sendRawTransaction`,
 * `prepareTransactionRequest`) and noble curve helpers are allowed: they can
 * only move already-signed payloads or verify signatures, and the webview has
 * no signer or key.
 *
 * Rules are applied per bundle and every failure names its bundle, so an
 * allowance for one bundle can never leak into another:
 *
 * - `bundle:extension` (host) may contain the shared wallet core and console
 *   output; it must keep the explicit owner-key removal marker.
 * - `bundle:memory` (memory browser) may perform chain/gateway reads.
 * - `bundle:secret` (wallet secret webview) additionally bans every network
 *   API, console/debugger, and any shared-core marker.
 *
 * Raw 64-hex literals are allowed on their own: ABI bytecode, curve constants
 * and domain separators legitimately contain them. They fail when attached to
 * a key-named variable or environment name. The one deliberate key-name
 * exception is the provider's explicit `LONGSTONE_OWNER_KEY: null` removal
 * marker.
 *
 * Usage:
 *   node scripts/audit-bundle.mjs [root]
 *
 * `root` defaults to this repository and exists for the negative tests.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(process.argv[2] ?? DEFAULT_ROOT);

const BUNDLES = [
  { id: 'extension', file: 'dist/extension.cjs' },
  { id: 'memory', file: 'dist/webview.js' },
  { id: 'secret', file: 'dist/wallet-webview.js' },
];

/** Entry points that must never appear in any bundle. */
const FORBIDDEN = [
  // No runtime download and no process spawning: the extension never fetches
  // the CLI, and VS Code (not this code) starts the installed `longstone`.
  ['node:child_process', /node:child_process/g],
  ['child_process', /\bchild_process\b/g],
  ['npx', /\bnpx\b/g],
  ['window.ethereum', /window\.ethereum/g],
  // Minifiers may suffix a duplicate binding with a digit; a word boundary
  // alone would miss `createWalletClient2` while still not matching
  // `presignMessagePrefix` for signMessage.
  ['createWalletClient', /\bcreateWalletClient\d*\b/g],
  ['privateKeyToAccount', /\bprivateKeyToAccount\d*\b/g],
  ['signMessage', /\bsignMessage\d*\b/g],
  ['signTypedData', /\bsignTypedData\d*\b/g],
  ['signTransaction', /\bsignTransaction\d*\b/g],
  ['eth_sendTransaction', /eth_sendTransaction/g],
  ['eth_signTypedData', /eth_signTypedData/g],
  ['eval(', /\beval\s*\(/g],
  ['new Function(', /\bnew\s+Function\s*\(/g],
];

/**
 * Secret-webview-only bans: no network, no console/debugger, and none of the
 * shared crypto core. The core runs in the host; the secret bundle only
 * renders what the host posts after `ready`.
 */
const SECRET_ONLY_FORBIDDEN = [
  ['fetch(', /\bfetch\s*\(/g],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/g],
  ['WebSocket', /\bWebSocket\b/g],
  ['EventSource', /\bEventSource\b/g],
  ['sendBeacon', /\bsendBeacon\b/g],
  ['console.', /\bconsole\s*\./g],
  ['debugger', /\bdebugger\b/g],
  ['@limccn/longstone-wallet', /@limccn\/longstone-wallet\b/g],
  ['argon2id', /argon2id/gi],
  ['longstone/wallet.v1', /longstone\/wallet\.v1/g],
];

/**
 * A key-material assignment: a key-named variable/env with a string literal
 * (the value may be a hex key, a mnemonic, or a concatenation beginning with
 * one). `LONGSTONE_OWNER_KEY` is special-cased for the approved null marker
 * below.
 */
const KEY_MATERIAL = [
  ['LONGSTONE_KEY literal', /\bLONGSTONE_KEY\b\s*[:=]\s*["'`]/g],
  ['LONGSTONE_OWNER_KEY literal', /\bLONGSTONE_OWNER_KEY\b\s*[:=]\s*["'`]/g],
  // Environment-style names only (uppercase or snake_case). The shared core
  // derives account material into camelCase locals such as
  // `const privateKey = \`0x${bytesToHex(...)}\``; that is computed output,
  // not a key literal, and literal hex is still caught by the rules below.
  [
    'private-key environment literal',
    /\b(?:PRIVATE_KEY|PRIVATEKEY|SECRET_KEY|SECRETKEY|private_key|secret_key)\b\s*[:=]\s*["'`]/g,
  ],
  ['mnemonic/seed literal', /\b(?:MNEMONIC|SEED_PHRASE|SEEDPHRASE)\b\s*[:=]\s*["'`]/gi],
  // The narrowing above keeps camelCase locals (the core derives
  // `privateKey` from bytes) from tripping the env rule. A mnemonic stored in
  // a key-named variable has no `0x` hex form, so the hex rules below cannot
  // see it: match 12-24 lowercase words (BIP-39 shape) after such a name.
  [
    'key-named mnemonic literal',
    /\b[A-Za-z_$][\w$]*(?:Key|KEY|Secret|SECRET|Mnemonic|MNEMONIC|Private|PRIVATE)[A-Za-z0-9_$]*\s*[:=]\s*["'`](?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}["'`]/g,
  ],
  ['privateKey hex literal', /\bprivateKey\b\s*[:=]\s*["'`]?0x[0-9a-fA-F]{64}\b/g],
  [
    'key-named hex assignment',
    /\b[A-Za-z_$][\w$]*(?:Key|KEY|Secret|SECRET|Mnemonic|MNEMONIC|Private|PRIVATE)[A-Za-z0-9_$]*\s*[:=]\s*["'`]?0x[0-9a-fA-F]{64}\b/g,
  ],
  [
    'key-literal argument',
    /\b(?:fromPrivateKey|privateKeyToAccount\d*|signMessage\d*|signTypedData\d*|signTransaction\d*)\s*\(\s*["'`]?0x[0-9a-fA-F]{64}\b/g,
  ],
];

/** The provider must keep removing the owner key from the server env. */
const OWNER_REMOVAL = /(?:OWNER_KEY_ENV|LONGSTONE_OWNER_KEY)["']?\]?\s*:\s*null/;

function lineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

function scan(text, pattern) {
  pattern.lastIndex = 0;
  return pattern.exec(text);
}

function where(bundleId, label, text, index) {
  return `${label} (bundle:${bundleId}):${lineNumber(text, index)}`;
}

const failures = [];
const texts = new Map();

for (const bundle of BUNDLES) {
  const file = path.join(ROOT, bundle.file);
  if (!existsSync(file)) {
    failures.push(`${bundle.file} (bundle:${bundle.id}): missing bundle`);
    continue;
  }
  const text = readFileSync(file, 'utf8');
  texts.set(bundle.id, text);

  const forbidden = bundle.id === 'secret'
    ? [...FORBIDDEN, ...SECRET_ONLY_FORBIDDEN]
    : FORBIDDEN;

  for (const [name, pattern] of forbidden) {
    const match = scan(text, pattern);
    if (match !== null) {
      failures.push(`${where(bundle.id, bundle.file, text, match.index)}: forbidden ${name}`);
    }
  }
  for (const [name, pattern] of KEY_MATERIAL) {
    const match = scan(text, pattern);
    if (match !== null) {
      failures.push(
        `${where(bundle.id, bundle.file, text, match.index)}: key material (${name})`,
      );
    }
  }
}

const extensionBundle = texts.get('extension');
if (extensionBundle !== undefined && !OWNER_REMOVAL.test(extensionBundle)) {
  failures.push(
    'dist/extension.cjs (bundle:extension): missing the explicit LONGSTONE_OWNER_KEY: null removal marker',
  );
}

if (failures.length > 0) {
  process.stderr.write(`Bundle audit failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write(`Bundle audit passed (${texts.size} bundles under ${ROOT})\n`);
