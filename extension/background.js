/*
 * FillDesk background service worker.
 *
 * Two jobs: (1) proxy requests to your local server, because a content script's
 * fetch is bound by the page's origin and cannot carry your token; (2) reach
 * every frame of the tab, because plenty of ATS forms live inside an iframe.
 */
'use strict';

const DEFAULT_SERVER = 'http://127.0.0.1:8756';

async function config() {
  const stored = await chrome.storage.local.get(['server', 'token']);
  return { server: (stored.server || DEFAULT_SERVER).replace(/\/+$/, ''), token: stored.token || '' };
}

async function apiCall({ server, token, path, method = 'GET', body }) {
  const base = (server || DEFAULT_SERVER).replace(/\/+$/, '');
  const init = { method, headers: {}, redirect: 'follow' };
  if (token) init.headers['x-filldesk-token'] = token;
  if (body !== undefined && body !== null && method !== 'GET') {
    init.headers['content-type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  try {
    const res = await fetch(base + path, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    if (!res.ok) return { ok: false, status: res.status, error: (data && data.error) || `HTTP ${res.status}`, hint: data && data.hint };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `cannot reach ${base} — is \`python3 -m server\` running? (${e.message})` };
  }
}

async function fileCall({ server, token, path }) {
  const base = (server || DEFAULT_SERVER).replace(/\/+$/, '');
  try {
    const res = await fetch(base + path, { headers: token ? { 'x-filldesk-token': token } : {} });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} fetching document` };
    const buf = await res.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return { ok: true, base64: btoa(binary), size: bytes.length };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
}

async function broadcast(msg, tabId) {
  if (tabId == null) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) tabId = tab.id;
  }
  if (tabId == null) return { ok: false, error: 'no active tab' };
  try {
    const results = await chrome.tabs.sendMessage(tabId, msg, { allFrames: true });
    return { ok: true, results: Array.isArray(results) ? results : [results] };
  } catch (e) {
    return { ok: false, error: `${e.message} — reload the page after installing the extension` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    switch (msg && msg.type) {
      case 'api': respond(await apiCall(msg)); break;
      case 'file': respond(await fileCall(msg)); break;
      case 'broadcast': respond(await broadcast(msg.msg, sender.tab && sender.tab.id)); break;
      case 'broadcast-external': {
        // popup → every frame except the top one, which already ran its own pass
        const tabId = msg.tabId != null ? msg.tabId : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        if (tabId == null) return respond({ ok: false, error: 'no active tab' });
        try {
          const results = await chrome.tabs.sendMessage(tabId, { ...msg.msg, external: true }, { allFrames: true });
          respond({ ok: true, results: Array.isArray(results) ? results : [results] });
        } catch (e) { respond({ ok: false, error: String(e.message) }); }
        break;
      }
      case 'open-popup': {
        const url = chrome.runtime.getURL('popup.html');
        chrome.tabs.create({ url });
        respond({ ok: true, url });
        break;
      }
      case 'open-dashboard': {
        const { server } = await config();
        chrome.tabs.create({ url: server });
        respond({ ok: true });
        break;
      }
      case 'save-packet': {
        await chrome.storage.local.set({ packet_id: msg.packet_id || '' });
        respond({ ok: true });
        break;
      }
      case 'get-packet': respond({ ok: true, packet_id: (await chrome.storage.local.get('packet_id')).packet_id || '' }); break;
      case 'save-config': {
        const patch = {};
        if (msg.server !== undefined) patch.server = String(msg.server || '').trim().replace(/\/+$/, '') || DEFAULT_SERVER;
        if (msg.token !== undefined) patch.token = String(msg.token || '').trim();
        await chrome.storage.local.set(patch);
        respond({ ok: true });
        break;
      }
      case 'capture-tab': {
        try {
          const winId = sender.tab && sender.tab.windowId;
          const dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: 'jpeg', quality: 60 });
          respond({ ok: true, dataUrl });
        } catch (e) {
          respond({ ok: false, error: String((e && e.message) || e) });
        }
        break;
      }
      case 'get-config': {
        const cfg = await config();
        respond({ ok: true, ...cfg });
        break;
      }
      default: respond({ ok: false, error: 'unknown message: ' + (msg && msg.type) });
    }
  })();
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  const type = command === 'save-job' ? 'save-job' : 'run';
  const res = await broadcast({ type });
  if (!res.ok) {
    const { server } = await config();
    chrome.notifications && chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'FillDesk',
      message: res.error + ` — dashboard: ${server}`,
    });
  }
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.action.setBadgeBackgroundColor({ color: '#5b8cff' });
  if (reason === 'install') {
    chrome.storage.local.get(['server'], (stored) => {
      if (!stored.server) chrome.storage.local.set({ server: DEFAULT_SERVER });
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    chrome.tabs.sendMessage(tabId, { type: 'url_changed', url: changeInfo.url }).catch(() => {});
  }
});
