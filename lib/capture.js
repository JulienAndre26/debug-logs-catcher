// Pure, side-effect-free capture helpers. No chrome.* here — imported by the service worker AND
// covered by `node --test` (see test/capture.test.js). Keep this file free of extension globals.

export const DEFAULT_MAX_BODY_KB = 200;
export const MAX_BODY_KB = 1000;
export const DEFAULT_CONSOLE_DEPTH = 1;
export const MAX_CONSOLE_DEPTH = 8;
export const CONSOLE_ARRAY_CAP = 50;   // max console array elements per level (objects are serialized in full)

export function coerceMaxBodyKB(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_BODY_KB;
    return Math.min(MAX_BODY_KB, Math.floor(n));
}

export function coerceConsoleDepth(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) return DEFAULT_CONSOLE_DEPTH;
    return Math.min(MAX_CONSOLE_DEPTH, n);
}

// Allowlist: capture only data bodies. Exact base-type set + RFC 6839 structured-syntax suffixes
// (`application/*+json` / `application/*+xml`, so vendor types like application/vnd.api+json or
// application/problem+xml are caught). NOT substring matching — that wrongly let image/svg+xml through.
// Everything else (binary, media, and the app's own code: text/html, text/css, text/javascript) is
// skipped. Bounding the suffix rule to application/* keeps image/svg+xml out. multipart handled apart.
const DATA_MIMES = new Set([
    'text/plain',
    'text/xml',
    'application/xml',
    'application/json',
    'application/graphql',
    'application/x-www-form-urlencoded'
]);
export function isTextMime(mime) {
    if (!mime) return false;
    const m = mime.split(';')[0].trim().toLowerCase();
    if (DATA_MIMES.has(m)) return true;
    return m.startsWith('application/') && (m.endsWith('+json') || m.endsWith('+xml'));
}

// Only capture bodies for actual data traffic (API calls / streams), never for page assets. CDP
// resourceType classifies the request; Document/Script/Stylesheet/Image/Font/Media are page code/assets.
const CAPTURABLE_RESOURCE_TYPES = new Set(['XHR', 'Fetch', 'EventSource']);
export function isCapturableResourceType(type) {
    if (!type) return true;   // unknown → don't block on this axis, let the mime allowlist decide
    return CAPTURABLE_RESOURCE_TYPES.has(type);
}

// Mask secret-bearing fields by key name (case-insensitive) so captured bodies / WS payloads / console
// objects don't leak credentials (e.g. the SHA-512 `user.password` hash in /v1/user/Info). Only string
// values are masked — booleans/numbers/objects (changePasswordLocked, tokenExpiry, …) are left intact.
// High-entropy identifiers you may want to correlate across a capture (which key / token / session) are
// *partially* masked (first 3 + *** + last 3) — enough to match them up, never enough to reuse. Pure
// secrets (passwords, secrets, credentials) are fully masked: a partial reveal helps nobody there.
const FULL_REDACT_KEY_RE = /password|passwd|pwd|secret|credential/i;
const PARTIAL_REDACT_KEY_RE = /api[_-]?key|token|session[_-]?id/i;

function partialMask(s) {
    return s.length > 8 ? s.slice(0, 3) + '***' + s.slice(-3) : '***';
}

export function redactSensitiveInPlace(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
        for (const child of node) redactSensitiveInPlace(child);
        return node;
    }
    for (const key of Object.keys(node)) {
        const val = node[key];
        if (typeof val === 'string' && val.length > 0) {
            if (PARTIAL_REDACT_KEY_RE.test(key)) { node[key] = partialMask(val); continue; }
            if (FULL_REDACT_KEY_RE.test(key)) { node[key] = '<redacted>'; continue; }
        }
        if (val && typeof val === 'object') redactSensitiveInPlace(val);
    }
    return node;
}

// A JWT also travels outside any header or token-named field — e.g. in the query string of a photo URL —
// where neither the header strip, the Bearer rule nor the key-name masking sees it. Matched by shape
// (base64url `{"` header and payload) and partially masked like any other token.
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

export function redactJwts(s) {
    if (typeof s !== 'string') return s;
    return s.replace(JWT_RE, partialMask);
}

export function contentTypeOf(headers) {
    if (!headers) return undefined;
    for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'content-type') return headers[k];
    }
    return undefined;
}

export function isMultipart(contentType) {
    if (!contentType) return false;
    return /^multipart\//i.test(contentType.split(';')[0].trim());
}

function multipartBoundary(contentType) {
    const m = /boundary=("?)([^";]+)\1/i.exec(contentType || '');
    return m ? m[2] : undefined;
}

