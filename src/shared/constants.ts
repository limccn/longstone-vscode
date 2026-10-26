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

/**
 * Wallet commands (design §7.2). The wallet manages keys and addresses only:
 * no command signs, sends, or connects to a dApp.
 */
export const COMMAND_WALLET_MANAGE = 'longstone.wallet.manage';
export const COMMAND_WALLET_CREATE = 'longstone.wallet.create';
export const COMMAND_WALLET_IMPORT = 'longstone.wallet.import';
export const COMMAND_WALLET_LOCK = 'longstone.wallet.lock';
export const COMMAND_WALLET_COPY_ADDRESS = 'longstone.wallet.copyAddress';
export const COMMAND_WALLET_EXPORT_SECRET = 'longstone.wallet.exportSecret';
export const COMMAND_WALLET_CHANGE_PASSWORD = 'longstone.wallet.changePassword';
export const COMMAND_WALLET_RESET = 'longstone.wallet.reset';

export const WEBVIEW_VIEW_TYPE = 'longstone.memoryBrowser';
export const WEBVIEW_TITLE = 'Longstone Memory';

/** Dedicated secret webview type (design §7.5); never shared with the browser. */
export const WALLET_SECRET_VIEW_TYPE = 'longstone.walletSecret';
export const WALLET_SECRET_VIEW_TITLE = 'Longstone Wallet — Secret';

/**
 * Logical keys understood by `@limccn/longstone-wallet`; the host storage
 * adapter maps them to the physical `globalState` keys below (design §4.1).
 */
export const WALLET_LOGICAL_RECORD_KEY = 'wallet.v1';
export const WALLET_LOGICAL_PENDING_KEY = 'wallet.v1.pending';

/** Physical `globalState` keys. Strings, never objects; never synced. */
export const WALLET_STORAGE_RECORD_KEY = 'longstone.wallet.v1';
export const WALLET_STORAGE_PENDING_KEY = 'longstone.wallet.v1.pending';

/** Status bar presentation (design §7.3). Remote windows create no item. */
export const WALLET_STATUS_PRIORITY = 100;
export const WALLET_STATUS_TEXT_NO_VAULT = '$(wallet) Longstone Wallet';
export const WALLET_STATUS_TEXT_LOCKED = '$(lock) Longstone Wallet: Locked';
/** UNLOCKED renders this icon followed by the truncated active address. */
export const WALLET_STATUS_ICON_UNLOCKED = '$(unlock)';
export const WALLET_STATUS_TOOLTIP_NO_VAULT = 'Set up a local encrypted wallet';
export const WALLET_STATUS_TOOLTIP_LOCKED = 'Click to unlock';
export const WALLET_STATUS_TOOLTIP_UNLOCKED = 'click to manage';

/** The CLI package users install globally; the provider launches its command. */
export const LONGSTONE_PACKAGE = '@limccn/longstone';

/**
 * Exact version the provider documents and the README tells users to install.
 * The extension launches the user-installed CLI (`longstone serve`) and never
 * fetches a package at run time, so this pin is the version contract; bumping
 * it is a deliberate change, mirrored in the README and in the manifest
 * assertion script.
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
