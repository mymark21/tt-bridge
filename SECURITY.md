# 安全策略

## 上报漏洞

请**私下**上报安全问题 —— 未修复的漏洞不要开公开 issue。

- 首选:GitHub →「Security」→「Report a vulnerability」(私有安全公告)。
- 或直接联系维护者(见仓库主页)。

请附上:受影响的版本 / commit、问题描述,以及(如有)PoC。一般数日内给出初步回应。

## 范围

**范围内**:daemon(`bin/daemon.mjs`)、CLI(`bin/cli.mjs`)、扩展 service worker(`dist/background.js`)。边界与残余风险见 [THREAT_MODEL.md](THREAT_MODEL.md)。

**不在范围内**:需要"已能以你身份读文件系统"的攻击(那样能直接读 `0600` token);以及通过 `AGENT_BROWSER_BRIDGE_HOST` 把 daemon 暴露到非环回网卡(不受支持的配置)。

## 加固基线(本版本)

- daemon 的写端点(`/command`、`/shutdown`)加 Bearer token 鉴权。
- 每个 HTTP 请求做 Host + Origin 校验(防 CSRF / DNS-rebinding)。
- WS `/ext` 要求 `chrome-extension://` origin。
- `file://` / `view-source:` / `devtools://` 不可调试。
- `cookies` 强制带过滤,且从不返回 httpOnly 的 value。
- 会话自动过期(默认 30 分钟)+ popup 审计日志。

## 供应链完整性

发布物随附 `SHA256SUMS.txt`。安装前请校验:

```
shasum -a 256 -c SHA256SUMS.txt
```

扩展以未打包方式分发;每次更新都请重新核对源码与校验和。
