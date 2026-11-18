/**
 * Agent Browser Bridge service worker.
 *
 * Connects to the local daemon via WebSocket, receives commands,
 * dispatches them to Chrome APIs (debugger/tabs/cookies), and returns results.
 */

import type { BridgeControlMessage, Command, ProfileDescriptor, Result, WindowSnapshot } from './protocol';
import {
  DEFAULT_DAEMON_PORT,
  KEEPALIVE_ALARM_NAME,
  KEEPALIVE_ALARM_PERIOD_MINUTES,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_RECONNECT_BASE_DELAY,
  WS_RECONNECT_MAX_DELAY,
  getDaemonWsUrl,
} from './protocol';
import type { BridgeDaemonStatus, BridgePortScan } from './daemon-discovery';
import {
  clearDaemonProfileNameCache,
  fetchDaemonProfileName,
  scanDaemonPorts,
} from './daemon-discovery';
import { readBridgeRuntimeConfig, writeBridgeRuntimeConfig } from './runtime-config';
import {
  buildWindowSnapshots,
  describeProfile,
  findWindowSnapshot,
  getSelectedWindowId,
  getSessionStorageArea,
  registerTopologyListeners,
  setProfileName,
  setSelectedWindowId,
} from './window-state';
import * as executor from './cdp';
import { buildShieldMarkSnippet, buildShieldUnmarkSnippet } from './tab-marker';

type ConnectionState = 'idle' | 'connecting' | 'waiting' | 'connected' | 'error';

type PopupBridgeState = {
  servingEnabled: boolean;
  port: number;
  statusText: string;
  connectionState: ConnectionState;
  defaultPortBusy: boolean;
  /** True when a daemon answered the port scan; false means it is not running. */
  daemonDetected: boolean;
  instanceLabel: string;
  profileEmail: string;
  profileName: string;
  windowCount: number;
  selectedWindowId: number | null;
  /** One-line human-readable summary of the profile's windows. */
  windowSummary: string;
  activeTabTitle: string;
  activeTabId: number | null;
  activeWindowId: number | null;
  agentActivity: {
    active: boolean;
    tabId: number | null;
    action: string;
    at: number;
    endedAt: number | null;
    recent: boolean;
  } | null;
};

type AgentActivity = {
  type: 'agent-activity';
  phase: 'start' | 'end';
  id?: string;
  action?: string;
  tabId?: number | null;
  at?: number;
  target?: string | null;
  ok?: boolean;
};

type LastAgentActivity = {
  active: boolean;
  tabId: number | null;
  action: string;
  at: number;
  endedAt: number | null;
};

const AGENT_ACTIVITY_KEY = 'ttBridgeAgentActivity';

let lastAgentActivity: LastAgentActivity | null = null;
let agentActivityTimer: ReturnType<typeof setTimeout> | null = null;
let badgeClearTimer: ReturnType<typeof setTimeout> | null = null;
let activityCleanupTimer: ReturnType<typeof setTimeout> | null = null;

function clearBadge(): void {
  if (badgeClearTimer) {
    clearTimeout(badgeClearTimer);
    badgeClearTimer = null;
  }
  try {
    void chrome.action?.setBadgeText?.({ text: '' });
  } catch {
    // ignore
  }
}

function showActiveBadge(): void {
  if (badgeClearTimer) {
    clearTimeout(badgeClearTimer);
    badgeClearTimer = null;
  }
  try {
    void chrome.action?.setBadgeText?.({ text: 'AI' });
    void chrome.action?.setBadgeBackgroundColor?.({ color: '#07C160' });
  } catch {
    // ignore
  }
}

function scheduleBadgeClear(): void {
  if (badgeClearTimer) {
    clearTimeout(badgeClearTimer);
  }
  badgeClearTimer = setTimeout(() => {
    badgeClearTimer = null;
    clearBadge();
  }, 10000);
}

function scheduleActivityCleanup(delayMs = 300000): void {
  if (activityCleanupTimer) {
    clearTimeout(activityCleanupTimer);
    activityCleanupTimer = null;
  }
  activityCleanupTimer = setTimeout(() => {
    activityCleanupTimer = null;
    if (lastAgentActivity && !lastAgentActivity.active) {
      if (!lastAgentActivity.endedAt || Date.now() - lastAgentActivity.endedAt >= 300000) {
        lastAgentActivity = null;
        void persistAgentActivity();
      }
    }
  }, Math.max(0, delayMs));
}

async function loadAgentActivity(): Promise<void> {
  const area = getSessionStorageArea();
  if (!area) return;
  try {
    const stored = await area.get(AGENT_ACTIVITY_KEY);
    const value = stored[AGENT_ACTIVITY_KEY];
    if (value && typeof value === 'object') {
      const active = Boolean(value.active);
      const tabId = typeof value.tabId === 'number' ? value.tabId : null;
      const action = typeof value.action === 'string' ? value.action : 'unknown';
      const at = typeof value.at === 'number' ? value.at : Date.now();
      const endedAt = typeof value.endedAt === 'number' ? value.endedAt : null;
      if (!active && endedAt && Date.now() - endedAt >= 300000) {
        lastAgentActivity = null;
        await area.remove(AGENT_ACTIVITY_KEY);
        return;
      }
      lastAgentActivity = { active, tabId, action, at, endedAt };
      if (!active && endedAt) {
        const remaining = 300000 - (Date.now() - endedAt);
        scheduleActivityCleanup(remaining);
      }
    }
  } catch {
    // ignore
  }
}

async function persistAgentActivity(): Promise<void> {
  const area = getSessionStorageArea();
  if (!area) return;
  try {
    if (lastAgentActivity) {
      await area.set({ [AGENT_ACTIVITY_KEY]: lastAgentActivity });
    } else {
      await area.remove(AGENT_ACTIVITY_KEY);
    }
  } catch {
    // ignore
  }
}

/** Window/profile facts shown in the popup; every field degrades to a neutral value. */
type PopupWindowInfo = {
  profileEmail: string;
  profileName: string;
  windowCount: number;
  selectedWindowId: number | null;
  windowSummary: string;
  activeTabTitle: string;
  activeTabId: number | null;
  activeWindowId: number | null;
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

// ─── Instance identity & tab pinning ─────────────────────────────────
// Each Chrome profile labels itself so the daemon (and the user) can tell
// multiple running browsers apart, and the agent can pin the tab it works on
// without stealing the human's focus.

const INSTANCE_LABEL_KEY = 'ttBridgeInstanceLabel';
const PINNED_TAB_KEY = 'ttBridgePinnedTabId';
/**
 * Stable connection identity of this Chrome profile, created once and reported
 * to the daemon as `profileId`. Without it the daemon cannot tell "the same
 * profile reconnected" from "two profiles share a label", and one of them gets
 * evicted forever.
 */
const PROFILE_ID_KEY = 'ttBridgeProfileId';

let pinnedTabIdCache: number | null = null;

function makeDefaultInstanceLabel(): string {
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 4);
  return `chrome-${suffix}`;
}

