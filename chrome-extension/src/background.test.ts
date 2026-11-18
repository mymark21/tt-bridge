import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DAEMON_PORT } from './protocol';
import { TOPOLOGY_DEBOUNCE_MS } from './window-state';

type Listener<T extends (...args: any[]) => void> = { addListener: (fn: T) => void };

type RuntimeMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => unknown;

type MockTab = {
  id: number;
  windowId: number;
  url?: string;
  title?: string;
  active?: boolean;
  status?: string;
};

type MockWindow = {
  id: number;
  focused: boolean;
  state: string;
  type: string;
  incognito: boolean;
  tabs: MockTab[];
};

/** Captures registered listeners so tests can fire the real Chrome events. */
function createListenerHub<T extends (...args: any[]) => void>() {
  const listeners: T[] = [];
  return {
    listeners,
    addListener: vi.fn((listener: T) => {
      listeners.push(listener);
    }),
    removeListener: vi.fn((listener: T) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    }),
    emit: (...args: Parameters<T>) => {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  /** Test helper: finish the handshake the way a real socket would. */
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  /** Test helper: parsed messages this socket received. */
  messages(): any[] {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}

function createChromeMock() {
  let nextTabId = 10;
  let nextWindowId = 5;
  const storage = new Map<string, unknown>();
  const tabs: MockTab[] = [
    { id: 1, windowId: 1, url: 'https://automation.example', title: 'automation', active: true, status: 'complete' },
    { id: 2, windowId: 2, url: 'https://user.example', title: 'user', active: true, status: 'complete' },
    { id: 3, windowId: 1, url: 'chrome://extensions', title: 'chrome', active: false, status: 'complete' },
    { id: 31, windowId: 3, url: 'https://min.example', title: 'minimized window', active: true, status: 'complete' },
  ];
  const windows = new Map<number, MockWindow>([
    [1, { id: 1, focused: false, state: 'normal', type: 'normal', incognito: true, tabs: [tabs[0], tabs[2]] }],
    [2, { id: 2, focused: true, state: 'normal', type: 'normal', incognito: false, tabs: [tabs[1]] }],
    [3, {
      id: 3,
      focused: false,
      state: 'minimized',
      type: 'popup',
      incognito: false,
      tabs: [{ id: 31, windowId: 3, url: 'https://min.example', title: 'minimized window', active: true, status: 'complete' }],
    }],
    [4, { id: 4, focused: false, state: 'normal', type: 'devtools', incognito: false, tabs: [] }],
  ]);

  const events = {
    alarms: createListenerHub<(alarm: { name: string }) => void>(),
    tabsCreated: createListenerHub<(tab: chrome.tabs.Tab) => void>(),
    tabsRemoved: createListenerHub<(tabId: number, info: chrome.tabs.TabRemoveInfo) => void>(),
    tabsActivated: createListenerHub<(info: chrome.tabs.TabActiveInfo) => void>(),
    tabsUpdated: createListenerHub<(tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void>(),
    windowsCreated: createListenerHub<(win: chrome.windows.Window) => void>(),
    windowsRemoved: createListenerHub<(windowId: number) => void>(),
    windowsFocused: createListenerHub<(windowId: number) => void>(),
    runtimeMessages: createListenerHub<RuntimeMessageListener>(),
  };

  const query = vi.fn(async (queryInfo: { windowId?: number } = {}) => {
    return tabs.filter((tab) => queryInfo.windowId === undefined || tab.windowId === queryInfo.windowId);
  });
  const create = vi.fn(async ({ windowId, url, active }: { windowId?: number; url?: string; active?: boolean }) => {
    const tab: MockTab = {
      id: nextTabId++,
      windowId: windowId ?? 999,
      url,
      title: url ?? 'blank',
      active: !!active,
      status: 'complete',
    };
    tabs.push(tab);
    return tab;
  });
  const update = vi.fn(async (tabId: number, updates: { active?: boolean; url?: string; muted?: boolean }) => {
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab) throw new Error(`Unknown tab ${tabId}`);
    if (updates.active !== undefined) tab.active = updates.active;
    if (updates.url !== undefined) tab.url = updates.url;
    if (updates.muted !== undefined) (tab as MockTab & { muted?: boolean }).muted = updates.muted;
    return tab;
  });
  const cookies: Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean }> = [
    { name: 'long_session', value: 'eyJhbGciOiJIUzI1NiJ9.payload.sig', domain: 'localhost', path: '/', secure: false, httpOnly: true },
    { name: 'short', value: 'abc', domain: 'localhost', path: '/', secure: false, httpOnly: false },
    { name: 'empty', value: '', domain: 'localhost', path: '/', secure: false, httpOnly: false },
    { name: 'other', value: 'shouldnotappear', domain: 'example.com', path: '/', secure: true, httpOnly: false },
  ];

  const chrome = {
    tabs: {
      query,
      create,
      update,
      remove: vi.fn(async (_tabId: number) => {}),
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.find((entry) => entry.id === tabId);
        if (!tab) throw new Error(`Unknown tab ${tabId}`);
        return tab;
      }),
      onCreated: events.tabsCreated,
      onRemoved: events.tabsRemoved,
      onActivated: events.tabsActivated,
      onUpdated: events.tabsUpdated,
    },
    windows: {
      get: vi.fn(async (windowId: number, options?: { populate?: boolean }) => {
        const win = windows.get(windowId);
        if (!win) throw new Error(`Unknown window ${windowId}`);
        return options?.populate ? win : { ...win, tabs: undefined };
      }),
      getAll: vi.fn(async (options?: { populate?: boolean }) => {
        return [...windows.values()].map((win) => (options?.populate ? win : { ...win, tabs: undefined }));
      }),
      create: vi.fn(async ({ url, focused, width, height, type, incognito }: any) => {
        const win = { id: nextWindowId++, url, focused, width, height, type, incognito: !!incognito };
        windows.set(win.id, {
          id: win.id,
          focused: !!focused,
          state: 'normal',
          type: 'normal',
          incognito: win.incognito,
          tabs: [],
        });
        return win;
      }),
      update: vi.fn(async (windowId: number, info: { focused?: boolean; state?: string }) => {
        const win = windows.get(windowId);
        if (!win) throw new Error(`Unknown window ${windowId}`);
        if (info.focused !== undefined) {
          for (const entry of windows.values()) entry.focused = entry.id === windowId && info.focused;
        }
        if (info.state !== undefined) win.state = info.state;
        return win;
      }),
      remove: vi.fn(async (_windowId: number) => {}),
      onCreated: events.windowsCreated,
      onRemoved: events.windowsRemoved,
      onFocusChanged: events.windowsFocused,
    },
    extension: {
      isAllowedIncognitoAccess: vi.fn(async () => true),
    },
    identity: {
      getProfileUserInfo: vi.fn(async (_details?: { accountStatus?: string }) => ({
        email: 'tester@example.com',
        id: '100000000000000000001',
      })),
    },
    alarms: {
      create: vi.fn(),
      onAlarm: events.alarms as Listener<(alarm: { name: string }) => void>,
    },
    runtime: {
      onInstalled: { addListener: vi.fn() } as Listener<() => void>,
      onStartup: { addListener: vi.fn() } as Listener<() => void>,
      onMessage: events.runtimeMessages,
      getManifest: vi.fn(() => ({ version: '1.0.0' })),
      id: 'tt-bridge-test',
      reload: vi.fn(),
    },
    storage: {
      local: {
        get: vi.fn(async (key?: string) => {
          if (!key) {
            return Object.fromEntries(storage.entries());
          }
          return { [key]: storage.get(key) };
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) {
            storage.set(key, value);
          }
        }),
      },
    },
    cookies: {
      getAll: vi.fn(async (details: { domain?: string; url?: string } = {}) => {
        return cookies.filter((cookie) => !details.domain || cookie.domain === details.domain);
      }),
    },
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (
        _target: { tabId?: number },
        method: string,
        params?: Record<string, unknown>,
      ) => {
        if (method === 'Runtime.evaluate') {
          return { result: { type: 'number', value: 1 } };
        }
        return {};
      }),
      onDetach: { addListener: vi.fn() } as Listener<() => void>,
    },
  };

  return { chrome, tabs, query, create, update, events, cookies };
}

