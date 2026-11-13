// The rules file's expression language (docs/rules-format.md). Expressions are compiled once,
// before anything is converted, so a mistake in a rules file is reported with where it is
// (`types.Weapon.data.damage[2]`) instead of misbehaving halfway through an import.
//
// An expression (E) is one of:
//   null, a number, true/false        itself
//   "$path"                           a value from the document (see paths below)
//   "text with {{path}}"              a template
//   "any other string"                itself
//   [E, T, T, …]                      a pipeline: E's value through each transform T
//   { "<op>": … }                     an operator (EXPR_OPS)
//
// Paths: "$" is the current value (the document, or the element being mapped); "$a.b.0" goes into
// it; "$~" is the Foundry document being converted; "$^" the scope around this one (repeatable:
// "$^.^"); "$#" the index of the element being mapped; "$:name" a variable from the rule's `vars`.

import { fixDoubled, foundryEmbeds, htmlToMarkdown, humanize, resolveKey, stripHtml, titleCase } from './text.mjs';

export class RulesError extends Error {
  constructor(message, at) {
    super(at ? `${at}: ${message}` : message);
    this.name = 'RulesError';
    this.at = at;
  }
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isEmpty = (v) => v === undefined || v === null || v === '' || (typeof v === 'number' && Number.isNaN(v));
const toNumber = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
};
const toText = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const asList = (v) => {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (isObject(v)) return Object.entries(v).map(([key, value]) => ({ key, value }));
  return [v];
};

/** A value at a dot path in `obj` ("a.b.0"); undefined if any step is missing. */
export function getPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Set a dot path in `obj`, making objects on the way. */
export function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (!isObject(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts.at(-1)] = value;
}

// ---- scopes ----
// { cur, parent, root, index, vars } — `root` is the Foundry document; `vars` the rule's variables.

export const scopeFor = (doc, vars = {}) => ({ cur: doc, parent: null, root: doc, index: undefined, vars });
export const childScope = (s, cur, index) => ({ cur, parent: s, root: s.root, index, vars: s.vars });

const PATH_RE = /^(?:~|\^(?:\.\^)*|#|:[A-Za-z_][\w-]*)?(?:\.?[^.\s{}]+(?:\.[^.\s{}]+)*)?$/;

/** A compiled path (without its "$"): a function of the scope. */
function compilePath(path, at) {
  if (path === '' || path === '.') return (s) => s.cur;
  if (!PATH_RE.test(path)) throw new RulesError(`"${path}" is not a path`, at);
  if (path === '#') return (s) => s.index;
  if (path.startsWith('~')) {
    const rest = path.slice(1).replace(/^\./, '');
    return (s) => getPath(s.root, rest);
  }
  if (path.startsWith('^')) {
    const m = /^\^((?:\.\^)*)\.?(.*)$/.exec(path);
    const ups = 1 + (m[1].match(/\^/g)?.length ?? 0);
    const rest = m[2];
    return (s) => {
      let scope = s;
      for (let i = 0; i < ups && scope; i++) scope = scope.parent;
      return scope ? getPath(scope.cur, rest) : undefined;
    };
  }
  if (path.startsWith(':')) {
    const m = /^:([A-Za-z_][\w-]*)\.?(.*)$/.exec(path);
    return (s) => {
      if (!Object.hasOwn(s.vars, m[1])) return undefined;
      return getPath(s.vars[m[1]], m[2]);
    };
  }
  const rest = path.replace(/^\./, '');
  return (s) => getPath(s.cur, rest);
}

function compileTemplate(text, at) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
    parts.push(text.slice(last, m.index));
    const p = compilePath(m[1].replace(/^\$/, ''), at);
    parts.push((s) => toText(p(s)));
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return (s) => parts.map((p) => (typeof p === 'function' ? p(s) : p)).join('');
}

function onlyKeys(spec, allowed, at) {
  for (const k of Object.keys(spec)) {
    if (!allowed.includes(k)) throw new RulesError(`unknown key "${k}" (expected ${allowed.map((a) => `"${a}"`).join(', ')})`, at);
  }
}

// ---- expressions ----

