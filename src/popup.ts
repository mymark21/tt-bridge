import './popup.css';

type PopupState = {
  servingEnabled: boolean;
  port: number;
  buttonLabel: string;
  statusText: string;
  connectionState: 'idle' | 'connecting' | 'waiting' | 'connected' | 'error';
  defaultPortBusy: boolean;
};

const serveButton = document.querySelector<HTMLButtonElement>('#serve-button');
const portValue = document.querySelector<HTMLInputElement>('#port-value');
const statusLine = document.querySelector<HTMLParagraphElement>('#status-line');

let currentState: PopupState | null = null;
let refreshTimer: number | null = null;

function render(state: PopupState): void {
  if (!serveButton || !portValue || !statusLine) {
    return;
  }

  currentState = state;
  serveButton.textContent = state.buttonLabel;
  serveButton.classList.toggle('is-on', state.servingEnabled);
  portValue.value = String(state.port);
  statusLine.textContent = state.statusText;
  statusLine.classList.toggle('is-warning', state.defaultPortBusy && state.connectionState !== 'error');
  statusLine.classList.toggle('is-error', state.connectionState === 'error');
}

async function requestState(message: Record<string, unknown>): Promise<PopupState> {
  return await chrome.runtime.sendMessage(message) as PopupState;
}

async function refreshState(): Promise<void> {
  try {
    render(await requestState({ type: 'ttbridge:get-popup-state' }));
  } catch (error) {
    render({
      servingEnabled: false,
      port: currentState?.port ?? 19826,
      buttonLabel: 'Start Serving',
      statusText: error instanceof Error ? error.message : 'Failed to load TT bridge state.',
      connectionState: 'error',
      defaultPortBusy: false,
    });
  }
}

async function handleButtonClick(): Promise<void> {
  if (!serveButton) {
    return;
  }

  serveButton.disabled = true;
  try {
    const nextState = await requestState({
      type: 'ttbridge:set-serving',
      enabled: !currentState?.servingEnabled,
    });
    render(nextState);
  } catch (error) {
    render({
      servingEnabled: Boolean(currentState?.servingEnabled),
      port: currentState?.port ?? 19826,
      buttonLabel: currentState?.servingEnabled ? 'Serving' : 'Start Serving',
      statusText: error instanceof Error ? error.message : 'Failed to update TT bridge state.',
      connectionState: 'error',
      defaultPortBusy: false,
    });
  } finally {
    serveButton.disabled = false;
  }
}

async function main(): Promise<void> {
  serveButton?.addEventListener('click', () => {
    void handleButtonClick();
  });

  await refreshState();
  refreshTimer = window.setInterval(() => {
    void refreshState();
  }, 1500);
}

window.addEventListener('beforeunload', () => {
  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer);
  }
});

void main();
