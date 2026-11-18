export type PopupMode = 'off' | 'connecting' | 'waiting' | 'ready' | 'error';

export interface PopupModeState {
  servingEnabled: boolean;
  connectionState: 'idle' | 'connecting' | 'waiting' | 'connected' | 'error';
  /** True when a daemon answered the port scan; false means it is not running. */
  daemonDetected: boolean;
}

/**
 * Decide which popup screen to show.
 *
 * `waiting` with no daemon on any scanned port is a different situation from
 * "a daemon is there and we are handshaking": the human must ask the agent to
 * start the local service, so it gets its own actionable screen. Everything
 * else that is not off/ready/error keeps the original "connecting" screen.
 */
export function derivePopupMode(state: PopupModeState): PopupMode {
  if (state.connectionState === 'error') {
    return 'error';
  }
  if (!state.servingEnabled) {
    return 'off';
  }
  if (state.connectionState === 'connected') {
    return 'ready';
  }
  if (state.connectionState === 'waiting' && !state.daemonDetected) {
    return 'waiting';
  }
  return 'connecting';
}
