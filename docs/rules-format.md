# Rules files

A rules file tells the Foundry import widget how to turn one Foundry system's exported documents
into one Tavern Moot system's documents. It is plain JSON. It contains no code, because package
pages may not run code from outside the package.

Two complete examples ship in [`rules/`](../rules):

- [`dolmenwood-to-osr.json`](../rules/dolmenwood-to-osr.json) covers items, classes with level tables
  and spellcasting, traits resolved from lang files, creatures and journals.
- [`ose-to-osr.json`](../rules/ose-to-osr.json) covers monsters whose embedded weapons become attack
  rows, treasure split from gear, nested folders and multi-page journals.

## A minimal file

```json
{
  "format": "foundry-to-tavern/rules",
  "version": 1,
  "name": "OSE → My System",
  "source": { "systems": ["ose"] },
  "target": { "system": "mysys" },
  "types": {
    "weapon": {
      "type": "mysys.weapon",
      "data": {
        "damage": "$system.damage",
        "cost": ["$system.cost", "number", { "default": 0 }],
        "description": ["$system.description", "markdown"]
      }
    },
    "*": { "skip": "not converted yet" }
  }
}
```

Each Foundry document whose `type` is `weapon` becomes a `mysys.weapon`. Its name comes from
Foundry's `name`, and its `data` holds the three fields shown. Documents of every other type are
left out, and the preview counts them.

## Top level

| Key           | Required | What it is                                                                                                                                                                   |
| ------------- | :------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`      |   yes    | Always `"foundry-to-tavern/rules"`.                                                                                                                                          |
| `version`     |   yes    | Always `1`.                                                                                                                                                                  |
| `name`        |   yes    | Shown in the widget, and the default archive name when several packs are converted.                                                                                          |
| `id`          |          | A short id. The widget saves the rules under it in the campaign.                                                                                                             |
| `description` |          | Shown under the name. Say which lang files the rules need, if any.                                                                                                           |
| `source`      |          | `{ "systems": ["ose"] }`: the Foundry systems the rules are written for. If an export comes from another system, the widget warns.                                           |
| `target`      |          | `{ "system": "osr" }`: the Tavern Moot system the documents are for. If the campaign runs another system, the widget warns.                                                 |
| `options`     |          | See [Options](#options).                                                                                                                                                     |
| `tables`      |          | Named lookup tables: `{ "saveLabels": { "doom": "Doom" } }`. Used by the `lookup` transform.                                                                                 |
| `partials`    |          | Named pieces of rules, shared with `"use"`. See [Partials](#partials).                                                                                                       |
| `types`       |   yes    | Foundry type → rule, or a list of rules. See [Rules](#rules).                                                                                                                |
| `embedded`    |          | Rules for documents embedded in another (an actor's items), when they differ from `types`. See [Embedded documents](#embedded-documents).                                    |
| `schema`      |          | The target types' field definitions, written by `tools/schema.mjs`. Every converted document is checked against them. See [Checking against the target](#checking-against-the-target). |

### Options

| Key        | Default | What it does                                                                                                                                                  |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folders`  | `"all"` | `"all"` keeps every folder in the export, including empty ones. `"used"` keeps only folders that hold something. `"none"` puts every document at the top.      |
| `wrap`     | (auto)  | `true` puts each pack in a folder named for it. Without it, packs are wrapped only when several are converted at once. The widget has a checkbox for this.     |
| `idPrefix` | (pack)  | Starts every entry id. By default ids start with the pack's id (`world.ose-items` gives `world-ose-items-…`).                                                  |
| `access`   | `"gm"`  | The widget's default for who may browse a new archive: `"gm"` or `"everyone"`.                                                                                |

## Rules

A rule turns one Foundry document into one Tavern Moot document, and can add more documents around
it.

