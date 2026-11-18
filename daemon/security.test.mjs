/**
 * End-to-end security tests for the daemon's loopback HTTP/WS surface.
 *
 * The daemon is a real child process with an isolated HOME (so token creation
 * cannot touch the developer's real ~/.config/tt-bridge) and a private port.
 * Covers the v1.0.5/v1.0.6 hardening that must survive every port:
 *   - Bearer token auth on every non-discovery route
 *   - Host (DNS rebinding) and Origin (CSRF) rejection
 *   - request body cap and non-object JSON rejection
 *   - WebSocket upgrade requires a chrome-extension:// Origin
 *   - the CLI attaches the token only to authenticated routes
 *
 * Run: node security.test.mjs
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const DAEMON_PATH = fileURLToPath(new URL('./bin/daemon.mjs', import.meta.url));
const CLI_PATH = fileURLToPath(new URL('./bin/cli.mjs', import.meta.url));
const MAX_BODY = 1024;

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStatus(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // daemon not listening yet
    }
    await sleep(50);
  }
  throw new Error(`daemon did not start listening on ${port}`);
}

/** Raw request so tests can forge Host/Origin/Authorization exactly. */
function rawRequest(port, { method = 'GET', path: requestPath = '/status', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path: requestPath, headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let payload = {};
          try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
          resolve({ status: res.statusCode, payload });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-bridge-sec-home-'));
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-bridge-sec-empty-'));
const port = await reservePort();
const env = {
  ...process.env,
  HOME: tmpHome,
  AGENT_BROWSER_BRIDGE_PORT: String(port),
  AGENT_BROWSER_BRIDGE_MAX_PORT: String(port),
  AGENT_BROWSER_BRIDGE_MAX_BODY_BYTES: String(MAX_BODY),
  AGENT_BROWSER_BRIDGE_EXTENSION_WAIT_MS: '50',
  AGENT_BROWSER_BRIDGE_IDLE_TIMEOUT_MS: '0',
};

let stderr = '';
const child = spawn(process.execPath, [DAEMON_PATH], { env, stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });

let wsOpenClient = null;

try {
  await waitForStatus(port);

  // ── token file ────────────────────────────────────────────────────
  const tokenPath = path.join(tmpHome, '.config', 'tt-bridge', 'token');
  assert.ok(fs.existsSync(tokenPath), 'daemon creates the auth token file');
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  assert.equal(token.length, 64, 'token is 32 random bytes as hex');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(tokenPath).mode & 0o077, 0, 'token file grants nothing to group/other');
  }

  // ── public discovery routes ───────────────────────────────────────
  const status = await rawRequest(port, { path: '/status' });
  assert.equal(status.status, 200, '/status stays public for discovery');
  assert.equal(status.payload.running, true);

  const ping = await rawRequest(port, { path: '/ping' });
  assert.equal(ping.status, 200, '/ping stays public');

  // ── bearer auth on command routes ─────────────────────────────────
  const noToken = await rawRequest(port, { method: 'POST', path: '/command', body: '{}' });
  assert.equal(noToken.status, 401, 'POST /command without token is 401');
  assert.equal(noToken.payload.code, 'UNAUTHORIZED');

  const wrongToken = await rawRequest(port, {
    method: 'POST',
    path: '/command',
    headers: { Authorization: 'Bearer deadbeef' },
    body: '{}',
  });
  assert.equal(wrongToken.status, 401, 'wrong token is 401');

  for (const [method, route] of [['GET', '/windows'], ['GET', '/profiles']]) {
    const res = await rawRequest(port, { method, path: route });
    assert.equal(res.status, 401, `${method} ${route} without token is 401`);
  }

  const authedCommand = await rawRequest(port, {
    method: 'POST',
    path: '/command',
    headers: { Authorization: `Bearer ${token}` },
    body: '{}',
  });
  assert.notEqual(authedCommand.status, 401, 'valid token clears the auth gate');
  assert.equal(authedCommand.status, 503, 'no extension connected -> 503, not an auth error');

  // ── DNS-rebinding / CSRF ──────────────────────────────────────────
  const evilHost = await rawRequest(port, { path: '/status', headers: { Host: 'evil.example' } });
  assert.equal(evilHost.status, 403, 'non-loopback Host is rejected');
  assert.equal(evilHost.payload.code, 'FORBIDDEN');

  const evilOrigin = await rawRequest(port, {
    method: 'POST',
    path: '/command',
    headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' },
    body: '{}',
  });
  assert.equal(evilOrigin.status, 403, 'web Origin is rejected even with a valid token');

  const extensionOrigin = await rawRequest(port, {
    method: 'POST',
    path: '/command',
    headers: { Authorization: `Bearer ${token}`, Origin: 'chrome-extension://abcdefghijklmnop' },
    body: '{}',
  });
  assert.notEqual(extensionOrigin.status, 403, 'chrome-extension:// Origin is allowed');

  // ── body limits and JSON shape ────────────────────────────────────
  const oversized = await rawRequest(port, {
    method: 'POST',
    path: '/command',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'x', action: 'exec', code: 'a'.repeat(MAX_BODY * 2) }),
  });
  assert.equal(oversized.status, 413, 'body over the cap is rejected with 413');
  assert.equal(oversized.payload.code, 'PAYLOAD_TOO_LARGE');

  for (const body of ['null', '[]', '"text"']) {
    const invalid = await rawRequest(port, {
      method: 'POST',
      path: '/command',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(invalid.status, 400, `body ${body} is rejected as non-object`);
    assert.equal(invalid.payload.code, 'BAD_REQUEST');
  }

  // ── WebSocket upgrade origin ──────────────────────────────────────
  const wsRejection = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch { /* ignore */ }
      resolve(result);
    };
    ws.on('open', () => finish('opened'));
    ws.on('unexpected-response', (_req, res) => finish(`rejected:${res.statusCode}`));
    ws.on('error', () => finish('rejected'));
    setTimeout(() => finish('timeout'), 3000);
  });
  assert.ok(wsRejection !== 'opened', 'WS without chrome-extension:// Origin is not accepted');
  assert.ok(wsRejection !== 'timeout', 'WS without Origin is rejected promptly');

  const wsAllow = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, {
      origin: 'chrome-extension://abcdefghijklmnop',
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    ws.on('open', () => { wsOpenClient = ws; finish('opened'); });
    ws.on('error', (error) => finish(`error:${error.message}`));
    setTimeout(() => finish('timeout'), 3000);
  });
  assert.equal(wsAllow, 'opened', 'WS with chrome-extension:// Origin is accepted');

  // ── /status must not leak profile PII ─────────────────────────────
  wsOpenClient.send(JSON.stringify({
    type: 'hello',
    label: 'sec-profile',
    profileId: 'pid-sec',
    profile: { email: 'alice@example.com', gaiaId: '1234567890123456', name: 'Alice Smith' },
    windowList: [{ windowId: 1, focused: true }],
  }));
  await sleep(100);
  const publicStatus = await rawRequest(port, { path: '/status' });
  assert.equal(publicStatus.status, 200);
  const statusText = JSON.stringify(publicStatus.payload);
  assert.ok(!statusText.includes('alice@example.com'), '/status redacts the raw profile email');
  assert.ok(!statusText.includes('1234567890123456'), '/status redacts the raw gaia id');
  assert.ok(!statusText.includes('Alice Smith'), '/status redacts the raw profile name');
  assert.ok(statusText.includes('a***@example.com'), '/status keeps only the masked email');
  assert.ok(statusText.includes('Alice S.'), '/status keeps only the masked profile name');

  // ── forwarded extension logs and late responses are redacted ──────
  wsOpenClient.send(JSON.stringify({
    type: 'log',
    level: 'warn',
    msg: 'navigate failed: Authorization: Bearer LEAKED https://example.com/cb?token=SECRET',
  }));
  wsOpenClient.send(JSON.stringify({
    id: 'late-response',
    ok: true,
    data: { cookie: 'SECRET_COOKIE', body: 'PRIVATE_PAGE' },
  }));
  await sleep(150);
  assert.ok(!stderr.includes('LEAKED'), 'forwarded log redacts bearer tokens');
  assert.ok(!stderr.includes('token=SECRET'), 'forwarded log redacts URL query values');
  assert.ok(!stderr.includes('SECRET_COOKIE'), 'late response payload is not logged');
  assert.ok(!stderr.includes('PRIVATE_PAGE'), 'late response payload is not logged');
  assert.match(stderr, /\[extension:warn\].*REDACTED/, 'the redacted log line is still forwarded');

  // ── CLI token wiring ──────────────────────────────────────────────
  const cliEnv = { ...env };
  const cliAuthed = spawnSync(process.execPath, [CLI_PATH, 'window', 'list', '--json'], {
    env: cliEnv,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(cliAuthed.status, 0, `CLI finds the token and calls /windows: ${cliAuthed.stderr || cliAuthed.stdout}`);

  const cliNoToken = spawnSync(process.execPath, [CLI_PATH, 'window', 'list', '--json'], {
    env: { ...cliEnv, HOME: emptyHome },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.notEqual(cliNoToken.status, 0, 'CLI without the token file fails on /windows');
  assert.match(`${cliNoToken.stdout}${cliNoToken.stderr}`, /unauthorized/i, 'CLI surfaces UNAUTHORIZED');

  console.log('security.test.mjs: all assertions passed');
} finally {
  if (wsOpenClient) {
    try { wsOpenClient.terminate(); } catch { /* ignore */ }
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3000),
  ]);
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(emptyHome, { recursive: true, force: true });
}
