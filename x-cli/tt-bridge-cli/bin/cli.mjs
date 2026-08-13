#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const HOST = process.env.AGENT_BROWSER_BRIDGE_HOST || '127.0.0.1';
const START_PORT = Number(process.env.AGENT_BROWSER_BRIDGE_PORT || '19826');
const MAX_PORT = Number(process.env.AGENT_BROWSER_BRIDGE_MAX_PORT || '19835');
const DAEMON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), './daemon.mjs');
const require = createRequire(import.meta.url);
let activePort = null;

// 共享密钥鉴权 (P0-1):daemon 会把 token 以 0600 存到用户 config 目录。
// 这里读取它(惰性重读,因为它在 daemon 首次启动时才创建),并在每个请求
// 上作为 Bearer 头发送。
const TOKEN_FILE = path.join(os.homedir(), '.config', 'tt-bridge', 'token');
function readAuthToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}
let AUTH_TOKEN = readAuthToken();

function printHelp() {
  console.log(`tt-bridge — AI browser control via Chrome extension

Usage:
  tt-bridge serve                   Start daemon in foreground (keep terminal open)
  tt-bridge ping
  tt-bridge status [--json]
  tt-bridge daemon start|stop|status [--json]
  tt-bridge open <url> [--human] [--workspace name] [--tab <id>] [--json]
  tt-bridge eval <js> [--human] [--workspace name] [--tab <id>] [--json]
  tt-bridge click <selector> [--human] [--workspace name] [--tab <id>] [--json]
  tt-bridge tab list [--human] [--workspace name] [--json]
  tt-bridge tab new [url] [--human] [--workspace name] [--json]
  tt-bridge tab <index> [--human] [--workspace name] [--json]
  tt-bridge tab select <index> [--human] [--workspace name] [--json]
  tt-bridge tab close <index> [--human] [--workspace name] [--json]
  tt-bridge screenshot [path] [--human] [--full-page] [--format png|jpeg] [--quality <n>] [--workspace name] [--tab <id>] [--json]
  tt-bridge sessions [--json]
  tt-bridge close-window [--human] [--workspace name] [--json]

Default:
  Commands target the user's currently visible normal Chrome window.

Options:
  --workspace <name>
    Use an isolated automation workspace. Non-human workspaces may create dedicated incognito windows.

Flags:
  --human   Compatibility alias for --workspace human
`);
}

function parseArgs(argv) {
  const options = {
    json: false,
    workspace: 'human',
    human: false,
    tabId: undefined,
    fullPage: false,
    format: undefined,
    quality: undefined,
  };
  const rest = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--json':
        options.json = true;
        break;
      case '--human':
        options.human = true;
        break;
      case '--workspace':
        options.workspace = argv[++i];
        break;
      case '--tab':
        options.tabId = Number(argv[++i]);
        break;
      case '--full-page':
        options.fullPage = true;
        break;
      case '--format':
        options.format = argv[++i];
        break;
      case '--quality':
        options.quality = Number(argv[++i]);
        break;
      default:
        rest.push(arg);
        break;
    }
  }

  // --human is shorthand for --workspace human
  if (options.human) {
    options.workspace = 'human';
  }

  return { options, rest };
}

function isBridgeStatusPayload(payload) {
  return Boolean(
    payload
    && payload.ok === true
    && payload.running === true
    && typeof payload.host === 'string'
    && typeof payload.port === 'number',
  );
}

async function fetchJsonForPort(port, urlPath, init = {}, timeoutMs = 3000) {
  if (!AUTH_TOKEN) {
    AUTH_TOKEN = readAuthToken();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${HOST}:${port}${urlPath}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { ok: false, error: text || `Non-JSON response (${response.status})` };
    }
    return { response, payload };
  } finally {
    clearTimeout(timer);
  }
}

async function findRunningDaemon(timeoutMs = 600) {
  for (let port = START_PORT; port <= MAX_PORT; port += 1) {
    try {
      const { response, payload } = await fetchJsonForPort(port, '/status', {}, timeoutMs);
      if (response.ok && isBridgeStatusPayload(payload)) {
        activePort = port;
        return { port, payload };
      }
    } catch {
      // Ignore unreachable ports during discovery.
    }
  }

  activePort = null;
  return null;
}