/** Compile an expression. Returns `(scope, ctx) => value`. */
export function compileExpr(spec, at = '') {
  if (spec === null || typeof spec === 'number' || typeof spec === 'boolean') return () => spec;
  if (typeof spec === 'string') {
    if (spec.startsWith('$')) return compilePath(spec.slice(1), at);
    if (spec.includes('{{')) return compileTemplate(spec, at);
    return () => spec;
  }
  if (Array.isArray(spec)) {
    if (!spec.length) throw new RulesError('an empty pipeline (for an empty list, write {"value": []})', at);
    const head = compileExpr(spec[0], `${at}[0]`);
    const steps = spec.slice(1).map((t, i) => compileTransform(t, `${at}[${i + 1}]`));
    return (s, c) => {
      let v = head(s, c);
      for (const step of steps) v = step(v, s, c);
      return v;
    };
  }
  if (isObject(spec)) {
    const op = Object.keys(spec).find((k) => Object.hasOwn(EXPR_OPS, k));
    if (!op) {
      const keys = Object.keys(spec);
      throw new RulesError(`${keys.length ? `"${keys[0]}" is not an operator${suggest(keys[0], Object.keys(EXPR_OPS))}` : 'an empty object'}; operators are ${Object.keys(EXPR_OPS).join(', ')} (a literal object is {"value": {…}})`, at);
    }
    return EXPR_OPS[op](spec, `${at}.${op}`);
  }
  throw new RulesError(`not an expression: ${JSON.stringify(spec)}`, at);
}

/**
 * A map of target paths to expressions ({"melee.damage": E, …}), compiled. Undefined and null
 * results are left out, so the target's defaults apply.
 */
export function compileMapping(spec, at) {
  if (!isObject(spec)) throw new RulesError('expected an object of "path": expression', at);
  const entries = Object.entries(spec).map(([path, e]) => {
    if (!/^[A-Za-z_$][\w$-]*(\.[A-Za-z_$0-9][\w$-]*)*$/.test(path)) throw new RulesError(`"${path}" is not a field path`, at);
    return [path, compileExpr(e, `${at}.${path}`)];
  });
  return (s, c) => {
    const out = {};
    for (const [path, fn] of entries) {
      const v = fn(s, c);
      if (v !== undefined && v !== null) setPath(out, path, v);
    }
    return out;
  };
}

