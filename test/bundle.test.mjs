// The two halves together: tavern-export builds a bundle (zip), foundry-to-tavern-module
// opens it, converts it with pictures, and plans the uploads. Runs on the reference OSE exports
// (skipped without them) with made-up picture bytes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildBundle, collectFiles, filePath as foundryFilePath, MANIFEST } from '../tavern-export/scripts/bundle.mjs';
import { crc32, ZipWriter } from '../tavern-export/scripts/zip.mjs';
import { compileAssets, filePath, parseFolder, targetPath, uploadPlan } from '../foundry-to-tavern-module/lib/assets.mjs';
import { openBundle } from '../foundry-to-tavern-module/lib/bundle.mjs';
import { compileRules, convert, RulesError } from '../foundry-to-tavern-module/lib/convert.mjs';
import { schemaFromManifest } from '../foundry-to-tavern-module/lib/schema.mjs';
import { readZip } from '../foundry-to-tavern-module/lib/zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(root, ...p);
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const FOUNDRY = at('reference', 'Foundry');
const have = fs.existsSync(FOUNDRY);

test('zip: what the writer writes, the reader reads', async () => {
  const z = new ZipWriter();
  const json = JSON.stringify({ hello: 'world', list: Array.from({ length: 200 }, (_, i) => i) });
  const pic = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  await z.add('packs/a.json', json, { deflate: true });
  await z.add('files/modules/x/Gob lin é.webp', new Blob([pic]));
  await assert.rejects(z.add('packs/a.json', '{}'), /already/);
  const zip = await readZip(z.finish());
  assert.deepEqual(zip.names.sort(), ['files/modules/x/Gob lin é.webp', 'packs/a.json']);
  assert.equal(await zip.text('packs/a.json'), json);
  assert.deepEqual(new Uint8Array(await (await zip.blob('files/modules/x/Gob lin é.webp')).arrayBuffer()), pic);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  await assert.rejects(readZip(new Blob(['not a zip at all, just text'])), /not a zip/);
});

test('zip: a large Blob goes in as itself, its CRC read a slice at a time', async () => {
  // Over 16 MB: more than one slice. A PDF's bytes are never all held at once.
  const big = new Uint8Array(17 * 1024 * 1024 + 5);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 9)) & 0xff;
  const z = new ZipWriter();
  await z.add('files/a.pdf', new Blob([big]));
  const out = z.finish();
  const head = new DataView(await out.slice(0, 30).arrayBuffer());
  assert.equal(head.getUint32(14, true), crc32(big));
  assert.equal(head.getUint32(18, true), big.length);
  const back = new Uint8Array(await (await (await readZip(out)).blob('files/a.pdf')).arrayBuffer());
  assert.equal(back.length, big.length);
  assert.equal(crc32(back), crc32(big));
});

test('picture paths: Foundry references to campaign paths', () => {
  // Both modules key files the same way.
  for (const ref of ['/modules/x/a%20b.webp?v=2', './worlds/w/token.png', 'https://example.com/i/x.png', 'data:image/png;base64,AAAA', '']) {
    assert.equal(filePath(ref), foundryFilePath(ref));
  }
  assert.equal(filePath('/modules/x/a%20b.webp?v=2'), 'modules/x/a b.webp');
  const a = compileAssets({ folder: 'foundry/ose' });
  assert.equal(targetPath('modules/x/y.webp', a), 'foundry/ose/modules/x/y.webp');
  assert.equal(targetPath('a/b/c/d/e/f/g/h/i.png', a), 'foundry/ose/a/b/c/d/e/f-g-h/i.png');
  assert.equal(targetPath('a/what?.png'.replace('?', ':'), a), 'foundry/ose/a/what-.png');
  assert.equal(targetPath('x.pdf', a), 'foundry/ose/x.pdf');
  assert.equal(targetPath('a/b.ogg', a), null);
  assert.equal(targetPath('deep/dir/z.png', compileAssets({ folder: 'nas:imports', layout: 'flat' })), 'nas:imports/z.png');
  assert.equal(parseFolder('../up'), null);
  assert.throws(() => compileAssets({ folder: 'a/../b' }), RulesError);
  assert.throws(() => compileAssets({ ifExist: 'skip' }), /unknown key "ifExist"/);
  // Files the documents point at, in fields and in HTML.
  const found = collectFiles({ img: 'icons/a.svg', system: { description: '<p><img src="worlds/w/map.jpg"> and <a href="x.pdf">a</a></p>' }, n: 'Plain text.' });
  assert.deepEqual([...found.keys()].sort(), ['icons/a.svg', 'worlds/w/map.jpg', 'x.pdf']);
  assert.equal(found.get('x.pdf').kind, 'pdf');
});

