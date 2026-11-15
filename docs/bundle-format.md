# Export bundles

An export bundle is one `.zip` holding everything an import needs from a Foundry world: compendium
packs, the pictures their documents use, and the world's translations. The Foundry module
[`foundry-export-module/`](../foundry-export-module) (*Export for Tavern Moot*) writes bundles. The
Tavern Moot module's **Foundry Export** tab reads them, and so does `tools/convert.mjs`.

A bundle replaces mana's Compendium Importer for this workflow and adds what that importer leaves
behind: the pictures and the translations. Its packs are in the importer's format, so the same
[rules files](rules-format.md) convert either.

## Layout

```
tavern-bundle.json                              the manifest (below)
packs/fvtt-Item-pack-world-ose-items.json       one file per compendium, in the Compendium Importer's format
packs/fvtt-Actor-pack-world-ose-creatures.json
lang/en.json                                    the world's translations (game.i18n.translations)
lang/fallback.json                              English, when the world runs another language
files/modules/ose-theholeintheoak/artwork/tokens/hazrad.webp     pictures, at their Foundry paths
files/worlds/my-world/maps/cave.jpg
files/web/example.com/art/dragon.png            pictures at web addresses: files/web/<host>/<path>
```

Readers find files through the manifest, not by these names. Only `tavern-bundle.json` has a fixed
name.

The zip is a plain zip: no zip64, no encryption. JSON is deflated and pictures are stored as they
are. Readers must accept both, and should accept `\` in names, which Windows PowerShell 5 writes.
Without zip64, a bundle holds at most 65,535 files and 4 GB; the exporter refuses to go past that.

## The manifest

```json
{
  "format": "foundry-to-tavern/bundle",
  "version": 1,
  "createdAt": "2026-11-14T22:44:53.000Z",
  "exporter": { "id": "tavern-export", "version": "0.1.0" },
  "source": {
    "world": "dev-ose", "worldTitle": "Dev OSE",
    "system": "ose", "systemTitle": "Old-School Essentials",
    "version": { "core": "14.367", "system": "3.3.0" }
  },
  "packs": [
    { "file": "packs/fvtt-Item-pack-world-ose-items.json", "id": "world.ose-items", "label": "ose-items",
      "type": "Item", "documents": 65, "folders": 7 }
  ],
  "lang": ["lang/en.json"],
  "files": {
    "modules/ose-theholeintheoak/artwork/tokens/hazrad.webp": {
      "file": "files/modules/ose-theholeintheoak/artwork/tokens/hazrad.webp", "size": 48213, "type": "image/webp"
    }
  },
  "left": [
    { "path": "icons/creatures/reptiles/dragon-winged-blue.webp", "reason": "Foundry’s own file, not exported", "uses": 3 },
    { "path": "modules/ose-theholeintheoak/pdf/The_Hole_in_the_Oak.pdf", "reason": "not a picture (Tavern Moot keeps pictures only)", "uses": 1 }
  ]
}
```

| Key         | What it is                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `format`    | Always `"foundry-to-tavern/bundle"`.                                                                                                                                                                               |
| `version`   | `1`. A reader refuses other versions rather than guess.                                                                                                                                                           |
| `createdAt` | When it was exported (ISO 8601).                                                                                                                                                                                   |
| `exporter`  | The Foundry module that wrote it, and its version.                                                                                                                                                                 |
| `source`    | The world, its system and Foundry's version: the same `source` each pack file has, plus titles.                                                                                                                    |
| `packs`     | One entry per pack: the zip `file`, the pack's `id` (collection), `label`, document `type`, and counts.                                                                                                            |
| `lang`      | Translation files, merged in order (later wins): the world's language last.                                                                                                                                        |
| `files`     | Pictures, keyed by **Foundry path** (below): the zip `file`, `size` in bytes, and media `type`. Every key is a picture some document in the bundle points at.                                                      |
| `left`      | Files the documents point at that the bundle doesn't carry, with why: not a picture, Foundry's own, at a web address, not found, larger than 25 MB, empty, or pictures not exported at all. `uses` counts references. |

### Pack files

Each pack file is what mana's Compendium Importer writes for a compendium:

```json
{ "package": "world.ose-items", "metadata": { … }, "type": "Item", "items": [ … ], "source": { … }, "folders": [ … ] }
```

`items` holds the pack's documents as Foundry stores them (`document.toObject()`), embedded
documents included. `folders` holds the pack's folders, also from `toObject()`. Documents keep their
Foundry `_id`, so converted entries get the same ids every time, and importing again replaces what
came before.

### Foundry paths

The keys of `files` and the paths in `left` are file references as documents make them, put in
one form. Both modules do this with the same function (`filePath`), so a reference in a document
finds its picture:

1. Trim it. `data:` and `blob:` URLs are not files.
2. Drop any `?query` or `#fragment`.
3. Decode `%` escapes (`a%20b.webp` → `a b.webp`).
4. Except for web addresses, drop leading `./` and `/`.

`/modules/x/a%20b.webp?v=2` and `modules/x/a b.webp` are therefore the same file.

## What the exporter collects

The exporter walks every document's data, embedded documents included. It takes two kinds of
reference:

- every string that looks like a file path with a known extension (`img`, `texture.src`,
  `background.src`, a page's `src`…);
- every `src`, `href`, `poster` and `data-src` in HTML text.

Pictures (png, jpg, jpeg, webp, gif, avif, svg) go into `files`. Anything else (PDFs, audio,
video) goes into `left`, because Tavern Moot keeps only pictures. The exporter's options decide
the rest:

| Option            | Default | When off                                                                                                                                                                                                              |
| ----------------- | :-----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pictures          |   on    | Nothing goes in `files`.                                                                                                                                                                                              |
| Foundry's own icons |  off  | Files under `icons/`, `ui/`, `cards/` and `sounds/` come with Foundry, not the world, so they stay out unless this is on. Check their licence before using them elsewhere.                                            |
| Web addresses     |   off   | Pictures at `http(s)://` stay out unless this is on. A site may refuse to send them.                                                                                                                                  |
| Translations      |   on    | No `lang` files.                                                                                                                                                                                                       |

## Reading a bundle

What the Foundry Export tab does, for anyone writing another reader:

1. Read the zip's central directory and `tavern-bundle.json`. Check `format` and `version`.
2. Read the chosen `packs` and the `lang` files, and convert the packs by the rules.
3. For each picture a converted document uses (the rules' `asset` transform), look its Foundry
   path up in `files`. Plan its campaign path from the rules' `assets` section.
4. Upload the planned pictures, reading each from the zip only when it's sent:
   `tavern.assets.uploadMany`, in batches.
5. Point the documents at the paths the pictures were stored under, and write the archive.