async function getInstanceLabel(): Promise<string> {
  const stored = await chrome.storage.local.get(INSTANCE_LABEL_KEY);
  const existing = stored[INSTANCE_LABEL_KEY];
  if (typeof existing === 'string' && existing.trim()) {
    return existing.trim();
  }
  const label = makeDefaultInstanceLabel();
  await chrome.storage.local.set({ [INSTANCE_LABEL_KEY]: label });
  return label;
}

async function setInstanceLabel(newLabel: string): Promise<string> {
  const trimmed = newLabel.trim().slice(0, 60);
  if (!trimmed) {
    throw new Error('Instance label cannot be empty');
  }
  await chrome.storage.local.set({ [INSTANCE_LABEL_KEY]: trimmed });
  return trimmed;
}

let profileIdCache: string | null = null;

/** This profile's stable connection identity; minted once, then reused. */
async function getProfileId(): Promise<string> {
  if (profileIdCache) {
    return profileIdCache;
  }
  const stored = await chrome.storage.local.get(PROFILE_ID_KEY);
  const existing = stored[PROFILE_ID_KEY];
  if (typeof existing === 'string' && existing.trim()) {
    profileIdCache = existing.trim();
    return profileIdCache;
  }
  const created = crypto.randomUUID();
  await chrome.storage.local.set({ [PROFILE_ID_KEY]: created });
  profileIdCache = created;
  return created;
}

/** Handshake variant: identity enrichment must never block a connect. */
async function getProfileIdSafe(): Promise<string | null> {
  try {
    return await getProfileId();
  } catch {
    return null;
  }
}

async function getPinnedTabId(): Promise<number | null> {
  if (pinnedTabIdCache !== null) {
    return pinnedTabIdCache;
  }
  const area = getSessionStorageArea();
  if (!area) {
    return null;
  }
  try {
    const stored = await area.get(PINNED_TAB_KEY);
    const value = stored[PINNED_TAB_KEY];
    if (typeof value === 'number' && Number.isFinite(value)) {
      pinnedTabIdCache = value;
      return value;
    }
  } catch {
    // Best-effort persistence only.
  }
  return null;
}

async function setPinnedTabId(tabId: number | null): Promise<void> {
  pinnedTabIdCache = tabId;
  const area = getSessionStorageArea();
  if (!area) {
    return;
  }
  try {
    if (tabId === null) {
      await area.remove(PINNED_TAB_KEY);
    } else {
      await area.set({ [PINNED_TAB_KEY]: tabId });
    }
  } catch {
    // The in-memory cache still covers this service-worker lifetime.
  }
}

// ─── Agent tab shield ────────────────────────────────────────────────
// The tab the agent is working on gets a green shield instead of its site
// favicon. Chrome has no favicon API, so the marker is a page-side
// `<link rel="icon">` rewrite (see tab-marker.ts). It expires on its own: the
// page drops it `SHIELD_TTL_MS` after the last command re-stamped it, so a
// dead service worker can never leave a shield behind.

/**
 * How long the shield survives without a command re-stamping it. Bounded on
 * purpose: a stale shield after a worker restart must clear itself, and the
 * page-side timer is the only cleanup that needs no debugger attach.
 */
const SHIELD_TTL_MS = 120_000;
/** Re-stamp at most this often per tab; the page-side timer keeps the icon up. */
const SHIELD_REFRESH_MS = 20_000;

/** The tab currently wearing the shield, and when it was last stamped. */
let shieldedTabId: number | null = null;
let shieldedAt = 0;

/**
 * Shield the tab the agent is about to operate. Best-effort: a tab that cannot
 * be evaluated (closed mid-flight, DevTools holding the debugger) keeps its own
 * favicon and the command still runs.
 *
 * Exactly one tab carries the shield. When the target moves (unpinned agent
 * following the human's tab), the previous shield is dropped immediately
 * instead of waiting out its TTL.
 */
async function markAgentTab(tabId: number, force = false): Promise<void> {
  if (shieldedTabId !== null && shieldedTabId !== tabId) {
    await unmarkAgentTab(shieldedTabId);
  }
  if (!force && shieldedTabId === tabId && Date.now() - shieldedAt < SHIELD_REFRESH_MS) {
    return;
  }
  shieldedTabId = tabId;
  shieldedAt = Date.now();
  try {
    await executor.evaluate(tabId, buildShieldMarkSnippet(SHIELD_TTL_MS));
  } catch {
    // Cosmetic only; never fail a command because the icon could not change.
  }
}

/** Drop the shield early (pin released, tab closed) and restore the site icon. */
async function unmarkAgentTab(tabId: number): Promise<void> {
  if (shieldedTabId === tabId) {
    shieldedTabId = null;
    shieldedAt = 0;
  }
  try {
    await executor.evaluate(tabId, buildShieldUnmarkSnippet());
  } catch {
    // The tab is gone or the page navigated away: nothing left to restore.
  }
}

/** Forget a closed tab so a reused tab id is never mistaken for a shielded one. */
function forgetShield(tabId: number): void {
  if (shieldedTabId === tabId) {
    shieldedTabId = null;
    shieldedAt = 0;
  }
}

// ─── Window & profile awareness ──────────────────────────────────────
// Every window of this profile, plus the account behind it, is reported to the
// daemon: in the `hello` handshake and in debounced `windows` events. The daemon
// turns the account identity into a Chrome profile name (it can read `Local
// State`; an extension cannot).

/** Window/tab topology as the daemon sees it. Counts stay plain numbers. */
type TopologySnapshot = {
  windowList: WindowSnapshot[];
  windows: number;
  tabs: number;
  selectedWindowId: number | null;
};

async function countAllTabs(): Promise<number> {
  try {
    return (await chrome.tabs.query({})).length;
  } catch {
    return 0;
  }
}

async function collectTopology(): Promise<TopologySnapshot> {
  const windowList = await buildWindowSnapshots();
  return {
    windowList,
    windows: windowList.length,
    tabs: await countAllTabs(),
    selectedWindowId: await getSelectedWindowId(),
  };
}

