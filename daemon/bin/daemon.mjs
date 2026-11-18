#!/usr/bin/env node

import http from 'node:http';
import { execFile } from 'node:child_process';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { readChromeProfiles, resolveProfileName, maskEmail, maskGaiaId, maskProfileName } from './chrome-profiles.mjs';
import { TargetRegistry, normalizeKey, readProfileId } from './targets.mjs';

const HOST = process.env.AGENT_BROWSER_BRIDGE_HOST || '127.0.0.1';
const START_PORT = Number(process.env.AGENT_BROWSER_BRIDGE_PORT || '19826');
const MAX_PORT = Number(process.env.AGENT_BROWSER_BRIDGE_MAX_PORT || String(START_PORT + 9));
const COMMAND_TIMEOUT_MS = Number(process.env.AGENT_BROWSER_BRIDGE_COMMAND_TIMEOUT_MS || '30000');
const IDLE_TIMEOUT_MS = Number(process.env.AGENT_BROWSER_BRIDGE_IDLE_TIMEOUT_MS || String(24 * 60 * 60 * 1000));
const EXTENSION_WAIT_MS = Number(process.env.AGENT_BROWSER_BRIDGE_EXTENSION_WAIT_MS || '20000');
const MAX_BODY_BYTES = Number(process.env.AGENT_BROWSER_BRIDGE_MAX_BODY_BYTES || String(5 * 1024 * 1024));
// Screenshots/highlights travel over the extension WebSocket, so the WS frame
// cap is deliberately larger than the HTTP body cap.
const MAX_WS_PAYLOAD = Number(process.env.AGENT_BROWSER_BRIDGE_MAX_WS_PAYLOAD || String(100 * 1024 * 1024));
const MAX_PENDING = Number(process.env.AGENT_BROWSER_BRIDGE_MAX_PENDING || '256');
/** Hard cap for the macOS `osascript` Chrome activation issued on `/window` focus. */
const ACTIVATE_TIMEOUT_MS = Number(process.env.AGENT_BROWSER_BRIDGE_ACTIVATE_TIMEOUT_MS || '2000');
/** Raising the whole Chrome app is the only way to steal focus on macOS (AppleEvents). */
const CHROME_ACTIVATE_SCRIPT = 'tell application "Google Chrome" to activate';

const startedAt = Date.now();
let activePort = START_PORT;

function nowIso() {
  return new Date().toISOString();
}

function log(...args) {
  console.error('[agent-browser-bridge:daemon]', ...args);
}

/**
 * Extension logs are relayed to stderr (and the daemon log file). They can
 * contain page URLs with query tokens or command errors that echo credentials,
 * so scrub the common secret shapes before anything is persisted.
 */
function redactLogLine(text) {
  return String(text)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b[A-Za-z0-9_-]*(?:token|secret|password|passwd|session|auth|key|sig|credential|cookie)[A-Za-z0-9_-]*\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s)]*/gi, '$1?[REDACTED]')
    .replace(/\/\/[^/@\s]+@/g, '//[REDACTED]@')
    .slice(0, 2000);
}

// --- 共享密钥鉴权 (P0-1) --------------------------------------------------
// daemon 启动时生成一次 token，以 0600 权限存到用户 config 目录。只有能读到
// 该文件的进程（即同一用户运行的 CLI）才能驱动浏览器。扩展从不调用
// 这些 HTTP 路由，因此不需要 token。
const TOKEN_DIR = path.join(os.homedir(), '.config', 'tt-bridge');
const TOKEN_FILE = path.join(TOKEN_DIR, 'token');

function getOrCreateToken() {
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // 缺失/不可读 —— 在下面创建。
  }
  const token = randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600, flag: 'wx' });
    return token;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      try {
        const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
        if (existing) return existing;
      } catch {
        // fall through to the warning below
      }
    }
    log('WARNING: could not persist auth token:', error instanceof Error ? error.message : String(error));
  }
  return token;
}

const AUTH_TOKEN = getOrCreateToken();

