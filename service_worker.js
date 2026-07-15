import {
    DEFAULT_MAX_BODY_KB,
    DEFAULT_CONSOLE_DEPTH,
    coerceMaxBodyKB,
    coerceConsoleDepth,
    isTextMime,
    isCapturableResourceType,
    contentTypeOf,
    isMultipart,
    parseMultipartFields,
    truncate,
    serializeDeep
} from './lib/capture.js';

const PROTOCOL_VERSION = '1.3';
const MAX_WS_FRAMES = 5000;
const MAX_CONSOLE = 10000;
const MAX_NETWORK = 5000;

const BUILD_INFO_PATH = '/build.json';

// kilo-octet (ko) = 1000 octets (SI). maxBodyKB stores the ko value; bytes = ko * 1000.
const BYTES_PER_KO = 1000;

const captures = new Map();
let autoDomains = [];
let clearOnReload = true;
let maxBodyBytes = DEFAULT_MAX_BODY_KB * BYTES_PER_KO;
let consoleDepth = DEFAULT_CONSOLE_DEPTH;

// Bind a tab-scoped CDP command sender for the chrome-free serializeDeep helper.
const sendCommandFor = (tabId) => (method, params) => chrome.debugger.sendCommand({ tabId }, method, params);

chrome.storage.local.get(['autoDomains', 'clearOnReload', 'maxBodyKB', 'consoleDepth'], (data) => {
    autoDomains = Array.isArray(data.autoDomains) ? data.autoDomains : [];
    clearOnReload = data.clearOnReload !== false;
    maxBodyBytes = coerceMaxBodyKB(data.maxBodyKB) * BYTES_PER_KO;
    consoleDepth = coerceConsoleDepth(data.consoleDepth);
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.autoDomains) {
        autoDomains = Array.isArray(changes.autoDomains.newValue) ? changes.autoDomains.newValue : [];
    }
    if (changes.clearOnReload) {
        clearOnReload = changes.clearOnReload.newValue !== false;
    }
    if (changes.maxBodyKB) {
        maxBodyBytes = coerceMaxBodyKB(changes.maxBodyKB.newValue) * BYTES_PER_KO;
    }
    if (changes.consoleDepth) {
        consoleDepth = coerceConsoleDepth(changes.consoleDepth.newValue);
    }
});

const BUILD_INFO_NOT_FOUND = { status: 'not-found' };

async function fetchBuildInfo(tabId, path) {
    if (!path || !path.trim()) return BUILD_INFO_NOT_FOUND;
    const expression = `
        (async () => {
            try {
                const r = await fetch(${JSON.stringify(path)}, { credentials: 'include' });
                if (!r.ok) return null;
                const text = await r.text();
                try { return JSON.parse(text); } catch { return text; }
            } catch (e) {
                return null;
            }
        })()
    `;
    try {
        const result = await chrome.debugger.sendCommand(
            { tabId },
            'Runtime.evaluate',
            { expression, awaitPromise: true, returnByValue: true }
        );
        const value = result && result.result && result.result.value;
        if (value === null || value === undefined) return BUILD_INFO_NOT_FOUND;
        return value;
    } catch (e) {
        return BUILD_INFO_NOT_FOUND;
    }
}

function getCapture(tabId) {
    let cap = captures.get(tabId);
    if (!cap) {
        cap = { sent: [], received: [], console: [], network: new Map(), attached: false, startedAt: 0 };
        captures.set(tabId, cap);
    }
    return cap;
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

function matchesAutoDomain(url) {
    if (!url || autoDomains.length === 0) return false;
    let host;
    try { host = new URL(url).hostname; } catch (e) { return false; }
    return autoDomains.some((pattern) => {
        const p = pattern.trim().replace(/^\*\./, '');
        if (!p) return false;
        return host === p;
    });
}

async function updateBadge() {
    const activeTabIds = [];
    for (const [tabId, cap] of captures.entries()) {
        if (cap.attached) activeTabIds.push(tabId);
    }
    const count = activeTabIds.length;

    let currentTabId;
    try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        currentTabId = tab && tab.id;
    } catch (e) {
        currentTabId = undefined;
    }

    let text = '';
    if (count > 9) {
        text = '9+';
    } else if (count > 1) {
        text = String(count);
    } else if (count === 1 && activeTabIds[0] !== currentTabId) {
        text = '1';
    }

    chrome.action.setBadgeText({ text });
    if (text) chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
}

async function attachToTab(tabId) {
    const cap = getCapture(tabId);
    if (cap.attached) return { ok: true, alreadyAttached: true };
    try {
        await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
        cap.attached = true;
        cap.startedAt = Date.now();
        await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
        updateBadge();
        fetchBuildInfo(tabId, BUILD_INFO_PATH).then((info) => {
            if (cap.attached) cap.buildInfo = info;
        });
        return { ok: true };
    } catch (e) {
        cap.attached = false;
        updateBadge();
        return { ok: false, error: String(e && e.message || e) };
    }
}