test('convert: the asset transform, with and without pictures to upload', () => {
  const rules = compileRules({
    format: 'foundry-to-tavern/rules', version: 1, name: 'T',
    assets: { folder: 'imports', exclude: ['icons/svg/'], layout: 'flat' },
    types: { thing: { type: 'x.thing', data: { img: ['$img', 'asset'] } } },
  });
  const docs = [
    { _id: 'aaaaaaaaaaaaaaa1', name: 'One', type: 'thing', img: 'worlds/w/one/pic.webp' },
    { _id: 'aaaaaaaaaaaaaaa2', name: 'Two', type: 'thing', img: 'worlds/w/two/pic.webp' }, // same name: kept apart
    { _id: 'aaaaaaaaaaaaaaa3', name: 'Three', type: 'thing', img: 'icons/svg/mystery-man.svg' },
    { _id: 'aaaaaaaaaaaaaaa4', name: 'Four', type: 'thing', img: 'worlds/w/gone.png' },
  ];
  const files = [{ name: 'p.json', json: { type: 'Item', items: docs, folders: [] } }];
  const img = (out) => out.entries.map((e) => e.data.img);
  // No pictures to upload (the Compendium Importer tab): fields are emptied, and that's noted.
  const plain = convert(rules, files);
  assert.deepEqual(img(plain), ['', '', '', '']);
  assert.ok(plain.notes.some((n) => /don.t carry/.test(n.message)));
  // A bundle with three of them: the planned paths, the two pic.webp kept apart.
  const bundle = { files: { 'worlds/w/one/pic.webp': { file: 'f1', size: 1 }, 'worlds/w/two/pic.webp': { file: 'f2', size: 1 }, 'icons/svg/mystery-man.svg': { file: 'f3', size: 1 } } };
  const planned = convert(rules, files, { assets: { files: bundle.files } });
  assert.equal(img(planned)[0], 'imports/pic.webp');
  assert.match(img(planned)[1], /^imports\/pic \([a-z0-9]+\)\.webp$/);
  assert.deepEqual(img(planned).slice(2), ['', '']); // excluded by the rules; not in the bundle
  assert.ok(planned.notes.some((n) => n.level === 'warning' && /bundle doesn.t have \(not found in Foundry\)/.test(n.message)));
  const why = convert(rules, files, { assets: { files: bundle.files, left: { 'worlds/w/gone.png': 'Foundry’s own file, not exported' } } });
  assert.ok(why.notes.some((n) => n.level === 'info' && /own file, not exported/.test(n.message)));
  const plan = uploadPlan(planned.assets, bundle);
  assert.deepEqual(plan.map((p) => p.from), ['worlds/w/one/pic.webp', 'worlds/w/two/pic.webp']);
  // After uploading: the stored paths (one was renamed by the server, one failed).
  const stored = new Map([['worlds/w/one/pic.webp', 'imports/pic (2).webp']]);
  const after = convert(rules, files, { assets: { files: bundle.files, stored } });
  assert.deepEqual(img(after), ['imports/pic (2).webp', '', '', '']);
  assert.ok(after.notes.some((n) => /could not be uploaded/.test(n.message)));
  // "missing": "keep" points at where it would be instead.
  const keep = compileRules({ ...JSON.parse(JSON.stringify({ format: 'foundry-to-tavern/rules', version: 1, name: 'T', types: { thing: { type: 'x.thing', data: { img: ['$img', 'asset'] } } } })), assets: { missing: 'keep' } });
  assert.equal(convert(keep, files).entries[3].data.img, 'foundry/worlds/w/gone.png');
});

