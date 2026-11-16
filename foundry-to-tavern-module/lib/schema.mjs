// Checking converted data against the target system's field definitions (its tavern.json
// `documentTypes[].fields`), and repairing it the way Tavern Moot itself would.
//
// A port of TM's packages/protocol/src/packages/fields.ts (normalizeFields), with one addition: it
// says what it changed. Archive writes store entries as they are (TM ADR 0112), and the server
// only checks them when they're imported into the campaign, so anything invalid has to be caught
// here or it fails later, far from its cause.

const TEXT_MAX = 20_000;
const LIST_MAX_ROWS = 200;
const TAGS_MAX = 200;
const NUMBERS_MAX = 100;
const JSON_FIELD_MAX = 20_000;
export const NOTE_BODY_MAX = 100_000;
export const DOCUMENT_NAME_MAX = 200;
export const ARCHIVE_NAME_MAX = 100;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const textMax = (f) => f.max ?? (f.multiline ? TEXT_MAX : 1000);
const clampNumber = (f, n) => {
  let v = f.integer ? Math.round(n) : n;
  if (f.min !== undefined) v = Math.max(f.min, v);
  if (f.max !== undefined) v = Math.min(f.max, v);
  return v;
};
// Image fields take campaign asset paths: `[storage:]folders/file.ext`, no `..`, nothing hidden.
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif']);
export function isAssetPath(p) {
  if (typeof p !== 'string' || p.length > 340 || !p) return false;
  const at = p.indexOf(':');
  const rel = at < 0 ? p : p.slice(at + 1);
  if (at >= 0 && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.slice(0, at))) return false;
  const parts = rel.split('/');
  if (parts.length > 9 || parts.some((s) => !s || s === '.' || s === '..' || s.startsWith('.') || /[\\\0]/.test(s))) return false;
  return IMAGE_EXT.has(parts.at(-1).split('.').pop().toLowerCase());
}

/** Core's own types, so notes and folders are checked too. */
export const CORE_TYPES = {
  'core.note': { category: 'note', contains: null, fields: [{ key: 'body', type: 'markdown', max: NOTE_BODY_MAX }] },
  'core.folder': { category: 'other', contains: [], fields: [] },
  // A tome holds notes as its pages (TM ADR 0104). Its data (`sections`, and `pages` naming its
  // notes by id) isn't field-shaped: `open` passes it through for Tavern Moot to check.
  'core.tome': { category: 'note', contains: ['core.note'], fields: [], open: true },
  // A PDF from the campaign's files (TM ADR 0133): `{ file, bookmarks? }`, checked by Tavern Moot.
  // It holds nothing, and a tome can't hold it: it sits in a folder.
  'core.pdf': { category: 'note', contains: [], fields: [], open: true },
};

function defaultValue(f) {
  switch (f.type) {
    case 'number': return f.default ?? clampNumber(f, 0);
    case 'text': case 'markdown': return f.default ?? '';
    case 'boolean': return f.default ?? false;
    case 'select': return f.default ?? f.options?.[0]?.value ?? '';
    case 'resource': return { value: f.default ?? 0, max: f.default ?? 0 };
    case 'image': return '';
    case 'tags': return cleanTags(f, f.default ?? []);
    case 'numbers': return sizeNumbers(f, f.default ?? []);
    case 'json': return {};
    case 'group': return normalize(f.fields, {}, null, '');
    case 'list': return [];
    default: return undefined;
  }
}

function cleanTags(f, values) {
  const allowed = f.options ? new Set(f.options.map((o) => o.value)) : null;
  const out = [];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const tag = v.trim().slice(0, 100);
    if (!tag || out.includes(tag) || (allowed && !allowed.has(tag))) continue;
    out.push(tag);
  }
  return out.slice(0, f.max ?? TAGS_MAX);
}

function sizeNumbers(f, values) {
  const out = values.slice(0, f.length ?? NUMBERS_MAX).map((n) => clampNumber(f, n));
  if (f.length !== undefined) while (out.length < f.length) out.push(clampNumber(f, 0));
  return out;
}

const show = (v) => {
  const s = typeof v === 'string' ? JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v) : JSON.stringify(v);
  return s === undefined ? 'nothing' : s.length > 60 ? `${s.slice(0, 60)}…` : s;
};

/**
 * One value made valid for its field. `note(path, message)` hears about anything that had to
 * change; a missing value taking its default is not a problem and isn't reported.
 */
