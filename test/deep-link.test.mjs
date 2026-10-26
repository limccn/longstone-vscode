import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blockscoutAddressUrl,
  blockscoutTxUrl,
  commitmentDeepLink,
  ipfsGatewayUrl,
  isAllowedExternalUrl,
  isCommitmentHash,
  isUriInsideCspSource,
  retractDeepLink,
} from '../src/shared/deep-link.ts';

const HASH = `0x${'ab'.repeat(32)}`;
const ADDRESS = `0x${'12'.repeat(20)}`;

test('a valid commitment hash builds a web-app deep link', () => {
  assert.equal(commitmentDeepLink(HASH), `https://longstone-ui.pages.dev/commitment/${HASH}`);
  assert.equal(retractDeepLink(HASH), `https://longstone-ui.pages.dev/retract?commitment=${HASH}`);
});

test('malformed hashes never produce a link', () => {
  for (const bad of [
    '',
    '0x',
    HASH.slice(0, -2),
    `${HASH}00`,
    HASH.replace('0x', ''),
    `${HASH}/../../evil`,
    `${HASH}?x=1`,
    `${HASH}\n`,
    'javascript:alert(1)',
  ]) {
    assert.equal(commitmentDeepLink(bad), null, JSON.stringify(bad));
    assert.equal(retractDeepLink(bad), null, JSON.stringify(bad));
    assert.equal(isCommitmentHash(bad), false, JSON.stringify(bad));
  }
});

test('path traversal and host injection cannot change the built URL', () => {
  // Even a hash that passes a loose check must be treated as data; these all
  // fail the strict check, so no URL is ever built from them.
  for (const bad of [`${HASH}#@evil.com`, `//evil.com/${HASH}`, `${HASH}%2f..%2f`]) {
    assert.equal(commitmentDeepLink(bad), null, bad);
  }
});

test('explorer URLs validate their input shapes', () => {
  assert.equal(blockscoutTxUrl(HASH), `https://base-sepolia.blockscout.com/tx/${HASH}`);
  assert.equal(blockscoutAddressUrl(ADDRESS), `https://base-sepolia.blockscout.com/address/${ADDRESS}`);
  assert.equal(blockscoutTxUrl(ADDRESS), null);
  assert.equal(blockscoutAddressUrl(HASH), null);
  assert.equal(blockscoutTxUrl(`0x${'11'.repeat(20)}`), null);
});

test('IPFS URLs accept only alphanumeric CIDs', () => {
  assert.deepEqual(ipfsGatewayUrl('https://gw.example.com/ipfs/', 'bafkreiabc'), {
    ok: true,
    url: 'https://gw.example.com/ipfs/bafkreiabc',
  });
  for (const bad of ['../etc/passwd', 'bafkrei/abc', 'baf krei', 'bafkrei?x=1', 'bafkrei#x', '']) {
    assert.equal(ipfsGatewayUrl('https://gw.example.com/ipfs', bad).ok, false, bad);
  }
  assert.equal(ipfsGatewayUrl('', 'bafkreiabc').ok, false);
});

test('openExternal is limited to fixed https hosts', () => {
  assert.equal(isAllowedExternalUrl(`https://longstone-ui.pages.dev/commitment/${HASH}`), true);
  assert.equal(isAllowedExternalUrl(`https://base-sepolia.blockscout.com/tx/${HASH}`), true);

  for (const bad of [
    'http://longstone-ui.pages.dev/',
    'https://longstone-ui.pages.dev.evil.com/',
    'https://evil.com/https://longstone-ui.pages.dev/',
    'https://user:pass@longstone-ui.pages.dev/',
    'https://longstone-ui.pages.dev:8443/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'vscode://settings/longstone.rpcUrl',
    'not a url',
    '',
  ]) {
    assert.equal(isAllowedExternalUrl(bad), false, bad);
  }
});

test('asWebviewUri resources are checked against the CSP source', () => {
  const source = 'https://file+.vscode-resource.vscode-cdn.net';
  assert.equal(
    isUriInsideCspSource(
      'https://file+.vscode-resource.vscode-cdn.net/c%3A/ext/dist/webview.js',
      source,
    ),
    true,
  );
  assert.equal(isUriInsideCspSource('https://evil.example.com/webview.js', source), false);
  assert.equal(isUriInsideCspSource('https://file+.vscode-resource.vscode-cdn.net.evil/x', source), false);
  assert.equal(isUriInsideCspSource('https://file+.vscode-resource.vscode-cdn.net/x', ''), false);
});

test('a wildcard cspSource matches the real webview host', () => {
  // VS Code commonly reports `https://*.vscode-cdn.net`, while
  // `asWebviewUri` resolves to `https://file+....vscode-cdn.net/...`.
  const wildcard = 'https://*.vscode-cdn.net';
  assert.equal(
    isUriInsideCspSource('https://file+.vscode-resource.vscode-cdn.net/c%3A/ext/dist/webview.js', wildcard),
    true,
  );
  assert.equal(isUriInsideCspSource('https://vscode-cdn.net/asset.js', wildcard), false);
  assert.equal(isUriInsideCspSource('https://evil-vscode-cdn.net/asset.js', wildcard), false);
  assert.equal(isUriInsideCspSource('http://file+.vscode-resource.vscode-cdn.net/x', wildcard), false);
});

test('a vscode-webview origin matches exactly', () => {
  const origin = 'vscode-webview://1234-abcd';
  assert.equal(isUriInsideCspSource(`${origin}/dist/webview.js`, origin), true);
  assert.equal(isUriInsideCspSource('vscode-webview://other/dist/webview.js', origin), false);
});

test('a CSP source list from VS Code 1.143 is accepted', () => {
  // 1.143 returns `'self' https://*.vscode-cdn.net` for a desktop webview.
  const source = "'self' https://*.vscode-cdn.net";
  assert.equal(
    isUriInsideCspSource(
      'https://file%2B.vscode-resource.vscode-cdn.net/c%3A/ext/dist/webview.js',
      source,
    ),
    true,
  );
  assert.equal(isUriInsideCspSource('https://evil.example.com/webview.js', source), false);
  // A malformed list is rejected, not partially trusted.
  assert.equal(
    isUriInsideCspSource(
      'https://file+.vscode-resource.vscode-cdn.net/x',
      "'self' https://x; script-src *",
    ),
    false,
  );
});
