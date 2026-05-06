'use strict';

const PROTOCOL_VERSION = '1.3';
const MAX_WS_FRAMES = 5000;
const MAX_CONSOLE = 10000;
const MAX_NETWORK = 5000;

const captures = new Map();
let autoDomains = [];
let clearOnReload = true;

chrome.storage.local.get(['autoDomains', 'clearOnReload'], (data) => {
    autoDomains = Array.isArray(data.autoDomains) ? data.autoDomains : [];
    clearOnReload = data.clearOnReload !== false;
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.autoDomains) {
        autoDomains = Array.isArray(changes.autoDomains.newValue) ? changes.autoDomains.newValue : [];
    }
    if (changes.clearOnReload) {
        clearOnReload = changes.clearOnReload.newValue !== false;
    }
});

function getCapture(tabId) {
    let cap = captures.get(tabId);
    if (!cap) {
        cap = { sent: [], received: [], console: [], network: new Map(), attached: false, startedAt: 0 };
        captures.set(tabId, cap);
    }
    return cap;
}

function matchesAutoDomain(url) {
    if (!url || autoDomains.length === 0) return false;
    let host;
    try { host = new URL(url).hostname; } catch (e) { return false; }
    return autoDomains.some((pattern) => {
        const p = pattern.trim();
        if (!p) return false;
        if (p.startsWith('*.')) return host === p.slice(2) || host.endsWith('.' + p.slice(2));
        return host === p || host.endsWith('.' + p);
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
        meta: { tabId, exportedAt: Date.now(), startedAt: cap.startedAt },
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
                t: Date.now(),
                cdpTimestamp: params.timestamp
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
                req.fromDiskCache = params.response.fromDiskCache;
            }
            break;
        }
        case 'Network.loadingFinished': {
            const req = cap.network.get(params.requestId);
            if (req) {
                req.encodedDataLength = params.encodedDataLength;
                req.finishedAt = Date.now();
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
            pushBounded(cap.console, {
                t: Date.now(),
                cdpTimestamp: params.timestamp,
                level: params.type,
                args: (params.args || []).map(serializeRemoteObject),
                stackTrace: params.stackTrace
            }, MAX_CONSOLE);
            break;
        }
        case 'Runtime.exceptionThrown': {
            const ed = params.exceptionDetails || {};
            pushBounded(cap.console, {
                t: Date.now(),
                cdpTimestamp: params.timestamp,
                level: 'exception',
                text: ed.text,
                exception: ed.exception ? serializeRemoteObject(ed.exception) : undefined,
                url: ed.url,
                lineNumber: ed.lineNumber,
                columnNumber: ed.columnNumber,
                stackTrace: ed.stackTrace
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
