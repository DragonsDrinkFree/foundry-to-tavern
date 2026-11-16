#!/usr/bin/env node
// Drives the real widget page (foundry-to-tavern-module/ui/import.html) in headless Chrome against a stand-in `tavern`:
// drops a rules file, exports and a schema on the Compendium Importer tab as a GM would, presses
// Create, and checks what reached `tavern.archives.create`. Then it drops a bundle built by
// tavern-export on the Foundry Export tab, and checks the uploads and where the documents point.
//
//   node test/widget.harness.mjs [--shot out.png]      (CHROME=<path> to pick the browser)
//
// Exit 0: passed; 1: failed; 0 with a "skipped" line when no Chrome is found.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from '../tavern-export/scripts/bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotAt = process.argv.indexOf('--shot');
const shot = shotAt > 0 ? path.resolve(process.argv[shotAt + 1]) : null;
const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chrome = CANDIDATES.find((p) => fs.existsSync(p));
if (!chrome) { console.log('skipped: no Chrome found (set CHROME)'); process.exit(0); }

const FILES = [
  'rules/ose-to-osr.json',
  'reference/Foundry/fvtt-Item-pack-ose-ose-items.json',
  'reference/Foundry/fvtt-Actor-pack-ose-ose-creatures.json',
  'test/fixtures/osr-tavern.json',
];

// A bundle as the Foundry module makes it, from the same exports and the journals (whose PDF
// pages become PDF notes), with made-up pictures and PDFs.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const bundleExports = [...FILES.slice(1, 3), 'reference/Foundry/fvtt-JournalEntry-pack-ose-ose-journal.json'].map((f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')));
const { blob: bundleBlob } = await buildBundle({
  packs: bundleExports.map((x) => ({ collection: x.package, metadata: x.metadata, documentName: x.type, documents: x.items, folders: x.folders })),
  source: bundleExports[0].source,
  exporter: { id: 'tavern-export', version: 'harness' },
  fetchFile: async (p) => (p.endsWith('.pdf') ? new Blob(['%PDF-1.7 made up'], { type: 'application/pdf' }) : new Blob([PNG], { type: 'image/png' })),
});
const BUNDLE = Buffer.from(await bundleBlob.arrayBuffer());

