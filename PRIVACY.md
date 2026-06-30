# Privacy Policy — Debug Logs Catcher

**Last updated:** 2026-06-29
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
  post body, response status, headers, size, timing).
- **Console output** (`console.log` / `warn` / `error` / etc.) and uncaught
  JavaScript exceptions, including stack traces. Each call's *arguments* are
  recorded as structured data — primitive values verbatim, and objects/arrays
  as Chrome DevTools Protocol's `ObjectPreview` (top-level property names with
  their primitive values; nested objects and arrays appear only as their
  description, e.g. `"Object"` or `"Array(11)"`, with no recursion into their
  contents — like the Chrome DevTools console panel before you click on an
  object to expand its nested properties).
- **Environment metadata** decoded from the page, when available:
  - The content of `/build.json` if served by the site (branch, build number,
    version, server identity).
  - The decoded payload of the first JWT bearer token found in outgoing
    network headers or WebSocket frames (used to identify tenant / user
    context — the token itself is not stored in the export).

The extension also persists, in `chrome.storage.local`:

- The list of *Auto-capture domains* you configured.
- The two boolean settings *Clear buffer on page reload* and *Include all
  headers in export*.

Nothing else is stored.

## What the extension does NOT do

- It does **not** make any network request of its own to a third-party server.
- It does **not** upload, sync, or transmit captured data anywhere.
- It does **not** include analytics, telemetry, crash reporting, or
  remote configuration.
- It does **not** modify any page's DOM, scripts, or global state. The only
  code it ever executes in the inspected page's context is a transient
  `fetch('/build.json')` expression evaluated through the DevTools Protocol
  to retrieve the build metadata documented above; it leaves no DOM nodes,
  no global variables, and no persistent listeners behind.
- It does **not** read any page outside of the tabs you explicitly start
  capturing on (via the Start button, or via an Auto-capture domain you have
  added to the list and granted Chrome permission for).
- It does **not** persist captured frames, console output, network requests,
  or environment metadata across browser sessions — they live only in memory
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

You can disable this redaction via the *Include all headers in export*
setting — only do this when you fully control the recipient of the export,
since the resulting file will contain credentials capable of impersonating
the captured session.

## Permissions

The extension declares the following Chrome permissions, used strictly for
the purposes above:

- **`debugger`** — to attach the Chrome DevTools Protocol to a tab and
  receive WebSocket, console, and network events. Activation is always
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
