/**
 * Lightweight JavaScript/TypeScript scanner for script actions in event sheets.
 *
 * This is not a parser. It tokenizes just enough to tell code apart from
 * comments and from string, template and regex literal text, to spot property
 * accesses and member names (object keys, class fields, TypeScript types),
 * and to collect names a script declares itself. The runtime-trap analyzer
 * uses it to find event parameters used as bare identifiers, literal
 * runtime.signal()/runtime.waitForSignal() calls, and the names an "Imports
 * for events" script puts in scope.
 *
 * Every heuristic here errs towards NOT reporting: a missed finding is
 * cheaper than a false warning on working code.
 */

export interface ScriptToken {
  kind: 'ident' | 'string' | 'punct' | 'other';
  /** Identifier name, decoded string value, or punctuator text */
  value: string;
  /** 1-based line of the token start */
  line: number;
  /** True when a line break separates this token from the previous one */
  nlBefore: boolean;
}

/**
 * Return the source text of a script action or script block.
 * Construct 3 saves `script` as an array of lines (next to a `language` key);
 * older saves and this server's own writer use a single string. Accept both.
 */
export function getScriptSource(script: unknown): string | null {
  if (typeof script === 'string') return script;
  if (Array.isArray(script)) {
    return script.filter((line): line is string => typeof line === 'string').join('\n');
  }
  return null;
}

const PUNCT_BY_LENGTH: string[][] = [
  ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??='],
  ['=>', '?.', '==', '!=', '<=', '>=', '&&', '||', '??', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'],
];

/** Keywords after which a `/` starts a regex literal rather than a division */
const REGEX_AFTER_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

const IDENT_START = /[\p{ID_Start}$_]/u;
const IDENT_PART = /[\p{ID_Continue}$\u200C\u200D]/u;

/** Token pushed for a template's `${` (head or middle); a regex may follow it */
const TEMPLATE_SUBST = '${';
/** Token pushed for a template's closing text after the last substitution */
const TEMPLATE_TAIL = '`';

/** Tokenize JS/TS source. Comments are dropped; literals become single tokens. */
export function tokenizeScript(src: string): ScriptToken[] {
  const tokens: ScriptToken[] = [];
  // Open braces: 'block' for `{`, 'template' for a `${` substitution
  const braceStack: Array<'block' | 'template'> = [];
  let i = 0;
  let line = 1;
  let nlBefore = false;
  const n = src.length;

  const push = (kind: ScriptToken['kind'], value: string, startLine: number) => {
    tokens.push({ kind, value, line: startLine, nlBefore });
    nlBefore = false;
  };

  /** Read template text from `pos` until the closing backtick or a `${`. */
  const readTemplate = (pos: number): { end: number; closed: boolean; text: string } => {
    let text = '';
    while (pos < n) {
      const ch = src[pos];
      if (ch === '\\') {
        const decoded = decodeEscape(src, pos);
        text += decoded.value;
        for (let k = pos; k < decoded.end; k++) if (src[k] === '\n') line++;
        pos = decoded.end;
        continue;
      }
      if (ch === '`') return { end: pos + 1, closed: true, text };
      if (ch === '$' && src[pos + 1] === '{') return { end: pos + 2, closed: false, text };
      if (ch === '\n') line++;
      text += ch;
      pos++;
    }
    return { end: n, closed: true, text };
  };

  while (i < n) {
    const ch = src[i];

    if (ch === '\n') { line++; nlBefore = true; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }

    // Comments
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) if (src[k] === '\n') { line++; nlBefore = true; }
      i = stop;
      continue;
    }

    const startLine = line;

    // String literals
    if (ch === '"' || ch === "'") {
      let value = '';
      let j = i + 1;
      while (j < n && src[j] !== ch && src[j] !== '\n') {
        if (src[j] === '\\') {
          const decoded = decodeEscape(src, j);
          value += decoded.value;
          j = decoded.end;
        } else {
          value += src[j++];
        }
      }
      i = j < n && src[j] === ch ? j + 1 : j;
      push('string', value, startLine);
      continue;
    }

    // Template literals: text is skipped, ${...} substitutions are tokenized as code
    if (ch === '`') {
      const t = readTemplate(i + 1);
      i = t.end;
      if (t.closed) {
        push('string', t.text, startLine);
      } else {
        push('other', TEMPLATE_SUBST, startLine);
        braceStack.push('template');
      }
      continue;
    }

    // Identifiers and keywords
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(src[j])) j++;
      push('ident', src.slice(i, j), startLine);
      i = j;
      continue;
    }

    // Numbers (loose: digits, hex, exponents, separators, decimals)
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      push('other', src.slice(i, j), startLine);
      i = j;
      continue;
    }

    // Regex literal (when a `/` cannot be a division)
    if (ch === '/' && regexAllowed(tokens)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++;
      push('other', 'regex', startLine);
      i = j;
      continue;
    }

    // Braces (tracked so template substitutions end at the right `}`)
    if (ch === '{') {
      braceStack.push('block');
      push('punct', '{', startLine);
      i++;
      continue;
    }
    if (ch === '}') {
      const kind = braceStack.pop();
      if (kind === 'template') {
        const t = readTemplate(i + 1);
        i = t.end;
        if (t.closed) {
          push('other', TEMPLATE_TAIL, startLine);
        } else {
          push('other', TEMPLATE_SUBST, startLine);
          braceStack.push('template');
        }
        continue;
      }
      push('punct', '}', startLine);
      i++;
      continue;
    }

    // Multi-character punctuators, longest first
    let matched = false;
    for (const group of PUNCT_BY_LENGTH) {
      for (const p of group) {
        if (src.startsWith(p, i)) {
          // `?.5` is a conditional followed by a number, not optional chaining
          if (p === '?.' && /[0-9]/.test(src[i + 2] ?? '')) continue;
          push('punct', p, startLine);
          i += p.length;
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
    if (matched) continue;

    push('punct', ch, startLine);
    i++;
  }

  return tokens;
}

/** Keywords whose parenthesized header can be followed directly by a statement */
const HEADER_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

/** Can a `/` after the tokens read so far start a regex literal (rather than divide)? */
function regexAllowed(tokens: ScriptToken[]): boolean {
  const prev = tokens[tokens.length - 1];
  if (!prev) return true;
  if (prev.kind === 'ident') return REGEX_AFTER_KEYWORDS.has(prev.value);
  if (prev.kind === 'other') return prev.value === TEMPLATE_SUBST;
  if (prev.kind !== 'punct') return false;
  // A postfix ++/-- or a closing bracket ends an operand: `/` divides
  if (prev.value === ']' || prev.value === '++' || prev.value === '--') return false;
  if (prev.value === ')') {
    // ...except after an `if (...)` / `while (...)` / `for (...)` header
    const open = findOpen(tokens, tokens.length - 1);
    const keyword = open > 0 ? tokens[open - 1] : undefined;
    return keyword?.kind === 'ident' && HEADER_KEYWORDS.has(keyword.value);
  }
  return true;
}

/** Decode one backslash escape starting at `pos` (which holds the backslash). */
function decodeEscape(src: string, pos: number): { value: string; end: number } {
  const c = src[pos + 1];
  if (c === undefined) return { value: '', end: pos + 1 };
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
  if (c in simple) return { value: simple[c], end: pos + 2 };
  if (c === '\n') return { value: '', end: pos + 2 };
  if (c === 'x' && /^[0-9a-f]{2}$/i.test(src.slice(pos + 2, pos + 4))) {
    return { value: String.fromCharCode(parseInt(src.slice(pos + 2, pos + 4), 16)), end: pos + 4 };
  }
  if (c === 'u') {
    if (src[pos + 2] === '{') {
      const close = src.indexOf('}', pos + 3);
      const hex = close === -1 ? '' : src.slice(pos + 3, close);
      if (/^[0-9a-f]{1,6}$/i.test(hex)) {
        return { value: String.fromCodePoint(parseInt(hex, 16)), end: close + 1 };
      }
    } else if (/^[0-9a-f]{4}$/i.test(src.slice(pos + 2, pos + 6))) {
      return { value: String.fromCharCode(parseInt(src.slice(pos + 2, pos + 6), 16)), end: pos + 6 };
    }
  }
  return { value: c, end: pos + 2 };
}

// ─── Brackets ───────────────────────────────────────────────

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'with', 'function']);

