import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { TargetRegistry, formatTargetOfflineError } from './bin/targets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createMockSocket() {
  return {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: function () {
      this.readyState = WebSocket.CLOSED;
    },
  };
}

test('墓碑跨断连保留：socket close 后实例条目保留在 instances 并标记 disconnectedAt', () => {
  const registry = new TargetRegistry({ tombstoneTtlMs: 10000 });
  const ws1 = createMockSocket();
  const entry1 = {
    key: null,
    label: null,
    profileId: null,
    ws: ws1,
    connectedAt: Date.now(),
  };

  registry.registerHello(entry1, {
    label: 'profile-alpha',
    profileId: 'pid-alpha',
    pinnedTabId: 101,
  });

  assert.equal(registry.instances.has('profile-alpha'), true);
  assert.equal(entry1.pinnedTabId, 101);
  assert.equal(entry1.disconnectedAt, null);
  assert.equal(registry.connectedInstances().length, 1);
  assert.equal(registry.designatedLabel, 'profile-alpha');

  // Trigger disconnect
  ws1.close();
  registry.handleSocketClose(entry1);

  // Assert tombstone preserved
  assert.equal(registry.instances.has('profile-alpha'), true, 'Tombstone must be kept in instances map');
  assert.equal(typeof entry1.disconnectedAt, 'number', 'disconnectedAt must be marked with timestamp');
  assert.equal(registry.connectedInstances().length, 0, 'No instances are open/connected');
  assert.equal(registry.isSocketOpen(entry1.ws), false);

  // Reconnect
  const ws2 = createMockSocket();
  const entry2 = {
    key: null,
    label: null,
    profileId: null,
    ws: ws2,
    connectedAt: Date.now(),
  };

  registry.registerHello(entry2, {
    label: 'profile-alpha',
    profileId: 'pid-alpha',
    pinnedTabId: 101,
  });

  assert.equal(registry.instances.has('profile-alpha'), true);
  assert.equal(entry2.disconnectedAt, null, 'disconnectedAt must be cleared on reconnect');
  assert.equal(registry.connectedInstances().length, 1);
});

test('TTL 过期清理：超过 tombstoneTtlMs 的墓碑被惰性清理', async () => {
  const registry = new TargetRegistry({ tombstoneTtlMs: 60 });
  const ws = createMockSocket();
  const entry = {
    key: null,
    label: null,
    profileId: null,
    ws,
    connectedAt: Date.now(),
  };

  registry.registerHello(entry, {
    label: 'short-lived',
    profileId: 'pid-short',
    pinnedTabId: 42,
  });

  assert.equal(registry.instances.has('short-lived'), true);
  assert.equal(registry.designatedLabel, 'short-lived');

  ws.close();
  registry.handleSocketClose(entry);
  assert.equal(registry.instances.has('short-lived'), true, 'Tombstone initially exists');

  // Wait past TTL
  await new Promise((resolve) => setTimeout(resolve, 80));

  registry.pruneExpiredTombstones();
  assert.equal(registry.instances.has('short-lived'), false, 'Expired tombstone must be removed');
  assert.equal(registry.designatedLabel, null, 'Expired designated label must be cleared');
  assert.equal(registry.ownerKey, null, 'Expired ownerKey must be cleared');
});

