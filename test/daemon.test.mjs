// P2-8 / P0-P2 regression tests for the hardened daemon HTTP contract.
// Run: node --test test/daemon.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.resolve(__dirname, '../x-cli/tt-bridge-cli/bin/daemon.mjs');
const PORT = 19940;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let home;
let token;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'ttb-test-'));
  child = spawn(process.execPath, [DAEMON], {
    stdio: 'ignore',
    env: {
      ...process.env,
      HOME: home,
      AGENT_BROWSER_BRIDGE_PORT: String(PORT),
      AGENT_BROWSER_BRIDGE_MAX_PORT: String(PORT + 2),
      AGENT_BROWSER_BRIDGE_EXTENSION_WAIT_MS: '300',
      AGENT_BROWSER_BRIDGE_MAX_BODY_BYTES: '1000',
    },
  });
  // Wait for the daemon to answer /status.
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${BASE}/status`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  token = readFileSync(path.join(home, '.config', 'tt-bridge', 'token'), 'utf8').trim();
});

after(() => {
  if (child) child.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

const post = (body, headers = {}) =>
  fetch(`${BASE}/command`, { method: 'POST', headers, body: JSON.stringify(body) });

// Node's fetch (undici) refuses to forge the Host header, so use raw http for that.
const rawPost = (headers, body = '{}') =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/command', method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : {} }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });

test('daemon mints a 64-hex token', () => {
  assert.match(token, /^[0-9a-f]{64}$/);
});

test('GET /status needs no auth', async () => {
  const r = await fetch(`${BASE}/status`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.running, true);
});

test('POST /command without token -> 401 UNAUTHORIZED', async () => {
  const r = await post({ action: 'exec', code: '1' });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).code, 'UNAUTHORIZED');
});

test('POST /command with wrong token -> 401', async () => {
  const r = await post({ action: 'exec', code: '1' }, { Authorization: 'Bearer nope' });
  assert.equal(r.status, 401);
});

test('POST /command with valid token routes (503 no extension)', async () => {
  const r = await post({ action: 'exec', code: '1' }, { Authorization: `Bearer ${token}` });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, 'EXT_NOT_CONNECTED');
});

test('forged Host -> 403 FORBIDDEN (anti DNS-rebinding)', async () => {
  const r = await rawPost(
    { Host: 'evil.example.com', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    JSON.stringify({ action: 'exec', code: '1' }),
  );
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'FORBIDDEN');
});

test('web Origin -> 403 FORBIDDEN (anti CSRF)', async () => {
  const r = await post({ action: 'exec', code: '1' }, { Authorization: `Bearer ${token}`, Origin: 'https://evil.example.com' });
  assert.equal(r.status, 403);
});

test('chrome-extension Origin is allowed through', async () => {
  const r = await post({ action: 'exec', code: '1' }, { Authorization: `Bearer ${token}`, Origin: 'chrome-extension://abcdefghijklmnop' });
  assert.equal(r.status, 503); // passed host+origin+auth, failed only on "no extension"
});

test('oversized body -> 413 PAYLOAD_TOO_LARGE', async () => {
  const big = 'a'.repeat(3000);
  const r = await fetch(`${BASE}/command`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: big,
  });
  assert.equal(r.status, 413);
  assert.equal((await r.json()).code, 'PAYLOAD_TOO_LARGE');
});

test('POST /shutdown without token -> 401', async () => {
  const r = await fetch(`${BASE}/shutdown`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 401);
});

test('authed /shutdown stops the daemon', async () => {
  const r = await fetch(`${BASE}/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' });
  assert.equal(r.status, 200);
  // Give it a moment, then confirm it is gone.
  await new Promise((res) => setTimeout(res, 300));
  let down = false;
  try { await fetch(`${BASE}/status`); } catch { down = true; }
  assert.equal(down, true);
});
