/**
 * `check-wallet-db.mjs` tests (PRD R6/AC-6).
 *
 * Every case builds a synthetic `state.vscdb` in a temporary directory with
 * the real `ItemTable` shape. The checker is read-only and must never print
 * record contents, so the output assertions include the salt, IV and
 * ciphertext strings.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  WALLET_FORMAT,
  WALLET_FORMAT_DOMAIN,
  bytesToBase64,
  randomBytes,
} from '@limccn/longstone-wallet';

import {
  CONTAINER_KEY,
  PENDING_KEY,
  RECORD_KEY,
  checkWalletDb,
  inspectWalletValue,
} from '../scripts/check-wallet-db.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/check-wallet-db.mjs', import.meta.url));
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath() {
  const dir = mkdtempSync(path.join(tmpdir(), 'longstone-wallet-db-'));
  tempDirs.push(dir);
  return path.join(dir, 'state.vscdb');
}

function makeRecord(overrides = {}) {
  return {
    format: WALLET_FORMAT,
    version: 1,
    domain: WALLET_FORMAT_DOMAIN,
    kdf: {
      alg: 'argon2id',
      m: 65536,
      t: 3,
      p: 1,
      salt: bytesToBase64(randomBytes(16)),
    },
    cipher: {
      alg: 'AES-256-GCM',
      iv: bytesToBase64(randomBytes(12)),
      ciphertext: bytesToBase64(randomBytes(64)),
    },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    ...overrides,
  };
}

/** Writes a real SQLite database; `entries` are [key, value] pairs. */
function writeDb(dbPath, entries, options = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    if (options.noTable === true) return;
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
    for (const [key, value] of entries) insert.run(key, value);
  } finally {
    db.close();
  }
}

/** The 1.143 memento object stored under the extension-id container key. */
function containerValue(entries) {
  return JSON.stringify(Object.fromEntries(entries));
}

/** Records are double-encoded inside the memento, exactly as VS Code does. */
function storedRecord(record = makeRecord()) {
  return JSON.stringify(JSON.stringify(record));
}

describe('inspectWalletValue', () => {
  it('accepts VS Code double encoding and a directly stored object', () => {
    const record = makeRecord();
    const double = JSON.stringify(JSON.stringify(record));
    const direct = JSON.stringify(record);

    for (const raw of [double, direct, Buffer.from(double, 'utf8')]) {
      const result = inspectWalletValue(raw, RECORD_KEY);
      assert.equal(result.ok, true);
      assert.equal(result.absent, false);
      assert.match(result.notes.join(' '), /ciphertext=64B/);
    }
  });

  it('treats null and undefined as absent', () => {
    for (const raw of [null, undefined]) {
      const result = inspectWalletValue(raw, RECORD_KEY);
      assert.equal(result.ok, true);
      assert.equal(result.absent, true);
    }
  });

  it('rejects malformed JSON and non-object shapes', () => {
    assert.equal(inspectWalletValue('not json', RECORD_KEY).failure.includes('invalid-json'), true);
    assert.equal(inspectWalletValue('[]', RECORD_KEY).ok, false);
  });

  it('rejects a wrong format, domain or KDF', () => {
    const cases = [
      makeRecord({ format: 'other.wallet.v1' }),
      makeRecord({ domain: 'other/wallet.v1/kdf' }),
      makeRecord({ version: 2 }),
      makeRecord({ kdf: { alg: 'argon2id', m: 1, t: 1, p: 1, salt: bytesToBase64(randomBytes(16)) } }),
    ];
    for (const record of cases) {
      const result = inspectWalletValue(JSON.stringify(record), RECORD_KEY);
      assert.equal(result.ok, false);
    }
  });

  it('rejects non-canonical base64 for salt, iv or ciphertext', () => {
    const records = [
      makeRecord({ kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: 'not-base64!!' } }),
      makeRecord({ cipher: { alg: 'AES-256-GCM', iv: 'short', ciphertext: bytesToBase64(randomBytes(64)) } }),
      makeRecord({ cipher: { alg: 'AES-256-GCM', iv: bytesToBase64(randomBytes(12)), ciphertext: '!!!' } }),
    ];
    for (const record of records) {
      const result = inspectWalletValue(JSON.stringify(record), RECORD_KEY);
      assert.equal(result.ok, false);
    }
  });

  it('rejects plaintext fields anywhere in the value', () => {
    const extraTopLevel = makeRecord({ accounts: [] });
    assert.match(
      inspectWalletValue(JSON.stringify(extraTopLevel), RECORD_KEY).failure,
      /unexpected-field/,
    );

    const nested = makeRecord();
    nested.kdf = { ...nested.kdf, words: 'test test test' };
    assert.match(inspectWalletValue(JSON.stringify(nested), RECORD_KEY).failure, /plaintext-field/);
  });
});

