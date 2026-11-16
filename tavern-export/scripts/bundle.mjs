// Building an export bundle (docs/bundle-format.md): compendium packs as mana's Compendium
// Importer writes them, the pictures and PDFs they use, and the world's translations, in one zip. No Foundry
// globals here: main.mjs gathers the packs and fetches files, and the tests run this in Node.

import { ZipWriter } from './zip.mjs';

export const BUNDLE_FORMAT = 'foundry-to-tavern/bundle';
export const BUNDLE_VERSION = 1;
export const MANIFEST = 'tavern-bundle.json';
/** Tavern Moot's limit for one picture. */
export const FILE_MAX_BYTES = 25 * 1024 * 1024;
/** And for one PDF (TM ADR 0134: 1 GB on a local storage; a bucket storage takes 100 MB). */
export const PDF_MAX_BYTES = 1024 * 1024 * 1024;

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg']);
// Files documents point at that Tavern Moot can't keep (pictures and PDFs only): listed, not sent.
const OTHER_EXT = new Set(['webm', 'mp4', 'm4v', 'ogv', 'ogg', 'oga', 'mp3', 'wav', 'flac', 'm4a', 'opus', 'aac', 'bmp', 'tif', 'tiff']);
const MEDIA_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml', pdf: 'application/pdf' };
const kindOf = (ext) => (IMAGE_EXT.has(ext) ? 'image' : ext === 'pdf' ? 'pdf' : OTHER_EXT.has(ext) ? 'other' : null);

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
export const isRemote = (p) => SCHEME_RE.test(p);
/** Foundry's own files (its icons, UI art, card faces, sounds), which come with Foundry rather than the world. */
export const isCore = (p) => /^(icons|ui|cards|sounds)\//.test(p);
export const extOf = (p) => /\.([a-z0-9]+)$/i.exec(p)?.[1].toLowerCase() ?? '';

/**
 * A file reference as documents write it, as a path: no query or fragment, %-escapes decoded, no
 * leading "/" or "./". Web addresses stay whole. null for data: and blob: URLs and nothing.
 * The Tavern Moot module's lib/assets.mjs has the same function; the bundle's `files` are keyed by it.
 */
