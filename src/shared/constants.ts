/**
 * Constants shared by the extension host, the webview and the test suite.
 *
 * Imported by plain Node tests, so this module must stay free of `vscode`
 * and of any runtime import that needs an extension host.
 */

/** Contributed MCP provider id (`contributes.mcpServerDefinitionProviders`). */
export const MCP_PROVIDER_ID = 'longstone';

/** Provider label shown by VS Code in the MCP server picker. */
export const MCP_PROVIDER_LABEL = 'Longstone memory (read-only by default)';

export const COMMAND_SHOW_BROWSER = 'longstone.showMemoryBrowser';
export const COMMAND_REPORT_KEY = 'longstone.reportKeyPresence';

export const WEBVIEW_VIEW_TYPE = 'longstone.memoryBrowser';
export const WEBVIEW_TITLE = 'Longstone Memory';

/** The CLI package the provider launches. Exact pin, never a range (PS-5). */
export const LONGSTONE_PACKAGE = '@limccn/longstone';

/**
 * Exact version the provider launches and `resolveMcpServerDefinition`
 * verifies. `npx -y` does not consult a lockfile, so the pin is the
 * supply-chain control; bumping it is a deliberate change, mirrored in the
 * README and in the manifest assertion script.
 */
export const LONGSTONE_CLI_VERSION = '0.1.1';

/** Server-side read-only switch implemented by longstone (C10). */
export const READ_ONLY_ENV = 'LONGSTONE_MCP_READ_ONLY';

/** Presence indicator only — the extension never reads or stores the value. */
export const KEY_ENV = 'LONGSTONE_KEY';

/** Owner key: never accepted, never inspected, named only to exclude it. */
export const OWNER_KEY_ENV = 'LONGSTONE_OWNER_KEY';

/** Fixed base for deep links to the web app; never taken from input (PS-8). */
export const WEB_APP_BASE = 'https://longstone-ui.pages.dev';

/** Fixed base for explorer links. */
export const BLOCKSCOUT_ORIGIN = 'https://base-sepolia.blockscout.com';

/** Hosts the webview may ask the host to open externally. */
export const ALLOWED_EXTERNAL_HOSTS: readonly string[] = [
  'base-sepolia.blockscout.com',
  'longstone-ui.pages.dev',
];

/**
 * Block-range chunk size. Base Sepolia's public RPC caps `eth_getLogs` at 200
 * blocks; the surface's `scanRange` adapts down further when a provider states
 * a smaller cap.
 */
export const SCAN_CHUNK_SIZE = 200;
