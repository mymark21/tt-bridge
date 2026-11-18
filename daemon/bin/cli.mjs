#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  DEFAULT_CAPTURE_AFTER,
  DEFAULT_MISS_THRESHOLD,
  advise,
  beginEpisode,
  createDraft,
  defaultExperienceDir,
  deprecateEntry,
  endEpisode,
  finalizeEntry,
  findEntries,
  ledgerList,
  ledgerShow,
  listEntries,
  markSeen,
  pruneLedger,
  readEntry,
  rebuildIndex,
  recordAttempt,
  resetLedger,
  runEntry,
  entryFile,
  summarizeEntry,
  updateEntry,
  validateAll,
  harvestTraceState,
  HARVEST_INTERACTION_CMDS,
  hasSeen,
  PROCESS_SESSION_ID,
} from './experience.mjs';

const HOST = process.env.AGENT_BROWSER_BRIDGE_HOST || '127.0.0.1';
const START_PORT = Number(process.env.AGENT_BROWSER_BRIDGE_PORT || '19826');
const MAX_PORT = Number(process.env.AGENT_BROWSER_BRIDGE_MAX_PORT || '19835');
const DAEMON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), './daemon.mjs');

// Shared secret written by the daemon at startup. Only authenticated routes get
// it as a Bearer header; /status and port discovery stay public and must never
// carry the token, or any local process sniffing loopback traffic could lift it.
const TOKEN_FILE = path.join(os.homedir(), '.config', 'tt-bridge', 'token');
function readAuthToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}
let AUTH_TOKEN = readAuthToken();
const AUTH_ROUTES = new Set([
  '/command',
  '/shutdown',
  '/window',
  '/instance',
  '/reload',
  '/windows',
  '/profiles',
]);
// Parsed CLI options, kept module-level so the command success path can honour
// --quiet without threading the option bag through sendCommand.
let cliOptions = {};
let activePort = null;

