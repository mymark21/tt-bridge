/**
 * Agent Browser Bridge service worker.
 *
 * Connects to the local daemon via WebSocket, receives commands,
 * dispatches them to Chrome APIs (debugger/tabs/cookies), and returns results.
 */

import type { Command, Result } from './protocol';
import { DEFAULT_DAEMON_PORT, WS_RECONNECT_BASE_DELAY, WS_RECONNECT_MAX_DELAY, getDaemonWsUrl } from './protocol';
import type { BridgeDaemonStatus, BridgePortScan } from './daemon-discovery';
import { scanDaemonPorts } from './daemon-discovery';
import { readBridgeRuntimeConfig, writeBridgeRuntimeConfig } from './runtime-config';
import * as executor from './cdp';

type ConnectionState = 'idle' | 'connecting' | 'waiting' | 'connected' | 'error';

type PopupBridgeState = {
  servingEnabled: boolean;
  port: number;
  buttonLabel: string;
  statusText: string;
  connectionState: ConnectionState;
  defaultPortBusy: boolean;
};

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let socketPort: number | null = null;
let connectionState: ConnectionState = 'idle';
let statusText = 'Ready to start serving.';
let servingEnabled = false;
let configuredPort = DEFAULT_DAEMON_PORT;
let lastScan: BridgePortScan | null = null;
let daemonStatus: BridgeDaemonStatus | null = null;
let initialized = false;
let initializationPromise: Promise<void> | null = null;

// ─── Console log forwarding ──────────────────────────────────────────
// Hook console.log/warn/error to forward logs to daemon via WebSocket.

const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

function forwardLog(level: 'info' | 'warn' | 'error', args: unknown[]): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    const msg = args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
    ws.send(JSON.stringify({ type: 'log', level, msg, ts: Date.now() }));
  } catch {
    // Avoid recursive logging failures.
  }
}

console.log = (...args: unknown[]) => {
  _origLog(...args);
  forwardLog('info', args);
};
console.warn = (...args: unknown[]) => {
  _origWarn(...args);
  forwardLog('warn', args);
};
console.error = (...args: unknown[]) => {
  _origError(...args);
  forwardLog('error', args);
};

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function isSocketConnected(): boolean {
  return Boolean(ws && ws.readyState === WebSocket.OPEN);
}

function setBridgeStatus(nextState: ConnectionState, nextStatusText: string): void {
  connectionState = nextState;
  statusText = nextStatusText;
}

function buildIdleStatus(scan: BridgePortScan | null, port: number): string {
  if (scan?.daemonPort !== null) {
    return `Local daemon detected on ${port}. Click Start Serving.`;
  }
  if (scan?.defaultPortBusy && port !== DEFAULT_DAEMON_PORT) {
    return `Default port ${DEFAULT_DAEMON_PORT} is busy. Start Serving will use ${port}.`;
  }
  return `Ready to start serving on ${port}.`;
}

function buildWaitingStatus(scan: BridgePortScan | null, port: number): string {
  if (scan?.defaultPortBusy && port !== DEFAULT_DAEMON_PORT) {
    return `Default port ${DEFAULT_DAEMON_PORT} is busy. Waiting for local daemon on ${port}.`;
  }
  return `Waiting for local daemon on ${port}.`;
}

function buildConnectingStatus(port: number): string {
  return `Connecting to local daemon on ${port}.`;
}

function buildConnectedStatus(port: number): string {
  return `Serving on ${port}.`;
}

function disconnectSocket(): void {
  if (!ws) {
    socketPort = null;
    return;
  }

  const socket = ws;
  ws = null;
  socketPort = null;
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
  try {
    socket.close();
  } catch {
    // Ignore close failures.
  }
}

async function persistRuntimeConfig(): Promise<void> {
  await writeBridgeRuntimeConfig({
    servingEnabled,
    port: configuredPort,
  });
}

async function refreshPortSelection(trigger: 'startup' | 'popup' | 'start' | 'reconnect'): Promise<BridgePortScan> {
  const scan = await scanDaemonPorts();
  lastScan = scan;
  daemonStatus = scan.status;

  const nextPort = scan.daemonPort ?? scan.candidatePort;
  if (configuredPort !== nextPort) {
    configuredPort = nextPort;
    await persistRuntimeConfig();
  }

  if (!servingEnabled || trigger === 'popup') {
    setBridgeStatus('idle', buildIdleStatus(scan, configuredPort));
  }

  return scan;
}

