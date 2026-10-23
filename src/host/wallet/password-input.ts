/**
 * Native password and text prompts for the wallet flows (design §7.1, §8).
 *
 * `vscode.window.showInputBox` is injected as a plain function so this module
 * runs under `node --test`. Every prompt is `ignoreFocusOut: false`: losing
 * the window cancels the input, which is what the lock-on-blur rule expects.
 *
 * Validation is routed through the shared core's password policy (NFC
 * normalization, codepoint length, confirmation match). Returning copy never
 * includes the value the user typed.
 */
import { isCommonPassword, validateNewPassword } from '@limccn/longstone-wallet';

import { walletErrorMessage } from './errors.ts';

/** The subset of `vscode.InputBoxOptions` this module uses. */
export interface WalletInputBoxSpec {
  readonly prompt: string;
  readonly password?: boolean;
  readonly ignoreFocusOut?: boolean;
  readonly value?: string;
  readonly placeHolder?: string;
  readonly validateInput?: (value: string) => string | undefined;
}

/** `vscode.window.showInputBox`; resolves `undefined` when the user cancels. */
export type WalletShowInputBox = (
  spec: WalletInputBoxSpec,
) => Promise<string | undefined>;

export type InputPromptResult =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'invalid'; readonly message: string };

export const DEFAULT_PASSWORD_PROMPT = 'Wallet password';
export const DEFAULT_CONFIRM_PROMPT = 'Confirm password';
export const WEAK_PASSWORD_WARNING =
  'This password is easy to guess. Use a stronger one if you can.';
export const WEAK_PASSWORD_CONFIRM = 'Use anyway';
export const WEAK_PASSWORD_REJECT = 'Choose another';

export interface PromptPasswordOptions {
  readonly prompt: string;
  /** Inline validator; return safe copy, never the value. */
  readonly validate?: (value: string) => string | undefined;
}

/** One masked prompt. An empty submission is treated as a cancellation. */
export async function promptPassword(
  showInputBox: WalletShowInputBox,
  options: PromptPasswordOptions,
): Promise<InputPromptResult> {
  const spec: WalletInputBoxSpec = {
    prompt: options.prompt,
    password: true,
    ignoreFocusOut: false,
    ...(options.validate === undefined ? {} : { validateInput: options.validate }),
  };
  const value = await showInputBox(spec);
  if (value === undefined || value === '') return { kind: 'cancelled' };
  const message = options.validate?.(value);
  if (message !== undefined) return { kind: 'invalid', message };
  return { kind: 'ok', value };
}

export interface PromptNewPasswordOptions {
  readonly prompt?: string;
  /**
   * Called when the password is on the common-password list, after length
   * validation. Returning `false` re-prompts. The password is not passed.
   */
  readonly confirmWeak?: () => Promise<boolean>;
}

/**
 * Masked new-password prompt. The shared policy supplies the inline error;
 * the weak-password list is a warning only, never a gate.
 */
export async function promptNewPassword(
  showInputBox: WalletShowInputBox,
  options: PromptNewPasswordOptions = {},
): Promise<InputPromptResult> {
  const prompt = options.prompt ?? DEFAULT_PASSWORD_PROMPT;
  for (;;) {
    const value = await showInputBox({
      prompt,
      password: true,
      ignoreFocusOut: false,
      validateInput(candidate: string): string | undefined {
        if (candidate === '') return undefined; // let cancel/empty resolve
        const validation = validateNewPassword(candidate, candidate);
        return validation.ok ? undefined : walletErrorMessage(validation.code);
      },
    });
    if (value === undefined) return { kind: 'cancelled' };

    const validation = validateNewPassword(value, value);
    if (!validation.ok) {
      return { kind: 'invalid', message: walletErrorMessage(validation.code) };
    }
    if (isCommonPassword(validation.value) && options.confirmWeak !== undefined) {
      const proceed = await options.confirmWeak();
      if (!proceed) continue;
    }
    return { kind: 'ok', value: validation.value };
  }
}

/**
 * Masked confirmation of an already-normalized new password. A mismatch is
 * reported through the shared `CONFIRM_MISMATCH` copy so the caller can
 * restart the pair without writing anything.
 */
export async function promptConfirm(
  showInputBox: WalletShowInputBox,
  expected: string,
  prompt: string = DEFAULT_CONFIRM_PROMPT,
): Promise<InputPromptResult> {
  const value = await showInputBox({
    prompt,
    password: true,
    ignoreFocusOut: false,
    validateInput(candidate: string): string | undefined {
      if (candidate === '') return undefined;
      return candidate.normalize('NFC') === expected
        ? undefined
        : walletErrorMessage('CONFIRM_MISMATCH');
    },
  });
  if (value === undefined) return { kind: 'cancelled' };
  const validation = validateNewPassword(expected, value);
  if (!validation.ok) return { kind: 'invalid', message: walletErrorMessage(validation.code) };
  return { kind: 'ok', value: validation.value };
}

export interface PromptTextOptions {
  readonly prompt: string;
  readonly value?: string;
  readonly placeHolder?: string;
  readonly validate?: (value: string) => string | undefined;
}

/** Plain (unmasked) prompt used for the RESET phrase and account labels. */
export async function promptText(
  showInputBox: WalletShowInputBox,
  options: PromptTextOptions,
): Promise<InputPromptResult> {
  const value = await showInputBox({
    prompt: options.prompt,
    password: false,
    ignoreFocusOut: false,
    ...(options.value === undefined ? {} : { value: options.value }),
    ...(options.placeHolder === undefined ? {} : { placeHolder: options.placeHolder }),
    ...(options.validate === undefined ? {} : { validateInput: options.validate }),
  });
  if (value === undefined) return { kind: 'cancelled' };
  const message = options.validate?.(value);
  if (message !== undefined) return { kind: 'invalid', message };
  return { kind: 'ok', value };
}