// Parse a multipart/form-data body into its text fields. File parts (those with a filename, or a
// binary Content-Type) are replaced by a short marker instead of their raw bytes. Returns an object
// keyed by field name, or undefined when the boundary can't be determined.
export function parseMultipartFields(body, contentType) {
    const boundary = multipartBoundary(contentType);
    if (!boundary || typeof body !== 'string') return undefined;
    const fields = {};
    for (let part of body.split('--' + boundary)) {
        part = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
        if (part === '' || part === '--') continue;   // preamble / closing delimiter
        const sep = part.indexOf('\r\n\r\n');
        if (sep === -1) continue;
        const headers = {};
        for (const line of part.slice(0, sep).split('\r\n')) {
            const idx = line.indexOf(':');
            if (idx > -1) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
        const disp = headers['content-disposition'] || '';
        const nameM = /name="([^"]*)"/i.exec(disp);
        const fileM = /filename="([^"]*)"/i.exec(disp);
        const name = nameM ? nameM[1] : '(unnamed)';
        const partType = headers['content-type'];
        if (fileM || (partType && !isTextMime(partType))) {
            const bits = ['file'];
            if (fileM && fileM[1]) bits.push(fileM[1]);
            if (partType) bits.push(partType);
            fields[name] = '[' + bits.join(' ') + ' omitted]';
        } else {
            fields[name] = part.slice(sep + 4);
        }
    }
    return fields;
}

// Truncate a string to at most maxBytes chars, flagging whether it was cut.
export function truncate(str, maxBytes) {
    if (typeof str !== 'string' || str.length <= maxBytes) return { value: str, truncated: false };
    return { value: str.slice(0, maxBytes), truncated: true };
}

// Turn a CDP object preview into a plain object/array (one shallow level, no extra CDP call).
export function previewToPlain(preview) {
    if (!preview) return undefined;
    const isArray = preview.subtype === 'array';
    const out = isArray ? [] : {};
    for (const p of (preview.properties || [])) {
        const val = p.type === 'object' ? (p.value || (p.subtype === 'array' ? 'Array' : 'Object')) : p.value;
        if (isArray) out.push(val);
        else out[p.name] = val;
    }
    if (preview.overflow) {
        if (isArray) out.push('(...)');
        else out['(...)'] = true;
    }
    return out;
}

// Serialize a remote object to a plain value up to `depth` levels via Runtime.getProperties.
// `sendCommand(method, params) => Promise<result>` is injected so this stays chrome-free and testable.
// At depth 0 we fall back to the (generatePreview) preview — one bonus level for free, no CDP call.
// getProperties (not callFunctionOn) means getters are never invoked: zero side effects.
export async function serializeDeep(sendCommand, ro, depth) {
    if (!ro) return undefined;
    if (ro.objectId === undefined) {
        if (ro.value !== undefined) return ro.value;
        if (ro.unserializableValue !== undefined) return ro.unserializableValue;
        return ro.description;
    }
    if (depth <= 0) {
        return ro.preview ? previewToPlain(ro.preview) : (ro.description || 'Object');
    }
    let res;
    try {
        res = await sendCommand('Runtime.getProperties', {
            objectId: ro.objectId,
            ownProperties: true,
            generatePreview: true
        });
    } catch (e) {
        return ro.preview ? previewToPlain(ro.preview) : (ro.description || 'Object');
    }
    const props = (res && res.result) || [];
    const isArray = ro.subtype === 'array';
    const out = isArray ? [] : {};
    if (isArray) {
        // Arrays are capped: a log of >50 elements is rarely useful.
        const indexed = props
            .filter((p) => p.value !== undefined && /^\d+$/.test(p.name))
            .sort((a, b) => Number(a.name) - Number(b.name));
        let count = 0;
        for (const p of indexed) {
            if (count >= CONSOLE_ARRAY_CAP) { out.push('(...)'); break; }
            count++;
            out.push(await serializeDeep(sendCommand, p.value, depth - 1));
        }
    } else {
        // Objects are serialized in full: some (e.g. /Info) carry many attributes and the useful
        // ones may sort after the noise — a positional cut would drop them.
        for (const p of props) {
            if (!p.enumerable || p.value === undefined) continue;
            out[p.name] = await serializeDeep(sendCommand, p.value, depth - 1);
        }
    }
    return out;
}

// postMessage capture. window.postMessage is no network traffic, so no CDP Network event reports it. The
// listener below runs in a CDP isolated world (the content-script mechanism): it shares the page's DOM and
// receives every message delivered to the window, while staying invisible to the page's own scripts.
// Nothing is patched — it only listens. It reports through a CDP binding exposed to that world only.
export const POST_MESSAGE_WORLD = 'debug-logs-catcher';
export const POST_MESSAGE_BINDING = '__debugLogsCatcherPostMessage';

