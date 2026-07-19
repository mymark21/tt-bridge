const DEFAULT_DAEMON_PORT = 19826;
const MAX_DAEMON_PORT = 19835;
const DAEMON_HOST = "127.0.0.1";
function getDaemonWsUrl(port) {
  return `ws://${DAEMON_HOST}:${port}/ext`;
}
function getDaemonHttpUrl(port) {
  return `http://${DAEMON_HOST}:${port}`;
}
const WS_RECONNECT_BASE_DELAY = 2e3;
const WS_RECONNECT_MAX_DELAY = 6e4;

function isBridgeDaemonStatus(value) {
  return Boolean(
    value && typeof value === "object" && value.ok === true && value.running === true && typeof value.host === "string" && typeof value.port === "number"
  );
}
async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json"
      }
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    return response.ok ? payload : { responseOk: false, payload };
  } finally {
    clearTimeout(timer);
  }
}
async function probeDaemonPort(port, timeoutMs = 500) {
  try {
    const payload = await fetchJsonWithTimeout(`${getDaemonHttpUrl(port)}/status`, timeoutMs);
    if (isBridgeDaemonStatus(payload)) {
      return {
        kind: "bridge-daemon",
        status: payload
      };
    }
    return { kind: "occupied" };
  } catch {
    return { kind: "available" };
  }
}
async function scanDaemonPorts(startPort = DEFAULT_DAEMON_PORT, endPort = MAX_DAEMON_PORT, timeoutMs = 500) {
  let defaultPortBusy = false;
  for (let port = startPort; port <= endPort; port += 1) {
    const probe = await probeDaemonPort(port, timeoutMs);
    if (probe.kind === "bridge-daemon") {
      return {
        daemonPort: port,
        candidatePort: port,
        defaultPortBusy: defaultPortBusy || port !== startPort,
        status: probe.status
      };
    }
    if (probe.kind === "available") {
      return {
        daemonPort: null,
        candidatePort: port,
        defaultPortBusy: defaultPortBusy || port !== startPort,
        status: null
      };
    }
    if (port === startPort) {
      defaultPortBusy = true;
    }
  }
  return {
    daemonPort: null,
    candidatePort: endPort,
    defaultPortBusy: true,
    status: null
  };
}

const STORAGE_KEY = "ttBridgeRuntimeConfig";
function normalizePort(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return DEFAULT_DAEMON_PORT;
  }
  return Math.min(MAX_DAEMON_PORT, Math.max(DEFAULT_DAEMON_PORT, Math.trunc(value)));
}
async function readBridgeRuntimeConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const rawConfig = stored[STORAGE_KEY];
  const expiresAt = typeof rawConfig?.servingExpiresAt === "number" ? rawConfig.servingExpiresAt : null;
  return {
    servingEnabled: Boolean(rawConfig?.servingEnabled),
    port: normalizePort(rawConfig?.port),
    servingExpiresAt: expiresAt
  };
}
async function writeBridgeRuntimeConfig(partialConfig) {
  const current = await readBridgeRuntimeConfig();
  const next = {
    servingEnabled: partialConfig.servingEnabled ?? current.servingEnabled,
    port: normalizePort(partialConfig.port ?? current.port),
    servingExpiresAt: partialConfig.servingExpiresAt !== void 0 ? partialConfig.servingExpiresAt : current.servingExpiresAt
  };
  await chrome.storage.local.set({
    [STORAGE_KEY]: next
  });
  return next;
}

