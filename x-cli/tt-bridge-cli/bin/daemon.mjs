#!/usr/bin/env node

import http from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const HOST = process.env.AGENT_BROWSER_BRIDGE_HOST || '127.0.0.1';
const START_PORT = Number(process.env.AGENT_BROWSER_BRIDGE_PORT || '19826');
const MAX_PORT = Number(process.env.AGENT_BROWSER_BRIDGE_MAX_PORT || '19835');
const COMMAND_TIMEOUT_MS = Number(process.env.AGENT_BROWSER_BRIDGE_COMMAND_TIMEOUT_MS || '30000');
const IDLE_TIMEOUT_MS = Number(process.env.AGENT_BROWSER_BRIDGE_IDLE_TIMEOUT_MS || String(5 * 60 * 1000));
const EXTENSION_WAIT_MS = Number(process.env.AGENT_BROWSER_BRIDGE_EXTENSION_WAIT_MS || '20000');
const MAX_BODY_BYTES = Number(process.env.AGENT_BROWSER_BRIDGE_MAX_BODY_BYTES || String(5 * 1024 * 1024));
const MAX_PENDING = Number(process.env.AGENT_BROWSER_BRIDGE_MAX_PENDING || '256');
const MAX_WAITERS = Number(process.env.AGENT_BROWSER_BRIDGE_MAX_WAITERS || '256');

const startedAt = Date.now();
let activePort = START_PORT;

/** @type {WebSocket | null} */
let extensionSocket = null;
/** @type {null | { connectedAt: number, hello?: Record<string, unknown> }} */
let extensionState = null;
/** @type {Map<string, { resolve: (value: unknown) => void, reject: (reason?: unknown) => void, timer: NodeJS.Timeout }>} */
const pendingRequests = new Map();
/** @type {Set<{ resolve: () => void, reject: (reason?: unknown) => void, timer: NodeJS.Timeout }>} */
const extensionWaiters = new Set();
/** @type {NodeJS.Timeout | null} */
let idleTimer = null;

