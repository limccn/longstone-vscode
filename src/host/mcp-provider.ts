/**
 * MCP server definition provider (design §5.3 / implement C6).
 *
 * Two behaviours are load-bearing and are tested without a VS Code host
 * through the pure helpers below:
 *
 * 1. Read-only by default (PS-2). `LONGSTONE_MCP_READ_ONLY=1` is placed in the
 *    server env unless the user has explicitly enabled `longstone.allowWriteTools`.
 *    This is not cosmetic: the longstone server registers the write tools only
 *    when that variable is absent/`0`, so the provider's env is the mechanism
 *    that keeps an agent from calling `memory_put` through this extension.
 *
 * 2. The definition is fully determined (no interactive input), so VS Code can
 *    start the server without a Webview or prompt. `resolve` only *validates*
 *    that the pinned CLI resolves; it never changes the tool surface.
 */

import {
  LONGSTONE_CLI_VERSION,
  LONGSTONE_PACKAGE,
  MCP_PROVIDER_LABEL,
  OWNER_KEY_ENV,
  READ_ONLY_ENV,
} from '../shared/constants.ts';

export interface ProviderInput {
  /** Value of `longstone.allowWriteTools`. */
  allowWriteTools: boolean;
}

export interface ProviderServer {
  label: string;
  command: string;
  args: string[];
  env: Record<string, string | number | null>;
  version?: string;
}

/** Exact launch arguments; no range, no `latest` (PS-5). */
export const MCP_ARGS: readonly string[] = [
  '-y',
  `${LONGSTONE_PACKAGE}@${LONGSTONE_CLI_VERSION}`,
  'serve',
];

/**
 * Server environment.
 *
 * - Read-only is *set* when writes are disabled and explicitly `'0'` when the
 *   user opts in, so the mode is never inherited from an ambient variable the
 *   user has forgotten about. Longstone treats an unset/`0` value as writable
 *   and any other value as a startup error (fail closed), so `'0'` is the only
 *   correct way to say "writes allowed".
 * - The signing key is inherited from the VS Code process environment. This
 *   object never contains `LONGSTONE_KEY`, and it *removes*
 *   `LONGSTONE_OWNER_KEY` with an explicit `null`.
 *
 * VS Code merges this map over the extension host's environment (entries
 * overwrite, and `null` removes), so omitting the owner key would let an
 * ambient one through. `null` excludes it without the extension ever reading
 * the value; the longstone CLI treats an owner key as an implicit superuser,
 * which this extension must not facilitate (design §5.3).
 */
export function providerEnv(input: ProviderInput): Record<string, string | number | null> {
  return {
    [READ_ONLY_ENV]: input.allowWriteTools ? '0' : '1',
    [OWNER_KEY_ENV]: null,
  };
}

/** The stdio definition supplied to VS Code. */
export function buildServerDefinition(input: ProviderInput): ProviderServer {
  return {
    label: MCP_PROVIDER_LABEL,
    command: 'npx',
    args: [...MCP_ARGS],
    env: providerEnv(input),
    // A version change tells VS Code to offer a tool refresh. It deliberately
    // tracks the read-only setting as well, because that changes the tool list.
    version: `${LONGSTONE_CLI_VERSION}+${input.allowWriteTools ? 'write-on' : 'read-only'}`,
  };
}

/**
 * Report key presence as a boolean. The value is never returned, logged, or
 * placed in a server definition — presence is all the UI may know.
 */
export function keyPresence(env: NodeJS.ProcessEnv): {
  /** `LONGSTONE_KEY` is set and non-empty. */
  keyPresent: boolean;
  /**
   * `LONGSTONE_OWNER_KEY` is set. Named because the extension must never
   * facilitate owner-key use; the value is not read.
   */
  ownerKeyPresent: boolean;
} {
  return {
    keyPresent: (env.LONGSTONE_KEY ?? '') !== '',
    ownerKeyPresent: (env.LONGSTONE_OWNER_KEY ?? '') !== '',
  };
}

/**
 * Arguments for the resolution check.
 *
 * `npx --no-install <pkg> --version` runs only from the local npm cache and
 * fails fast when the pinned version is not present, which is the check
 * `resolveMcpServerDefinition` needs: it must not trigger a network install
 * while the editor is starting a server.
 */
export function resolveProbeArgs(): string[] {
  return ['--no-install', `${LONGSTONE_PACKAGE}@${LONGSTONE_CLI_VERSION}`, '--version'];
}

