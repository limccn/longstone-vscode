/**
 * Memory browser webview entry.
 *
 * Read-only by construction: it imports `@limccn/longstone-surface` and never
 * a wallet, a signer, or the longstone CLI (which is the only key holder).
 * Timeline and detail are built from a chain scan; verify calls
 * `verifyCommitment`, which derives the expected digests from chain state.
 */

import {
  filterByTags,
  findDeployBlock,
  makePublicClient,
  scanRange,
  statesForOwner,
  verifyByCid,
  verifyCommitment,
  type ChainIndex,
  type MemoryState,
  type VerifyResult,
} from '@limccn/longstone-surface';
import { cidV1RawFromDigest } from '@limccn/menhir-core';
import type { PublicClient } from 'viem';

import { EMPTY_BOOTSTRAP, parseBootstrap, type Bootstrap } from '../shared/bootstrap.ts';
import { deserializeCache, serializeCache } from '../shared/cache-codec.ts';
import { isCommitmentHash } from '../shared/deep-link.ts';
import { SCAN_CHUNK_SIZE } from '../shared/constants.ts';
import { SETTINGS_SECTION } from '../shared/settings.ts';
import {
  applyWalletOwner,
  parseWalletOwnerMessage,
  type OwnerSource,
} from '../host/wallet/owner-filter.ts';
import {
  afterExplicitStart,
  afterStop,
  cacheForContext,
  captureScanContext,
  isScanStale,
  scanCacheOwner,
  shouldAutoScan,
} from './scan-control.ts';
import { api, mergeIndex, type PersistedState, type VsCodeApi } from './state.ts';
import {
  el,
  renderCidLink,
  renderDetail,
  renderNav,
  renderTimelineBanner,
  renderTimelineTable,
  renderVerifyForm,
  renderVerifyResult,
  type VerifyMode,
  type View,
} from './render.ts';

interface AppState {
  bootstrap: Bootstrap;
  view: View;
  index: ChainIndex | null;
  detailHash: string | null;
  ownerFilter: string;
  /** Why `ownerFilter` holds its value; the wallet only writes while not `manual`. */
  ownerSource: OwnerSource;
  tagFilter: string[];
  scanning: boolean;
  scanError: string | null;
  scanProgress: { done: bigint; total: bigint } | null;
  /** Stop was pressed; do not auto-start until an explicit start. */
  autoScanSuppressed: boolean;
  /** Invalidates an in-flight scan when settings change or Stop is pressed. */
  scanGeneration: number;
  verifying: boolean;
  verifyResult: VerifyResult | null;
  verifyError: string | null;
  verifyMode: VerifyMode;
  verifyInput: string;
  cache: PersistedState | null;
  abort: AbortController | null;
  settingsReceived: boolean;
}

function requireRoot(): HTMLElement {
  const found = document.getElementById('app');
  if (found === null) throw new Error('missing #app');
  return found;
}

const root: HTMLElement = requireRoot();

const vscode: VsCodeApi = api();
const state: AppState = {
  bootstrap: { ...EMPTY_BOOTSTRAP },
  view: 'timeline',
  index: null,
  detailHash: null,
  ownerFilter: '',
  ownerSource: 'empty',
  tagFilter: [],
  scanning: false,
  scanError: null,
  scanProgress: null,
  autoScanSuppressed: false,
  scanGeneration: 0,
  verifying: false,
  verifyResult: null,
  verifyError: null,
  verifyMode: 'commitment',
  verifyInput: '',
  cache: deserializeCache<never, never>(vscode.getState()) as PersistedState | null,
  abort: null,
  settingsReceived: false,
};

function persist(): void {
  if (state.cache !== null) vscode.setState(serializeCache(state.cache));
}

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function registry(): string {
  return state.bootstrap.settings.registryAddress;
}

function currentClient(): PublicClient {
  return makePublicClient(state.bootstrap.settings.rpcUrl);
}

