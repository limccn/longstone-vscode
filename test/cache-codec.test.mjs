import assert from 'node:assert/strict';
import test from 'node:test';

import { deserializeCache, serializeCache } from '../src/shared/cache-codec.ts';

const record = {
  kind: 'committed',
  blockNumber: 20n,
  logIndex: 0,
  txHash: `0x${'33'.repeat(32)}`,
  owner: `0x${'22'.repeat(20)}`,
  commitmentHash: `0x${'44'.repeat(32)}`,
  commitment: {
    owner: `0x${'22'.repeat(20)}`,
    contentHash: `0x${'55'.repeat(32)}`,
    cidDigest: `0x${'66'.repeat(32)}`,
    signer: `0x${'99'.repeat(20)}`,
    blockHeight: 20n,
    op: 0,
    prev: `0x${'00'.repeat(32)}`,
  },
  tags: ['alpha'],
};

test('bigint values round-trip through the cache codec', () => {
  const payload = { records: [record], signers: [], scannedTo: '42', owner: `0x${'11'.repeat(20)}` };
  const restored = deserializeCache(serializeCache(payload));
  assert.ok(restored);
  assert.equal(restored.scannedTo, '42');
  assert.equal(restored.records[0].blockNumber, 20n);
  assert.equal(restored.records[0].commitment.blockHeight, 20n);
  assert.equal(restored.records[0].tags[0], 'alpha');
});

test('a chain-shaped object cannot impersonate a revived bigint', () => {
  const hostile = JSON.stringify({
    records: [{ kind: 'committed', blockNumber: { __bigint: '1', extra: 'x' } }],
    signers: [],
    scannedTo: '1',
    owner: '',
  });
  const restored = deserializeCache(hostile);
  assert.ok(restored);
  // Two keys => not revived; it stays a plain object (the type cast is the
  // caller's risk, exactly as with any cache-payload cast).
  assert.deepEqual(restored.records[0].blockNumber, { __bigint: '1', extra: 'x' });
});

test('malformed or foreign cache state is rejected, not thrown on', () => {
  for (const raw of [undefined, null, 42, '', 'not json', '[]', '{"records":1}', '{"records":[],"signers":[],"scannedTo":"-1"}']) {
    assert.equal(deserializeCache(raw), null, String(raw));
  }
});

test('an absent owner defaults to empty', () => {
  const restored = deserializeCache('{"records":[],"signers":[],"scannedTo":"7"}');
  assert.ok(restored);
  assert.equal(restored.owner, '');
});
