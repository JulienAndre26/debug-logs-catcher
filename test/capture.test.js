import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_MAX_BODY_KB,
    MAX_BODY_KB,
    DEFAULT_CONSOLE_DEPTH,
    MAX_CONSOLE_DEPTH,
    CONSOLE_ARRAY_CAP,
    coerceMaxBodyKB,
    coerceConsoleDepth,
    isTextMime,
    isCapturableResourceType,
    redactSensitiveInPlace,
    contentTypeOf,
    isMultipart,
    parseMultipartFields,
    truncate,
    previewToPlain,
    serializeDeep,
    redactJwts,
    POST_MESSAGE_BINDING,
    encodeCloned,
    installPostMessageListener,
    postMessageCaptureSource,
    parsePostMessagePayload
} from '../lib/capture.js';

test('coerceMaxBodyKB clamps and defaults', () => {
    assert.equal(coerceMaxBodyKB(100), 100);
    assert.equal(coerceMaxBodyKB(256), 256);
    assert.equal(coerceMaxBodyKB(5000), MAX_BODY_KB);       // clamp high
    assert.equal(coerceMaxBodyKB(0), DEFAULT_MAX_BODY_KB);   // invalid -> default
    assert.equal(coerceMaxBodyKB(-5), DEFAULT_MAX_BODY_KB);
    assert.equal(coerceMaxBodyKB('abc'), DEFAULT_MAX_BODY_KB);
    assert.equal(coerceMaxBodyKB(64.9), 64);                 // floored
});

test('coerceConsoleDepth clamps and defaults', () => {
    assert.equal(coerceConsoleDepth(0), 0);
    assert.equal(coerceConsoleDepth(3), 3);
    assert.equal(coerceConsoleDepth(20), MAX_CONSOLE_DEPTH);   // clamp high
    assert.equal(coerceConsoleDepth(-1), DEFAULT_CONSOLE_DEPTH);
    assert.equal(coerceConsoleDepth(1.5), DEFAULT_CONSOLE_DEPTH); // non-integer -> default
    assert.equal(coerceConsoleDepth('x'), DEFAULT_CONSOLE_DEPTH);
});

test('isTextMime allowlists text/plain + data types, rejects app code and binary', () => {
    for (const m of [
        'text/plain', 'text/plain; charset=utf-8', 'text/xml',
        'application/json', 'application/json; charset=utf-8', 'application/xml',
        'application/x-www-form-urlencoded', 'application/graphql',
        'application/ld+json', 'application/vnd.api+json', 'application/problem+xml',  // RFC 6839 suffixes
        'application/atom+xml'
    ]) {
        assert.equal(isTextMime(m), true, m);
    }
    for (const m of [
        'text/html', 'text/css', 'text/javascript', 'text/csv',   // the app's own code / not in the set
        'application/javascript', 'application/ecmascript',
        'image/svg+xml',                                          // SVG asset — application/* guard excludes it
        'image/png', 'font/woff2', 'audio/mpeg', 'video/mp4',
        'application/octet-stream', 'application/pdf', 'application/zip', '', undefined, null
    ]) {
        assert.equal(isTextMime(m), false, String(m));
    }
});

test('isCapturableResourceType allows XHR/Fetch/EventSource, blocks page assets', () => {
    for (const t of ['XHR', 'Fetch', 'EventSource']) assert.equal(isCapturableResourceType(t), true, t);
    for (const t of ['Document', 'Script', 'Stylesheet', 'Image', 'Font', 'Media', 'Manifest', 'Other']) {
        assert.equal(isCapturableResourceType(t), false, t);
    }
    assert.equal(isCapturableResourceType(undefined), true);   // unknown -> defer to the mime allowlist
});