/** Instance label + signed-in account; `name` is only a local override, never invented. */
async function getProfileDescriptor(): Promise<ProfileDescriptor> {
  let label = '';
  try {
    label = await getInstanceLabel();
  } catch {
    label = '';
  }
  return describeProfile(label);
}

/** Push the current topology. Only meaningful while a socket is open. */
async function sendTopologyEvent(socket: WebSocket): Promise<void> {
  try {
    const [topology, profile, profileId] = await Promise.all([
      collectTopology(),
      getProfileDescriptor(),
      getProfileIdSafe(),
    ]);
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({
      type: 'windows',
      windows: topology.windows,
      windowList: topology.windowList,
      tabs: topology.tabs,
      selectedWindowId: topology.selectedWindowId,
      profile,
      profileId,
      ts: Date.now(),
    }));
  } catch {
    // Topology pushes are best-effort: the next event, or the next hello, repairs state.
  }
}

function emitTopologyEvent(): void {
  const socket = ws;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    // Never emit during reconnect; the fresh hello carries the whole state.
    return;
  }
  void sendTopologyEvent(socket);
}

// Synchronous, top-level registration: an MV3 service worker that is woken by a
// tab/window event must already have its listeners armed.
registerTopologyListeners(emitTopologyEvent);

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

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Keep this worker alive for as long as Serving does. Chrome 116+ resets its 30s
 * idle timer on WebSocket message flow, so a ping every 20s is what stops the
 * worker from being killed mid-session (and with it the connection).
 */
function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    const socket = ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      stopHeartbeat();
      return;
    }
    const frame: BridgeControlMessage = { type: 'ping', ts: Date.now() };
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // A wedged socket is the reconnect path's problem, never the heartbeat's.
    }
  }, WS_HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function setBridgeStatus(nextState: ConnectionState, nextStatusText: string): void {
  connectionState = nextState;
  statusText = nextStatusText;
}

function buildIdleStatus(scan: BridgePortScan | null, port: number): string {
  if (scan?.daemonPort !== null) {
    return `已检测到本地服务（端口 ${port}），点「允许 AI 控制」即可连接。`;
  }
  if (scan?.defaultPortBusy && port !== DEFAULT_DAEMON_PORT) {
    return `默认端口 ${DEFAULT_DAEMON_PORT} 被占用，将使用端口 ${port}。`;
  }
  return `准备就绪（端口 ${port}）。`;
}

function buildWaitingStatus(scan: BridgePortScan | null, port: number): string {
  if (scan?.defaultPortBusy && port !== DEFAULT_DAEMON_PORT) {
    return `默认端口 ${DEFAULT_DAEMON_PORT} 被占用，正在等待本地服务在 ${port} 启动。`;
  }
  return '正在等待本地服务启动。';
}

function buildConnectingStatus(port: number): string {
  return `Connecting to local daemon on ${port}.`;
}

function buildConnectedStatus(port: number): string {
  return `Serving on ${port}.`;
}

function disconnectSocket(): void {
  stopHeartbeat();
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

  if (!servingEnabled) {
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

/**
 * Announce this Chrome profile to the daemon: stable label (editable in the
 * popup), extension version, the profile identity the daemon maps to a Chrome
 * profile, and the full window/tab topology. Sent on connect and after state
 * changes (rename, window switch). Best-effort: every field that Chrome refuses
 * to answer degrades instead of failing the handshake.
 */
async function sendHello(socket: WebSocket): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  let label: string | null = null;
  let profile: ProfileDescriptor | null = null;
  let profileId: string | null = null;
  let windowList: WindowSnapshot[] = [];
  let tabs = 0;
  let selectedWindowId: number | null = null;
  let pinnedTabId: number | null = null;

  try {
    label = await getInstanceLabel();
  } catch {
    // Identity enrichment is best-effort; send whatever we have.
  }
  try {
    profile = await getProfileDescriptor();
  } catch {
    // Profile identity is best-effort.
  }
  try {
    profileId = await getProfileId();
  } catch {
    // The daemon treats a missing profileId as unknown identity.
  }
  try {
    windowList = await buildWindowSnapshots();
  } catch {
    // Window list is best-effort.
  }
  try {
    tabs = await countAllTabs();
  } catch {
    // Tab count is best-effort.
  }
  try {
    selectedWindowId = await getSelectedWindowId();
  } catch {
    // Selection is best-effort.
  }
  try {
    pinnedTabId = await getPinnedTabId();
  } catch {
    // Pin state is best-effort.
  }

  try {
    socket.send(JSON.stringify({
      type: 'hello',
      role: 'extension',
      version: chrome.runtime.getManifest().version,
      extensionId: chrome.runtime.id,
      label,
      profile,
      profileId,
      windows: windowList.length,
      windowList,
      tabs,
      selectedWindowId,
      pinnedTabId,
      ts: Date.now(),
    }));
  } catch {
    // Socket may have closed during the awaits; reconnect logic will retry.
  }
}

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
    void sendHello(socket);
    reconnectAttempts = 0;
    clearReconnectTimer();
    startHeartbeat();
    clearBadge();
    setBridgeStatus('connected', buildConnectedStatus(targetPort));
  };

  socket.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data as string) as Command | BridgeControlMessage | AgentActivity;
      if ((message as BridgeControlMessage).type === 'pong') {
        // Heartbeat ack: answering it would read as unmatched noise in the daemon.
        return;
      }
      if ((message as AgentActivity).type === 'agent-activity') {
        const activity = message as AgentActivity;
        const myLabel = await getInstanceLabel();
        if (activity.target && activity.target !== myLabel && activity.target.toLowerCase() !== myLabel.toLowerCase()) {
          return;
        }
        if (activity.phase === 'start') {
          if (agentActivityTimer) {
            clearTimeout(agentActivityTimer);
            agentActivityTimer = null;
          }
          if (activityCleanupTimer) {
            clearTimeout(activityCleanupTimer);
            activityCleanupTimer = null;
          }
          let resolvedTabId: number | null = typeof activity.tabId === 'number' ? activity.tabId : null;
          if (resolvedTabId === null) {
            try {
              const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
              if (activeTabs[0] && typeof activeTabs[0].id === 'number') {
                resolvedTabId = activeTabs[0].id;
              }
            } catch {
              // Ignore failure, retain null
            }
          }
          lastAgentActivity = {
            active: true,
            tabId: resolvedTabId,
            action: typeof activity.action === 'string' ? activity.action : 'unknown',
            at: typeof activity.at === 'number' ? activity.at : Date.now(),
            endedAt: null,
          };
          showActiveBadge();
          void persistAgentActivity();
          agentActivityTimer = setTimeout(() => {
            agentActivityTimer = null;
            if (lastAgentActivity) {
              lastAgentActivity.active = false;
              lastAgentActivity.endedAt = Date.now();
              void persistAgentActivity();
              scheduleBadgeClear();
              scheduleActivityCleanup();
            }
          }, 35000);
        } else if (activity.phase === 'end') {
          if (agentActivityTimer) {
            clearTimeout(agentActivityTimer);
            agentActivityTimer = null;
          }
          const endedAt = Date.now();
          if (lastAgentActivity) {
            lastAgentActivity.active = false;
            lastAgentActivity.endedAt = endedAt;
          } else {
            lastAgentActivity = {
              active: false,
              tabId: typeof activity.tabId === 'number' ? activity.tabId : null,
              action: typeof activity.action === 'string' ? activity.action : 'unknown',
              at: typeof activity.at === 'number' ? activity.at : endedAt,
              endedAt,
            };
          }
          scheduleBadgeClear();
          scheduleActivityCleanup();
          void persistAgentActivity();
        }
        return;
      }
      const result = await handleCommand(message as Command);
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
    stopHeartbeat();

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
  // Stopping serving must release every debugger attachment, otherwise the
  // "being debugged" banner and the CDP session linger on the user's tabs.
  executor.detachAll();
  await refreshPortSelection('popup');
  setBridgeStatus('idle', buildIdleStatus(lastScan, configuredPort));
}

