import './popup.css';
import { buildConnectionInstruction, buildStartupInstruction } from './popup-instructions';
import { derivePopupMode } from './popup-mode';

type PopupState = {
  servingEnabled: boolean;
  port: number;
  statusText: string;
  connectionState: 'idle' | 'connecting' | 'waiting' | 'connected' | 'error';
  defaultPortBusy: boolean;
  /** True when a daemon answered the port scan; false means it is not running. */
  daemonDetected: boolean;
  instanceLabel: string;
  profileEmail: string;
  profileName: string;
  windowCount: number;
  selectedWindowId: number | null;
  windowSummary: string;
  activeTabTitle: string;
  activeTabId: number | null;
  activeWindowId: number | null;
  agentActivity: {
    active: boolean;
    tabId: number | null;
    action?: string;
    at?: number;
    endedAt?: number | null;
    recent?: boolean;
  } | null;
};

const popup = document.querySelector<HTMLElement>('#popup');
const statusLabel = document.querySelector<HTMLElement>('#status-label');
const headline = document.querySelector<HTMLElement>('#headline');
const subline = document.querySelector<HTMLElement>('#subline');
const primaryAction = document.querySelector<HTMLButtonElement>('#primary-action');
const primaryHint = document.querySelector<HTMLElement>('#primary-hint');
const secondaryAction = document.querySelector<HTMLButtonElement>('#secondary-action');
const windowCard = document.querySelector<HTMLElement>('#window-card');
const windowTitle = document.querySelector<HTMLElement>('#window-title');
const windowTabs = document.querySelector<HTMLElement>('#window-tabs');
const detailsToggle = document.querySelector<HTMLButtonElement>('#details-toggle');
const viewMain = document.querySelector<HTMLElement>('#view-main');
const viewDetails = document.querySelector<HTMLElement>('#view-details');
const detailsBack = document.querySelector<HTMLButtonElement>('#details-back');
const portValue = document.querySelector<HTMLElement>('#port-value');
const instanceInput = document.querySelector<HTMLInputElement>('#instance-input');
const profileValue = document.querySelector<HTMLElement>('#profile-value');
const profileNameInput = document.querySelector<HTMLInputElement>('#profile-name-input');
const statusText = document.querySelector<HTMLElement>('#status-text');
const version = document.querySelector<HTMLElement>('#version');
const footerNote = document.querySelector<HTMLElement>('#footer-note');

let currentState: PopupState | null = null;
let refreshTimer: number | null = null;
let copyHintTimer: number | null = null;

function parseTabCount(summary: string): number {
  const match = summary.match(/(\d+)\s+tabs?/i);
  return match ? parseInt(match[1], 10) : 0;
}

function maskProfileName(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return '未登录';
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const firstWord = parts[0];
    const initial = parts[1][0].toUpperCase();
    return `${firstWord} ${initial}.`;
  }
  const initial = parts[0][0].toUpperCase();
  return `${parts[0]} ${initial}.`;
}

function showDetails(): void {
  if (popup) {
    popup.setAttribute('data-view', 'details');
  }
  if (viewMain) {
    viewMain.hidden = true;
  }
  if (viewDetails) {
    viewDetails.hidden = false;
  }
  detailsToggle?.setAttribute('aria-expanded', 'true');
  detailsBack?.focus();
}

function showMain(): void {
  if (popup) {
    popup.setAttribute('data-view', 'main');
  }
  if (viewMain) {
    viewMain.hidden = false;
  }
  if (viewDetails) {
    viewDetails.hidden = true;
  }
  detailsToggle?.setAttribute('aria-expanded', 'false');
  detailsToggle?.focus();
}