test('redactSensitiveInPlace masks string secrets, keeps benign values', () => {
    const obj = {
        user: { password: '11328f43deadbeefhash', name: 'rbryant', changePasswordLocked: false, hasPassword: true },
        authToken: 'abc.def.ghi',
        tokenExpiry: 12345,
        sessionID: '6434020671595375190',
        apiKey: 'sk_live_abcdef123456',
        x_api_key: 'short',
        nested: [{ secret: 's' }, { note: 'keep' }],
        passwordPolicy: { minLength: 8 }
    };
    redactSensitiveInPlace(obj);
    assert.equal(obj.user.password, '<redacted>');        // pure secret: fully masked
    assert.equal(obj.user.name, 'rbryant');
    assert.equal(obj.user.changePasswordLocked, false);   // boolean left intact
    assert.equal(obj.user.hasPassword, true);
    assert.equal(obj.nested[0].secret, '<redacted>');     // pure secret: fully masked
    assert.equal(obj.authToken, 'abc***ghi');             // token: partially masked (correlatable, unusable)
    assert.equal(obj.sessionID, '643***190');             // session id: partially masked
    assert.equal(obj.apiKey, 'sk_***456');                // API key: partially masked
    assert.equal(obj.x_api_key, '***');                   // too short to partially reveal
    assert.equal(obj.tokenExpiry, 12345);                 // number left intact (key matches but value is not a string)
    assert.equal(obj.nested[1].note, 'keep');
    assert.deepEqual(obj.passwordPolicy, { minLength: 8 }); // object value untouched (recursed, no string secret)
});

test('contentTypeOf is case-insensitive', () => {
    assert.equal(contentTypeOf({ 'Content-Type': 'application/json' }), 'application/json');
    assert.equal(contentTypeOf({ 'content-type': 'text/plain' }), 'text/plain');
    assert.equal(contentTypeOf({ Accept: 'x' }), undefined);
    assert.equal(contentTypeOf(undefined), undefined);
});

test('isMultipart', () => {
    assert.equal(isMultipart('multipart/form-data; boundary=BOUNDARY'), true);
    assert.equal(isMultipart('multipart/mixed'), true);
    assert.equal(isMultipart('application/json'), false);
    assert.equal(isMultipart(undefined), false);
});

test('parseMultipartFields keeps text fields, drops file parts', () => {
    const ct = 'multipart/form-data; boundary=BOUNDARY';
    const body =
        '--BOUNDARY\r\n' +
        'Content-Disposition: form-data; name="prop"\r\n' +
        '\r\n' +
        'acdValue\r\n' +
        '--BOUNDARY\r\n' +
        'Content-Disposition: form-data; name="count"\r\n' +
        '\r\n' +
        '42\r\n' +
        '--BOUNDARY\r\n' +
        'Content-Disposition: form-data; name="upload"; filename="a.png"\r\n' +
        'Content-Type: image/png\r\n' +
        '\r\n' +
        'BINARYDATA\r\n' +
        '--BOUNDARY--\r\n';
    const fields = parseMultipartFields(body, ct);
    assert.deepEqual(fields, {
        prop: 'acdValue',
        count: '42',
        upload: '[file a.png image/png omitted]'
    });
});

test('parseMultipartFields returns undefined without a boundary', () => {
    assert.equal(parseMultipartFields('whatever', 'multipart/form-data'), undefined);
    assert.equal(parseMultipartFields(undefined, 'multipart/form-data; boundary=X'), undefined);
});

test('truncate cuts oversized strings and flags them', () => {
    assert.deepEqual(truncate('hello', 10), { value: 'hello', truncated: false });
    assert.deepEqual(truncate('hello', 3), { value: 'hel', truncated: true });
    assert.deepEqual(truncate(undefined, 3), { value: undefined, truncated: false });
});

test('previewToPlain flattens object/array previews and marks overflow', () => {
    assert.deepEqual(
        previewToPlain({ properties: [{ name: 'x', type: 'number', value: '7' }, { name: 'o', type: 'object' }] }),
        { x: '7', o: 'Object' }
    );
    assert.deepEqual(
        previewToPlain({ subtype: 'array', properties: [{ name: '0', type: 'number', value: '1' }], overflow: true }),
        ['1', '(...)']
    );
    assert.deepEqual(
        previewToPlain({ properties: [{ name: 'a', type: 'number', value: '1' }], overflow: true }),
        { a: '1', '(...)': true }
    );
});

function mockSend(store) {
    return async (method, params) => {
        assert.equal(method, 'Runtime.getProperties');
        return { result: store[params.objectId] || [] };
    };
}

test('serializeDeep: primitives return their value', async () => {
    const send = mockSend({});
    assert.equal(await serializeDeep(send, { value: 42 }, 1), 42);
    assert.equal(await serializeDeep(send, { description: 'fn' }, 1), 'fn');
});

test('serializeDeep: depth=1 expands top level + nested preview', async () => {
    const store = {
        '1': [
            { name: 'a', enumerable: true, value: { value: 5 } },
            { name: 'nested', enumerable: true, value: {
                objectId: '2',
                preview: { properties: [{ name: 'x', type: 'number', value: '7' }, { name: 'deep', type: 'object' }] }
            } }
        ]
    };
    const out = await serializeDeep(mockSend(store), { objectId: '1' }, 1);
    assert.deepEqual(out, { a: 5, nested: { x: '7', deep: 'Object' } });
});