function buildPopupState(instanceLabel: string, windowInfo: PopupWindowInfo): PopupBridgeState {
  const isActivityActive = Boolean(
    lastAgentActivity &&
      ((lastAgentActivity.active && Date.now() - lastAgentActivity.at < 35000) ||
        (lastAgentActivity.endedAt !== null && Date.now() - lastAgentActivity.endedAt < 10000))
  );
  let agentActivity: PopupBridgeState['agentActivity'] = null;
  if (lastAgentActivity) {
    const endedAt = lastAgentActivity.endedAt;
    const recent = Boolean(
      !isActivityActive && endedAt !== null && Date.now() - endedAt < 300000
    );
    agentActivity = {
      ...lastAgentActivity,
      active: isActivityActive,
      endedAt,
      recent,
    };
  }

  return {
    servingEnabled,
    port: configuredPort,
    statusText,
    connectionState,
    defaultPortBusy: Boolean(lastScan?.defaultPortBusy),
    daemonDetected: Boolean(lastScan && lastScan.daemonPort !== null),
    instanceLabel,
    agentActivity,
    ...windowInfo,
  };
}

function buildWindowSummary(windowCount: number, tabs: number, selectedWindowId: number | null): string {
  if (windowCount === 0) {
    return 'Window info unavailable.';
  }
  const windowLabel = windowCount === 1 ? '1 window' : `${windowCount} windows`;
  const tabLabel = tabs === 1 ? '1 tab' : `${tabs} tabs`;
  const selection = selectedWindowId === null
    ? 'no window selected'
    : `window ${selectedWindowId} selected`;
  return `${windowLabel} · ${tabLabel} · ${selection}`;
}

/**
 * Window/profile facts for the popup, fetched only when someone asks for them.
 * Chrome APIs can fail (no permission, no profile, sleeping worker), so every
 * source degrades on its own and the popup still renders.
 */
async function collectPopupWindowInfo(): Promise<PopupWindowInfo> {
  const [profile, topology, activeTabs] = await Promise.all([
    getProfileDescriptor().catch(() => null),
    collectTopology().catch(() => null),
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [] as chrome.tabs.Tab[]),
  ]);

  // The local override wins immediately; otherwise the daemon resolves the
  // Chrome profile name (it can read `Local State`; an extension cannot).
  const localOverride = profile?.name ?? '';
  const daemonName = await fetchDaemonProfileName(configuredPort, {
    profileId: await getProfileIdSafe(),
    label: profile?.label ?? '',
  });

  const windowCount = topology?.windows ?? 0;
  const selectedWindowId = topology?.selectedWindowId ?? null;
  const activeTab = activeTabs?.[0];
  const activeTabTitle = activeTab?.title ?? '';
  const activeTabId = typeof activeTab?.id === 'number' ? activeTab.id : null;
  const activeWindowId = typeof activeTab?.windowId === 'number' ? activeTab.windowId : null;
  return {
    profileEmail: profile?.email ?? '',
    profileName: localOverride || daemonName,
    windowCount,
    selectedWindowId,
    windowSummary: buildWindowSummary(windowCount, topology?.tabs ?? 0, selectedWindowId),
    activeTabTitle,
    activeTabId,
    activeWindowId,
  };
}

async function getPopupState(): Promise<PopupBridgeState> {
  await refreshPortSelection('popup');
  if (servingEnabled && !isSocketConnected()) {
    void connect('popup');
  }
  const [instanceLabel, windowInfo] = await Promise.all([
    getInstanceLabel(),
    collectPopupWindowInfo(),
  ]);
  return buildPopupState(instanceLabel, windowInfo);
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
  chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: KEEPALIVE_ALARM_PERIOD_MINUTES });
  executor.registerListeners();
  clearBadge();
  await loadAgentActivity();

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

