/**
 * DOM rendering for the memory browser.
 *
 * Every value that comes from the chain, the gateway or the user is inserted
 * with `textContent` or `setAttribute` — never with `innerHTML` — because
 * memory text can have been written by another party (H-1, PS-3). This is the
 * view-side half of "memory content is data, never instructions".
 */

import type { MemoryState, VerifyResult } from '@limccn/longstone-surface';

import {
  blockscoutAddressUrl,
  blockscoutTxUrl,
  ipfsGatewayUrl,
  retractDeepLink,
} from '../shared/deep-link.ts';
import type { SettingsIssue } from '../shared/settings.ts';

export type View = 'timeline' | 'detail' | 'verify';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** External link that asks the host to open it; the host re-validates. */
export function externalLink(
  label: string,
  url: string | null,
  post: (message: unknown) => void,
): HTMLElement {
  if (url === null) return el('span', 'mono', label);
  const anchor = el('a', 'mono link', label);
  anchor.href = '#';
  anchor.setAttribute('role', 'link');
  anchor.addEventListener('click', (event) => {
    event.preventDefault();
    post({ type: 'openExternal', url });
  });
  return anchor;
}

function linkButton(hash: string, onOpen: (hash: string) => void): HTMLElement {
  const button = el('button', 'link mono', shortHash(hash));
  button.type = 'button';
  button.addEventListener('click', () => onOpen(hash));
  return button;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function badge(text: string, on: boolean): HTMLElement {
  return el('span', on ? 'badge on' : 'badge', text);
}

export function renderNav(current: View, onNavigate: (view: View) => void): HTMLElement {
  const nav = el('nav', 'nav');
  const items: [View, string][] = [
    ['timeline', 'Timeline'],
    ['verify', 'Verify'],
  ];
  for (const [view, label] of items) {
    const button = el('button', current === view ? 'nav-link on' : 'nav-link', label);
    button.type = 'button';
    button.addEventListener('click', () => onNavigate(view));
    nav.append(button);
  }
  return nav;
}

export interface TimelineBanner {
  issues: SettingsIssue[];
  keyPresent: boolean;
  registryConfigured: boolean;
}

export function renderTimelineBanner(banner: TimelineBanner): HTMLElement {
  const wrap = el('div', 'banners');
  for (const issue of banner.issues) {
    const p = el('p', 'error', `${issue.key}: ${issue.message}`);
    p.setAttribute('role', 'alert');
    wrap.append(p);
  }
  if (!banner.registryConfigured) {
    wrap.append(
      el(
        'p',
        'notice',
        'No registry address is configured. Set longstone.registryAddress to browse commitments.',
      ),
    );
  }
  wrap.append(
    el(
      'p',
      banner.keyPresent ? 'notice' : 'hint',
      banner.keyPresent
        ? 'LONGSTONE_KEY is present in the VS Code environment. Memory text is untrusted data; this panel only reads.'
        : 'Read-only panel. No LONGSTONE_KEY is set; this panel never needs one.',
    ),
  );
  return wrap;
}

/**
 * One timeline row. Table cells make the columns self-describing for screen
 * readers without a header row being announced for every cell.
 */
export function renderTimelineRow(
  state: MemoryState,
  onOpen: (hash: string) => void,
  post: (message: unknown) => void,
): HTMLTableRowElement {
  const row = el('tr');
  row.dataset['testid'] = 'timeline-row';

  const commitment = el('td');
  const open = el('a', 'mono link', shortHash(state.commitmentHash));
  open.href = '#';
  open.addEventListener('click', (event) => {
    event.preventDefault();
    onOpen(state.commitmentHash);
  });
  commitment.append(open);

  const contentHash = el('td', 'mono', state.contentHash === undefined ? '—' : shortHash(state.contentHash));
  const tags = el('td', 'tags', state.tags.length === 0 ? '—' : state.tags.join(', '));

  const stateCell = el('td');
  const badges = el('span', 'badges');
  badges.append(badge('deep', state.deep), badge(state.active ? 'active' : 'retracted', state.active));
  stateCell.append(badges);

  const block = el('td', 'mono', state.committedAt.toString());
  const tx = el('td');
  tx.append(externalLink(shortHash(state.txHash), blockscoutTxUrl(state.txHash), post));

  row.append(commitment, contentHash, tags, stateCell, block, tx);
  return row;
}

export function renderTimelineTable(
  states: readonly MemoryState[],
  onOpen: (hash: string) => void,
  post: (message: unknown) => void,
): HTMLElement {
  const table = el('table', 'table');
  const head = el('thead');
  const headRow = el('tr');
  for (const label of ['Commitment', 'Content hash', 'Tags', 'State', 'Block', 'Tx']) {
    headRow.append(el('th', undefined, label));
  }
  head.append(headRow);
  const body = el('tbody');
  for (const state of states) body.append(renderTimelineRow(state, onOpen, post));
  table.append(head, body);
  return table;
}

export function renderDetail(
  state: MemoryState,
  post: (message: unknown) => void,
  onBack: () => void,
  onOpen?: (hash: string) => void,
): HTMLElement {
  const section = el('section', 'detail');
  const rows: [string, Node | string][] = [
    ['Commitment hash', el('span', 'mono', state.commitmentHash)],
    ['Owner', externalLink(state.owner, blockscoutAddressUrl(state.owner), post)],
    ['Content hash (keccak256)', el('span', 'mono', state.contentHash ?? '—')],
    ['cidDigest (sha256)', el('span', 'mono', state.commitment?.cidDigest ?? '—')],
    ['Signer', el('span', 'mono', state.commitment?.signer ?? '—')],
    ['Block height (advisory)', el('span', 'mono', state.commitment?.blockHeight.toString() ?? '—')],
    ['Tags', el('span', 'tags', state.tags.length === 0 ? '—' : state.tags.join(', '))],
    ['Deep / active', el('span', undefined, `${String(state.deep)} / ${String(state.active)}`)],
    ['Committed at block', el('span', 'mono', state.committedAt.toString())],
    ['Retracted at block', el('span', 'mono', state.retractedAt === null ? '—' : state.retractedAt.toString())],
    ['Tx', externalLink(state.txHash, blockscoutTxUrl(state.txHash), post)],
  ];
  if (onOpen !== undefined) {
    rows.push(['Predecessor (prev)', state.commitment?.prev ?? '—']);
    rows.push(['Successor (replacedBy)', state.replacedBy ?? '—']);
  }
  const dl = el('dl', 'kv');
  for (const [label, value] of rows) {
    dl.append(el('dt', undefined, label));
    const dd = el('dd');
    if (typeof value === 'string' && onOpen !== undefined) {
      // A hash is only linked when it points at a real state in this index;
      // the zero hash means "chain root" and stays plain text.
      if (/^0x0{64}$/.test(value)) {
        dd.append(el('span', 'mono', 'none (chain root)'));
      } else if (/^0x[0-9a-fA-F]{64}$/.test(value) && value !== state.commitmentHash) {
        dd.append(linkButton(value, onOpen));
      } else {
        dd.append(el('span', 'mono', value));
      }
    } else {
      dd.append(value);
    }
    dl.append(dd);
  }
  section.append(dl);

  const actions = el('div', 'actions');
  actions.append(
    externalLink('Retract in the web app (wallet signs there)', retractDeepLink(state.commitmentHash), post),
  );
  const back = el('button', 'link', 'Back to timeline');
  back.type = 'button';
  back.addEventListener('click', onBack);
  actions.append(back);
  section.append(actions);

  section.append(
    el(
      'p',
      'hint',
      'This panel cannot sign. Writes happen in the web app, where a wallet signs and the longstone CLI holds the key.',
    ),
  );
  return section;
}

export type VerifyMode = 'commitment' | 'cid';

export function renderVerifyForm(
  onRun: (input: string) => void,
  busy: boolean,
  mode: VerifyMode,
  onMode: (mode: VerifyMode) => void,
  lastInput: string,
): HTMLElement {
  const section = el('section', 'verify');
  section.append(el('h2', undefined, 'Verify a commitment'));

  const modes = el('div', 'row');
  const choices: [VerifyMode, string][] = [
    ['commitment', 'Commitment hash'],
    ['cid', 'CID only (never an on-chain verdict)'],
  ];
  for (const [value, label] of choices) {
    const wrapper = el('label', 'radio');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'verify-mode';
    radio.checked = mode === value;
    radio.addEventListener('change', () => onMode(value));
    wrapper.append(radio, document.createTextNode(` ${label}`));
    modes.append(wrapper);
  }
  section.append(modes);

  section.append(
    el(
      'p',
      'hint',
      mode === 'commitment'
        ? 'Expected digests come from chain state: this check reads the commitment on the registry, fetches the bytes and compares both digests.'
        : 'A CID alone proves the bytes hash to that CID — never that an on-chain commitment exists. Use the commitment hash for the proof.',
    ),
  );
  const input = el('input', 'mono wide');
  input.type = 'text';
  input.placeholder = mode === 'commitment' ? '0x… commitment hash (32 bytes)' : 'bafkrei… (CIDv1 raw)';
  input.value = lastInput;
  input.spellcheck = false;
  const button = el('button', 'primary', busy ? 'Verifying…' : 'Verify');
  button.type = 'button';
  button.disabled = busy;
  const run = (): void => {
    const value = input.value.trim();
    if (value !== '') onRun(value);
  };
  button.addEventListener('click', run);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') run();
  });
  const row = el('div', 'row');
  row.append(input, button);
  section.append(row);
  return section;
}