function isAuthorized(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(AUTH_TOKEN);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// 防 DNS-rebinding (P0-2): Host 必须是我们自己的环回权威。
function isAllowedHost(req) {
  const host = req.headers.host || '';
  return host === `127.0.0.1:${activePort}`
    || host === `localhost:${activePort}`
    || host === `[::1]:${activePort}`;
}

// 防 CSRF (P0-2): 真实网页一定带 http(s) Origin；CLI 不带；扩展带
// chrome-extension://。拒绝网页 Origin。
function isForbiddenOrigin(req) {
  const origin = req.headers.origin;
  return Boolean(origin) && !origin.startsWith('chrome-extension://');
}

const targets = new TargetRegistry({
  log,
  getProfiles: readChromeProfiles,
});
const instances = targets.instances;
/** @type {Map<WebSocket, InstanceEntry>} socket -> entry */
const instancesBySocket = new Map();

/** @type {Map<string, { resolve: (value: unknown) => void, reject: (reason?: unknown) => void, timer: NodeJS.Timeout, targetKey: string|null }>} */
const pendingRequests = new Map();
/** @type {Set<{ resolve: () => void, reject: (reason?: unknown) => void, timer: NodeJS.Timeout }>} */
const extensionWaiters = new Set();
/** @type {NodeJS.Timeout | null} */
let idleTimer = null;

function isSocketOpen(ws) {
  return targets.isSocketOpen(ws);
}

function connectedInstances() {
  return targets.connectedInstances();
}

function broadcastToInstances(obj) {
  const payload = JSON.stringify(obj);
  for (const entry of instances.values()) {
    if (isSocketOpen(entry?.ws)) {
      try {
        entry.ws.send(payload);
      } catch {
        // Ignore single send failure
      }
    }
  }
}

function resolveTarget() {
  return targets.resolveTarget();
}

function resetIdleTimer() {
  if (!IDLE_TIMEOUT_MS) {
    return;
  }
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    log(`Idle timeout reached after ${IDLE_TIMEOUT_MS}ms, shutting down`);
    shutdown(0);
  }, IDLE_TIMEOUT_MS);
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function rejectPendingRequests(message, targetKey = undefined) {
  for (const [id, pending] of pendingRequests.entries()) {
    if (targetKey !== undefined && pending.targetKey !== targetKey) {
      continue;
    }
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
    pendingRequests.delete(id);
  }
}

function settleExtensionWaiters(error) {
  for (const waiter of extensionWaiters) {
    clearTimeout(waiter.timer);
    if (error) {
      waiter.reject(error);
    } else {
      waiter.resolve();
    }
    extensionWaiters.delete(waiter);
  }
}

function waitForExtension(timeoutMs = EXTENSION_WAIT_MS) {
  if (connectedInstances().length > 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const waiter = {
      resolve: () => {
        extensionWaiters.delete(waiter);
        resolve();
      },
      reject: (error) => {
        extensionWaiters.delete(waiter);
        reject(error);
      },
      timer: setTimeout(() => {
        extensionWaiters.delete(waiter);
        reject(new Error(`Extension not connected after waiting ${timeoutMs}ms`));
      }, timeoutMs),
    };
    extensionWaiters.add(waiter);
  });
}


function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const onData = (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        req.off('data', onData);
        // 排空（丢弃）剩余数据但不缓冲，让 socket 存活、调用方仍能收到 413 响应。
        req.resume();
        const error = new Error('Request body too large');
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    req.on('data', onData);
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (error) => {
      if (!done) {
        done = true;
        reject(error);
      }
    });
  });
}

function sendBodyError(res, error) {
  const statusCode = (error && error.statusCode) || 400;
  sendJson(res, statusCode, {
    ok: false,
    error: error instanceof Error ? error.message : 'Invalid JSON body',
    code: statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
  });
}

async function handleCommandRequest(req, res) {
  resetIdleTimer();

  if (pendingRequests.size >= MAX_PENDING) {
    sendJson(res, 429, { ok: false, error: 'Too many in-flight commands', code: 'RATE_LIMITED' });
    return;
  }

  let command;
  try {
    const raw = await readBody(req);
    command = raw ? JSON.parse(raw) : {};
  } catch (error) {
    const statusCode = (error && error.statusCode) || 400;
    sendJson(res, statusCode, {
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid JSON body',
      code: statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
    });
    return;
  }

  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    sendJson(res, 400, {
      ok: false,
      error: 'Command body must be a JSON object',
      code: 'BAD_REQUEST',
    });
    return;
  }

  const id = typeof command.id === 'string' && command.id ? command.id : randomUUID();
  const outbound = { ...command, id };

  try {
    if (connectedInstances().length === 0) {
      await waitForExtension();
    }
  } catch (error) {
    sendJson(res, 503, {
      id,
      ok: false,
      error: error instanceof Error ? error.message : 'Extension not connected',
    });
    return;
  }

  let target = resolveTarget();
  if ('code' in target && target.code === 'TARGET_OFFLINE') {
    const targetKey = target.target?.key || targets.designatedLabel || targets.ownerKey;
    log(`Target "${targetKey}" is offline; waiting up to ${targets.targetWaitMs}ms for reconnect...`);
    const reconnected = await targets.waitForTarget(targetKey);
    if (reconnected) {
      log(`Target "${targetKey}" reconnected; retrying resolveTarget()`);
      target = resolveTarget();
    }
  }

  if ('error' in target) {
    sendJson(res, 409, {
      id,
      ok: false,
      error: target.error,
      ...(target.code ? { code: target.code, target: target.target, connected: target.connected } : {}),
    });
    return;
  }

  const response = await dispatchToEntry(target.entry, outbound).catch((error) => ({
    id,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));

  sendJson(res, response.ok === false ? 500 : 200, response);
}

