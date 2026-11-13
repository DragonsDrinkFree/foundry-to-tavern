#!/usr/bin/env node
// Convert Foundry exports by a rules file, outside the app: to try rules out, or to write an
// archive file (the format a package ships, and the Archives window imports).
//
//   node tools/convert.mjs --rules <rules.json> <export.json…> [--lang <en.json>…]
//        [--schema <tavern.json>…] [--out <archive.json>] [--name <archive name>] [--wrap] [--json]
//
// Prints what came in, by type, and every note and problem. Exit 0: converted; 1: problems that
// left documents out; 2: usage or a broken rules file.

import fs from 'node:fs';
import path from 'node:path';
import { archiveFile, compileRules, convert, RulesError } from '../lib/convert.mjs';
import { schemaFromManifest } from '../lib/schema.mjs';
import { mergeLang } from '../lib/text.mjs';

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
  console.error('usage: node tools/convert.mjs --rules <rules.json> <export.json…> [--lang f] [--schema tavern.json] [--out archive.json] [--name n] [--wrap] [--json]');
  process.exit(2);
}

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
let rules;
try { rules = compileRules(read(opts.rules)); }
catch (err) {
  console.error(err instanceof RulesError ? `${opts.rules}: ${err.message}` : err);
  process.exit(2);
}
const lang = opts.lang.length ? mergeLang(...opts.lang.map(read)) : undefined;
const schema = opts.schema.length ? Object.assign({}, ...opts.schema.map((f) => schemaFromManifest(read(f)))) : undefined;
const files = opts.files.map((f) => ({ name: path.basename(f), json: read(f) }));

let out;
try { out = convert(rules, files, { lang, schema, wrap: opts.wrap }); }
catch (err) {
  console.error(err instanceof RulesError ? `${opts.rules}: ${err.message}` : err);
  process.exit(2);
}

if (opts.out) {
  const name = opts.name ?? (out.packs.length === 1 ? out.packs[0].label : rules.name);
  fs.writeFileSync(opts.out, `${JSON.stringify(archiveFile(name, out.entries), null, 1)}\n`);
}
if (opts.json) {
  process.stdout.write(`${JSON.stringify({ packs: out.packs, stats: out.stats, notes: out.notes, problems: out.problems, entries: opts.out ? undefined : out.entries }, null, 2)}\n`);
} else {
  for (const p of out.packs) {
    console.log(`${p.file} (${p.label}, ${p.system ?? 'unknown system'}): ${p.documents} documents, ${p.folders} folders, ${p.skipped} left out`);
    for (const [t, n] of Object.entries(p.byType)) console.log(`  ${String(n).padStart(4)} ${t}`);
  }
  for (const n of out.notes) {
    console.log(`${n.level === 'warning' ? 'warning' : 'note'}: ${n.message} ×${n.count}`);
    for (const e of n.examples.slice(0, 3)) console.log(`    e.g. ${e}`);
  }
  for (const p of out.problems) console.log(`${p.level}: ${p.doc ? `${p.doc}: ` : ''}${p.message}`);
  if (opts.out) console.log(`wrote ${opts.out}: ${out.entries.length} entries`);
}
process.exit(out.problems.some((p) => p.level === 'error') ? 1 : 0);
