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
    'jobs.lever.co', 'lever.co', 'myworkdayjobs.com', 'myworkdaysite.com', 'workday.com', 'wday.com',
    'smartrecruiters.com', 'jobs.smartrecruiters.com', 'recruitite.com', 'jobvite.com',
    'bamboohr.com', 'workable.com', 'apply.workable.com', 'personio.com', 'jobs.personio.com',
    'teamtailor.com', 'jobs.teamtailor.com', 'ashbyhq.com', 'jobs.ashbyhq.com',
    'icims.com', 'taleo.net', 'secure.netsuite.com', 'ezhire.com', 'jalbert.com',
    'cws-netprod.sterlingtech.net', 'faaalead.com', 'quantisnow.com', 'successfactors.com',
    'successfactors.eu', 'sapsf.com', 'ns2cloud.com', 'careerfive.com', 'ceipal.com', 'jobs.accenture.com',
    'dice.com', 'jooble.org', 'workingnomads.com', 'remote.co', 'otta.tech',
    'oraclecloud.com', 'csod.com', 'ultipro.com', 'dayforcehcm.com', 'applicantpro.com',
    'paylocity.com', 'paycomonline.net', 'paycom.com', 'adp.com', 'breezy.hr', 'pinpointhq.com',
    'recruitee.com', 'jazzhr.com', 'brassring.com', 'eightfold.ai', 'avature.net', 'phenompro.com',
    'phenom.com', 'rippling.com', 'ziprecruiter.com', 'wellfound.com', 'builtin.com',
    'joinhandshake.com', 'usajobs.gov'
  ];

  const BLOCKED_HOST_PATTERNS = [
    /mail\.google\.com$/i,
    /inbox\.google\.com$/i,
    /outlook\.(live|office|office365)\.com$/i,
    /mail\.yahoo\.com$/i,
    /mail\.aol\.com$/i,
    /proton\.me$/i,
    /zoho\.com$/i,
    /web\.whatsapp\.com$/i,
    /web\.telegram\.org$/i,
    /discord\.com$/i,
    /slack\.com$/i,
    /teams\.microsoft\.com$/i,
    /youtube\.com$/i,
    /netflix\.com$/i,
    /twitter\.com$/i,
    /x\.com$/i,
    /facebook\.com$/i,
    /instagram\.com$/i,
    /reddit\.com$/i,
    /tiktok\.com$/i,
    /amazon\.com$/i,
    /ebay\.com$/i,
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

  const MEMORY_STORAGE = {};
  function storageGet(key) {
    try {
      return (typeof window !== 'undefined' && window.localStorage) ? window.localStorage.getItem(key) : (MEMORY_STORAGE[key] || null);
    } catch (e) {
      // In sandboxed frames (e.g. LinkedIn or ATS iframes without allow-same-origin),
      // accessing window.localStorage throws a SecurityError. Fall back silently.
      return MEMORY_STORAGE[key] || null;
    }
  }

  function storageSet(key, value) {
    try {
      if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(key, String(value));
    } catch (e) {
      // Ignore sandbox SecurityErrors and keep in-memory copy
    }
    MEMORY_STORAGE[key] = String(value);
  }

  const MEMORY_SESSION = {};
  function sessionGet(key) {
    try {
      return (typeof window !== 'undefined' && window.sessionStorage) ? window.sessionStorage.getItem(key) : (MEMORY_SESSION[key] || null);
    } catch (e) {
      return MEMORY_SESSION[key] || null;
    }
  }

  function sessionSet(key, value) {
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) window.sessionStorage.setItem(key, String(value));
    } catch (e) {}
    MEMORY_SESSION[key] = String(value);
  }

  function dismissalKey() {
    const host = (location.hostname || '').toLowerCase();
    const isJobPortal = host === 'linkedin.com' || host.endsWith('.linkedin.com')
      || host === 'indeed.com' || host.endsWith('.indeed.com')
      || host === 'glassdoor.com' || host.endsWith('.glassdoor.com');
    if (isJobPortal) {
      return 'filldesk_dismissed_' + host + '_' + (location.pathname || '');
    }
    return 'filldesk_dismissed_' + host;
  }

  const inMemoryDismissed = new Set();
  function isDismissed() {
    const key = dismissalKey();
    if (inMemoryDismissed.has(key)) return true;
    return sessionGet(key) === '1';
  }

  function setDismissed(val) {
    const key = dismissalKey();
    if (val) {
      inMemoryDismissed.add(key);
      sessionSet(key, '1');
    } else {
      inMemoryDismissed.delete(key);
      sessionSet(key, '0');
    }
  }

  function dismissPanel() {
    if (state.running) stop();
    setDismissed(true);
    ui.hide();
  }

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
    state.settings = {
      autofill_work_auth: true,
      autofill_eeoc: true,
      ...(stored.settings || {}),
    };
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

  function isGenericPlaceholder(s) {
    if (!s) return true;
    const low = clean(s).toLowerCase().replace(/\.+$/, '');
    return /^(type here|enter text|write here|your answer|please enter|enter here|type|write|text|n\/a|na|none|select|please select|choose|search)$/i.test(low);
  }

  function fieldQuestionTitle(el) {
    if (!el) return '';
    const containerSelector = [
      '.ashby-application-form-field-entry',
      '[class*="field-entry"]',
      '[class*="FieldEntry"]',
      '[class*="form-field"]',
      '[class*="FormField"]',
      '[class*="form-group"]',
      '[class*="question-container"]',
      '[class*="application-question"]',
      '[class*="marginY"]',
      '[data-qa*="field"]',
      '[data-automation*="field"]',
      '[data-automation-id*="formField"]',
      '[data-automation-id*="section"]',
      '[data-automation-id*="composite"]',
      'fieldset',
      '.field',
      'tr',
      'li',
    ].join(',');
    const titleSelector = [
      '.ashby-application-form-question-title',
      '[class*="question-title"]',
      '[class*="QuestionTitle"]',
      '[class*="field-label"]',
      '[class*="FieldLabel"]',
      '[class*="question-text"]',
      '[class*="field-title"]',
      '[class*="FieldTitle"]',
      'legend',
      'label:not([class*="option"]):not([class*="choice"])',
      'h1,h2,h3,h4,h5,h6',
      '[role="heading"]',
      '[data-automation-id*="Label" i]',
      '[data-automation-id*="label" i]',
      '[data-automation-id*="header" i]',
      '[data-automation-id*="title" i]',
    ].join(',');

    let container = el.closest(containerSelector);
    if (container) {
      const titleEl = container.querySelector(titleSelector);
      if (titleEl && !titleEl.contains(el)) {
        const t = clean(titleEl.textContent);
        if (t && t.length < 240) return t;
      }
    }

    let curr = el.parentElement;
    for (let depth = 0; depth < 5 && curr && curr !== document.body; depth++, curr = curr.parentElement) {
      const titleEl = curr.querySelector(titleSelector);
      if (titleEl && !titleEl.contains(el)) {
        const t = clean(titleEl.textContent);
        if (t && t.length < 240) return t;
      }
      let sib = curr.previousElementSibling;
      for (let hops = 0; sib && hops < 3; hops++, sib = sib.previousElementSibling) {
        if (sib.matches(titleSelector)) {
          const t = clean(sib.textContent);
          if (t && t.length < 240) return t;
        }
      }
    }
    return '';
  }

  function parentOrHost(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode && node.getRootNode();
    return (root && root.host) ? root.host : null;
  }

  function closestDeep(el, selector) {
    let cur = el;
    while (cur && cur !== document) {
      if (cur.matches && cur.matches(selector)) return cur;
      cur = parentOrHost(cur);
    }
    return null;
  }

  function queryAllDeep(selector, root = document) {
    const out = [];
    const seen = new Set();
    function walk(r) {
      if (!r || !r.querySelectorAll) return;
      for (const el of r.querySelectorAll(selector)) {
        if (!seen.has(el)) { seen.add(el); out.push(el); }
      }
      for (const node of r.querySelectorAll('*')) {
        if (node.hasAttribute && node.hasAttribute('data-filldesk-panel')) continue;
        if (node.shadowRoot) walk(node.shadowRoot);
      }
    }
    walk(root);
    return out;
  }

  function isCookieConsentNode(el) {
    return !!closestDeep(el, '#onetrust-pc-sdk, #onetrust-consent-sdk, .onetrust-pc-dark-filter, #CybotCookiebotDialog, [id*="cookie-banner" i], [id*="cookie-consent" i], [class*="cookie-banner" i], [class*="cookie-consent" i], [class*="cc-window" i], [role="dialog"][aria-label*="cookie" i], [role="dialog"][aria-label*="consent" i], [role="dialog"][aria-label*="privacy" i]');
  }

  function labelText(el) {
    const bits = [];
    const rootNode = (el.getRootNode && el.getRootNode()) || document;
    const byId = (id) => (rootNode.getElementById ? rootNode.getElementById(id) : null) || document.getElementById(id);
    if (el.getAttribute('aria-labelledby')) {
      for (const id of el.getAttribute('aria-labelledby').split(/\s+/)) {
        const ref = byId(id);
        if (ref) bits.push(textOf(ref));
      }
    }
    const aria = el.getAttribute('aria-label');
    if (aria) bits.push(aria);

    const id = el.id;
    if (id) {
      const direct = (rootNode.querySelector ? rootNode.querySelector(`label[for="${CSS.escape(id)}"]`) : null) || document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (direct) bits.unshift(textOf(direct));
    }
    const wrapping = closestDeep(el, 'label');
    if (wrapping && el.type !== 'radio' && el.type !== 'checkbox') {
      bits.unshift(clean(wrapping.textContent.replace(el.value || '', '')));
    }

    // Check shadow host attributes & slotted labels (e.g. ADP SDF, Salesforce LWC, Workday web components)
    let hostCur = (rootNode && rootNode.host) ? rootNode.host : null;
    for (let h = 0; h < 3 && hostCur; h++, hostCur = (hostCur.getRootNode && hostCur.getRootNode().host) || null) {
      const hLabel = hostCur.getAttribute('label') || hostCur.getAttribute('aria-label') || hostCur.getAttribute('data-label');
      if (hLabel) bits.push(hLabel);
      if (hostCur.getAttribute('aria-labelledby')) {
        for (const hid of hostCur.getAttribute('aria-labelledby').split(/\s+/)) {
          const href = document.getElementById(hid);
          if (href) bits.push(textOf(href));
        }
      }
      const slottedLabel = hostCur.querySelector && hostCur.querySelector('label, [slot="label"], .label, [class*="label" i]');
      if (slottedLabel) bits.push(textOf(slottedLabel));
    }

    const qTitle = fieldQuestionTitle(el);
    if (qTitle) bits.push(qTitle);

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
      let parent = closestDeep(el, 'td,li,.field,.form-field,.forminator-field,.wf-field,fieldset,[class*="field-entry"],[class*="form-group"]');
      if (!parent) parent = parentOrHost(el);
      for (let depth = 0; depth < 4 && parent && parent !== document.body; depth++, parent = parentOrHost(parent)) {
        const clone = parent.cloneNode(true);
        const stripSelector = el.type === 'file' ? 'input,textarea,select,script,style' : 'input,textarea,select,button,script,style';
        clone.querySelectorAll(stripSelector).forEach((n) => n.remove());
        const t = clean(clone.textContent);
        if (t && t.length < 160) { bits.push(t); break; }
      }
    }
    const fs = closestDeep(el, 'fieldset');
    const legend = fs ? textOf(fs.querySelector('legend')) : '';
    const heading = nearestHeading(el);
    const placeholder = el.getAttribute('placeholder') || (rootNode && rootNode.host && rootNode.host.getAttribute('placeholder')) || '';
    const safePlaceholder = !isGenericPlaceholder(placeholder) ? placeholder : '';
    const hostName = (rootNode && rootNode.host && (rootNode.host.getAttribute('name') || rootNode.host.id)) || '';
    return {
      label: clean(bits.find(Boolean) || safePlaceholder || el.getAttribute('title') || humanize(el.name || hostName || el.id || '')),
      legend: clean(legend),
      section: clean(heading),
    };
  }

  function nearestHeading(el) {
    let node = el;
    for (let depth = 0; depth < 12 && node; depth++) {
      let sib = node.previousElementSibling;
      for (let hops = 0; sib && hops < 8; hops++, sib = sib.previousElementSibling) {
        if (/^H[1-6]$/.test(sib.tagName) || sib.getAttribute('role') === 'heading') return textOf(sib);
      }
      node = parentOrHost(node);
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
    const qTitle = fieldQuestionTitle(el);
    if (qTitle) return qTitle;
    let container = el.closest('[role="radiogroup"],[role="group"],fieldset,.radios,.radio-group,.choice,.form-group,.field,td,li');
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
    let anc = el;
    while (anc && anc !== document && anc.nodeType === 1) {
      if (anc.hasAttribute && (anc.hasAttribute('hidden') || anc.getAttribute('aria-hidden') === 'true')) return false;
      const acs = getComputedStyle(anc);
      if (acs.display === 'none' || acs.visibility === 'hidden') return false;
      anc = parentOrHost(anc);
    }
    if (el.type === 'file') {
      return Boolean(el.isConnected);
    }
    // Modern ATSs (Ashby, Greenhouse, etc.) style native radios/checkboxes with opacity: 0
    // and overlay custom SVGs or icons. Do not reject on opacity: 0 if container is visible.
    if (el.type === 'radio' || el.type === 'checkbox') {
      const parent = closestDeep(el, 'label, [class*="radio"], [class*="checkbox"], fieldset, form, section, main') || parentOrHost(el) || el;
      const rect = parent.getBoundingClientRect();
      if (rect.width < 1 && rect.height < 1) return false;
      return true;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 && rect.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.opacity === '0') return false;
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
    const nodes = queryAllDeep('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="textbox"], button[aria-haspopup="listbox"], button[aria-haspopup="dialog"], button[data-automation-id*="prompt" i], button[data-automation-id*="select" i]');
    const out = [];
    const seenRadioGroups = new Set();
    const handledContainers = new Set();

    // 1. Detect custom segmented controls (e.g. AshbyHQ Yes/No segmented button pairs)
    const segmentedContainers = queryAllDeep('.ashby-application-form-input-yesno, [class*="input-yesno"], [data-qa*="yesno"]');
    for (const container of segmentedContainers) {
      if (closestDeep(container, '[data-filldesk-panel]') || closestDeep(container, 'nav') || isCookieConsentNode(container)) continue;
      const buttons = Array.from(container.querySelectorAll('button[data-option], button')).filter(isVisible);
      if (buttons.length >= 2) {
        handledContainers.add(container);
        out.push({ el: buttons[0], kind: 'radio', group: buttons, isCustomRadio: true, container });
      }
    }

    for (const el of nodes) {
      if (closestDeep(el, '[data-filldesk-panel]') || closestDeep(el, 'nav') || isCookieConsentNode(el)) continue;
      let inHandled = false;
      for (const hc of handledContainers) {
        if (hc.contains(el)) { inHandled = true; break; }
      }
      if (inHandled) continue;

      const type = (el.type || el.tagName.toLowerCase()).toLowerCase();
      const isCombobox = el.getAttribute('role') === 'combobox' ||
        el.getAttribute('aria-haspopup') === 'listbox' ||
        el.getAttribute('aria-haspopup') === 'dialog' ||
        el.getAttribute('data-automation-id') === 'promptOption' ||
        (el.tagName === 'BUTTON' && (el.getAttribute('aria-expanded') != null || el.getAttribute('data-automation-id') === 'promptOption') && (closestDeep(el, '[class*="select" i]') || closestDeep(el, '[data-automation-id*="formField" i]') || el.getAttribute('aria-haspopup')));
      if (isCombobox) {
        out.push({ el, kind: 'select', isCustomCombobox: true });
        continue;
      }
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
      if (type === 'file') {
        // Skip ATS "Autofill from resume" / "Parse resume" widgets on complex forms with many fields
        // (Dropping a file on these triggers ATS mutations that asynchronously wipe the form).
        // On dedicated resume-upload steps (like Workday Step 1 or upload-only pages), do NOT skip.
        const otherInputs = queryAllDeep('input:not([type=hidden]):not([type=file]), textarea, select').filter(isVisible);
        const isDedicatedStep = /autofillWithResume/i.test(location.href) || otherInputs.length < 2;
        const container = closestDeep(el, 'div, section, fieldset, form') || parentOrHost(el);
        const containerText = container ? clean(container.textContent || '') : '';
        const isAutofillWidget = !isDedicatedStep && (closestDeep(el, '[class*="autofill" i], [class*="Autofill"], [data-qa*="autofill" i]') ||
          /\b(autofill|auto-fill|pre-fill|prefill|import|parse)\s*(?:from|with|using)?\s*(?:your\s*)?(?:resume|cv|profile|linkedin)\b/i.test(
            (el.getAttribute('aria-label') || '') + ' ' + (el.title || '') + ' ' + containerText
          ));
        if (isAutofillWidget) continue;
        out.push({ el, kind: 'input', isDedicatedUploadStep: isDedicatedStep });
        continue;
      }
      if (type === 'radio') {
        const name = el.name;
        const root = (el.getRootNode && el.getRootNode()) || document;
        if (name) {
          const groupKey = `${root === document ? 'doc' : 'sr'}:${name}`;
          if (seenRadioGroups.has(groupKey)) continue;
          seenRadioGroups.add(groupKey);
          const group = Array.from(root.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`));
          out.push({ el, kind: 'radio', group });
          continue;
        } else {
          const parentGroup = closestDeep(el, '[role="radiogroup"], fieldset, [class*="radio-group"], [class*="radiogroup"], .ashby-application-form-field-entry');
          if (parentGroup) {
            if (handledContainers.has(parentGroup)) continue;
            handledContainers.add(parentGroup);
            const group = queryAllDeep('input[type="radio"]', parentGroup);
            out.push({ el: group[0] || el, kind: 'radio', group });
            continue;
          }
          out.push({ el, kind: 'radio', group: [el] });
          continue;
        }
      }
      if (type === 'checkbox') { out.push({ el, kind: 'checkbox' }); continue; }
      if (el.tagName === 'SELECT') { out.push({ el, kind: 'select' }); continue; }
      if (el.tagName === 'TEXTAREA') { out.push({ el, kind: 'textarea' }); continue; }
      if (el.tagName === 'INPUT') { out.push({ el, kind: 'input' }); continue; }
      out.push({ el, kind: 'editable' });
    }
    return out;
  }

  function checkboxOptionLabel(el) {
    if (!el) return '';
    const l = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    if (l) return textOf(l);
    const wrap = el.closest('label');
    if (wrap) return clean(wrap.textContent.replace(el.value || '', ''));
    let sib = el.nextElementSibling;
    for (let hops = 0; sib && hops < 3; hops++, sib = sib.nextElementSibling) {
      const t = textOf(sib);
      if (t) return t;
    }
    sib = el.previousElementSibling;
    for (let hops = 0; sib && hops < 2; hops++, sib = sib.previousElementSibling) {
      const t = textOf(sib);
      if (t) return t;
    }
    return el.value || '';
  }

  function customComboboxOptions(el) {
    const controls = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    let listbox = controls ? document.getElementById(controls) : null;
    if (!listbox) {
      listbox = el.closest('[class*="select"], [class*="Select"], [class*="dropdown"], [class*="field"]')?.querySelector('[role="listbox"], [role="menu"]');
    }
    if (!listbox) return [];
    return Array.from(listbox.querySelectorAll('[role="option"], [role="menuitem"], li')).map((o) => ({
      label: clean(o.textContent) || o.getAttribute('data-value') || '',
      value: o.getAttribute('data-value') || clean(o.textContent) || '',
      selected: o.getAttribute('aria-selected') === 'true',
      disabled: o.getAttribute('aria-disabled') === 'true',
    }));
  }

  function describe(entry, indexHint) {
    const { el, kind } = entry;
    const { label, legend, section } = labelText(el);
    const effectiveSection = inferredSection(el, section);
    const type = kind === 'radio' ? 'radio' : kind === 'checkbox' ? 'checkbox' : kind === 'select' ? 'select'
      : kind === 'textarea' ? 'textarea' : (el.type || 'text').toLowerCase();
    const grp = groupContext(el, kind);
    const optLabel = kind === 'checkbox' ? checkboxOptionLabel(el) : '';
    const effectiveLabel = (kind === 'radio' && grp) ? grp : (kind === 'checkbox' && grp ? grp : label);
    return {
      el, kind,
      tag: entry.isCustomCombobox ? 'select' : (kind === 'editable' ? 'textarea' : el.tagName.toLowerCase()),
      type,
      label: effectiveLabel, legend,
      section: effectiveSection,
      optionLabel: optLabel,
      name: el.name || '',
      id: el.id || '',
      testid: el.getAttribute('data-qa') || el.getAttribute('data-testid') || el.getAttribute('data-automation') || el.getAttribute('data-automation-name') || '',
      placeholder: el.getAttribute('placeholder') || '',
      aria: el.getAttribute('aria-label') || '',
      groupLabel: grp,
      title: el.getAttribute('title') || '',
      autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
      help: (() => {
        const d = el.getAttribute('aria-describedby');
        if (!d) return '';
        return d.split(/\s+/).map((i) => textOf(document.getElementById(i))).join(' ');
      })(),
      options: kind === 'select' ? (entry.isCustomCombobox ? customComboboxOptions(el) : optionsOf(el)) : [],
      radioLabels: kind === 'radio' ? (entry.group || []).map((r) => ({ el: r, label: radioLabel(r) }))
        : (kind === 'checkbox' && optLabel ? [{ el, label: optLabel }] : []),
      visible: isVisible(el),
      required: el.required || el.getAttribute('aria-required') === 'true',
      currentValue: kind === 'select' ? '' : (el.value || '').toString(),
      dateHint: M.dateHintFor({ placeholder: el.getAttribute('placeholder') || '', name: el.name || '', id: el.id || '' }),
      index: indexHint || 0,
      isCustomCombobox: !!entry.isCustomCombobox,
      isDedicatedUploadStep: !!entry.isDedicatedUploadStep,
    };
  }

  function radioLabel(radio) {
    if (radio.tagName === 'BUTTON') {
      return clean(radio.textContent) || radio.getAttribute('data-option') || '';
    }
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

  function findCardIndex(el) {
    if (!el) return null;
    let cur = el;
    while (cur && cur !== document.body) {
      const aria = (cur.getAttribute && (cur.getAttribute('aria-label') || cur.getAttribute('data-automation-id') || '')) || '';
      const ariaMatch = aria.match(/(?:work\s*experience|employment|job|education)\s*(\d+)/i);
      if (ariaMatch) return parseInt(ariaMatch[1], 10) - 1;

      if (cur.matches && cur.matches('fieldset, [class*="card" i], [class*="section" i], [data-automation-id*="section" i], [data-automation-id*="formField" i]')) {
        const heading = cur.querySelector('h1, h2, h3, h4, h5, legend, [data-automation-id*="header" i], [data-automation-id*="title" i]');
        if (heading) {
          const ht = (heading.innerText || heading.textContent || '').trim();
          const hm = ht.match(/(?:work\s*experience|employment|job|education)\s*(\d+)/i);
          if (hm) return parseInt(hm[1], 10) - 1;
        }
      }

      let prev = cur.previousElementSibling;
      while (prev) {
        if (prev.matches && prev.matches('h1, h2, h3, h4, h5, [class*="header" i], [data-automation-id*="header" i]')) {
          const pt = (prev.innerText || prev.textContent || '').trim();
          const pm = pt.match(/(?:work\s*experience|employment|job|education)\s*(\d+)/i);
          if (pm) return parseInt(pm[1], 10) - 1;
        }
        prev = prev.previousElementSibling;
      }

      cur = cur.parentElement;
    }
    return null;
  }

  // ---------------------------------------------------------------- scanning
  function scan() {
    const counters = {};
    const out = [];
    for (const entry of fieldElements()) {
      const cardIdx = findCardIndex(entry.el);
      const desc = describe(entry, cardIdx ?? 0);
      const probe = M.classify(desc, state.snapshot || emptySnap(), state.settings);
      if (probe.key && /^(exp|edu|ref)\./.test(probe.key)) {
        if (cardIdx != null) {
          desc.index = cardIdx;
        } else {
          const bucket = probe.key.split('.')[1];
          desc.index = counters[bucket] || 0;
          counters[bucket] = desc.index + 1;
        }
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
    if (el.focus) el.focus({ preventScroll: true });
    const isInput = el.tagName === 'INPUT';
    const isTextarea = el.tagName === 'TEXTAREA';
    const proto = isInput ? window.HTMLInputElement.prototype
      : isTextarea ? window.HTMLTextAreaElement.prototype : null;

    // 1. Reset React's internal value tracker so React's change detection triggers
    const track = el._valueTracker;
    if (track && typeof track.setValue === 'function') {
      track.setValue('');
    }

    // 2. Set value via prototype descriptor to bypass React's own property wrapper
    if (proto) {
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) {
        setter.set.call(el, value);
      } else {
        el.value = value;
      }
    } else {
      el.value = value;
    }

    // 3. Dispatch composed bubbling input & change events for React, Vue, Angular
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: value, inputType: 'insertReplacementText' }));
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    // 4. Dispatch blur event and blur element so React forms (Rippling One-UI, Formik, React Hook Form) commit and validate
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true, composed: true }));
    if (typeof el.blur === 'function') el.blur();
  }

  function mark(el, cls) {
    if (state.settings.highlight_filled === false) return;
    el.style.outline = '';
    el.style.outlineOffset = '';
    const colors = { filled: '#2fbf7a', review: '#e6a23c', blocked: '#ef5f5f', manual: '#ef5f5f', planned: '#5b8cff' };
    el.style.outline = `2px solid ${colors[cls] || colors.planned}`;
    el.style.outlineOffset = '1px';
    el.dataset.filldesk = cls;
    setTimeout(() => { el.style.outline = ''; delete el.dataset.filldesk; }, cls === 'planned' ? 2500 : 90000);
  }

  async function fillText(desc, value) {
    const el = desc.el;
    if (el.focus) el.focus({ preventScroll: true });
    setNativeValue(el, value);
    if (el.tagName === 'SELECT') return true;
    return el.value === value || String(el.value).length > 0;
  }

  async function fillSelect(desc, value, context) {
    const el = desc.el;
    if (el.tagName === 'SELECT') {
      const ctx = context || desc.context || desc.key;
      const idx = M.matchOption(desc.options, value, ctx);
      if (idx < 0) return false;
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
      el.focus({ preventScroll: true });
      if (nativeSetter && nativeSetter.set) nativeSetter.set.call(el, desc.options[idx].value);
      else el.selectedIndex = idx;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new FocusEvent('blur', { bubbles: true, composed: true }));
      if (typeof el.blur === 'function') el.blur();
      return true;
    }
    return await fillCustomCombobox(desc, value, context);
  }

  async function fillCustomCombobox(desc, value, context) {
    const el = desc.el;
    if (el.focus) el.focus({ preventScroll: true });
    const isComboboxExpanded = el.getAttribute('aria-expanded') === 'true' || el.checked;
    if (!isComboboxExpanded) el.click();
    await sleep(200);

    const controls = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    let container = controls ? document.getElementById(controls) : null;
    if (!container) {
      container = el.closest('[class*="select"], [class*="Select"], [class*="dropdown"]') || document.body;
    }
    const optionSelector = '[data-automation-id="menuItem"], [data-automation-id="promptOption"], [data-automation-id*="option" i], [role="option"], [role="menuitem"], [data-testid*="option"], [class*="option-item"], [class*="SelectOption"], li[data-value], li[role="option"]';
    let optionEls = Array.from(document.querySelectorAll(optionSelector)).filter(isVisible);
    if (!optionEls.length && container) {
      optionEls = Array.from(container.querySelectorAll(optionSelector));
    }
    if (!optionEls.length) {
      const searchBox = document.querySelector('[data-automation-id="searchBox"], [data-automation-id*="search" i], input[type="search"]');
      if (searchBox && isVisible(searchBox)) {
        setNativeValue(searchBox, value);
        searchBox.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(300);
        optionEls = Array.from(document.querySelectorAll(optionSelector)).filter(isVisible);
      }
    }
    if (!optionEls.length) {
      const listbox = document.querySelector('[role="listbox"], [role="menu"], [class*="SelectMenu"], [class*="popover"]');
      if (listbox) optionEls = Array.from(listbox.querySelectorAll('li, button, div[tabindex]')).filter(isVisible);
    }
    if (!optionEls.length) return false;

    const opts = optionEls.map((o) => ({
      label: clean(o.textContent) || o.getAttribute('data-value') || '',
      value: o.getAttribute('data-value') || clean(o.textContent) || '',
    }));
    const ctx = context || desc.context || desc.key;
    let idx = M.matchOption(opts, value, ctx);
    if (idx < 0) {
      for (let i = 0; i < opts.length; i++) {
        if (M.booleanFor(opts[i].label, value) === true) { idx = i; break; }
        if (M.normalizeOption(opts[i].label) === M.normalizeOption(value)) { idx = i; break; }
      }
    }
    if (idx >= 0 && optionEls[idx]) {
      const isOptionSelected = optionEls[idx].getAttribute('aria-selected') === 'true' || optionEls[idx].checked;
      if (!isOptionSelected) {
        optionEls[idx].scrollIntoView({ block: 'nearest' });
        optionEls[idx].click();
      }
      optionEls[idx].dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(100);
      el.dispatchEvent(new FocusEvent('blur', { bubbles: true, composed: true }));
      if (typeof el.blur === 'function') el.blur();
      return true;
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  }

  function fillRadio(desc, value, context) {
    const items = desc.radioLabels || [];
    const ctx = context || desc.context || desc.key;
    const opts = items.map((i) => ({ label: i.label }));
    const matchIdx = M.matchOption(opts, value, ctx);
    if (matchIdx >= 0 && items[matchIdx]) {
      const target = items[matchIdx].el;
      const isAlreadyChecked = target.checked || target.getAttribute('aria-pressed') === 'true';
      if (!isAlreadyChecked) {
        if (target.focus) target.focus({ preventScroll: true });
        if (target.tagName === 'INPUT') {
          const proto = window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'checked');
          if (setter && setter.set) setter.set.call(target, true);
          else target.checked = true;
          if (target._valueTracker && typeof target._valueTracker.setValue === 'function') {
            target._valueTracker.setValue('');
          }
        }
        target.click();
        const wrapLabel = target.closest('label') || (target.id ? document.querySelector(`label[for="${CSS.escape(target.id)}"]`) : null);
        if (wrapLabel && wrapLabel !== target) {
          try { wrapLabel.click(); } catch (_) {}
        }
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return true;
    }
    for (const item of items) {
      const verdict = M.booleanFor(item.label, value);
      const isAlreadyChecked = item.el.checked || item.el.getAttribute('aria-pressed') === 'true';
      if (verdict === true && !isAlreadyChecked) {
        item.el.click();
        item.el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    for (const item of items) {
      const isAlreadyChecked = item.el.checked || item.el.getAttribute('aria-pressed') === 'true';
      if (M.normalizeOption(item.label) === M.normalizeOption(value) && !isAlreadyChecked) {
        item.el.click();
        return true;
      }
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
    if (!path) return { ok: false, reason: `no ${which} document in snapshot` };
    const res = await send({ type: 'file', server: state.server, token: state.token, path });
    if (!res.ok) return { ok: false, reason: res.error };
    const bytes = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
    const mime = /\.docx$/i.test(name)
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'text/plain';
    const file = new File([bytes], name, { type: mime, lastModified: Date.now() });
    const dt = new DataTransfer();
    dt.items.add(file);
    const targetInput = (desc.el.tagName === 'INPUT' && desc.el.type === 'file')
      ? desc.el
      : (desc.el.querySelector('input[type="file"]') || desc.el.parentElement?.querySelector('input[type="file"]') || desc.el);
    try {
      targetInput.files = dt.files;
    } catch (e) {
      return { ok: false, reason: 'this uploader blocks programmatic files' };
    }
    targetInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    targetInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    const dropzone = desc.el.closest('[class*="drop"], [class*="upload"], [class*="input-file"], [draggable]') || desc.el.parentElement || desc.el;
    if (dropzone) {
      let dropEvent;
      try {
        dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
      } catch (e) {
        dropEvent = new Event('drop', { bubbles: true, cancelable: true });
        try { Object.defineProperty(dropEvent, 'dataTransfer', { value: dt }); } catch (_) {}
      }
      dropzone.dispatchEvent(dropEvent);
      if (dropzone !== targetInput) {
        try { targetInput.dispatchEvent(dropEvent); } catch (_) {}
      }
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- actions
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function aiMapUnmatched(plan) {
    if (!state.token || !Array.isArray(plan) || !plan.length) return 0;
    const targets = [];
    for (let idx = 0; idx < plan.length; idx++) {
      const item = plan[idx];
      if (!item || !item.desc || !item.decision) continue;
      if (item.decision.action !== 'skip') continue;
      if (!item.desc.visible || item.decision.reason === 'hidden') continue;
      if (item.decision.unverified || item.decision.reason === 'ats autofill widget') continue;
      if (item.desc.type === 'file' || item.desc.tag === 'file') continue;
      targets.push({ idx, item });
    }
    if (!targets.length) return 0;
    try {
      ui.line({ kind: 'ok', text: `asking AI to map ${targets.length} unrecognised field(s)…` });
      const payloadFields = targets.slice(0, 35).map(({ idx, item }) => ({
        id: idx,
        label: item.desc.groupLabel || item.desc.label || item.desc.legend || item.desc.placeholder || item.desc.name || '',
        type: item.desc.type,
        tag: item.desc.tag,
        placeholder: item.desc.placeholder || '',
        section: item.desc.section || '',
        required: !!item.desc.required,
        options: (item.desc.options && item.desc.options.length
          ? item.desc.options.map((o) => o.label)
          : (item.desc.radioLabels || []).map((r) => r.label)).filter(Boolean),
      }));
      const res = await api('/api/autofill/map_fields', {
        method: 'POST',
        body: {
          url: location.href,
          title: document.title || '',
          job_id: storageGet('filldesk_last_job') || '',
          fields: payloadFields,
        },
      });
      const mappings = (res && res.mappings) || {};
      let mapped = 0;
      for (const { idx, item } of targets) {
        const m = mappings[String(idx)];
        if (m && m.action === 'fill' && m.value) {
          item.decision = {
            action: 'fill',
            key: 'ai:' + clipLabel(item.desc),
            value: String(m.value),
            confidence: m.confidence || 0.8,
            method: 'ai-mapper',
            review: 'ai_mapped',
            reason: '',
          };
          mark(item.desc.el, 'review');
          mapped++;
        }
      }
      if (mapped > 0) {
        ui.line({ kind: 'ok', text: `AI mapped ${mapped} additional field(s)` });
      }
      return mapped;
    } catch (e) {
      return 0;
    }
  }

  async function preview() {
    await ensureSnapshot();
    clearMarks();
    const scanResult = scan();
    state.plan = scanResult;
    const counts = { fill: 0, upload: 0, block: 0, skip: 0 };
    for (const item of scanResult) {
      if (item.decision.reason === 'hidden') continue;
      counts[item.decision.action] = (counts[item.decision.action] || 0) + 1;
      if (item.decision.action === 'fill' || item.decision.action === 'upload') mark(item.desc.el, item.decision.review ? 'review' : 'planned');
      if (item.decision.action === 'block') mark(item.desc.el, 'blocked');
      if (item.decision.action === 'skip') mark(item.desc.el, 'manual');
    }
    const unverified = flagUnverified(scanResult);
    counts.unverified = unverified;
    ui.counts(counts);
    ui.logLines(scanResult.map(lineFor).filter(Boolean));
    if (unverified) {
      ui.line({ kind: 'warn', text: `${unverified} question(s) on this form have answers you did not verify — they will NOT be typed. Tick "I have verified this" in the dashboard packet review to release them.` });
    }
    return counts;
  }

  // For the questions FillDesk will not touch, say what the honest options are, so the
  // reviewer can answer in one click instead of googling the legal vocabulary.
  const BLOCK_HINTS = {
    work_authorization: 'you choose: US citizen · permanent resident · visa holder (H-1B, TN, OPT…) · work permit (EAD) · prefer not to say',
    protected_class: 'voluntary — blank is a fine answer',
    disability: 'only you can request an accommodation',
    veteran: 'voluntary self-identification',
    legal_declaration: 'attestations are signed by you',
    age: 'yours alone',
  };

  // Questions the packet carries but the human never confirmed. They are absent from the
  // approved answers on purpose; say so, or they look like a matching failure.
  const normQ = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  function flagUnverified(plan) {
    const list = ((state.snapshot && state.snapshot.unverified_questions) || []).map(normQ).filter(Boolean);
    if (!list.length) return 0;
    let n = 0;
    for (const item of plan) {
      if (item.decision.action !== 'skip') continue;
      const q = normQ([item.desc.label, item.desc.legend, item.desc.groupLabel].join(' '));
      if (q.length < 12) continue;
      if (list.some((u) => q.includes(u.slice(0, 40)) || u.includes(q.slice(0, 40)))) {
        item.decision.unverified = true;
        n++;
      }
    }
    return n;
  }

  function lineFor(item) {
    const { desc, decision } = item;
    if (decision.action === 'block') {
      const hint = BLOCK_HINTS[decision.category];
      return { kind: 'bad', text: `will not answer — ${decision.category}: ${clipLabel(desc)}${hint ? `\n        ↳ ${hint}` : ''}` };
    }
    if (decision.action === 'upload') return { kind: 'ok', text: `attach ${decision.value === 'cover_letter' ? 'cover letter' : 'resume'}` };
    if (decision.action === 'fill') return { kind: decision.review ? 'warn' : 'ok', text: `${clipLabel(desc)} → ${clip(decision.value, 46)}${decision.review ? ' (verify)' : ''}` };
    return null;
  }

  const clipLabel = (desc) => clip(desc.label || desc.name || desc.id || 'field', 46);
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };

  async function run() {
    if (state.running) return;
    await ensureSnapshot();
    if (!state.plan.length || state.plan.some((item) => item.desc && item.desc.el && !item.desc.el.isConnected)) await preview();
    await aiMapUnmatched(state.plan);
    state.running = true;
    state.cancelled = false;
    state.reached = 0;
    ui.setRunning(true);
    const results = { filled: 0, uploaded: 0, unmatched: 0, blocked: 0, review: 0, unverified: 0, failed: [] };
    const delay = Number(state.settings.visible_delay_ms ?? 260);

    // Reorder: run all fields first, then file uploads last to prevent ATS background resume parsers
    // from overwriting inputs as they are typed.
    const nonUploads = state.plan.filter((item) => item.decision.action !== 'upload');
    const uploads = state.plan.filter((item) => item.decision.action === 'upload');
    const executionPlan = [...nonUploads, ...uploads];

    let i = 0;
    for (const item of executionPlan) {
      if (state.cancelled) break;
      i++;
      ui.progress(i, executionPlan.length);
      const { desc, decision } = item;
      if (decision.action === 'block') { results.blocked++; mark(desc.el, 'blocked'); continue; }
      if (decision.reason === 'hidden' || (!desc.visible && desc.type !== 'file')) { continue; }
      if (decision.action === 'skip') {
        if (decision.unverified) {
          results.unverified = (results.unverified || 0) + 1;
          mark(desc.el, 'review');
          ui.line({ kind: 'warn', text: `${clipLabel(desc)} — left for you (answer unverified)` });
        } else {
          results.unmatched++;
          mark(desc.el, 'manual');
          ui.line({ kind: 'bad', text: `${clipLabel(desc)} — not in profile / left for manual entry` });
        }
        continue;
      }
      if (!state.settings.overwrite_filled && desc.currentValue && desc.kind !== 'select' && desc.kind !== 'radio' && desc.kind !== 'checkbox') { continue; }

      // Ask-per-field mode: the human decides on each value, one at a time.
      if (state.reviewEach && !state.reviewAll) {
        desc.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        ui.line({ kind: 'warn', text: `waiting on you: ${clipLabel(desc)} — press Y to fill, N to skip, A for the rest` });
        send({
          type: 'api',
          server: state.server,
          token: state.token,
          path: '/api/notify',
          method: 'POST',
          body: { kind: 'waiting', field: clipLabel(desc) },
        });
        state.reached = i;
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
        if (desc.kind === 'select') ok = await fillSelect(desc, decision.value, decision.context || decision.key);
        else if (desc.kind === 'radio') ok = fillRadio(desc, decision.value, decision.context || decision.key);
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

    // Watchdog pass: ATS Single Page Apps (Rippling, Ashby, Lever) often trigger a background
    // resume parse on file upload that asynchronously clears or overwrites input fields.
    if (results.uploaded > 0) {
      await sleep(1500);
      for (const item of nonUploads) {
        if (item.decision.action === 'fill' && item.desc.el) {
          const el = item.desc.el;
          if (document.contains(el)) {
            const isText = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
            if (isText && (!el.value || el.value === '')) {
              await fillText(item.desc, item.decision.value);
              mark(el, 'filled');
            }
          }
        }
      }
    }
    state.running = false;
    ui.setRunning(false);
    ui.summary(results, state.settings.click_navigation !== false, state.changes.length,
               state.cancelled ? { reached: state.reached || 0, total: state.plan.length } : null);
    if (IS_TOP) {
      // Same job in every other frame of this tab (iframe-hosted ATS forms).
      send({ type: 'broadcast-external', msg: { type: 'run', snapshot: state.snapshot } });
    }
    send({ type: 'api', server: state.server, token: state.token, path: '/api/events', method: 'POST', body: {
      event: 'autofill_run', host: location.hostname, filled: results.filled, uploaded: results.uploaded,
      unmatched: results.unmatched, blocked: results.blocked, review: results.review,
      packet_id: state.snapshot && state.snapshot.packet_id,
      job_id: (state.snapshot && state.snapshot.job_id) || storageGet('filldesk_last_job'),
    } });
    send({
      type: 'api',
      server: state.server,
      token: state.token,
      path: '/api/notify',
      method: 'POST',
      body: { kind: 'done', field: `${results.filled} filled · ${results.unmatched} left` },
    });
  }

  function clearMarks() {
    document.querySelectorAll('[data-filldesk]').forEach((el) => { el.style.outline = ''; delete el.dataset.filldesk; });
  }

  const isDateField = (desc, decision) => Boolean(
    (window.FILLDESK_CAL && (desc.dateHint || desc.type === 'month'
      || (decision && decision.review === 'date_precision')
      || (typeof decision?.value === 'string' && /^\d{4}(-\d{1,2})?$/.test(decision.value.trim())))));

  const dateModeOf = (desc) => (desc.type === 'month' || desc.dateHint === 'my' ? 'month + year'
    : desc.dateHint === 'y' ? 'year only' : 'full date');

  /**
   * The one place a human can fix a date by clicking instead of retyping. The value is
   * re-shaped into whatever this particular field asked for (mm/dd/yyyy, yyyy-mm-dd,
   * type="month"), so choosing June 2021 can never arrive as 2021-06-01 on a form that
   * wanted 06/2021.
   */
  function openDatePicker(item, anchor, mountRoot) {
    const CAL = window.FILLDESK_CAL;
    if (!CAL || !anchor) return ui.line({ kind: 'warn', text: 'date picker unavailable' });
    const desc = item.desc;
    const mode = desc.type === 'month' || desc.dateHint === 'my' ? 'ym'
      : desc.dateHint === 'y' ? 'y' : 'mdy';
    CAL.buildPicker({
      mode,
      value: item.decision.value,
      root: mountRoot,
      onPick(chosen) {
        if (!chosen) {
          item.decision.action = 'skip';
          return ui.line({ kind: 'warn', text: `${clipLabel(desc)} date cleared — that one is yours` });
        }
        const shaped = M.formatDate(chosen, desc) || chosen;
        item.decision.value = shaped;
        const shown = mountRoot.querySelector && mountRoot.querySelector('#fd-revv');
        if (shown) shown.textContent = shaped;
        ui.line({ kind: 'ok', text: `${clipLabel(desc)} will be filled as "${shaped}"` });
      },
    }).open(anchor);
  }

  function setReviewEach(on) {
    state.reviewEach = !!on;
    state.reviewAll = false;
    ui.setReviewEach(state.reviewEach);
    storageSet('filldesk_review_each', state.reviewEach ? '1' : '0');
    ui.line({ kind: 'ok', text: state.reviewEach
      ? 'ask-per-field is ON: it will stop at each field — Y fills, N skips, A fills the rest, Esc stops'
      : 'ask-per-field is OFF: it fills the approved plan in one run' });
  }

  async function draftCover() {
    const last = storageGet('filldesk_last_job');
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

  // ---------------------------------------------------------------- error reporting
  // An extension error used to be visible only on chrome://extensions, where a stale
  // entry then haunted a fixed build for days while the snippet pointed at a line that
  // could not throw. Anything that fails inside our own script now says so in the panel
  // the user is actually looking at. Errors raised by the page itself are ignored —
  // the ATS site's broken JavaScript is not ours to report.
  let reported = 0;
  function reportError(where, detail) {
    try { console.error(`[FillDesk] ${where}`, detail); } catch (e) { /* console blocked */ }
    if (reported < 3 && ui.isMounted()) {
      reported++;
      ui.line({ kind: 'bad', text: `${where}: ${String(detail || 'unknown error').slice(0, 150)}` });
    }
  }

  const isOurs = (file) => /content\.js(\?|$)/.test(String(file || '')) || /FillDesk/.test(String(file || ''));

  window.addEventListener('error', (e) => {
    if (!isOurs(e && e.filename)) return;
    reportError('extension error', (e && e.message) || 'script failed to load');
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    const text = String((r && r.stack) || (r && r.message) || r || '');
    if (!isOurs(text) && !isOurs(r && r.fileName)) return;
    reportError('extension error', text.split('\n')[0]);
  });

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
      const isWorkdayNav = el.getAttribute('data-automation-id') === 'bottom-navigation-next-button' ||
        el.getAttribute('data-automation-id') === 'page-navigation-next-button';
      if ((M.isNextText(text) || isWorkdayNav) && isVisible(el)) {
        ui.line({ kind: 'ok', text: `clicked "${text || 'Continue'}" — navigation only, never Submit` });
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

  function isFileUploadPrompt(text) {
    return /\b(upload|attach)\b.*\b(resume|cv|curriculum vitae|cover letter|document|file|pdf|docx?|portfolio|transcript)\b/i.test(text)
      || /\b(max file size|allowed file types|accepted formats)\b/i.test(text);
  }

  function extractQuestionsFromForm() {
    const found = [];
    const push = (t) => {
      const s = clean(t);
      const isQ = (/[?]/i.test(s) || /\b(experience with|why|describe|explain|how|what|tell|availability|expectation|rate your|have you|do you|are you|will you|can you|which|years of|rate|rank|agreement|agree to|consent to)\b/i.test(s));
      if (s.length > 7 && !isFileUploadPrompt(s) && isQ && !found.some((f) => f.toLowerCase() === s.toLowerCase())) found.push(s);
    };
    document.querySelectorAll('label, legend, [data-filldesk-question], .label, .question, .ashby-application-form-question-title, [class*="question-title"], [class*="field-label"], [class*="marginY"], [class*="question-container"], [class*="form-group"]').forEach((el) => {
      if (el.closest('input[type=file]') || el.querySelector('input[type=file]')) return;
      const titleEl = el.querySelector('h1,h2,h3,h4,h5,h6,p,strong,b') || el;
      push(textOf(titleEl));
    });
    for (const entry of fieldElements()) {
      const desc = describe(entry);
      if (desc.groupLabel) push(desc.groupLabel);
      if (desc.legend) push(desc.legend);
      if (desc.label && desc.label !== 'Yes' && desc.label !== 'No') push(desc.label);
    }
    document.querySelectorAll('input:not([type=file]):not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea, select').forEach((el) => {
      const l = labelText(el);
      push(l.label || l.legend || l.section);
    });
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
    if (/ashbyhq\.com$/.test(host)) {
      const seg = location.pathname.split('/').filter(Boolean)[0];
      if (seg && seg !== 'jobs' && seg !== 'company') return seg.replace(/[-_]+/g, ' ');
    }
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

  let currentManualIndex = -1;
  function jumpToNextManualField() {
    const fields = Array.from(document.querySelectorAll('[data-filldesk="manual"], [data-filldesk="blocked"], [data-filldesk="review"]'))
      .filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
    if (!fields.length) {
      ui.line({ kind: 'ok', text: 'no manual fields remaining on this page' });
      return false;
    }
    currentManualIndex = (currentManualIndex + 1) % fields.length;
    const target = fields[currentManualIndex];
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    try { target.focus({ preventScroll: true }); } catch (e) {}
    const origOutline = target.style.outline;
    target.style.outline = '3px solid #ff2222';
    setTimeout(() => { target.style.outline = origOutline; }, 700);
    return true;
  }

  async function prepareAndFill() {
    if (state.running) return;
    state.plan = [];
    ui.setHeader('analyzing job…', true);
    ui.line({ kind: 'ok', text: '1/3 analyzing job description on this page…' });

    const jp = jsonLdJobs()[0] || {};
    const host = location.hostname;
    const title = clean(jp.title || meta(['og:title', 'twitter:title']) || textOf(document.querySelector('h1')) || document.title || 'Job Application');
    const company = clean((jp.hiringOrganization && (jp.hiringOrganization.name || jp.hiringOrganization['@id'])) || meta(['og:site_name']) || subdomainCompany(host) || '');
    let description = '';
    if (jp.description) description = stripHtml(jp.description);
    if (description.length < 200) description = mainText();

    const payload = {
      url: location.href,
      title,
      company,
      location: jp.jobLocation ? clean(typeof jp.jobLocation === 'string' ? jp.jobLocation : [jp.jobLocation].flat().map((l) => (l && l.address ? [l.address.addressLocality, l.address.addressRegion, l.address.addressCountry].filter(Boolean).join(', ') : '')).join('; ')) : '',
      description: description.slice(0, 20000),
      questions: extractQuestionsFromForm(),
    };

    try {
      ui.setHeader('tailoring with AI…', true);
      ui.line({ kind: 'ok', text: `2/3 AI tailoring resume & answers for “${clip(title, 36)}”…` });
      const res = await api('/api/autofill/prepare_and_fill', { method: 'POST', body: payload });
      state.snapshot = res.snapshot;
      storageSet('filldesk_last_job', res.job_id);
      ui.setHeader(`${res.company || ''} · ${res.title || ''}`.replace(/^ · /, ''), true);
      ui.line({ kind: 'ok', text: '3/3 tailored packet ready — filling application…' });
      await run();
    } catch (e) {
      ui.line({ kind: 'warn', text: `AI tailoring error (${e.message}) — using Master Profile…` });
      await quickFillProfile();
    }
  }

  async function quickFillProfile() {
    if (state.running) return;
    state.plan = [];
    ui.setHeader('loading profile…', true);
    try {
      state.snapshot = await api('/api/autofill/snapshot?source=profile&host=' + encodeURIComponent(location.hostname));
      ui.setHeader(`${state.snapshot.identity.full_name || 'Profile'} · Master`, true);
      ui.line({ kind: 'ok', text: 'filling directly from your Master Profile…' });
      await run();
    } catch (e) {
      ui.line({ kind: 'bad', text: 'could not load profile: ' + e.message });
    }
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
      try {
        state.snapshot = await api('/api/autofill/snapshot?source=profile&host=' + encodeURIComponent(location.hostname));
        ui.setHeader(`${state.snapshot.identity.full_name || 'Profile'} · Master`, true);
        return state.snapshot;
      } catch (_) {}
      ui.setHeader('no approved packet', false);
      ui.line({ kind: 'warn', text: e.message });
      return null;
    }
  }

  // ---------------------------------------------------------------- panel UI
  const ui = (function buildPanel() {
    let root, logEl, progEl, headEl, mounted = false, reviewResolve = null;
    // 'running' has to be declared: the file runs in strict mode, so the old bare
    // assignment in setRunning() threw ReferenceError before a single field was typed.
    let running = false;
    const host = document.createElement('div');
    host.setAttribute('data-filldesk-panel', '');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:18px;bottom:18px;font-family:system-ui,sans-serif;';

    function css() {
      return `
      .box{width:440px;min-width:380px;max-width:92vw;background:#12161d;color:#e8ecf3;border:1px solid #2a3442;border-radius:12px;
           box-shadow:0 14px 44px rgba(0,0,0,.5);font-size:13.5px;overflow:hidden}
      .hd{display:flex;align-items:center;gap:10px;padding:11px 14px;background:#171d26;border-bottom:1px solid #2a3442;cursor:grab;user-select:none;touch-action:none}
      .hd.dragging{cursor:grabbing}
      .grip{color:#5c6b82;font-size:13.5px;cursor:grab;letter-spacing:-1.5px;user-select:none;margin-right:2px;display:inline-flex;align-items:center}
      .hd.dragging .grip{cursor:grabbing}
      .dot{width:9px;height:9px;border-radius:50%;background:#ef5f5f;flex:none}
      .dot.on{background:#2fbf7a}
      .ttl{font-weight:700;font-size:15px;letter-spacing:.2px}
      .ver{color:#63708a;font-size:11.5px;font-weight:600;margin-right:4px}
      .sub{color:#93a0b5;font-size:12.5px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mini{background:#202735;border:1px solid #2a3442;color:#cdd6e3;border-radius:6px;padding:4px 9px;font-size:13px;cursor:pointer;line-height:1}
      .mini:hover{background:#2e3849;color:#fff}
      .mini.close{font-size:14px;padding:3px 8px;margin-left:2px}
      .mini.close:hover{background:#ef5f5f;border-color:#ef5f5f;color:#fff}
      .btns{display:flex;flex-wrap:wrap;gap:8px;padding:12px 14px}
      .btn{flex:1 1 calc(25% - 8px);min-width:85px;background:#252d3b;border:1px solid #33405200;color:#e8ecf3;border-radius:8px;padding:8px 10px;font-size:13px;cursor:pointer;font-weight:600;text-align:center}
      .btn:hover{background:#2e3849}
      .btn.pri{background:#5b8cff;border-color:#5b8cff;color:#fff}
      .btn.stop{background:#ef5f5f;border-color:#ef5f5f;color:#fff}
      .bar{height:4px;background:#202735}
      .bar>i{display:block;height:100%;width:0;background:#5b8cff;transition:width .18s}
      .legend{display:flex;gap:12px;padding:0 14px 10px;color:#93a0b5;font-size:12px}
      .legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px}
      .log{max-height:240px;overflow:auto;padding:0 14px 12px;font-size:12.5px;line-height:1.55}
      .log div{padding:4px 0;border-bottom:1px solid #1c232e;white-space:pre-line}
      .log .ok{color:#8fe0b6}.log .warn{color:#f0c48a}.log .bad{color:#f3a1a1}
      .sum{padding:11px 14px;background:#171d26;border-top:1px solid #2a3442;color:#cdd6e3;font-size:13px}
      .sum b{color:#fff}
      .row{display:flex;gap:8px;padding:0 14px 12px}
      .row input{flex:1;background:#0f141a;border:1px solid #2a3442;color:#e8ecf3;border-radius:7px;padding:8px 10px;font-size:13px}
      .hint{padding:0 14px 12px;color:#93a0b5;font-size:12.5px}
      .rev{border-top:1px solid #2a3442;background:#141a24;padding:12px 14px}
      /* A panel waiting on a decision has to look like it is waiting, or it reads as a
         hung tool: the reviewer's hand was already on the big button. */
      .rev.waiting{background:#182231;border-top-color:#5b8cff;box-shadow:inset 0 2px 0 #5b8cff}
      .rev.waiting .revq{color:#9db8ff}
      .rev.waiting #fd-ry{box-shadow:0 0 0 3px rgba(91,140,255,.35)}
      .revq{color:#93a0b5;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px}
      .revl{font-weight:700;font-size:14.5px;margin:3px 0}
      .revv{background:#0f141a;border:1px solid #2a3442;border-radius:7px;padding:8px 10px;margin:6px 0 8px;
            font-size:13px;max-height:85px;overflow:auto;color:#cdd6e3;white-space:pre-wrap}
      .revd{display:flex;align-items:center;gap:8px;margin:0 0 8px}
      .revd .btn{flex:none;padding:5px 10px;font-size:12px}
      .hintx{color:#93a0b5;font-size:11.5px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .revb{display:flex;gap:8px;flex-wrap:wrap}
      .revb .btn{flex:1 1 auto;padding:8px 12px;font-size:13px}
      /* Off has to read as "click me", not "cannot click me": a dimmed button in a
         dark panel looks disabled, and one reviewer already read it that way. */
      .btn.off{background:#1c232e;border:1px dashed #4a5a70;color:#c3cddd}
      .btn.off:hover{background:#2b3f5c;border-color:#5b8cff;color:#fff}
      .btn.on{background:#2b3f5c;border:1px solid #5b8cff;color:#fff}
      .draft{border-top:1px solid #2a3442;padding:12px 14px}
      .draft pre{margin:0 0 8px;max-height:180px;overflow:auto;white-space:pre-wrap;font:12.5px/1.55 ui-monospace,monospace;
                 background:#0f141a;border:1px solid #2a3442;border-radius:7px;padding:9px}
      .hide .body{display:none}
      `;
    }

    root = document.createElement('div');
    root.innerHTML = `<style>${css()}</style>
      <div class="box">
        <div class="hd" title="Drag up/down to reposition">
          <span class="grip" title="Drag up/down">⋮⋮</span>
          <span class="dot" id="fd-dot"></span><span class="ttl">FillDesk</span>
          <span class="ver" id="fd-ver"></span>
          <span class="sub" id="fd-sub">connecting…</span>
          <button class="mini" id="fd-min" title="collapse">–</button>
          <button class="mini close" id="fd-close" title="Close FillDesk on this page">✕</button>
        </div>
        <div class="body">
          <div class="bar"><i id="fd-prog"></i></div>
          <div class="btns">
            <button class="btn pri" id="fd-fill" title="1-click: tailor with AI & autofill">Tailor &amp; Fill</button>
            <button class="btn" id="fd-quick" title="1-click: fast autofill from profile">Profile Fill</button>
            <button class="btn" id="fd-scan">Preview</button>
            <button class="btn" id="fd-save">Save job</button>
            <button class="btn" id="fd-next">Next page</button>
            <button class="btn" id="fd-packet">View packet</button>
            <button class="btn" id="fd-cover" style="display:none">Cover letter</button>
            <button class="btn off" id="fd-review" title="ask before each field">Ask per field</button>
            <button class="btn" id="fd-settings">Settings</button>
          </div>
          <div class="legend">
            <span><i style="background:#2fbf7a"></i>filled</span>
            <span><i style="background:#e6a23c"></i>verify</span>
            <span><i style="background:#ef5f5f"></i>manual (you answer)</span>
          </div>
          <div class="rev" id="fd-rev" style="display:none">
            <div class="revq" id="fd-revq">field 1 of 1</div>
            <div class="revl" id="fd-revl"></div>
            <div class="revv" id="fd-revv"></div>
            <div class="revd" id="fd-revd" style="display:none">
              <button class="btn" id="fd-rdate" type="button">Change date</button>
              <span class="hintx" id="fd-rdatehint"></span>
            </div>
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
    let shadow;
    try { shadow = host.attachShadow({ mode: 'open' }); } catch (e) { shadow = host; }
    shadow.appendChild(root);

    const $ = (id) => root.querySelector('#' + id);
    progEl = $('fd-prog');
    logEl = $('fd-log');
    headEl = $('fd-sub');

    function ensureAttached() {
      if (!mounted || isDismissed()) return;
      if (!host.isConnected || !document.contains(host)) {
        const targetParent = document.documentElement || document.body;
        if (targetParent) {
          try { targetParent.appendChild(host); } catch (e) {}
        }
      }
    }

    function mount() {
      const targetParent = document.documentElement || document.body;
      if (!targetParent) return setTimeout(mount, 200);
      if (mounted) {
        ensureAttached();
        show();
        return;
      }
      try {
        const build = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?';
        root.querySelector('#fd-ver').textContent = 'v' + build;
      } catch (e) { /* a page that blocks chrome APIs still gets a panel */ }
      mounted = true;
      targetParent.appendChild(host);
      try { host.dataset.filldeskBuild = (chrome.runtime.id || 'ext') + '@' + ((chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?'); } catch (e) { /* ignore */ }
      const collapsed = storageGet('filldesk_collapsed') === '1';
      if (collapsed) root.querySelector('.box').classList.add('hide');

      function clampPosition() {
        if (!host.style.top || host.style.top === 'auto') return;
        const box = root.querySelector('.box');
        const boxHeight = (box && box.offsetHeight) || host.offsetHeight || 50;
        const maxTop = Math.max(8, window.innerHeight - boxHeight - 8);
        const curTop = parseInt(host.style.top, 10);
        if (!isNaN(curTop)) {
          const target = Math.max(8, Math.min(maxTop, curTop));
          host.style.top = target + 'px';
        }
      }

      const savedTop = parseInt(storageGet('filldesk_panel_top'), 10);
      if (!isNaN(savedTop)) {
        host.style.bottom = 'auto';
        host.style.top = savedTop + 'px';
        setTimeout(clampPosition, 40);
      }

      const hd = root.querySelector('.hd');
      let dragging = false;
      let startClientY = 0;
      let startTop = 0;

      if (hd) {
        hd.addEventListener('pointerdown', (e) => {
          if (e.button !== 0 && e.pointerType === 'mouse') return;
          if (e.target.closest('button, input, a, select')) return;

          dragging = true;
          hd.classList.add('dragging');
          startClientY = e.clientY;
          const rect = host.getBoundingClientRect();
          startTop = rect.top;
          host.style.bottom = 'auto';
          host.style.top = startTop + 'px';

          try { hd.setPointerCapture(e.pointerId); } catch (_) {}

          const onMove = (ev) => {
            if (!dragging) return;
            ev.preventDefault();
            const delta = ev.clientY - startClientY;
            const box = root.querySelector('.box');
            const boxHeight = (box && box.offsetHeight) || host.offsetHeight || 50;
            const maxTop = Math.max(8, window.innerHeight - boxHeight - 8);
            const newTop = Math.max(8, Math.min(maxTop, startTop + delta));
            host.style.top = newTop + 'px';
          };

          const onUp = (ev) => {
            if (!dragging) return;
            dragging = false;
            hd.classList.remove('dragging');
            try { hd.releasePointerCapture(ev.pointerId); } catch (_) {}
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);

            const finalTop = parseInt(host.style.top, 10);
            if (!isNaN(finalTop)) {
              storageSet('filldesk_panel_top', String(finalTop));
            }
          };

          window.addEventListener('pointermove', onMove, { passive: false });
          window.addEventListener('pointerup', onUp);
          window.addEventListener('pointercancel', onUp);
          e.preventDefault();
        });

        hd.addEventListener('dblclick', (e) => {
          if (e.target.closest('button, input, a, select')) return;
          host.style.top = 'auto';
          host.style.bottom = '18px';
          storageSet('filldesk_panel_top', '');
        });

        window.addEventListener('resize', clampPosition);
      }

      $('fd-min').onclick = () => {
        const box = root.querySelector('.box');
        box.classList.toggle('hide');
        storageSet('filldesk_collapsed', box.classList.contains('hide') ? '1' : '0');
        setTimeout(clampPosition, 40);
      };
      $('fd-close').onclick = () => {
        dismissPanel();
      };
      $('fd-fill').onclick = () => {
        prepareAndFill();
      };
      $('fd-quick').onclick = () => quickFillProfile();
      $('fd-scan').onclick = () => preview();
      $('fd-save').onclick = () => saveJob();
      $('fd-next').onclick = () => stepNext();
      $('fd-settings').onclick = () => chrome.runtime.sendMessage({ type: 'open-popup' });
      if ($('fd-cover')) $('fd-cover').onclick = () => draftCover();
      $('fd-review').onclick = () => setReviewEach(!state.reviewEach);
      $('fd-ry').onclick = () => ui.answerReview('fill');
      $('fd-rn').onclick = () => ui.answerReview('skip');
      $('fd-ra').onclick = () => ui.answerReview('all');
      $('fd-rs').onclick = () => ui.answerReview('stop');
      $('fd-packet').onclick = async () => {
        const last = storageGet('filldesk_last_job');
        if (!last) return line({ kind: 'warn', text: 'save or tailor a job first' });
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

    function show() {
      if (host) host.style.display = '';
      ensureAttached();
    }

    function hide() {
      if (host) host.style.display = 'none';
    }

    function toggleBox() {
      const box = root.querySelector('.box');
      if (box) {
        box.classList.toggle('hide');
        storageSet('filldesk_collapsed', box.classList.contains('hide') ? '1' : '0');
      }
    }

    return {
      mount,
      show,
      hide,
      dismiss: () => dismissPanel(),
      toggleBox,
      ensureAttached,
      isMounted: () => mounted && host && host.isConnected,
      isVisible: () => mounted && host && host.isConnected && host.style.display !== 'none',
      isDismissed: () => isDismissed(),
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
        btn.textContent = on ? 'Filling… (click to stop)' : 'Tailor & Fill';
        btn.classList.toggle('stop', on);
        if (on) btn.onclick = () => stop();
        else btn.onclick = () => prepareAndFill();
      },
      summary(r, navAllowed, undoable, stopped) {
        const sum = root.querySelector('#fd-sum');
        sum.style.display = 'block';
        const head = stopped
          ? `<b>Stopped after ${stopped.reached} of ${stopped.total} fields</b> — the rest were never touched, so nothing below is a verdict on them.<br>`
          : '';
        const manualTotal = (r.blocked || 0) + (r.unmatched || 0);
        sum.innerHTML = `${head}
          <div style="display:flex;gap:10px;margin-bottom:8px;font-size:13.5px;flex-wrap:wrap">
            <span style="color:#2fbf7a;font-weight:700">● ${r.filled} filled</span>
            ${r.review ? `<span style="color:#e6a23c;font-weight:700">● ${r.review} verify</span>` : ''}
            <span style="color:#ef5f5f;font-weight:700">● ${manualTotal} manual (red)</span>
            ${r.uploaded ? `<span>· <b>${r.uploaded}</b> attached</span>` : ''}
          </div>
          <div><b>${r.filled}</b> filled · <b>${r.uploaded}</b> documents attached · <b>${r.blocked}</b> left for you (compliance)${r.unverified ? ` · <b>${r.unverified}</b> left for you (answer unverified)` : ''} · <b>${r.unmatched}</b> unrecognised</div>
          ${manualTotal > 0 ? `<div style="margin:8px 0"><button class="btn pri" id="fd-jump-manual" style="width:100%;padding:8px 10px;cursor:pointer">Jump to next manual field (red) ➔</button></div>` : ''}
          <div class="hint">Nothing was submitted${r.review ? `, and <b>${r.review}</b> answer(s) were flagged <span style="color:#f0c48a">verify</span>` : ''}. Fields in <span style="color:#ef5f5f;font-weight:600">red</span> need manual input. Read the whole form — including collapsed sections — then submit it yourself${navAllowed ? '' : ' (navigation clicks are off)'}.</div>
          <div class="hint"><b>You are responsible for everything you submit.</b> Check every answer against your actual situation before you press Submit.${undoable ? ' <button class="btn" id="fd-undo" style="margin-top:4px">Undo what FillDesk typed</button>' : ''}</div>`;
        const undo = sum.querySelector('#fd-undo');
        if (undo) undo.onclick = () => undoChanges();
        const jumpBtn = sum.querySelector('#fd-jump-manual');
        if (jumpBtn) jumpBtn.onclick = () => jumpToNextManualField();
      },
      review(item, index, total) {
        const box = root.querySelector('#fd-rev');
        const d = item.desc, dec = item.decision;
        root.querySelector('#fd-revq').textContent = `field ${index} of ${total} · ${dec.action === 'upload' ? 'attach a document' : 'type'}`;
        root.querySelector('#fd-revl').textContent = clipLabel(d);
        root.querySelector('#fd-revv').textContent = dec.action === 'upload'
          ? (dec.value === 'cover_letter' ? 'cover letter (.docx)' : 'your resume (.docx)')
          : String(dec.value || '');
        const dateRow = root.querySelector('#fd-revd');
        dateRow.style.display = isDateField(d, dec) ? 'flex' : 'none';
        if (dateRow.style.display === 'flex') {
          root.querySelector('#fd-rdatehint').textContent = `this form wants ${dateModeOf(d)} — pick it, do not type it`;
          root.querySelector('#fd-rdate').onclick = () => openDatePicker(item, root.querySelector('#fd-rdate'), root.getRootNode());
        }
        box.style.display = 'block';
        box.classList.add('waiting');
        // The run button sits exactly where a hand reaching for "Fill" already points,
        // and it read "Filling… (click to stop)" — one reviewer pressed it, stopped the
        // run at field 1, and concluded the extension filled nothing. Shorter text, and
        // the decision button gets focus so Y and Enter both work immediately.
        const runBtn = root.querySelector('#fd-fill');
        runBtn.textContent = 'Stop run';
        runBtn.classList.remove('pri');
        try { root.querySelector('#fd-ry').focus({ preventScroll: true }); } catch (e) { /* headless */ }
        box.scrollIntoView({ block: 'nearest' });
        return new Promise((resolve) => { reviewResolve = resolve; });
      },
      reviewOpen() { return !!reviewResolve; },
      answerReview(choice) {
        const box = root.querySelector('#fd-rev');
        box.style.display = 'none';
        box.classList.remove('waiting');
        if (running) {
          const runBtn = root.querySelector('#fd-fill');
          runBtn.textContent = running ? 'Filling…' : 'Fill application';
          runBtn.classList.add('stop');
        }
        const r = reviewResolve;
        reviewResolve = null;
        if (r) r(choice);
      },
      setReviewEach(on) {
        const b = root.querySelector('#fd-review');
        b.classList.toggle('on', !!on);
        b.classList.toggle('off', !on);
        b.textContent = on ? 'Ask per field ✓' : 'Ask per field ○';
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
        storageSet('filldesk_last_job', job.id);
        const btn = root.querySelector('#fd-packet');
        btn.textContent = 'Build packet';
      },
      setStatus(text) { headEl.textContent = text; },
    };
  })();

  // ---------------------------------------------------------------- boot
  const IS_TOP = window.top === window.self;

  // Never run on our own dashboard. It is a page full of inputs, and the extension
  // filling it would type an approved packet into the profile form that produced it.
  //
  // Scoped to the dashboard's own paths on purpose: the sample form at
  // /preview.html is served from this very origin and exists so the autofiller can be
  // tested. Excluding the whole origin deleted the panel from the test form — which is
  // exactly the page a reviewer is told to open first.
  const DASHBOARD_PATHS = new Set(['/', '/index.html', '/app.js', '/styles.css']);
  const isOwnDashboard = () => {
    try {
      return new URL(state.server).origin === location.origin && DASHBOARD_PATHS.has(location.pathname);
    } catch (e) { return false; }
  };

  function looksLikeApplication() {
    if (isOwnDashboard()) return false;
    const host = location.hostname.toLowerCase();
    const path = location.pathname.toLowerCase();
    const search = location.search.toLowerCase();

    // 1. Blocked sites: Webmail, general social feeds, shopping, chat
    if (BLOCKED_HOST_PATTERNS.some((p) => p.test(host))) return false;

    // 2. LinkedIn: active ONLY on /jobs, /talent, /hiring (never on /feed, /messaging, /in, /mynetwork)
    if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
      return /^\/(jobs|talent|hiring)\b/i.test(path);
    }

    // 3. Indeed: only on viewjob, rc, jobs, apply, cmp
    if (host === 'indeed.com' || host.endsWith('.indeed.com')) {
      return /(viewjob|rc|jobs|apply|cmp)/i.test(path) || search.includes('vjk=');
    }

    // 4. Glassdoor: job sections only
    if (host === 'glassdoor.com' || host.endsWith('.glassdoor.com')) {
      return /(job|jobs|overview)/i.test(path);
    }

    // 5. Dedicated ATS domains
    if (ATS_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return true;

    // 6. Dedicated career/job subdomains on any enterprise domain (e.g. careers.honeywell.com, jobs.apple.com)
    if (/(^|\.)(careers?|jobs?|talent|recruiting|hcm)\./i.test(host)) return true;

    // 7. Path contains clear job application or career portal tokens
    if (/(apply|application|posting|openings?|jobs?|careers?|vacanc\w*|requisition|portalcareer|employment|join-?us|work-?with-?us)\b/i.test(path)) return true;

    // 8. Query string has job req or application parameters
    if (/[?&](job_?id|req_?id|career_job_req_id|posting_?id|opening_?id|gh_jid|career_ns|currentjobid|jobid|reqid|requisitionid)\b/i.test(search)) return true;

    // 9. Structured Data JSON-LD has JobPosting schema
    if (jsonLdJobs().length > 0) return true;

    // 10. Document title indicates job / career opportunity
    const title = (document.title || '').toLowerCase();
    if (/(career opportunities|job opportunities|job opening|apply for|application for|job details)\b/i.test(title)) return true;

    // 11. Apply or Save Job action on screen AND at least 2 real input fields
    const hasJobAction = Array.from(document.querySelectorAll('button, a, input[type=button], input[type=submit]')).some((el) => {
      const t = (el.textContent || el.value || '').trim().toLowerCase();
      return /^(apply|apply now|save job|submit application)$/i.test(t);
    });
    if (hasJobAction && document.querySelectorAll('input:not([type=hidden]), textarea, select').length >= 2) return true;

    // 12. Candidate application form signature (file upload for resume + contact inputs)
    const hasResumeUpload = !!document.querySelector('input[type=file]');
    if (hasResumeUpload && document.querySelectorAll('input:not([type=hidden]), textarea, select').length >= 3) return true;

    return false;
  }

  async function uiCheckServer() {
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

  let lastHref = location.href;
  let lastStepHeader = '';
  function currentStepHeading() {
    const el = document.querySelector('[data-automation-id="pageHeader"], [aria-current="step"], [data-automation-id="progressBarStepActive"], [data-automation-id="subPageTitle"], h1, h2');
    return el ? clean(el.textContent || el.innerText || '') : '';
  }

  function handleNavigation() {
    if (!IS_TOP) return;
    const isApp = looksLikeApplication();
    if (isApp) {
      if (isDismissed()) return;
      state.plan = [];
      if (!ui.isMounted()) {
        ui.mount();
        uiCheckServer();
      } else {
        ui.show();
        preview().catch(() => {});
      }
    } else {
      if (ui.isMounted()) {
        ui.hide();
      }
    }
  }

  function checkNavigation() {
    const curHref = location.href;
    const curStep = currentStepHeading();
    const hrefChanged = curHref !== lastHref;
    const stepChanged = Boolean(curStep && lastStepHeader && curStep !== lastStepHeader);

    if (hrefChanged || stepChanged) {
      lastHref = curHref;
      lastStepHeader = curStep;
      handleNavigation();
    } else if (IS_TOP && looksLikeApplication() && !isDismissed()) {
      if (!lastStepHeader && curStep) lastStepHeader = curStep;
      ui.ensureAttached();
    }
  }

  async function boot() {
    await loadConfig();
    if (isOwnDashboard()) {
      // Silent by design: the dashboard is FillDesk, not a form to fill.
      window.__FILLDESK__ = 'own-origin';
      return;
    }
    try {
      const build = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?';
      console.info(`[FillDesk] content script v${build} on ${location.host}`
        + ` (matcher ${window.FILLDESK_MATCHER ? 'ok' : 'MISSING'}, calendar ${window.FILLDESK_CAL ? 'ok' : 'MISSING'})`);
    } catch (e) { /* logging must never break a page */ }
    const APP_LIKE = looksLikeApplication();
    if (IS_TOP && APP_LIKE && !isDismissed()) {
      ui.mount();
      uiCheckServer();
    }
    if (storageGet('filldesk_review_each') === '1') { state.reviewEach = true; ui.setReviewEach(true); }

    // Run continuous lightweight check for SPA client-side navigations (e.g. LinkedIn, Workday)
    setInterval(checkNavigation, 500);

    window.addEventListener('popstate', () => { lastHref = location.href; handleNavigation(); });
    window.addEventListener('hashchange', () => { lastHref = location.href; handleNavigation(); });
    document.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('a, button, [role="button"], [role="link"], [role="tab"]')) {
        setTimeout(checkNavigation, 250);
        setTimeout(checkNavigation, 800);
      }
    }, { passive: true });
  }

  chrome.storage.onChanged.addListener(() => { loadConfig().then(() => { state.snapshot = null; }); });

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    (async () => {
      try {
        if (isOwnDashboard()) return respond({ ok: false, error: 'FillDesk does not run on its own dashboard' });
        switch (msg && msg.type) {
          case 'url_changed': {
            lastHref = location.href;
            handleNavigation();
            respond({ ok: true });
            break;
          }
          case 'mount':
          case 'toggle': {
            if (IS_TOP) {
              setDismissed(false);
              if (!ui.isMounted()) {
                ui.mount();
                ui.show();
                uiCheckServer();
              } else if (!ui.isVisible()) {
                ui.show();
                uiCheckServer();
              } else {
                ui.toggleBox();
              }
            }
            respond({ ok: true, mounted: ui.isMounted(), visible: ui.isVisible() });
            break;
          }
          case 'scan': {
            setDismissed(false);
            if (IS_TOP && !ui.isMounted()) { ui.mount(); uiCheckServer(); }
            if (IS_TOP) ui.show();
            respond({ ok: true, counts: await preview() });
            break;
          }
          case 'run': {
            setDismissed(false);
            if (IS_TOP && !ui.isMounted()) { ui.mount(); uiCheckServer(); }
            if (IS_TOP) ui.show();
            if (msg.external && IS_TOP) return respond({ ok: true, skipped: 'top frame drives the run' });
            if (msg.snapshot) { state.snapshot = msg.snapshot; state.plan = []; }
            await run();
            respond({ ok: true, host: location.hostname });
            break;
          }
          case 'save-job': {
            setDismissed(false);
            if (IS_TOP && !ui.isMounted()) { ui.mount(); uiCheckServer(); }
            if (IS_TOP) ui.show();
            await saveJob();
            respond({ ok: true, title: document.title });
            break;
          }
          case 'next': stepNext(); respond({ ok: true }); break;
          case 'status': respond({ ok: true, host: location.hostname, hasSnapshot: !!state.snapshot, fields: fieldElements().length, appLike: looksLikeApplication(), mounted: ui.isMounted(), visible: ui.isVisible(), dismissed: isDismissed() }); break;
          default: respond({ ok: false, error: 'unknown message' });
        }
      } catch (e) {
        reportError('message handler', e && e.message);
        respond({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  });

  boot().catch((e) => { /* sandboxed or restricted frames fail quietly */ });
})();
