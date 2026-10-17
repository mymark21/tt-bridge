true              &&(function polyfill() {
  const relList = document.createElement("link").relList;
  if (relList && relList.supports && relList.supports("modulepreload")) {
    return;
  }
  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) {
    processPreload(link);
  }
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "childList") {
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node.tagName === "LINK" && node.rel === "modulepreload")
          processPreload(node);
      }
    }
  }).observe(document, { childList: true, subtree: true });
  function getFetchOpts(link) {
    const fetchOpts = {};
    if (link.integrity) fetchOpts.integrity = link.integrity;
    if (link.referrerPolicy) fetchOpts.referrerPolicy = link.referrerPolicy;
    if (link.crossOrigin === "use-credentials")
      fetchOpts.credentials = "include";
    else if (link.crossOrigin === "anonymous") fetchOpts.credentials = "omit";
    else fetchOpts.credentials = "same-origin";
    return fetchOpts;
  }
  function processPreload(link) {
    if (link.ep)
      return;
    link.ep = true;
    const fetchOpts = getFetchOpts(link);
    fetch(link.href, fetchOpts);
  }
}());

const serveButton = document.querySelector("#serve-button");
const portValue = document.querySelector("#port-value");
const statusLine = document.querySelector("#status-line");
const sessionLine = document.querySelector("#session-line");
const auditSection = document.querySelector("#audit-section");
const auditList = document.querySelector("#audit-list");
let currentState = null;
let refreshTimer = null;
function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1e3));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function formatClock(ts) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return "";
  }
}
function renderSession(state) {
  if (!sessionLine) return;
  if (state.servingEnabled && typeof state.remainingMs === "number") {
    sessionLine.hidden = false;
    sessionLine.textContent = `Auto-stops in ${formatDuration(state.remainingMs)}`;
  } else {
    sessionLine.hidden = true;
    sessionLine.textContent = "";
  }
}
function renderAudit(state) {
  if (!auditSection || !auditList) return;
  const entries = Array.isArray(state.auditRecent) ? state.auditRecent : [];
  if (!entries.length) {
    auditSection.hidden = true;
    auditList.replaceChildren();
    return;
  }
  auditSection.hidden = false;
  // Build with textContent only — audit detail contains page-controlled exec
  // code / URLs and must never be interpolated as HTML.
  const items = entries.map((entry) => {
    const li = document.createElement("li");
    li.className = "audit-item";
    const when = document.createElement("span");
    when.className = "audit-when";
    when.textContent = formatClock(entry.ts);
    const what = document.createElement("span");
    what.className = "audit-what";
    const detail = entry.detail ? ` ${entry.detail}` : "";
    what.textContent = `${entry.action}${detail}`;
    what.title = what.textContent;
    li.append(when, what);
    return li;
  });
  auditList.replaceChildren(...items);
}
function render(state) {
  if (!serveButton || !portValue || !statusLine) {
    return;
  }
  currentState = state;
  serveButton.textContent = state.buttonLabel;
  serveButton.classList.toggle("is-on", state.servingEnabled);
  portValue.value = String(state.port);
  statusLine.textContent = state.statusText;
  statusLine.classList.toggle("is-warning", state.defaultPortBusy && state.connectionState !== "error");
  statusLine.classList.toggle("is-error", state.connectionState === "error");
  renderSession(state);
  renderAudit(state);
}
async function requestState(message) {
  return await chrome.runtime.sendMessage(message);
}
async function refreshState() {
  try {
    render(await requestState({ type: "ttbridge:get-popup-state" }));
  } catch (error) {
    render({
      servingEnabled: false,
      port: currentState?.port ?? 19826,
      buttonLabel: "Start Serving",
      statusText: error instanceof Error ? error.message : "Failed to load TT bridge state.",
      connectionState: "error",
      defaultPortBusy: false
    });
  }
}
async function handleButtonClick() {
  if (!serveButton) {
    return;
  }
  serveButton.disabled = true;
  try {
    const nextState = await requestState({
      type: "ttbridge:set-serving",
      enabled: !currentState?.servingEnabled
    });
    render(nextState);
  } catch (error) {
    render({
      servingEnabled: Boolean(currentState?.servingEnabled),
      port: currentState?.port ?? 19826,
      buttonLabel: currentState?.servingEnabled ? "Serving" : "Start Serving",
      statusText: error instanceof Error ? error.message : "Failed to update TT bridge state.",
      connectionState: "error",
      defaultPortBusy: false
    });
  } finally {
    serveButton.disabled = false;
  }
}
async function main() {
  serveButton?.addEventListener("click", () => {
    void handleButtonClick();
  });
  await refreshState();
  refreshTimer = window.setInterval(() => {
    void refreshState();
  }, 1500);
}
window.addEventListener("beforeunload", () => {
  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer);
  }
});
void main();
