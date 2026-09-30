/**
 * Asset usage tracking across the project.
 *
 * Images: one entry per object type with animations (sprites) or a single
 * image (Tiled Background, 9-patch, Particles, Sprite font and other plugins
 * that save an `image`; counted as one frame, without `animations`). The
 * editor saves `animations` as `{ items, subfolders }`; every animation in
 * every subfolder is counted. An image is used when the project index counts
 * its object type as used, the rule of find_orphaned_objects: used in an event
 * (directly or through one of its families), an instance in a layout
 * (sub-layers and non-world instances included) or named by another
 * instance's object property; or when System "Create object (by name)"
 * creates it with a literal name. It is not analysed when
 * events or scripts may reach it by name: its name appears in an expression,
 * as a string literal in a parameter or script, or as a script identifier;
 * System "Create object (by name)" with an expression; a script that looks up
 * `runtime.objects[...]` with a computed name or passes `runtime.objects` on.
 *
 * File assets (rootFileFolders: sound, music, video, font, icon, general) are
 * matched to the places that can name them:
 * - Audio file parameters ("audio-file": the sound name without extension,
 *   saved as a string or as { "path": name }) and the by-name Audio actions
 *   ("folder" + "audio-file-name", a string expression);
 * - other event parameters: a bare value that is the file name (project file
 *   parameters such as AJAX "Request project file"), or a string literal that
 *   is or contains the file name (for sounds, music and fonts also a literal
 *   that is the name without extension, except in animation and text
 *   parameters); tag and layer parameters are skipped;
 * - script actions, script blocks and script files: file names in the code,
 *   and string literals that are a sound, music or font name;
 * - layouts, object types and families: property values (plugin properties
 *   that name data or image files, Video sources; Text "font" holds the font
 *   name without extension; animation names, display text and instance
 *   variable definitions are not sound, music or font names);
 * - flowcharts and timelines: every string they hold;
 * - CSS font declarations anywhere ("font-family: 'Pixel Sans'") name fonts
 *   without extension;
 * - the text of other project files (an HTML page naming an image, a texture
 *   atlas naming its page image). Such a reference counts only when the file
 *   that holds it is itself used.
 * An asset that cannot be decided is reported as "not-analysed" with a reason,
 * never as "unused": icons (used by the export), project files with a purpose
 * other than "none", names built at runtime (by-name Audio actions with an
 * expression, "prefix" & ... concatenations, ProjectFileNameAt, asset-manager
 * calls, fetch() and import() in scripts with a computed name; prefixes that
 * start with a server URL are skipped), and files that could not be read
 * (an event sheet, script, layout, object type or family: every asset; a
 * flowchart or timeline: file assets; a project file: file assets, once that
 * project file is itself used or not analysed).
 */

import type { Construct3ProjectReader } from '../project-reader.js';
import type { FileFolder, FileFolderSubfolder, FileItem, AssetUsageInfo } from '../types.js';
import { getProjectIndex } from './index-builder.js';
import { countAnimationFrames } from './animations.js';
import { getScriptSource, tokenizeScript, type ScriptToken } from './script-scan.js';
import { createByNameTarget } from '../event-shapes.js';

export type AssetType = 'sound' | 'music' | 'image' | 'font' | 'video' | 'icon' | 'general' | 'all';

type AssetKind = AssetUsageInfo['type'];
type FileKind = Exclude<AssetKind, 'image'>;

export interface AssetUsageResult {
  summary: {
    totalAssets: number;
    byType: Record<string, number>;
    usedCount: number;
    unusedCount: number;
    notAnalysedCount: number;
    mostReferenced: Array<{ name: string; type: string; referenceCount: number }>;
  };
  assets?: AssetUsageInfo[];
  notes: string[];
}

const MAX_DEPTH = 50;
const MAX_REASONS = 3;
const STANDARD_LIMIT = 50;

/** Kinds whose files are also named without extension (sounds/music by Audio, fonts by Text "font") */
const BASE_NAME_KINDS: ReadonlySet<FileKind> = new Set(['sound', 'music', 'font']);
/** Kinds an Audio file parameter can name (the parameter does not say which folder) */
const AUDIO_KINDS: ReadonlySet<FileKind> = new Set(['sound', 'music']);
/** Kinds that computed names in event expressions and scripts can load */
const COMPUTED_NAME_KINDS: ReadonlySet<FileKind> = new Set(['general', 'video', 'font']);
/** Parameter keys that name a file, URL, path or source (AJAX "url", Sprite "uri", Video "primary-source", ...) */
const FILE_PARAMETER_KEY = /file|url|uri|src|path|source|font/i;
/** Parameters that hold a tag or a layer/group name, never a file */
const NON_FILE_PARAMETER_KEYS = new Set(['tag', 'tags', 'tag-optional', 'layer', 'group-name']);
/** Keys of layouts/object types whose strings are not file references */
const NON_FILE_PROPERTY_KEYS = new Set(['tags', 'originalSource']);
/**
 * Parameter and property keys whose values are animation names or display
 * text (Sprite "initial-animation" and "set-animation", Spine "animation" and
 * "skin", Text "text"): never the name of a sound, music or font
 */
const NON_NAME_VALUE_KEY = /anim|^(?:text|skin|tooltip|placeholder)$/i;
/**
 * Timeline and flowchart keys that hold editor settings (interpolation, ease,
 * the layout a timeline starts on), not values the project reads
 */
const DATA_FILE_SKIP_KEYS = new Set([
  'tags', 'interpolationMode', 'resultMode', 'ease', 'pathMode', 'resizeMode', 'startOnLayout',
]);
/** A name that starts with the URL of a server ("https://host/api/", "//cdn/") is not a project file */
const REMOTE_URL = /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i;
/** CSS font declarations ("font-family: 'Pixel Sans', serif", "font: 12px Pixel Sans"); the value, lower case */
const CSS_FONT_DECLARATION = /font(?:-family)?\s*:([^;{}<>]*)/g;
/** Longest string recorded as a possible object name */
const MAX_NAME_LENGTH = 200;