describe('checkWalletDb', () => {
  it('passes a valid record with an absent pending key', () => {
    const dbPath = tempDbPath();
    writeDb(dbPath, [[RECORD_KEY, JSON.stringify(JSON.stringify(makeRecord()))]]);

    const result = checkWalletDb(dbPath);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.failures, []);
    assert.match(result.lines.join('\n'), /record\s+longstone\.wallet\.v1\s+ok/);
    assert.match(result.lines.join('\n'), /pending\s+longstone\.wallet\.v1\.pending\s+absent/);
  });

  it('passes a valid record stored as a BLOB', () => {
    const dbPath = tempDbPath();
    const raw = Buffer.from(JSON.stringify(JSON.stringify(makeRecord())), 'utf8');
    writeDb(dbPath, [[RECORD_KEY, raw]]);

    const result = checkWalletDb(dbPath);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.failures, []);
    assert.match(result.lines.join('\n'), /record\s+longstone\.wallet\.v1\s+ok/);
  });

  it('passes a valid record and a valid pending record', () => {
    const dbPath = tempDbPath();
    writeDb(dbPath, [
      [RECORD_KEY, JSON.stringify(JSON.stringify(makeRecord()))],
      [PENDING_KEY, JSON.stringify(JSON.stringify(makeRecord()))],
    ]);
    assert.equal(checkWalletDb(dbPath).exitCode, 0);
  });

  it('fails when the record key is missing', () => {
    const dbPath = tempDbPath();
    writeDb(dbPath, [[PENDING_KEY, JSON.stringify(JSON.stringify(makeRecord()))]]);
    const result = checkWalletDb(dbPath);
    assert.equal(result.exitCode, 1);
    assert.match(result.failures.join('\n'), /missing wallet record/);
  });

  it('fails on a corrupt pending record', () => {
    const dbPath = tempDbPath();
    writeDb(dbPath, [
      [RECORD_KEY, JSON.stringify(JSON.stringify(makeRecord()))],
      [PENDING_KEY, 'not json'],
    ]);
    assert.equal(checkWalletDb(dbPath).exitCode, 1);
  });

  it('returns 2 for a missing database or a database without ItemTable', () => {
    const missing = tempDbPath();
    assert.equal(checkWalletDb(missing).exitCode, 2);

    const noTable = tempDbPath();
    writeDb(noTable, [], { noTable: true });
    assert.equal(checkWalletDb(noTable).exitCode, 2);
  });

  it('never prints the salt, IV or ciphertext', () => {
    const dbPath = tempDbPath();
    const record = makeRecord();
    writeDb(dbPath, [[RECORD_KEY, JSON.stringify(JSON.stringify(record))]]);

    const output = checkWalletDb(dbPath).lines.join('\n');
    for (const secret of [record.kdf.salt, record.cipher.iv, record.cipher.ciphertext]) {
      assert.equal(output.includes(secret), false);
    }
  });

  it('keeps its physical keys in sync with src/shared/constants.ts', () => {
    const constants = readFileSync(
      new URL('../src/shared/constants.ts', import.meta.url),
      'utf8',
    );
    assert.match(constants, new RegExp(`WALLET_STORAGE_RECORD_KEY = '${RECORD_KEY}'`));
    assert.match(constants, new RegExp(`WALLET_STORAGE_PENDING_KEY = '${PENDING_KEY}'`));
  });

  it('reads a valid record from the 1.143 per-extension container', () => {
    const dbPath = tempDbPath();
    writeDb(dbPath, [
      [
        CONTAINER_KEY,
        containerValue([
          [RECORD_KEY, storedRecord()],
          [PENDING_KEY, storedRecord()],
        ]),
      ],
    ]);

    const result = checkWalletDb(dbPath);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.failures, []);
    assert.equal(result.layout, 'container');
    assert.match(result.lines.join('\n'), /layout\s+container limccn\.longstone-vscode/);
    assert.match(result.lines.join('\n'), /record\s+longstone\.wallet\.v1\s+ok/);
    assert.match(result.lines.join('\n'), /pending\s+longstone\.wallet\.v1\.pending\s+ok/);
  });

  it('reads a container stored as a BLOB and accepts a direct object value', () => {
    const dbPath = tempDbPath();
    writeDb(dbPath, [
      [CONTAINER_KEY, Buffer.from(containerValue([[RECORD_KEY, makeRecord()]]), 'utf8')],
    ]);

    const result = checkWalletDb(dbPath);
    assert.equal(result.exitCode, 0);
    assert.equal(result.layout, 'container');
    assert.match(result.lines.join('\n'), /pending\s+longstone\.wallet\.v1\.pending\s+absent/);
  });

  it('fails on a corrupt record inside the container', () => {
    const dbPath = tempDbPath();
    writeDb(dbPath, [[CONTAINER_KEY, containerValue([[RECORD_KEY, 'not json']])]]);

    const result = checkWalletDb(dbPath);
    assert.equal(result.exitCode, 1);
    assert.match(result.failures.join('\n'), /longstone\.wallet\.v1: invalid-json/);
    assert.match(result.lines.join('\n'), /record\s+longstone\.wallet\.v1\s+FAIL\s+invalid-json/);
  });

  it('fails when the container value cannot be read as an object', () => {
    const cases = [
      ['not json', /container .*: invalid-json/],
      ['[]', /container .*: invalid-shape/],
      [42, /container .*: unsupported-value-type/],
    ];
    for (const [value, pattern] of cases) {
      const dbPath = tempDbPath();
      writeDb(dbPath, [[CONTAINER_KEY, value]]);

      const result = checkWalletDb(dbPath);
      assert.equal(result.exitCode, 1, String(value));
      assert.match(result.failures.join('\n'), pattern);
      assert.match(
        result.lines.join('\n'),
        /record\s+longstone\.wallet\.v1\s+FAIL\s+container-unreadable/,
      );
      // The first line prints the caller-supplied database path, which may
      // itself contain the value (e.g. a temp directory named "tmp42"); the
      // path is not record content, so assert against the status lines only.
      const statusLines = result.lines
        .filter((line) => !line.startsWith('state.vscdb: '))
        .join('\n');
      assert.equal(
        statusLines.includes(String(value)),
        false,
        'the container value is never echoed',
      );
    }
  });

  it('prefers top-level keys when both layouts are present', () => {
    const dbPath = tempDbPath();
    writeDb(dbPath, [
      [RECORD_KEY, storedRecord()],
      [CONTAINER_KEY, 'not json'],
    ]);

    const result = checkWalletDb(dbPath);
    assert.equal(result.exitCode, 0);
    assert.equal(result.layout, 'top-level');
  });

  it('fails when the container has no record key', () => {
    const dbPath = tempDbPath();
    writeDb(dbPath, [[CONTAINER_KEY, containerValue([[PENDING_KEY, storedRecord()]])]]);

    const result = checkWalletDb(dbPath);
    assert.equal(result.exitCode, 1);
    assert.match(result.failures.join('\n'), /missing wallet record/);
  });

  it('never prints secrets read from the container', () => {
    const dbPath = tempDbPath();
    const record = makeRecord();
    writeDb(dbPath, [[CONTAINER_KEY, containerValue([[RECORD_KEY, storedRecord(record)]])]]);

    const output = checkWalletDb(dbPath).lines.join('\n');
    for (const secret of [record.kdf.salt, record.cipher.iv, record.cipher.ciphertext]) {
      assert.equal(output.includes(secret), false);
    }
  });

  it('never prints other keys or values from the container', () => {
    const dbPath = tempDbPath();
    writeDb(dbPath, [
      [
        CONTAINER_KEY,
        containerValue([
          ['some.other.setting', JSON.stringify({ note: 'do-not-print' })],
          [RECORD_KEY, storedRecord()],
        ]),
      ],
    ]);

    const result = checkWalletDb(dbPath);
    assert.equal(result.exitCode, 0);
    const output = [...result.lines, ...result.failures].join('\n');
    assert.equal(output.includes('some.other.setting'), false);
    assert.equal(output.includes('do-not-print'), false);
  });

  it('keeps the container key in sync with package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(CONTAINER_KEY, `${pkg.publisher}.${pkg.name}`);
  });
});

