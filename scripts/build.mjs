#!/usr/bin/env node
/**
 * Build: two esbuild bundles into dist/.
 *
 * - `dist/extension.cjs` — the extension host (CJS, `vscode` external, Node).
 *   The `.cjs` extension is required because package.json is `"type": "module"`
 *   (Node's TypeScript stripping needs ESM for the `.ts` test imports) and VS
 *   Code loads `main` with `require`; a `.js` file here would be parsed as ESM.
 * - `dist/webview.js`   — the webview (ESM browser bundle, everything inlined
 *   except the `vscode` API, which the webview never imports).
 *
 * Both builds are `bundle: true`: a webview may not load remote code, and a
 * host bundle that left `node_modules` imports behind would break inside a
 * VSIX that ships no dependencies.
 *
 * The script fails if the webview bundle contains a `node:` import or a
 * longstone CLI import, which would mean the read-only panel had picked up a
 * key holder or a Node-only module.
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

async function buildWebview() {
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
  if (/require\(["']node:/.test(bundle) || /from\s*["']node:/.test(bundle)) {
    problems.push('a node: builtin is imported by the webview bundle');
  }
  if (/@limccn\/longstone(?!-surface)/.test(bundle)) {
    problems.push('the longstone CLI (key holder) is imported by the webview bundle');
  }
  if (/\beval\s*\(/.test(bundle)) {
    problems.push('the webview bundle contains eval()');
  }
  if (problems.length > 0) {
    throw new Error(`webview bundle audit failed:\n- ${problems.join('\n- ')}`);
  }
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
await buildExtension();
await buildWebview();
process.stdout.write('built dist/extension.cjs and dist/webview.js\n');
