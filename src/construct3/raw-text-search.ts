/**
 * Text search in project files the bulk reads skip (issue #55): a registered
 * layout, event sheet, object type or family over the reader's 10MB cap, not
 * valid JSON, or otherwise not parsed. The cross-reference index cannot see
 * the uses inside such a file, so the reference checks search its raw text
 * for the names they look for instead.
 *
 * - A word term (a name, or a number such as an object type's SID in an
 *   object property) matches as a whole word, ignoring case the way the
 *   editor compares names: not preceded or followed by a letter, digit or
 *   underscore. "Enemy" matches "Enemy", "Enemy.X", "enemy(0)",
 *   runtime.objects.Enemy and "\nEnemy" in JSON-escaped script text, but not
 *   "EnemyBullet" or "BigEnemy". The name is searched as JSON writes it
 *   inside a string (JSON.stringify without the quotes); a name that a file
 *   spells with \u escapes is not found.
 * - A pattern term is a regular expression with a bounded match length
 *   (`maxLength`), such as `"uid": <digits>` for layout instances.
 * A match is only a possible use: the text may hold the same name in another
 * string (a comment, a text property, another name's value), so callers
 * report it as "possible".
 *
 * The file is streamed in chunks of CHUNK_SIZE with an overlap longer than
 * any match, so the search reads files of any size in linear time without
 * holding them in memory, and stops as soon as every term was found. The
 * word terms are one alternation of literals (no lookbehind, no "u" flag, so
 * the regular expression engine can skip ahead) and the word boundaries are
 * checked only where a literal matched: about 50ms for 50MB, with one name or
 * two hundred, plus reading the file.
 */

import { createReadStream } from 'fs';

/** Characters read per step of the stream */
const CHUNK_SIZE = 1024 * 1024;
/** Characters of context a match needs beyond its own length (the characters before and after it) */
const CONTEXT = 16;

const WORD_CHAR = /[\p{L}\p{N}_]/u;

export type RawTextTerm =
  | {
    /** What the caller calls this term; the keys of the terms found are returned */
    key: string;
    kind: 'word';
    /** The literal text searched, ignoring case */
    text: string;
    /** Upper bound of a match's length in UTF-16 code units */
    maxLength: number;
  }
  | {
    key: string;
    kind: 'pattern';
    /** Regular expression source (without capturing groups), run with flags "gi" */
    source: string;
    maxLength: number;
  };

type WordTerm = Extract<RawTextTerm, { kind: 'word' }>;
type PatternTerm = Extract<RawTextTerm, { kind: 'pattern' }>;

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** A name, as a whole word ignoring case, spelled as JSON writes it inside a string. */
export function nameTerm(name: string, key = name): RawTextTerm {
  const text = JSON.stringify(name).slice(1, -1);
  return { key, kind: 'word', text, maxLength: text.length };
}

/** A non-negative integer, as a whole word (an object type's SID in an object property). */
export function numberTerm(value: number, key: string): RawTextTerm {
  const text = String(value);
  return { key, kind: 'word', text, maxLength: text.length };
}

/** A regular expression (no capturing groups) whose matches are at most `maxLength` long. */
export function patternTerm(key: string, source: string, maxLength: number): RawTextTerm {
  return { key, kind: 'pattern', source, maxLength };
}

/** The code point that ends just before `index`, or undefined at the start. */
function codePointBefore(text: string, index: number): number | undefined {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(index - 2);
  }
  return low;
}

function isWordCode(code: number | undefined): boolean {
  return code !== undefined && WORD_CHAR.test(String.fromCodePoint(code));
}

/**
 * Whether a word starts at `index`: the text starts there, the character
 * before is not part of a word, or it ends a JSON escape (\n, \t, ...).
 */
function wordStartsAt(text: string, index: number): boolean {
  const before = codePointBefore(text, index);
  if (!isWordCode(before)) return true;
  return 'nrtbf'.includes(text[index - 1]) && text[index - 2] === '\\';
}

/**
 * Incremental search for a set of terms over text given piece by piece.
 * push() each piece in order, then finish(): the keys of the terms found.
 */
export class RawTextSearch {
  private words: WordTerm[] = [];
  private patterns: PatternTerm[] = [];
  /** Lower-cased literal → the word terms with that literal */
  private wordsByText = new Map<string, WordTerm[]>();
  /** Some pending literal starts another one (ignoring case): a failed match is retried with the shorter ones */
  private prefixes = false;
  private wordRegex: RegExp | null = null;
  private patternRegex: RegExp | null = null;
  private readonly found = new Set<string>();
  private readonly overlap: number;
  /** The end of the text before the current piece, searched again with it */
  private carry = '';
  /** Whether text before the carry was dropped (then the carry does not start the text) */
  private dropped = false;
  private finished = false;

  constructor(terms: readonly RawTextTerm[]) {
    this.overlap = Math.max(0, ...terms.map(t => t.maxLength)) + CONTEXT;
    this.compile(terms);
  }

  /** True once every term was found: the rest of the text need not be read. */
  get done(): boolean {
    return this.words.length === 0 && this.patterns.length === 0;
  }

