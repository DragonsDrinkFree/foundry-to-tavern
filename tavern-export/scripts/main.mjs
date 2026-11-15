// Export for Tavern Moot: compendiums, with their pictures, as one zip for the Foundry Import
// widget's "Foundry Export" tab. GMs only. Everything heavy is in bundle.mjs; this file is the
// Foundry side: the sidebar button and context menu, the dialog, reading packs and fetching files.
//
// For macros: game.modules.get('tavern-export').api.exportPacks(['world.my-items'], { core: true })

import { buildBundle } from './bundle.mjs';

const MODULE_ID = 'tavern-export';
const SETTING = 'lastChoice';

const t = (key, data) => (data ? game.i18n.format(`TAVERN_EXPORT.${key}`, data) : game.i18n.localize(`TAVERN_EXPORT.${key}`));
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ''));

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, SETTING, { scope: 'client', config: false, type: Object, default: {} });
});

Hooks.once('ready', () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = { exportPacks, openExportDialog };
});

// A button in the Compendiums sidebar's header.
Hooks.on('renderCompendiumDirectory', (app, html) => {
  if (!game.user?.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const actions = root?.querySelector('.header-actions');
  if (!actions || actions.querySelector('.tavern-export')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tavern-export';
  btn.innerHTML = `<i class="fa-solid fa-file-export" inert></i> <span>${esc(t('Button'))}</span>`;
  btn.addEventListener('click', () => openExportDialog());
  actions.append(btn);
});

// "Export for Tavern Moot" on a compendium's context menu. v14 reads label/visible/onClick; v13
// reads name/condition/callback; both are given, so neither warns.
const packOf = (li) => (li?.dataset ? li : li?.[0])?.dataset?.pack;
function addContextOption(app, options) {
  if (!game.user?.isGM || options.some((o) => o.tavernExport)) return;
  options.push({
    tavernExport: true,
    label: 'TAVERN_EXPORT.ContextOption',
    name: 'TAVERN_EXPORT.ContextOption',
    icon: '<i class="fa-solid fa-file-export"></i>',
    visible: (li) => !!game.packs.get(packOf(li)),
    condition: (li) => !!game.packs.get(packOf(li)),
    onClick: (event, li) => openExportDialog([packOf(li)]),
    callback: (li) => openExportDialog([packOf(li)]),
  });
}
Hooks.on('getCompendiumContextOptions', addContextOption);
Hooks.on('getCompendiumDirectoryEntryContext', addContextOption);

/** The dialog: which packs, and what goes with them. */
export async function openExportDialog(preselected = null) {
  if (!game.user?.isGM) return ui.notifications.warn(t('GMOnly'));
  const last = game.settings.get(MODULE_ID, SETTING) ?? {};
  const chosen = new Set(preselected?.filter(Boolean) ?? last.packs ?? []);
  const groups = new Map();
  for (const pack of game.packs) {
    const kind = pack.metadata.packageType;
    const key = kind === 'world' ? t('Group.World') : `${pack.metadata.packageName} (${kind})`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pack);
  }
  const order = [...groups.keys()].sort((a, b) => (a === t('Group.World') ? -1 : b === t('Group.World') ? 1 : a.localeCompare(b)));
  const list = order.map((g) => `
    <fieldset class="tavern-export-group"><legend>${esc(g)}</legend>
      ${groups.get(g).sort((a, b) => a.metadata.label.localeCompare(b.metadata.label)).map((p) => `
        <label class="tavern-export-pack">
          <input type="checkbox" name="pack" value="${esc(p.collection)}" ${chosen.has(p.collection) ? 'checked' : ''}>
          <span class="label">${esc(p.metadata.label)}</span>
          <span class="meta">${esc(game.i18n.has(`DOCUMENT.${p.documentName}`) ? game.i18n.localize(`DOCUMENT.${p.documentName}`) : p.documentName)} · ${p.index.size}</span>
        </label>`).join('')}
    </fieldset>`).join('');
  const opt = (name, on, label, hint) => `
    <label class="tavern-export-option"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}> ${esc(label)}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</label>`;
  const date = new Date().toISOString().slice(0, 10);
  const content = `
    <div class="tavern-export-dialog">
      <p class="hint">${esc(t('Dialog.Hint'))}</p>
      <div class="tavern-export-packs">${list || `<p>${esc(t('Dialog.NoPacks'))}</p>`}</div>
      ${opt('pictures', last.pictures ?? true, t('Option.Pictures'), t('Option.PicturesHint'))}
      ${opt('core', last.core ?? false, t('Option.Core'), t('Option.CoreHint'))}
      ${opt('remote', last.remote ?? false, t('Option.Remote'), t('Option.RemoteHint'))}
      ${opt('translations', last.translations ?? true, t('Option.Translations'), t('Option.TranslationsHint'))}
      <label class="tavern-export-file">${esc(t('Option.FileName'))}
        <input type="text" name="fileName" value="${esc(`tavern-${game.world.id}-${date}.zip`)}">
      </label>
    </div>`;
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: t('Dialog.Title'), icon: 'fa-solid fa-file-export' },
    position: { width: 520 },
    content,
    buttons: [
      {
        action: 'export', label: t('Dialog.Export'), icon: 'fa-solid fa-file-export', default: true,
        callback: (event, button) => {
          const f = button.form.elements;
          const packs = [...button.form.querySelectorAll('input[name=pack]:checked')].map((i) => i.value);
          return { packs, pictures: f.pictures.checked, core: f.core.checked, remote: f.remote.checked, translations: f.translations.checked, fileName: f.fileName.value };
        },
      },
      { action: 'cancel', label: t('Dialog.Cancel'), icon: 'fa-solid fa-xmark' },
    ],
    rejectClose: false,
  });
  if (!choice || typeof choice !== 'object') return;
  if (!choice.packs.length) return ui.notifications.warn(t('NoneChosen'));
  const { fileName, ...remember } = choice;
  await game.settings.set(MODULE_ID, SETTING, remember);
  try {
    await exportPacks(choice.packs, { ...choice, download: true });
  } catch (err) {
    console.error(`${MODULE_ID} |`, err);
    ui.notifications.error(t('Failed', { error: err?.message ?? String(err) }));
  }
}

