/**
 * Possible uses in registered files the bulk reads skipped (issue #55).
 *
 * The reference checks (delete_object, delete_family, delete_layout,
 * delete_event_sheet, delete_event_from_sheet, the removals of
 * update_object_properties and update_family, rename_animation) and the
 * analyses built on the cross-reference index (get_object_dependencies,
 * find_orphaned_objects) only see the files the bulk reads could parse. A
 * registered layout, event sheet, object type or family over the reader's
 * 10MB cap, not valid JSON or not readable is left out, so its uses were
 * invisible: an object used only there counted as unreferenced.
 *
 * Such files are now searched as text (raw-text-search.ts, streamed, no size
 * limit) for the names a check looks for. The outcome per file:
 * - "possible-use": the text names what the check looks for. A text search
 *   cannot tell a use from the same name in another string, so this is a
 *   possible use: the checks refuse without force and say "possible";
 * - "unreadable": the file exists but cannot be read even as text (a file
 *   that no longer exists, ENOENT, holds no uses and is left out): the checks
 *   refuse without force;
 * - "no-match": nothing found; the checks go ahead and warn that the file was
 *   only searched as text, and for what (`searchedFor`);
 * - "not-searched": the file was not searched. With `unchecked`, it is the
 *   file that defines what the check is about (delete_object's object type,
 *   delete_family's family): what it holds is unknown, so what depends on it
 *   could not be checked, and the check refuses without force. Without, the
 *   analysis had nothing to search it for.
 * A registered file that does not exist (E_FILE_NOT_FOUND) is not a skipped
 * file: it holds no uses. The search runs only while there are skipped files
 * of the categories a check looks at.
 */

import {
  isFileNotFoundError,
  type Construct3ProjectReader,
  type EntityCategory,
  type ReadFailure,
  type ReadFailureCode,
} from '../project-reader.js';
import type { RawTextTerm } from '../raw-text-search.js';

/** A registered entity file that a bulk read skipped although it exists (or may exist). */
export interface UnscannedFile {
  category: EntityCategory;
  name: string;
  /** "<category>/<name>", as validate_project lists unscanned files */
  file: string;
  /** Why it was not parsed, e.g. "over the 10MB read limit" */
  reason: string;
}

export type TextSearchOutcome = 'possible-use' | 'no-match' | 'unreadable' | 'not-searched';

/** What the text search of one skipped file found, as tool results list it (`unscannedFiles`). */
export interface UnscannedFileReport {
  file: string;
  reason: string;
  textSearch: TextSearchOutcome;
  /** With "possible-use": the names the text holds, of those the check looks for */
  names?: string[];
  /** With "no-match": what the text was searched for (names, and descriptions of patterns) */
  searchedFor?: string[];
  /** With "not-searched", in a check: what could not be checked because the file could not be parsed */
  unchecked?: string;
}

/**
 * Names that a check looks for in the files of some categories. A file holds
 * a possible use when, for every group of `allOf`, it holds one of the
 * group's terms (e.g. an instance variable name AND the object's name). The
 * keys of the terms found are the names reported.
 */
export interface UseRule {
  categories: readonly EntityCategory[];
  allOf: ReadonlyArray<readonly RawTextTerm[]>;
}

const REASONS: Record<Exclude<ReadFailureCode, 'E_FILE_NOT_FOUND'>, string> = {
  E_FILE_TOO_LARGE: 'over the 10MB read limit',
  E_INVALID_JSON: 'not valid JSON',
  E_READ_ERROR: 'could not be read',
};

/** Why a bulk read skipped a file, for messages: "over the 10MB read limit", "not valid JSON", ... */
export function describeReadFailure(code: ReadFailureCode): string {
  return code === 'E_FILE_NOT_FOUND' ? 'not found' : REASONS[code];
}

/**
 * The registered entities of a category that a bulk read skipped: registered
 * names missing from its result, except those whose file does not exist.
 * `failures` must be the reader's failures for that result (taken right
 * after the read).
 */
