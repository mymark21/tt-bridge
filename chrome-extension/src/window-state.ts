/**
 * Window + profile awareness for this Chrome profile.
 *
 * The daemon must know how many windows this profile has open, which window the
 * bridge currently targets, and enough identity (email/gaia id) to map the
 * instance to a Chrome profile. Chrome exposes no profile display name to
 * extensions, so the daemon resolves that from `Local State`; this module only
 * reports what Chrome will tell us, best-effort.
 *
 * Every helper here degrades instead of throwing: a missing permission, a
 * missing API (e.g. `chrome.storage.session` in some contexts) or a rejected
 * call must never break command handling.
 */

import type { ProfileDescriptor, WindowSnapshot } from './protocol';

/** chrome.storage.session key holding the window the bridge currently targets. */
export const SELECTED_WINDOW_KEY = 'ttBridgeSelectedWindowId';
/** chrome.storage.local key holding a user-set profile display name override. */
export const PROFILE_NAME_KEY = 'ttBridgeProfileName';
/** Coalescing window for topology change events pushed to the daemon (ms). */
export const TOPOLOGY_DEBOUNCE_MS = 250;

/**
 * Window types worth reporting. DevTools windows are never listed (Chrome's own
 * default filter is `['normal', 'popup']`; being explicit keeps panels/apps in
 * and DevTools out no matter what the default becomes).
 */
const REPORTED_WINDOW_TYPES: chrome.windows.windowTypeEnum[] = ['normal', 'popup', 'panel', 'app'];

// ─── Selected window (sticky automation target) ───────────────────────

let selectedWindowIdCache: number | null = null;

/** `chrome.storage.session` when this context has it, else null. */
export function getSessionStorageArea(): chrome.storage.StorageArea | null {
  try {
    return chrome.storage?.session ?? null;
  } catch {
    return null;
  }
}

/** The window commands resolve against when no tab is pinned or passed explicitly. */
export async function getSelectedWindowId(): Promise<number | null> {
  if (selectedWindowIdCache !== null) {
    return selectedWindowIdCache;
  }
  const area = getSessionStorageArea();
  if (!area) {
    return null;
  }
  try {
    const stored = await area.get(SELECTED_WINDOW_KEY);
    const value = stored[SELECTED_WINDOW_KEY];
    if (typeof value === 'number' && Number.isFinite(value)) {
      selectedWindowIdCache = value;
      return value;
    }
  } catch {
    // Best-effort persistence only.
  }
  return null;
}

/** Set (or with `null`, clear) the sticky target window. Never focuses anything. */
export async function setSelectedWindowId(windowId: number | null): Promise<void> {
  selectedWindowIdCache = windowId;
  const area = getSessionStorageArea();
  if (!area) {
    return;
  }
  try {
    if (windowId === null) {
      await area.remove(SELECTED_WINDOW_KEY);
    } else {
      await area.set({ [SELECTED_WINDOW_KEY]: windowId });
    }
  } catch {
    // The in-memory cache still covers this service-worker lifetime.
  }
}

// ─── Window snapshots ────────────────────────────────────────────────

/** Snapshot every window of this profile; DevTools windows are skipped. */
export async function buildWindowSnapshots(): Promise<WindowSnapshot[]> {
  const windows = await chrome.windows.getAll({
    populate: true,
    windowTypes: REPORTED_WINDOW_TYPES,
  });

  const snapshots: WindowSnapshot[] = [];
  for (const win of windows) {
    if (win.id === undefined || win.type === 'devtools') {
      continue;
    }
    const tabs = win.tabs ?? [];
    const activeTab = tabs.find((tab) => tab.active);
    snapshots.push({
      windowId: win.id,
      focused: Boolean(win.focused),
      state: win.state ?? 'normal',
      type: win.type ?? 'normal',
      incognito: Boolean(win.incognito),
      tabCount: tabs.length,
      activeTab: activeTab
        ? {
          tabId: activeTab.id ?? null,
          title: activeTab.title ?? '',
          url: activeTab.url ?? '',
        }
        : null,
    });
  }
  return snapshots;
}

/** Snapshot of one window, or null when it is closed (or is a DevTools window). */
export async function findWindowSnapshot(windowId: number): Promise<WindowSnapshot | null> {
  const snapshots = await buildWindowSnapshots();
  return snapshots.find((snapshot) => snapshot.windowId === windowId) ?? null;
}