function render(state: PopupState): void {
  currentState = state;
  const mode = derivePopupMode(state);
  const activity = state.agentActivity;
  const tabId = activity?.tabId ?? null;

  const endedAt = typeof activity?.endedAt === 'number' ? activity.endedAt : null;
  const isWithin10s = endedAt !== null && Date.now() - endedAt < 10000;
  const active = Boolean(activity && (activity.active === true || isWithin10s));
  const isWithin5m = endedAt !== null && Date.now() - endedAt < 300000;
  const recent = Boolean(!active && activity && (activity.recent === true || isWithin5m));

  const isReadyActive = mode === 'ready' && active;
  const isReadyRecent = mode === 'ready' && !active && recent;

  if (popup) {
    popup.setAttribute('data-mode', mode);
    popup.setAttribute('data-agent-active', isReadyActive ? 'true' : 'false');
    popup.setAttribute('data-agent-recent', isReadyRecent ? 'true' : 'false');
  }

  if (mode === 'off') {
    if (statusLabel) statusLabel.textContent = '未连接';
    if (headline) headline.textContent = 'AI 看不到你的浏览器';
    if (subline) subline.textContent = '点一下，允许它帮你操作';
    if (primaryAction) {
      primaryAction.textContent = '允许 AI 控制';
      primaryAction.disabled = false;
    }
    if (secondaryAction) {
      secondaryAction.hidden = true;
      secondaryAction.textContent = '';
      secondaryAction.disabled = false;
    }
    if (windowCard) windowCard.hidden = true;
    if (footerNote) {
      footerNote.hidden = false;
      footerNote.textContent = '只在你选定的窗口里工作';
    }
  } else if (mode === 'waiting') {
    if (statusLabel) statusLabel.textContent = '等待服务';
    if (headline) headline.textContent = '本地服务未启动';
    if (subline) subline.textContent = '复制启动指令，粘贴到你的 AI 对话';
    if (primaryAction) {
      primaryAction.textContent = '复制启动指令';
      primaryAction.disabled = false;
    }
    if (secondaryAction) {
      secondaryAction.hidden = false;
      secondaryAction.textContent = '暂停';
      secondaryAction.disabled = false;
    }
    if (windowCard) windowCard.hidden = true;
    if (footerNote) {
      footerNote.hidden = false;
      footerNote.textContent = 'AI 启动服务后会自动接通';
    }
  } else if (mode === 'connecting') {
    if (statusLabel) statusLabel.textContent = '正在接通';
    if (headline) headline.textContent = '正在接通';
    if (subline) subline.textContent = '正在接通本地助手';
    if (primaryAction) {
      primaryAction.textContent = '正在接通…';
      primaryAction.disabled = true;
    }
    if (secondaryAction) {
      secondaryAction.hidden = false;
      secondaryAction.textContent = '取消';
      secondaryAction.disabled = false;
    }
    if (windowCard) windowCard.hidden = true;
    if (footerNote) {
      footerNote.hidden = true;
      footerNote.textContent = '';
    }
  } else if (mode === 'ready') {
    if (statusLabel) {
      if (active) {
        if (tabId === null || state.activeTabId === null) {
          statusLabel.textContent = 'AI 正在操作';
        } else if (tabId === state.activeTabId) {
          statusLabel.textContent = 'AI 正在此标签页';
        } else {
          statusLabel.textContent = 'AI 正在其他标签页';
        }
      } else if (recent) {
        if (tabId === null || state.activeTabId === null) {
          statusLabel.textContent = 'AI 刚刚操作过';
        } else if (tabId === state.activeTabId) {
          statusLabel.textContent = 'AI 刚刚操作过此标签页';
        } else {
          statusLabel.textContent = 'AI 刚刚操作过其他标签页';
        }
      } else {
        statusLabel.textContent = '已连接';
      }
    }
    if (headline) headline.textContent = 'AI 可以操作这个浏览器';
    if (subline) subline.textContent = '只在你选定的窗口里工作';
    if (primaryAction) {
      primaryAction.textContent = '复制连接指令';
      primaryAction.disabled = false;
    }
    if (secondaryAction) {
      secondaryAction.hidden = false;
      secondaryAction.textContent = '暂停';
      secondaryAction.disabled = false;
    }
    if (windowCard) {
      windowCard.hidden = false;
      if (windowTitle) {
        windowTitle.textContent = state.activeTabTitle.trim() || '当前窗口';
      }
      if (windowTabs) {
        const tabs = parseTabCount(state.windowSummary);
        windowTabs.textContent = `${tabs} 个标签页`;
      }
    }
    if (footerNote) {
      footerNote.hidden = true;
      footerNote.textContent = '';
    }
  } else if (mode === 'error') {
    if (statusLabel) statusLabel.textContent = '需要处理';
    if (headline) headline.textContent = '没能连上本地助手';
    if (subline) subline.textContent = state.statusText;
    if (primaryAction) {
      primaryAction.textContent = '重新连接';
      primaryAction.disabled = false;
    }
    if (secondaryAction) {
      secondaryAction.hidden = false;
      secondaryAction.textContent = '查看原因';
      secondaryAction.disabled = false;
    }
    if (windowCard) windowCard.hidden = true;
    if (footerNote) {
      footerNote.hidden = true;
      footerNote.textContent = '';
    }
  }

  // Primary hint handling
  if (mode === 'ready') {
    if (copyHintTimer === null && primaryHint) {
      primaryHint.textContent = '粘贴到 AI 对话框，它直接接管这个标签页';
    }
  } else if (mode === 'waiting') {
    // Keep the "copied" confirmation on screen for its full timeout instead of
    // letting the 1.5s state refresh wipe it on the next tick.
    if (copyHintTimer === null && primaryHint) {
      primaryHint.textContent = '';
    }
  } else {
    if (copyHintTimer !== null) {
      window.clearTimeout(copyHintTimer);
      copyHintTimer = null;
    }
    if (primaryHint) {
      primaryHint.textContent = '';
    }
  }

  // Details panel fields
  if (portValue) {
    portValue.textContent = String(state.port);
  }
  if (instanceInput && document.activeElement !== instanceInput) {
    instanceInput.value = state.instanceLabel;
  }
  if (profileValue) {
    profileValue.textContent = maskProfileName(state.profileName);
  }
  if (profileNameInput && document.activeElement !== profileNameInput) {
    profileNameInput.value = state.profileName;
  }
  if (statusText) {
    statusText.textContent = state.statusText;
  }
  if (version) {
    try {
      version.textContent = chrome.runtime.getManifest?.()?.version ?? '';
    } catch {
      version.textContent = '';
    }
  }
}

