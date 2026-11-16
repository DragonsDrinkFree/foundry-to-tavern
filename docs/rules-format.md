# Rules files

A rules file tells the Foundry import widget how to turn one Foundry system's exported documents
into one Tavern Moot system's documents. It is plain JSON. It contains no code, because package
pages may not run code from outside the package.

The same rules serve both of the widget's tabs. *Compendium Importer* reads the JSON files mana's
Compendium Importer writes. *Foundry Export* reads a bundle from this project's Foundry module
([bundle format](bundle-format.md)), whose packs are in the same JSON, plus the pictures the
documents use and the world's translations. Only the `assets` section and the `asset` transform are
about pictures; the rest works the same on either tab.

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
| `description` |          | Shown under the name: what the rules convert, and into what.                                                                                                                 |
| `setup`       |          | What the GM must do in the campaign before importing: text, or a list of steps. Shown under the rules as *Before you import*. See [Setup steps](#setup-steps).               |
| `source`      |          | `{ "systems": ["ose"] }`: the Foundry systems the rules are written for. If an export comes from another system, the widget warns.                                           |
| `target`      |          | `{ "system": "osr" }`: the Tavern Moot system the documents are for. If the campaign runs another system, the widget warns.                                                 |
| `options`     |          | See [Options](#options).                                                                                                                                                     |
| `tables`      |          | Named lookup tables: `{ "saveLabels": { "doom": "Doom" } }`. Used by the `lookup` transform.                                                                                 |
| `partials`    |          | Named pieces of rules, shared with `"use"`. See [Partials](#partials).                                                                                                       |
| `types`       |   yes    | Foundry type → rule, or a list of rules. See [Rules](#rules).                                                                                                                |
| `embedded`    |          | Rules for documents embedded in another (an actor's items), when they differ from `types`. See [Embedded documents](#embedded-documents).                                    |
| `schema`      |          | The target types' field definitions, written by `tools/schema.mjs`. Every converted document is checked against them. See [Checking against the target](#checking-against-the-target). |
| `assets`      |          | Where pictures and PDFs go in the campaign's files, and which to bring. See [Pictures and PDFs](#pictures-and-pdfs).                                                          |

### Setup steps

Some rules need the campaign set up first: a casting method or magic source the system doesn't ship,
a homebrew setting, lang files to load beside the export. Say so in `setup`:

```json
"setup": [
  "In **Campaign settings ▸ Home Brew ▸ Spellcasting**, add a casting method with the key `fairy-glamour`.",
  "Load Dolmenwood's lang files (`en.json`, `en-traits.json`) with the export."
]
```

The widget shows the steps under the rules as soon as they're chosen, numbered when there are
several. The CLI prints them first. Steps may use `**bold**`, `*italics*` and `` `code` ``; nothing
else is formatted, and HTML shows as text.

Keys a campaign may name differently are best kept in a table, so a GM changes them in one place. The
Dolmenwood rules keep their casting methods and sources in `tables.magic` and read them with
`["runeMethod", { "lookup": "magic" }]`.

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
- `lang` looks the value up as a localisation key in the lang files loaded with the import (a
  bundle brings the world's own). It gives nothing if the key isn't found, and the preview counts
  the misses, so add a fallback:
  `[{ "coalesce": [["$nameKey", "lang"], ["$id", "humanize"]] }]`.
- `asset` takes a Foundry file path and gives the campaign path the picture or PDF is uploaded to.
  See [Pictures and PDFs](#pictures-and-pdfs).
- `ref` takes a Foundry `_id` and gives the id of the entry that document became in this import.
  See [Links between documents](#links-between-documents).

**Lookups:**

- `{ "lookup": "tableName" }` or `{ "lookup": { "a": "b" }, "else": E }` gives the table's value.
  Without `else`, a value not in the table passes through unchanged.
- `{ "oneOf": [allowed…], "else": E }` keeps the value only if it is allowed.
- `{ "get": "a.b" }` gives a path into the value.

**Lists:**

- Picking: `length`, `first`, `last`, `{ "at": i }`, `{ "slice": [start, end] }`.
- Reshaping: `compact`, `flatten`, `unique`, `reverse`, `sort`, and `{ "sortBy": "path" }` for a
  list of objects (`{ "sortBy": "sort" }` puts Foundry pages in their order).
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

## Adventures

An Adventure compendium holds whole adventures, each a single Foundry document with its actors,
items, journal entries, scenes, roll tables, macros, cards and playlists inside. The widget
unpacks them before any rule runs:

- **Everything inside** goes through the rules for its own type, as if it came from a compendium
  of its own. A monster uses the `monster` rule, a journal entry the `JournalEntry` rule. Contents
  without a `type` of their own are keyed by their Foundry document name: `JournalEntry`, `Scene`,
  `RollTable`, `Macro`, `Cards`, `Playlist`, `Combat`.
- **The adventure itself** is one more document, keyed `Adventure`, with its collections left out.
  Its `name`, `img`, `caption` and `description` are there for a rule. The shipped rule sets make
  it a note.
- **Folders:** Foundry keeps an adventure's folders apart by document type, so an adventure often
  has one folder of each name per type. An archive's folders aren't split by type, so folders with
  the same name in the same place become one.

## Journals as tomes

A tome (`core.tome`, TM ADR 0104) is a note that holds notes as its pages. To bring a journal
across as one, make the journal a `core.tome` and each page an extra `core.note` held by it:

```json
"JournalEntry": {
  "type": "core.tome",
  "extra": [{ "from": "$pages", "type": "core.note", "data": { "body": ["$text.content", "markdown"] } }]
}
```

A tome's layout, its `sections` and `pages`, names its pages by id. Write the page ids with the
`ref` transform (see [Links between documents](#links-between-documents)), and Foundry's categories
as sections:

```json
"data": {
  "sections": { "map": ["$categories", { "sortBy": "sort" }], "to": { "object": { "id": "$_id", "name": "$name" } } },
  "pages": { "map": ["$pages", { "sortBy": "sort" }], "to": { "object": { "id": ["$_id", "ref"], "section": "$category" } } }
}
```

Tavern Moot carries those ids through an import from ADR 0132 on (the `core.import-refs`
feature). On an older server the widget drops the layout, and the tome shows its pages in their
`sort` order, which each page takes from Foundry by default.

The shipped rule sets do this for every journal with text or image pages:

- a text page keeps its Markdown when Foundry wrote it as Markdown;
- an image page shows its picture (`![name](path)`, through `asset`) and its caption;
- a PDF page becomes a PDF note (below);
- video pages stay behind.

### PDF pages

A PDF note (`core.pdf`, TM ADR 0133) is a PDF from the campaign's files, read in Notes. Its data is
`{ file }`, the PDF's campaign path. A tome holds only notes, so a journal's PDF pages become PDF
notes **beside** its tome, in the journal's folder:

```json
"extra": [{
  "from": ["$pages", { "where": [{ "get": "type" }, { "eq": "pdf" }] }],
  "place": "beside",
  "type": "core.pdf",
  "data": { "file": ["$src", "asset", "nullIfEmpty"] }
}]
```

`nullIfEmpty` leaves `file` out when there is no PDF to upload, which makes an empty PDF note: it
asks for its PDF when opened. A journal with nothing but PDF pages is made a `core.pdf` itself.

The shipped rule sets do both. A PDF page called "PDF" (the OSE modules' habit) takes its
journal's name, or failing that, its file's. The OSE rules also drop the "File Location" page the
OSE modules put beside each PDF: it gives the PDF's place on Foundry's disk.

PDF notes need a server with `core.pdf`; the widget checks. Without it, they're left out, and the
preview says so.

## Links between documents

Foundry text links documents with `@UUID[…]{Label}`. The `markdown` and `embeds` transforms keep
each link, and once every entry is made, it becomes a Tavern Moot link to the entry its document
became: `[[@<entry id>|Label]]`. This works across packs converted together. A link to a document
that isn't in the import keeps only its label, and the preview lists those.

The `ref` transform does the same for a field: `["$system.ownerId", "ref"]` gives the entry id of
the Foundry document with that `_id`, or the `_id` unchanged if it isn't in the import. A system
type with such a field should declare it in its `refs` (TM ADR 0132), so Tavern Moot remaps it on
import.

Both need a server with `core.import-refs`; the widget checks. Without it, links keep only their
label, as they always did.

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
- **Pictures and PDFs** come across only through the `asset` transform, on the Foundry Export tab.
  See [Pictures and PDFs](#pictures-and-pdfs).

## Pictures and PDFs

Foundry documents name their pictures by path (`img`, `prototypeToken.texture.src`,
`background.src`…), and a PDF journal page its PDF (`src`). Those paths mean nothing in a campaign.
The `asset` transform turns one into the campaign path the file is uploaded to:

```json
"data": {
  "img": ["$img", "asset"],
  "portrait": [{ "if": ["$img", { "test": "^icons/" }], "then": "$prototypeToken.texture.src", "else": "$img" }, "asset"]
}
```

The second line uses the token art when the portrait is one of Foundry's stock icons. Everything
below about pictures goes for PDFs too.

**On the Foundry Export tab,** the bundle carries the pictures. The preview shows each document
pointing at where its picture will go. When you create the archive, the widget first uploads every
picture some document uses, each once (`tavern.assets.uploadMany`, TM ADR 0131). It then points
the documents at the paths the pictures were stored under. Those may differ from the planned path
if the server stored a renamed copy. A picture that fails to upload leaves its field empty, and
the status says how many failed. Creating the archive again retries them; pictures already there
are kept, not sent again.

**On the Compendium Importer tab,** there are no pictures to upload. Fields mapped with `asset`
are left empty, unless `"missing": "keep"` (below) points them where the pictures would be.

The `assets` section says where pictures go and which to bring. Every key is optional:

```json
"assets": {
  "folder": "foundry/ose",
  "layout": "paths",
  "exclude": ["icons/svg/"],
  "ifExists": "skip",
  "missing": "drop"
}
```

| Key        | Default      | What it does                                                                                                                                                                                                                                                                                                                       |
| ---------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folder`   | `"foundry"`  | The campaign folder pictures go under. It may start with another storage, as in `"maps-nas:foundry"`. It can be up to 7 folders deep. The widget's Pictures step can change it for one import.                                                                                                                                    |
| `layout`   | `"paths"`    | `"paths"` keeps Foundry's folders under `folder`: `modules/x/art/goblin.webp` becomes `foundry/ose/modules/x/art/goblin.webp`. `"flat"` puts every file straight in `folder`. Two different files with the same name are then kept apart by a suffix.                                                                            |
| `include`  | (everything) | Foundry path beginnings to bring, such as `["modules/", "worlds/"]`.                                                                                                                                                                                                                                                              |
| `exclude`  | (nothing)    | Foundry path beginnings to leave out, such as `["icons/svg/"]` for Foundry's placeholder icons.                                                                                                                                                                                                                                  |
| `ifExists` | `"skip"`     | When a picture of that name is already in the campaign: `"skip"` keeps it if it is the same picture and otherwise stores a renamed copy; `"replace"` writes over it; `"rename"` always stores a copy. `"skip"` and `"replace"` need a server with `core.asset-upload`; on an older one, the widget offers to upload copies instead. The widget's Pictures step can change it. |
| `missing`  | `"drop"`     | A picture there is nothing to upload for: one not in the bundle, one that failed, or any picture on the Compendium Importer tab. `"drop"` leaves the field empty. `"keep"` points it where the picture would be uploaded, for you to upload it there yourself.                                                                  |

Paths are made valid campaign paths as they are planned. Characters a campaign path can't hold
become `-`. A path more than eight folders deep has its deepest folders merged into one. A web
address (`https://host/a/b.png`) goes under `web/host/a/`. Only pictures (png, jpg, webp, gif,
avif, svg, up to 25 MB) and PDFs come across; the preview notes anything else a rule maps with
`asset`, such as audio.

A PDF may be up to 1 GB on a local storage, but a bucket storage takes PDFs up to 100 MB only
(TM ADR 0134). The widget warns when a PDF is larger: choose a `folder` on a local storage for it.
PDFs go up one batch at a time, a large one on its own, with its name in the status. On a server
without `core.pdf`, `asset` gives nothing for a PDF.

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

1. Export a compendium from Foundry, with mana's Compendium Importer or this project's Foundry
   module (a bundle).
2. Read a few documents from it. Their fields are under `system`.
3. Write the rules, starting with `"*": { "skip": "…" }` and adding one type at a time.
4. Run them outside the app:

   ```sh
   node tools/convert.mjs --rules rules/my-rules.json export.json --schema <system>/tavern.json [--lang en.json] [--out archive.json]
   node tools/convert.mjs --rules rules/my-rules.json bundle.zip --schema <system>/tavern.json
   ```

   This prints the counts by type, and every note and problem with examples. With a bundle, it
   also prints the pictures that would be uploaded and where to. Nothing is uploaded from the
   command line. `--out` writes an archive file you can read through, or ship in a package. With
   `--json` you get it all as data, including the planned uploads.

5. Mistakes in the rules file are reported with their location before anything is converted, for
   example: `types.Weapon.data.melee.damage[2]: "trunc" is not a transform (did you mean "truncate"?)`.