describe('background tab isolation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  it('lists only automation-window web tabs', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('site:twitter', 1);
    const result = await mod.__test__.handleTabs({ id: '1', action: 'tabs', op: 'list', workspace: 'site:twitter' }, 'site:twitter');

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      {
        index: 0,
        tabId: 1,
        url: 'https://automation.example',
        title: 'automation',
        active: true,
      },
    ]);
  });

  it('creates new tabs inside the automation window', async () => {
    const { chrome, create } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('site:twitter', 1);

    const result = await mod.__test__.handleTabs({ id: '2', action: 'tabs', op: 'new', url: 'https://new.example', workspace: 'site:twitter' }, 'site:twitter');

    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledWith({ windowId: 1, url: 'https://new.example', active: true });
  });

  it('creates automation windows in incognito mode', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await mod.__test__.getAutomationWindow('site:incognito');

    expect(chrome.windows.create).toHaveBeenCalledWith({
      url: 'data:text/html,<html></html>',
      focused: false,
      width: 1280,
      height: 900,
      type: 'normal',
      incognito: true,
    });
  });

  it('fails fast when incognito access is disabled', async () => {
    const { chrome } = createChromeMock();
    chrome.extension.isAllowedIncognitoAccess.mockResolvedValue(false);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');

    await expect(mod.__test__.getAutomationWindow('site:blocked')).rejects.toThrow(
      'Allow in Incognito',
    );
  });

  it('reports sessions per workspace', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('site:twitter', 1);
    mod.__test__.setAutomationWindowId('site:zhihu', 2);

    const result = await mod.__test__.handleSessions({ id: '3', action: 'sessions' });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspace: 'site:twitter', windowId: 1, incognito: true }),
      expect.objectContaining({ workspace: 'site:zhihu', windowId: 2, incognito: false }),
    ]));
  });

  it('applies a device preset via emulate', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('emulate:preset', 1);

    const result = await mod.__test__.handleEmulate(
      { id: 'e1', action: 'emulate', device: 'iphone14', workspace: 'emulate:preset' },
      'emulate:preset',
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      device: 'iphone14',
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      touch: true,
    });
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: expect.any(Number) },
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({ width: 390, height: 844, deviceScaleFactor: 3, mobile: true }),
    );
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: expect.any(Number) },
      'Emulation.setTouchEmulationEnabled',
      expect.objectContaining({ enabled: true }),
    );
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: expect.any(Number) },
      'Network.setUserAgentOverride',
      expect.objectContaining({ userAgent: expect.stringContaining('iPhone') }),
    );
  });

  it('emulates explicit width and height', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('emulate:wh', 1);

    const result = await mod.__test__.handleEmulate(
      { id: 'e2', action: 'emulate', width: 1280, height: 720, deviceScaleFactor: 2, workspace: 'emulate:wh' },
      'emulate:wh',
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
  });

  it('resets device metrics, touch and user agent', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('emulate:reset', 1);

    const result = await mod.__test__.handleEmulate(
      { id: 'e3', action: 'emulate', reset: true, workspace: 'emulate:reset' },
      'emulate:reset',
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ reset: true });
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: expect.any(Number) },
      'Emulation.clearDeviceMetricsOverride',
      undefined,
    );
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: expect.any(Number) },
      'Emulation.setTouchEmulationEnabled',
      expect.objectContaining({ enabled: false }),
    );
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: expect.any(Number) },
      'Network.setUserAgentOverride',
      { userAgent: '' },
    );
  });

  it('rejects unknown device presets', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('emulate:bad', 1);

    const result = await mod.__test__.handleEmulate(
      { id: 'e4', action: 'emulate', device: 'nokia3310', workspace: 'emulate:bad' },
      'emulate:bad',
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown device preset');
  });

  it('keeps waiting status when popup opens during serving mode', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));

    const mod = await import('./background');
    mod.__test__.setServingEnabled(true);
    mod.__test__.setConfiguredPort(19826);
    mod.__test__.setBridgeStatusForTest('waiting', 'Waiting for local daemon on 19826.');

    await mod.__test__.refreshPortSelection('popup');

    expect(mod.__test__.getConnectionState()).toBe('waiting');
    expect(mod.__test__.getStatusText()).toBe('Waiting for local daemon on 19826.');
  });

  it('marks daemonDetected=false in the popup state when no daemon answers the scan', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));

    const mod = await import('./background');
    mod.__test__.setServingEnabled(true);
    await mod.__test__.refreshPortSelection('popup');

    const state = mod.__test__.buildPopupStateForTest();
    expect(state.servingEnabled).toBe(true);
    expect(state.daemonDetected).toBe(false);
    expect(state.connectionState).not.toBe('connected');
  });

  it('retries the daemon connection immediately when the popup asks', async () => {
    const { chrome, events } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    MockWebSocket.instances = [];

    const mod = await import('./background');
    const listener = events.runtimeMessages.listeners[0];

    // First message finishes initialization while serving is still disabled
    // (storage is empty), so the retry message is the only thing that connects.
    await new Promise<void>((resolve) => {
      listener({ type: 'ttbridge:get-popup-state' }, {}, () => resolve());
    });

    mod.__test__.setServingEnabled(true);
    const response = await new Promise<any>((resolve) => {
      listener({ type: 'ttbridge:retry-connection' }, {}, resolve);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(mod.__test__.getConnectionState()).toBe('waiting');
    expect(response).toMatchObject({ servingEnabled: true, daemonDetected: false });
  });
});

