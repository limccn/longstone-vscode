#!/usr/bin/env node
/**
 * Read-only inspector for the wallet keys in VS Code's `state.vscdb`
 * (design §4.1/§4.5; PRD R6).
 *
 * The extension stores the `wallet.v1` record as a string under two
 * `globalState` keys. This script opens the SQLite database read-only,
 * validates the envelope and ciphertext properties with the shared core's
 * strict parser, and prints only key names, statuses, KDF parameters and
 * ciphertext length. Record values are never printed.
 *
 * Usage:
 *   node scripts/check-wallet-db.mjs [--db <path>] [--json]
 *
 * Exit codes:
 *   0  record valid (pending absent or valid)
 *   1  validation failed (missing record, corrupt value, plaintext field)
 *   2  usage or database-environment error
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import {
  base64ToBytes,
  isWalletError,
  parseWalletRecord,
} from '@limccn/longstone-wallet';

// Mirrors WALLET_STORAGE_RECORD_KEY / WALLET_STORAGE_PENDING_KEY in
// src/shared/constants.ts (kept literal so the script needs no TS loader).
// test/wallet-db-check.test.mjs asserts the two stay in sync.
export const RECORD_KEY = 'longstone.wallet.v1';
export const PENDING_KEY = 'longstone.wallet.v1.pending';

const EXPECTED_TOP_LEVEL = [
  'cipher',
  'createdAt',
  'domain',
  'format',
  'kdf',
  'updatedAt',
  'version',
];

/** Field names that would mean a decrypted payload leaked into the record. */
const FORBIDDEN_KEYS = new Set([
  'accounts',
  'entropy',
  'hex',
  'mnemonic',
  'phrase',
  'privatekey',
  'secret',
  'seed',
  'words',
]);

function fail(code, detail) {
  return { ok: false, absent: false, failure: detail === undefined ? code : `${code}: ${detail}` };
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return null;
}

function collectKeys(value, out = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, out);
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      out.push(key);
      collectKeys(entry, out);
    }
  }
  return out;
}

/**
 * A `Memento` string value is JSON-encoded once by VS Code and our record is
 * itself a JSON document, so the stored text can be either a JSON object or a
 * JSON string containing one. Accept both; anything else is corruption.
 */
function decodeRecordText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed;
}

/**
 * Validates one stored value. `rawValue` is what SQLite returned (TEXT or
 * BLOB); `null`/`undefined` means the key is absent.
 */
export function inspectWalletValue(rawValue, key) {
  if (rawValue === null || rawValue === undefined) {
    return { ok: true, absent: true, notes: [] };
  }
  const text = textOf(rawValue);
  if (text === null) return fail('unsupported-value-type', key);

  const parsed = decodeRecordText(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('invalid-json', key);
  }

  const topKeys = Object.keys(parsed);
  const missing = EXPECTED_TOP_LEVEL.filter((name) => !topKeys.includes(name));
  if (missing.length > 0) return fail('missing-field', missing.join(','));
  const unexpected = topKeys.filter((name) => !EXPECTED_TOP_LEVEL.includes(name));
  if (unexpected.length > 0) return fail('unexpected-field', unexpected.join(','));

  const leaked = collectKeys(parsed).filter((name) => FORBIDDEN_KEYS.has(name.toLowerCase()));
  if (leaked.length > 0) return fail('plaintext-field', leaked.join(','));

  let record;
  try {
    record = parseWalletRecord(parsed);
  } catch (error) {
    return fail(isWalletError(error) ? error.code : 'VAULT_CORRUPT', key);
  }

  const ciphertextBytes = base64ToBytes(record.cipher.ciphertext).length;
  return {
    ok: true,
    absent: false,
    notes: [
      `format=${record.format}`,
      `kdf=${String(record.kdf.m)}/${String(record.kdf.t)}/${String(record.kdf.p)}`,
      `ciphertext=${String(ciphertextBytes)}B`,
    ],
  };
}