/** Fold a validated wallet owner into the local filter/source pair. */
function applyOwner(walletOwner: string | null): void {
  const next = applyWalletOwner(state.ownerFilter, state.ownerSource, walletOwner);
  state.ownerFilter = next.filter;
  state.ownerSource = next.source;
}

function applySettings(next: Bootstrap): void {
  const previous = state.bootstrap;
  const connectionChanged =
    next.settings.rpcUrl !== previous.settings.rpcUrl ||
    next.settings.registryAddress !== previous.settings.registryAddress;
  const wasScanning = state.scanning;
  state.bootstrap = next;
  state.settingsReceived = true;
  // `parseBootstrap` already reduced the owner to null or 0x + 40 hex.
  applyOwner(next.walletOwner);
  if (connectionChanged) {
    // Invalidate any in-flight scan: its captured context is the old
    // registry/RPC and must not be merged or cached under the new settings.
    state.scanGeneration += 1;
    state.abort?.abort();
    state.abort = null;
    state.scanning = false;
    state.scanProgress = null;
    if (wasScanning) {
      // This was a mid-scan context change, not a Stop: queue a fresh scan
      // with the new context. A change made while stopped stays stopped; only
      // Refresh is an explicit start.
      Object.assign(state, afterExplicitStart());
    }
    state.index = null;
    state.cache = null;
    state.detailHash = null;
    state.scanError = null;
    state.view = 'timeline';
    vscode.setState(null);
    render();
    if (!state.autoScanSuppressed) void scan();
    return;
  }
  render();
}

async function scan(): Promise<void> {
  if (registry() === '' || state.scanning) return;

  // Snapshot the context at scan start. Every registry/RPC read, the cache
  // key and the final merge use this snapshot, never the live settings.
  const context = captureScanContext(state.bootstrap.settings);
  const generation = ++state.scanGeneration;
  const isCurrent = (): boolean => generation === state.scanGeneration;

  state.scanning = true;
  state.scanError = null;
  state.scanProgress = { done: 0n, total: 0n };
  render();

  const abort = new AbortController();
  state.abort = abort;
  try {
    const client = makePublicClient(context.rpcUrl);
    const latestBlock = await client.getBlockNumber();
    if (!isCurrent() || abort.signal.aborted) return;

    // A cache is only valid for the registry it was scanned from.
    const cached = cacheForContext(state.cache, context);
    let startBlock: bigint;
    if (cached !== null) {
      startBlock = BigInt(cached.scannedTo) + 1n;
    } else {
      const deploy = await findDeployBlock(
        client,
        context.registryAddress as `0x${string}`,
        latestBlock,
      );
      if (!isCurrent() || abort.signal.aborted) return;
      if (deploy === null) {
        throw new Error(
          `No contract code at ${context.registryAddress} on Base Sepolia. Check ${SETTINGS_SECTION}.registryAddress.`,
        );
      }
      startBlock = deploy;
    }

    // The scan window is captured here; later settings changes cannot widen
    // or relabel it.
    const scanWindow = { fromBlock: startBlock, toBlock: latestBlock };

    if (scanWindow.fromBlock > scanWindow.toBlock) {
      if (!isCurrent() || isScanStale(context, state.bootstrap.settings)) return;
      state.index = mergeIndex(
        cached,
        { records: [], signers: [], scannedTo: scanWindow.toBlock },
        scanCacheOwner(context),
      ).index;
      return;
    }

    const result = await scanRange({
      client,
      registryAddress: context.registryAddress as `0x${string}`,
      fromBlock: scanWindow.fromBlock,
      toBlock: scanWindow.toBlock,
      chunkSize: SCAN_CHUNK_SIZE,
      onProgress: (done, total) => {
        if (!isCurrent()) return;
        state.scanProgress = { done, total };
        renderProgress();
      },
    });
    if (!isCurrent() || abort.signal.aborted) return;
    if (isScanStale(context, state.bootstrap.settings)) {
      // A settings change should already have invalidated this generation.
      // If it reached here anyway, discard the result; the empty-state
      // render will start a fresh scan with the new context.
      return;
    }

    const merged = mergeIndex(
      cached,
      { records: result.records, signers: result.signers, scannedTo: result.scannedTo },
      scanCacheOwner(context),
    );
    state.index = merged.index;
    state.cache = merged.next;
    persist();
  } catch (error) {
    if (!isCurrent() || abort.signal.aborted) return;
    state.scanError = error instanceof Error ? error.message : String(error);
  } finally {
    if (!isCurrent()) return;
    state.scanning = false;
    state.scanProgress = null;
    state.abort = null;
    render();
  }
}