/**
 * Arguments for the one allowed retry after a cold-cache failure.
 *
 * The launch command itself is `npx -y …`, so a first run on a clean machine
 * *will* fetch the package. Blocking that first run on a cache probe would
 * make the provider unusable until the user had run npx manually, so the
 * probe retries once with `-y` (bounded by a longer timeout) and only fails
 * when that fetch also fails.
 */
export function installProbeArgs(): string[] {
  return ['-y', `${LONGSTONE_PACKAGE}@${LONGSTONE_CLI_VERSION}`, '--version'];
}

/**
 * On Windows `npx` is `npx.cmd`, and Node 24 refuses to spawn a `.cmd` without
 * a shell (`EINVAL`) while a bare `npx` is `ENOENT`. Both failure modes look
 * like "the CLI is missing" to a user, so the probe must use a shell there.
 *
 * With `shell: true` Node concatenates `args` unescaped (DEP0190), so Windows
 * gets ONE constant command line instead of an args array. Every token comes
 * from this module; no user input, setting or chain value is interpolated, so
 * there is nothing to escape.
 */
export function probeSpawnOptions(
  platform: NodeJS.Platform,
  args: readonly string[] = resolveProbeArgs(),
): { command: string; args: string[]; shell: boolean } {
  return platform === 'win32'
    ? { command: ['npx', ...args].join(' '), args: [], shell: true }
    : { command: 'npx', args: [...args], shell: false };
}

export interface ProbeResult {
  ok: boolean;
  /** Present when `ok` is false; safe to show in an error notification. */
  message?: string;
  stdout?: string;
  /**
   * The pinned package is simply not in the npx cache yet. This is the normal
   * first-run state: the server launch (`npx -y …`) would download it, so the
   * host may retry once with `-y` instead of treating it as a hard failure.
   */
  missingFromCache?: boolean;
}

/**
 * Interpret the probe's exit status. Kept pure so the error text is covered
 * by tests: the message must name the exact package and the likely fixes,
 * because "server failed to start" with no detail is the failure mode this
 * check exists to prevent.
 */
export function interpretProbeResult(input: {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}): ProbeResult {
  if (input.timedOut) {
    return {
      ok: false,
      message:
        `Timed out checking ${LONGSTONE_PACKAGE}@${LONGSTONE_CLI_VERSION}. ` +
        `Run \`npx -y ${LONGSTONE_PACKAGE}@${LONGSTONE_CLI_VERSION} --version\` once in a terminal to populate the npm cache.`,
    };
  }
  if (input.code === 0) {
    const version = input.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    if (version !== LONGSTONE_CLI_VERSION) {
      return {
        ok: false,
        message: `\`npx --no-install\` resolved ${LONGSTONE_PACKAGE} to "${version}" instead of ${LONGSTONE_CLI_VERSION}. The provider pins ${LONGSTONE_CLI_VERSION} exactly; clear the npx cache entry or install the pinned version.`,
        stdout: input.stdout,
      };
    }
    return { ok: true, stdout: input.stdout };
  }

  const output = `${input.stderr}\n${input.stdout}`;
  const detail = output.trim().slice(0, 400);
  // npm prints "canceled due to missing packages" (or similar) when
  // --no-install cannot find the package locally. That is not a packaging
  // failure; it is a cold cache. A 404, by contrast, means the pinned version
  // really is not resolvable and retrying would not help.
  const cacheMiss = /canceled due to missing packages|missing packages and no YES option|not installed/i.test(
    output,
  );
  const notFound = /\bE404\b|\b404\b/.test(output);
  return {
    ok: false,
    missingFromCache: cacheMiss && !notFound,
    message:
      `${LONGSTONE_PACKAGE}@${LONGSTONE_CLI_VERSION} does not resolve` +
      (detail === '' ? '' : `: ${detail}`) +
      `. Run \`npx -y ${LONGSTONE_PACKAGE}@${LONGSTONE_CLI_VERSION} --version\` once (or check npm/network access), then retry.`,
    stdout: input.stdout,
  };
}

/** Interpretation for the `-y` retry after a cold-cache probe. */
export function interpretInstallProbeResult(input: {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}): ProbeResult {
  const interpreted = interpretProbeResult(input);
  if (interpreted.ok) return interpreted;
  const detail = `${input.stderr}\n${input.stdout}`.trim().slice(0, 400);
  return {
    ok: false,
    message:
      `Could not fetch ${LONGSTONE_PACKAGE}@${LONGSTONE_CLI_VERSION} with npx` +
      (detail === '' ? '' : `: ${detail}`) +
      '. Check npm/network access, then retry.',
    stdout: input.stdout,
  };
}