const EXPR_OPS = {
  /** {"value": anything} — that value, as written. */
  value(spec, at) {
    onlyKeys(spec, ['value'], at);
    const v = structuredClone(spec.value);
    return () => structuredClone(v);
  },
  /** {"path": "a.b"} — the same as "$a.b". */
  path(spec, at) {
    onlyKeys(spec, ['path'], at);
    if (typeof spec.path !== 'string') throw new RulesError('expected a path string', at);
    return compilePath(spec.path.replace(/^\$/, ''), at);
  },
  /** {"template": "Range {{system.range}}"} — the same as the string, even without {{ }}. */
  template(spec, at) {
    onlyKeys(spec, ['template'], at);
    if (typeof spec.template !== 'string') throw new RulesError('expected a string', at);
    return compileTemplate(spec.template, at);
  },
  /** {"if": E, "then": E, "else": E} — `else` defaults to nothing. */
  if(spec, at) {
    onlyKeys(spec, ['if', 'then', 'else'], at);
    const cond = compileExpr(spec.if, `${at}`);
    const yes = 'then' in spec ? compileExpr(spec.then, `${at}.then`) : () => true;
    const no = 'else' in spec ? compileExpr(spec.else, `${at}.else`) : () => undefined;
    return (s, c) => (truthy(cond(s, c)) ? yes(s, c) : no(s, c));
  },
  /** {"switch": E, "cases": {"a": E, …}, "default": E} */
  switch(spec, at) {
    onlyKeys(spec, ['switch', 'cases', 'default'], at);
    if (!isObject(spec.cases)) throw new RulesError('"cases" must be an object', at);
    const key = compileExpr(spec.switch, at);
    const cases = Object.fromEntries(Object.entries(spec.cases).map(([k, e]) => [k, compileExpr(e, `${at}.cases.${k}`)]));
    const dflt = 'default' in spec ? compileExpr(spec.default, `${at}.default`) : () => undefined;
    return (s, c) => {
      const k = toText(key(s, c));
      return Object.hasOwn(cases, k) ? cases[k](s, c) : dflt(s, c);
    };
  },
  /** {"coalesce": [E, E, …]} — the first that isn't empty (null, missing, ""). */
  coalesce(spec, at) {
    onlyKeys(spec, ['coalesce'], at);
    const list = compileList(spec.coalesce, at);
    return (s, c) => {
      for (const fn of list) {
        const v = fn(s, c);
        if (!isEmpty(v)) return v;
      }
      return undefined;
    };
  },
  /** {"all": [E, …]} / {"any": [E, …]} / {"not": E} — true or false. */
  all(spec, at) {
    onlyKeys(spec, ['all'], at);
    const list = compileList(spec.all, at);
    return (s, c) => list.every((fn) => truthy(fn(s, c)));
  },
  any(spec, at) {
    onlyKeys(spec, ['any'], at);
    const list = compileList(spec.any, at);
    return (s, c) => list.some((fn) => truthy(fn(s, c)));
  },
  not(spec, at) {
    onlyKeys(spec, ['not'], at);
    const fn = compileExpr(spec.not, at);
    return (s, c) => !truthy(fn(s, c));
  },
  /** {"list": [E, …]} — a list of the values (left as they are; add "compact" to drop empties). */
  list(spec, at) {
    onlyKeys(spec, ['list'], at);
    const list = compileList(spec.list, at);
    return (s, c) => list.map((fn) => fn(s, c));
  },
  /** {"object": {"a.b": E, …}} — an object built like a rule's `data`. */
  object(spec, at) {
    onlyKeys(spec, ['object'], at);
    return compileMapping(spec.object, at);
  },
  /** {"join": [E, …], "sep": "\n\n"} — the non-empty values as text, joined (default sep: ""). */
  join(spec, at) {
    onlyKeys(spec, ['join', 'sep'], at);
    const list = compileList(spec.join, at);
    const sep = spec.sep ?? '';
    return (s, c) => list.map((fn) => fn(s, c)).filter((v) => !isEmpty(v)).map(toText).join(sep);
  },
  /**
   * {"labels": [["Range", E], …], "format": "**{label}:** {value}", "sep": "\n\n"} — labelled
   * lines for a description, leaving out those whose value is empty.
   */
  labels(spec, at) {
    onlyKeys(spec, ['labels', 'format', 'sep'], at);
    if (!Array.isArray(spec.labels)) throw new RulesError('expected a list of ["Label", expression] pairs', at);
    const pairs = spec.labels.map((p, i) => {
      if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string') throw new RulesError('expected ["Label", expression]', `${at}[${i}]`);
      return [p[0], compileExpr(p[1], `${at}[${i}][1]`)];
    });
    const format = spec.format ?? '**{label}:** {value}';
    const sep = spec.sep ?? '\n\n';
    return (s, c) => pairs.map(([label, fn]) => [label, fn(s, c)]).filter(([, v]) => !isEmpty(v) && !(Array.isArray(v) && !v.length))
      .map(([label, v]) => format.replace('{label}', label).replace('{value}', Array.isArray(v) ? v.map(toText).join(', ') : toText(v))).join(sep);
  },
  /**
   * {"map": E, "to": E} or {"map": E, "row": {"path": E, …}}, with "where": E to keep some — each
   * element of a list (an object's entries, as {key, value}), with "$" the element, "$#" its
   * index and "$^" the scope around.
   */
  map(spec, at) {
    onlyKeys(spec, ['map', 'to', 'row', 'where'], at);
    if (('to' in spec) === ('row' in spec)) throw new RulesError('give one of "to" or "row"', at);
    const list = compileExpr(spec.map, at);
    const each = 'row' in spec ? compileMapping(spec.row, `${at}.row`) : compileExpr(spec.to, `${at}.to`);
    const where = 'where' in spec ? compileExpr(spec.where, `${at}.where`) : null;
    return (s, c) => {
      const out = [];
      asList(list(s, c)).forEach((el, i) => {
        const inner = childScope(s, el, i);
        if (where && !truthy(where(inner, c))) return;
        out.push(each(inner, c));
      });
      return out;
    };
  },
  /**
   * {"zip": {"col": E, …}, "length": "longest" | "shortest" | n | E, "fill": "last" | E} — lists
   * side by side, as rows: [{col: list1[0], …}, {col: list1[1], …}]. A list that runs out repeats
   * its last value ("last", the default) or takes `fill`.
   */
  zip(spec, at) {
    onlyKeys(spec, ['zip', 'length', 'fill'], at);
    if (!isObject(spec.zip)) throw new RulesError('"zip" must be an object of column: expression', at);
    const cols = Object.entries(spec.zip).map(([k, e]) => [k, compileExpr(e, `${at}.${k}`)]);
    const len = spec.length ?? 'longest';
    const lenFn = typeof len === 'string' && (len === 'longest' || len === 'shortest') ? null : compileExpr(len, `${at}.length`);
    const fill = spec.fill === undefined || spec.fill === 'last' ? null : compileExpr(spec.fill, `${at}.fill`);
    return (s, c) => {
      const lists = cols.map(([k, fn]) => [k, asList(fn(s, c))]);
      const lengths = lists.map(([, l]) => l.length);
      const n = lenFn ? Math.max(0, Math.trunc(toNumber(lenFn(s, c))) || 0)
        : len === 'shortest' ? Math.min(...lengths) : Math.max(0, ...lengths);
      return Array.from({ length: Math.min(n, 10_000) }, (_, i) => Object.fromEntries(lists.map(([k, l]) => [k,
        i < l.length ? l[i] : fill ? fill(s, c) : l.at(-1)])));
    };
  },
  /** {"range": E} — [0, 1, …, n-1]. */
  range(spec, at) {
    onlyKeys(spec, ['range'], at);
    const n = compileExpr(spec.range, at);
    return (s, c) => Array.from({ length: Math.min(10_000, Math.max(0, Math.trunc(toNumber(n(s, c))) || 0)) }, (_, i) => i);
  },
};

