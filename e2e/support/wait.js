export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls fn until it returns a truthy value, which is returned; a throw counts as "not yet".
export async function waitFor(fn, label, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const value = await Promise.resolve().then(fn).catch(() => undefined);
        if (value) return value;
        await sleep(100);
    }
    throw new Error('timeout waiting for ' + label);
}
