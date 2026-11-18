/**
 * CDP execution via chrome.debugger API.
 *
 * chrome.debugger only needs the "debugger" permission — no host_permissions.
 * It can attach to any http/https tab. Avoid chrome:// and chrome-extension://
 * tabs (resolveTabId in background.ts filters them).
 */

const attached = new Set<number>();

/** Check if a URL can be attached via CDP */
function isDebuggableUrl(url?: string): boolean {
  if (!url) return true;  // empty/undefined = tab still loading, allow it
  return !url.startsWith('chrome://')
    && !url.startsWith('chrome-extension://')
    && !url.startsWith('file://')
    && !url.startsWith('view-source:')
    && !url.startsWith('devtools://');
}

function logDebuggerFailure(tabId: number, url: string | undefined, message: string): void {
  const lastError = chrome.runtime.lastError?.message;
  console.error('[agent-browser-bridge] debugger.attach failed', {
    tabId,
    url: url ?? 'unknown',
    message,
    ...(lastError ? { lastError } : {}),
  });
}

/** Reason of the most recent chrome.debugger.onDetach event, for error diagnostics. */
let lastDetachReason: string | null = null;

/** Fetch a tab URL for diagnostics; 'unknown' when the tab is gone. */
async function tabUrlForDiagnostics(tabId: number): Promise<string> {
  try {
    return (await chrome.tabs.get(tabId)).url ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Append actionable guidance when a command fails because the debugger
 * session is gone. If Chrome cancelled this extension's debugger session
 * (user pressed Cancel on the debug banner, or the profile auto-revokes it),
 * point the user at the per-profile fix; otherwise stay generic.
 */
function withDetachHint(message: string): string {
  if (!/Debugger is not attached/i.test(message)) return message;
  if (lastDetachReason === 'canceled_by_user') {
    return `${message} Chrome cancelled this extension's debugger session in this profile `
      + `(reason: canceled_by_user) — re-add the extension in chrome://extensions for this `
      + `profile, or allow the "TT Bridge is debugging this browser" banner instead of cancelling it.`;
  }
  if (lastDetachReason) {
    return `${message} (last debugger detach reason: ${lastDetachReason})`;
  }
  return message;
}

/**
 * chrome.debugger.sendCommand wrapper: logs one console.error line (tabId,
 * tab URL, CDP method, raw Chrome message + runtime.lastError) on failure,
 * then rethrows the original error untouched. Silent on success.
 */
async function sendCdpCommand<R = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<R> {
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params) as R;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const lastError = chrome.runtime.lastError?.message;
    console.error('[agent-browser-bridge] debugger.sendCommand failed', {
      tabId,
      url: await tabUrlForDiagnostics(tabId),
      method,
      message,
      ...(lastError ? { lastError } : {}),
    });
    if (e instanceof Error) {
      e.message = withDetachHint(e.message);
      throw e;
    }
    throw new Error(withDetachHint(message));
  }
}

async function ensureAttached(tabId: number): Promise<void> {
  let tabUrl: string | undefined;
  try {
    const tab = await chrome.tabs.get(tabId);
    tabUrl = tab.url || tab.pendingUrl;
  } catch (e) {
    attached.delete(tabId);
    const message = e instanceof Error ? e.message : String(e);
    logDebuggerFailure(tabId, tabUrl, message);
    throw new Error(`Tab ${tabId} no longer exists`);
  }

  const url = tabUrl ?? '';
  if (!isDebuggableUrl(url)) {
    attached.delete(tabId);
    const errMessage = `Tab ${tabId} is a restricted page (${url}). Switch to a normal page, or re-pin with "tt-bridge tab pin".`;
    logDebuggerFailure(tabId, tabUrl, errMessage);
    throw new Error(errMessage);
  }

  if (attached.has(tabId)) {
    // Verify the debugger is still actually attached by sending a harmless command
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1', returnByValue: true,
      });
      return; // Still attached and working
    } catch (e) {
      // Stale cache entry — need to re-attach
      attached.delete(tabId);
      console.error('[agent-browser-bridge] debugger attach cache stale, re-attaching', {
        tabId,
        url: tabUrl ?? 'unknown',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = msg.includes('chrome-extension://')
      ? '. Tip: another Chrome extension may be interfering — try disabling other extensions'
      : '';
    logDebuggerFailure(tabId, tabUrl, msg);
    if (msg.includes('Another debugger is already attached')) {
      try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
      } catch (retryError) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
        logDebuggerFailure(tabId, tabUrl, `retry after detach also failed: ${retryMsg}`);
        throw new Error(withDetachHint(`attach failed: ${msg}${hint}`));
      }
    } else {
      throw new Error(withDetachHint(`attach failed: ${msg}${hint}`));
    }
  }
  attached.add(tabId);

  try {
    await sendCdpCommand(tabId, 'Runtime.enable');
  } catch {
    // Some pages may not need explicit enable — the wrapper already logged it.
  }
}