function scheduleReconnect(): void {
  if (!servingEnabled || reconnectTimer) {
    return;
  }

  reconnectAttempts += 1;
  const delay = Math.min(
    WS_RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1),
    WS_RECONNECT_MAX_DELAY,
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect('reconnect');
  }, delay);
}

// ─── WebSocket connection ────────────────────────────────────────────

async function connect(trigger: 'startup' | 'popup' | 'start' | 'reconnect'): Promise<void> {
  if (!servingEnabled) {
    return;
  }

  const scan = await refreshPortSelection(trigger);
  const targetPort = configuredPort;

  if (isSocketConnected() && socketPort === targetPort) {
    setBridgeStatus('connected', buildConnectedStatus(targetPort));
    return;
  }

  if (ws?.readyState === WebSocket.CONNECTING && socketPort === targetPort) {
    return;
  }

  clearReconnectTimer();
  disconnectSocket();

  if (scan.daemonPort === targetPort) {
    setBridgeStatus('connecting', buildConnectingStatus(targetPort));
  } else {
    setBridgeStatus('waiting', buildWaitingStatus(scan, targetPort));
  }

  let socket: WebSocket;
  try {
    socket = new WebSocket(getDaemonWsUrl(targetPort));
  } catch {
    setBridgeStatus('waiting', buildWaitingStatus(scan, targetPort));
    scheduleReconnect();
    return;
  }

  ws = socket;
  socketPort = targetPort;

  socket.onopen = () => {
    if (ws !== socket) {
      return;
    }

    console.log('[agent-browser-bridge] Connected to daemon');
    socket.send(JSON.stringify({
      type: 'hello',
      role: 'extension',
      version: chrome.runtime.getManifest().version,
      extensionId: chrome.runtime.id,
      ts: Date.now(),
    }));
    reconnectAttempts = 0;
    clearReconnectTimer();
    setBridgeStatus('connected', buildConnectedStatus(targetPort));
  };

  socket.onmessage = async (event) => {
    try {
      const command = JSON.parse(event.data as string) as Command;
      const result = await handleCommand(command);
      ws?.send(JSON.stringify(result));
    } catch (error) {
      console.error('[agent-browser-bridge] Message handling error:', error);
    }
  };

  socket.onclose = () => {
    if (ws !== socket) {
      return;
    }

    console.log('[agent-browser-bridge] Disconnected from daemon');
    ws = null;
    socketPort = null;

    if (!servingEnabled) {
      setBridgeStatus('idle', buildIdleStatus(lastScan, configuredPort));
      return;
    }

    setBridgeStatus('waiting', buildWaitingStatus(lastScan, configuredPort));
    scheduleReconnect();
  };

  socket.onerror = () => {
    socket.close();
  };
}

async function startServing(): Promise<void> {
  servingEnabled = true;
  await persistRuntimeConfig();
  await connect('start');
}

async function stopServing(): Promise<void> {
  servingEnabled = false;
  await persistRuntimeConfig();
  reconnectAttempts = 0;
  clearReconnectTimer();
  disconnectSocket();
  await refreshPortSelection('popup');
  setBridgeStatus('idle', buildIdleStatus(lastScan, configuredPort));
}

function buildPopupState(): PopupBridgeState {
  return {
    servingEnabled,
    port: configuredPort,
    buttonLabel: servingEnabled ? 'Serving' : 'Start Serving',
    statusText,
    connectionState,
    defaultPortBusy: Boolean(lastScan?.defaultPortBusy),
  };
}

async function getPopupState(): Promise<PopupBridgeState> {
  await refreshPortSelection('popup');
  if (servingEnabled && !isSocketConnected()) {
    void connect('popup');
  }
  return buildPopupState();
}

// ─── Automation window isolation ─────────────────────────────────────
// All automation operations happen in a dedicated incognito Chrome window
// so the user's active browsing session is never touched.
// The window auto-closes after 120s of idle (no commands).

type AutomationSession = {
  windowId: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleDeadlineAt: number;
};

const automationSessions = new Map<string, AutomationSession>();
const WINDOW_IDLE_TIMEOUT = 120000;
const AUTOMATION_WINDOW_URL = 'data:text/html,<html></html>';
const INCOGNITO_ACCESS_ERROR =
  'TT-brower-bridge needs Chrome "Allow in Incognito" enabled before it can create its dedicated incognito automation window. Open chrome://extensions, open TT-brower-bridge details, and enable "Allow in Incognito".';

