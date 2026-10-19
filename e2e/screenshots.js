// Regenerates the Chrome Web Store screenshots in screenshots/ (1280×800): the real popup, rendered by the real
// extension in light theme, then laid on the listing background. The popup is fed a fixed state (stubbed runtime
// messages) so the images do not depend on any capture. Usage: npm run screenshots
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './support/browser.js';
import { EXTENSION_DIR, installExtension, popupStateStub } from './support/extension.js';
import { serve } from './support/server.js';
import { waitFor } from './support/wait.js';

const OUT = path.join(EXTENSION_DIR, 'screenshots');
const WIDTH = 1280;
const HEIGHT = 800;
const POPUP_WIDTH = 300;
const IDLE = { attached: false, sent: 0, received: 0, console: 0, network: 0, postMessages: 0 };
const CAPTURING = { attached: true, startedAt: 1, sent: 5, received: 7, console: 427, network: 73, postMessages: 38 };
const DOMAINS = ['mywebsite.example.com', 'api.example.com'];

const SHOTS = [
    { file: '01-popup-idle.png', status: IDLE, scale: 2 },
    { file: '02-popup-settings.png', status: IDLE, scale: 1.3, settings: true },
    { file: '03-popup-capturing.png', status: CAPTURING, scale: 2 }
];

async function renderPopup(browser, extensionId, shot) {
    const session = await browser.openPage(`chrome-extension://${extensionId}/popup.html`, {
        initScript: popupStateStub(shot.status, DOMAINS),
        setup: async (s) => {
            await browser.send('Emulation.setEmulatedMedia',
                { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, s);
            await browser.send('Emulation.setDeviceMetricsOverride',
                { width: POPUP_WIDTH, height: 600, deviceScaleFactor: shot.scale, mobile: false }, s);
        }
    });
    await waitFor(() => browser.evaluate(session,
        `document.getElementById('consoleCount').textContent === '${shot.status.console}'`), 'the popup state');
    // no focus in the textarea: headless Chrome draws the focus ring black, not in the system accent colour
    if (shot.settings) await browser.evaluate(session, `document.querySelector('details').open = true`);
    // the body's own height: scrollHeight never goes below the viewport's
    const height = await browser.evaluate(session, 'Math.ceil(document.body.getBoundingClientRect().height)');
    const { data } = await browser.send('Page.captureScreenshot',
        { format: 'png', clip: { x: 0, y: 0, width: POPUP_WIDTH, height, scale: 1 } }, session);
    return data;
}

function stagePage(png, scale) {
    return `<!doctype html><style>
body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; display: flex; align-items: center; justify-content: center;
       background: linear-gradient(135deg, #eef2ff, #cbd5e1); }
img { width: ${POPUP_WIDTH * scale}px; border-radius: ${10 * scale}px;
      box-shadow: 0 0 0 1px rgba(15, 23, 42, .08), 0 30px 80px rgba(15, 23, 42, .28); }
</style><img src="data:image/png;base64,${png}">`;
}

const browser = launchBrowser();
let stage;
try {
    const extensionId = await installExtension(browser);
    let current = '';
    stage = await serve('127.0.0.1', { '/stage.html': { type: 'text/html', body: () => current } });
    for (const shot of SHOTS) {
        current = stagePage(await renderPopup(browser, extensionId, shot), shot.scale);
        const session = await browser.openPage(stage.origin + '/stage.html', {
            setup: (s) => browser.send('Emulation.setDeviceMetricsOverride',
                { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, s)
        });
        const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, session);
        fs.writeFileSync(path.join(OUT, shot.file), Buffer.from(data, 'base64'));
        console.log('written', path.join('screenshots', shot.file));
    }
} finally {
    if (stage) stage.close();
    await browser.close();
}