  push(piece: string): void {
    if (this.done || this.finished || piece.length === 0) return;
    const text = this.carry + piece;
    this.scan(text, false);
    if (text.length > this.overlap) {
      this.carry = text.slice(text.length - this.overlap);
      this.dropped = true;
    } else {
      this.carry = text;
    }
  }

  /** The keys of the terms found in the whole text. */
  finish(): Set<string> {
    if (!this.finished && !this.done && this.carry.length > 0) this.scan(this.carry, true);
    this.finished = true;
    return this.found;
  }

  /**
   * One regular expression for the pending word terms (their literals,
   * longest first, so the longest literal matching at a place is tried
   * first) and one for the patterns (one capturing group each).
   */
  private compile(terms: readonly RawTextTerm[]): void {
    this.words = terms.filter((t): t is WordTerm => t.kind === 'word' && t.text.length > 0)
      .sort((a, b) => b.text.length - a.text.length);
    this.patterns = terms.filter((t): t is PatternTerm => t.kind === 'pattern');
    this.wordsByText = new Map();
    for (const term of this.words) {
      const lower = term.text.toLowerCase();
      this.wordsByText.set(lower, [...(this.wordsByText.get(lower) ?? []), term]);
    }
    const lowers = [...this.wordsByText.keys()];
    this.prefixes = lowers.some(a => lowers.some(b => b !== a && b.startsWith(a)));
    this.wordRegex = this.words.length > 0 ? new RegExp(this.words.map(t => escapeRegExp(t.text)).join('|'), 'gi') : null;
    this.patternRegex = this.patterns.length > 0 ? new RegExp(this.patterns.map(t => `(${t.source})`).join('|'), 'gi') : null;
  }

  private markFound(key: string): void {
    this.found.add(key);
    this.compile([...this.words, ...this.patterns].filter(t => t.key !== key));
  }

  /**
   * Search `text`. Unless it is the end of the file, a match that reaches the
   * end of `text` may go on in the next piece (a longer word): it is left for
   * the next search, which starts with the end of this text. Once text before
   * it was dropped, matches in its first two characters are skipped: they
   * were decided with their real context in the previous search.
   */
  private scan(text: string, last: boolean): void {
    const minStart = this.dropped ? 2 : 0;
    this.scanWords(text, last, minStart);
    this.scanPatterns(text, last, minStart);
  }

  private scanWords(text: string, last: boolean, minStart: number): void {
    let from = minStart;
    while (this.wordRegex) {
      const regex = this.wordRegex;
      regex.lastIndex = from;
      const match = regex.exec(text);
      if (!match) return;
      const term = this.wordAt(text, match.index, match[0], last);
      if (term) {
        this.markFound(term.key);
        // Another term can match at the same place
        from = match.index;
      } else {
        from = match.index + 1;
      }
    }
  }

  /**
   * The pending word term that matches as a whole word at `index`, where the
   * regular expression matched `matched`: its term, or, when that is not a
   * whole word there, a shorter literal that starts it.
   */
  private wordAt(text: string, index: number, matched: string, last: boolean): WordTerm | undefined {
    if (!wordStartsAt(text, index)) return undefined;
    const lower = matched.toLowerCase();
    let candidates = this.wordsByText.get(lower)
      // The regular expression folds case in its own way: compare its match ignoring case
      ?? this.words.filter(t => t.text.length === matched.length && new RegExp(`^(?:${escapeRegExp(t.text)})$`, 'i').test(matched));
    if (this.prefixes) {
      candidates = [...candidates, ...this.words.filter(t =>
        t.text.length < matched.length && text.slice(index, index + t.text.length).toLowerCase() === t.text.toLowerCase())];
    }
    for (const term of candidates) {
      const end = index + term.text.length;
      if (end >= text.length && !last) continue;
      if (!isWordCode(text.codePointAt(end))) return term;
    }
    return undefined;
  }

  private scanPatterns(text: string, last: boolean, minStart: number): void {
    let from = minStart;
    while (this.patternRegex) {
      const regex = this.patternRegex;
      regex.lastIndex = from;
      const match = regex.exec(text);
      if (!match) return;
      const end = match.index + match[0].length;
      if (!last && end >= text.length) {
        from = match.index + 1;
        continue;
      }
      const group = match.findIndex((value, i) => i > 0 && value !== undefined);
      this.markFound(this.patterns[group - 1].key);
      from = match.index;
    }
  }
}

/** Search a whole text (tests, and readers that already hold the text). */
export function searchText(text: string, terms: readonly RawTextTerm[]): Set<string> {
  const search = new RawTextSearch(terms);
  search.push(text);
  return search.finish();
}

/**
 * Search a file for the terms, streaming it (no size limit, memory for one
 * chunk). Returns the keys of the terms found. fs errors propagate
 * unwrapped, so callers can test `.code` (ENOENT: no file, so nothing in it).
 */
export async function searchFileText(path: string, terms: readonly RawTextTerm[]): Promise<Set<string>> {
  const search = new RawTextSearch(terms);
  if (search.done) return search.finish();
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: CHUNK_SIZE });
  try {
    for await (const piece of stream) {
      search.push(piece as string);
      if (search.done) break;
    }
  } finally {
    stream.destroy();
  }
  return search.finish();
}