function getWorkspaceKey(workspace?: string): string {
  return workspace?.trim() || 'default';
}

function resetWindowIdleTimer(workspace: string): void {
  const session = automationSessions.get(workspace);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleDeadlineAt = Date.now() + WINDOW_IDLE_TIMEOUT;
  session.idleTimer = setTimeout(async () => {
    const current = automationSessions.get(workspace);
    if (!current) return;
    try {
      await chrome.windows.remove(current.windowId);
      console.log(`[agent-browser-bridge] Automation window ${current.windowId} (${workspace}) closed (idle timeout)`);
    } catch {
      // Already gone.
    }
    automationSessions.delete(workspace);
  }, WINDOW_IDLE_TIMEOUT);
}

async function ensureIncognitoAccess(): Promise<void> {
  if (!chrome.extension?.isAllowedIncognitoAccess) {
    throw new Error('Chrome incognito access check is unavailable in this extension context.');
  }

  const allowed = await chrome.extension.isAllowedIncognitoAccess();
  if (!allowed) {
    throw new Error(INCOGNITO_ACCESS_ERROR);
  }
}

/** Get or create the dedicated automation window. */
async function getAutomationWindow(workspace: string): Promise<number> {
  const existing = automationSessions.get(workspace);
  if (existing) {
    try {
      await chrome.windows.get(existing.windowId);
      return existing.windowId;
    } catch {
      automationSessions.delete(workspace);
    }
  }

  await ensureIncognitoAccess();

  const win = await chrome.windows.create({
    url: AUTOMATION_WINDOW_URL,
    focused: false,
    width: 1280,
    height: 900,
    type: 'normal',
    incognito: true,
  });
  if (!win.id) {
    throw new Error('Failed to create incognito automation window');
  }
  if (!win.incognito) {
    try {
      await chrome.windows.remove(win.id);
    } catch {
      // Ignore cleanup failures and surface the actionable error below.
    }
    throw new Error(INCOGNITO_ACCESS_ERROR);
  }
  const session: AutomationSession = {
    windowId: win.id,
    idleTimer: null,
    idleDeadlineAt: Date.now() + WINDOW_IDLE_TIMEOUT,
  };
  automationSessions.set(workspace, session);
  console.log(`[agent-browser-bridge] Created incognito automation window ${session.windowId} (${workspace})`);
  resetWindowIdleTimer(workspace);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return session.windowId;
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [workspace, session] of automationSessions.entries()) {
    if (session.windowId === windowId) {
      console.log(`[agent-browser-bridge] Automation window closed (${workspace})`);
      if (session.idleTimer) clearTimeout(session.idleTimer);
      automationSessions.delete(workspace);
    }
  }
});

// ─── Lifecycle events ────────────────────────────────────────────────

async function initialize(): Promise<void> {
  if (initialized) {
    return;
  }
  initialized = true;
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  executor.registerListeners();

  const config = await readBridgeRuntimeConfig();
  servingEnabled = config.servingEnabled;
  configuredPort = config.port;
  await refreshPortSelection('startup');

  if (servingEnabled) {
    await connect('startup');
  }

  console.log('[agent-browser-bridge] Extension initialized');
}

async function ensureInitialized(): Promise<void> {
  if (!initializationPromise) {
    initializationPromise = initialize().catch((error) => {
      initializationPromise = null;
      initialized = false;
      throw error;
    });
  }
  await initializationPromise;
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureInitialized();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureInitialized();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive' && servingEnabled) {
    void connect('reconnect');
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void ensureInitialized()
    .then(async () => {
      if (message?.type === 'ttbridge:get-popup-state') {
        sendResponse(await getPopupState());
        return;
      }

      if (message?.type === 'ttbridge:set-serving') {
        if (message.enabled) {
          await startServing();
        } else {
          await stopServing();
        }
        sendResponse(await getPopupState());
        return;
      }

      sendResponse(null);
    })
    .catch((error) => {
      const fallbackState: PopupBridgeState = {
        servingEnabled: false,
        port: configuredPort,
        buttonLabel: 'Start Serving',
        statusText: error instanceof Error ? error.message : 'Failed to initialize TT bridge.',
        connectionState: 'error',
        defaultPortBusy: false,
      };
      sendResponse(fallbackState);
    });

  return true;
});

// ─── Command dispatcher ─────────────────────────────────────────────