async function requestState(message: Record<string, unknown>): Promise<PopupState> {
  return (await chrome.runtime.sendMessage(message)) as PopupState;
}

function renderError(error: unknown, fallbackMessage: string): void {
  render({
    servingEnabled: Boolean(currentState?.servingEnabled),
    port: currentState?.port ?? 19826,
    statusText: error instanceof Error ? error.message : fallbackMessage,
    connectionState: 'error',
    defaultPortBusy: false,
    daemonDetected: false,
    instanceLabel: currentState?.instanceLabel ?? '',
    profileEmail: currentState?.profileEmail ?? '',
    profileName: currentState?.profileName ?? '',
    windowCount: currentState?.windowCount ?? 0,
    selectedWindowId: currentState?.selectedWindowId ?? null,
    windowSummary: currentState?.windowSummary ?? 'Window info unavailable.',
    activeTabTitle: currentState?.activeTabTitle ?? '',
    activeTabId: currentState?.activeTabId ?? null,
    activeWindowId: currentState?.activeWindowId ?? null,
    agentActivity: null,
  });
}

async function refreshState(): Promise<void> {
  try {
    render(await requestState({ type: 'ttbridge:get-popup-state' }));
  } catch (error) {
    renderError(error, 'Failed to load TT bridge state.');
  }
}

async function setServing(enabled: boolean): Promise<void> {
  if (primaryAction) primaryAction.disabled = true;
  if (secondaryAction) secondaryAction.disabled = true;
  try {
    const nextState = await requestState({
      type: 'ttbridge:set-serving',
      enabled,
    });
    render(nextState);
  } catch (error) {
    renderError(error, enabled ? 'Failed to start serving.' : 'Failed to stop serving.');
  } finally {
    if (currentState && primaryAction) {
      primaryAction.disabled = derivePopupMode(currentState) === 'connecting';
    }
    if (secondaryAction) {
      secondaryAction.disabled = false;
    }
  }
}

async function restartServing(): Promise<void> {
  if (primaryAction) primaryAction.disabled = true;
  if (secondaryAction) secondaryAction.disabled = true;
  try {
    await requestState({ type: 'ttbridge:set-serving', enabled: false });
    const nextState = await requestState({ type: 'ttbridge:set-serving', enabled: true });
    render(nextState);
  } catch (error) {
    renderError(error, 'Failed to reconnect.');
  } finally {
    if (currentState && primaryAction) {
      primaryAction.disabled = derivePopupMode(currentState) === 'connecting';
    }
    if (secondaryAction) {
      secondaryAction.disabled = false;
    }
  }
}

