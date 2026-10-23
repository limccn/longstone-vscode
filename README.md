# Longstone Memory for VS Code

A VS Code extension with three capabilities:

1. **An MCP server provider.** Copilot Chat (or any MCP host in VS Code) gains
   the Longstone memory tools with no JSON to write. The provider starts
   `npx -y @limccn/longstone@0.1.1 serve` and, by default, sets
   `LONGSTONE_MCP_READ_ONLY=1`, so only `memory_get`, `memory_verify` and
   `memory_stage_status` are registered.
2. **A memory browser panel.** Timeline, commitment detail and verification,
   rendered inside the editor from the same `@limccn/longstone-surface`
   package the web app uses. The browser is read-only.
3. **A local encrypted wallet.** Key management and addresses only: create or
   import Base Sepolia EOAs, protect them with one vault password, manage
   accounts, and export a secret after re-entering the password. The wallet is
   **local-only** (it refuses to run in remote windows), **never signs**,
   never sends a transaction, and never connects to a dApp. Its secrets are
   never injected into the MCP server environment.

Longstone stores durable agent memory on Base Sepolia. The memory browser is a
**viewer**; the wallet manages keys locally, and its only interaction with the
browser is a temporary owner-filter default while it is unlocked (it writes no
setting).

> **M1 status: Base Sepolia only (chain id 84532), testnet keys only.**
> Memories live on the chain they were anchored on; the registry is immutable
> (an upgrade is a new address, never a proxy). A CID alone is never proof of
> an on-chain memory — only a commitment hash resolved against registry state
> is.

## What changed in 0.2.0

- **Local encrypted wallet.** Create or import Base Sepolia EOAs, protect them
  with one vault password (Argon2id + AES-256-GCM), manage up to 50 accounts,
  export a secret after re-entering the password, change the password or reset
  the vault. It is local-only, never signs, and never injects a key into MCP.
- **One shared vault core.** The crypto and record format live in
  `@limccn/longstone-wallet`, consumed by both the browser extension and this
  extension; this repository contains no second implementation.
- **Temporary owner default.** While the wallet is unlocked, the memory
  browser defaults its owner filter to the active address. Locking clears the
  wallet-sourced value; a value you typed is kept. No setting is written.
- **Three bundles**, `dist/extension.cjs`, `dist/webview.js` and
  `dist/wallet-webview.js`, packaged as `longstone-vscode-0.2.0.vsix`.

---

## Install (sideload)

Marketplace/Open VSX publishing is **not** part of v1. Build a VSIX and install
it:

```bash
corepack pnpm install                 # from the workspace root
pnpm --dir longstone-vscode package   # builds + runs the pinned vsce 4.0.0
code --install-extension longstone-vscode-0.2.0.vsix
```

In VS Code: **Extensions → … → Install from VSIX…** does the same thing.

Prerequisites:

- Node.js **>= 24** on `PATH` (the pinned CLI declares the same engine).
- `npx` available. The first server start downloads and caches
  `@limccn/longstone@0.1.1`; `resolveMcpServerDefinition` only resolves from
  the local npm cache (`npx --no-install`), so run this once in a terminal if
  the extension reports that the CLI is missing:

  ```bash
  npx -y @limccn/longstone@0.1.1 --version
  ```

## The MCP provider

| | |
|---|---|
| Provider id | `longstone` |
| Command | `npx -y @limccn/longstone@0.1.1 serve` |
| Tool surface (default) | `memory_get`, `memory_verify`, `memory_stage_status` |
| Tool surface (write mode) | adds `memory_put`, `memory_retract`, `memory_acl` |
| Server env | `LONGSTONE_MCP_READ_ONLY=1` (default) or `=0` (write mode) |

- **Read-only by default.** This is the mechanism, not a label: the longstone
  server registers the write tools only when that variable is absent or `0`.
  The provider always sets it explicitly, so an ambient value in your shell
  cannot silently widen the tool list.
- **Enabling write mode is an explicit user setting**:
  `longstone.allowWriteTools: true`. The setting is application-scoped, so a
  workspace cannot enable it. Changing it changes the server definition's
  version, which makes VS Code re-read the tool list and prompt to refresh.
- **The owner key is never handed to the server.** The provider passes
  `LONGSTONE_OWNER_KEY: null` to VS Code, which removes an ambient owner key
  from the spawned server's environment without this extension reading the
  value. Only `LONGSTONE_KEY` is inherited; write mode is the only mode that
  uses it. Because `memory_acl` grant/revoke requires the owner key, those
  owner operations are not available through this provider; use the CLI.
- **The local wallet stays out of this channel.** Wallet secrets, mnemonic
  words and private keys are never injected into the MCP server environment,
  and unlocking or locking the wallet does not change the server definition.
  `LONGSTONE_KEY` remains the only signing-key source for the MCP server.
