#!/usr/bin/env node
/**
 * Bundle audit for the two shipped bundles.
 *
 * Fails on wallet entry points, signing entry points, dynamic code execution,
 * and key-material assignments. The viem public-client internals that are
 * legitimately pulled in by `createPublicClient` (`sendRawTransaction`,
 * `prepareTransactionRequest`) and noble curve helpers are allowed: they can
 * only move already-signed payloads or verify signatures, and the webview has
 * no signer or key.
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

const BUNDLES = ['dist/extension.cjs', 'dist/webview.js'];

/** Entry points that must never appear in either bundle. */
const FORBIDDEN = [
  ['window.ethereum', /window\.ethereum/g],
  // Minifiers may suffix a duplicate binding with a digit; a word boundary
  // alone would miss `createWalletClient2` while still not matching
  // `presignMessagePrefix` for signMessage.
  ['createWalletClient', /\bcreateWalletClient\d*\b/g],
  ['privateKeyToAccount', /\bprivateKeyToAccount\d*\b/g],
  ['signMessage', /\bsignMessage\d*\b/g],
  ['signTypedData', /\bsignTypedData\d*\b/g],
  ['signTransaction', /\bsignTransaction\d*\b/g],
  ['eval(', /\beval\s*\(/g],
  ['new Function(', /\bnew\s+Function\s*\(/g],
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
  ['private-key environment literal', /\b(?:PRIVATE_KEY|PRIVATEKEY|SECRET_KEY|SECRETKEY)\b\s*[:=]\s*["'`]/gi],
  ['mnemonic/seed literal', /\b(?:MNEMONIC|SEED_PHRASE|SEEDPHRASE)\b\s*[:=]\s*["'`]/gi],
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

const failures = [];
const texts = new Map();

for (const label of BUNDLES) {
  const file = path.join(ROOT, label);
  if (!existsSync(file)) {
    failures.push(`${label}: missing bundle`);
    continue;
  }
  const text = readFileSync(file, 'utf8');
  texts.set(label, text);
  for (const [name, pattern] of FORBIDDEN) {
    const match = scan(text, pattern);
    if (match !== null) {
      failures.push(`${label}:${lineNumber(text, match.index)}: forbidden ${name}`);
    }
  }
  for (const [name, pattern] of KEY_MATERIAL) {
    const match = scan(text, pattern);
    if (match !== null) {
      failures.push(`${label}:${lineNumber(text, match.index)}: key material (${name})`);
    }
  }
}

const extensionBundle = texts.get('dist/extension.cjs');
if (extensionBundle !== undefined && !OWNER_REMOVAL.test(extensionBundle)) {
  failures.push(
    'dist/extension.cjs: missing the explicit LONGSTONE_OWNER_KEY: null removal marker',
  );
}

if (failures.length > 0) {
  process.stderr.write(`Bundle audit failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write(`Bundle audit passed (${texts.size} bundles under ${ROOT})\n`);
