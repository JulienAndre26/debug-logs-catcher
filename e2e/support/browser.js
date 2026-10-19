// A headless Google Chrome driven over the DevTools Protocol. Spawned with --remote-debugging-pipe (CDP over file
// descriptors 3/4, NUL-delimited JSON, flat sessions) and --enable-unsafe-extension-debugging, which unlocks
// Extensions.loadUnpacked: branded Chrome no longer honours --load-extension. Set CHROME_PATH for another binary.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitFor } from './wait.js';

export function launchBrowser() {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlc-e2e-'));
    const proc = spawn(process.env.CHROME_PATH || '/usr/bin/google-chrome', [
        '--headless=new',
        '--remote-debugging-pipe',
        '--enable-unsafe-extension-debugging',
        '--site-per-process',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        `--user-data-dir=${userDataDir}`,
        'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    const [, , , toChrome, fromChrome] = proc.stdio;
    const pending = new Map();
    const listeners = new Set();
    let nextId = 1;
    let buffer = '';

    fromChrome.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let end;
        while ((end = buffer.indexOf('\0')) !== -1) {
            const message = JSON.parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
            const call = message.id !== undefined && pending.get(message.id);
            if (call) {
                pending.delete(message.id);
                if (message.error) call.reject(new Error(call.method + ': ' + message.error.message));
                else call.resolve(message.result);
            } else if (message.method) {
                listeners.forEach((listener) => listener(message));
            }
        }
    });

    function send(method, params = {}, sessionId) {
        const id = nextId++;
        toChrome.write(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }) + '\0');
        return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
    }

    // Subscribes to every protocol event; returns the unsubscribe function.
    function on(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    async function evaluate(sessionId, expression) {
        const params = { expression, awaitPromise: true, returnByValue: true };
        const result = await send('Runtime.evaluate', params, sessionId);
        if (result.exceptionDetails) throw new Error('evaluate failed: ' + result.exceptionDetails.text);
        return result.result.value;
    }

    // Opens a tab on url and resolves once it has loaded, iframes included. initScript runs before the page's own
    // scripts; setup(sessionId) runs before the navigation (emulation…). Resolves with the CDP session id.
    async function openPage(url, { initScript, setup } = {}) {
        const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
        await send('Page.enable', {}, sessionId);
        if (setup) await setup(sessionId);
        if (initScript) await send('Page.addScriptToEvaluateOnNewDocument', { source: initScript }, sessionId);
        await send('Page.navigate', { url }, sessionId);
        await waitFor(() => evaluate(sessionId, `document.URL === ${JSON.stringify(new URL(url).href)}
            && document.readyState === 'complete'`), 'the load of ' + url);
        return sessionId;
    }

    // Reloads and resolves once the new document has loaded.
    async function reload(sessionId) {
        const before = await evaluate(sessionId, 'performance.timeOrigin');
        await send('Page.reload', {}, sessionId);
        await waitFor(() => evaluate(sessionId, `performance.timeOrigin !== ${before}
            && document.readyState === 'complete'`), 'the reload');
    }

    // The profile can only go once Chrome is gone: it keeps writing into it while it shuts down.
    async function close() {
        const exited = new Promise((resolve) => proc.once('exit', resolve));
        send('Browser.close').catch(() => {});
        const kill = setTimeout(() => proc.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(kill);
        fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    return { send, on, evaluate, openPage, reload, close };
}
