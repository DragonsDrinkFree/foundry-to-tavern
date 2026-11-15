# Foundry Import (`foundry-to-tavern`)

Two modules that bring FoundryVTT compendiums into Tavern Moot as campaign archives. Folders come
across nested as they were, and with the second route, so do the pictures.

- **[`foundry-to-tavern-module/`](foundry-to-tavern-module)**: the Tavern Moot module. Its
  *Foundry import* widget converts exports into an archive. It has two tabs:
  - **Compendium Importer** takes the JSON files that mana's Compendium Importer writes;
  - **Foundry Export** takes a bundle from the Foundry module below, and also uploads the pictures.
- **[`foundry-export-module/`](foundry-export-module)**: *Export for Tavern Moot*, a Foundry module.
  It exports compendiums, the pictures they use and the world's translations as one `.zip`
  bundle.

The conversion is driven by a **rules file**: JSON that maps Foundry types and fields onto the
campaign system's types and fields. The widget works with any system. Each Foundry system → Tavern
Moot system pairing needs its own rules file, and one rules file serves both tabs.

## Using it

1. **In Foundry**, either:
   - export with *Export for Tavern Moot* (see [its README](foundry-export-module/README.md)), or
   - export with mana's Compendium Importer, which brings no pictures.
2. **In a campaign you run**, open **Modules**, add *Foundry Import*, and allow its widget. Open
   it from the menu bar's **Widgets** menu (*Foundry import*).
3. **Drop the files** on the tab that matches what you exported. Any drop zone recognises each
   file by its content:
   - a **rules file** (see [`rules/`](rules) for examples);
   - a **bundle** (`.zip`), on the Foundry Export tab. Untick any compendiums in it you don't want;
   - **exports** (`fvtt-Item-pack-….json`, `fvtt-Actor-pack-….json`, `fvtt-JournalEntry-….json`),
     on the Compendium Importer tab;
   - optionally, the Foundry system's **lang files**, for rules that resolve localisation keys.
     Dolmenwood's class and kindred traits need them. A bundle brings the world's own;
   - optionally, the target system's **`tavern.json`**, to check the data when the rules don't
     carry a schema.
4. **Read the preview.** It gives counts by pack and by type, the folder tree, and notes on
   anything repaired or left out.
5. **Pictures** (Foundry Export tab). The preview shows how many pictures will be uploaded and to
   which folder. You can change the folder, and what happens when a picture of that name is
   already there. By default a picture that is already there is kept if it's the same picture, so
   importing again sends nothing twice.
6. **Choose the archive:** *A new archive*, or *Add to an archive this campaign has* to update an
   earlier import (the same ids are replaced). Then press **Create archive**. On the Foundry
   Export tab the button reads *Upload pictures and create archive*: the pictures are uploaded
   first, and the documents point at wherever they were stored.
7. **Import what you need** from the archive in the **Archives** window.

**Save to campaign** keeps the rules in the campaign, so next time you can pick them from the list
instead of dropping the file again. Only GMs can make archives and upload pictures. Players can
open the widget and preview a conversion, but can't save it.

Uploading pictures needs a Tavern Moot with `tavern.assets.uploadMany` (TM ADR 0131). Keeping
pictures that are already there needs a server with the `core.asset-upload` feature. On an older
server the widget offers to upload copies instead, or to make the archive without pictures.

## Rule sets included

| File                                                       | From → to                         | Covers                                                                                                   |
| ---------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`rules/dolmenwood-to-osr.json`](rules/dolmenwood-to-osr.json) | Dolmenwood → OSR (`osr` system) | Equipment, spells, holy spells, runes, glamours, classes, kindreds, creatures, journals; their pictures. |
| [`rules/ose-to-osr.json`](rules/ose-to-osr.json)               | OSE → OSR                       | Items and treasure, weapons, armour, containers, spells, monsters with attacks, journals; their pictures. |

To write rules for another system, see [docs/rules-format.md](docs/rules-format.md). The bundle's
format is in [docs/bundle-format.md](docs/bundle-format.md).

## Layout

The two packages are `foundry-to-tavern-module/` (load it in Tavern Moot's Library) and
`foundry-export-module/` (copy it into Foundry's `Data/modules/` as `tavern-export`). Everything
else is development material.

```
foundry-to-tavern-module/
  tavern.json        the module (one widget, one store area for saved rules)
  ui/import.*        the widget page: two tabs, one conversion
  lib/convert.mjs    rules → archive entries (no DOM, no tavern calls: shared by the widget, CLI and tests)
  lib/expr.mjs       the rules file's expression language
  lib/schema.mjs     checking data against a system's fields (a port of TM's normalizeFields)
  lib/text.mjs       HTML → Markdown, Foundry inline rolls/links → embeds, export clean-up
  lib/assets.mjs     Foundry picture paths → campaign file paths, and the upload plan
  lib/bundle.mjs     opening an export bundle
  lib/zip.mjs        reading a zip in the page
foundry-export-module/
  module.json        the Foundry module (v13, v14)
  scripts/main.mjs   sidebar button, context menu, dialog; reads packs and fetches files
  scripts/bundle.mjs builds the bundle (no Foundry globals)
  scripts/zip.mjs    writing a zip
rules/               rule sets (load them in the widget)
tools/convert.mjs    convert exports or a bundle from the command line, or write an archive file
tools/schema.mjs     put a system's types into a rules file's "schema"
test/                engine, fixture and bundle tests, and a headless-Chrome run of the widget
```

## Development

```sh
npm test                 # engine tests, the bundle round trip, and the rule sets against reference/Foundry (skipped if absent)
npm run test:widget      # the widget's two tabs in headless Chrome with a stand-in `tavern` (CHROME=<path> if needed)
node tools/convert.mjs --rules rules/ose-to-osr.json reference/Foundry/fvtt-Item-pack-ose-ose-items.json --schema test/fixtures/osr-tavern.json
node tools/convert.mjs --rules rules/ose-to-osr.json my-bundle.zip --schema test/fixtures/osr-tavern.json
tavern validate foundry-to-tavern-module        # the TM CLI
```

The Foundry module can't be tested outside Foundry, except for `bundle.mjs` and `zip.mjs`, which the
tests run. `main.mjs` was checked against Foundry v14's source, not run in Foundry.

`reference/` holds the sample exports, the Foundry systems and the TM docs. It is not in git.