// --- 共享密钥鉴权 (P0-1) --------------------------------------------------
// daemon 启动时生成一次 token,以 0600 权限存到用户 config 目录。只有能读到
// 该文件的进程(即同一用户运行的 CLI)才能驱动浏览器。扩展从不调用
// /command 或 /shutdown,因此不需要 token。
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
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  } catch (error) {
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

// 防 DNS-rebinding (P0-2):Host 必须是我们自己的环回权威。
function isAllowedHost(req) {
  const host = req.headers.host || '';
  return host === `127.0.0.1:${activePort}`
    || host === `localhost:${activePort}`
    || host === `[::1]:${activePort}`;
}

// 防 CSRF (P0-2):真实网页一定带 http(s) Origin;CLI 不带;扩展带
// chrome-extension://。拒绝网页 Origin。
function isForbiddenOrigin(req) {
  const origin = req.headers.origin;
  return Boolean(origin) && !origin.startsWith('chrome-extension://');
}

function nowIso() {
  return new Date().toISOString();
}

function log(...args) {
  console.error('[agent-browser-bridge:daemon]', ...args);
}

function isExtensionConnected() {
  return Boolean(extensionSocket && extensionSocket.readyState === WebSocket.OPEN);
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

function rejectPendingRequests(message) {
  for (const [id, pending] of pendingRequests.entries()) {
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
  if (isExtensionConnected()) {
    return Promise.resolve();
  }

  if (extensionWaiters.size >= MAX_WAITERS) {
    return Promise.reject(new Error('Too many callers waiting for the extension'));
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
        // 排空(丢弃)剩余数据但不缓冲,让 socket 存活、调用方仍能收到 413 响应。
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

  const id = typeof command.id === 'string' && command.id ? command.id : randomUUID();
  const outbound = { ...command, id };

  try {
    if (!isExtensionConnected()) {
      await waitForExtension();
    }
  } catch (error) {
    sendJson(res, 503, {
      id,
      ok: false,
      error: error instanceof Error ? error.message : 'Extension not connected',
      code: 'EXT_NOT_CONNECTED',
    });
    return;
  }

  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timed out waiting for result after ${COMMAND_TIMEOUT_MS}ms`));
    }, COMMAND_TIMEOUT_MS);

    pendingRequests.set(id, { resolve, reject, timer });

    try {
      extensionSocket.send(JSON.stringify(outbound));
    } catch (error) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(error);
    }
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id,
      ok: false,
      error: message,
      code: message.includes('Timed out') ? 'TIMEOUT' : 'INTERNAL',
    };
  });

  sendJson(res, response.ok === false ? 500 : 200, response);
}

function handleSocketMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch (error) {
    log('Ignoring invalid extension payload:', error instanceof Error ? error.message : String(error));
    return;
  }

  if (message?.type === 'hello') {
    extensionState = {
      connectedAt: extensionState?.connectedAt || Date.now(),
      hello: message,
    };
    log(`Extension hello: id=${message.extensionId || 'unknown'} version=${message.version || 'unknown'}`);
    return;
  }

  if (message?.type === 'log') {
    const level = typeof message.level === 'string' ? message.level : 'info';
    const line = typeof message.msg === 'string' ? message.msg : JSON.stringify(message.msg);
    log(`[extension:${level}]`, line);
    return;
  }

  if (!message?.id || !pendingRequests.has(message.id)) {
    log('Ignoring unmatched extension response:', JSON.stringify(message));
    return;
  }

  const pending = pendingRequests.get(message.id);
  clearTimeout(pending.timer);
  pendingRequests.delete(message.id);
  pending.resolve(message);
}

function buildStatusPayload() {
  return {
    ok: true,
    running: true,
    host: HOST,
    port: activePort,
    extensionConnected: isExtensionConnected(),
    pendingRequests: pendingRequests.size,
    uptimeMs: Date.now() - startedAt,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    extension: extensionState,
    now: nowIso(),
  };
}

function shutdown(exitCode = 0) {
  clearIdleTimer();
  settleExtensionWaiters(new Error('Daemon shutting down'));
  rejectPendingRequests('Daemon shutting down');

  if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
    try {
      extensionSocket.close(1001, 'Daemon shutting down');
    } catch {
      // Ignore socket shutdown errors.
    }
  }

  server.close(() => {
    process.exit(exitCode);
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 404, { ok: false, error: 'Missing URL' });
    return;
  }

  // 防 DNS-rebinding (P0-2):拒绝目标不是本机环回权威的请求。
  if (!isAllowedHost(req)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden host', code: 'FORBIDDEN' });
    return;
  }
  // 防 CSRF (P0-2):直接拒绝网页来源(Origin)。
  if (isForbiddenOrigin(req)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden origin', code: 'FORBIDDEN' });
    return;
  }

  if (req.method === 'GET' && req.url === '/ping') {
    sendJson(res, 200, {
      ok: true,
      running: true,
      extensionConnected: isExtensionConnected(),
      now: nowIso(),
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    sendJson(res, 200, buildStatusPayload());
    return;
  }

  if (req.method === 'POST' && req.url === '/command') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }
    await handleCommandRequest(req, res);
    return;
  }

  if (req.method === 'POST' && req.url === '/shutdown') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }
    sendJson(res, 200, { ok: true, message: 'Shutting down' });
    setTimeout(() => shutdown(0), 50);
    return;
  }

  sendJson(res, 404, { ok: false, error: `Unknown route: ${req.method} ${req.url}` });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ext') {
    socket.destroy();
    return;
  }

  // 要求 chrome-extension:// 来源 (P1-1)。空 Origin(非浏览器的本地客户端)
  // 绝不能冒充扩展。
  const origin = req.headers.origin;
  if (!origin || !origin.startsWith('chrome-extension://')) {
    socket.destroy();
    return;
  }
  // 升级(upgrade)路径同样防 DNS-rebinding。
  if (!isAllowedHost(req)) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
      try {
        extensionSocket.close(1000, 'Superseded by a new extension connection');
      } catch {
        // Ignore close errors.
      }
      // P1-4:别让在途请求挂在旧 socket 上直到超时。
      rejectPendingRequests('Extension connection superseded by a new connection');
    }

    extensionSocket = ws;
    extensionState = {
      connectedAt: Date.now(),
    };
    log('Extension connected');
    resetIdleTimer();
    settleExtensionWaiters(null);

    ws.on('message', handleSocketMessage);
    ws.on('close', () => {
      if (extensionSocket === ws) {
        extensionSocket = null;
        log('Extension disconnected');
        rejectPendingRequests('Extension disconnected');
      }
    });
    ws.on('error', (error) => {
      log('Extension socket error:', error instanceof Error ? error.message : String(error));
    });
  });
});

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

listenWithFallback()
  .then(() => {
    log(`Listening on http://${HOST}:${activePort}`);
    // P2-3:持久的致命错误处理器只在 listen 成功后再挂。挂早了会在第一次
    // EADDRINUSE 时先 process.exit(1),抢在 listenWithFallback 退到下一端口
    // 之前,使整个回退循环变成死代码。
    server.on('error', (error) => {
      log('HTTP server error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
    resetIdleTimer();
  })
  .catch((error) => {
    log('Failed to start daemon:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
