/** QuickPick menus and account label/delete rules (design §7.4, ux-flows §5). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  accountActionItems,
  accountQuickPickItems,
  confirmDelete,
  deleteConfirmationMessage,
  exportKindItems,
  manageEmptyItems,
  manageLockedItems,
  manageUnlockedItems,
  pickExportKind,
  pickImportKind,
  promptAccountLabel,
  DELETE_CONFIRM_LABEL,
} from '../src/host/wallet/account-menu.ts';

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const SECOND = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

function account(overrides = {}) {
  return {
    id: 'a'.repeat(32),
    address: ADDRESS,
    label: 'Main',
    source: 'created',
    active: true,
    ...overrides,
  };
}

describe('accountQuickPickItems', () => {
  it('truncates the address and marks the active account', () => {
    const items = accountQuickPickItems([
      account(),
      account({ id: 'b'.repeat(32), address: SECOND, label: 'Work', source: 'private-key', active: false }),
    ]);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      kind: 'account',
      accountId: 'a'.repeat(32),
      label: 'Main',
      description: '0x1234…5678 · active',
      detail: 'Created',
    });
    assert.equal(items[1].description, '0xabcd…abcd');
    assert.equal(items[1].detail, 'Imported');
    assert.equal(items[0].description.includes(ADDRESS), false);
  });

  it('maps mnemonic imports to Imported', () => {
    const [item] = accountQuickPickItems([account({ source: 'mnemonic' })]);
    assert.equal(item.detail, 'Imported');
  });
});

describe('menus', () => {
  it('shows accounts then actions in the unlocked menu', () => {
    const items = manageUnlockedItems([account()]);
    assert.deepEqual(
      items.map((item) => (item.kind === 'account' ? `account:${item.label}` : item.action)),
      ['account:Main', 'addAccount', 'changePassword', 'lock', 'reset'],
    );
  });

  it('never includes account data in the locked menu', () => {
    const items = manageLockedItems();
    assert.deepEqual(items.map((item) => item.action), ['unlock', 'changePassword', 'reset']);
    assert.equal(JSON.stringify(items).includes('0x'), false);
  });

  it('offers create and import when no vault exists', () => {
    assert.deepEqual(
      manageEmptyItems().map((item) => [item.action, item.label]),
      [
        ['create', 'Create a new wallet'],
        ['import', 'Import an existing wallet'],
      ],
    );
  });

  it('lists the five account actions', () => {
    assert.deepEqual(
      accountActionItems().map((item) => item.action),
      ['copyAddress', 'setActive', 'rename', 'exportSecret', 'delete'],
    );
  });
});

describe('import and export kinds', () => {
  it('maps the import choice back to a secret kind', async () => {
    const kind = await pickImportKind(async (items) => items[1]);
    assert.equal(kind, 'privateKey');
    const cancelled = await pickImportKind(async () => undefined);
    assert.equal(cancelled, undefined);
  });

  it('offers phrase and derived key for a created account', () => {
    const items = exportKindItems(account());
    assert.deepEqual(items.map((item) => item.value), ['mnemonic', 'privateKey']);
    assert.match(items[1].description, /Derived at m\/44'\/60'\/0'\/0\/0/);
  });

  it('only offers the key for a private-key account and skips the picker', async () => {
    const items = exportKindItems(account({ source: 'private-key' }));
    assert.deepEqual(items.map((item) => item.value), ['privateKey']);
    assert.equal(await pickExportKind(async () => undefined, items), 'privateKey');
  });
});

describe('promptAccountLabel', () => {
  it('sanitizes control, bidi and zero-width characters', async () => {
    const specs = [];
    const result = await promptAccountLabel(
      async (spec) => {
        specs.push(spec);
        return '  Ma‮in​  ';
      },
      'Old',
      2,
    );
    assert.deepEqual(result, { kind: 'ok', value: 'Main' });
    assert.equal(specs[0].value, 'Old');
    assert.equal(specs[0].password, false);
    assert.equal(specs[0].ignoreFocusOut, false);
  });

  it('turns an empty label into Account N', async () => {
    const result = await promptAccountLabel(async () => '   ', 'Old', 3);
    assert.deepEqual(result, { kind: 'ok', value: 'Account 3' });
  });

  it('rejects labels over 64 codepoints', async () => {
    const result = await promptAccountLabel(async () => 'a'.repeat(65), 'Old', 1);
    assert.equal(result.kind, 'invalid');
    assert.match(result.message, /64 characters/);
  });

  it('returns cancellation', async () => {
    assert.deepEqual(await promptAccountLabel(async () => undefined, 'Old', 1), {
      kind: 'cancelled',
    });
  });
});

describe('delete confirmation', () => {
  it('includes the last-account whole-wallet warning only when last', () => {
    const normal = deleteConfirmationMessage('Main', false);
    assert.match(normal, /Delete “Main”\?/);
    assert.equal(normal.includes('last account'), false);

    const last = deleteConfirmationMessage('Main', true);
    assert.match(last, /This is the last account\. Deleting it deletes the entire wallet\./);
    assert.match(last, /cannot be undone/);
  });

  it('requires the modal Delete answer', async () => {
    const calls = [];
    const answered = await confirmDelete(
      async (message, options, ...items) => {
        calls.push({ message, options, items });
        return DELETE_CONFIRM_LABEL;
      },
      'Main',
      true,
    );
    assert.equal(answered, true);
    assert.equal(calls[0].options.modal, true);
    assert.deepEqual(calls[0].items, [DELETE_CONFIRM_LABEL, 'Cancel']);

    const declined = await confirmDelete(async () => undefined, 'Main', false);
    assert.equal(declined, false);
  });
});