const isPunct = (t: ScriptToken | undefined, value: string) => t?.kind === 'punct' && t.value === value;

/** Index of the bracket matching the opener at `open`, or -1. */
function findClose(tokens: ScriptToken[], open: number): number {
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind !== 'punct') continue;
    if (t.value in OPENERS) depth++;
    else if (CLOSERS.has(t.value) && --depth === 0) return k;
  }
  return -1;
}

/** Index of the opener matching the closer at `close`, or -1. */
function findOpen(tokens: ScriptToken[], close: number): number {
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    const t = tokens[k];
    if (t.kind !== 'punct') continue;
    if (CLOSERS.has(t.value)) depth++;
    else if (t.value in OPENERS && --depth === 0) return k;
  }
  return -1;
}

/** Punctuators that, at the end of a line, mean the expression continues. */
function lineContinues(prev: ScriptToken, next: ScriptToken): boolean {
  if (next.kind === 'punct' && ['.', '?.', '?', ':', ',', '=', '+', '-', '*', '/', '%', '&&', '||', '??', '=>'].includes(next.value)) {
    return true;
  }
  return prev.kind === 'punct' && !CLOSERS.has(prev.value) && prev.value !== '++' && prev.value !== '--';
}

// ─── TypeScript types ───────────────────────────────────────

/** Punctuators that can appear at the top level of a type argument list `<...>` */
const TYPE_ARG_PUNCT = new Set([',', '.', '|', '&', '=>', '...']);

/** Type operators that prefix a type: `keyof T`, `typeof x`, `readonly T[]`, `new () => T` */
const TYPE_PREFIX_WORDS = new Set(['keyof', 'typeof', 'readonly', 'unique', 'infer', 'asserts', 'new', 'abstract']);

const startsType = (t: ScriptToken | undefined) => t !== undefined
  && (t.kind === 'ident' || t.kind === 'string' || isPunct(t, '{') || isPunct(t, '[') || isPunct(t, '(') || isPunct(t, '<'));

/**
 * Index just after the `>` that closes the type argument list opening at
 * `open`, or -1 when the tokens cannot be type arguments (so `a < b` stays a
 * comparison): anything but names, literals, bracket groups and the
 * punctuators types use ends the attempt, as in TypeScript's own parse.
 */
function skipTypeArgs(tokens: ScriptToken[], open: number): number {
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind !== 'punct') {
      if (t.value === TEMPLATE_SUBST || t.value === TEMPLATE_TAIL) return -1;
      continue;
    }
    if (t.value === '<') depth++;
    else if (t.value === '>' || t.value === '>>' || t.value === '>>>') {
      depth -= t.value.length;
      if (depth <= 0) return depth === 0 ? k + 1 : -1;
    } else if (t.value in OPENERS) {
      const close = findClose(tokens, k);
      if (close === -1) return -1;
      k = close;
    } else if (!TYPE_ARG_PUNCT.has(t.value)) {
      return -1;
    }
  }
  return -1;
}

/**
 * Last token index of the TypeScript type that starts at `start` (start - 1
 * when none does): names (`a.b`), literals, type literals, tuples,
 * parenthesized and function types, type arguments, array and indexed access
 * types, unions, intersections and `x is T` predicates.
 */
