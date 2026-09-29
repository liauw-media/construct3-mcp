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
 *   runtime.objects.Enemy and "\nEnemy" or "\u000bEnemy" in JSON-escaped
 *   script text, but not "EnemyBullet" or "BigEnemy". The name is searched as
 *   JSON writes it inside a string (JSON.stringify without the quotes) and,
 *   for a name with characters outside ASCII, also with those characters as
 *   \u escapes (as Python's json.dump writes them by default). A name whose
 *   ASCII characters a file spells with \u escapes is not found.
 * - A pattern term is a regular expression with a bounded match length
 *   (`maxLength`), such as `"uid": <digits>` for layout instances.
 * A match is only a possible use: the text may hold the same name in another
 * string (a comment, a text property, another name's value), so callers
 * report it as "possible".
 *
 * The file is streamed in chunks of CHUNK_SIZE with an overlap longer than
 * any match and its context, so the search reads files of any size in linear
 * time without holding them in memory, and stops as soon as every term was
 * found. It is read as UTF-8, or as UTF-16LE when it starts with that byte
 * order mark; a file in UTF-16BE, or with a NUL character (which JSON text
 * never holds unescaped: another encoding, or not text), cannot be searched
 * and rejects, so callers treat it as unreadable.
 *
 * The word terms are one alternation of literals, longest first, followed by
 * a lookahead that rejects an ASCII word character (no lookbehind, no "u"
 * flag, so the regular expression engine can skip ahead, and a name that
 * only starts a longer word, "Enemy" in "EnemyBullet", is not returned at
 * all). The start of the word, and a continuation outside ASCII, are checked
 * where a literal matched, looking up the literals of each length there
 * (not every name). docs/TROUBLESHOOTING.md has the measured times.
 *
 * The UID/SID scan of the ID generator (issue #49) reads such files the same
 * way (scanFileIds, issue #59): streamed, so a file of any size costs memory
 * for one chunk (and the SIDs found), not a string as long as the file, which
 * JavaScript cannot hold beyond about 512MB. Unlike the search, it drops NUL
 * characters instead of rejecting the file, and reads UTF-16BE as UTF-8. The
 * entries it looks for are ASCII, and UTF-8 decoding keeps every ASCII byte
 * as it is: in UTF-16 without a byte order mark, and in UTF-16BE, only NUL
 * bytes stand between their characters, and the zeros at the end of a save
 * cut short hold no entry. Dropping NUL characters can only make it find
 * more entries or longer numbers, never miss a UID, so such a file does not
 * block new UIDs. (A name search could miss a name outside ASCII in such a
 * file, so searchFileText still rejects it.)
 */

import { createReadStream } from 'fs';
import { open } from 'fs/promises';

/** Characters read per step of the stream */
const CHUNK_SIZE = 1024 * 1024;
/**
 * Characters of context a match needs beyond its own length: before it (a
 * \uXXXX escape, or two of them for a character outside the BMP) and after
 * it (a \uXXXX escape), with room to spare. See RawTextSearch.scan.
 */
const CONTEXT = 32;
/** Characters at the start of a text a search skips once text before it was dropped: the context before a match */
const SKIP_AFTER_DROP = 12;
/** Length of a \uXXXX escape */
const ESCAPE_LENGTH = 6;

const WORD_CHAR = /[\p{L}\p{N}_]/u;

export type RawTextTerm =
  | {
    /** What the caller calls this term; the keys of the terms found are returned */
    key: string;
    kind: 'word';
    /** The literal text searched, ignoring case */
    text: string;
    /** Other spellings of the same text, searched the same way (e.g. with \u escapes) */
    alternatives?: string[];
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
/** One spelling of a word term, as searched */
interface Literal {
  term: WordTerm;
  text: string;
  lower: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** `text` with every UTF-16 code unit outside ASCII as a \uXXXX escape (lower-case hex digits, as Python writes them). */
function asciiEscaped(text: string): string {
  return text.replace(/[^\x00-\x7f]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * A name, as a whole word ignoring case, spelled as JSON writes it inside a
 * string; a name with characters outside ASCII also with those as \u escapes.
 */
export function nameTerm(name: string, key = name): RawTextTerm {
  const text = JSON.stringify(name).slice(1, -1);
  const escaped = asciiEscaped(text);
  return escaped === text
    ? { key, kind: 'word', text, maxLength: text.length }
    : { key, kind: 'word', text, alternatives: [escaped], maxLength: Math.max(text.length, escaped.length) };
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

/** The code unit of the \uXXXX escape that starts at `index`, if one does. */
function escapeAt(text: string, index: number): number | undefined {
  if (index < 0 || text[index] !== '\\' || text[index + 1] !== 'u') return undefined;
  const hex = text.slice(index + 2, index + ESCAPE_LENGTH);
  return /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : undefined;
}

function isHighSurrogate(code: number | undefined): code is number {
  return code !== undefined && code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number | undefined): code is number {
  return code !== undefined && code >= 0xdc00 && code <= 0xdfff;
}

function combineSurrogates(high: number, low: number): number {
  return ((high - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
}

/** The character that a \uXXXX escape (or a pair of them, for a surrogate pair) ending at `index` stands for. */
function escapedCodePointBefore(text: string, index: number): number | undefined {
  const code = escapeAt(text, index - ESCAPE_LENGTH);
  if (!isLowSurrogate(code)) return code;
  const high = escapeAt(text, index - 2 * ESCAPE_LENGTH);
  return isHighSurrogate(high) ? combineSurrogates(high, code) : code;
}

/** The character that a \uXXXX escape (or a pair of them) starting at `index` stands for. */
function escapedCodePointAt(text: string, index: number): number | undefined {
  const code = escapeAt(text, index);
  if (!isHighSurrogate(code)) return code;
  const low = escapeAt(text, index + ESCAPE_LENGTH);
  return isLowSurrogate(low) ? combineSurrogates(code, low) : code;
}

/**
 * Whether a word starts at `index`: the text starts there, the character
 * before is not part of a word, or it ends a JSON escape (\n, \t, ..., or a
 * \uXXXX escape of a character that is not part of a word).
 */
function wordStartsAt(text: string, index: number): boolean {
  const before = codePointBefore(text, index);
  if (!isWordCode(before)) return true;
  if ('nrtbf'.includes(text[index - 1]) && text[index - 2] === '\\') return true;
  const escaped = escapedCodePointBefore(text, index);
  return escaped !== undefined && !isWordCode(escaped);
}

/**
 * Whether wordGoesOnAt(text, index) needs text after the end of `text`: at
 * the end, half a surrogate pair, or a backslash that may start an escape
 * (a pair of them, for a character outside the BMP).
 */
function undecidedAt(text: string, index: number): boolean {
  if (index >= text.length) return true;
  if (isHighSurrogate(text.charCodeAt(index))) return index + 1 >= text.length;
  return text[index] === '\\' && index + 2 * ESCAPE_LENGTH > text.length;
}

/** Whether a word goes on at `index`: a character that is part of a word there, or a \uXXXX escape of one. */
function wordGoesOnAt(text: string, index: number): boolean {
  return isWordCode(text.codePointAt(index)) || isWordCode(escapedCodePointAt(text, index));
}

/**
 * Incremental search for a set of terms over text given piece by piece.
 * push() each piece in order, then finish(): the keys of the terms found.
 */
export class RawTextSearch {
  private words: WordTerm[] = [];
  private patterns: PatternTerm[] = [];
  /** Lower-cased literal (a term's text or alternative) → the pending literals with that lower-cased text */
  private literalsByLower = new Map<string, Literal[]>();
  /** The pending literals, longest first */
  private literals: Literal[] = [];
  /** The distinct lengths of the pending literals, longest first */
  private literalLengths: number[] = [];
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
   * One regular expression for the pending word terms (all their literals,
   * longest first, so the longest literal matching at a place is tried first,
   * then a shorter one where the longer one goes on with an ASCII word
   * character) and one for the patterns (one capturing group each).
   */
  private compile(terms: readonly RawTextTerm[]): void {
    this.words = terms.filter((t): t is WordTerm => t.kind === 'word' && t.text.length > 0);
    this.patterns = terms.filter((t): t is PatternTerm => t.kind === 'pattern');
    this.literals = this.words
      .flatMap(term => [...new Set([term.text, ...(term.alternatives ?? [])])]
        .filter(text => text.length > 0)
        .map(text => ({ term, text, lower: text.toLowerCase() })))
      .sort((a, b) => b.text.length - a.text.length);
    this.literalsByLower = new Map();
    for (const literal of this.literals) {
      this.literalsByLower.set(literal.lower, [...(this.literalsByLower.get(literal.lower) ?? []), literal]);
    }
    this.literalLengths = [...new Set(this.literals.map(l => l.text.length))];
    this.wordRegex = this.literals.length > 0
      ? new RegExp(`(?:${this.literals.map(l => escapeRegExp(l.text)).join('|')})(?![A-Za-z0-9_])`, 'gi')
      : null;
    this.patternRegex = this.patterns.length > 0 ? new RegExp(this.patterns.map(t => `(${t.source})`).join('|'), 'gi') : null;
  }

  private markFound(key: string): void {
    this.found.add(key);
    this.compile([...this.words, ...this.patterns].filter(t => t.key !== key));
  }

  /**
   * Search `text`. Unless it is the end of the file, a match that reaches
   * close to the end of `text` may go on in the next piece (a longer word,
   * or an escape after it): it is left for the next search, which starts
   * with the end of this text (the overlap: the longest match plus CONTEXT).
   * Once text before it was dropped, matches in its first SKIP_AFTER_DROP
   * characters are skipped: their context before them is cut off, and they
   * were decided with it in the previous search (they end well before the
   * end of the previous text).
   */
  private scan(text: string, last: boolean): void {
    const minStart = this.dropped ? SKIP_AFTER_DROP : 0;
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
   * regular expression matched `matched`: the literal matched or, when that
   * is not a whole word there (a word character outside ASCII, or an escape
   * of one, follows), a shorter literal that starts it. Each length is one
   * lookup, whatever the number of names.
   */
  private wordAt(text: string, index: number, matched: string, last: boolean): WordTerm | undefined {
    if (!wordStartsAt(text, index)) return undefined;
    for (const length of this.literalLengths) {
      if (length > matched.length) continue;
      let candidates = this.literalsByLower.get(text.slice(index, index + length).toLowerCase())
        ?.filter(l => l.text.length === length);
      if (length === matched.length && !candidates?.length) {
        // The regular expression folds case in its own way: compare its match ignoring case
        candidates = this.literals.filter(l =>
          l.text.length === length && new RegExp(`^(?:${escapeRegExp(l.text)})$`, 'i').test(matched));
      }
      for (const literal of candidates ?? []) {
        const end = index + length;
        if (!last && undecidedAt(text, end)) continue;
        if (!wordGoesOnAt(text, end)) return literal.term;
      }
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

/** Why a file cannot be searched as text (its encoding): a rejection that is not ENOENT, so callers treat the file as unreadable. */
export class RawTextEncodingError extends Error {
  readonly code = 'E_TEXT_ENCODING';
}

/**
 * What streamFileText does with NUL characters and UTF-16BE: "reject" the
 * file (the text search, which could miss a name outside ASCII in such a
 * file), or "drop" the NUL characters and read UTF-16BE as UTF-8 (the
 * UID/SID scan, whose entries are ASCII; see the top of this file).
 */
type NulHandling = 'reject' | 'drop';

/** The encoding to stream a file in, from its first bytes: UTF-16LE after its byte order mark, otherwise UTF-8. */
async function textEncodingOf(path: string, nul: NulHandling): Promise<BufferEncoding> {
  const handle = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(2), 0, 2, 0);
    if (bytesRead === 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le';
    if (bytesRead === 2 && buffer[0] === 0xfe && buffer[1] === 0xff && nul === 'reject') {
      throw new RawTextEncodingError('The file is UTF-16BE text, which the text search does not read');
    }
    return 'utf8';
  } finally {
    await handle.close();
  }
}

/**
 * Stream a file as text, one chunk of CHUNK_SIZE bytes at a time, to
 * `onPiece`, until it returns true (nothing more needed). The file is read
 * as UTF-8, or as UTF-16LE after that byte order mark. With `nul` "reject"
 * (the default), a file in UTF-16BE or with a NUL character rejects with a
 * RawTextEncodingError; with "drop", UTF-16BE is read as UTF-8 and NUL
 * characters are left out of the pieces. fs errors propagate unwrapped.
 */
async function streamFileText(
  path: string,
  onPiece: (piece: string) => boolean,
  nul: NulHandling = 'reject',
): Promise<void> {
  const encoding = await textEncodingOf(path, nul);
  const stream = createReadStream(path, { encoding, highWaterMark: CHUNK_SIZE });
  try {
    for await (const chunk of stream) {
      let piece = chunk as string;
      if (piece.includes('\u0000')) {
        if (nul === 'reject') throw new RawTextEncodingError('The file holds NUL characters: it is not UTF-8 text');
        piece = piece.replaceAll('\u0000', '');
      }
      if (onPiece(piece)) break;
    }
  } finally {
    stream.destroy();
  }
}

/**
 * Search a file for the terms, streaming it (no size limit, memory for one
 * chunk). Returns the keys of the terms found. fs errors propagate
 * unwrapped, so callers can test `.code` (ENOENT: no file, so nothing in
 * it); a file that is not UTF-8 or UTF-16LE text rejects with a
 * RawTextEncodingError.
 */
export async function searchFileText(path: string, terms: readonly RawTextTerm[]): Promise<Set<string>> {
  const search = new RawTextSearch(terms);
  if (search.done) return search.finish();
  await streamFileText(path, piece => {
    search.push(piece);
    return search.done;
  });
  return search.finish();
}

// ─── UID and SID scan ────────────────────────────────────────

/**
 * `"uid": <digits>`, `"parent-uid": <digits>` (the parent a hierarchy link
 * names) or `"sid": <digits>`, whitespace allowed around the colon; group 1
 * is the key, group 2 the digits
 */
const ID_ENTRY = /"(uid|parent-uid|sid)"\s*:\s*(\d+)/g;
/** The keys of ID_ENTRY with their quotes */
const ID_KEYS = ['"uid"', '"parent-uid"', '"sid"'];
/**
 * Digits of a number that a piece boundary cuts off that are kept, leading
 * zeros dropped: more than any finite double has, so Number() of the kept
 * digits is Number() of all of them (Infinity beyond about 309 digits).
 */
const MAX_KEPT_DIGITS = 400;

/** The digits of a number cut off by a piece boundary, as kept: leading zeros dropped, at most MAX_KEPT_DIGITS. */
function keptDigits(digits: string): string {
  return digits.replace(/^0+(?=\d)/, '').slice(0, MAX_KEPT_DIGITS);
}

/** The key of ID_KEYS (with its quotes) that `text` ends with, if one. */
function idKeyAtEnd(text: string): string | undefined {
  return ID_KEYS.find(key => text.endsWith(key));
}

/** The longest start of a key of ID_KEYS (`"`, `"u`, ..., `"parent-uid`, without the closing quote) that `text` ends with, or ''. */
function idKeyStartAtEnd(text: string): string {
  let longest = '';
  for (const key of ID_KEYS) {
    for (let length = key.length - 1; length > longest.length; length--) {
      if (text.endsWith(key.slice(0, length))) {
        longest = key.slice(0, length);
        break;
      }
    }
  }
  return longest;
}

/**
 * The start of an ID entry at the end of `text` that the next piece may
 * complete, in the shortest form that matches the same way: the key or part
 * of it (`"`, `"u`, `"ui`, `"uid`, `"uid"`, or of `"parent-uid"`), the key
 * followed by whitespace (kept as one space), or the key and the colon
 * (whitespace around it dropped). '' when the text does not end with one.
 */
function cutOffIdEntry(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(':')) {
    const key = idKeyAtEnd(trimmed.slice(0, -1).trimEnd());
    return key ? `${key}:` : '';
  }
  const key = idKeyAtEnd(trimmed);
  if (key) return trimmed.length < text.length ? `${key} ` : key;
  if (trimmed.length < text.length) return '';
  return idKeyStartAtEnd(text);
}

/**
 * Incremental scan for the UIDs and SIDs in the text of a layout or object
 * type file the reader skipped (issue #49): every `"uid": <n>` and
 * `"sid": <n>`, wherever it is, without parsing the JSON, and the UIDs that
 * hierarchy links name as `"parent-uid": <n>` (a link to a deleted instance
 * keeps its UID taken; a children entry's is a `"uid"`). push() each piece
 * in order, then finish(): the highest UID and every SID, in text order.
 * Between pieces only the start of an entry that the boundary cut off is
 * kept (a few characters, and the digits of a number cut in two), so the
 * scan finds what a scan of the whole text finds while its memory does not
 * grow with the text (the SIDs aside).
 */
export class RawIdScan {
  private highestUid = 0;
  private readonly sids: number[] = [];
  private carry = '';
  private finished = false;

  push(piece: string): void {
    if (this.finished || piece.length === 0) return;
    this.carry = this.scan(this.carry + piece, false);
  }

  finish(): { highestUid: number; sids: number[] } {
    if (!this.finished && this.carry.length > 0) this.scan(this.carry, true);
    this.carry = '';
    this.finished = true;
    return { highestUid: this.highestUid, sids: this.sids };
  }

  /**
   * Record the entries in `text`. Unless it is the end of the file, an
   * entry whose number reaches the end of `text` may go on in the next
   * piece: it is returned (the carry for the next piece) instead, as is the
   * start of an entry at the end.
   */
  private scan(text: string, last: boolean): string {
    for (const match of text.matchAll(ID_ENTRY)) {
      if (!last && match.index + match[0].length === text.length) {
        return `"${match[1]}":${keptDigits(match[2])}`;
      }
      const value = Number(match[2]);
      if (match[1] === 'sid') {
        this.sids.push(value);
      } else if (value > this.highestUid) {
        this.highestUid = value;
      }
    }
    return last ? '' : cutOffIdEntry(text);
  }
}

/** The UIDs and SIDs in a whole text (see RawIdScan). */
export function scanIdsInText(content: string): { highestUid: number; sids: number[] } {
  const scan = new RawIdScan();
  scan.push(content);
  return scan.finish();
}

/**
 * Scan a file for its UIDs and SIDs (see RawIdScan), streaming it: no size
 * limit, memory for one chunk and the SIDs found. Read as UTF-8, or as
 * UTF-16LE after its byte order mark, without its NUL characters, so UTF-16
 * without a byte order mark and UTF-16BE are read too (see the top of this
 * file): no file is rejected for its encoding. fs errors propagate unwrapped
 * (ENOENT: no file).
 */
export async function scanFileIds(path: string): Promise<{ highestUid: number; sids: number[] }> {
  const scan = new RawIdScan();
  await streamFileText(path, piece => {
    scan.push(piece);
    return false;
  }, 'drop');
  return scan.finish();
}
