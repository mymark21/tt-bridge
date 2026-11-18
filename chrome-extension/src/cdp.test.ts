/**
 * Unit tests for cdp.ts failure logging: ensureAttached() must console.error
 * (with tabId + URL + raw Chrome message) on every failure path, must NOT log
 * on the happy path, and onDetach must log its reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener<T extends (...args: any[]) => void> = { addListener: (fn: T) => void };

function createChromeMock() {
  const detachListeners: Array<(source: { tabId?: number }, reason?: string) => void> = [];
  const chrome = {
    tabs: {
      get: vi.fn(async (tabId: number) => {
        if (tabId === 7) throw new Error('No tab with id: 7.');
        return { id: tabId, windowId: 1, url: 'https://example.com/page' };
      }),
      onRemoved: { addListener: vi.fn() } as Listener<(tabId: number) => void>,
      onUpdated: { addListener: vi.fn() } as Listener<(tabId: number, info: { url?: string }) => void>,
    },
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_target: unknown, method: string) => {
        if (method === 'Runtime.evaluate') return { result: { type: 'number', value: 1 } };
        return {};
      }),
      onDetach: {
        addListener: vi.fn((fn: (source: { tabId?: number }, reason?: string) => void) => {
          detachListeners.push(fn);
        }),
      },
    },
    runtime: {
      lastError: undefined as chrome.runtime.LastError | undefined,
    },
  };
  return { chrome, detachListeners };
}

describe('cdp ensureAttached failure logging', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('logs and rethrows the raw Chrome message when attach rejects', async () => {
    const { chrome } = createChromeMock();
    chrome.debugger.attach.mockRejectedValue(new Error('Cannot attach to this target'));
    chrome.runtime.lastError = { message: 'Cannot attach to this target' };
    vi.stubGlobal('chrome', chrome);

    const cdp = await import('./cdp');
    await expect(cdp.evaluate(2, '1+1')).rejects.toThrow('attach failed: Cannot attach to this target');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [prefix, context] = errorSpy.mock.calls[0] as [string, { tabId: number; url: string; message: string; lastError?: string }];
    expect(prefix).toContain('agent-browser-bridge');
    expect(context.tabId).toBe(2);
    expect(context.url).toBe('https://example.com/page');
    expect(context.message).toBe('Cannot attach to this target');
    expect(context.lastError).toBe('Cannot attach to this target');
  });

  it('logs the retry-after-detach failure when "Another debugger" retry fails', async () => {
    const { chrome } = createChromeMock();
    chrome.debugger.attach.mockRejectedValue(new Error('Another debugger is already attached'));
    vi.stubGlobal('chrome', chrome);

    const cdp = await import('./cdp');
    await expect(cdp.evaluate(3, '1+1')).rejects.toThrow('attach failed: Another debugger is already attached');

    // Initial failure + retry failure = two error lines, both with tabId and URL.
    expect(errorSpy).toHaveBeenCalledTimes(2);
    for (const call of errorSpy.mock.calls) {
      const context = call[1] as { tabId: number; url: string; message: string };
      expect(context.tabId).toBe(3);
      expect(context.url).toBe('https://example.com/page');
    }
    expect((errorSpy.mock.calls[1]![1] as { message: string }).message).toContain('retry after detach also failed');
  });

  it('logs when the tab lookup itself fails', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const cdp = await import('./cdp');
    await expect(cdp.evaluate(7, '1+1')).rejects.toThrow('Tab 7 no longer exists');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const context = errorSpy.mock.calls[0]![1] as { tabId: number; url: string; message: string };
    expect(context.tabId).toBe(7);
    expect(context.message).toBe('No tab with id: 7.');
  });

  it('logs when the URL is not debuggable', async () => {
    const { chrome } = createChromeMock();
    chrome.tabs.get.mockResolvedValue({ id: 5, windowId: 1, url: 'chrome://extensions' });
    vi.stubGlobal('chrome', chrome);

    const cdp = await import('./cdp');
    await expect(cdp.evaluate(5, '1+1')).rejects.toThrow(
      'Tab 5 is a restricted page (chrome://extensions). Switch to a normal page, or re-pin with "tt-bridge tab pin".',
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const context = errorSpy.mock.calls[0]![1] as { tabId: number; url: string; message: string };
    expect(context.tabId).toBe(5);
    expect(context.url).toBe('chrome://extensions');
    expect(context.message).toContain('restricted page');
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
  });

  it('rejects with browser/extension page error and does not call debugger.attach when tab is a chrome-extension:// page', async () => {
    const { chrome } = createChromeMock();
    chrome.tabs.get.mockResolvedValue({ id: 6, windowId: 1, url: 'chrome-extension://abc123xyz/popup.html' });
    vi.stubGlobal('chrome', chrome);

    const cdp = await import('./cdp');
    await expect(cdp.evaluate(6, '1+1')).rejects.toThrow(
      'Tab 6 is a restricted page (chrome-extension://abc123xyz/popup.html). Switch to a normal page, or re-pin with "tt-bridge tab pin".',
    );
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
  });

  it.each(['file:///etc/hosts', 'view-source:https://example.com', 'devtools://devtools/bundled/inspector.html'])(
    'refuses to attach to restricted scheme %s',
    async (url) => {
      const { chrome } = createChromeMock();
      chrome.tabs.get.mockResolvedValue({ id: 8, windowId: 1, url });
      vi.stubGlobal('chrome', chrome);

      const cdp = await import('./cdp');
      await expect(cdp.evaluate(8, '1+1')).rejects.toThrow('restricted page');
      expect(chrome.debugger.attach).not.toHaveBeenCalled();
    },
  );

  it('does not log on the happy path', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const cdp = await import('./cdp');
    await expect(cdp.evaluate(2, '1+1')).resolves.toBe(1);
    expect(errorSpy).not.toHaveBeenCalled();

    // Second call uses the attached cache — still no logs.
    await expect(cdp.evaluate(2, '2+2')).resolves.toBe(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs the detach reason via onDetach', async () => {
    const { chrome, detachListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const cdp = await import('./cdp');
    cdp.registerListeners();

    expect(detachListeners).toHaveLength(1);
    detachListeners[0]!({ tabId: 9 }, 'replaced_with_devtools');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [prefix, context] = errorSpy.mock.calls[0] as [string, { tabId: number; reason: string; hint?: string }];
    expect(prefix).toContain('agent-browser-bridge');
    expect(context.tabId).toBe(9);
    expect(context.reason).toBe('replaced_with_devtools');
    expect(context.hint).toContain('Cancel');
  });

  it('logs and rethrows when sendCommand fails after a successful attach', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const cdp = await import('./cdp');

    // Attach succeeds, then the actual command fails — the real-world JIN-profile shape.
    chrome.debugger.sendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'Runtime.enable') return {};
      throw new Error('Debugger is not attached to the tab with id: 42.');
    });

    await expect(cdp.evaluate(42, 'document.title')).rejects.toThrow(
      'Debugger is not attached to the tab with id: 42.',
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [prefix, context] = errorSpy.mock.calls[0] as [string, {
      tabId: number; url: string; method: string; message: string;
    }];
    expect(prefix).toContain('agent-browser-bridge');
    expect(context.tabId).toBe(42);
    expect(context.url).toBe('https://example.com/page');
    expect(context.method).toBe('Runtime.evaluate');
    expect(context.message).toContain('Debugger is not attached');
  });

  it('keeps the happy path of evaluate silent', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const cdp = await import('./cdp');

    await expect(cdp.evaluate(2, '1+1')).resolves.toBe(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('reports unknown URL in the log when the tab vanished before diagnostics', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const cdp = await import('./cdp');

    chrome.debugger.sendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'Runtime.enable') return {};
      throw new Error('Debugger is not attached to the tab with id: 8.');
    });
    // ensureAttached sees the tab, but it's gone by the time the diagnostic URL lookup runs.
    let tabsGetCalls = 0;
    chrome.tabs.get.mockImplementation(async () => {
      tabsGetCalls += 1;
      if (tabsGetCalls === 1) return { id: 8, windowId: 1, url: 'https://example.com/page' };
      throw new Error('No tab with id: 8.');
    });

    await expect(cdp.evaluate(8, 'document.title')).rejects.toThrow('Debugger is not attached');

    const context = errorSpy.mock.calls[0]![1] as { tabId: number; url: string; method: string };
    expect(context.tabId).toBe(8);
    expect(context.url).toBe('unknown');
    expect(context.method).toBe('Runtime.evaluate');
  });

  it('appends the canceled_by_user guidance when Chrome cancelled the session', async () => {
    const { chrome, detachListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const cdp = await import('./cdp');
    cdp.registerListeners();

    // Chrome cancels the banner session for this profile…
    detachListeners[0]!({ tabId: 9 }, 'canceled_by_user');
    // …and every subsequent command fails with "not attached".
    chrome.debugger.sendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'Runtime.enable') return {};
      throw new Error('Debugger is not attached to the tab with id: 9.');
    });

    await expect(cdp.evaluate(9, 'document.title')).rejects.toThrow(
      /Debugger is not attached to the tab with id: 9\. Chrome cancelled this extension's debugger session in this profile \(reason: canceled_by_user\) — re-add the extension in chrome:\/\/extensions for this profile/,
    );
  });

  it('uses a generic hint for an unknown detach reason', async () => {
    const { chrome, detachListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const cdp = await import('./cdp');
    cdp.registerListeners();

    detachListeners[0]!({ tabId: 9 }, 'target_closed');
    chrome.debugger.sendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'Runtime.enable') return {};
      throw new Error('Debugger is not attached to the tab with id: 9.');
    });

    const error = await cdp.evaluate(9, 'document.title').then(
      () => { throw new Error('expected evaluate to reject'); },
      (e: Error) => e,
    );
    expect(error.message).toContain('(last debugger detach reason: target_closed)');
    expect(error.message).not.toContain('canceled_by_user');
    expect(error.message).not.toContain('chrome://extensions');
  });

  it('leaves non-detach errors untouched', async () => {
    const { chrome, detachListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const cdp = await import('./cdp');
    cdp.registerListeners();

    detachListeners[0]!({ tabId: 9 }, 'canceled_by_user');
    chrome.debugger.sendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'Runtime.enable') return {};
      throw new Error('Some other CDP failure');
    });

    await expect(cdp.evaluate(9, 'x')).rejects.toThrow(/^Some other CDP failure$/);
  });
});