async function fetchJson(urlPath, init = {}, timeoutMs = 3000) {
  const resolvedPort = activePort ?? START_PORT;
  return await fetchJsonForPort(resolvedPort, urlPath, init, timeoutMs);
}

async function isDaemonRunning() {
  const running = await findRunningDaemon();
  return Boolean(running);
}

async function ensureResolvedPort() {
  if (activePort !== null) {
    return activePort;
  }

  const daemon = await findRunningDaemon();
  if (!daemon) {
    throw new Error('Daemon is not running');
  }

  return daemon.port;
}

async function ensureDaemonRunning() {
  const runningDaemon = await findRunningDaemon();
  if (runningDaemon) {
    return;
  }

  try {
    require.resolve('ws');
  } catch {
    throw new Error(
      'Cannot start daemon because dependency "ws" is missing. Re-extract the latest tt-bridge-cli.zip, or run "npm install" inside the tt-bridge-cli folder before starting TT Bridge.',
    );
  }

  const child = spawn(process.execPath, [DAEMON_PATH], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const daemon = await findRunningDaemon();
    if (daemon) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('Timed out starting local daemon');
}

async function sendCommand(command, autoStart = true) {
  if (autoStart) {
    await ensureDaemonRunning();
  }

  await ensureResolvedPort();

  const payload = {
    id: command.id || randomUUID(),
    ...command,
  };
  const { response, payload: result } = await fetchJson('/command', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, 35000);

  if (!response.ok || result.ok === false) {
    throw new Error(result.error || `Command failed with HTTP ${response.status}`);
  }
  return result;
}

function printMaybeJson(value, options) {
  if (options.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (typeof value === 'string') {
    console.log(value);
    return;
  }

  console.log(JSON.stringify(value, null, 2));
}

function printTabList(tabs) {
  for (const tab of tabs) {
    const marker = tab.active ? '→' : ' ';
    const title = tab.title || '';
    const url = tab.url || '';
    if (title && url) {
      console.log(`${marker} [${tab.index}] ${title} - ${url}`);
    } else if (url) {
      console.log(`${marker} [${tab.index}] - ${url}`);
    } else {
      console.log(`${marker} [${tab.index}] ${title}`);
    }
  }
}

function buildClickExpression(selector) {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const node = document.querySelector(selector);
    if (!node) {
      throw new Error('Selector not found: ' + selector);
    }
    node.click();
    return JSON.stringify({ clicked: true, selector });
  })()`;
}

async function main() {
  const { options, rest } = parseArgs(process.argv.slice(2));
  if (rest.length === 0 || rest[0] === 'help' || rest[0] === '--help' || rest[0] === '-h') {
    printHelp();
    return;
  }

  const [command, ...args] = rest;

  // Foreground daemon — keeps process alive, logs to stderr
  if (command === 'serve') {
    const result = spawnSync(process.execPath, [DAEMON_PATH], {
      stdio: 'inherit',
      env: process.env,
    });
    process.exitCode = result.status ?? 0;
    return;
  }

  if (command === 'ping') {
    const running = await isDaemonRunning();
    if (!running) {
      process.exitCode = 1;
      console.error('Daemon is not running');
      return;
    }
    console.log('pong');
    return;
  }

  if (command === 'status') {
    const daemon = await findRunningDaemon();
    if (!daemon) {
      printMaybeJson({ running: false, extensionConnected: false }, options);
      return;
    }
    const { payload } = await fetchJson('/status');
    printMaybeJson(payload, options);
    return;
  }

  if (command === 'daemon') {
    const subcommand = args[0];
    if (subcommand === 'start') {
      await ensureDaemonRunning();
      const { payload } = await fetchJson('/status');
      printMaybeJson(payload, options);
      return;
    }
    if (subcommand === 'stop') {
      const daemon = await findRunningDaemon();
      if (!daemon) {
        printMaybeJson({ running: false }, options);
        return;
      }
      const { payload } = await fetchJsonForPort(daemon.port, '/shutdown', { method: 'POST', body: '{}' });
      activePort = null;
      printMaybeJson(payload, options);
      return;
    }
    if (subcommand === 'status') {
      const daemon = await findRunningDaemon();
      if (!daemon) {
        printMaybeJson({ running: false, extensionConnected: false }, options);
        return;
      }
      const { payload } = await fetchJson('/status');
      printMaybeJson(payload, options);
      return;
    }
    throw new Error(`Unknown daemon command: ${subcommand || '(missing)'}`);
  }

  if (command === 'open') {
    const url = args[0];
    if (!url) {
      throw new Error('Missing URL');
    }
    const result = await sendCommand({
      action: 'navigate',
      url,
      workspace: options.workspace,
      tabId: options.tabId,
    });
    printMaybeJson(result.data, options);
    return;
  }

  if (command === 'eval') {
    const expression = args[0];
    if (!expression) {
      throw new Error('Missing JavaScript expression');
    }
    const result = await sendCommand({
      action: 'exec',
      code: expression,
      workspace: options.workspace,
      tabId: options.tabId,
    });
    console.log(JSON.stringify(result.data));
    return;
  }

  if (command === 'click') {
    const selector = args[0];
    if (!selector) {
      throw new Error('Missing selector');
    }
    const result = await sendCommand({
      action: 'exec',
      code: buildClickExpression(selector),
      workspace: options.workspace,
      tabId: options.tabId,
    });
    printMaybeJson(result.data, options);
    return;
  }

  if (command === 'tab') {
    if (args.length === 0) {
      const result = await sendCommand({
        action: 'tabs',
        op: 'list',
        workspace: options.workspace,
      });
      if (options.json) {
        printMaybeJson(result.data, options);
      } else {
        printTabList(Array.isArray(result.data) ? result.data : []);
      }
      return;
    }

    if (/^\d+$/.test(args[0])) {
      const result = await sendCommand({
        action: 'tabs',
        op: 'select',
        index: Number(args[0]),
        workspace: options.workspace,
      });
      printMaybeJson(result.data, options);
      return;
    }

    const subcommand = args[0];
    if (subcommand === 'list') {
      const result = await sendCommand({
        action: 'tabs',
        op: 'list',
        workspace: options.workspace,
      });
      if (options.json) {
        printMaybeJson(result.data, options);
      } else {
        printTabList(Array.isArray(result.data) ? result.data : []);
      }
      return;
    }
    if (subcommand === 'new') {
      const result = await sendCommand({
        action: 'tabs',
        op: 'new',
        url: args[1],
        workspace: options.workspace,
      });
      printMaybeJson(result.data, options);
      return;
    }
    if (subcommand === 'select') {
      const index = Number(args[1]);
      if (Number.isNaN(index)) {
        throw new Error('tab select requires a numeric index');
      }
      const result = await sendCommand({
        action: 'tabs',
        op: 'select',
        index,
        workspace: options.workspace,
      });
      printMaybeJson(result.data, options);
      return;
    }
    if (subcommand === 'close') {
      const index = args[1] === undefined ? undefined : Number(args[1]);
      if (args[1] !== undefined && Number.isNaN(index)) {
        throw new Error('tab close requires a numeric index');
      }
      const result = await sendCommand({
        action: 'tabs',
        op: 'close',
        index,
        workspace: options.workspace,
        tabId: index === undefined ? options.tabId : undefined,
      });
      printMaybeJson(result.data, options);
      return;
    }
    throw new Error(`Unknown tab command: ${subcommand}`);
  }

  if (command === 'screenshot') {
    const outputPath = args[0] && !args[0].startsWith('--') ? args[0] : null;
    const result = await sendCommand({
      action: 'screenshot',
      workspace: options.workspace,
      tabId: options.tabId,
      format: options.format,
      quality: options.quality,
      fullPage: options.fullPage,
    });
    if (typeof result.data !== 'string') {
      throw new Error('Screenshot response did not contain base64 data');
    }
    if (outputPath) {
      fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
      fs.writeFileSync(path.resolve(outputPath), Buffer.from(result.data, 'base64'));
      printMaybeJson({ path: path.resolve(outputPath) }, options);
    } else {
      console.log(result.data);
    }
    return;
  }

  if (command === 'sessions') {
    const result = await sendCommand({ action: 'sessions' });
    printMaybeJson(result.data, options);
    return;
  }

  if (command === 'close-window') {
    const result = await sendCommand({
      action: 'close-window',
      workspace: options.workspace,
    });
    printMaybeJson(result.data, options);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