async function handleCommand(cmd: Command): Promise<Result> {
  const workspace = getWorkspaceKey(cmd.workspace);
  resetWindowIdleTimer(workspace);
  try {
    switch (cmd.action) {
      case 'exec':
        return await handleExec(cmd, workspace);
      case 'navigate':
        return await handleNavigate(cmd, workspace);
      case 'tabs':
        return await handleTabs(cmd, workspace);
      case 'cookies':
        return await handleCookies(cmd);
      case 'screenshot':
        return await handleScreenshot(cmd, workspace);
      case 'close-window':
        return await handleCloseWindow(cmd, workspace);
      case 'sessions':
        return await handleSessions(cmd);
      default:
        return { id: cmd.id, ok: false, error: `Unknown action: ${cmd.action}` };
    }
  } catch (error) {
    return {
      id: cmd.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── Action handlers ─────────────────────────────────────────────────

function isDebuggableUrl(url?: string): boolean {
  if (!url) return true;
  return !url.startsWith('chrome://') && !url.startsWith('chrome-extension://');
}

async function resolveTabId(tabId: number | undefined, workspace: string): Promise<number> {
  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (isDebuggableUrl(tab.url)) return tabId;
      console.warn(`[agent-browser-bridge] Tab ${tabId} URL is not debuggable (${tab.url}), re-resolving`);
    } catch {
      console.warn(`[agent-browser-bridge] Tab ${tabId} no longer exists, re-resolving`);
    }
  }

  const windowId = await getAutomationWindow(workspace);
  const tabs = await chrome.tabs.query({ windowId });
  const debuggableTab = tabs.find((tab) => tab.id && isDebuggableUrl(tab.url));
  if (debuggableTab?.id) return debuggableTab.id;

  const reuseTab = tabs.find((tab) => tab.id);
  if (reuseTab?.id) {
    await chrome.tabs.update(reuseTab.id, { url: AUTOMATION_WINDOW_URL });
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const updated = await chrome.tabs.get(reuseTab.id);
      if (isDebuggableUrl(updated.url)) return reuseTab.id;
      console.warn(`[agent-browser-bridge] data: URI was intercepted (${updated.url}), creating fresh tab`);
    } catch {
      // Tab was closed during navigation.
    }
  }

  const newTab = await chrome.tabs.create({ windowId, url: AUTOMATION_WINDOW_URL, active: true });
  if (!newTab.id) throw new Error('Failed to create tab in automation window');
  return newTab.id;
}

async function listAutomationTabs(workspace: string): Promise<chrome.tabs.Tab[]> {
  const session = automationSessions.get(workspace);
  if (!session) return [];
  try {
    return await chrome.tabs.query({ windowId: session.windowId });
  } catch {
    automationSessions.delete(workspace);
    return [];
  }
}

async function listAutomationWebTabs(workspace: string): Promise<chrome.tabs.Tab[]> {
  const tabs = await listAutomationTabs(workspace);
  return tabs.filter((tab) => isDebuggableUrl(tab.url));
}

async function handleExec(cmd: Command, workspace: string): Promise<Result> {
  if (!cmd.code) return { id: cmd.id, ok: false, error: 'Missing code' };
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await executor.evaluateAsync(tabId, cmd.code);
    return { id: cmd.id, ok: true, data };
  } catch (error) {
    return { id: cmd.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleNavigate(cmd: Command, workspace: string): Promise<Result> {
  if (!cmd.url) return { id: cmd.id, ok: false, error: 'Missing url' };
  const tabId = await resolveTabId(cmd.tabId, workspace);

  const beforeTab = await chrome.tabs.get(tabId);
  const beforeUrl = beforeTab.url ?? '';
  const targetUrl = cmd.url;

  await chrome.tabs.update(tabId, { url: targetUrl });

  let timedOut = false;
  await new Promise<void>((resolve) => {
    let urlChanged = false;

    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id !== tabId) return;
      if (info.url && info.url !== beforeUrl) {
        urlChanged = true;
      }
      if (urlChanged && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    setTimeout(async () => {
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (currentTab.url !== beforeUrl && currentTab.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      } catch {
        // Tab disappeared.
      }
    }, 100);

    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      timedOut = true;
      console.warn(`[agent-browser-bridge] Navigate to ${targetUrl} timed out after 15s`);
      resolve();
    }, 15000);
  });

  const tab = await chrome.tabs.get(tabId);
  return {
    id: cmd.id,
    ok: true,
    data: { title: tab.title, url: tab.url, tabId, timedOut },
  };
}