describe('instance identity & tab pinning', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  it('generates and renames a stable instance label', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const generated = await mod.__test__.getInstanceLabelForTest();
    expect(generated).toMatch(/^chrome-[0-9a-f]{4}$/);

    const renamed = await mod.__test__.setInstanceLabelForTest('work-chrome');
    expect(renamed).toBe('work-chrome');
    expect(await mod.__test__.getInstanceLabelForTest()).toBe('work-chrome');
  });

  it('pins a human tab and reports pin status without activating it', async () => {
    const { chrome, update } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setPinnedTabIdForTest(null);

    const pinResult = await mod.__test__.handleTabs({ id: 'p1', action: 'tabs', op: 'pin', tabId: 2 }, 'human');
    expect(pinResult.ok).toBe(true);
    expect(pinResult.data).toMatchObject({ pinned: true, tabId: 2 });
    expect(await mod.__test__.getPinnedTabIdForTest()).toBe(2);
    expect(update.mock.calls.some((call) => call[1]?.active === true)).toBe(false);

    const status = await mod.__test__.handleTabs({ id: 'p2', action: 'tabs', op: 'pin-status' }, 'human');
    expect(status.data).toMatchObject({ pinned: true, tabId: 2, url: 'https://user.example' });
  });

  it('unpins on request', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setPinnedTabIdForTest(2);

    const result = await mod.__test__.handleTabs({ id: 'p3', action: 'tabs', op: 'unpin' }, 'human');
    expect(result.data).toEqual({ pinned: false });
    expect(await mod.__test__.getPinnedTabIdForTest()).toBe(null);
  });

  it('announces pinnedTabId in hello after pin succeeds', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await mod.__test__.startServing();
    const socket = MockWebSocket.instances.at(-1)!;
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Clear initial messages sent on connect
    socket.sent.length = 0;

    const pinResult = await mod.__test__.handleTabs({ id: 'p1', action: 'tabs', op: 'pin', tabId: 2 }, 'human');
    expect(pinResult.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const hellos = socket.messages().filter((msg) => msg.type === 'hello');
    expect(hellos).toHaveLength(1);
    expect(hellos[0]).toMatchObject({ type: 'hello', pinnedTabId: 2 });
  });

  it('announces pinnedTabId: null in hello after unpin', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setPinnedTabIdForTest(2);
    await mod.__test__.startServing();
    const socket = MockWebSocket.instances.at(-1)!;
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    socket.sent.length = 0;

    const unpinResult = await mod.__test__.handleTabs({ id: 'u1', action: 'tabs', op: 'unpin' }, 'human');
    expect(unpinResult.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const hellos = socket.messages().filter((msg) => msg.type === 'hello');
    expect(hellos).toHaveLength(1);
    expect(hellos[0]).toMatchObject({ type: 'hello', pinnedTabId: null });
  });

  it('human select pins the chosen tab instead of activating it', async () => {
    const { chrome, update } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setPinnedTabIdForTest(null);

    const result = await mod.__test__.handleTabs({ id: 'p4', action: 'tabs', op: 'select', tabId: 2 }, 'human');
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ selected: 2, pinned: true, activated: false });
    expect(await mod.__test__.getPinnedTabIdForTest()).toBe(2);
    expect(update.mock.calls.some((call) => call[1]?.active === true)).toBe(false);
  });

  it('rejects pin for automation workspaces and lists human tabs with pin markers', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setPinnedTabIdForTest(2);

    const rejected = await mod.__test__.handleTabs({ id: 'p5', action: 'tabs', op: 'pin', workspace: 'team-a' }, 'team-a');
    expect(rejected.ok).toBe(false);

    const listed = await mod.__test__.handleTabs({ id: 'p6', action: 'tabs', op: 'list' }, 'human');
    expect(listed.ok).toBe(true);
    const data = listed.data as Array<{ url?: string; tabId?: number; bridgePinned?: boolean }>;
    expect(data.some((tab) => tab.url?.startsWith('chrome://'))).toBe(false);
    expect(data.find((tab) => tab.bridgePinned)).toMatchObject({ tabId: 2 });
  });

  it('opens human-mode tabs in the background without activating them', async () => {
    const { chrome, create, update } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const result = await mod.__test__.handleTabs(
      { id: 'n1', action: 'tabs', op: 'new', url: 'https://example.com/lesson' },
      'human',
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ url: 'https://example.com/lesson', background: true, active: false });
    expect(create.mock.calls.at(-1)?.[0]).toMatchObject({ url: 'https://example.com/lesson', active: false });
    expect(update.mock.calls.some((call) => call[1]?.active === true)).toBe(false);
  });

  it('mutes a new human-mode tab only when mute is requested', async () => {
    const { chrome, update } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const result = await mod.__test__.handleTabs(
      { id: 'n2', action: 'tabs', op: 'new', url: 'https://noisy.example', mute: true },
      'human',
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ muted: true });
    const data = result.data as Record<string, unknown> | undefined;
    const newTabId = data && typeof data.tabId === 'number' ? data.tabId : NaN;
    expect(update).toHaveBeenCalledWith(newTabId, { muted: true });
  });

  it('does not mute a new human-mode tab by default', async () => {
    const { chrome, update } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const result = await mod.__test__.handleTabs(
      { id: 'n3', action: 'tabs', op: 'new', url: 'https://music.example' },
      'human',
    );

    expect(result.ok).toBe(true);
    expect(result.data).not.toHaveProperty('muted');
    expect(update.mock.calls.some((call) => call[1]?.muted !== undefined)).toBe(false);
  });

  it('mutes a new automation-workspace tab when requested', async () => {
    const { chrome, update } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('site:music', 1);
    const result = await mod.__test__.handleTabs(
      { id: 'n4', action: 'tabs', op: 'new', url: 'https://automation.example/video', mute: true, workspace: 'site:music' },
      'site:music',
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ muted: true });
    expect(update).toHaveBeenCalledWith(expect.any(Number), { muted: true });
  });

  it('refuses to screenshot a minimized window and reports the --restore hint', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // Tab 31 lives in window 3, which the mock seeds with state 'minimized'.
    const result = await mod.__test__.handleScreenshot(
      { id: 's1', action: 'screenshot', tabId: 31 },
      'human',
    );

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('minimized');
    expect(String(result.error)).toContain('--restore');
    // Must fail fast: no CDP capture was attempted.
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 31 }),
      'Page.captureScreenshot',
      expect.anything(),
    );
    expect(chrome.windows.update).not.toHaveBeenCalled();
  });

  it('restores a minimized window with restoreWindow before capturing', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const result = await mod.__test__.handleScreenshot(
      { id: 's2', action: 'screenshot', tabId: 31, restoreWindow: true },
      'human',
    );

    expect(chrome.windows.update).toHaveBeenCalledWith(3, { state: 'normal' });
    expect(result.ok).toBe(true);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 31 }),
      'Page.captureScreenshot',
      expect.objectContaining({ format: 'png' }),
    );
  });

  it('still refuses minimized screenshots for automation workspaces without restore', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('site:min', 3);
    const result = await mod.__test__.handleScreenshot(
      { id: 's3', action: 'screenshot', restoreWindow: true, workspace: 'site:min' },
      'site:min',
    );

    // --restore is human-only; automation windows must not be silently raised.
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('minimized');
    expect(chrome.windows.update).not.toHaveBeenCalled();
  });

  it('passes mobile through handleScreenshot to executor.screenshot', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const result = await mod.__test__.handleScreenshot(
      { id: 's4', action: 'screenshot', tabId: 2, mobile: true },
      'human',
    );

    expect(result.ok).toBe(true);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 2 }),
      'Page.captureScreenshot',
      expect.objectContaining({ format: 'png' }),
    );
  });

  it('returns raw cookie values with metadata; masking happens at the CLI layer', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const result = await mod.__test__.handleCookies({ id: 'c1', action: 'cookies', domain: 'localhost' });

    expect(result.ok).toBe(true);
    const data = (result.data as Array<{ name: string; value: string; domain: string; secure: boolean }> | undefined) ?? [];
    // Only localhost cookies (domain filter respected); values pass through raw.
    expect(data.every((cookie) => cookie.domain === 'localhost')).toBe(true);
    expect(data.find((cookie) => cookie.name === 'long_session')).toMatchObject({
      value: 'eyJhbGciOiJIUzI1NiJ9.payload.sig',
      httpOnly: true,
    });
  });

  it('renames the current instance through the instance action', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const result = await mod.__test__.handleInstance({ id: 'i1', action: 'instance', newLabel: 'mac-work' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ label: 'mac-work' });

    const info = await mod.__test__.handleInstance({ id: 'i2', action: 'instance' });
    expect(info.ok).toBe(true);
    expect(info.data).toMatchObject({ label: 'mac-work', extensionId: 'tt-bridge-test' });
  });
});

