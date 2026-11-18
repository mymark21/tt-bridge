import { describe, expect, it } from 'vitest';
import { derivePopupMode } from './popup-mode';

const base = {
  servingEnabled: true,
  connectionState: 'waiting' as const,
  daemonDetected: false,
};

describe('derivePopupMode', () => {
  it('shows the error screen even when serving is disabled', () => {
    expect(derivePopupMode({ ...base, servingEnabled: false, connectionState: 'error' })).toBe('error');
  });

  it('shows the off screen whenever serving is disabled', () => {
    expect(derivePopupMode({ ...base, servingEnabled: false, connectionState: 'idle' })).toBe('off');
  });

  it('shows ready as soon as the socket is connected', () => {
    expect(derivePopupMode({ ...base, connectionState: 'connected', daemonDetected: true })).toBe('ready');
    expect(derivePopupMode({ ...base, connectionState: 'connected', daemonDetected: false })).toBe('ready');
  });

  it('shows the actionable waiting screen only when no daemon answered the scan', () => {
    expect(derivePopupMode({ ...base, connectionState: 'waiting', daemonDetected: false })).toBe('waiting');
  });

  it('keeps the connecting screen while a detected daemon is handshaking', () => {
    expect(derivePopupMode({ ...base, connectionState: 'waiting', daemonDetected: true })).toBe('connecting');
    expect(derivePopupMode({ ...base, connectionState: 'connecting', daemonDetected: true })).toBe('connecting');
    expect(derivePopupMode({ ...base, connectionState: 'idle', daemonDetected: false })).toBe('connecting');
  });
});