export async function evaluate(tabId: number, expression: string): Promise<unknown> {
  await ensureAttached(tabId);

  const result = await sendCdpCommand<{
    result?: { type: string; value?: unknown; description?: string; subtype?: string };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  }>(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });

  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Eval error';
    throw new Error(errMsg);
  }

  return result.result?.value;
}

export const evaluateAsync = evaluate;

/**
 * Capture a screenshot via CDP Page.captureScreenshot.
 * Returns base64-encoded image data.
 */
export async function screenshot(
  tabId: number,
  options: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; mobile?: boolean } = {},
): Promise<string> {
  await ensureAttached(tabId);

  const format = options.format ?? 'png';

  // For full-page screenshots, get the full page dimensions first
  if (options.fullPage) {
    // Get full page metrics
    const metrics = await sendCdpCommand<{
      contentSize?: { width: number; height: number };
      cssContentSize?: { width: number; height: number };
    }>(tabId, 'Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize;
    if (size) {
      // Set device metrics to full page size
      await sendCdpCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
        mobile: Boolean(options.mobile),
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        deviceScaleFactor: 1,
      });
    }
  }

  try {
    const params: Record<string, unknown> = { format };
    if (format === 'jpeg' && options.quality !== undefined) {
      params.quality = Math.max(0, Math.min(100, options.quality));
    }

    const result = await sendCdpCommand<{ data: string }>(tabId, 'Page.captureScreenshot', params);

    return result.data;
  } finally {
    // Reset device metrics if we changed them for full-page
    if (options.fullPage) {
      await sendCdpCommand(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
  }
}

/**
 * Insert text as TRUSTED input via CDP Input.insertText.
 * Works with React/Slate-style editors that ignore JS-synthesized events.
 */
export async function insertText(tabId: number, text: string): Promise<void> {
  await ensureAttached(tabId);
  await sendCdpCommand(tabId, 'Input.insertText', { text });
}

/**
 * Send a TRUSTED left mouse click at viewport coordinates (x, y) via CDP
 * Input.dispatchMouseEvent (mousePressed then mouseReleased).
 */
export async function mouseClickAt(tabId: number, x: number, y: number): Promise<void> {
  await ensureAttached(tabId);
  const base = { x, y, button: 'left' as const, clickCount: 1 };
  await sendCdpCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...base,
  });
  await sendCdpCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...base,
  });
}

/** Fixed key map: name -> CDP Input.dispatchKeyEvent fields */
const KEY_DEFINITIONS: Record<string, {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
};

/**
 * Send a TRUSTED key press via CDP Input.dispatchKeyEvent (keyDown then keyUp).
 * For Enter, `text: '\r'` is included on keyDown so React/Slate-style editors
 * register a real newline / paragraph break.
 */
