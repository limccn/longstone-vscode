import assert from 'node:assert/strict';
import test from 'node:test';

import { WALLET_SECRET_VIEW_TITLE } from '../src/shared/constants.ts';
import {
  buildContentSecurityPolicy,
  buildSecretCsp,
  cspMetaTag,
} from '../src/shared/csp.ts';
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts';
import { renderSecretHtml } from '../src/host/wallet/secret-html.ts';

const CSP_SOURCE = 'https://file+.vscode-resource.vscode-cdn.net';
const NONCE = '0123456789abcdef0123456789abcdef';
const SCRIPT_URI = `${CSP_SOURCE}/ext/dist/wallet-webview.js`;
const STYLE_URI = `${CSP_SOURCE}/ext/media/wallet.css`;

// Public BIP-39 test phrase and a valid secp256k1 scalar (Hardhat #1): neither
// may ever appear in the static shell.
const MNEMONIC_CANARY = 'test test test test test test test test test test test junk';
const PRIVATE_KEY_CANARY = `0x${'ab'.repeat(32)}`;

function directive(policy, name) {
  const parts = policy.split('; ');
  const found = parts.find((part) => part === name || part.startsWith(`${name} `));
  return found ?? null;
}

function renderHtml({
  cspSource = CSP_SOURCE,
  nonce = NONCE,
  scriptUri = SCRIPT_URI,
  styleUri = STYLE_URI,
  title,
} = {}) {
  const args = {
    cspMeta: cspMetaTag(buildSecretCsp({ cspSource, nonce })),
    nonce,
    scriptUri,
    styleUri,
  };
  if (title !== undefined) args.title = title;
  return renderSecretHtml(args);
}

test('secret CSP closes every network and embedding directive', () => {
  const policy = buildSecretCsp({ cspSource: CSP_SOURCE, nonce: NONCE });

  assert.equal(directive(policy, 'default-src'), "default-src 'none'");
  assert.equal(directive(policy, 'script-src'), `script-src 'nonce-${NONCE}'`);
  assert.equal(directive(policy, 'style-src'), `style-src ${CSP_SOURCE}`);
  for (const name of [
    'img-src',
    'font-src',
    'connect-src',
    'media-src',
    'object-src',
    'frame-src',
    'frame-ancestors',
    'worker-src',
    'base-uri',
    'form-action',
  ]) {
    assert.equal(directive(policy, name), `${name} 'none'`, name);
  }

  assert.doesNotMatch(policy, /unsafe-inline/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.doesNotMatch(policy, /\bdata:/);
  assert.doesNotMatch(policy, /https?:\/\/(?!file\+\.vscode-resource)/);
});

test('secret CSP is not the memory-browser CSP', () => {
  const secret = buildSecretCsp({ cspSource: CSP_SOURCE, nonce: NONCE });
  const memory = buildContentSecurityPolicy({
    cspSource: CSP_SOURCE,
    nonce: NONCE,
    settings: DEFAULT_SETTINGS,
  });

  assert.notEqual(secret, memory);
  // Memory allows packaged icons and bundled fonts; secrets allow neither.
  assert.equal(directive(memory, 'img-src'), `img-src ${CSP_SOURCE} data:`);
  assert.equal(directive(secret, 'img-src'), "img-src 'none'");
  assert.equal(directive(memory, 'font-src'), `font-src ${CSP_SOURCE}`);
  assert.equal(directive(secret, 'font-src'), "font-src 'none'");
  // Secret documents are never embeddable; the memory CSP does not set this.
  assert.equal(directive(secret, 'frame-ancestors'), "frame-ancestors 'none'");
  assert.equal(directive(memory, 'frame-ancestors'), null);
});

test('secret CSP rejects a malformed nonce or source instead of sanitizing it', () => {
  assert.throws(() => buildSecretCsp({ cspSource: CSP_SOURCE, nonce: '' }), /nonce/);
  assert.throws(() => buildSecretCsp({ cspSource: CSP_SOURCE, nonce: 'short' }), /nonce/);
  assert.throws(
    () => buildSecretCsp({ cspSource: CSP_SOURCE, nonce: `${NONCE} 0123` }),
    /nonce/,
  );
  assert.throws(
    () => buildSecretCsp({ cspSource: CSP_SOURCE, nonce: `${NONCE}'; connect-src *` }),
    /nonce/,
  );
  assert.throws(() => buildSecretCsp({ cspSource: '', nonce: NONCE }), /source/);
  assert.throws(
    () => buildSecretCsp({ cspSource: 'https://x; connect-src *', nonce: NONCE }),
    /source/,
  );
  assert.throws(
    () => buildSecretCsp({ cspSource: 'https://x y', nonce: NONCE }),
    /source/,
  );
});

test('secret CSP accepts a CSP source list from current VS Code', () => {
  const source = "'self' https://*.vscode-cdn.net";
  const policy = buildSecretCsp({ cspSource: source, nonce: NONCE });
  assert.equal(directive(policy, 'style-src'), `style-src ${source}`);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
});

test('HTML embeds the secret CSP and exactly one nonce-gated script', () => {
  const html = renderHtml();

  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="/);
  for (const fragment of [
    "default-src 'none'",
    "connect-src 'none'",
    "img-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    `'nonce-${NONCE}'`,
  ]) {
    assert.ok(html.includes(fragment), fragment);
  }
  assert.ok(html.includes(`<script nonce="${NONCE}" src="${SCRIPT_URI}"></script>`));
  assert.ok(html.includes(`<link rel="stylesheet" href="${STYLE_URI}">`));
  assert.equal((html.match(/<script\b/gi) ?? []).length, 1);
  assert.equal((html.match(/<link\b/gi) ?? []).length, 1);
});

test('HTML has no inline code, style attributes or event handlers', () => {
  const html = renderHtml();

  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /<script[^>]*>\s*[^<\s]/i);
});