test('TARGET_OFFLINE 文案含 profileName + pinnedTabId + 拒绝静默漂移', () => {
  const registry = new TargetRegistry({
    getProfiles: () => ({
      profiles: [
        { name: 'Work Chrome', email: 'worker@company.com' },
        { name: 'Personal Chrome', email: 'me@home.com' },
      ],
    }),
  });

  const wsA = createMockSocket();
  const entryA = { ws: wsA };
  registry.registerHello(entryA, {
    label: 'work',
    profileId: 'pid-work',
    pinnedTabId: 8888,
    profile: { profileName: 'Work Chrome' },
  });

  const wsB = createMockSocket();
  const entryB = { ws: wsB };
  registry.registerHello(entryB, {
    label: 'personal',
    profileId: 'pid-personal',
    pinnedTabId: null,
    profile: { profileName: 'Personal Chrome' },
  });

  assert.equal(registry.designatedLabel, 'work');

  // Disconnect work
  wsA.close();
  registry.handleSocketClose(entryA);

  const targetResult = registry.resolveTarget();
  assert.equal(targetResult.code, 'TARGET_OFFLINE');
  assert.equal(targetResult.target.label, 'work');
  assert.equal(targetResult.target.profileName, 'Work Chrome');
  assert.equal(targetResult.target.pinnedTabId, 8888);
  assert.equal(typeof targetResult.target.disconnectedAt, 'number');

  assert.equal(targetResult.connected.length, 1);
  assert.equal(targetResult.connected[0].label, 'personal');
  assert.equal(targetResult.connected[0].profileName, 'Personal Chrome');

  // Check error message wording requirement
  const msg = targetResult.error;
  assert.match(msg, /work/, 'error message must contain target label');
  assert.match(msg, /Work Chrome/, 'error message must contain profileName');
  assert.match(msg, /8888/, 'error message must contain pinnedTabId');
  assert.match(msg, /Personal Chrome/, 'error message must contain connected profileName');
  assert.match(msg, /Refusing to drift to another Chrome profile while a pin is active; open that profile or pass --force/,
    'error message must contain exact refusal clause');
});

test('定向等待在目标重连后成功', async () => {
  const registry = new TargetRegistry({ targetWaitMs: 1000 });
  const ws1 = createMockSocket();
  const entry1 = { ws: ws1 };
  registry.registerHello(entry1, {
    label: 'target-service',
    profileId: 'pid-target',
    pinnedTabId: 123,
  });

  ws1.close();
  registry.handleSocketClose(entry1);

  const waitPromise = registry.waitForTarget('target-service');

  // After 50ms, simulate reconnect
  setTimeout(() => {
    const ws2 = createMockSocket();
    const entry2 = { ws: ws2 };
    registry.registerHello(entry2, {
      label: 'target-service',
      profileId: 'pid-target',
      pinnedTabId: 123,
    });
  }, 50);

  const result = await waitPromise;
  assert.equal(result, true, 'waitForTarget must resolve true when target reconnects');
  const resolved = registry.resolveTarget();
  assert.equal('entry' in resolved, true, 'resolveTarget must now find connected target');
});

