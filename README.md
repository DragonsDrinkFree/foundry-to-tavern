# Foundry Import (`foundry-to-tavern`)

A Tavern Moot module that converts compendiums exported from FoundryVTT, using mana's Compendium
Importer, into campaign archives. Folders come across nested as they were.

The conversion is driven by a **rules file**: JSON that maps Foundry types and fields onto the
campaign system's types and fields. The module works with any system, and each Foundry system →
Tavern Moot system pairing needs its own rules file.

## Using it

1. In a campaign you run, open **Modules**, add *Foundry Import*, and allow its widget.
2. Open it from the menu bar's **Widgets** menu (*Foundry import*).
3. Drop the files onto the drop zone. The widget recognises each one by its content:
   - a **rules file** (see [`rules/`](rules) for examples);
   - one or more **exports** (`fvtt-Item-pack-….json`, `fvtt-Actor-pack-….json`,
     `fvtt-JournalEntry-….json`);
   - optionally, the Foundry system's **lang files**, for rules that resolve localisation keys
     (Dolmenwood's class and kindred traits need them);
   - optionally, the target system's **`tavern.json`**, to check the data when the rules don't
     carry a schema.
4. Read the preview. It gives counts by pack and by type, the folder tree, and notes on anything
   repaired or left out.
5. Choose **A new archive**, or **Add to an archive this campaign has** to update an earlier
   import (the same ids are replaced). Then press **Create archive**.
6. Import what you need from the archive in the **Archives** window.

**Save to campaign** keeps the rules in the campaign, so next time you can pick them from the list
instead of dropping the file again. Only GMs can make archives. Players can open the widget and
preview a conversion, but can't save it.

## Rule sets included

| File                                                       | From → to                         | Covers                                                                                    |
| ---------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| [`rules/dolmenwood-to-osr.json`](rules/dolmenwood-to-osr.json) | Dolmenwood → OSR (`osr` system) | Equipment, spells, holy spells, runes, glamours, classes, kindreds, creatures, journals.  |
| [`rules/ose-to-osr.json`](rules/ose-to-osr.json)               | OSE → OSR                       | Items and treasure, weapons, armour, containers, spells, monsters with attacks, journals. |

To write rules for another system, see [docs/rules-format.md](docs/rules-format.md).

## Layout

```
tavern.json          the module (one widget, one store area for saved rules)
ui/import.*          the widget page
lib/convert.mjs      rules → archive entries (no DOM, no tavern calls: shared by the widget, CLI and tests)
lib/expr.mjs         the rules file's expression language
lib/schema.mjs       checking data against a system's fields (a port of TM's normalizeFields)
lib/text.mjs         HTML → Markdown, Foundry inline rolls/links → embeds, export clean-up
rules/               rule sets (not part of the package; load them in the widget)
tools/convert.mjs    convert from the command line, or write an archive file
tools/schema.mjs     put a system's types into a rules file's "schema"
test/                engine and fixture tests, and a headless-Chrome run of the widget
```

## Development

```sh
npm test                 # engine tests, plus the rule sets against reference/Foundry (skipped if absent)
npm run test:widget      # the widget in headless Chrome with a stand-in `tavern` (CHROME=<path> if needed)
node tools/convert.mjs --rules rules/ose-to-osr.json reference/Foundry/fvtt-Item-pack-ose-ose-items.json --schema test/fixtures/osr-tavern.json
tavern validate .        # the TM CLI
```

`reference/` holds the sample exports, the Foundry systems and the TM docs. It is not in git.
