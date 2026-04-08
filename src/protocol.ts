/**
 * Agent Browser Bridge protocol — shared types between daemon, extension, and CLI.
 *
 * 5 actions: exec, navigate, tabs, cookies, screenshot.
 * Everything else is just JS code sent via 'exec'.
 */

export type Action = 'exec' | 'navigate' | 'tabs' | 'cookies' | 'screenshot' | 'close-window' | 'sessions';

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
  /** Sub-operation for tabs: list, new, close, select */
  op?: 'list' | 'new' | 'close' | 'select';
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
export const WS_RECONNECT_BASE_DELAY = 2000;
/** Max reconnect delay (ms) */
export const WS_RECONNECT_MAX_DELAY = 60000;
/** Idle timeout before daemon auto-exits (ms) */
export const DAEMON_IDLE_TIMEOUT = 5 * 60 * 1000;