// ─── Profile identity probes ─────────────────────────────────────────

/**
 * A user-set profile display name, or '' — the extension cannot read the Chrome
 * profile name, so only storage can answer this.
 */
export async function getProfileName(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get(PROFILE_NAME_KEY);
    const value = stored[PROFILE_NAME_KEY];
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/** Longest user-set profile name kept in storage. */
const MAX_PROFILE_NAME_LENGTH = 60;

/**
 * Persist (or with `''`, clear) the user-set profile name override. Returns the
 * value that was stored; storage failures degrade to `''` instead of throwing.
 */
export async function setProfileName(name: string): Promise<string> {
  const value = name.trim().slice(0, MAX_PROFILE_NAME_LENGTH);
  try {
    const local = chrome.storage?.local;
    if (value === '') {
      if (local?.remove) {
        await local.remove(PROFILE_NAME_KEY);
      } else {
        await local.set({ [PROFILE_NAME_KEY]: '' });
      }
      return '';
    }
    await local.set({ [PROFILE_NAME_KEY]: value });
    return value;
  } catch {
    return '';
  }
}

/**
 * `accountStatus: 'ANY'` (Chrome 84+) also reports accounts that are not syncing;
 * the default `SYNC` returns empty fields for signed-in-but-not-syncing profiles.
 */
const ANY_ACCOUNT_STATUS = 'ANY' as chrome.identity.AccountStatus;

/**
 * Signed-in account of this profile. Requires both `identity` and
 * `identity.email` in the manifest; `accountStatus: 'ANY'` also reports accounts
 * that are not syncing. Empty strings are a normal state (signed out, guest,
 * incognito) — never throw.
 */
export async function getProfileIdentity(): Promise<{ email: string; gaiaId: string }> {
  try {
    const identity = chrome.identity;
    if (!identity?.getProfileUserInfo) {
      return { email: '', gaiaId: '' };
    }
    const info = await identity.getProfileUserInfo({ accountStatus: ANY_ACCOUNT_STATUS });
    return { email: info?.email ?? '', gaiaId: info?.id ?? '' };
  } catch {
    return { email: '', gaiaId: '' };
  }
}

/** Convenience composition used by the popup and by tests. */
export async function describeProfile(label: string): Promise<ProfileDescriptor> {
  const [identity, name] = await Promise.all([getProfileIdentity(), getProfileName()]);
  return { label, email: identity.email, gaiaId: identity.gaiaId, name };
}

// ─── Topology change events ──────────────────────────────────────────

export type TopologyEmitter = () => void;

let listenersRegistered = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Subscribe to every event that changes the window/tab topology and coalesce
 * them into one `emit()` call per quiet period.
 *
 * Registration is synchronous (so a service-worker restart re-arms the listeners
 * immediately) and idempotent: calling it twice in one worker lifetime is a
 * no-op, which keeps MV3 re-initialization from double-emitting.
 */
export function registerTopologyListeners(emit: TopologyEmitter): boolean {
  if (listenersRegistered) {
    return false;
  }
  listenersRegistered = true;

  const schedule = () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      emit();
    }, TOPOLOGY_DEBOUNCE_MS);
  };

  chrome.windows.onCreated?.addListener(() => schedule());
  chrome.windows.onFocusChanged?.addListener(() => schedule());
  chrome.windows.onRemoved?.addListener((windowId) => {
    // Drop a selection whose window is gone before the next command resolves it.
    void clearSelectionForRemovedWindow(windowId);
    schedule();
  });
  chrome.tabs.onCreated?.addListener(() => schedule());
  chrome.tabs.onRemoved?.addListener(() => schedule());
  chrome.tabs.onActivated?.addListener(() => schedule());
  chrome.tabs.onUpdated?.addListener((_tabId, changeInfo) => {
    // Tab churn fires constantly; only settled pages and titles matter here.
    if (changeInfo.status === 'complete' || typeof changeInfo.title === 'string') {
      schedule();
    }
  });

  return true;
}

async function clearSelectionForRemovedWindow(windowId: number): Promise<void> {
  if ((await getSelectedWindowId()) === windowId) {
    await setSelectedWindowId(null);
  }
}
