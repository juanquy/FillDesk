/* FillDesk dashboard — vanilla JS, no build step. */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// --------------------------------------------------------------------- api
async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
  }
  if (opts.body !== undefined) init.body = opts.body;
  if (opts.headers) Object.assign(init.headers, opts.headers);
  const res = await fetch(path, init);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
  if (!res.ok) throw Object.assign(new Error(data.error || res.status + ' ' + res.statusText), { payload: data, status: res.status });
  return data;
}

let TOAST_T = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast ' + kind;
  clearTimeout(TOAST_T);
  TOAST_T = setTimeout(() => el.classList.add('hidden'), 5200);
}

function modal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  const cancel = $('#modal-cancel');
  const confirm = $('#modal-confirm');
  const close = $('#modal-close');
  if (cancel) cancel.classList.add('hidden');
  if (confirm) confirm.classList.add('hidden');
  if (close) close.classList.remove('hidden');
  $('#modal').classList.remove('hidden');
}

function confirmModal({ title, html, confirmText = 'Confirm', cancelText = 'Cancel', kind = 'primary' }) {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = html;
    const cancel = $('#modal-cancel');
    const confirm = $('#modal-confirm');
    const close = $('#modal-close');
    if (close) close.classList.add('hidden');
    if (cancel) {
      cancel.classList.remove('hidden');
      cancel.textContent = cancelText;
    }
    if (confirm) {
      confirm.classList.remove('hidden');
      confirm.className = kind;
      confirm.textContent = confirmText;
    }
    const cleanup = (val) => {
      $('#modal').classList.add('hidden');
      if (cancel) cancel.onclick = null;
      if (confirm) confirm.onclick = null;
      resolve(val);
    };
    if (cancel) cancel.onclick = () => cleanup(false);
    if (confirm) confirm.onclick = () => cleanup(true);
    $('#modal').classList.remove('hidden');
  });
}
$('#modal-close').onclick = () => $('#modal').classList.add('hidden');
$('#modal').onclick = (e) => {
  if (e.target.id === 'modal') {
    const cancel = $('#modal-cancel');
    if (cancel && !cancel.classList.contains('hidden')) cancel.click();
    else $('#modal').classList.add('hidden');
  }
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --------------------------------------------------------------------- tabs
$$('.tab').forEach((btn) => {
  btn.onclick = () => {
    $$('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    $$('section.panel').forEach((p) => p.classList.remove('active'));
    $('#tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'profile') renderProfile();
    if (btn.dataset.tab === 'jobs') loadJobs();
    if (btn.dataset.tab === 'packets') loadPackets();
    if (btn.dataset.tab === 'settings') loadSettings();
    window.scrollTo(0, 0);
  };
});
function showPanel(id) {
  $$('section.panel').forEach((p) => p.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo(0, 0);
}

// --------------------------------------------------------------------- status
async function loadStatus() {
  try {
    const s = await api('/api/status');
    const llm = $('#pill-llm');
    llm.textContent = s.llm.provider === 'none' ? 'rule-based writing' : `${s.llm.provider} · ${s.llm.model}`;
    llm.className = 'pill ' + (s.llm.provider === 'none' ? 'warn' : 'ok');
    const pr = $('#pill-profile');
    pr.textContent = `profile ${s.profile.score}%`;
    pr.className = 'pill ' + (s.profile.score >= 80 ? 'ok' : s.profile.score >= 45 ? 'warn' : 'bad');
    pr.title = s.profile.missing.length ? 'missing: ' + s.profile.missing.join(', ') : 'complete';
    $('#pill-counts').textContent = `${s.jobs} jobs · ${s.packets} packets`;
    const st = s.stats || {};
    $('#stats').innerHTML = `
      <div class="stat"><b>${st.filled || 0}</b><span>fields filled by autofill</span></div>
      <div class="stat"><b>${st.unmatched || 0}</b><span>fields it could not match</span></div>
      <div class="stat"><b>${st.blocked || 0}</b><span>compliance fields it refused</span></div>
      <div class="stat"><b>${Object.keys(st.by_host || {}).length}</b><span>distinct ATS hosts seen</span></div>`;
  } catch (e) { toast('status: ' + e.message, 'err'); }
}

// --------------------------------------------------------------------- tiny markdown
function mdToHtml(md) {
  const out = [];
  let list = null;
  for (const rawline of String(md || '').split('\n')) {
    const line = rawline.trim();
    const isItem = /^([-*•]|\d+[.)])\s+/.test(line);
    if (!isItem && list) { out.push('</ul>'); list = null; }
    if (!line) continue;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${Math.min(h[1].length, 3)}>${inline(h[2])}</h${Math.min(h[1].length, 3)}>`); continue; }
    if (/^[-*_]{3,}$/.test(line)) { out.push('<hr>'); continue; }
    if (isItem) {
      if (!list) { out.push('<ul>'); list = 1; }
      out.push(`<li>${inline(line.replace(/^([-*•]|\d+[.)])\s+/, ''))}</li>`);
      continue;
    }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');

  function inline(t) {
    let s = esc(t);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\[[^\]]*(NEEDS INPUT|NEEDS REVIEW|TODO|VERIFY)[^\]]*\]/gi, '<span class="needs">$&</span>');
    return s;
  }
}

// --------------------------------------------------------------------- profile
let PROFILE = null;

async function loadProfile() { PROFILE = await api('/api/profile'); renderProfile(); renderProfileWarnings(); }

function renderProfileWarnings() {
  const box = $('#p-warnings');
  const warnings = (PROFILE && PROFILE.warnings) || [];
  if (!warnings.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = `<h3>${warnings.length} thing${warnings.length === 1 ? '' : 's'} to fix before you apply</h3>
    <ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
}

function renderProfile() {
  if (!PROFILE) return;
  const p = PROFILE;
  const set = (id, v) => { const el = $(id); if (el) el.value = v == null ? '' : v; };
  set('#p-name', p.name); set('#p-email', p.email); set('#p-phone', p.phone);
  const addr = p.address || {};
  set('#p-addr1', addr.address_line1 || addr.line1);
  set('#p-addr2', addr.address_line2 || addr.line2);
  set('#p-city', addr.city);
  set('#p-state', addr.state);
  set('#p-postal', addr.postal_code || addr.postal);
  set('#p-country', addr.country || 'United States');
  set('#p-location', p.location); set('#p-headline', p.headline); set('#p-pronouns', p.pronouns);
  set('#p-linkedin', (p.links || {}).linkedin); set('#p-github', (p.links || {}).github); set('#p-other', (p.links || {}).other);
  set('#p-salary', p.salary_expectation); set('#p-relocation', p.relocation);
  const prefs = p.preferences || {};
  set('#p-willing-relocate', prefs.willing_to_relocate != null ? (prefs.willing_to_relocate ? 'Yes' : 'No') : 'Yes');
  set('#p-start', p.start_date); set('#p-notice', p.notice_period);
  set('#p-howheard', prefs.how_heard);
  const wa = p.work_authorization || {};
  set('#p-wa-status', wa.status || (wa.is_citizen ? 'U.S. Citizen' : ''));
  set('#p-wa-sponsor', wa.requires_sponsorship ? 'Yes' : 'No');
  set('#p-workauth', p.work_authorization_note);
  const eeoc = p.eeoc || {};
  set('#p-eeoc-gender', eeoc.gender);
  set('#p-eeoc-race', eeoc.race);
  set('#p-eeoc-veteran', eeoc.veteran);
  set('#p-eeoc-disability', eeoc.disability);
  set('#p-resume', p.master_resume_markdown); set('#p-summary', p.summary);
  set('#p-skills', (p.skills || []).join(', ')); set('#p-certs', (p.certifications || []).join(', '));
  set('#p-languages', (p.languages || []).join(', '));
  renderExperience(); renderEducation(); renderBoilerplate();
}

/** Give every date field in a scope its calendar button (see shared/datepicker.js). */
function bindCalendars(scope) {
  if (window.FILLDESK_CAL) window.FILLDESK_CAL.attachAll(scope || document, document);
}

function itemCard(host, item, fields, defaults) {
  const wrap = document.createElement('div');
  wrap.className = 'sub';
  const id = item.id || (defaults.id_prefix + '_' + Math.random().toString(36).slice(2, 8));
  const rows = fields.map((f) => {
    // The picker marker has to land INSIDE the control tag: sitting it outside the
    // branch puts the attribute in the markup as loose text and no button ever binds.
    const cal = f.cal ? ` data-cal="${f.cal}"` : '';
    const control = f.multiline
      ? `<textarea data-k="${f.key}"${cal} rows="4" class="${f.key === 'bullets' ? 'mono' : ''}" placeholder="${esc(f.ph || '')}">${esc(f.key === 'bullets' ? (item[f.key] || []).join('\n') : item[f.key] || '')}</textarea>`
      : `<input data-k="${f.key}"${cal} value="${esc(item[f.key] || '')}" placeholder="${esc(f.ph || '')}">`;
    return `
    <div class="row" data-field="${f.key}"><label>${esc(f.label)}</label>
      ${control}
    </div>`;
  }).join('');
  wrap.innerHTML = `<div class="head"><span class="muted">${esc(item.title || item.label || item.school || 'entry')}</span>
      <button class="x ghost" type="button">remove</button></div>
      <div class="${fields.some((f) => f.multiline) ? 'fields' : 'grid3'}">${rows}</div>`;
  wrap.querySelector('button.x').onclick = () => { wrap.remove(); };
  wrap.dataset.id = id;
  host.appendChild(wrap);
  return wrap;
}

function collect(host, fields) {
  return Array.from(host.querySelectorAll('.sub')).map((card) => {
    const obj = { id: card.dataset.id };
    for (const f of fields) {
      const el = card.querySelector(`[data-k="${f.key}"]`);
      if (!el) continue;
      obj[f.key] = f.key === 'bullets'
        ? el.value.split('\n').map((s) => s.replace(/^[-*•]\s*/, '').trim()).filter(Boolean)
        : (f.list ? el.value.split(',').map((s) => s.trim()).filter(Boolean) : el.value);
    }
    return obj;
  });
}

const EXP_FIELDS = [
  { key: 'company', label: 'Company', ph: 'Figma' },
  { key: 'title', label: 'Title', ph: 'Senior Product Manager' },
  { key: 'location', label: 'Location', ph: 'Remote' },
  { key: 'start', label: 'Start', ph: '2021-06', cal: 'ym' },
  { key: 'end', label: 'End', ph: 'Present', cal: 'ym' },
  { key: 'context', label: 'What the company/product does', multiline: true, ph: 'One line so the writer understands the scope.' },
  { key: 'bullets', label: 'Achievements (one per line — keep the numbers)', multiline: true, ph: 'Rebuilt checkout → +23% paid conversion' },
  { key: 'tech', label: 'Tools / tech used here (comma separated)', list: true },
];
const EDU_FIELDS = [
  { key: 'school', label: 'School / Institution', ph: 'UC Berkeley' },
  { key: 'degree', label: 'Degree / Level', ph: 'BS' },
  { key: 'field', label: 'Major / Field of study', ph: 'EECS' },
  { key: 'minor', label: 'Minor', ph: 'Optional' },
  { key: 'start_year', label: 'Start Year', cal: 'y', ph: '2014' },
  { key: 'start_month', label: 'Start Month', ph: 'September' },
  { key: 'end_year', label: 'End / Grad Year', cal: 'y', ph: '2018' },
  { key: 'end_month', label: 'End Month', ph: 'May' },
  { key: 'school_fallback', label: 'Fallback if unlisted', ph: 'Other' },
  { key: 'notes', label: 'Notes (honours, thesis)' },
];
const BOIL_FIELDS = [
  // The example has to be answerable before an employer exists; it used to suggest
  // "Why this company?", the one prompt that cannot be written in advance.
  { key: 'label', label: 'Question this answers', ph: 'Why are you leaving your current role?' },
  { key: 'text', label: 'Your answer', multiline: true, ph: 'Write the real thing. Packets reuse it instead of inventing filler.' },
];

function renderExperience() {
  const host = $('#p-experience'); host.innerHTML = '';
  (PROFILE.experience || []).forEach((e) => itemCard(host, e, EXP_FIELDS, { id_prefix: 'exp' }));
  bindCalendars(host);
}
function renderEducation() {
  const host = $('#p-education'); host.innerHTML = '';
  (PROFILE.education || []).forEach((e) => itemCard(host, e, EDU_FIELDS, { id_prefix: 'edu' }));
  bindCalendars(host);
}
function renderBoilerplate() {
  const host = $('#p-boilerplate'); host.innerHTML = '';
  (PROFILE.boilerplate || []).forEach((b) => decorateAnswerCard(itemCard(host, b, BOIL_FIELDS, { id_prefix: 'ans' })));
}

// Employer-specific prompts ("why this company?") cannot be answered before there is an
// employer, and generic prose under such a label used to be typed into every motivation
// question at every company. Say what belongs there instead.
const EMPLOYER_RX = /why (this|our|the|your)? ?\s*(company|team|organi[sz]ation|org|firm)|why us|why should we|why do you want to work|what (interests|attracts) you about|what do you know about us/i;

function decorateAnswerCard(card) {
  if (!card) return card;
  const label = card.querySelector('input[data-k="label"]');
  const ta = card.querySelector('textarea[data-k="text"]');
  if (!ta) return card;

  const note = document.createElement('div');
  note.className = 'note';
  note.style.cssText = 'margin-top:6px;color:#f0c48a;font-size:11.5px;display:none';
  const fields = card.querySelector('.fields') || card;
  fields.appendChild(note);

  const row = document.createElement('div');
  row.className = 'row inline';
  row.style.marginTop = '6px';
  row.innerHTML = `<button class="ghost" type="button">Polish with AI</button>
    <span class="muted" style="font-size:11.5px">restates your words — adds no numbers, no employers, no claims</span>`;
  fields.appendChild(row);

  const refresh = () => {
    const employer = EMPLOYER_RX.test(label && label.value ? label.value : '');
    note.style.display = employer ? 'block' : 'none';
    note.textContent = employer
      ? 'This answer changes with every employer. FillDesk drafts it per packet from the posting and will not reuse generic text here — answer it in the packet review, or scope the label ("Why this company? — Stripe") to reuse it at that one company.'
      : '';
  };
  if (label) label.addEventListener('input', refresh);
  refresh();

  const btn = row.querySelector('button');
  btn.onclick = async () => {
    const text = ta.value.trim();
    if (text.length < 24) return toast('Write a sentence or two first — there is nothing to rewrite yet.', 'warn');
    const was = btn.textContent;
    btn.disabled = true; btn.textContent = 'Rewriting…';
    try {
      const res = await api('/api/profile/polish', { method: 'POST', json: { text } });
      if (!res.ok) {
        toast(res.refused || 'the rewrite was refused', 'err');
        if (res.attempt) showRefusedRewrite(res.attempt, res.refused);
        return;
      }
      ta.value = res.text;
      toast('Rewritten in place — read it, then Save profile. Nothing was saved yet.', 'ok');
      if (res.note) toast(res.note, 'warn');
    } catch (e) { toast(e.message, 'err'); }
    finally { btn.disabled = false; btn.textContent = was; }
  };
  return card;
}
$('#p-add-exp').onclick = () => { itemCard($('#p-experience'), { id_prefix: 'exp' }, EXP_FIELDS, { id_prefix: 'exp' }); bindCalendars($('#p-experience')); };
$('#p-add-edu').onclick = () => { itemCard($('#p-education'), { id_prefix: 'edu' }, EDU_FIELDS, { id_prefix: 'edu' }); bindCalendars($('#p-education')); };
$('#p-add-boiler').onclick = () => decorateAnswerCard(itemCard($('#p-boilerplate'), { id_prefix: 'ans' }, BOIL_FIELDS, { id_prefix: 'ans' }));

// Test hook: #selftest-align writes the left edge of every control in a labelled card
// into the DOM, so "the boxes line up" is an assertion instead of a screenshot two
// people disagree about. Harmless in normal use; nothing reads it but the test.
if (location.hash === '#selftest-align') {
  setTimeout(() => {
    const edges = { controls: {}, labels: {} };
    document.querySelectorAll('.sub .fields .row').forEach((row) => {
      const control = row.querySelector('[data-k]');
      const label = row.querySelector('label');
      if (!control || !label) return;
      const key = control.getAttribute('data-k');
      (edges.controls[key] = edges.controls[key] || []).push(Math.round(control.getBoundingClientRect().left));
      (edges.labels[key] = edges.labels[key] || []).push(Math.round(label.getBoundingClientRect().left));
    });
    const out = document.createElement('div');
    out.id = 'selftest-align';
    out.textContent = JSON.stringify(edges);
    document.body.appendChild(out);
  }, 1200);
}

$('#p-paste-toggle').onclick = () => { $('#p-resume').focus(); toast('Type or paste below, then Save profile.', 'ok'); };

$('#p-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('resume', file, file.name);
  $('#p-file-status').textContent = 'reading…';
  try {
    const res = await api('/api/profile/resume', { method: 'POST', body: fd });
    if (res.ok) {
      PROFILE = await api('/api/profile');
      $('#p-resume').value = PROFILE.master_resume_markdown || '';
      $('#p-file-status').textContent = `read ${res.chars} chars via ${res.method}`;
      toast('Resume loaded. Read the text below — extraction is never perfect.', 'ok');
      renderProfile();
    } else {
      $('#p-file-status').textContent = res.warning || 'nothing extracted';
      toast(res.warning || 'Nothing extracted from that file — paste the text instead.', 'err');
    }
  } catch (err) { $('#p-file-status').textContent = err.message; toast(err.message, 'err'); }
};

function profileFromForm() {
  const city = ($('#p-city') ? $('#p-city').value.trim() : '');
  const state = ($('#p-state') ? $('#p-state').value.trim() : '');
  const country = ($('#p-country') ? $('#p-country').value.trim() : 'United States');
  const locFallback = [city, state, country].filter(Boolean).join(', ');
  const locVal = ($('#p-location') && $('#p-location').value.trim()) || locFallback;

  return {
    name: $('#p-name').value.trim(), email: $('#p-email').value.trim(), phone: $('#p-phone').value.trim(),
    address: {
      address_line1: ($('#p-addr1') ? $('#p-addr1').value.trim() : ''),
      address_line2: ($('#p-addr2') ? $('#p-addr2').value.trim() : ''),
      city: city,
      state: state,
      postal_code: ($('#p-postal') ? $('#p-postal').value.trim() : ''),
      country: country,
    },
    location: locVal, headline: $('#p-headline').value.trim(), pronouns: $('#p-pronouns').value.trim(),
    links: { ...(PROFILE.links || {}), linkedin: $('#p-linkedin').value.trim(), github: $('#p-github').value.trim(), other: $('#p-other').value.trim() },
    salary_expectation: $('#p-salary').value.trim(), relocation: $('#p-relocation').value.trim(),
    preferences: {
      ...(PROFILE.preferences || {}),
      willing_to_relocate: $('#p-willing-relocate') ? $('#p-willing-relocate').value === 'Yes' : true,
      how_heard: ($('#p-howheard') ? $('#p-howheard').value.trim() : ''),
      work_model: $('#p-relocation').value.trim(),
    },
    start_date: $('#p-start').value.trim(), notice_period: $('#p-notice').value.trim(),
    work_authorization: {
      status: ($('#p-wa-status') ? $('#p-wa-status').value.trim() : ''),
      is_citizen: $('#p-wa-status') ? ($('#p-wa-status').value === 'U.S. Citizen' || $('#p-wa-status').value === 'citizen') : true,
      authorized: true,
      requires_sponsorship: $('#p-wa-sponsor') ? $('#p-wa-sponsor').value === 'Yes' : false,
    },
    work_authorization_note: $('#p-workauth').value.trim(),
    eeoc: {
      gender: ($('#p-eeoc-gender') ? $('#p-eeoc-gender').value.trim() : ''),
      race: ($('#p-eeoc-race') ? $('#p-eeoc-race').value.trim() : ''),
      veteran: ($('#p-eeoc-veteran') ? $('#p-eeoc-veteran').value.trim() : ''),
      disability: ($('#p-eeoc-disability') ? $('#p-eeoc-disability').value.trim() : ''),
    },
    master_resume_markdown: $('#p-resume').value, summary: $('#p-summary').value.trim(),
    skills: $('#p-skills').value.split(',').map((s) => s.trim()).filter(Boolean),
    certifications: $('#p-certs').value.split(',').map((s) => s.trim()).filter(Boolean),
    languages: $('#p-languages').value.split(',').map((s) => s.trim()).filter(Boolean),
    experience: collect($('#p-experience'), EXP_FIELDS),
    education: collect($('#p-education'), EDU_FIELDS),
    boilerplate: collect($('#p-boilerplate'), BOIL_FIELDS),
  };
}

$('#p-save').onclick = async () => {
  $('#p-saved').textContent = 'saving…';
  try {
    PROFILE = await api('/api/profile', { method: 'PUT', json: profileFromForm() });
    $('#p-saved').textContent = 'saved ' + new Date().toLocaleTimeString();
    const n = (PROFILE.warnings || []).length;
    toast(n ? `Saved — ${n} thing${n === 1 ? '' : 's'} still worth fixing below.` : 'Profile saved. Looks clean.', n ? 'err' : 'ok');
    renderProfile(); renderProfileWarnings(); loadStatus();
  } catch (e) { $('#p-saved').textContent = ''; toast(e.message, 'err'); }
};

// --------------------------------------------------------------------- jobs
async function loadJobs() {
  const { jobs } = await api('/api/jobs');
  $('#jobs-count').textContent = jobs.length ? `(${jobs.length})` : '';
  const host = $('#jobs-list');
  if (!jobs.length) {
    host.innerHTML = `<div class="item"><span class="muted">Nothing yet. Save a listing with the extension, or paste one above.</span></div>`;
    return;
  }
  host.innerHTML = '';
  for (const j of jobs) {
    const el = document.createElement('div');
    el.className = 'item';
    const statusBadge = { saved: 'blue', prepared: 'blue', packet: 'warn', autofilled: 'warn', applied: 'ok', submitted: 'ok' }[j.status] || '';
    const hasPacket = !!j.packet_id;
    const isApplied = j.status === 'applied' || !!j.applied_at;
    const appliedText = j.applied_at ? `Applied ${esc(j.applied_at.slice(0, 10))}` : '';
    const fillStats = (j.fill_stats && j.fill_stats.filled != null) ? `${j.fill_stats.filled} fields filled` : '';
    el.innerHTML = `
      <h3>${esc(j.title || '(untitled)')} <span class="badge ${statusBadge}">${esc(j.status)}</span> ${isApplied && appliedText ? `<span class="badge ok">${appliedText}</span>` : ''}</h3>
      <div class="meta">
        <span>${esc(j.company || '—')}</span><span>${esc(j.location || '')}</span>
        <span>${j.url ? `<a href="${esc(j.url)}" target="_blank" rel="noopener noreferrer">${esc(new URL(j.url).hostname)}</a>` : esc(j.source || '')}</span>
        <span>${(j.description_preview || '').length} chars</span>
        ${fillStats ? `<span class="pill">${fillStats}</span>` : ''}
        <span>${j.applied_at ? `Applied ${esc(j.applied_at.slice(0, 10))}` : esc(j.created_at || '').slice(0, 10)}</span>
      </div>
      <div class="muted" style="margin-bottom:8px">${esc(j.description_preview || '')}…</div>
      <div class="actions">
        ${hasPacket ? `<button data-act="open-packet" class="primary">Inspect packet</button>` : `<button data-act="build" class="primary">Build packet</button>`}
        ${hasPacket ? `<a class="btnlike" href="/api/packets/${esc(j.packet_id)}/resume.docx" download>Resume .docx</a>` : ''}
        <button data-act="cover">${j.draft_cover ? 'Cover letter ✓' : 'Cover letter'}</button>
        <button data-act="view">Read full</button>
        ${j.url ? `<a class="btnlike" href="${esc(j.url)}" target="_blank" rel="noopener noreferrer">Open posting</a>` : ''}
        <button data-act="del">Delete</button>
      </div>`;
    if (el.querySelector('[data-act=build]')) {
      el.querySelector('[data-act=build]').onclick = () => buildPacket({ job_id: j.id }, el.querySelector('[data-act=build]'));
    }
    if (el.querySelector('[data-act=open-packet]')) {
      el.querySelector('[data-act=open-packet]').onclick = () => openPacket(j.packet_id);
    }
    el.querySelector('[data-act=cover]').onclick = async (ev) => coverAction(ev.currentTarget, j);
    el.querySelector('[data-act=view]').onclick = async () => {
      const full = await api('/api/jobs/' + j.id);
      modal(`${full.title} — ${full.company}`, `<div class="muted" style="margin-bottom:10px">${esc(full.url)}</div>
        <pre style="white-space:pre-wrap;font-size:12.5px">${esc(full.description || '(no description captured)')}</pre>`);
    };
    el.querySelector('[data-act=del]').onclick = async () => {
      const ok = await confirmModal({
        title: 'Delete job?',
        html: `<p>Delete job <b>${esc(j.title || 'untitled')} — ${esc(j.company || '')}</b>? A backup copy is preserved in data/backups.</p>`,
        confirmText: 'Delete',
        kind: 'bad',
      });
      if (!ok) return;
      await api('/api/jobs/' + j.id, { method: 'DELETE' }); loadJobs(); loadStatus();
    };
    host.appendChild(el);
  }
}

// A cover letter drafted from one saved job. It lives on the job record, not in a
// packet, so the autofill engine cannot reach it: review and approval still gate it.
async function coverAction(btn, job) {
  if (job.draft_cover) return showCoverDraft(job);
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Writing…';
  try {
    job.draft_cover = await api(`/api/jobs/${job.id}/draft_cover`, { method: 'POST', json: {} });
    btn.textContent = 'Cover letter ✓';
    showCoverDraft(job);
    toast('Draft written. Nothing is used until you approve a packet.', 'ok');
  } catch (e) {
    toast(e.message, 'err'); btn.textContent = label;
  } finally { btn.disabled = false; }
}

function showCoverDraft(job) {
  const d = job.draft_cover;
  if (!d) return toast('No draft for this job yet.', 'warn');
  modal(`Cover letter — ${job.title || job.company || 'draft'}`, `
    <div class="muted" style="margin-bottom:10px">${d.words} words · written with ${esc(d.method === 'llm' ? 'your model (' + (d.model || '') + ')' : 'no model, from your profile only')} · ${(d.drafted_at || '').slice(0, 16).replace('T', ' ')}</div>
    ${d.note ? `<div class="badge warn" style="margin-bottom:10px">${esc(d.note)}</div>` : ''}
    <pre style="white-space:pre-wrap;font-size:12.5px;line-height:1.5">${esc(d.text)}</pre>
    <div class="actions" style="margin-top:12px">
      <button id="m-copy">Copy</button>
      <button id="m-rewrite">Rewrite it</button>
      <button class="primary" id="m-build">Build the packet</button>
    </div>
    <p class="muted" style="margin-top:10px">A draft is not an answer: it is never typed or uploaded
    until you build a packet, read it, and approve it.</p>`);
  $('#m-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(d.text); toast('Copied.', 'ok'); }
    catch (e) { toast('Copy blocked — select the text and copy manually.', 'warn'); }
  };
  $('#m-rewrite').onclick = async () => {
    $('#modal-body').querySelector('pre').textContent = 'writing…';
    job.draft_cover = await api(`/api/jobs/${job.id}/draft_cover`, { method: 'POST', json: {} });
    showCoverDraft(job);
  };
  $('#m-build').onclick = () => { $('#modal').classList.add('hidden'); buildPacket({ job_id: job.id }); };
}

// Deep links from the extension: /#packet=pkt_1 opens that packet, /#job=job_1 its draft.
async function followHash() {
  const [key, value] = (location.hash || '').replace(/^#/, '').split('=');
  if (!value) return;
  try {
    if (key === 'packet') { showPanel('#tab-packets'); await loadPackets(); await openPacket(value); }
    if (key === 'job') {
      showPanel('#tab-jobs');
      const { jobs } = await api('/api/jobs');
      const job = jobs.find((j) => j.id === value);
      if (job) { loadJobs(); showCoverDraft(job); }
    }
  } catch (e) { toast(e.message, 'err'); }
}
window.addEventListener('hashchange', followHash);

$('#j-add').onclick = async () => {
  const payload = {
    title: $('#j-title').value.trim(), company: $('#j-company').value.trim(),
    location: $('#j-location').value.trim(), url: $('#j-url').value.trim(),
    description: $('#j-desc').value, source: 'manual',
  };
  if (!payload.title || payload.description.trim().length < 40) {
    toast('Title plus a real job description are what make a packet worth reading.', 'err');
    return;
  }
  await api('/api/jobs', { method: 'POST', json: payload });
  ['#j-title', '#j-company', '#j-location', '#j-url', '#j-desc'].forEach((s) => ($(s).value = ''));
  toast('Job saved.', 'ok'); loadJobs(); loadStatus();
};

// --------------------------------------------------------------------- packets
async function buildPacket(payload, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'writing…'; }
  try {
    const p = await api('/api/packets', { method: 'POST', json: payload });
    toast('Packet ready — read it before you approve.', 'ok');
    openPacket(p.id); loadStatus();
  } catch (e) {
    toast(e.message, 'err');
    if (btn) { btn.disabled = false; btn.textContent = 'Build packet'; }
  }
}

async function loadPackets() {
  const { packets } = await api('/api/packets');
  $('#packets-count').textContent = packets.length ? `(${packets.length})` : '';
  const host = $('#packets-list');
  if (!packets.length) {
    host.innerHTML = `<div class="item"><span class="muted">No packets yet. Build one from the Jobs tab.</span></div>`;
    return;
  }
  host.innerHTML = '';
  for (const p of packets) {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `
      <h3>${esc(p.title || '(no title)')} <span class="badge ${p.approved ? 'ok' : 'warn'}">${p.approved ? 'approved' : 'needs review'}</span></h3>
      <div class="meta"><span>${esc(p.company || '')}</span><span>${esc(p.created_at || '').slice(0, 16).replace('T', ' ')}</span>
      <span>${esc(p.provider || '')}</span>
      <span>${p.answers_total} answers</span>
      ${p.answers_needs_input ? `<span class="badge warn">${p.answers_needs_input} to fill in</span>` : ''}
      ${p.answers_blocked ? `<span class="badge bad">${p.answers_blocked} compliance — you answer</span>` : ''}</div>
      <div class="actions">
        <button data-act="open" class="primary">Review</button>
        <button data-act="del">Delete</button>
      </div>`;
    el.querySelector('[data-act=open]').onclick = () => openPacket(p.id);
    el.querySelector('[data-act=del]').onclick = async () => {
      const ok = await confirmModal({
        title: 'Delete packet?',
        html: `<p>Delete application packet for <b>${esc(p.title || 'untitled')} — ${esc(p.company || '')}</b>?</p>`,
        confirmText: 'Delete',
        kind: 'bad',
      });
      if (!ok) return;
      await api('/api/packets/' + p.id, { method: 'DELETE' }); loadPackets(); loadStatus();
    };
    host.appendChild(el);
  }
}

let CURRENT = null;

async function openPacket(id) {
  CURRENT = await api('/api/packets/' + id);
  showPanel('#packet-detail');
  $('#pd-title').textContent = `${CURRENT.title || 'Packet'} — ${CURRENT.company || ''}`;
  $('#pd-sub').innerHTML = `${esc(CURRENT.url || '')} · drafted by ${esc(CURRENT.llm.provider)}${CURRENT.llm.model ? ' (' + esc(CURRENT.llm.model) + ')' : ''} · ${CURRENT.questions_found} questions found
    <span class="badge ${CURRENT.approved ? 'ok' : 'warn'}">${CURRENT.approved ? 'approved — extension may use it' : 'not approved'}</span>`;
  $('#pd-warnings').innerHTML = (CURRENT.warnings || []).length
    ? `<div class="notice">${CURRENT.warnings.map(esc).join('<br>')}</div>` : '';
  renderRedactions();
  renderStatusMentions();
  $('#pd-resume').value = CURRENT.resume.markdown || '';
  $('#pd-cover').value = CURRENT.cover_letter.text || '';
  $('#pd-words').textContent = (CURRENT.cover_letter.words || 0) + ' words';
  const fit = CURRENT.resume.fit || {};
  $('#pd-fit').textContent = fit.note || '';
  $('#pd-fit').className = 'badge ' + (fit.over ? 'warn' : fit.under ? 'warn' : 'ok');
  $('#pd-changes').innerHTML = (CURRENT.resume.changes || []).map((c) => `<li>${esc(c)}</li>`).join('');
  $('#pd-state').textContent = CURRENT.approved ? 'approved ' + (CURRENT.approved_at || '').slice(0, 16).replace('T', ' ') : '';
  renderPreview(); renderAnswers(); refreshAts(false);
  const base = `/api/packets/${CURRENT.id}/file`;
  $('#pd-dl-docx').href = base + '?fmt=docx';
  $('#pd-dl-html').href = base + '?fmt=html';
  $('#pd-dl-cover').href = base + '?fmt=docx&type=cover';
}

// What the drafter tried to claim about compliance, and we took out. Shown first,
// because the honest fix is a person deciding whether to say it themselves.
function renderRedactions() {
  const red = (CURRENT && CURRENT.compliance_redactions) || [];
  const host = $('#pd-redactions');
  if (!host) return;
  if (!red.length) { host.innerHTML = ''; return; }
  host.innerHTML = `<div class="notice" style="border-left:3px solid #ef5f5f">
    <strong>${red.length} compliance statement${red.length > 1 ? 's' : ''} the drafter invented ${red.length > 1 ? 'were' : 'was'} removed</strong>
    <ul style="margin:6px 0 0 18px">${red.map((r) => `<li><b>${esc(String(r.category).replace(/_/g, ' '))}</b> in ${esc(r.where)}:
      &ldquo;${esc(r.sentence)}&rdquo; — ${esc(r.why)}</li>`).join('')}</ul>
    Statements like these are yours alone. Say them yourself, in your own words, only if they are true.</div>`;
}

// A legal status that came from your own master resume. Not removed, not blocked:
// just a reminder to decide, per application, whether you want it on the page.
function renderStatusMentions() {
  const host = $('#pd-status');
  if (!host) return;
  const rows = (CURRENT && CURRENT.status_mentions) || [];
  if (!rows.length) { host.innerHTML = ''; return; }
  host.innerHTML = `<div class="notice" style="border-left:3px solid #e6a23c">
    <strong>This packet states a legal status. Confirm you want it on this application.</strong>
    <ul style="margin:6px 0 0 18px">${rows.map((r) => `<li><b>${esc(r.where)}</b>: &ldquo;${esc(r.text)}&rdquo;</li>`).join('')}</ul>
    It came from your own master resume, so FillDesk leaves it alone. Employers do ask
    (authorized to work? do you require sponsorship for a visa such as H-1B?) — but they ask
    <em>you</em>, and the extension will never answer those for you. If a role is outside the
    US or the requirement is irrelevant, remove the line here.</div>`;
}

function renderPreview() { $('#pd-preview').innerHTML = mdToHtml($('#pd-resume').value); }
$('#pd-resume').oninput = () => { renderPreview(); };
$('#pd-changes-toggle').onclick = () => $('#pd-changes').classList.toggle('hidden');

async function refreshAts(toastIt = true) {
  if (!CURRENT) return;
  await savePacketEdits(false);
  try {
    const ats = await api(`/api/packets/${CURRENT.id}/ats`);
    $('#pd-ats').textContent = `${ats.coverage_percent}% of the job description's terms appear in the resume · ${ats.matched.length} matched`;
    $('#pd-missing').className = ats.missing_frequent.length ? '' : 'hidden';
    $('#pd-missing').innerHTML = `<div class="notice"><strong>Absent from your resume</strong> (only add them if genuinely true):
      ${ats.missing_frequent.map((m) => `<span class="badge">${esc(m.term)}·${m.in_job}</span>`).join(' ')}</div>`;
    if (toastIt) toast('Keyword check done.', 'ok');
  } catch (e) { $('#pd-ats').textContent = e.message; }
}
$('#pd-refresh-ats').onclick = () => refreshAts(true);

function renderAnswers() {
  const host = $('#pd-answers');
  host.innerHTML = '';
  if (!(CURRENT.answers || []).length) {
    host.innerHTML = `<div class="muted">No employer questions were found in the saved posting. The extension re-scans the live form and will flag anything unexpected.</div>`;
  }
  (CURRENT.answers || []).forEach((a, i) => {
    const kind = a.blocked ? 'blocked' : a.needs_input || a.review ? 'review' : 'drafted';
    const el = document.createElement('div');
    el.className = 'answer ' + kind;
    const badge = a.blocked
      ? `<span class="badge bad">refused · ${esc(a.category || 'compliance')}</span>`
      : a.needs_input ? '<span class="badge warn">needs your input</span>'
      : a.review ? `<span class="badge warn">verify · ${esc(a.review.category)}</span>`
      : '<span class="badge blue">drafted</span>';
    el.innerHTML = `
      <div class="q">${esc(a.question)} ${badge}</div>
      ${a.blocked
        ? `<div class="muted">FillDesk will not draft this (${esc(a.why || 'protected/compliance question')}). Answer it yourself on the employer's page — an autofilled wrong answer here can be a legal problem, not just an awkward one.</div>`
        : `<textarea rows="4" data-i="${i}">${esc(a.answer)}</textarea>`}
      ${a.note ? `<div class="note">${esc(a.note)}</div>` : ''}
      ${!a.blocked ? `<div class="note">source: ${esc(a.source)} · confidence ${Math.round((a.confidence || 0) * 100)}%
        <label class="check" style="display:inline-flex;margin-left:10px"><input type="checkbox" data-done="${i}" ${a.needs_input ? '' : 'checked'}> I have verified this</label>
        <button class="ghost pol" type="button" data-polish="${i}" title="restate your own words professionally; adds no facts">Polish with AI</button></div>` : ''}`;
    host.appendChild(el);
  });
  host.querySelectorAll('[data-polish]').forEach((btn) => {
    btn.onclick = async () => {
      const i = Number(btn.dataset.polish);
      const ta = host.querySelector(`textarea[data-i="${i}"]`);
      if (!ta) return;
      const text = ta.value.trim();
      if (text.length < 24) return toast('Write a sentence or two first — there is nothing to rewrite yet.', 'warn');
      const was = btn.textContent;
      btn.disabled = true; btn.textContent = 'Rewriting…';
      try {
        const res = await api(`/api/packets/${CURRENT.id}/polish`, { method: 'POST', json: { index: i, text } });
        if (!res.ok) {
          toast(res.refused || 'the rewrite was refused', 'err');
          if (res.attempt) showRefusedRewrite(res.attempt, res.refused);
          return;
        }
        CURRENT = res.packet;
        renderAnswers();
        toast('Rewritten from your own words. Re-tick "I have verified this" before it can be typed.', 'ok');
        if (res.note) toast(res.note, 'warn');
      } catch (e) { toast(e.message, 'err'); }
      finally { btn.disabled = false; btn.textContent = was; }
    };
  });
}

// A refusal is informative, so it is shown: the user may still want the wording, now that
// they can see the number or employer the model invented.
function showRefusedRewrite(attempt, reason) {
  modal('The rewrite was refused', `
    <div class="badge bad" style="margin-bottom:10px">${esc(reason || 'it added facts')}</div>
    <div class="muted" style="margin-bottom:8px">This is what it wanted to say. Your answer below is left untouched —
    if the wording is fine apart from the invented part, take it and fix that yourself.</div>
    <pre style="white-space:pre-wrap;font-size:12.5px;line-height:1.5">${esc(attempt)}</pre>`);
}

function collectAnswers() {
  return (CURRENT.answers || []).map((a, i) => {
    const next = { ...a };
    const ta = document.querySelector(`textarea[data-i="${i}"]`);
    if (ta) { next.answer = ta.value; next.needs_input = /\[needs input\]/i.test(ta.value); }
    const done = document.querySelector(`input[data-done="${i}"]`);
    if (done) { next.needs_input = !done.checked || /\[needs input\]/i.test(next.answer || ''); }
    return next;
  });
}

async function savePacketEdits(notify = true) {
  if (!CURRENT) return;
  CURRENT.answers = collectAnswers();
  const patch = { resume: $('#pd-resume').value, cover_letter: $('#pd-cover').value, answers: CURRENT.answers };
  CURRENT = await api('/api/packets/' + CURRENT.id, { method: 'PUT', json: patch });
  $('#pd-words').textContent = (CURRENT.cover_letter.words || 0) + ' words';
  renderAnswers();
  if (notify) toast('Saved.', 'ok');
}
$('#pd-save').onclick = () => savePacketEdits(true).catch((e) => toast(e.message, 'err'));

$('#pd-approve').onclick = async () => {
  await savePacketEdits(false);
  const btn = $('#pd-approve');
  btn.disabled = true;
  try {
    const res = await api(`/api/packets/${CURRENT.id}/approve`, { method: 'POST', json: {} });
    if (res.approved) {
      CURRENT = res.packet;
      $('#pd-state').textContent = 'approved ' + (CURRENT.approved_at || '').slice(0, 16).replace('T', ' ');
      $('#pd-sub').innerHTML += ` <span class="badge ok">approved — extension may use it</span>`;
      toast('Approved. The extension can now autofill with exactly this text.', 'ok');
      loadPackets(); loadStatus();
    } else {
      const items = [
        ...(res.blocking || []).map((b) => `<li style="margin:6px 0"><b>Question:</b> ${esc(b.question)}${b.note ? ` <span class="muted">(${esc(b.note)})</span>` : ''}</li>`),
        ...(res.flags || []).map((f) => `<li style="margin:6px 0"><b>Document placeholder:</b> ${esc(f)}</li>`),
      ].slice(0, 15);
      const html = `
        <div class="callout warn" style="margin-bottom:12px">
          <h3>Unresolved items</h3>
          <p style="margin:0 0 8px">The following items are still flagged as requiring input or review:</p>
          <ul style="margin:0;padding-left:18px">${items.join('')}</ul>
        </div>
        <p class="muted" style="font-size:13px;margin:8px 0 0">
          Approving with open items releases the packet for autofill, but unanswered questions won't be typed and document placeholders will remain unreplaced. Do you want to approve anyway?
        </p>
      `;
      const go = await confirmModal({
        title: 'Approve packet with open items?',
        html,
        confirmText: 'Approve anyway',
        cancelText: 'Keep editing',
        kind: 'primary',
      });
      if (go) {
        const forced = await api(`/api/packets/${CURRENT.id}/approve`, { method: 'POST', json: { force: true } });
        CURRENT = forced.packet;
        toast('Approved with open items. Re-read the form on the employer page.', 'warn');
        loadPackets(); loadStatus();
      }
    }
  } catch (e) { toast(e.message, 'err'); }
  btn.disabled = false;
};

$('#pd-back').onclick = () => { showPanel('#tab-packets'); loadPackets(); };

// --------------------------------------------------------------------- settings
async function loadSettings() {
  const s = await api('/api/settings');
  const t = await api('/api/token');
  $('#s-provider').value = s.llm.provider; $('#s-model').value = s.llm.model;
  $('#s-base').value = s.llm.base_url; $('#s-key').value = '';
  $('#s-key').placeholder = s.llm.api_key ? '•••• stored — blank keeps it' : 'api key';
  $('#s-temp').value = s.llm.temperature; $('#s-maxtok').value = s.llm.max_tokens;
  $('#s-nothink').checked = s.llm.no_thinking !== false;
  $('#s-overwrite').checked = s.autofill.overwrite_filled;
  $('#s-nav').checked = s.autofill.click_navigation;
  $('#s-upload').checked = s.autofill.upload_documents;
  const workAuthBox = $('#s-workauth');
  if (workAuthBox) workAuthBox.checked = s.autofill.autofill_work_auth !== false;
  const eeocBox = $('#s-eeoc');
  if (eeocBox) eeocBox.checked = s.autofill.autofill_eeoc !== false;
  $('#s-delay').value = s.autofill.visible_delay_ms;
  $('#s-tailor').checked = s.packets.tailor_resume;
  $('#s-letter').checked = s.packets.write_cover_letter;
  $('#s-pages').value = s.packets.resume_pages;
  $('#s-token').value = t.token;

  const alerts = s.alerts || {};
  const alertBox = $('#s-alerts-desktop');
  if (alertBox) alertBox.checked = alerts.desktop !== false;
  const coolBox = $('#s-alerts-cooldown');
  if (coolBox) coolBox.value = alerts.cooldown_seconds != null ? alerts.cooldown_seconds : 60;
  const statusEl = $('#s-alerts-status');
  if (statusEl && alerts.status) {
    statusEl.textContent = alerts.status.possible
      ? `Detected: ${alerts.status.backends.join(', ')}`
      : 'No desktop notification backend detected';
  }
}

$('#s-save').onclick = async () => {
  const patch = {
    llm: {
      provider: $('#s-provider').value, model: $('#s-model').value.trim(), base_url: $('#s-base').value.trim(),
      temperature: parseFloat($('#s-temp').value || '0.4'), max_tokens: parseInt($('#s-maxtok').value || '8000', 10),
      no_thinking: $('#s-nothink').checked,
    },
    autofill: {
      overwrite_filled: $('#s-overwrite').checked, click_navigation: $('#s-nav').checked,
      upload_documents: $('#s-upload').checked, refuse_blocked_fields: true,
      autofill_work_auth: $('#s-workauth') ? $('#s-workauth').checked : true,
      autofill_eeoc: $('#s-eeoc') ? $('#s-eeoc').checked : true,
      visible_delay_ms: parseInt($('#s-delay').value || '260', 10),
    },
    packets: { tailor_resume: $('#s-tailor').checked, write_cover_letter: $('#s-letter').checked, resume_pages: parseInt($('#s-pages').value || '1', 10) },
    alerts: {
      desktop: $('#s-alerts-desktop') ? $('#s-alerts-desktop').checked : true,
      cooldown_seconds: parseInt(($('#s-alerts-cooldown') && $('#s-alerts-cooldown').value) || '60', 10),
    },
  };
  if ($('#s-key').value.trim()) patch.llm.api_key = $('#s-key').value.trim();
  await api('/api/settings', { method: 'PUT', json: patch });
  $('#s-saved').textContent = 'saved ' + new Date().toLocaleTimeString();
  $('#s-key').value = '';
  toast('Settings saved.', 'ok'); loadStatus();
};

const alertTestBtn = $('#s-alerts-test');
if (alertTestBtn) {
  alertTestBtn.onclick = async () => {
    const was = alertTestBtn.textContent;
    alertTestBtn.disabled = true; alertTestBtn.textContent = 'Sending…';
    try {
      const res = await api('/api/notify', { method: 'POST', json: { kind: 'test', field: 'FillDesk alert test' } });
      if (res.sent) {
        toast(`Desktop alert sent via ${res.via}. Check your screen.`, 'ok');
      } else {
        toast(`Alert not sent: ${res.reason || 'disabled or unavailable'}`, 'warn');
      }
    } catch (e) {
      toast('Alert request failed: ' + e.message, 'err');
    } finally {
      alertTestBtn.disabled = false; alertTestBtn.textContent = was;
    }
  };
}

$('#s-test').onclick = async () => {
  $('#s-test-out').textContent = 'contacting model…';
  try {
    const r = await api('/api/llm/test', { method: 'POST', json: {} });
    $('#s-test-out').textContent = JSON.stringify(r, null, 2);
    toast(r.ok ? 'Model answered.' : 'Model failed — see output.', r.ok ? 'ok' : 'err');
  } catch (e) { $('#s-test-out').textContent = e.message; toast(e.message, 'err'); }
  loadStatus();
};

$('#s-copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('#s-token').value); toast('Token copied.', 'ok'); }
  catch (e) { $('#s-token').select(); document.execCommand('copy'); toast('Token copied.', 'ok'); }
};

// --------------------------------------------------------------------- boot
(async function boot() {
  await loadProfile().catch((e) => toast('profile: ' + e.message, 'err'));
  loadStatus();
  bindCalendars(document);
  followHash();
})();
