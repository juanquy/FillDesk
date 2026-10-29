/*
 * FillDesk content script.
 *
 * What it does: reads the form on screen, asks the matcher what it is allowed to
 * type, shows you the plan, types it slowly enough to watch, and stops. It never
 * clicks Submit, never answers a compliance question, and never types a value you
 * did not approve in the dashboard.
 */
(() => {
  'use strict';
  if (window.__FILLDESK__) return;
  window.__FILLDESK__ = true;

  const M = window.FILLDESK_MATCHER;
  const DEFAULT_SERVER = 'http://127.0.0.1:8756';

  const ATS_HOSTS = [
    'boards.greenhouse.io', 'job-boards.greenhouse.io', 'greenhouse.io',
    'jobs.lever.co', 'lever.co', 'myworkdayjobs.com', 'wday.com', 'myworkday.com',
    'smartrecruiters.com', 'jobs.smartrecruiters.com', 'recruitite.com', 'jobvite.com',
    'bamboohr.com', 'workable.com', 'apply.workable.com', 'personio.com', 'jobs.personio.com',
    'teamtailor.com', 'jobs.teamtailor.com', 'ashbyhq.com', 'jobs.ashbyhq.com',
    'icims.com', 'taleo.net', 'secure.netsuite.com', 'ezhire.com', 'jalbert.com',
    'cws-netprod.sterlingtech.net', 'faaalead.com', 'quantisnow.com', 'successfactors.com',
    'sapsf.com', 'careerfive.com', 'ceipal.com', 'jobs.accenture.com', 'deloitte careers',
    'linkedin.com/jobs', 'linkedin.com/talent', 'indeed.com/viewjob', 'indeed.com/rc',
    'glassdoor.com/joblisting', 'ziprecruiter.com/jobs', 'wellfound.com', 'builtin.com',
    'dice.com/jobs', 'jooble.org', 'workingnomads.com', 'remote.co', 'otta.tech',
  ];

  const state = {
    server: DEFAULT_SERVER,
    token: '',
    settings: {},
    snapshot: null,
    plan: [],
    running: false,
    cancelled: false,
    panel: null,
    log: [],
    reviewEach: false,
    reviewAll: false,
    changes: [],
  };

  // ---------------------------------------------------------------- transport
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(res || { ok: false, error: 'no response from FillDesk background' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message) });
      }
    });
  }

  async function loadConfig() {
    const stored = await chrome.storage.local.get(['server', 'token', 'settings']);
    state.server = stored.server || DEFAULT_SERVER;
    state.token = stored.token || '';
    state.settings = stored.settings || {};
  }

  async function api(path, opts = {}) {
    const res = await send({ type: 'api', server: state.server, token: state.token, path, ...opts });
    if (!res.ok) throw new Error(res.error || 'request failed');
    return res.data;
  }

  // ---------------------------------------------------------------- label resolution
  const TEXT_LIMIT = 260;
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_LIMIT);

  function textOf(el) {
    if (!el) return '';
    return clean(el.textContent || '');
  }

  function labelText(el) {
    const bits = [];
    if (el.getAttribute('aria-labelledby')) {
      for (const id of el.getAttribute('aria-labelledby').split(/\s+/)) {
        const ref = document.getElementById(id);
        if (ref) bits.push(textOf(ref));
      }
    }
    const aria = el.getAttribute('aria-label');
    if (aria) bits.push(aria);

    const id = el.id;
    if (id) {
      const direct = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (direct) bits.unshift(textOf(direct));
    }
    const wrapping = el.closest('label');
    if (wrapping) bits.unshift(clean(wrapping.textContent.replace(el.value || '', '')));

    if (!bits.length || bits.every((b) => !b)) {
      // Common ATS markup: <label>text</label> immediately before the control,
      // or a sibling div/span acting as a label.
      let sib = el.previousElementSibling;
      for (let hops = 0; sib && hops < 3; hops++, sib = sib.previousElementSibling) {
        const t = textOf(sib);
        if (t && sib.matches('label,span,div,p,legend,th,td,b,strong')) { bits.push(t); break; }
      }
    }
    if (!bits.length || bits.every((b) => !b)) {
      const parent = el.closest('td,li,.field,.form-field,.forminator-field,.wf-field,fieldset,div');
      if (parent) {
        const clone = parent.cloneNode(true);
        clone.querySelectorAll('input,textarea,select,button,script,style').forEach((n) => n.remove());
        const t = clean(clone.textContent);
        if (t && t.length < 160) bits.push(t);
      }
    }
    const legend = el.closest('fieldset') ? textOf(el.closest('fieldset').querySelector('legend')) : '';
    const heading = nearestHeading(el);
    return {
      label: clean(bits.find(Boolean) || el.getAttribute('placeholder') || el.getAttribute('title') || humanize(el.name || el.id || '')),
      legend: clean(legend),
      section: clean(heading),
    };
  }

  function nearestHeading(el) {
    let node = el;
    for (let depth = 0; depth < 8 && node; depth++) {
      let sib = node.previousElementSibling;
      for (let hops = 0; sib && hops < 8; hops++, sib = sib.previousElementSibling) {
        if (/^H[1-6]$/.test(sib.tagName) || sib.getAttribute('role') === 'heading') return textOf(sib);
      }
      node = node.parentElement;
    }
    return '';
  }

  function humanize(s) {
    return clean(String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' '));
  }

  // Radio and checkbox groups are the dangerous ones: the accessible name of each
  // input is just "Yes" or "No", and the actual question lives on the element above
  // them. Without this, a yes/no EEO question reads as a field called "Yes".
  function groupContext(el, kind) {
    if (kind !== 'radio' && kind !== 'checkbox') return '';
    const wrapping = el.closest('label');
    if (wrapping && clean(wrapping.textContent).length >= 22) return '';
    let container = el.closest('[role="radiogroup"],[role="group"],fieldset,.radios,.radio-group,.choice,.form-group,.field,td,li,div');
    for (let up = 0; up < 5 && container; up++, container = container.parentElement) {
      let sib = container.previousElementSibling;
      for (let hops = 0; sib && hops < 6; hops++, sib = sib.previousElementSibling) {
        const t = textOf(sib);
        if (t.length >= 18) return t;
        const inner = sib.matches('label,legend,p,div,span,strong,b,h1,h2,h3,h4') ? clean(sib.textContent) : '';
        if (inner.length >= 18) return inner;
      }
    }
    return '';
  }

  // Many ATS forms have no heading at all. Rather than guessing that any "Start
  // Date" is an employment date, look for employment neighbours in the same block
  // and say so explicitly via a synthetic section name.
  function inferredSection(el, heading) {
    if (heading) return heading;
    const container = el.closest('fieldset,table,section,.card,.form-section,.section,.grid,div');
    if (!container) return '';
    const labels = Array.from(container.querySelectorAll('label,legend,[aria-label]')).slice(0, 40)
      .map((l) => norm(l.textContent || l.getAttribute('aria-label') || '')).join(' ');
    if (/\b(company|employer|organization|organisation|job title|position title|reason for leaving)\b/.test(labels)) return 'Employment history';
    if (/\b(school|university|college|degree|gpa|transcript)\b/.test(labels)) return 'Education';
    return '';
  }

  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  function isVisible(el) {
    if (!el) return false;
    if (el.type === 'hidden' || el.getAttribute('aria-hidden') === 'true') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 && rect.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    if (el.closest('[aria-hidden="true"],[hidden]')) return false;
    return true;
  }

  function optionsOf(el) {
    return Array.from(el.options || []).map((o) => ({
      label: clean(o.textContent) || o.value || '',
      value: o.value,
      selected: !!o.selected,
      disabled: !!o.disabled,
    }));
  }

  function fieldElements() {
    const nodes = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="textbox"]'));
    const out = [];
    const seenRadioGroups = new Set();
    for (const el of nodes) {
      if (el.closest('[data-filldesk-panel]') || el.closest('nav')) continue;
      const type = (el.type || el.tagName.toLowerCase()).toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
      if (type === 'radio') {
        const name = el.name || 'anon-' + out.length;
        if (seenRadioGroups.has(name)) continue;
        seenRadioGroups.add(name);
        const group = el.name ? Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)) : [el];
        out.push({ el, kind: 'radio', group });
        continue;
      }
      if (type === 'checkbox') { out.push({ el, kind: 'checkbox' }); continue; }
      if (el.tagName === 'SELECT') { out.push({ el, kind: 'select' }); continue; }
      if (el.tagName === 'TEXTAREA') { out.push({ el, kind: 'textarea' }); continue; }
      if (el.tagName === 'INPUT') { out.push({ el, kind: 'input' }); continue; }
      out.push({ el, kind: 'editable' });
    }
    return out;
  }

  function describe(entry, indexHint) {
    const { el, kind } = entry;
    const { label, legend, section } = labelText(el);
    const effectiveSection = inferredSection(el, section);
    const type = kind === 'radio' ? 'radio' : kind === 'checkbox' ? 'checkbox' : kind === 'select' ? 'select'
      : kind === 'textarea' ? 'textarea' : (el.type || 'text').toLowerCase();
    return {
      el, kind,
      tag: kind === 'editable' ? 'textarea' : el.tagName.toLowerCase(),
      type,
      label, legend,
      section: effectiveSection,
      name: el.name || '',
      id: el.id || '',
      testid: el.getAttribute('data-qa') || el.getAttribute('data-testid') || el.getAttribute('data-automation') || el.getAttribute('data-automation-name') || '',
      placeholder: el.getAttribute('placeholder') || '',
      aria: el.getAttribute('aria-label') || '',
      groupLabel: groupContext(el, kind),
      title: el.getAttribute('title') || '',
      autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
      help: (() => {
        const d = el.getAttribute('aria-describedby');
        if (!d) return '';
        return d.split(/\s+/).map((i) => textOf(document.getElementById(i))).join(' ');
      })(),
      options: kind === 'select' ? optionsOf(el) : [],
      radioLabels: kind === 'radio' ? (entry.group || []).map((r) => ({ el: r, label: radioLabel(r) })) : [],
      visible: isVisible(el),
      required: el.required || el.getAttribute('aria-required') === 'true',
      currentValue: kind === 'select' ? '' : (el.value || '').toString(),
      dateHint: M.dateHintFor({ placeholder: el.getAttribute('placeholder') || '', name: el.name || '', id: el.id || '' }),
      index: indexHint || 0,
    };
  }

  function radioLabel(radio) {
    const l = radio.id ? document.querySelector(`label[for="${CSS.escape(radio.id)}"]`) : null;
    if (l) return textOf(l);
    const wrap = radio.closest('label');
    if (wrap) return clean(wrap.textContent);
    let sib = radio.nextElementSibling;
    for (let hops = 0; sib && hops < 3; hops++, sib = sib.nextElementSibling) {
      const t = textOf(sib);
      if (t) return t;
    }
    return radio.value || '';
  }

  // ---------------------------------------------------------------- scanning
  function scan() {
    const counters = {};
    const out = [];
    for (const entry of fieldElements()) {
      const desc = describe(entry, 0);
      const probe = M.classify(desc, state.snapshot || emptySnap(), state.settings);
      if (probe.key && /^(exp|edu)\./.test(probe.key)) {
        const bucket = probe.key.split('.')[1];
        desc.index = counters[bucket] || 0;
        counters[bucket] = desc.index + 1;
        out.push({ desc, decision: M.classify(desc, state.snapshot || emptySnap(), state.settings) });
      } else {
        out.push({ desc, decision: probe });
      }
    }
    return out;
  }

  function emptySnap() {
    return { identity: {}, links: {}, experience: [], education: [], answers: [], review_only: {}, skills: [], never_autofill: [] };
  }

  // ---------------------------------------------------------------- writing values
  function setNativeValue(el, value) {
    const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype
      : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : null;
    const track = el._valueTracker;
    if (proto && Object.prototype.hasOwnProperty.call(el, 'value') === false) {
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) { setter.set.call(el, value); } else { el.value = value; }
    } else {
      el.value = value;
    }
    if (track && typeof track.setValue === 'function') track.setValue(String(el.value));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: value, inputType: 'insertReplacementText' }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function mark(el, cls) {
    if (state.settings.highlight_filled === false) return;
    el.style.outline = '';
    el.style.outlineOffset = '';
    const colors = { filled: '#2fbf7a', review: '#e6a23c', blocked: '#ef5f5f', planned: '#5b8cff' };
    el.style.outline = `2px solid ${colors[cls] || colors.planned}`;
    el.style.outlineOffset = '1px';
    el.dataset.filldesk = cls;
    setTimeout(() => { el.style.outline = ''; delete el.dataset.filldesk; }, cls === 'planned' ? 2500 : 60000);
  }

  async function fillText(desc, value) {
    const el = desc.el;
    if (el.focus) el.focus({ preventScroll: true });
    setNativeValue(el, value);
    if (el.tagName === 'SELECT') return true;
    return el.value === value || String(el.value).length > 0;
  }

  function fillSelect(desc, value) {
    const idx = M.matchOption(desc.options, value);
    if (idx < 0) return false;
    const el = desc.el;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
    el.focus({ preventScroll: true });
    if (nativeSetter && nativeSetter.set) nativeSetter.set.call(el, desc.options[idx].value);
    else el.selectedIndex = idx;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function fillRadio(desc, value) {
    const items = desc.radioLabels || [];
    for (const item of items) {
      const verdict = M.booleanFor(item.label, value);
      if (verdict === true) { item.el.click(); item.el.dispatchEvent(new Event('change', { bubbles: true })); return true; }
    }
    for (const item of items) {
      if (M.normalizeOption(item.label) === M.normalizeOption(value)) { item.el.click(); return true; }
    }
    return false;
  }

  function fillCheckbox(desc, value) {
    const verdict = M.booleanFor(desc.label + ' ' + (desc.radioLabels?.[0]?.label || ''), value);
    const want = verdict === null ? /^(yes|true|1|current)\b/i.test(value) : verdict;
    if (desc.el.checked !== want) desc.el.click();
    return desc.el.checked === want;
  }

  async function attachFile(desc, which) {
    if (!state.snapshot || !state.snapshot.docs) return { ok: false, reason: 'no approved documents' };
    const path = which === 'cover_letter'
      ? (state.snapshot.docs.cover_letter_docx || state.snapshot.docs.cover_letter_txt)
      : state.snapshot.docs.resume_docx;
    const name = which === 'cover_letter'
      ? ((state.snapshot.doc_names || {}).cover_letter || 'cover-letter.docx')
      : ((state.snapshot.doc_names || {}).resume || 'resume.docx');
    const res = await send({ type: 'file', server: state.server, token: state.token, path });
    if (!res.ok) return { ok: false, reason: res.error };
    const bytes = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
    const mime = /\.docx$/i.test(name)
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'text/plain';
    const file = new File([bytes], name, { type: mime, lastModified: Date.now() });
    const dt = new DataTransfer();
    dt.items.add(file);
    const el = desc.el;
    try {
      el.files = dt.files;
    } catch (e) {
      return { ok: false, reason: 'this uploader blocks programmatic files' };
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const dropzone = el.closest('[class*="drop"], [class*="upload"], [draggable]') || el.parentElement;
    if (dropzone) {
      const drop = new Event('drop', { bubbles: true });
      try { drop.dataTransfer = dt; } catch (e) { /* some frameworks read a synthetic field */ }
      dropzone.dispatchEvent(drop);
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- actions
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function preview() {
    await ensureSnapshot();
    clearMarks();
    const scanResult = scan();
    state.plan = scanResult;
    const counts = { fill: 0, upload: 0, block: 0, skip: 0 };
    for (const item of scanResult) {
      counts[item.decision.action] = (counts[item.decision.action] || 0) + 1;
      if (item.decision.action === 'fill' || item.decision.action === 'upload') mark(item.desc.el, item.decision.review ? 'review' : 'planned');
      if (item.decision.action === 'block') mark(item.desc.el, 'blocked');
    }
    ui.counts(counts);
    ui.logLines(scanResult.map(lineFor).filter(Boolean));
    return counts;
  }

  function lineFor(item) {
    const { desc, decision } = item;
    if (decision.action === 'block') return { kind: 'bad', text: `will not answer — ${decision.category}: ${clipLabel(desc)}` };
    if (decision.action === 'upload') return { kind: 'ok', text: `attach ${decision.value === 'cover_letter' ? 'cover letter' : 'resume'}` };
    if (decision.action === 'fill') return { kind: decision.review ? 'warn' : 'ok', text: `${clipLabel(desc)} → ${clip(decision.value, 46)}${decision.review ? ' (verify)' : ''}` };
    return null;
  }

  const clipLabel = (desc) => clip(desc.label || desc.name || desc.id || 'field', 46);
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };

  async function run() {
    if (state.running) return;
    await ensureSnapshot();
    if (!state.plan.length) await preview();
    state.running = true;
    state.cancelled = false;
    ui.setRunning(true);
    const results = { filled: 0, uploaded: 0, unmatched: 0, blocked: 0, review: 0, failed: [] };
    const delay = Number(state.settings.visible_delay_ms ?? 260);
    let i = 0;
    for (const item of state.plan) {
      if (state.cancelled) break;
      i++;
      ui.progress(i, state.plan.length);
      const { desc, decision } = item;
      if (decision.action === 'block') { results.blocked++; mark(desc.el, 'blocked'); continue; }
      if (decision.action === 'skip') { results.unmatched++; continue; }
      if (!desc.visible) { results.unmatched++; continue; }
      if (!state.settings.overwrite_filled && desc.currentValue && desc.kind !== 'select' && desc.kind !== 'radio' && desc.kind !== 'checkbox') { continue; }

      // Ask-per-field mode: the human decides on each value, one at a time.
      if (state.reviewEach && !state.reviewAll) {
        desc.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const choice = await ui.review(item, i, state.plan.length);
        if (choice === 'skip') { results.unmatched++; ui.line({ kind: 'warn', text: `skipped ${clipLabel(desc)} — yours to answer` }); continue; }
        if (choice === 'stop') { state.cancelled = true; break; }
        if (choice === 'all') state.reviewAll = true;
      }
      if (decision.action === 'fill' && desc.kind !== 'select' && desc.kind !== 'radio' && desc.kind !== 'checkbox') {
        state.changes.push({ el: desc.el, kind: desc.kind, prev: desc.currentValue || '' });
      }

      try {
        if (decision.action === 'upload') {
          if (state.settings.upload_documents === false) { results.unmatched++; continue; }
          desc.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          const r = await attachFile(desc, decision.value);
          if (r.ok) { results.uploaded++; mark(desc.el, 'filled'); ui.line({ kind: 'ok', text: `attached ${decision.value}` }); }
          else { results.failed.push(`${clipLabel(desc)}: ${r.reason}`); ui.line({ kind: 'bad', text: `${clipLabel(desc)} — ${r.reason}` }); }
          await sleep(delay * 3);
          continue;
        }

        desc.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        let ok = false;
        if (desc.kind === 'select') ok = fillSelect(desc, decision.value);
        else if (desc.kind === 'radio') ok = fillRadio(desc, decision.value);
        else if (desc.kind === 'checkbox') ok = fillCheckbox(desc, decision.value);
        else if (desc.kind === 'editable') { desc.el.focus(); document.execCommand('insertText', false, decision.value); ok = (desc.el.textContent || '').includes(decision.value.slice(0, 24)); }
        else ok = await fillText(desc, decision.value);

        if (ok) {
          results.filled++;
          if (decision.review) results.review++;
          mark(desc.el, decision.review ? 'review' : 'filled');
          ui.line({ kind: decision.review ? 'warn' : 'ok', text: `${clipLabel(desc)} → ${clip(decision.value, 40)}` });
        } else {
          results.unmatched++;
          ui.line({ kind: 'warn', text: `could not set ${clipLabel(desc)} — left for you` });
        }
      } catch (e) {
        results.failed.push(`${clipLabel(desc)}: ${e.message}`);
      }
      await sleep(delay);
    }
    state.running = false;
    ui.setRunning(false);
    ui.summary(results, state.settings.click_navigation !== false, state.changes.length);
    if (IS_TOP) {
      // Same job in every other frame of this tab (iframe-hosted ATS forms).
      send({ type: 'broadcast-external', msg: { type: 'run' } });
    }
    send({ type: 'api', server: state.server, token: state.token, path: '/api/events', method: 'POST', body: {
      event: 'autofill_run', host: location.hostname, filled: results.filled, uploaded: results.uploaded,
      unmatched: results.unmatched, blocked: results.blocked, review: results.review,
      packet_id: state.snapshot && state.snapshot.packet_id,
    } });
  }

  function clearMarks() {
    document.querySelectorAll('[data-filldesk]').forEach((el) => { el.style.outline = ''; delete el.dataset.filldesk; });
  }

  function setReviewEach(on) {
    state.reviewEach = !!on;
    state.reviewAll = false;
    ui.setReviewEach(state.reviewEach);
    localStorage.setItem('filldesk_review_each', state.reviewEach ? '1' : '0');
    ui.line({ kind: 'ok', text: state.reviewEach
      ? 'ask-per-field is ON: it will stop at each field — Y fills, N skips, A fills the rest, Esc stops'
      : 'ask-per-field is OFF: it fills the approved plan in one run' });
  }

  async function draftCover() {
    const last = localStorage.getItem('filldesk_last_job');
    if (!last) return ui.line({ kind: 'warn', text: 'save the job first — Cover letter needs a saved posting' });
    ui.line({ kind: 'ok', text: 'drafting a cover letter for this posting…' });
    try {
      const d = await api(`/api/jobs/${last}/draft_cover`, { method: 'POST', body: {} });
      ui.showDraft(d, last);
      ui.line({ kind: 'ok', text: `draft ready (${d.words} words, ${d.method}${d.model ? ' · ' + d.model : ''}) — read it before you use it` });
      if (d.redactions && d.redactions.length) {
        ui.line({ kind: 'bad', text: `removed ${d.redactions.length} compliance statement(s) the drafter invented — only you can state those` });
      }
      if (d.note) ui.line({ kind: 'warn', text: d.note });
    } catch (e) {
      ui.line({ kind: 'bad', text: 'draft failed: ' + e.message });
    }
  }

  function undoChanges() {
    let n = 0;
    for (const c of state.changes.slice().reverse()) {
      try {
        if (!document.contains(c.el)) continue;
        if (c.kind === 'editable') { c.el.textContent = c.prev; }
        else { setNativeValue(c.el, c.prev); }
        c.el.dispatchEvent(new Event('input', { bubbles: true }));
        c.el.dispatchEvent(new Event('change', { bubbles: true }));
        n++;
      } catch (e) { /* a field the page replaced; leave it alone */ }
    }
    state.changes = [];
    clearMarks();
    ui.line({ kind: n ? 'ok' : 'warn', text: n ? `cleared ${n} field(s) FillDesk typed` : 'nothing to undo' });
  }

  document.addEventListener('keydown', (e) => {
    if (!ui.reviewOpen()) return;
    const t = e.target;
    if (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)) return;
    const k = (e.key || '').toLowerCase();
    const map = { y: 'fill', n: 'skip', a: 'all', escape: 'stop' };
    if (map[k]) { e.preventDefault(); e.stopPropagation(); ui.answerReview(map[k]); }
  }, true);

  function stop() {
    if (ui.reviewOpen()) ui.answerReview('stop');
    state.cancelled = true;
    state.running = false;
    ui.setRunning(false);
    ui.line({ kind: 'warn', text: 'stopped by you — nothing was submitted' });
  }

  function stepNext() {
    if (state.settings.click_navigation === false) return ui.line({ kind: 'warn', text: 'navigation clicks are off in Settings' });
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="submit"], input[type="button"]'));
    for (const el of candidates) {
      const text = clean(el.textContent || el.value || el.getAttribute('aria-label') || '');
      if (M.isNextText(text) && isVisible(el)) {
        ui.line({ kind: 'ok', text: `clicked "${text}" — navigation only, never Submit` });
        el.click();
        return;
      }
    }
    ui.line({ kind: 'warn', text: 'no Next/Continue button found' });
  }

  // ---------------------------------------------------------------- job capture
  function jsonLdJobs() {
    const out = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        for (const node of (Array.isArray(data) ? data : [data])) {
          const items = node['@graph'] ? node['@graph'] : [node];
          for (const item of items) {
            const type = item['@type'];
            if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) out.push(item);
          }
        }
      } catch (e) { /* malformed ld+json is common; ignore */ }
    }
    return out;
  }

  function meta(names) {
    for (const n of names) {
      const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
      if (el && el.content) return el.content.trim();
    }
    return '';
  }

  function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    div.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
    return clean(div.textContent).length > 200 ? clean(div.textContent) : clean(div.innerText || '');
  }

  function extractQuestionsFromForm() {
    const found = [];
    const push = (t) => {
      const s = clean(t);
      if (s.length > 7 && (/[?]$/.test(s) || /\b(experience with|why|describe|explain|how|what| tell|availability|expectation)\b/i.test(s)) && !found.some((f) => f.toLowerCase() === s.toLowerCase())) found.push(s);
    };
    document.querySelectorAll('label, legend, [data-filldesk-question], .label, .question').forEach((el) => push(textOf(el)));
    document.querySelectorAll('textarea, select').forEach((el) => { const l = labelText(el); push(l.label || l.legend || l.section); });
    return found.slice(0, 40);
  }

  async function saveJob() {
    const jp = jsonLdJobs()[0] || {};
    const host = location.hostname;
    const title = clean(jp.title || meta(['og:title', 'twitter:title']) || textOf(document.querySelector('h1')) || document.title);
    const company = clean((jp.hiringOrganization && (jp.hiringOrganization.name || jp.hiringOrganization['@id'])) || meta(['og:site_name']) || subdomainCompany(host) || '');
    const locationStr = jp.jobLocation
      ? clean(typeof jp.jobLocation === 'string' ? jp.jobLocation : [jp.jobLocation].flat().map((l) => (l && l.address ? [l.address.addressLocality, l.address.addressRegion, l.address.addressCountry].filter(Boolean).join(', ') : '')).join('; '))
      : '';
    let description = '';
    if (jp.description) description = stripHtml(jp.description);
    if (description.length < 200) description = mainText();
    if (title.length < 3 || description.length < 120) {
      ui.line({ kind: 'bad', text: 'could not find a job posting on this page' });
      return;
    }
    const payload = {
      url: location.href,
      title, company,
      location: locationStr || '',
      salary: clean(jp.baseSalary ? `${jp.baseSalary.value} ${jp.baseSalary.currency || ''}` : ''),
      employment_type: clean(jp.employmentType || ''),
      posted: clean(jp.datePosted || ''),
      description: description.slice(0, 20000),
      questions: extractQuestionsFromForm(),
    };
    try {
      const job = await api('/api/jobs/capture', { method: 'POST', body: payload });
      ui.line({ kind: 'ok', text: `saved “${clip(job.title, 40)}” at ${clip(job.company || host, 26)} · ${job.questions ? job.questions.length + ' questions' : 'no questions yet'}` });
      ui.savedJob(job);
    } catch (e) {
      ui.line({ kind: 'bad', text: 'save failed: ' + e.message });
    }
  }

  function subdomainCompany(host) {
    const parts = host.split('.');
    if (/greenhouse\.io$/.test(host)) {
      const seg = location.pathname.split('/').filter(Boolean)[0];
      if (seg && seg !== 'jobs' && seg !== 'o') return seg.replace(/[-_]+/g, ' ');
    }
    if (/lever\.co$/.test(host) || /smartrecruiters\.com$/.test(host)) {
      const seg = location.pathname.split('/').filter(Boolean)[0];
      if (seg && seg !== 'jobs' && seg !== 'company') return seg.replace(/[-_]+/g, ' ');
    }
    if (/workable\.com$/.test(host)) return (location.pathname.split('/').filter(Boolean)[0] || '').replace(/[-_]+/g, ' ');
    return parts.length > 2 && !['www', 'jobs', 'boards', 'careers', 'apply'].includes(parts[0]) ? parts[0] : '';
  }

  function mainText() {
    const candidates = Array.from(document.querySelectorAll('article, main, [role="main"], .job-description, #job-description, .app__job, .job-desc, .content, section'))
      .map((el) => ({ el, text: clean(el.innerText || el.textContent), }))
      .filter((c) => c.text.length > 400)
      .sort((a, b) => b.text.length - a.text.length);
    if (candidates[0]) return candidates[0].text.slice(0, 20000);
    return clean(document.body.innerText).slice(0, 20000);
  }

  async function buildPacketForSavedJob(jobId) {
    ui.line({ kind: 'ok', text: 'writing your packet…' });
    try {
      const p = await api('/api/packets', { method: 'POST', body: { job_id: jobId } });
      ui.line({ kind: 'ok', text: `packet ready (${p.answers.length} answers) — review it in the dashboard before approving` });
      window.open(`${state.server}/#packet=${p.id}`, '_blank');
    } catch (e) { ui.line({ kind: 'bad', text: 'packet failed: ' + e.message }); }
  }

  async function ensureSnapshot() {
    if (state.snapshot) return state.snapshot;
    try {
      const stored = await chrome.storage.local.get('packet_id');
      const qs = stored.packet_id ? `?packet_id=${encodeURIComponent(stored.packet_id)}` : '';
      state.snapshot = await api('/api/autofill/snapshot' + qs);
      ui.setHeader(`${state.snapshot.job.company || ''} · ${state.snapshot.job.title || ''}`.replace(/^ · /, ''), true);
      return state.snapshot;
    } catch (e) {
      ui.setHeader('no approved packet', false);
      ui.line({ kind: 'warn', text: e.message });
      return null;
    }
  }

  // ---------------------------------------------------------------- panel UI
  const ui = (function buildPanel() {
    let root, logEl, progEl, headEl, mounted = false, reviewResolve = null;
    const host = document.createElement('div');
    host.setAttribute('data-filldesk-panel', '');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:18px;bottom:18px;font-family:system-ui,sans-serif;';

    function css() {
      return `
      .box{width:330px;background:#12161d;color:#e8ecf3;border:1px solid #2a3442;border-radius:12px;
           box-shadow:0 12px 40px rgba(0,0,0,.45);font-size:12.5px;overflow:hidden}
      .hd{display:flex;align-items:center;gap:8px;padding:9px 11px;background:#171d26;border-bottom:1px solid #2a3442}
      .dot{width:8px;height:8px;border-radius:50%;background:#ef5f5f;flex:none}
      .dot.on{background:#2fbf7a}
      .ttl{font-weight:700;letter-spacing:.2px}
      .sub{color:#93a0b5;font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mini{background:#202735;border:1px solid #2a3442;color:#cdd6e3;border-radius:6px;padding:3px 7px;font-size:11px;cursor:pointer}
      .btns{display:flex;flex-wrap:wrap;gap:6px;padding:10px 11px}
      .btn{flex:1 1 auto;background:#252d3b;border:1px solid #33405200;color:#e8ecf3;border-radius:7px;padding:7px 9px;font-size:12px;cursor:pointer;font-weight:600}
      .btn:hover{background:#2e3849}
      .btn.pri{background:#5b8cff;border-color:#5b8cff;color:#fff}
      .btn.stop{background:#ef5f5f;border-color:#ef5f5f;color:#fff}
      .bar{height:4px;background:#202735}
      .bar>i{display:block;height:100%;width:0;background:#5b8cff;transition:width .18s}
      .legend{display:flex;gap:9px;padding:0 11px 8px;color:#93a0b5;font-size:10.5px}
      .legend i{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:4px}
      .log{max-height:190px;overflow:auto;padding:0 11px 10px;font-size:11.5px;line-height:1.45}
      .log div{padding:2px 0;border-bottom:1px solid #1c232e}
      .log .ok{color:#8fe0b6}.log .warn{color:#f0c48a}.log .bad{color:#f3a1a1}
      .sum{padding:9px 11px;background:#171d26;border-top:1px solid #2a3442;color:#cdd6e3}
      .sum b{color:#fff}
      .row{display:flex;gap:6px;padding:0 11px 10px}
      .row input{flex:1;background:#0f141a;border:1px solid #2a3442;color:#e8ecf3;border-radius:6px;padding:6px;font-size:11.5px}
      .hint{padding:0 11px 10px;color:#93a0b5;font-size:11px}
      .rev{border-top:1px solid #2a3442;background:#141a24;padding:9px 11px}
      .revq{color:#93a0b5;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px}
      .revl{font-weight:700;margin:2px 0}
      .revv{background:#0f141a;border:1px solid #2a3442;border-radius:6px;padding:6px;margin:5px 0 7px;
            font-size:11.5px;max-height:66px;overflow:auto;color:#cdd6e3;white-space:pre-wrap}
      .revb{display:flex;gap:6px;flex-wrap:wrap}
      .revb .btn{flex:1 1 auto;padding:6px 8px;font-size:11.5px}
      .btn.off{opacity:.55}
      .btn.on{background:#2b3f5c;border-color:#5b8cff}
      .draft{border-top:1px solid #2a3442;padding:9px 11px}
      .draft pre{margin:0 0 7px;max-height:150px;overflow:auto;white-space:pre-wrap;font:11.5px/1.5 ui-monospace,monospace;
                 background:#0f141a;border:1px solid #2a3442;border-radius:6px;padding:7px}
      .hide .body{display:none}
      `;
    }

    root = document.createElement('div');
    root.innerHTML = `<style>${css()}</style>
      <div class="box">
        <div class="hd">
          <span class="dot" id="fd-dot"></span><span class="ttl">FillDesk</span>
          <span class="sub" id="fd-sub">connecting…</span>
          <button class="mini" id="fd-min" title="collapse">–</button>
        </div>
        <div class="body">
          <div class="bar"><i id="fd-prog"></i></div>
          <div class="btns">
            <button class="btn pri" id="fd-fill">Fill application</button>
            <button class="btn" id="fd-scan">Preview</button>
            <button class="btn" id="fd-save">Save job</button>
            <button class="btn" id="fd-next">Next page</button>
            <button class="btn" id="fd-packet">Build packet</button>
            <button class="btn" id="fd-cover">Cover letter</button>
            <button class="btn off" id="fd-review" title="ask before each field">Ask per field</button>
            <button class="btn" id="fd-settings">Settings</button>
          </div>
          <div class="legend">
            <span><i style="background:#2fbf7a"></i>filled</span>
            <span><i style="background:#e6a23c"></i>verify</span>
            <span><i style="background:#ef5f5f"></i>you must answer</span>
          </div>
          <div class="rev" id="fd-rev" style="display:none">
            <div class="revq" id="fd-revq">field 1 of 1</div>
            <div class="revl" id="fd-revl"></div>
            <div class="revv" id="fd-revv"></div>
            <div class="revb">
              <button class="btn pri" id="fd-ry">Fill (Y)</button>
              <button class="btn" id="fd-rn">Skip (N)</button>
              <button class="btn" id="fd-ra">Fill the rest</button>
              <button class="btn" id="fd-rs">Stop</button>
            </div>
          </div>
          <div class="draft" id="fd-draft" style="display:none">
            <pre id="fd-drafttxt"></pre>
            <div class="revb">
              <button class="btn" id="fd-dcopy">Copy letter</button>
              <button class="btn pri" id="fd-dopen">Review in dashboard</button>
            </div>
            <div class="hint">A draft, not an answer: nothing is typed or attached until you
            read it and approve the packet.</div>
          </div>
          <div class="log" id="fd-log"></div>
          <div class="sum" id="fd-sum" style="display:none"></div>
        </div>
      </div>`;
    host.appendChild(root);

    const $ = (id) => root.querySelector('#' + id);
    progEl = $('fd-prog');
    logEl = $('fd-log');
    headEl = $('fd-sub');

    function mount() {
      if (mounted) return;
      if (!document.body) return setTimeout(mount, 200);
      mounted = true;
      document.body.appendChild(host);
      const collapsed = localStorage.getItem('filldesk_collapsed') === '1';
      if (collapsed) root.querySelector('.box').classList.add('hide');
      $('fd-min').onclick = () => {
        const box = root.querySelector('.box');
        box.classList.toggle('hide');
        localStorage.setItem('filldesk_collapsed', box.classList.contains('hide') ? '1' : '0');
      };
      $('fd-fill').onclick = () => run();
      $('fd-scan').onclick = () => preview();
      $('fd-save').onclick = () => saveJob();
      $('fd-next').onclick = () => stepNext();
      $('fd-settings').onclick = () => chrome.runtime.sendMessage({ type: 'open-popup' });
      $('fd-cover').onclick = () => draftCover();
      $('fd-review').onclick = () => setReviewEach(!state.reviewEach);
      $('fd-ry').onclick = () => ui.answerReview('fill');
      $('fd-rn').onclick = () => ui.answerReview('skip');
      $('fd-ra').onclick = () => ui.answerReview('all');
      $('fd-rs').onclick = () => ui.answerReview('stop');
      $('fd-packet').onclick = async () => {
        const last = localStorage.getItem('filldesk_last_job');
        if (!last) return line({ kind: 'warn', text: 'save the job first' });
        buildPacketForSavedJob(last);
      };
    }

    function line(item) {
      const div = document.createElement('div');
      div.className = item.kind;
      div.textContent = item.text;
      logEl.prepend(div);
      while (logEl.children.length > 140) logEl.lastChild.remove();
    }

    return {
      mount,
      isMounted: () => mounted,
      line,
      logLines(items) { logEl.innerHTML = ''; items.forEach(line); },
      counts(c) {
        headEl.textContent = `${c.fill || 0} to fill · ${c.upload || 0} uploads · ${c.block || 0} you answer`;
      },
      progress(done, total) { progEl.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`; },
      setHeader(text, connected) {
        headEl.textContent = text || (connected ? 'connected' : 'not connected');
        root.querySelector('#fd-dot').classList.toggle('on', !!connected);
      },
      setRunning(on) {
        running = on;
        const btn = root.querySelector('#fd-fill');
        btn.textContent = on ? 'Filling… (click to stop)' : 'Fill application';
        btn.classList.toggle('stop', on);
        if (on) btn.onclick = () => stop();
        else btn.onclick = () => run();
      },
      summary(r, navAllowed, undoable) {
        const sum = root.querySelector('#fd-sum');
        sum.style.display = 'block';
        sum.innerHTML = `<b>${r.filled}</b> filled · <b>${r.uploaded}</b> documents attached · <b>${r.blocked}</b> left for you (compliance) · <b>${r.unmatched}</b> unrecognised
          <div class="hint">Nothing was submitted${r.review ? `, and <b>${r.review}</b> answer(s) were flagged <span style="color:#f0c48a">verify</span>` : ''}. Read the whole form — including collapsed sections — then submit it yourself${navAllowed ? '' : ' (navigation clicks are off)'}.</div>
          <div class="hint"><b>You are responsible for everything you submit.</b> Check every answer against your actual situation before you press Submit.${undoable ? ' <button class="btn" id="fd-undo" style="margin-top:4px">Undo what FillDesk typed</button>' : ''}</div>`;
        const undo = sum.querySelector('#fd-undo');
        if (undo) undo.onclick = () => undoChanges();
      },
      review(item, index, total) {
        const box = root.querySelector('#fd-rev');
        const d = item.desc, dec = item.decision;
        root.querySelector('#fd-revq').textContent = `field ${index} of ${total} · ${dec.action === 'upload' ? 'attach a document' : 'type'}`;
        root.querySelector('#fd-revl').textContent = clipLabel(d);
        root.querySelector('#fd-revv').textContent = dec.action === 'upload'
          ? (dec.value === 'cover_letter' ? 'cover letter (.docx)' : 'your resume (.docx)')
          : String(dec.value || '');
        box.style.display = 'block';
        return new Promise((resolve) => { reviewResolve = resolve; });
      },
      reviewOpen() { return !!reviewResolve; },
      answerReview(choice) {
        root.querySelector('#fd-rev').style.display = 'none';
        const r = reviewResolve;
        reviewResolve = null;
        if (r) r(choice);
      },
      setReviewEach(on) {
        const b = root.querySelector('#fd-review');
        b.classList.toggle('on', !!on);
        b.classList.toggle('off', !on);
      },
      showDraft(d, jobId) {
        const box = root.querySelector('#fd-draft');
        root.querySelector('#fd-drafttxt').textContent = d.text;
        box.style.display = 'block';
        box.querySelector('#fd-dcopy').onclick = async () => {
          try { await navigator.clipboard.writeText(d.text); line({ kind: 'ok', text: 'cover letter copied to your clipboard' }); }
          catch (e) { line({ kind: 'warn', text: 'copy blocked by the page — select it and copy manually' }); }
        };
        box.querySelector('#fd-dopen').onclick = () => window.open(`${state.server}/#job=${jobId}`, '_blank');
      },
      savedJob(job) {
        localStorage.setItem('filldesk_last_job', job.id);
        const btn = root.querySelector('#fd-packet');
        btn.textContent = 'Build packet';
      },
      setStatus(text) { headEl.textContent = text; },
    };
  })();

  // ---------------------------------------------------------------- boot
  const IS_TOP = window.top === window.self;

  function looksLikeApplication() {
    const host = location.hostname.toLowerCase();
    if (ATS_HOSTS.some((h) => host.endsWith(h))) return true;
    if (/\/(apply|application|posting|opening|job\/|jobs\/|career)/i.test(location.pathname)) return true;
    // A page with a real form on it is worth offering the panel, whatever its title says.
    return document.querySelectorAll('input:not([type=hidden]), textarea, select').length >= 6;
  }

  async function boot() {
    await loadConfig();
    const APP_LIKE = looksLikeApplication();
    if (IS_TOP && APP_LIKE) ui.mount();
    if (localStorage.getItem('filldesk_review_each') === '1') { state.reviewEach = true; ui.setReviewEach(true); }

    if (!state.token) {
      ui.setHeader('add your token in the extension popup', false);
      return;
    }
    try {
      const st = await api('/api/status');
      ui.setHeader(`${st.llm.provider === 'none' ? 'rule-based' : st.llm.provider} · ${st.jobs} saved`, true);
      const settings = await api('/api/settings').catch(() => null);
      if (settings && settings.autofill) state.settings = { ...state.settings, ...settings.autofill };
    } catch (e) {
      ui.setHeader('server not running', false);
    }
  }

  chrome.storage.onChanged.addListener(() => { loadConfig().then(() => { state.snapshot = null; }); });

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    (async () => {
      try {
        switch (msg && msg.type) {
          case 'scan': respond({ ok: true, counts: await preview() }); break;
          case 'run': {
            if (msg.external && IS_TOP) return respond({ ok: true, skipped: 'top frame drives the run' });
            await run();
            respond({ ok: true, host: location.hostname });
            break;
          }
          case 'save-job': await saveJob(); respond({ ok: true, title: document.title }); break;
          case 'next': stepNext(); respond({ ok: true }); break;
          case 'status': respond({ ok: true, host: location.hostname, hasSnapshot: !!state.snapshot, fields: fieldElements().length, appLike: looksLikeApplication(), mounted: ui.isMounted() }); break;
          default: respond({ ok: false, error: 'unknown message' });
        }
      } catch (e) {
        respond({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  });

  boot();
})();