/** An initialize() failure must not surface as an unhandled rejection in the worker. */
function reportInitializationFailure(error: unknown): void {
  console.warn(
    '[agent-browser-bridge] Initialization failed:',
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * Bring a dropped connection back the moment the user does anything in Chrome.
 *
 * Every top-level listener below may be the reason this worker was woken, so it
 * must run `ensureInitialized()` first: `servingEnabled` lives in memory and is
 * only false on a cold worker because nothing has read the stored config yet.
 */
function wakeForReconnect(): void {
  if (isSocketConnected()) {
    return;
  }
  if (ws?.readyState === WebSocket.CONNECTING) {
    return;
  }
  void ensureInitialized()
    .then(() => {
      if (servingEnabled && !isSocketConnected()) {
        void connect('reconnect');
      }
    })
    .catch(reportInitializationFailure);
}

let gestureWakeRegistered = false;

/**
 * Gestures are the only wake-up with millisecond latency; the keepalive alarm is
 * a 30s backstop. Registration is synchronous and idempotent so an MV3 restart
 * re-arms it without stacking duplicate listeners.
 */
function registerGestureWakeListeners(): void {
  if (gestureWakeRegistered) {
    return;
  }
  gestureWakeRegistered = true;
  chrome.tabs.onActivated?.addListener(() => wakeForReconnect());
  chrome.windows.onFocusChanged?.addListener(() => wakeForReconnect());
  chrome.windows.onCreated?.addListener(() => wakeForReconnect());
}

registerGestureWakeListeners();

chrome.runtime.onInstalled.addListener(() => {
  void ensureInitialized();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureInitialized();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM_NAME) {
    return;
  }
  void ensureInitialized()
    .then(() => {
      if (servingEnabled && !isSocketConnected()) {
        void connect('reconnect');
      }
    })
    .catch(reportInitializationFailure);
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

      if (message?.type === 'ttbridge:retry-connection') {
        // The popup resets the backoff when the human copies the startup
        // prompt, so the next attempt is immediate once the agent starts the
        // daemon instead of waiting for the exponential timer.
        reconnectAttempts = 0;
        clearReconnectTimer();
        if (servingEnabled) {
          await connect('popup');
        }
        sendResponse(await getPopupState());
        return;
      }

      if (message?.type === 'ttbridge:set-instance-label') {
        await setInstanceLabel(String(message.label ?? ''));
        if (ws && ws.readyState === WebSocket.OPEN) {
          void sendHello(ws);
        }
        sendResponse(await getPopupState());
        return;
      }

      if (message?.type === 'ttbridge:set-profile-name') {
        await setProfileName(String(message.name ?? ''));
        clearDaemonProfileNameCache();
        if (ws && ws.readyState === WebSocket.OPEN) {
          void sendHello(ws);
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
        statusText: error instanceof Error ? error.message : 'Failed to initialize TT bridge.',
        connectionState: 'error',
        defaultPortBusy: false,
        daemonDetected: false,
        instanceLabel: '',
        profileEmail: '',
        profileName: '',
        windowCount: 0,
        selectedWindowId: null,
        windowSummary: 'Window info unavailable.',
        activeTabTitle: '',
        activeTabId: null,
        activeWindowId: null,
        agentActivity: null,
      };
      sendResponse(fallbackState);
    });

  return true;
});

// ─── Command dispatcher ─────────────────────────────────────────────

async function handleCommand(cmd: Command): Promise<Result> {
  const workspace = getWorkspaceKey(cmd.workspace);
  if (workspace !== 'human') {
    resetWindowIdleTimer(workspace);
  }
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
      case 'input':
        return await handleInput(cmd, workspace);
      case 'focus':
        return await handleFocus(cmd, workspace);
      case 'key':
        return await handleKey(cmd, workspace);
      case 'emulate':
        return await handleEmulate(cmd, workspace);
      case 'instance':
        return await handleInstance(cmd);
      case 'windows':
        return await handleWindows(cmd);
      case 'reload':
        return await handleReload(cmd);
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
  return !url.startsWith('chrome://')
    && !url.startsWith('chrome-extension://')
    && !url.startsWith('file://')
    && !url.startsWith('view-source:')
    && !url.startsWith('devtools://');
}

/** Only plain web pages may be navigated to; privileged schemes are off-limits. */
function isNavigableUrl(url: string): boolean {
  if (url === 'about:blank') return true;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

async function listHumanTabs(): Promise<chrome.tabs.Tab[]> {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => tab.id && isDebuggableUrl(tab.url));
}

/** Validate a tab id for human-workspace debugging; returns the id or null. */
async function validateHumanTab(tabId: number): Promise<number | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.id && isDebuggableUrl(tab.url)) {
      return tab.id;
    }
  } catch {
    // Tab is gone.
  }
  return null;
}

/**
 * Pick a human tab without changing focus.
 * Priority: explicit --tab > cmd.index (over the human tab list) > selected window > current active tab.
 */
async function resolveHumanCandidate(cmd: Command): Promise<chrome.tabs.Tab | null> {
  if (cmd.tabId !== undefined) {
    const valid = await validateHumanTab(cmd.tabId);
    if (valid === null) {
      return null;
    }
    try {
      return await chrome.tabs.get(valid);
    } catch {
      return null;
    }
  }
  if (cmd.index !== undefined) {
    const tabs = await listHumanTabs();
    return tabs[cmd.index] ?? null;
  }
  const selectedWindowId = await getSelectedWindowId();
  if (selectedWindowId !== null) {
    try {
      const win = await chrome.windows.get(selectedWindowId, { populate: true });
      const activeTab = (win.tabs ?? []).find((tab) => tab.active);
      if (activeTab && activeTab.id && isDebuggableUrl(activeTab.url)) {
        return activeTab;
      }
    } catch {
      await setSelectedWindowId(null);
    }
  }
  const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return active.find((tab) => tab.id && isDebuggableUrl(tab.url)) ?? null;
}

/**
 * Active tab of a window the agent pinned with `windows use`.
 * A window that no longer exists clears the stale selection (returns null so the
 * caller falls back); a window that exists but has no debuggable active tab is
 * an error, because silently retargeting another window would defeat the pin.
 */
async function resolveSelectedWindowTabId(windowId: number): Promise<number | null> {
  let win: chrome.windows.Window;
  try {
    win = await chrome.windows.get(windowId, { populate: true });
  } catch {
    // The window is gone (the worker may have been asleep for its onRemoved).
    await setSelectedWindowId(null);
    return null;
  }

  const active = (win.tabs ?? []).find((tab) => tab.active);
  if (!active?.id) {
    throw new Error(`Selected window ${windowId} has no active tab`);
  }
  if (!isDebuggableUrl(active.url)) {
    throw new Error(
      `Active tab ${active.id} of selected window ${windowId} is not debuggable (${active.url ?? 'unknown url'})`,
    );
  }
  return active.id;
}

/**
 * Resolve the tab a command will act on, then shield it so the human can see
 * which tab the agent is driving.
 *
 * Marking is awaited, not fired in parallel: two concurrent `debugger.attach`
 * calls for the same tab race, and the loser detaches the winner's session.
 * It never throws, so a cosmetic failure cannot fail the command.
 */
async function resolveTabId(tabId: number | undefined, workspace: string): Promise<number> {
  const resolved = await resolveTabIdTarget(tabId, workspace);
  if (workspace === 'human') {
    await markAgentTab(resolved);
  }
  return resolved;
}