function typeEnd(tokens: ScriptToken[], start: number): number {
  let k = start;
  if (isPunct(tokens[k], '|') || isPunct(tokens[k], '&')) k++;
  for (;;) {
    while (tokens[k]?.kind === 'ident' && TYPE_PREFIX_WORDS.has(tokens[k].value) && startsType(tokens[k + 1])) k++;
    const t = tokens[k];
    if (!t) return k - 1;
    if (t.kind === 'ident' || t.kind === 'string' || (t.kind === 'other' && t.value !== TEMPLATE_SUBST && t.value !== TEMPLATE_TAIL)) {
      k++;
    } else if (isPunct(t, '{') || isPunct(t, '[')) {
      const close = findClose(tokens, k);
      if (close === -1) return tokens.length - 1;
      k = close + 1;
    } else if (isPunct(t, '(') || isPunct(t, '<')) {
      // Parenthesized type, or a function type: (a: T) => R, <T>(a: T) => R
      const open = isPunct(t, '<') ? skipTypeArgs(tokens, k) : k;
      if (!isPunct(tokens[open], '(')) return k - 1;
      const close = findClose(tokens, open);
      if (close === -1) return tokens.length - 1;
      k = close + 1;
      if (isPunct(tokens[k], '=>')) {
        k++;
        continue; // the return type follows
      }
    } else {
      return k - 1;
    }

    // Postfix: qualified names, type arguments, array and indexed access types
    for (;;) {
      const p = tokens[k];
      if (isPunct(p, '.') && tokens[k + 1]?.kind === 'ident') {
        k += 2;
      } else if (isPunct(p, '<') && !p!.nlBefore) {
        const after = skipTypeArgs(tokens, k);
        if (after === -1) break;
        k = after;
      } else if (isPunct(p, '[') && !p!.nlBefore) {
        const close = findClose(tokens, k);
        if (close === -1) return tokens.length - 1;
        k = close + 1;
      } else {
        break;
      }
    }

    const op = tokens[k];
    if (isPunct(op, '|') || isPunct(op, '&') || (op?.kind === 'ident' && op.value === 'is' && !op.nlBefore)) {
      k++;
      continue;
    }
    return k - 1;
  }
}

/**
 * Index of the `{` that opens the body of a function whose parameter list
 * closes at `close`, skipping a return type (`): T {`); -1 if there is none.
 */
function functionBodyOpen(tokens: ScriptToken[], close: number): number {
  let k = close + 1;
  if (isPunct(tokens[k], ':')) k = typeEnd(tokens, k + 1) + 1;
  return isPunct(tokens[k], '{') ? k : -1;
}

// ─── Declared names ─────────────────────────────────────────

/** Declare every identifier in a binding list, except property names and default values. */
function declareRange(tokens: ScriptToken[], from: number, to: number, declared: Set<string>): void {
  for (let k = from; k <= to; k++) {
    const t = tokens[k];
    if (t.kind !== 'ident') continue;
    const prev = tokens[k - 1];
    if (prev && prev.kind === 'punct' && (prev.value === '.' || prev.value === '?.' || prev.value === '=')) continue;
    declared.add(t.value);
  }
}

/** A parameter and the tokens it is visible in (its function or catch clause) */
interface ScopedBinding {
  name: string;
  from: number;
  to: number;
}

interface Declarations {
  /** let/const/var bindings and function, class, enum, type and interface names (script-wide) */
  names: Set<string>;
  /** Parameters of the script's own functions, arrows, methods and catch clauses */
  params: ScopedBinding[];
}

/** Index of the `}` closing the body opened at `open`, or the last token when unsure. */
function bodyEnd(tokens: ScriptToken[], open: number): number {
  const close = open === -1 ? -1 : findClose(tokens, open);
  return close === -1 ? tokens.length - 1 : close;
}

/**
 * Last token of an arrow function's body: the `}` of a block body, or for a
 * concise body the token before the first `,` `;` or unmatched closer at its
 * depth, or before a line break that does not continue the expression.
 */
function arrowBodyEnd(tokens: ScriptToken[], arrow: number): number {
  if (isPunct(tokens[arrow + 1], '{')) return bodyEnd(tokens, arrow + 1);
  let depth = 0;
  for (let k = arrow + 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (depth === 0 && k > arrow + 1 && t.nlBefore && !lineContinues(tokens[k - 1], t)) return k - 1;
    if (t.kind !== 'punct') continue;
    if (t.value in OPENERS) depth++;
    else if (CLOSERS.has(t.value)) {
      if (depth === 0) return k - 1;
      depth--;
    } else if (depth === 0 && (t.value === ',' || t.value === ';')) {
      return k - 1;
    }
  }
  return tokens.length - 1;
}

/** Does the identifier at `i` name a class or object member (`{ go(`, `static go(`, `*go(`)? */
function isMemberName(tokens: ScriptToken[], i: number): boolean {
  const prev = tokens[i - 1];
  return startsEntry(prev, tokens[i]) || isPunct(prev, '*')
    || (prev?.kind === 'ident' && MEMBER_MODIFIERS.has(prev.value) && !tokens[i].nlBefore);
}

/**
 * Collect the names the script declares. let/const/var bindings and
 * function/class/type names count for the whole script (scope-insensitive on
 * purpose: over-declaring only hides findings, it never invents one).
 * Parameters count only inside their own function or catch clause, so
 * `function helper(mode) {...}` does not hide a bare `mode` elsewhere.
 */