function compileList(spec, at) {
  if (!Array.isArray(spec)) throw new RulesError('expected a list of expressions', at);
  return spec.map((e, i) => compileExpr(e, `${at}[${i}]`));
}

export function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (isObject(v)) return Object.keys(v).length > 0;
  return !!v && !(typeof v === 'number' && Number.isNaN(v));
}

// ---- transforms ----
// A transform (T) is "name" or {"name": arg, …}: (value, scope, ctx) => value. Args marked E are
// expressions, evaluated in the current scope ("$" is still the document, or the mapped element).

const loose = (a, b) => (typeof a === 'number' || typeof b === 'number' ? toNumber(a) === toNumber(b) : toText(a) === toText(b));
const numArg = (fn) => (arg, at) => {
  const e = compileExpr(arg, at);
  return (v, s, c) => fn(toNumber(v), toNumber(e(s, c)));
};
const cmpArg = (fn) => (arg, at) => {
  const e = compileExpr(arg, at);
  return (v, s, c) => fn(v, e(s, c));
};
const regex = (arg, at) => {
  const [pattern, flags = ''] = Array.isArray(arg) ? arg : [arg];
  try { return new RegExp(pattern, flags); } catch (err) { throw new RulesError(`bad pattern: ${err.message}`, at); }
};
const pipelineOf = (arg, at) => {
  const list = Array.isArray(arg) ? arg : [arg];
  const steps = list.map((t, i) => compileTransform(t, Array.isArray(arg) ? `${at}[${i}]` : at));
  return (v, s, c) => steps.reduce((acc, step) => step(acc, s, c), v);
};
/** For each/where/find: the transforms run on each element, in its own scope. */
const perElement = (arg, at) => {
  const pipe = pipelineOf(arg, at);
  return (el, i, s, c) => pipe(el, childScope(s, el, i), c);
};

