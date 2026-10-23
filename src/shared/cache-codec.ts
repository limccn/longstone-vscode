/**
 * Codec for the webview's scan cache.
 *
 * Records and commitments carry `bigint` block numbers, and `JSON.stringify`
 * throws on those. They travel as `{ "__bigint": "<decimal>" }` and are
 * revived only when the object has exactly that single string key, so no
 * chain-provided object can masquerade as a revived bigint.
 *
 * Pure module: no DOM, no `vscode`, no chain imports — the shape of the
 * payload is checked by the tests without an extension host.
 */

const BIGINT_KEY = '__bigint';

export interface CachePayload<TRecord, TSigner> {
  records: TRecord[];
  signers: TSigner[];
  scannedTo: string;
  owner: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function serializeCache<TRecord, TSigner>(state: CachePayload<TRecord, TSigner>): string {
  return JSON.stringify(state, (_key, value: unknown) => {
    if (typeof value === 'bigint') return { [BIGINT_KEY]: value.toString() };
    return value;
  });
}

export function deserializeCache<TRecord, TSigner>(raw: unknown): CachePayload<TRecord, TSigner> | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw, (_key, value: unknown) => {
      if (isRecord(value) && Object.keys(value).length === 1 && typeof value[BIGINT_KEY] === 'string') {
        const digits = value[BIGINT_KEY];
        return /^-?\d+$/.test(digits) ? BigInt(digits) : value;
      }
      return value;
    });
    if (!isRecord(parsed)) return null;
    const { records, signers, scannedTo, owner } = parsed;
    if (!Array.isArray(records) || !Array.isArray(signers)) return null;
    if (typeof scannedTo !== 'string' || !/^\d+$/.test(scannedTo)) return null;
    return {
      records: records as TRecord[],
      signers: signers as TSigner[],
      scannedTo,
      owner: typeof owner === 'string' ? owner : '',
    };
  } catch {
    return null;
  }
}