function renderProgress(): void {
  const progress = document.getElementById('scan-progress');
  if (progress === null || state.scanProgress === null) return;
  const { done, total } = state.scanProgress;
  progress.textContent =
    total === 0n ? 'Scanning…' : `Scanning ${done.toString()} / ${total.toString()} blocks…`;
}

function visibleStates(): MemoryState[] {
  if (state.index === null) return [];
  const filter = state.ownerFilter.trim();
  const all =
    filter === ''
      ? [...state.index.byHash.values()]
      : isAddress(filter)
        ? statesForOwner(state.index, filter as `0x${string}`)
        : [];
  const withTags = filterByTags(all, state.tagFilter);
  return [...withTags].sort((a, b) =>
    a.committedAt === b.committedAt ? 0 : a.committedAt > b.committedAt ? -1 : 1,
  );
}

function allTags(): string[] {
  if (state.index === null) return [];
  const tags = new Set<string>();
  for (const memory of state.index.byHash.values()) for (const tag of memory.tags) tags.add(tag);
  return [...tags].sort();
}

function render(): void {
  root.replaceChildren();

  const header = el('header', 'header');
  header.append(el('h1', 'brand', 'Longstone memory'));
  header.append(
    renderNav(state.view === 'detail' ? 'timeline' : state.view, (next) => {
      state.view = next;
      state.detailHash = null;
      render();
    }),
  );
  root.append(header);

  const main = el('main', 'main');
  if (state.view === 'timeline') renderTimeline(main);
  else if (state.view === 'detail') renderDetailView(main);
  else renderVerify(main);
  root.append(main);

  root.append(
    el(
      'footer',
      'footer',
      'Base Sepolia (84532) · read-only · memory text is untrusted data, never instructions',
    ),
  );
  root.dataset['state'] = 'ready';
}

