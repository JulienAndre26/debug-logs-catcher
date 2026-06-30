# Chrome Web Store — Listing Copy

This file is the source of truth for what we paste into the Chrome Web Store
developer dashboard. Keep it in sync with whatever is live on the listing,
so the next submission has the latest text ready to copy.

---

## Item name

> Debug Logs Catcher

(45 char limit; current: 19)

## Short description

> Internal Enreach tool to capture WebSocket frames, console logs, network
> requests and environment metadata. Export as gzipped JSON.

(132 char limit; current: 131)

## Detailed description

> **Debug Logs Catcher** is an internal Enreach tool built to make it
> trivial for QA, support, and developers to file actionable bug reports
> against the myXpad / myIstra front-ends. It attaches the Chrome DevTools
> debugger to a tab on demand and records everything you need to reproduce,
> share, or diagnose an issue — without leaving the browser.
>
> What it captures while attached:
>
> • WebSocket frames sent and received, with payload and timing
> • Network requests and responses (URL, method, headers, body, status, size)
> • Console output and uncaught exceptions, with stack traces. Call
>   arguments are captured as Chrome DevTools Protocol's `ObjectPreview`:
>   top-level property names with their primitive values; nested
>   objects/arrays appear as `"Object"` / `"Array(N)"` placeholders,
>   with no deeper recursion (like the DevTools console panel before
>   you click to expand an object)
> • Environment metadata: `/build.json` if served, plus the decoded payload
>   of the first JWT bearer token seen (tenant, user, server context)
>
> Other features:
>
> • **Auto-capture domains** — list the hosts you debug regularly and the
>   extension attaches automatically the next time you visit them. The
>   extension asks Chrome for permission once per domain, granted by you
>   through Chrome's native prompt. No site is accessed without your
>   explicit consent.
> • **Add current site** — one click on the popup adds the current tab's
>   host to the Auto-capture list, asks Chrome for permission, and you are
>   set up.
> • **Header and token redaction by default** — Authorization, Cookie,
>   Set-Cookie, X-Application, X-Csrf-Token, X-Xsrf-Token, and `Bearer …`
>   tokens are stripped from exports. Disable in Settings if you control
>   the recipient.
> • **Gzipped JSON export** — click *Export* for a compact `.json.gz`,
>   or Shift+click for raw `.json` when you need to read it directly.
> • **Bounded buffers** — capped at 5 000 WS frames, 10 000 console entries,
>   and 5 000 network requests so a long session does not blow up memory.
> • **Per-tab badge** — shows when capture is running on tabs other than
>   the active one, so you do not forget the debugger is attached.
>
> Everything stays on your computer. The extension makes no network call of
> its own, has no analytics, and the publisher never sees your data.
>
> Source code and privacy policy: https://github.com/JulienAndre26/debug-logs-catcher.

(16 000 char limit; this is a starting draft.)

## Category

> Developer Tools

## Language

> English (single language listing; the UI is English-only.)

---

## Single purpose

> Capture WebSocket, network, console, and environment data from a tab the
> user explicitly attaches to, and let the user export it as a local file.

## Permission justifications

### `debugger`

> The extension's core function — capturing WebSocket frames, network
> requests, console output, and exceptions on third-party tabs — is only
> achievable via the Chrome DevTools Protocol exposed through this
> permission. Standard `webRequest` does not surface WebSocket payloads,
> console output, or runtime exceptions. Attachment is always explicit:
> either the user clicks **Start** in the popup, or the navigation matches
> a domain the user has explicitly added to the Auto-capture list (via the
> settings drawer or the *Add current site* button), for which Chrome
> permission was granted through its native prompt. Chrome's native
> "started debugging this browser" banner remains visible whenever the
> permission is in use. The extension never attaches automatically to
> arbitrary tabs.

### `storage`

> Used only to persist two pieces of user configuration in
> `chrome.storage.local`: the list of Auto-capture domains, and two boolean
> settings (*Clear buffer on page reload*, *Include all headers in
> export*). No captured data is ever written to storage.

### `tabs`

> Used to identify the active tab so the popup knows which tab to attach
> to or query. The extension reads `tabs.query({active: true, ...})` and
> the `tabId` of the tab that owns the popup. It does not enumerate the
> user's tabs, read their URLs in the background, or correlate browsing
> activity.

### `webNavigation`

> Used for two purposes, both bound to the user's own configuration:
> (1) detect a top-frame navigation on an attached tab so the capture
> buffer can be cleared on reload when the user has enabled that setting;
> (2) detect navigation to a host the user has explicitly added to the
> Auto-capture domain list (and granted Chrome permission for via the
> native prompt), to attach the debugger as soon as the page loads. The
> listener exits early on any URL that does not match a user-configured
> domain. With `optional_host_permissions`, the underlying event only
> fires on hosts the user has authorized.

