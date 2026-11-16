// Converting exported Foundry compendiums into Tavern Moot archive entries, by a rules file
// (docs/rules-format.md). Pure: no DOM and no `tavern` calls, so the widget, the CLI and the tests
// share it.
//
//   const rules = compileRules(json)            // throws RulesError, saying where
//   const out = convert(rules, packs, opts)     // { entries, packs, notes, problems, stats }
//
// Entries are what `tavern.archives.create({ entries })` takes (TM ADR 0112): folders and holders
// by `parentId`, parents first, ids stable across runs so importing again replaces what came before.

import { compileExpr, compileMapping, RulesError, scopeFor, childScope, truthy } from './expr.mjs';
import { canHold, CORE_TYPES, DOCUMENT_NAME_MAX, normalize } from './schema.mjs';
import { compileAssets, filePath, isPdf, kindOf, selected, targetPath } from './assets.mjs';
import { LINK_RE, REF_RE } from './text.mjs';

export { RulesError } from './expr.mjs';

export const RULES_FORMAT = 'foundry-to-tavern/rules';
export const RULES_VERSION = 1;
const MODULE_ID = 'foundry-to-tavern';
const BODY_MAX = 256 * 1024;
const MAX_DEPTH = 6;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(spec, allowed, at) {
  for (const k of Object.keys(spec)) {
    if (!allowed.includes(k)) throw new RulesError(`unknown key "${k}" (expected one of ${allowed.join(', ')})`, at);
  }
}

// ---- compiling a rules file ----

const RULE_KEYS = ['when', 'skip', 'use', 'type', 'name', 'sort', 'vars', 'data', 'embedded', 'extra', 'folder', 'note'];
const PARTIAL_KEYS = RULE_KEYS.filter((k) => k !== 'when' && k !== 'skip');

/**
 * A rule with the partials it names (`"use": "physical"` or a list) merged in, in order, before
 * its own keys: `vars` and `data` merge (the rule's win), `extra` adds up, the rest is replaced.
 */
function withPartials(spec, partials, at, seen = []) {
  if (spec.use === undefined) return spec;
  const names = Array.isArray(spec.use) ? spec.use : [spec.use];
  let merged = {};
  for (const name of names) {
    if (typeof name !== 'string' || !Object.hasOwn(partials, name)) throw new RulesError(`no partial "${name}" in "partials"`, `${at}.use`);
    if (seen.includes(name)) throw new RulesError(`partials use each other in a loop (${[...seen, name].join(' → ')})`, `${at}.use`);
    const part = partials[name];
    if (!isObject(part)) throw new RulesError('a partial is an object', `partials.${name}`);
    onlyKeys(part, PARTIAL_KEYS, `partials.${name}`);
    merged = mergeRule(merged, withPartials(part, partials, `partials.${name}`, [...seen, name]));
  }
  const { use, ...own } = spec;
  return mergeRule(merged, own);
}
function mergeRule(base, over) {
  const out = { ...base, ...over };
  for (const k of ['vars', 'data']) if (base[k] || over[k]) out[k] = { ...(base[k] ?? {}), ...(over[k] ?? {}) };
  if (base.extra || over.extra) out.extra = [...(base.extra ?? []), ...(over.extra ?? [])];
  delete out.use;
  return out;
}
const EXTRA_KEYS = [...RULE_KEYS, 'from', 'place'];

