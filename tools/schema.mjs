#!/usr/bin/env node
// Put a system's document types into a rules file's "schema", so the widget can check converted
// data against them without the system's tavern.json to hand.
//
//   node tools/schema.mjs <system tavern.json> [module tavern.json …] --into <rules.json> [--types a,b]
//   node tools/schema.mjs <system tavern.json>            (prints the schema)
//
// --types keeps only the types named (with or without the package prefix), to keep the file small.

import fs from 'node:fs';
import { schemaFromManifest } from '../foundry-to-tavern-module/lib/schema.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const into = flag('--into');
const only = flag('--types');
if (!args.length) {
  console.error('usage: node tools/schema.mjs <tavern.json> [more tavern.json…] [--into rules.json] [--types a,b]');
  process.exit(2);
}

let schema = {};
for (const file of args) schema = { ...schema, ...schemaFromManifest(JSON.parse(fs.readFileSync(file, 'utf8'))) };
if (only) {
  const want = new Set(only.split(',').map((s) => s.trim()).filter(Boolean));
  schema = Object.fromEntries(Object.entries(schema).filter(([t]) => want.has(t) || want.has(t.slice(t.indexOf('.') + 1))));
}
// Only what checking needs: labels, layout hints and the like are dropped.
const KEEP = ['key', 'type', 'fields', 'options', 'default', 'min', 'max', 'integer', 'multiline', 'maxRows', 'length'];
const slim = (fields) => fields.map((f) => {
  const out = Object.fromEntries(Object.entries(f).filter(([k]) => KEEP.includes(k)));
  if (out.options) out.options = out.options.map((o) => ({ value: o.value }));
  if (out.fields) out.fields = slim(out.fields);
  return out;
});
for (const def of Object.values(schema)) def.fields = slim(def.fields);

/** JSON that keeps anything short on one line, so a rules file stays readable. */
function inline(value) {
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  if (value && typeof value === 'object') {
    const parts = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`);
    return parts.length ? `{ ${parts.join(', ')} }` : '{}';
  }
  return JSON.stringify(value) ?? 'null';
}
function compact(value, indent = '', width = 110) {
  const flat = inline(value);
  if (typeof value !== 'object' || value === null || flat.length + indent.length <= width) return flat;
  const inner = `${indent}  `;
  if (Array.isArray(value)) return `[\n${value.map((v) => inner + compact(v, inner, width)).join(',\n')}\n${indent}]`;
  return `{\n${Object.entries(value).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${compact(v, inner, width)}`).join(',\n')}\n${indent}}`;
}

if (!into) {
  process.stdout.write(`${compact(schema)}\n`);
} else {
  const rules = JSON.parse(fs.readFileSync(into, 'utf8'));
  rules.schema = schema;
  // The schema goes last: it's generated, and the rules are what people read.
  const { schema: s, ...rest } = rules;
  fs.writeFileSync(into, `${compact({ ...rest, schema: s })}\n`);
  console.log(`${into}: schema for ${Object.keys(schema).length} types (${Object.keys(schema).join(', ')})`);
}