test('其他实例在线/重连不短路定向等待', async () => {
  const registry = new TargetRegistry({ targetWaitMs: 250 });
  const wsA = createMockSocket();
  const entryA = { ws: wsA };
  registry.registerHello(entryA, {
    label: 'profile-a',
    profileId: 'pid-a',
    pinnedTabId: 99,
  });

  wsA.close();
  registry.handleSocketClose(entryA);

  // Profile B is connected
  const wsB = createMockSocket();
  const entryB = { ws: wsB };
  registry.registerHello(entryB, {
    label: 'profile-b',
    profileId: 'pid-b',
  });

  const waitPromise = registry.waitForTarget('profile-a');

  // Send activity from profile-b while waiting for profile-a
  setTimeout(() => {
    registry.notifyTargetReconnected('profile-b');
  }, 50);

  let waitSettledEarly = false;
  waitPromise.then(() => {
    waitSettledEarly = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(waitSettledEarly, false, 'Other instance activity must NOT resolve or short-circuit wait');

  const result = await waitPromise;
  assert.equal(result, false, 'Must time out with false because profile-a never reconnected');
});

test('PIN_HELD 拦截与 force 放行', () => {
  const registry = new TargetRegistry();
  const currentTarget = {
    key: 'target-pinned',
    label: 'target-pinned',
    profileId: 'pid-alpha',
    pinnedTabId: 999,
    disconnectedAt: Date.now() - 1000,
    profile: { profileName: 'Alpha' },
  };

  // 1. Without force, switching to different profileId is blocked with PIN_HELD
  const blocked = registry.checkPinHeld({
    currentTarget,
    newProfileId: 'pid-beta',
    newKey: 'target-beta',
    force: false,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'PIN_HELD');
  assert.equal(blocked.target.pinnedTabId, 999);
  assert.match(blocked.error, /--force/);

  // 2. With force, switching is allowed
  const allowed = registry.checkPinHeld({
    currentTarget,
    newProfileId: 'pid-beta',
    newKey: 'target-beta',
    force: true,
  });
  assert.equal(allowed.allowed, true);

  // 3. Switching within same profileId is allowed even without force
  const sameProfile = registry.checkPinHeld({
    currentTarget,
    newProfileId: 'pid-alpha',
    newKey: 'target-alpha-win2',
    force: false,
  });
  assert.equal(sameProfile.allowed, true);
});

test('端到端 smoke：独立端口 19899 启动 daemon，断开其一报 409，重连恢复', async () => {
  const testPort = 19899;
  const daemonPath = path.resolve(__dirname, './bin/daemon.mjs');
  // Isolated HOME: the daemon writes its bearer token under ~/.config.
  const smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-bridge-smoke-home-'));

  const child = spawn(process.execPath, [daemonPath], {
    env: {
      ...process.env,
      HOME: smokeHome,
      AGENT_BROWSER_BRIDGE_PORT: String(testPort),
      AGENT_BROWSER_BRIDGE_MAX_PORT: String(testPort + 5),
      AGENT_BROWSER_BRIDGE_HOST: '127.0.0.1',
      AGENT_BROWSER_BRIDGE_TARGET_WAIT_MS: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stderr.on('data', (d) => {
    // console.error('[smoke:daemon]', d.toString());
  });

  const cleanup = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore
    }
  };

  // Poll until ready
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${testPort}/ping`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.equal(ready, true, `Daemon failed to start on port ${testPort}`);

  const token = fs.readFileSync(path.join(smokeHome, '.config', 'tt-bridge', 'token'), 'utf8').trim();
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const extensionOrigin = 'chrome-extension://smoketest';

  try {
    // 1. Connect Client A (Smoke Alpha, with pin)
    const wsA = new WebSocket(`ws://127.0.0.1:${testPort}/ext`, { origin: extensionOrigin });
    await new Promise((resolve, reject) => {
      wsA.once('open', resolve);
      wsA.once('error', reject);
    });
    wsA.send(JSON.stringify({
      type: 'hello',
      label: 'smoke-alpha',
      profileId: 'pid-smoke-a',
      pinnedTabId: 7777,
      profile: { profileName: 'SmokeAlphaProfile' },
      windowList: [{ windowId: 10, focused: true }],
    }));
    await new Promise((r) => setTimeout(r, 100));

    // 2. Connect Client B (Smoke Beta, no pin)
    const wsB = new WebSocket(`ws://127.0.0.1:${testPort}/ext`, { origin: extensionOrigin });
    await new Promise((resolve, reject) => {
      wsB.once('open', resolve);
      wsB.once('error', reject);
    });
    wsB.send(JSON.stringify({
      type: 'hello',
      label: 'smoke-beta',
      profileId: 'pid-smoke-b',
      profile: { profileName: 'SmokeBetaProfile' },
      windowList: [{ windowId: 20, focused: false }],
    }));
    await new Promise((r) => setTimeout(r, 100));

    // Check status: smoke-alpha is owner
    const status1 = await (await fetch(`http://127.0.0.1:${testPort}/status`)).json();
    assert.equal(status1.ownerLabel, 'smoke-alpha');
    assert.equal(status1.ownerOnline, true);
    assert.equal(status1.instances.length, 2);

    // 2b. Regression: a live topology event must not crash the daemon.
    //     v1.4.5 shipped a dangling readProfileId() call on this exact path,
    //     which killed the daemon the first time a window/tab changed.
    wsB.send(JSON.stringify({
      type: 'windows',
      profileId: 'pid-smoke-b',
      windowList: [{ windowId: 20, focused: false }, { windowId: 21, focused: true }],
      windows: 2,
      tabs: 5,
    }));
    await new Promise((r) => setTimeout(r, 150));
    const pingAfterTopology = await fetch(`http://127.0.0.1:${testPort}/ping`);
    assert.equal(pingAfterTopology.ok, true, 'daemon crashed on a windows topology event');
    const statusTopology = await (await fetch(`http://127.0.0.1:${testPort}/status`)).json();
    const betaInst = statusTopology.instances.find((i) => i.label === 'smoke-beta');
    assert.equal(betaInst.windowCount, 2);

    // 2c. Regression: window targeting goes through the registry helper; a
    //     removed local lookup would throw a ReferenceError and kill the daemon.
    const ghostWindow = await fetch(`http://127.0.0.1:${testPort}/window`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ target: 'ghost:20' }),
    });
    assert.equal(ghostWindow.status, 404);
    const ghostInstance = await fetch(`http://127.0.0.1:${testPort}/window`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ instance: 'ghost', target: 20 }),
    });
    assert.equal(ghostInstance.status, 404);
    const pingAfterGhost = await fetch(`http://127.0.0.1:${testPort}/ping`);
    assert.equal(pingAfterGhost.ok, true, 'daemon crashed on an unknown window target');

    // 3. Disconnect Client A
    wsA.close();
    await new Promise((r) => setTimeout(r, 100));

    // Verify /status still shows ownerLabel with ownerOnline: false and tombstone info
    const status2 = await (await fetch(`http://127.0.0.1:${testPort}/status`)).json();
    assert.equal(status2.ownerLabel, 'smoke-alpha');
    assert.equal(status2.ownerOnline, false);
    const alphaInst = status2.instances.find((i) => i.label === 'smoke-alpha');
    assert.equal(Boolean(alphaInst), true);
    assert.equal(alphaInst.connected, false);
    assert.equal(alphaInst.pinnedTabId, 7777);
    assert.equal(typeof alphaInst.disconnectedAt, 'string');

    // 4. Send POST /command -> must time out after 500ms and return 409 TARGET_OFFLINE
    const cmdRes = await fetch(`http://127.0.0.1:${testPort}/command`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ action: 'ping' }),
    });
    assert.equal(cmdRes.status, 409);
    const cmdPayload = await cmdRes.json();
    assert.equal(cmdPayload.code, 'TARGET_OFFLINE');
    assert.match(cmdPayload.error, /smoke-alpha/);
    assert.match(cmdPayload.error, /SmokeAlphaProfile/);
    assert.match(cmdPayload.error, /7777/);
    assert.match(cmdPayload.error, /SmokeBetaProfile/);
    assert.match(cmdPayload.error, /Refusing to drift to another Chrome profile while a pin is active; open that profile or pass --force/);

    // 5. Test PIN_HELD protection on /instance
    const instSwitchNoForce = await fetch(`http://127.0.0.1:${testPort}/instance`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ label: 'smoke-beta' }),
    });
    assert.equal(instSwitchNoForce.status, 409);
    const pinHeldPayload = await instSwitchNoForce.json();
    assert.equal(pinHeldPayload.code, 'PIN_HELD');

    // 6. Test /instance switch with force: true succeeds
    const instSwitchForce = await fetch(`http://127.0.0.1:${testPort}/instance`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ label: 'smoke-beta', force: true }),
    });
    assert.equal(instSwitchForce.status, 200);

    // Re-anchor to smoke-alpha with force
    await fetch(`http://127.0.0.1:${testPort}/instance`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ label: 'smoke-alpha', force: true }),
    });

    // 7. Reconnect Client A
    const wsA2 = new WebSocket(`ws://127.0.0.1:${testPort}/ext`, { origin: extensionOrigin });
    await new Promise((resolve, reject) => {
      wsA2.once('open', resolve);
      wsA2.once('error', reject);
    });

    // Handle command dispatch on Client A
    wsA2.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.action === 'ping' && msg.id) {
          wsA2.send(JSON.stringify({ id: msg.id, ok: true, pong: true }));
        }
      } catch {
        // Ignore
      }
    });

    wsA2.send(JSON.stringify({
      type: 'hello',
      label: 'smoke-alpha',
      profileId: 'pid-smoke-a',
      pinnedTabId: 7777,
      profile: { profileName: 'SmokeAlphaProfile' },
      windowList: [{ windowId: 10, focused: true }],
    }));
    await new Promise((r) => setTimeout(r, 100));

    // Send POST /command -> now succeeds!
    const cmdRes2 = await fetch(`http://127.0.0.1:${testPort}/command`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ action: 'ping' }),
    });
    assert.equal(cmdRes2.status, 200);
    const cmdPayload2 = await cmdRes2.json();
    assert.equal(cmdPayload2.ok, true);
    assert.equal(cmdPayload2.pong, true);

    wsA2.close();
    wsB.close();
  } finally {
    cleanup();
    fs.rmSync(smokeHome, { recursive: true, force: true });
  }
});
