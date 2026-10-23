import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SETTINGS,
  connectOriginsFor,
  validateEndpointUrl,
  validateRegistryAddress,
  validateSettings,
} from '../src/shared/settings.ts';
import {
  ALLOWED_EXTERNAL_HOSTS,
  BLOCKSCOUT_ORIGIN,
  WEB_APP_BASE,
} from '../src/shared/constants.ts';

test('endpoint URLs require https', () => {
  for (const url of [
    'https://sepolia.base.org',
    'https://gateway.pinata.cloud/ipfs',
    'https://rpc.example.com:8545',
  ]) {
    assert.deepEqual(validateEndpointUrl(url, { allowEmpty: false }), { ok: true, value: url });
  }
});

test('plain http is accepted on loopback only', () => {
  for (const url of [
    'http://localhost:8545',
    'http://127.0.0.1:8545',
    'http://127.0.0.53:1234',
    'http://[::1]:8545',
    'http://node.localhost:8545',
  ]) {
    const check = validateEndpointUrl(url, { allowEmpty: false });
    assert.equal(check.ok, true, url);
  }
  for (const url of ['http://example.com', 'http://sepolia.base.org', 'http://10.0.0.1:8545']) {
    const check = validateEndpointUrl(url, { allowEmpty: false });
    assert.equal(check.ok, false, url);
    assert.match(check.error, /loopback/);
  }
});

test('non-http schemes are rejected', () => {
  for (const url of ['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'vscode://x']) {
    assert.equal(validateEndpointUrl(url, { allowEmpty: false }).ok, false, url);
  }
});

test('endpoint URLs must not embed credentials, queries or fragments', () => {
  assert.match(validateEndpointUrl('https://user:pass@example.com', { allowEmpty: false }).error, /credentials/);
  assert.match(validateEndpointUrl('https://example.com/rpc?key=1', { allowEmpty: false }).error, /query/);
  assert.match(validateEndpointUrl('https://example.com/rpc#x', { allowEmpty: false }).error, /fragment/);
});

test('percent-encoded host characters that would break the CSP origin are rejected', () => {
  // `new URL` decodes these into the hostname; CSP interpolation must never
  // see a directive separator or quote from a settings value.
  for (const bad of [
    'https://evil.com%22',
    'https://evil.com%3B',
    'https://evil.com%27',
    'https://evil.com%2C',
    'https://evil.com%60',
  ]) {
    const check = validateEndpointUrl(bad, { allowEmpty: false });
    assert.equal(check.ok, false, bad);
    assert.match(check.error, /host/, bad);
  }
});

test('a key-shaped value is rejected in every URL field', () => {
  const key = `https://example.com/${'0x' + 'ab'.repeat(32)}`;
  const check = validateEndpointUrl(key, { allowEmpty: false });
  assert.equal(check.ok, false);
  assert.match(check.error, /key material/);
});

test('trailing slashes are trimmed so paths concatenate correctly', () => {
  const check = validateEndpointUrl('https://gateway.pinata.cloud/ipfs///', { allowEmpty: false });
  assert.deepEqual(check, { ok: true, value: 'https://gateway.pinata.cloud/ipfs' });
});

test('an empty URL is allowed only where emptiness is meaningful', () => {
  assert.deepEqual(validateEndpointUrl('   ', { allowEmpty: true }), { ok: true, value: '' });
  assert.equal(validateEndpointUrl('', { allowEmpty: false }).ok, false);
  assert.equal(validateEndpointUrl(undefined, { allowEmpty: true }).ok, false);
});

test('registry addresses must be 0x + 40 hex', () => {
  assert.deepEqual(validateRegistryAddress('0xC85ed11d3065739F1829A114e420584bEC3FDFEF', { allowEmpty: false }), {
    ok: true,
    value: '0xC85ed11d3065739F1829A114e420584bEC3FDFEF',
  });
  for (const bad of [
    'C85ed11d3065739F1829A114e420584bEC3FDFEF',
    '0xC85ed11d3065739F1829A114e420584bEC3FD',
    '0xC85ed11d3065739F1829A114e420584bEC3FDFEF00',
    '0xzz5ed11d3065739F1829A114e420584bEC3FDFEF',
    '0x',
  ]) {
    assert.equal(validateRegistryAddress(bad, { allowEmpty: false }).ok, false, bad);
  }
  assert.deepEqual(validateRegistryAddress('', { allowEmpty: true }), { ok: true, value: '' });
});

test('validateSettings falls back to defaults and reports each bad field once', () => {
  const { settings, issues } = validateSettings({
    rpcUrl: 'http://example.com',
    registryAddress: 'nope',
    ipfsGateway: 'https://gw.example.com',
    hisaishiUrl: '',
    allowWriteTools: 'yes',
  });
  assert.equal(settings.rpcUrl, DEFAULT_SETTINGS.rpcUrl);
  assert.equal(settings.registryAddress, DEFAULT_SETTINGS.registryAddress);
  assert.equal(settings.ipfsGateway, 'https://gw.example.com');
  assert.equal(settings.hisaishiUrl, '');
  assert.equal(settings.allowWriteTools, false);
  assert.deepEqual(
    issues.map((issue) => issue.key).sort(),
    ['longstone.allowWriteTools', 'longstone.registryAddress', 'longstone.rpcUrl'],
  );
});

test('write tools are off unless the value is literally true', () => {
  for (const value of [undefined, null, 'true', 1, {}, []]) {
    const raw = value === undefined ? {} : { allowWriteTools: value };
    assert.equal(validateSettings(raw).settings.allowWriteTools, false, JSON.stringify(value));
  }
  assert.equal(validateSettings({ allowWriteTools: true }).settings.allowWriteTools, true);
});

test('validateSettings tolerates non-object input', () => {
  for (const raw of [undefined, null, 42, 'x', [], true]) {
    const { settings, issues } = validateSettings(raw);
    assert.deepEqual(settings, DEFAULT_SETTINGS);
    assert.deepEqual(issues, []);
  }
});

test('connect-src origins are origin-only, deduplicated, and skip empties', () => {
  const origins = connectOriginsFor({
    rpcUrl: 'https://sepolia.base.org/path',
    registryAddress: '0x' + '11'.repeat(20),
    ipfsGateway: 'https://sepolia.base.org/ipfs',
    hisaishiUrl: '',
    allowWriteTools: false,
  });
  assert.deepEqual(origins, ['https://sepolia.base.org']);
});

test('connect-src keeps a non-default port', () => {
  const origins = connectOriginsFor({
    rpcUrl: 'http://localhost:8545',
    registryAddress: '',
    ipfsGateway: 'https://gateway.pinata.cloud/ipfs',
    hisaishiUrl: '',
    allowWriteTools: false,
  });
  assert.deepEqual(origins.sort(), ['http://localhost:8545', 'https://gateway.pinata.cloud']);
});

test('no key setting exists in the schema defaults', () => {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    assert.doesNotMatch(key, /key|secret|mnemonic|private/i, key);
  }
});

test('external-link allowlist and deep-link bases are fixed https origins', () => {
  for (const url of [WEB_APP_BASE, BLOCKSCOUT_ORIGIN]) {
    assert.equal(new URL(url).protocol, 'https:');
    assert.equal(new URL(url).search, '');
  }
  assert.deepEqual(
    [...ALLOWED_EXTERNAL_HOSTS].sort(),
    ['base-sepolia.blockscout.com', 'longstone-ui.pages.dev'],
  );
});
