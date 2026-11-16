# Export for Tavern Moot (`tavern-export`)

A Foundry VTT module (v13 and v14) that exports compendiums for Tavern Moot. It saves one `.zip`
bundle holding:

- the compendiums, in the same JSON as mana's Compendium Importer;
- the pictures and PDFs their documents use;
- the world's translations.

Drop the bundle on the **Foundry Export** tab of Tavern Moot's *Foundry Import* widget,
with a rules file for the system. The widget uploads the pictures and PDFs to the campaign's files
and makes an archive of the documents, folders and all.

## Installing

Copy this folder into Foundry's `Data/modules/` as `tavern-export` (the folder name must match the
`id` in `module.json`). Then enable *Export for Tavern Moot* in the world's **Manage Modules**.

## Exporting

As a GM, either:

- press **Export for Tavern Moot** at the top of the **Compendiums** sidebar, or
- right-click a compendium and choose **Export for Tavern Moot**. It starts with that one ticked.

Tick the compendiums to export, then choose what goes with them:

| Option                     | Default | What it does                                                                                                         |
| -------------------------- | :-----: | -------------------------------------------------------------------------------------------------------------------- |
| Pictures                   |   on    | The pictures the documents use: portraits, icons, tokens, scene backgrounds, pictures in journal text.               |
| PDFs                       |   on    | PDFs the journals show (a module's adventure, a handout), up to 1 GB each. They become PDF notes in Tavern Moot.     |
| Foundry's own icons        |   off   | Files under `icons/` and `ui/`, which come with Foundry. Check their licence before using them elsewhere.            |
| Pictures at web addresses  |   off   | Pictures the documents link from the web. Some sites refuse to send them.                                             |
| Translations               |   on    | The world's text in its language, so rules that read localisation keys need no lang files dropped beside the bundle. |

Then press **Export**. A progress bar shows each step, and the browser saves the zip.

The widget only uploads files that some converted document uses, so leaving pictures and PDFs on
costs nothing beyond the zip's size. Files Tavern Moot can't keep (audio, video, pictures over
25 MB, PDFs over 1 GB) are listed in the bundle as left out, and in the browser console.

A module's PDFs can be large. The bundle has no zip64, so it holds at most 4 GB: export fewer
compendiums at a time, or leave PDFs off, if it gets there.

## From a macro

```js
const { blob, manifest } = await game.modules.get('tavern-export').api.exportPacks(
  ['world.ose-items', 'world.ose-creatures'],
  { pictures: true, pdfs: true, core: false, remote: false, translations: true, download: true, fileName: 'ose.zip' },
);
```

`download: false` returns the zip without saving it.

## Files

```
module.json
scripts/main.mjs     the sidebar button, context menu and dialog; reads packs, fetches files
scripts/bundle.mjs   builds the bundle (no Foundry globals: the tests run it in Node)
scripts/zip.mjs      a small zip writer
lang/en.json
styles/export.css
```

The bundle's format is in [docs/bundle-format.md](../docs/bundle-format.md).
