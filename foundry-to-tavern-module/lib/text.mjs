// Text clean-up for Foundry content: HTML to Markdown, Foundry inline syntax to Tavern Moot
// embeds, and repair of known export faults. Pure functions (no DOM), so they run in the widget,
// the CLI and tests alike.

const NAMED = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—',
  hellip: '…', times: '×', divide: '÷', deg: '°', frac12: '½', frac14: '¼',
  frac34: '¾', plusmn: '±', minus: '−', prime: '′', Prime: '″', bull: '•',
  middot: '·', copy: '©', reg: '®', trade: '™', sect: '§', para: '¶',
  eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', ouml: 'ö', uuml: 'ü',
  auml: 'ä', iuml: 'ï', ccedil: 'ç', szlig: 'ß', shy: '',
};

/** HTML entities (named, decimal and hex) as characters. Unknown names are left as they are. */
export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return Object.hasOwn(NAMED, name) ? NAMED[name] : whole;
  });
}

/**
 * Text where nearly every word has each character doubled ("ttaallll tthhiicckkeettss") is an
 * export fault seen in Dolmenwood's creature pack (spaces are not doubled): collapse the pairs word
 * by word. Only acts when at least 80% of the words are doubled, so real text is left alone.
 * Lines are judged on their own, since a field can mix a faulty line with a good one.
 */
export function fixDoubled(text) {
  if (typeof text !== 'string' || text.length < 12) return { text, fixed: false };
  // Ligatures (fl, fi) were split back into letters before the doubling, so they come as "flfl".
  const unlig = (w) => w.replace(/flfl/g, 'ffll').replace(/fifi/g, 'ffii');
  const isDoubled = (word) => {
    const w = [...unlig(word)];
    return w.length >= 2 && w.length % 2 === 0 && w.every((c, i) => i % 2 === 1 || c === w[i + 1]);
  };
  let fixed = false;
  const out = text.split('\n').map((line) => {
    const words = line.split(/(\s+)/);
    const real = words.filter((w) => w.trim() && w.length >= 2);
    if (real.length < 3 || real.filter(isDoubled).length / real.length < 0.8) return line;
    fixed = true;
    return words.map((w) => (isDoubled(w) ? [...unlig(w)].filter((_, i) => i % 2 === 0).join('') : w)).join('');
  });
  return { text: out.join('\n'), fixed };
}

/**
 * Foundry's inline text as Tavern Moot embeds (TM ADR 0111):
 * - inline rolls (`[[/r 1d6]]{Label}`, `[[1d6]]`) become `@roll[1d6]{Label}`;
 * - document links (`@UUID[…]{Label}`, `@Compendium[…]{Label}`) become a link placeholder
 *   (`linkPlaceholder`): convert() makes it `[[@<entry id>|Label]]` when the document it points at
 *   came in with the import (TM ADR 0132), and otherwise keeps only the label;
 * - Foundry's `@Embed[…]` and `@Check[…]`-style enrichers keep their label, or vanish.
 */
export function foundryEmbeds(text) {
  if (!text || (!text.includes('[[') && !text.includes('@'))) return text ?? '';
  return String(text)
    .replace(/\[\[\/(?:r|roll|gmr|br|sr|publicroll|pr)\s+([^\]]+?)\s*\]\](?:\{([^}]*)\})?/gi,
      (_, f, label) => `@roll[${f.replace(/#.*$/, '').trim()}]${label ? `{${label}}` : ''}`)
    .replace(/\[\[([^/\]][^\]]*?)\]\](?:\{([^}]*)\})?/g, (_, f, label) => `@roll[${f.trim()}]${label ? `{${label}}` : ''}`)
    .replace(/@(?:UUID|Compendium|Actor|Item|JournalEntry|JournalEntryPage|RollTable|Scene|Macro)\[([^\]]*)\](?:\{([^}]*)\})?/g,
      (_, target, label) => linkPlaceholder(target.replace(/#.*$/, '').split('.').pop(), label ?? ''))
    .replace(/@Embed\[[^\]]*\](?:\{([^}]*)\})?/g, (_, label) => label ?? '');
}