function dispatchToEntry(entry, command, timeoutMs = COMMAND_TIMEOUT_MS) {
  if (!entry || !isSocketOpen(entry.ws)) {
    return Promise.reject(new Error(`Instance "${entry?.label || entry?.key || 'unknown'}" is not connected`));
  }
  const id = typeof command.id === 'string' && command.id ? command.id : randomUUID();
  const outbound = { ...command, id };
  const target = entry.key ?? entry.label ?? null;

  broadcastToInstances({
    type: 'agent-activity',
    phase: 'start',
    id,
    action: command.action ?? 'unknown',
    tabId: command.tab ?? command.tabId ?? null,
    at: Date.now(),
    target,
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timed out waiting for result after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer, targetKey: entry.key });

    try {
      entry.ws.send(JSON.stringify(outbound));
    } catch (error) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(error);
    }
  }).then(
    (result) => {
      broadcastToInstances({
        type: 'agent-activity',
        phase: 'end',
        id,
        at: Date.now(),
        ok: result?.ok !== false,
        target,
      });
      return result;
    },
    (error) => {
      broadcastToInstances({
        type: 'agent-activity',
        phase: 'end',
        id,
        at: Date.now(),
        ok: false,
        target,
      });
      throw error;
    }
  );
}

async function handleInstanceRequest(req, res) {
  resetIdleTimer();

  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (error) {
    sendBodyError(res, error);
    return;
  }

  if (body.clear === true || body.label === null) {
    targets.designatedLabel = null;
    targets.ownerKey = null;
    log('Instance designation and ownership cleared');
    sendJson(res, 200, { ok: true, message: 'Instance designation cleared', ...buildStatusPayload() });
    return;
  }

  const key = normalizeKey(body.label);
  if (!key) {
    sendJson(res, 400, { ok: false, error: 'Provide { label: "<instance label>" } or { clear: true }' });
    return;
  }

  const lookup = targets.lookupInstanceByLabel(key);
  if (lookup && 'error' in lookup) {
    sendJson(res, 409, { ok: false, error: lookup.error });
    return;
  }
  const entry = lookup ? lookup.entry : null;

  const currentTarget = targets.getCurrentTargetEntry();
  const pinCheck = targets.checkPinHeld({
    currentTarget,
    newProfileId: entry?.profileId,
    newKey: entry?.key || key,
    force: body.force === true,
  });
  if (!pinCheck.allowed) {
    sendJson(res, 409, { ok: false, code: pinCheck.code, error: pinCheck.error, target: pinCheck.target });
    return;
  }
  if (body.force === true && currentTarget && currentTarget.disconnectedAt && currentTarget.pinnedTabId !== null) {
    log(`Force override active pin: switching target from "${currentTarget.label || currentTarget.key}" to "${entry?.label || key}"`);
  }

  if (!entry || !isSocketOpen(entry.ws)) {
    targets.designatedLabel = key;
    log(`Designated instance "${key}" (not currently connected; will adopt on reconnect)`);
    sendJson(res, 200, {
      ok: true,
      message: `Instance "${key}" designated, but it is not connected right now. Connected: ${targets.listInstanceLabels()}`,
      ...buildStatusPayload(),
    });
    return;
  }

  targets.designatedLabel = entry.key;
  log(`Designated instance "${entry.label || entry.key}" as target`);
  sendJson(res, 200, { ok: true, message: `Now targeting "${entry.label || entry.key}"`, ...buildStatusPayload() });
}

