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
 *    start the server without a Webview or prompt. The command is the
 *    user-installed `longstone` CLI (or the value of `longstone.cliPath`); this
 *    extension never downloads, installs, or spawns a process. `resolve` only
 *    checks that the configured command exists on disk; VS Code starts it.
 */

import { posix, win32 } from 'node:path';

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
  /** Value of `longstone.cliPath` (the host trims it and falls back to `longstone`). */
  cliPath: string;
}

export interface ProviderServer {
  label: string;
  command: string;
  args: string[];
  env: Record<string, string | number | null>;
  version?: string;
}

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

/**
 * The stdio definition supplied to VS Code.
 *
 * `command` is the user-installed CLI; the only argument is `serve`. There is
 * no package name and no version argument because nothing is fetched at run
 * time. The `version` field only signals a tool-surface change to VS Code.
 */
export function buildServerDefinition(input: ProviderInput): ProviderServer {
  return {
    label: MCP_PROVIDER_LABEL,
    command: input.cliPath,
    args: ['serve'],
    env: providerEnv(input),
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

export interface CliLookupInput {
  /** `longstone.cliPath` value: a bare command or an absolute/relative path. */
  command: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Filesystem predicate; production passes `fs.existsSync`, tests a fake. */
  exists: (candidate: string) => boolean;
}

export type CliLookupResult = { ok: true } | { ok: false; message: string };

/** A message that names both the global install and the escape hatch. */
function missingCliMessage(detail: string): string {
  return (
    `${detail}. Install it with \`npm install -g ${LONGSTONE_PACKAGE}@${LONGSTONE_CLI_VERSION}\`, ` +
    'or set `longstone.cliPath` to its full path.'
  );
}

/**
 * Locate the CLI without executing anything.
 *
 * Pure by construction: the caller supplies the filesystem predicate, so the
 * lookup is a sequence of string operations plus `exists` calls. It never
 * spawns a process, reads a version, or touches the network. `resolve` uses it
 * to avoid handing VS Code a server command that cannot start, while the
 * actual process is still launched by VS Code's MCP client.
 *
 * Resolution rules:
 * - Empty/whitespace command: fail without consulting the filesystem.
 * - Absolute or slash/backslash-containing command: check it directly; on
 *   Windows, a command with no extension also tries every `PATHEXT` variant.
 * - Bare command: check each non-empty `PATH` directory (Windows `PATHEXT`
 *   variants included; surrounding whitespace and quotes on Windows entries are
 *   stripped). `PATH` is preferred over `Path`, matching Node's environment
 *   shape; `process.env` is case-insensitive on Windows anyway.
 */
export function resolveCliCommand(input: CliLookupInput): CliLookupResult {
  const command = input.command.trim();
  if (command === '') {
    return { ok: false, message: missingCliMessage('the configured CLI path is empty') };
  }

  const windows = input.platform === 'win32';
  const pathApi = windows ? win32 : posix;
  const extensions = windows
    ? (input.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((extension) => extension.trim())
        .filter((extension) => extension !== '')
    : [];
  const hasExtension = windows && pathApi.extname(command) !== '';
  const pathLike = pathApi.isAbsolute(command) || command.includes('/') || command.includes('\\');

  const candidates: string[] = [];
  const addCandidates = (base: string): void => {
    candidates.push(base);
    if (!windows) return;
    for (const extension of extensions) candidates.push(`${base}${extension}`);
  };

  if (pathLike) {
    candidates.push(command);
    if (!hasExtension) {
      for (const extension of extensions) candidates.push(`${command}${extension}`);
    }
  } else {
    const rawPath = input.env.PATH ?? input.env.Path ?? '';
    for (const entry of rawPath.split(windows ? ';' : ':')) {
      // Windows accepts quoted PATH entries (common when a directory contains
      // spaces); the quotes are not part of the directory name, and leaving
      // them in would make every joined candidate unmatchable. Ignore
      // surrounding whitespace the same way.
      const directory = windows ? entry.trim().replace(/^"(.*)"$/, '$1') : entry;
      if (directory === '') continue;
      addCandidates(pathApi.join(directory, command));
    }
  }

  for (const candidate of candidates) {
    if (input.exists(candidate)) return { ok: true };
  }
  return { ok: false, message: missingCliMessage(`the CLI "${command}" was not found`) };
}