// The stand-in API, and the test script: runs once the page has loaded.
const MOCK = `
<script>
  window.__calls = [];
  window.__errors = [];
  addEventListener('error', (e) => __errors.push(String(e.message) + ' @' + e.filename + ':' + e.lineno));
  addEventListener('unhandledrejection', (e) => __errors.push('rejection: ' + String(e.reason && e.reason.stack || e.reason)));
  const store = {};
  const ok = (v) => Promise.resolve(v);
  window.tavern = {
    system: { get: () => ok({ id: 'osr', name: 'OSR', version: '0.2.0' }) },
    viewer: { get: () => ok({ id: 'u1', name: 'GM', role: 'gm', roles: [], groups: [], online: true }) },
    store: {
      get: (p) => ok(p ? p.split('.').reduce((o, k) => o?.[k], store) : store),
      set: (p, v) => { const ks = p.split('.'); let o = store; for (const k of ks.slice(0, -1)) o = o[k] ??= {}; o[ks.at(-1)] = v; __calls.push(['store.set', p]); return ok(true); },
      delete: (p) => { const ks = p.split('.'); let o = store; for (const k of ks.slice(0, -1)) o = o?.[k]; if (o) delete o[ks.at(-1)]; return ok(true); },
    },
    archives: {
      list: () => ok([{ id: 'arc-1', name: 'Old import', source: 'campaign', count: 3 }, { id: 'pkg.x.y', name: 'Pkg', source: 'package:x', count: 9 }]),
      create: (input) => { __calls.push(['archives.create', { name: input.name, access: input.access, entries: input.entries }]); return ok('arc-new'); },
      add: (a, e) => { __calls.push(['archives.add', a, e.length]); return ok(e.map((x) => x.id)); },
    },
    features: { has: (id) => ok(id === 'core.asset-upload' || id === 'core.import-refs' || id === 'core.pdf') },
    assets: {
      // The first picture of each call is stored renamed, the second fails, the rest are stored (every other one "already there").
      uploadMany: (files, opts) => {
        __calls.push(['assets.uploadMany', files.length, opts && opts.ifExists, files.every((f) => f.file instanceof Blob && f.file.size > 0), files.map((f) => f.path)]);
        return ok(files.map((f, i) => i === 0 ? { path: f.path, stored: f.path.replace(/(\\.\\w+)$/, ' (2)$1') } : i === 1 ? { path: f.path, error: 'boom' } : { path: f.path, stored: f.path, ...(i % 2 ? {} : { kept: true }) }));
      },
    },
    ui: { notify: (t, l) => { __calls.push(['notify', l, t]); return ok(true); }, confirm: (t) => { __calls.push(['confirm', t]); return ok(true); } },
  };
  addEventListener('load', async () => {
    const out = document.createElement('pre');
    out.id = '__result';
    const finish = (r) => { out.textContent = JSON.stringify(r); document.body.append(out); };
    try {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const until = async (fn, what, tries = 200) => { for (let i = 0; i < tries; i++) { if (fn()) return; await wait(25); } throw new Error('timed out waiting for ' + what); };
      const files = [];
      for (const f of ${JSON.stringify(FILES)}) files.push(new File([await (await fetch('/' + f)).text()], f.split('/').pop(), { type: 'application/json' }));
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      await until(() => !document.getElementById('preview-card').hidden, 'the preview');
      const preview = {
        rules: document.getElementById('rules-info').textContent,
        rulesError: document.getElementById('rules-error').hidden ? null : document.getElementById('rules-error').textContent,
        files: [...document.querySelectorAll('#files li, #extras li')].map((li) => li.textContent),
        summary: document.getElementById('summary').textContent,
        tree: document.getElementById('tree').textContent,
        notes: [...document.querySelectorAll('#notes .note')].map((n) => n.textContent),
        archiveName: document.getElementById('archive-name').value,
        wrap: document.getElementById('wrap').checked,
        addDisabled: document.querySelector('input[name=dest][value=add]').disabled,
        archives: [...document.querySelectorAll('#archive-pick option')].map((o) => o.textContent),
      };
      document.getElementById('save-rules').click();
      await until(() => __calls.some((c) => c[0] === 'store.set'), 'saving the rules');
      await until(() => document.querySelectorAll('#saved option').length > 1, 'the saved list');
      document.getElementById('create').click();
      await until(() => __calls.some((c) => c[0] === 'archives.create'), 'archives.create');
      await until(() => document.getElementById('status').textContent.startsWith('Made'), 'the status');
      const ci = { preview, saved: [...document.querySelectorAll('#saved option')].map((o) => o.textContent), status: document.getElementById('status').textContent };

      // The Foundry Export tab: the bundle, the same rules (still loaded), pictures.
      document.getElementById('tab-fe').click();
      const zip = new File([await (await fetch('/__bundle.zip')).blob()], 'tavern-dev-ose.zip', { type: 'application/zip' });
      const dt2 = new DataTransfer();
      dt2.items.add(zip);
      document.getElementById('drop-fe').dispatchEvent(new DragEvent('drop', { dataTransfer: dt2, bubbles: true, cancelable: true }));
      await until(() => !document.getElementById('pictures-card').hidden, 'the pictures card');
      const fe = {
        bundle: document.getElementById('bundle').textContent,
        summary: document.getElementById('summary').textContent,
        pictures: document.getElementById('pictures-info').textContent,
        createLabel: document.getElementById('create').textContent,
        ciHidden: document.getElementById('panel-ci').hidden,
      };
      const before = __calls.filter((c) => c[0] === 'archives.create').length;
      document.getElementById('create').click();
      await until(() => __calls.filter((c) => c[0] === 'archives.create').length > before, 'the second archives.create', 4000);
      await until(() => /Files:/.test(document.getElementById('status').textContent), 'the upload status');
      fe.status = document.getElementById('status').textContent;

      // Rules with setup steps show them under the rules, formatted but never as HTML.
      const dw = new File([await (await fetch('/rules/dolmenwood-to-osr.json')).text()], 'dolmenwood-to-osr.json', { type: 'application/json' });
      const dt3 = new DataTransfer();
      dt3.items.add(dw);
      document.getElementById('drop-fe').dispatchEvent(new DragEvent('drop', { dataTransfer: dt3, bubbles: true, cancelable: true }));
      await until(() => document.querySelector('#rules-info .setup'), 'the setup steps');
      const setup = {
        steps: document.querySelectorAll('#rules-info .setup li').length,
        code: [...document.querySelectorAll('#rules-info .setup code')].map((c) => c.textContent),
        strong: document.querySelectorAll('#rules-info .setup strong').length,
      };
      finish({ ci, fe, setup, calls: __calls });
    } catch (err) {
      finish({ error: String(err && err.stack || err), errors: __errors, calls: __calls, status: document.getElementById('status').textContent + ' | pictures: ' + document.getElementById('pictures-info').textContent + ' | create disabled: ' + document.getElementById('create').disabled,
        page: { rulesError: document.getElementById('rules-error').textContent, files: document.getElementById('files').textContent, info: document.getElementById('rules-info').textContent } });
    }
  });
</script>`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(root, url);
  if (url === '/__bundle.zip') { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(BUNDLE); return; }
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
  if (url === '/foundry-to-tavern-module/ui/import.html') body = Buffer.from(body.toString('utf8').replace('<head>', `<head>${MOCK}`));
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(body);
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/foundry-to-tavern-module/ui/import.html`;
  const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'f2t-chrome-'));
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--virtual-time-budget=200000', '--window-size=1000,1800'];
  const done = (code, msg) => { console.log(msg); server.close(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* still in use */ } process.exit(code); };
  execFile(chrome, [...args, '--dump-dom', url], { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (err, stdout) => {
    if (err && !stdout) return done(1, `FAIL: Chrome: ${err.message}`);
    const m = /<pre id="__result">([\s\S]*?)<\/pre>/.exec(stdout);
    if (!m) return done(1, 'FAIL: the page never reported (did the script throw before load?)');
    const r = JSON.parse(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    const fail = [];
    const check = (cond, what) => { if (!cond) fail.push(what); };
    if (r.error) fail.push(`page error: ${r.error}
  errors: ${JSON.stringify(r.errors)}
  page: ${JSON.stringify(r.page)}
  calls: ${JSON.stringify(r.calls.map((c) => [c[0], ...(typeof c[1] === 'object' ? [] : c.slice(1, 3))]))}
  status: ${r.status}`);
    else {
      const created = r.calls.find((c) => c[0] === 'archives.create')?.[1];
      const preview = r.ci.preview;
      r.saved = r.ci.saved;
      r.status = r.ci.status;
      check(!preview.rulesError, `rules error: ${preview.rulesError}`);
      check(/Old-School Essentials/.test(preview.rules), 'the rules are named');
      check(preview.files.length === 3, `3 files listed (got ${preview.files.length})`);
      check(preview.wrap === true, 'two packs are wrapped in folders of their own');
      check(preview.addDisabled === false, 'the campaign archive can be added to');
      check(preview.archives.length === 1, 'package archives are not offered');
      check(/160 documents/.test(preview.summary), `160 documents previewed (${preview.summary.slice(0, 80)})`);
      check(/The Hole in the Oak/.test(preview.tree), 'the folder tree shows the export\u2019s folders');
      check(!preview.notes.some((n) => /not a field|isn't one of/.test(n)), `no schema problems (${preview.notes.join(' | ')})`);
      check(r.saved.some((s) => /Old-School/.test(s)), 'the rules were saved to the campaign');
      check(created && created.entries.length > 160, 'archives.create got the entries');
      check(created && created.entries.filter((e) => e.type === 'core.folder').length >= 10, 'with their folders');
      check(created && created.name === 'Old-School Essentials → OSR', `named for the rules (${created?.name})`);
      check(/^Made/.test(r.status), 'the status says it was made');
      const firstCreate = r.calls.findIndex((c) => c[0] === 'archives.create');
      check(!r.calls.slice(0, firstCreate).some((c) => c[0] === 'assets.uploadMany'), 'the Compendium Importer tab uploads nothing');

      // The Foundry Export tab.
      const fe = r.fe;
      const uploads = r.calls.filter((c) => c[0] === 'assets.uploadMany');
      const second = r.calls.filter((c) => c[0] === 'archives.create')[1]?.[1];
      const uploaded = uploads.flatMap((c) => c[4]);
      check(fe.ciHidden, 'the tab switched');
      check(/tavern-dev-ose\.zip/.test(fe.bundle) && /ose-creatures/.test(fe.bundle), `the bundle is listed (${fe.bundle.slice(0, 120)})`);
      check(/390 documents/.test(fe.summary), `390 documents from the bundle's three packs (${fe.summary.slice(0, 80)})`);
      check(/\d+ pictures and 3 PDFs to upload/.test(fe.pictures), `the pictures and PDFs are counted (${fe.pictures})`);
      check(/Upload files/.test(fe.createLabel), 'the button says it uploads');
      check(uploads.length >= 2 && uploads.every((c) => c[1] <= 50), `uploaded in batches of 50 at most (${uploads.map((c) => c[1]).join(', ')})`);
      check(uploads.every((c) => c[2] === 'skip' && c[3] === true), 'as Blobs, keeping pictures already there');
      check(uploaded.length > 50 && uploaded.every((p) => p.startsWith('foundry/ose/')), 'into the rules\u2019 folder');
      check(new Set(uploaded).size === uploaded.length, 'each picture once');
      if (second && uploads.length) {
        const pics = second.entries.flatMap((e) => [e.data?.portrait, e.data?.img, e.data?.file]).filter((p) => typeof p === 'string');
        const renamed = uploads.map((c) => c[4][0].replace(/(\.\w+)$/, ' (2)$1'));
        check(renamed.every((p) => pics.includes(p)), 'documents point at the renamed copies');
        check(!pics.includes(uploads[0][4][1]), 'and not at a picture that failed');
        check(pics.filter(Boolean).every((p) => p.startsWith('foundry/ose/')), 'every picture is a campaign path');
        check(pics.filter(Boolean).length > 50, `most documents have their picture (${pics.filter(Boolean).length})`);
        const pdfNotes = second.entries.filter((e) => e.type === 'core.pdf');
        check(pdfNotes.length === 3, `the journals' PDFs are PDF notes (${pdfNotes.length})`);
        const pdfFiles = pdfNotes.map((e) => e.data.file).filter(Boolean);
        check(pdfFiles.length >= 2 && pdfFiles.every((f) => /^foundry\/ose\/modules\/.+\.pdf$/.test(f)), `pointing at their uploaded PDFs (${pdfFiles.join(', ')})`);
        check(uploaded.filter((p) => p.endsWith('.pdf')).length === 3, 'each PDF uploaded once');
      } else fail.push('no second archives.create, or no uploads');
      check(/^Made/.test(fe.status) && /failed/.test(fe.status), `the status reports the uploads (${fe.status})`);
      check(r.setup.steps === 4, `the Dolmenwood rules' four setup steps (${r.setup.steps})`);
      check(r.setup.code.includes('fairy-glamour') && r.setup.strong > 0, 'with their code and bold as elements');
    }
    if (shot) {
      execFile(chrome, [...args, `--screenshot=${shot}`, url], { timeout: 120_000 }, () => done(fail.length ? 1 : 0, fail.length ? `FAIL:\n  ${fail.join('\n  ')}` : `ok: widget (screenshot ${shot})`));
    } else done(fail.length ? 1 : 0, fail.length ? `FAIL:\n  ${fail.join('\n  ')}` : 'ok: widget');
  });
});
