// The shipped rule sets against real exports in reference/Foundry (not in git: skipped without them).
// `node --test test/`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileRules, convert } from '../foundry-to-tavern-module/lib/convert.mjs';
import { schemaFromManifest } from '../foundry-to-tavern-module/lib/schema.mjs';
import { mergeLang } from '../foundry-to-tavern-module/lib/text.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(root, ...p);
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const FOUNDRY = at('reference', 'Foundry');
const have = fs.existsSync(FOUNDRY);
const schema = schemaFromManifest(read(at('test', 'fixtures', 'osr-tavern.json')));

/** Converted, with the system's full schema: nothing invalid, nothing unknown, nothing left out. */
function clean(out) {
  assert.deepEqual(out.problems, []);
  const bad = out.notes.filter((n) => n.level === 'warning' || /not a field|out of range|not one of|not a number|not text/.test(n.message));
  assert.deepEqual(bad.map((n) => `${n.message} (${n.examples[0]})`), []);
  const seen = new Set();
  for (const e of out.entries) {
    assert.match(e.id, /^[A-Za-z0-9_-]{8,64}$/);
    assert.ok(!seen.has(e.id), `id ${e.id} once`);
    if (e.parentId) assert.ok(seen.has(e.parentId), `${e.name}: parent first`);
    seen.add(e.id);
  }
}

test('both rule sets compile', () => {
  for (const f of ['dolmenwood-to-osr.json', 'ose-to-osr.json']) compileRules(read(at('rules', f)));
  // Setup steps for the GM, shown under the rules.
  assert.ok(compileRules(read(at('rules', 'dolmenwood-to-osr.json'))).setup.some((step) => /fairy-glamour/.test(step)));
});

test('Dolmenwood → OSR converts every sample document', { skip: !have && 'no reference/Foundry' }, () => {
  const dir = path.join(FOUNDRY, 'dw-item-format');
  const lang = mergeLang(...['en.json', 'en-traits.json', 'en-classes.json', 'en-kindreds.json'].map((f) => read(path.join(FOUNDRY, 'dolmenwood-foundry-system', 'lang', f))));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ name: f, json: read(path.join(dir, f)) }));
  const out = convert(compileRules(read(at('rules', 'dolmenwood-to-osr.json'))), files, { schema, lang });
  clean(out);
  assert.equal(out.packs.reduce((n, p) => n + p.skipped, 0), 0);
  assert.deepEqual(out.stats, {
    'osr.creature': 119, 'osr.class': 14, 'osr.ability': 124, 'osr.item': 108, 'osr.container': 13, 'osr.armor': 7,
    'osr.weapon': 20, 'osr.spell': 144, 'osr.ancestry': 6, 'core.tome': 1, 'core.note': 200,
  });
  const by = (n) => out.entries.find((e) => e.name === n);
  // Traits resolve from the lang files; nothing is left as a key.
  assert.ok(!out.notes.some((n) => /Localisation/.test(n.message)));
  const enchanter = by('Enchanter');
  assert.equal(enchanter.data.levels.length, 15);
  assert.deepEqual(enchanter.data.castings.runes.progression.uses[4], [2, 1, 1]);
  assert.deepEqual(enchanter.data.levels[0], { xp: 0, attack: 0, death: 11, ray: 12, hold: 13, breath: 16, spell: 14 });
  assert.equal(by('Torch (flaming)').data.melee.damage, '1d4');
  // Runes and glamours: spells of their own sources, cast by the campaign's methods (tables.magic).
  const spells = out.entries.filter((e) => e.type === 'osr.spell');
  assert.equal(spells.filter((e) => e.data.sources.includes('glamour')).length, 20);
  assert.equal(spells.filter((e) => e.data.sources.includes('fairy')).length, 18);
  assert.equal(enchanter.data.castings.runes.method, 'fairy-runes');
  assert.deepEqual([enchanter.data.castings.glamours.method, enchanter.data.castings.glamours.source], ['fairy-glamour', 'glamour']);
  assert.deepEqual(enchanter.data.castings.glamours.progression.known.slice(0, 4), [[1], [2], [3], [3]]);
  assert.deepEqual(enchanter.data.castings.glamours.progression.maxLevel.slice(0, 2), [1, 1]);
  assert.equal(by('Magician').data.castings.glamours, undefined);
  // Traits and skills are held by their class or kindred, granted at their level; none loose.
  const holders = new Set(out.entries.filter((e) => e.type === 'osr.class' || e.type === 'osr.ancestry').map((e) => e.id));
  const abilities = out.entries.filter((e) => e.type === 'osr.ability' && !e.data.category?.startsWith('Glamour'));
  assert.ok(abilities.every((a) => holders.has(a.parentId)), 'every trait and skill is inside its class or kindred');
  const knight = by('Knight');
  assert.equal(out.entries.find((e) => e.parentId === knight.id && /hospitality/i.test(e.name)).data.grantLevel, 3);
  assert.ok(out.entries.filter((e) => e.parentId === knight.id).every((e) => e.data.grantLevel >= 1));
  assert.equal(by('Antler Wraith').data.movement.base, 120);
  assert.ok(!/(\w)\1(\w)\2(\w)\3/.test(by('Brambling').data.behaviour.split('\n')[0]), 'doubled text repaired');
  // Each pack's folder (6) and the two packs' own folders (11 each); the journal is a tome.
  assert.equal(out.entries.filter((e) => e.type === 'core.folder').length, 6 + 11 + 11);
  const tome = out.entries.find((e) => e.type === 'core.tome');
  assert.equal(out.entries.filter((e) => e.parentId === tome.id && e.type === 'core.note').length, 200);
});