function printHelp() {
  console.log(`tt-bridge — AI browser control via Chrome extension

Usage:
  tt-bridge serve                   Start daemon in foreground (keep terminal open)
  tt-bridge ping
  tt-bridge status [--json]
  tt-bridge daemon start|stop|status [--json]
  tt-bridge instance list [--json]
  tt-bridge instance use <label> [--json]
  tt-bridge instance clear [--json]
  tt-bridge instance rename <new-label> [--json]
  tt-bridge window [list] [--json]
  tt-bridge window use <index|label:winId> [--focus] [--json]
  tt-bridge window focus <index|label:winId> [--json]
  tt-bridge window status [--json]
  tt-bridge profile [list] [--json]
  tt-bridge reload [--all] [--instance <label>] [--json]
  tt-bridge open <url> [--human] [--workspace name] [--tab <id>] [--json]
  tt-bridge eval <js> [--human] [--workspace name] [--tab <id>] [--json]
  tt-bridge click <selector> [--human] [--workspace name] [--tab <id>] [--json]
  tt-bridge type <text> [--human] [--workspace name] [--tab <id>] [--json]
  tt-bridge focus <selector> [--human] [--workspace name] [--tab <id>] [--json]
  tt-bridge key <keyname> [--human] [--workspace name] [--tab <id>] [--json]
  tt-bridge emulate <preset> [--human] [--workspace name] [--tab <id>] [--json]
  tt-bridge emulate <width> <height> [--dpr <n>] [--mobile] [--touch] [--user-agent <str>] [--human] [--workspace name] [--tab <id>] [--json]
  tt-bridge emulate reset [--human] [--workspace name] [--tab <id>] [--json]
  tt-bridge tab list [--human] [--workspace name] [--json]
  tt-bridge tab new [url] [--mute] [--human] [--workspace name] [--json]   Background tab in human mode (no focus steal); --mute mutes the new tab
  tt-bridge tab pin [--tab <id>] [--json]        Pin the human tab the agent should keep using
  tt-bridge tab unpin [--json]                   Release the pinned tab (back to follow-active-tab)
  tt-bridge tab status [--json]                  Show the current pinned tab
  tt-bridge tab <index> [--human] [--workspace name] [--json]
  tt-bridge tab select <index|--tab <id>> [--human] [--workspace name] [--json]
  tt-bridge tab close <index> [--human] [--workspace name] [--json]
  tt-bridge screenshot [path] [--human] [--full-page] [--format png|jpeg] [--quality <n>] [--viewport <WxH>] [--device <name>] [--no-reset] [--restore] [--workspace name] [--tab <id>] [--json]
  tt-bridge sessions [--json]
  tt-bridge cookies [--domain <d>] [--url <u>] [--show-values] [--json]
  tt-bridge close-window [--human] [--workspace name] [--json]
  tt-bridge experience advise --host <h> --action <a> [--arg <x>] [--json]
  tt-bridge experience begin --url <url> --intent <slug> [--session <id>] [--json]
  tt-bridge experience end --session <id> --assert <file> [--error <msg>] [--errclass page|env] [--json]
  tt-bridge experience find <url> [--intent <slug>] [--all] [--json]
  tt-bridge experience show <id> [--json]
  tt-bridge experience list [--host <h>] [--kind <k>] [--status <s>] [--json]
  tt-bridge experience miss --url <url> --intent <slug> [--error <msg>] [--json]
  tt-bridge experience hit --url <url> --intent <slug> [--id <id>] [--json]
  tt-bridge experience capture --url <url> --intent <slug> --kind text|script|hybrid --description "<text>" [--body-file <md>] [--script-file <py>] [--tags a,b] [--json]
  tt-bridge experience finalize <id> [--body-file <md>] [--script-file <py>] [--kind <k>] [--verify-script] [--allow-script-exec] [--json]
  tt-bridge experience update <id> [--status <s>] [--description <text>] [--tags a,b] [--kind <k>] [--match <m>] [--body-file <md>] [--json]
  tt-bridge experience deprecate <id> [--reason <text>] [--json]
  tt-bridge experience run <id> [--url <url>] [--force] [--json] [-- <script args>]
  tt-bridge experience reindex [--json]
  tt-bridge experience validate [--json]
  tt-bridge experience ledger list|show <key>|prune --older-than <90d>|reset [--json]

Flags:
  --human            Target the human's current tab (pinned tab wins once pinned; no separate window)
  --workspace <name> Automation session key (ignored with --human)
  --tab <id>         Target a specific tab by id (one-shot; tab pin makes it sticky)
  --focus            With window use: also raise the OS window (note: macOS may only bounce Dock without user gesture)
  --all              With reload: reload all instances; with experience find: skip match/status filtering
  --instance <label> Target a specific instance by label (with reload or window)
  --dpr <n>          Device scale factor for emulate (default 1)
  --mobile           Emulate a mobile viewport (emulate)
  --touch            Enable touch emulation (emulate); defaults to --mobile value
  --user-agent <s>   Override User-Agent (emulate)
  --viewport <WxH>   Convenience for screenshot: emulate WxH before capture
  --device <name>    Convenience for screenshot: emulate a device preset before capture
  --no-reset         With --viewport/--device screenshot, keep the emulation after capture
  --restore          With screenshot (human workspace): restore a minimized window to normal before capture
  --mute             With tab new: mute the newly created tab (default: not muted)
  --domain <d>       With cookies: only cookies for this domain
  --url <u>          Target URL (cookies filter; experience find/miss/hit/capture/finalize/run)
  --show-values      With cookies: print raw cookie values (WARNING: live session credentials — do NOT paste into logs or model context). Default masks values (first 6 chars + '***')
  --intent <slug>    Experience: stable intent slug (e.g. post-comment, export-csv)
  --host <h>         Experience list: filter by host
  --id <id>          Experience hit: target an existing entry id
  --match <m>        Experience capture: exact|prefix|glob (default prefix)
  --kind <k>         Experience: text|script|hybrid
  --description <s>  Experience: one-line summary for the entry
  --body-file <md>   Experience: read the entry body from a Markdown file
  --script-file <py> Experience: attach a python3 script to the entry
  --tags <a,b>       Experience: comma-separated tags
  --status <s>       Experience: draft|verified|stale|deprecated (list/update filter)
  --error <msg>      Experience: error detail recorded with a miss
  --reason <text>    Experience: deprecation reason
  --force            Experience run: allow a draft/stale entry (review it first); entries are never overwritten
  --older-than <d>   Experience ledger prune: max age (e.g. 90d, 12h)
  --no-auto-capture  Experience: do not auto-create a draft at the capture threshold
  --verify-script    Experience finalize: run the script before marking verified
  --allow-script-exec Experience finalize: allow --verify-script to execute a stored script
  --threshold <n>    Experience: consecutive misses before candidate/stale (default 2)
  --capture-after <n> Experience: attempts before auto-capture (default 3)
  --json             Machine-readable JSON output

Device presets:
  iphone14, iphone14pro, iphone14promax, iphonese, ipad, ipadpro, pixel7, galaxys23

Examples:
  tt-bridge emulate iphone14
  tt-bridge emulate 390 844 --dpr 3 --mobile
  tt-bridge emulate reset
  tt-bridge screenshot mobile.png --device iphone14
  tt-bridge screenshot wide.png --viewport 1280x720

Window shift:
  tt-bridge window list                         # view all windows across profiles (see IDX column)
  tt-bridge window use 0                        # retarget to window 0 without stealing focus
  tt-bridge window use chrome-ab12:91 --focus   # switch to specific window and raise it
  tt-bridge window focus 1                      # switch and raise window 1
  tt-bridge profile list                        # view Chrome profiles and instance connections
  tt-bridge reload --all                        # hot-reload extension in all profiles
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
    dpr: undefined,
    mobile: false,
    touch: undefined,
    userAgent: undefined,
    viewport: undefined,
    device: undefined,
    noReset: false,
    mute: false,
    restore: false,
    showValues: false,
    domain: undefined,
    url: undefined,
    focus: false,
    all: false,
    instance: undefined,
    intent: undefined,
    kind: undefined,
    description: undefined,
    bodyFile: undefined,
    scriptFile: undefined,
    tags: undefined,
    status: undefined,
    errclass: undefined,
    error: undefined,
    reason: undefined,
    force: false,
    olderThan: undefined,
    autoCapture: true,
    verifyScript: false,
    allowScriptExec: false,
    threshold: undefined,
    captureAfter: undefined,
    match: undefined,
    passthrough: [],
    host: undefined,
    id: undefined,
    session: undefined,
    assert: undefined,
    action: undefined,
    arg: undefined,
    quiet: false,
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
      case '--focus':
        options.focus = true;
        break;
      case '--all':
        options.all = true;
        break;
      case '--instance':
        options.instance = argv[++i];
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
      case '--dpr':
        options.dpr = Number(argv[++i]);
        break;
      case '--mobile':
        options.mobile = true;
        break;
      case '--touch':
        options.touch = true;
        break;
      case '--user-agent':
        options.userAgent = argv[++i];
        break;
      case '--viewport':
        options.viewport = argv[++i];
        break;
      case '--device':
        options.device = argv[++i];
        break;
      case '--no-reset':
        options.noReset = true;
        break;
      case '--mute':
        options.mute = true;
        break;
      case '--restore':
        options.restore = true;
        break;
      case '--show-values':
        options.showValues = true;
        break;
      case '--domain':
        options.domain = argv[++i];
        break;
      case '--url':
        options.url = argv[++i];
        break;
      case '--intent':
        options.intent = argv[++i];
        break;
      case '--kind':
        options.kind = argv[++i];
        break;
      case '--description':
        options.description = argv[++i];
        break;
      case '--body-file':
        options.bodyFile = argv[++i];
        break;
      case '--script-file':
        options.scriptFile = argv[++i];
        break;
      case '--tags':
        options.tags = argv[++i];
        break;
      case '--status':
        options.status = argv[++i];
        break;
      case '--error':
        options.error = argv[++i];
        break;
      case '--errclass':
        options.errclass = argv[++i];
        break;
      case '--reason':
        options.reason = argv[++i];
        break;
      case '--force':
        options.force = true;
        break;
      case '--older-than':
        options.olderThan = argv[++i];
        break;
      case '--no-auto-capture':
        options.autoCapture = false;
        break;
      case '--verify-script':
        options.verifyScript = true;
        break;
      case '--allow-script-exec':
        options.allowScriptExec = true;
        break;
      case '--threshold':
        options.threshold = Number(argv[++i]);
        break;
      case '--capture-after':
        options.captureAfter = Number(argv[++i]);
        break;
      case '--match':
        options.match = argv[++i];
        break;
      case '--host':
        options.host = argv[++i];
        break;
      case '--id':
        options.id = argv[++i];
        break;
      case '--session':
        options.session = argv[++i];
        break;
      case '--assert':
        options.assert = argv[++i];
        break;
      case '--action':
        options.action = argv[++i];
        break;
      case '--arg':
        options.arg = argv[++i];
        break;
      case '--quiet':
      case '-q':
        options.quiet = true;
        break;
      case '--':
        options.passthrough = argv.slice(i + 1);
        i = argv.length;
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
  const route = urlPath.split('?')[0];
  const sendAuth = AUTH_ROUTES.has(route);
  if (sendAuth && !AUTH_TOKEN) {
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
        ...(sendAuth && AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
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

const MAX_DAEMON_LOG_SIZE = 5 * 1024 * 1024; // 5 MiB

function resolveDaemonLogPath() {
  const envPath = process.env.TT_BRIDGE_DAEMON_LOG;
  if (envPath && envPath.trim()) {
    const trimmed = envPath.trim();
    if (trimmed.startsWith('~/') || trimmed === '~') {
      const home = process.env.HOME || os.homedir();
      return path.resolve(path.join(home, trimmed.slice(1)));
    }
    return path.resolve(trimmed);
  }
  const home = process.env.HOME || os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Logs', 'tt-bridge', 'daemon.log');
  }
  return path.join(home, '.cache', 'tt-bridge', 'daemon.log');
}

function rotateDaemonLogIfNeeded(logPath) {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size > MAX_DAEMON_LOG_SIZE) {
      const rotatedPath = path.join(path.dirname(logPath), 'daemon.log.1');
      try {
        fs.renameSync(logPath, rotatedPath);
      } catch {
        try {
          fs.unlinkSync(rotatedPath);
          fs.renameSync(logPath, rotatedPath);
        } catch {
          // Ignore rotate error to avoid preventing daemon startup
        }
      }
    }
  } catch {
    // Log file does not exist yet
  }
}

async function ensureDaemonRunning() {
  const runningDaemon = await findRunningDaemon();
  if (runningDaemon) {
    return;
  }

  let child;
  let logFd = null;
  let logPath = null;

  try {
    logPath = resolveDaemonLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    rotateDaemonLogIfNeeded(logPath);
    logFd = fs.openSync(logPath, 'a', 0o600);
    // The daemon log can contain page URLs; keep it private even if the file
    // predates this mode or was created by an older CLI.
    try { fs.chmodSync(logPath, 0o600); } catch { /* best effort */ }
    child = spawn(process.execPath, [DAEMON_PATH], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
    fs.writeSync(logFd, `=== daemon start ${new Date().toISOString()} pid=${child.pid} ===\n`);
  } catch (error) {
    console.error(`Warning: failed to set up daemon log at ${logPath || '(unknown)'}: ${error.message}; falling back to stdio: 'ignore'`);
    if (!child) {
      child = spawn(process.execPath, [DAEMON_PATH], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
    }
  } finally {
    if (logFd !== null) {
      try {
        fs.closeSync(logFd);
      } catch {}
    }
  }
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

// Host attribution for the trace. Kept inside the experience store (0600) rather
// than $TMPDIR: a world-writable directory lets any local process pre-create the
// path as a symlink and have this write land outside the store.
function cachedHostFile(session) {
  const sid = String(session || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(path.resolve(defaultExperienceDir()), '_state', `host-${sid}.txt`);
}

function readHostCache(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return null;
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function getCachedHost(session) {
  return readHostCache(cachedHostFile(session));
}

function setCachedHost(session, host) {
  if (!host) return;
  try {
    const file = cachedHostFile(session);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    try {
      if (fs.lstatSync(file).isSymbolicLink()) return;
    } catch { /* absent is fine */ }
    fs.writeFileSync(file, String(host).trim().toLowerCase(), { encoding: 'utf8', mode: 0o600 });
  } catch {}
}

// L0 trace: every browser command appends one fact line, whether it succeeded
// or not. This is the raw material the atom layer aggregates (failure rate per
// host+action) and the only history that survives a page-level bug. It never
// decides hit/miss — a command exiting 0 is not proof the goal was reached.
//
// Privacy: this file sits on disk indefinitely, so driver text and URL query
// values must never land here verbatim. `type`/`input` arguments are typed
// secrets (passwords, tokens) and URLs routinely carry session tokens.
const TRACE_SECRET_FIELDS = new Set(['input', 'type', 'key']);

function traceArg(action, arg, options) {
  if (arg === undefined || arg === null) return null;
  const text = String(arg);
  const cmd = String(options && options.cmd ? options.cmd : action || '');
  if (TRACE_SECRET_FIELDS.has(cmd) || TRACE_SECRET_FIELDS.has(String(action || ''))) {
    // Keep only a shape hint: length + first character class, never the value.
    return `<redacted:${text.length}>`;
  }
  if (cmd === 'eval' || String(action) === 'exec') {
    // Eval snippets routinely embed Authorization headers or API tokens. The
    // trace only needs the gesture's shape, never the credential.
    return redactTraceError(text).slice(0, 120);
  }
  if (cmd === 'open' || cmd === 'navigate' || String(action) === 'navigate') {
    return stripUrlSecrets(text);
  }
  return text.slice(0, 120);
}

// Drop userinfo + query values while keeping the shape of the URL useful for
// failure-rate aggregation (host and path survive).
function stripUrlSecrets(raw) {
  try {
    const url = new URL(String(raw));
    url.username = '';
    url.password = '';
    if (url.search) {
      const kept = [];
      for (const [k, v] of url.searchParams) kept.push(`${k}=${v ? '[REDACTED]' : ''}`);
      url.search = kept.length ? `?${kept.join('&')}` : '';
    }
    return url.toString().slice(0, 120);
  } catch {
    return String(raw).replace(/\/\/[^/@\s]+@/g, '//[REDACTED]@').slice(0, 120);
  }
}

function appendTrace(action, arg, ok, error, options) {
  try {
    if (process.env.TT_BRIDGE_EXPERIENCE_NO_TRACE === '1') return;
    const root = defaultExperienceDir();
    const dir = path.join(path.resolve(root), '_trace');
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const session = (options && options.session) || process.env.TT_BRIDGE_SESSION || null;
    const host = (options && options.host) || getCachedHost(session) || null;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      session,
      host,
      // `cmd` is the CLI verb the user typed (open/eval/click/...). `action` is
      // the protocol verb (navigate/exec/input). Advice keys off the CLI verb,
      // so both must be recorded or the failure-rate layer silently misses.
      cmd: (options && options.cmd) || null,
      action,
      arg: traceArg(action, arg, options),
      ok: Boolean(ok),
      // Errors carry cookies/URLs too (fetch failures echo the request).
      error: error ? redactTraceError(String(error)).slice(0, 200) : null,
    });
    fs.appendFileSync(path.join(dir, `${day}.jsonl`), `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Contract: a broken store must never break the command.
  }
}