async function detachFromTab(tabId) {
    const cap = captures.get(tabId);
    if (!cap || !cap.attached) return { ok: true };
    try {
        await chrome.debugger.detach({ tabId });
    } catch (e) {
        // best-effort; debugger may already be gone
    }
    cap.attached = false;
    updateBadge();
    return { ok: true };
}

function clearCapture(tabId) {
    const cap = captures.get(tabId);
    if (!cap) return;
    cap.sent = [];
    cap.received = [];
    cap.console = [];
    cap.network = new Map();
}

function snapshotStatus(tabId) {
    const cap = captures.get(tabId);
    if (!cap) return { attached: false, sent: 0, received: 0, console: 0, network: 0 };
    return {
        attached: cap.attached,
        startedAt: cap.startedAt,
        sent: cap.sent.length,
        received: cap.received.length,
        console: cap.console.length,
        network: cap.network.size
    };
}

function exportCapture(tabId) {
    const cap = captures.get(tabId);
    if (!cap) return undefined;
    return {
        meta: {
            formatVersion: 2,
            tabId,
            exportedAt: Date.now(),
            startedAt: cap.startedAt,
            buildInfo: cap.buildInfo === undefined ? BUILD_INFO_NOT_FOUND : cap.buildInfo
        },
        wsSent: cap.sent,
        wsReceived: cap.received,
        console: cap.console,
        network: Array.from(cap.network.values())
    };
}

function pushBounded(arr, item, max) {
    arr.push(item);
    if (arr.length > max) arr.shift();
}

function serializeRemoteObject(arg) {
    if (!arg) return undefined;
    if (arg.value !== undefined) return arg.value;
    if (arg.unserializableValue !== undefined) return arg.unserializableValue;
    if (arg.preview) return arg.preview;
    if (arg.description) return arg.description;
    return undefined;
}

// Best-effort: fetch the response body via CDP once the request finished, before the buffer is evicted.
// Non-text bodies are skipped, oversized bodies truncated (not dropped). Fire-and-forget; mutates req.
async function captureResponseBody(tabId, requestId, req) {
    if (req.type !== 'http') return;
    if (!isCapturableResourceType(req.resourceType)) {
        req.responseBodyOmitted = 'resource-type';
        return;
    }
    if (!isTextMime(req.mimeType)) {
        req.responseBodyOmitted = 'non-text';
        return;
    }
    try {
        const res = await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId });
        if (!res || typeof res.body !== 'string') return;
        if (res.base64Encoded) req.responseBodyBase64 = true;
        const t = truncate(res.body, maxBodyBytes);
        req.responseBody = t.value;
        if (t.truncated) req.responseBodyTruncated = true;
    } catch (e) {
        req.responseBodyError = String((e && e.message) || e);
    }
}

// Full request body: requestWillBeSent inlines postData only for small bodies; fetch the rest explicitly.
// multipart/form-data is parsed down to its text fields (file parts dropped) so form posts are captured
// without their binary uploads; other non-text request bodies are skipped.
async function captureRequestBody(tabId, requestId, req) {
    if (req.type !== 'http') return;
    if (!req.hasPostData || req.postData) return;
    if (!isCapturableResourceType(req.resourceType)) {
        req.postDataOmitted = 'resource-type';
        return;
    }
    const contentType = contentTypeOf(req.headers);
    const multipart = isMultipart(contentType);
    if (!multipart && !isTextMime(contentType)) {
        req.postDataOmitted = 'non-text';
        return;
    }
    try {
        const res = await chrome.debugger.sendCommand({ tabId }, 'Network.getRequestPostData', { requestId });
        if (!res || typeof res.postData !== 'string') return;
        if (multipart) {
            req.postDataFields = parseMultipartFields(res.postData, contentType);
        } else {
            const t = truncate(res.postData, maxBodyBytes);
            req.postData = t.value;
            if (t.truncated) req.postDataTruncated = true;
        }
    } catch (e) {
        req.postDataError = String((e && e.message) || e);
    }
}

