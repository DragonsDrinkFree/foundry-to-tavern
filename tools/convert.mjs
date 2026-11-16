#!/usr/bin/env node
// Convert Foundry exports by a rules file, outside the app: to try rules out, or to write an
// archive file (the format a package ships, and the Archives window imports).
//
//   node tools/convert.mjs --rules <rules.json> <export.json…|bundle.zip> [--lang <en.json>…]
//        [--schema <tavern.json>…] [--out <archive.json>] [--name <archive name>] [--wrap] [--json]
//
// A bundle (from the Export for Tavern Moot Foundry module) brings its packs and translations; its
// pictures and PDFs are planned (the paths documents get, and the uploads listed) but not uploaded.
//
// Prints what came in, by type, and every note and problem. Exit 0: converted; 1: problems that
// left documents out; 2: usage or a broken rules file.

import fs from 'node:fs';
import path from 'node:path';
import { uploadPlan } from '../foundry-to-tavern-module/lib/assets.mjs';
import { openBundle } from '../foundry-to-tavern-module/lib/bundle.mjs';
import { archiveFile, compileRules, convert, RulesError } from '../foundry-to-tavern-module/lib/convert.mjs';
import { schemaFromManifest } from '../foundry-to-tavern-module/lib/schema.mjs';
import { mergeLang } from '../foundry-to-tavern-module/lib/text.mjs';

const argv = process.argv.slice(2);
const opts = { rules: null, lang: [], schema: [], out: null, name: null, wrap: undefined, json: false, files: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--rules') opts.rules = argv[++i];
  else if (a === '--lang') opts.lang.push(argv[++i]);
  else if (a === '--schema') opts.schema.push(argv[++i]);
  else if (a === '--out') opts.out = argv[++i];
  else if (a === '--name') opts.name = argv[++i];
  else if (a === '--wrap') opts.wrap = true;
  else if (a === '--no-wrap') opts.wrap = false;
  else if (a === '--json') opts.json = true;
  else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2); }
  else opts.files.push(a);
}
if (!opts.rules || !opts.files.length) {
  console.error('usage: node tools/convert.mjs --rules <rules.json> <export.json…|bundle.zip> [--lang f] [--schema tavern.json] [--out archive.json] [--name n] [--wrap] [--json]');
  process.exit(2);
}

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
let rules;
try { rules = compileRules(read(opts.rules)); }
catch (err) {
  console.error(err instanceof RulesError ? `${opts.rules}: ${err.message}` : err);
  process.exit(2);
}
const files = [];
const langs = [];
let bundle = null;
for (const f of opts.files) {
  if (!/\.zip$/i.test(f)) { files.push({ name: path.basename(f), json: read(f) }); continue; }
  if (bundle) { console.error('one bundle at a time'); process.exit(2); }
  try { bundle = await openBundle(Object.assign(new Blob([fs.readFileSync(f)]), { name: path.basename(f) })); }
  catch (err) { console.error(`${f}: ${err.message}`); process.exit(2); }
  for (const p of bundle.packs) files.push({ name: p.name, json: p.json });
  for (const l of bundle.lang) langs.push(l.json);
}
langs.push(...opts.lang.map(read));
const lang = langs.length ? mergeLang(...langs) : undefined;
const schema = opts.schema.length ? Object.assign({}, ...opts.schema.map((f) => schemaFromManifest(read(f)))) : undefined;
const assets = bundle ? { files: bundle.files, left: Object.fromEntries(bundle.left.map((l) => [l.path, l.reason])) } : undefined;
const plan = () => (bundle ? uploadPlan(out.assets, bundle) : []);

let out;
try { out = convert(rules, files, { lang, schema, assets, wrap: opts.wrap }); }
catch (err) {
  console.error(err instanceof RulesError ? `${opts.rules}: ${err.message}` : err);
  process.exit(2);
}

if (opts.out) {
  const name = opts.name ?? (out.packs.length === 1 ? out.packs[0].label : rules.name);
  fs.writeFileSync(opts.out, `${JSON.stringify(archiveFile(name, out.entries), null, 1)}\n`);
}
if (opts.json) {
  const uploads = bundle ? plan().map(({ from, path: to, size }) => ({ from, to, size })) : undefined;
  process.stdout.write(`${JSON.stringify({ packs: out.packs, stats: out.stats, notes: out.notes, problems: out.problems, uploads, entries: opts.out ? undefined : out.entries }, null, 2)}\n`);
} else {
  if (rules.setup.length) {
    console.log('Before you import:');
    rules.setup.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  }
  for (const p of out.packs) {
    console.log(`${p.file} (${p.label}, ${p.system ?? 'unknown system'}): ${p.documents} documents, ${p.folders} folders, ${p.skipped} left out`);
    for (const [t, n] of Object.entries(p.byType)) console.log(`  ${String(n).padStart(4)} ${t}`);
  }
  for (const n of out.notes) {
    console.log(`${n.level === 'warning' ? 'warning' : 'note'}: ${n.message} ×${n.count}`);
    for (const e of n.examples.slice(0, 3)) console.log(`    e.g. ${e}`);
  }
  for (const p of out.problems) console.log(`${p.level}: ${p.doc ? `${p.doc}: ` : ''}${p.message}`);
  if (bundle) {
    const up = plan();
    console.log(`pictures and PDFs: ${up.length} to upload (${up.filter((p) => p.kind === 'pdf').length} PDFs, ${(up.reduce((n, p) => n + p.size, 0) / 1048576).toFixed(1)} MB)${up[0] ? `, e.g. ${up[0].from} → ${up[0].path}` : ''}`);
  }
  if (opts.out) console.log(`wrote ${opts.out}: ${out.entries.length} entries`);
}
process.exit(out.problems.some((p) => p.level === 'error') ? 1 : 0);