// Turn a structured-clone value (what postMessage delivers) into a JSON-safe one without losing what JSON
// drops or mangles. Above all, a property explicitly set to undefined is kept as "<undefined>": the
// structured clone preserves it, JSON.stringify would remove the key and hide a field that was published
// empty. Stringified into the isolated world, so it must stay self-contained.
export function encodeCloned(value) {
    const MAX_DEPTH = 20;
    const ancestors = new Set();
    function encode(v, depth) {
        if (v === undefined) return '<undefined>';
        if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
        if (typeof v === 'number') return Number.isFinite(v) ? v : '<' + v + '>';
        if (typeof v === 'bigint') return '<' + v + 'n>';
        if (typeof v !== 'object') return '<' + typeof v + '>';
        if (ancestors.has(v)) return '<circular>';
        if (depth >= MAX_DEPTH) return '<max-depth>';
        const tag = Object.prototype.toString.call(v).slice(8, -1);
        ancestors.add(v);
        try {
            switch (tag) {
                case 'Object': return Object.fromEntries(Object.keys(v).map((key) => [key, encode(v[key], depth + 1)]));
                case 'Array': return Array.from(v, (item) => encode(item, depth + 1));
                case 'Map':
                    return { '<Map>': Array.from(v, ([k, item]) => [encode(k, depth + 1), encode(item, depth + 1)]) };
                case 'Set': return { '<Set>': Array.from(v, (item) => encode(item, depth + 1)) };
                case 'Date': return '<Date ' + (Number.isNaN(v.getTime()) ? 'Invalid' : v.toISOString()) + '>';
                case 'RegExp': return '<RegExp ' + v + '>';
                case 'Error': return '<' + v.name + ': ' + v.message + '>';
                case 'Boolean':
                case 'Number':
                case 'String': return encode(v.valueOf(), depth);
                case 'Blob': return '<Blob ' + v.size + ' bytes ' + v.type + '>';
                case 'File': return '<File ' + v.name + ' ' + v.size + ' bytes>';
                case 'ArrayBuffer': return '<ArrayBuffer ' + v.byteLength + ' bytes>';
            }
            if (ArrayBuffer.isView(v)) return '<' + tag + ' ' + v.byteLength + ' bytes>';
            return '<' + tag + '>';   // ImageBitmap, CryptoKey… — opaque to a key walk
        } finally {
            ancestors.delete(v);
        }
    }
    return encode(value, 0);
}

// Page-side half, stringified into the isolated world of every frame. Capture phase, so a page listener
// stopping propagation cannot hide a message from it. Self-contained like encodeCloned.
export function installPostMessageListener(win, binding, encode) {
    // the same world can evaluate the script twice (runImmediately, then the new-document hook)
    if (win.__debugLogsCatcherListening) return;
    win.__debugLogsCatcherListening = true;

    // event.source is a WindowProxy: not serializable, so it is reported as its relation to this window
    function describeSource(source) {
        if (!source) return { source: 'none' };
        if (source === win) return { source: 'self' };
        if (source === win.parent && win.parent !== win) return { source: 'parent' };
        if (source === win.opener) return { source: 'opener' };
        const frames = Array.from(win.document.querySelectorAll('iframe, frame'));
        const frame = frames.find((f) => f.contentWindow === source);
        if (frame) return { source: 'child', sourceUrl: frame.src };
        if (source === win.top) return { source: 'top' };
        return { source: 'other' };
    }

    function onMessage(event) {
        const entry = { t: Date.now(), receiver: win.location.origin, origin: event.origin };
        Object.assign(entry, describeSource(event.source));
        try {
            entry.data = encode(event.data);
        } catch (e) {
            entry.data = '<unencodable: ' + e + '>';
        }
        if (event.ports && event.ports.length) entry.ports = event.ports.length;
        try {
            win[binding](JSON.stringify(entry));
        } catch (e) {
            // never surface in the page: a payload too large to stringify is dropped
        }
    }

    win.addEventListener('message', onMessage, true);
}

export function postMessageCaptureSource() {
    return '(' + installPostMessageListener + ')(window, ' + JSON.stringify(POST_MESSAGE_BINDING) + ', ' +
        encodeCloned + ');';
}

// Binding payload → buffer entry. The data is truncated past maxBytes like a body (flagged, not dropped),
// keeping the envelope fields readable. Returns undefined for a payload that is not ours.
export function parsePostMessagePayload(payload, maxBytes) {
    let entry;
    try { entry = JSON.parse(payload); } catch (e) { return undefined; }
    if (!entry || typeof entry !== 'object') return undefined;
    const t = truncate(JSON.stringify(entry.data), maxBytes);
    if (t.truncated) {
        entry.data = t.value;
        entry.dataTruncated = true;
    }
    return entry;
}
