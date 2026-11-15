// The Foundry import widget: rules + exports in, a campaign archive out (TM ADR 0112).
// Two tabs, one conversion: "Compendium Importer" takes the JSON exports mana's module writes;
// "Foundry Export" takes the zip bundle our Foundry module writes, whose pictures are uploaded to
// the campaign's files (TM ADR 0131) before the archive is written. Everything is converted here,
// in the page, by lib/convert.mjs.
import { ASSET_MAX_BYTES, parseFolder, UPLOAD_BATCH, uploadPlan } from '../lib/assets.mjs';
import { openBundle } from '../lib/bundle.mjs';
import { compileRules, convert, readExport, RULES_FORMAT, slug } from '../lib/convert.mjs';
import { schemaFromManifest } from '../lib/schema.mjs';
import { mergeLang } from '../lib/text.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) e.append(k);
  return e;
};
const api = typeof tavern === 'undefined' ? null : tavern;
const STORE_AREA = 'rules';
const STORE_SOFT_MAX = 400_000;

const state = {
  mode: 'ci', // 'ci': Compendium Importer exports; 'fe': a Foundry Export bundle
  rules: null, // { json, compiled, key, saved }
  exports: [], // { name, json, info }
  bundle: null, // openBundle(), plus `chosen`: the pack files to convert
  lang: [], // { name, json }
  manifests: [], // { name, json }
  saved: {}, // key -> { name, savedAt, rules }
  system: null,
  isGm: true,
  result: null,
  busy: false,
};

// ---- reading files ----

const readText = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error ?? new Error('could not read the file'));
  r.readAsText(file);
});

/** What a JSON file is, by its shape. */
function classify(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return 'unknown';
  if (json.format === RULES_FORMAT) return 'rules';
  if (Array.isArray(json.documentTypes) && typeof json.id === 'string') return 'manifest';
  if (Array.isArray(json.items) || Array.isArray(json.pages) || (json._id && json.name && (json.system || json.type))) return 'export';
  const values = Object.values(json);
  if (values.length && values.every((v) => typeof v === 'string' || (v && typeof v === 'object' && !Array.isArray(v)))) return 'lang';
  return 'unknown';
}

const isZip = (file) => /\.zip$/i.test(file.name) || /zip/.test(file.type);

async function addFiles(fileList) {
  const problems = [];
  let switchTo = null;
  for (const file of fileList) {
    if (isZip(file)) {
      say('Opening the bundle…');
      try {
        const bundle = await openBundle(file);
        bundle.chosen = new Set(bundle.packs.map((p) => p.meta.file));
        state.bundle = bundle;
        switchTo = 'fe';
        say('');
      } catch (err) { problems.push(`${file.name}: ${err.message}`); say(''); }
      continue;
    }
    let json;
    try { json = JSON.parse(await readText(file)); }
    catch (err) { problems.push(`${file.name}: not JSON (${err.message})`); continue; }
    const kind = classify(json);
    if (kind === 'rules') useRules(json, { key: null, saved: false, name: file.name });
    else if (kind === 'manifest') replaceByName(state.manifests, { name: file.name, json });
    else if (kind === 'lang') replaceByName(state.lang, { name: file.name, json });
    else if (kind === 'export') {
      let info;
      try { info = readExport(json, file.name); } catch (err) { problems.push(`${file.name}: ${err.message}`); continue; }
      replaceByName(state.exports, { name: file.name, json, info });
      switchTo ??= 'ci';
    } else problems.push(`${file.name}: not a rules file, Foundry export, bundle, tavern.json or lang file`);
  }
  if (problems.length) notify(problems.join('\n'), 'warning');
  if (switchTo && switchTo !== state.mode) setMode(switchTo, false);
  refresh();
}

function replaceByName(list, item) {
  const i = list.findIndex((x) => x.name === item.name);
  if (i >= 0) list[i] = item; else list.push(item);
}

function notify(text, level = 'info') {
  if (api?.ui?.notify) api.ui.notify(text, level).catch(() => {});
  else console.warn(text);
}

// ---- tabs ----