/**
 * Markers for what convert() resolves once every entry's id is known: a link to a Foundry
 * document (its `_id` and label), and a bare reference (the `ref` transform). Private-use
 * characters, so no text has them and Markdown leaves them alone.
 */
export const LINK_RE = /\uE000([^\uE001\uE002]*)\uE001([^\uE002]*)\uE002/g;
export const REF_RE = /\uE003([^\uE004]*)\uE004/g;
export const linkPlaceholder = (id, label) => (id ? `\uE000${id}\uE001${String(label).replace(/[\uE000-\uE004]/g, '')}\uE002` : label);
export const refPlaceholder = (id) => `\uE003${String(id).replace(/[\uE000-\uE004]/g, '')}\uE004`;

/** Foundry's HTML (ProseMirror output) as Markdown, with its inline syntax as embeds. */
export function htmlToMarkdown(html) {
  if (html == null || html === '') return '';
  let s = String(html);
  if (!/[<&]/.test(s)) return foundryEmbeds(s).trim();
  // Spaces just inside bold/italic tags go outside them: `** text**` would not render as bold.
  s = s.replace(/<(strong|b|em|i)(\s[^>]*)?>(\s+)/gi, '$3<$1$2>').replace(/(\s+)<\/(strong|b|em|i)\s*>/gi, '</$2>$1');
  // Lists: number ordered items; nested lists are flattened with indentation.
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
    let n = 0;
    return `\n${inner.replace(/<li[^>]*>/gi, () => `\n${++n}. `).replace(/<\/li>/gi, '')}\n`;
  });
  s = s
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<\s*hr\s*\/?>/gi, '\n\n---\n\n')
    .replace(/<blockquote[^>]*>/gi, '\n\n> ').replace(/<\/blockquote\s*>/gi, '\n\n')
    .replace(/<\/p\s*>/gi, '\n\n').replace(/<p[^>]*>/gi, '')
    .replace(/<\/(div|section|article|tr|table|ul)\s*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' | ')
    .replace(/<\s*(strong|b)(\s[^>]*)?>/gi, '**').replace(/<\/\s*(strong|b)\s*>/gi, '**')
    .replace(/<\s*(em|i)(\s[^>]*)?>/gi, '*').replace(/<\/\s*(em|i)\s*>/gi, '*')
    .replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li\s*>/gi, '')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .replace(/\*\*\*\*/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return foundryEmbeds(s).trim();
}

/** HTML with every tag dropped and entities decoded: plain text. */
export function stripHtml(html) {
  if (html == null) return '';
  return decodeEntities(String(html).replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/p\s*>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** "detectMagic" -> "Detect Magic", "detect_magic" / "detect-magic" -> "Detect magic". */
export function humanize(id) {
  return String(id ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/** "detect magic" -> "Detect Magic". */
export function titleCase(text) {
  return String(text ?? '').replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/** A localisation key resolved against a lang object, flat (`{"A.B": "x"}`) or nested. Null if absent. */
export function resolveKey(key, lang) {
  if (!key || !lang || typeof key !== 'string') return null;
  if (typeof lang[key] === 'string') return lang[key];
  let cur = lang;
  for (const part of key.split('.')) {
    cur = cur?.[part];
    if (cur === undefined) return null;
  }
  return typeof cur === 'string' ? cur : null;
}

/** Several lang files as one lookup: later ones win. Nested objects are merged. */
export function mergeLang(...objects) {
  const merge = (into, from) => {
    for (const [k, v] of Object.entries(from || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) into[k] = merge(into[k] && typeof into[k] === 'object' ? into[k] : {}, v);
      else into[k] = v;
    }
    return into;
  };
  return objects.reduce((acc, o) => merge(acc, o), {});
}