function collectDeclarations(tokens: ScriptToken[]): Declarations {
  const names = new Set<string>();
  const params: ScopedBinding[] = [];
  /** Parameters in tokens from..to, visible in tokens scopeFrom..scopeTo */
  const addParams = (from: number, to: number, scopeFrom: number, scopeTo: number) => {
    const found = new Set<string>();
    declareRange(tokens, from, to, found);
    for (const name of found) params.push({ name, from: scopeFrom, to: scopeTo });
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];

    if (t.kind === 'ident' && (t.value === 'let' || t.value === 'const' || t.value === 'var') && next) {
      declareVariableList(tokens, i + 1, names);
      continue;
    }

    if (t.kind === 'ident' && t.value === 'function') {
      let k = i + 1;
      if (isPunct(tokens[k], '*')) k++;
      if (tokens[k]?.kind === 'ident') names.add(tokens[k++].value);
      if (isPunct(tokens[k], '<')) {
        const after = skipTypeArgs(tokens, k); // function f<T>(a: T)
        if (after !== -1) k = after;
      }
      if (isPunct(tokens[k], '(')) {
        const close = findClose(tokens, k);
        // Without a recognizable body, the parameters stay visible to the end of the script
        if (close !== -1) addParams(k + 1, close - 1, k, bodyEnd(tokens, functionBodyOpen(tokens, close)));
      }
      continue;
    }

    if (t.kind === 'ident' && ['class', 'interface', 'enum', 'namespace', 'type'].includes(t.value)
      && next?.kind === 'ident' && !next.nlBefore) {
      names.add(next.value);
      continue;
    }

    if (t.kind === 'ident' && t.value === 'catch' && isPunct(next, '(')) {
      const close = findClose(tokens, i + 1);
      if (close !== -1) {
        addParams(i + 2, close - 1, i + 1, bodyEnd(tokens, isPunct(tokens[close + 1], '{') ? close + 1 : -1));
      }
      continue;
    }

    // Arrow function parameters: `x =>`, `(a, b) =>`, `(a: T): R =>`
    if (t.kind === 'punct' && t.value === '=>') {
      const end = arrowBodyEnd(tokens, i);
      const prev = tokens[i - 1];
      if (prev?.kind === 'ident') {
        // `(a): R =>` — the identifier is a return type and (a) holds the parameters.
        // `{ key: x => x }` and `c ? f() : x => x` also put `:` before `x`, so
        // only a `(...)` that is not a call counts as the parameter list.
        const paramList = isPunct(tokens[i - 2], ':') && isPunct(tokens[i - 3], ')')
          ? arrowParamListOpen(tokens, i - 3)
          : -1;
        if (paramList !== -1) addParams(paramList + 1, i - 4, paramList, end);
        else params.push({ name: prev.value, from: i - 1, to: end });
      } else {
        const close = isPunct(prev, ')') ? i - 1 : findReturnTypedParamClose(tokens, i);
        const open = close === -1 ? -1 : findOpen(tokens, close);
        if (open !== -1) addParams(open + 1, close - 1, open, end);
      }
      continue;
    }

    // Method / function shorthand: `name(a, b) {`, and `name(a: T): R {` in a class or object
    if (t.kind === 'ident' && !CONTROL_KEYWORDS.has(t.value) && isPunct(next, '(')) {
      const close = findClose(tokens, i + 1);
      if (close === -1) continue;
      const open = isPunct(tokens[close + 1], '{')
        ? close + 1
        : isPunct(tokens[close + 1], ':') && isMemberName(tokens, i) ? functionBodyOpen(tokens, close) : -1;
      if (open !== -1) addParams(i + 2, close - 1, i + 1, bodyEnd(tokens, open));
    }
  }

  return { names, params };
}

/**
 * Collect every name the script declares anywhere, parameters included
 * (scope-insensitive: over-declaring only hides findings, it never invents one).
 */
export function collectDeclaredNames(tokens: ScriptToken[]): Set<string> {
  const { names, params } = collectDeclarations(tokens);
  for (const p of params) names.add(p.name);
  return names;
}

/**
 * Opener of the `(...)` closed at `close` when it can be an arrow parameter
 * list, or -1 when it is a call's argument list (`f(...)`, `a[0](...)`).
 */
function arrowParamListOpen(tokens: ScriptToken[], close: number): number {
  const open = findOpen(tokens, close);
  if (open === -1) return -1;
  const before = tokens[open - 1];
  const isCall = before !== undefined && (
    (before.kind === 'ident' && before.value !== 'async' && !REGEX_AFTER_KEYWORDS.has(before.value))
    || (before.kind === 'punct' && CLOSERS.has(before.value))
  );
  return isCall ? -1 : open;
}

/** For `(a: T): R =>`, walk back from the arrow to the `)` that is followed by `:`. */
function findReturnTypedParamClose(tokens: ScriptToken[], arrow: number): number {
  for (let k = arrow - 1; k >= 0 && arrow - k < 64; k--) {
    const t = tokens[k];
    if (t.kind !== 'punct') continue;
    if (t.value === ';') return -1;
    if (CLOSERS.has(t.value)) {
      if (t.value === ')' && tokens[k + 1]?.value === ':') return k;
      const open = findOpen(tokens, k);
      if (open === -1) return -1;
      k = open;
    }
  }
  return -1;
}

/**
 * Skip a declarator's type annotation and/or initializer starting at `j`:
 * index of the next declarator after a depth-0 `,`, or -1 when the
 * declaration ends first.
 */
function nextDeclarator(tokens: ScriptToken[], j: number): number {
  let depth = 0;
  for (; j < tokens.length; j++) {
    const cur = tokens[j];
    if (depth === 0 && cur.nlBefore && !lineContinues(tokens[j - 1], cur)) return -1;
    if (cur.kind === 'punct') {
      if (cur.value in OPENERS) depth++;
      else if (CLOSERS.has(cur.value)) {
        if (depth === 0) return -1;
        depth--;
      } else if (depth === 0 && cur.value === ',') return j + 1;
      else if (depth === 0 && cur.value === ';') return -1;
    } else if (depth === 0 && cur.kind === 'ident' && (cur.value === 'of' || cur.value === 'in')) {
      return -1;
    }
  }
  return -1;
}

/** Declare the bindings of `let/const/var a = 1, { b } = o, [c] = arr`. */
function declareVariableList(tokens: ScriptToken[], start: number, declared: Set<string>): void {
  let j = start;
  while (j !== -1 && j < tokens.length) {
    const t = tokens[j];
    if (t.kind === 'ident') {
      declared.add(t.value);
      j++;
    } else if (t.kind === 'punct' && (t.value === '{' || t.value === '[')) {
      const close = findClose(tokens, j);
      if (close === -1) return;
      declareRange(tokens, j + 1, close - 1, declared);
      j = close + 1;
    } else {
      return;
    }
    j = nextDeclarator(tokens, j);
  }
}

