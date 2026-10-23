# Longstone Memory for VS Code

A **read-only** VS Code extension with two capabilities:

1. **An MCP server provider.** Copilot Chat (or any MCP host in VS Code) gains
   the Longstone memory tools with no JSON to write. The provider starts
   `npx -y @limccn/longstone@0.1.1 serve` and, by default, sets
   `LONGSTONE_MCP_READ_ONLY=1`, so only `memory_get`, `memory_verify` and
   `memory_stage_status` are registered.
2. **A memory browser panel.** Timeline, commitment detail and verification,
   rendered inside the editor from the same `@limccn/longstone-surface`
   package the web app uses.

Longstone stores durable agent memory on Base Sepolia. This extension is a
**viewer**: it has no wallet connection, no signing call path, and no key
channel.

> **M1 status: Base Sepolia only (chain id 84532), testnet keys only.**
> Memories live on the chain they were anchored on; the registry is immutable
> (an upgrade is a new address, never a proxy). A CID alone is never proof of
> an on-chain memory — only a commitment hash resolved against registry state
> is.

---

## Install (sideload)

Marketplace/Open VSX publishing is **not** part of v1. Build a VSIX and install
it:

```bash
corepack pnpm install                 # from the workspace root
pnpm --dir longstone-vscode package   # builds + runs the pinned vsce 4.0.0
code --install-extension longstone-vscode-0.1.0.vsix
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
  signature recovery. There is no wallet client, account, signer,
  `window.ethereum`, or signing call path. `scripts/audit-bundle.mjs` fails on
  `window.ethereum`, `createWalletClient`, `privateKeyToAccount`,
  `signMessage`, `signTypedData`, `signTransaction`, `eval(`, and
  `new Function(`, and on key-material assignments. It allows the
  already-signed transaction helpers, the noble internals, and the provider's
  explicit `LONGSTONE_OWNER_KEY: null` removal marker.

### What the panel cannot do

No wallet connection, no signing, no retract/ACL writes. The detail view links
to the web app for retraction, where a wallet signs. Write tools (if enabled)
run through the MCP server's own signing path, which requires `LONGSTONE_KEY`.

## Development

```bash
pnpm --dir longstone-vscode typecheck       # tsc, strict + exactOptionalPropertyTypes
pnpm --dir longstone-vscode test            # plain Node tests, no VS Code host
pnpm --dir longstone-vscode build           # esbuild: dist/extension.cjs, dist/webview.js
pnpm --dir longstone-vscode assert:manifest # packaging contract assertions
pnpm --dir longstone-vscode audit:bundle    # wallet/signing/key-material bundle audit
pnpm --dir longstone-vscode package         # build + vsce 4.0.0
```

The tests cover settings validation, CSP/nonce construction, deep-link/URL
building, MCP provider env and resolution behaviour, scan-control transitions,
the bundle audit, and the cache codec — all without launching VS Code.
`scripts/assert-manifest.mjs` asserts the provider contribution, the command,
the configuration keys, and the absence of any key setting.

Press `F5` in the repo root to launch an Extension Development Host after
`pnpm --dir longstone-vscode build`.

## v2 (expected)

Deliberately out of scope for this release:

- **Marketplace and Open VSX publishing** (with signing and the listing
  assets).
- **In-editor writes**: retract/ACL through the extension, which would need a
  signing path and would end the "no key channel" property.
- **Wallet or connector integration** in the webview.
- **A tree view / activity-bar container** for the timeline (v1 uses a
  webview panel only).
- **Configurable hashtags/owner defaults** and multi-registry profiles.
- **Incremental scan persistence across VS Code restarts** (v1 keeps the
  cache in webview state).

## Licence

Apache-2.0. See `LICENSE`.