function setMode(mode, again = true) {
  state.mode = mode;
  for (const tab of document.querySelectorAll('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
  $('panel-ci').hidden = mode !== 'ci';
  $('panel-fe').hidden = mode !== 'fe';
  if (again) refresh();
}
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => setMode(tab.dataset.mode));

// ---- rules ----

function useRules(json, { key, saved, name }) {
  $('rules-error').hidden = true;
  try {
    state.rules = { json, compiled: compileRules(json), key: key ?? (slug(json.id || json.name || name).slice(0, 48) || 'rules'), saved };
  } catch (err) {
    state.rules = null;
    $('rules-error').textContent = `${name ? `${name}: ` : ''}${err.message}`;
    $('rules-error').hidden = false;
  }
  $('asset-folder').value = '';
}

function showRules() {
  const info = $('rules-info');
  const r = state.rules;
  $('save-rules').disabled = !r || r.saved || !state.isGm;
  $('forget-rules').disabled = !r || !r.saved || !state.isGm;
  if (!r) {
    info.replaceChildren(el('span', { className: 'muted', textContent: 'No rules yet: drop a rules file, or choose one this campaign has saved.' }));
    return;
  }
  const c = r.compiled;
  const types = [...c.types.keys()].filter((k) => k !== '*');
  const schemaTypes = Object.keys(c.schema ?? {}).length;
  const lines = [
    el('p', {}, el('strong', { textContent: c.name }), c.description ? ` — ${c.description}` : ''),
    el('p', { className: 'muted small', textContent: [
      c.source.systems.length ? `From ${c.source.systems.join(', ')}` : 'From any system',
      c.target.system ? `to ${c.target.system}` : null,
      `Foundry types: ${types.join(', ')}`,
      schemaTypes ? `checks data against ${schemaTypes} types` : state.manifests.length ? 'checks data against the loaded tavern.json' : 'no schema: data is not checked',
    ].filter(Boolean).join(' · ') }),
  ];
  if (c.target.system && state.system && c.target.system !== state.system.id) {
    lines.push(el('p', { className: 'banner warn', textContent: `These rules make ${c.target.system} documents, but this campaign's system is ${state.system.name} (${state.system.id}). The archive would hold documents this campaign can't use.` }));
  }
  info.replaceChildren(...lines);
}

async function loadSaved() {
  if (!api?.store) return;
  try { state.saved = (await api.store.get(STORE_AREA)) ?? {}; }
  catch { state.saved = {}; }
  const sel = $('saved');
  const keys = Object.keys(state.saved).sort((a, b) => String(state.saved[a]?.name).localeCompare(String(state.saved[b]?.name)));
  sel.replaceChildren(
    el('option', { value: '', textContent: keys.length ? 'Saved rules…' : 'No saved rules' }),
    ...keys.map((k) => el('option', { value: k, textContent: state.saved[k]?.name ?? k })),
  );
  sel.disabled = !keys.length;
  if (state.rules?.saved && state.rules.key in state.saved) sel.value = state.rules.key;
}

$('saved').addEventListener('change', () => {
  const k = $('saved').value;
  if (!k || !state.saved[k]) return;
  useRules(state.saved[k].rules, { key: k, saved: true, name: state.saved[k].name });
  refresh();
});

$('save-rules').addEventListener('click', async () => {
  const r = state.rules;
  if (!r || !api?.store) return;
  const size = JSON.stringify(r.json).length;
  if (size > STORE_SOFT_MAX) {
    notify(`These rules are ${Math.round(size / 1024)} KB; a module's campaign data is limited to 1 MB in all, so they weren't saved. Drop the file in each time instead.`, 'warning');
    return;
  }
  try {
    await api.store.set(`${STORE_AREA}.${r.key}`, { name: r.compiled.name, savedAt: new Date().toISOString(), rules: r.json });
    r.saved = true;
    await loadSaved();
    notify(`Saved "${r.compiled.name}" in this campaign.`, 'success');
  } catch (err) { notify(`Could not save: ${err.message ?? err}`, 'danger'); }
  refresh();
});

$('forget-rules').addEventListener('click', async () => {
  const r = state.rules;
  if (!r?.saved || !api) return;
  if (!(await api.ui.confirm(`Remove the saved rules **${r.compiled.name}** from this campaign? Archives already made stay.`, { ok: 'Remove' }))) return;
  try {
    await api.store.delete(`${STORE_AREA}.${r.key}`);
    r.saved = false;
    await loadSaved();
  } catch (err) { notify(`Could not remove: ${err.message ?? err}`, 'danger'); }
  refresh();
});

// ---- the file lists ----

const mb = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`);

function showFiles() {
  const list = $('files');
  const fe = state.mode === 'fe';
  list.hidden = fe;
  $('bundle').hidden = !fe;
  if (fe) showBundle();
  else if (!state.exports.length) list.replaceChildren(el('li', { className: 'muted', textContent: 'No exports yet.' }));
  else list.replaceChildren(...state.exports.map((x) => el('li', {},
    el('span', { className: 'kind', textContent: x.info.kind ?? 'export' }),
    el('span', { className: 'name', textContent: x.info.label }),
    el('span', { className: 'meta', textContent: `${x.name} · ${x.info.system ?? 'unknown system'} · ${x.info.docs.length} documents · ${x.info.folders.length} folders` }),
    removeButton(state.exports, x),
  )));
  const extras = [
    ...state.manifests.map((x) => [x, state.manifests, 'schema', `${x.json.name ?? x.json.id} ${x.json.version ?? ''} — its types check the data`]),
    ...state.lang.map((x) => [x, state.lang, 'lang', 'localisation keys']),
  ];
  $('extras').replaceChildren(...extras.map(([x, from, kind, meta]) => el('li', {},
    el('span', { className: 'kind', textContent: kind }),
    el('span', { className: 'name', textContent: x.name }),
    el('span', { className: 'meta', textContent: meta }),
    removeButton(from, x),
  )));
}

/** The bundle: where it's from, its packs (each may be left out), its pictures. */
function showBundle() {
  const b = state.bundle;
  const box = $('bundle');
  if (!b) { box.replaceChildren(el('p', { className: 'muted', textContent: 'No bundle yet.' })); return; }
  const m = b.manifest;
  const s = m.source ?? {};
  const when = m.createdAt ? new Date(m.createdAt).toLocaleString() : null;
  const pictures = Object.values(b.files);
  const bytes = pictures.reduce((n, f) => n + (f.size || 0), 0);
  const packRows = b.packs.map((p) => el('li', {},
    el('input', { type: 'checkbox', checked: b.chosen.has(p.meta.file), title: 'Convert this compendium', onchange: (e) => { if (e.target.checked) b.chosen.add(p.meta.file); else b.chosen.delete(p.meta.file); refresh(); } }),
    el('span', { className: 'kind', textContent: p.info.kind ?? p.meta.type ?? 'pack' }),
    el('span', { className: 'name', textContent: p.info.label }),
    el('span', { className: 'meta', textContent: `${p.meta.id ?? p.info.key} · ${p.info.docs.length} documents · ${p.info.folders.length} folders` }),
  ));
  const reasons = new Map();
  for (const l of b.left) reasons.set(l.reason, (reasons.get(l.reason) ?? 0) + 1);
  box.replaceChildren(
    el('p', {},
      el('strong', { textContent: b.name }), ' ',
      el('span', { className: 'muted small', textContent: [
        s.worldTitle ?? s.world, `${s.systemTitle ?? s.system ?? '?'} ${s.version?.system ?? ''}`.trim(), s.version?.core ? `Foundry ${s.version.core}` : null, when ? `exported ${when}` : null,
      ].filter(Boolean).join(' · ') }), ' ',
      el('button', { type: 'button', className: 'x', title: 'Remove', textContent: '✕', onclick: () => { state.bundle = null; refresh(); } }),
    ),
    el('ul', { className: 'files' }, ...packRows),
    el('p', { className: 'muted small', textContent: `${pictures.length} pictures (${mb(bytes)})${b.lang.length ? ` · translations (${b.lang.map((l) => l.name.split('/').pop()).join(', ')})` : ''}${b.left.length ? ` · ${b.left.length} files left out in Foundry` : ''}` }),
    b.left.length ? el('details', {}, el('summary', { className: 'small', textContent: 'Left out when exporting' }),
      el('ul', { className: 'examples small' }, ...[...reasons].map(([r, n]) => el('li', { textContent: `${r}: ${n}` })),
        ...b.left.slice(0, 50).map((l) => el('li', { className: 'muted', textContent: `${l.path} — ${l.reason}` })),
        b.left.length > 50 ? el('li', { className: 'muted', textContent: `…and ${b.left.length - 50} more` }) : null)) : null,
  );
}

function removeButton(list, item) {
  return el('button', {
    type: 'button', className: 'x', title: 'Remove', textContent: '✕',
    onclick: () => { list.splice(list.indexOf(item), 1); refresh(); },
  });
}

// ---- converting ----

const usesBundle = () => state.mode === 'fe' && !!state.bundle;
const picturesOn = () => usesBundle() && $('pictures').checked;

/** The folder pictures go to: the field, else the rules'. null if the field isn't a folder. */
function assetFolder() {
  const typed = $('asset-folder').value.trim();
  if (!typed) return state.rules?.compiled.assets.folder ?? 'foundry';
  return parseFolder(typed) ? typed : null;
}

function sources() {
  if (state.mode === 'ci') return state.exports.map((x) => ({ name: x.name, json: x.json }));
  if (!state.bundle) return [];
  return state.bundle.packs.filter((p) => state.bundle.chosen.has(p.meta.file)).map((p) => ({ name: p.name, json: p.json }));
}

function convertNow(stored = null) {
  const schema = state.manifests.length ? Object.assign({}, ...state.manifests.map((m) => schemaFromManifest(m.json))) : undefined;
  const langs = [...(usesBundle() ? state.bundle.lang : []), ...state.lang];
  const lang = langs.length ? mergeLang(...langs.map((l) => l.json)) : undefined;
  const assets = usesBundle() ? { files: picturesOn() ? state.bundle.files : {}, left: Object.fromEntries(state.bundle.left.map((l) => [l.path, l.reason])), folder: assetFolder() ?? undefined, ...(stored ? { stored } : {}) } : undefined;
  return convert(state.rules.compiled, sources(), { schema, lang, assets, wrap: $('wrap').checked });
}

function runConversion() {
  state.result = null;
  if (!state.rules || !sources().length) return;
  try {
    state.result = convertNow();
  } catch (err) {
    $('rules-error').textContent = err.message;
    $('rules-error').hidden = false;
  }
}

function showPreview() {
  const res = state.result;
  $('preview-card').hidden = !res;
  $('create-card').hidden = !res;
  if (!res) return;
  const total = res.entries.filter((e) => e.type !== 'core.folder').length;
  const folders = res.entries.length - total;
  const packRows = res.packs.map((p) => el('tr', {},
    el('td', { textContent: p.label }), el('td', { textContent: p.system ?? '?' }),
    el('td', { className: 'n', textContent: p.documents }), el('td', { className: 'n', textContent: p.folders }), el('td', { className: 'n', textContent: p.skipped || '' })));
  const typeRows = Object.entries(res.stats).sort((a, b) => b[1] - a[1]).map(([t, n]) => el('tr', {}, el('td', { textContent: t }), el('td', { className: 'n', textContent: n })));
  $('summary').replaceChildren(
    el('p', {}, el('strong', { textContent: `${total} documents` }), ` in ${folders} folders, ready to go into an archive.`),
    el('table', {}, el('thead', {}, el('tr', {}, ...['Pack', 'System', 'Documents', 'Folders', 'Left out'].map((h, i) => el('th', { textContent: h, className: i > 1 ? 'n' : '' })))), el('tbody', {}, ...packRows)),
    el('details', {}, el('summary', { textContent: 'By type' }), el('table', {}, el('tbody', {}, ...typeRows))),
  );
  showTree(res.entries);
  const notes = [
    ...res.problems.map((p) => ({ level: p.level, message: p.doc ? `${p.doc}: ${p.message}` : p.message, count: 1, examples: [] })),
    ...res.notes,
  ].sort((a, b) => rank(a.level) - rank(b.level));
  $('notes').replaceChildren(...(notes.length ? [el('h3', { className: 'small muted', textContent: 'Notes' })] : []), ...notes.slice(0, 200).map((n) => el('div', { className: `note ${n.level}` },
    el('div', {}, n.message, n.count > 1 ? el('span', { className: 'muted', textContent: ` ×${n.count}` }) : null),
    n.examples.length ? el('ul', { className: 'examples' }, ...n.examples.map((x) => el('li', { textContent: x }))) : null,
  )));
}
const rank = (level) => (level === 'error' ? 0 : level === 'warning' ? 1 : 2);

/** The archive's folders as a tree, each with how many documents it holds. */
function showTree(entries) {
  const kids = new Map();
  for (const e of entries) {
    const k = e.parentId ?? '';
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(e);
  }
  const count = (id) => (kids.get(id) ?? []).reduce((n, e) => n + (e.type === 'core.folder' ? count(e.id) : 1 + countHeld(e.id)), 0);
  const countHeld = (id) => (kids.get(id) ?? []).reduce((n, e) => n + 1 + countHeld(e.id), 0);
  const branch = (id, depth) => {
    const folders = (kids.get(id) ?? []).filter((e) => e.type === 'core.folder');
    const docs = (kids.get(id) ?? []).filter((e) => e.type !== 'core.folder');
    const items = folders.map((f) => el('li', {}, `📁 ${f.name} `, el('span', { className: 'count', textContent: `(${count(f.id)})` }), depth < 8 ? branch(f.id, depth + 1) : null));
    if (docs.length && id !== '') items.push(el('li', { className: 'count', textContent: `${docs.length} documents` }));
    return el('ul', {}, ...items);
  };
  const top = branch('', 0);
  const loose = (kids.get('') ?? []).filter((e) => e.type !== 'core.folder').length;
  if (loose) top.append(el('li', { className: 'count', textContent: `${loose} documents at the top` }));
  $('tree').replaceChildren(...top.childNodes);
}

// ---- pictures ----

const currentPlan = () => (state.result && picturesOn() ? uploadPlan(state.result.assets, state.bundle) : []);

function showPictures() {
  const card = $('pictures-card');
  card.hidden = !usesBundle() || !state.result;
  $('create-title').textContent = card.hidden ? '4. Archive' : '5. Archive';
  if (card.hidden) return;
  const on = $('pictures').checked;
  $('pictures-opts').hidden = !on;
  if (!$('asset-folder').value) $('asset-folder').placeholder = state.rules?.compiled.assets.folder ?? 'foundry';
  if (!$('if-exists').dataset.touched) $('if-exists').value = state.rules?.compiled.assets.ifExists ?? 'skip';
  const folderOk = assetFolder() !== null;
  $('folder-error').hidden = folderOk;
  $('folder-error').textContent = folderOk ? '' : 'Not a folder: use letters, digits, spaces and - _ ( ), with / between folders (at most 7), and an optional "storage:" in front.';
  const refs = state.result.assets;
  const plan = currentPlan();
  const bytes = plan.reduce((n, p) => n + p.size, 0);
  const absent = refs.filter((r) => !r.available);
  // Why the bundle hasn't them, as the export said.
  const why = new Map(state.bundle.left.map((l) => [l.path, l.reason]));
  const reasons = new Map();
  for (const r of absent) { const k = why.get(r.path) ?? 'not found in Foundry'; reasons.set(k, (reasons.get(k) ?? 0) + 1); }
  const absentLine = absent.length ? `; ${absent.length} the documents use aren't in the bundle (${[...reasons].map(([k, n]) => `${k}: ${n}`).join('; ')})` : '';
  $('pictures-info').textContent = !refs.length ? 'These documents use no pictures (or the rules don’t map any).'
    : !on ? `${refs.length} pictures are used; their fields will be ${state.rules.compiled.assets.missing === 'keep' ? 'pointed at where they would be' : 'left empty'}.`
    : `${plan.length} pictures to upload (${mb(bytes)}) to ${assetFolder() ?? '…'}/${absentLine}. Nothing is uploaded until you create the archive.`;
}

