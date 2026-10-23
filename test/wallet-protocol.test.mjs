import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_UI_MESSAGE_CODEPOINTS,
  isWebviewActionAllowed,
  parseHostToWebviewMessage,
  parseWebviewToHostMessage,
  utf8ByteLength,
} from '../src/shared/wallet-protocol.ts';

// Public BIP-39 test phrase and a valid secp256k1 scalar (Hardhat #1).
const MNEMONIC = 'test test test test test test test test test test test junk';
const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

function acceptsHost(raw) {
  return parseHostToWebviewMessage(raw) !== null;
}

function acceptsWebview(raw) {
  return parseWebviewToHostMessage(raw) !== null;
}

test('host secret messages accept every valid mode/kind pair', () => {
  const cases = [
    {
      type: 'secret',
      mode: 'create-reveal',
      kind: 'mnemonic',
      value: MNEMONIC,
      address: ADDRESS,
      label: 'Account 1',
    },
    { type: 'secret', mode: 'import', kind: 'mnemonic', label: 'Account 1' },
    { type: 'secret', mode: 'import', kind: 'privateKey' },
    {
      type: 'secret',
      mode: 'reveal-export',
      kind: 'mnemonic',
      value: MNEMONIC,
      address: ADDRESS,
      countdownSeconds: 60,
    },
    {
      type: 'secret',
      mode: 'reveal-export',
      kind: 'privateKey',
      value: PRIVATE_KEY,
      derivationPath: "m/44'/60'/0'/0/0",
      countdownSeconds: 60,
    },
  ];
  for (const raw of cases) {
    assert.deepEqual(parseHostToWebviewMessage(raw), raw, JSON.stringify(raw.mode));
  }
});

test('host error and clear frames are accepted, with no extra fields', () => {
  assert.deepEqual(parseHostToWebviewMessage({ type: 'error', message: 'Nope.' }), {
    type: 'error',
    message: 'Nope.',
  });
  assert.deepEqual(parseHostToWebviewMessage({ type: 'clear' }), { type: 'clear' });
});

test('unknown host types and non-objects are dropped', () => {
  for (const raw of [null, undefined, 42, 'ready', [], { type: 'settings' }, { type: 'secret' }]) {
    assert.equal(parseHostToWebviewMessage(raw), null, JSON.stringify(raw));
  }
});

test('mode/kind pairs and mode-specific payload fields are enforced', () => {
  const rejects = [
    // Creation always shows a mnemonic.
    { type: 'secret', mode: 'create-reveal', kind: 'privateKey', value: PRIVATE_KEY },
    // No countdown and no derivation path in create-reveal.
    { type: 'secret', mode: 'create-reveal', kind: 'mnemonic', value: MNEMONIC, countdownSeconds: 60 },
    {
      type: 'secret',
      mode: 'create-reveal',
      kind: 'mnemonic',
      value: MNEMONIC,
      derivationPath: "m/44'/60'/0'/0/0",
    },
    // Import posts the form shape, never a secret or a derived address.
    { type: 'secret', mode: 'import', kind: 'mnemonic', value: MNEMONIC },
    { type: 'secret', mode: 'import', kind: 'mnemonic', address: ADDRESS },
    {
      type: 'secret',
      mode: 'import',
      kind: 'mnemonic',
      derivationPath: "m/44'/60'/0'/0/0",
    },
    // Reveal always has a countdown; the path only belongs to a private key.
    { type: 'secret', mode: 'reveal-export', kind: 'mnemonic', value: MNEMONIC },
    {
      type: 'secret',
      mode: 'reveal-export',
      kind: 'mnemonic',
      value: MNEMONIC,
      countdownSeconds: 60,
      derivationPath: "m/44'/60'/0'/0/0",
    },
    // Countdown bounds.
    { type: 'secret', mode: 'reveal-export', kind: 'mnemonic', value: MNEMONIC, countdownSeconds: 0 },
    { type: 'secret', mode: 'reveal-export', kind: 'mnemonic', value: MNEMONIC, countdownSeconds: 1.5 },
    { type: 'secret', mode: 'reveal-export', kind: 'mnemonic', value: MNEMONIC, countdownSeconds: '60' },
    // Unknown extra fields.
    { type: 'secret', mode: 'import', kind: 'mnemonic', extra: true },
    { type: 'error', message: 'x', extra: true },
    { type: 'clear', extra: true },
  ];
  for (const raw of rejects) {
    assert.equal(parseHostToWebviewMessage(raw), null, JSON.stringify(raw));
  }
});