describe('window snapshots & selected window state', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  it('maps chrome.windows.getAll into snapshots and skips devtools windows', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const snapshots = await mod.__test__.buildWindowSnapshots();

    expect(chrome.windows.getAll).toHaveBeenCalledWith({
      populate: true,
      windowTypes: ['normal', 'popup', 'panel', 'app'],
    });
    expect(snapshots.map((snapshot) => snapshot.windowId)).toEqual([1, 2, 3]);
    expect(snapshots[0]).toEqual({
      windowId: 1,
      focused: false,
      state: 'normal',
      type: 'normal',
      incognito: true,
      tabCount: 2,
      activeTab: { tabId: 1, title: 'automation', url: 'https://automation.example' },
    });
    expect(snapshots[1]).toMatchObject({
      windowId: 2,
      focused: true,
      incognito: false,
      tabCount: 1,
      activeTab: { tabId: 2, title: 'user', url: 'https://user.example' },
    });
    expect(snapshots[2]).toMatchObject({
      windowId: 3,
      state: 'minimized',
      type: 'popup',
      tabCount: 1,
      activeTab: { tabId: 31, title: 'minimized window', url: 'https://min.example' },
    });
  });

  it('reads, persists and clears the selected window in session storage', async () => {
    const { chrome } = createChromeMock();
    const session = new Map<string, unknown>([['ttBridgeSelectedWindowId', 7]]);
    (chrome.storage as any).session = {
      get: vi.fn(async (key: string) => ({ [key]: session.get(key) })),
      set: vi.fn(async (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) session.set(key, value);
      }),
      remove: vi.fn(async (key: string) => {
        session.delete(key);
      }),
    };
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    expect(await mod.__test__.getSelectedWindowIdForTest()).toBe(7);

    await mod.__test__.setSelectedWindowIdForTest(null);
    expect(session.has('ttBridgeSelectedWindowId')).toBe(false);

    await mod.__test__.setSelectedWindowIdForTest(3);
    expect(session.get('ttBridgeSelectedWindowId')).toBe(3);
  });
});

describe('windows action', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  it('lists windows with the selection and the profile descriptor', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const result = await mod.__test__.handleWindows({ id: 'w1', action: 'windows', windowOp: 'list' });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.windows).toHaveLength(3);
    expect(data.selectedWindowId).toBeNull();
    expect(data.profile).toEqual({
      label: expect.stringMatching(/^chrome-[0-9a-f]{4}$/),
      email: 'tester@example.com',
      gaiaId: '100000000000000000001',
      name: '',
    });
    expect(chrome.identity.getProfileUserInfo).toHaveBeenCalledWith({ accountStatus: 'ANY' });
  });

  it('reports empty identity fields when chrome.identity is unavailable', async () => {
    const { chrome } = createChromeMock();
    delete (chrome as any).identity;
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    expect(await mod.__test__.getProfileDescriptor()).toMatchObject({ email: '', gaiaId: '', name: '' });
  });

  it('reports empty identity fields when the identity call fails', async () => {
    const { chrome } = createChromeMock();
    chrome.identity.getProfileUserInfo.mockRejectedValue(new Error('identity.email not granted'));
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    expect(await mod.__test__.getProfileDescriptor()).toMatchObject({ email: '', gaiaId: '' });
  });

  it('selects a window without focusing it and refuses unknown windows', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');

    const missing = await mod.__test__.handleWindows({ id: 'w2', action: 'windows', windowOp: 'use' });
    expect(missing).toMatchObject({ ok: false, error: 'Missing windowId' });

    const selected = await mod.__test__.handleWindows({ id: 'w3', action: 'windows', windowOp: 'use', windowId: 2 });
    expect(selected.ok).toBe(true);
    expect(selected.data).toMatchObject({
      selectedWindowId: 2,
      focused: false,
      window: { windowId: 2, tabCount: 1 },
    });
    expect(chrome.windows.update).not.toHaveBeenCalled();
    expect(await mod.__test__.getSelectedWindowIdForTest()).toBe(2);

    const unknown = await mod.__test__.handleWindows({ id: 'w4', action: 'windows', windowOp: 'use', windowId: 99 });
    expect(unknown).toMatchObject({ ok: false, error: 'Window 99 not found' });
    expect(await mod.__test__.getSelectedWindowIdForTest()).toBe(2);
  });

  it('clears the selection when the target window no longer exists', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await mod.__test__.setSelectedWindowIdForTest(99);

    const result = await mod.__test__.handleWindows({ id: 'w5', action: 'windows', windowOp: 'use', windowId: 99 });

    expect(result).toMatchObject({ ok: false, error: 'Window 99 not found' });
    expect(await mod.__test__.getSelectedWindowIdForTest()).toBeNull();
  });

  it('focuses a window only when explicitly asked', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');

    const used = await mod.__test__.handleWindows({
      id: 'w6',
      action: 'windows',
      windowOp: 'use',
      windowId: 2,
      focusWindow: true,
    });
    expect(used.data).toMatchObject({
      selectedWindowId: 2,
      focused: true,
      window: { windowId: 2, focused: true },
    });
    expect(chrome.windows.update).toHaveBeenCalledWith(2, { focused: true });

    const direct = await mod.__test__.handleWindows({ id: 'w7', action: 'windows', windowOp: 'focus', windowId: 1 });
    expect(direct.data).toEqual({ windowId: 1, focused: true });

    const gone = await mod.__test__.handleWindows({ id: 'w8', action: 'windows', windowOp: 'focus', windowId: 99 });
    expect(gone).toMatchObject({ ok: false, error: 'Window 99 not found' });
  });

  it('reports status counts and rejects unknown ops', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await mod.__test__.setSelectedWindowIdForTest(2);

    const status = await mod.__test__.handleWindows({ id: 'w9', action: 'windows', windowOp: 'status' });
    expect(status.ok).toBe(true);
    expect(status.data).toMatchObject({ selectedWindowId: 2, windowCount: 3, tabCount: 4 });

    const noOp = await mod.__test__.handleWindows({ id: 'w10', action: 'windows' });
    expect(noOp).toMatchObject({ ok: false, error: 'Unknown windows op: undefined' });

    const bogus = await mod.__test__.handleWindows({ id: 'w11', action: 'windows', windowOp: 'sync' as any });
    expect(bogus).toMatchObject({ ok: false, error: 'Unknown windows op: sync' });
  });
});