/** TypeScript: mark the type annotations of `let/const/var a: T = 1, { b }: U = o`. */
function markDeclaratorTypes(tokens: ScriptToken[], start: number, mark: (from: number, to: number) => void): void {
  let j = start;
  while (j !== -1 && j < tokens.length) {
    const t = tokens[j];
    if (t.kind === 'ident') {
      j++;
    } else if (isPunct(t, '{') || isPunct(t, '[')) {
      const close = findClose(tokens, j);
      if (close === -1) return;
      j = close + 1;
    } else {
      return;
    }
    if (isPunct(tokens[j], '!') && isPunct(tokens[j + 1], ':')) j++; // let x!: T
    if (isPunct(tokens[j], ':')) {
      const end = typeEnd(tokens, j + 1);
      mark(j, end);
      j = end + 1;
    }
    j = nextDeclarator(tokens, j);
  }
}

// ─── Bare identifier uses ───────────────────────────────────

/** Words that can never be a variable reference */
const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await', 'implements',
  'interface', 'package', 'private', 'protected', 'public',
]);

/**
 * Names that resolve in an event-sheet script without being declared:
 * the `runtime` and `localVars` variables Construct provides (C3 manual,
 * "Scripts in event sheets") plus common JavaScript/browser globals.
 */
const SCRIPT_GLOBALS = new Set([
  'runtime', 'localVars', 'globalThis', 'window', 'self', 'document', 'navigator', 'console',
  'Math', 'JSON', 'Date', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Promise', 'Symbol',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Reflect',
  'Proxy', 'Intl', 'BigInt', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'undefined', 'NaN',
  'Infinity', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'fetch', 'alert',
  'arguments',
]);

/** TypeScript type keywords that appear bare in annotations */
const TS_TYPE_WORDS = new Set([
  'string', 'number', 'boolean', 'any', 'unknown', 'never', 'object', 'symbol', 'bigint', 'void',
  'readonly', 'keyof', 'infer', 'declare', 'abstract',
]);

/** Identifiers that may legitimately follow a value reference on the same line */
const OPERATOR_WORDS = new Set(['in', 'instanceof', 'as', 'satisfies', 'of']);

/** Words after which an identifier is in a type position, not a value position */
const TYPE_POSITION_WORDS = new Set(['typeof', 'as', 'satisfies', 'keyof', 'infer', 'is']);

/** Class member modifiers: the identifier after one of these names a member */
const MEMBER_MODIFIERS = new Set([
  'static', 'get', 'set', 'async', 'readonly', 'private', 'public', 'protected', 'declare',
  'abstract', 'override', 'accessor',
]);

/** Words that start a new statement, ending a type alias that has no `;` */
const STATEMENT_WORDS = new Set([
  'const', 'let', 'var', 'if', 'for', 'while', 'do', 'return', 'function', 'class', 'type',
  'interface', 'enum', 'switch', 'try', 'throw', 'await',
]);

type BodyKind = 'class' | 'enum';

interface ScriptStructure {
  /**
   * True for tokens of `interface X {...}` and `type X = ...`, and in
   * TypeScript for annotations, return types and type arguments (type positions only)
   */
  typeOnly: boolean[];
  /** Opening `{` of class and enum bodies */
  bodies: Map<number, BodyKind>;
}

/**
 * Index of the `{` that opens the body of a declaration starting after `from`,
 * skipping (), [] and generic <> nesting; -1 if a `;` or closer comes first.
 */
function findBodyOpen(tokens: ScriptToken[], from: number): number {
  let depth = 0;
  let angle = 0;
  for (let k = from; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind !== 'punct') continue;
    if (t.value === '(' || t.value === '[') depth++;
    else if (t.value === ')' || t.value === ']') {
      if (--depth < 0) return -1;
    } else if (t.value === '<') angle++;
    else if (t.value === '>' || t.value === '>>' || t.value === '>>>') angle = Math.max(0, angle - t.value.length);
    else if (t.value === '{') {
      if (depth === 0 && angle === 0) return k;
      const close = findClose(tokens, k); // e.g. `<T extends { a: 1 }>`
      if (close === -1) return -1;
      k = close;
    } else if ((t.value === ';' || t.value === '}') && depth === 0) {
      return -1;
    }
  }
  return -1;
}

/** Last token index of a `type X = ...` alias whose `=` is at `assign`. */
function typeAliasEnd(tokens: ScriptToken[], assign: number): number {
  let depth = 0;
  for (let k = assign + 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (depth === 0 && t.nlBefore && k > assign + 1) {
      const prev = tokens[k - 1];
      const continues = lineContinues(prev, t) || isPunct(t, '|') || isPunct(t, '&');
      if (!continues || (t.kind === 'ident' && STATEMENT_WORDS.has(t.value))) return k - 1;
    }
    if (t.kind !== 'punct') continue;
    if (t.value in OPENERS) depth++;
    else if (CLOSERS.has(t.value)) {
      if (depth === 0) return k - 1;
      depth--;
    } else if (depth === 0 && t.value === ';') {
      return k;
    }
  }
  return tokens.length - 1;
}

/**
 * Can `t` end an operand (`x`, `this`, `"s"`, `1`, `)`), so that an `as` /
 * `satisfies` after it is the operator rather than a variable named `as`?
 */
const endsOperand = (t: ScriptToken | undefined) => t !== undefined
  && (t.kind !== 'punct' || isPunct(t, ')') || isPunct(t, ']') || isPunct(t, '}'));

/**
 * TypeScript: mark the types the compiler erases from value code. Variable
 * annotations (`let m: T = ...`), return types (`function f(): T {`,
 * `(a): T =>`, `go(): T {` in a class or object), the type after `as` /
 * `satisfies`, and type arguments of calls (`new Map<K, V>()`, `f<T>(x)`).
 * Parameter annotations need no marking: parameter lists are declarations.
 */