function compileRule(raw, at, partials, depth = 0, isExtra = false) {
  if (!isObject(raw)) throw new RulesError('a rule is an object', at);
  onlyKeys(raw, isExtra ? EXTRA_KEYS : RULE_KEYS, at);
  const spec = withPartials(raw, partials, at);
  if (depth > MAX_DEPTH) throw new RulesError(`extras nested more than ${MAX_DEPTH} deep`, at);
  const rule = { at, note: spec.note };
  rule.when = 'when' in spec ? compileExpr(spec.when, `${at}.when`) : null;
  if (spec.skip) {
    rule.skip = typeof spec.skip === 'string' ? spec.skip : 'skipped by the rules';
    return rule;
  }
  if (typeof spec.type !== 'string' || !/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(spec.type)) {
    throw new RulesError(`"type" must be a Tavern Moot type id such as "osr.weapon" (got ${JSON.stringify(spec.type)})`, at);
  }
  rule.type = spec.type;
  rule.name = compileExpr(spec.name ?? '$name', `${at}.name`);
  rule.sort = compileExpr(spec.sort ?? '$sort', `${at}.sort`);
  rule.folder = 'folder' in spec ? compileExpr(spec.folder, `${at}.folder`) : null;
  if ('vars' in spec && !isObject(spec.vars)) throw new RulesError('"vars" must be an object of name: expression', `${at}.vars`);
  rule.vars = Object.entries(spec.vars ?? {}).map(([k, e]) => {
    if (!/^[A-Za-z_][\w-]*$/.test(k)) throw new RulesError(`"${k}" is not a variable name`, `${at}.vars`);
    return [k, compileExpr(e, `${at}.vars.${k}`)];
  });
  rule.data = compileMapping(spec.data ?? {}, `${at}.data`);
  rule.embedded = compileEmbedded(spec.embedded, `${at}.embedded`);
  if ('extra' in spec && !Array.isArray(spec.extra)) throw new RulesError('"extra" must be a list of rules', `${at}.extra`);
  rule.extra = (spec.extra ?? []).map((x, i) => {
    const where = `${at}.extra[${i}]`;
    if (!isObject(x) || !('from' in x)) throw new RulesError('an extra needs "from": the list to make documents from', where);
    const place = x.place ?? 'held';
    if (!['held', 'beside'].includes(place)) throw new RulesError('"place" is "held" (inside this document) or "beside" (in its folder)', where);
    return { ...compileRule(x, where, partials, depth + 1, true), from: compileExpr(x.from, `${where}.from`), place, index: i };
  });
  if (isExtra && rule.skip) throw new RulesError('an extra cannot be skipped', at);
  return rule;
}

function compileEmbedded(spec, at) {
  if (spec === undefined || spec === 'hold' || spec === true) return { mode: 'hold' };
  if (spec === 'skip' || spec === false) return { mode: 'skip' };
  if (isObject(spec)) {
    onlyKeys(spec, ['only', 'except'], at);
    for (const k of ['only', 'except']) if (k in spec && !Array.isArray(spec[k])) throw new RulesError(`"${k}" must be a list of Foundry types`, at);
    return { mode: 'hold', only: spec.only ? new Set(spec.only) : null, except: new Set(spec.except ?? []) };
  }
  throw new RulesError('"embedded" is "hold", "skip", or {"only": [types]} / {"except": [types]}', at);
}

function compileTypeMap(spec, at, partials) {
  if (spec === undefined) return new Map();
  if (!isObject(spec)) throw new RulesError('expected an object of Foundry type: rule (or list of rules)', at);
  return new Map(Object.entries(spec).map(([key, r]) => {
    const list = Array.isArray(r) ? r : [r];
    if (!list.length) throw new RulesError('an empty list of rules', `${at}.${key}`);
    return [key, list.map((x, i) => compileRule(x, Array.isArray(r) ? `${at}.${key}[${i}]` : `${at}.${key}`, partials))];
  }));
}

/**
 * A rules file, checked and compiled. Throws a RulesError naming the first problem and where it is.
 * @param {object} json  the parsed rules file
 */
