import { redactSensitiveInPlace } from './lib/capture.js';

const SENSITIVE_HEADERS = new Set([
    'authorization',
    'x-application',
    'cookie',
    'set-cookie',
    'x-csrf-token',
    'x-xsrf-token'
]);

const BOILERPLATE_HEADERS = new Set([
    'content-security-policy',
    'content-security-policy-report-only',
    'strict-transport-security',
    'x-frame-options',
    'x-content-type-options',
    'x-xss-protection',
    'referrer-policy',
    'permissions-policy',
    'cross-origin-opener-policy',
    'cross-origin-embedder-policy',
    'cross-origin-resource-policy',
    // underscore variants (the backend sends these with underscores). A CORS misconfig surfaces as a
    // console CORS error with the offending policy, so these response headers add nothing.
    'cross_origin_opener_policy',
    'cross_origin_embedder_policy',
    'cross_origin_resource_policy',
    // caching / transport noise, identical or irrelevant for debugging
    'date',
    'etag',
    'expires',
    'last-modified',
    'cache-control',
    'vary',
    'accept-ranges',
    'content-encoding',
    'content-length'
]);

// Request headers worth keeping per-request. Everything else (User-Agent, Referer, Origin, Accept,
// Accept-Encoding, Upgrade-Insecure-Requests…) is noise — identical across requests. User-Agent /
// Referer / Origin are lifted once into meta.environment instead (see extractEnvironment).
const REQUEST_HEADER_KEEP = new Set(['content-type', 'x-authenticate', 'range']);

const BEARER_RE = /Bearer:?\s*[A-Za-z0-9._\-+/=]+/g;
const BEARER_TOKEN_RE = /Bearer:?\s*([A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)/;
const AUTH_FIELD_RE = /"(Authorization|X-Application|Cookie|Set-Cookie)"\s*:\s*"[^"]*"/gi;

function decodeJwt(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return undefined;
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        return JSON.parse(atob(padded));
    } catch (e) {
        return undefined;
    }
}

function extractEnvironment(data) {
    const env = {};
    // User-Agent / Referer / Origin are identical across every request — lift them here once instead
    // of repeating them on each network entry (see REQUEST_HEADER_KEEP, which drops them per-request).
    const withHeaders = (data.network || []).find((r) => r.headers) || {};
    for (const [k, v] of Object.entries(withHeaders.headers || {})) {
        const kl = k.toLowerCase();
        if (kl === 'user-agent') env.userAgent = v;
        else if (kl === 'referer') env.referer = v;
        else if (kl === 'origin') env.origin = v;
    }
    // Decoded payload of the first JWT bearer token seen.
    const sources = [];
    for (const req of (data.network || []).slice(0, 30)) {
        for (const v of Object.values(req.headers || {})) {
            if (typeof v === 'string') sources.push(v);
        }
    }
    for (const frame of (data.wsSent || []).slice(0, 30)) {
        if (typeof frame.payload === 'string') sources.push(frame.payload);
    }
    for (const s of sources) {
        const m = s.match(BEARER_TOKEN_RE);
        if (!m) continue;
        const decoded = decodeJwt(m[1]);
        if (decoded) { Object.assign(env, decoded); break; }
    }
    return Object.keys(env).length ? env : undefined;
}

const DEBUGGABLE_SCHEMES = new Set(['http:', 'https:']);

function isDebuggablePageUrl(url) {
    if (!url) return false;
    let u;
    try { u = new URL(url); } catch (e) { return false; }
    if (!DEBUGGABLE_SCHEMES.has(u.protocol)) return false;
    if (u.hostname === 'chromewebstore.google.com') return false;
    if (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return false;
    return true;
}

function describeUnsupported(url) {
    if (!url) return 'this page';
    let u;
    try { u = new URL(url); } catch (e) { return url; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.protocol + '//';
    return u.hostname;
}

let currentTabId;
let refreshTimer;

function send(msg) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(msg, (response) => {
            if (chrome.runtime.lastError) {
                resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else {
                resolve(response);
            }
        });
    });
}

function showError(text) {
    const el = document.getElementById('errBox');
    if (!text) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }
    el.textContent = text;
    el.classList.remove('hidden');
}

async function refresh() {
    if (currentTabId === undefined) return;
    const status = await send({ type: 'status', tabId: currentTabId });
    document.getElementById('attachState').textContent = status.attached ? 'Capturing' : 'Idle';
    document.getElementById('sentCount').textContent = status.sent;
    document.getElementById('recvCount').textContent = status.received;
    document.getElementById('consoleCount').textContent = status.console;
    document.getElementById('networkCount').textContent = status.network;
    document.getElementById('dot').className = 'dot ' + (status.attached ? 'on' : 'off');
    document.getElementById('toggle').textContent = status.attached ? 'Stop' : 'Start';
    const total = status.sent + status.received + status.console + status.network;
    document.getElementById('export').disabled = total === 0;
}