test('OSE → OSR converts every sample document', { skip: !have && 'no reference/Foundry' }, () => {
  const files = ['fvtt-Item-pack-ose-ose-items.json', 'fvtt-Actor-pack-ose-ose-creatures.json', 'fvtt-JournalEntry-pack-ose-ose-journal.json']
    .map((f) => ({ name: f, json: read(path.join(FOUNDRY, f)) }));
  const out = convert(compileRules(read(at('rules', 'ose-to-osr.json'))), files, { schema });
  clean(out);
  const by = (n) => out.entries.find((e) => e.name === n);
  const hazrad = by('Hazrad the Unholy');
  assert.equal(hazrad.data.attacks[0].attackBonus, 3);
  assert.deepEqual(out.entries.filter((e) => e.parentId === hazrad.id).map((e) => e.type).sort(), ['osr.item', 'osr.spell', 'osr.spell', 'osr.spell', 'osr.spell']);
  // Folder chain: pack folder / The Hole in the Oak / Spells.
  const parents = (e) => { const p = []; for (let c = out.entries.find((x) => x.id === e.parentId); c; c = out.entries.find((x) => x.id === c.parentId)) p.unshift(c.name); return p; };
  const spell = out.entries.find((e) => e.type === 'osr.spell' && parents(e).includes('Spells') && parents(e).includes('The Hole in the Oak'));
  assert.ok(spell, 'a spell inside The Hole in the Oak / Spells');
  assert.equal(by('Silver crown').type, 'osr.treasure');
  // Journals are tomes; their pages are notes held by them, in Foundry's order (by sort, which
  // is how a tome shows pages its layout doesn't list).
  const tomes = out.entries.filter((e) => e.type === 'core.tome');
  assert.equal(tomes.length, 9); // the "PDF" journals keep their text page; the PDF itself stays behind
  const oak = tomes.find((t) => t.name === 'The Hole In the Oak');
  const pages = out.entries.filter((e) => e.parentId === oak.id);
  assert.equal(pages.length, 68);
  assert.ok(pages.every((p) => p.type === 'core.note'));
  assert.ok(pages.filter((p) => p.data.body).length > 60, 'nearly every page has its text');
  const journal = files[2].json.items.find((j) => j.name === 'The Hole In the Oak');
  assert.deepEqual([...pages].sort((a, b) => a.sort - b.sort).map((p) => p.name), [...journal.pages].sort((a, b) => a.sort - b.sort).map((p) => p.name));
  // The tome's layout lists its pages in Foundry's order, by their entry ids (TM ADR 0132).
  const byId = new Map(pages.map((p) => [p.id, p]));
  assert.deepEqual(oak.data.pages.map((p) => byId.get(p.id)?.name), [...journal.pages].sort((a, b) => a.sort - b.sort).map((p) => p.name));
  // Image pages show their picture: there with a bundle, empty-handed without one.
  const art = out.entries.filter((e) => e.parentId === tomes.find((t) => t.name === 'Artwork').id);
  assert.ok(art.length > 5);
  const withPictures = convert(compileRules(read(at('rules', 'ose-to-osr.json'))), files, {
    schema, assets: { files: Object.fromEntries(files[2].json.items.flatMap((j) => j.pages).filter((p) => p.src).map((p) => [p.src, { file: 'x', size: 1 }])) },
  });
  const drawn = withPictures.entries.filter((e) => /^!\[[^\]]*\]\(foundry\/ose\/[^)]+\)/.test(e.data?.body ?? ''));
  assert.ok(drawn.length >= 3, `${drawn.length} image pages draw their picture`);
});

test('an adventure pack unpacks: its documents by their own rules, its folders merged', { skip: !have && 'no reference/Foundry' }, () => {
  const file = path.join(FOUNDRY, 'fvtt-Adventure-pack-ose-hallsofthebloodking-adventure.json');
  if (!fs.existsSync(file)) return;
  const out = convert(compileRules(read(at('rules', 'ose-to-osr.json'))), [{ name: 'adv.json', json: read(file) }], { schema });
  clean(out);
  // Foundry keeps one "Halls of the Blood King" folder per document type; the archive has one.
  const folders = out.entries.filter((e) => e.type === 'core.folder');
  assert.deepEqual(folders.map((f) => f.name), ['Halls of the Blood King']);
  const inFolder = out.entries.filter((e) => e.parentId === folders[0].id);
  for (const t of ['osr.creature', 'osr.weapon', 'core.tome']) assert.ok(inFolder.some((e) => e.type === t), `${t} in the folder`);
  // The adventure itself: a note of its description, at the top.
  const intro = out.entries.find((e) => e.type === 'core.note' && e.name === 'Halls of the Blood King' && !e.parentId);
  assert.ok(intro && intro.data.body.length > 200);
  // Links between the adventure's journal pages and to its actors are links again.
  const ids = new Set(out.entries.map((e) => e.id));
  const links = out.entries.flatMap((e) => [...(e.data.body ?? '').matchAll(/\[\[@([A-Za-z0-9_-]+)/g)].map((m) => m[1]));
  assert.ok(links.length >= 20, `${links.length} links`);
  assert.ok(links.every((l) => ids.has(l)), 'every link names an entry of the import');
  // Scenes and tables have no rules yet: counted, not lost silently.
  assert.equal(out.packs[0].skipped, 10);
  assert.ok(out.notes.some((n) => /^Scene: /.test(n.message) && n.count === 4));
  assert.ok(out.notes.some((n) => /^RollTable: /.test(n.message) && n.count === 6));
});
