#!/usr/bin/env node
// Drives the real widget page (ui/import.html) in headless Chrome against a stand-in `tavern`:
// drops a rules file, exports, a schema and lang files on it as a GM would, presses Create, and
// checks what reached `tavern.archives.create`.
//
//   node test/widget.harness.mjs [--shot out.png]      (CHROME=<path> to pick the browser)
//
// Exit 0: passed; 1: failed; 0 with a "skipped" line when no Chrome is found.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    ui: { notify: (t, l) => { __calls.push(['notify', l, t]); return ok(true); }, confirm: (t) => { __calls.push(['confirm', t]); return ok(true); } },
  };
  addEventListener('load', async () => {
    const out = document.createElement('pre');
    out.id = '__result';
    const finish = (r) => { out.textContent = JSON.stringify(r); document.body.append(out); };
    try {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const until = async (fn, what) => { for (let i = 0; i < 200; i++) { if (fn()) return; await wait(25); } throw new Error('timed out waiting for ' + what); };
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
      finish({ preview, saved: [...document.querySelectorAll('#saved option')].map((o) => o.textContent), status: document.getElementById('status').textContent, calls: __calls });
    } catch (err) {
      finish({ error: String(err && err.stack || err), errors: __errors, calls: __calls,
        page: { rulesError: document.getElementById('rules-error').textContent, files: document.getElementById('files').textContent, info: document.getElementById('rules-info').textContent } });
    }
  });
</script>`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(root, url);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
  if (url === '/ui/import.html') body = Buffer.from(body.toString('utf8').replace('<head>', `<head>${MOCK}`));
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(body);
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/ui/import.html`;
  const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'f2t-chrome-'));
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--virtual-time-budget=20000', '--window-size=1000,1800'];
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
  calls: ${JSON.stringify(r.calls).slice(0, 600)}`);
    else {
      const created = r.calls.find((c) => c[0] === 'archives.create')?.[1];
      check(!r.preview.rulesError, `rules error: ${r.preview.rulesError}`);
      check(/Old-School Essentials/.test(r.preview.rules), 'the rules are named');
      check(r.preview.files.length === 3, `3 files listed (got ${r.preview.files.length})`);
      check(r.preview.wrap === true, 'two packs are wrapped in folders of their own');
      check(r.preview.addDisabled === false, 'the campaign archive can be added to');
      check(r.preview.archives.length === 1, 'package archives are not offered');
      check(/160 documents/.test(r.preview.summary), `160 documents previewed (${r.preview.summary.slice(0, 80)})`);
      check(/The Hole in the Oak/.test(r.preview.tree), 'the folder tree shows the export\u2019s folders');
      check(!r.preview.notes.some((n) => /not a field|isn't one of/.test(n)), `no schema problems (${r.preview.notes.join(' | ')})`);
      check(r.saved.some((s) => /Old-School/.test(s)), 'the rules were saved to the campaign');
      check(created && created.entries.length > 160, 'archives.create got the entries');
      check(created && created.entries.filter((e) => e.type === 'core.folder').length >= 10, 'with their folders');
      check(created && created.name === 'Old-School Essentials → OSR', `named for the rules (${created?.name})`);
      check(/^Made/.test(r.status), 'the status says it was made');
    }
    if (shot) {
      execFile(chrome, [...args, `--screenshot=${shot}`, url], { timeout: 120_000 }, () => done(fail.length ? 1 : 0, fail.length ? `FAIL:\n  ${fail.join('\n  ')}` : `ok: widget (screenshot ${shot})`));
    } else done(fail.length ? 1 : 0, fail.length ? `FAIL:\n  ${fail.join('\n  ')}` : 'ok: widget');
  });
});
