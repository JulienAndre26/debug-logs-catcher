// Known Chrome limitation, pinned: no extension may debug a tab holding a frame of another extension (e.g. a password
// manager's inline menu). Chrome decides it on its own — 1.1.0, which attached to no iframe, behaved the same. These
// tests document the behaviour and how the extension copes; one failing on the Chrome side means Chrome changed it,
// and the README "Limits" section needs a look.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { launchBrowser } from './support/browser.js';
import { FIXTURES_DIR, installExtension, loadExtension, openPopupFor } from './support/extension.js';
import { serve } from './support/server.js';
import { waitFor } from './support/wait.js';
import { foreignFrameRoutes } from './fixtures/pages.js';

let browser;
let extension;
let page;

before(async () => {
    browser = launchBrowser();
    extension = await loadExtension(browser);
    const foreignId = await installExtension(browser, path.join(FIXTURES_DIR, 'foreign-extension'));
    page = await serve('127.0.0.1', foreignFrameRoutes(foreignId));
});

after(async () => {
    page.close();
    await browser.close();
});

test('a foreign extension iframe appearing mid-capture ends the capture; Start resumes it, gap recorded', async () => {
    const url = page.origin + '/page.html';
    const session = await browser.openPage(url);
    const tabId = await extension.tabIdOf(url);
    const capture = extension.capture(tabId);
    assert.equal((await capture.start()).ok, true);
    await browser.evaluate(session, `console.log('before the iframe')`);
    await browser.evaluate(session, 'addForeignFrame()');
    const status = await waitFor(async () => {
        const s = await capture.status();
        return !s.attached && s;
    }, 'Chrome ending the capture');
    assert.equal(status.detachReason, 'target_closed');

    const popup = await openPopupFor(browser, extension, tabId);
    const notice = await waitFor(() => browser.evaluate(popup,
        `!document.getElementById('detachNotice').classList.contains('hidden')
            && document.getElementById('detachNoticeBody').textContent`), 'the popup notice');
    assert.match(notice, /another extension/, 'the popup says why the capture stopped');

    await browser.evaluate(session, 'removeForeignFrame()');
    assert.equal((await capture.start()).ok, true);
    await browser.evaluate(session, `console.log('after the iframe')`);
    const data = await capture.waitForExport((d) => d.console.some((c) => c.args[0] === 'after the iframe'),
        'the resumed capture');
    const logs = data.console.map((c) => c.args[0]);
    assert.equal(logs.filter((l) => l === 'before the iframe').length, 1, 'one buffer across the gap, no duplicate');
    assert.equal(data.meta.interruptions.length, 1);
    const [gap] = data.meta.interruptions;
    assert.equal(gap.reason, 'target_closed');
    assert.ok(gap.from < gap.to);
    assert.equal((await capture.status()).detachReason, undefined);
});

test('Start is refused while a foreign extension iframe is in the page', async () => {
    const url = page.origin + '/page.html?again';
    const session = await browser.openPage(url);
    await browser.evaluate(session, 'addForeignFrame()');
    const start = await extension.capture(await extension.tabIdOf(url)).start();
    assert.equal(start.ok, false);
    assert.match(start.error, /Cannot access a chrome-extension:\/\/ URL of different extension/);
});
