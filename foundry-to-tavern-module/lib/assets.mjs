// Pictures: from the paths Foundry documents use to the campaign file paths they're uploaded to
// (TM ADR 0131). Pure, like convert.mjs: the rules file's "assets" section, the `asset` transform,
// and the widget's upload plan all come through here.

import { RulesError } from './expr.mjs';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg']);
/** Tavern Moot's limits for a campaign file path (packages/protocol/src/assets.ts). */
const MAX_FOLDERS = 8;
const MAX_SEGMENT = 100;
const MAX_PATH = 340;
export const ASSET_MAX_BYTES = 25 * 1024 * 1024;
export const UPLOAD_BATCH = 50; // uploadMany takes 500; smaller batches show progress

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
export const isRemote = (p) => SCHEME_RE.test(p);
export const extOf = (p) => /\.([a-z0-9]+)$/i.exec(p)?.[1].toLowerCase() ?? '';
export const isImage = (p) => IMAGE_EXT.has(extOf(p));

/**
 * A file reference as documents write it, as a path: no query or fragment, %-escapes decoded, no
 * leading "/" or "./". Web addresses stay whole. null for data: and blob: URLs and nothing.
 * The same as filePath in the Foundry module's bundle.mjs, which keys the bundle's files by it.
 */
export function filePath(ref) {
  let s = String(ref ?? '').trim();
  if (!s || /^(data|blob):/i.test(s)) return null;
  s = s.replace(/[?#].*$/, '');
  try { s = decodeURI(s); } catch { /* a stray %: keep it as written */ }
  if (!isRemote(s)) s = s.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  return s || null;
}

export const ASSET_DEFAULTS = Object.freeze({ folder: 'foundry', layout: 'paths', include: [], exclude: [], ifExists: 'skip', missing: 'drop' });

const okSegment = (s) => !!s && s !== '.' && s !== '..' && !s.startsWith('.') && !/[\\/:*?"<>|\0]/.test(s) && s.length <= MAX_SEGMENT;

/** "storage:folder/sub" split and checked, or null if it isn't a folder path. */
export function parseFolder(folder) {
  const s = String(folder ?? '').trim().replace(/^\/+|\/+$/g, '');
  const at = s.indexOf(':');
  const storage = at < 0 ? null : s.slice(0, at);
  if (storage !== null && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(storage)) return null;
  const rel = at < 0 ? s : s.slice(at + 1).replace(/^\/+/, '');
  const parts = rel ? rel.split('/') : [];
  if (parts.length > MAX_FOLDERS - 1 || !parts.every(okSegment)) return null;
  return { storage, parts };
}

/** The rules file's "assets" section, checked. */
export function compileAssets(spec, at = 'assets') {
  if (spec === undefined) return { ...ASSET_DEFAULTS };
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new RulesError('"assets" must be an object', at);
  const allowed = Object.keys(ASSET_DEFAULTS);
  for (const k of Object.keys(spec)) if (!allowed.includes(k)) throw new RulesError(`unknown key "${k}" (expected one of ${allowed.join(', ')})`, at);
  const out = { ...ASSET_DEFAULTS, ...spec };
  if (typeof out.folder !== 'string' || !parseFolder(out.folder)) throw new RulesError('"folder" is a campaign folder such as "foundry" or "maps-nas:foundry/ose", up to 7 folders deep', `${at}.folder`);
  if (!['paths', 'flat'].includes(out.layout)) throw new RulesError('"layout" is "paths" (keep Foundry’s folders) or "flat" (every file straight in the folder)', `${at}.layout`);
  for (const k of ['include', 'exclude']) {
    if (!Array.isArray(out[k]) || !out[k].every((x) => typeof x === 'string' && x)) throw new RulesError(`"${k}" is a list of Foundry path beginnings, such as "modules/" or "icons/svg/"`, `${at}.${k}`);
  }
  if (!['skip', 'replace', 'rename'].includes(out.ifExists)) throw new RulesError('"ifExists" is "skip", "replace" or "rename"', `${at}.ifExists`);
  if (!['drop', 'keep'].includes(out.missing)) throw new RulesError('"missing" is "drop" (leave the field empty) or "keep" (point it where the picture would be)', `${at}.missing`);
  return out;
}

/** Does the rules' include/exclude let this Foundry path through? */
export function selected(path, assets) {
  const p = path.toLowerCase();
  if (assets.include.length && !assets.include.some((x) => p.startsWith(x.toLowerCase()))) return false;
  return !assets.exclude.some((x) => p.startsWith(x.toLowerCase()));
}

function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

function cleanSegment(s, keepExt = false) {
  let out = String(s).replace(/[\\/:*?"<>|\0]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '_');
  if (!out || out === '.' || out === '..') out = '_';
  if (out.length > MAX_SEGMENT) {
    const ext = keepExt ? `.${extOf(out)}` : '';
    out = `${out.slice(0, MAX_SEGMENT - ext.length - 9)}-${hash(out).slice(0, 8)}${ext}`;
  }
  return out;
}

/**
 * Where a Foundry picture goes in the campaign's files: `folder/<its Foundry path>` (or just its
 * name, for layout "flat"), made a valid campaign path. null if it isn't a picture.
 * @param {string} path  a Foundry path, as filePath gives it
 * @param {{ folder: string, layout: string }} assets
 */
export function targetPath(path, assets) {
  if (!path || !isImage(path)) return null;
  const base = parseFolder(assets.folder) ?? parseFolder(ASSET_DEFAULTS.folder);
  let rel;
  if (isRemote(path)) {
    try { const u = new URL(path); rel = ['web', u.host, ...decodeURIComponent(u.pathname).split('/')]; }
    catch { rel = ['web', path]; }
  } else rel = path.split('/');
  rel = rel.filter((s) => s && s !== '.' && s !== '..');
  if (assets.layout === 'flat') rel = rel.slice(-1);
  const name = cleanSegment(rel.pop() ?? 'file', true);
  let folders = rel.map((s) => cleanSegment(s));
  // Too deep: the deepest folders go together into one.
  while (base.parts.length + folders.length > MAX_FOLDERS && folders.length > 1) {
    const last = folders.pop();
    folders[folders.length - 1] = cleanSegment(`${folders.at(-1)}-${last}`);
  }
  if (base.parts.length + folders.length > MAX_FOLDERS) folders = [];
  const prefix = base.storage ? `${base.storage}:` : '';
  let out = `${prefix}${[...base.parts, ...folders, name].join('/')}`;
  if (out.length > MAX_PATH) out = `${prefix}${[...base.parts, `${hash(path)}-${name}`.slice(-MAX_SEGMENT)].join('/')}`;
  return out;
}

/**
 * What to upload: each picture the converted entries point at that the bundle has, once.
 * @param {{ path: string, target: string, available: boolean }[]} refs  convert()'s `assets`
 * @param {{ files: Record<string, { file: string, size: number }> }} bundle
 */
export function uploadPlan(refs, bundle) {
  const plan = [];
  const seen = new Set();
  for (const r of refs) {
    const f = bundle?.files?.[r.path];
    if (!r.available || !f || !r.target || seen.has(r.target)) continue;
    seen.add(r.target);
    plan.push({ from: r.path, file: f.file, size: f.size ?? 0, path: r.target });
  }
  return plan;
}