describe('human tab resolution priority', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  it('prefers explicit tab, then the pin, then the selected window', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');

    // Nothing set: the last-focused window query picks the first debuggable tab.
    expect(await mod.__test__.resolveTabId(undefined, 'human')).toBe(1);

    // Selected window outranks whatever the human is looking at.
    await mod.__test__.setSelectedWindowIdForTest(2);
    expect(await mod.__test__.resolveTabId(undefined, 'human')).toBe(2);

    // Pin still outranks the selected window.
    await mod.__test__.setSelectedWindowIdForTest(1);
    await mod.__test__.setPinnedTabIdForTest(2);
    expect(await mod.__test__.resolveTabId(undefined, 'human')).toBe(2);

    // Explicit tab outranks both.
    expect(await mod.__test__.resolveTabId(1, 'human')).toBe(1);
  });

  it('drops a stale selected window and falls back to the focused window', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await mod.__test__.setSelectedWindowIdForTest(99);

    expect(await mod.__test__.resolveTabId(undefined, 'human')).toBe(1);
    expect(await mod.__test__.getSelectedWindowIdForTest()).toBeNull();
  });

  it('throws helpful error when the active human tab is a browser/extension page', async () => {
    const { chrome } = createChromeMock();
    chrome.tabs.query = vi.fn(async () => [
      { id: 100, windowId: 1, url: 'chrome://extensions', title: 'Extensions', active: true, status: 'complete' },
    ]);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await expect(mod.__test__.resolveTabId(undefined, 'human')).rejects.toThrow(
      'Active tab is a browser/extension page. Switch Chrome to a normal web page, or run "tt-bridge tab pin --tab <id>".',
    );
  });

  it('clears the selection when its window is removed', async () => {
    const { chrome, events } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await mod.__test__.setSelectedWindowIdForTest(2);

    events.windowsRemoved.emit(3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await mod.__test__.getSelectedWindowIdForTest()).toBe(2);

    events.windowsRemoved.emit(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await mod.__test__.getSelectedWindowIdForTest()).toBeNull();
  });

  it('resolveHumanCandidate prefers active tab of selectedWindowId over lastFocusedWindow', async () => {
    const { chrome, tabs } = createChromeMock();
    chrome.tabs.query = vi.fn(async (queryInfo: any) => {
      if (queryInfo.lastFocusedWindow) {
        return [{ id: 88, windowId: 1, url: 'https://last-focused.example', active: true, status: 'complete' }];
      }
      return tabs.filter((tab) => queryInfo.windowId === undefined || tab.windowId === queryInfo.windowId);
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await mod.__test__.setSelectedWindowIdForTest(2);

    const candidate = await mod.__test__.resolveHumanCandidate({ id: 'c1', action: 'tabs', op: 'pin' });
    expect(candidate).toBeDefined();
    expect(candidate?.id).toBe(2);
    expect(candidate?.windowId).toBe(2);
  });

  it('resolveHumanCandidate falls back to lastFocusedWindow when selected window is gone or non-debuggable', async () => {
    const { chrome, tabs } = createChromeMock();
    chrome.tabs.query = vi.fn(async (queryInfo: any) => {
      if (queryInfo.lastFocusedWindow) {
        return [{ id: 88, windowId: 1, url: 'https://last-focused.example', active: true, status: 'complete' }];
      }
      return tabs.filter((tab) => queryInfo.windowId === undefined || tab.windowId === queryInfo.windowId);
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');

    // Stale windowId: window 99 does not exist
    await mod.__test__.setSelectedWindowIdForTest(99);
    const candidateStale = await mod.__test__.resolveHumanCandidate({ id: 'c2', action: 'tabs', op: 'pin' });
    expect(candidateStale?.id).toBe(88);
    expect(await mod.__test__.getSelectedWindowIdForTest()).toBeNull();

    // Window with no debuggable tab (window 4 has tabs: [])
    await mod.__test__.setSelectedWindowIdForTest(4);
    const candidateEmpty = await mod.__test__.resolveHumanCandidate({ id: 'c3', action: 'tabs', op: 'pin' });
    expect(candidateEmpty?.id).toBe(88);
  });

  it('preserves resolveTabIdTarget regression priority: pinnedTabId > selectedWindowId > lastFocusedWindow', async () => {
    const { chrome, tabs } = createChromeMock();
    chrome.tabs.query = vi.fn(async (queryInfo: any) => {
      if (queryInfo.lastFocusedWindow) {
        return [{ id: 88, windowId: 1, url: 'https://last-focused.example', active: true, status: 'complete' }];
      }
      return tabs.filter((tab) => queryInfo.windowId === undefined || tab.windowId === queryInfo.windowId);
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setPinnedTabIdForTest(null);
    await mod.__test__.setSelectedWindowIdForTest(null);

    // 1) Neither set -> falls back to lastFocusedWindow (tab 88)
    expect(await mod.__test__.resolveTabIdTarget(undefined, 'human')).toBe(88);

    // 2) selectedWindowId set (window 2 has tab 2) -> returns selected window tab (tab 2)
    await mod.__test__.setSelectedWindowIdForTest(2);
    expect(await mod.__test__.resolveTabIdTarget(undefined, 'human')).toBe(2);

    // 3) pinnedTabId set (tab 1) -> pin outranks selectedWindowId
    mod.__test__.setPinnedTabIdForTest(1);
    expect(await mod.__test__.resolveTabIdTarget(undefined, 'human')).toBe(1);
  });
});

describe('agent tab shield', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  /**
   * Drain the fire-and-forget shield work. Every step is a promise (CDP
   * evaluate → attach check → sendCommand), so ticking microtasks is exact —
   * no wall-clock sleep and no fake timers needed.
   */
  async function settle(): Promise<void> {
    for (let tick = 0; tick < 20; tick += 1) {
      await Promise.resolve();
    }
  }

  it('shields the pinned tab and restores it on unpin', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const pinned = await mod.__test__.handleTabs({ id: 'p1', action: 'tabs', op: 'pin', tabId: 2 }, 'human');
    expect(pinned.ok).toBe(true);
    await settle();
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 2 },
      'Runtime.evaluate',
      expect.objectContaining({ expression: expect.stringContaining('data-tt-bridge-shield') }),
    );

    await mod.__test__.handleTabs({ id: 'p2', action: 'tabs', op: 'unpin' }, 'human');
    await settle();
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 2 },
      'Runtime.evaluate',
      expect.objectContaining({ expression: expect.stringContaining('restored') }),
    );
  });

  it('moves the shield off the previous tab when the target changes', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await mod.__test__.resolveTabId(1, 'human');
    await settle();
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 1 },
      'Runtime.evaluate',
      expect.objectContaining({ expression: expect.stringContaining('restored') }),
    );

    await mod.__test__.resolveTabId(2, 'human');
    await settle();
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Runtime.evaluate',
      expect.objectContaining({ expression: expect.stringContaining('restored') }),
    );
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 2 },
      'Runtime.evaluate',
      expect.objectContaining({ expression: expect.stringContaining('data-tt-bridge-shield') }),
    );
  });

  it('never shields automation-workspace tabs', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('site:quiet', 1);
    await mod.__test__.resolveTabId(undefined, 'site:quiet');
    await settle();

    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      'Runtime.evaluate',
      expect.objectContaining({ expression: expect.stringContaining('data-tt-bridge-shield') }),
    );
  });
});