$('pictures').addEventListener('change', () => refresh());
$('asset-folder').addEventListener('change', () => refresh());
$('if-exists').addEventListener('change', () => { $('if-exists').dataset.touched = '1'; });

/**
 * Upload the plan in batches; Foundry path → where it was stored. Reports progress, and what failed.
 * @returns {Promise<{ stored: Map<string, string>, kept: number, failed: { path: string, error: string }[] }>}
 */
async function uploadPictures(plan, ifExists) {
  const stored = new Map();
  const failed = [];
  let kept = 0;
  for (let i = 0; i < plan.length; i += UPLOAD_BATCH) {
    const batch = plan.slice(i, i + UPLOAD_BATCH);
    say(`Uploading pictures: ${i} of ${plan.length}…`);
    const files = [];
    const ready = [];
    for (const p of batch) {
      try {
        if (p.size > ASSET_MAX_BYTES) throw new Error('larger than 25 MB');
        files.push({ path: p.path, file: await state.bundle.picture(p.from) });
        ready.push(p);
      } catch (err) { failed.push({ path: p.from, error: err.message ?? String(err) }); }
    }
    if (!files.length) continue;
    const results = await api.assets.uploadMany(files, { ifExists });
    results.forEach((r, j) => {
      const p = ready[j];
      if (r?.stored) { stored.set(p.from, r.stored); if (r.kept) kept++; }
      else failed.push({ path: p.from, error: r?.error ?? 'not stored' });
    });
  }
  return { stored, kept, failed };
}