test('mnemonic text is bounded by UTF-8 bytes at 1 KiB', () => {
  assert.equal(utf8ByteLength('é'), 2);
  const maxAscii = 'a'.repeat(1024);
  assert.equal(
    parseHostToWebviewMessage({
      type: 'secret',
      mode: 'create-reveal',
      kind: 'mnemonic',
      value: maxAscii,
    })?.value,
    maxAscii,
  );
  const maxMultibyte = 'é'.repeat(512);
  assert.ok(
    acceptsHost({ type: 'secret', mode: 'create-reveal', kind: 'mnemonic', value: maxMultibyte }),
  );
  const oversizedAscii = 'a'.repeat(1025);
  const oversizedMultibyte = 'é'.repeat(513);
  for (const value of [oversizedAscii, oversizedMultibyte]) {
    assert.equal(
      parseHostToWebviewMessage({ type: 'secret', mode: 'create-reveal', kind: 'mnemonic', value }),
      null,
    );
  }
  assert.equal(
    parseHostToWebviewMessage({ type: 'secret', mode: 'create-reveal', kind: 'mnemonic', value: '' }),
    null,
  );
});

test('private keys must be exactly 0x plus 64 hex characters', () => {
  const valid = { type: 'secret', mode: 'reveal-export', kind: 'privateKey', value: PRIVATE_KEY, countdownSeconds: 60 };
  assert.ok(acceptsHost(valid));
  const badValues = [
    `0x${'ab'.repeat(31)}`, // 62 hex
    `0x${'ab'.repeat(32)}ab`, // 66 hex
    `0x${'ab'.repeat(31)}`, // 64 chars total
    '0X' + 'ab'.repeat(32), // wrong prefix
    'ab'.repeat(32), // no prefix
    `0x${'zz'.repeat(32)}`, // non-hex
    '',
  ];
  for (const value of badValues) {
    assert.equal(
      parseHostToWebviewMessage({ ...valid, value }),
      null,
      `accepted private key ${JSON.stringify(value)}`,
    );
  }
});

test('labels are bounded, control-free and never empty', () => {
  const base = { type: 'secret', mode: 'import', kind: 'mnemonic' };
  assert.ok(acceptsHost({ ...base, label: 'a'.repeat(64) }));
  assert.equal(acceptsHost({ ...base, label: 'a'.repeat(65) }), false);
  assert.equal(acceptsHost({ ...base, label: 42 }), false);
  assert.equal(acceptsHost({ ...base, label: '' }), false);
  assert.equal(acceptsHost({ ...base, label: '   ' }), false);
  assert.equal(acceptsHost({ ...base, label: 'bad\u0007label' }), false);
  assert.equal(acceptsHost({ ...base, label: 'bad‮label' }), false);
});

test('addresses and derivation paths are shape-checked', () => {
  const reveal = {
    type: 'secret',
    mode: 'reveal-export',
    kind: 'mnemonic',
    value: MNEMONIC,
    countdownSeconds: 60,
  };
  assert.ok(acceptsHost({ ...reveal, address: ADDRESS }));
  for (const address of ['0x1234', `0x${'ab'.repeat(19)}`, `0x${'gg'.repeat(20)}`, 7]) {
    assert.equal(acceptsHost({ ...reveal, address }), false);
  }
  const privateReveal = {
    type: 'secret',
    mode: 'reveal-export',
    kind: 'privateKey',
    value: PRIVATE_KEY,
    countdownSeconds: 60,
  };
  for (const derivationPath of ['44/0', 'not-a-path', 'm//0', 'm/44x', `m/${'1'.repeat(65)}`, 5]) {
    assert.equal(acceptsHost({ ...privateReveal, derivationPath }), false);
  }
});

