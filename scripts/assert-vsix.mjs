#!/usr/bin/env node
/**
 * Assert the packaged file list (`vsce ls --no-dependencies` output) contains
 * the three bundles, both stylesheets, and no sources, tooling or source maps.
 *
 * Usage:
 *   pnpm exec vsce ls --no-dependencies > vsix-files.txt
 *   node scripts/assert-vsix.mjs vsix-files.txt
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

const file = process.argv[2];
if (file === undefined) {
  process.stderr.write('usage: node scripts/assert-vsix.mjs <vsce-ls-output>\n');
  process.exit(2);
}

const files = readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== '');

const required = [
  'dist/extension.cjs',
  'dist/webview.js',
  'dist/wallet-webview.js',
  'media/webview.css',
  'media/wallet.css',
  'media/icon128x128.png',
  'package.json',
  'README.md',
  'LICENSE',
];
const forbiddenPrefixes = ['src/', 'test/', 'scripts/', 'node_modules/', '.github/'];
const forbiddenExact = ['tsconfig.json', '.vscodeignore', '.gitignore', 'media/icon.png'];

const failures = [];
for (const path of required) {
  if (!files.includes(path)) failures.push(`missing ${path}`);
}
for (const path of forbiddenExact) {
  if (files.includes(path)) failures.push(`must not contain ${path}`);
}
for (const prefix of forbiddenPrefixes) {
  for (const path of files) {
    if (path.startsWith(prefix)) failures.push(`must not contain ${path}`);
  }
}
for (const path of files) {
  if (path.endsWith('.map')) failures.push(`must not contain a source map: ${path}`);
}

if (failures.length > 0) {
  process.stderr.write(`VSIX contents failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}
process.stdout.write(`VSIX contents ok (${files.length} files)\n`);
