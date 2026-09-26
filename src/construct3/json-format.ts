/**
 * On-disk text style of Construct 3 project JSON files.
 *
 * Construct 3 saves project files in the shape of JSON.stringify(data, null,
 * '\t'): tab indent, LF line endings, no trailing newline, no BOM. A byte
 * round-trip (parse → stringify → compare) reproduced all 385 entity files of
 * 10 public projects (incl. Scirra/Construct-Example-Projects) and the
 * project.c3proj of 21 of 22 public repos exactly. Git can normalize line
 * endings, so those checkouts prove the layout but not LF. The LF claim rests
 * on bytes git never normalized: the .c3p archives (zipped folder projects,
 * committed as binary) of fodi/construct-3-projects — 4 archives zipped on
 * Windows, savedWithRelease 38802–45802, holding the editor's *.uistate.json
 * files, so they come from saved project folders, not a checkout. Every entity
 * JSON in them is LF, has no trailing newline and no BOM, and equals
 * JSON.stringify(x, null, '\t') byte for byte (only the minified
 * *.uistate.json files differ).
 *
 * A checkout can still differ: git's core.autocrlf=true gives CRLF files on
 * Windows, and other tools add trailing newlines or a BOM. (The "tabs + CRLF"
 * noted in komabear/c3-skill describes such a checkout, not the editor's own
 * output.) Rewriting such a file in C3's style turns a one-line change into a
 * whole-file diff. So an overwritten file keeps its own line endings, trailing
 * whitespace and BOM, and a new file follows the project's convention.
 * (Rule from komabear/c3-skill, MIT: keep C3 JSON rewrites byte-faithful.)
 */

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

export type LineEnding = '\n' | '\r\n';

export interface JsonTextStyle {
  eol: LineEnding;
  /** Exact whitespace after the closing bracket ('' in Construct 3's own style). */
  trailing: string;
  bom: boolean;
}

/** Detected style; `eol` is undefined when the text has no line break at all. */
export interface DetectedJsonTextStyle extends Omit<JsonTextStyle, 'eol'> {
  eol: LineEnding | undefined;
}

/** The style Construct 3 writes itself. */
export const C3_JSON_STYLE: Readonly<JsonTextStyle> = Object.freeze({
  eol: '\n',
  trailing: '',
  bom: false,
});

const BOM = '\uFEFF';

/** Maximum sibling files inspected when project.c3proj gives no line-ending hint. */
const MAX_SIBLINGS_CHECKED = 5;

/** Remove a leading UTF-8 byte order mark, if present. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** JSON.parse (same return type) that tolerates a leading BOM, which JSON.parse alone rejects. */
export function parseJsonText(text: string): ReturnType<typeof JSON.parse> {
  return JSON.parse(stripBom(text));
}

/** True for the whitespace characters JSON allows between tokens. */
function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * Detect line endings, trailing whitespace and BOM of existing file content.
 * Mixed line endings resolve to the majority (ties go to LF); the trailing
 * whitespace is kept exactly (e.g. a bare "\n" at the end of a CRLF file).
 */
export function detectJsonTextStyle(text: string): DetectedJsonTextStyle {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  let end = text.length;
  while (end > 0 && isJsonWhitespace(text.charCodeAt(end - 1))) end--;
  return {
    eol: crlf + lf === 0 ? undefined : crlf > lf ? '\r\n' : '\n',
    trailing: text.slice(end),
    bom: text.charCodeAt(0) === 0xfeff,
  };
}

/** Style of existing content, with `fallbackEol` for single-line content. */
export function jsonTextStyleOf(text: string, fallbackEol: LineEnding = C3_JSON_STYLE.eol): JsonTextStyle {
  const detected = detectJsonTextStyle(text);
  return { ...detected, eol: detected.eol ?? fallbackEol };
}

/**
 * Apply a text style to tab-indented JSON.stringify output.
 * JSON.stringify escapes newlines inside strings, so every raw "\n" in its
 * output is a structural line break and can be rewritten safely.
 */
export function applyJsonTextStyle(json: string, style: JsonTextStyle): string {
  const out = (style.eol === '\r\n' ? json.replace(/\n/g, '\r\n') : json) + style.trailing;
  return style.bom ? BOM + out : out;
}

/** Serialize data the way Construct 3 does, then apply the given text style. */
export function serializeJson(data: unknown, style: JsonTextStyle = C3_JSON_STYLE): string {
  return applyJsonTextStyle(JSON.stringify(data, null, '\t'), style);
}

async function readStyle(filePath: string): Promise<DetectedJsonTextStyle | undefined> {
  try {
    return detectJsonTextStyle(await readFile(filePath, 'utf-8'));
  } catch {
    return undefined;
  }
}

/**
 * The project's convention for new files: the style of project.c3proj,
 * falling back to the first JSON file in `siblingDir` that has line breaks,
 * then to Construct 3's own style.
 */
export async function projectJsonTextStyle(projectPath: string, siblingDir?: string): Promise<JsonTextStyle> {
  const fromProject = await readStyle(projectPath);
  if (fromProject?.eol) return { ...fromProject, eol: fromProject.eol };

  if (siblingDir) {
    let names: string[] = [];
    try {
      names = (await readdir(siblingDir)).filter(n => n.endsWith('.json')).sort();
    } catch {
      // Folder does not exist yet — nothing to learn from
    }
    for (const name of names.slice(0, MAX_SIBLINGS_CHECKED)) {
      const sibling = await readStyle(join(siblingDir, name));
      if (sibling?.eol) return { ...sibling, eol: sibling.eol };
    }
  }

  return { ...C3_JSON_STYLE };
}

/**
 * Style to write `filePath` with: the file's own style when it exists,
 * otherwise the project convention (see projectJsonTextStyle). An existing
 * single-line file keeps its BOM and trailing whitespace and takes its line
 * ending from the project convention.
 */
export async function resolveJsonTextStyle(
  filePath: string,
  projectPath: string,
  siblingDir?: string,
): Promise<JsonTextStyle> {
  const own = await readStyle(filePath);
  if (own?.eol) return { ...own, eol: own.eol };
  const project = await projectJsonTextStyle(projectPath, siblingDir);
  return own ? { ...own, eol: project.eol } : project;
}
