import { WebSocket } from 'ws';
import { readChromeProfiles, resolveProfileName } from './chrome-profiles.mjs';

export const DEFAULT_TOMBSTONE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_TARGET_WAIT_MS = 3000;

export function normalizeKey(label) {
  return typeof label === 'string' ? label.trim().toLowerCase() : '';
}

export function readProfileId(payload) {
  const value = payload?.profileId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function isForeignProfile(holder, profileId) {
  return Boolean(holder.profileId && profileId && holder.profileId !== profileId);
}

export function formatTargetOfflineError(target, connected) {
  const label = target.label || target.key || '(unknown)';
  const prof = target.profileName ? target.profileName : '(unknown profile)';
  const pin = target.pinnedTabId !== null && target.pinnedTabId !== undefined ? target.pinnedTabId : 'none';
  const connStr = connected && connected.length > 0
    ? connected.map((c) => `"${c.label}" (${c.profileName || 'unknown profile'})`).join(', ')
    : '(none)';

  return `Target instance "${label}" (Profile: "${prof}", pinned tab ${pin}) is offline; current online instances: ${connStr}. Refusing to drift to another Chrome profile while a pin is active; open that profile or pass --force.`;
}

export class TargetRegistry {
  constructor(options = {}) {
    this.tombstoneTtlMs = options.tombstoneTtlMs ?? Number(process.env.AGENT_BROWSER_BRIDGE_TOMBSTONE_TTL_MS || String(DEFAULT_TOMBSTONE_TTL_MS));
    this.targetWaitMs = options.targetWaitMs ?? Number(process.env.AGENT_BROWSER_BRIDGE_TARGET_WAIT_MS || String(DEFAULT_TARGET_WAIT_MS));
    this.instances = new Map();
    this.targetWaiters = new Map();
    this.ownerKey = null;
    this.designatedLabel = options.initialDesignatedLabel ?? (normalizeKey(process.env.AGENT_BROWSER_BRIDGE_INSTANCE || '') || null);
    this.unlabeledCounter = 0;
    this.log = options.log || console.error.bind(console, '[agent-browser-bridge:daemon]');
    this.getProfiles = options.getProfiles || readChromeProfiles;
  }

  isSocketOpen(ws) {
    return Boolean(ws && ws.readyState === WebSocket.OPEN);
  }

  connectedInstances() {
    return [...this.instances.values()].filter((entry) => this.isSocketOpen(entry.ws));
  }

  pruneExpiredTombstones(now = Date.now()) {
    for (const [key, entry] of this.instances.entries()) {
      if (entry.disconnectedAt && (now - entry.disconnectedAt > this.tombstoneTtlMs)) {
        this.instances.delete(key);
        if (this.ownerKey === key) {
          this.ownerKey = null;
        }
        if (this.designatedLabel === key) {
          this.designatedLabel = null;
        }
        this.log(`Tombstone expired and pruned for instance "${entry.label || key}"`);
      }
    }
  }

  assignInstanceKey(entry, baseKey, profileId) {
    const holder = this.instances.get(baseKey);
    if (!holder || holder === entry || !isForeignProfile(holder, profileId)) {
      return baseKey;
    }

    if (entry.key && entry.key.startsWith(`${baseKey}-`) && this.instances.get(entry.key) === entry) {
      return entry.key;
    }

    let suffix = 2;
    while (this.instances.has(`${baseKey}-${suffix}`) && this.instances.get(`${baseKey}-${suffix}`) !== entry) {
      suffix += 1;
    }
    return `${baseKey}-${suffix}`;
  }

  lookupInstanceByLabel(labelKey) {
    this.pruneExpiredTombstones();
    const exact = this.instances.get(labelKey);
    if (exact) {
      return { entry: exact };
    }
    const candidates = [...this.instances.values()].filter((entry) => entry.key && entry.key.startsWith(`${labelKey}-`));
    if (candidates.length === 1) {
      return { entry: candidates[0] };
    }
    if (candidates.length > 1) {
      return {
        error: `"${labelKey}" matches ${candidates.length} instances sharing that label: ${candidates.map((entry) => entry.key).join(', ')}. Use the disambiguated key as target "<key>:<windowId>".`,
      };
    }
    return null;
  }

  evictInstance(entry, reason, instancesBySocket) {
    if (instancesBySocket && entry.ws) {
      instancesBySocket.delete(entry.ws);
    }
    if (entry.key && this.instances.get(entry.key) === entry) {
      this.instances.delete(entry.key);
    }
    if (entry.ws) {
      try {
        entry.ws.close(1000, reason);
      } catch {
        // Ignore close errors
      }
    }
  }

  listInstanceLabels() {
    const connected = this.connectedInstances();
    const counts = new Map();
    for (const entry of connected) {
      const label = entry.label || entry.key || '(unknown)';
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    const labels = connected.map((entry) => {
      const label = entry.label || entry.key || '(unknown)';
      return counts.get(label) > 1 ? `${label} [${entry.key}]` : label;
    });
    return labels.length ? labels.join(', ') : '(none)';
  }

  registerHello(entry, hello, instancesBySocket) {
    this.pruneExpiredTombstones();
    const rawLabel = typeof hello.label === 'string' && hello.label.trim() ? hello.label.trim() : null;
    const baseKey = rawLabel ? normalizeKey(rawLabel) : `unlabeled-${++this.unlabeledCounter}`;
    const profileId = readProfileId(hello);

    entry.pinnedTabId = typeof hello.pinnedTabId === 'number' ? hello.pinnedTabId : null;
    entry.disconnectedAt = null;

    let oldHeldKey = null;
    if (profileId) {
      entry.profileId = profileId;
      for (const other of [...this.instances.values()]) {
        if (other !== entry && other.profileId === profileId) {
          oldHeldKey = other.key;
          this.evictInstance(other, 'Superseded by a newer connection from the same profile', instancesBySocket);
        }
      }
    }

    const key = this.assignInstanceKey(entry, baseKey, profileId);
    const previousKey = entry.key;
    if (previousKey && previousKey !== key && this.instances.get(previousKey) === entry) {
      this.instances.delete(previousKey);
    }

    entry.key = key;
    entry.label = rawLabel || `unlabeled (${key})`;
    entry.hello = hello;
    entry.windows = Array.isArray(hello.windowList) ? hello.windowList : [];
    entry.windowCount = typeof hello.windows === 'number' ? hello.windows : entry.windows.length;
    entry.tabCount = typeof hello.tabs === 'number' ? hello.tabs : 0;
    entry.profile = (hello.profile && typeof hello.profile === 'object') ? hello.profile : null;
    entry.selectedWindowId = typeof hello.selectedWindowId === 'number' ? hello.selectedWindowId : null;
    entry.connectedAt = entry.connectedAt || Date.now();
    this.instances.set(key, entry);

    if (this.ownerKey && (this.ownerKey === previousKey || this.ownerKey === oldHeldKey)) {
      this.ownerKey = key;
    }
    if (this.designatedLabel && (this.designatedLabel === previousKey || this.designatedLabel === oldHeldKey)) {
      this.designatedLabel = key;
    }

    if (entry.pinnedTabId !== null && !this.designatedLabel) {
      this.designatedLabel = entry.key;
      this.log(`Auto-designated instance "${entry.label}" with pinned tab ${entry.pinnedTabId}`);
    }

    if (!this.ownerKey && !this.designatedLabel && this.connectedInstances().length === 1) {
      this.ownerKey = key;
      this.log(`Adopted instance "${entry.label}" as owner`);
    } else if (this.ownerKey && this.ownerKey !== key) {
      this.log(`Instance "${entry.label}" connected; owner remains "${this.instances.get(this.ownerKey)?.label || this.ownerKey}"`);
    } else if (key !== baseKey) {
      this.log(`Instance "${entry.label}" shares a label with another profile; registered as "${key}"`);
    } else {
      this.log(`Extension hello: id=${hello.extensionId || 'unknown'} version=${hello.version || 'unknown'} label=${entry.label} profileId=${profileId || 'unknown'}`);
    }

    this.notifyTargetReconnected(key);
    if (oldHeldKey && oldHeldKey !== key) {
      this.notifyTargetReconnected(oldHeldKey);
    }
    if (baseKey && baseKey !== key) {
      this.notifyTargetReconnected(baseKey);
    }
  }

  handleSocketClose(entry) {
    if (!entry) return;
    entry.disconnectedAt = Date.now();
    this.log(`Extension disconnected${entry.label ? ` (${entry.label})` : ''}`);
    if (this.ownerKey && entry.key === this.ownerKey) {
      this.log(`Owner "${entry.label || entry.key}" disconnected; ownership held until it reconnects (or switch with "tt-bridge instance use/clear")`);
    }
  }

  buildTargetOfflineResult(entry, profiles) {
    const profileName = resolveProfileName(entry.profile, profiles) || entry.profile?.profileName || '';
    const target = {
      key: entry.key,
      label: entry.label || entry.key,
      profileName,
      pinnedTabId: entry.pinnedTabId ?? null,
      disconnectedAt: entry.disconnectedAt,
    };
    const connected = this.connectedInstances().map((e) => ({
      label: e.label || e.key,
      profileName: resolveProfileName(e.profile, profiles) || e.profile?.profileName || '',
    }));
    const error = formatTargetOfflineError(target, connected);
    return {
      code: 'TARGET_OFFLINE',
      error,
      target,
      connected,
    };
  }

  resolveTarget() {
    this.pruneExpiredTombstones();
    const { profiles } = this.getProfiles();

    if (this.designatedLabel) {
      const designated = this.instances.get(this.designatedLabel);
      if (designated && this.isSocketOpen(designated.ws)) {
        return { entry: designated };
      }
      if (designated && designated.disconnectedAt) {
        return this.buildTargetOfflineResult(designated, profiles);
      }
      return {
        error: `Designated instance "${this.designatedLabel}" is not connected. Connected instances: ${this.listInstanceLabels()}`,
      };
    }

    if (this.ownerKey) {
      const owner = this.instances.get(this.ownerKey);
      if (owner && this.isSocketOpen(owner.ws)) {
        return { entry: owner };
      }
      if (owner && owner.disconnectedAt) {
        return this.buildTargetOfflineResult(owner, profiles);
      }
      return {
        error: `Owner instance "${this.ownerKey}" is currently disconnected; ownership is held for its reconnect. Wait a moment, or switch explicitly: "tt-bridge instance use <label>" / "tt-bridge instance clear". Connected instances: ${this.listInstanceLabels()}`,
      };
    }

    const connected = this.connectedInstances();
    if (connected.length === 0) {
      return { error: 'Extension not connected' };
    }
    if (connected.length === 1) {
      this.ownerKey = connected[0].key;
      this.log(`Adopted instance "${connected[0].label || connected[0].key}" as owner`);
      return { entry: connected[0] };
    }
    return {
      error: `Multiple Chrome instances are serving: ${this.listInstanceLabels()}. Choose one with "tt-bridge instance use <label>".`,
    };
  }

  getCurrentTargetEntry() {
    this.pruneExpiredTombstones();
    if (this.designatedLabel && this.instances.has(this.designatedLabel)) {
      return this.instances.get(this.designatedLabel);
    }
    if (this.ownerKey && this.instances.has(this.ownerKey)) {
      return this.instances.get(this.ownerKey);
    }
    return null;
  }

  waitForTarget(targetKey, timeoutMs = this.targetWaitMs) {
    if (!targetKey) {
      return Promise.resolve(false);
    }
    const current = this.instances.get(targetKey);
    if (current && this.isSocketOpen(current.ws)) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let timer = null;
      const waiter = {
        resolve: (val) => {
          if (timer) clearTimeout(timer);
          resolve(val);
        },
        timer: null,
      };
      timer = setTimeout(() => {
        this.removeTargetWaiter(targetKey, waiter);
        resolve(false);
      }, timeoutMs);
      waiter.timer = timer;

      if (!this.targetWaiters.has(targetKey)) {
        this.targetWaiters.set(targetKey, new Set());
      }
      this.targetWaiters.get(targetKey).add(waiter);
    });
  }

  removeTargetWaiter(targetKey, waiter) {
    const set = this.targetWaiters.get(targetKey);
    if (set) {
      set.delete(waiter);
      if (set.size === 0) {
        this.targetWaiters.delete(targetKey);
      }
    }
  }

  notifyTargetReconnected(key) {
    if (!key) return;
    const set = this.targetWaiters.get(key);
    if (set) {
      for (const waiter of set) {
        waiter.resolve(true);
      }
      this.targetWaiters.delete(key);
    }
  }

  clearWaiters() {
    for (const set of this.targetWaiters.values()) {
      for (const waiter of set) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(false);
      }
    }
    this.targetWaiters.clear();
  }

  checkPinHeld({ currentTarget, newProfileId, newKey, force }) {
    if (force === true) {
      return { allowed: true };
    }
    if (!currentTarget || !currentTarget.disconnectedAt || currentTarget.pinnedTabId === null) {
      return { allowed: true };
    }
    const isDifferentProfile = (currentTarget.profileId && newProfileId)
      ? currentTarget.profileId !== newProfileId
      : (currentTarget.key && newKey ? currentTarget.key !== newKey : true);

    if (!isDifferentProfile) {
      return { allowed: true };
    }

    const { profiles } = this.getProfiles();
    const currentProfileName = resolveProfileName(currentTarget.profile, profiles) || currentTarget.profile?.profileName || '';
    const target = {
      label: currentTarget.label || currentTarget.key,
      profileName: currentProfileName,
      pinnedTabId: currentTarget.pinnedTabId,
      disconnectedAt: currentTarget.disconnectedAt,
    };
    const error = `Cannot switch profile while active pin is held on offline instance "${target.label}" (Profile: "${target.profileName || 'unknown'}", pinned tab ${target.pinnedTabId}). Use --force to override.`;

    return {
      allowed: false,
      code: 'PIN_HELD',
      error,
      target,
    };
  }
}
