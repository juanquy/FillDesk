#!/usr/bin/env node
/*
 * No-browser dry run: run the real matcher over web/preview.html using the real
 * approved packet from your local server, and print what the extension would do.
 *
 *   node tools/simulate.mjs              # against http://127.0.0.1:8756
 *   node tools/simulate.mjs http://127.0.0.1:8756 <packet_id>
 *
 * Useful for checking a rules change without opening Chrome, and for seeing
 * exactly which fields the tool refuses before you trust it on a real form.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(readFileSync(path.join(ROOT, 'extension/matcher.js'), 'utf8'));
const M = globalThis.FILLDESK_MATCHER;

const ARGS = process.argv.slice(2).filter((a) => a !== '--json');
export const JSON_OUT = process.argv.includes('--json');
const BASE = ARGS[0] || process.env.FILLDESK_URL || 'http://127.0.0.1:8756';
const PACKET = ARGS[1] || '';

function token() {
  try { return readFileSync(path.join(ROOT, 'data/api_token'), 'utf8').trim(); } catch { return ''; }
}

async function get(p) {
  const res = await fetch(BASE + p, { headers: token() ? { 'x-filldesk-token': token() } : {} });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p} -> ${res.status} ${body.error || ''}`);
  return body;
}

// A deliberately small parser for one known fixture file: walk h2 / label /
// control in document order so section and group context match what content.js
// derives from a real DOM.
function fieldsFromPreview(html) {
  const out = [];
  let section = '';
  let label = '';
  let lastLongLabel = '';
  const rx = /<(h2|h3)\b[^>]*>([\s\S]*?)<\/\1>|<label\b[^>]*>([\s\S]*?)<\/label>|<(input|textarea|select)\b([^>]*)>/gi;
  const cleanText = (t) => String(t || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  let m;
  while ((m = rx.exec(html))) {
    if (m[1]) { section = cleanText(m[2]); continue; }
    if (m[3] !== undefined) {
      const t = cleanText(m[3]);
      label = t;
      if (t.length >= 18) lastLongLabel = t;
      // Continue scanning INSIDE the label: plenty of forms wrap the control in it,
      // and skipping the body would hide every yes/no radio from this report.
      rx.lastIndex = m.index + m[0].indexOf('>') + 1;
      continue;
    }
    const tag = m[4].toLowerCase();
    const attrs = {};
    for (const a of m[5].matchAll(/(\w[\w-]*)\s*=\s*"([^"]*)"/g)) attrs[a[1].toLowerCase()] = a[2];
    if (tag === 'select') {
      const close = html.indexOf('</select>', rx.lastIndex);
      const body = html.slice(rx.lastIndex, close < 0 ? rx.lastIndex : close);
      const options = [...body.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((o) => ({ label: o[1].trim(), value: o[1].trim() }));
      out.push({ tag: 'select', type: 'select', label, name: attrs.name || '', visible: true, options, placeholder: '', id: attrs.id || '', section, currentValue: '' });
      rx.lastIndex = close < 0 ? rx.lastIndex : close + 9;
      continue;
    }
    const type = tag === 'textarea' ? 'textarea' : (attrs.type || 'text');
    const shortLabel = label.length < 20 && (type === 'radio' || type === 'checkbox');
    out.push({
      tag, type,
      label: label || attrs.name || '',
      name: attrs.name || '', id: attrs.id || '',
      placeholder: attrs.placeholder || '',
      autocomplete: (attrs.autocomplete || '').toLowerCase(),
      visible: true, options: [], currentValue: '',
      dateHint: M.dateHintFor({ placeholder: attrs.placeholder || '', name: attrs.name || '', id: attrs.id || '' }),
      radioLabels: [], index: 0, section,
      groupLabel: shortLabel ? lastLongLabel : '',
    });
  }
  return out;
}

function shape(desc) {
  return {
    tag: desc.tag, type: desc.type, label: desc.label, name: desc.name, id: desc.id,
    placeholder: desc.placeholder || '', aria: '', title: '', testid: '', help: '',
    autocomplete: desc.autocomplete || '', legend: '', section: desc.section || '',
    groupLabel: desc.groupLabel || '',
    options: desc.options || [], radioLabels: desc.radioLabels || [],
    visible: desc.visible !== false, required: false, currentValue: desc.currentValue || '',
    dateHint: desc.dateHint || '', index: desc.index || 0, prefixText: '',
  };
}

async function main() {
  const html = readFileSync(path.join(ROOT, 'web/preview.html'), 'utf8');
  const snapshot = await get('/api/autofill/snapshot' + (PACKET ? `?packet_id=${PACKET}` : ''));
  const settings = { refuse_blocked_fields: true, overwrite_filled: false, upload_documents: true };

  console.log(`\npacket ${snapshot.packet_id} · ${snapshot.job.company} — ${snapshot.job.title}`);
  console.log(`${snapshot.approved ? 'approved' : 'NOT approved'} · ${snapshot.answers.length} answers · ${snapshot.experience.length} roles\n`);

  const counters = {};
  const rows = [];
  for (const raw of fieldsFromPreview(html)) {
    let desc = shape(raw);
    const probe = M.classify(desc, snapshot, settings);
    if (probe.key && /^(exp|edu)\./.test(probe.key)) {
      const bucket = probe.key.split('.')[1];
      desc.index = counters[bucket] || 0;
      counters[bucket] = desc.index + 1;
    }
    rows.push({ desc, decision: M.classify(desc, snapshot, settings) });
  }

  if (JSON_OUT) {
    const t = { fill: 0, upload: 0, block: 0, skip: 0 };
    for (const r of rows) t[r.decision.action] = (t[r.decision.action] || 0) + 1;
    console.log(JSON.stringify({
      packet_id: snapshot.packet_id,
      job: snapshot.job,
      approved: snapshot.approved,
      answers: snapshot.answers.length,
      roles: snapshot.experience.length,
      tally: t,
      rows: rows.map(({ desc, decision }) => ({
        label: desc.label || desc.name || desc.name, name: desc.name, type: desc.type, section: desc.section,
        action: decision.action, key: decision.key || '', value: decision.value || '',
        review: decision.review || '', category: decision.category || '', reason: decision.reason || '',
      })),
    }));
    return;
  }

  const symbols = { fill: '\x1b[32mFILL  \x1b[0m', upload: '\x1b[36mUPLOAD\x1b[0m', block: '\x1b[31mREFUSE\x1b[0m', skip: '\x1b[90mskip  \x1b[0m' };
  const tally = { fill: 0, upload: 0, block: 0, skip: 0 };
  for (const { desc, decision } of rows) {
    tally[decision.action] = (tally[decision.action] || 0) + 1;
    const detail = decision.action === 'fill'
      ? (decision.review ? `\x1b[33mVERIFY\x1b[0m ${clip(decision.value, 44)}` : clip(decision.value, 52))
      : decision.action === 'block' ? `${decision.category}`
      : decision.action === 'upload' ? (decision.value === 'cover_letter' ? 'cover letter' : 'resume')
      : decision.reason;
    console.log(`  ${symbols[decision.action]} ${clip(desc.label || desc.name, 46).padEnd(46)} ${detail}`);
  }
  console.log(`\n  ${tally.fill} filled · ${tally.upload} uploads · \x1b[31m${tally.block} refused (you answer these)\x1b[0m · ${tally.skip} left alone\n`);
  console.log('  Nothing here submits the form. Read the page, then submit it yourself.\n');
}

const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

main().catch((e) => { console.error('\n' + e.message); console.error('start the server first:  python3 -m server\n'); process.exit(1); });
