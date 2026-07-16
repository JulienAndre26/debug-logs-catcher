# Changelog

All notable changes to this extension are documented here. Format roughly
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [SemVer](https://semver.org/).

## [1.1.0] — 2026-07-16

### Added

- HTTP response bodies are now actually captured (via `Network.getResponseBody`),
  not just request/response metadata. Full request bodies are fetched too
  (`Network.getRequestPostData`) when the body was not inlined. Complete JSON
  response bodies are exported as parsed objects; truncated or non-JSON bodies
  stay strings.
- Deep serialization of console objects (`Runtime.getProperties` with
  `generatePreview`) instead of opaque `"Object"` placeholders. Depth is
  configurable; the default (1) expands one level plus a free preview of nested
  objects at one CDP call per logged object, with no getter side effects.
- Extension **Options page** (right-click → Manage extension → Extension options)
  exposing two expert settings as sliders, applied live: console serialization
  depth (0–8) and max captured body size (1–1000 ko).
- `multipart/form-data` request bodies are parsed down to their text fields
  (`postDataFields`); file-upload parts are dropped. Captures ACD-style form
  posts whose fields would otherwise be invisible.
- Theme-aware UI — the popup and the Options page follow the system light or
  dark theme. The Options page is styled as a `chrome://extensions`-like card.
- Export `meta.formatVersion` for downstream parsers.
- Shared pure-logic module (`lib/capture.js`) with a `node --test` suite
  (`npm test`) covering the mime allowlist, multipart parser, size clamping,
  truncation, and deep serialization.

### Changed

- Bodies over the size limit (default 200 ko) are truncated, not dropped
  (`responseBodyTruncated` / `postDataTruncated`). Bodies are captured only for
  XHR/Fetch traffic and only for data content types (JSON, XML, `text/plain`,
  form-encoded, GraphQL); page assets (HTML/CSS/JS, images, fonts, media) are
  skipped (`responseBodyOmitted` / `postDataOmitted`: `"resource-type"` /
  `"non-text"`).
- Export redaction now also covers response/request bodies, deep-serialized console
  objects and `meta.environment` (unless *Include all headers in export* is on).
  Secret-bearing fields are masked by key name: `password` / `secret` / `credential`
  fully (`<redacted>`); API keys, tokens and session ids partially (`5b7***653` —
  correlatable across the capture but unusable). Catches e.g. the `user.password`
  hash from `/v1/user/Info` and the session token in the decoded JWT.
- Console / exception entries no longer carry the CDP `stackTrace` object (a
  ~14-frame trace used to hang off every single log, ~60% of a capture's size).
  It was redundant: for a logged error the useful throw stack is already in the
  entry's `args` (or the exception's `text` / `url` / line / column). Dropped.
- Dropped the redundant `cdpTimestamp` field from every entry — `t` (Date.now,
  epoch ms) is kept as the single wall-clock across console / network / exceptions
  (network's cdpTimestamp was a monotonic clock, not a real time anyway).
- Trim captured headers. Request headers keep only an allowlist (`Content-Type`,
  `X-Authenticate`, `Range`); `User-Agent` / `Referer` / `Origin` are lifted once
  into `meta.environment` instead of repeating on every request. Response headers
  additionally strip caching/transport noise (`Date`, `ETag`, `Expires`,
  `Last-Modified`, `Cache-Control`, `Vary`, `Accept-Ranges`, `Content-Encoding`,
  `Content-Length`, and CORP/COOP/COEP including their underscore variants).
- Background service worker is now an ES module (`"type": "module"`) so it can
  share `lib/capture.js` with the test suite.

## [1.0.1] — 2026-07-02

### Added

- Friendly notice replacing the popup UI when the active tab is a page
  Chrome protects from debugging (`chrome://`, `chrome-extension://`, the
  Chrome Web Store, and any non-`http`/`https` scheme). The notice names
  the blocked host or scheme so the user understands why the extension
  cannot attach there.

### Fixed

- Auto-capture no longer attempts to attach on protected URLs, avoiding
  the `"The extensions gallery cannot be scripted"` error on
  `chromewebstore.google.com` and equivalents.

## [1.0.0] — 2026-06-29

Initial public release.

### Added

- Capture WebSocket frames (sent + received) via `chrome.debugger`.
- Capture console output and uncaught runtime exceptions with stack traces.
- Capture HTTP requests and responses (URL, method, headers, body, status,
  size, timing).
- Environment metadata in exports: `/build.json` from the inspected origin
  plus the decoded payload of the first JWT bearer token seen.
- Auto-capture domain list — auto-attach on navigation to listed hosts
  (strict hostname match; each subdomain must be added explicitly). Uses
  `optional_host_permissions`, so Chrome shows its native permission prompt
  for each host the user adds, and revokes it when removed.
- One-click *Add current site* button in the popup to authorize the active
  tab's host without typing.
- Gzipped JSON export (default) and raw JSON export (`Shift+click`).
- Header and token redaction in exports (on by default for `Authorization`,
  `Cookie`, `Set-Cookie`, `X-Application`, `X-Csrf-Token`, `X-Xsrf-Token`,
  and `Bearer …` tokens; toggle off via *Include all headers in export*).
- Per-tab badge indicating active captures on non-focused tabs.
- *Clear buffer on page reload* setting (on by default).
- Bounded buffers (5 000 WS frames / 10 000 console entries / 5 000 network
  requests per tab) to keep memory bounded.