test('a bundle from the Foundry module, opened and converted by the widget’s code', { skip: !have && 'no reference/Foundry' }, async () => {
  const exports = ['fvtt-Item-pack-ose-ose-items.json', 'fvtt-Actor-pack-ose-ose-creatures.json', 'fvtt-JournalEntry-pack-ose-ose-journal.json'].map((f) => read(path.join(FOUNDRY, f)));
  const packs = exports.map((x) => ({ collection: x.package, metadata: x.metadata, documentName: x.type, documents: x.items, folders: x.folders }));
  const fetched = [];
  const { blob, manifest } = await buildBundle({
    packs,
    source: exports[0].source,
    exporter: { id: 'tavern-export', version: 'test' },
    i18n: { lang: 'en', translations: { OSE: { Hello: 'Hello' } } },
    fetchFile: async (p) => {
      fetched.push(p);
      if (p.includes('hazrad')) return null; // one missing in Foundry
      if (p.endsWith('.pdf')) return new Blob([new TextEncoder().encode(`%PDF-1.7 ${p}`)], { type: 'application/pdf' });
      return new Blob([new TextEncoder().encode(`picture:${p}`)], { type: 'image/webp' });
    },
  });
  // Foundry's own icons stay behind by default; everything else was fetched, the PDFs too.
  assert.ok(!fetched.some((p) => p.startsWith('icons/')));
  const pdfPaths = Object.keys(manifest.files).filter((p) => p.endsWith('.pdf'));
  assert.equal(pdfPaths.length, 3);
  assert.equal(manifest.files[pdfPaths[0]].type, 'application/pdf');
  assert.ok(!manifest.left.some((l) => /\.pdf$/.test(l.path)));
  assert.ok(manifest.left.some((l) => /hazrad/.test(l.path) && l.reason === 'not found'));
  assert.equal(manifest.packs.length, 3);

  const file = Object.assign(blob, { name: 'tavern-dev-ose.zip' });
  const bundle = await openBundle(file);
  assert.equal(bundle.packs.length, 3);
  assert.equal(bundle.lang[0].json.OSE.Hello, 'Hello');
  // The packs inside are what mana's exporter writes: the same rules convert them the same way.
  const rules = compileRules(read(at('rules', 'ose-to-osr.json')));
  const schema = schemaFromManifest(read(at('test', 'fixtures', 'osr-tavern.json')));
  const direct = convert(rules, exports.map((json, i) => ({ name: `f${i}.json`, json })), { schema });
  const out = convert(rules, bundle.packs.map((p) => ({ name: p.name, json: p.json })), { schema, assets: { files: bundle.files } });
  assert.equal(out.entries.length, direct.entries.length);
  assert.deepEqual(out.entries.map((e) => e.id), direct.entries.map((e) => e.id));
  // Pictures: planned under the rules' folder, read back from the zip byte for byte.
  const plan = uploadPlan(out.assets, bundle);
  assert.ok(plan.length > 50, `${plan.length} pictures planned`);
  assert.ok(plan.every((p) => p.path.startsWith('foundry/ose/')));
  const giant = out.entries.find((e) => e.name === 'Giant Lizard Man Figment');
  assert.equal(giant.data.portrait, 'foundry/ose/modules/ose-theholeintheoak/artwork/tokens/giant_lizard_man_figment.Token.webp');
  const one = plan.find((p) => p.from === 'modules/ose-theholeintheoak/artwork/tokens/giant_lizard_man_figment.Token.webp');
  assert.equal(await (await bundle.picture(one.from)).text(), `picture:${one.from}`);
  // The PDFs: each a PDF note pointing where its file goes, planned as a PDF, read back whole.
  const pdfPlan = plan.filter((p) => p.kind === 'pdf');
  assert.equal(pdfPlan.length, 3);
  assert.deepEqual(out.entries.filter((e) => e.type === 'core.pdf').map((e) => e.data.file).sort(), pdfPlan.map((p) => p.path).sort());
  assert.equal(await (await bundle.picture(pdfPlan[0].from)).text(), `%PDF-1.7 ${pdfPlan[0].from}`);
  assert.equal(out.entries.find((e) => e.name === 'Hazrad the Unholy').data.portrait, '');
  // The manifest is in the zip under its name, as the format says.
  assert.ok((await readZip(file)).has(MANIFEST));
});