function markTypeAnnotations(tokens: ScriptToken[], mark: (from: number, to: number) => void): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1];

    if (t.kind === 'punct') {
      if (t.value === '<' && prev?.kind === 'ident') {
        const after = skipTypeArgs(tokens, i);
        if (after !== -1 && isPunct(tokens[after], '(')) mark(i, after - 1);
      } else if (t.value === '=>') {
        // `(a): T =>` — only when (a) is not a call's argument list and all of T is a type
        const close = findReturnTypedParamClose(tokens, i);
        if (close !== -1 && arrowParamListOpen(tokens, close) !== -1 && typeEnd(tokens, close + 2) === i - 1) {
          mark(close + 1, i - 1);
        }
      }
      continue;
    }
    if (t.kind !== 'ident' || isPunct(prev, '.') || isPunct(prev, '?.')) continue;

    if (t.value === 'let' || t.value === 'const' || t.value === 'var') {
      markDeclaratorTypes(tokens, i + 1, mark);
    } else if ((t.value === 'as' || t.value === 'satisfies') && !t.nlBefore && endsOperand(prev)) {
      mark(i + 1, typeEnd(tokens, i + 1));
    } else if (t.value === 'function') {
      let k = i + 1;
      if (isPunct(tokens[k], '*')) k++;
      if (tokens[k]?.kind === 'ident') k++;
      if (isPunct(tokens[k], '<')) k = skipTypeArgs(tokens, k);
      const close = isPunct(tokens[k], '(') ? findClose(tokens, k) : -1;
      if (close !== -1 && isPunct(tokens[close + 1], ':')) mark(close + 1, typeEnd(tokens, close + 2));
    } else if (isPunct(tokens[i + 1], '(') && !CONTROL_KEYWORDS.has(t.value) && isMemberName(tokens, i)) {
      // go(a): T { — a method; `c ? f(x) : y` never starts a member, so its `:` is left alone
      const close = findClose(tokens, i + 1);
      if (close === -1 || !isPunct(tokens[close + 1], ':')) continue;
      const end = typeEnd(tokens, close + 2);
      if (isPunct(tokens[end + 1], '{')) mark(close + 1, end);
    }
  }
}

/**
 * Find TypeScript type declarations and annotations (whose identifiers are
 * never values) and class/enum bodies (whose top-level identifiers are member
 * names).
 */
function analyzeStructure(tokens: ScriptToken[], typescript: boolean): ScriptStructure {
  const typeOnly = new Array<boolean>(tokens.length).fill(false);
  const bodies = new Map<number, BodyKind>();
  const markTypeOnly = (from: number, to: number) => {
    for (let k = Math.max(0, from); k <= to && k < tokens.length; k++) typeOnly[k] = true;
  };
  if (typescript) markTypeAnnotations(tokens, markTypeOnly);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'ident') continue;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    // `obj.class`, `{ type: 1 }` — a property name, not a keyword
    if (isPunct(prev, '.') || isPunct(prev, '?.') || isPunct(next, ':')) continue;
    const namedOnSameLine = next?.kind === 'ident' && !next.nlBefore;

    if (t.value === 'interface' && namedOnSameLine) {
      const open = findBodyOpen(tokens, i + 2);
      const close = open === -1 ? -1 : findClose(tokens, open);
      if (close !== -1) markTypeOnly(i, close);
    } else if (t.value === 'type' && namedOnSameLine) {
      let k = i + 2;
      if (isPunct(tokens[k], '<')) {
        // Skip generic parameters: type X<T extends Array<U>> = ...
        let angle = 0;
        for (; k < tokens.length; k++) {
          const g = tokens[k];
          if (g.kind !== 'punct') continue;
          if (g.value === '<') angle++;
          else if (g.value === '>' || g.value === '>>' || g.value === '>>>') angle -= g.value.length;
          else if (g.value === ';' || g.value === '=') break;
          if (angle <= 0) { k++; break; }
        }
      }
      if (isPunct(tokens[k], '=')) markTypeOnly(i, typeAliasEnd(tokens, k));
    } else if (t.value === 'enum' && namedOnSameLine) {
      const open = findBodyOpen(tokens, i + 2);
      if (open !== -1) bodies.set(open, 'enum');
    } else if (t.value === 'class') {
      const open = findBodyOpen(tokens, i + 1);
      if (open !== -1) bodies.set(open, 'class');
    }
  }
  return { typeOnly, bodies };
}

/**
 * Does `t` start an entry of an object, class, type literal or statement list?
 * True after `{` `,` `;` `}`, at the start of the script, and on a new line
 * that the previous token does not continue.
 */
function startsEntry(prev: ScriptToken | undefined, t: ScriptToken): boolean {
  if (!prev) return true;
  if (prev.kind === 'punct' && ['{', ',', ';', '}'].includes(prev.value)) return true;
  return t.nlBefore && !(prev.kind === 'punct' && !CLOSERS.has(prev.value));
}

export interface BareIdentifierUse {
  name: string;
  lines: number[];
}

/**
 * Find uses of `names` as bare identifiers (value references) in script code.
 * Ignores property accesses (`x.mode`), object keys (`{ mode: 1 }`), members
 * of classes, enums, interfaces and type literals, labels, `#private` names,
 * text in strings/templates/regexes/comments, `typeof mode`, TypeScript type
 * positions (with `typescript`), names the script declares itself (`let mode`
 * anywhere; parameters of its own functions only inside those functions), and
 * `globals` (e.g. names from the project's "Imports for events" script).
 */
