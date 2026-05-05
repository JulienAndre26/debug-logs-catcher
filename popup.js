'use strict';

let currentTabId;
let refreshTimer;

function send(msg) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(msg, (response) => {
            if (chrome.runtime.lastError) {
                resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else {
                resolve(response);
            }
        });
    });
}

function showError(text) {
    const el = document.getElementById('errBox');
    if (!text) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }
    el.textContent = text;
    el.classList.remove('hidden');
}

async function refresh() {
    if (currentTabId === undefined) return;
    const status = await send({ type: 'status', tabId: currentTabId });
    document.getElementById('attachState').textContent = status.attached ? 'Capturing' : 'Idle';
    document.getElementById('sentCount').textContent = status.sent;
    document.getElementById('recvCount').textContent = status.received;
    document.getElementById('consoleCount').textContent = status.console;
    document.getElementById('networkCount').textContent = status.network;
    document.getElementById('dot').className = 'dot ' + (status.attached ? 'on' : 'off');
    document.getElementById('toggle').textContent = status.attached ? 'Stop' : 'Start';
    const total = status.sent + status.received + status.console + status.network;
    document.getElementById('export').disabled = total === 0;
}

async function onToggle() {
    showError('');
    const status = await send({ type: 'status', tabId: currentTabId });
    const result = status.attached
        ? await send({ type: 'stop', tabId: currentTabId })
        : await send({ type: 'start', tabId: currentTabId });
    if (!result.ok) showError(result.error || 'operation failed');
    refresh();
}

async function onClear() {
    await send({ type: 'clear', tabId: currentTabId });
    refresh();
}

async function onExport() {
    const result = await send({ type: 'export', tabId: currentTabId });
    if (!result.ok) {
        showError(result.error || 'export failed');
        return;
    }
    const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `capture-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

async function loadAutoDomains() {
    const { domains } = await send({ type: 'getAutoDomains' });
    document.getElementById('autoDomains').value = (domains || []).join('\n');
}

async function onSaveAutoDomains() {
    const lines = document.getElementById('autoDomains').value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    await send({ type: 'setAutoDomains', domains: lines });
    const ack = document.getElementById('saveAck');
    ack.classList.remove('hidden');
    setTimeout(() => ack.classList.add('hidden'), 1500);
}

async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
        showError('no active tab');
        return;
    }
    currentTabId = tab.id;

    document.getElementById('toggle').addEventListener('click', onToggle);
    document.getElementById('clear').addEventListener('click', onClear);
    document.getElementById('export').addEventListener('click', onExport);
    document.getElementById('saveAutoDomains').addEventListener('click', onSaveAutoDomains);

    await loadAutoDomains();
    await refresh();
    refreshTimer = setInterval(refresh, 1000);
}

window.addEventListener('unload', () => {
    if (refreshTimer) clearInterval(refreshTimer);
});

init();