// Same redaction rules as experience's redactError, kept local so the CLI's
// hot path does not import the store module for one regex.
function redactTraceError(text) {
  return String(text)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b[A-Za-z0-9_-]*(?:token|secret|password|passwd|session|auth|key|sig|credential|cookie)[A-Za-z0-9_-]*\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]')
    .replace(/([?&][^=&#\s]*(?:token|secret|password|passwd|session|auth|key|sig|credential)[^=&#\s]*=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/\/\/[^/@\s]+@/g, '//[REDACTED]@');
}

// Trace attribution needs the CLI context (which verb, which session, which
// host), not the wire payload: the payload's session is always absent and its
// host is only a fallback.
function traceContext(traceCtx, payload) {
  return {
    cmd: traceCtx.cmd || null,
    session: traceCtx.session !== undefined ? traceCtx.session : (payload && payload.session) || undefined,
    host: traceCtx.host || undefined,
    arg: traceCtx.arg !== undefined ? traceCtx.arg : describeCommandArg(payload),
  };
}

// The trace keys on the argument that actually identifies the gesture
// (key name, selector, text), not on the whole payload.
function describeCommandArg(payload) {
  const pick = ['key', 'selector', 'text', 'code', 'url'];
  for (const field of pick) {
    if (payload[field] !== undefined && payload[field] !== null) return payload[field];
  }
  return null;
}

/**
 * `hostOverride` is the host the command actually landed on, for the re-advise
 * that runs after sendCommand learns the real URL. Without it the pre-run pass
 * can only guess — and on a freshly selected tab it guesses nothing at all.
 */
function maybeAdvisePre(action, arg, options, hostOverride) {
  try {
    if (!options || options.quiet || process.env.TT_BRIDGE_EXPERIENCE_SILENT === '1') return;
    const root = defaultExperienceDir();
    const session = options.session || process.env.TT_BRIDGE_SESSION;
    let host = hostOverride || options.host;
    if (!host && (action === 'navigate' || action === 'open') && arg) {
      try { host = new URL(arg).host; } catch {}
    }
    if (!host) {
      host = getCachedHost(session);
    }
    if (!host) return;
    const adviceResult = advise(root, { host, action, arg, quiet: options.quiet, session });
    if (adviceResult && adviceResult.line) {
      process.stderr.write(`${adviceResult.line}\n`);
    }
  } catch {
    // Contract D: 任何注入逻辑异常必须被吞掉，绝不影响命令执行与退出码。
  }
}

function maybeAdvisePost(action, arg, error, options) {
  try {
    if (options.quiet || process.env.TT_BRIDGE_EXPERIENCE_SILENT === '1') return;
    const root = defaultExperienceDir();
    const session = options.session || process.env.TT_BRIDGE_SESSION;
    let host = options.host || getCachedHost(session);
    const adviceResult = advise(root, { host, action, arg, error, quiet: options.quiet, session, failed: true });
    if (adviceResult && adviceResult.line) {
      process.stderr.write(`${adviceResult.line}\n`);
    }
  } catch {
    // Contract D: 任何注入逻辑异常必须被吞掉，绝不影响命令执行与退出码。
  }
}

// Where a result says it landed: exec/navigate hoist the URL to the top level,
// tab ops only carry it on data.url. Anything unparsable counts as unknown.
function resultHost(result) {
  try {
    const raw = (result && (result.url || (result.data && result.data.url))) || null;
    if (!raw) return null;
    const host = new URL(String(raw)).host;
    return host ? host.toLowerCase() : null;
  } catch {
    return null;
  }
}

// The host the pre-run advise saw, resolved exactly like maybeAdvisePre does.
// Read before the request: the cache is rewritten from the response, so
// recomputing afterwards would make every command look like a host change.
function preAdviseHost(traceCtx) {
  try {
    const explicit = traceCtx && traceCtx.host;
    if (explicit) return String(explicit).trim().toLowerCase();
    const action = traceCtx && traceCtx.cmd;
    if ((action === 'open' || action === 'navigate') && traceCtx.arg) {
      const host = new URL(String(traceCtx.arg)).host;
      if (host) return host.toLowerCase();
    }
    const cached = getCachedHost((traceCtx && traceCtx.session) || process.env.TT_BRIDGE_SESSION);
    return cached ? cached.toLowerCase() : null;
  } catch {
    return null;
  }
}

// Every `tt-bridge` invocation is its own process, so this only guards against
// a nudge repeating inside one process; the cross-process guard is the
// dedupe store, which is what actually keeps the file from nagging.
const HARVEST_NUDGE_THRESHOLD = 8;

/**
 * Struggle detection on success: N commands deep on one host with nothing to
 * show for it. Recording the experience is the agent's job — the CLI cannot
 * write a meaningful body without the reasoning that only the agent has — so
 * the most this can do is notice the moment and say which verb to run.
 *
 * Two shapes, because the fix differs:
 *   - never acknowledged: capture what was just learned
 *   - acknowledged but still flailing: the entry is probably stale, update it
 */
function maybeHarvestNudge(options, url) {
  try {
    if (!options || options.quiet || process.env.TT_BRIDGE_EXPERIENCE_SILENT === '1') return;
    const root = defaultExperienceDir();
    const session = options.session || process.env.TT_BRIDGE_SESSION;
    const host = getCachedHost(session);
    if (!host) return;

    const state = harvestTraceState(root, session, host);
    if (state.sinceAck < HARVEST_NUDGE_THRESHOLD) return;

    const sessionId = session || '';
    let line;
    if (state.acked) {
      const id = state.ackId || '<id>';
      const key = `harvest::ack::${host}::${id}`;
      if (hasSeen(sessionId, key)) return;
      markSeen(sessionId, key);
      line = `[exp] 你已查阅 ${id} 但仍进行了大量调试；若发现新坑点请用: tt-bridge experience update ${id}`;
    } else {
      const key = `harvest::nack::${host}`;
      if (hasSeen(sessionId, key)) return;
      markSeen(sessionId, key);
      // The intent slug is the agent's call: deriving one here would either
      // collide across pages or encode a URL into a filename.
      line = `[exp] 检测到你在 ${host} 已探索 ${state.sinceAck} 步且无现成经验；跑通后请执行: tt-bridge experience capture --url ${url || `https://${host}/`} --intent <slug>`;
    }
    process.stderr.write(`${line}\n`);
  } catch {
    // Contract D: 任何注入逻辑异常必须被吞掉，绝不影响命令执行与退出码。
  }
}

async function sendCommand(command, autoStart = true, traceCtx = {}) {
  if (autoStart) {
    await ensureDaemonRunning();
  }

  await ensureResolvedPort();

  const payload = {
    id: command.id || randomUUID(),
    ...command,
  };
  // Snapshot before the request: the response rewrites the host cache below, so
  // reading it afterwards would always report "no change".
  const preHost = preAdviseHost(traceCtx);
  let result;
  try {
    const response_ = await fetchJson('/command', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, 35000);
    result = response_.payload;
    if (!response_.response.ok || result.ok === false) {
      throw new Error(result.error || `Command failed with HTTP ${response_.response.status}`);
    }
  } catch (error) {
    appendTrace(payload.action, describeCommandArg(payload), false,
      error.message || String(error), traceContext(traceCtx, payload));
    throw error;
  }
  // exec/navigate hoist the landed URL to the top level; tab ops only put it on
  // data.url. Either way it names the site this command actually ran against.
  const landedUrl = (result && (result.url || (result.data && result.data.url))) || null;
  const actualHost = resultHost(result);
  if (actualHost) {
    setCachedHost(traceCtx.session || process.env.TT_BRIDGE_SESSION, actualHost);
  }
  // The pre-run pass had to guess the site: no cache at all on a freshly
  // selected tab, or the previous site right after a switch. Now that the
  // response names the real host, replay the advice against it. Entry gestures
  // (tab select/new/pin) carry no pending action, so they advise as `open` on
  // the landed URL; every other command reuses its own action + argument.
  if (actualHost && actualHost !== preHost) {
    try {
      const cmd = traceCtx.cmd || null;
      const isEntry = !cmd || cmd === 'open' || cmd === 'navigate';
      maybeAdvisePre(
        isEntry ? 'open' : cmd,
        isEntry ? landedUrl : traceCtx.arg,
        { quiet: Boolean(cliOptions && cliOptions.quiet), session: traceCtx.session },
        actualHost,
      );
    } catch {
      // Contract D: advice must never break the command.
    }
  }
  // Record after the host cache is refreshed, otherwise the first command that
  // learns the host is the one command that fails to attribute itself.
  appendTrace(payload.action, describeCommandArg(payload), true, null,
    traceContext(traceCtx, payload));
  // Struggle detection runs on the success path only: a failing command is
  // already covered by the failure-rate layer, and counting failures here
  // would nag about a site that is merely unreachable.
  const verb = traceCtx.cmd || null;
  if (verb && HARVEST_INTERACTION_CMDS.includes(verb)) {
    maybeHarvestNudge(
      { quiet: Boolean(cliOptions && cliOptions.quiet), session: traceCtx.session },
      (result && result.url) || null,
    );
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

function printWindowsList(payload) {
  if (!payload || !Array.isArray(payload.windows) || payload.windows.length === 0) {
    console.log('No windows reported' + (payload?.warnings?.length ? ` (${payload.warnings.join('; ')})` : ''));
    return;
  }

  console.log('  IDX  INST           PROFILE         WIN     FOCUS  STATE     TABS  ACTIVE TAB');
  for (const w of payload.windows) {
    const marker = w.target ? '→' : ' ';
    const idxStr = `[${w.index}]`.padEnd(5);
    const instStr = (w.instance.label + (w.instance.owner ? '*' : '')).slice(0, 14).padEnd(14);
    const profStr = (w.instance.profileName || '(unknown)').slice(0, 15).padEnd(15);
    const winStr = String(w.windowId).padEnd(7);
    const focusStr = (w.focused ? 'yes' : 'no').padEnd(6);
    const stateStr = (w.state || 'normal').slice(0, 9).padEnd(9);
    const tabsStr = String(w.tabCount).padEnd(5);
    const activeTabStr = w.activeTab ? (w.activeTab.title ? `${w.activeTab.title} - ${w.activeTab.url}` : w.activeTab.url) : '(none)';

    console.log(`${marker} ${idxStr} ${instStr} ${profStr} ${winStr} ${focusStr} ${stateStr} ${tabsStr} ${activeTabStr}`);
  }

  if (payload.warnings && payload.warnings.length) {
    console.log('\nWarnings:');
    for (const warn of payload.warnings) {
      console.log(`  - ${warn}`);
    }
  }
}

function printProfilesList(payload) {
  if (!payload || !Array.isArray(payload.profiles) || payload.profiles.length === 0) {
    console.log('No Chrome profiles found' + (payload?.source ? ` at ${payload.source}` : ''));
    return;
  }

  console.log('DIR          PROFILE NAME       EMAIL               INSTANCE        CONNECTED  WINDOWS');
  for (const p of payload.profiles) {
    const dirStr = p.dir.padEnd(12);
    // Chrome's default names are directory names, not aliases; DIR already shows them.
    const nameStr = (p.displayName || '(default name)').slice(0, 18).padEnd(18);
    const emailStr = (p.email || '-').slice(0, 19).padEnd(19);
    const instStr = (p.instanceLabel || '-').slice(0, 15).padEnd(15);
    const connStr = (p.connected ? 'yes' : 'no').padEnd(10);
    const winStr = p.connected ? String(p.windows) : '-';

    console.log(`${dirStr} ${nameStr} ${emailStr} ${instStr} ${connStr} ${winStr}`);
  }
}

const MASKED_PREFIX_LENGTH = 6;

/**
 * Mask a cookie value for display: keep the first 6 chars + '***'.
 * Empty values stay empty; values of <= 6 chars become just '***'.
 * With showValues the raw value passes through untouched.
 */
function maskCookie(cookie, showValues) {
  const raw = typeof cookie.value === 'string' ? cookie.value : '';
  let value;
  let masked;
  if (showValues) {
    value = raw;
    masked = false;
  } else if (raw.length === 0) {
    value = '';
    masked = false;
  } else if (raw.length <= MASKED_PREFIX_LENGTH) {
    value = '***';
    masked = true;
  } else {
    value = `${raw.slice(0, MASKED_PREFIX_LENGTH)}***`;
    masked = true;
  }
  return { ...cookie, value, masked };
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

function parseViewport(value) {
  const match = /^(\d+)\s*[xX,]\s*(\d+)$/.exec(String(value).trim());
  if (!match) {
    throw new Error(`Invalid viewport "${value}", expected WxH (e.g. 390x844)`);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function sendEmulate(target, options) {
  return await sendCommand({
    action: 'emulate',
    ...target,
    workspace: options.workspace,
    tabId: options.tabId,
  });
}

function experienceRoot() {
  return defaultExperienceDir(process.env);
}

// Reading or running an entry is the agent acting on the advice, so the
// similar stage must stop nagging about it for this session. Failure to record
// the ack only costs one repeated hint, so it never breaks the command.
function ackEntry(id, options) {
  try {
    const session = (options && options.session) || process.env.TT_BRIDGE_SESSION || PROCESS_SESSION_ID;
    markSeen(session, `ack::${id}`);
  } catch {}
}

function readTextFile(file, label) {
  try {
    return fs.readFileSync(path.resolve(file), 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${label} "${file}": ${error.message}`);
  }
}

function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function experienceThreshold(options) {
  return options.threshold ?? envPositiveInt('TT_BRIDGE_EXPERIENCE_MISS_THRESHOLD', DEFAULT_MISS_THRESHOLD);
}

// Usage errors (bad flag values) exit 2; internal failures stay 1.
function asUsageError(error) {
  if (error && error.exitCode === undefined) error.exitCode = 2;
  return error;
}

function experienceCaptureAfter(options) {
  return options.captureAfter ?? envPositiveInt('TT_BRIDGE_EXPERIENCE_CAPTURE_AFTER', DEFAULT_CAPTURE_AFTER);
}

function printExperienceHelp() {
  console.log(`tt-bridge experience — local, daemon-free site playbooks

Usage:
  tt-bridge experience advise --host <h> --action <a> [--arg <x>] [--force] [--json]
  tt-bridge experience begin --url <url> --intent <slug> [--session <id>] [--json]
  tt-bridge experience end --session <id> --assert <file> | --error <msg> [--errclass page|env] [--json]
  tt-bridge experience find <url> [--intent <slug>] [--all] [--json]
  tt-bridge experience show <id> [--json]
  tt-bridge experience list [--host <h>] [--kind <k>] [--status <s>] [--json]
  tt-bridge experience miss --url <url> --intent <slug> [--error <msg>] [--json]
  tt-bridge experience hit --url <url> --intent <slug> [--id <id>] [--json]
  tt-bridge experience capture --url <url> --intent <slug> --kind text|script|hybrid --description "<text>" [--body-file <md>] [--script-file <py>] [--tags a,b] [--json]
  tt-bridge experience finalize <id> [--body-file <md>] [--script-file <py>] [--kind <k>] [--verify-script] [--allow-script-exec] [--json]
  tt-bridge experience update <id> [--status <s>] [--description <text>] [--tags a,b] [--kind <k>] [--match <m>] [--body-file <md>] [--json]
  tt-bridge experience deprecate <id> [--reason <text>] [--json]
  tt-bridge experience run <id> [--url <url>] [--force] [--json] [-- <script args>]
  tt-bridge experience reindex [--json]
  tt-bridge experience validate [--json]
  tt-bridge experience ledger list|show <key>|prune --older-than <90d>|reset [--json]

Store: $TT_BRIDGE_EXPERIENCE_DIR or ~/.agents/skills/tt-bridge/experience
Attempts: env-class failures (daemon down, extension disconnected, timeouts) never
count as attempts; 2 consecutive page misses => candidate/stale; 3 real attempts
without an entry => auto-capture draft.
Exit codes: 0 hit, 1 page miss, 3 env miss, 2 usage error.`);
}

function printExperienceEntry(entry) {
  console.log(`${entry.id}  [${entry.status}] kind=${entry.kind} confidence=${entry.confidence}`);
  console.log(`url: ${entry.url} (match=${entry.match})`);
  if (entry.description) console.log(`description: ${entry.description}`);
  if (entry.tags && entry.tags.length) console.log(`tags: ${entry.tags.join(', ')}`);
  if (entry.script) console.log(`script: ${entry.script}`);
  console.log('');
  console.log(entry.body);
}

function printExperienceList(entries) {
  if (entries.length === 0) {
    console.log('No experience entries found');
    return;
  }
  for (const entry of entries) {
    console.log(`${entry.id}  [${entry.status}] ${entry.kind} ${entry.description || ''}`.trim());
  }
}

function printAttemptResult(result) {
  console.log(`${result.key}: ${result.result} — attempts=${result.attempts} misses=${result.misses} consecutive=${result.consecutiveMisses} state=${result.state || '-'}`);
  if (result.captureRequired) {
    console.log(`captureRequired: suggested id ${result.suggestedId} (kind ${result.recommendedKind})`);
    console.log(result.draftPath ? `draft created: ${result.draftPath}` : 'draft not created (--no-auto-capture)');
  }
  if (result.updateRequired) {
    console.log(`updateRequired: ${result.entryId} is stale — update the playbook`);
  }
}

function printValidation(result) {
  if (result.ok) {
    console.log(`OK: ${result.checked} entr${result.checked === 1 ? 'y' : 'ies'} valid`);
  } else {
    console.log(`FAILED: ${result.errors.length} entr${result.errors.length === 1 ? 'y' : 'ies'} with errors`);
    for (const item of result.errors) {
      console.log(`  ${item.id}`);
      for (const message of item.errors) console.log(`    - ${message}`);
    }
  }
  for (const item of result.warnings) {
    console.log(`  warning ${item.id}`);
    for (const message of item.warnings) console.log(`    - ${message}`);
  }
}

async function handleExperience(args, options) {
  const root = experienceRoot();
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printExperienceHelp();
    return 0;
  }

  switch (subcommand) {
    case 'advise': {
      const host = options.host || rest[0];
      const action = options.action || (options.host ? rest[0] : rest[1]);
      const arg = options.arg !== undefined ? options.arg : (options.host ? rest[1] : rest[2]);
      if (!host) {
        console.error('experience advise requires --host <host>');
        return 2;
      }
      if (!action) {
        console.error('experience advise requires --action <action>');
        return 2;
      }
      // Default mirrors the hot path (dedupe applies); --force bypasses it so
      // "why did I not see a hint" can be answered without waiting for a new
      // session.
      const adviceResult = advise(root, {
        host,
        action,
        arg,
        quiet: options.quiet,
        session: options.session,
        ignoreSession: Boolean(options.force),
      });
      if (options.json) {
        if (!adviceResult) {
          printMaybeJson({ ok: true, advice: null }, options);
        } else {
          printMaybeJson({
            ok: true,
            line: adviceResult.line,
            entryId: adviceResult.entryId,
            kind: adviceResult.kind,
            reason: adviceResult.reason,
            lastVerified: adviceResult.lastVerified || null,
            host,
            action,
            arg: arg || null,
          }, options);
        }
        return 0;
      }
      if (adviceResult) {
        console.log(adviceResult.line);
      }
      return 0;
    }

    case 'begin': {
      const url = rest[0] || options.url;
      const intent = options.intent || rest[1];
      if (!url) {
        console.error('experience begin requires --url <url>');
        return 2;
      }
      if (!intent) {
        console.error('experience begin requires --intent <slug>');
        return 2;
      }
      let result;
      try {
        result = beginEpisode(root, {
          url,
          intent,
          session: options.session,
        });
      } catch (err) {
        if (err.exitCode === 2) {
          console.error(err.message);
          return 2;
        }
        throw err;
      }
      if (options.json) {
        printMaybeJson(result, options);
        return 0;
      }
      console.log(`Started episode ${result.session} for ${result.intent} (${result.url})`);
      console.log(`state: ${result.stateFile}`);
      return 0;
    }

    case 'end': {
      const session = options.session || rest[0];
      if (!session) {
        console.error('experience end requires --session <id>');
        return 2;
      }
      const assertFile = options.assert || (options.session ? rest[0] : rest[1]);
      if (!assertFile && options.error === undefined) {
        console.error('experience end requires --assert <file> or --error <msg>');
        return 2;
      }
      let result;
      try {
        result = endEpisode(root, {
          session,
          assert: assertFile,
          error: options.error,
          threshold: asUsageError(() => experienceThreshold(options))(),
          captureAfter: asUsageError(() => experienceCaptureAfter(options))(),
          autoCapture: options.autoCapture,
          errclass: options.errclass,
        });
      } catch (err) {
        if (err.exitCode === 2) {
          console.error(err.message);
          return 2;
        }
        throw err;
      }
      if (options.json) {
        printMaybeJson(result, options);
      } else {
        console.log(`Episode ${result.session}: ${result.result} (${result.ledgerKey})`);
        if (result.record) {
          printAttemptResult({
            key: result.ledgerKey,
            result: result.result,
            attempts: result.record.attempts,
            misses: result.record.misses,
            consecutiveMisses: result.record.consecutiveMisses,
            state: result.record.state,
            captureRequired: result.captureRequired,
            suggestedId: `${result.record.host}/${result.intent}`,
            recommendedKind: Number(result.record.misses || 0) >= 2 ? 'text' : 'script',
            // Without this the line below claims "draft not created" even when
            // auto-capture did write one.
            draftPath: result.draftPath || null,
            draftError: result.draftError || null,
          });
        }
      }
      return result.result === 'hit' ? 0 : (result.errclass === 'env' ? 3 : 1);
    }

    case 'find': {
      const url = rest[0] || options.url;
      if (!url) throw new Error('experience find requires a URL');
      const entries = findEntries(root, url, { intent: options.intent, all: options.all });
      if (options.json) {
        printMaybeJson(entries.map(summarizeEntry), options);
        return 0;
      }
      if (entries.length === 0) {
        console.log(`No experience entries match ${url}`);
        return 0;
      }
      for (const entry of entries) {
        console.log(`${entry.id}  [${entry.status}] ${entry.kind} score=${entry.score} ${entry.description || ''}`.trim());
      }
      return 0;
    }

    case 'show': {
      const id = rest[0];
      if (!id) throw new Error('experience show requires an entry id');
      const entry = readEntry(entryFile(root, id));
      // Reading an entry is the acknowledgement gesture the harvest nudge
      // looks for, and the trace is how a later process finds out it happened.
      appendTrace('show', id, true, null, { cmd: 'show', session: options.session, host: entry.host });
      ackEntry(entry.id, options);
      if (options.json) {
        printMaybeJson(entry, options);
        return 0;
      }
      printExperienceEntry(entry);
      return 0;
    }

    case 'list': {
      const entries = listEntries(root, {
        host: options.host ? String(options.host).toLowerCase() : undefined,
        kind: options.kind,
        status: options.status,
      });
      if (options.json) {
        printMaybeJson(entries.map(summarizeEntry), options);
        return 0;
      }
      printExperienceList(entries);
      return 0;
    }

    case 'miss':
    case 'hit': {
      const url = rest[0] || options.url;
      if (!url) throw new Error(`experience ${subcommand} requires --url <url>`);
      if (!options.intent) throw new Error(`experience ${subcommand} requires --intent <slug>`);
      const result = recordAttempt(root, {
        url,
        intent: options.intent,
        result: subcommand,
        error: subcommand === 'miss' ? options.error : undefined,
        id: subcommand === 'hit' ? options.id : undefined,
        threshold: experienceThreshold(options),
        captureAfter: experienceCaptureAfter(options),
        autoCapture: options.autoCapture,
      });
      if (options.json) {
        printMaybeJson(result, options);
        return 0;
      }
      printAttemptResult(result);
      return 0;
    }

    case 'capture': {
      const url = rest[0] || options.url;
      if (!url) throw new Error('experience capture requires --url <url>');
      if (!options.intent) throw new Error('experience capture requires --intent <slug>');
      if (!options.kind) throw new Error('experience capture requires --kind text|script|hybrid');
      const body = options.bodyFile ? readTextFile(options.bodyFile, 'body file') : undefined;
      const entry = createDraft(root, {
        url,
        intent: options.intent,
        kind: options.kind,
        description: options.description || '',
        tags: options.tags,
        body,
        scriptFile: options.scriptFile,
        source: 'manual',
        match: options.match || 'prefix',
      });
      if (options.json) {
        printMaybeJson(entry, options);
        return 0;
      }
      console.log(`Created draft ${entry.id} at ${entry.file}`);
      return 0;
    }

    case 'finalize': {
      const id = rest[0];
      if (!id) throw new Error('experience finalize requires an entry id');
      const body = options.bodyFile ? readTextFile(options.bodyFile, 'body file') : undefined;
      const entry = finalizeEntry(root, id, {
        body,
        scriptFile: options.scriptFile,
        kind: options.kind,
        verifyScript: options.verifyScript,
        allowScriptExec: options.allowScriptExec,
        url: options.url,
      });
      if (options.json) {
        printMaybeJson(entry, options);
        return 0;
      }
      console.log(`Finalized ${entry.id} [${entry.status}]${entry.script ? ` script=${entry.script}` : ''}`);
      return 0;
    }

    case 'update': {
      const id = rest[0];
      if (!id) throw new Error('experience update requires an entry id');
      const patch = {};
      if (options.status !== undefined) patch.status = options.status;
      if (options.description !== undefined) patch.description = options.description;
      if (options.tags !== undefined) patch.tags = options.tags;
      if (options.kind !== undefined) patch.kind = options.kind;
      if (options.match !== undefined) patch.match = options.match;
      if (options.bodyFile) patch.body = readTextFile(options.bodyFile, 'body file');
      if (Object.keys(patch).length === 0) {
        throw new Error('experience update needs at least one of --status, --description, --tags, --kind, --match, --body-file');
      }
      const entry = updateEntry(root, id, patch);
      if (options.json) {
        printMaybeJson(entry, options);
        return 0;
      }
      console.log(`Updated ${entry.id} [${entry.status}]`);
      return 0;
    }

    case 'deprecate': {
      const id = rest[0];
      if (!id) throw new Error('experience deprecate requires an entry id');
      const entry = deprecateEntry(root, id, { reason: options.reason });
      if (options.json) {
        printMaybeJson(entry, options);
        return 0;
      }
      console.log(`Deprecated ${entry.id}${options.reason ? `: ${options.reason}` : ''}`);
      return 0;
    }

    case 'run': {
      const id = rest[0];
      if (!id) throw new Error('experience run requires an entry id');
      const result = runEntry(root, id, { url: options.url, args: options.passthrough, force: options.force });
      // Same acknowledgement meaning as `show`, but keyed on the entry's own
      // host: running an entry for another site must not reset this one.
      try {
        appendTrace('run', id, result.ok !== false, null, {
          cmd: 'run',
          session: options.session,
          host: readEntry(entryFile(root, id)).host,
        });
      } catch {}
      if (result.ok) ackEntry(result.entryId || id, options);
      if (options.json) {
        printMaybeJson(result, options);
      } else {
        if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
        if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
        if (result.error) console.error(result.error);
      }
      return result.exitCode;
    }

    case 'reindex': {
      const index = rebuildIndex(root);
      const indexPath = path.join(root, 'index.json');
      if (options.json) {
        printMaybeJson({ ok: true, count: index.count, indexPath, index }, options);
        return 0;
      }
      console.log(`Indexed ${index.count} entr${index.count === 1 ? 'y' : 'ies'} at ${indexPath}`);
      return 0;
    }

    case 'validate': {
      const result = validateAll(root);
      if (options.json) {
        printMaybeJson(result, options);
      } else {
        printValidation(result);
      }
      return result.ok ? 0 : 1;
    }

    case 'ledger': {
      const action = rest[0] || 'list';
      if (action === 'list') {
        const rows = ledgerList(root);
        if (options.json) {
          printMaybeJson(rows, options);
          return 0;
        }
        if (rows.length === 0) {
          console.log('Ledger is empty');
          return 0;
        }
        for (const row of rows) {
          console.log(`${row.key}  attempts=${row.attempts || 0} misses=${row.misses || 0} consecutive=${row.consecutiveMisses || 0} state=${row.state || '-'} entry=${row.entryId || '-'}`);
        }
        return 0;
      }
      if (action === 'show') {
        const key = rest[1] || options.intent;
        if (!key) throw new Error('experience ledger show requires a key (host|intent)');
        const record = ledgerShow(root, key);
        if (options.json) {
          printMaybeJson(record, options);
          return 0;
        }
        console.log(JSON.stringify(record, null, 2));
        return 0;
      }
      if (action === 'prune') {
        const result = pruneLedger(root, { olderThan: options.olderThan || '90d' });
        if (options.json) {
          printMaybeJson(result, options);
          return 0;
        }
        console.log(`Pruned ${result.removed} record(s); ${result.remaining} remaining`);
        return 0;
      }
      if (action === 'reset') {
        const result = resetLedger(root);
        if (options.json) {
          printMaybeJson(result, options);
          return 0;
        }
        console.log('Ledger reset');
        return 0;
      }
      const err = new Error(`Unknown experience ledger command: ${action}`);
      err.exitCode = 2;
      throw err;
    }

    default: {
      const err = new Error(`Unknown experience command: ${subcommand}`);
      err.exitCode = 2;
      throw err;
    }
  }
}

async function main() {
  const { options, rest } = parseArgs(process.argv.slice(2));
  cliOptions = options || {};
  if (rest.length === 0 || rest[0] === 'help' || rest[0] === '--help' || rest[0] === '-h') {
    printHelp();
    return;
  }

  const [command, ...args] = rest;

  // Local experience store — works even when the daemon is down.
  if (command === 'experience') {
    let code;
    try {
      code = await handleExperience(args, options);
    } catch (error) {
      // A stray throw must not surface as the generic exit 1: everything under
      // `experience` is either a usage error (2) or an env/ page outcome.
      console.error(error && error.message ? error.message : String(error));
      code = error && error.exitCode ? error.exitCode : 1;
    }
    if (typeof code === 'number') process.exitCode = code;
    return;
  }

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

  if (command === 'instance') {
    const subcommand = args[0];
    if (subcommand === 'list' || subcommand === undefined || subcommand === 'status') {
      const { payload } = await fetchJson('/status');
      printMaybeJson(payload, options);
      return;
    }
    if (subcommand === 'use') {
      const label = args[1];
      if (!label) {
        throw new Error('instance use requires a label — see "tt-bridge instance list"');
      }
      const { payload } = await fetchJson('/instance', {
        method: 'POST',
        body: JSON.stringify({ label, force: options.force === true }),
      });
      printMaybeJson(payload, options);
      return;
    }
    if (subcommand === 'clear') {
      const { payload } = await fetchJson('/instance', {
        method: 'POST',
        body: JSON.stringify({ clear: true }),
      });
      printMaybeJson(payload, options);
      return;
    }
    if (subcommand === 'rename') {
      const newLabel = args[1];
      if (!newLabel) {
        throw new Error('instance rename requires the new label');
      }
      const result = await sendCommand({ action: 'instance', newLabel });
      printMaybeJson(result.data, options);
      return;
    }
    throw new Error(`Unknown instance command: ${subcommand}`);
  }

  if (command === 'window' || command === 'windows') {
    const subcommand = args[0];
    if (!subcommand || subcommand === 'list') {
      await ensureDaemonRunning();
      await ensureResolvedPort();
      const { response, payload } = await fetchJson('/windows');
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `Failed to fetch windows (${response.status})`);
      }
      if (options.json) {
        printMaybeJson(payload, options);
      } else {
        printWindowsList(payload);
      }
      return;
    }

    if (subcommand === 'use') {
      const target = args[1];
      if (!target) {
        throw new Error('window use requires <index|label:windowId> (e.g. "tt-bridge window use 0" or "tt-bridge window use chrome-ab12:91")');
      }
      await ensureDaemonRunning();
      await ensureResolvedPort();
      const { response, payload } = await fetchJson('/window', {
        method: 'POST',
        body: JSON.stringify({ target, focus: options.focus === true, force: options.force === true }),
      });
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || 'Failed to switch window');
      }
      if (options.json) {
        printMaybeJson(payload, options);
      } else {
        const t = payload.target;
        const profStr = t?.instance?.profileName ? ` (${t.instance.profileName})` : '';
        console.log(`Target switched to window ${t?.windowId ?? target} on instance "${t?.instance?.label || '(unknown)'}"${profStr}${options.focus ? ' [focus requested]' : ''}`);
      }
      return;
    }

    if (subcommand === 'focus') {
      const target = args[1];
      if (!target) {
        throw new Error('window focus requires <index|label:windowId>');
      }
      await ensureDaemonRunning();
      await ensureResolvedPort();
      const { response, payload } = await fetchJson('/window', {
        method: 'POST',
        body: JSON.stringify({ target, focus: true }),
      });
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || 'Failed to focus window');
      }
      if (options.json) {
        printMaybeJson(payload, options);
      } else {
        const t = payload.target;
        const profStr = t?.instance?.profileName ? ` (${t.instance.profileName})` : '';
        console.log(`Focused window ${t?.windowId ?? target} on instance "${t?.instance?.label || '(unknown)'}"${profStr}`);
      }
      return;
    }

    if (subcommand === 'status') {
      await ensureDaemonRunning();
      await ensureResolvedPort();
      const { response, payload } = await fetchJson('/windows');
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || 'Failed to get window status');
      }
      if (options.json) {
        printMaybeJson(payload, options);
        return;
      }
      const targetWin = payload.windows?.find((w) => w.target);
      if (!targetWin) {
        console.log(`No active target window found. Target instance: ${payload.targetInstance || '(none)'}`);
        if (payload.warnings?.length) {
          console.log(`Warnings: ${payload.warnings.join('; ')}`);
        }
        return;
      }
      console.log('Target Window:');
      console.log(`  Instance:     ${targetWin.instance.label}${targetWin.instance.owner ? '*' : ''} (${targetWin.instance.profileName || 'unknown profile'})`);
      console.log(`  Window ID:    ${targetWin.windowId} (state: ${targetWin.state}, focused: ${targetWin.focused ? 'yes' : 'no'})`);
      console.log(`  Tabs:         ${targetWin.tabCount}`);
      console.log(`  Active Tab:   ${targetWin.activeTab ? `${targetWin.activeTab.title || '(untitled)'} - ${targetWin.activeTab.url}` : '(none)'}`);
      console.log(`  Selected:     ${targetWin.selected ? 'yes' : 'no'}`);
      return;
    }

    throw new Error(`Unknown window command: ${subcommand}`);
  }

  if (command === 'profile' || command === 'profiles') {
    const subcommand = args[0];
    if (!subcommand || subcommand === 'list') {
      await ensureDaemonRunning();
      await ensureResolvedPort();
      const { response, payload } = await fetchJson('/profiles');
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || 'Failed to list profiles');
      }
      if (options.json) {
        printMaybeJson(payload, options);
      } else {
        printProfilesList(payload);
      }
      return;
    }
    throw new Error(`Unknown profile command: ${subcommand}`);
  }

  if (command === 'reload') {
    await ensureDaemonRunning();
    await ensureResolvedPort();
    const { response, payload } = await fetchJson('/reload', {
      method: 'POST',
      body: JSON.stringify({
        all: options.all === true,
        instance: options.instance,
      }),
    });
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || 'Failed to reload extension');
    }
    if (options.json) {
      printMaybeJson(payload, options);
    } else {
      const list = payload.instances || [];
      if (list.length === 0) {
        console.log(payload.message || 'No extension instances reloaded');
      } else {
        const summary = list.map((i) => `${i.label}${i.ok ? '' : ` (failed: ${i.error})`}`).join(', ');
        console.log(`Reloaded ${list.length} extension instance(s): ${summary}`);
      }
    }
    return;
  }

  if (command === 'open') {
    const url = args[0];
    if (!url) {
      throw new Error('Missing URL');
    }
    maybeAdvisePre('open', url, options);
    let result;
    try {
      result = await sendCommand({
        action: 'navigate',
        url,
        workspace: options.workspace,
        tabId: options.tabId,
      }, true, { cmd: 'open', session: options.session, host: options.host, arg: url });
    } catch (error) {
      maybeAdvisePost('open', url, error.message, options);
      throw error;
    }
    printMaybeJson(result.data, options);
    return;
  }

  if (command === 'eval') {
    const expression = args[0];
    if (!expression) {
      throw new Error('Missing JavaScript expression');
    }
    maybeAdvisePre('eval', expression, options);
    let result;
    try {
      result = await sendCommand({
        action: 'exec',
        code: expression,
        workspace: options.workspace,
        tabId: options.tabId,
      }, true, { cmd: 'eval', session: options.session, host: options.host, arg: expression });
    } catch (error) {
      maybeAdvisePost('eval', expression, error.message, options);
      throw error;
    }
    console.log(JSON.stringify(result.data));
    return;
  }

  if (command === 'click') {
    const selector = args[0];
    if (!selector) {
      throw new Error('Missing selector');
    }
    maybeAdvisePre('click', selector, options);
    let result;
    try {
      result = await sendCommand({
        action: 'exec',
        code: buildClickExpression(selector),
        workspace: options.workspace,
        tabId: options.tabId,
      }, true, { cmd: 'click', session: options.session, host: options.host, arg: selector });
    } catch (error) {
      maybeAdvisePost('click', selector, error.message, options);
      throw error;
    }
    printMaybeJson(result.data, options);
    return;
  }

  if (command === 'type') {
    const text = args[0];
    if (!text) {
      throw new Error('Missing text');
    }
    maybeAdvisePre('input', text, options);
    let result;
    try {
      result = await sendCommand({
        action: 'input',
        text,
        workspace: options.workspace,
        tabId: options.tabId,
      }, true, { cmd: 'input', session: options.session, host: options.host, arg: text });
    } catch (error) {
      maybeAdvisePost('input', text, error.message, options);
      throw error;
    }
    printMaybeJson(result.data, options);
    return;
  }

  if (command === 'focus') {
    const selector = args[0];
    if (!selector) {
      throw new Error('Missing selector');
    }
    maybeAdvisePre('focus', selector, options);
    let result;
    try {
      result = await sendCommand({
        action: 'focus',
        selector,
        workspace: options.workspace,
        tabId: options.tabId,
      }, true, { cmd: 'focus', session: options.session, host: options.host, arg: selector });
    } catch (error) {
      maybeAdvisePost('focus', selector, error.message, options);
      throw error;
    }
    printMaybeJson(result.data, options);
    return;
  }

  if (command === 'key') {
    const key = args[0];
    if (!key) {
      throw new Error('Missing key name');
    }
    maybeAdvisePre('key', key, options);
    let result;
    try {
      result = await sendCommand({
        action: 'key',
        key,
        workspace: options.workspace,
        tabId: options.tabId,
      }, true, { cmd: 'key', session: options.session, host: options.host, arg: key });
    } catch (error) {
      maybeAdvisePost('key', key, error.message, options);
      throw error;
    }
    printMaybeJson(result.data, options);
    return;
  }

  if (command === 'emulate') {
    const first = args[0];
    if (!first) {
      throw new Error('Missing device preset, WIDTH HEIGHT, or reset');
    }

    if (first === 'reset') {
      const result = await sendEmulate({ reset: true }, options);
      printMaybeJson(result.data, options);
      return;
    }

    if (/^\d+$/.test(first)) {
      const width = Number(first);
      const height = Number(args[1]);
      if (!args[1] || Number.isNaN(height)) {
        throw new Error('emulate WIDTH HEIGHT requires numeric width and height');
      }
      const target = { width, height };
      if (options.dpr !== undefined) target.deviceScaleFactor = options.dpr;
      if (options.mobile) target.mobile = true;
      if (options.touch !== undefined) target.touch = options.touch;
      if (options.userAgent !== undefined) target.userAgent = options.userAgent;
      const result = await sendEmulate(target, options);
      printMaybeJson(result.data, options);
      return;
    }

    const target = { device: first };
    if (options.dpr !== undefined) target.deviceScaleFactor = options.dpr;
    if (options.mobile) target.mobile = true;
    if (options.touch !== undefined) target.touch = options.touch;
    if (options.userAgent !== undefined) target.userAgent = options.userAgent;
    const result = await sendEmulate(target, options);
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
      }, true, { session: options.session });
      printMaybeJson(result.data, options);
      return;
    }

    const subcommand = args[0];
    if (subcommand === 'pin') {
      const index = args[1] !== undefined && /^\d+$/.test(args[1]) ? Number(args[1]) : undefined;
      const result = await sendCommand({
        action: 'tabs',
        op: 'pin',
        tabId: options.tabId,
        index,
        workspace: options.workspace,
      }, true, { session: options.session });
      printMaybeJson(result.data, options);
      return;
    }
    if (subcommand === 'unpin') {
      const result = await sendCommand({
        action: 'tabs',
        op: 'unpin',
        workspace: options.workspace,
      });
      printMaybeJson(result.data, options);
      return;
    }
    if (subcommand === 'status') {
      const result = await sendCommand({
        action: 'tabs',
        op: 'pin-status',
        workspace: options.workspace,
      });
      printMaybeJson(result.data, options);
      return;
    }
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
        mute: options.mute || undefined,
        workspace: options.workspace,
      }, true, { session: options.session });
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
      }, true, { session: options.session });
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

    // Optional pre-capture emulation via --viewport / --device.
    let appliedEmulation = false;
    if (options.viewport) {
      const { width, height } = parseViewport(options.viewport);
      const target = { width, height };
      if (options.dpr !== undefined) target.deviceScaleFactor = options.dpr;
      if (options.mobile) target.mobile = true;
      if (options.userAgent !== undefined) target.userAgent = options.userAgent;
      await sendEmulate(target, options);
      appliedEmulation = true;
    } else if (options.device) {
      const target = { device: options.device };
      if (options.dpr !== undefined) target.deviceScaleFactor = options.dpr;
      if (options.userAgent !== undefined) target.userAgent = options.userAgent;
      await sendEmulate(target, options);
      appliedEmulation = true;
    }

    const result = await sendCommand({
      action: 'screenshot',
      workspace: options.workspace,
      tabId: options.tabId,
      format: options.format,
      quality: options.quality,
      fullPage: options.fullPage,
      mobile: options.mobile || Boolean(options.device),
      restoreWindow: options.restore || undefined,
    });

    // Restore desktop defaults after a one-off emulated capture unless --no-reset.
    if (appliedEmulation && !options.noReset) {
      await sendEmulate({ reset: true }, options);
    }

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

  if (command === 'cookies') {
    const result = await sendCommand({
      action: 'cookies',
      domain: options.domain,
      url: options.url,
    });
    const cookies = Array.isArray(result.data) ? result.data : [];
    const output = cookies.map((cookie) => maskCookie(cookie, options.showValues));
    if (options.json) {
      printMaybeJson(output, options);
      return;
    }
    if (!options.showValues) {
      console.log('# values masked by default; pass --show-values to print real values (live session credentials — do NOT paste into logs or model context)');
    }
    for (const cookie of output) {
      console.log(`${cookie.name} = ${cookie.value}  domain=${cookie.domain} path=${cookie.path} secure=${cookie.secure} httpOnly=${cookie.httpOnly} masked=${cookie.masked}`);
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

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  let invokedPath;
  try {
    invokedPath = fs.realpathSync(process.argv[1]);
  } catch {
    invokedPath = path.resolve(process.argv[1]);
  }
  return fileURLToPath(import.meta.url) === invokedPath;
}

if (isDirectInvocation()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(typeof error.exitCode === 'number' ? error.exitCode : 1);
  });
}

export {
  maskCookie,
  parseArgs,
  MASKED_PREFIX_LENGTH,
  resolveDaemonLogPath,
  rotateDaemonLogIfNeeded,
  ensureDaemonRunning,
  traceArg,
};
