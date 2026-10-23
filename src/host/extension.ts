/**
 * Extension entry point.
 *
 * Activation does three things:
 * 1. registers the MCP server definition provider (read-only by default);
 * 2. registers the memory-browser command;
 * 3. registers a key-presence command that reports a boolean only.
 *
 * No `vscode.lm.registerTool` calls: the MCP server already exposes the tools,
 * and a second registration would duplicate them with a different schema.
 */

import * as vscode from 'vscode';

import {
  COMMAND_REPORT_KEY,
  COMMAND_SHOW_BROWSER,
  KEY_ENV,
  LONGSTONE_CLI_VERSION,
  LONGSTONE_PACKAGE,
  MCP_PROVIDER_ID,
  OWNER_KEY_ENV,
} from '../shared/constants.ts';
import { SETTINGS_SECTION, SETTING_KEYS } from '../shared/settings.ts';
import { runCliProbe } from './cli-probe.ts';
import { buildServerDefinition, keyPresence, type ProviderServer } from './mcp-provider.ts';
import { MemoryBrowserPanel } from './webview-panel.ts';

let probeCache: { result: Awaited<ReturnType<typeof runCliProbe>> } | undefined;
let panelRef: MemoryBrowserPanel | undefined;

function log(message: string): void {
  // One channel, no secrets: callers never pass key values here.
  console.log(`[longstone] ${message}`);
}

function readAllowWriteTools(): boolean {
  return (
    vscode.workspace
      .getConfiguration(SETTINGS_SECTION)
      .get<boolean>('allowWriteTools', false) === true
  );
}

function readRawSettings(): Record<string, unknown> {
  const config = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  const raw: Record<string, unknown> = {};
  // Settings are read by their short name; the full keys are the manifest's.
  for (const key of ['rpcUrl', 'registryAddress', 'ipfsGateway', 'hisaishiUrl'] as const) {
    const value = config.get<unknown>(key);
    if (value !== undefined) raw[key] = value;
  }
  return raw;
}

function currentKeyPresence(): { keyPresent: boolean; ownerKeyPresent: boolean } {
  return keyPresence(process.env);
}

async function resolveValidated(): Promise<ProviderServer | undefined> {
  const result = probeCache?.result ?? (await runCliProbe());
  if (result.ok) {
    // Cache successes only: a transient failure is retried on the next start.
    probeCache = { result };
  }
  if (!result.ok) {
    log(`MCP server resolution failed: ${result.message ?? 'unknown error'}`);
    void vscode.window.showErrorMessage(
      `Longstone: ${result.message ?? 'the MCP server command could not be resolved.'}`,
    );
    // Returning undefined tells VS Code not to start a server that cannot run,
    // instead of spawning a process that fails on the first request.
    return undefined;
  }
  return buildServerDefinition({ allowWriteTools: readAllowWriteTools() });
}

function toVsCodeDefinition(server: ProviderServer): vscode.McpStdioServerDefinition {
  return new vscode.McpStdioServerDefinition(
    server.label,
    server.command,
    server.args,
    server.env,
    server.version,
  );
}

export function activate(context: vscode.ExtensionContext): void {
  log(`activating (pinned CLI ${LONGSTONE_PACKAGE}@${LONGSTONE_CLI_VERSION})`);

  // Fires when a setting that changes the definition (or its env) changes, so
  // VS Code re-queries the tool list instead of serving a stale one.
  const definitionsChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(definitionsChanged);

  const provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> = {
    onDidChangeMcpServerDefinitions: definitionsChanged.event,
    provideMcpServerDefinitions: () => [
      toVsCodeDefinition(buildServerDefinition({ allowWriteTools: readAllowWriteTools() })),
    ],
    resolveMcpServerDefinition: async (server) => {
      // Rebuild at resolve time so the response reflects the current setting,
      // even if the user changed it after the list was provided.
      const validated = await resolveValidated();
      if (validated === undefined) return undefined;
      return toVsCodeDefinition({
        ...validated,
        // Preserve the label the host handed us (the user may have renamed it).
        label: server.label === '' ? validated.label : server.label,
      });
    },
  };

  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, provider),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(SETTING_KEYS.allowWriteTools)) {
        probeCache = undefined;
        definitionsChanged.fire();
      }
      if (
        event.affectsConfiguration(SETTING_KEYS.rpcUrl) ||
        event.affectsConfiguration(SETTING_KEYS.ipfsGateway) ||
        event.affectsConfiguration(SETTING_KEYS.hisaishiUrl) ||
        event.affectsConfiguration(SETTING_KEYS.registryAddress)
      ) {
        panelRef?.refresh();
      }
    }),
  );

  const panel = new MemoryBrowserPanel({
    extensionUri: context.extensionUri,
    readRawSettings,
    keyPresence: currentKeyPresence,
    log,
  });
  panelRef = panel;

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SHOW_BROWSER, () => {
      panel.show();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_REPORT_KEY, async () => {
      const presence = currentKeyPresence();
      const message = presence.keyPresent
        ? `${KEY_ENV} is present in the VS Code environment. Value not read.`
        : `${KEY_ENV} is not set. Read tools work; write tools would fail with NO_KEY.`;
      const owner = presence.ownerKeyPresent
        ? ` ${OWNER_KEY_ENV} is also present; this extension never uses it.`
        : '';
      await vscode.window.showInformationMessage(`Longstone: ${message}${owner}`);
    }),
  );
}

export function deactivate(): void {
  // VS Code disposes the registrations in `subscriptions`; nothing else is held.
}