| Key        | What it does                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`     | **Required.** The Tavern Moot type, e.g. `"osr.weapon"`. `"core.note"` and `"core.folder"` also work.                                                        |
| `name`     | An expression for the name. The default is `"$name"`.                                                                                                        |
| `data`     | A map from a target field path to an expression (see below).                                                                                                 |
| `when`     | An expression. When the type has a list of rules, the first rule whose `when` is true (or that has no `when`) is used.                                       |
| `skip`     | `true`, or a reason string: documents matching this rule are left out deliberately. The preview lists them with the reason.                                  |
| `use`      | One partial's name, or a list of names, merged in before this rule's own keys.                                                                               |
| `vars`     | Named values worked out before `data`, and read as `"$:name"`. Each var can use the ones before it.                                                          |
| `sort`     | An expression for the sort order. The default is Foundry's `"$sort"`.                                                                                        |
| `folder`   | An expression giving a folder path such as `"Spells/Level 3"`. Folders are made as needed inside the place the document would otherwise go.                  |
| `embedded` | What to do with the Foundry document's embedded items: `"hold"` (the default), `"skip"`, `{ "only": [types] }` or `{ "except": [types] }`.                    |
| `extra`    | Further documents made from lists inside this one. See [Extras](#extras).                                                                                    |
| `note`     | Free text for whoever reads the file. It is ignored.                                                                                                         |

`"*"` in `types` is the fallback for any Foundry type that has no rule of its own. A document is
matched by its `type`. Journal entries have no `type`, so they are matched by the pack's type,
`"JournalEntry"`.

### `data`

Keys are **dot paths** into the target document's data, and values are expressions:

```json
"data": {
  "qualities.melee": true,
  "melee.damage": "$system.damage",
  "missile.rangeShort": ["$system.range.short", "number", { "default": 0 }]
}
```

If an expression gives nothing (`null`, or a missing value), the field is left out and the target
system's default applies. Write `""` or `0` when you want an empty value instead.

### Partials

Rule pieces shared between rules:

```json
"partials": {
  "physical": { "data": { "quantity": ["$system.quantity", "int", { "default": 1 }], "weight": "$system.weight" } }
},
"types": {
  "Item": { "type": "osr.item", "use": "physical" },
  "Weapon": { "type": "osr.weapon", "use": "physical", "data": { "melee.damage": "$system.damage" } }
}
```

Partials are merged in the order listed, and the rule's own keys come last. Within `vars` and
`data`, individual keys merge, so the rule's own keys win. `extra` lists are joined together, and
any other key is replaced. A partial can itself `use` other partials.

### Embedded documents

Foundry actors carry their items inside them (`items`). Each embedded item is converted by its own
rule and **held** by the converted actor: its entry's `parentId` is the actor's entry. A rule for an
embedded item is found in `embedded` first, then in `types`, then in `"*"`.

Inside an embedded item's rule, `$` is the item, and `$^` is the actor that holds it:

```json
"embedded": {
  "weapon": { "type": "osr.weapon", "data": { "attackBonus": ["$system.bonus", { "add": "$^.system.thac0.bba" }] } }
}
```

When some embedded items should become rows on the actor instead, read them in the actor's own
`data` and exclude them from being held:

```json
"monster": {
  "type": "osr.creature",
  "embedded": { "except": ["weapon", "ability"] },
  "data": {
    "attacks": { "map": "$items", "where": ["$type", { "eq": "weapon" }], "row": { "attackName": "$name", "attackDamage": "$system.damage" } }
  }
}
```

If the target's schema says the holder can't hold a type (its `contains`), that embedded item is
left out and the preview says so.

### Extras

`extra` makes more documents from a list inside the document. Examples are a class's traits as
ability documents, and a journal's pages as notes.

```json
"extra": [
  {
    "from": "$system.traits",
    "place": "beside",
    "type": "osr.ability",
    "name": "$name",
    "data": { "category": "{{~.name}} traits", "description": ["$description", "markdown"] }
  }
]
```

- `from` is an expression for the list. An object counts as a list of `{ "key", "value" }` entries.
- `place` is `"held"` (the default) to put the new document inside this one, or `"beside"` to put
  it in the same folder.
- An extra takes the same keys as any rule, except `skip`. Inside it, `$` is the list element,
  `$#` is its index, `$~` is the Foundry document, and `$^` is the rule's scope (so `$^.name` is
  the document's name).
- A `when` on an extra skips individual elements.

When the rule's own `type` is `"core.folder"`, held extras go inside that folder. This is how a
journal entry with several pages becomes a folder of notes:

```json
"JournalEntry": [
  {
    "when": ["$pages", { "where": [{ "get": "type" }, { "eq": "text" }] }, "length", { "gt": 1 }],
    "type": "core.folder",
    "extra": [{ "from": ["$pages", { "where": [{ "get": "type" }, { "eq": "text" }] }], "type": "core.note", "data": { "body": ["$text.content", "markdown"] } }]
  },
  { "type": "core.note", "data": { "body": ["$pages", "first", { "get": "text.content" }, "markdown"] } }
]
```

## Expressions

An expression is one of the following:

| Written as                    | Means                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `null`, `12`, `true`          | Itself.                                                                            |
| `"$system.cost"`              | A value from the document (see [Paths](#paths)).                                   |
| `"{{name}} ({{system.lvl}})"` | A template: each `{{path}}` is filled in, and a missing value becomes `""`.        |
| `"any other text"`            | Itself.                                                                            |
| `[E, T, T, …]`                | A **pipeline**: the value of `E`, passed through each transform `T` in turn.       |
| `{ "op": … }`                 | An [operator](#operators).                                                         |

A literal list or object must be wrapped: `{ "value": ["melee"] }`. A bare list is read as a
pipeline, and a bare object as an operator. Any string starting with `$` is read as a path, so
write `{ "value": "$5" }` for the literal text.

### Paths

| Path           | Is                                                                                 |
| -------------- | ---------------------------------------------------------------------------------- |
| `$`            | The current value: the document, or the element being mapped.                     |
| `$a.b.0.c`     | A path into it. Numbers index into lists.                                          |
| `$~`, `$~.a`   | The Foundry document being converted, from anywhere.                               |
| `$^`, `$^.a`   | The scope around this one. Repeat it to go further out: `$^.^.a`.                  |
| `$#`           | The index of the element being mapped.                                             |
| `$:name`       | A variable from the rule's `vars`.                                                 |

Template paths work the same way, without the `$`: `"{{~.name}} ({{:group}})"`.

### Operators

| Operator                                                       | Gives                                                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `{ "value": x }`                                               | `x`, as written.                                                                                                              |
| `{ "path": "a.b" }` / `{ "template": "…" }`                    | The same as `"$a.b"` / a template string.                                                                                     |
| `{ "if": E, "then": E, "else": E }`                            | `then` if the condition is true, otherwise `else` (by default nothing). Empty text, `0`, `[]` and `{}` count as false.        |
| `{ "switch": E, "cases": { "a": E }, "default": E }`           | The case named by the value.                                                                                                  |
| `{ "coalesce": [E, …] }`                                       | The first value that isn't empty (`null`, missing or `""`).                                                                   |
| `{ "all": [E, …] }` / `{ "any": [E, …] }` / `{ "not": E }`     | `true` or `false`.                                                                                                            |
| `{ "list": [E, …] }`                                           | A list of the values.                                                                                                         |
| `{ "object": { "a.b": E } }`                                   | An object, built like `data`.                                                                                                 |
| `{ "join": [E, …], "sep": "\n\n" }`                            | The non-empty values as text, joined by `sep`. Useful for descriptions.                                                       |
| `{ "labels": [["Range", E], …] }`                              | `**Range:** 30'` lines, skipping empty values. Takes `"format"` (default `"**{label}:** {value}"`) and `"sep"` (default a blank line). |
| `{ "map": E, "to": E }` / `{ "map": E, "row": { … } }`         | Each element of a list, with `$` set to the element. `row` builds an object like `data`. `"where": E` keeps only some elements. |
| `{ "zip": { "col": E, … }, "length": …, "fill": … }`           | Lists side by side, as rows. See below.                                                                                       |
| `{ "range": E }`                                               | `[0, 1, …, n-1]`.                                                                                                             |

`zip` turns parallel lists into rows, as level-by-level class tables need:

```json
"levels": {
  "map": { "zip": { "xp": "$system.xpThresholds", "attack": "$system.attackProgression" } },
  "row": { "xp": ["$xp", "int"], "attack": ["$attack", "int", { "default": 0 }] }
}
```

`length` is `"longest"` (the default), `"shortest"` or a number. When a list runs out, its last
value is repeated, unless `fill` gives another value.

### Transforms

A transform is written as a name (`"int"`) or as `{ "name": argument }`. Arguments marked **E** are
expressions, so `{ "add": "$^.system.bonus" }` works.

**Types:** `string`, `number`, `int` (rounds toward zero), `boolean` (`"no"`, `"false"`, `"0"` and
`""` are false), `array` (a single value becomes `[value]`; nothing becomes `[]`), `json`,
`parseJson`.

**Missing values:**

- `{ "default": E }` replaces an empty value (`null`, missing, `""` or `NaN`).
- `{ "defaultIfZero": E }` also replaces `0`.
- `nullIfEmpty` turns `""` and `[]` into nothing.

**Numbers:**

- Arithmetic, where each argument is **E**: `add`, `sub`, `mul`, `div`, `mod`.
- Limits: `atLeast` and `atMost` (each **E**), and `{ "clamp": [lo, hi] }`.
- Rounding: `{ "round": digits }`, `floor`, `ceil`. Also `abs`.

**Text:**

- Case: `trim`, `lower`, `upper`, `capitalize`, `title`.
- `humanize` turns `detectMagic` into `Detect Magic`.
- `{ "prefix": E }` and `{ "suffix": E }` add text, skipping empty values.
- `{ "template": "save vs {{.}}" }` formats the value; paths inside it are into the value.
- `{ "truncate": n }` cuts the text to `n` characters.
- `{ "replace": [pattern, with, flags] }` uses a regular expression; flags default to `"g"`.
- `{ "match": pattern }` or `{ "match": [pattern, flags, group] }` gives the matched text.
- `{ "test": pattern }` gives `true` or `false`.
- `{ "split": "," }` gives a list.

**Foundry text:**

- `markdown` turns Foundry's HTML into Markdown. Inline rolls (`[[/r 1d6]]`) become `@roll[1d6]`,
  and document links keep only their label.
- `stripHtml` gives plain text.
- `embeds` converts only the inline syntax.
- `fixDoubled` repairs text where every character was doubled (`ttaallll` becomes `tall`), a fault
  seen in some exports. The preview counts each repair.
- `lang` looks the value up as a localisation key in the lang files loaded with the import. It
  gives nothing if the key isn't found, and the preview counts the misses, so add a fallback:
  `[{ "coalesce": [["$nameKey", "lang"], ["$id", "humanize"]] }]`.

**Lookups:**

- `{ "lookup": "tableName" }` or `{ "lookup": { "a": "b" }, "else": E }` gives the table's value.
  Without `else`, a value not in the table passes through unchanged.
- `{ "oneOf": [allowed…], "else": E }` keeps the value only if it is allowed.
- `{ "get": "a.b" }` gives a path into the value.

**Lists:**

- Picking: `length`, `first`, `last`, `{ "at": i }`, `{ "slice": [start, end] }`.
- Reshaping: `compact`, `flatten`, `unique`, `reverse`, `sort`.
- Objects: `keys`, `values`, and `entries` (which gives a list of `{ key, value }`).
- Totals: `sum`, `largest`, `smallest`.
- `{ "join": ", " }` joins the list into text.
- `{ "each": T or [T…] }` runs the transforms on each element.
- `{ "where": T or [T…] }` keeps the elements the transforms say yes to.
- `{ "find": T or [T…] }` gives the first such element.
- `{ "includes": E }` gives `true` or `false`.

**Tests:**

- Comparisons, each **E**: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`. When one side is a number, both
  are compared as numbers.
- `{ "in": [values] }` checks membership.
- `not`, `truthy`, `empty` and `present` check the value itself.
- `{ "then": E, "else": E }` picks a value by the test before it:
  `["$system.type", { "eq": "shield" }, { "then": "shield", "else": "armor" }]`.

## Folders, ids and importing again

- **Folders** are copied from the export with their nesting (Foundry's `folders` and each
  document's `folder`). They become `core.folder` entries, parents first.
- **Ids** are stable. An entry id is built from the pack's id and the Foundry document's `_id`
  (`world-ose-items-1gFcW0jXwrbyDxbZ`). Extras and embedded documents add a suffix to their
  holder's id. Converting the same pack with the same rules always gives the same ids.
- **Importing again.** Choose *Add to an archive this campaign has* and pick the earlier archive.
  An entry with the same id **replaces** the old one, and new entries are added. Entries no longer
  in the export are **not** removed.
- **Where each entry came from:** `flags["foundry-to-tavern"].source` gives
  `{ pack, id, type, system }`, plus `embedded`, or `extra` and `index`, for documents that weren't
  top-level.
- **Pictures** aren't copied, since Foundry's image paths don't exist in the campaign. To keep
  them, map them yourself:
  `"img": ["$img", { "prefix": "foundry/" }]`. Then upload the images to `foundry/…` in the
  campaign's storage.

## Checking against the target

Archives store entries as they are given. Tavern Moot checks them only later, when someone imports
from the archive into the campaign (TM ADR 0112). The widget therefore checks every document
against the target types' field definitions first. It fills in defaults and repairs what it can,
the way Tavern Moot itself would:

- numbers out of range are clamped;
- text that is too long is cut;
- a select value that isn't one of the options gets the field's default;
- an image path that isn't valid is removed.

It reports each repair. A key that isn't a field of the type is kept, but reported as a warning,
because it is nearly always a typo in the rules.

The schema comes from one of two places:

- **In the rules file:** `node tools/schema.mjs <system>/tavern.json --into rules/my-rules.json --types weapon,armor,item`
  puts the types in `"schema"`, keeping only what checking needs.
- **At import time:** drop the system's `tavern.json` on the widget with the export.

Without a schema, nothing is checked, and the preview warns.

## Writing and testing rules

1. Export a compendium from Foundry with mana's Compendium Importer.
2. Read a few documents from it. Their fields are under `system`.
3. Write the rules, starting with `"*": { "skip": "…" }` and adding one type at a time.
4. Run them outside the app:

   ```sh
   node tools/convert.mjs --rules rules/my-rules.json export.json --schema <system>/tavern.json [--lang en.json] [--out archive.json]
   ```

   This prints the counts by type, and every note and problem with examples. `--out` writes an
   archive file you can read through, or ship in a package. With `--json` you get it all as data.

5. Mistakes in the rules file are reported with their location before anything is converted, for
   example: `types.Weapon.data.melee.damage[2]: "trunc" is not a transform (did you mean "truncate"?)`.