async function handleCopyInstruction(): Promise<void> {
  if (!currentState) return;
  const instruction = buildConnectionInstruction(currentState);
  try {
    await navigator.clipboard.writeText(instruction);
    if (primaryHint) {
      if (copyHintTimer !== null) {
        window.clearTimeout(copyHintTimer);
      }
      primaryHint.textContent = '已复制，粘贴给 AI 即可接管';
      copyHintTimer = window.setTimeout(() => {
        copyHintTimer = null;
        if (currentState && derivePopupMode(currentState) === 'ready' && primaryHint) {
          primaryHint.textContent = '粘贴到 AI 对话框，它直接接管这个标签页';
        }
      }, 2000);
    }
  } catch {
    // Best-effort clipboard copy
  }
}

async function handleCopyStartupInstruction(): Promise<void> {
  try {
    await navigator.clipboard.writeText(buildStartupInstruction());
    if (primaryHint) {
      if (copyHintTimer !== null) {
        window.clearTimeout(copyHintTimer);
      }
      primaryHint.textContent = '已复制，去 AI 对话里粘贴';
      copyHintTimer = window.setTimeout(() => {
        copyHintTimer = null;
        if (currentState && derivePopupMode(currentState) === 'waiting' && primaryHint) {
          primaryHint.textContent = '';
        }
      }, 2000);
    }
  } catch {
    // Best-effort clipboard copy
  }
  // The human has just been told to start the service; reset the backoff so the
  // extension connects immediately after the agent runs `tt-bridge daemon start`.
  void retryConnection();
}

async function retryConnection(): Promise<void> {
  if (secondaryAction) secondaryAction.disabled = true;
  try {
    render(await requestState({ type: 'ttbridge:retry-connection' }));
  } catch (error) {
    renderError(error, 'Failed to reconnect.');
  } finally {
    if (secondaryAction) secondaryAction.disabled = false;
  }
}

async function handlePrimaryClick(): Promise<void> {
  if (!currentState) return;
  const mode = derivePopupMode(currentState);
  if (mode === 'off') {
    await setServing(true);
  } else if (mode === 'waiting') {
    await handleCopyStartupInstruction();
  } else if (mode === 'ready') {
    await handleCopyInstruction();
  } else if (mode === 'error') {
    await restartServing();
  }
}

async function handleSecondaryClick(): Promise<void> {
  if (!currentState) return;
  const mode = derivePopupMode(currentState);
  if (mode === 'off' || mode === 'error') {
    showDetails();
  } else {
    // connecting / waiting / ready all share the same escape hatch: stop
    // serving. In waiting mode the popup is already retrying on its own poll,
    // so a separate "retry" button would be redundant.
    await setServing(false);
  }
}

async function handleInstanceRename(): Promise<void> {
  if (!instanceInput) return;
  const label = instanceInput.value.trim();
  if (!label || label === currentState?.instanceLabel) {
    if (currentState) {
      instanceInput.value = currentState.instanceLabel;
    }
    return;
  }

  try {
    const nextState = await requestState({
      type: 'ttbridge:set-instance-label',
      label,
    });
    render(nextState);
  } catch (error) {
    renderError(error, 'Failed to rename this instance.');
  }
}

async function handleProfileRename(): Promise<void> {
  if (!profileNameInput) return;
  const name = profileNameInput.value.trim();
  if (name === (currentState?.profileName ?? '')) {
    profileNameInput.value = currentState?.profileName ?? '';
    return;
  }

  try {
    const nextState = await requestState({
      type: 'ttbridge:set-profile-name',
      name,
    });
    render(nextState);
  } catch (error) {
    renderError(error, 'Failed to rename this profile.');
  }
}

async function main(): Promise<void> {
  primaryAction?.addEventListener('click', () => {
    void handlePrimaryClick();
  });

  secondaryAction?.addEventListener('click', () => {
    void handleSecondaryClick();
  });

  detailsToggle?.addEventListener('click', () => {
    showDetails();
  });

  detailsBack?.addEventListener('click', () => {
    showMain();
  });

  instanceInput?.addEventListener('change', () => {
    void handleInstanceRename();
  });

  profileNameInput?.addEventListener('change', () => {
    void handleProfileRename();
  });

  await refreshState();
  refreshTimer = window.setInterval(() => {
    void refreshState();
  }, 1500);
}

window.addEventListener('beforeunload', () => {
  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (copyHintTimer !== null) {
    window.clearTimeout(copyHintTimer);
    copyHintTimer = null;
  }
});

void main();
