/**
 * Resolves `@limccn/longstone@<pinned>` for `resolveMcpServerDefinition`.
 *
 * Strategy:
 * 1. `npx --no-install <pkg>@<ver> --version` — fast, no download, and enough
 *    for every machine that has used the CLI before.
 * 2. If (and only if) that fails because the package is not cached yet, retry
 *    once with `npx -y` — exactly what the server launch would do — with a
 *    longer timeout. A clean machine therefore still gets a working server on
 *    first use, while a genuinely unresolvable package (404) fails with a
 *    clear message instead of a process that dies on first request.
 *
 * The result is cached per activation for success only, so a transient failure
 * is retried on the next server start.
 */

import { spawn } from 'node:child_process';

import { OWNER_KEY_ENV } from '../shared/constants.ts';
import {
  installProbeArgs,
  interpretInstallProbeResult,
  interpretProbeResult,
  probeSpawnOptions,
  resolveProbeArgs,
  type ProbeResult,
} from './mcp-provider.ts';

const CACHED_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 180_000;

interface RunInput {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runNpx(
  args: readonly string[],
  timeoutMs: number,
  platform: NodeJS.Platform,
): Promise<RunInput> {
  const spawnSpec = probeSpawnOptions(platform, args);
  return new Promise<RunInput>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const finish = (result: RunInput): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        shell: spawnSpec.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // The probe runs only `--version`; it never needs the owner key. Set
        // it to undefined so Node omits it even when the extension host has
        // one, matching the provider's server environment rule.
        env: { ...process.env, [OWNER_KEY_ENV]: undefined, npm_config_yes: 'false' },
      });
    } catch (error) {
      finish({
        code: null,
        signal: null,
        stdout: '',
        stderr: `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
        timedOut: false,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // `close` waits for the stdio pipes to end. On Windows a cmd.exe shell
      // can exit while its npx/node grandchild keeps those pipes open, so
      // waiting for `close` after a kill can outlive the timeout indefinitely.
      // Destroy the pipes and settle now: a hung fetch must not stall
      // `resolveMcpServerDefinition` forever.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish({ code: null, signal: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    timer.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ code: null, signal: null, stdout, stderr: error.message, timedOut: false });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      finish({ code, signal, stdout, stderr, timedOut });
    });
  });
}

export async function runCliProbe(
  options: { platform?: NodeJS.Platform; timeoutMs?: number; allowFetch?: boolean } = {},
): Promise<ProbeResult> {
  const platform = options.platform ?? process.platform;
  const cached = interpretProbeResult(
    await runNpx(resolveProbeArgs(), options.timeoutMs ?? CACHED_TIMEOUT_MS, platform),
  );
  if (cached.ok || cached.missingFromCache !== true || options.allowFetch === false) {
    return cached;
  }
  // Cold cache: the launch command itself is `npx -y`, so fetching here is
  // the same action, just earlier and with a clear error if it fails.
  return interpretInstallProbeResult(
    await runNpx(installProbeArgs(), FETCH_TIMEOUT_MS, platform),
  );
}