/**
 * Script asset-manager calls (runtime.assets.*) that load project files or
 * media files (sounds, music, videos) by name.
 */
const SCRIPT_FILE_APIS = new Map<string, FileKind[]>([
  ['fetchText', ['general']],
  ['fetchJson', ['general']],
  ['fetchBlob', ['general']],
  ['fetchArrayBuffer', ['general']],
  ['getProjectFileUrl', ['general']],
  ['loadScripts', ['general']],
  ['loadStyleSheet', ['general']],
  ['compileWebAssembly', ['general']],
  ['getMediaFileUrl', ['sound', 'music', 'video']],
]);

/** Extensions of project files that cannot name other files */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'psd',
  'webm', 'ogg', 'oga', 'opus', 'mp3', 'm4a', 'aac', 'flac', 'wav', 'mid', 'midi',
  'mp4', 'm4v', 'mov', 'ogv', 'avi', 'mkv',
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'wasm', 'zip', 'gz', '7z', 'rar', 'glb', 'bin', 'pdf',
]);

/** A file name in running text ("page.html", "ui/a_b-1.png") */
const FILE_NAME_TOKEN = /[\p{L}\p{N}_\-.%~+]+\.[\p{L}\p{N}]{1,8}/gu;
const FILE_NAME_TOKEN_CHARS = /^[\p{L}\p{N}_\-.%~+]+$/u;

const FILE_FOLDERS: Array<{ key: FileKind; type: FileKind }> = [
  { key: 'sound', type: 'sound' },
  { key: 'music', type: 'music' },
  { key: 'video', type: 'video' },
  { key: 'font', type: 'font' },
  { key: 'icon', type: 'icon' },
  { key: 'general', type: 'general' },
];

type Via = 'audio-file' | 'play-by-name' | 'parameter' | 'string' | 'script' | 'property' | 'flowchart' | 'timeline'
  | 'project-file' | 'object';

interface Refs {
  eventSheets: Set<string>;
  layouts: Set<string>;
  objectTypes: Set<string>;
  scripts: Set<string>;
  flowcharts: Set<string>;
  timelines: Set<string>;
  projectFiles: Set<string>;
  via: Set<Via>;
}

interface FileAsset {
  kind: FileKind;
  /** Path inside its folder, e.g. "sub/click.webm" */
  path: string;
  lcName: string;
  lcPath: string;
  /** Lower-case name without extension */
  lcBase: string;
  purpose?: string;
  refs: Refs;
  /** A reference other than from another project file */
  direct: boolean;
  /** Project files whose text names this asset */
  namedBy: FileAsset[];
  reasons: string[];
  status?: AssetUsageInfo['status'];
}

/** A file name the project builds at runtime */
interface ComputedName {
  kinds: FileKind[];
  /** Text the name starts with (lower case), or null */
  prefix: string | null;
  /** Text the name ends with (lower case), or null */
  suffix: string | null;
  /** Compare against the name without extension (by-name Audio actions) */
  baseName: boolean;
  where: string;
}

const newRefs = (): Refs => ({
  eventSheets: new Set(), layouts: new Set(), objectTypes: new Set(), scripts: new Set(), flowcharts: new Set(), timelines: new Set(),
  projectFiles: new Set(), via: new Set(),
});

/**
 * Family names in the value of a CSS font declaration, e.g. ` 'pixel sans',
 * serif` or, for the `font` shorthand, ` bold 12px pixel sans`: a quoted
 * name as written, an unquoted one whole and after a size.
 */