const attached = /* @__PURE__ */ new Set();
function isDebuggableUrl$1(url) {
  if (!url) return true;
  return !url.startsWith("chrome://") && !url.startsWith("chrome-extension://") && !url.startsWith("file://") && !url.startsWith("view-source:") && !url.startsWith("devtools://");
}
async function ensureAttached(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isDebuggableUrl$1(tab.url)) {
      attached.delete(tabId);
      throw new Error(`Cannot debug tab ${tabId}: URL is ${tab.url ?? "unknown"}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Cannot debug tab")) throw e;
    attached.delete(tabId);
    throw new Error(`Tab ${tabId} no longer exists`);
  }
  if (attached.has(tabId)) {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "1",
        returnByValue: true
      });
      return;
    } catch {
      attached.delete(tabId);
    }
  }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = msg.includes("chrome-extension://") ? ". Tip: another Chrome extension may be interfering — try disabling other extensions" : "";
    if (msg.includes("Another debugger is already attached")) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
      }
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
      } catch {
        throw new Error(`attach failed: ${msg}${hint}`);
      }
    } else {
      throw new Error(`attach failed: ${msg}${hint}`);
    }
  }
  attached.add(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  } catch {
  }
}
async function evaluate(tabId, expression) {
  await ensureAttached(tabId);
  const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Eval error";
    throw new Error(errMsg);
  }
  return result.result?.value;
}
const evaluateAsync = evaluate;
async function screenshot(tabId, options = {}) {
  await ensureAttached(tabId);
  const format = options.format ?? "png";
  if (options.fullPage) {
    const metrics = await chrome.debugger.sendCommand({ tabId }, "Page.getLayoutMetrics");
    const size = metrics.cssContentSize || metrics.contentSize;
    if (size) {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
        mobile: false,
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        deviceScaleFactor: 1
      });
    }
  }
  try {
    const params = { format };
    if (format === "jpeg" && options.quality !== void 0) {
      params.quality = Math.max(0, Math.min(100, options.quality));
    }
    const result = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", params);
    return result.data;
  } finally {
    if (options.fullPage) {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride").catch(() => {
      });
    }
  }
}
function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    chrome.debugger.detach({ tabId });
  } catch {
  }
}
function detachAll() {
  for (const tabId of [...attached]) {
    detach(tabId);
  }
}
function registerListeners() {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) attached.delete(source.tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.url && !isDebuggableUrl$1(info.url)) {
      if (attached.has(tabId)) {
        attached.delete(tabId);
        try {
          chrome.debugger.detach({ tabId });
        } catch {
        }
      }
    }
  });
}

let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let socketPort = null;
let connectionState = "idle";
let statusText = "Ready to start serving.";
let servingEnabled = false;
let configuredPort = DEFAULT_DAEMON_PORT;
let lastScan = null;
let initialized = false;
let initializationPromise = null;
// P1-5:会话级 serving。serving 在 SESSION_MAX_MS 后自动过期;popup 显示
// 实时倒计时和已执行命令的审计日志。
const SESSION_MAX_MS = 30 * 60 * 1e3;
const AUDIT_LOG_KEY = "ttBridgeAuditLog";
const AUDIT_LOG_MAX = 50;
let servingExpiresAt = null;
let auditLog = [];
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);
// P2-5:默认不把扩展日志(可能含访问/导航过的 URL)转发给 daemon。
// 仅本地调试时才置为 true。
const LOG_FORWARD_ENABLED = false;
function forwardLog(level, args) {
  if (!LOG_FORWARD_ENABLED) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    const msg = args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ");
    ws.send(JSON.stringify({ type: "log", level, msg, ts: Date.now() }));
  } catch {
  }
}
console.log = (...args) => {
  _origLog(...args);
  forwardLog("info", args);
};
console.warn = (...args) => {
  _origWarn(...args);
  forwardLog("warn", args);
};
console.error = (...args) => {
  _origError(...args);
  forwardLog("error", args);
};
function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}
function isSocketConnected() {
  return Boolean(ws && ws.readyState === WebSocket.OPEN);
}
function setBridgeStatus(nextState, nextStatusText) {
  connectionState = nextState;
  statusText = nextStatusText;
}
function buildIdleStatus(scan, port) {
  if (scan?.daemonPort !== null) {
    return `Local daemon detected on ${port}. Click Start Serving.`;
  }
  if (scan?.defaultPortBusy && port !== DEFAULT_DAEMON_PORT) {
    return `Default port ${DEFAULT_DAEMON_PORT} is busy. Start Serving will use ${port}.`;
  }
  return `Ready to start serving on ${port}.`;
}
function buildWaitingStatus(scan, port) {
  if (scan?.defaultPortBusy && port !== DEFAULT_DAEMON_PORT) {
    return `Default port ${DEFAULT_DAEMON_PORT} is busy. Waiting for local daemon on ${port}.`;
  }
  return `Waiting for local daemon on ${port}.`;
}
function buildConnectingStatus(port) {
  return `Connecting to local daemon on ${port}.`;
}
function buildConnectedStatus(port) {
  return `Serving on ${port}.`;
}
function disconnectSocket() {
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
  }
}
async function persistRuntimeConfig() {
  await writeBridgeRuntimeConfig({
    servingEnabled,
    port: configuredPort,
    servingExpiresAt
  });
}
async function refreshPortSelection(trigger) {
  const scan = await scanDaemonPorts();
  lastScan = scan;
  scan.status;
  const nextPort = scan.daemonPort ?? scan.candidatePort;
  if (configuredPort !== nextPort) {
    configuredPort = nextPort;
    await persistRuntimeConfig();
  }
  if (!servingEnabled) {
    setBridgeStatus("idle", buildIdleStatus(scan, configuredPort));
  }
  return scan;
}
function scheduleReconnect() {
  if (!servingEnabled || reconnectTimer) {
    return;
  }
  reconnectAttempts += 1;
  const delay = Math.min(
    WS_RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1),
    WS_RECONNECT_MAX_DELAY
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}
async function connect(trigger) {
  if (!servingEnabled) {
    return;
  }
  const scan = await refreshPortSelection();
  const targetPort = configuredPort;
  if (isSocketConnected() && socketPort === targetPort) {
    setBridgeStatus("connected", buildConnectedStatus(targetPort));
    return;
  }
  if (ws?.readyState === WebSocket.CONNECTING && socketPort === targetPort) {
    return;
  }
  clearReconnectTimer();
  disconnectSocket();
  if (scan.daemonPort === targetPort) {
    setBridgeStatus("connecting", buildConnectingStatus(targetPort));
  } else {
    setBridgeStatus("waiting", buildWaitingStatus(scan, targetPort));
  }
  let socket;
  try {
    socket = new WebSocket(getDaemonWsUrl(targetPort));
  } catch {
    setBridgeStatus("waiting", buildWaitingStatus(scan, targetPort));
    scheduleReconnect();
    return;
  }
  ws = socket;
  socketPort = targetPort;
  socket.onopen = () => {
    if (ws !== socket) {
      return;
    }
    console.log("[agent-browser-bridge] Connected to daemon");
    socket.send(JSON.stringify({
      type: "hello",
      role: "extension",
      version: chrome.runtime.getManifest().version,
      extensionId: chrome.runtime.id,
      ts: Date.now()
    }));
    reconnectAttempts = 0;
    clearReconnectTimer();
    setBridgeStatus("connected", buildConnectedStatus(targetPort));
  };
  socket.onmessage = async (event) => {
    try {
      const command = JSON.parse(event.data);
      const result = await handleCommand(command);
      ws?.send(JSON.stringify(result));
    } catch (error) {
      console.error("[agent-browser-bridge] Message handling error:", error);
    }
  };
  socket.onclose = () => {
    if (ws !== socket) {
      return;
    }
    console.log("[agent-browser-bridge] Disconnected from daemon");
    ws = null;
    socketPort = null;
    if (!servingEnabled) {
      setBridgeStatus("idle", buildIdleStatus(lastScan, configuredPort));
      return;
    }
    setBridgeStatus("waiting", buildWaitingStatus(lastScan, configuredPort));
    scheduleReconnect();
  };
  socket.onerror = () => {
    socket.close();
  };
}
async function startServing() {
  servingEnabled = true;
  servingExpiresAt = Date.now() + SESSION_MAX_MS;
  await persistRuntimeConfig();
  await connect();
}
async function stopServing() {
  servingEnabled = false;
  servingExpiresAt = null;
  await persistRuntimeConfig();
  reconnectAttempts = 0;
  clearReconnectTimer();
  disconnectSocket();
  // P1-3:停止 serving 时必须释放所有已挂的调试器,否则"正在调试"黄条
  // 和 CDP 连接会残留在用户标签页上。
  detachAll();
  await refreshPortSelection();
  setBridgeStatus("idle", buildIdleStatus(lastScan, configuredPort));
}
function buildPopupState() {
  const remainingMs = servingEnabled && servingExpiresAt ? Math.max(0, servingExpiresAt - Date.now()) : null;
  return {
    servingEnabled,
    port: configuredPort,
    buttonLabel: servingEnabled ? "Serving" : "Start Serving",
    statusText,
    connectionState,
    defaultPortBusy: Boolean(lastScan?.defaultPortBusy),
    remainingMs,
    sessionMaxMs: SESSION_MAX_MS,
    auditRecent: auditLog.slice(-8).reverse()
  };
}
async function getPopupState() {
  await refreshPortSelection();
  enforceSessionExpiry();
  if (servingEnabled && !isSocketConnected()) {
    void connect();
  }
  return buildPopupState();
}
async function loadAuditLog() {
  try {
    const stored = await chrome.storage.local.get(AUDIT_LOG_KEY);
    const raw = stored[AUDIT_LOG_KEY];
    auditLog = Array.isArray(raw) ? raw.slice(-AUDIT_LOG_MAX) : [];
  } catch {
    auditLog = [];
  }
}
function recordAudit(entry) {
  auditLog.push(entry);
  if (auditLog.length > AUDIT_LOG_MAX) {
    auditLog = auditLog.slice(-AUDIT_LOG_MAX);
  }
  // 即发即忘地持久化;内存中的副本才是权威来源。
  try {
    void chrome.storage.local.set({ [AUDIT_LOG_KEY]: auditLog });
  } catch {
  }
}
function auditFromCommand(cmd, workspace) {
  const entry = { ts: Date.now(), action: cmd.action, workspace };
  if (cmd.action === "exec" && typeof cmd.code === "string") {
    entry.detail = cmd.code.length > 80 ? cmd.code.slice(0, 80) + "…" : cmd.code;
  } else if (cmd.action === "navigate" && typeof cmd.url === "string") {
    entry.detail = cmd.url;
  } else if (cmd.action === "cookies") {
    entry.detail = cmd.domain || cmd.url || "";
  } else if (cmd.action === "tabs" && typeof cmd.op === "string") {
    entry.detail = cmd.op;
  }
  return entry;
}
// P1-5:强制会话过期。由 keepalive alarm、初始化时、以及 popup 每次取状态时
// 调用。若刚刚停止了 serving 则返回 true。
function enforceSessionExpiry() {
  if (servingEnabled && servingExpiresAt && Date.now() >= servingExpiresAt) {
    console.log("[agent-browser-bridge] Serving session expired, stopping");
    void stopServing();
    return true;
  }
  return false;
}
const automationSessions = /* @__PURE__ */ new Map();
const WINDOW_IDLE_TIMEOUT = 12e4;
const AUTOMATION_WINDOW_URL = "data:text/html,<html></html>";
const INCOGNITO_ACCESS_ERROR = 'TT Bridge needs Chrome "Allow in Incognito" enabled before it can create its dedicated incognito automation window. Open chrome://extensions, open TT Bridge details, and enable "Allow in Incognito".';
function getWorkspaceKey(workspace) {
  return workspace?.trim() || "human";
}
function isHumanWorkspace(workspace) {
  return workspace === "human";
}
function resetWindowIdleTimer(workspace) {
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
    }
    automationSessions.delete(workspace);
  }, WINDOW_IDLE_TIMEOUT);
}
async function ensureIncognitoAccess() {
  if (!chrome.extension?.isAllowedIncognitoAccess) {
    throw new Error("Chrome incognito access check is unavailable in this extension context.");
  }
  const allowed = await chrome.extension.isAllowedIncognitoAccess();
  if (!allowed) {
    throw new Error(INCOGNITO_ACCESS_ERROR);
  }
}
async function getAutomationWindow(workspace) {
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
    type: "normal",
    incognito: true
  });
  if (!win.id) {
    throw new Error("Failed to create incognito automation window");
  }
  if (!win.incognito) {
    try {
      await chrome.windows.remove(win.id);
    } catch {
    }
    throw new Error(INCOGNITO_ACCESS_ERROR);
  }
  const session = {
    windowId: win.id,
    idleTimer: null,
    idleDeadlineAt: Date.now() + WINDOW_IDLE_TIMEOUT
  };
  automationSessions.set(workspace, session);
  console.log(`[agent-browser-bridge] Created incognito automation window ${session.windowId} (${workspace})`);
  resetWindowIdleTimer(workspace);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return session.windowId;
}
async function getHumanWindowId() {
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  if (win?.id && !win.incognito) return win.id;
  throw new Error("No focused normal Chrome window found.");
}
async function resolveHumanTabId(tabId) {
  if (tabId !== void 0) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.incognito && isDebuggableUrl(tab.url)) return tabId;
    throw new Error(`Tab ${tabId} is not a debuggable tab in a normal Chrome window.`);
  }
  const windowId = await getHumanWindowId();
  const tabs = await chrome.tabs.query({ windowId, active: true });
  const tab = tabs.find((candidate) => candidate.id && !candidate.incognito && isDebuggableUrl(candidate.url));
  if (!tab?.id) {
    throw new Error("No debuggable active tab found in the user's visible Chrome window.");
  }
  return tab.id;
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
async function initialize() {
  if (initialized) {
    return;
  }
  initialized = true;
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  registerListeners();
  await loadAuditLog();
  const config = await readBridgeRuntimeConfig();
  servingEnabled = config.servingEnabled;
  configuredPort = config.port;
  servingExpiresAt = config.servingExpiresAt;
  await refreshPortSelection();
  if (servingEnabled && enforceSessionExpiry()) {
    // service worker 被回收期间会话已过期 —— 上面已执行 stopServing()。
  } else if (servingEnabled) {
    await connect();
  }
  console.log("[agent-browser-bridge] Extension initialized");
}
async function ensureInitialized() {
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
  if (alarm.name === "keepalive" && servingEnabled) {
    if (enforceSessionExpiry()) return;
    void connect();
  }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void ensureInitialized().then(async () => {
    if (message?.type === "ttbridge:get-popup-state") {
      sendResponse(await getPopupState());
      return;
    }
    if (message?.type === "ttbridge:set-serving") {
      if (message.enabled) {
        await startServing();
      } else {
        await stopServing();
      }
      sendResponse(await getPopupState());
      return;
    }
    sendResponse(null);
  }).catch((error) => {
    const fallbackState = {
      servingEnabled: false,
      port: configuredPort,
      buttonLabel: "Start Serving",
      statusText: error instanceof Error ? error.message : "Failed to initialize TT bridge.",
      connectionState: "error",
      defaultPortBusy: false
    };
    sendResponse(fallbackState);
  });
  return true;
});
// P2-6:分发前对 action 做白名单、对字段做边界校验。
const VALID_ACTIONS = new Set(["exec", "navigate", "tabs", "cookies", "screenshot", "close-window", "sessions"]);
function validateCommand(cmd) {
  if (!cmd || typeof cmd !== "object") return "Command must be an object";
  if (!VALID_ACTIONS.has(cmd.action)) return `Unknown action: ${cmd.action}`;
  if (cmd.action === "exec" && typeof cmd.code !== "string") return "exec requires a string 'code'";
  if (cmd.action === "navigate" && typeof cmd.url !== "string") return "navigate requires a string 'url'";
  if (cmd.tabId !== void 0 && (typeof cmd.tabId !== "number" || !Number.isFinite(cmd.tabId))) return "tabId must be a finite number";
  if (cmd.action === "screenshot") {
    if (cmd.format !== void 0 && cmd.format !== "png" && cmd.format !== "jpeg") return "screenshot format must be png or jpeg";
    if (cmd.quality !== void 0 && (typeof cmd.quality !== "number" || cmd.quality < 0 || cmd.quality > 100)) return "screenshot quality must be 0-100";
  }
  return null;
}
async function handleCommand(cmd) {
  const workspace = getWorkspaceKey(cmd.workspace);
  resetWindowIdleTimer(workspace);
  const validationError = validateCommand(cmd);
  if (validationError) {
    return { id: cmd.id, ok: false, error: validationError, code: "BAD_REQUEST" };
  }
  recordAudit(auditFromCommand(cmd, workspace));
  try {
    switch (cmd.action) {
      case "exec":
        return await handleExec(cmd, workspace);
      case "navigate":
        return await handleNavigate(cmd, workspace);
      case "tabs":
        return await handleTabs(cmd, workspace);
      case "cookies":
        return await handleCookies(cmd);
      case "screenshot":
        return await handleScreenshot(cmd, workspace);
      case "close-window":
        return await handleCloseWindow(cmd, workspace);
      case "sessions":
        return await handleSessions(cmd);
      default:
        return { id: cmd.id, ok: false, error: `Unknown action: ${cmd.action}` };
    }
  } catch (error) {
    return {
      id: cmd.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
function isDebuggableUrl(url) {
  if (!url) return true;
  return !url.startsWith("chrome://") && !url.startsWith("chrome-extension://") && !url.startsWith("file://") && !url.startsWith("view-source:") && !url.startsWith("devtools://");
}
async function resolveTabId(tabId, workspace) {
  if (isHumanWorkspace(workspace)) {
    return await resolveHumanTabId(tabId);
  }
  if (tabId !== void 0) {
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
    }
  }
  const newTab = await chrome.tabs.create({ windowId, url: AUTOMATION_WINDOW_URL, active: true });
  if (!newTab.id) throw new Error("Failed to create tab in automation window");
  return newTab.id;
}
async function listAutomationTabs(workspace) {
  const session = automationSessions.get(workspace);
  if (!session) return [];
  try {
    return await chrome.tabs.query({ windowId: session.windowId });
  } catch {
    automationSessions.delete(workspace);
    return [];
  }
}
async function listAutomationWebTabs(workspace) {
  const tabs = await listAutomationTabs(workspace);
  return tabs.filter((tab) => isDebuggableUrl(tab.url));
}
async function listHumanWebTabs() {
  const windowId = await getHumanWindowId();
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.filter((tab) => !tab.incognito && isDebuggableUrl(tab.url));
}
async function handleExec(cmd, workspace) {
  if (!cmd.code) return { id: cmd.id, ok: false, error: "Missing code" };
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await evaluateAsync(tabId, cmd.code);
    return { id: cmd.id, ok: true, data };
  } catch (error) {
    return { id: cmd.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
async function handleNavigate(cmd, workspace) {
  if (!cmd.url) return { id: cmd.id, ok: false, error: "Missing url" };
  let tabId;
  let beforeUrl = "";
  const targetUrl = cmd.url;
  if (isHumanWorkspace(workspace) && cmd.tabId === void 0) {
    const windowId = await getHumanWindowId();
    const tab = await chrome.tabs.create({
      windowId,
      url: targetUrl,
      active: true
    });
    if (!tab.id) throw new Error("Failed to create tab in the user's visible Chrome window.");
    tabId = tab.id;
  } else {
    tabId = await resolveTabId(cmd.tabId, workspace);
    const beforeTab = await chrome.tabs.get(tabId);
    beforeUrl = beforeTab.url ?? "";
    await chrome.tabs.update(tabId, { url: targetUrl });
  }
  let timedOut = false;
  await new Promise((resolve) => {
    let urlChanged = false;
    let settled = false;
    let pollTimer = null;
    let timeoutTimer = null;
    // P2-4:只 settle 一次并清掉两个定时器,这样已完成的 navigate 不会留下
    // 100ms 轮询和 15s 超时对着一个已结束的 promise 触发(后者还会打印
    // 假的 "timed out" 警告)。
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (pollTimer) clearTimeout(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve();
    };
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.url && info.url !== beforeUrl) {
        urlChanged = true;
      }
      if (urlChanged && info.status === "complete") {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    pollTimer = setTimeout(async () => {
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (!settled && currentTab.url !== beforeUrl && currentTab.status === "complete") {
          finish();
        }
      } catch {
      }
    }, 100);
    timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      console.warn(`[agent-browser-bridge] Navigate to ${targetUrl} timed out after 15s`);
      finish();
    }, 15e3);
  });
  const tab = await chrome.tabs.get(tabId);
  return {
    id: cmd.id,
    ok: true,
    data: { title: tab.title, url: tab.url, tabId, timedOut }
  };
}
async function handleTabs(cmd, workspace) {
  switch (cmd.op) {
    case "list": {
      const tabs = isHumanWorkspace(workspace) ? await listHumanWebTabs() : await listAutomationWebTabs(workspace);
      const data = tabs.map((tab, index) => ({
        index,
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active
      }));
      return { id: cmd.id, ok: true, data };
    }
    case "new": {
      const windowId = isHumanWorkspace(workspace) ? await getHumanWindowId() : await getAutomationWindow(workspace);
      const createOptions = { windowId, active: true };
      const url = cmd.url ?? (isHumanWorkspace(workspace) ? void 0 : AUTOMATION_WINDOW_URL);
      if (url !== void 0) createOptions.url = url;
      const tab = await chrome.tabs.create(createOptions);
      return { id: cmd.id, ok: true, data: { tabId: tab.id, url: tab.url } };
    }
    case "close": {
      if (cmd.index !== void 0) {
        const tabs = isHumanWorkspace(workspace) ? await listHumanWebTabs() : await listAutomationWebTabs(workspace);
        const target = tabs[cmd.index];
        if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
        await chrome.tabs.remove(target.id);
        detach(target.id);
        return { id: cmd.id, ok: true, data: { closed: target.id } };
      }
      const tabId = await resolveTabId(cmd.tabId, workspace);
      await chrome.tabs.remove(tabId);
      detach(tabId);
      return { id: cmd.id, ok: true, data: { closed: tabId } };
    }
    case "select": {
      if (cmd.index === void 0 && cmd.tabId === void 0) {
        return { id: cmd.id, ok: false, error: "Missing index or tabId" };
      }
      if (cmd.tabId !== void 0) {
        await chrome.tabs.update(cmd.tabId, { active: true });
        return { id: cmd.id, ok: true, data: { selected: cmd.tabId } };
      }
      const tabs = isHumanWorkspace(workspace) ? await listHumanWebTabs() : await listAutomationWebTabs(workspace);
      const target = tabs[cmd.index];
      if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
      await chrome.tabs.update(target.id, { active: true });
      if (target.windowId) {
        await chrome.windows.update(target.windowId, { focused: true });
      }
      return { id: cmd.id, ok: true, data: { selected: target.id } };
    }
    default:
      return { id: cmd.id, ok: false, error: `Unknown tabs op: ${cmd.op}` };
  }
}
async function handleCookies(cmd) {
  // P1-2:拒绝通配符整库 dump,且绝不明文返回 httpOnly(会话)cookie 的值。
  if (!cmd.domain && !cmd.url) {
    return { id: cmd.id, ok: false, error: "cookies action requires a 'domain' or 'url' filter (wildcard dumps are refused)" };
  }
  const details = {};
  if (cmd.domain) details.domain = cmd.domain;
  if (cmd.url) details.url = cmd.url;
  const cookies = await chrome.cookies.getAll(details);
  const data = cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.httpOnly ? void 0 : cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expirationDate: cookie.expirationDate
  }));
  return { id: cmd.id, ok: true, data };
}
async function handleScreenshot(cmd, workspace) {
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await screenshot(tabId, {
      format: cmd.format,
      quality: cmd.quality,
      fullPage: cmd.fullPage
    });
    return { id: cmd.id, ok: true, data };
  } catch (error) {
    return { id: cmd.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
async function handleCloseWindow(cmd, workspace) {
  if (isHumanWorkspace(workspace)) {
    return { id: cmd.id, ok: true, data: { closed: false, reason: "human workspace does not close the user's normal Chrome window" } };
  }
  const session = automationSessions.get(workspace);
  if (session) {
    try {
      await chrome.windows.remove(session.windowId);
    } catch {
    }
    if (session.idleTimer) clearTimeout(session.idleTimer);
    automationSessions.delete(workspace);
  }
  return { id: cmd.id, ok: true, data: { closed: true } };
}
async function handleSessions(cmd) {
  const now = Date.now();
  const data = await Promise.all([...automationSessions.entries()].map(async ([workspace, session]) => ({
    incognito: (await chrome.windows.get(session.windowId)).incognito,
    workspace,
    windowId: session.windowId,
    tabCount: (await chrome.tabs.query({ windowId: session.windowId })).filter((tab) => isDebuggableUrl(tab.url)).length,
    idleMsRemaining: Math.max(0, session.idleDeadlineAt - now)
  })));
  return { id: cmd.id, ok: true, data };
}
