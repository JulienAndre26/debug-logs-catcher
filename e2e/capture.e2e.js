// Capture end to end, one scenario run in order: a "CRM" page (127.0.0.1) embedding an "app" iframe (localhost).
// Two different sites, so the iframe runs in its own process — the layout of an app embedded in a customer's CRM.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from './support/browser.js';
import { exportFromPopup, loadExtension, openPopupFor } from './support/extension.js';
import { serve } from './support/server.js';
import { waitFor } from './support/wait.js';
import { APP_JWT, appRoutes, childRoutes, crmRoutes, hostRoutes } from './fixtures/pages.js';

let browser;
let extension;
let app;
let crm;
let crmSession;
let crmTabId;
let capture;

const typesIn = (data) => data.postMessages.map((e) => e.data && e.data.type);
const hasType = (type) => (data) => typesIn(data).includes(type);
const logsIn = (data) => data.console.map((c) => c.args && c.args[0]);
const command = (cmd) => browser.evaluate(crmSession, `sendCommand(${JSON.stringify(cmd)})`);

before(async () => {
    app = await serve('localhost', appRoutes());
    crm = await serve('127.0.0.1', crmRoutes(app.origin));
    browser = launchBrowser();
    extension = await loadExtension(browser);
    const crmUrl = crm.origin + '/crm.html';
    crmSession = await browser.openPage(crmUrl);
    await browser.send('Runtime.enable', {}, crmSession);
    crmTabId = await extension.tabIdOf(crmUrl);
    capture = extension.capture(crmTabId);
});

after(async () => {
    app.close();
    crm.close();
    await browser.close();
});

test('Start on an already loaded page captures both sides of a command', async () => {
    const start = await capture.start();
    assert.equal(start.ok, true, JSON.stringify(start));
    await command({ type: 'ANSWER', uid: 'u-1', lineID: 7 });
    const data = await capture.waitForExport(hasType('u-1'), 'the response');

    const inbound = data.postMessages.find((e) => e.data.type === 'ANSWER');
    assert.equal(inbound.receiver, app.origin, 'the command is captured inside the iframe');
    assert.equal(inbound.origin, crm.origin);
    assert.equal(inbound.source, 'parent');

    const response = data.postMessages.filter((e) => e.data.type === 'u-1');
    assert.equal(response.length, 1, 'one entry per message, even if the listener script runs twice');
    assert.equal(response[0].receiver, crm.origin);
    assert.equal(response[0].source, 'child');
    assert.equal(response[0].sourceUrl, app.origin + '/app.html');
    assert.equal(response[0].data.content.status, 200);

    const ready = data.console.find((c) => c.args[0] === 'crm ready');
    assert.ok(ready.t < data.meta.startedAt, 'the first Start collects the console history, dated when logged');
});

test('a reload while capturing records the iframe from its very first message', async () => {
    await browser.reload(crmSession);
    const data = await capture.waitForExport(hasType('GENERAL_INFO'), 'GENERAL_INFO');
    assert.equal(data.meta.formatVersion, 3);
    assert.ok(!typesIn(data).includes('u-1'), 'clear-on-reload dropped the previous entries');

    const info = data.postMessages.find((e) => e.data.type === 'GENERAL_INFO').data.content;
    assert.equal(info.activeMember, '<undefined>', 'a key sent as undefined is kept');
    assert.equal(info.nan, '<NaN>');
    assert.equal(info.when, '<Date 1970-01-01T00:00:00.000Z>');
    assert.deepEqual(info.map, { '<Map>': [['k', 1]] });
});

test('the cross-site iframe traffic is captured and tagged with its origin', async () => {
    const apiUrl = app.origin + '/api.json';
    // bodies, WebSocket frames and console serialization land asynchronously
    const data = await capture.waitForExport((d) => d.wsSent.length && d.wsReceived.length
        && d.network.some((r) => r.url === apiUrl && r.responseBody)
        && d.console.some((c) => c.args[0] === 'app ready' && c.args[1].nested), 'the iframe traffic');

    const api = data.network.find((r) => r.url === apiUrl);
    assert.equal(api.frame, app.origin);
    assert.match(api.responseBody, /"ok":true/, 'the body is fetched through the iframe session');

    const ready = data.console.find((c) => c.args[0] === 'app ready');
    assert.equal(ready.frame, app.origin);
    // depth 1: one getProperties level (only possible on the iframe session), then a preview whose values are strings
    assert.deepEqual(ready.args[1], { nested: { deep: 'true' } });

    assert.equal(data.network.find((r) => r.type === 'ws').frame, app.origin);
    assert.ok(data.wsReceived.some((f) => f.payload === 'hello-from-ws' && f.frame === app.origin));
    assert.ok(data.wsSent.some((f) => f.payload === 'ping-from-app' && f.frame === app.origin));

    const crmReady = data.console.find((c) => c.args[0] === 'crm ready');
    assert.equal(crmReady.frame, undefined, 'top-page entries carry no frame tag');
});

