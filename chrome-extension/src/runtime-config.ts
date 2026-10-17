import { DEFAULT_DAEMON_PORT, MAX_DAEMON_PORT } from './protocol';

export interface BridgeRuntimeConfig {
  servingEnabled: boolean;
  port: number;
}

const STORAGE_KEY = 'ttBridgeRuntimeConfig';

function normalizePort(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return DEFAULT_DAEMON_PORT;
  }
  return Math.min(MAX_DAEMON_PORT, Math.max(DEFAULT_DAEMON_PORT, Math.trunc(value)));
}

export async function readBridgeRuntimeConfig(): Promise<BridgeRuntimeConfig> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const rawConfig = stored[STORAGE_KEY] as Partial<BridgeRuntimeConfig> | undefined;

  return {
    servingEnabled: Boolean(rawConfig?.servingEnabled),
    port: normalizePort(rawConfig?.port),
  };
}

export async function writeBridgeRuntimeConfig(
  partialConfig: Partial<BridgeRuntimeConfig>,
): Promise<BridgeRuntimeConfig> {
  const current = await readBridgeRuntimeConfig();
  const next: BridgeRuntimeConfig = {
    servingEnabled: partialConfig.servingEnabled ?? current.servingEnabled,
    port: normalizePort(partialConfig.port ?? current.port),
  };

  await chrome.storage.local.set({
    [STORAGE_KEY]: next,
  });

  return next;
}