export async function pressKey(tabId: number, key: string): Promise<void> {
  const def = KEY_DEFINITIONS[key];
  if (!def) {
    throw new Error(
      `Unsupported key: ${key}. Supported keys: ${Object.keys(KEY_DEFINITIONS).join(', ')}`,
    );
  }

  await ensureAttached(tabId);

  const base = {
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.windowsVirtualKeyCode,
    nativeVirtualKeyCode: def.windowsVirtualKeyCode,
  };
  const keyDownParams: Record<string, unknown> = { type: 'keyDown', ...base };
  if (def.text !== undefined) {
    keyDownParams.text = def.text;
  }

  await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', keyDownParams);
  await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// ─── Device & viewport emulation ─────────────────────────────────────

export interface DeviceMetricsOptions {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
}

export interface DevicePreset extends DeviceMetricsOptions {
  deviceScaleFactor: number;
  mobile: boolean;
  /** Whether touch emulation should be enabled for this device */
  touch: boolean;
  /** Mobile user agent string for Network.setUserAgentOverride */
  userAgent: string;
}

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

/**
 * Built-in device presets. Keys are lowercased and stripped of separators,
 * so "iPhone 14 Pro", "iphone-14-pro" and "iphone14pro" all resolve.
 */
export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  iphone14: {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent: IOS_UA,
  },
  iphone14pro: {
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent: IOS_UA,
  },
  iphone14promax: {
    width: 430,
    height: 932,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent: IOS_UA,
  },
  iphonese: {
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgent: IOS_UA,
  },
  ipad: {
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgent: IPAD_UA,
  },
  ipadpro: {
    width: 1024,
    height: 1366,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgent: IPAD_UA,
  },
  pixel7: {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    touch: true,
    userAgent: ANDROID_UA,
  },
  galaxys23: {
    width: 360,
    height: 780,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent: ANDROID_UA,
  },
};

/** Normalize a preset name: lowercase and strip non-alphanumerics. */
export function normalizeDeviceName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Resolve a device preset by (loosely matched) name. */
export function getDevicePreset(name: string): DevicePreset | undefined {
  return DEVICE_PRESETS[normalizeDeviceName(name)];
}

export function listDevicePresets(): Array<{ name: string } & DevicePreset> {
  return Object.entries(DEVICE_PRESETS).map(([name, preset]) => ({ name, ...preset }));
}

/**
 * Override viewport size / DPR / mobile flag via Emulation.setDeviceMetricsOverride.
 * `screenOrientation` is included so mobile emulation matches the portrait viewport.
 */
export async function setDeviceMetrics(tabId: number, options: DeviceMetricsOptions): Promise<void> {
  await ensureAttached(tabId);
  const mobile = Boolean(options.mobile);
  await sendCdpCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
    width: Math.ceil(options.width),
    height: Math.ceil(options.height),
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
    mobile,
    screenOrientation: mobile
      ? { type: 'portraitPrimary', angle: 0 }
      : { type: 'landscapePrimary', angle: 0 },
  });
}

/** Clear any viewport override via Emulation.clearDeviceMetricsOverride. */
export async function clearDeviceMetrics(tabId: number): Promise<void> {
  await ensureAttached(tabId);
  await sendCdpCommand(tabId, 'Emulation.clearDeviceMetricsOverride');
}

/** Enable/disable touch emulation via Emulation.setTouchEmulationEnabled. */
export async function setTouchEmulation(tabId: number, enabled: boolean): Promise<void> {
  await ensureAttached(tabId);
  await sendCdpCommand(tabId, 'Emulation.setTouchEmulationEnabled', {
    enabled,
    maxTouchPoints: enabled ? 5 : 1,
  });
}

/**
 * Override the User-Agent via Network.setUserAgentOverride.
 * An empty string clears the override.
 */
export async function setUserAgentOverride(tabId: number, userAgent: string): Promise<void> {
  await ensureAttached(tabId);
  await sendCdpCommand(tabId, 'Network.setUserAgentOverride', {
    userAgent: userAgent || '',
  });
}

export function detach(tabId: number): void {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
}

/** Release every debugger attachment; stops the "being debugged" banner remnants. */
export function detachAll(): void {
  for (const tabId of [...attached]) {
    detach(tabId);
  }
}

export function registerListeners(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId) attached.delete(source.tabId);
    lastDetachReason = reason ?? 'unknown';
    console.error('[agent-browser-bridge] debugger detached', {
      tabId: source.tabId ?? null,
      reason: reason ?? 'unknown',
      ...(reason === 'replaced_with_devtools'
        ? { hint: 'user pressed Cancel on the Chrome debug banner (or opened DevTools)' }
        : {}),
    });
  });
  // Invalidate attached cache when tab URL changes to non-debuggable
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.url && !isDebuggableUrl(info.url)) {
      if (attached.has(tabId)) {
        attached.delete(tabId);
        try { chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
      }
    }
  });
}
