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