describe('window topology events', () => {
  beforeEach(() => {
    vi.resetModules();
    MockWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
  });

  async function connectExtension() {
    const { chrome, events } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await mod.__test__.startServing();

    const socket = MockWebSocket.instances.at(-1)!;
    socket.open();
    // Let the best-effort hello round-trip settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    return { chrome, events, mod, socket };
  }

  it('announces the profile, window list and selection in hello', async () => {
    const { socket } = await connectExtension();

    const hello = socket.messages().find((message) => message.type === 'hello');
    expect(hello).toBeDefined();
    expect(hello).toMatchObject({
      role: 'extension',
      label: expect.stringMatching(/^chrome-[0-9a-f]{4}$/),
      profile: {
        label: expect.stringMatching(/^chrome-[0-9a-f]{4}$/),
        email: 'tester@example.com',
        gaiaId: '100000000000000000001',
        name: '',
      },
      windows: 3,
      tabs: 4,
    });
    expect(hello.windowList).toHaveLength(3);
  });

  it('pushes one windows event per burst of topology changes', async () => {
    const { events, socket } = await connectExtension();

    events.tabsActivated.emit({ tabId: 2, windowId: 2 });
    events.tabsUpdated.emit(2, { status: 'complete' }, { id: 2 } as chrome.tabs.Tab);
    events.windowsFocused.emit(2);

    await new Promise((resolve) => setTimeout(resolve, TOPOLOGY_DEBOUNCE_MS + 150));

    const windowsEvents = socket.messages().filter((message) => message.type === 'windows');
    expect(windowsEvents).toHaveLength(1);
    expect(windowsEvents[0]).toMatchObject({ type: 'windows', windows: 3, tabs: 4, selectedWindowId: null });
    expect(windowsEvents[0].profile.email).toBe('tester@example.com');
  });

  it('ignores tab updates that are not settled', async () => {
    const { events, socket } = await connectExtension();

    events.tabsUpdated.emit(2, { status: 'loading' }, { id: 2 } as chrome.tabs.Tab);

    await new Promise((resolve) => setTimeout(resolve, TOPOLOGY_DEBOUNCE_MS + 150));

    expect(socket.messages().filter((message) => message.type === 'windows')).toHaveLength(0);
  });

  it('registers topology listeners once per worker lifetime', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');

    // Armed synchronously at import time (topology pushes plus the gesture wake
    // hooks); a second registration attempt in the same worker is a no-op.
    const updatedListeners = chrome.tabs.onUpdated.addListener.mock.calls.length;
    const focusListeners = chrome.windows.onFocusChanged.addListener.mock.calls.length;
    expect(updatedListeners).toBe(1);
    expect(focusListeners).toBeGreaterThanOrEqual(1);

    expect(mod.__test__.ensureTopologyListeners()).toBe(false);
    expect(chrome.tabs.onUpdated.addListener.mock.calls.length).toBe(updatedListeners);
    expect(chrome.windows.onFocusChanged.addListener.mock.calls.length).toBe(focusListeners);
  });
});