export function compileRules(json) {
  if (!isObject(json)) throw new RulesError('a rules file is a JSON object');
  onlyKeys(json, ['$schema', 'format', 'version', 'id', 'name', 'description', 'setup', 'authors', 'source', 'target', 'options', 'tables', 'partials', 'schema', 'types', 'embedded', 'assets'], '');
  if (json.format !== RULES_FORMAT) throw new RulesError(`"format" must be "${RULES_FORMAT}" (is this a rules file?)`, 'format');
  if (json.version !== RULES_VERSION) throw new RulesError(`version ${JSON.stringify(json.version)} isn't supported; this module reads version ${RULES_VERSION}`, 'version');
  if (typeof json.name !== 'string' || !json.name.trim()) throw new RulesError('"name" is required', 'name');
  const setup = json.setup === undefined ? [] : Array.isArray(json.setup) ? json.setup : [json.setup];
  if (!setup.every((x) => typeof x === 'string' && x.trim())) throw new RulesError('"setup" is text, or a list of steps (each text)', 'setup');
  if (json.tables !== undefined && !isObject(json.tables)) throw new RulesError('"tables" must be an object of name: {key: value}', 'tables');
  for (const [k, t] of Object.entries(json.tables ?? {})) if (!isObject(t)) throw new RulesError('a table is an object of key: value', `tables.${k}`);
  if (json.schema !== undefined && !isObject(json.schema)) throw new RulesError('"schema" must be an object of type: {category, contains, fields}', 'schema');
  const options = json.options ?? {};
  if (!isObject(options)) throw new RulesError('"options" must be an object', 'options');
  onlyKeys(options, ['folders', 'wrap', 'idPrefix', 'access'], 'options');
  if (options.folders !== undefined && !['all', 'used', 'none'].includes(options.folders)) throw new RulesError('"folders" is "all", "used" or "none"', 'options.folders');
  if (options.idPrefix !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(options.idPrefix)) throw new RulesError('"idPrefix" is up to 32 letters, digits, - or _', 'options.idPrefix');
  if (options.access !== undefined && !['gm', 'everyone'].includes(options.access)) throw new RulesError('"access" is "gm" or "everyone"', 'options.access');
  if (json.partials !== undefined && !isObject(json.partials)) throw new RulesError('"partials" must be an object of name: rule fragment', 'partials');
  const partials = json.partials ?? {};
  const types = compileTypeMap(json.types, 'types', partials);
  if (!types.size) throw new RulesError('"types" has no rules', 'types');
  return {
    id: String(json.id ?? ''),
    name: json.name.trim(),
    description: String(json.description ?? ''),
    /** What to do in the campaign before importing: steps, in Markdown (bold, italics, code). */
    setup: setup.map((x) => x.trim()),
    source: { systems: asStrings(json.source?.systems ?? json.source?.system) },
    target: { system: json.target?.system ? String(json.target.system) : null },
    options: { folders: options.folders ?? 'all', wrap: options.wrap ?? null, idPrefix: options.idPrefix ?? null, access: options.access ?? 'gm' },
    tables: json.tables ?? {},
    schema: json.schema ?? null,
    types,
    embedded: compileTypeMap(json.embedded, 'embedded', partials),
    assets: compileAssets(json.assets),
  };
}

const asStrings = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v]).map(String));

// ---- reading exports ----

/**
 * What an export file holds: a pack ({ items, folders, metadata, … }) as mana's Compendium
 * Importer writes it, or one document (a journal entry, an item, an actor).
 */
export function readExport(json, fileName = '') {
  if (!isObject(json)) throw new Error('not a JSON object');
  const isPack = Array.isArray(json.items) && (json.metadata || json.package || json.folders || json.type);
  let docs = (isPack ? json.items : [json]).filter(isObject);
  const kind = isPack ? json.type ?? json.metadata?.type ?? null : json.pages ? 'JournalEntry' : json.prototypeToken ? 'Actor' : json.type ? 'Item' : null;
  const system = json.source?.system ?? json.metadata?.system ?? docs.find((d) => d?._stats?.systemId)?._stats?.systemId ?? null;
  const label = String(json.metadata?.label ?? (isPack ? json.metadata?.name ?? json.package : json.name) ?? fileName.replace(/\.json$/i, '') ?? 'Import').trim() || 'Import';
  const key = json.metadata?.id ?? json.package ?? (isPack ? null : json._id) ?? fileName.replace(/\.json$/i, '');
  let folders = Array.isArray(json.folders) ? json.folders.filter(isObject) : [];
  /** Each document's Foundry document name, where the pack's kind doesn't say it (adventures). */
  const kinds = new Map();
  if (kind === 'Adventure') ({ docs, folders } = unpackAdventures(docs, folders, kinds));
  return { label, key: String(key || label), system, kind, docs, folders, isPack, kinds };
}

/** An adventure's collections, and the Foundry document name of what each holds. */
const ADVENTURE_CONTENTS = {
  journal: 'JournalEntry', actors: 'Actor', items: 'Item', scenes: 'Scene', tables: 'RollTable',
  macros: 'Macro', cards: 'Cards', playlists: 'Playlist', combats: 'Combat',
};