/** A file's bytes from the Foundry server (or, for web addresses, the web), or null if it's not there. */
async function fetchFile(path) {
  const remote = /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
  const url = remote ? path : foundry.utils.getRoute(path.split('/').map(encodeURIComponent).join('/'));
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.blob();
}

/**
 * Export packs as a bundle. Returns { blob, manifest }; with `download`, also saves it.
 * @param {string[]} ids  pack ids (`world.my-items`, `dolmenwood.creatures`…)
 * @param {{ pictures?: boolean, core?: boolean, remote?: boolean, translations?: boolean, download?: boolean, fileName?: string }} [opts]
 */
export async function exportPacks(ids, opts = {}) {
  const packs = ids.map((id) => {
    const p = game.packs.get(id);
    if (!p) throw new Error(t('NoPack', { id }));
    return p;
  });
  const bar = ui.notifications.info(t('Progress.Reading'), { progress: true });
  const step = (pct, message) => bar?.update?.({ pct: Math.min(0.99, pct), message });
  try {
    const data = [];
    for (const [i, pack] of packs.entries()) {
      step(0.3 * (i / packs.length), t('Progress.Pack', { label: pack.metadata.label }));
      const documents = await pack.getDocuments();
      data.push({
        collection: pack.collection,
        metadata: foundry.utils.deepClone(pack.metadata),
        documentName: pack.documentName,
        documents: documents.map((d) => d.toObject()),
        folders: [...(pack.folders ?? [])].map((f) => f.toObject()),
      });
    }
    const module = game.modules.get(MODULE_ID);
    const { blob, manifest } = await buildBundle({
      packs: data,
      source: { world: game.world.id, system: game.system.id, version: { core: game.version, system: game.system.version } },
      titles: { world: game.world.title, system: game.system.title },
      exporter: { id: MODULE_ID, version: module?.version ?? '0.0.0' },
      i18n: opts.translations === false ? null : { lang: game.i18n.lang, translations: game.i18n.translations, fallback: game.i18n._fallback },
      options: { pictures: opts.pictures ?? true, core: !!opts.core, remote: !!opts.remote },
      fetchFile,
      onProgress: ({ stage, done, total }) => {
        if (stage === 'files') step(0.3 + 0.65 * (done / Math.max(1, total)), t('Progress.Files', { done, total }));
      },
    });
    bar?.update?.({ pct: 1, message: t('Progress.Done') });
    const files = Object.keys(manifest.files).length;
    const documents = manifest.packs.reduce((n, p) => n + p.documents, 0);
    if (opts.download !== false) {
      const name = (String(opts.fileName ?? '').trim() || `tavern-${game.world.id}.zip`).replace(/[\\/:*?"<>|]+/g, '-');
      saveBlob(blob, name.toLowerCase().endsWith('.zip') ? name : `${name}.zip`);
    }
    ui.notifications.info(t('Done', { packs: manifest.packs.length, documents, files, left: manifest.left.length, size: megabytes(blob.size) }));
    if (manifest.left.length) console.info(`${MODULE_ID} | files left out of the bundle:`, manifest.left);
    return { blob, manifest };
  } catch (err) {
    bar?.remove?.();
    throw err;
  }
}

const megabytes = (n) => (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0);

function saveBlob(blob, fileName) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
