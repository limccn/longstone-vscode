import assert from 'node:assert/strict';
import test from 'node:test';

import {
  afterExplicitStart,
  afterStop,
  cacheForContext,
  captureScanContext,
  isScanStale,
  scanCacheOwner,
  shouldAutoScan,
} from '../src/webview/scan-control.ts';

const IDLE = {
  indexPresent: false,
  registryConfigured: true,
  scanning: false,
  scanError: null,
  autoScanSuppressed: false,
};

test('Stop suppresses the empty-state auto-scan until an explicit start', () => {
  assert.equal(shouldAutoScan(IDLE), true);

  const stopped = { ...IDLE, ...afterStop() };
  assert.equal(stopped.scanning, false);
  assert.equal(stopped.scanProgress, null);
  assert.equal(stopped.autoScanSuppressed, true);
  assert.equal(shouldAutoScan(stopped), false);

  const restarted = { ...stopped, ...afterExplicitStart() };
  assert.equal(restarted.autoScanSuppressed, false);
  assert.equal(shouldAutoScan(restarted), true);
});

test('auto-scan is gated by every other precondition', () => {
  assert.equal(shouldAutoScan({ ...IDLE, scanning: true }), false);
  assert.equal(shouldAutoScan({ ...IDLE, scanError: 'boom' }), false);
  assert.equal(shouldAutoScan({ ...IDLE, indexPresent: true }), false);
  assert.equal(shouldAutoScan({ ...IDLE, registryConfigured: false }), false);
});

test('a mid-scan registry change cannot key the cache to the new registry', () => {
  const context = captureScanContext({
    rpcUrl: 'https://rpc.example-a.test',
    registryAddress: `0x${'11'.repeat(20)}`,
  });
  const changed = {
    rpcUrl: 'https://rpc.example-a.test',
    registryAddress: `0x${'22'.repeat(20)}`,
  };

  assert.equal(isScanStale(context, changed), true);
  assert.equal(isScanStale(context, { ...changed, registryAddress: context.registryAddress }), false);

  // A result is completed under the captured context, not the live settings.
  const completed = {
    records: [],
    signers: [],
    scannedTo: '10',
    owner: scanCacheOwner(context),
  };
  assert.equal(completed.owner, context.registryAddress);
  assert.notEqual(completed.owner, changed.registryAddress);

  // The new registry must not accept the old registry's cache.
  assert.equal(cacheForContext(completed, changed), null);
  assert.equal(cacheForContext(completed, context), completed);
});

test('an RPC change alone also makes the in-flight scan stale', () => {
  const context = captureScanContext({
    rpcUrl: 'https://rpc.example-a.test',
    registryAddress: `0x${'33'.repeat(20)}`,
  });
  assert.equal(
    isScanStale(context, {
      rpcUrl: 'https://rpc.example-b.test',
      registryAddress: context.registryAddress,
    }),
    true,
  );
});