test('HTML references only the csp source and the two resource URIs', () => {
  const html = renderHtml();
  const urls = [...new Set(html.match(/https?:\/\/[^"'\s<>;]+/g) ?? [])].sort();
  assert.deepEqual(urls, [CSP_SOURCE, SCRIPT_URI, STYLE_URI].sort());
});

test('HTML contains no secret material', () => {
  const html = renderHtml();
  assert.equal(html.includes(MNEMONIC_CANARY), false);
  assert.equal(html.includes(PRIVATE_KEY_CANARY), false);
  assert.equal(html.includes("0x59c6995e"), false);
});

test('HTML escapes the title', () => {
  const evilTitle = '<img src=x onerror="alert(1)"> & "quoted"';
  const html = renderHtml({ title: evilTitle });

  assert.ok(
    html.includes(
      '<title>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quoted&quot;</title>',
    ),
  );
  assert.equal(html.includes(evilTitle), false);
});

test('HTML escapes resource URIs in attributes', () => {
  const scriptUri = `${CSP_SOURCE}/ext/dist/wallet-webview.js?v=1&x=2`;
  const html = renderHtml({ scriptUri });
  assert.ok(html.includes(`src="${CSP_SOURCE}/ext/dist/wallet-webview.js?v=1&amp;x=2"`));
});

test('HTML defaults to the panel title and is deterministic', () => {
  const html = renderHtml();
  assert.ok(html.includes(`<title>${WALLET_SECRET_VIEW_TITLE}</title>`));
  assert.equal(renderHtml(), html);
});

test('HTML rejects malformed arguments', () => {
  const base = {
    cspMeta: cspMetaTag(buildSecretCsp({ cspSource: CSP_SOURCE, nonce: NONCE })),
    nonce: NONCE,
    scriptUri: SCRIPT_URI,
    styleUri: STYLE_URI,
  };

  assert.throws(() => renderSecretHtml({ ...base, cspMeta: '<script>alert(1)</script>' }), /cspMeta/);
  assert.throws(
    () => renderSecretHtml({ ...base, cspMeta: base.cspMeta.replace('>', ' >') }),
    /cspMeta/,
  );
  assert.throws(() => renderSecretHtml({ ...base, nonce: 'short' }), /nonce/);
  assert.throws(() => renderSecretHtml({ ...base, nonce: `${NONCE}"` }), /nonce/);
  assert.throws(() => renderSecretHtml({ ...base, scriptUri: '' }), /scriptUri/);
  assert.throws(() => renderSecretHtml({ ...base, scriptUri: 'https://x/a b.js' }), /scriptUri/);
  assert.throws(() => renderSecretHtml({ ...base, styleUri: 'https://x/a".css' }), /styleUri/);
  assert.throws(() => renderSecretHtml({ ...base, styleUri: '<style>' }), /styleUri/);
  assert.throws(() => renderSecretHtml({ ...base, title: 'bad\u0000title' }), /title/);
  assert.throws(() => renderSecretHtml({ ...base, title: 'bad\nline' }), /title/);
});