/**
 * Adventures unpacked: each adventure (kind "Adventure", its collections left out) and then
 * everything in it, as if from packs of their own, so each goes through the rules for its type.
 * An adventure's folders are kept separate by document type in Foundry; an archive's aren't, so
 * folders with the same name in the same place become one.
 */
function unpackAdventures(adventures, packFolders, kinds) {
  const docs = [];
  const folders = [...packFolders];
  const merged = new Map(); // a folder's id → the id of the one it became
  const byPlace = new Map(); // "parent/name" → folder id kept
  for (const adv of adventures) {
    const { folders: own = [], ...rest } = adv;
    const head = { ...rest };
    for (const k of Object.keys(ADVENTURE_CONTENTS)) delete head[k];
    kinds.set(head, 'Adventure');
    docs.push(head);
    // Parents first, so a merged parent is known when its children are placed.
    const list = (Array.isArray(own) ? own : []).filter(isObject);
    const depth = (f) => { let n = 0; for (let p = f.folder; p && n < 50; p = list.find((x) => x._id === p)?.folder) n++; return n; };
    for (const f of [...list].sort((a, b) => depth(a) - depth(b))) {
      const parent = f.folder ? merged.get(f.folder) ?? f.folder : adv.folder ?? null;
      const place = `${parent ?? ''}/${String(f.name ?? '').trim().toLowerCase()}`;
      if (byPlace.has(place)) { merged.set(f._id, byPlace.get(place)); continue; }
      byPlace.set(place, f._id);
      merged.set(f._id, f._id);
      folders.push({ ...f, folder: parent });
    }
    for (const [collection, name] of Object.entries(ADVENTURE_CONTENTS)) {
      for (const d of Array.isArray(adv[collection]) ? adv[collection] : []) {
        if (!isObject(d)) continue;
        const doc = { ...d, folder: d.folder ? merged.get(d.folder) ?? d.folder : adv.folder ?? null };
        kinds.set(doc, name);
        docs.push(doc);
      }
    }
  }
  return { docs, folders };
}

// ---- ids ----

function hash(text) {
  // FNV-1a, 32-bit, twice with different seeds: enough to keep generated ids apart.
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(36).padStart(7, '0') + b.toString(36).padStart(7, '0');
}

export const slug = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const safe = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

class Ids {
  constructor() { this.taken = new Set(); }
  /** A document id (8-64 of A-Z a-z 0-9 - _) from `base`, the same for the same base each run. */
  make(base) {
    let id = safe(base);
    if (id.length > 64) id = `${id.slice(0, 49)}-${hash(base)}`;
    while (id.length < 8) id += '_';
    let n = 2;
    const start = id;
    while (this.taken.has(id)) id = `${start.slice(0, 60)}-${n++}`;
    this.taken.add(id);
    return id;
  }
}

// ---- converting ----

class Notes {
  constructor() { this.map = new Map(); }
  /** Count a note (the same message counted once, with a few examples). */
  add(message, example, level = 'info') {
    const n = this.map.get(message) ?? { message, level, count: 0, examples: [] };
    n.count++;
    if (example && n.examples.length < 5 && !n.examples.includes(example)) n.examples.push(example);
    this.map.set(message, n);
  }
  list() { return [...this.map.values()]; }
}

/**
 * Convert exports by compiled rules.
 * @param {ReturnType<typeof compileRules>} rules
 * @param {{ name?: string, json: object }[]} files  parsed export files
 * @param {{ lang?: object, schema?: object, wrap?: boolean, idPrefix?: string, assets?: { files?: Iterable<string>|object, left?: Record<string, string>, stored?: Map<string, string>, folder?: string } }} [opts]
 *   `schema`: target types (schemaFromManifest), used before the rules file's own; `wrap`: put each
 *   pack in a folder named for it (default: when converting more than one, or the rules say so).
 *   `assets`: the pictures there are to upload (`files`, Foundry paths: a bundle's), where they were
 *   stored once uploaded (`stored`, Foundry path → campaign path), why the bundle hasn't some (`left`,
 *   path → reason), and a `folder` in place of the rules'.
 *   Without `stored`, a picture there is to upload points where it will go.
 *   `pdfs`: the server keeps PDFs and PDF notes (`core.pdf`, TM ADR 0133; default true). Without
 *   it, `core.pdf` entries are left out and the `asset` transform gives nothing for a PDF.
 *   `refs`: the server remaps ids inside data on import (`core.import-refs`, TM ADR 0132; default
 *   true). Then Foundry links and `ref`s to documents in this import become their entry ids;
 *   without it, links keep only their label and tomes get no layout.
 */
