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
 *   only searched as text.
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

export type TextSearchOutcome = 'possible-use' | 'no-match' | 'unreadable';

/** What the text search of one skipped file found, as tool results list it (`unscannedFiles`). */
export interface UnscannedFileReport {
  file: string;
  reason: string;
  textSearch: TextSearchOutcome;
  /** With "possible-use": the names the text holds, of those the check looks for */
  names?: string[];
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
    if (hits.length === 0) return { file: file.file, reason: file.reason, textSearch: 'no-match' };
    const names = [...new Set(hits.flatMap(r => r.allOf.flatMap(group => group.filter(t => found.has(t.key)).map(t => t.key))))];
    return { file: file.file, reason: file.reason, textSearch: 'possible-use', names };
  });
}

/** True when a check must refuse without force: a possible use, or a file it could not search. */
export function blocksWithoutForce(reports: readonly UnscannedFileReport[]): boolean {
  return reports.some(r => r.textSearch !== 'no-match');
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
  const sentences: string[] = [];
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
    warnings.push(`${done} with force=true: ${unscannedRefusal(reports)} Uses in these files were NOT checked beyond ` +
      'this text search and were NOT changed.');
  }
  const searched = reports.filter(r => r.textSearch === 'no-match');
  if (searched.length > 0) {
    warnings.push(`${searched.map(describeUnscannedFile).join(', ')} could not be parsed and ` +
      `${searched.length === 1 ? 'was' : 'were'} only searched as text; the search found no possible use.`);
  }
  return warnings;
}

/** Tool result fields for the skipped files a check searched: none when there were none. */
export function unscannedFields(reports: readonly UnscannedFileReport[]): { unscannedFiles?: UnscannedFileReport[] } {
  return reports.length > 0 ? { unscannedFiles: [...reports] } : {};
}
