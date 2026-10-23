/**
 * Webview-side state helpers.
 *
 * Persistence uses `acquireVsCodeApi().setState`, which VS Code keeps for the
 * life of the panel's webview (including hide/show and HTML reloads). It is a
 * cache, not a source of truth: losing it only means scanning again.
 */

import {
  deriveIndex,
  type ChainIndex,
  type MemoryEventRecord,
  type SignerRecord,
} from '@limccn/longstone-surface';

import type { CachePayload } from '../shared/cache-codec.ts';

export type PersistedState = CachePayload<MemoryEventRecord, SignerRecord>;

export interface VsCodeApi {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
}

declare global {
  // Injected by VS Code into every webview before any script runs.
  var acquireVsCodeApi: (() => VsCodeApi) | undefined;
}

export function api(): VsCodeApi {
  if (typeof acquireVsCodeApi !== 'function') {
    throw new Error('acquireVsCodeApi is only available inside a VS Code webview');
  }
  return acquireVsCodeApi();
}

/** Build the chain index from cached records plus a freshly scanned tail. */
export function mergeIndex(
  cached: PersistedState | null,
  fresh: { records: MemoryEventRecord[]; signers: SignerRecord[]; scannedTo: bigint },
  owner: string,
): { index: ChainIndex; next: PersistedState } {
  const records = [...(cached?.records ?? []), ...fresh.records];
  const signers = [...(cached?.signers ?? []), ...fresh.signers];
  const next: PersistedState = {
    records,
    signers,
    scannedTo: fresh.scannedTo.toString(),
    owner,
  };
  return { index: deriveIndex(records, fresh.scannedTo, signers), next };
}
