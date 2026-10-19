// The pages the E2E suites serve, as route maps for support/server.js.

export const APP_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlMTIzNDU2';

// An app speaking a CRM-iframe-style protocol: an event on load, a { type: uid } response to every { type, uid }
// command. Its event carries what JSON would lose (undefined, NaN, Date, Map) and a JWT in a photo URL; it also
// fetches, logs and opens a WebSocket, so every capture section has something from the iframe.
export function appRoutes() {
    return {
        '/app.html': {
            type: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>App</title><script>
window.addEventListener('message', (e) => {
    if (!e.data || !e.data.uid) return;
    parent.postMessage({ type: e.data.uid, content: { status: 200, content: { echo: e.data.type } } }, '*');
});
parent.postMessage({ type: 'GENERAL_INFO', content: {
    activeMember: undefined, nan: NaN, when: new Date(0), map: new Map([['k', 1]]),
    urlPhoto: 'https://pbx.example/photo/42?jwt=${APP_JWT}'
} }, '*');
fetch('/api.json').then((r) => r.json()).then((j) => console.log('app fetched', j));
console.log('app ready', { nested: { deep: true } });
const ws = new WebSocket('ws://' + location.host + '/ws');
ws.onopen = () => ws.send('ping-from-app');
</script>`
        },
        '/api.json': { type: 'application/json', body: '{"ok":true,"password":"hunter2"}' }
    };
}

// The CRM embedding the app; sendCommand(cmd) posts a command into it.
export function crmRoutes(appOrigin) {
    return {
        '/crm.html': {
            type: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>CRM</title>
<iframe id="app" src="${appOrigin}/app.html"></iframe>
<script>
window.sendCommand = (cmd) => document.getElementById('app').contentWindow
    .postMessage(cmd, ${JSON.stringify(appOrigin)});
console.log('crm ready');
</script>`
        }
    };
}

// A child answering every message with { type: 'reply-' + type }, and fetching a JSON on load.
export function childRoutes() {
    return {
        '/child.html': {
            type: 'text/html', body: `<!doctype html><script>
window.addEventListener('message', (e) => parent.postMessage({ type: 'reply-' + e.data.type }, '*'));
fetch('/child.json');</script>`
        },
        '/child.json': { type: 'application/json', body: '{}' }
    };
}

export function hostRoutes(childOrigin) {
    return {
        '/host.html': {
            type: 'text/html', body: `<!doctype html><iframe id="child" src="${childOrigin}/child.html"></iframe>`
        }
    };
}

// A page that can insert (and remove) an iframe of another extension, like a password manager's inline menu.
export function foreignFrameRoutes(foreignExtensionId) {
    return {
        '/page.html': {
            type: 'text/html', body: `<!doctype html><script>
window.addForeignFrame = () => new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.id = 'foreign';
    frame.onload = resolve;
    frame.src = 'chrome-extension://${foreignExtensionId}/frame.html';
    document.body.appendChild(frame);
});
window.removeForeignFrame = () => document.getElementById('foreign').remove();</script>`
        }
    };
}
