'use strict';

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
    'cross-origin-resource-policy'
]);

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
        if (decoded) return decoded;
    }
    return undefined;
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
    return redactString(JSON.stringify(parsed));
}

function stripData(data) {
    return {
        meta: data.meta,
        wsSent: (data.wsSent || []).map((f) => ({ ...f, payload: stripPayload(f.payload) })),
        wsReceived: (data.wsReceived || []).map((f) => ({ ...f, payload: stripPayload(f.payload) })),
        console: data.console,
        network: (data.network || []).map((req) => ({
            ...req,
            url: redactString(req.url),
            headers: stripHeaders(req.headers),
            responseHeaders: stripHeaders(req.responseHeaders),
            postData: redactString(req.postData)
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

async function loadAutoDomains() {
    const { domains } = await send({ type: 'getAutoDomains' });
    document.getElementById('autoDomains').value = (domains || []).join('\n');
}

function flashAck() {
    const ack = document.getElementById('saveAck');
    ack.classList.remove('hidden');
    setTimeout(() => ack.classList.add('hidden'), 1500);
}

async function onSaveAutoDomains() {
    const lines = document.getElementById('autoDomains').value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    await send({ type: 'setAutoDomains', domains: lines });
    flashAck();
}

async function onClearAutoDomains() {
    document.getElementById('autoDomains').value = '';
    await send({ type: 'setAutoDomains', domains: [] });
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

    document.getElementById('toggle').addEventListener('click', onToggle);
    document.getElementById('clear').addEventListener('click', onClear);
    document.getElementById('export').addEventListener('click', onExport);
    document.getElementById('saveAutoDomains').addEventListener('click', onSaveAutoDomains);
    document.getElementById('clearAutoDomains').addEventListener('click', onClearAutoDomains);
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