export function unscannedFilesOf(
  category: EntityCategory,
  registered: Iterable<string>,
  loaded: ReadonlyMap<string, unknown>,
  failures: ReadonlyMap<string, ReadFailure>,
): UnscannedFile[] {
  const files: UnscannedFile[] = [];
  for (const name of registered) {
    if (loaded.has(name)) continue;
    const failure = failures.get(name);
    if (failure?.code === 'E_FILE_NOT_FOUND') continue;
    files.push({ category, name, file: `${category}/${name}`, reason: failure ? REASONS[failure.code] : 'not read' });
  }
  return files;
}

/**
 * Search each file for the terms `termsFor` gives it (none: not searched).
 * `found` is null for a file that cannot be read even as text; a file that
 * no longer exists is left out.
 */
export async function searchUnscannedFiles(
  reader: Pick<Construct3ProjectReader, 'searchEntityTextRaw'>,
  files: readonly UnscannedFile[],
  termsFor: (file: UnscannedFile) => RawTextTerm[],
): Promise<Array<{ file: UnscannedFile; found: Set<string> | null }>> {
  const results: Array<{ file: UnscannedFile; found: Set<string> | null }> = [];
  for (const file of files) {
    const terms = termsFor(file);
    if (terms.length === 0) continue;
    try {
      results.push({ file, found: await reader.searchEntityTextRaw(file.category, file.name, terms) });
    } catch (error) {
      if (isFileNotFoundError(error)) continue;
      results.push({ file, found: null });
    }
  }
  return results;
}

/**
 * Search the skipped files of the rules' categories for possible uses. Empty
 * when there are none (then nothing is read).
 */
export async function checkUnscannedFiles(
  reader: Pick<Construct3ProjectReader, 'searchEntityTextRaw'>,
  files: readonly UnscannedFile[],
  rules: readonly UseRule[],
): Promise<UnscannedFileReport[]> {
  const usable = rules.filter(r => r.allOf.length > 0 && r.allOf.every(group => group.length > 0));
  const rulesFor = (file: UnscannedFile) => usable.filter(r => r.categories.includes(file.category));
  const searched = await searchUnscannedFiles(reader, files, file => rulesFor(file).flatMap(r => r.allOf.flat()));
  return searched.map(({ file, found }): UnscannedFileReport => {
    if (found === null) return { file: file.file, reason: file.reason, textSearch: 'unreadable' };
    const hits = rulesFor(file).filter(r => r.allOf.every(group => group.some(t => found.has(t.key))));
    if (hits.length === 0) {
      const searchedFor = [...new Set(rulesFor(file).flatMap(r => r.allOf.flat().map(t => t.key)))];
      return { file: file.file, reason: file.reason, textSearch: 'no-match', searchedFor };
    }
    const names = [...new Set(hits.flatMap(r => r.allOf.flatMap(group => group.filter(t => found.has(t.key)).map(t => t.key))))];
    return { file: file.file, reason: file.reason, textSearch: 'possible-use', names };
  });
}

/**
 * Reports for the files that define what a check is about (the object type
 * delete_object deletes, the family delete_family deletes), for those of
 * `own` the bulk reads skipped: what they hold is unknown, so `unchecked`
 * could not be checked. They are not searched.
 */
export function ownFileReports(
  files: readonly UnscannedFile[],
  own: ReadonlyArray<{ category: EntityCategory; name: string; unchecked: string }>,
): UnscannedFileReport[] {
  return own.flatMap(({ category, name, unchecked }) => files
    .filter(f => f.category === category && f.name === name)
    .map((f): UnscannedFileReport => ({ file: f.file, reason: f.reason, textSearch: 'not-searched', unchecked })));
}

/** True when a check must refuse without force: a possible use, a file it could not search, or its own file unknown. */
export function blocksWithoutForce(reports: readonly UnscannedFileReport[]): boolean {
  return reports.some(r => r.textSearch === 'possible-use' || r.textSearch === 'unreadable' ||
    (r.textSearch === 'not-searched' && r.unchecked !== undefined));
}

const OUTCOME_RANK: Record<TextSearchOutcome, number> = { 'unreadable': 3, 'possible-use': 2, 'no-match': 1, 'not-searched': 0 };

/**
 * One report per file from several searches of the same files (a file a
 * tool searched for different things): the weightiest outcome, with the
 * names found and searched for of all of them.
 */
