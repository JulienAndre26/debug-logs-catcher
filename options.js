'use strict';

const DEFAULT_MAX_BODY_KB = 200;
const MAX_BODY_KB = 1000;
const DEFAULT_CONSOLE_DEPTH = 1;
const MAX_CONSOLE_DEPTH = 8;

function flashAck() {
    const ack = document.getElementById('saveAck');
    ack.classList.remove('hidden');
    setTimeout(() => ack.classList.add('hidden'), 1200);
}

function setRange(id, value) {
    document.getElementById(id).value = value;
    document.getElementById(id + 'Val').textContent = value;
}

function bindRange(id, key, def, min, max) {
    const el = document.getElementById(id);
    const out = document.getElementById(id + 'Val');
    // Live value while dragging; persist only when released (change) to avoid a storage write per tick.
    el.addEventListener('input', () => { out.textContent = el.value; });
    el.addEventListener('change', () => {
        let n = Math.floor(Number(el.value));
        if (!Number.isFinite(n)) n = def;
        n = Math.min(max, Math.max(min, n));
        setRange(id, n);
        chrome.storage.local.set({ [key]: n });
        flashAck();
    });
}

async function load() {
    const s = await chrome.storage.local.get(['maxBodyKB', 'consoleDepth']);
    const depth = Number.isInteger(s.consoleDepth) && s.consoleDepth >= 0
        ? Math.min(MAX_CONSOLE_DEPTH, s.consoleDepth)
        : DEFAULT_CONSOLE_DEPTH;
    const maxKB = Number(s.maxBodyKB) > 0
        ? Math.min(MAX_BODY_KB, Math.floor(Number(s.maxBodyKB)))
        : DEFAULT_MAX_BODY_KB;
    setRange('consoleDepth', depth);
    setRange('maxBodyKB', maxKB);
}

bindRange('consoleDepth', 'consoleDepth', DEFAULT_CONSOLE_DEPTH, 0, MAX_CONSOLE_DEPTH);
bindRange('maxBodyKB', 'maxBodyKB', DEFAULT_MAX_BODY_KB, 1, MAX_BODY_KB);

load();