export function defaultStateDbPath(
  platform = process.platform,
  env = process.env,
  home = homedir(),
) {
  if (platform === 'win32') {
    const appData = env.APPDATA;
    if (appData === undefined || appData === '') return null;
    return path.join(appData, 'Code', 'User', 'globalStorage', 'state.vscdb');
  }
  if (platform === 'darwin') {
    return path.join(
      home,
      'Library',
      'Application Support',
      'Code',
      'User',
      'globalStorage',
      'state.vscdb',
    );
  }
  return path.join(home, '.config', 'Code', 'User', 'globalStorage', 'state.vscdb');
}

function lineFor(key, result) {
  const name = key === RECORD_KEY ? 'record' : 'pending';
  if (result.absent) return `${name.padEnd(8)} ${key}  absent`;
  if (result.ok) return `${name.padEnd(8)} ${key}  ok  ${result.notes.join(' ')}`;
  return `${name.padEnd(8)} ${key}  FAIL  ${result.failure}`;
}

export function checkWalletDb(dbPath) {
  const lines = [`state.vscdb: ${dbPath}`];
  const failures = [];

  if (!existsSync(dbPath)) {
    failures.push(`database not found: ${dbPath}`);
    return { exitCode: 2, lines, failures };
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    failures.push(`cannot open database read-only: ${error.message}`);
    return { exitCode: 2, lines, failures };
  }

  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ItemTable'")
      .get();
    if (table === undefined) {
      failures.push('database has no ItemTable; is this a VS Code state database?');
      return { exitCode: 2, lines, failures };
    }

    const rows = db
      .prepare('SELECT key, value FROM ItemTable WHERE key IN (?, ?) ORDER BY key')
      .all(RECORD_KEY, PENDING_KEY);
    const stored = new Map(rows.map((row) => [row.key, row.value]));

    const record = inspectWalletValue(stored.get(RECORD_KEY), RECORD_KEY);
    lines.push(lineFor(RECORD_KEY, record));
    if (record.absent) failures.push(`missing wallet record: ${RECORD_KEY}`);
    else if (!record.ok) failures.push(`${RECORD_KEY}: ${record.failure}`);

    const pending = inspectWalletValue(stored.get(PENDING_KEY), PENDING_KEY);
    lines.push(lineFor(PENDING_KEY, pending));
    if (!pending.ok) failures.push(`${PENDING_KEY}: ${pending.failure}`);

    return { exitCode: failures.length > 0 ? 1 : 0, lines, failures };
  } catch (error) {
    failures.push(`read failed: ${error.message}`);
    return { exitCode: 2, lines, failures };
  } finally {
    db.close();
  }
}

function usage() {
  return [
    'usage: node scripts/check-wallet-db.mjs [--db <path>] [--json]',
    '',
    'Read-only check of the wallet keys in a VS Code state.vscdb.',
    'Defaults to this platform\'s stable VS Code profile; use --db for',
    'Insiders, VSCodium, or a custom profile. Close VS Code first.',
  ].join('\n');
}

function parseArgs(argv) {
  let dbPath = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return { error: '--db needs a path' };
      dbPath = value;
      index += 1;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  return { dbPath, json };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`${args.error}\n${usage()}\n`);
    return 2;
  }

  const dbPath = args.dbPath ?? defaultStateDbPath();
  if (dbPath === null) {
    process.stderr.write('cannot determine the VS Code user data directory; pass --db\n');
    return 2;
  }

  if (args.json === true) {
    const { exitCode, failures } = checkWalletDb(dbPath);
    process.stdout.write(
      `${JSON.stringify({ db: dbPath, ok: exitCode === 0, exitCode, failures }, null, 2)}\n`,
    );
    return exitCode;
  }

  const { exitCode, lines, failures } = checkWalletDb(dbPath);
  process.stdout.write(`${lines.join('\n')}\n`);
  if (failures.length > 0) {
    process.stderr.write(`${failures.length} wallet database check(s) failed\n`);
  }
  return exitCode;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = main();
}