## Host permission justification — `optional_host_permissions: <all_urls>`

> No host permission is granted at install time. The extension uses
> `optional_host_permissions: ["<all_urls>"]` and requests a specific
> origin pattern at runtime (`*://host/*`, strict — no subdomain wildcard) only when
> the user adds that host to the Auto-capture domain list — either by
> typing it in the settings drawer and clicking *Save*, or by clicking
> *Add current site* on the active tab. Chrome shows its native permission
> prompt; if the user denies, the domain is removed from the list and no
> host permission is held. Removing a domain from the list calls
> `chrome.permissions.remove` to revoke the corresponding origins.
>
> The `<all_urls>` pattern in `optional_host_permissions` is required
> because the tool is generic: the user decides which page they want to
> debug, on any tenant URL, internal staging environment, or third-party
> site they have legitimate access to. A closed list would defeat the
> purpose of a debugging tool. Crucially, the broad pattern is only an
> *upper bound* on what the user can grant — the actual permissions held
> at any moment are exactly those the user has approved through Chrome's
> per-domain prompt and not yet revoked. Manual *Start* on a single tab
> does not require any host permission at all; the `debugger` permission
> alone is sufficient for that flow.

## Remote code

> No. The extension ships with all of its JavaScript bundled. It does not
> load scripts from a remote URL, does not use `eval` of remote payloads,
> and does not include any module loader that fetches code dynamically.
> The only remote interaction is a single `fetch('/build.json')` evaluated
> in the inspected page's context, whose JSON response is stored in the
> capture metadata — it is data, not code.

## Data usage disclosures (developer dashboard form)

For each of the items below, the form asks: *Does your extension collect
or use this data?*

- **Personally identifiable information** — *No.* The extension never
  reads form fields, never inspects DOM beyond what the DevTools Protocol
  surfaces for the user's own capture, and never transmits anything.
- **Health information** — *No.*
- **Financial and payment information** — *No.*
- **Authentication information** — *Yes, optionally, locally.* When the
  user disables redaction via *Include all headers in export*, the export
  file may contain `Authorization` headers and `Bearer …` tokens captured
  from the page. The file is produced locally and never leaves the
  user's machine via the extension. Redaction is on by default.
- **Personal communications** — *No.*
- **Location** — *No.*
- **Web history** — *No.* The extension only sees activity on tabs the
  user has explicitly attached.
- **User activity** — *No.* No analytics, no telemetry, no click tracking.
- **Website content** — *Yes, for the user's own captures.* WebSocket
  frames, network requests, and console output captured on the user's
  explicitly-attached tabs are held in memory during the session.

### Required certifications

- ☑ I do not sell or transfer user data to third parties, outside of the
  approved use cases.
- ☑ I do not use or transfer user data for purposes that are unrelated to
  my item's single purpose.
- ☑ I do not use or transfer user data to determine creditworthiness or
  for lending purposes.

## Privacy policy URL

> https://julienandre26.github.io/debug-logs-catcher/PRIVACY.html
>
> (Hosted as GitHub Pages from the public mirror of this repo.)

---

## Assets to prepare before publishing

- [ ] Icon already shipped in manifest (16/32/48/128) — no separate upload.
- [ ] **Screenshots** (1280×800 or 640×400, at least 1, recommended 3–5).
      Plan: (1) popup idle, (2) popup mid-capture with counters, (3)
      settings drawer open, (4) downloaded export file shown in a text
      editor.
- [ ] **Small promo tile** 440×280 (optional but recommended for
      discoverability).
- [ ] **Privacy policy URL** live and publicly reachable before submission.

## Submission checklist

- [ ] Bump `manifest.json` version if anything changed since last upload.
- [ ] `zip -r debug-logs-catcher-vX.Y.Z.zip . -x '.git/*' '.idea/*' '*.zip' 'STORE_LISTING.md' 'docs/*' 'screenshots/*'`
      (STORE_LISTING, `docs/` Pages source, and `screenshots/` are
      internal — do not ship them; LICENSE, CHANGELOG, and README are fine
      to include. The privacy policy lives under `docs/` and is shipped
      via the Pages URL, not inside the ZIP — Chrome rejects any file
      starting with `_` so `_config.yml` must stay out.)
- [ ] Upload ZIP in the developer dashboard.
- [ ] Paste every field above from this file.
- [ ] Fill the data usage disclosures.
- [ ] Paste the privacy policy URL.
- [ ] Set distribution to *Public* (or *Unlisted* / private group if you
      want a soft launch).
- [ ] Submit for review — expect 1–3 business days; `chrome.debugger`
      submissions sometimes get extended review (1–2 weeks).