export function convert(rules, files, opts = {}) {
  const notes = new Notes();
  const problems = [];
  const schema = { ...CORE_TYPES, ...(rules.schema ?? {}), ...(opts.schema ?? {}) };
  const checked = Object.keys(schema).length > Object.keys(CORE_TYPES).length;
  const ids = new Ids();
  const entries = [];
  const stats = {};
  const packs = [];
  const wrap = opts.wrap ?? rules.options.wrap ?? files.length > 1;
  const tables = rules.tables;
  const unknownTypes = new Set();

  // Pictures (the `asset` transform): each Foundry path once, with the campaign path it goes to.
  const assetRules = { ...rules.assets, ...(opts.assets?.folder ? { folder: opts.assets.folder } : {}) };
  const rawFiles = opts.assets?.files;
  const haveFiles = rawFiles == null ? null : new Set(typeof rawFiles[Symbol.iterator] === 'function' && typeof rawFiles !== 'string' ? rawFiles : Object.keys(rawFiles));
  const stored = opts.assets?.stored ?? null;
  const refs = new Map();
  const targets = new Set();
  // Foundry `_id` → the entry it became, for links and `ref`s (resolved once everything is made).
  const foundryIds = new Map();
  const pdfs = opts.pdfs !== false;
  // A server without PDF notes: they're left out (they hold nothing, so they go alone), and links
  // to them keep only their label.
  const withoutPdfs = (made, docName) => {
    const gone = new Set(made.filter((e) => e.type === 'core.pdf').map((e) => e.id));
    if (!gone.size) return made;
    for (const [fid, id] of foundryIds) if (gone.has(id)) foundryIds.delete(fid);
    notes.add('This Tavern Moot has no PDF notes (core.pdf), so PDFs were left out', docName, 'warning');
    return made.filter((e) => !gone.has(e.id));
  };
  const assetFor = (ref, docName) => {
    if (ref == null || ref === '' || typeof ref !== 'string') return '';
    const path = filePath(ref);
    if (!path) { notes.add('Pictures held in the data itself (data: addresses) were left out', docName); return ''; }
    if (!kindOf(path)) { notes.add('Files that aren’t pictures or PDFs were left out (Tavern Moot keeps only those)', `${docName}: ${path}`); return ''; }
    if (isPdf(path) && !pdfs) return '';
    if (!selected(path, assetRules)) { notes.add('Files the rules’ "assets" leave out', `${docName}: ${path}`); return ''; }
    let r = refs.get(path);
    if (!r) {
      // Two Foundry files never share a campaign path (likely with "layout": "flat").
      let target = targetPath(path, assetRules);
      for (let n = 2; targets.has(target.toLowerCase()); n++) target = targetPath(path, assetRules).replace(/(\.[a-z0-9]+)$/i, ` (${hash(path).slice(0, 6)}${n > 2 ? `-${n}` : ''})$1`);
      targets.add(target.toLowerCase());
      r = { path, target, available: haveFiles ? haveFiles.has(path) : false, uses: 0, example: docName };
      refs.set(path, r);
    }
    r.uses++;
    if (stored ? stored.has(path) : r.available) return stored ? stored.get(path) : r.target;
    return assetRules.missing === 'keep' ? r.target : '';
  };

  const ctxFor = (docName) => ({
    tables,
    lang: opts.lang,
    count: (message, example) => notes.add(message, example ?? docName),
    asset: (ref) => assetFor(ref, docName),
  });

  /** Data checked against the target type, with what had to change counted. */
  const check = (type, data, docName) => {
    const def = schema[type];
    if (def?.open) return data;
    if (!def) {
      if (checked && !unknownTypes.has(type)) {
        unknownTypes.add(type);
        problems.push({ level: 'warning', doc: docName, message: `${type} isn't one of the target system's types, so its data wasn't checked. Is the type id right?` });
      }
      return data;
    }
    return normalize(def.fields, data, (path, why) => {
      const general = why.replace(/\s*\(.*\)$/, '');
      notes.add(`${type} ${path.replace(/\[\d+\]/g, '[]')}: ${general}`, `${docName}: ${why}`, why.includes('not a field') ? 'warning' : 'info');
    });
  };

  const choose = (map, key) => map.get(key) ?? null;
  const pickRule = (list, scope, ctx) => list?.find((r) => !r.when || truthy(r.when(scope, ctx))) ?? null;

  for (const file of files) {
    let pack;
    try { pack = readExport(file.json, file.name ?? ''); }
    catch (err) { problems.push({ level: 'error', doc: file.name, message: `Could not read: ${err.message}` }); continue; }
    const prefix = safe(opts.idPrefix ?? rules.options.idPrefix ?? slug(pack.key).slice(0, 32)) || 'import';
    const summary = { file: file.name ?? pack.label, label: pack.label, system: pack.system, kind: pack.kind, documents: 0, folders: 0, skipped: 0, byType: {} };
    packs.push(summary);
    if (rules.source.systems.length && pack.system && !rules.source.systems.includes(pack.system)) {
      problems.push({ level: 'warning', doc: summary.file, message: `This export is from the "${pack.system}" system; these rules are for ${rules.source.systems.map((s) => `"${s}"`).join(', ')}.` });
    }

    // Folders: the pack's own (wrapped in one named for the pack, if asked), parents first.
    let root = null;
    if (wrap) {
      root = ids.make(`${prefix}-pack`);
      entries.push({ id: root, type: 'core.folder', name: clampName(pack.label), parentId: null, sort: 0, data: {}, flags: {} });
      summary.folders++;
    }
    const folderIds = new Map();
    if (rules.options.folders !== 'none') {
      const byId = new Map(pack.folders.map((f) => [f._id, f]));
      let keep = pack.folders;
      if (rules.options.folders === 'used') {
        const used = new Set();
        for (const d of pack.docs) for (let f = d.folder, n = 0; f && byId.has(f) && !used.has(f) && n < 50; f = byId.get(f).folder, n++) used.add(f);
        keep = pack.folders.filter((f) => used.has(f._id));
      }
      const depth = (f) => { let n = 0; for (let p = f.folder; p && byId.has(p) && n < 50; p = byId.get(p).folder) n++; return n; };
      for (const f of [...keep].sort((a, b) => depth(a) - depth(b) || (a.sort ?? 0) - (b.sort ?? 0))) {
        if (!f._id) continue;
        const id = ids.make(`${prefix}-f-${f._id}`);
        folderIds.set(f._id, id);
      }
      for (const f of [...keep].sort((a, b) => depth(a) - depth(b) || (a.sort ?? 0) - (b.sort ?? 0))) {
        const id = folderIds.get(f._id);
        if (!id) continue;
        const parentId = f.folder && folderIds.has(f.folder) ? folderIds.get(f.folder) : root;
        entries.push({ id, type: 'core.folder', name: clampName(f.name || 'Folder'), parentId, sort: num(f.sort), data: {}, flags: {} });
        summary.folders++;
      }
    }
    // Folders a rule's `folder` asks for, by path under where the document would be.
    const madeFolders = new Map();
    const subfolder = (parentId, path) => {
      let at = parentId;
      for (const part of String(path).split('/').map((p) => p.trim()).filter(Boolean)) {
        const k = `${at ?? ''}/${part.toLowerCase()}`;
        if (!madeFolders.has(k)) {
          const id = ids.make(`${prefix}-g-${hash(k)}`);
          entries.push({ id, type: 'core.folder', name: clampName(part), parentId: at, sort: 0, data: {}, flags: {} });
          summary.folders++;
          madeFolders.set(k, id);
        }
        at = madeFolders.get(k);
      }
      return at;
    };

    const tally = (type) => {
      summary.documents++;
      summary.byType[type] = (summary.byType[type] ?? 0) + 1;
      stats[type] = (stats[type] ?? 0) + 1;
    };

    /**
     * One document by its rule, then what it holds (Foundry embedded items, extras). Returns the
     * entries made, or throws (the document and what it holds are then left out together).
     */
    const build = (rule, scope, ctx, { idBase, parentId, sourceRef, holderType }) => {
      const out = [];
      const vars = { ...scope.vars };
      const s = { ...scope, vars };
      for (const [k, fn] of rule.vars) vars[k] = fn(s, ctx);
      const name = clampName(rule.name(s, ctx));
      let where = parentId;
      if (rule.folder) {
        const path = rule.folder(s, ctx);
        if (typeof path === 'string' && path.trim()) where = subfolder(parentId, path);
      }
      if (holderType && holderType !== 'core.folder' && !canHold(schema, holderType, rule.type)) {
        throw new Error(`${holderType} can't hold ${rule.type}`);
      }
      const data = check(rule.type, rule.data(s, ctx), name);
      const size = JSON.stringify(data).length;
      if (size > BODY_MAX) throw new Error(`its data is ${Math.round(size / 1024)} KB; a document may have 256 KB`);
      const id = ids.make(idBase);
      const fid = isObject(scope.cur) ? scope.cur._id : null;
      if (typeof fid === 'string' && fid && !foundryIds.has(fid)) foundryIds.set(fid, id);
      out.push({
        id, type: rule.type, name, parentId: where ?? null, sort: num(rule.sort(s, ctx)), data,
        flags: { [MODULE_ID]: { source: sourceRef } },
      });
      // Foundry's embedded documents (an actor's items), each by its own rule.
      const embedded = Array.isArray(scope.cur?.items) && scope.cur === scope.root ? scope.cur.items : [];
      if (embedded.length && rule.embedded.mode === 'hold') {
        embedded.forEach((child, i) => {
          if (!isObject(child)) return;
          const key = child.type;
          if (rule.embedded.only && !rule.embedded.only.has(key)) return;
          if (rule.embedded.except?.has(key)) return;
          const cscope = { ...scopeFor(child), parent: s };
          const list = choose(rules.embedded, key) ?? choose(rules.types, key);
          const childRule = pickRule(list, cscope, ctx) ?? pickRule(choose(rules.embedded, '*') ?? choose(rules.types, '*'), cscope, ctx);
          const label = `${name} / ${child.name ?? '(unnamed)'}`;
          if (!childRule) { notes.add(`Embedded ${key} documents have no rule, so they were left out`, label, 'warning'); return; }
          if (childRule.skip) { notes.add(`Embedded ${key}: ${childRule.skip}`, label); return; }
          try {
            const made = build(childRule, cscope, ctxFor(label), {
              idBase: `${id}-${child._id ?? i}`, parentId: id, holderType: rule.type,
              sourceRef: { ...sourceRef, embedded: child._id ?? null, type: key },
            });
            out.push(...made);
          } catch (err) {
            if (err instanceof RulesError) throw err;
            notes.add(`Embedded documents left out: ${err.message}`, label, 'warning');
          }
        });
      }
      // Extras: more documents made from lists in this one (a class's traits, a journal's pages).
      for (const x of rule.extra) {
        const items = x.from(s, ctx);
        const list = items == null ? [] : Array.isArray(items) ? items : isObject(items) ? Object.entries(items).map(([key, value]) => ({ key, value })) : [items];
        list.forEach((el, i) => {
          const xs = childScope(s, el, i);
          if (x.when && !truthy(x.when(xs, ctx))) return;
          const held = x.place === 'held';
          out.push(...build(x, xs, ctx, {
            idBase: `${id}-x${x.index}-${i}`, parentId: held ? id : where ?? null, holderType: held ? rule.type : null,
            sourceRef: { ...sourceRef, extra: x.index, index: i },
          }));
        });
      }
      return out;
    };

    for (const [i, doc] of pack.docs.entries()) {
      const key = doc.type ?? pack.kinds.get(doc) ?? pack.kind ?? '?';
      const docName = String(doc.name ?? '(unnamed)');
      const ctx = ctxFor(docName);
      const scope = scopeFor(doc);
      const rule = pickRule(choose(rules.types, key), scope, ctx) ?? pickRule(choose(rules.types, '*'), scope, ctx);
      if (!rule) {
        summary.skipped++;
        notes.add(`No rule for Foundry type "${key}": left out`, docName, 'warning');
        continue;
      }
      if (rule.skip) {
        summary.skipped++;
        notes.add(`${key}: ${rule.skip}`, docName);
        continue;
      }
      const folder = rules.options.folders !== 'none' && doc.folder && folderIds.has(doc.folder) ? folderIds.get(doc.folder) : root;
      try {
        let made = build(rule, scope, ctx, {
          idBase: `${prefix}-${doc._id ?? `n${i}`}`, parentId: folder, holderType: null,
          sourceRef: { pack: pack.key, id: doc._id ?? null, type: key, system: pack.system },
        });
        if (!pdfs) made = withoutPdfs(made, docName);
        if (!made.length) { summary.skipped++; continue; }
        entries.push(...made);
        for (const e of made) tally(e.type);
      } catch (err) {
        if (err instanceof RulesError) throw err;
        summary.skipped++;
        problems.push({ level: 'error', doc: docName, message: `Left out: ${err.message}` });
      }
    }
  }
  resolveRefs(entries, foundryIds, opts.refs !== false, notes);
  const assets = [...refs.values()];
  if (assets.length) {
    const kept = assetRules.missing === 'keep';
    const absent = assets.filter((r) => !r.available);
    const failed = stored ? assets.filter((r) => r.available && !stored.has(r.path)) : [];
    if (!haveFiles) {
      for (const r of assets) notes.add(`The documents use ${assets.length} pictures and PDFs, which these exports don’t carry; ${kept ? `their fields point at ${assetRules.folder}/… for you to upload them there` : 'their fields were left empty'}. The Foundry Export tab brings them.`, `${r.example}: ${r.path}`);
    } else {
      // Left out on purpose when exporting (Foundry's own icons, say): worth knowing. Missing: a warning.
      const left = opts.assets?.left ?? {};
      for (const r of absent) {
        const why = left[r.path];
        const meant = why && why !== 'not found' && !why.startsWith('could not');
        notes.add(`Files the bundle doesn’t have (${why ?? 'not found in Foundry'}): ${kept ? 'pointed at where they would be' : 'left empty'}`, `${r.example}: ${r.path}`, meant ? 'info' : 'warning');
      }
    }
    for (const r of failed) notes.add(`Files that could not be uploaded: ${kept ? 'pointed at where they would be' : 'left empty'}`, `${r.example}: ${r.path}`, 'warning');
  }
  if (!checked) notes.add('No target schema: data was not checked against the system’s fields. Add one to the rules file (tools/schema.mjs) or load the system’s tavern.json.', null, 'warning');
  return { entries, packs, notes: notes.list(), problems, stats, assets };
}