test('Stop then Start works as a pause: buffer kept, gap recorded, nothing twice', async () => {
    const errors = [];
    const unsubscribe = browser.on((m) => {
        if (m.sessionId === crmSession && m.method === 'Runtime.exceptionThrown') errors.push(m.params);
    });
    const { startedAt } = (await capture.export()).meta;
    await capture.stop();
    await command({ type: 'ANSWER', uid: 'u-while-stopped' });
    await browser.evaluate(crmSession, `console.log('logged while stopped')`);
    assert.equal((await capture.start()).ok, true);
    await command({ type: 'ANSWER', uid: 'u-2' });
    const data = await capture.waitForExport(hasType('u-2'), 'u-2');
    unsubscribe();

    const types = typesIn(data);
    assert.ok(types.includes('GENERAL_INFO'), 'what was captured before the pause is kept');
    assert.ok(!types.includes('u-while-stopped'));
    assert.equal(types.filter((t) => t === 'u-2').length, 1);
    assert.equal(types.filter((t) => t === 'ANSWER').length, 1);
    assert.equal(data.meta.startedAt, startedAt, 'a resume is not a new capture');

    assert.equal(data.meta.interruptions.length, 1);
    const [gap] = data.meta.interruptions;
    assert.equal(gap.reason, 'stopped');
    assert.ok(gap.from < gap.to);

    // every Start makes Chrome replay its console history
    assert.equal(logsIn(data).filter((l) => l === 'crm ready').length, 1, 'nothing already captured comes back');
    const paused = data.console.filter((c) => c.args[0] === 'logged while stopped');
    assert.equal(paused.length, 1, 'a message logged during the pause is recovered from the history');
    assert.ok(paused[0].t > gap.from && paused[0].t < gap.to, 'with its own time, inside the gap');

    assert.deepEqual(errors, []);
    const pageView = await browser.evaluate(crmSession,
        `typeof window.__debugLogsCatcherPostMessage + '/' + typeof window.__debugLogsCatcherListening`);
    assert.equal(pageView, 'undefined/undefined', 'the binding and the guard live in the isolated world only');
});

test('the popup export redacts the postMessage payloads', async () => {
    const apiUrl = app.origin + '/api.json';
    await browser.reload(crmSession);
    await capture.waitForExport((d) => hasType('GENERAL_INFO')(d)
        && d.network.some((r) => r.url === apiUrl && r.responseBody), 'the app boot');
    const popup = await openPopupFor(browser, extension, crmTabId);
    await waitFor(async () => Number(await browser.evaluate(popup,
        `document.getElementById('postMessageCount').textContent`)) >= 1, 'the popup counter');

    const text = await exportFromPopup(browser, popup);
    const exported = JSON.parse(text);
    const info = exported.postMessages.find((e) => e.data.type === 'GENERAL_INFO').data.content;
    assert.equal(info.activeMember, '<undefined>', 'the marker survives the redaction round trip');
    assert.equal(info.urlPhoto, 'https://pbx.example/photo/42?jwt=eyJ***DU2');
    assert.ok(!text.includes(APP_JWT), 'no raw JWT anywhere in the file');
    assert.equal(exported.network.find((r) => r.url === apiUrl).responseBody.password, '<redacted>');
});

test('a same-site iframe shares the tab session: captured, untagged', async () => {
    const child = await serve('127.0.0.1', childRoutes());
    // same host, another port: same site, so the same process
    const host = await serve('127.0.0.1', hostRoutes(child.origin));
    try {
        const hostUrl = host.origin + '/host.html';
        const hostSession = await browser.openPage(hostUrl);
        const hostCapture = extension.capture(await extension.tabIdOf(hostUrl));
        assert.equal((await hostCapture.start()).ok, true);
        await browser.reload(hostSession);
        await browser.evaluate(hostSession,
            `document.getElementById('child').contentWindow.postMessage({ type: 'hello' }, '*')`);
        const data = await hostCapture.waitForExport(hasType('reply-hello'), 'the reply');

        const hello = data.postMessages.find((e) => e.data.type === 'hello');
        assert.equal(hello.receiver, child.origin, 'the listener runs in same-site iframes too');
        assert.equal(hello.source, 'parent');
        const request = data.network.find((r) => r.url === child.origin + '/child.json');
        assert.ok(request, 'the same-site iframe request is captured');
        assert.equal(request.frame, undefined, 'and not tagged: it comes through the tab session');
        await hostCapture.stop();
    } finally {
        child.close();
        host.close();
    }
});
