import { describe, expect, it } from 'vitest';
import { buildConnectionInstruction, buildStartupInstruction } from './popup-instructions';

describe('popup clipboard payloads', () => {
  it('builds a takeover command with instance, window and tab when known', () => {
    const text = buildConnectionInstruction({
      port: 19826,
      instanceLabel: 'chrome-work',
      profileName: 'Work',
      selectedWindowId: 12,
      activeTabId: 34,
      activeTabTitle: 'Dashboard',
    });

    expect(text).toContain('实例 chrome-work');
    expect(text).toContain('窗口 chrome-work:12');
    expect(text).toContain('标签页 34「Dashboard」');
    expect(text).toContain('tt-bridge instance use chrome-work');
    expect(text).toContain('tt-bridge window use chrome-work:12');
    expect(text).toContain('tt-bridge tab pin --tab 34');
  });

  it('omits commands whose data is unavailable', () => {
    const text = buildConnectionInstruction({ port: 19827 });
    expect(text).toContain('tt-bridge 端口 19827');
    expect(text).not.toContain('instance use');
    expect(text).not.toContain('window use');
    expect(text).not.toContain('tab pin');
  });

  it('writes the startup prompt for the agent, not for the human', () => {
    const text = buildStartupInstruction();

    expect(text).toContain('tt-bridge daemon start');
    expect(text).toContain('tt-bridge status --json');
    expect(text).toContain('"extensionConnected": true');
    // Reconnect can take up to the 10s backoff cap, so an immediate status
    // check may still read false even though the service is up.
    expect(text).toContain('等 3–5 秒');
    expect(text).toContain('再查一次');
    expect(text).toContain('Release zip');
    // "where to paste it" belongs in the popup chrome; the clipboard must
    // start directly with the task so the agent does not read meta-instructions.
    expect(text).not.toContain('粘贴');
    expect(text).not.toContain('复制');
    expect(text.startsWith('请帮我启动 TT Bridge 本地服务')).toBe(true);
  });
});
