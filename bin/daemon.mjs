#!/usr/bin/env node

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const HOST = process.env.AGENT_BROWSER_BRIDGE_HOST || '127.0.0.1';
const START_PORT = Number(process.env.AGENT_BROWSER_BRIDGE_PORT || '19826');
const MAX_PORT = Number(process.env.AGENT_BROWSER_BRIDGE_MAX_PORT || '19835');
const COMMAND_TIMEOUT_MS = Number(process.env.AGENT_BROWSER_BRIDGE_COMMAND_TIMEOUT_MS || '30000');
const IDLE_TIMEOUT_MS = Number(process.env.AGENT_BROWSER_BRIDGE_IDLE_TIMEOUT_MS || String(5 * 60 * 1000));
const EXTENSION_WAIT_MS = Number(process.env.AGENT_BROWSER_BRIDGE_EXTENSION_WAIT_MS || '20000');

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

function nowIso() {
  return new Date().toISOString();
}

function log(...args) {
  console.error('[tt-bridge:daemon]', ...args);
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleCommandRequest(req, res) {
  resetIdleTimer();

  let command;
  try {
    const raw = await readBody(req);
    command = raw ? JSON.parse(raw) : {};
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid JSON body',
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
  }).catch((error) => ({
    id,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));

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
    await handleCommandRequest(req, res);
    return;
  }

  if (req.method === 'POST' && req.url === '/shutdown') {
    sendJson(res, 200, { ok: true, message: 'Shutting down' });
    setTimeout(() => shutdown(0), 50);
    return;
  }

  sendJson(res, 404, { ok: false, error: `Unknown route: ${req.method} ${req.url}` });
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ext') {
    socket.destroy();
    return;
  }

  const origin = req.headers.origin;
  if (origin && !origin.startsWith('chrome-extension://')) {
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
