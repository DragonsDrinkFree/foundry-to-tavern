// Opening an export bundle from the Foundry module "Export for Tavern Moot" (docs/bundle-format.md):
// its manifest, its packs (the same JSON mana's Compendium Importer writes) and translations read
// now; its pictures and PDFs only when they're uploaded.

import { readExport } from './convert.mjs';
import { readZip } from './zip.mjs';

export const BUNDLE_FORMAT = 'foundry-to-tavern/bundle';
export const BUNDLE_VERSION = 1;
export const MANIFEST = 'tavern-bundle.json';

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {Blob & { name?: string }} file  the dropped zip
 * @returns {Promise<{ name: string, size: number, manifest: object, packs: { name: string, json: object, info: object, meta: object }[], lang: { name: string, json: object }[], files: Record<string, { file: string, size: number, type?: string }>, left: object[], picture(path: string): Promise<Blob> }>}
 */
export async function openBundle(file) {
  const zip = await readZip(file);
  if (!zip.has(MANIFEST)) {
    throw new Error(`not an export bundle (it has no ${MANIFEST}). Export from Foundry with the "Export for Tavern Moot" module; files from mana's Compendium Importer go on the other tab.`);
  }
  let manifest;
  try { manifest = await zip.json(MANIFEST); } catch (err) { throw new Error(`${MANIFEST} is not JSON (${err.message})`); }
  if (!isObject(manifest) || manifest.format !== BUNDLE_FORMAT) throw new Error(`${MANIFEST} is not a bundle manifest`);
  if (manifest.version !== BUNDLE_VERSION) throw new Error(`bundle version ${JSON.stringify(manifest.version)} isn't supported; this module reads version ${BUNDLE_VERSION}. Update the module or the Foundry exporter so they match.`);

  const packs = [];
  for (const meta of Array.isArray(manifest.packs) ? manifest.packs : []) {
    if (!isObject(meta) || typeof meta.file !== 'string' || !zip.has(meta.file)) continue;
    const json = await zip.json(meta.file);
    const name = meta.file.split('/').pop();
    packs.push({ name, json, info: readExport(json, name), meta });
  }
  if (!packs.length) throw new Error('the bundle has no compendiums in it');

  const lang = [];
  for (const l of Array.isArray(manifest.lang) ? manifest.lang : []) {
    if (typeof l === 'string' && zip.has(l)) lang.push({ name: l, json: await zip.json(l) });
  }

  // Only files the zip really has.
  const files = {};
  for (const [path, f] of Object.entries(isObject(manifest.files) ? manifest.files : {})) {
    if (isObject(f) && typeof f.file === 'string' && zip.has(f.file)) files[path] = { file: f.file, size: Number(f.size) || zip.size(f.file), type: typeof f.type === 'string' ? f.type : '' };
  }

  return {
    name: file.name ?? 'bundle.zip',
    size: file.size,
    manifest,
    packs,
    lang,
    files,
    left: Array.isArray(manifest.left) ? manifest.left.filter(isObject) : [],
    /** A picture's or PDF's bytes, by its Foundry path (a slice of the zip: nothing is read yet). */
    picture: (path) => {
      const f = files[path];
      if (!f) return Promise.reject(new Error(`${path} is not in the bundle`));
      return zip.blob(f.file, f.type || '');
    },
  };
}