function buildStatusPayload() {
  const target = resolveTarget();
  const targetEntry = 'entry' in target ? target.entry : targets.getCurrentTargetEntry();
  const { profiles } = readChromeProfiles();
  const ownerLabel = targetEntry
    ? (targetEntry.label || targetEntry.key)
    : (targets.designatedLabel || targets.ownerKey || null);
  const ownerOnline = Boolean(targetEntry && isSocketOpen(targetEntry.ws));

  return {
    ok: true,
    running: true,
    host: HOST,
    port: activePort,
    extensionConnected: connectedInstances().length > 0,
    ownerLabel,
    ownerOnline,
    designatedLabel: targets.designatedLabel,
    instances: [...instances.values()].map((entry) => ({
      label: entry.label || entry.key || '(unknown)',
      profileId: entry.profileId ?? null,
      connected: isSocketOpen(entry.ws),
      connectedAt: new Date(entry.connectedAt).toISOString(),
      disconnectedAt: entry.disconnectedAt ? new Date(entry.disconnectedAt).toISOString() : null,
      pinnedTabId: entry.pinnedTabId ?? null,
      owner: Boolean(targetEntry && entry.key === targetEntry.key),
      version: entry.hello?.version ?? null,
      windows: entry.hello?.windows ?? null,
      tabs: entry.hello?.tabs ?? null,
      // /status is unauthenticated: shorten the display name here as well, so
      // the full profile name never leaves the daemon on the public route.
      profileName: maskProfileName(resolveProfileName(entry.profile, profiles)),
      windowCount: entry.windowCount ?? (entry.hello?.windows ?? null),
      selectedWindowId: entry.selectedWindowId ?? null,
    })),
    pendingRequests: pendingRequests.size,
    uptimeMs: Date.now() - startedAt,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    // /status is public (discovery), so the hello payload is redacted before it
    // leaves the daemon: raw profile email and gaia id must never be exposed.
    extension: ownerOnline && targetEntry ? publicHello(targetEntry.hello) : null,
    now: nowIso(),
  };
}

function publicHello(hello) {
  if (!hello || typeof hello !== 'object') {
    return null;
  }
  const profile = hello.profile && typeof hello.profile === 'object'
    ? {
        label: hello.profile.label ?? '',
        name: maskProfileName(hello.profile.name),
        email: maskEmail(hello.profile.email),
        gaiaId: maskGaiaId(hello.profile.gaiaId),
      }
    : null;
  return {
    role: hello.role,
    version: hello.version,
    label: hello.label,
    profile,
    profileId: hello.profileId,
    windows: hello.windows,
    tabs: hello.tabs,
    selectedWindowId: hello.selectedWindowId,
    pinnedTabId: hello.pinnedTabId,
    ts: hello.ts,
  };
}

function closeSocketQuietly(ws, code, reason) {
  if (!ws) {
    return;
  }
  try {
    ws.close(code, reason);
  } catch {
    // Ignore close errors.
  }
}

/**
 * Raise Google Chrome itself, macOS only.
 *
 * `chrome.windows.update({focused:true})` cannot bring a background app forward —
 * AppKit only reorders Chrome's own windows. The daemon is a native process, so it
 * does what the extension cannot: an AppleEvent `activate`. Never throws or rejects
 * (the window switch already succeeded); returns whether osascript exited cleanly.
 */
function activateChromeApplication() {
  if (process.platform !== 'darwin') {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (activated) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(activated);
    };

    try {
      // execFile, not exec: no shell, no quoting, no injection surface.
      const child = execFile(
        'osascript',
        ['-e', CHROME_ACTIVATE_SCRIPT],
        { timeout: ACTIVATE_TIMEOUT_MS, windowsHide: true },
        (error) => {
          if (error) {
            log('Chrome activation skipped:', error instanceof Error ? error.message : String(error));
          }
          finish(!error);
        },
      );
      child.on('error', (error) => {
        log('Chrome activation failed:', error instanceof Error ? error.message : String(error));
        finish(false);
      });
    } catch (error) {
      log('Chrome activation failed:', error instanceof Error ? error.message : String(error));
      finish(false);
    }
  });
}

function updateInstanceTopology(ws, message) {
  const entry = instancesBySocket.get(ws);
  if (!entry) {
    return;
  }
  const profileId = readProfileId(message);
  if (profileId) {
    entry.profileId = profileId;
  }
  if (Array.isArray(message.windowList)) {
    entry.windows = message.windowList;
  }
  if (typeof message.windows === 'number') {
    entry.windowCount = message.windows;
  } else if (Array.isArray(message.windowList)) {
    entry.windowCount = message.windowList.length;
  }
  if (typeof message.tabs === 'number') {
    entry.tabCount = message.tabs;
  }
  if (message.profile && typeof message.profile === 'object') {
    entry.profile = message.profile;
  }
  if (message.selectedWindowId !== undefined) {
    entry.selectedWindowId = typeof message.selectedWindowId === 'number' ? message.selectedWindowId : null;
  }
  if (message.pinnedTabId !== undefined) {
    entry.pinnedTabId = typeof message.pinnedTabId === 'number' ? message.pinnedTabId : null;
  }
}