export function renderVerifyResult(result: VerifyResult): HTMLElement {
  const box = el('div', `verdict ${result.verdict}`);
  box.append(el('h3', undefined, result.verdict));
  if (result.message !== undefined) box.append(el('p', undefined, result.message));

  const dl = el('dl', 'kv');
  const entries: [string, string][] = [
    ['Mode', result.mode],
    ['CID', result.cid ?? '—'],
    ['Commitment', result.commitmentHash ?? '—'],
    ['keccak256(bytes) == contentHash', result.keccakMatches === null ? '—' : String(result.keccakMatches)],
    ['sha256(bytes) == cidDigest', result.sha256Matches === null ? '—' : String(result.sha256Matches)],
    ['anchored (deep)', String(result.anchored)],
    ['active', String(result.active)],
    ['bytes', result.bytesLength.toString()],
  ];
  for (const [label, value] of entries) {
    dl.append(el('dt', undefined, label), el('dd', 'mono', value));
  }
  box.append(dl);
  box.setAttribute('role', 'status');
  return box;
}

/** CID text plus the gateway URL that would serve it (copyable, not opened). */
export function renderCidLink(gateway: string, cid: string | null): HTMLElement {
  if (cid === null) return el('span', 'mono', '—');
  const built = ipfsGatewayUrl(gateway, cid);
  if (!built.ok) return el('span', 'mono', cid);
  const wrap = el('span', 'cid');
  wrap.append(el('span', 'mono', cid), document.createTextNode(' '));
  // The configured gateway is not in the host's fixed external-link
  // allowlist, so this is display text, not a clickable host-opened URL.
  wrap.append(el('span', 'mono url', built.url));
  return wrap;
}