test('host error copy is bounded and control-free', () => {
  assert.ok(acceptsHost({ type: 'error', message: 'a'.repeat(MAX_UI_MESSAGE_CODEPOINTS) }));
  assert.equal(
    acceptsHost({ type: 'error', message: 'a'.repeat(MAX_UI_MESSAGE_CODEPOINTS + 1) }),
    false,
  );
  assert.equal(acceptsHost({ type: 'error', message: '' }), false);
  assert.equal(acceptsHost({ type: 'error', message: 'line\nbreak' }), false);
  assert.equal(acceptsHost({ type: 'error', message: 5 }), false);
});

test('webview messages accept the six defined shapes', () => {
  const cases = [
    { type: 'ready' },
    { type: 'copy' },
    { type: 'saved' },
    { type: 'cancel' },
    { type: 'submit-mnemonic', value: MNEMONIC },
    { type: 'submit-private-key', value: PRIVATE_KEY },
  ];
  for (const raw of cases) {
    assert.deepEqual(parseWebviewToHostMessage(raw), raw, raw.type);
  }
});

test('webview messages reject unknown types, extra fields and malformed values', () => {
  const rejects = [
    null,
    [],
    'ready',
    { type: 'hello' },
    { type: 'ready', extra: true },
    { type: 'copy', extra: true },
    { type: 'submit-mnemonic' },
    { type: 'submit-mnemonic', value: 5 },
    { type: 'submit-mnemonic', value: 'a'.repeat(1025) },
    { type: 'submit-mnemonic', value: '' },
    { type: 'submit-private-key', value: `0x${'ab'.repeat(31)}` },
    { type: 'submit-private-key', value: `0x${'ab'.repeat(33)}` },
    { type: 'submit-private-key', value: PRIVATE_KEY, extra: true },
  ];
  for (const raw of rejects) {
    assert.equal(parseWebviewToHostMessage(raw), null, JSON.stringify(raw));
  }
});

test('mode/action pairs follow design §7.5', () => {
  const ready = { type: 'ready' };
  const cancel = { type: 'cancel' };
  const copy = { type: 'copy' };
  const saved = { type: 'saved' };
  const submitMnemonic = { type: 'submit-mnemonic', value: MNEMONIC };
  const submitKey = { type: 'submit-private-key', value: PRIVATE_KEY };

  for (const mode of ['create-reveal', 'import', 'reveal-export']) {
    for (const kind of ['mnemonic', 'privateKey']) {
      assert.equal(isWebviewActionAllowed(mode, kind, ready), true, `${mode}/${kind} ready`);
      assert.equal(isWebviewActionAllowed(mode, kind, cancel), true, `${mode}/${kind} cancel`);
    }
  }

  assert.equal(isWebviewActionAllowed('create-reveal', 'mnemonic', copy), true);
  assert.equal(isWebviewActionAllowed('create-reveal', 'mnemonic', saved), true);
  assert.equal(isWebviewActionAllowed('create-reveal', 'mnemonic', submitMnemonic), false);
  assert.equal(isWebviewActionAllowed('create-reveal', 'mnemonic', submitKey), false);

  assert.equal(isWebviewActionAllowed('import', 'mnemonic', copy), false);
  assert.equal(isWebviewActionAllowed('import', 'mnemonic', saved), false);
  assert.equal(isWebviewActionAllowed('import', 'mnemonic', submitMnemonic), true);
  assert.equal(isWebviewActionAllowed('import', 'mnemonic', submitKey), false);

  assert.equal(isWebviewActionAllowed('import', 'privateKey', submitMnemonic), false);
  assert.equal(isWebviewActionAllowed('import', 'privateKey', submitKey), true);

  assert.equal(isWebviewActionAllowed('reveal-export', 'mnemonic', copy), true);
  assert.equal(isWebviewActionAllowed('reveal-export', 'mnemonic', saved), false);
  assert.equal(isWebviewActionAllowed('reveal-export', 'mnemonic', submitMnemonic), false);
  assert.equal(isWebviewActionAllowed('reveal-export', 'privateKey', submitKey), false);
});
