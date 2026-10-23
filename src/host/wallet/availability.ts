/**
 * Remote-window availability (design §5.4, I-7).
 *
 * The wallet is local-only: in a remote window the password would leave the
 * machine, and a warning cannot change that. This module is pure so the
 * decision can be tested without `vscode`; the host passes
 * `vscode.env.remoteName`.
 */
export type WalletAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly code: 'remote' };

export interface WalletAvailabilityInput {
  /** `vscode.env.remoteName`; `undefined` in a local window. */
  readonly remoteName: string | undefined;
}

export function walletAvailability(input: WalletAvailabilityInput): WalletAvailability {
  const remoteName = input.remoteName;
  if (remoteName === undefined || remoteName === null || remoteName.trim() === '') {
    return { available: true };
  }
  // Any remote (SSH, WSL, containers, Codespaces) disables the wallet. The code
  // is intentionally coarse: the UI copy is the same for every remote kind.
  return { available: false, code: 'remote' };
}