async function resolveTabIdTarget(tabId: number | undefined, workspace: string): Promise<number> {
  if (workspace === 'human') {
    // 1) Explicit one-shot target wins (does not change the pin).
    if (tabId !== undefined) {
      const explicit = await validateHumanTab(tabId);
      if (explicit !== null) return explicit;
      throw new Error(`Tab ${tabId} is not available for debugging (closed or non-debuggable URL)`);
    }

    // 2) Pinned tab: stay on it no matter where the human browses.
    const pinned = await getPinnedTabId();
    if (pinned !== null) {
      const valid = await validateHumanTab(pinned);
      if (valid !== null) return valid;
      await setPinnedTabId(null);
      throw new Error(
        `Pinned tab ${pinned} is no longer available (closed or non-debuggable URL). `
        + 'Re-pin with "tt-bridge tab pin" or pass "--tab <id>" for a one-shot target.',
      );
    }

    // 3) A window explicitly selected with `windows use` outranks whatever the
    //    human is currently looking at, so the target stays put while they work.
    const selectedWindowId = await getSelectedWindowId();
    if (selectedWindowId !== null) {
      const selectedTabId = await resolveSelectedWindowTabId(selectedWindowId);
      if (selectedTabId !== null) return selectedTabId;
    }

    // 4) Default: follow the human's active tab.
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const target = tabs.find((tab) => tab.active && tab.id) ?? tabs[0];
    if (target?.id && isDebuggableUrl(target.url)) return target.id;
    throw new Error(
      'Active tab is a browser/extension page. Switch Chrome to a normal web page, or run "tt-bridge tab pin --tab <id>".',
    );
  }

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

async function getTabContext(tabId: number): Promise<{ url?: string; title?: string }> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const context: { url?: string; title?: string } = {};
    if (tab?.url) context.url = tab.url;
    if (tab?.title) context.title = tab.title;
    return context;
  } catch {
    return {};
  }
}

