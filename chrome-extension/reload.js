/**
 * Bootstrap hot-reload page (not part of the service worker).
 *
 * Opens with `web_accessible_resources` from a page this extension owns, so any
 * previously installed build — including ones that predate the `reload` action —
 * can be told to reload itself from disk. That is what makes the v1.4.0 upgrade
 * work without clicking Reload in chrome://extensions for every Chrome profile.
 *
 * `chrome.runtime.reload()` drops the very context that calls it, so the page
 * talks to its own extension through the *background* entry point instead and
 * reports the outcome back to the daemon via the local HTTP API.
 */
(function () {
  var message = document.getElementById('tt-bridge-reload-msg');
  var requestId = ('reload-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));

  var base = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id
    ? 'chrome-extension://' + chrome.runtime.id + '/reload.html'
    : 'this extension';
  var query = 'from=' + requestId;

  function reply(payload) {
    // Best-effort: the daemon may be down, or not care.
    try {
      fetch('http://127.0.0.1:19826/reload-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(function () {});
    } catch (err) {
      /* ignore */
    }
  }

  function reloadNow() {
    if (message) message.textContent = 'Reloading tt-bridge from ' + base + ' …';
    reply({ from: 'reload-page', url: location.href, query: query, at: Date.now() });
    // Reload the extension itself. The page dies with it.
    try {
      chrome.runtime.reload();
    } catch (err) {
      if (message) message.textContent = 'Reload failed: ' + (err && err.message ? err.message : String(err));
      reply({ from: 'reload-page', error: String(err) });
    }
  }

  if (document.readyState === 'complete') {
    reloadNow();
  } else {
    window.addEventListener('load', reloadNow);
  }
})();
