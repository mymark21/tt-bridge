/**
 * Agent Browser Bridge protocol — shared types between daemon, extension, and CLI.
 *
 * 5 actions: exec, navigate, tabs, cookies, screenshot.
 * Plus trusted-input actions: input (Input.insertText), focus (Input.dispatchMouseEvent),
 * key (Input.dispatchKeyEvent).
 * Plus device emulation: emulate (Emulation.* + Network.setUserAgentOverride).
 * Everything else is just JS code sent via 'exec'.
 */

export type Action = 'exec' | 'navigate' | 'tabs' | 'cookies' | 'screenshot' | 'close-window' | 'sessions' | 'input' | 'focus' | 'key' | 'emulate' | 'instance' | 'windows' | 'reload';

/** Sub-operation for the windows action. */
export type WindowOp = 'list' | 'use' | 'focus' | 'status';

/** One Chrome window of the extension's own profile, as seen by the daemon. */
export interface WindowSnapshot {
  windowId: number;
  focused: boolean;
  /** 'normal' | 'minimized' | 'maximized' | 'fullscreen' | 'locked-fullscreen' */
  state: string;
  /** 'normal' | 'popup' | 'panel' | 'app' | 'devtools' */
  type: string;
  incognito: boolean;
  tabCount: number;
  activeTab: { tabId: number | null; title: string; url: string } | null;
}

/** Profile identity of the extension instance; the daemon resolves the name. */
export interface ProfileDescriptor {
  /** user-editable instance label (chrome.storage.local) */
  label: string;
  /** signed-in account email, '' when unavailable */
  email: string;
  /** gaia id, '' when unavailable */
  gaiaId: string;
  /** profile display name: local override if set, else '' (daemon resolves it) */
  name: string;
}

export interface Command {
  /** Unique request ID */
  id: string;
  /** Action type */
  action: Action;
  /** Target tab ID (omit for active tab) */
  tabId?: number;
  /** JS code to evaluate in page context (exec action) */
  code?: string;
  /** Logical workspace for automation session reuse */
  workspace?: string;
  /** URL to navigate to (navigate action) */
  url?: string;
  /** Sub-operation for tabs: list, new, close, select, pin, unpin, pin-status */
  op?: 'list' | 'new' | 'close' | 'select' | 'pin' | 'unpin' | 'pin-status';
  /** Human-workspace tab new: open in background (default true) */
  background?: boolean;
  /** New label for the instance action (rename) */
  newLabel?: string;
  /** Tab index for tabs select/close */
  index?: number;
  /** Cookie domain filter */
  domain?: string;
  /** Screenshot format: png (default) or jpeg */
  format?: 'png' | 'jpeg';
  /** JPEG quality (0-100), only for jpeg format */
  quality?: number;
  /** Whether to capture full page (not just viewport) */
  fullPage?: boolean;
  /** Text to insert as trusted input (input action) */
  text?: string;
  /** CSS selector to focus/click (focus action) */
  selector?: string;
  /** Key name to press, e.g. Enter or Tab (key action) */
  key?: string;
  /** Reset viewport/UA/touch back to desktop defaults (emulate action) */
  reset?: boolean;
  /** Device preset name, e.g. iphone14, iphone14pro, pixel7, ipad (emulate action) */
  device?: string;
  /** Viewport width in CSS pixels (emulate action) */
  width?: number;
  /** Viewport height in CSS pixels (emulate action) */
  height?: number;
  /** Device scale factor / DPR (emulate action) */
  deviceScaleFactor?: number;
  /** Whether to emulate a mobile device (emulate action) */
  mobile?: boolean;
  /** User agent override; empty string clears the override (emulate action) */
  userAgent?: string;
  /** Whether to enable touch emulation (emulate action) */
  touch?: boolean;
  /** Sub-operation for the windows action */
  windowOp?: WindowOp;
  /** Target Chrome window id (windows action) */
  windowId?: number;
  /** windows use: also bring that OS window to the front (default false) */
  focusWindow?: boolean;
  /** tabs new: mute the newly created tab (default false) */
  mute?: boolean;
  /** screenshot: restore a minimized window to normal before capturing (human workspace only) */
  restoreWindow?: boolean;
}

export interface Result {
  /** Matching request ID */
  id: string;
  /** Whether the command succeeded */
  ok: boolean;
  /** Result data on success */
  data?: unknown;
  /** Error message on failure */
  error?: string;
  /** tab 上下文，供自动记账使用 */
  url?: string;
  title?: string;
}

/** Default daemon port */
export const DEFAULT_DAEMON_PORT = 19826;
export const MAX_DAEMON_PORT = 19835;
export const DAEMON_HOST = '127.0.0.1';

export function getDaemonWsUrl(port: number): string {
  return `ws://${DAEMON_HOST}:${port}/ext`;
}

export function getDaemonHttpUrl(port: number): string {
  return `http://${DAEMON_HOST}:${port}`;
}

/** Base reconnect delay for extension WebSocket (ms) */
export const WS_RECONNECT_BASE_DELAY = 500;
/** Max reconnect delay (ms) */
export const WS_RECONNECT_MAX_DELAY = 10000;

/**
 * Heartbeat cadence while the extension socket is open (ms).
 *
 * Chrome 116+ counts WebSocket message flow as service-worker activity, so a
 * ping beats the 30s idle kill that would otherwise drop the connection during
 * normal Serving. The daemon answers every ping with a `pong`.
 */
export const WS_HEARTBEAT_INTERVAL_MS = 20000;

/** Name of the periodic wake-up alarm (reconnect backstop). */
export const KEEPALIVE_ALARM_NAME = 'keepalive';
/**
 * Alarm period in minutes. 0.5 is Chrome's documented minimum: smaller values
 * (e.g. 0.25) are silently clamped, which is why this is a constant, not a
 * literal at the call site.
 */
export const KEEPALIVE_ALARM_PERIOD_MINUTES = 0.5;

/** Control frames between extension and daemon; they are not commands. */
export type BridgeControlMessage =
  | { type: 'ping'; ts: number }
  | { type: 'pong'; ts: number };

/** Idle timeout before daemon auto-exits (ms) */
export const DAEMON_IDLE_TIMEOUT = 5 * 60 * 1000;
