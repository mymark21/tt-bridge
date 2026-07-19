// P2-8: unit tests for the REAL shipped extension logic. The bundle has no
// import/export, so we run its source in a node:vm context with a chrome mock
// and harvest the top-level function declarations. This exercises the actual
// patched code paths (file:// blocking, cookie redaction, command validation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BG = path.resolve(__dirname, '../x-ext/tt-bridge-chrome-extension/dist/background.js');
const source = readFileSync(BG, 'utf8');

const COOKIE_FIXTURE = [
  { name: 'sid', value: 'SECRET-SESSION', domain: 'example.com', path: '/', secure: true, httpOnly: true, expirationDate: 0 },
  { name: 'theme', value: 'dark', domain: 'example.com', path: '/', secure: false, httpOnly: false, expirationDate: 0 },
];

function noopEvent() { return { addListener() {} }; }

function buildSandbox() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => ({ ok: false, text: async () => '' }),
    WebSocket: Object.assign(function WebSocket() {}, { OPEN: 1, CONNECTING: 0 }),
    chrome: {
      runtime: { onInstalled: noopEvent(), onStartup: noopEvent(), onMessage: noopEvent(), getManifest: () => ({ version: '0.0.0-test' }), id: 'testid' },
      alarms: { create() {}, onAlarm: noopEvent() },
      tabs: { onRemoved: noopEvent(), onUpdated: noopEvent(), query: async () => [], get: async () => ({}), create: async () => ({}), update: async () => ({}), remove: async () => {} },
      debugger: { onDetach: noopEvent(), attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
      windows: { onRemoved: noopEvent(), create: async () => ({ id: 1, incognito: true }), get: async () => ({ incognito: true }), getLastFocused: async () => ({ id: 1 }), remove: async () => {}, update: async () => {} },
      cookies: { getAll: async () => COOKIE_FIXTURE },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      extension: { isAllowedIncognitoAccess: async () => true },
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

const ctx = buildSandbox();
vm.runInNewContext(source, ctx, { filename: 'background.js' });

test('validateCommand accepts a well-formed exec', () => {
  assert.equal(ctx.validateCommand({ action: 'exec', code: 'document.title' }), null);
});

test('validateCommand rejects unknown action', () => {
  assert.match(ctx.validateCommand({ action: 'rm-rf' }), /Unknown action/);
});

test('validateCommand rejects exec without string code', () => {
  assert.match(ctx.validateCommand({ action: 'exec' }), /requires a string/);
});

test('validateCommand bounds screenshot quality', () => {
  assert.match(ctx.validateCommand({ action: 'screenshot', quality: 500 }), /0-100/);
  assert.equal(ctx.validateCommand({ action: 'screenshot', quality: 80 }), null);
});

test('validateCommand rejects non-finite tabId', () => {
  assert.match(ctx.validateCommand({ action: 'sessions', tabId: NaN }), /finite number/);
});

test('isDebuggableUrl blocks file:// and privileged schemes', () => {
  assert.equal(ctx.isDebuggableUrl('file:///etc/passwd'), false);
  assert.equal(ctx.isDebuggableUrl('view-source:https://x.com'), false);
  assert.equal(ctx.isDebuggableUrl('devtools://devtools/'), false);
  assert.equal(ctx.isDebuggableUrl('chrome://settings'), false);
  assert.equal(ctx.isDebuggableUrl('https://example.com'), true);
  // second copy of the function must match
  assert.equal(ctx.isDebuggableUrl$1('file:///etc/passwd'), false);
  assert.equal(ctx.isDebuggableUrl$1('https://example.com'), true);
});

test('handleCookies refuses wildcard dumps (no domain/url)', async () => {
  const res = await ctx.handleCookies({ id: '1' });
  assert.equal(res.ok, false);
  assert.match(res.error, /domain.*url|filter/);
});

test('handleCookies never returns httpOnly cookie values', async () => {
  const res = await ctx.handleCookies({ id: '2', domain: 'example.com' });
  assert.equal(res.ok, true);
  const sid = res.data.find((c) => c.name === 'sid');
  const theme = res.data.find((c) => c.name === 'theme');
  assert.equal(sid.httpOnly, true);
  assert.equal(sid.value, undefined, 'httpOnly cookie value must be stripped');
  assert.equal(theme.value, 'dark', 'non-httpOnly value is preserved');
});

test('auditFromCommand truncates long exec code and captures navigate url', () => {
  const longCode = 'x'.repeat(200);
  const e1 = ctx.auditFromCommand({ action: 'exec', code: longCode }, 'human');
  assert.equal(e1.action, 'exec');
  assert.ok(e1.detail.length <= 81); // 80 + ellipsis
  const e2 = ctx.auditFromCommand({ action: 'navigate', url: 'https://a.test/x' }, 'human');
  assert.equal(e2.detail, 'https://a.test/x');
});