function cssFontFamilies(value: string): string[] {
  const out: string[] = [];
  for (const item of value.split(',')) {
    const quoted = /(["'])(.*?)\1/.exec(item);
    if (quoted) {
      out.push(quoted[2].trim());
      continue;
    }
    const plain = item.replace(/["']/g, '').trim();
    if (!plain) continue;
    out.push(plain);
    const afterSize = /(?:^|\s)\d[\d.]*[a-z%]*(?:\/\S+)?\s+(.+)$/.exec(plain);
    if (afterSize) out.push(afterSize[1]);
  }
  return out;
}

const stripExtension = (name: string) => name.replace(/\.[^./\\]*$/, '');
const extensionOf = (name: string) => (/\.([^./\\]+)$/.exec(name)?.[1] ?? '').toLowerCase();

/** Last path segment of a file reference, lower case, without query or hash ("sub/a.png?v=1" -> "a.png") */
function lastSegment(value: string): string {
  const clean = value.trim().split(/[?#]/)[0];
  const parts = clean.split(/[\\/]/);
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

/**
 * Track asset usage across the project.
 */
export async function getAssetUsage(
  reader: Construct3ProjectReader,
  options: {
    type?: AssetType;
    detail?: 'summary' | 'standard' | 'full';
  } = {}
): Promise<AssetUsageResult> {
  const index = await getProjectIndex(reader);
  const project = reader.getProject();
  const detail = options.detail || 'standard';
  const filterType = options.type || 'all';
  const notes: string[] = [];
  /** Event sheets, script files, layouts, object types and families that could not be read: every asset is undecided */
  const unreadable: string[] = [];
  /** Flowcharts and timelines that could not be read: they can name files, not place or create objects */
  const unreadableForFiles: string[] = [];
  /** Project files that could not be read: they may name any file asset, which matters once they are used */
  const unreadableProjectFiles: FileAsset[] = [];

  // ── File assets ──────────────────────────────────────────
  const fileAssets: FileAsset[] = [];
  const rootFolders: Partial<Record<string, FileFolder>> = { ...(project.rootFileFolders ?? {}) };
  for (const { key, type } of FILE_FOLDERS) {
    const folder = rootFolders[key];
    if (folder) collectFileAssets(folder, type, '', fileAssets, 0);
  }
  const byName = new Map<string, FileAsset[]>();
  const byBase = new Map<string, FileAsset[]>();
  for (const asset of fileAssets) {
    pushMap(byName, asset.lcName, asset);
    if (BASE_NAME_KINDS.has(asset.kind)) pushMap(byBase, asset.lcBase, asset);
  }
  const computed: ComputedName[] = [];
  // Names with characters the token pattern does not cover (e.g. spaces) are searched as text
  const unusualNames = fileAssets.filter(a => !FILE_NAME_TOKEN_CHARS.test(a.lcName));

  // A font family in CSS is the font's name without extension
  const fontsByBase = new Map<string, FileAsset[]>();
  for (const a of fileAssets) if (a.kind === 'font' && a.lcBase) pushMap(fontsByBase, a.lcBase, a);

  /** Assets a value names by file name (the whole value, last path segment) */
  const byFileName = (value: string): FileAsset[] => byName.get(lastSegment(value)) ?? [];
  /**
   * Assets whose file name occurs in a text: the whole text, or a file name
   * within it ("url(bg.png)"); and fonts named in a CSS font declaration
   */
  const namedInText = (text: string): FileAsset[] => {
    const lower = text.toLowerCase();
    const found = new Set(byFileName(text));
    for (const m of lower.matchAll(FILE_NAME_TOKEN)) for (const a of byName.get(m[0]) ?? []) found.add(a);
    for (const a of unusualNames) if (lower.includes(a.lcName)) found.add(a);
    if (fontsByBase.size > 0 && lower.includes('font')) {
      // HTML attributes may hold the quotes as entities
      const css = lower.replace(/&quot;|&#0*39;|&apos;/g, '"');
      for (const m of css.matchAll(CSS_FONT_DECLARATION)) {
        for (const family of cssFontFamilies(m[1])) for (const a of fontsByBase.get(family) ?? []) found.add(a);
      }
    }
    return [...found];
  };
  /** Assets of `kinds` a value names without extension */
  const byBaseName = (value: string, kinds: ReadonlySet<FileKind>): FileAsset[] =>
    (byBase.get(lastSegment(value)) ?? []).filter(a => kinds.has(a.kind));
  const addRef = (assets: FileAsset[], where: keyof Omit<Refs, 'via'>, location: string, via: Via) => {
    for (const asset of assets) {
      asset.refs[where].add(location);
      asset.refs.via.add(via);
      if (where !== 'projectFiles') asset.direct = true;
    }
  };

  // ── Event sheets ─────────────────────────────────────────
  const sheetNames = await reader.listEventSheets();
  const sheets = await reader.readAllEventSheets();
  for (const name of sheetNames) if (!sheets.has(name)) unreadable.push(`event sheet "${name}"`);
  /** Script identifiers (JavaScript names are case-sensitive): object names used as runtime.objects.Name */
  const scriptIdentifiers = new Set<string>();
  /**
   * Lower case: identifiers in event expressions (C3 names are case-insensitive)
   * and whole string literals in parameters, variables and scripts, any of
   * which may name an object type that events or scripts look up by name
   */
  const namedInCode = new Set<string>();
  const noteName = (s: string) => {
    if (s && s.length <= MAX_NAME_LENGTH) namedInCode.add(s.toLowerCase());
  };
  /** Object types (lower case) created by a literal name -> event sheets; expressions that create by a computed name */
  const createdByName = new Map<string, string[]>();
  const createdByExpression: string[] = [];

  /**
   * `objects` at token i: runtime.objects.Name and runtime.objects["Name"]
   * name an object type (the identifier and string rules record them);
   * objects[expression] looks one up by a computed name, and passing
   * runtime.objects on as a whole (an alias, Object.keys) may reach any.
   */
  const noteObjectLookup = (tokens: ScriptToken[], i: number, scriptPlace: string) => {
    const isPunct = (t: ScriptToken | undefined, ...values: string[]) => t?.kind === 'punct' && values.includes(t.value);
    let j = i + 1;
    if (isPunct(tokens[j], '?.') && isPunct(tokens[j + 1], '[')) j++;
    if (isPunct(tokens[j], '[')) {
      const literal = tokens[j + 1]?.kind === 'string' && isPunct(tokens[j + 2], ']');
      if (!literal) createdByExpression.push(`${scriptPlace} looks up object types by a computed name (objects[...])`);
      return;
    }
    const onRuntime = isPunct(tokens[i - 1], '.', '?.') && tokens[i - 2]?.kind === 'ident' && tokens[i - 2].value === 'runtime';
    if (onRuntime && !isPunct(tokens[j], '.', '?.')) {
      createdByExpression.push(`${scriptPlace} passes runtime.objects on as a whole, which can reach any object type by name`);
    }
  };

  /** Whether the string at token i is the URL argument of fetch(), import() or XMLHttpRequest open() */
  const isUrlArgument = (tokens: ScriptToken[], i: number): boolean => {
    const prev = tokens[i - 1];
    const callee = tokens[i - 2];
    if (prev?.kind === 'punct' && prev.value === '(' && callee?.kind === 'ident' && (callee.value === 'fetch' || callee.value === 'import')) {
      return true;
    }
    // xhr.open("GET", "levels/" + n)
    return prev?.kind === 'punct' && prev.value === ',' && tokens[i - 2]?.kind === 'string'
      && tokens[i - 3]?.kind === 'punct' && tokens[i - 3].value === '('
      && tokens[i - 4]?.kind === 'ident' && tokens[i - 4].value === 'open';
  };

  const scanScript = (source: string, location: string, where: 'eventSheets' | 'scripts') => {
    // File names anywhere in the code, template literal text included
    addRef(namedInText(source), where, location, 'script');
    const scriptPlace = where === 'scripts' ? location : `a script in event sheet "${location}"`;
    const tokens = tokenizeScript(source);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.kind === 'ident') {
        scriptIdentifiers.add(t.value);
        if (t.value === 'objects') noteObjectLookup(tokens, i, scriptPlace);
        const kinds = SCRIPT_FILE_APIS.get(t.value);
        const prev = tokens[i - 1];
        const open = tokens[i + 1];
        if (kinds && prev?.kind === 'punct' && (prev.value === '.' || prev.value === '?.') && open?.kind === 'punct' && open.value === '(') {
          const arg = tokens[i + 2];
          const after = tokens[i + 3];
          const lone = arg?.kind === 'string' && after?.kind === 'punct' && (after.value === ')' || after.value === ',');
          const prefixed = arg?.kind === 'string' && after?.kind === 'punct' && after.value === '+' && arg.value.length > 0;
          if (!lone && !(prefixed && REMOTE_URL.test(arg.value))) {
            computed.push({
              kinds, prefix: prefixed ? arg.value.toLowerCase() : null, suffix: null, baseName: false,
              where: `${scriptPlace} passes a computed name to ${t.value}()`,
            });
          }
        }
        continue;
      }
      if (t.kind !== 'string' || !t.value) continue;
      noteName(t.value);
      addRef(byBaseName(t.value, BASE_NAME_KINDS), where, location, 'script');
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      const plusBefore = prev?.kind === 'punct' && prev.value === '+';
      const plusAfter = next?.kind === 'punct' && next.value === '+';
      if (plusBefore && !plusAfter) addComputed(computed, [], [t.value], false, `... + "${t.value}" in ${scriptPlace}`);
      if (plusAfter && !plusBefore && isUrlArgument(tokens, i)) {
        addComputed(computed, [t.value], [], true, `"${t.value}" + ... as a URL in ${scriptPlace}`);
      }
    }
    // Template literal text is not tokenized: `${...}tail`, and fetch(`head${...}`)
    for (const m of source.matchAll(/\}([^`$\\{}]*)`/g)) addComputed(computed, [], [m[1]], false, `\`\${...}${m[1]}\` in ${scriptPlace}`);
    for (const m of source.matchAll(/\b(?:fetch|import)\s*\(\s*`([^`$\\{}]*)\$\{/g)) {
      addComputed(computed, [m[1]], [], true, `\`${m[1]}\${...}\` as a URL in ${scriptPlace}`);
    }
  };

  const visitValue = (sheet: string, ace: Record<string, unknown>, key: string | undefined, value: unknown) => {
    // Newer releases save file parameters as { "path": name }
    const path = value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { path?: unknown }).path === 'string'
      ? (value as { path: string }).path
      : null;
    if (path === null && typeof value !== 'string') return;

    if (key === 'audio-file' || (key === 'audio' && ace.id === 'add-convolution-effect')) {
      addRef(byBaseName(path ?? String(value), AUDIO_KINDS), 'eventSheets', sheet, 'audio-file');
      return;
    }
    if (key === 'audio-file-name') {
      visitAudioByName(sheet, ace, path ?? String(value));
      return;
    }
    if (key !== undefined && NON_FILE_PARAMETER_KEYS.has(key)) return;
    if (path !== null) {
      addRef(byFileName(path), 'eventSheets', sheet, 'parameter');
      return;
    }
    const text = String(value);
    if (!text.includes('"')) {
      // A bare value: a project file parameter (AJAX "file": "data.json") or an expression
      if (/\.[\p{L}\p{N}]+\s*$/u.test(text)) addRef(byFileName(text), 'eventSheets', sheet, 'parameter');
      noteExpression(text, sheet);
      return;
    }
    const pieces = c3StringPieces(text);
    const baseNames = key === undefined || !NON_NAME_VALUE_KEY.test(key);
    for (const piece of pieces) {
      if (!piece.value) continue;
      addRef(namedInText(piece.value), 'eventSheets', sheet, 'string');
      if (piece.concatBefore || piece.concatAfter) continue;
      noteName(piece.value);
      if (baseNames) addRef(byBaseName(piece.value, BASE_NAME_KINDS), 'eventSheets', sheet, 'string');
    }
    const prefixes = pieces.filter(p => p.concatAfter && !p.concatBefore).map(p => p.value);
    const suffixes = pieces.filter(p => p.concatBefore && !p.concatAfter).map(p => p.value);
    addComputed(computed, prefixes, suffixes, key !== undefined && FILE_PARAMETER_KEY.test(key),
      `${JSON.stringify(text.slice(0, 80))} in event sheet "${sheet}"`);
    noteExpression(stripC3Literals(text), sheet);
  };

  /**
   * By-name Audio actions: "folder" ("sounds"/"music") and "audio-file-name",
   * a string expression naming the file without extension. Literal names are
   * matched; any other expression may play every file of the folder whose
   * name fits its literal "prefix" & ... / ... & "suffix" parts.
   */
  const visitAudioByName = (sheet: string, ace: Record<string, unknown>, expression: string) => {
    const folder = (ace.parameters as Record<string, unknown>).folder;
    const kinds: FileKind[] = folder === 'sounds' ? ['sound'] : folder === 'music' ? ['music'] : ['sound', 'music'];
    const kindSet = new Set(kinds);
    const pieces = c3StringPieces(expression);
    for (const piece of pieces) {
      if (!piece.concatBefore && !piece.concatAfter) addRef(byBaseName(piece.value, kindSet), 'eventSheets', sheet, 'play-by-name');
    }
    // Complete names: one literal, or only literals picked by choose()
    const code = stripC3Literals(expression).replace(/\bchoose\b/gi, '');
    const onlyLiterals = pieces.length > 0 && pieces.every(p => !p.concatBefore && !p.concatAfter) && /^[\s"(),]*$/.test(code);
    if (onlyLiterals) return;
    const prefix = pieces.find(p => p.concatAfter && !p.concatBefore && p.value)?.value.toLowerCase() ?? null;
    const suffix = pieces.find(p => p.concatBefore && !p.concatAfter && p.value)?.value.toLowerCase() ?? null;
    computed.push({
      kinds, prefix, suffix, baseName: true,
      where: `"${String(ace.id)}" in event sheet "${sheet}" names the file with the expression ${JSON.stringify(expression.slice(0, 80))}`,
    });
  };

  /** Identifiers used in an expression; ProjectFileNameAt makes every project file reachable. */
  const noteExpression = (code: string, sheet: string) => {
    for (const m of code.matchAll(/[\p{L}_][\p{L}\p{N}_]*/gu)) noteName(m[0]);
    if (/projectfilenameat\s*\(/i.test(code)) {
      computed.push({ kinds: ['general'], prefix: null, suffix: null, baseName: false, where: `ProjectFileNameAt() in event sheet "${sheet}"` });
    }
  };

  const visitAce = (sheet: string, ace: unknown) => {
    if (!ace || typeof ace !== 'object' || Array.isArray(ace)) return;
    const record = ace as Record<string, unknown>;
    if (record.type === 'script') {
      const source = getScriptSource(record.script);
      if (source) scanScript(source, sheet, 'eventSheets');
      return;
    }
    const params = record.parameters;
    if (Array.isArray(params)) {
      for (const value of params) visitValue(sheet, record, undefined, value);
    } else if (params && typeof params === 'object') {
      // System "Create object (by name)": a string expression naming the object type
      const created = createByNameTarget(record);
      if (typeof created === 'string') pushMap(createdByName, created.toLowerCase(), sheet);
      else if (created === null) createdByExpression.push(`"create-object-by-name" in event sheet "${sheet}" creates an object type named by an expression`);
      for (const [key, value] of Object.entries(params)) visitValue(sheet, record, key, value);
    }
  };

  for (const [sheetName, sheet] of sheets) {
    const stack: Array<{ event: unknown; depth: number }> = (Array.isArray(sheet.events) ? sheet.events : []).map(event => ({ event, depth: 0 }));
    while (stack.length > 0) {
      const { event, depth } = stack.pop()!;
      if (!event || typeof event !== 'object' || Array.isArray(event) || depth > MAX_DEPTH) continue;
      const e = event as Record<string, unknown>;
      if (e.eventType === 'script') {
        const source = getScriptSource(e.script);
        if (source) scanScript(source, sheetName, 'eventSheets');
      }
      if (e.eventType === 'variable' && typeof e.initialValue === 'string' && e.initialValue) {
        // String variables save their initial value as plain text
        noteName(e.initialValue);
        addRef(namedInText(e.initialValue), 'eventSheets', sheetName, 'string');
        addRef(byBaseName(e.initialValue, BASE_NAME_KINDS), 'eventSheets', sheetName, 'string');
      }
      for (const list of [e.conditions, e.actions]) {
        if (Array.isArray(list)) for (const ace of list) visitAce(sheetName, ace);
      }
      if (Array.isArray(e.children)) for (const child of e.children) stack.push({ event: child, depth: depth + 1 });
    }
  }

  // ── Script files ─────────────────────────────────────────
  const scriptFolder = rootFolders.script;
  if (scriptFolder) {
    const scriptPaths: string[] = [];
    walkFolder(scriptFolder, '', 0, (item, prefix) => { if (typeof item.name === 'string') scriptPaths.push(prefix + item.name); });
    for (const scriptPath of scriptPaths) {
      try {
        scanScript(await reader.readScriptFile(scriptPath), `scripts/${scriptPath}`, 'scripts');
      } catch {
        unreadable.push(`script file "${scriptPath}"`);
      }
    }
  }

  // ── Layouts, object types, families ──────────────────────
  const layouts = await reader.readAllLayouts();
  for (const name of await reader.listLayouts()) if (!layouts.has(name)) unreadable.push(`layout "${name}"`);
  const objectTypes = await reader.readAllObjectTypes();
  for (const name of await reader.listObjectTypes()) if (!objectTypes.has(name)) unreadable.push(`object type "${name}"`);
  const families = await reader.readAllFamilies();
  for (const name of await reader.listFamilies()) if (!families.has(name)) unreadable.push(`family "${name}"`);

  const scanProperties = (data: unknown, where: 'layouts' | 'objectTypes', location: string) => {
    walkStrings(data, NON_FILE_PROPERTY_KEYS, (text, inValues, key) => {
      addRef(namedInText(text), where, location, 'property');
      if (inValues && !(key !== undefined && NON_NAME_VALUE_KEY.test(key))) addRef(byBaseName(text, BASE_NAME_KINDS), where, location, 'property');
    });
  };
  for (const [name, layout] of layouts) scanProperties(layout, 'layouts', name);
  for (const [name, obj] of objectTypes) scanProperties(obj, 'objectTypes', name);
  for (const [name, family] of families) scanProperties(family, 'objectTypes', name);

  // ── Flowcharts and timelines ─────────────────────────────
  // Flowchart node outputs are strings events read (Flowchart.OutputValue);
  // the node shape is not known, so every string counts (the file's own name
  // and editor settings aside).
  for (const folder of ['flowcharts', 'timelines'] as const) {
    const label = folder === 'flowcharts' ? 'flowchart' : 'timeline';
    let paths: string[];
    try {
      paths = await reader.listDataFiles(folder);
    } catch {
      unreadableForFiles.push(`${folder} folder`);
      continue;
    }
    for (const relPath of paths) {
      let data: unknown;
      try {
        data = JSON.parse(await reader.readDataFileText(folder, relPath));
      } catch {
        unreadableForFiles.push(`${label} "${relPath}"`);
        continue;
      }
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const { name: _ownName, ...rest } = data as Record<string, unknown>;
        data = rest;
      }
      const location = relPath.replace(/\.json$/i, '');
      walkStrings(data, DATA_FILE_SKIP_KEYS, text => {
        addRef(namedInText(text), folder, location, label);
        addRef(byBaseName(text, BASE_NAME_KINDS), folder, location, label);
      });
    }
  }

  // ── Project files that name other files ──────────────────
  for (const file of fileAssets) {
    if (file.kind !== 'general' || BINARY_EXTENSIONS.has(extensionOf(file.lcName))) continue;
    let text: string;
    try {
      text = await reader.readProjectFileText(file.path);
    } catch {
      unreadableProjectFiles.push(file);
      continue;
    }
    if (text.includes('\u0000')) continue; // binary content
    const named = new Set(namedInText(text));
    for (const m of text.matchAll(/["']([^"'\n]{1,200})["']/g)) {
      for (const a of byBaseName(m[1], BASE_NAME_KINDS)) named.add(a);
    }
    named.delete(file);
    for (const a of named) {
      a.refs.projectFiles.add(file.path);
      a.namedBy.push(file);
    }
  }

  // ── Status of file assets ────────────────────────────────
  const listUnreadable = (list: string[]) => (list.length > 0
    ? `${list.length} file(s) could not be read (${list.slice(0, 3).join(', ')}${list.length > 3 ? ', ...' : ''})`
    : null);
  /** Reason for images; file assets also depend on flowcharts and timelines */
  const unreadableReason = listUnreadable(unreadable);
  const fileUnreadableReason = listUnreadable([...unreadable, ...unreadableForFiles]);
  for (const asset of fileAssets) {
    if (asset.direct) {
      asset.status = 'used';
      continue;
    }
    if (asset.kind === 'icon') {
      asset.reasons.push(`icon${asset.purpose ? ` (${asset.purpose})` : ''}: used by the export, not by events, layouts or scripts`);
    } else if (asset.purpose && asset.purpose !== 'none') {
      asset.reasons.push(`project file purpose "${asset.purpose}": loaded by the project itself`);
    }
    for (const c of computed) {
      if (c.kinds.includes(asset.kind) && fitsComputedName(asset, c)) asset.reasons.push(`the name may be built at runtime: ${c.where}`);
    }
    if (fileUnreadableReason) asset.reasons.push(fileUnreadableReason);
    if (asset.reasons.length > 0) asset.status = 'not-analysed';
  }
  // A project file's references count when that file is used (or cannot be
  // decided); one that could not be read may name any file asset
  const inUse = (f: FileAsset) => f.status === 'used' || f.status === 'not-analysed';
  let changed = true;
  while (changed) {
    changed = false;
    for (const asset of fileAssets) {
      if (asset.status === 'used') continue;
      if (asset.namedBy.some(f => f.status === 'used')) {
        asset.status = 'used';
        asset.refs.via.add('project-file');
        changed = true;
      } else if (asset.status !== 'not-analysed') {
        const undecided = asset.namedBy.find(f => f.status === 'not-analysed');
        const unread = unreadableProjectFiles.find(f => f !== asset && inUse(f));
        if (undecided) {
          asset.status = 'not-analysed';
          asset.reasons.push(`named by project file "${undecided.path}", which is not analysed`);
          changed = true;
        } else if (unread) {
          asset.status = 'not-analysed';
          asset.reasons.push(`project file "${unread.path}" could not be read and may name it`);
          changed = true;
        }
      }
    }
  }
  for (const asset of fileAssets) {
    if (!asset.status) asset.status = 'unused';
    if (asset.status === 'unused' && asset.namedBy.length > 0) {
      asset.reasons.push(`named only by unused project files (${asset.namedBy.map(f => f.path).join(', ')})`);
    }
  }

  // ── Images (sprite animations and single images) ─────────
  const containers = Array.isArray(project.containers) && project.containers.length > 0
    ? JSON.stringify(project.containers).toLowerCase()
    : '';
  const assetUsages: AssetUsageInfo[] = [];
  for (const [objName, objData] of objectTypes) {
    // Tiled Background, 9-patch, Particles, Sprite font and other plugins save one `image` instead
    const singleImage = objData.animations === undefined && isRecord(objData.image);
    if (objData.animations === undefined && !singleImage) continue;
    const counts: { animations?: number; frames: number } = singleImage
      ? { frames: 1 }
      : countAnimationFrames(objData.animations);
    const eventSheets = new Set(index.getEventSheetsForObject(objName));
    const objFamilies = index.objectToFamilies.get(objName) ?? [];
    for (const family of objFamilies) {
      for (const s of index.getEventSheetsForObject(family)) eventSheets.add(s);
    }
    for (const name of [objName, ...objFamilies]) {
      for (const s of createdByName.get(name.toLowerCase()) ?? []) eventSheets.add(s);
    }
    const namedAs = [objName, ...objFamilies].find(n => scriptIdentifiers.has(n) || namedInCode.has(n.toLowerCase()));
    // Layouts with an instance (any layer or sub-layer, or non-world), from the project index
    const inLayouts = [...(index.objectToLayouts.get(objName) ?? [])].sort();
    const info: AssetUsageInfo = {
      name: objName,
      type: 'image',
      status: 'used',
      referencedIn: { eventSheets: [...eventSheets].sort(), layouts: inLayouts },
      ...counts,
      isGlobal: objData.isGlobal === true,
    };
    // Used by the same rule as find_orphaned_objects (events, directly or through a
    // family, Create object (by name) with a literal name included; layout
    // instances; object properties of other instances)
    if (index.isObjectUsed(objName) || eventSheets.size > 0) {
      info.via = ['object'];
    } else if (namedAs !== undefined) {
      info.status = 'not-analysed';
      info.reason = `${namedAs === objName ? 'the object name' : `its family "${namedAs}"`} appears in event parameters or scripts, `
        + 'where object references are not all traced';
    } else if (containers.includes(JSON.stringify(objName.toLowerCase()))) {
      info.status = 'not-analysed';
      info.reason = 'the object type is in a container, whose other members create its instances';
    } else if (createdByExpression.length > 0) {
      info.status = 'not-analysed';
      info.reason = createdByExpression[0];
    } else if (unreadableReason) {
      info.status = 'not-analysed';
      info.reason = unreadableReason;
    } else {
      info.status = 'unused';
    }
    assetUsages.push(info);
  }

  for (const asset of fileAssets) {
    const r = asset.refs;
    const referencedIn: AssetUsageInfo['referencedIn'] = { eventSheets: [...r.eventSheets].sort(), layouts: [...r.layouts].sort() };
    if (r.objectTypes.size) referencedIn.objectTypes = [...r.objectTypes].sort();
    if (r.scripts.size) referencedIn.scripts = [...r.scripts].sort();
    if (r.flowcharts.size) referencedIn.flowcharts = [...r.flowcharts].sort();
    if (r.timelines.size) referencedIn.timelines = [...r.timelines].sort();
    if (r.projectFiles.size) referencedIn.projectFiles = [...r.projectFiles].sort();
    const info: AssetUsageInfo = {
      name: asset.path,
      type: asset.kind,
      status: asset.status!,
      referencedIn,
      isGlobal: false,
    };
    if (r.via.size) info.via = [...r.via];
    const reasons = [...new Set(asset.reasons)];
    if (asset.status !== 'used' && reasons.length) {
      info.reason = reasons.slice(0, MAX_REASONS).join('; ')
        + (reasons.length > MAX_REASONS ? `; (+${reasons.length - MAX_REASONS} more)` : '');
    }
    assetUsages.push(info);
  }

  // ── Result ───────────────────────────────────────────────
  const selected = filterType === 'all' ? assetUsages : assetUsages.filter(a => a.type === filterType);
  const byType: Record<string, number> = {};
  for (const a of selected) byType[a.type] = (byType[a.type] || 0) + 1;
  const count = (status: AssetUsageInfo['status']) => selected.filter(a => a.status === status).length;

  const referenceCount = (a: AssetUsageInfo) => {
    const r = a.referencedIn;
    return r.eventSheets.length + r.layouts.length + (r.objectTypes?.length ?? 0) + (r.scripts?.length ?? 0)
      + (r.flowcharts?.length ?? 0) + (r.timelines?.length ?? 0) + (r.projectFiles?.length ?? 0);
  };
  const mostReferenced = selected
    .map(a => ({ name: a.name, type: a.type, referenceCount: referenceCount(a) }))
    .filter(a => a.referenceCount > 0)
    .sort((a, b) => b.referenceCount - a.referenceCount)
    .slice(0, 10);

  notes.push(
    'Sounds and music count as used when an Audio file parameter or a by-name Audio action names them, or a string in '
      + 'events, scripts, flowcharts, timelines or project files holds their name; tag, layer, animation and text '
      + 'parameters are not file references.',
    'Images are object types with animations (sprites) or a single image (Tiled Background, 9-patch, Particles, '
      + 'Sprite font and other plugins that save an image); they are used when the object type (or one of its families) '
      + 'is used in events, placed in a layout or named by an object property of another instance (as in find_orphaned_objects), '
      + 'and not analysed when events or scripts may look it up by name.',
    'Names that only exist at runtime without a literal part in the project (server data, user input, a script that '
      + 'builds a URL other than in fetch(), import(), XMLHttpRequest open() or runtime.assets calls) are not seen.',
  );
  const unreadableAll = [...unreadable, ...unreadableForFiles, ...unreadableProjectFiles.map(f => `project file "${f.path}"`)];
  if (unreadableAll.length > 0) {
    notes.push(`${listUnreadable(unreadableAll)}. What they may name is not analysed: an unreadable event sheet, script, `
      + 'layout, object type or family affects every asset, a flowchart or timeline the file assets, and a project file '
      + 'the file assets once that project file is itself used or not analysed.');
  }

  const result: AssetUsageResult = {
    summary: {
      totalAssets: selected.length,
      byType,
      usedCount: count('used'),
      unusedCount: count('unused'),
      notAnalysedCount: count('not-analysed'),
      mostReferenced,
    },
    notes,
  };

  if (detail !== 'summary') {
    const order: Record<AssetUsageInfo['status'], number> = { unused: 0, 'not-analysed': 1, used: 2 };
    const sorted = selected.map((a, i) => ({ a, i })).sort((x, y) => order[x.a.status] - order[y.a.status] || x.i - y.i).map(x => x.a);
    result.assets = detail === 'full' ? sorted : sorted.slice(0, STANDARD_LIMIT);
    if (detail === 'standard' && sorted.length > STANDARD_LIMIT) {
      notes.push(`Showing ${STANDARD_LIMIT} of ${sorted.length} assets (unused and not-analysed first); use detail "full" for all.`);
    }
  }

  return result;
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walkFolder(
  folder: FileFolder | FileFolderSubfolder,
  prefix: string,
  depth: number,
  visit: (item: FileItem, prefix: string) => void,
): void {
  if (depth > MAX_DEPTH) return;
  for (const item of Array.isArray(folder.items) ? folder.items : []) {
    if (item && typeof item === 'object') visit(item, prefix);
  }
  for (const sub of Array.isArray(folder.subfolders) ? folder.subfolders : []) {
    if (sub && typeof sub.name === 'string') walkFolder(sub, `${prefix}${sub.name}/`, depth + 1, visit);
  }
}

function collectFileAssets(folder: FileFolder, kind: FileKind, prefix: string, out: FileAsset[], depth: number): void {
  walkFolder(folder, prefix, depth, (item, itemPrefix) => {
    if (typeof item.name !== 'string' || !item.name) return;
    const path = itemPrefix + item.name;
    out.push({
      kind,
      path,
      lcName: item.name.toLowerCase(),
      lcPath: path.toLowerCase(),
      lcBase: stripExtension(item.name).toLowerCase(),
      purpose: item['file-info']?.purpose ?? item['icon-info']?.purpose,
      refs: newRefs(),
      direct: false,
      namedBy: [],
      reasons: [],
    });
  });
}

/**
 * Record the literal parts of a name built at runtime ("prefix" & ... and
 * ... & "suffix"). Only a suffix that looks like an extension (".json",
 * "_hd.png") marks a computed file name; a prefix alone counts only in a
 * file parameter (key naming a file, URL, path or source), since elsewhere
 * "prefix" & n is mostly text, tags or animation names. A name that starts
 * with a server URL ("https://host/api/" & endpoint) is not a project file.
 */
function addComputed(out: ComputedName[], prefixes: string[], suffixes: string[], fileParameter: boolean, where: string): void {
  if (prefixes.some(x => REMOTE_URL.test(x))) return;
  const p = prefixes.map(x => x.toLowerCase()).filter(x => x.trim().length >= 2);
  const s = suffixes.map(x => x.toLowerCase()).filter(x => x.length >= 2 && x.includes('.'));
  const push = (prefix: string | null, suffix: string | null) =>
    out.push({ kinds: [...COMPUTED_NAME_KINDS], prefix, suffix, baseName: false, where });
  if (p.length === 1 && s.length === 1) {
    push(p[0], s[0]);
    return;
  }
  if (fileParameter) for (const prefix of p) push(prefix, null);
  for (const suffix of s) push(p.length === 1 ? p[0] : null, suffix);
}

/** Whether a file name fits a computed name's literal parts. */
function fitsComputedName(asset: FileAsset, c: ComputedName): boolean {
  const name = c.baseName ? asset.lcBase : asset.lcName;
  if (c.suffix !== null && !name.endsWith(c.suffix)) return false;
  if (c.prefix === null) return true;
  // A folder part may not match how the file is addressed at runtime: compare the rest with the name
  const rest = c.prefix.slice(c.prefix.lastIndexOf('/') + 1);
  return name.startsWith(rest) || (!c.baseName && asset.lcPath.startsWith(c.prefix));
}

interface C3Piece {
  value: string;
  /** Joined to what precedes it with & */
  concatBefore: boolean;
  /** Joined to what follows it with & */
  concatAfter: boolean;
}

/** Index of the quote that closes the C3 string literal opening at `start`, or -1. */
function c3StringEnd(s: string, start: number): number {
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === '"') {
      if (s[i + 1] === '"') {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}

/**
 * String literals of a C3 expression ("" escapes a quote; C3 manual,
 * Expressions) and whether `&` joins each to its neighbours.
 */
function c3StringPieces(expr: string): C3Piece[] {
  const pieces: C3Piece[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] !== '"') continue;
    const end = c3StringEnd(expr, i);
    if (end === -1) break;
    spans.push({ start: i, end });
    i = end;
  }
  for (const { start, end } of spans) {
    const before = expr.slice(0, start).trimEnd();
    const after = expr.slice(end + 1).trimStart();
    pieces.push({
      value: expr.slice(start + 1, end).replace(/""/g, '"'),
      concatBefore: before.endsWith('&'),
      concatAfter: after.startsWith('&'),
    });
  }
  return pieces;
}

/** The expression with its string literals removed. */
function stripC3Literals(expr: string): string {
  let out = '';
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '"') {
      const end = c3StringEnd(expr, i);
      if (end === -1) return out;
      out += '""';
      i = end;
    } else {
      out += expr[i];
    }
  }
  return out;
}

/**
 * Call `visit` for every string in a project data file (layout, object type,
 * family, flowchart, timeline), with the key it is saved under (for array
 * items, the array's key). Keys in `skipKeys` are not visited.
 * `inValues` is true under instance properties ("properties") and instance
 * variable values: layout instances save "instanceVariables" as
 * { name: value }; object types and families save the variable definitions
 * (name, type, description) there as an array, which holds no values.
 */
function walkStrings(
  data: unknown,
  skipKeys: ReadonlySet<string>,
  visit: (text: string, inValues: boolean, key: string | undefined) => void,
): void {
  const stack: Array<{ node: unknown; inValues: boolean; key: string | undefined; depth: number }> = [
    { node: data, inValues: false, key: undefined, depth: 0 },
  ];
  while (stack.length > 0) {
    const { node, inValues, key, depth } = stack.pop()!;
    if (depth > MAX_DEPTH) continue;
    if (typeof node === 'string') {
      if (node) visit(node, inValues, key);
    } else if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, inValues, key, depth: depth + 1 });
    } else if (node && typeof node === 'object') {
      for (const [childKey, child] of Object.entries(node)) {
        if (skipKeys.has(childKey)) continue;
        const values = inValues || childKey === 'properties' || (childKey === 'instanceVariables' && !Array.isArray(child));
        stack.push({ node: child, inValues: values, key: childKey, depth: depth + 1 });
      }
    }
  }
}