describe('extension hot reload', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  it('answers first and schedules exactly one reload', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');

    vi.useFakeTimers();
    try {
      const result = await mod.__test__.handleReload({ id: 'r1', action: 'reload' });

      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ reloading: true, label: expect.stringMatching(/^chrome-/) });
      expect(chrome.runtime.reload).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(400);
      expect(chrome.runtime.reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('service-worker wake-up reconnect', () => {
  beforeEach(() => {
    vi.resetModules();
    MockWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Serving state that only storage knows: a previous worker lifetime left it ON. */
  async function persistServingOn(chrome: ReturnType<typeof createChromeMock>['chrome']): Promise<void> {
    await chrome.storage.local.set({ ttBridgeRuntimeConfig: { servingEnabled: true, port: 19826 } });
  }

  it('reconnects when the keepalive alarm wakes a cold worker', async () => {
    const { chrome, events } = createChromeMock();
    await persistServingOn(chrome);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // Cold worker: nothing initialized this module yet, so `servingEnabled` is false.
    expect(mod.__test__.getConnectionState()).toBe('idle');
    expect(MockWebSocket.instances).toHaveLength(0);

    events.alarms.emit({ name: 'keepalive' });

    await vi.waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const socket = MockWebSocket.instances[0];
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mod.__test__.getConnectionState()).toBe('connected');
    expect(socket.messages().some((message) => message.type === 'hello')).toBe(true);
    // 0.25 is below Chrome's minimum period and would be clamped silently.
    expect(chrome.alarms.create).toHaveBeenCalledWith('keepalive', { periodInMinutes: 0.5 });
  });

  it('ignores alarms that are not the keepalive alarm', async () => {
    const { chrome, events } = createChromeMock();
    await persistServingOn(chrome);
    vi.stubGlobal('chrome', chrome);

    await import('./background');
    events.alarms.emit({ name: 'some-other-alarm' });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('reconnects on a user gesture before the backoff timer fires', async () => {
    vi.useFakeTimers();
    const { chrome, events } = createChromeMock();
    await persistServingOn(chrome);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await mod.__test__.startServing();

    const first = MockWebSocket.instances.at(-1)!;
    first.open();
    await vi.advanceTimersByTimeAsync(0);

    // The daemon restarted: the socket dies and only the backoff timer is pending.
    first.close();
    expect(mod.__test__.getConnectionState()).toBe('waiting');

    const before = MockWebSocket.instances.length;
    events.tabsActivated.emit({ tabId: 2, windowId: 2 });
    await vi.advanceTimersByTimeAsync(0);

    expect(MockWebSocket.instances.length).toBe(before + 1);

    // The pending backoff must not open a second socket on top of it.
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances.length).toBe(before + 1);
  });

  it('reconnects when Chrome regains focus or a window is created', async () => {
    vi.useFakeTimers();
    const { chrome, events } = createChromeMock();
    await persistServingOn(chrome);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await mod.__test__.startServing();
    const first = MockWebSocket.instances.at(-1)!;
    first.open();
    await vi.advanceTimersByTimeAsync(0);
    first.close();

    const before = MockWebSocket.instances.length;
    events.windowsFocused.emit(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(MockWebSocket.instances.length).toBe(before + 1);

    const second = MockWebSocket.instances.at(-1)!;
    second.open();
    await vi.advanceTimersByTimeAsync(0);
    second.close();

    events.windowsCreated.emit({ id: 9, focused: true } as chrome.windows.Window);
    await vi.advanceTimersByTimeAsync(0);
    expect(MockWebSocket.instances.length).toBe(before + 2);
  });

  it('never reconnects on a gesture while Serving is off', async () => {
    const { chrome, events } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    await import('./background');
    events.tabsActivated.emit({ tabId: 2, windowId: 2 });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});

describe('connection heartbeat', () => {
  beforeEach(() => {
    vi.resetModules();
    MockWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function connectWithServing() {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await mod.__test__.startServing();
    return { chrome, mod, socket: MockWebSocket.instances.at(-1)! };
  }

  it('sends one ping per interval while connected and stops after close', async () => {
    vi.useFakeTimers();
    const { socket } = await connectWithServing();
    const pings = () => socket.messages().filter((message) => message.type === 'ping');

    // Not connected yet: no heartbeat traffic.
    await vi.advanceTimersByTimeAsync(60000);
    expect(pings()).toHaveLength(0);

    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(pings()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(20000);
    expect(pings()).toEqual([{ type: 'ping', ts: expect.any(Number) }]);

    await vi.advanceTimersByTimeAsync(20000);
    expect(pings()).toHaveLength(2);

    socket.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(pings()).toHaveLength(2);
  });

  it('ignores the daemon pong instead of answering it as a command', async () => {
    const { socket } = await connectWithServing();
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sentBefore = socket.sent.length;
    socket.onmessage?.({ data: JSON.stringify({ type: 'pong', ts: Date.now() }) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.sent).toHaveLength(sentBefore);
  });

  it('survives a heartbeat send that throws', async () => {
    vi.useFakeTimers();
    const { mod, socket } = await connectWithServing();
    socket.open();
    await vi.advanceTimersByTimeAsync(0);

    socket.send = () => {
      throw new Error('socket is wedged');
    };

    await vi.advanceTimersByTimeAsync(40000);
    expect(mod.__test__.getConnectionState()).toBe('connected');
  });
});

describe('profile identity', () => {
  beforeEach(() => {
    vi.resetModules();
    MockWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
  });

  async function openFirstSocket() {
    const { chrome, events } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await mod.__test__.startServing();
    const socket = MockWebSocket.instances.at(-1)!;
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { chrome, events, mod, socket };
  }

  it('reports a stable profileId in hello and in windows events', async () => {
    const { chrome, events, socket } = await openFirstSocket();

    const hello = socket.messages().find((message) => message.type === 'hello');
    expect(hello.profileId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Persisted, so a later worker lifetime reports the same identity.
    const stored = await chrome.storage.local.get('ttBridgeProfileId');
    expect(stored.ttBridgeProfileId).toBe(hello.profileId);

    events.tabsActivated.emit({ tabId: 2, windowId: 2 });
    await new Promise((resolve) => setTimeout(resolve, TOPOLOGY_DEBOUNCE_MS + 150));

    const topology = socket.messages().find((message) => message.type === 'windows');
    expect(topology.profileId).toBe(hello.profileId);
  });

  it('reuses the persisted profileId instead of minting a new one', async () => {
    const { chrome } = createChromeMock();
    await chrome.storage.local.set({ ttBridgeProfileId: 'profile-from-an-earlier-run' });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await mod.__test__.startServing();
    const socket = MockWebSocket.instances.at(-1)!;
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const hello = socket.messages().find((message) => message.type === 'hello');
    expect(hello.profileId).toBe('profile-from-an-earlier-run');
  });

  it('keeps the same profileId across a reconnect', async () => {
    const { socket } = await openFirstSocket();
    const firstHello = socket.messages().find((message) => message.type === 'hello');
    expect(firstHello.profileId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 700));

    const reconnected = MockWebSocket.instances.at(-1)!;
    expect(reconnected).not.toBe(socket);
    reconnected.open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reconnected.messages().find((message) => message.type === 'hello').profileId)
      .toBe(firstHello.profileId);
  });
});

describe('popup profile alias', () => {
  /** Test seam: each test needs a fresh worker module after vi.resetModules(). */
  async function loadBackground() {
    return await import('./background');
  }

  function isPopupState(value: unknown): value is { profileName: string } {
    return typeof value === 'object'
      && value !== null
      && 'profileName' in value
      && typeof value.profileName === 'string';
  }

  beforeEach(() => {
    vi.resetModules();
    MockWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the daemon-resolved Chrome profile alias', async () => {
    const { chrome } = createChromeMock();
    await chrome.storage.local.set({ ttBridgeProfileId: 'profile-known' });
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        ok: true,
        running: true,
        host: '127.0.0.1',
        port: DEFAULT_DAEMON_PORT,
        instances: [
          { profileId: 'someone-else', label: 'chrome-aaaa', profileName: 'Wrong Profile' },
          { profileId: 'profile-known', label: 'chrome-bbbb', profileName: 'Work Chrome' },
        ],
      }),
    })));

    const mod = await loadBackground();
    const state = await mod.__test__.getPopupState();

    expect(state.profileName).toBe('Work Chrome');
    expect(state.profileEmail).toBe('tester@example.com');
  });

  it('falls back to the local override when the daemon is unreachable', async () => {
    const { chrome } = createChromeMock();
    await chrome.storage.local.set({ ttBridgeProfileName: 'Local Alias' });
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));

    const mod = await loadBackground();
    const info = await mod.__test__.collectPopupWindowInfo();

    expect(info.profileName).toBe('Local Alias');
    expect(info.profileEmail).toBe('tester@example.com');
  });

  it('prefers the local override over the daemon alias', async () => {
    const { chrome } = createChromeMock();
    await chrome.storage.local.set({ ttBridgeProfileId: 'profile-known', ttBridgeProfileName: 'Local Alias' });
    vi.stubGlobal('chrome', chrome);
    const fetchStub = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        ok: true,
        running: true,
        host: '127.0.0.1',
        port: DEFAULT_DAEMON_PORT,
        instances: [{ profileId: 'profile-known', label: 'chrome-cccc', profileName: 'Daemon Alias' }],
      }),
    }));
    vi.stubGlobal('fetch', fetchStub);

    const mod = await loadBackground();
    const info = await mod.__test__.collectPopupWindowInfo();

    expect(info.profileName).toBe('Local Alias');
    expect(fetchStub).toHaveBeenCalled();
  });

  it('persists a profile rename and returns it in the popup state', async () => {
    const { chrome, events } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));

    const mod = await loadBackground();

    // The listener answers through a callback, and the compile target is ES2022,
    // so Promise.withResolvers is not in the lib: the executor form is required.
    const response = await new Promise<unknown>((resolve) => {
      events.runtimeMessages.emit(
        { type: 'ttbridge:set-profile-name', name: '  Work Chrome  ' },
        null,
        resolve,
      );
    });

    const stored = await chrome.storage.local.get('ttBridgeProfileName');
    expect(stored.ttBridgeProfileName).toBe('Work Chrome');
    expect(isPopupState(response) ? response.profileName : undefined).toBe('Work Chrome');
    expect((await mod.__test__.collectPopupWindowInfo()).profileName).toBe('Work Chrome');
  });
});