export function filePath(ref) {
  let s = String(ref ?? '').trim();
  if (!s || /^(data|blob):/i.test(s)) return null;
  s = s.replace(/[?#].*$/, '');
  try { s = decodeURI(s); } catch { /* a stray %: keep it as written */ }
  if (!isRemote(s)) s = s.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  return s || null;
}

const LOOKS_LIKE_FILE = /^[^\s<>"'`]+\.[a-z0-9]{2,5}(?:[?#][^\s]*)?$/i;
const SRC_RE = /\b(?:src|href|poster|data-src)\s*=\s*(["'])(.*?)\1/gi;

/**
 * Every file the documents point at: fields holding a path (`img`, `texture.src`, a page's `src`…)
 * and `src`/`href` in HTML text. Map of path → { path, kind: 'image'|'pdf'|'other', uses }.
 */
export function collectFiles(value, found = new Map()) {
  const consider = (ref) => {
    const path = filePath(ref);
    if (!path) return;
    const kind = kindOf(extOf(path));
    if (!kind) return;
    const f = found.get(path) ?? { path, kind, uses: 0 };
    f.uses++;
    found.set(path, f);
  };
  const walk = (v, depth) => {
    if (depth > 64 || v == null) return;
    if (typeof v === 'string') {
      if (v.length < 1024 && LOOKS_LIKE_FILE.test(v)) consider(v);
      else if (v.includes('<')) for (const m of v.matchAll(SRC_RE)) consider(m[2]);
    } else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(value, 0);
  return found;
}

const slug = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pack';

/** A pack as mana's Compendium Importer writes it: what the import rules read. */
export function packExport(pack, source) {
  return {
    package: pack.collection,
    metadata: pack.metadata ?? {},
    type: pack.documentName,
    items: pack.documents,
    source,
    folders: pack.folders ?? [],
  };
}
export const packFileName = (pack) => `fvtt-${pack.documentName}-pack-${slug(pack.collection)}.json`;

/** Where a file goes in the zip: its Foundry path (web addresses under `web/<host>/`). */
function zipPathFor(path) {
  if (!isRemote(path)) return `files/${path}`;
  try {
    const u = new URL(path);
    return `files/web/${u.host}${u.pathname}`;
  } catch {
    return `files/web/${slug(path)}`;
  }
}

async function pool(items, size, fn) {
  let next = 0;
  const run = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

/**
 * The bundle, as a zip Blob, and its manifest.
 * @param {object} input
 * @param {{ collection: string, metadata: object, documentName: string, documents: object[], folders: object[] }[]} input.packs
 *   each pack's documents and folders as plain data (`toObject()`)
 * @param {{ world: string, system: string, version: { core: string, system: string } }} input.source
 * @param {{ id: string, version: string }} input.exporter
 * @param {(path: string) => Promise<Blob|null>} input.fetchFile  a file's bytes, or null if it isn't there
 * @param {{ lang: string, translations: object, fallback?: object }} [input.i18n]  the world's translations
 * @param {{ world?: string, system?: string }} [input.titles]
 * @param {{ pictures?: boolean, pdfs?: boolean, core?: boolean, remote?: boolean }} [input.options]
 *   pictures, pdfs: send them at all; core: Foundry's own icons too; remote: files at web addresses too
 * @param {(p: { stage: string, done: number, total: number, label?: string }) => void} [input.onProgress]
 */
export async function buildBundle({ packs, source, exporter, fetchFile, i18n = null, titles = {}, options = {}, onProgress = () => {} }) {
  const opts = { pictures: true, pdfs: true, core: false, remote: false, ...options };
  const zip = new ZipWriter();
  const manifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    exporter,
    source: { ...source, ...(titles.world ? { worldTitle: titles.world } : {}), ...(titles.system ? { systemTitle: titles.system } : {}) },
    packs: [],
    lang: [],
    files: {},
    left: [],
  };

  const found = new Map();
  for (const [i, pack] of packs.entries()) {
    onProgress({ stage: 'packs', done: i, total: packs.length, label: pack.metadata?.label ?? pack.collection });
    const file = `packs/${packFileName(pack)}`;
    await zip.add(file, JSON.stringify(packExport(pack, source)), { deflate: true });
    manifest.packs.push({
      file,
      id: pack.collection,
      label: String(pack.metadata?.label ?? pack.collection),
      type: pack.documentName,
      documents: pack.documents.length,
      folders: (pack.folders ?? []).length,
    });
    collectFiles(pack.documents, found);
  }

  // Translations, so rules that resolve localisation keys need no lang files dropped beside.
  if (i18n?.translations && Object.keys(i18n.translations).length) {
    const code = String(i18n.lang || 'en').replace(/[^A-Za-z0-9_-]/g, '') || 'en';
    if (i18n.fallback && Object.keys(i18n.fallback).length && code !== 'en') {
      await zip.add('lang/fallback.json', JSON.stringify(i18n.fallback), { deflate: true });
      manifest.lang.push('lang/fallback.json');
    }
    await zip.add(`lang/${code}.json`, JSON.stringify(i18n.translations), { deflate: true });
    manifest.lang.push(`lang/${code}.json`);
  }

  // Pictures and PDFs: fetched a few at a time (PDFs, which may be large, one at a time), written
  // to the zip one at a time.
  const todo = [];
  for (const f of [...found.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const leave = (reason) => manifest.left.push({ path: f.path, reason, uses: f.uses });
    if (f.kind === 'other') leave('not a picture or PDF (Tavern Moot keeps only those)');
    else if (f.kind === 'image' && !opts.pictures) leave('pictures not exported');
    else if (f.kind === 'pdf' && !opts.pdfs) leave('PDFs not exported');
    else if (isRemote(f.path) && !opts.remote) leave('at a web address, not exported');
    else if (isCore(f.path) && !opts.core) leave('Foundry’s own file, not exported');
    else todo.push(f);
  }
  let written = Promise.resolve();
  let done = 0;
  const total = todo.length;
  const fetchOne = async (f) => {
    let blob = null;
    let why = 'not found';
    try { blob = await fetchFile(f.path); } catch (err) { why = `could not be read (${err?.message ?? err})`; }
    const add = async () => {
      if (!blob) manifest.left.push({ path: f.path, reason: why, uses: f.uses });
      else if (!blob.size) manifest.left.push({ path: f.path, reason: 'empty', uses: f.uses });
      else if (f.kind === 'image' && blob.size > FILE_MAX_BYTES) manifest.left.push({ path: f.path, reason: 'larger than 25 MB', uses: f.uses });
      else if (f.kind === 'pdf' && blob.size > PDF_MAX_BYTES) manifest.left.push({ path: f.path, reason: 'larger than 1 GB', uses: f.uses });
      else {
        const name = zipPathFor(f.path);
        if (!zip.has(name)) await zip.add(name, blob);
        manifest.files[f.path] = { file: name, size: blob.size, type: MEDIA_TYPES[extOf(f.path)] ?? blob.type ?? '' };
      }
      onProgress({ stage: 'files', done: ++done, total, label: f.path });
    };
    written = written.then(add);
    await written;
  };
  await pool(todo.filter((f) => f.kind === 'image'), 6, fetchOne);
  await pool(todo.filter((f) => f.kind === 'pdf'), 1, fetchOne);
  await written;

  manifest.left.sort((a, b) => a.path.localeCompare(b.path));
  await zip.add(MANIFEST, JSON.stringify(manifest, null, 1), { deflate: true });
  return { blob: zip.finish(), manifest };
}