async function onToggle() {
    showError('');
    const status = await send({ type: 'status', tabId: currentTabId });
    const result = status.attached
        ? await send({ type: 'stop', tabId: currentTabId })
        : await send({ type: 'start', tabId: currentTabId });
    if (!result.ok) showError(result.error || 'operation failed');
    refresh();
}

async function onClear() {
    await send({ type: 'clear', tabId: currentTabId });
    refresh();
}

function stripHeaders(headers) {
    if (!headers) return headers;
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        const kl = k.toLowerCase();
        if (SENSITIVE_HEADERS.has(kl) || BOILERPLATE_HEADERS.has(kl)) continue;
        out[k] = v;
    }
    return out;
}

// Request headers use an allowlist (few are useful) rather than the response denylist.
function allowlistRequestHeaders(headers) {
    if (!headers) return headers;
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        if (REQUEST_HEADER_KEEP.has(k.toLowerCase())) out[k] = v;
    }
    return out;
}

function redactString(s) {
    if (typeof s !== 'string') return s;
    return s.replace(BEARER_RE, 'Bearer:<redacted>').replace(AUTH_FIELD_RE, '"$1":"<redacted>"');
}

function walkAndStripHeaders(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const child of node) walkAndStripHeaders(child);
        return;
    }
    for (const key of ['headers', 'responseHeaders']) {
        if (node[key] && typeof node[key] === 'object' && !Array.isArray(node[key])) {
            node[key] = stripHeaders(node[key]);
        }
    }
    for (const key of Object.keys(node)) {
        const val = node[key];
        if (val && typeof val === 'object') walkAndStripHeaders(val);
    }
}

function stripPayload(s) {
    if (typeof s !== 'string') return s;
    let parsed;
    try { parsed = JSON.parse(s); } catch (e) { return redactString(s); }
    walkAndStripHeaders(parsed);
    redactSensitiveInPlace(parsed);
    return redactString(JSON.stringify(parsed));
}

// Response bodies: a complete JSON body is returned as a parsed object (nicer to read / query); a
// truncated, non-JSON, or base64 body stays a (redacted) string. Redaction is applied either way — we
// redact the string first (via stripPayload) then parse the result back, so a truncated JSON that can't
// re-parse simply falls back to the redacted string.
function stripBody(s, isBase64) {
    if (isBase64 || typeof s !== 'string') return s;
    const redacted = stripPayload(s);
    try { return JSON.parse(redacted); } catch (e) { return redacted; }
}

function redactConsoleArg(arg) {
    if (typeof arg === 'string') return redactString(arg);
    if (arg && typeof arg === 'object') {
        // Deep-serialized console objects can carry tokens/headers; round-trip through stripPayload
        // (JSON walk-and-strip headers + bearer/auth redaction) like any other payload.
        try { return JSON.parse(stripPayload(JSON.stringify(arg))); } catch (e) { return arg; }
    }
    return arg;
}

function redactConsoleEntry(entry) {
    if (!entry || !Array.isArray(entry.args)) return entry;
    return { ...entry, args: entry.args.map(redactConsoleArg) };
}

function stripData(data) {
    return {
        meta: data.meta,
        wsSent: (data.wsSent || []).map((f) => ({ ...f, payload: stripPayload(f.payload) })),
        wsReceived: (data.wsReceived || []).map((f) => ({ ...f, payload: stripPayload(f.payload) })),
        console: (data.console || []).map(redactConsoleEntry),
        network: (data.network || []).map((req) => ({
            ...req,
            url: redactString(req.url),
            headers: allowlistRequestHeaders(req.headers),
            responseHeaders: stripHeaders(req.responseHeaders),
            postData: stripPayload(req.postData),
            responseBody: stripBody(req.responseBody, req.responseBodyBase64)
        }))
    };
}

async function gzipBlob(text) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return await new Response(stream).blob();
}

function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

async function onExport(event) {
    showError('');
    const result = await send({ type: 'export', tabId: currentTabId });
    if (!result.ok) {
        showError(result.error || 'export failed');
        return;
    }
    const environment = extractEnvironment(result.data);
    const settings = await chrome.storage.local.get(['includeAllHeaders']);
    const data = settings.includeAllHeaders ? result.data : stripData(result.data);
    if (environment) {
        // environment carries the decoded JWT payload, incl. the session token — mask it like any body
        // (skipped in raw mode, consistent with the rest of the redaction).
        if (!settings.includeAllHeaders) redactSensitiveInPlace(environment);
        data.meta = { ...data.meta, environment };
    }
    const json = JSON.stringify(data, null, 2);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const wantRaw = event && event.shiftKey;

    if (wantRaw) {
        triggerDownload(new Blob([json], { type: 'application/json' }), `capture-${ts}.json`);
    } else {
        const blob = await gzipBlob(json);
        triggerDownload(new Blob([blob], { type: 'application/gzip' }), `capture-${ts}.json.gz`);
    }
}

let currentAutoDomains = [];

function patternsFor(domain) {
    const trimmed = domain.trim().replace(/^\*\./, '');
    if (!trimmed) return [];
    return [`*://${trimmed}/*`];
}

