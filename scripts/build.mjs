#!/usr/bin/env node
/**
 * Build: three esbuild bundles into dist/.
 *
 * - `dist/extension.cjs`      — the extension host (CJS, `vscode` external,
 *   Node). The `.cjs` extension is required because package.json is
 *   `"type": "module"` (Node's TypeScript stripping needs ESM for the `.ts`
 *   test imports) and VS Code loads `main` with `require`; a `.js` file here
 *   would be parsed as ESM. This is the only bundle allowed to contain the
 *   shared wallet core (`@limccn/longstone-wallet`).
 * - `dist/webview.js`         — the memory browser (ESM browser bundle).
 * - `dist/wallet-webview.js`  — the dedicated secret webview. It carries no
 *   host API, no network, and no shared-core code.
 *
 * All builds are `bundle: true`: a webview may not load remote code, and a
 * host bundle that left `node_modules` imports behind would break inside a
 * VSIX that ships no dependencies.
 *
 * Import bans use an exact module specifier match (`from '@limccn/longstone'`
 * / `require('@limccn/longstone')`), never a prefix regex: a prefix would
 * also reject `@limccn/longstone-wallet`, and the host legitimately consumes
 * the wallet core.
 */

import { build } from 'esbuild';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const COMMON = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  absWorkingDir: ROOT,
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
};

const NODE_BUILTIN = /(?:require\(["']node:|from\s*["']node:)/;

/** Exact module-specifier import, safe for names that are prefixes of others. */
function importOf(moduleName) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(?:from\\s*|require\\s*\\(\\s*)["']${escaped}["']`);
}

// The CLI is the only key holder and must never reach a webview.
const CLI_IMPORT = importOf('@limccn/longstone');
// The shared wallet core may only be bundled into the host extension.
const WALLET_CORE_IMPORT = importOf('@limccn/longstone-wallet');

function isNodeBuiltin(bundle) {
  return NODE_BUILTIN.test(bundle);
}

function isEval(bundle) {
  return /\beval\s*\(/.test(bundle);
}

async function buildExtension() {
  await build({
    ...COMMON,
    entryPoints: ['src/host/extension.ts'],
    outfile: 'dist/extension.cjs',
    platform: 'node',
    format: 'cjs',
    // `vscode` is provided by the host at runtime, never bundled.
    external: ['vscode'],
  });
}

async function buildMemoryWebview() {
  await build({
    ...COMMON,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    // The webview must not need the host API at all. Listing it means an
    // accidental import fails the build instead of resolving to undefined.
    external: ['vscode'],
  });

  const bundle = await readFile(path.join(DIST, 'webview.js'), 'utf8');
  const problems = [];
  if (isNodeBuiltin(bundle)) {
    problems.push('a node: builtin is imported by the memory webview bundle');
  }
  if (CLI_IMPORT.test(bundle)) {
    problems.push('the longstone CLI (key holder) is imported by the memory webview bundle');
  }
  if (isEval(bundle)) {
    problems.push('the memory webview bundle contains eval()');
  }
  if (problems.length > 0) {
    throw new Error(`memory webview bundle audit failed:\n- ${problems.join('\n- ')}`);
  }
}

async function buildSecretWebview() {
  await build({
    ...COMMON,
    entryPoints: ['src/wallet-webview/main.ts'],
    outfile: 'dist/wallet-webview.js',
    platform: 'browser',
    format: 'iife',
    // Same rationale as the memory webview: the secret bundle has no host API.
    external: ['vscode'],
  });

  const bundle = await readFile(path.join(DIST, 'wallet-webview.js'), 'utf8');
  const problems = [];
  if (isNodeBuiltin(bundle)) {
    problems.push('a node: builtin is imported by the secret webview bundle');
  }
  if (CLI_IMPORT.test(bundle)) {
    problems.push('the longstone CLI (key holder) is imported by the secret webview bundle');
  }
  if (WALLET_CORE_IMPORT.test(bundle)) {
    problems.push(
      'the shared wallet core is imported by the secret webview bundle (host-only)',
    );
  }
  if (isEval(bundle)) {
    problems.push('the secret webview bundle contains eval()');
  }
  if (/\bfetch\s*\(/.test(bundle)) {
    problems.push('the secret webview bundle contains fetch()');
  }
  if (problems.length > 0) {
    throw new Error(`secret webview bundle audit failed:\n- ${problems.join('\n- ')}`);
  }
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
await buildExtension();
await buildMemoryWebview();
await buildSecretWebview();
process.stdout.write(
  'built dist/extension.cjs, dist/webview.js and dist/wallet-webview.js\n',
);
