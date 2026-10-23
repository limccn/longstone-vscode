/** Native password prompts (design §7.1, ux-flows F-1/F-3/F-6). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONFIRM_PROMPT,
  DEFAULT_PASSWORD_PROMPT,
  promptConfirm,
  promptNewPassword,
  promptPassword,
  promptText,
  WEAK_PASSWORD_CONFIRM,
  WEAK_PASSWORD_REJECT,
} from '../src/host/wallet/password-input.ts';
import { walletErrorMessage } from '../src/host/wallet/errors.ts';

function scriptedInputs(values) {
  const specs = [];
  return {
    specs,
    async show(value) {
      return value;
    },
    async showInputBox(spec) {
      specs.push(spec);
      const next = values.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe('promptPassword', () => {
  it('uses a masked, non-ignoring prompt', async () => {
    const inputs = scriptedInputs(['secret-passphrase']);
    const result = await promptPassword(inputs.showInputBox, { prompt: 'Wallet password' });
    assert.deepEqual(result, { kind: 'ok', value: 'secret-passphrase' });
    assert.equal(inputs.specs.length, 1);
    assert.equal(inputs.specs[0].password, true);
    assert.equal(inputs.specs[0].ignoreFocusOut, false);
    assert.equal(inputs.specs[0].prompt, 'Wallet password');
    assert.equal(inputs.specs[0].value, undefined);
    assert.equal(inputs.specs[0].validateInput, undefined);
  });

  it('treats escape and an empty submission as cancellation', async () => {
    assert.deepEqual(
      await promptPassword(scriptedInputs([undefined]).showInputBox, { prompt: 'x' }),
      { kind: 'cancelled' },
    );
    assert.deepEqual(
      await promptPassword(scriptedInputs(['']).showInputBox, { prompt: 'x' }),
      { kind: 'cancelled' },
    );
  });

  it('carries the injected validator into the input box', async () => {
    const inputs = scriptedInputs(['RESET']);
    const result = await promptPassword(inputs.showInputBox, {
      prompt: 'Type RESET',
      validate: (value) => (value === 'RESET' ? undefined : 'Type RESET exactly.'),
    });
    assert.equal(result.kind, 'ok');
    assert.equal(inputs.specs[0].validateInput('nope'), 'Type RESET exactly.');
    assert.equal(inputs.specs[0].validateInput('RESET'), undefined);
  });

  it('re-checks the validator when a fake host ignores it', async () => {
    const result = await promptPassword(scriptedInputs(['wrong']).showInputBox, {
      prompt: 'Type RESET',
      validate: (value) => (value === 'RESET' ? undefined : 'Type RESET exactly.'),
    });
    assert.deepEqual(result, { kind: 'invalid', message: 'Type RESET exactly.' });
  });
});

describe('promptNewPassword', () => {
  it('applies the shared minimum length through the input validator', async () => {
    const inputs = scriptedInputs(['short']);
    const result = await promptNewPassword(inputs.showInputBox);
    assert.deepEqual(result, { kind: 'invalid', message: walletErrorMessage('TOO_SHORT') });
    assert.equal(inputs.specs[0].prompt, DEFAULT_PASSWORD_PROMPT);
    assert.equal(inputs.specs[0].password, true);
    assert.equal(inputs.specs[0].validateInput('short'), walletErrorMessage('TOO_SHORT'));
    assert.equal(inputs.specs[0].validateInput(''), undefined);
  });

  it('normalizes NFC and accepts a long passphrase', async () => {
    const inputs = scriptedInputs(['é'.repeat(8)]);
    const result = await promptNewPassword(inputs.showInputBox, { prompt: 'New password' });
    assert.equal(result.kind, 'ok');
    assert.equal(result.value, 'é'.repeat(8));
    assert.equal(inputs.specs[0].prompt, 'New password');
  });

  it('rejects a password over the maximum length', async () => {
    const inputs = scriptedInputs(['a'.repeat(1025)]);
    const result = await promptNewPassword(inputs.showInputBox);
    assert.deepEqual(result, { kind: 'invalid', message: walletErrorMessage('TOO_LONG') });
  });

  it('asks before accepting a common password and re-prompts when declined', async () => {
    const inputs = scriptedInputs(['password123', 'a much better passphrase']);
    const questions = [];
    const result = await promptNewPassword(inputs.showInputBox, {
      async confirmWeak() {
        questions.push('asked');
        return questions.length > 1;
      },
    });
    assert.equal(result.kind, 'ok');
    assert.equal(result.value, 'a much better passphrase');
    // The second password is not common, so the question is asked once.
    assert.deepEqual(questions, ['asked']);
  });

  it('accepts a common password when the confirmation is accepted', async () => {
    const inputs = scriptedInputs(['password123']);
    const result = await promptNewPassword(inputs.showInputBox, {
      async confirmWeak() {
        return true;
      },
    });
    assert.deepEqual(result, { kind: 'ok', value: 'password123' });
  });

  it('returns cancellation without asking the weak-password question', async () => {
    const inputs = scriptedInputs([undefined]);
    let asked = false;
    const result = await promptNewPassword(inputs.showInputBox, {
      async confirmWeak() {
        asked = true;
        return true;
      },
    });
    assert.deepEqual(result, { kind: 'cancelled' });
    assert.equal(asked, false);
  });
});

describe('promptConfirm', () => {
  it('matches after NFC normalization', async () => {
    const inputs = scriptedInputs(['é'.repeat(8)]);
    const result = await promptConfirm(inputs.showInputBox, 'é'.repeat(8));
    assert.equal(result.kind, 'ok');
    assert.equal(inputs.specs[0].prompt, DEFAULT_CONFIRM_PROMPT);
    assert.equal(inputs.specs[0].password, true);
  });

  it('reports a mismatch with the shared copy', async () => {
    const inputs = scriptedInputs(['different passphrase']);
    const result = await promptConfirm(inputs.showInputBox, 'expected passphrase');
    assert.deepEqual(result, {
      kind: 'invalid',
      message: walletErrorMessage('CONFIRM_MISMATCH'),
    });
    assert.equal(
      inputs.specs[0].validateInput('expected passphrase'),
      undefined,
    );
    assert.equal(
      inputs.specs[0].validateInput('different passphrase'),
      walletErrorMessage('CONFIRM_MISMATCH'),
    );
  });

  it('returns cancellation on escape', async () => {
    assert.deepEqual(
      await promptConfirm(scriptedInputs([undefined]).showInputBox, 'expected passphrase'),
      { kind: 'cancelled' },
    );
  });
});

describe('promptText', () => {
  it('is unmasked, prefilled and validated', async () => {
    const inputs = scriptedInputs(['Account 2']);
    const result = await promptText(inputs.showInputBox, {
      prompt: 'Account label',
      value: 'Account 1',
      placeHolder: 'Account',
      validate: () => undefined,
    });
    assert.deepEqual(result, { kind: 'ok', value: 'Account 2' });
    assert.equal(inputs.specs[0].password, false);
    assert.equal(inputs.specs[0].value, 'Account 1');
    assert.equal(inputs.specs[0].placeHolder, 'Account');
  });

  it('keeps the weak-password copy free of the value', () => {
    assert.equal(WEAK_PASSWORD_CONFIRM, 'Use anyway');
    assert.equal(WEAK_PASSWORD_REJECT, 'Choose another');
  });
});