async function reconcileWithPermissions(domains) {
    if (domains.length === 0) return domains;
    const grantedOrigins = new Set((await chrome.permissions.getAll()).origins || []);
    const filtered = domains.filter((d) => {
        const patterns = patternsFor(d);
        return patterns.some((p) => grantedOrigins.has(p));
    });
    if (filtered.length !== domains.length) {
        await send({ type: 'setAutoDomains', domains: filtered });
    }
    return filtered;
}

async function loadAutoDomains() {
    const { domains } = await send({ type: 'getAutoDomains' });
    currentAutoDomains = await reconcileWithPermissions(domains || []);
    document.getElementById('autoDomains').value = currentAutoDomains.join('\n');
}

function flashAck() {
    const ack = document.getElementById('saveAck');
    ack.classList.remove('hidden');
    setTimeout(() => ack.classList.add('hidden'), 1500);
}

async function persistDomains(list) {
    await send({ type: 'setAutoDomains', domains: list });
    currentAutoDomains = list;
    document.getElementById('autoDomains').value = list.join('\n');
}

async function onSaveAutoDomains() {
    showError('');
    const inputLines = document.getElementById('autoDomains').value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);

    const added = inputLines.filter((d) => !currentAutoDomains.includes(d));
    const removed = currentAutoDomains.filter((d) => !inputLines.includes(d));

    if (removed.length > 0) {
        const origins = removed.flatMap(patternsFor);
        try { await chrome.permissions.remove({ origins }); } catch (e) { /* best-effort */ }
    }

    const kept = currentAutoDomains.filter((d) => !removed.includes(d));
    const optimistic = [...kept, ...added];
    await persistDomains(optimistic);

    if (added.length === 0) {
        flashAck();
        return;
    }

    const origins = added.flatMap(patternsFor);
    let granted = false;
    try {
        granted = await chrome.permissions.request({ origins });
    } catch (e) {
        showError(`Permission request failed: ${e.message || e}`);
    }

    if (!granted) {
        await persistDomains(kept);
        showError(`Not added (permission denied): ${added.join(', ')}`);
        return;
    }
    flashAck();
}

async function onClearAutoDomains() {
    showError('');
    if (currentAutoDomains.length > 0) {
        const origins = currentAutoDomains.flatMap(patternsFor);
        try { await chrome.permissions.remove({ origins }); } catch (e) { /* best-effort */ }
    }
    await persistDomains([]);
    flashAck();
}

async function onAddCurrentSite() {
    showError('');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
        showError('No active tab to read.');
        return;
    }
    let host;
    try { host = new URL(tab.url).hostname; } catch (e) { host = ''; }
    if (!host) {
        showError(`Current tab has no host (${tab.url}).`);
        return;
    }
    if (currentAutoDomains.includes(host)) {
        showError(`${host} is already in the list.`);
        return;
    }

    const optimistic = [...currentAutoDomains, host];
    await persistDomains(optimistic);

    const origins = patternsFor(host);
    let granted = false;
    try {
        granted = await chrome.permissions.request({ origins });
    } catch (e) {
        showError(`Permission request failed: ${e.message || e}`);
    }

    if (!granted) {
        await persistDomains(currentAutoDomains.filter((d) => d !== host));
        showError(`Not added (permission denied): ${host}`);
        return;
    }
    flashAck();
}

async function loadSettings() {
    const settings = await chrome.storage.local.get(['clearOnReload', 'includeAllHeaders']);
    document.getElementById('clearOnReload').checked = settings.clearOnReload !== false;
    document.getElementById('includeAllHeaders').checked = settings.includeAllHeaders === true;
}

function bindSetting(id, key) {
    document.getElementById(id).addEventListener('change', (e) => {
        chrome.storage.local.set({ [key]: e.target.checked });
    });
}

async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
        showError('no active tab');
        return;
    }
    currentTabId = tab.id;

    if (!isDebuggablePageUrl(tab.url)) {
        document.getElementById('protectedTarget').textContent = describeUnsupported(tab.url);
        document.getElementById('protectedNotice').classList.remove('hidden');
        document.getElementById('mainUi').classList.add('hidden');
        return;
    }

    document.getElementById('toggle').addEventListener('click', onToggle);
    document.getElementById('clear').addEventListener('click', onClear);
    document.getElementById('export').addEventListener('click', onExport);
    document.getElementById('saveAutoDomains').addEventListener('click', onSaveAutoDomains);
    document.getElementById('clearAutoDomains').addEventListener('click', onClearAutoDomains);
    document.getElementById('addCurrentSite').addEventListener('click', onAddCurrentSite);
    bindSetting('clearOnReload', 'clearOnReload');
    bindSetting('includeAllHeaders', 'includeAllHeaders');

    await loadAutoDomains();
    await loadSettings();
    await refresh();
    refreshTimer = setInterval(refresh, 1000);
}

window.addEventListener('unload', () => {
    if (refreshTimer) clearInterval(refreshTimer);
});

init();