const TRANSFORMS = {
  // -- types
  string: () => (v) => toText(v),
  number: () => (v) => toNumber(v),
  int: () => (v) => { const n = toNumber(v); return Number.isFinite(n) ? Math.trunc(n) : NaN; },
  boolean: () => (v) => (typeof v === 'string' ? !/^(|0|false|no|off)$/i.test(v.trim()) : truthy(v)),
  array: () => (v) => (v == null ? [] : Array.isArray(v) ? v : [v]),
  json: () => (v) => JSON.stringify(v ?? null),
  parseJson: () => (v) => { try { return JSON.parse(toText(v)); } catch { return undefined; } },

  // -- missing values
  /** {"default": E} — E when the value is empty (null, missing, "", NaN). */
  default: (arg, at) => { const e = compileExpr(arg, at); return (v, s, c) => (isEmpty(v) ? e(s, c) : v); },
  /** {"defaultIfZero": E} — also when it's 0. */
  defaultIfZero: (arg, at) => { const e = compileExpr(arg, at); return (v, s, c) => (isEmpty(v) || toNumber(v) === 0 ? e(s, c) : v); },
  /** "nullIfEmpty" — "" and [] become nothing, so the field is left out. */
  nullIfEmpty: () => (v) => (isEmpty(v) || (Array.isArray(v) && !v.length) ? undefined : v),

  // -- numbers (args are E)
  add: numArg((a, b) => a + b),
  sub: numArg((a, b) => a - b),
  mul: numArg((a, b) => a * b),
  div: numArg((a, b) => (b === 0 ? NaN : a / b)),
  mod: numArg((a, b) => (b === 0 ? NaN : a % b)),
  atLeast: numArg((a, b) => (Number.isNaN(a) ? a : Math.max(a, b))),
  atMost: numArg((a, b) => (Number.isNaN(a) ? a : Math.min(a, b))),
  /** {"round": digits} (default 0). */
  round: (arg) => { const d = Math.max(0, Math.min(10, Number(arg ?? 0) || 0)); const f = 10 ** d; return (v) => Math.round(toNumber(v) * f) / f; },
  floor: () => (v) => Math.floor(toNumber(v)),
  ceil: () => (v) => Math.ceil(toNumber(v)),
  abs: () => (v) => Math.abs(toNumber(v)),
  /** {"clamp": [lo, hi]} (literal numbers; either may be null). */
  clamp: (arg, at) => {
    if (!Array.isArray(arg) || arg.length !== 2) throw new RulesError('expected [lo, hi]', at);
    const [lo, hi] = arg;
    return (v) => { let n = toNumber(v); if (Number.isNaN(n)) return n; if (lo != null) n = Math.max(lo, n); if (hi != null) n = Math.min(hi, n); return n; };
  },

  // -- text
  trim: () => (v) => toText(v).trim(),
  lower: () => (v) => toText(v).toLowerCase(),
  upper: () => (v) => toText(v).toUpperCase(),
  capitalize: () => (v) => toText(v).replace(/^./, (ch) => ch.toUpperCase()),
  title: () => (v) => titleCase(toText(v)),
  humanize: () => (v) => humanize(v),
  prefix: (arg, at) => { const e = compileExpr(arg, at); return (v, s, c) => (isEmpty(v) ? v : toText(e(s, c)) + toText(v)); },
  suffix: (arg, at) => { const e = compileExpr(arg, at); return (v, s, c) => (isEmpty(v) ? v : toText(v) + toText(e(s, c))); },
  /**
   * {"template": "… {{.}} …"} — paths are into the value ("{{.}}" is the value itself, "{{a.b}}" a
   * key of it); "{{^.x}}" is the scope around, "{{~.x}}" the document. Empty values pass through.
   */
  template: (arg, at) => {
    if (typeof arg !== 'string') throw new RulesError('expected a string', at);
    const t = compileTemplate(arg, at);
    return (v, s) => (isEmpty(v) ? v : t(childScope(s, v, s.index)));
  },
  /** {"truncate": n} — at most n characters. */
  truncate: (arg) => (v) => (typeof v === 'string' ? v.slice(0, Number(arg) || 0) : v),
  /** {"replace": [pattern, replacement, flags?]} — flags default to "g". */
  replace: (arg, at) => {
    if (!Array.isArray(arg) || arg.length < 2) throw new RulesError('expected [pattern, replacement, flags?]', at);
    const re = regex([arg[0], arg[2] ?? 'g'], at);
    return (v) => toText(v).replace(re, arg[1]);
  },
  /** {"match": pattern} or {"match": [pattern, flags, group]} — the matched text (or group), else nothing. */
  match: (arg, at) => {
    const re = regex(arg, at);
    const group = Array.isArray(arg) ? arg[2] ?? 0 : 0;
    return (v) => { const m = re.exec(toText(v)); return m ? m[group] : undefined; };
  },
  /** {"test": pattern} — true if it matches. Pattern alone, or [pattern, flags]. */
  test: (arg, at) => { const re = regex(arg, at); return (v) => re.test(toText(v)); },
  split: (arg) => (v) => (isEmpty(v) ? [] : toText(v).split(arg ?? ',').map((x) => x.trim()).filter(Boolean)),
  markdown: () => (v) => htmlToMarkdown(v),
  stripHtml: () => (v) => stripHtml(v),
  embeds: () => (v) => foundryEmbeds(toText(v)),
  /** Repairs doubled characters (see text.mjs), and counts the repair. */
  fixDoubled: () => (v, s, c) => {
    const r = fixDoubled(v);
    if (r.fixed) c?.count?.('Text with doubled characters repaired');
    return r.text;
  },
  /** A localisation key resolved against the lang files given with the import; nothing if absent. */
  lang: () => (v, s, c) => {
    if (isEmpty(v)) return undefined;
    const r = resolveKey(toText(v), c?.lang);
    if (r == null) c?.count?.('Localisation keys not found (add the system’s lang files)', toText(v));
    return r ?? undefined;
  },

  // -- lookups
  /** {"lookup": "tableName" | {…}, "else": E} — the table's value for this one; else `else`, or the value unchanged. */
  lookup: (arg, at, spec) => {
    const hasElse = 'else' in spec;
    const elseFn = hasElse ? compileExpr(spec.else, `${at}.else`) : null;
    if (typeof arg !== 'string' && !isObject(arg)) throw new RulesError('expected a table name or an object', at);
    return (v, s, c) => {
      const table = typeof arg === 'string' ? c?.tables?.[arg] : arg;
      if (!table) throw new RulesError(`no table "${arg}" in "tables"`, at);
      const k = toText(v);
      return Object.hasOwn(table, k) ? structuredClone(table[k]) : hasElse ? elseFn(s, c) : v;
    };
  },
  /** {"oneOf": [allowed…], "else": E} — the value if it's allowed, else `else` (default nothing). */
  oneOf: (arg, at, spec) => {
    if (!Array.isArray(arg)) throw new RulesError('expected a list of allowed values', at);
    const elseFn = 'else' in spec ? compileExpr(spec.else, `${at}.else`) : () => undefined;
    return (v, s, c) => (arg.some((a) => loose(a, v)) ? v : elseFn(s, c));
  },
  /** {"get": "a.b"} — a path into the value. */
  get: (arg, at) => { if (typeof arg !== 'string') throw new RulesError('expected a path', at); return (v) => getPath(v, arg.replace(/^\$\.?/, '')); },

  // -- lists
  length: () => (v) => (v == null ? 0 : Array.isArray(v) || typeof v === 'string' ? v.length : isObject(v) ? Object.keys(v).length : 1),
  first: () => (v) => (Array.isArray(v) ? v[0] : v),
  last: () => (v) => (Array.isArray(v) ? v.at(-1) : v),
  /** {"at": i} — negative counts from the end. */
  at: (arg) => (v) => (Array.isArray(v) || typeof v === 'string' ? v.at(Number(arg) || 0) : undefined),
  /** {"slice": [start, end?]} for lists and text. */
  slice: (arg, at) => {
    const [a, b] = Array.isArray(arg) ? arg : [arg];
    if (typeof a !== 'number') throw new RulesError('expected [start, end?]', at);
    return (v) => (Array.isArray(v) || typeof v === 'string' ? v.slice(a, b ?? undefined) : v);
  },
  compact: () => (v) => asList(v).filter((x) => !isEmpty(x)),
  flatten: () => (v) => asList(v).flat(),
  unique: () => (v) => [...new Set(asList(v).map((x) => (isObject(x) ? JSON.stringify(x) : x)))].map((x) => (typeof x === 'string' && /^[{[]/.test(x) ? JSON.parse(x) : x)),
  reverse: () => (v) => [...asList(v)].reverse(),
  sort: () => (v) => [...asList(v)].sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : toText(a).localeCompare(toText(b)))),
  keys: () => (v) => (isObject(v) ? Object.keys(v) : []),
  values: () => (v) => (isObject(v) ? Object.values(v) : asList(v)),
  /** An object as [{key, value}, …]. */
  entries: () => (v) => (isObject(v) ? Object.entries(v).map(([key, value]) => ({ key, value })) : asList(v)),
  sum: () => (v) => asList(v).reduce((a, x) => a + (toNumber(x) || 0), 0),
  largest: () => (v) => { const l = asList(v).map(toNumber).filter(Number.isFinite); return l.length ? Math.max(...l) : undefined; },
  smallest: () => (v) => { const l = asList(v).map(toNumber).filter(Number.isFinite); return l.length ? Math.min(...l) : undefined; },
  /** {"join": sep} — a list as text. */
  join: (arg) => (v) => asList(v).filter((x) => !isEmpty(x)).map(toText).join(arg ?? ', '),
  /** {"each": T | [T…]} — transforms on every element. */
  each: (arg, at) => { const f = perElement(arg, at); return (v, s, c) => asList(v).map((el, i) => f(el, i, s, c)); },
  /** {"where": T | [T…]} — the elements the transforms say yes to. */
  where: (arg, at) => { const f = perElement(arg, at); return (v, s, c) => asList(v).filter((el, i) => truthy(f(el, i, s, c))); },
  /** {"find": T | [T…]} — the first such element. */
  find: (arg, at) => { const f = perElement(arg, at); return (v, s, c) => asList(v).find((el, i) => truthy(f(el, i, s, c))); },
  /** {"includes": E} — does the list (or text) contain it? */
  includes: cmpArg((v, x) => (Array.isArray(v) ? v.some((y) => loose(y, x)) : toText(v).includes(toText(x)))),

  // -- tests (true or false)
  eq: cmpArg((a, b) => loose(a, b)),
  ne: cmpArg((a, b) => !loose(a, b)),
  gt: numArg((a, b) => a > b),
  gte: numArg((a, b) => a >= b),
  lt: numArg((a, b) => a < b),
  lte: numArg((a, b) => a <= b),
  /** {"in": [values…]} (literal). */
  in: (arg, at) => { if (!Array.isArray(arg)) throw new RulesError('expected a list', at); return (v) => arg.some((a) => loose(a, v)); },
  not: () => (v) => !truthy(v),
  truthy: () => (v) => truthy(v),
  empty: () => (v) => isEmpty(v) || (Array.isArray(v) && !v.length) || (isObject(v) && !Object.keys(v).length),
  present: () => (v) => !(isEmpty(v) || (Array.isArray(v) && !v.length)),
  /** {"then": E, "else": E} — after a test: E for true, the other for false. */
  then: (arg, at, spec) => {
    const yes = compileExpr(arg, at);
    const no = 'else' in spec ? compileExpr(spec.else, `${at}.else`) : () => undefined;
    return (v, s, c) => (truthy(v) ? yes(s, c) : no(s, c));
  },
};

