// The engine: expressions, schema checks, and conversion. `node --test test/`
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileExpr, scopeFor } from '../lib/expr.mjs';
import { compileRules, convert, RulesError } from '../lib/convert.mjs';
import { normalize, schemaFromManifest, canHold } from '../lib/schema.mjs';
import { fixDoubled, htmlToMarkdown, humanize } from '../lib/text.mjs';

const ev = (spec, doc = {}, ctx = {}) => compileExpr(spec, 'test')(scopeFor(doc), ctx);
const rules = (types, extra = {}) => compileRules({ format: 'foundry-to-tavern/rules', version: 1, name: 'T', types, ...extra });

test('paths, templates and literals', () => {
  const doc = { name: 'Axe', system: { cost: 5, tags: ['a', 'b'] } };
  assert.equal(ev('$name', doc), 'Axe');
  assert.equal(ev('$system.tags.1', doc), 'b');
  assert.equal(ev('$system.nope.deeper', doc), undefined);
  assert.equal(ev('{{name}} costs {{system.cost}} gp', doc), 'Axe costs 5 gp');
  assert.equal(ev('plain', doc), 'plain');
  assert.deepEqual(ev({ value: ['$x'] }, doc), ['$x']);
  assert.equal(ev(7), 7);
});

test('pipelines and transforms', () => {
  const doc = { system: { w: '50', q: null, s: 'Hello World', list: [3, 1, 2] } };
  assert.equal(ev(['$system.w', 'number', { div: 10 }, { round: 1 }], doc), 5);
  assert.equal(ev(['$system.q', 'int', { default: 1 }], doc), 1);
  assert.equal(ev(['$system.s', 'lower', { replace: ['o', '0'] }], doc), 'hell0 w0rld');
  assert.equal(ev(['$system.s', { test: ['world', 'i'] }], doc), true);
  assert.equal(ev(['$system.s', { match: ['(\\w+) (\\w+)', '', 2] }], doc), 'World');
  assert.deepEqual(ev(['$system.list', 'sort'], doc), [1, 2, 3]);
  assert.equal(ev(['$system.list', 'largest'], doc), 3);
  assert.equal(ev(['$system.list', { includes: 2 }], doc), true);
  assert.equal(ev(['$system.list', { each: [{ mul: 2 }] }, 'sum'], doc), 12);
  assert.deepEqual(ev(['$system.list', { where: [{ gt: 1 }] }], doc), [3, 2]);
  assert.equal(ev(['x', { lookup: { x: 'y' } }]), 'y');
  assert.equal(ev(['z', { lookup: { x: 'y' }, else: 'none' }]), 'none');
  assert.equal(ev(['z', { lookup: 'saves' }], {}, { tables: { saves: { z: 'Zed' } } }), 'Zed');
  assert.equal(ev(['huge', { oneOf: ['small', 'large'], else: 'medium' }]), 'medium');
  assert.equal(ev(['$system.s', { eq: 'Hello World' }, { then: 'yes', else: 'no' }], doc), 'yes');
  assert.equal(ev(['', { template: 'save vs {{.}}' }]), '');
  assert.equal(ev(['Death', { template: 'save vs {{.}}' }]), 'save vs Death');
});

test('operators: if, coalesce, labels, map, zip, object', () => {
  const doc = { name: 'Elf', system: { a: '', b: 'B', saves: { doom: 10, ray: 11 }, xp: [0, 100], atk: [1] } };
  assert.equal(ev({ coalesce: ['$system.a', '$system.b'] }, doc), 'B');
  assert.equal(ev({ if: '$system.a', then: 1, else: 2 }, doc), 2);
  assert.equal(ev({ labels: [['A', '$system.a'], ['B', '$system.b']] }, doc), '**B:** B');
  assert.deepEqual(ev({ map: '$system.saves', row: { label: '$key', n: '$value', who: '$^.name', i: '$#' } }, doc),
    [{ label: 'doom', n: 10, who: 'Elf', i: 0 }, { label: 'ray', n: 11, who: 'Elf', i: 1 }]);
  assert.deepEqual(ev({ zip: { xp: '$system.xp', atk: '$system.atk' } }, doc), [{ xp: 0, atk: 1 }, { xp: 100, atk: 1 }]);
  assert.deepEqual(ev({ object: { 'a.b': 1, 'a.c': '$name', skip: null } }, doc), { a: { b: 1, c: 'Elf' } });
  assert.deepEqual(ev({ map: { range: 3 }, to: ['$', { mul: 10 }] }), [0, 10, 20]);
  assert.equal(ev({ switch: 'b', cases: { a: 1, b: 2 }, default: 3 }), 2);
});

