// The shipped rule sets against real exports in reference/Foundry (not in git: skipped without them).
// `node --test test/`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileRules, convert } from '../lib/convert.mjs';
import { schemaFromManifest } from '../lib/schema.mjs';
import { mergeLang } from '../lib/text.mjs';

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
});

test('Dolmenwood → OSR converts every sample document', { skip: !have && 'no reference/Foundry' }, () => {
  const dir = path.join(FOUNDRY, 'dw-item-format');
  const lang = mergeLang(...['en.json', 'en-traits.json', 'en-classes.json', 'en-kindreds.json'].map((f) => read(path.join(FOUNDRY, 'dolmenwood-foundry-system', 'lang', f))));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ name: f, json: read(path.join(dir, f)) }));
  const out = convert(compileRules(read(at('rules', 'dolmenwood-to-osr.json'))), files, { schema, lang });
  clean(out);
  assert.equal(out.packs.reduce((n, p) => n + p.skipped, 0), 0);
  assert.deepEqual(out.stats, {
    'osr.creature': 119, 'osr.class': 14, 'osr.ability': 144, 'osr.item': 108, 'osr.container': 13, 'osr.armor': 7,
    'osr.weapon': 20, 'osr.spell': 124, 'osr.ancestry': 6, 'core.folder': 1, 'core.note': 200,
  });
  const by = (n) => out.entries.find((e) => e.name === n);
  // Traits resolve from the lang files; nothing is left as a key.
  assert.ok(!out.notes.some((n) => /Localisation/.test(n.message)));
  const enchanter = by('Enchanter');
  assert.equal(enchanter.data.levels.length, 15);
  assert.deepEqual(enchanter.data.castings.runes.progression.uses[4], [2, 1, 1]);
  assert.deepEqual(enchanter.data.levels[0], { xp: 0, attack: 0, death: 11, ray: 12, hold: 13, breath: 16, spell: 14 });
  assert.equal(by('Torch (flaming)').data.melee.damage, '1d4');
  assert.equal(by('Antler Wraith').data.movement.base, 120);
  assert.ok(!/(\w)\1(\w)\2(\w)\3/.test(by('Brambling').data.behaviour.split('\n')[0]), 'doubled text repaired');
  // Each pack's folder (6), the two packs' own folders (11 each), and the journal's: all there.
  assert.equal(out.entries.filter((e) => e.type === 'core.folder').length, 6 + 11 + 11 + 1);
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
});