function handleSocketMessage(raw, ws) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch (error) {
    log('Ignoring invalid extension payload:', error instanceof Error ? error.message : String(error));
    return;
  }

  if (message?.type === 'ping') {
    // Heartbeat from the extension (20s cadence, one per connected profile). Chrome
    // keeps the extension worker alive on WebSocket message flow, so this must stay
    // cheap and must never fall through to the unmatched-response log below.
    try {
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
    } catch (error) {
      log('Failed to answer extension ping:', error instanceof Error ? error.message : String(error));
    }
    // A serving profile means the bridge is in use: hold the daemon open.
    resetIdleTimer();
    return;
  }

  if (message?.type === 'hello') {
    registerHello(ws, message);
    return;
  }

  if (message?.type === 'windows') {
    updateInstanceTopology(ws, message);
    return;
  }

  if (message?.type === 'log') {
    const level = typeof message.level === 'string' ? message.level : 'info';
    const line = typeof message.msg === 'string' ? message.msg : JSON.stringify(message.msg);
    log(`[extension:${level}]`, redactLogLine(line));
    return;
  }

  if (!message?.id || !pendingRequests.has(message.id)) {
    // Never stringify the whole response: a late screenshot/cookie/exec result
    // may contain page data or live credentials.
    log(`Ignoring unmatched extension response (id=${message?.id ?? 'none'}, ok=${message?.ok ?? 'unknown'})`);
    return;
  }

  const pending = pendingRequests.get(message.id);
  clearTimeout(pending.timer);
  pendingRequests.delete(message.id);
  pending.resolve(message);
}

function registerHello(ws, hello) {
  const entry = instancesBySocket.get(ws);
  if (!entry) {
    return;
  }
  targets.registerHello(entry, hello, instancesBySocket);
  resetIdleTimer();
  settleExtensionWaiters(null);
}

function handleSocketClose(ws) {
  const entry = instancesBySocket.get(ws);
  if (!entry) {
    return;
  }
  instancesBySocket.delete(ws);
  targets.handleSocketClose(entry);

  // Only fail the in-flight commands that were routed to this instance.
  rejectPendingRequests('Extension disconnected', entry.key);
}

function buildWindowsSnapshotRows() {
  targets.pruneExpiredTombstones();
  const target = resolveTarget();
  const targetKey = 'entry' in target ? target.entry.key : (target.code === 'TARGET_OFFLINE' ? target.target.key : null);
  const targetLabel = 'entry' in target
    ? (target.entry.label || target.entry.key)
    : (target.code === 'TARGET_OFFLINE' ? target.target.label : (targets.designatedLabel || targets.ownerKey || null));
  const ownerEntry = targets.ownerKey ? instances.get(targets.ownerKey) : null;
  const ownerLabel = ownerEntry ? (ownerEntry.label || ownerEntry.key) : targets.ownerKey;

  const { profiles } = readChromeProfiles();
  const connected = connectedInstances();
  const rawRows = [];
  const warnings = [];

  if (target.code === 'TARGET_OFFLINE') {
    const t = target.target;
    const pinPart = t.pinnedTabId !== null ? `pinned tab ${t.pinnedTabId}` : 'pin active';
    warnings.push(`Target instance "${t.label}" (${t.profileName || 'unknown profile'}) is offline (${pinPart}). Windows shown below belong to other profiles; pass --force to switch.`);
  }

  for (const entry of connected) {
    const profileName = resolveProfileName(entry.profile, profiles);
    const maskedEmail = maskEmail(entry.profile?.email || '');
    const isOwner = Boolean(ownerEntry && entry.key === ownerEntry.key);

    const instanceMeta = {
      label: entry.label || entry.key,
      key: entry.key,
      profileName: profileName || '',
      email: maskedEmail,
      version: entry.hello?.version ?? 'unknown',
      owner: isOwner,
      windows: entry.windowCount ?? entry.windows.length,
      tabs: entry.tabCount ?? 0,
    };

    if (!entry.windows || entry.windows.length === 0) {
      warnings.push(`Instance "${entry.label || entry.key}" has no window list reported (version ${entry.hello?.version || '1.3.0'})`);
    } else {
      for (const win of entry.windows) {
        rawRows.push({ instanceMeta, entry, win });
      }
    }
  }

  // Sort by instance label asc, then windowId asc
  rawRows.sort((a, b) => {
    const labelComp = a.instanceMeta.label.localeCompare(b.instanceMeta.label);
    if (labelComp !== 0) return labelComp;
    return (a.win.windowId || 0) - (b.win.windowId || 0);
  });

  // Determine target row
  let targetRow = null;
  if (targetKey) {
    const targetEntry = 'entry' in target ? target.entry : null;
    if (targetEntry) {
      if (targetEntry.selectedWindowId !== null) {
        targetRow = rawRows.find((r) => r.entry.key === targetKey && r.win.windowId === targetEntry.selectedWindowId) || null;
      }
      if (!targetRow) {
        targetRow = rawRows.find((r) => r.entry.key === targetKey && r.win.focused === true) || null;
      }
      if (!targetRow) {
        targetRow = rawRows.find((r) => r.entry.key === targetKey) || null;
      }
    }
  }

  const rows = rawRows.map((item, idx) => {
    const isSelected = item.entry.selectedWindowId !== null && item.entry.selectedWindowId === item.win.windowId;
    const isTarget = Boolean(targetRow && item === targetRow);

    return {
      index: idx,
      instance: item.instanceMeta,
      windowId: item.win.windowId,
      focused: Boolean(item.win.focused),
      state: item.win.state || 'normal',
      type: item.win.type || 'normal',
      incognito: Boolean(item.win.incognito),
      tabCount: item.win.tabCount ?? (Array.isArray(item.win.tabs) ? item.win.tabs.length : 0),
      activeTab: item.win.activeTab ?? null,
      selected: isSelected,
      target: isTarget,
      _entry: item.entry,
    };
  });

  return {
    ownerLabel,
    targetInstance: targetLabel,
    windows: rows,
    warnings,
  };
}