test('serializeDeep: arrays are capped, objects are not', async () => {
    const arrProps = Array.from({ length: 60 }, (_, i) => ({ name: String(i), enumerable: true, value: { value: i } }));
    const objProps = Array.from({ length: 60 }, (_, i) => ({ name: 'k' + i, enumerable: true, value: { value: i } }));
    const send = mockSend({ arr: arrProps, obj: objProps });

    const arr = await serializeDeep(send, { objectId: 'arr', subtype: 'array' }, 1);
    assert.equal(arr.length, CONSOLE_ARRAY_CAP + 1);
    assert.equal(arr[CONSOLE_ARRAY_CAP], '(...)');

    const obj = await serializeDeep(send, { objectId: 'obj' }, 1);
    assert.equal(Object.keys(obj).length, 60);
});

test('serializeDeep: non-enumerable props are skipped', async () => {
    const store = { '1': [
        { name: 'shown', enumerable: true, value: { value: 1 } },
        { name: 'hidden', enumerable: false, value: { value: 2 } }
    ] };
    const out = await serializeDeep(mockSend(store), { objectId: '1' }, 1);
    assert.deepEqual(out, { shown: 1 });
});

test('serializeDeep: falls back to preview when getProperties throws', async () => {
    const send = async () => { throw new Error('object released'); };
    const ro = { objectId: 'x', preview: { properties: [{ name: 'p', type: 'string', value: 'v' }] } };
    assert.deepEqual(await serializeDeep(send, ro, 1), { p: 'v' });
});

test('redactJwts masks a JWT anywhere in a string, by shape', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlMTIzNDU2';
    assert.equal(redactJwts('https://pbx.example/photo/42?jwt=' + jwt + '&size=64'),
        'https://pbx.example/photo/42?jwt=eyJ***DU2&size=64');
    assert.equal(redactJwts('a.b.c and eyJnot-a-jwt'), 'a.b.c and eyJnot-a-jwt');
    assert.equal(redactJwts(undefined), undefined);
});

test('encodeCloned keeps what JSON would drop or mangle', () => {
    const out = encodeCloned({
        activeMember: undefined,
        list: [1, undefined],
        nan: NaN,
        inf: -Infinity,
        big: 10n,
        when: new Date(0),
        bad: new Date('nope'),
        re: /x/g,
        map: new Map([['k', { v: undefined }]]),
        set: new Set([1]),
        err: new TypeError('boom'),
        buf: new ArrayBuffer(4),
        bytes: new Uint8Array(3),
        blob: new Blob(['abc'], { type: 'text/plain' }),
        boxed: new String('s')
    });
    assert.deepEqual(out, {
        activeMember: '<undefined>',
        list: [1, '<undefined>'],
        nan: '<NaN>',
        inf: '<-Infinity>',
        big: '<10n>',
        when: '<Date 1970-01-01T00:00:00.000Z>',
        bad: '<Date Invalid>',
        re: '<RegExp /x/g>',
        map: { '<Map>': [['k', { v: '<undefined>' }]] },
        set: { '<Set>': [1] },
        err: '<TypeError: boom>',
        buf: '<ArrayBuffer 4 bytes>',
        bytes: '<Uint8Array 3 bytes>',
        blob: '<Blob 3 bytes text/plain>',
        boxed: 's'
    });
    // the point of it: the key survives a JSON round trip
    const roundTrip = JSON.parse(JSON.stringify(encodeCloned({ activeMember: undefined })));
    assert.deepEqual(roundTrip, { activeMember: '<undefined>' });
});

test('encodeCloned keeps an own "__proto__" key as data', () => {
    assert.deepEqual(Object.keys(encodeCloned(JSON.parse('{"__proto__": {"a": 1}, "b": 2}'))), ['__proto__', 'b']);
});

test('encodeCloned marks cycles but expands a shared, acyclic reference twice', () => {
    const shared = { x: 1 };
    const cyclic = { shared, again: shared };
    cyclic.self = cyclic;
    assert.deepEqual(encodeCloned(cyclic), { shared: { x: 1 }, again: { x: 1 }, self: '<circular>' });
});

