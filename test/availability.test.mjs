/** Remote-window availability (design §5.4, I-7). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { walletAvailability } from '../src/host/wallet/availability.ts';

describe('walletAvailability', () => {
  it('is available in a local window', () => {
    assert.deepEqual(walletAvailability({ remoteName: undefined }), { available: true });
    assert.deepEqual(walletAvailability({ remoteName: null }), { available: true });
    assert.deepEqual(walletAvailability({ remoteName: '' }), { available: true });
    assert.deepEqual(walletAvailability({ remoteName: '   ' }), { available: true });
  });

  it('is unavailable in every remote window kind', () => {
    for (const remoteName of ['ssh-remote', 'wsl', 'dev-container', 'codespaces', 'attached-container']) {
      assert.deepEqual(
        walletAvailability({ remoteName }),
        { available: false, code: 'remote' },
        remoteName,
      );
    }
  });

  it('hides the remote kind from the UI copy', () => {
    const result = walletAvailability({ remoteName: 'ssh-remote+some-host' });
    assert.equal(result.available, false);
    assert.equal(result.code, 'remote');
    assert.equal(Object.keys(result).length, 2);
  });
});
