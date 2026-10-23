/**
 * Pure scan-state helpers for the memory browser.
 *
 * Kept free of the DOM, `vscode`, and chain imports so the Stop transition
 * and the registry-change invariant can be tested without an extension host.
 */

/** The subset of UI state that decides whether the empty view auto-scans. */
export interface ScanUiState {
  indexPresent: boolean;
  registryConfigured: boolean;
  scanning: boolean;
  scanError: string | null;
  /** Set by Stop; cleared only by an explicit start (Refresh / settings change). */
  autoScanSuppressed: boolean;
}

/**
 * The empty timeline may start a scan automatically only when nothing is
 * running, nothing failed, there is no index yet, a registry is configured,
 * and the user has not pressed Stop.
 */
export function shouldAutoScan(state: ScanUiState): boolean {
  return (
    !state.scanning &&
    state.scanError === null &&
    !state.indexPresent &&
    state.registryConfigured &&
    !state.autoScanSuppressed
  );
}

/** Fields set when the user presses Stop. */
export interface ScanStopState {
  scanning: false;
  scanProgress: null;
  autoScanSuppressed: true;
}

/**
 * Stop is an explicit abort: the in-flight generation is invalidated by the
 * caller, and the empty-state render must not start another scan until the
 * user explicitly starts one.
 */
export function afterStop(): ScanStopState {
  return { scanning: false, scanProgress: null, autoScanSuppressed: true };
}

/** Fields set when the user explicitly starts a scan (Refresh or settings change). */
export interface ScanExplicitStartState {
  autoScanSuppressed: false;
}

export function afterExplicitStart(): ScanExplicitStartState {
  return { autoScanSuppressed: false };
}

/**
 * The settings a scan was started with. The chain client, registry reads and
 * cache key must all use this snapshot, never the live settings, so a settings
 * change cannot relabel records from one registry as another's.
 */
export interface ScanContext {
  rpcUrl: string;
  registryAddress: string;
  /** Cache identity; always the captured registry address. */
  owner: string;
}

export function captureScanContext(settings: {
  rpcUrl: string;
  registryAddress: string;
}): ScanContext {
  return {
    rpcUrl: settings.rpcUrl,
    registryAddress: settings.registryAddress,
    owner: settings.registryAddress,
  };
}

/** True when the live settings no longer match the scan's captured context. */
export function isScanStale(
  context: ScanContext,
  settings: { rpcUrl: string; registryAddress: string },
): boolean {
  return (
    context.rpcUrl !== settings.rpcUrl ||
    context.registryAddress !== settings.registryAddress
  );
}

/** Cache owner for a completed scan: the registry captured at scan start. */
export function scanCacheOwner(context: ScanContext): string {
  return context.owner;
}

/**
 * A cached scan is reusable only for the registry it was produced from. After
 * a registry change the old cache is intentionally ignored, so a scan can
 * never write a cache entry keyed by the new registry.
 */
export function cacheForContext<T extends { owner: string }>(
  cache: T | null,
  context: ScanContext,
): T | null {
  return cache !== null && cache.owner === context.owner ? cache : null;
}
