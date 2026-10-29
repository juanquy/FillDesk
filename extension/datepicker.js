/*
 * Shared calendar widget.
 *
 * One file, two homes: the dashboard loads it as /shared/datepicker.js and the
 * extension loads it as a content script. No dependencies; it carries its own styles
 * inside its own container so it renders the same inside a shadow root.
 *
 * Modes exist because application dates are not all full dates. A job is honestly
 * "2021-06"; schooling is often just a year; "earliest start date" is a real day. A
 * native <input type="date"> cannot express the first two, which is exactly why a
 * year-only date used to arrive at an employer as January 1st.
 */
(() => {
  'use strict';

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const pad = (n) => String(n).padStart(2, '0');
  const daysInMonth = (y, m) => new Date(y, m, 0).getDate();

  /** Weeks for one month: 7 cells each, null where the month does not reach. */
  function monthMatrix(year, month, weekStartsOn = 0) {
    if (!(year >= 1 && year <= 9999) || !(month >= 1 && month <= 12)) return [];
    const lead = (new Date(year, month - 1, 1).getDay() - weekStartsOn + 7) % 7;
    const cells = new Array(lead).fill(null);
    for (let d = 1; d <= daysInMonth(year, month); d++) cells.push({ day: d, month, year });
    while (cells.length % 7) cells.push(null);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }

  /** A pick becomes the string that field stores. Never a padded fake day. */
  function pickToValue(parts, mode) {
    if (!parts || !parts.year) return '';
    const y = parts.year;
    if (mode === 'y') return String(y);
    if (mode === 'ym') return parts.month ? `${y}-${pad(parts.month)}` : String(y);
    if (parts.month && parts.day) return `${y}-${pad(parts.month)}-${pad(parts.day)}`;
    return parts.month ? `${y}-${pad(parts.month)}` : String(y);
  }

  /** Accept what people already typed: 2021, 2021-06, 06/2021, 01/15/2024, 15/06/2024. */
  function parseLoose(value) {
    const s = String(value || '').trim();
    if (!s || /^(present|current|now|n\/?a|unknown|tbd)$/i.test(s)) return null;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return { year: +m[1], month: +m[2], day: +m[3] };
    m = s.match(/^(\d{4})-(\d{1,2})$/);
    if (m) return { year: +m[1], month: +m[2] };
    m = s.match(/^(\d{4})$/);
    if (m) return { year: +m[1] };
    m = s.match(/^(\d{1,2})[/.](\d{4})$/);
    if (m) return { year: +m[2], month: +m[1] > 12 ? 1 : +m[1] };
    m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
    if (m) {
      const a = +m[1], b = +m[2];
      if (a > 12 && b <= 12) return { year: +m[3], month: b, day: a };
      return { year: +m[3], month: a > 12 ? 1 : a, day: b > 31 ? 1 : b };
    }
    return null;
  }

  /** Refuse an impossible pick rather than write a 13th month into someone's history. */
  function valid(parts, mode) {
    if (!parts || !(parts.year >= 1)) return false;
    if (parts.month != null && (parts.month < 1 || parts.month > 12)) return false;
    if (parts.day != null && (parts.day < 1 || parts.day > daysInMonth(parts.year, parts.month || 1))) return false;
    if (mode === 'mdy') return !!(parts.month && parts.day);
    if (mode === 'ym') return !!parts.month;
    return true;
  }

  const CSS = `
.fc{position:fixed;z-index:2147483647;width:238px;background:#12161d;color:#e8ecf3;
    border:1px solid #2a3442;border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.5);
    font-family:system-ui,sans-serif;font-size:12px;padding:9px;box-sizing:border-box}
.fc *{box-sizing:border-box}
.fc .hd{display:flex;align-items:center;gap:4px;margin-bottom:7px}
.fc .hd b{flex:1;text-align:center;font-size:12.5px}
.fc .nv{background:#202735;border:1px solid #2a3442;color:#cdd6e3;border-radius:6px;
        width:26px;height:22px;line-height:1;cursor:pointer;font-size:13px;padding:0}
.fc .nv:hover{background:#2e3849;border-color:#5b8cff}
.fc .dow{display:grid;grid-template-columns:repeat(7,1fr);color:#93a0b5;font-size:10px;
         text-align:center;margin-bottom:3px}
.fc .grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.fc .grid.thirds{grid-template-columns:repeat(3,1fr)}
.fc .cell{background:#1a212b;border:1px solid transparent;border-radius:6px;padding:5px 0;
          text-align:center;cursor:pointer;color:#dbe3ee;font-size:11.5px;font-family:inherit}
.fc .cell:hover{background:#2b3f5c;border-color:#5b8cff}
.fc .cell.blank{background:none;cursor:default;pointer-events:none}
.fc .cell.sel{background:#5b8cff;border-color:#5b8cff;color:#fff;font-weight:700}
.fc .ft{display:flex;gap:5px;margin-top:8px}
.fc .ft button{flex:1;background:#252d3b;border:1px solid #334052;color:#cdd6e3;border-radius:6px;
               padding:5px;font-size:11px;cursor:pointer;font-family:inherit}
.fc .ft button:hover{background:#2e3849;border-color:#5b8cff}
.fc .hint{color:#93a0b5;font-size:10.5px;margin-top:6px;text-align:center;line-height:1.35}
.calbtn{background:#202735;border:1px solid #2a3442;border-radius:6px;color:#cdd6e3;
        padding:4px 7px;font-size:12px;cursor:pointer;line-height:1}
.calbtn:hover{background:#2e3849;border-color:#5b8cff}
`;

  /**
   * buildPicker({ mode:'ym'|'y'|'mdy', value, onPick(value), root, weekStartsOn })
   * → { open(anchor), close(), setValue(value) }. The caller passes the root to mount
   * into, which is what lets the extension open it inside its shadow root.
   */
  function buildPicker(opts = {}) {
    const mode = opts.mode || 'ym';
    const weekStartsOn = opts.weekStartsOn || 0;
    let picked = parseLoose(opts.value) || {};
    let view = { year: picked.year || new Date().getFullYear(), month: picked.month || new Date().getMonth() + 1 };
    let level = mode === 'y' ? 'year' : mode === 'ym' ? 'month' : 'day';
    let root = null;
    let anchor = null;

    const emit = (value) => { close(); if (opts.onPick) opts.onPick(value); };

    function shift(steps) {
      if (level === 'year') { view.year += steps * 12; return; }
      const total = view.year * 12 + (view.month - 1) + steps;
      view = { year: Math.floor(total / 12), month: (total % 12 + 12) % 12 + 1 };
      if (view.year < 1900) view = { year: 1900, month: view.month };
    }

    function title() {
      if (level === 'year') { const s = Math.floor(view.year / 12) * 12; return `${s} – ${s + 11}`; }
      if (level === 'month') return String(view.year);
      return `${MONTHS[view.month - 1]} ${view.year}`;
    }

    function gridHTML(labels, cls, selected) {
      return `<div class="grid ${cls}">${labels.map((label, i) =>
        `<button type="button" class="cell${label === '' ? ' blank' : ''}${selected === i ? ' sel' : ''}" data-i="${i}">${label}</button>`).join('')}</div>`;
    }

    function bodyHTML() {
      if (level === 'year') {
        const start = Math.floor(view.year / 12) * 12;
        const years = Array.from({ length: 12 }, (_, i) => String(start + i));
        return gridHTML(years, 'thirds', view.year - start);
      }
      if (level === 'month') return gridHTML(MONTHS.map((m) => m.slice(0, 3)), 'thirds', view.month - 1);
      const head = `<div class="dow">${[0, 1, 2, 3, 4, 5, 6].map((i) => `<span>${DOW[(i + weekStartsOn) % 7]}</span>`).join('')}</div>`;
      const cells = monthMatrix(view.year, view.month, weekStartsOn).flat()
        .map((c) => (c ? String(c.day) : ''));
      const sel = (picked.day && picked.month === view.month && picked.year === view.year) ? picked.day - 1 : -1;
      return head + gridHTML(cells, '', sel);
    }

    function footerHTML() {
      const bits = [];
      if (level === 'day' && mode === 'mdy') bits.push('<button type="button" data-a="month">Month only</button>');
      if (mode !== 'mdy') bits.push('<button type="button" data-a="year">Year only</button>');
      bits.push('<button type="button" data-a="clear">Clear</button>');
      const hint = mode === 'y' ? 'A bare year is a valid answer. A guessed month is not.'
        : mode === 'ym' ? 'Month and year — no invented day.'
          : 'Pick a day only if you are sure of it.';
      return `<div class="ft">${bits.join('')}</div><div class="hint">${hint}</div>`;
    }

    function render() {
      if (!root) return;
      root.querySelector('.hd b').textContent = title();
      root.querySelector('.calbody').innerHTML = bodyHTML();
      root.querySelector('.calfoot').innerHTML = footerHTML();
      bind();
    }

    function bind() {
      root.querySelectorAll('.calbody .cell').forEach((btn) => {
        if (btn.classList.contains('blank')) return;
        btn.onclick = () => {
          const i = Number(btn.dataset.i);
          if (level === 'year') {
            const year = Math.floor(view.year / 12) * 12 + i;
            if (mode === 'y') return emit(pickToValue({ year }, 'y'));
            view = { year, month: view.month };
            level = 'month';
            return render();
          }
          if (level === 'month') {
            const month = i + 1;
            if (mode === 'ym') return emit(pickToValue({ year: view.year, month }, 'ym'));
            view = { year: view.year, month };
            level = 'day';
            return render();
          }
          const cell = monthMatrix(view.year, view.month, weekStartsOn).flat()[i];
          if (!cell) return;
          const next = { year: cell.year, month: cell.month, day: cell.day };
          if (!valid(next, 'mdy')) return;
          emit(pickToValue(next, 'mdy'));
        };
      });
      root.querySelectorAll('.calfoot [data-a]').forEach((btn) => {
        btn.onclick = () => {
          const a = btn.dataset.a;
          if (a === 'clear') return emit('');
          if (a === 'year') return emit(pickToValue({ year: view.year }, 'y'));
          if (a === 'month') { level = 'month'; return render(); }
          return undefined;
        };
      });
      root.querySelectorAll('[data-nav]').forEach((btn) => {
        btn.onclick = () => { shift(btn.dataset.nav === 'next' ? 1 : -1); render(); };
      });
    }

    function outside(e) {
      if (!root) return;
      // Inside a shadow root the event target is retargeted to the host, so compare
      // the composed path or a click on a day would close the picker before it lands.
      const path = e.composedPath ? e.composedPath() : [e.target];
      if (path.includes(root) || (anchor && path.includes(anchor))) return;
      close();
    }

    function open(anchorEl) {
      close();
      anchor = anchorEl;
      root = document.createElement('div');
      root.className = 'fc';
      root.innerHTML = `<style>${CSS}</style>
        <div class="hd"><button type="button" class="nv" data-nav="prev" title="earlier">‹</button>
        <b></b><button type="button" class="nv" data-nav="next" title="later">›</button></div>
        <div class="calbody"></div><div class="calfoot"></div>`;
      (opts.root || document.body).appendChild(root);
      render();
      const r = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : { top: 90, left: 90, bottom: 90 };
      const width = 238, height = level === 'day' ? 250 : 230;
      root.style.left = Math.min(Math.max(8, r.left), Math.max(8, (window.innerWidth || 1200) - width - 8)) + 'px';
      root.style.top = (r.bottom + 6 + height > (window.innerHeight || 800) ? Math.max(8, r.top - height - 6) : r.bottom + 6) + 'px';
      setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    }

    function close() {
      document.removeEventListener('pointerdown', outside, true);
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = null;
    }

    return {
      open,
      close,
      isOpen: () => !!root,
      setValue(value) {
        picked = parseLoose(value) || {};
        if (picked.year) view = { year: picked.year, month: picked.month || view.month };
        level = mode === 'y' ? 'year' : mode === 'ym' ? (picked.month ? 'month' : 'month') : (picked.day ? 'day' : picked.month ? 'month' : 'day');
      },
    };
  }

  /**
   * attachAll(scope): every <input data-cal="ym|y|mdy"> gets a calendar button.
   * The field stays editable, because somebody's start date really is
   * "4 weeks after offer" and a picker must never take that answer away.
   */
  function attachAll(scope, doc) {
    const host = scope || (typeof document !== 'undefined' && document);
    const d = doc || host;
    if (!host || !host.querySelectorAll) return [];
    const made = [];
    host.querySelectorAll('input[data-cal]').forEach((input) => {
      if (input.dataset.calBound === '1') return;
      input.dataset.calBound = '1';
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = 'calbtn';
      btn.title = 'pick a date instead of typing it';
      btn.setAttribute('aria-label', 'choose a date');
      btn.textContent = '\u{1F4C5}';
      if (input.parentNode) input.parentNode.insertBefore(btn, input.nextSibling);
      const picker = buildPicker({
        mode: input.dataset.cal || 'ym',
        value: input.value,
        onPick(value) {
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        },
      });
      btn.onclick = () => { picker.setValue(input.value); picker.open(btn); };
      made.push(btn);
    });
    return made;
  }

  const API = { MONTHS, DOW, pad, daysInMonth, monthMatrix, pickToValue, parseLoose, valid, buildPicker, attachAll };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.FILLDESK_CAL = API;
})();