describe('CLI exit codes', () => {
  function run(args) {
    return spawnSync(process.execPath, ['--no-warnings', SCRIPT, ...args], {
      encoding: 'utf8',
    });
  }

  it('exits 0 for a valid database', () => {
    const dbPath = tempDbPath();
    writeDb(dbPath, [[RECORD_KEY, JSON.stringify(JSON.stringify(makeRecord()))]]);
    const result = run(['--db', dbPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /record\s+longstone\.wallet\.v1\s+ok/);
  });

  it('reports the storage layout in --json output', () => {
    const dbPath = tempDbPath();
    writeDb(dbPath, [[CONTAINER_KEY, containerValue([[RECORD_KEY, storedRecord()]])]]);
    const result = run(['--db', dbPath, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.layout, 'container');
    assert.equal(parsed.ok, true);
  });

  it('keeps the --json shape when the database cannot be opened', () => {
    const result = run(['--db', path.join(tmpdir(), 'does-not-exist.vscdb'), '--json']);
    assert.equal(result.status, 2);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.layout, 'unknown');
    assert.equal(parsed.ok, false);
    assert.equal(parsed.exitCode, 2);
    assert.ok(parsed.failures.length > 0);
  });

  it('exits 1 for a validation failure', () => {
    const dbPath = tempDbPath();
    writeDb(dbPath, [[RECORD_KEY, 'not json']]);
    assert.equal(run(['--db', dbPath]).status, 1);
  });

  it('exits 2 for an environment or usage error', () => {
    assert.equal(run(['--db', path.join(tmpdir(), 'does-not-exist.vscdb')]).status, 2);
    assert.equal(run(['--nope']).status, 2);
  });
});