// Enrich already-pushed console args in place: replace object args with a deep-serialized plain value.
function enrichConsoleArgs(tabId, remoteArgs, entry) {
    (remoteArgs || []).forEach((ro, i) => {
        if (!ro || ro.objectId === undefined) return;
        serializeDeep(sendCommandFor(tabId), ro, consoleDepth)
            .then((plain) => { if (plain !== undefined) entry.args[i] = plain; })
            .catch(() => { /* keep the shallow preview */ });
    });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const cap = captures.get(tabId);
    if (!cap || !cap.attached) return;

    switch (method) {
        case 'Network.webSocketCreated': {
            cap.network.set('ws:' + params.requestId, {
                type: 'ws',
                requestId: params.requestId,
                url: params.url,
                t: Date.now()
            });
            break;
        }
        case 'Network.webSocketFrameSent': {
            pushBounded(cap.sent, {
                t: Date.now(),
                requestId: params.requestId,
                opcode: params.response && params.response.opcode,
                payload: params.response && params.response.payloadData
            }, MAX_WS_FRAMES);
            break;
        }
        case 'Network.webSocketFrameReceived': {
            pushBounded(cap.received, {
                t: Date.now(),
                requestId: params.requestId,
                opcode: params.response && params.response.opcode,
                payload: params.response && params.response.payloadData
            }, MAX_WS_FRAMES);
            break;
        }
        case 'Network.webSocketClosed': {
            const entry = cap.network.get('ws:' + params.requestId);
            if (entry) entry.closedAt = Date.now();
            break;
        }
        case 'Network.requestWillBeSent': {
            cap.network.set(params.requestId, {
                type: 'http',
                requestId: params.requestId,
                url: params.request.url,
                method: params.request.method,
                headers: params.request.headers,
                postData: params.request.postData,
                hasPostData: params.request.hasPostData,
                t: Date.now()
            });
            if (cap.network.size > MAX_NETWORK) {
                const firstKey = cap.network.keys().next().value;
                cap.network.delete(firstKey);
            }
            break;
        }
        case 'Network.responseReceived': {
            const req = cap.network.get(params.requestId);
            if (req) {
                req.responseStatus = params.response.status;
                req.responseStatusText = params.response.statusText;
                req.responseHeaders = params.response.headers;
                req.mimeType = params.response.mimeType;
                req.resourceType = params.type;
                req.fromDiskCache = params.response.fromDiskCache;
            }
            break;
        }
        case 'Network.loadingFinished': {
            const req = cap.network.get(params.requestId);
            if (req) {
                req.encodedDataLength = params.encodedDataLength;
                req.finishedAt = Date.now();
                captureResponseBody(tabId, params.requestId, req);
                captureRequestBody(tabId, params.requestId, req);
            }
            break;
        }
        case 'Network.loadingFailed': {
            const req = cap.network.get(params.requestId);
            if (req) {
                req.failed = true;
                req.errorText = params.errorText;
                req.canceled = params.canceled;
                req.finishedAt = Date.now();
            }
            break;
        }
        case 'Runtime.consoleAPICalled': {
            const entry = {
                t: Date.now(),
                level: params.type,
                args: (params.args || []).map(serializeRemoteObject)
            };
            pushBounded(cap.console, entry, MAX_CONSOLE);
            if (consoleDepth >= 1) enrichConsoleArgs(tabId, params.args, entry);
            break;
        }
        case 'Runtime.exceptionThrown': {
            const ed = params.exceptionDetails || {};
            pushBounded(cap.console, {
                t: Date.now(),
                level: 'exception',
                text: ed.text,
                exception: ed.exception ? serializeRemoteObject(ed.exception) : undefined,
                url: ed.url,
                lineNumber: ed.lineNumber,
                columnNumber: ed.columnNumber
            }, MAX_CONSOLE);
            break;
        }
    }
});

chrome.debugger.onDetach.addListener((source, reason) => {
    const cap = source.tabId !== undefined && captures.get(source.tabId);
    if (cap) {
        cap.attached = false;
        cap.detachReason = reason;
    }
    updateBadge();
});

chrome.tabs.onRemoved.addListener((tabId) => {
    const cap = captures.get(tabId);
    if (cap && cap.attached) {
        chrome.debugger.detach({ tabId }).catch(() => {});
    }
    captures.delete(tabId);
    updateBadge();
});

chrome.tabs.onActivated.addListener(() => updateBadge());
chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) updateBadge();
});

chrome.webNavigation.onBeforeNavigate.addListener(async ({ tabId, url, frameId }) => {
    if (frameId !== 0) return;
    const cap = captures.get(tabId);
    if (cap && cap.attached && clearOnReload) {
        clearCapture(tabId);
    }
    if (!matchesAutoDomain(url)) return;
    if (!isDebuggablePageUrl(url)) return;
    if (cap && cap.attached) return;
    await attachToTab(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        switch (msg && msg.type) {
            case 'status':
                sendResponse(snapshotStatus(msg.tabId));
                break;
            case 'start': {
                const r = await attachToTab(msg.tabId);
                sendResponse(r);
                break;
            }
            case 'stop': {
                const r = await detachFromTab(msg.tabId);
                sendResponse(r);
                break;
            }
            case 'clear':
                clearCapture(msg.tabId);
                sendResponse({ ok: true });
                break;
            case 'export': {
                const data = exportCapture(msg.tabId);
                sendResponse(data ? { ok: true, data } : { ok: false, error: 'no capture' });
                break;
            }
            case 'getAutoDomains':
                sendResponse({ domains: autoDomains });
                break;
            case 'setAutoDomains':
                autoDomains = Array.isArray(msg.domains) ? msg.domains : [];
                chrome.storage.local.set({ autoDomains });
                sendResponse({ ok: true });
                break;
            default:
                sendResponse({ ok: false, error: 'unknown message' });
        }
    })();
    return true;
});
