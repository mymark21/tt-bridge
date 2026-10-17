import { beforeEach, describe, expect, it, vi } from 'vitest';

import { scanDaemonPorts } from './daemon-discovery';

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    text: async () => JSON.stringify(payload),
  } as Response;
}

describe('daemon port discovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the default port when a TT daemon is already running there', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ok: true,
      running: true,
      host: '127.0.0.1',
      port: 19826,
      extensionConnected: false,
    })));

    const result = await scanDaemonPorts();

    expect(result.daemonPort).toBe(19826);
    expect(result.candidatePort).toBe(19826);
    expect(result.defaultPortBusy).toBe(false);
  });

  it('moves to the next candidate when the default port responds with non-bridge HTTP', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, service: 'other-http' }))
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED')));

    const result = await scanDaemonPorts();

    expect(result.daemonPort).toBeNull();
    expect(result.candidatePort).toBe(19827);
    expect(result.defaultPortBusy).toBe(true);
  });
});
