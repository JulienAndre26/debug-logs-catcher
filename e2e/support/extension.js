import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, waitFor } from './wait.js';

export const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES_DIR = path.join(EXTENSION_DIR, 'e2e', 'fixtures');

// Start answers once the tab session is set up; cross-site iframes get theirs right after, asynchronously.
const ATTACH_SETTLE_MS = 500;

export async function installExtension(browser, dir = EXTENSION_DIR) {
    const { id } = await browser.send('Extensions.loadUnpacked', { path: dir });
    return id;
}

// Loads Debug Logs Catcher and drives its service worker with the popup's own runtime messages, sent from its
// options page (an extension page, so chrome.runtime is there).
export async function loadExtension(browser) {
    const id = await installExtension(browser);
    const page = await browser.openPage(`chrome-extension://${id}/options.html`);
    const message = (msg) => browser.evaluate(page, `chrome.runtime.sendMessage(${JSON.stringify(msg)})`);

    function capture(tabId) {
        const exportData = async () => (await message({ type: 'export', tabId })).data;
        return {
            start: async () => {
                const reply = await message({ type: 'start', tabId });
                await sleep(ATTACH_SETTLE_MS);
                return reply;
            },
            stop: () => message({ type: 'stop', tabId }),
            clear: () => message({ type: 'clear', tabId }),
            status: () => message({ type: 'status', tabId }),
            export: exportData,
            // the export, once predicate(export) holds
            waitForExport: (predicate, label) => waitFor(async () => {
                const data = await exportData();
                return predicate(data) && data;
            }, label)
        };
    }

    return {
        id,
        tabIdOf: (url) => browser.evaluate(page,
            `chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url === ${JSON.stringify(url)}).id)`),
        capture
    };
}

// The real popup, acting on tabId: it otherwise acts on the active tab, which would be itself.
export function openPopupFor(browser, extension, tabId) {
    return browser.openPage(`chrome-extension://${extension.id}/popup.html`, {
        initScript: `if (globalThis.chrome && chrome.tabs) {
            const query = chrome.tabs.query.bind(chrome.tabs);
            chrome.tabs.query = async (q) => (q && q.active ? [await chrome.tabs.get(${tabId})] : query(q));
        }`
    });
}

// Init script feeding the popup a fixed state instead of the service worker's: active tab, status, granted domains.
export function popupStateStub(status, domains = []) {
    return `if (globalThis.chrome && chrome.runtime) {
        const domains = ${JSON.stringify(domains)};
        chrome.tabs.query = async () => [{ id: 1, url: 'https://mywebsite.example.com/' }];
        chrome.permissions.getAll = async () => ({ origins: domains.map((d) => '*://' + d + '/*') });
        chrome.runtime.sendMessage = (msg, callback) => {
            const reply = msg.type === 'status' ? ${JSON.stringify(status)}
                : msg.type === 'getAutoDomains' ? { domains } : { ok: true };
            setTimeout(() => callback(reply));
        };
    }`;
}

// Shift+clicks Export in an open popup and returns the downloaded raw JSON, as text.
export async function exportFromPopup(browser, popup) {
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'dlc-e2e-downloads-'));
    try {
        await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
        await browser.evaluate(popup, `document.getElementById('export')
            .dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }))`);
        const file = await waitFor(() => fs.readdirSync(downloads).find((f) => f.endsWith('.json')), 'the download');
        return fs.readFileSync(path.join(downloads, file), 'utf8');
    } finally {
        fs.rmSync(downloads, { recursive: true, force: true });
    }
}