export function findBareIdentifierUses(
  source: string | ScriptToken[],
  names: Iterable<string>,
  options: { typescript?: boolean; globals?: Iterable<string> } = {},
): BareIdentifierUse[] {
  const globals = new Set(options.globals ?? []);
  const candidates = new Set<string>();
  for (const name of names) {
    if (!name || RESERVED.has(name) || SCRIPT_GLOBALS.has(name) || globals.has(name)) continue;
    if (options.typescript && TS_TYPE_WORDS.has(name)) continue;
    candidates.add(name);
  }
  if (candidates.size === 0) return [];

  const tokens = typeof source === 'string' ? tokenizeScript(source) : source;
  const { names: declared, params } = collectDeclarations(tokens);
  const paramScopes = new Map<string, ScopedBinding[]>();
  for (const p of params) {
    if (!candidates.has(p.name)) continue;
    const scopes = paramScopes.get(p.name);
    if (scopes) scopes.push(p);
    else paramScopes.set(p.name, [p]);
  }
  /** Declared script-wide, or a parameter of a function or catch clause that contains token `i` */
  const isDeclared = (name: string, i: number) => declared.has(name)
    || (paramScopes.get(name)?.some(p => p.from <= i && i <= p.to) ?? false);
  const structure = analyzeStructure(tokens, options.typescript === true);
  const braces: Array<BodyKind | 'block'> = [];
  const uses = new Map<string, number[]>();

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'punct') {
      if (t.value === '{') braces.push(structure.bodies.get(i) ?? 'block');
      else if (t.value === '}') braces.pop();
      continue;
    }
    if (t.kind !== 'ident' || !candidates.has(t.value) || isDeclared(t.value, i)) continue;
    // interface X { mode: T } / type X = { mode: T } / let x: mode — types, never values
    if (structure.typeOnly[i]) continue;

    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const body = braces[braces.length - 1];
    const entryStart = startsEntry(prev, t);

    // obj.mode / obj?.mode — property access; this.#mode — private name
    if (prev?.kind === 'punct' && (prev.value === '.' || prev.value === '?.' || prev.value === '#')) continue;
    // { [mode: string]: T } — an index signature key (a type; `[x:` never occurs in value code)
    if (isPunct(prev, '[') && isPunct(next, ':')) continue;
    // enum E { a = 1, mode = 2 } — member names
    if (body === 'enum' && (isPunct(prev, '{') || isPunct(prev, ','))) continue;
    // class A { mode = 1; static mode; mode: T; mode() {} } — member names
    if (body === 'class' && (entryStart || isPunct(prev, '*')
      || (prev?.kind === 'ident' && MEMBER_MODIFIERS.has(prev.value) && !t.nlBefore))) continue;
    // { mode: 1 }, { mode?: T; ... }, `mode: for (...)` — object key, type member or label
    if (entryStart && (isPunct(next, ':')
      || ((isPunct(next, '?') || isPunct(next, '!')) && isPunct(tokens[i + 2], ':')))) continue;
    // break mode / continue mode — label reference
    if (prev?.kind === 'ident' && (prev.value === 'break' || prev.value === 'continue') && !t.nlBefore) continue;
    // typeof mode (safe on undeclared names), `x as mode` and other type positions
    if (prev?.kind === 'ident' && TYPE_POSITION_WORDS.has(prev.value)) continue;
    // `type Foo`, `declare mode` — a keyword-like use, not a value
    if (next?.kind === 'ident' && !next.nlBefore && !OPERATOR_WORDS.has(next.value)) continue;
    // mode => ... — arrow parameter
    if (isPunct(next, '=>')) continue;
    if (isPunct(next, '(')) {
      const close = findClose(tokens, i + 1);
      const after = close === -1 ? undefined : tokens[close + 1];
      // { mode() { ... } } — a method definition that happens to share the name
      if (isPunct(after, '{') && !after!.nlBefore) continue;
      // { mode(): T } — a method signature with a return type
      if (entryStart && isPunct(after, ':')) continue;
    }

    const lines = uses.get(t.value) ?? [];
    if (!lines.includes(t.line)) lines.push(t.line);
    uses.set(t.value, lines);
  }

  return [...uses].map(([name, lines]) => ({ name, lines }));
}

/**
 * Names an "Imports for events" script makes available to every script in
 * the event sheets: its import bindings plus its top-level declarations
 * (C3 manual, "Scripts in event sheets" > "Using imports"). Over-collecting is
 * harmless: it can only hide a finding.
 */
export function collectImportsForEventsNames(source: string): Set<string> {
  const tokens = tokenizeScript(source);
  const names = collectDeclaredNames(tokens);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'ident' || t.value !== 'import' || isPunct(tokens[i - 1], '.') || isPunct(tokens[i + 1], '(')) continue;
    // import X, { a, b as c }, * as D from "..."
    for (let k = i + 1; k < tokens.length; k++) {
      const cur = tokens[k];
      if ((cur.kind === 'ident' && cur.value === 'from') || cur.kind === 'string' || isPunct(cur, ';')) break;
      if (cur.kind === 'ident' && cur.value !== 'as' && cur.value !== 'type') names.add(cur.value);
    }
  }
  return names;
}

// ─── Calls on the runtime ───────────────────────────────────

/**
 * Local names a script binds to the runtime: `const r = runtime`,
 * `let rt = this.runtime`, `const r: IRuntime = inst.runtime`.
 */
function collectRuntimeAliases(tokens: ScriptToken[]): Set<string> {
  const aliases = new Set<string>();
  for (let i = 0; i + 3 < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'ident' || !['const', 'let', 'var'].includes(t.value) || isPunct(tokens[i - 1], '.')) continue;
    const name = tokens[i + 1];
    if (name.kind !== 'ident') continue;
    let k = i + 2;
    if (isPunct(tokens[k], ':')) k = typeEnd(tokens, k + 1) + 1;
    if (!isPunct(tokens[k], '=') || tokens[k + 1]?.kind !== 'ident') continue;
    // A plain member chain that ends in `runtime`
    let j = k + 1;
    while ((isPunct(tokens[j + 1], '.') || isPunct(tokens[j + 1], '?.')) && tokens[j + 2]?.kind === 'ident') j += 2;
    if (tokens[j].value === 'runtime' && !isPunct(tokens[j + 1], '(') && !isPunct(tokens[j + 1], '[')) {
      aliases.add(name.value);
    }
  }
  return aliases;
}