/** Extra keys some transforms take beside their own. */
const EXTRA_KEYS = { lookup: ['else'], oneOf: ['else'], then: ['else'] };

export function compileTransform(spec, at) {
  if (typeof spec === 'string') {
    if (!Object.hasOwn(TRANSFORMS, spec)) throw new RulesError(`"${spec}" is not a transform${suggest(spec)}`, at);
    return TRANSFORMS[spec](undefined, at, {});
  }
  if (isObject(spec)) {
    const keys = Object.keys(spec);
    const name = keys.find((k) => Object.hasOwn(TRANSFORMS, k));
    if (!name) throw new RulesError(`${keys[0] ? `"${keys[0]}" is not a transform${suggest(keys[0])}` : 'an empty transform'}`, at);
    onlyKeys(spec, [name, ...(EXTRA_KEYS[name] ?? [])], at);
    return TRANSFORMS[name](spec[name], `${at}.${name}`, spec);
  }
  throw new RulesError(`a transform is a name or {"name": arg}, not ${JSON.stringify(spec)}`, at);
}

/** Edit distance (with swaps), for "did you mean". */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
function suggest(name, names = Object.keys(TRANSFORMS)) {
  const lower = String(name).toLowerCase();
  let best = null;
  let bestD = Infinity;
  for (const k of names) {
    const dd = distance(lower, k.toLowerCase());
    if (dd < bestD) { best = k; bestD = dd; }
  }
  return best && bestD <= Math.max(1, Math.floor(lower.length / 3)) ? ` (did you mean "${best}"?)` : '';
}

export const TRANSFORM_NAMES = Object.keys(TRANSFORMS);
export const OPERATOR_NAMES = Object.keys(EXPR_OPS);