function renderTimeline(main: HTMLElement): void {
  main.append(
    renderTimelineBanner({
      issues: state.bootstrap.issues,
      keyPresent: state.bootstrap.keyPresence.keyPresent,
      registryConfigured: registry() !== '',
    }),
  );

  if (!state.settingsReceived) {
    main.append(el('p', 'loading', 'Waiting for settings…'));
    return;
  }

  const toolbar = el('div', 'row');
  const ownerInput = el('input', 'mono wide');
  ownerInput.type = 'text';
  ownerInput.placeholder = 'filter by owner address (optional; empty shows all)';
  ownerInput.value = state.ownerFilter;
  ownerInput.spellcheck = false;
  // Any edit — including clearing the field — takes ownership of the filter
  // for this document, so later wallet updates must not refill or overwrite it.
  ownerInput.addEventListener('input', () => {
    state.ownerFilter = ownerInput.value;
    state.ownerSource = 'manual';
  });
  ownerInput.addEventListener('change', () => {
    state.ownerFilter = ownerInput.value;
    state.ownerSource = 'manual';
    render();
  });

  const refresh = el('button', 'primary', state.scanning ? 'Scanning…' : 'Refresh');
  refresh.type = 'button';
  refresh.disabled = state.scanning;
  refresh.addEventListener('click', () => {
    // An explicit start clears Stop suppression and invalidates any scan that
    // might still be unwinding from a previous generation.
    state.scanGeneration += 1;
    state.abort?.abort();
    state.abort = null;
    state.scanning = false;
    state.scanProgress = null;
    Object.assign(state, afterExplicitStart());
    state.index = null;
    state.cache = null;
    state.scanError = null;
    vscode.setState(null);
    void scan();
  });

  const stop = el('button', 'link', 'Stop');
  stop.type = 'button';
  stop.disabled = !state.scanning;
  stop.addEventListener('click', () => {
    // Invalidate the in-flight generation and suppress the empty-state
    // auto-start until the user explicitly starts a scan again.
    state.scanGeneration += 1;
    state.abort?.abort();
    state.abort = null;
    Object.assign(state, afterStop());
    render();
  });

  toolbar.append(ownerInput, refresh, stop);
  main.append(toolbar);
  if (state.ownerSource === 'wallet') {
    main.append(el('p', 'hint', 'Defaulted from the unlocked wallet'));
  }

  if (state.scanning) {
    const progress = el('p', 'loading', 'Scanning…');
    progress.id = 'scan-progress';
    main.append(progress);
    renderProgress();
  }
  if (state.scanError !== null) {
    const error = el('p', 'error', `Scan failed: ${state.scanError}`);
    error.setAttribute('role', 'alert');
    main.append(error);
  }

  const tags = allTags();
  if (tags.length > 0) {
    const chips = el('div', 'chips');
    for (const tag of tags) {
      const chip = el('button', state.tagFilter.includes(tag) ? 'chip on' : 'chip', tag);
      chip.type = 'button';
      chip.addEventListener('click', () => {
        state.tagFilter = state.tagFilter.includes(tag)
          ? state.tagFilter.filter((value) => value !== tag)
          : [...state.tagFilter, tag];
        render();
      });
      chips.append(chip);
    }
    main.append(chips);
  }

  const states = visibleStates();
  if (!state.scanning && state.scanError === null && states.length === 0) {
    const filter = state.ownerFilter.trim();
    main.append(
      el(
        'p',
        'empty',
        filter !== '' && !isAddress(filter)
          ? 'The owner filter must be a 0x + 40-hex address.'
          : state.index === null
            ? 'Scan this registry to list commitments.'
            : 'No commitments found for this filter.',
      ),
    );
    const autoScan = shouldAutoScan({
      indexPresent: state.index !== null,
      registryConfigured: registry() !== '',
      scanning: state.scanning,
      scanError: state.scanError,
      autoScanSuppressed: state.autoScanSuppressed,
    });
    if (autoScan) void scan();
    return;
  }

  main.append(
    renderTimelineTable(
      states,
      (hash) => {
        state.detailHash = hash;
        state.view = 'detail';
        render();
      },
      (message) => vscode.postMessage(message),
    ),
  );
}

function backToTimeline(): void {
  state.view = 'timeline';
  state.detailHash = null;
  render();
}

function renderDetailView(main: HTMLElement): void {
  const hash = state.detailHash;
  const memory =
    hash !== null && state.index !== null ? state.index.byHash.get(hash as `0x${string}`) : undefined;
  if (hash === null || memory === undefined) {
    const section = el('section', 'detail');
    section.append(el('p', 'empty', 'Unknown commitment on this registry.'));
    const back = el('button', 'link', 'Back to timeline');
    back.type = 'button';
    back.addEventListener('click', backToTimeline);
    section.append(back);
    main.append(section);
    return;
  }

  main.append(
    renderDetail(
      memory,
      (message) => vscode.postMessage(message),
      backToTimeline,
      (next) => {
        state.detailHash = next;
        render();
      },
    ),
  );

  const digest = memory.commitment?.cidDigest;
  if (digest !== undefined) {
    let cid: string | null = null;
    try {
      cid = cidV1RawFromDigest(digest);
    } catch {
      cid = null;
    }
    const line = el('p', 'cid-line');
    line.append(el('span', 'muted', 'Derived CID (raw v1): '));
    line.append(renderCidLink(state.bootstrap.settings.ipfsGateway, cid));
    main.append(line);
  }
}