- **Resolution is validated.** Before a server starts,
  `resolveMcpServerDefinition` runs `npx --no-install @limccn/longstone@0.1.1
  --version`; a missing package or a mismatched version surfaces an error
  naming the package and the fix instead of a server that fails on first use.
  The check is cached for the session.
- **No duplicate tools.** The extension never calls `vscode.lm.registerTool`:
  MCP already exposes the tools, and a second registration would drift.

### Keys

Keys are **environment variables of the VS Code process**, read by the
longstone CLI. There is no key setting, no SecretStorage use, and this
extension never reads a key value.

- `LONGSTONE_KEY` — presence is reported as a **boolean** by the command
  **Longstone: Report Key Presence (boolean only)**.
- `LONGSTONE_OWNER_KEY` — named only to say it is never used here. The
  extension does not expose an owner-key path.

With no key, reads work and writes fail with the typed `NO_KEY` error. That is
the intended state for this panel.

## The local wallet

The wallet manages keys and addresses only. It is **local-only**: in Remote
SSH, Codespaces or Dev Containers every wallet command reports that the wallet
is local-only, and the extension never reads or writes wallet data there.

- Create a 12-word Base Sepolia EOA (`m/44'/60'/0'/0/0`) or import a BIP-39
  mnemonic (12/15/18/21/24 words) or a 32-byte private key.
- One vault password (at least 8 Unicode code points) encrypts the keys with
  Argon2id + AES-256-GCM. The ciphertext lives in `context.globalState` under
  `longstone.wallet.v1` (`longstone.wallet.v1.pending` holds a two-phase
  password change); there is no `SecretStorage` use and no Settings Sync.
- Unlock, lock, add/rename/switch/delete accounts, copy the active address,
  export a mnemonic or private key after re-entering the password, change the
  password, reset the wallet.
- The wallet has no settings: idle lock is 15 minutes, and losing window focus
  locks immediately. The manifest contributes zero wallet configuration.
- **Never signs.** There is no signing, sending, dApp connection or
  `window.ethereum` path in any bundle. Commands are key management only.
- **Forgotten passwords are unrecoverable.** There is no recovery key and no
  escrow; the extension cannot decrypt the vault without the password.
- **Export risk.** Exported material is shown in a dedicated secret webview,
  not in the editor or Output panel. Copying puts it on the system clipboard,
  and clipboard history may retain it.

Manual GUI verification — including the at-rest `state.vscdb` check — is in the
[wallet verification runbook](https://github.com/limccn/longstone-vscode/blob/main/docs/wallet-verification.md).
It is a signed-off manual runbook; CI never launches VS Code.

Wallet commands (all available from the command palette; the status bar opens
`Longstone: Manage Wallet`):

| Command | Purpose |
|---|---|
| `Longstone: Manage Wallet` | State-aware menu: create/import, unlock, accounts, lock |
| `Longstone: Create Wallet` | Generate a 12-word wallet |
| `Longstone: Import Wallet` | Import a mnemonic or private key |
| `Longstone: Lock Wallet` | Drop the in-memory session |
| `Longstone: Copy Wallet Address` | Copy the active address |
| `Longstone: Export Wallet Secret` | Password check, then reveal a secret |
| `Longstone: Change Wallet Password` | Re-encrypt with a new salt and IV |
| `Longstone: Reset Wallet` | Delete the vault (typed confirmation) |

## Settings

All settings live under `longstone.*`. Endpoints must use `https://`; plain
`http://` is accepted **only** for loopback hosts (`localhost`, `127.0.0.0/8`,
`::1`, `*.localhost`). URLs that embed credentials, a query string, or a
fragment are rejected, and a value that looks like 32-byte key material is
refused.

| Setting | Default | Meaning |
|---|---|---|
| `longstone.rpcUrl` | `https://sepolia.base.org` | Base Sepolia JSON-RPC |
| `longstone.registryAddress` | `0xC85ed11d3065739F1829A114e420584bEC3FDFEF` | MemoryRegistry (0x + 40 hex) |
| `longstone.ipfsGateway` | `https://gateway.pinata.cloud/ipfs` | Content fetch for verification |
| `longstone.hisaishiUrl` | empty | Optional gateway; empty means IPFS only |
| `longstone.allowWriteTools` | `false` | Expose MCP write tools |

**There is no key setting, by design.** Settings are not a secret channel.

## The memory browser

Commands:

- **Longstone: Show Memory Browser** — timeline, detail and verify.
- **Longstone: Report Key Presence (boolean only)** — see above.

The panel is built from `@limccn/longstone-surface`:

- **Timeline** scans registry events from the contract's deploy block (found
  by binary search over historical `eth_getCode`, never genesis), with
  adaptive chunking for provider range caps. Records are cached per webview
  session.
- **Detail** shows both digests, the derived raw CIDv1, deep/active state,
  predecessor/successor, and Blockscout links.
