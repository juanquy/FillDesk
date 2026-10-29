// Point this at any Playwright install; nothing here may hardcode a machine path,
// because this file is published and a home directory is personal data.
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
import { mkdtempSync } from 'node:fs';
process.env.SHOW = process.env.SHOW || '';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const PORT = Number(process.argv[2] || 8799);
const TOKEN = process.argv[3];
const ext = path.resolve('extension');
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'fdext-')), {
  headless: !process.env.SHOW,
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  // Chrome only honours --load-extension under the new headless mode; the old headless
  // starts with extensions switched off and says nothing about it.
  args: [...(process.env.SHOW ? [] : ['--headless=new']),
         `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const sw = await ctx.waitForEvent('serviceworker', { timeout: 8000 }).catch(() => null);
console.log('service worker:', sw ? sw.url() : 'not visible to playwright (normal in headless)');

const errors = [];
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e.message).split('\n')[0]));
page.on('console', (m) => { const t = m.text(); if (t.includes('FillDesk')) console.log('  page console:', t.slice(0, 120)); });
// Configure the extension through its own popup page (chrome-extension origin).
const probe = await ctx.newPage();
await probe.goto(`http://127.0.0.1:${PORT}/preview.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await probe.waitForTimeout(1500);
const extId = await probe.evaluate(() => new Promise((done) => {
  const t = setInterval(() => {
    const el = document.querySelector('[data-filldesk-build]');
    if (el) { clearInterval(t); done((el.getAttribute('data-filldesk-build') || '').split('@')[0]); }
  }, 200);
  setTimeout(() => { clearInterval(t); done(''); }, 4000);
}));
await probe.close();

const popup = await ctx.newPage();
if (extId) {
  await popup.goto(`chrome-extension://${extId}/popup.html`).catch(() => {});
  await popup.evaluate(async (cfg) => chrome.storage.local.set(cfg), { server: `http://127.0.0.1:${PORT}`, token: TOKEN });
  console.log('configured extension via popup page, id', extId);
} else {
  console.log('NOT TESTED: Chrome did not attach the unpacked extension, so nothing here ran.');
  console.log('This harness is evidence only when it prints an extension id. Run it with SHOW=1');
  console.log('and a Chrome that accepts --load-extension; otherwise delete the entry and move on.');
  await ctx.close();
  process.exit(2);
}
await popup.close();

await page.goto(`http://127.0.0.1:${PORT}/preview.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fd-fill', { timeout: 15000 });
console.log('extension id:', await page.evaluate(() => document.querySelector('[data-filldesk-build]')?.dataset.filldeskBuild));
console.log('panel header:', (await page.textContent('.hd')).replace(/\s+/g, ' ').trim());

await page.click('#fd-scan');
await page.waitForTimeout(1200);
await page.click('#fd-fill');
await page.waitForTimeout(9000);

const filled = await page.evaluate(() => ({
  filled: document.querySelectorAll('#q_name,#q_email,#q_phone,#q_linkedin,#q_city,#q_how_work_0,#q_how_work_1,#exp_0_0_company,#q_salary').length,
  withValue: ['#q_name','#q_email','#q_phone','#q_linkedin','#q_city','#exp_0_0_company'].filter(s => (document.querySelector(s).value||'').trim()).length,
  marked: document.querySelectorAll('[data-filldesk]').length,
  summary: (document.querySelector('#fd-sum')?.textContent || '').replace(/\s+/g,' ').trim().slice(0, 140),
}));
console.log('values written:', filled.withValue, 'of 6 · fields marked:', filled.marked);
console.log('summary:', filled.summary);
console.log('page errors during a real Fill run:', errors.length ? errors : 'NONE');
await ctx.close();
console.log(errors.length ? 'RESULT: reproduced' : 'RESULT: clean run in real Chrome');
