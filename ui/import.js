// The Foundry import widget: rules + exports in, a campaign archive out (TM ADR 0112).
// Everything is converted here, in the page, by lib/convert.mjs; the only calls to the campaign
// are reading the system, the saved rules and the archive list, and the one write at the end.
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
  rules: null, // { json, compiled, key, saved }
  exports: [], // { name, json, info }
  lang: [], // { name, json }
  manifests: [], // { name, json }
  saved: {}, // key -> { name, savedAt, rules }
  system: null,
  isGm: true,
  result: null,
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

async function addFiles(fileList) {
  const problems = [];
  for (const file of fileList) {
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
    } else problems.push(`${file.name}: not a rules file, Foundry export, tavern.json or lang file`);
  }
  if (problems.length) notify(problems.join('\n'), 'warning');
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

function showFiles() {
  const list = $('files');
  if (!state.exports.length) list.replaceChildren(el('li', { className: 'muted', textContent: 'No exports yet.' }));
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

function removeButton(list, item) {
  return el('button', {
    type: 'button', className: 'x', title: 'Remove', textContent: '✕',
    onclick: () => { list.splice(list.indexOf(item), 1); refresh(); },
  });
}

// ---- preview ----

function runConversion() {
  state.result = null;
  if (!state.rules || !state.exports.length) return;
  const schema = state.manifests.length ? Object.assign({}, ...state.manifests.map((m) => schemaFromManifest(m.json))) : undefined;
  const lang = state.lang.length ? mergeLang(...state.lang.map((l) => l.json)) : undefined;
  try {
    state.result = convert(state.rules.compiled, state.exports.map((x) => ({ name: x.name, json: x.json })), { schema, lang, wrap: $('wrap').checked });
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

// ---- creating the archive ----

function defaultArchiveName() {
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
  if (!res || !api) return;
  const add = document.querySelector('input[name=dest]:checked').value === 'add';
  const count = res.entries.length;
  const errors = res.problems.filter((p) => p.level === 'error').length;
  const warn = errors ? `\n\n${errors} documents were left out; see the notes.` : '';
  const archiveName = $('archive-name').value.trim() || defaultArchiveName();
  const target = add ? $('archive-pick').selectedOptions[0]?.textContent : archiveName;
  if (!(await api.ui.confirm(`Put **${count}** entries (documents and folders) into ${add ? 'the archive' : 'a new archive,'} **${target}**?${warn}`, { ok: add ? 'Add' : 'Create' }))) return;
  $('create').disabled = true;
  say('Writing the archive…');
  try {
    if (add) {
      const archive = $('archive-pick').value;
      await api.archives.add(archive, res.entries);
      say(`Added ${count} entries to ${target}.`, 'ok');
    } else {
      await api.archives.create({ name: archiveName.slice(0, 100), access: $('access').value, entries: res.entries });
      say(`Made the archive "${archiveName}" with ${count} entries. Open it from the Archives window to import what you need.`, 'ok');
    }
    await loadArchives();
  } catch (err) {
    say(`Nothing was written: ${err.message ?? err}`, 'danger');
  } finally {
    $('create').disabled = !state.isGm;
  }
});

function say(text, level) {
  const s = $('status');
  s.textContent = text;
  s.className = level === 'ok' ? '' : level === 'danger' ? 'banner danger' : 'muted';
}

// ---- drop zone ----

const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
});
// Files dropped anywhere on the page count too, rather than the frame navigating to them.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  if (drop.contains(e.target)) return;
  e.preventDefault();
  if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
});
$('pick').addEventListener('change', () => {
  addFiles([...$('pick').files]);
  $('pick').value = '';
});
$('wrap').addEventListener('change', () => { $('wrap').dataset.touched = '1'; refresh(); });

// ---- everything, again ----

let lastNameDefault = '';
function refresh() {
  if (!$('wrap').dataset.touched) $('wrap').checked = state.exports.length > 1 || !!state.rules?.compiled.options.wrap;
  runConversion();
  showRules();
  showFiles();
  showPreview();
  const name = defaultArchiveName();
  if (!$('archive-name').value || $('archive-name').value === lastNameDefault) $('archive-name').value = name;
  lastNameDefault = name;
  if (state.rules) $('access').value = $('access').dataset.touched ? $('access').value : state.rules.compiled.options.access;
  $('create').disabled = !state.result || !state.result.entries.length || !state.isGm;
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