test('encodeCloned stops at the depth cap', () => {
    const deep = Array.from({ length: 25 }).reduce((inner) => ({ d: inner }), 'bottom');
    const atCap = Array.from({ length: 20 }).reduce((node) => node.d, encodeCloned(deep));
    assert.equal(atCap, '<max-depth>');
});

function fakeWindow(frames = []) {
    const listeners = [];
    const win = {
        location: { origin: 'https://app.example' },
        document: { querySelectorAll: () => frames },
        addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
        listeners,
        calls: []
    };
    win.parent = { name: 'crm' };
    win.top = win.parent;
    win.opener = null;
    win[POST_MESSAGE_BINDING] = (payload) => win.calls.push(JSON.parse(payload));
    return win;
}

const dispatch = (win, event) => win.listeners.forEach((l) => l.fn(event));

test('installPostMessageListener listens once, in the capture phase', () => {
    const win = fakeWindow();
    installPostMessageListener(win, POST_MESSAGE_BINDING, encodeCloned);
    installPostMessageListener(win, POST_MESSAGE_BINDING, encodeCloned);
    assert.equal(win.listeners.length, 1);
    assert.equal(win.listeners[0].type, 'message');
    assert.equal(win.listeners[0].capture, true);
});

test('installPostMessageListener reports origin, source relation and the encoded data', () => {
    const child = { name: 'child' };
    const win = fakeWindow([
        { contentWindow: {}, src: 'https://other.example/' },
        { contentWindow: child, src: 'https://ads.example/f' }
    ]);
    installPostMessageListener(win, POST_MESSAGE_BINDING, encodeCloned);
    const command = { uid: 'u1', type: 'ANSWER', x: undefined };
    dispatch(win, { origin: 'https://crm.example', source: win.parent, data: command });
    dispatch(win, { origin: 'https://ads.example', source: child, data: 'ping', ports: [{}] });
    dispatch(win, { origin: 'https://app.example', source: win, data: 1 });
    dispatch(win, { origin: '', source: null, data: 2 });
    dispatch(win, { origin: 'https://x.example', source: { name: 'stranger' }, data: 3 });
    const strip = ({ t, receiver, ...rest }) => rest;
    assert.ok(win.calls.every((c) => typeof c.t === 'number' && c.receiver === 'https://app.example'));
    assert.deepEqual(win.calls.map(strip), [
        { origin: 'https://crm.example', source: 'parent', data: { uid: 'u1', type: 'ANSWER', x: '<undefined>' } },
        { origin: 'https://ads.example', source: 'child', sourceUrl: 'https://ads.example/f', data: 'ping', ports: 1 },
        { origin: 'https://app.example', source: 'self', data: 1 },
        { origin: '', source: 'none', data: 2 },
        { origin: 'https://x.example', source: 'other', data: 3 }
    ]);
});

test('installPostMessageListener never throws into the page, and keeps listening', () => {
    const win = fakeWindow();
    installPostMessageListener(win, POST_MESSAGE_BINDING, encodeCloned);
    win[POST_MESSAGE_BINDING] = () => { throw new RangeError('Invalid string length'); };
    assert.doesNotThrow(() => dispatch(win, { origin: 'https://crm.example', source: win.parent, data: 1 }));
    assert.equal(win.listeners.length, 1);
});

test('postMessageCaptureSource is self-contained once stringified', () => {
    const win = fakeWindow();
    new Function('window', postMessageCaptureSource())(win);
    dispatch(win, { origin: 'https://crm.example', source: win.parent, data: { when: new Date(0), v: undefined } });
    assert.deepEqual(win.calls[0].data, { when: '<Date 1970-01-01T00:00:00.000Z>', v: '<undefined>' });
});

test('parsePostMessagePayload truncates the data only, and rejects foreign payloads', () => {
    const small = JSON.stringify({ t: 1, origin: 'o', data: { type: 'A' } });
    assert.deepEqual(parsePostMessagePayload(small, 100), { t: 1, origin: 'o', data: { type: 'A' } });

    const big = JSON.stringify({ t: 1, origin: 'o', data: { blob: 'x'.repeat(50) } });
    const entry = parsePostMessagePayload(big, 20);
    assert.equal(entry.origin, 'o');
    assert.equal(entry.data, '{"blob":"xxxxxxxxxxx');
    assert.equal(entry.dataTruncated, true);

    assert.equal(parsePostMessagePayload('not json', 100), undefined);
    assert.equal(parsePostMessagePayload('42', 100), undefined);
});
