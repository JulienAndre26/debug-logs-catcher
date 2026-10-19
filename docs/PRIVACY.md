# Privacy Policy — Debug Logs Catcher

**Last updated:** 2026-10-19
**Publisher:** Julien Andre
**Contact:** julien.andre.devchrome@gmail.com

## Summary

Debug Logs Catcher is a developer tool that captures debugging information from
browser tabs you explicitly choose to attach it to. **All captured data stays
on your computer.** Nothing is uploaded, transmitted to any server, or shared
with the publisher or any third party. Export files are produced locally and
saved through your browser's normal download flow; what you do with them
afterwards is entirely up to you.

## What the extension captures

When you click **Start** in the popup (or when you visit a domain you have
listed in *Auto-capture domains*), the extension attaches the Chrome DevTools
debugger to the current tab and records, in memory only:

- **WebSocket frames** sent and received by the page (payload + timing).
- **HTTP requests and responses** issued by the page (URL, method, headers,
  request body, response body, status, size, timing). Bodies are captured for
  data content types (JSON, XML, form-encoded, plain text) up to a configurable
  size limit and truncated beyond it; page assets (HTML/CSS/JS) and binary
  responses (images, fonts, media) are skipped.
- **Console output** (`console.log` / `warn` / `error` / etc.) and uncaught
  JavaScript exceptions. Each call's *arguments* are recorded as structured
  data — primitive values verbatim, and objects/arrays serialized via the
  Chrome DevTools Protocol to a configurable depth (default one level, plus a
  free preview of the next). Serialization reads own enumerable properties only
  and never invokes getters, so it has no side effect on the page.
- **postMessage traffic** — messages delivered to the windows of the tab
  through `window.postMessage` (receiving window origin, sender origin, the
  sender's relation to the receiver, and the message payload).
- The above includes the **cross-site iframes** of the tab, which run in
  separate processes: the extension attaches to each of them as part of the
  same capture.
- **Environment metadata** decoded from the page, when available:
  - The content of `/build.json` if served by the site (branch, build number,
    version, server identity).
  - The decoded payload of the first JWT bearer token found in outgoing
    network headers or WebSocket frames (used to identify tenant / user
    context — the token itself is not stored in the export).

The extension also persists, in `chrome.storage.local`:

- The list of *Auto-capture domains* you configured.
- The two boolean settings *Clear buffer on page reload* and *Include all
  headers in export*, and the two expert options from the options page
  (console serialization depth, max captured body size).

Nothing else is stored.

## What the extension does NOT do

- It does **not** make any network request of its own to a third-party server.
- It does **not** upload, sync, or transmit captured data anywhere.
- It does **not** include analytics, telemetry, crash reporting, or
  remote configuration.
- It does **not** modify any page's DOM, scripts, or global state. It
  executes exactly two things in an inspected page, both through the DevTools
  Protocol: a transient `fetch('/build.json')` expression to retrieve the
  build metadata documented above, and a `message` event listener that
  records postMessage traffic. That listener runs in a DevTools *isolated
  world* — the mechanism behind extension content scripts — so the page's own
  scripts cannot see it, and it adds no DOM node and no page global. It only
  listens; nothing is patched or intercepted. It stays in the page until the
  next reload or navigation, recording nothing once the capture is stopped.
- It does **not** read any page outside of the tabs you explicitly start
  capturing on (via the Start button, or via an Auto-capture domain you have
  added to the list and granted Chrome permission for). It only attaches to
  `http://` and `https://` tabs; Chrome protects its own pages (`chrome://`,
  `chrome-extension://`, the Chrome Web Store) from debugging.
- It does **not** persist captured frames, console output, network requests,
  postMessage traffic, or environment metadata across browser sessions — they live only in memory
  while the service worker is alive, and are discarded when the tab is
  closed or when you click **Clear**.

## Data redaction in exports

By default, exports strip sensitive data before the file is produced:

- Request and response headers named `Authorization`, `X-Application`,
  `Cookie`, `Set-Cookie`, `X-Csrf-Token`, `X-Xsrf-Token` are removed.
- Common boilerplate security headers (CSP, HSTS, etc.) are removed to
  reduce noise.
- `Bearer …` tokens found anywhere in URLs, post bodies, or WebSocket
  payloads are replaced with `Bearer:<redacted>`.
- JSON fields named `Authorization`, `X-Application`, `Cookie`, or
  `Set-Cookie` are replaced with `<redacted>`.
- Secret-bearing fields in request/response bodies, deep-serialized console
  objects, postMessage payloads, and the decoded JWT payload are masked by
  key name: `password`, `secret`, and `credential` fields become
  `<redacted>`, while API keys, tokens, and session ids are partially masked
  (first and last characters kept, middle removed) so they stay correlatable
  but unusable.
- A JWT found anywhere else in a captured string (for instance in a URL's
  query string) is partially masked the same way.

You can disable this redaction via the *Include all headers in export*
setting — only do this when you fully control the recipient of the export,
since the resulting file will contain credentials capable of impersonating
the captured session.

## Permissions

The extension declares the following Chrome permissions, used strictly for
the purposes above:

- **`debugger`** — to attach the Chrome DevTools Protocol to a tab (and to
  its cross-site iframes) and receive WebSocket, console, network, and
  postMessage events. Activation is always
  explicit (Start button) or via the user-authorized Auto-capture domain
  list. Chrome shows its native *"…started debugging this browser"*
  banner at the top of the window whenever this permission is in use.
- **`storage`** — to persist your settings and the Auto-capture domain
  list locally.
- **`tabs`** — to identify the active tab the popup acts on.
- **`webNavigation`** — to detect page reloads (to optionally clear the
  capture buffer) and to auto-attach when you navigate to an Auto-capture
  domain you have authorized.
- **`optional_host_permissions: <all_urls>`** — *no host permission is
  granted at install time.* When you add a domain to the Auto-capture list
  (via the *Add current site* button or by typing in the settings drawer),
  Chrome shows its native permission prompt for that specific domain. The
  extension never gains access to any host you have not explicitly
  authorized through that prompt. Removing a domain from the list revokes
  its host permission.

## Data retention

Captured data lives only in the service worker's memory while a capture is
active. It is cleared when:

- You click **Clear** in the popup.
- You click **Stop** and then **Start** again on the same tab (a fresh
  capture replaces the previous one).
- You reload the page, if *Clear buffer on page reload* is enabled (default).
- You close the tab.
- The browser unloads the extension's service worker.

The publisher has no access to any of this data.

## Children

The extension is a developer tool and is not directed at children under 13.

## Changes to this policy

Material changes will be reflected by updating the *Last updated* date at
the top of this document and, where appropriate, the version number of the
extension.

## Contact

Questions about this policy: julien.andre.devchrome@gmail.com
