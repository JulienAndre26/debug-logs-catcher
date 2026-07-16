# Debug Logs Catcher

A Chrome extension that attaches the DevTools debugger to a tab on demand and
captures WebSocket frames, console output, network requests, and environment
metadata. Everything stays local — exports are produced as gzipped JSON files
you download yourself.

Built primarily to make it easy to reproduce and file bugs against Enreach
front-end stacks (myXpad / myIstra), but the extension is generic and works
on any tab.

## Features

- **WebSocket capture** — every frame sent and received, with payload and
  timestamp (capped at 5 000 frames per tab).
- **Console capture** — `console.log` / `warn` / `error` / etc. plus uncaught
  exceptions. Call arguments are serialized via the Chrome DevTools Protocol
  to a configurable depth (default one level plus a preview of the next):
  primitive values verbatim, nested objects/arrays expanded, own enumerable
  properties only, no getters invoked. Capped at 10 000 entries.
- **Network capture** — every HTTP request and response with URL, method,
  headers, status, size, and timing. Request and response bodies are captured
  for XHR/Fetch data types (JSON, XML, `text/plain`, form-encoded, GraphQL) up
  to a configurable size limit; page assets and binary responses are skipped.
  Capped at 5 000 requests.
- **Environment metadata** — automatically fetches `/build.json` from the
  inspected origin if served, and decodes the first JWT bearer token seen
  in network headers or WebSocket payloads to surface tenant / user / server
  context.
- **Auto-capture domains** — list the hosts you debug regularly; the
  extension attaches automatically the next time you visit them. One-click
  **Add current site** button in the popup, or type domains by hand.
  Permissions are requested per domain through Chrome's native prompt.
- **Redaction by default** — sensitive headers (`Authorization`, `Cookie`,
  `Set-Cookie`, `X-Application`, `X-Csrf-Token`, `X-Xsrf-Token`) and `Bearer …`
  tokens are stripped from exports. Secret-bearing fields in bodies, console
  objects, and the decoded JWT are masked by key name: `password` / `secret` /
  `credential` fully (`<redacted>`), API keys / tokens / session ids partially
  (`abc***xyz`). Toggle off in Settings if you control the recipient.
- **Gzipped export by default** — click *Export* for a compact `.json.gz`,
  or `Shift+click` for raw `.json` when you want to read it directly in an
  editor.
- **Per-tab badge** — shows on tabs that have an active capture you are not
  currently viewing, so you do not forget the debugger is attached.
- **Clear-on-reload** — optional (on by default). Discards the buffer
  when the page reloads, so each repro attempt starts clean.
- **Theme-aware UI** — the popup and the options page follow the system
  light or dark theme.
- **Expert options** — an options page (right-click the icon → *Options*)
  exposes two advanced settings applied live: console serialization depth and
  max captured body size.

## Installation

### From the Chrome Web Store

Search for *Debug Logs Catcher* in the Chrome Web Store, or use the direct
listing URL (added here once the extension is published).

### From source (unpacked)

1. Clone the public mirror:
   ```
   git clone https://github.com/JulienAndre26/debug-logs-catcher.git
   ```
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and select the cloned folder.

## Usage

1. Click the toolbar icon on the tab you want to debug.
2. Click **Start** — the icon dot turns green and Chrome shows its native
   *"Debug Logs Catcher started debugging this browser"* banner at the top
   of the window (this is expected — it is how Chrome surfaces the
   `chrome.debugger` permission).
3. Reproduce the issue in the tab. The counters in the popup update in
   real time.
4. Click **Export** to download a `.json.gz` file with everything captured.
   `Shift+click` for raw `.json` (much larger).
5. Click **Stop** when you are done — the debugger banner disappears.

### Auto-capture domains

Open the *Settings* drawer in the popup. Two ways to add a host:

- Click **Add current site** to add the active tab's host in one go.
- Type a host in the textarea (one per line) and click **Save**. Each
  entry matches that exact hostname.

Either way, Chrome shows its native permission prompt for that domain the
first time you add it. Allow it once, and the extension will attach
automatically the next time you load a matching page. Removing a domain
from the list revokes the underlying Chrome host permission cleanly. The
extension never holds permission for a host you have not explicitly
authorized.

### Export format

Top-level structure:

```jsonc
{
  "meta": {
    "formatVersion": 2,
    "tabId": 123,
    "exportedAt": 1719399012345,
    "startedAt": 1719398999000,
    "buildInfo": { "branch": "infinity", "build": "…", "version": "…" },
    "environment": { "sub": "alice@example.com", "tenant": "…", "iss": "…" }
  },
  "wsSent":     [{ "t": …, "requestId": …, "opcode": …, "payload": "…" }, …],
  "wsReceived": [{ … same shape … }],
  "console":    [{ "t": …, "level": "log", "args": […] }, …],
  "network":    [{ "t": …, "type": "http", "url": "…", "headers": …, "responseStatus": …, "responseBody": …, … }, …]
}
```

`meta.buildInfo` is either the JSON returned by `GET /build.json` on the
inspected origin, or `{ "status": "not-found" }` if the file is missing.
`meta.environment` is the decoded payload of the first JWT bearer token
seen in outgoing requests — the token itself is never stored.

## Permissions

The extension declares the following permissions:

| Permission | Why |
|---|---|
| `debugger` | Only way to receive WebSocket payloads, runtime console events, and exception details. Activation is always explicit (Start button or user-authorized Auto-capture domain). |
| `storage` | Persist the Auto-capture domain list and user settings (two booleans plus the two expert options — console depth, max body size). No captured data is ever written to storage. |
| `tabs` | Identify the active tab the popup acts on. |
| `webNavigation` | Detect page reload (clear buffer) and detect navigation to an Auto-capture domain the user has authorized. |
| `optional_host_permissions: <all_urls>` | **No host access at install time.** Requested per domain at runtime when the user adds it to the Auto-capture list, via Chrome's native permission prompt. Removing a domain revokes it. The manual *Start* button does not require any host permission — `debugger` is enough. |

See [docs/PRIVACY.md](docs/PRIVACY.md) for the full privacy policy
(also published at <https://julienandre26.github.io/debug-logs-catcher/PRIVACY.html>).

## Limits

- Buffers are bounded per tab: **5 000** WS frames, **10 000** console
  entries, **5 000** network requests. Oldest entries are dropped first.
- Captured data lives only in the service worker's memory and is gone
  when the tab is closed (or sooner, see *Clear-on-reload*).
- Only top-frame navigations are watched for Auto-capture matches.
- The extension only runs on `http://` and `https://` tabs. Chrome blocks
  debugging on its own pages (`chrome://`, `chrome-extension://`, the
  Chrome Web Store); the popup shows a notice on those tabs.

## Project structure

```
manifest.json         MV3 manifest
service_worker.js     CDP listeners, capture buffers, attach/detach lifecycle
lib/capture.js        Pure capture helpers (mime allowlist, multipart, redaction, deep serialization)
popup.html            Popup UI
popup.js              Popup logic, export pipeline, redaction
popup.css             Popup styling
options.html          Options page — expert settings (console depth, max body size)
options.js            Options page logic (persists to chrome.storage.local)
icons/                16/32/48/128 PNG icons
test/                 node --test suite covering lib/capture.js
package.json          Dev scripts (test, coverage, package) — not shipped in the ZIP
docs/                 GitHub Pages source (landing + privacy policy)
STORE_LISTING.md      Source of truth for Chrome Web Store form copy
CHANGELOG.md          Release notes
LICENSE               License
```

## Development

There is no bundler — the repo content is the extension. Edit, reload on
`chrome://extensions`, retry. The pure capture logic lives in `lib/capture.js`
and is covered by a `node --test` suite: run `npm test` (or `npm run coverage`).

Before publishing a new version:

1. Bump `manifest.json` → `version` (and `package.json` → `version` to match —
   `npm run package` names the ZIP from it).
2. Add a `CHANGELOG.md` entry.
3. `git tag vX.Y.Z && git push --tags`.
4. Produce the upload zip with `npm run package`.
   (STORE_LISTING, the `docs/` Pages source, `screenshots/`, the `test/` suite,
   and `package.json` are dev/internal-only and stay out; LICENSE, CHANGELOG,
   and README are kept in the bundle. The privacy policy lives under `docs/`
   and is shipped via the Pages URL, not inside the ZIP &mdash; Chrome rejects
   any file starting with `_` so `_config.yml` must stay out.)
5. Upload via the
   [Chrome Web Store dashboard](https://chrome.google.com/webstore/devconsole/)
   and paste the texts from `STORE_LISTING.md`.

## License

See [LICENSE](LICENSE).
