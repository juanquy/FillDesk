'use strict';

const $ = (sel) => document.querySelector(sel);
const DEFAULT_SERVER = 'http://127.0.0.1:8756';

function bg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(res || { ok: false, error: 'background did not answer' });
      });
    } catch (e) { resolve({ ok: false, error: String(e && e.message) }); }
  });
}

let cfg = { server: DEFAULT_SERVER, token: '' };

const BUILD = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?';

function setStatus(text, on) {
  // The version is printed everywhere the user looks, because "did my extension
  // actually reload?" must never again be answered by guessing from a stack line.
  $('#status').textContent = `${text} · v${BUILD}`;
  $('#dot').classList.toggle('on', !!on);
}

async function api(path, opts = {}) {
  return bg({ type: 'api', server: cfg.server, token: cfg.token, path, ...opts });
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

async function sendToPage(msg) {
  const tab = await activeTab();
  if (!tab) return { ok: false, error: 'no active tab' };
  return bg({ type: 'broadcast', msg, tabId: tab.id });
}

async function refresh() {
  const c = await bg({ type: 'get-config' });
  cfg = { server: (c && c.server) || DEFAULT_SERVER, token: (c && c.token) || '' };
  $('#server').value = cfg.server;
  $('#token').value = cfg.token;

  const st = await api('/api/status');
  if (!st.ok) {
    setStatus(st.error, false);
    if (st.hint) setStatus(st.hint, false);
    return;
  }
  const s = st.data;
  setStatus(`connected · ${s.llm.provider === 'none' ? 'rule-based writing' : s.llm.model} · ${s.jobs} jobs · profile ${s.profile.score}%`, true);
  const c2 = s.stats || {};
  $('#counts').innerHTML = `autofill so far: <b>${c2.filled || 0}</b> fields filled · <b>${c2.unmatched || 0}</b> unrecognised · <b>${c2.blocked || 0}</b> refused (compliance)`;

  const list = await api('/api/autofill/latest');
  const sel = $('#packet');
  const current = await bg({ type: 'get-packet' });
  sel.innerHTML = '<option value="">most recently approved</option>';
  ((list.data && list.data.packets) || []).forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.company || '?'} — ${p.title || 'packet'}${p.answers_needs_input ? ` (${p.answers_needs_input} open)` : ''}`;
    sel.appendChild(opt);
  });
  if (current && current.packet_id) sel.value = current.packet_id;

  const tab = await activeTab();
  if (tab && /^https?:/.test(tab.url || '')) {
    const page = await bg({ type: 'broadcast', msg: { type: 'status' }, tabId: tab.id });
    const frames = (page.results || []).filter(Boolean);
    const fields = frames.reduce((n, r) => n + (r.fields || 0), 0);
    const appLike = frames.some((r) => r.appLike);
    $('#page').classList.remove('hidden');
    $('#pageinfo').textContent = appLike || fields >= 2
      ? `${tab.url.replace(/^https?:\/\//, '').slice(0, 46)} · ${fields} input${fields === 1 ? '' : 's'} found across ${frames.length} frame${frames.length === 1 ? '' : 's'}`
      : 'not auto-detected as a job form — click Toggle panel below to open FillDesk';
  } else {
    $('#page').classList.add('hidden');
    $('#pageinfo').textContent = 'open a job application in a tab first';
  }
}

$('#save').onclick = async () => {
  await bg({ type: 'save-config', server: $('#server').value, token: $('#token').value });
  $('#save').textContent = 'Saved';
  refresh();
  setTimeout(() => ($('#save').textContent = 'Save connection'), 1400);
};

$('#dash').onclick = () => bg({ type: 'open-dashboard' });

$('#packet').onchange = async () => {
  await bg({ type: 'save-packet', packet_id: $('#packet').value });
  $('#packet').title = $('#packet').value ? 'this packet will be used' : 'latest approved packet will be used';
};

async function pageAction(type, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'working…';
  const res = await sendToPage({ type });
  const results = (res.results || []).filter((r) => r && r.ok);
  if (!res.ok) setStatus(res.error, false);
  else if (type === 'scan' && results[0] && results[0].counts) {
    const c = results[0].counts;
    setStatus(`preview: ${c.fill || 0} to fill, ${c.upload || 0} uploads, ${c.block || 0} you must answer`, true);
  } else if (type === 'run') setStatus(`filled in ${results.length} frame${results.length === 1 ? '' : 's'} — read the form, then submit it yourself`, true);
  button.disabled = false;
  button.textContent = original;
}

$('#fill').onclick = (e) => pageAction('run', e.target);
$('#preview').onclick = (e) => pageAction('scan', e.target);
$('#savejob').onclick = (e) => pageAction('save-job', e.target);
$('#next').onclick = (e) => pageAction('next', e.target);
const toggleBtn = $('#togglepanel');
if (toggleBtn) toggleBtn.onclick = () => sendToPage({ type: 'toggle' });

refresh();