describe('tab context in command results (url & title)', () => {
  beforeEach(() => {
    vi.resetModules();
    MockWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches tab url and title on successful command returns without polluting data', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');

    // Tab 1 has url: 'https://automation.example', title: 'automation'
    const execRes = await mod.__test__.handleExec(
      { id: 't1', action: 'exec', code: '1 + 1', tabId: 1 },
      'human',
    );
    expect(execRes.ok).toBe(true);
    expect(execRes.url).toBe('https://automation.example');
    expect(execRes.title).toBe('automation');
    expect(execRes.data).toBe(1);

    const inputRes = await mod.__test__.handleInput(
      { id: 't2', action: 'input', text: 'hello', tabId: 1 },
      'human',
    );
    expect(inputRes.ok).toBe(true);
    expect(inputRes.url).toBe('https://automation.example');
    expect(inputRes.title).toBe('automation');
    expect(inputRes.data).toEqual({ inserted: 5, tabId: 1 });

    const keyRes = await mod.__test__.handleKey(
      { id: 't3', action: 'key', key: 'Enter', tabId: 1 },
      'human',
    );
    expect(keyRes.ok).toBe(true);
    expect(keyRes.url).toBe('https://automation.example');
    expect(keyRes.title).toBe('automation');
    expect(keyRes.data).toEqual({ pressed: 'Enter' });

    // Tab 2 has url: 'https://user.example', title: 'user'
    const screenshotRes = await mod.__test__.handleScreenshot(
      { id: 't4', action: 'screenshot', tabId: 2 },
      'human',
    );
    expect(screenshotRes.ok).toBe(true);
    expect(screenshotRes.url).toBe('https://user.example');
    expect(screenshotRes.title).toBe('user');

    // Focus on element
    const originalSendCommand = chrome.debugger.sendCommand;
    (chrome.debugger.sendCommand as any) = vi.fn(async (target: any, method: string, params: any) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params?.expression ?? '');
        if (expr.includes('getBoundingClientRect')) {
          return { result: { type: 'object', value: { x: 100, y: 200 } } };
        }
      }
      return originalSendCommand(target, method, params);
    });

    const focusRes = await mod.__test__.handleFocus(
      { id: 't5', action: 'focus', selector: 'button.submit', tabId: 1 },
      'human',
    );
    expect(focusRes.ok).toBe(true);
    expect(focusRes.url).toBe('https://automation.example');
    expect(focusRes.title).toBe('automation');
    expect(focusRes.data).toEqual({ selector: 'button.submit', x: 100, y: 200, tabId: 1 });

    // Navigate to a new url
    const navRes = await mod.__test__.handleNavigate(
      { id: 't6', action: 'navigate', url: 'https://nav.example', tabId: 1 },
      'human',
    );
    expect(navRes.ok).toBe(true);
    expect(navRes.url).toBe('https://nav.example');
    expect(navRes.title).toBe('automation');
    expect(navRes.data).toMatchObject({ url: 'https://nav.example', tabId: 1, timedOut: false });
  });

  it('refuses navigate to non-http(s) URL schemes without touching the tab', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./background');

    for (const url of ['chrome://settings', 'file:///etc/hosts', 'javascript:alert(1)']) {
      const res = await mod.__test__.handleNavigate(
        { id: `bad-nav-${url}`, action: 'navigate', url, tabId: 1 },
        'human',
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain('non-http(s)');
    }
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('allows about:blank navigation', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./background');

    const res = await mod.__test__.handleNavigate(
      { id: 'blank-nav', action: 'navigate', url: 'about:blank', tabId: 1 },
      'human',
    );
    expect(res.ok).toBe(true);
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: 'about:blank' });
  });

  it('omits url and title when chrome.tabs.get throws, keeping ok: true and data intact', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');

    const originalGet = chrome.tabs.get;
    chrome.tabs.get = vi.fn(async (id: number) => {
      const stack = new Error().stack ?? '';
      if (stack.includes('getTabContext')) {
        throw new Error('Tab lookup failed');
      }
      return originalGet(id);
    });

    const execRes = await mod.__test__.handleExec(
      { id: 'fail-get-1', action: 'exec', code: '1 + 1', tabId: 1 },
      'human',
    );
    expect(execRes.ok).toBe(true);
    expect('url' in execRes).toBe(false);
    expect('title' in execRes).toBe(false);
    expect(execRes.data).toBe(1);

    const keyRes = await mod.__test__.handleKey(
      { id: 'fail-get-2', action: 'key', key: 'Enter', tabId: 1 },
      'human',
    );
    expect(keyRes.ok).toBe(true);
    expect('url' in keyRes).toBe(false);
    expect('title' in keyRes).toBe(false);
    expect(keyRes.data).toEqual({ pressed: 'Enter' });
  });

  it('omits url and title when tab does not provide them', async () => {
    const { chrome, tabs } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    tabs.push({ id: 99, windowId: 1, active: true, status: 'complete' });

    const mod = await import('./background');
    const keyRes = await mod.__test__.handleKey(
      { id: 'no-meta', action: 'key', key: 'Tab', tabId: 99 },
      'human',
    );
    expect(keyRes.ok).toBe(true);
    expect('url' in keyRes).toBe(false);
    expect('title' in keyRes).toBe(false);
    expect(keyRes.data).toEqual({ pressed: 'Tab' });
  });
});