/**
 * Links and `ref`s, now every entry's id is known: to a document in this import, its entry id
 * (the server remaps it on import); otherwise the link keeps its label and a `ref` its Foundry id.
 * Without the server's remapping, links keep only their label and tomes lose their layout.
 */
function resolveRefs(entries, foundryIds, remaps, notes) {
  const label = (s) => s.replace(/[[\]|]/g, '').trim();
  const fix = (v, where) => {
    if (typeof v === 'string') {
      if (!/[\uE000\uE003]/.test(v)) return v;
      return v
        .replace(REF_RE, (_, fid) => (remaps && foundryIds.get(fid)) || fid)
        .replace(LINK_RE, (_, fid, text) => {
          const id = remaps ? foundryIds.get(fid) : null;
          if (id) { notes.add('Foundry links made into links to the documents they point at', where); return `[[@${id}${label(text) ? `|${label(text)}` : ''}]]`; }
          if (remaps) notes.add('Foundry links to documents not in this import: their label is kept', `${where}: ${text || fid}`);
          return text;
        });
    }
    if (Array.isArray(v)) return v.map((x) => fix(x, where));
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x, where)]));
    return v;
  };
  for (const e of entries) {
    e.data = fix(e.data, e.name);
    if (!remaps && e.type === 'core.tome') e.data = {};
  }
  if (!remaps && entries.some((e) => e.type === 'core.tome')) {
    notes.add('This server doesn\u2019t carry ids through an import (core.import-refs), so tomes show their pages in Foundry\u2019s order, without sections', null);
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : 0);
function clampName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim();
  return (s || '(unnamed)').slice(0, DOCUMENT_NAME_MAX);
}

/** An archive file (what a package's `archives` entry points at) from converted entries. */
export function archiveFile(name, entries) {
  return { format: 1, name: String(name).slice(0, 100), entries };
}
