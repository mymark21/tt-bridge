import { DEFAULT_DAEMON_PORT, MAX_DAEMON_PORT, getDaemonHttpUrl } from './protocol';

export interface BridgeDaemonStatus {
  ok: true;
  running: true;
  host: string;
  port: number;
  extensionConnected: boolean;
  pendingRequests?: number;
  uptimeMs?: number;
  idleTimeoutMs?: number;
  extension?: unknown;
  now?: string;
}

export interface BridgePortScan {
  daemonPort: number | null;
  candidatePort: number;
  defaultPortBusy: boolean;
  status: BridgeDaemonStatus | null;
}

type ProbeResult =
  | { kind: 'bridge-daemon'; status: BridgeDaemonStatus }
  | { kind: 'occupied' }
  | { kind: 'available' };

function isBridgeDaemonStatus(value: unknown): value is BridgeDaemonStatus {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as BridgeDaemonStatus).ok === true
    && (value as BridgeDaemonStatus).running === true
    && typeof (value as BridgeDaemonStatus).host === 'string'
    && typeof (value as BridgeDaemonStatus).port === 'number',
  );
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    return response.ok ? payload : { responseOk: false, payload };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeDaemonPort(port: number, timeoutMs = 500): Promise<ProbeResult> {
  try {
    const payload = await fetchJsonWithTimeout(`${getDaemonHttpUrl(port)}/status`, timeoutMs);
    if (isBridgeDaemonStatus(payload)) {
      return {
        kind: 'bridge-daemon',
        status: payload,
      };
    }
    return { kind: 'occupied' };
  } catch {
    return { kind: 'available' };
  }
}

export async function scanDaemonPorts(
  startPort = DEFAULT_DAEMON_PORT,
  endPort = MAX_DAEMON_PORT,
  timeoutMs = 500,
): Promise<BridgePortScan> {
  let defaultPortBusy = false;

  for (let port = startPort; port <= endPort; port += 1) {
    const probe = await probeDaemonPort(port, timeoutMs);

    if (probe.kind === 'bridge-daemon') {
      return {
        daemonPort: port,
        candidatePort: port,
        defaultPortBusy: defaultPortBusy || port !== startPort,
        status: probe.status,
      };
    }

    if (probe.kind === 'available') {
      return {
        daemonPort: null,
        candidatePort: port,
        defaultPortBusy: defaultPortBusy || port !== startPort,
        status: null,
      };
    }

    if (port === startPort) {
      defaultPortBusy = true;
    }
  }

  return {
    daemonPort: null,
    candidatePort: endPort,
    defaultPortBusy: true,
    status: null,
  };
}