async function handleTabs(cmd: Command, workspace: string): Promise<Result> {
  switch (cmd.op) {
    case 'list': {
      const tabs = await listAutomationWebTabs(workspace);
      const data = tabs.map((tab, index) => ({
        index,
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
      }));
      return { id: cmd.id, ok: true, data };
    }
    case 'new': {
      const windowId = await getAutomationWindow(workspace);
      const tab = await chrome.tabs.create({ windowId, url: cmd.url ?? AUTOMATION_WINDOW_URL, active: true });
      return { id: cmd.id, ok: true, data: { tabId: tab.id, url: tab.url } };
    }
    case 'close': {
      if (cmd.index !== undefined) {
        const tabs = await listAutomationWebTabs(workspace);
        const target = tabs[cmd.index];
        if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
        await chrome.tabs.remove(target.id);
        executor.detach(target.id);
        return { id: cmd.id, ok: true, data: { closed: target.id } };
      }
      const tabId = await resolveTabId(cmd.tabId, workspace);
      await chrome.tabs.remove(tabId);
      executor.detach(tabId);
      return { id: cmd.id, ok: true, data: { closed: tabId } };
    }
    case 'select': {
      if (cmd.index === undefined && cmd.tabId === undefined) {
        return { id: cmd.id, ok: false, error: 'Missing index or tabId' };
      }
      if (cmd.tabId !== undefined) {
        await chrome.tabs.update(cmd.tabId, { active: true });
        return { id: cmd.id, ok: true, data: { selected: cmd.tabId } };
      }
      const tabs = await listAutomationWebTabs(workspace);
      const target = tabs[cmd.index!];
      if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
      await chrome.tabs.update(target.id, { active: true });
      return { id: cmd.id, ok: true, data: { selected: target.id } };
    }
    default:
      return { id: cmd.id, ok: false, error: `Unknown tabs op: ${cmd.op}` };
  }
}

async function handleCookies(cmd: Command): Promise<Result> {
  const details: chrome.cookies.GetAllDetails = {};
  if (cmd.domain) details.domain = cmd.domain;
  if (cmd.url) details.url = cmd.url;
  const cookies = await chrome.cookies.getAll(details);
  const data = cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expirationDate: cookie.expirationDate,
  }));
  return { id: cmd.id, ok: true, data };
}

async function handleScreenshot(cmd: Command, workspace: string): Promise<Result> {
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await executor.screenshot(tabId, {
      format: cmd.format,
      quality: cmd.quality,
      fullPage: cmd.fullPage,
    });
    return { id: cmd.id, ok: true, data };
  } catch (error) {
    return { id: cmd.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleCloseWindow(cmd: Command, workspace: string): Promise<Result> {
  const session = automationSessions.get(workspace);
  if (session) {
    try {
      await chrome.windows.remove(session.windowId);
    } catch {
      // Window may already be closed.
    }
    if (session.idleTimer) clearTimeout(session.idleTimer);
    automationSessions.delete(workspace);
  }
  return { id: cmd.id, ok: true, data: { closed: true } };
}

async function handleSessions(cmd: Command): Promise<Result> {
  const now = Date.now();
  const data = await Promise.all([...automationSessions.entries()].map(async ([workspace, session]) => ({
    incognito: (await chrome.windows.get(session.windowId)).incognito,
    workspace,
    windowId: session.windowId,
    tabCount: (await chrome.tabs.query({ windowId: session.windowId })).filter((tab) => isDebuggableUrl(tab.url)).length,
    idleMsRemaining: Math.max(0, session.idleDeadlineAt - now),
  })));
  return { id: cmd.id, ok: true, data };
}

export const __test__ = {
  getAutomationWindow,
  handleTabs,
  handleSessions,
  getPopupState,
  startServing,
  stopServing,
  refreshPortSelection,
  getConfiguredPort: () => configuredPort,
  setConfiguredPort: (port: number) => {
    configuredPort = port;
  },
  getAutomationWindowId: (workspace: string = 'default') => automationSessions.get(workspace)?.windowId ?? null,
  setAutomationWindowId: (workspace: string, windowId: number | null) => {
    if (windowId === null) {
      const session = automationSessions.get(workspace);
      if (session?.idleTimer) clearTimeout(session.idleTimer);
      automationSessions.delete(workspace);
      return;
    }
    automationSessions.set(workspace, {
      windowId,
      idleTimer: null,
      idleDeadlineAt: Date.now() + WINDOW_IDLE_TIMEOUT,
    });
  },
};