test('mistakes in rules are reported with where they are', () => {
  assert.throws(() => ev(['$x', 'nubmer']), /test\[1\]: "nubmer" is not a transform \(did you mean "number"\?\)/);
  assert.throws(() => ev({ iff: 1 }), /"iff" is not an operator/);
  assert.throws(() => ev({ if: 1, than: 2 }), /unknown key "than"/);
  assert.throws(() => ev('$5 gold'), /is not a path/);
  assert.throws(() => rules({ Weapon: { type: 'Weapon' } }), (e) => e instanceof RulesError && /types\.Weapon: "type" must be/.test(e.message));
  assert.throws(() => rules({ Weapon: { type: 'x.weapon', data: { dmg: ['$a', { mull: 2 }] } } }), /types\.Weapon\.data\.dmg\[1\]/);
  assert.throws(() => rules({ Weapon: { type: 'x.weapon', use: 'nope' } }), /no partial "nope"/);
  assert.throws(() => compileRules({ format: 'other', version: 1, name: 'x', types: {} }), /"format" must be/);
});

test('schema: defaults, repairs and unknown keys', () => {
  const fields = [
    { key: 'n', type: 'number', integer: true, min: 0, max: 10 },
    { key: 'size', type: 'select', options: [{ value: 's' }, { value: 'm' }], default: 'm' },
    { key: 'g', type: 'group', fields: [{ key: 't', type: 'text', max: 3 }] },
    { key: 'rows', type: 'list', fields: [{ key: 'v', type: 'boolean' }] },
    { key: 'img', type: 'image' },
  ];
  const notes = [];
  const out = normalize(fields, { n: 12.4, size: 'huge', g: { t: 'abcdef' }, rows: [{ v: 'yes' }], img: 'icons/x.webp', typo: 1 }, (p, w) => notes.push(`${p}: ${w}`));
  assert.deepEqual({ ...out, rows: out.rows.map((r) => ({ ...r })) }, { n: 10, size: 'm', g: { t: 'abc' }, rows: [{ v: false }], img: 'icons/x.webp', typo: 1 });
  assert.equal(notes.length, 5);
  assert.ok(notes.some((n) => n.startsWith('typo: is not a field')));
  assert.deepEqual(normalize(fields, {}, () => assert.fail('a missing value is not a problem')).size, 'm');
});

test('schema from a manifest, and what may hold what', () => {
  const s = schemaFromManifest({ id: 'x', documentTypes: [
    { name: 'hero', category: 'actor', fields: [] },
    { name: 'bag', category: 'item', contains: ['item'], fields: [] },
    { name: 'sword', category: 'item', fields: [] },
  ] });
  assert.deepEqual(Object.keys(s), ['x.hero', 'x.bag', 'x.sword']);
  assert.ok(canHold(s, 'x.hero', 'x.sword'));
  assert.ok(canHold(s, 'x.bag', 'x.sword'));
  assert.ok(!canHold(s, 'x.sword', 'x.bag'));
});

