import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContentSecurityPolicy, cspMetaTag, generateNonce } from '../src/shared/csp.ts';
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts';

const CSP_SOURCE = 'https://file+.vscode-resource.vscode-cdn.net';

function policyFor(overrides = {}, nonce = 'abc123') {
  return buildContentSecurityPolicy({
    cspSource: CSP_SOURCE,
    nonce,
    settings: { ...DEFAULT_SETTINGS, ...overrides },
  });
}

function directive(policy, name) {
  const found = policy.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `));
  assert.ok(found, `missing ${name} in: ${policy}`);
  return found;
}

test('default-src is none and never relaxed', () => {
  const policy = policyFor();
  assert.equal(directive(policy, 'default-src'), "default-src 'none'");
});

test('script-src carries exactly the nonce and no unsafe sources', () => {
  const policy = policyFor({}, 'deadbeef');
  assert.equal(directive(policy, 'script-src'), "script-src 'nonce-deadbeef'");
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.doesNotMatch(directive(policy, 'script-src'), /unsafe-inline/);
});

test('connect-src lists exactly the configured origins', () => {
  const policy = policyFor({
    rpcUrl: 'https://sepolia.base.org',
    ipfsGateway: 'https://gateway.pinata.cloud/ipfs',
    hisaishiUrl: 'https://gateway.example.com/base',
  });
  assert.deepEqual(directive(policy, 'connect-src').split(/\s+/).slice(1).sort(), [
    'https://gateway.example.com',
    'https://gateway.pinata.cloud',
    'https://sepolia.base.org',
  ]);
});

test('connect-src never carries a wildcard or a scheme', () => {
  const policy = policyFor();
  const connect = directive(policy, 'connect-src');
  assert.doesNotMatch(connect, /\*/);
  assert.doesNotMatch(connect, /\shttps:\s/);
  assert.doesNotMatch(connect, /\shttp:\s/);
});

test('loopback http originates are kept as exact origins with their port', () => {
  const policy = policyFor({ rpcUrl: 'http://localhost:8545' });
  assert.match(directive(policy, 'connect-src'), /http:\/\/localhost:8545\b/);
});

test('dangerous directives are closed explicitly', () => {
  const policy = policyFor();
  for (const name of ['object-src', 'frame-src', 'worker-src', 'base-uri', 'form-action', 'media-src']) {
    assert.equal(directive(policy, name), `${name} 'none'`, name);
  }
});

test('style-src allows only the packaged stylesheet; no unsafe-inline', () => {
  const policy = policyFor();
  assert.equal(directive(policy, 'style-src'), `style-src ${CSP_SOURCE}`);
  assert.equal(directive(policy, 'img-src'), `img-src ${CSP_SOURCE} data:`);
});

test('no directive anywhere allows unsafe-inline or unsafe-eval', () => {
  const policy = policyFor();
  assert.doesNotMatch(policy, /unsafe-inline/);
  assert.doesNotMatch(policy, /unsafe-eval/);
});

test('no empty settings produce connect-src without a source', () => {
  const policy = policyFor({ rpcUrl: '', ipfsGateway: '', hisaishiUrl: '' });
  assert.equal(directive(policy, 'connect-src'), "connect-src 'none'");
});

test('nonces are long, hex and unique per call', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const nonce = generateNonce(crypto.getRandomValues(new Uint8Array(16)));
    assert.match(nonce, /^[0-9a-f]{32}$/);
    assert.equal(seen.has(nonce), false, 'nonce repeated');
    seen.add(nonce);
  }
});

test('a short nonce is refused rather than silently weakened', () => {
  assert.throws(() => generateNonce(new Uint8Array(8)), /at least 16/);
});

test('the meta tag is a well-formed, quote-free attribute', () => {
  const tag = cspMetaTag(policyFor());
  assert.match(tag, /^<meta http-equiv="Content-Security-Policy" content="[^"]+">$/);
  assert.throws(() => cspMetaTag(`default-src "x"`), /double quotes/);
});

test('the policy names no remote hosts beyond the configured endpoints', () => {
  const policy = policyFor();
  // The webview CSP source itself is a vscode-cdn.net URL, so match whole
  // third-party hostnames rather than the substring "cdn".
  for (const host of ['googleapis.com', 'cdnjs.cloudflare.com', 'unpkg.com', 'jsdelivr.net', 'esm.sh']) {
    assert.doesNotMatch(policy, new RegExp(host.replace(/\./g, '\\.')), host);
  }
});