async function handleWindowRequest(req, res) {
  resetIdleTimer();

  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (error) {
    sendBodyError(res, error);
    return;
  }

  const snapshot = buildWindowsSnapshotRows();
  const allRows = snapshot.windows;

  let chosenRow = null;
  const rawTarget = body.target !== undefined && body.target !== null ? String(body.target).trim() : '';

  if (rawTarget && rawTarget.includes(':')) {
    const [labelPart, winIdPart] = rawTarget.split(':');
    const targetKey = normalizeKey(labelPart);
    const winId = Number(winIdPart);
    chosenRow = allRows.find((r) => r.instance.key === targetKey && r.windowId === winId) || null;
    if (!chosenRow) {
      const lookup = targets.lookupInstanceByLabel(targetKey);
      const entry = lookup && 'entry' in lookup ? lookup.entry : null;
      if (!entry || !isSocketOpen(entry.ws)) {
        const detail = lookup && 'error' in lookup ? ` ${lookup.error}` : '';
        sendJson(res, 404, { ok: false, error: `Instance "${labelPart}" is not connected.${detail}` });
        return;
      }
      chosenRow = {
        _entry: entry,
        windowId: winId,
        instance: { label: entry.label || entry.key, key: entry.key },
      };
    }
  } else if (body.instance) {
    const targetKey = normalizeKey(body.instance);
    const lookup = targets.lookupInstanceByLabel(targetKey);
    if (lookup && 'error' in lookup) {
      sendJson(res, 409, { ok: false, error: lookup.error });
      return;
    }
    const entry = lookup ? lookup.entry : null;
    if (!entry || !isSocketOpen(entry.ws)) {
      sendJson(res, 404, { ok: false, error: `Instance "${body.instance}" is not connected` });
      return;
    }
    const winId = Number(body.target ?? body.windowId);
    if (Number.isNaN(winId)) {
      sendJson(res, 400, { ok: false, error: 'Provide a valid numeric windowId or target' });
      return;
    }
    chosenRow = allRows.find((r) => r.instance.key === targetKey && r.windowId === winId) || {
      _entry: entry,
      windowId: winId,
      instance: { label: entry.label || entry.key, key: entry.key },
    };
  } else if (rawTarget !== '' && /^\d+$/.test(rawTarget)) {
    const index = Number(rawTarget);
    if (allRows.length === 0) {
      sendJson(res, 400, { ok: false, error: 'No windows are currently reported by any connected instance' });
      return;
    }
    if (index < 0 || index >= allRows.length) {
      sendJson(res, 400, {
        ok: false,
        error: `Window index ${index} out of range (valid range: 0..${allRows.length - 1})`,
      });
      return;
    }
    chosenRow = allRows[index];
  } else if (body.windowId !== undefined && typeof body.windowId === 'number') {
    const matching = allRows.filter((r) => r.windowId === body.windowId);
    if (matching.length === 1) {
      chosenRow = matching[0];
    } else if (matching.length > 1) {
      sendJson(res, 409, {
        ok: false,
        error: `Window id ${body.windowId} exists in multiple instances. Specify target as "<instance>:${body.windowId}" or use global index.`,
      });
      return;
    } else {
      sendJson(res, 404, { ok: false, error: `Window id ${body.windowId} not found` });
      return;
    }
  } else {
    sendJson(res, 400, {
      ok: false,
      error: 'Provide { target: "<index>|<label>:<windowId>" } (e.g. { target: 0 } or { target: "chrome-ab12:91" })',
    });
    return;
  }

  const entry = chosenRow._entry;
  const windowId = chosenRow.windowId;
  const focus = body.focus === true;

  const currentTarget = targets.getCurrentTargetEntry();
  const pinCheck = targets.checkPinHeld({
    currentTarget,
    newProfileId: entry?.profileId,
    newKey: entry?.key,
    force: body.force === true,
  });
  if (!pinCheck.allowed) {
    sendJson(res, 409, { ok: false, code: pinCheck.code, error: pinCheck.error, target: pinCheck.target });
    return;
  }
  if (body.force === true && currentTarget && currentTarget.disconnectedAt && currentTarget.pinnedTabId !== null) {
    log(`Force override active pin: switching window to "${entry?.label || entry?.key}" while pin held on "${currentTarget.label || currentTarget.key}"`);
  }

  let result;
  try {
    result = await dispatchToEntry(entry, {
      action: 'windows',
      windowOp: 'use',
      windowId,
      focusWindow: focus,
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }

  if (!result || result.ok === false) {
    sendJson(res, 500, { ok: false, error: result?.error || 'Failed to switch window' });
    return;
  }

  targets.designatedLabel = entry.key;
  entry.selectedWindowId = windowId;

  const updatedSnapshot = buildWindowsSnapshotRows();
  const updatedRow = updatedSnapshot.windows.find(
    (r) => r.instance.key === entry.key && r.windowId === windowId
  );
  const cleanTargetRow = updatedRow ? (({ _entry, ...rest }) => rest)(updatedRow) : null;

  // Chromium cannot raise a background app on macOS; the native daemon does it
  // after the extension has acknowledged the in-Chrome window switch.
  const osActivated = focus ? await activateChromeApplication() : false;

  sendJson(res, 200, {
    ok: true,
    message: `Target switched to window ${windowId} on instance "${entry.label || entry.key}"`,
    target: cleanTargetRow,
    ...(focus ? { osActivated } : {}),
  });
}

function handleProfilesRequest(req, res) {
  resetIdleTimer();
  const localState = readChromeProfiles();
  const connected = connectedInstances();

  const profiles = localState.profiles.map((p) => {
    let matchedEntry = null;
    if (p.gaiaId) {
      matchedEntry = connected.find((e) => e.profile?.gaiaId && e.profile.gaiaId === p.gaiaId);
    }
    if (!matchedEntry && p.email) {
      matchedEntry = connected.find(
        (e) => e.profile?.email && e.profile.email.toLowerCase() === p.email.toLowerCase()
      );
    }

    return {
      dir: p.dir,
      name: p.name,
      displayName: p.isDefaultName ? '' : p.name,
      email: maskEmail(p.email),
      gaiaId: maskGaiaId(p.gaiaId),
      instanceLabel: matchedEntry ? (matchedEntry.label || matchedEntry.key) : null,
      connected: Boolean(matchedEntry && isSocketOpen(matchedEntry.ws)),
      windows: matchedEntry ? (matchedEntry.windowCount ?? matchedEntry.windows.length) : 0,
      isDefaultName: p.isDefaultName,
    };
  });

  sendJson(res, 200, {
    ok: true,
    available: localState.available,
    source: localState.source,
    profiles,
  });
}

async function handleReloadRequest(req, res) {
  resetIdleTimer();

  let body = {};
  try {
    const raw = await readBody(req);
    if (raw) body = JSON.parse(raw);
  } catch (error) {
    sendBodyError(res, error);
    return;
  }

  const { instance, all } = body;

  if (all === true) {
    const targets = connectedInstances();
    if (targets.length === 0) {
      sendJson(res, 200, { ok: true, message: 'No connected instances to reload', instances: [] });
      return;
    }
    const results = await Promise.all(
      targets.map(async (entry) => {
        try {
          const resp = await dispatchToEntry(entry, { action: 'reload' }, 5000);
          return { label: entry.label || entry.key, ok: resp.ok !== false, error: resp.error };
        } catch (error) {
          return { label: entry.label || entry.key, ok: false, error: error.message };
        }
      })
    );
    sendJson(res, 200, { ok: results.every((r) => r.ok), instances: results });
    return;
  }

  if (instance) {
    const key = normalizeKey(instance);
    const entry = instances.get(key);
    if (!entry || !isSocketOpen(entry.ws)) {
      sendJson(res, 404, { ok: false, error: `Instance "${instance}" is not connected` });
      return;
    }
    try {
      const resp = await dispatchToEntry(entry, { action: 'reload' }, 5000);
      sendJson(res, resp.ok === false ? 500 : 200, {
        ok: resp.ok !== false,
        instances: [{ label: entry.label || entry.key, ok: resp.ok !== false, error: resp.error }],
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message,
        instances: [{ label: entry.label || entry.key, ok: false, error: error.message }],
      });
    }
    return;
  }

  // Default: current target instance
  const target = resolveTarget();
  if ('error' in target) {
    sendJson(res, 409, { ok: false, error: target.error });
    return;
  }

  try {
    const resp = await dispatchToEntry(target.entry, { action: 'reload' }, 5000);
    sendJson(res, resp.ok === false ? 500 : 200, {
      ok: resp.ok !== false,
      instances: [{ label: target.entry.label || target.entry.key, ok: resp.ok !== false, error: resp.error }],
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error.message,
      instances: [{ label: target.entry.label || target.entry.key, ok: false, error: error.message }],
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 404, { ok: false, error: 'Missing URL' });
    return;
  }

  const pathname = req.url.split('?')[0];

  // 防 DNS-rebinding (P0-2): 拒绝目标不是本机环回权威的请求。
  if (!isAllowedHost(req)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden host', code: 'FORBIDDEN' });
    return;
  }
  // 防 CSRF (P0-2): 直接拒绝网页来源 (Origin)。
  if (isForbiddenOrigin(req)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden origin', code: 'FORBIDDEN' });
    return;
  }

  if (req.method === 'GET' && pathname === '/ping') {
    sendJson(res, 200, {
      ok: true,
      running: true,
      extensionConnected: connectedInstances().length > 0,
      now: nowIso(),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/status') {
    sendJson(res, 200, buildStatusPayload());
    return;
  }

  // 发现路由（/ping、/status）保持公开；其余路由一律要求本地 bearer token。
  if (!isAuthorized(req)) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
    return;
  }

  if (req.method === 'GET' && pathname === '/windows') {
    resetIdleTimer();
    const data = buildWindowsSnapshotRows();
    const publicWindows = data.windows.map(({ _entry, ...rest }) => rest);
    sendJson(res, 200, {
      ok: true,
      count: publicWindows.length,
      ownerLabel: data.ownerLabel,
      targetInstance: data.targetInstance,
      windows: publicWindows,
      ...(data.warnings.length ? { warnings: data.warnings } : {}),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/window') {
    await handleWindowRequest(req, res);
    return;
  }

  if (req.method === 'GET' && pathname === '/profiles') {
    handleProfilesRequest(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/instance') {
    await handleInstanceRequest(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/command') {
    await handleCommandRequest(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/reload') {
    await handleReloadRequest(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/shutdown') {
    sendJson(res, 200, { ok: true, message: 'Shutting down' });
    setTimeout(() => shutdown(0), 50);
    return;
  }

  sendJson(res, 404, { ok: false, error: `Unknown route: ${req.method} ${req.url}` });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ext') {
    socket.destroy();
    return;
  }

  // 要求 chrome-extension:// 来源 (P1-1)。空 Origin（非浏览器的本地客户端）
  // 绝不能冒充扩展。
  const origin = req.headers.origin;
  if (!origin || !origin.startsWith('chrome-extension://')) {
    socket.destroy();
    return;
  }
  // 升级（upgrade）路径同样防 DNS-rebinding。
  if (!isAllowedHost(req)) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const entry = {
      key: null,
      label: null,
      profileId: null,
      ws,
      connectedAt: Date.now(),
      hello: null,
      windows: [],
      windowCount: 0,
      tabCount: 0,
      profile: null,
      selectedWindowId: null,
    };
    instancesBySocket.set(ws, entry);
    log('Extension socket connected (awaiting hello)');
    resetIdleTimer();

    ws.on('message', (raw) => handleSocketMessage(raw, ws));
    ws.on('close', () => handleSocketClose(ws));
    ws.on('error', (error) => {
      log('Extension socket error:', error instanceof Error ? error.message : String(error));
    });
  });
});

function shutdown(exitCode = 0) {
  clearIdleTimer();
  settleExtensionWaiters(new Error('Daemon shutting down'));
  rejectPendingRequests('Daemon shutting down');
  targets.clearWaiters();

  for (const entry of instancesBySocket.values()) {
    closeSocketQuietly(entry.ws, 1001, 'Daemon shutting down');
  }

  server.close(() => {
    process.exit(exitCode);
  });
}

// ─── Lifecycle ───────────────────────────────────────────────────────

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}

async function listenWithFallback() {
  for (let port = START_PORT; port <= MAX_PORT; port += 1) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, HOST);
      });

      activePort = port;
      return;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'EADDRINUSE') {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`No free port found between ${START_PORT} and ${MAX_PORT}`);
}

server.on('error', (error) => {
  log('HTTP server error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

listenWithFallback()
  .then(() => {
    log(`Listening on http://${HOST}:${activePort}`);
    resetIdleTimer();
  })
  .catch((error) => {
    log('Failed to start daemon:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
