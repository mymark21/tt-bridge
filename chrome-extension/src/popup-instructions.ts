/**
 * Clipboard payloads shown by the popup. Kept free of DOM/chrome imports so the
 * exact text can be unit-tested without a browser environment.
 */

export interface ConnectionInstructionState {
  port?: number | null;
  instanceLabel?: string;
  profileName?: string;
  selectedWindowId?: number | null;
  activeWindowId?: number | null;
  activeTabId?: number | null;
  activeTabTitle?: string;
}

/**
 * Takeover command copied in the ready state. The human pastes this into the
 * agent, which runs the commands and pins the intended tab.
 */
export function buildConnectionInstruction(state: ConnectionInstructionState): string {
  const port = state.port ?? 19826;
  const instanceLabel = state.instanceLabel?.trim() || '';
  const profileName = state.profileName?.trim() || '';
  const windowId = state.selectedWindowId ?? state.activeWindowId ?? null;
  const tabId = state.activeTabId ?? null;
  const tabTitle = state.activeTabTitle?.trim() || '';

  const summaryParts: string[] = [];
  if (instanceLabel) {
    summaryParts.push(`实例 ${instanceLabel}`);
  }
  if (profileName) {
    summaryParts.push(`Profile ${profileName}`);
  }
  if (windowId !== null) {
    const windowRef = instanceLabel ? `${instanceLabel}:${windowId}` : `${windowId}`;
    summaryParts.push(`窗口 ${windowRef}`);
  }
  if (tabId !== null) {
    summaryParts.push(tabTitle ? `标签页 ${tabId}「${tabTitle}」` : `标签页 ${tabId}`);
  }

  const commands: string[] = [];
  if (instanceLabel) {
    commands.push(`tt-bridge instance use ${instanceLabel}`);
  }
  if (windowId !== null) {
    const windowRef = instanceLabel ? `${instanceLabel}:${windowId}` : `${windowId}`;
    commands.push(`tt-bridge window use ${windowRef}`);
  }
  if (tabId !== null) {
    commands.push(`tt-bridge tab pin --tab ${tabId}`);
  }

  const lines: string[] = [`接管我的浏览器（tt-bridge 端口 ${port}）`];
  if (summaryParts.length > 0) {
    lines.push(summaryParts.join(' · '));
  }
  if (commands.length > 0) {
    lines.push('');
    lines.push(...commands);
  }

  return lines.join('\n');
}

/**
 * Prompt copied while the local daemon is down. This is written for the agent,
 * not for the human: the popup's own labels explain where to paste it, so the
 * payload starts directly with the task.
 */
export function buildStartupInstruction(): string {
  return [
    '请帮我启动 TT Bridge 本地服务，并确认浏览器扩展已连接：',
    '',
    '1. 运行 tt-bridge daemon start',
    '2. 等 3–5 秒，再运行 tt-bridge status --json',
    '3. 看到 "extensionConnected": true 后告诉我',
    '4. 如果还是 false，再查一次；仍为 false 就告诉我，并确认 Chrome 已打开、TT Bridge 扩展已启用',
    '',
    '如果提示找不到 tt-bridge 命令，说明 CLI 还没安装，请先按项目 README 的 Release zip 方式安装。',
  ].join('\n');
}