interface RuntimeCall {
  method: string;
  /** Index of the call's `(` */
  paren: number;
  line: number;
}

/**
 * Calls of the IRuntime methods in `methods`: `runtime.m(`, `runtime?.m(` and
 * `runtime["m"](`. The runtime may be reached as a member (`inst.runtime.m(`,
 * `this.runtime.m(`) on purpose: IInstance.runtime and IBehaviorInstance.runtime
 * are the IRuntime (C3 scripting reference), so these are real runtime calls.
 * A local alias (`const r = runtime; r.m(`) counts too. Not matched: the
 * runtime passed in through a function parameter, and `inst.signal()` /
 * `inst.waitForSignal()` without `.runtime`, which are IInstance's
 * per-instance signals and never resume a System "Wait for signal".
 */
function findRuntimeCalls(tokens: ScriptToken[], methods: ReadonlySet<string>): RuntimeCall[] {
  const aliases = collectRuntimeAliases(tokens);
  const calls: RuntimeCall[] = [];
  for (let i = 0; i + 3 < tokens.length; i++) {
    const obj = tokens[i];
    if (obj.kind !== 'ident') continue;
    // `x.runtime` is the runtime; `x.r` is not the local alias `r`
    const isMember = isPunct(tokens[i - 1], '.') || isPunct(tokens[i - 1], '?.');
    if (obj.value !== 'runtime' && (isMember || !aliases.has(obj.value))) continue;

    let method: ScriptToken;
    let paren: number;
    if (isPunct(tokens[i + 1], '.') || isPunct(tokens[i + 1], '?.')) {
      method = tokens[i + 2];
      paren = i + 3;
      if (method.kind !== 'ident') continue;
    } else if (isPunct(tokens[i + 1], '[') && tokens[i + 2].kind === 'string' && isPunct(tokens[i + 3], ']')) {
      method = tokens[i + 2]; // runtime["signal"](...)
      paren = i + 4;
    } else {
      continue;
    }
    if (methods.has(method.value) && isPunct(tokens[paren], '(')) calls.push({ method: method.value, paren, line: method.line });
  }
  return calls;
}

// ─── runtime.callFunction() ─────────────────────────────────

export interface ScriptFunctionCall {
  name: string;
  /** Each argument's literal string value, or null when it is not a plain string literal */
  args: Array<string | null>;
  line: number;
}

const CALL_FUNCTION = new Set(['callFunction']);

/** Find `runtime.callFunction("Name", ...args)` calls with a literal function name. */
export function findScriptFunctionCalls(source: string | ScriptToken[]): ScriptFunctionCall[] {
  const tokens = typeof source === 'string' ? tokenizeScript(source) : source;
  const calls: ScriptFunctionCall[] = [];
  for (const call of findRuntimeCalls(tokens, CALL_FUNCTION)) {
    const nameTok = tokens[call.paren + 1];
    if (nameTok?.kind !== 'string') continue;
    const close = findClose(tokens, call.paren);
    if (close === -1) continue;
    const args: Array<string | null> = [];
    let start = call.paren + 2;
    if (isPunct(tokens[start], ',')) {
      start++;
      let depth = 0;
      let argStart = start;
      for (let k = start; k <= close; k++) {
        const t = tokens[k];
        const atEnd = k === close;
        if (!atEnd && t.kind === 'punct') {
          if (t.value in OPENERS) depth++;
          else if (CLOSERS.has(t.value)) depth--;
        }
        if (atEnd || (depth === 0 && t.kind === 'punct' && t.value === ',')) {
          const arg = tokens.slice(argStart, k);
          if (arg.length > 0) args.push(arg.length === 1 && arg[0].kind === 'string' ? arg[0].value : null);
          argStart = k + 1;
        }
      }
    }
    calls.push({ name: nameTok.value, args, line: call.line });
  }
  return calls;
}

// ─── runtime.signal() / runtime.waitForSignal() ─────────────

export interface ScriptSignalCall {
  method: 'signal' | 'waitForSignal';
  /** Literal tag, or null when the argument is not a plain string literal */
  tag: string | null;
  /** For a non-literal tag written as `"prefix" + ...`: the text every value starts with */
  prefix?: string;
  line: number;
}

/** `"button_" + name` → "button_" (the argument starting at `start`); undefined otherwise. */
function concatPrefix(tokens: ScriptToken[], start: number, close: number): string | undefined {
  const first = tokens[start];
  if (first?.kind !== 'string' || !isPunct(tokens[start + 1], '+')) return undefined;
  for (let k = start + 2; k < close; k++) {
    const t = tokens[k];
    // A conditional or logical operator can pick a different value; a comma ends the argument
    if (t.kind === 'punct' && ['?', '??', '||', '&&', ','].includes(t.value)) return undefined;
  }
  return first.value;
}

const SIGNAL_METHODS = new Set(['signal', 'waitForSignal']);

/**
 * Find `runtime.signal(tag)` and `runtime.waitForSignal(tag)` calls
 * (IRuntime methods, C3 scripting reference), also through `x.runtime` and
 * local aliases (see findRuntimeCalls). Commented-out calls are ignored.
 */
export function findScriptSignalCalls(source: string | ScriptToken[]): ScriptSignalCall[] {
  const tokens = typeof source === 'string' ? tokenizeScript(source) : source;
  const calls: ScriptSignalCall[] = [];
  for (const call of findRuntimeCalls(tokens, SIGNAL_METHODS)) {
    const arg = tokens[call.paren + 1];
    const isLiteral = arg?.kind === 'string' && (isPunct(tokens[call.paren + 2], ')') || isPunct(tokens[call.paren + 2], ','));
    const close = isLiteral ? -1 : findClose(tokens, call.paren);
    const prefix = close === -1 ? undefined : concatPrefix(tokens, call.paren + 1, close);
    calls.push({
      method: call.method as ScriptSignalCall['method'],
      tag: isLiteral ? arg.value : null,
      ...(prefix ? { prefix } : {}),
      line: call.line,
    });
  }
  return calls;
}