- **Verify** calls `verifyCommitment`, which reads the expected digests from
  **chain state** and compares both `keccak256(bytes)` against `contentHash`
  and `sha256(bytes)` against `cidDigest`. The gateway supplies bytes only.

### Webview security

- CSP: `default-src 'none'`, a nonce'd `script-src` (the one bundle), and
  `connect-src` limited to the origins of the configured RPC/gateway/hisaishi
  URLs. Styles, images and fonts come only from the webview's own
  `cspSource`.
- Assets load through `asWebviewUri`; no remote code, no `eval`.
- Settings arrive over `postMessage`; the document carries no inline data.
- External links go through a host-side allowlist
  (`base-sepolia.blockscout.com`, `longstone-ui.pages.dev`); anything else is
  refused.
- Memory text is rendered with `textContent`, never HTML: **memory content is
  untrusted data, never instructions.**
- **Dependency residual.** `dist/webview.js` may contain viem public-client
  transaction helpers (`sendRawTransaction`, `prepareTransactionRequest`) and
  noble curve/signing primitives pulled in by `createPublicClient` and
  signature recovery. It contains zero wallet client, account, signer,
  `window.ethereum`, or signing call path. `scripts/audit-bundle.mjs` checks
  each bundle by name and fails on `window.ethereum`, `createWalletClient`,
  `privateKeyToAccount`, `signMessage`, `signTypedData`, `signTransaction`,
  `eth_sendTransaction`, `eth_signTypedData`, `eval(`, `new Function(`, and on
  key-material assignments. The secret bundle additionally fails on `fetch(`,
  `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `console.`,
  `debugger`, and every shared-core marker (`@limccn/longstone-wallet`,
  `argon2id`, `longstone/wallet.v1`). The audit allows the already-signed
  transaction helpers, the noble internals, and the provider's explicit
  `LONGSTONE_OWNER_KEY: null` removal marker, which it still requires in the
  host bundle.

### What the panel cannot do

The memory browser has no dApp connection, no signing call path, and no
retract/ACL writes. The detail view links to the web app for retraction, where
a wallet signs. Write tools (if enabled) run through the MCP server's own
signing path, which requires `LONGSTONE_KEY`. The local wallet is a separate
surface: it never signs either, and no panel can reach its keys.

## Development

The vault core is the workspace package `@limccn/longstone-wallet`; it is
shared with the browser extension and must stay the only crypto/format
implementation.

```bash
pnpm --filter @limccn/longstone-wallet test  # shared vault core (Argon2id/AES-GCM)
pnpm --dir longstone-vscode typecheck       # tsc, strict + exactOptionalPropertyTypes
pnpm --dir longstone-vscode test            # plain Node tests, no VS Code host
pnpm --dir longstone-vscode build           # esbuild: extension.cjs + two webviews
pnpm --dir longstone-vscode assert:manifest # packaging contract assertions
pnpm --dir longstone-vscode audit:bundle    # wallet/signing/key-material bundle audit
pnpm --dir longstone-vscode check:wallet-db -- --db <state.vscdb>  # read-only at-rest check
pnpm --dir longstone-vscode package         # build + vsce 4.0.0
```

The package gate (`pnpm --dir longstone-vscode verify:all`) plus the VSIX
check:

```bash
pnpm --dir longstone-vscode exec vsce package --no-dependencies
pnpm --dir longstone-vscode exec vsce ls --no-dependencies > longstone-vscode/vsix-files.txt
node longstone-vscode/scripts/assert-vsix.mjs longstone-vscode/vsix-files.txt
```

The tests cover settings validation, CSP/nonce construction, deep-link/URL
building, MCP provider env and resolution behaviour, scan-control transitions,
the bundle audit (including the secret-bundle bans and their per-bundle
scope), the cache codec, and the wallet surface — controller state/locking/
read-back/async epochs, protocol, secret HTML/CSP, commands, status bar,
password input, owner filter and the design §12.3 source scans — all without
launching VS Code.
`scripts/assert-manifest.mjs` asserts the provider contribution, all ten
commands and their activation events, the five configuration keys, the
absence of any key or wallet setting, and the README's wallet claims.

Press `F5` in the repo root to launch an Extension Development Host after
`pnpm --dir longstone-vscode build`.

## v2 (expected)

Deliberately out of scope for this release:

- **Marketplace and Open VSX publishing** (with signing and the listing
  assets).
- **In-editor writes**: retract/ACL through the extension, which would need a
  signing path and would end the "no key channel" property.
- **Wallet connector / dApp integration** in the memory browser webview
  (the separate local wallet never connects to a dApp either).
- **A tree view / activity-bar container** for the timeline (v1 uses a
  webview panel only).
- **Configurable hashtags/owner defaults** and multi-registry profiles.
- **Incremental scan persistence across VS Code restarts** (v1 keeps the
  cache in webview state).

## Licence

Apache-2.0. See `LICENSE`.