async function handleExec(cmd: Command, workspace: string): Promise<Result> {
  if (!cmd.code) return { id: cmd.id, ok: false, error: 'Missing code' };
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await executor.evaluateAsync(tabId, cmd.code);
    const tabContext = await getTabContext(tabId);
    return { id: cmd.id, ok: true, data, ...tabContext };
  } catch (error) {
    return { id: cmd.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleNavigate(cmd: Command, workspace: string): Promise<Result> {
  if (!cmd.url) return { id: cmd.id, ok: false, error: 'Missing url' };
  if (!isNavigableUrl(cmd.url)) {
    return { id: cmd.id, ok: false, error: `Refusing to navigate to non-http(s) URL: ${cmd.url}` };
  }
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

  // A full page load replaces the document, so the shield must be re-applied.
  if (workspace === 'human') {
    await markAgentTab(tabId, true);
  }
  const tabContext = await getTabContext(tabId);
  return {
    id: cmd.id,
    ok: true,
    data: { title: tabContext.title, url: tabContext.url, tabId, timedOut },
    ...tabContext,
  };
}

async function handleTabs(cmd: Command, workspace: string): Promise<Result> {
  switch (cmd.op) {
    case 'list': {
      if (workspace === 'human') {
        const tabs = await listHumanTabs();
        const pinned = await getPinnedTabId();
        const data = tabs.map((tab, index) => ({
          index,
          tabId: tab.id,
          windowId: tab.windowId,
          active: Boolean(tab.active),
          url: tab.url,
          title: tab.title,
          bridgePinned: tab.id === pinned,
        }));
        return { id: cmd.id, ok: true, data };
      }
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
      if (workspace === 'human') {
        // Human workspace: open the page in a BACKGROUND tab so the agent
        // never visibly switches the human's view. Pass background:false to
        // force a foreground tab (rarely wanted).
        const active = cmd.background === false;
        const tab = await chrome.tabs.create({
          url: cmd.url ?? 'about:blank',
          active,
        });
        const data: Record<string, unknown> = { tabId: tab.id, url: tab.url, background: !active, active };
        if (cmd.mute) {
          await chrome.tabs.update(tab.id!, { muted: true });
          data.muted = true;
        }
        return { id: cmd.id, ok: true, data };
      }
      const windowId = await getAutomationWindow(workspace);
      const tab = await chrome.tabs.create({ windowId, url: cmd.url ?? AUTOMATION_WINDOW_URL, active: true });
      const data: Record<string, unknown> = { tabId: tab.id, url: tab.url };
      if (cmd.mute) {
        await chrome.tabs.update(tab.id!, { muted: true });
        data.muted = true;
      }
      return { id: cmd.id, ok: true, data };
    }
    case 'pin': {
      if (workspace !== 'human') {
        return { id: cmd.id, ok: false, error: 'tab pin only applies to the human workspace (--human)' };
      }
      const candidate = await resolveHumanCandidate(cmd);
      if (!candidate?.id) {
        return { id: cmd.id, ok: false, error: 'No matching debuggable tab to pin' };
      }
      await setPinnedTabId(candidate.id);
      await markAgentTab(candidate.id);
      if (ws && ws.readyState === WebSocket.OPEN) void sendHello(ws);
      return {
        id: cmd.id,
        ok: true,
        data: { pinned: true, tabId: candidate.id, url: candidate.url, title: candidate.title },
      };
    }
    case 'unpin': {
      const pinned = await getPinnedTabId();
      await setPinnedTabId(null);
      if (pinned !== null) {
        await unmarkAgentTab(pinned);
      }
      if (ws && ws.readyState === WebSocket.OPEN) void sendHello(ws);
      return { id: cmd.id, ok: true, data: { pinned: false } };
    }
    case 'pin-status': {
      const pinned = await getPinnedTabId();
      if (pinned === null) {
        return { id: cmd.id, ok: true, data: { pinned: false } };
      }
      try {
        const tab = await chrome.tabs.get(pinned);
        if (!isDebuggableUrl(tab.url)) {
          throw new Error('non-debuggable');
        }
        return {
          id: cmd.id,
          ok: true,
          data: { pinned: true, tabId: pinned, url: tab.url, title: tab.title },
        };
      } catch {
        await setPinnedTabId(null);
        return { id: cmd.id, ok: true, data: { pinned: false, cleared: true } };
      }
    }
    case 'close': {
      if (cmd.index !== undefined) {
        const tabs = workspace === 'human'
          ? await listHumanTabs()
          : await listAutomationWebTabs(workspace);
        const target = tabs[cmd.index];
        if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
        await chrome.tabs.remove(target.id);
        executor.detach(target.id);
        forgetShield(target.id);
        if ((await getPinnedTabId()) === target.id) {
          await setPinnedTabId(null);
        }
        return { id: cmd.id, ok: true, data: { closed: target.id } };
      }
      const tabId = await resolveTabId(cmd.tabId, workspace);
      await chrome.tabs.remove(tabId);
      executor.detach(tabId);
      forgetShield(tabId);
      if ((await getPinnedTabId()) === tabId) {
        await setPinnedTabId(null);
      }
      return { id: cmd.id, ok: true, data: { closed: tabId } };
    }
    case 'select': {
      if (cmd.index === undefined && cmd.tabId === undefined) {
        return { id: cmd.id, ok: false, error: 'Missing index or tabId' };
      }
      if (workspace === 'human') {
        // Never steal focus in the human workspace: pin the chosen tab instead of activating it.
        const candidate = await resolveHumanCandidate(cmd);
        if (!candidate?.id) {
          return { id: cmd.id, ok: false, error: 'No matching debuggable tab to select' };
        }
        await setPinnedTabId(candidate.id);
        await markAgentTab(candidate.id);
        if (ws && ws.readyState === WebSocket.OPEN) void sendHello(ws);
        return {
          id: cmd.id,
          ok: true,
          data: {
            selected: candidate.id,
            pinned: true,
            activated: false,
            url: candidate.url,
            title: candidate.title,
          },
        };
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
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    if (win.state === 'minimized' && typeof win.id === 'number') {
      // macOS unloads the hardware rendering surface of minimized windows, so
      // Page.captureScreenshot either hangs ~30s or returns a black frame.
      if (workspace === 'human' && cmd.restoreWindow) {
        await chrome.windows.update(win.id, { state: 'normal' });
      } else {
        const hint = workspace === 'human'
          ? ' Re-run with --restore to bring the window back to normal first.'
          : ' Restore the window (or use a non-minimized workspace window) before capturing.';
        return {
          id: cmd.id,
          ok: false,
          error: `Window ${win.id} is minimized; screenshots hang or capture a black frame.${hint}`,
        };
      }
    }
    const data = await executor.screenshot(tabId, {
      format: cmd.format,
      quality: cmd.quality,
      fullPage: cmd.fullPage,
      mobile: cmd.mobile,
    });
    const tabContext = await getTabContext(tabId);
    return { id: cmd.id, ok: true, data, ...tabContext };
  } catch (error) {
    return { id: cmd.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleInput(cmd: Command, workspace: string): Promise<Result> {
  if (typeof cmd.text !== 'string' || cmd.text.length === 0) {
    return { id: cmd.id, ok: false, error: 'Missing text' };
  }
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    await executor.insertText(tabId, cmd.text);
    const tabContext = await getTabContext(tabId);
    return { id: cmd.id, ok: true, data: { inserted: cmd.text.length, tabId }, ...tabContext };
  } catch (error) {
    return { id: cmd.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleFocus(cmd: Command, workspace: string): Promise<Result> {
  if (!cmd.selector) return { id: cmd.id, ok: false, error: 'Missing selector' };
  const tabId = await resolveTabId(cmd.tabId, workspace);
  const selectorJson = JSON.stringify(cmd.selector);
  const snippet = `(() => {
    const node = document.querySelector(${selectorJson});
    if (!node) throw new Error('Selector not found: ' + ${selectorJson});
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
  try {
    const coords = await executor.evaluateAsync(tabId, snippet) as { x: number; y: number } | undefined;
    if (!coords || typeof coords.x !== 'number' || typeof coords.y !== 'number') {
      return { id: cmd.id, ok: false, error: 'Failed to resolve element center' };
    }
    await executor.mouseClickAt(tabId, coords.x, coords.y);
    const tabContext = await getTabContext(tabId);
    return { id: cmd.id, ok: true, data: { selector: cmd.selector, x: coords.x, y: coords.y, tabId }, ...tabContext };
  } catch (error) {
    return { id: cmd.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleKey(cmd: Command, workspace: string): Promise<Result> {
  if (!cmd.key) return { id: cmd.id, ok: false, error: 'Missing key' };
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    await executor.pressKey(tabId, cmd.key);
    const tabContext = await getTabContext(tabId);
    return { id: cmd.id, ok: true, data: { pressed: cmd.key }, ...tabContext };
  } catch (error) {
    return { id: cmd.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleEmulate(cmd: Command, workspace: string): Promise<Result> {
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    if (cmd.reset) {
      await executor.clearDeviceMetrics(tabId);
      await executor.setTouchEmulation(tabId, false);
      await executor.setUserAgentOverride(tabId, '');
      return { id: cmd.id, ok: true, data: { reset: true, tabId } };
    }

    let width = cmd.width;
    let height = cmd.height;
    let deviceScaleFactor = cmd.deviceScaleFactor;
    let mobile = cmd.mobile;
    let touch = cmd.touch;
    let userAgent = cmd.userAgent;
    let presetName: string | undefined;

    if (cmd.device) {
      const preset = executor.getDevicePreset(cmd.device);
      if (!preset) {
        const available = Object.keys(executor.DEVICE_PRESETS).join(', ');
        return {
          id: cmd.id,
          ok: false,
          error: `Unknown device preset: ${cmd.device}. Available presets: ${available}`,
        };
      }
      presetName = executor.normalizeDeviceName(cmd.device);
      // Explicit params override preset values.
      width = width ?? preset.width;
      height = height ?? preset.height;
      deviceScaleFactor = deviceScaleFactor ?? preset.deviceScaleFactor;
      mobile = mobile ?? preset.mobile;
      touch = touch ?? preset.touch;
      userAgent = userAgent ?? preset.userAgent;
    }

    if (width === undefined || height === undefined) {
      return { id: cmd.id, ok: false, error: 'Missing width/height or device preset' };
    }

    const metrics = {
      width,
      height,
      deviceScaleFactor: deviceScaleFactor ?? 1,
      mobile: Boolean(mobile),
    };
    await executor.setDeviceMetrics(tabId, metrics);
    await executor.setTouchEmulation(tabId, touch ?? Boolean(mobile));
    if (userAgent !== undefined) {
      await executor.setUserAgentOverride(tabId, userAgent);
    }

    return {
      id: cmd.id,
      ok: true,
      data: {
        tabId,
        device: presetName,
        width: Math.ceil(width),
        height: Math.ceil(height),
        deviceScaleFactor: metrics.deviceScaleFactor,
        mobile: metrics.mobile,
        touch: touch ?? Boolean(mobile),
        userAgent: userAgent ?? null,
      },
    };
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

async function handleInstance(cmd: Command): Promise<Result> {
  const currentLabel = await getInstanceLabel();

  if (cmd.newLabel) {
    const label = await setInstanceLabel(cmd.newLabel);
    console.log(`[agent-browser-bridge] Instance renamed: ${currentLabel} -> ${label}`);
    if (ws && ws.readyState === WebSocket.OPEN) {
      void sendHello(ws);
    }
    return { id: cmd.id, ok: true, data: { label, previousLabel: currentLabel } };
  }

  const pinned = await getPinnedTabId();
  return {
    id: cmd.id,
    ok: true,
    data: {
      label: currentLabel,
      version: chrome.runtime.getManifest().version,
      extensionId: chrome.runtime.id,
      pinnedTabId: pinned,
    },
  };
}

// ─── Window action ───────────────────────────────────────────────────

/** Keep the sticky selection honest: a vanished window is dropped, not reported. */
async function reconcileSelectedWindow(windowList: WindowSnapshot[]): Promise<number | null> {
  const selectedWindowId = await getSelectedWindowId();
  if (selectedWindowId === null) {
    return null;
  }
  if (windowList.some((snapshot) => snapshot.windowId === selectedWindowId)) {
    return selectedWindowId;
  }
  await setSelectedWindowId(null);
  return null;
}

/** Drop the sticky selection when it points at a window that is gone. */
async function clearSelectionIfMatches(windowId: number): Promise<void> {
  if ((await getSelectedWindowId()) === windowId) {
    await setSelectedWindowId(null);
  }
}

function windowNotFound(cmd: Command, windowId: number): Result {
  return { id: cmd.id, ok: false, error: `Window ${windowId} not found` };
}

async function handleWindows(cmd: Command): Promise<Result> {
  switch (cmd.windowOp) {
    case 'list': {
      const windowList = await buildWindowSnapshots();
      const selectedWindowId = await reconcileSelectedWindow(windowList);
      const profile = await getProfileDescriptor();
      return { id: cmd.id, ok: true, data: { windows: windowList, selectedWindowId, profile } };
    }

    case 'status': {
      const windowList = await buildWindowSnapshots();
      const selectedWindowId = await reconcileSelectedWindow(windowList);
      const profile = await getProfileDescriptor();
      return {
        id: cmd.id,
        ok: true,
        data: {
          selectedWindowId,
          profile,
          windowCount: windowList.length,
          tabCount: await countAllTabs(),
        },
      };
    }

    case 'use': {
      if (cmd.windowId === undefined) {
        return { id: cmd.id, ok: false, error: 'Missing windowId' };
      }
      const windowId = cmd.windowId;

      let window = await findWindowSnapshot(windowId);
      if (!window) {
        await clearSelectionIfMatches(windowId);
        return windowNotFound(cmd, windowId);
      }

      // Selecting a window never focuses it; `focusWindow` is the explicit ask.
      let focused = false;
      if (cmd.focusWindow === true) {
        try {
          await chrome.windows.update(windowId, { focused: true });
          focused = true;
        } catch {
          await clearSelectionIfMatches(windowId);
          return windowNotFound(cmd, windowId);
        }
      }

      await setSelectedWindowId(windowId);
      if (focused) {
        window = (await findWindowSnapshot(windowId)) ?? window;
      }

      const socket = ws;
      if (socket && socket.readyState === WebSocket.OPEN) {
        // The selection is part of the instance state the daemon renders.
        void sendHello(socket);
      }

      return { id: cmd.id, ok: true, data: { selectedWindowId: windowId, focused, window } };
    }

    case 'focus': {
      if (cmd.windowId === undefined) {
        return { id: cmd.id, ok: false, error: 'Missing windowId' };
      }
      const windowId = cmd.windowId;
      try {
        await chrome.windows.update(windowId, { focused: true });
      } catch {
        await clearSelectionIfMatches(windowId);
        return windowNotFound(cmd, windowId);
      }
      return { id: cmd.id, ok: true, data: { windowId, focused: true } };
    }

    default:
      return { id: cmd.id, ok: false, error: `Unknown windows op: ${cmd.windowOp}` };
  }
}

// ─── Extension reload ────────────────────────────────────────────────

/** Gap between answering a `reload` and tearing this worker down (ms). */
const RELOAD_DELAY_MS = 250;

/**
 * Chrome never picks up a rebuilt unpacked extension on its own, so the daemon
 * asks for a reload instead of the human clicking through chrome://extensions.
 * The reply must reach the socket first: reloading kills this worker, and every
 * pending request with it.
 */
async function handleReload(cmd: Command): Promise<Result> {
  let label = '';
  try {
    label = await getInstanceLabel();
  } catch {
    label = '';
  }

  setTimeout(() => {
    try {
      chrome.runtime.reload();
    } catch (error) {
      console.error('[agent-browser-bridge] Failed to reload the extension:', error);
    }
  }, RELOAD_DELAY_MS);

  return { id: cmd.id, ok: true, data: { reloading: true, label } };
}

export const __test__ = {
  getAutomationWindow,
  handleTabs,
  handleSessions,
  handleEmulate,
  handleScreenshot,
  handleExec,
  handleNavigate,
  handleInput,
  handleFocus,
  handleKey,
  handleCookies,
  getPopupState,
  startServing,
  stopServing,
  refreshPortSelection,
  getConnectionState: () => connectionState,
  getStatusText: () => statusText,
  getConfiguredPort: () => configuredPort,
  setConfiguredPort: (port: number) => {
    configuredPort = port;
  },
  setServingEnabled: (enabled: boolean) => {
    servingEnabled = enabled;
  },
  setBridgeStatusForTest: (nextState: ConnectionState, nextStatusText: string) => {
    setBridgeStatus(nextState, nextStatusText);
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
  getPinnedTabIdForTest: () => getPinnedTabId(),
  setPinnedTabIdForTest: (tabId: number | null) => setPinnedTabId(tabId),
  getInstanceLabelForTest: () => getInstanceLabel(),
  setInstanceLabelForTest: (label: string) => setInstanceLabel(label),
  handleInstance,
  handleWindows,
  handleReload,
  resolveTabId,
  resolveTabIdTarget,
  resolveHumanCandidate,
  buildWindowSnapshots,
  findWindowSnapshot,
  getProfileDescriptor,
  getSelectedWindowIdForTest: () => getSelectedWindowId(),
  setSelectedWindowIdForTest: (windowId: number | null) => setSelectedWindowId(windowId),
  ensureTopologyListeners: () => registerTopologyListeners(emitTopologyEvent),
  collectPopupWindowInfo,
  buildPopupStateForTest: (instanceLabel = '', windowInfo = {
    profileEmail: '',
    profileName: '',
    windowCount: 0,
    selectedWindowId: null,
    windowSummary: 'Window info unavailable.',
    activeTabTitle: '',
    activeTabId: null,
    activeWindowId: null,
  }) => buildPopupState(instanceLabel, windowInfo),
};
