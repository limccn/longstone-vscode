/** Status-bar presentation and lifecycle (design §7.3, I-4). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createWalletStatusBar,
  truncateAddress,
  walletStatusPresentation,
} from '../src/host/wallet/status-bar.ts';
import {
  COMMAND_WALLET_MANAGE,
  WALLET_STATUS_ICON_UNLOCKED,
  WALLET_STATUS_TEXT_LOCKED,
  WALLET_STATUS_TEXT_NO_VAULT,
  WALLET_STATUS_TOOLTIP_LOCKED,
  WALLET_STATUS_TOOLTIP_NO_VAULT,
  WALLET_STATUS_TOOLTIP_UNLOCKED,
} from '../src/shared/constants.ts';

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

function fakeItem() {
  const calls = [];
  return {
    calls,
    text: '',
    tooltip: undefined,
    command: undefined,
    show() {
      calls.push('show');
    },
    hide() {
      calls.push('hide');
    },
    dispose() {
      calls.push('dispose');
    },
  };
}

describe('truncateAddress', () => {
  it('keeps short values and truncates full addresses', () => {
    assert.equal(truncateAddress('0x1234'), '0x1234');
    assert.equal(truncateAddress('1234567890'), '1234567890');
    assert.equal(truncateAddress(ADDRESS), '0x1234…5678');
  });
});

describe('walletStatusPresentation', () => {
  it('is invisible when the wallet is unavailable', () => {
    assert.deepEqual(walletStatusPresentation({ status: 'UNAVAILABLE' }), { visible: false });
  });

  it('shows the no-vault call to action', () => {
    const presentation = walletStatusPresentation({ status: 'NO_VAULT' });
    assert.deepEqual(presentation, {
      visible: true,
      text: WALLET_STATUS_TEXT_NO_VAULT,
      tooltip: WALLET_STATUS_TOOLTIP_NO_VAULT,
      command: COMMAND_WALLET_MANAGE,
    });
  });

  it('never renders an address, label, or count while locked', () => {
    const presentation = walletStatusPresentation({ status: 'LOCKED' });
    assert.equal(presentation.visible, true);
    assert.equal(presentation.text, WALLET_STATUS_TEXT_LOCKED);
    assert.equal(presentation.tooltip, WALLET_STATUS_TOOLTIP_LOCKED);
    assert.equal(presentation.command, COMMAND_WALLET_MANAGE);
    assert.equal(presentation.text.includes('0x'), false);
    assert.equal('address' in presentation, false);
    assert.equal('accountLabel' in presentation, false);
  });

  it('shows the truncated active address and label while unlocked', () => {
    const presentation = walletStatusPresentation({
      status: 'UNLOCKED',
      address: ADDRESS,
      accountLabel: 'Main',
    });
    assert.deepEqual(presentation, {
      visible: true,
      text: `${WALLET_STATUS_ICON_UNLOCKED} 0x1234…5678`,
      tooltip: `Main · ${WALLET_STATUS_TOOLTIP_UNLOCKED}`,
      command: COMMAND_WALLET_MANAGE,
    });
    assert.equal(presentation.text.includes(ADDRESS), false);
  });
});

describe('createWalletStatusBar', () => {
  it('creates no item at all in an unavailable window', () => {
    let created = 0;
    const statusBar = createWalletStatusBar({
      available: false,
      createItem() {
        created += 1;
        return fakeItem();
      },
    });
    statusBar.update({ status: 'NO_VAULT' });
    statusBar.update({ status: 'UNLOCKED', address: ADDRESS, accountLabel: 'Main' });
    statusBar.dispose();
    assert.equal(created, 0);
  });

  it('drives the item through the four states and disposes once', () => {
    const item = fakeItem();
    let created = 0;
    const statusBar = createWalletStatusBar({
      available: true,
      createItem() {
        created += 1;
        return item;
      },
    });
    assert.equal(created, 1);

    statusBar.update({ status: 'NO_VAULT' });
    assert.equal(item.text, WALLET_STATUS_TEXT_NO_VAULT);
    assert.equal(item.tooltip, WALLET_STATUS_TOOLTIP_NO_VAULT);
    assert.equal(item.command, COMMAND_WALLET_MANAGE);
    assert.deepEqual(item.calls, ['show']);

    statusBar.update({ status: 'LOCKED' });
    assert.equal(item.text, WALLET_STATUS_TEXT_LOCKED);

    statusBar.update({ status: 'UNLOCKED', address: ADDRESS, accountLabel: 'Main' });
    assert.equal(item.text, `${WALLET_STATUS_ICON_UNLOCKED} 0x1234…5678`);
    assert.deepEqual(item.calls, ['show', 'show', 'show']);

    statusBar.update({ status: 'UNAVAILABLE' });
    assert.deepEqual(item.calls, ['show', 'show', 'show', 'hide']);

    statusBar.dispose();
    statusBar.dispose();
    statusBar.update({ status: 'NO_VAULT' });
    assert.deepEqual(item.calls, ['show', 'show', 'show', 'hide', 'dispose']);
  });
});