test('convert: folders, ids, embedded items and extras', () => {
  const pack = {
    package: 'world.test-pack', type: 'Actor', metadata: { label: 'Test Pack', id: 'world.test-pack' },
    folders: [{ _id: 'F1', name: 'Outer', folder: null }, { _id: 'F2', name: 'Inner', folder: 'F1' }, { _id: 'F3', name: 'Empty', folder: null }],
    items: [
      { _id: 'A1', name: 'Goblin', type: 'npc', folder: 'F2', system: { hp: 4, traits: ['Sneaky', 'Small'] },
        items: [{ _id: 'I1', name: 'Knife', type: 'weapon', system: { dmg: 'd4' } }, { _id: 'I2', name: 'Bite', type: 'attack', system: {} }] },
      { _id: 'A2', name: 'Mystery', type: 'vehicle', system: {} },
    ],
  };
  const r = rules({
    npc: { type: 'x.hero', data: { hp: '$system.hp' }, embedded: { except: ['attack'] },
      extra: [{ from: '$system.traits', type: 'x.trait', name: '$', place: 'beside', data: { of: '$~.name' } }] },
    weapon: { type: 'x.sword', data: { damage: '$system.dmg', wielder: '$^.name' } },
  });
  const out = convert(r, [{ name: 'p.json', json: pack }]);
  const byName = Object.fromEntries(out.entries.map((e) => [e.name, e]));
  assert.equal(byName.Inner.parentId, byName.Outer.id);
  assert.ok(byName.Empty, 'folders: "all" keeps empty folders');
  assert.equal(byName.Goblin.parentId, byName.Inner.id);
  assert.equal(byName.Goblin.id, 'world-test-pack-A1');
  assert.equal(byName.Knife.parentId, byName.Goblin.id);
  assert.deepEqual(byName.Knife.data, { damage: 'd4', wielder: 'Goblin' });
  assert.equal(byName.Bite, undefined, 'excluded embedded type');
  assert.equal(byName.Sneaky.parentId, byName.Inner.id, 'extras placed beside sit in the same folder');
  assert.equal(byName.Sneaky.data.of, 'Goblin');
  assert.deepEqual(byName.Goblin.flags['foundry-to-tavern'].source, { pack: 'world.test-pack', id: 'A1', type: 'npc', system: null });
  assert.ok(out.notes.some((n) => /No rule for Foundry type "vehicle"/.test(n.message)));
  // Parents always come before what they hold.
  const seen = new Set();
  for (const e of out.entries) { if (e.parentId) assert.ok(seen.has(e.parentId), `${e.name} after its parent`); seen.add(e.id); }
  // The same input gives the same ids: importing again replaces.
  assert.deepEqual(convert(r, [{ name: 'p.json', json: pack }]).entries.map((e) => e.id), out.entries.map((e) => e.id));
  // Ids are valid TM document ids.
  for (const e of out.entries) assert.match(e.id, /^[A-Za-z0-9_-]{8,64}$/);
});

test('convert: wrap, holders the schema refuses, and rule choice by "when"', () => {
  const json = { type: 'Item', metadata: { label: 'P' }, items: [
    { _id: 'a1', name: 'Gem', type: 'item', system: { treasure: true } },
    { _id: 'a2', name: 'Rope', type: 'item', system: {} },
  ] };
  const r = rules({ item: [{ when: '$system.treasure', type: 'x.gem' }, { type: 'x.gear' }] });
  const out = convert(r, [{ name: 'a.json', json }], { wrap: true });
  assert.equal(out.entries[0].type, 'core.folder');
  assert.equal(out.entries[0].name, 'P');
  assert.deepEqual(out.entries.slice(1).map((e) => [e.name, e.type, e.parentId]), [['Gem', 'x.gem', out.entries[0].id], ['Rope', 'x.gear', out.entries[0].id]]);
  const schema = { 'x.gem': { category: 'item', contains: [], fields: [] }, 'x.gear': { category: 'item', contains: [], fields: [] } };
  const holding = rules({ item: { type: 'x.gear', extra: [{ from: { value: [1] }, type: 'x.gem', name: 'inner' }] } });
  const bad = convert(holding, [{ name: 'a.json', json }], { schema });
  assert.equal(bad.entries.length, 0);
  assert.ok(bad.problems.every((p) => /x.gear can't hold x.gem/.test(p.message)));
});

test('text: markdown, embeds and doubled characters', () => {
  assert.equal(htmlToMarkdown('<p><strong>Range: </strong>30&rsquo;</p><p>Roll [[/r 1d6]]{damage} or @UUID[Item.x]{Sword}.</p>'),
    '**Range:** 30’\n\nRoll @roll[1d6]{damage} or Sword.');
  assert.equal(htmlToMarkdown('<ol><li>One</li><li>Two</li></ol>'), '1. One\n2. Two');
  assert.equal(fixDoubled('55′′ ttaallll tthhiicckkeettss ooff ddrraaggoonnflflyy').text, '5′ tall thickets of dragonfly');
  assert.equal(fixDoubled('A perfectly normal sentence here.').fixed, false);
  assert.equal(humanize('detectMagic'), 'Detect Magic');
});