function normalizeValue(f, v, note, path) {
  const missing = v === undefined;
  const fix = (out, why) => { if (!missing) note(path, `${why} (${show(v)} → ${show(out)})`); return out; };
  switch (f.type) {
    case 'number': {
      if (typeof v === 'number' && Number.isFinite(v)) {
        const out = clampNumber(f, v);
        return out === v ? v : fix(out, f.integer && Math.round(v) !== v ? 'not a whole number' : 'out of range');
      }
      return missing ? defaultValue(f) : fix(defaultValue(f), 'not a number');
    }
    case 'text': {
      if (typeof v !== 'string') return missing ? defaultValue(f) : fix(defaultValue(f), 'not text');
      const max = textMax(f);
      return v.length > max ? fix(v.slice(0, max), `longer than ${max} characters`) : v;
    }
    case 'markdown': {
      if (typeof v !== 'string') return missing ? defaultValue(f) : fix(defaultValue(f), 'not text');
      const max = f.max ?? TEXT_MAX;
      return v.length > max ? fix(v.slice(0, max), `longer than ${max} characters`) : v;
    }
    case 'boolean':
      return typeof v === 'boolean' ? v : missing ? defaultValue(f) : fix(defaultValue(f), 'not true/false');
    case 'select':
      if (typeof v === 'string' && f.options?.some((o) => o.value === v)) return v;
      return missing ? defaultValue(f) : fix(defaultValue(f), `not one of ${f.options.map((o) => JSON.stringify(o.value)).join(', ')}`);
    case 'resource': {
      if (!isObject(v)) return missing ? defaultValue(f) : fix(defaultValue(f), 'not { value, max }');
      const num = (x, k) => {
        if (typeof x === 'number' && Number.isFinite(x)) return x;
        if (x !== undefined) note(`${path}.${k}`, `not a number (${show(x)})`);
        return f.default ?? 0;
      };
      return { ...v, value: num(v.value, 'value'), max: num(v.max, 'max') };
    }
    case 'image':
      if (v === '' || isAssetPath(v)) return v;
      return missing ? '' : fix('', 'not a campaign image path');
    case 'tags': {
      if (!Array.isArray(v)) return missing ? defaultValue(f) : fix(defaultValue(f), 'not a list');
      const out = cleanTags(f, v);
      return out.length === v.length && out.every((t, i) => t === v[i]) ? v : fix(out, f.options ? 'tags not among the options, repeated or empty' : 'tags repeated or empty');
    }
    case 'numbers': {
      if (!Array.isArray(v)) return missing ? defaultValue(f) : fix(defaultValue(f), 'not a list of numbers');
      const out = sizeNumbers(f, v.map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0)));
      return out.length === v.length && out.every((n, i) => n === v[i]) ? v : fix(out, 'numbers out of range or the wrong count');
    }
    case 'json':
      if (isObject(v) && JSON.stringify(v).length <= (f.max ?? JSON_FIELD_MAX)) return v;
      return missing ? {} : fix({}, isObject(v) ? 'too big' : 'not an object');
    case 'group':
      if (!isObject(v) && !missing) note(path, `not an object (${show(v)})`);
      return normalize(f.fields, isObject(v) ? v : {}, note, path);
    case 'list': {
      if (!Array.isArray(v)) { if (!missing) note(path, `not a list (${show(v)})`); return []; }
      const max = f.maxRows ?? LIST_MAX_ROWS;
      if (v.length > max) note(path, `more than ${max} rows (${v.length}); the rest were dropped`);
      return v.slice(0, max).map((row, i) => {
        if (!isObject(row)) note(`${path}[${i}]`, `not an object (${show(row)})`);
        return normalize(f.fields, isObject(row) ? row : {}, note, `${path}[${i}]`);
      });
    }
    default:
      return v;
  }
}

/**
 * Data with every declared field present and valid. Keys the definition doesn't know are kept
 * (as TM keeps them) but reported, since in a rules file they're nearly always a typo.
 */
export function normalize(fields, data, note, path = '') {
  const say = note || (() => {});
  const source = isObject(data) ? data : {};
  const out = { ...source };
  const known = new Set();
  for (const f of fields) {
    known.add(f.key);
    out[f.key] = normalizeValue(f, source[f.key], say, path ? `${path}.${f.key}` : f.key);
  }
  for (const k of Object.keys(source)) {
    if (!known.has(k) && k !== '_id') say(path ? `${path}.${k}` : k, 'is not a field of this type (kept, but unused)');
  }
  return out;
}

/**
 * A schema (`{ "<type>": { category, contains, fields } }`) from a system's or module's tavern.json.
 * `contains` is what a type may hold: categories or type ids. TM's default when a type doesn't say:
 * actors hold items, everything else holds nothing.
 */
export function schemaFromManifest(manifest) {
  const out = {};
  const id = manifest?.id;
  for (const t of Array.isArray(manifest?.documentTypes) ? manifest.documentTypes : []) {
    const name = t?.name ?? t?.id;
    if (!name) continue;
    const type = name.includes('.') ? name : `${id}.${name}`;
    const category = t.category ?? 'other';
    out[type] = { category, contains: t.contains ?? (category === 'actor' ? ['item'] : []), fields: Array.isArray(t.fields) ? t.fields : [] };
  }
  // A module's `extends` adds fields to another package's types.
  for (const e of Array.isArray(manifest?.extends) ? manifest.extends : []) {
    if (out[e.type] && Array.isArray(e.fields)) out[e.type].fields = [...out[e.type].fields, ...e.fields];
  }
  return out;
}

/** May a document of `childType` be held by one of `holderType`? Unknown either way: yes. */
export function canHold(schema, holderType, childType) {
  if (holderType === 'core.folder') return true;
  const holder = schema[holderType];
  const child = schema[childType];
  if (!holder || !child) return true;
  const contains = holder.contains ?? (holder.category === 'actor' ? ['item'] : []);
  const short = childType.slice(childType.indexOf('.') + 1);
  return contains.includes(child.category) || contains.includes(childType) || contains.includes(short);
}
