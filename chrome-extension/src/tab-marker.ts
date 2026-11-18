/**
 * Green-shield marker on the tab the agent is operating.
 *
 * Chrome has no favicon API: `chrome.tabs` has no `setFavicon`, and the
 * DevTools protocol has no favicon command either. Every shipping extension
 * that swaps a tab icon (Favico, Tab-Edit, Gmail Favicon Customizer, Backlog
 * Favicon Changer) rewrites the page's `<link rel="icon">` from page context.
 * The community-hardened details kept here:
 *
 *  - Save the site's own `<link rel="icon">`s and re-create them on unmark.
 *  - Re-assert on a 1 s timer: SPAs rewrite `<head>` and silently drop the
 *    marker (Gmail swaps its favicon on every unread-count change).
 *  - Expire page-side, not from the service worker: MV3 workers die, and a
 *    shield that outlives its agent is worse than none. The deadline is
 *    re-stamped by every command that touches the tab.
 *
 * Snippets run through `Runtime.evaluate` (CDP), so they execute in the page's
 * main world and are not subject to the page's script CSP. A `data:` favicon
 * is not blocked by `img-src` in Chrome (crbug.com/40081966).
 */

/** Attribute on the injected `<link>`; also the DOM handle used to find it. */
export const SHIELD_LINK_ATTRIBUTE = 'data-tt-bridge-shield';

/** Page global holding the saved site icons, the timer and the deadline. */
export const SHIELD_STATE_KEY = '__ttBridgeShield';

/**
 * 16 px-friendly shield: a full-width green body with a dark rim and a
 * geometric "AI" (two stroked legs plus a crossbar, one bar for the I).
 * Real font glyphs collapse into mush at 16 px; strokes survive.
 */
export const SHIELD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
  + '<path d="M32 1.5C43 6 52 9 61 11.5v16.5c0 15.5-12 26-29 34.5'
  + 'C15 54 3 43.5 3 28V11.5C12 9 21 6 32 1.5z" fill="#16a34a" '
  + 'stroke="#064e3b" stroke-width="3" stroke-linejoin="round"/>'
  + '<g fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M18 44 27.5 17 37 44"/>'
  + '<path d="M22 33h11"/>'
  + '<path d="M48 17v27"/>'
  + '</g></svg>';

/**
 * Mark the tab: stash the site's icons, take over the favicon slot, and keep
 * re-asserting once a second until `expiresInMs` elapses or the tab is
 * unmarked. Repeat calls re-stamp the deadline and reuse the saved icons.
 */
export function buildShieldMarkSnippet(expiresInMs: number): string {
  return `(() => {
  const ATTR = ${JSON.stringify(SHIELD_LINK_ATTRIBUTE)};
  const KEY = ${JSON.stringify(SHIELD_STATE_KEY)};
  const HREF = 'data:image/svg+xml,' + encodeURIComponent(${JSON.stringify(SHIELD_SVG)});
  const head = () => document.head || document.documentElement;
  const siteIcons = () => Array.from(document.querySelectorAll('link[rel~="icon"]'));
  const state = window[KEY] || (window[KEY] = { saved: null, timer: null, deadline: 0 });
  if (state.saved === null) {
    state.saved = siteIcons().filter((link) => !link.hasAttribute(ATTR)).map((link) => ({
      rel: link.getAttribute('rel') || 'icon',
      type: link.getAttribute('type') || '',
      sizes: link.getAttribute('sizes') || '',
      href: link.getAttribute('href') || '',
    }));
  }
  state.deadline = Date.now() + ${Math.max(0, Math.trunc(expiresInMs))};
  const restore = () => {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    for (const link of Array.from(document.querySelectorAll('link[' + ATTR + ']'))) link.remove();
    for (const icon of state.saved || []) {
      const link = document.createElement('link');
      link.setAttribute('rel', icon.rel || 'icon');
      if (icon.type) link.setAttribute('type', icon.type);
      if (icon.sizes) link.setAttribute('sizes', icon.sizes);
      if (icon.href) link.setAttribute('href', icon.href);
      head().appendChild(link);
    }
    try { delete window[KEY]; } catch { window[KEY] = undefined; }
  };
  const ensure = () => {
    if (Date.now() > state.deadline) { restore(); return; }
    for (const link of siteIcons()) {
      if (!link.hasAttribute(ATTR)) link.remove();
    }
    let link = document.querySelector('link[' + ATTR + ']');
    if (!link) {
      link = document.createElement('link');
      link.setAttribute(ATTR, '1');
      link.setAttribute('rel', 'icon');
      link.setAttribute('type', 'image/svg+xml');
      head().appendChild(link);
    }
    if (link.getAttribute('href') !== HREF) link.setAttribute('href', HREF);
  };
  ensure();
  if (!state.timer) state.timer = setInterval(ensure, 1000);
  return { marked: true, replaced: state.saved.length, expiresInMs: ${Math.max(0, Math.trunc(expiresInMs))} };
})()`;
}

/**
 * Unmark: stop the timer and re-create the saved site icons. Re-inserting
 * (rather than restoring `href` in place) is what makes Chrome reload the real
 * favicon. Safe on pages that were never marked.
 */
export function buildShieldUnmarkSnippet(): string {
  return `(() => {
  const ATTR = ${JSON.stringify(SHIELD_LINK_ATTRIBUTE)};
  const KEY = ${JSON.stringify(SHIELD_STATE_KEY)};
  const state = window[KEY];
  if (!state) {
    for (const link of Array.from(document.querySelectorAll('link[' + ATTR + ']'))) link.remove();
    return { marked: false, restored: 0 };
  }
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  for (const link of Array.from(document.querySelectorAll('link[' + ATTR + ']'))) link.remove();
  const saved = Array.isArray(state.saved) ? state.saved : [];
  for (const icon of saved) {
    const link = document.createElement('link');
    link.setAttribute('rel', icon.rel || 'icon');
    if (icon.type) link.setAttribute('type', icon.type);
    if (icon.sizes) link.setAttribute('sizes', icon.sizes);
    if (icon.href) link.setAttribute('href', icon.href);
    (document.head || document.documentElement).appendChild(link);
  }
  try { delete window[KEY]; } catch { window[KEY] = undefined; }
  return { marked: false, restored: saved.length };
})()`;
}
