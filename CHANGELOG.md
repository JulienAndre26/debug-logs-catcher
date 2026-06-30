# Changelog

All notable changes to this extension are documented here. Format roughly
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [SemVer](https://semver.org/).

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