// ---- creating the archive ----

function defaultArchiveName() {
  if (state.mode === 'fe' && state.bundle) {
    const chosen = state.bundle.packs.filter((p) => state.bundle.chosen.has(p.meta.file));
    if (chosen.length === 1) return chosen[0].info.label;
    return state.bundle.manifest.source?.worldTitle ?? state.rules?.compiled.name ?? 'Foundry import';
  }
  if (state.exports.length === 1) return state.exports[0].info.label;
  return state.rules?.compiled.name ?? 'Foundry import';
}

async function loadArchives() {
  const sel = $('archive-pick');
  if (!api?.archives) return;
  try {
    const list = (await api.archives.list()).filter((a) => a.source === 'campaign');
    sel.replaceChildren(...list.map((a) => el('option', { value: a.id, textContent: `${a.name} (${a.count})` })));
    document.querySelector('input[name=dest][value=add]').disabled = !list.length;
  } catch { /* none to add to */ }
}

for (const r of document.querySelectorAll('input[name=dest]')) {
  r.addEventListener('change', () => {
    const add = document.querySelector('input[name=dest]:checked').value === 'add';
    $('dest-new').hidden = add;
    $('dest-add').hidden = !add;
  });
}

$('create').addEventListener('click', async () => {
  const res = state.result;
  if (!res || !api || state.busy) return;
  const add = document.querySelector('input[name=dest]:checked').value === 'add';
  const count = res.entries.length;
  const errors = res.problems.filter((p) => p.level === 'error').length;
  const warn = errors ? `\n\n${errors} documents were left out; see the notes.` : '';
  const archiveName = $('archive-name').value.trim() || defaultArchiveName();
  const target = add ? $('archive-pick').selectedOptions[0]?.textContent : archiveName;
  const plan = currentPlan();
  if (plan.length && assetFolder() === null) { say('The pictures’ folder isn’t a folder path; see Pictures.', 'danger'); return; }
  let ifExists = $('if-exists').value;
  if (plan.length && !api.assets?.uploadMany) {
    if (!(await api.ui.confirm('This version of Tavern Moot can’t upload files from a page, so the pictures will be left out. Make the archive without them?', { ok: 'Without pictures' }))) return;
    plan.length = 0;
  }
  if (plan.length && ifExists !== 'rename') {
    let can = false;
    try { can = await api.features.has('core.asset-upload'); } catch { can = false; }
    if (!can) {
      if (!(await api.ui.confirm('This server can’t tell whether a picture is already there, so pictures uploaded before will be stored again as copies. Upload them anyway?', { ok: 'Upload copies' }))) return;
      ifExists = 'rename';
    }
  }
  const pics = plan.length ? ` and upload **${plan.length}** pictures (${mb(plan.reduce((n, p) => n + p.size, 0))}) to **${assetFolder()}**` : '';
  if (!(await api.ui.confirm(`Put **${count}** entries (documents and folders) into ${add ? 'the archive' : 'a new archive,'} **${target}**${pics}?${warn}`, { ok: add ? 'Add' : 'Create' }))) return;
  state.busy = true;
  $('create').disabled = true;
  let upload = null;
  try {
    let entries = res.entries;
    if (plan.length) {
      upload = await uploadPictures(plan, ifExists);
      // Point the documents at where each picture was stored (a renamed copy, perhaps).
      entries = convertNow(upload.stored).entries;
    }
    say('Writing the archive…');
    if (add) {
      await api.archives.add($('archive-pick').value, entries);
    } else {
      await api.archives.create({ name: archiveName.slice(0, 100), access: $('access').value, entries });
    }
    const picLine = upload ? ` Pictures: ${upload.stored.size - upload.kept} uploaded${upload.kept ? `, ${upload.kept} already there` : ''}${upload.failed.length ? `, ${upload.failed.length} failed (their fields are empty; try again to retry them)` : ''}.` : '';
    say(add ? `Added ${entries.length} entries to ${target}.${picLine}` : `Made the archive "${archiveName}" with ${entries.length} entries.${picLine} Open it from the Archives window to import what you need.`, upload?.failed.length ? 'warn' : 'ok');
    if (upload?.failed.length) console.warn('Pictures that failed to upload:', upload.failed);
    await loadArchives();
  } catch (err) {
    const done = upload ? ` The ${upload.stored.size} pictures uploaded stay in the campaign's files; trying again keeps them.` : '';
    say(`Nothing was written: ${String(err.message ?? err).replace(/\.$/, '')}.${done}`, 'danger');
  } finally {
    state.busy = false;
    $('create').disabled = !state.isGm;
  }
});