export function mergeUnscannedReports(...lists: ReadonlyArray<readonly UnscannedFileReport[]>): UnscannedFileReport[] {
  const merged = new Map<string, UnscannedFileReport>();
  for (const report of lists.flat()) {
    const seen = merged.get(report.file);
    if (!seen) {
      merged.set(report.file, { ...report });
      continue;
    }
    const textSearch = OUTCOME_RANK[report.textSearch] > OUTCOME_RANK[seen.textSearch] ? report.textSearch : seen.textSearch;
    const names = [...new Set([...(seen.names ?? []), ...(report.names ?? [])])];
    const searchedFor = [...new Set([...(seen.searchedFor ?? []), ...(report.searchedFor ?? [])])];
    const unchecked = seen.unchecked ?? report.unchecked;
    merged.set(report.file, {
      file: seen.file,
      reason: seen.reason,
      textSearch,
      ...(textSearch === 'possible-use' && names.length > 0 ? { names } : {}),
      ...(textSearch === 'no-match' && searchedFor.length > 0 ? { searchedFor } : {}),
      ...(unchecked !== undefined ? { unchecked } : {}),
    });
  }
  return [...merged.values()];
}

function quoted(names: readonly string[] = []): string {
  return names.map(n => `"${n}"`).join(', ');
}

/** "layouts/Big (over the 10MB read limit)", or "(could not be read, not even as text)" */
export function describeUnscannedFile(report: UnscannedFileReport): string {
  return report.textSearch === 'unreadable'
    ? `${report.file} (${report.reason}, not even as text)`
    : `${report.file} (${report.reason})`;
}

/**
 * Why a check refuses because of skipped files, in sentences; empty when it
 * does not. Possible uses name the files and what their text names; files
 * that could not be searched are named apart.
 */
export function unscannedRefusal(reports: readonly UnscannedFileReport[]): string {
  const possible = reports.filter(r => r.textSearch === 'possible-use');
  const unreadable = reports.filter(r => r.textSearch === 'unreadable');
  const own = reports.filter(r => r.textSearch === 'not-searched' && r.unchecked !== undefined);
  const sentences: string[] = own.map(r => `Its own file could not be parsed: ${describeUnscannedFile(r)}; ${r.unchecked}.`);
  if (possible.length > 0) {
    sentences.push(`There are possible uses in files that could not be parsed: ` +
      possible.map(r => `${describeUnscannedFile(r)}, whose text names ${quoted(r.names)}`).join('; ') +
      '. They were found by a text search, which cannot tell a use from the same name in another string.');
  }
  if (unreadable.length > 0) {
    sentences.push(`Files that could not be parsed could not be searched for uses either: ` +
      `${unreadable.map(describeUnscannedFile).join(', ')}.`);
  }
  return sentences.join(' ');
}

/**
 * The warnings for skipped files once a check goes ahead: with force, the
 * possible uses and unsearched files it went past (`done`: what happened,
 * e.g. "Deleted"); in any case the files that were only searched as text.
 */
export function unscannedWarnings(reports: readonly UnscannedFileReport[], done: string): string[] {
  const warnings: string[] = [];
  if (blocksWithoutForce(reports)) {
    const searched = reports.some(r => r.textSearch === 'possible-use' || r.textSearch === 'unreadable');
    warnings.push(`${done} with force=true: ${unscannedRefusal(reports)}` +
      (searched ? ' Uses in these files were NOT checked beyond this text search and were NOT changed.' : ''));
  }
  for (const r of reports.filter(r => r.textSearch === 'no-match')) {
    warnings.push(`${describeUnscannedFile(r)} could not be parsed and was only searched as text` +
      (r.searchedFor && r.searchedFor.length > 0
        ? ` (for: ${listSome(r.searchedFor)}); none of these was found.`
        : '; the search found no possible use.'));
  }
  return warnings;
}

/** "a, b, c" or "a, b, c, d, e and 3 more" */
function listSome(items: readonly string[], max = 5): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/** Tool result fields for the skipped files a check searched: none when there were none. */
export function unscannedFields(reports: readonly UnscannedFileReport[]): { unscannedFiles?: UnscannedFileReport[] } {
  return reports.length > 0 ? { unscannedFiles: [...reports] } : {};
}