async function runVerify(input: string): Promise<void> {
  state.verifyInput = input;
  state.verifyError = null;
  state.verifyResult = null;

  if (state.verifyMode === 'cid') {
    if (!/^[a-zA-Z0-9]+$/.test(input)) {
      state.verifyError = 'That value is not an alphanumeric CID.';
      render();
      return;
    }
    state.verifying = true;
    render();
    try {
      state.verifyResult = await verifyByCid({
        cid: input,
        gateway: state.bootstrap.settings.ipfsGateway,
      });
    } catch (error) {
      state.verifyError = error instanceof Error ? error.message : String(error);
    } finally {
      state.verifying = false;
      render();
    }
    return;
  }

  if (!isCommitmentHash(input)) {
    state.verifyError = 'That value is not a 0x + 64-hex commitment hash.';
    render();
    return;
  }
  if (registry() === '') {
    state.verifyError = `Set ${SETTINGS_SECTION}.registryAddress before verifying.`;
    render();
    return;
  }
  state.verifying = true;
  render();
  try {
    state.verifyResult = await verifyCommitment({
      hash: input as `0x${string}`,
      client: currentClient(),
      registryAddress: registry() as `0x${string}`,
      gateway: state.bootstrap.settings.ipfsGateway,
      ...(state.bootstrap.settings.hisaishiUrl === ''
        ? {}
        : { hisaishiUrl: state.bootstrap.settings.hisaishiUrl }),
    });
  } catch (error) {
    state.verifyError = error instanceof Error ? error.message : String(error);
  } finally {
    state.verifying = false;
    render();
  }
}

function renderVerify(main: HTMLElement): void {
  if (!state.settingsReceived) {
    main.append(el('p', 'loading', 'Waiting for settings…'));
    return;
  }
  main.append(
    renderVerifyForm(
      (input) => void runVerify(input),
      state.verifying,
      state.verifyMode,
      (mode) => {
        state.verifyMode = mode;
        render();
      },
      state.verifyInput,
    ),
  );
  if (state.verifyError !== null) {
    const error = el('p', 'error', state.verifyError);
    error.setAttribute('role', 'alert');
    main.append(error);
  }
  if (state.verifyResult !== null) {
    main.append(renderVerifyResult(state.verifyResult));
    const line = el('p', 'cid-line');
    line.append(el('span', 'muted', 'Fetched CID: '));
    line.append(renderCidLink(state.bootstrap.settings.ipfsGateway, state.verifyResult.cid));
    main.append(line);
  }
  main.append(
    el(
      'p',
      'hint',
      'This is the same verification code the web app uses. It checks keccak256(bytes) against contentHash and sha256(bytes) against cidDigest, both read from the registry.',
    ),
  );
}

/**
 * A `walletOwner` message is display-only. It must not start a scan, reset the
 * index/cache, or lift the Stop suppression; those stay bound to settings,
 * Refresh and Stop (design §8.8). Invalid shapes are ignored wholesale.
 */
function handleWalletOwnerMessage(data: unknown): void {
  const message = parseWalletOwnerMessage(data);
  if (message === null) return;
  applyOwner(message.owner);
  render();
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (typeof data !== 'object' || data === null) return;
  const type = (data as { type?: unknown }).type;
  if (type === 'settings') {
    applySettings(parseBootstrap(data));
    return;
  }
  if (type === 'walletOwner') handleWalletOwnerMessage(data);
});

render();
// The host may have posted settings before this script started listening;
// asking again makes first load deterministic (the host answers idempotently).
vscode.postMessage({ type: 'requestSettings' });