function say(text, level) {
  const s = $('status');
  s.textContent = text;
  s.className = level === 'ok' ? '' : level === 'danger' ? 'banner danger' : level === 'warn' ? 'banner warn' : 'muted';
}

// ---- drop zones ----

for (const id of ['drop', 'drop-fe']) {
  const drop = $(id);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove('over');
    if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
  });
}
// Files dropped anywhere on the page count too, rather than the frame navigating to them.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
});
for (const id of ['pick', 'pick-fe']) {
  $(id).addEventListener('change', () => {
    addFiles([...$(id).files]);
    $(id).value = '';
  });
}
$('wrap').addEventListener('change', () => { $('wrap').dataset.touched = '1'; refresh(); });

// ---- everything, again ----

let lastNameDefault = '';
function refresh() {
  const packs = sources().length;
  if (!$('wrap').dataset.touched) $('wrap').checked = packs > 1 || !!state.rules?.compiled.options.wrap;
  runConversion();
  showRules();
  showFiles();
  showPreview();
  showPictures();
  const name = defaultArchiveName();
  if (!$('archive-name').value || $('archive-name').value === lastNameDefault) $('archive-name').value = name;
  lastNameDefault = name;
  if (state.rules) $('access').value = $('access').dataset.touched ? $('access').value : state.rules.compiled.options.access;
  $('create').disabled = !state.result || !state.result.entries.length || !state.isGm || state.busy;
  $('create').textContent = picturesOn() && currentPlan().length ? 'Upload pictures and create archive' : 'Create archive';
}
$('access').addEventListener('change', () => { $('access').dataset.touched = '1'; });

async function start() {
  if (api) {
    try {
      state.system = await api.system.get();
      if (state.system) { $('system').textContent = `${state.system.name} ${state.system.version}`; $('system').hidden = false; }
    } catch { /* shown without it */ }
    try {
      const viewer = await api.viewer.get();
      state.isGm = viewer?.role === 'gm';
    } catch { state.isGm = false; }
    $('gm-only').hidden = state.isGm;
    await Promise.all([loadSaved(), loadArchives()]);
  }
  refresh();
}
start();
