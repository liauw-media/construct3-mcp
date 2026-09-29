/**
 * Runtime control tools for Construct 3 games.
 *
 * These tools bridge the gap between static project manipulation and
 * live game control: they add a bridge script to the project, serve an
 * exported game (preview-server.ts), and drive the running game over the
 * Chrome DevTools Protocol (cdp-client.ts) through that bridge.
 *
 * Generic — not tied to any specific game or addon.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { Construct3ProjectWriter } from '../construct3/project-writer.js';
import { generateBridgeScript, getBridgeScriptPath } from '../runtime/bridge.js';
import { writeFile, mkdir, readFile, readdir, realpath, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { toolResult, toolError, boundedRecord } from './shared.js';
import { writeZip } from '../runtime/zip-writer.js';
import { jsonTextStyleOf, parseJsonText, serializeJson } from '../construct3/json-format.js';
import { resolveProjectPath } from '../construct3/path-utils.js';

import { PreviewManager, isLoopbackHost } from '../runtime/preview-server.js';
import { RuntimeConnectionManager } from '../runtime/cdp-client.js';
import type { RuntimeCondition, SimulatedInputAction } from '../runtime/cdp-client.js';
/** The host part of a ws:// or wss:// endpoint, or the endpoint itself when it does not parse. */
function hostOfEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return endpoint;
  }
}

/** The real path of a file that may not exist yet: the real path of its nearest existing folder, plus the rest. */
async function realTargetPath(path: string): Promise<string> {
  const rest: string[] = [];
  let existing = resolve(path);
  for (;;) {
    try {
      return join(await realpath(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return resolve(path);
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** True when `path` is `dir` or lies under it (case-insensitively where the platform's paths are). */
function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Refuse a screenshot target that is not a new image file outside the
 * project: the runtime tools leave the project as it is, and a relative
 * path would land in the server process's working folder, wherever that is.
 */
async function checkScreenshotTarget(outputPath: string, format: 'png' | 'jpeg', overwrite: boolean, projectDir: string): Promise<void> {
  if (!isAbsolute(outputPath)) {
    throw new Error("outputPath must be an absolute path (a relative one would land in the MCP server's working folder).");
  }
  const extension = extname(outputPath).toLowerCase();
  if (format === 'png' ? extension !== '.png' : extension !== '.jpg' && extension !== '.jpeg') {
    throw new Error(format === 'png' ? 'outputPath must end in .png for format "png".' : 'outputPath must end in .jpg or .jpeg for format "jpeg".');
  }
  const [project, target] = await Promise.all([realTargetPath(projectDir), realTargetPath(outputPath)]);
  if (isInside(project, target)) {
    throw new Error("outputPath lies inside the open project's folder. The runtime tools leave the project as it is: write screenshots to a folder outside it.");
  }
  if (!overwrite && existsSync(outputPath)) {
    throw new Error('outputPath exists already; pass overwrite: true to replace it, or choose a new file name.');
  }
}

export interface RuntimeToolController {
  close(): Promise<void>;
}

const BRIDGE_COMMANDS = [
  'callFunction',
  'getGlobalVar',
  'setGlobalVar',
  'getObjectState',
  'getAllInstances',
  'getLayout',
  'goToLayout',
  'evaluateExpression',
  'layerToCssPx',
  'cssPxToLayer',
  'subscribeEvents',
  'readEvents',
  'unsubscribeEvents',
  'listObjects',
  'listGlobalVars',
  'ping',
] as const;

const conditionOperatorSchema = z.enum(['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains']);
const runtimeConditionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('globalVar'),
    name: z.string().min(1).max(200),
    operator: conditionOperatorSchema,
    value: z.unknown(),
  }),
  z.object({
    type: z.literal('objectProperty'),
    objectType: z.string().min(1).max(200),
    property: z.string().min(1).max(200),
    operator: conditionOperatorSchema,
    value: z.unknown(),
  }),
  z.object({
    type: z.literal('layout'),
    name: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal('expression'),
    expr: z.string().min(1).max(10_000).describe('JavaScript evaluated in the game page (only with C3MCP_ALLOW_EVAL=1 in the server environment)'),
    operator: conditionOperatorSchema,
    value: z.unknown(),
  }),
]).superRefine((condition, ctx) => {
  if (condition.type !== 'layout' && !Object.hasOwn(condition, 'value')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: 'value is required for this condition type',
    });
  }
});

const inputCoordinateSchema = z.number().finite().min(0).max(100_000);
const inputActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('click'),
    x: inputCoordinateSchema,
    y: inputCoordinateSchema,
    button: z.enum(['left', 'right', 'middle']).optional().default('left'),
    clickCount: z.union([z.literal(1), z.literal(2)]).optional().default(1),
  }),
  z.object({
    type: z.literal('touch'),
    x: inputCoordinateSchema,
    y: inputCoordinateSchema,
    gesture: z.enum(['tap', 'longPress', 'swipe']),
    endX: inputCoordinateSchema.optional(),
    endY: inputCoordinateSchema.optional(),
  }),
  z.object({
    type: z.literal('key'),
    key: z.string().min(1).max(100).describe('A key name (Enter, Escape, Space, ArrowLeft, Tab, Backspace, F1-F24...) or one character ("a", ".", "!"); characters get the US-layout code and keyCode'),
    modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).max(4).optional().default([]),
  }),
  z.object({
    type: z.literal('type'),
    text: z.string().min(1).max(1_000),
    mode: z.enum(['keys', 'insertText']).optional().default('keys')
      .describe('"keys" (default): a key press per character, with US-layout key codes, as a game reading the keyboard expects; "insertText": insert the text at once into the focused field, without key events'),
  }),
  z.object({
    type: z.literal('mouseMove'),
    x: inputCoordinateSchema,
    y: inputCoordinateSchema,
  }),
]).superRefine((action, ctx) => {
  if (action.type === 'touch' && action.gesture === 'swipe'
    && (action.endX === undefined || action.endY === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endX'],
      message: 'swipe gestures require endX and endY',
    });
  }
});

const BRIDGE_FILENAME = 'c3-runtime-bridge.js';

interface RuntimeToolDeps {
  server: McpServer;
  reader: Construct3ProjectReader;
  writer: Construct3ProjectWriter;
}

/**
 * Script files are listed in project.c3proj under rootFileFolders.script
 * (items and nested subfolders), each with "script-info": { purpose }, where
 * the purpose is "main", "imports-for-events" or "none" (as the editor saves
 * them). Construct loads the main script on its own and nothing else; other
 * scripts run only when imported (manual, "Script files"). The bridge is
 * therefore imported by the project's main script, or registered as the
 * main script of a project that has none.
 */
interface ScriptFolder {
  items?: Array<Record<string, unknown>>;
  subfolders?: ScriptFolder[];
  name?: string;
}

/** The comment that marks the import line inject_runtime_bridge adds, so removal takes out exactly that line. */
const BRIDGE_IMPORT_MARKER = '// construct3-mcp runtime bridge (remove_runtime_bridge removes this line)';

function scriptPurpose(item: Record<string, unknown>): unknown {
  const info = (item['script-info'] ?? item['file-info']) as { purpose?: unknown } | undefined;
  return info?.purpose;
}

/** The project's main script other than the bridge: its path under scripts/ ("main.js", "game/main.ts"). */
function findMainScript(folder: ScriptFolder | undefined, prefix = '', depth = 0): string | undefined {
  if (!folder || depth > 32) return undefined;
  for (const item of Array.isArray(folder.items) ? folder.items : []) {
    if (item?.name !== BRIDGE_FILENAME && typeof item?.name === 'string' && scriptPurpose(item) === 'main') return prefix + item.name;
  }
  for (const sub of Array.isArray(folder.subfolders) ? folder.subfolders : []) {
    if (typeof sub?.name !== 'string') continue;
    const found = findMainScript(sub, `${prefix}${sub.name}/`, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** How many bridge entries the script folders hold. */
function countBridgeEntries(folder: ScriptFolder | undefined, depth = 0): number {
  if (!folder || depth > 32) return 0;
  let count = Array.isArray(folder.items) ? folder.items.filter((item) => item?.name === BRIDGE_FILENAME).length : 0;
  for (const sub of Array.isArray(folder.subfolders) ? folder.subfolders : []) count += countBridgeEntries(sub, depth + 1);
  return count;
}

/** Remove every bridge entry from the script folders; returns those removed. */
function takeBridgeEntries(folder: ScriptFolder | undefined, depth = 0): Array<Record<string, unknown>> {
  if (!folder || depth > 32) return [];
  const taken: Array<Record<string, unknown>> = [];
  if (Array.isArray(folder.items)) {
    taken.push(...folder.items.filter((item) => item?.name === BRIDGE_FILENAME));
    folder.items = folder.items.filter((item) => item?.name !== BRIDGE_FILENAME);
  }
  for (const sub of Array.isArray(folder.subfolders) ? folder.subfolders : []) taken.push(...takeBridgeEntries(sub, depth + 1));
  return taken;
}

type BridgeLoading = 'main' | 'import' | 'classic';

interface BridgeInstall {
  /** How Construct loads the bridge: as the main script, imported by the main script, or (classic scripts) listed. */
  loadedAs: BridgeLoading;
  /** The main script that imports the bridge, relative to scripts/. */
  mainScript?: string;
  /** Whether project.c3proj was changed. */
  registered: boolean;
  /** Whether the import line was added to the main script. */
  importAdded: boolean;
}

/** The main script's file, checked to stay inside the project's scripts folder. */
function mainScriptFile(projectDir: string, mainScript: string): string {
  return resolveProjectPath(projectDir, 'scripts', ...mainScript.split('/'));
}

const BRIDGE_FILE_PATTERN = BRIDGE_FILENAME.replace(/[.]/gu, '\\.');
/** A script that already imports the bridge, in whatever form. */
const BRIDGE_IMPORT_LINE = new RegExp(`^[^\\S\\r\\n]*import\\s+["'][^"']*${BRIDGE_FILE_PATTERN}["'];?[^\\r\\n]*(?:\\r?\\n)?`, 'mu');
/**
 * A line that only imports the bridge for its effect: the marked line
 * inject_runtime_bridge writes, or the line v1.9.2's instructions had users
 * type (`import "./c3-runtime-bridge.js";`), with at most a comment after it.
 */
const BRIDGE_IMPORT_ONLY_LINES = new RegExp(`^[^\\S\\r\\n]*import\\s*["'][^"'\\r\\n]*${BRIDGE_FILE_PATTERN}["'][^\\S\\r\\n]*;?[^\\S\\r\\n]*(?:\\/\\/[^\\r\\n]*)?(?:\\r?\\n|$)`, 'gmu');
/** Any other use of the bridge file in a script: `import x from`, `export ... from`, `import(...)`. */
const BRIDGE_REFERENCE = new RegExp(`(?:\\bfrom|\\bimport)\\s*\\(?\\s*["'][^"'\\r\\n]*${BRIDGE_FILE_PATTERN}["']`, 'u');

/** Add `import "<...>/c3-runtime-bridge.js";` as the first line of the main script, unless it imports the bridge already. */
async function addBridgeImport(projectDir: string, mainScript: string): Promise<boolean> {
  const file = mainScriptFile(projectDir, mainScript);
  const text = await readFile(file, 'utf-8');
  if (BRIDGE_IMPORT_LINE.test(text)) return false;
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? text.slice(1) : text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const depth = mainScript.split('/').length - 1;
  const specifier = `${depth === 0 ? './' : '../'.repeat(depth)}${BRIDGE_FILENAME}`;
  await writeFile(file, `${bom}import "${specifier}"; ${BRIDGE_IMPORT_MARKER}${eol}${body}`, 'utf-8');
  return true;
}

/** Script files under scripts/ (paths relative to it, with "/"), except the bridge itself. */
async function scriptFiles(scriptsDir: string, prefix = '', depth = 0): Promise<string[]> {
  if (depth > 32) return [];
  let entries;
  try {
    entries = await readdir(prefix ? join(scriptsDir, ...prefix.split('/')) : scriptsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await scriptFiles(scriptsDir, path, depth + 1));
    else if (entry.isFile() && /\.(?:m?js|ts)$/iu.test(entry.name) && path !== BRIDGE_FILENAME) found.push(path);
  }
  return found;
}

/**
 * The scripts that import the bridge, with their text once those import
 * lines are gone (byte order mark and line endings kept). Throws, before
 * anything is written, when a script uses the bridge in a way that cannot
 * be taken out line by line: after the bridge file is deleted, that script
 * would import a file that no longer exists and the game would not load.
 */
async function planImportRemoval(projectDir: string): Promise<Array<{ path: string; file: string; text: string }>> {
  const scriptsDir = join(projectDir, 'scripts');
  const changes: Array<{ path: string; file: string; text: string }> = [];
  const blocking: string[] = [];
  for (const path of await scriptFiles(scriptsDir)) {
    const file = resolveProjectPath(projectDir, 'scripts', ...path.split('/'));
    let text: string;
    try {
      text = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    if (!text.includes(BRIDGE_FILENAME)) continue;
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    const without = bom + text.slice(bom.length).replace(BRIDGE_IMPORT_ONLY_LINES, '');
    if (BRIDGE_REFERENCE.test(without)) blocking.push(`scripts/${path}`);
    else if (without !== text) changes.push({ path, file, text: without });
  }
  if (blocking.length > 0) {
    throw new Error(`Nothing was changed: ${blocking.join(', ')} ${blocking.length === 1 ? 'uses' : 'use'} the bridge in a way remove_runtime_bridge cannot take out (only a line that just imports it, such as the one inject_runtime_bridge adds, is removed). Without the bridge file the game would not load. Remove that use of ${BRIDGE_FILENAME}, then call remove_runtime_bridge again.`);
  }
  return changes;
}

/**
 * Write the bridge script into `projectDir` and register it so Construct
 * loads it: imported by the main script, or as the main script when the
 * project has none. A registration an earlier version wrote (a
 * "file-info" entry with purpose none, which nothing loaded) is replaced.
 */
async function installBridge(projectDir: string, c3projPath: string): Promise<BridgeInstall> {
  const bridgePath = join(projectDir, getBridgeScriptPath());
  await mkdir(dirname(bridgePath), { recursive: true });
  await writeFile(bridgePath, generateBridgeScript(), 'utf-8');

  const raw = await readFile(c3projPath, 'utf-8');
  const c3proj = parseJsonText(raw) as Record<string, unknown>;
  const folders = (c3proj.rootFileFolders ??= {}) as Record<string, ScriptFolder>;
  const scripts = (folders.script ??= { items: [], subfolders: [] });
  scripts.items ??= [];
  scripts.subfolders ??= [];

  const mainScript = findMainScript(scripts);
  // The scripts type is a project property ("module" or "classic"); a classic
  // script cannot hold an import statement.
  const scriptsType = (c3proj.properties as { scriptsType?: unknown } | undefined)?.scriptsType;
  const loadedAs: BridgeLoading = scriptsType === 'classic' ? 'classic' : mainScript ? 'import' : 'main';
  const purpose = loadedAs === 'main' ? 'main' : 'none';

  const entryFor = (earlier: Record<string, unknown> | undefined) => ({
    name: BRIDGE_FILENAME,
    type: 'application/javascript',
    sid: typeof earlier?.sid === 'number'
      ? earlier.sid
      : Math.floor(Math.random() * 900_000_000_000_000) + 100_000_000_000_000,
    'script-info': { purpose },
  });
  const rootIndex = scripts.items.findIndex(item => item?.name === BRIDGE_FILENAME);
  if (rootIndex >= 0 && countBridgeEntries(scripts) === 1) {
    // The one entry stays where it is (the editor keeps the order it was
    // given); only an outdated one ("file-info", another purpose) is replaced.
    const current = scripts.items[rootIndex];
    const upToDate = current['file-info'] === undefined
      && (current['script-info'] as { purpose?: unknown } | undefined)?.purpose === purpose;
    if (!upToDate) scripts.items[rootIndex] = entryFor(current);
  } else {
    const existing = takeBridgeEntries(scripts);
    scripts.items.push(entryFor(existing[0]));
  }
  // Written only when something changed, so a repeated call leaves the file as it was.
  const text = serializeJson(c3proj, jsonTextStyleOf(raw));
  const registered = text !== raw;
  if (registered) await writeFile(c3projPath, text, 'utf-8');

  const importAdded = loadedAs === 'import' ? await addBridgeImport(projectDir, mainScript!) : false;
  return { loadedAs, mainScript: loadedAs === 'import' ? mainScript : undefined, registered, importAdded };
}

/**
 * Take the bridge out again: the lines importing it (the marked line
 * inject_runtime_bridge added, or one typed by hand), its entry, its file.
 * Refuses before writing anything while a script uses the bridge otherwise.
 */
async function uninstallBridge(projectDir: string, c3projPath: string): Promise<{ entries: number; importRemoved: boolean; scriptsChanged: string[] }> {
  const imports = await planImportRemoval(projectDir);
  const raw = await readFile(c3projPath, 'utf-8');
  const c3proj = parseJsonText(raw) as Record<string, unknown>;
  const scripts = (c3proj.rootFileFolders as Record<string, ScriptFolder> | undefined)?.script;
  for (const change of imports) await writeFile(change.file, change.text, 'utf-8');
  const entries = takeBridgeEntries(scripts).length;
  if (entries > 0) await writeFile(c3projPath, serializeJson(c3proj, jsonTextStyleOf(raw)), 'utf-8');
  try {
    await unlink(join(projectDir, getBridgeScriptPath()));
  } catch {
    // no bridge file
  }
  return { entries, importRemoved: imports.length > 0, scriptsChanged: imports.map(change => change.path) };
}

/** The result fields that say how the bridge was installed, as inject_runtime_bridge reports them. */
function installFields(install: BridgeInstall): Record<string, unknown> {
  return {
    loadedAs: install.loadedAs,
    ...(install.mainScript ? { mainScript: install.mainScript, importAdded: install.importAdded } : {}),
  };
}

function loadingMessage(install: BridgeInstall): string {
  if (install.loadedAs === 'main') {
    return 'The bridge is registered as the project\'s main script (it had none), so Construct loads it on startup.';
  }
  if (install.loadedAs === 'import') {
    return `The bridge is imported by the main script scripts/${install.mainScript}, so Construct loads it on startup.`;
  }
  return 'The project uses classic scripts, where imports are not available; the bridge is listed with purpose none. Loading it that way is not verified: switch the project to module scripts if the bridge does not start.';
}

export function registerRuntimeTools({ server, reader, writer }: RuntimeToolDeps): RuntimeToolController {
  const connections = new RuntimeConnectionManager();
  const previews = new PreviewManager();

  // ── inject_runtime_bridge ─────────────────────────────────

  server.tool(
    'inject_runtime_bridge',
    'Add the runtime bridge script (scripts/c3-runtime-bridge.js) to the project so the running game exposes globalThis.__c3bridge to connect_to_game, call_bridge and the other runtime tools. Construct loads only the main script on its own, so the bridge is imported by the project\'s main script (one marked line at its top) or, in a project without one, registered as the main script. It starts through runOnStartup() and processes commands each tick, on the page or in the runtime\'s worker. remove_runtime_bridge undoes all of it.',
    {},
    async () => {
      try {
        const projectDir = reader.getProjectDir();
        const install = await installBridge(projectDir, reader.getProjectPath());
        await reader.loadProject();
        return toolResult({
          success: true,
          injected: true,
          path: join(projectDir, getBridgeScriptPath()),
          registered: install.registered,
          ...installFields(install),
          message: loadingMessage(install),
        }, { projectWritten: true });
      } catch (error) {
        console.error('[inject_runtime_bridge] failed:', error);
        return toolError(`Failed to inject runtime bridge: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── remove_runtime_bridge ─────────────────────────────────

  server.tool(
    'remove_runtime_bridge',
    'Remove the runtime bridge from the project: the script file, its entry in project.c3proj, and every line in the project\'s scripts that only imports it (the one inject_runtime_bridge added to the main script, or one typed by hand). Refuses, changing nothing, while a script uses the bridge in another way (such as `import * as b from`). Use this to clean up after testing.',
    {},
    async () => {
      try {
        const projectDir = reader.getProjectDir();
        const removed = await uninstallBridge(projectDir, reader.getProjectPath());
        await reader.loadProject();
        return toolResult({
          success: true,
          removed: true,
          entriesRemoved: removed.entries,
          importRemoved: removed.importRemoved,
          scriptsChanged: removed.scriptsChanged,
          message: 'Runtime bridge removed from project.',
        }, { projectWritten: true });
      } catch (error) {
        console.error('[remove_runtime_bridge] failed:', error);
        return toolError(`Failed to remove runtime bridge: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── get_bridge_commands ───────────────────────────────────

  server.tool(
    'get_bridge_commands',
    'List the commands the runtime bridge supports, with their arguments: what call_bridge can run in a game connected with connect_to_game.',
    {},
    async () => {
      const commands = {
        ping: {
          description: 'Health check — returns { pong: true, time: <timestamp> }',
          args: {},
        },
        callFunction: {
          description: 'Call a C3 event sheet function by name',
          args: { name: 'string (function name)', params: 'array (optional parameters)' },
        },
        getGlobalVar: {
          description: 'Read a global variable value',
          args: { name: 'string (variable name)' },
        },
        setGlobalVar: {
          description: 'Set a global variable value',
          args: { name: 'string (variable name)', value: 'any (new value)' },
        },
        getObjectState: {
          description: 'Read properties from the first instance of an object type (its instance variables come in _instVars)',
          args: {
            objectName: 'string (object type name; the argument is objectName, not objectType)',
            properties: 'string[] (optional — defaults to x, y, width, height, isVisible, opacity)',
          },
        },
        getAllInstances: {
          description: 'List all instances of an object type (position, uid, visibility)',
          args: { objectName: 'string', limit: 'number (default 50)' },
        },
        getLayout: {
          description: 'Get current layout info (name, size, layers)',
          args: {},
        },
        goToLayout: {
          description: 'Navigate to a different layout',
          args: { name: 'string (layout name)' },
        },
        evaluateExpression: {
          description: 'Read a plugin expression from an object instance',
          args: {
            objectName: 'string (object type name, e.g. "MyPlugin")',
            expression: 'string (property/expression name on the instance)',
          },
        },
        listObjects: {
          description: 'List all object type names in the runtime',
          args: {},
        },
        listGlobalVars: {
          description: 'List all global variables and their current values',
          args: {},
        },
        layerToCssPx: {
          description: 'Convert layout coordinates on a layer to CSS pixels in the page viewport, through the game\'s own transform (simulate_input uses it for coordinateSpace "layout")',
          args: { layer: 'string | number (layer name or index, default 0)', x: 'number', y: 'number' },
        },
        cssPxToLayer: {
          description: 'Convert CSS pixels in the page viewport to layout coordinates on a layer',
          args: { layer: 'string | number (layer name or index, default 0)', x: 'number', y: 'number' },
        },
        subscribeEvents: {
          description: 'Start buffering events (the subscribe_events tool wraps it)',
          args: {
            eventType: '"globalVarChange" | "layoutChange" | "custom"',
            filter: 'object ({ variable } for globalVarChange, optional { name } for custom)',
            bufferSize: 'number (1 to 1000, default 100)',
          },
        },
        readEvents: {
          description: 'Read a subscription\'s buffered events (the read_events tool wraps it)',
          args: { subscriptionId: 'string', clear: 'boolean (default true)' },
        },
        unsubscribeEvents: {
          description: 'Stop a subscription (the unsubscribe_events tool wraps it)',
          args: { subscriptionId: 'string' },
        },
      };

      return toolResult(commands);
    },
  );

  // ── connect_to_game ──────────────────────────────────────

  server.tool(
    'connect_to_game',
    'Connect to a running Construct game over Chrome DevTools Protocol. Provide a page WebSocket endpoint directly (serve_preview returns it as pageEndpoint), or a host and debugging port: then the browser\'s pages (narrowed by pageUrl and urlContains) are tried and the one whose runtime bridge answers ready is kept. When several pages have a ready bridge (two games, or another site that defines one), the call fails and lists them instead of guessing; name the game with pageUrl, urlContains or cdpEndpoint. The bridge is found on the page or, for a game with "Use worker" on, in the page\'s worker (bridgeContext). The tab is brought to the front; pageVisible false with a warning means it stayed hidden, where a game does not tick. The connection stays open for the other runtime tools. Only browsers on this machine are reached, unless the server was started with C3MCP_ALLOW_REMOTE_CDP=1.',
    {
      cdpEndpoint: z.string().url().refine(
        (value) => value.startsWith('ws://') || value.startsWith('wss://'),
        'cdpEndpoint must use ws:// or wss://',
      ).optional().describe('Direct CDP page WebSocket endpoint'),
      host: z.string().min(1).max(255).optional().describe('CDP discovery host (default: 127.0.0.1)'),
      port: z.number().int().min(1).max(65535).optional().describe('CDP discovery port (default: 9222)'),
      pageUrl: z.string().url().max(2_000).optional()
        .describe('With host/port: only pages of this URL\'s origin whose path starts with its path (e.g. the url serve_preview returned, "http://127.0.0.1:53817/")'),
      urlContains: z.string().min(1).max(2_000).optional()
        .describe('With host/port: only pages whose origin and path (not query or fragment) contain this text (e.g. "localhost:8080" or "preview")'),
      timeoutMs: z.number().int().min(100).max(60_000).optional().default(10_000)
        .describe('Maximum time for the whole connection: discovery, opening and waiting for the runtime bridge'),
    },
    async ({ cdpEndpoint, host, port, pageUrl, urlContains, timeoutMs }) => {
      try {
        const allowRemoteHosts = process.env.C3MCP_ALLOW_REMOTE_CDP === '1';
        const target = cdpEndpoint !== undefined ? hostOfEndpoint(cdpEndpoint) : (host ?? '127.0.0.1');
        if (!allowRemoteHosts && !isLoopbackHost(target)) {
          return toolError(`Refusing to connect to "${target}": only this machine (localhost, 127.0.0.1, ::1) is allowed unless the server was started with the environment variable C3MCP_ALLOW_REMOTE_CDP=1. The runtime bridge runs script in whatever page it reaches.`);
        }
        const connected = await connections.connect({ cdpEndpoint, host, port, pageUrl, urlContains, allowRemoteHosts, timeoutMs });
        return toolResult(connected, { projectWritten: false });
      } catch (error) {
        console.error('[connect_to_game] failed:', error);
        return toolError(`Failed to connect to game: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── disconnect_from_game ─────────────────────────────────

  server.tool(
    'disconnect_from_game',
    'Close a persistent game connection created by connect_to_game.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
    },
    async ({ connectionId }) => {
      try {
        const stopped = await connections.disconnect(connectionId);
        if (!stopped) return toolError(`Unknown or closed connection: ${connectionId}`);
        return toolResult({ connectionId, disconnected: true }, { projectWritten: false });
      } catch (error) {
        console.error('[disconnect_from_game] failed:', error);
        return toolError(`Failed to disconnect from game: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── call_bridge ──────────────────────────────────────────

  server.tool(
    'call_bridge',
    'Execute a command through the injected Construct runtime bridge using a persistent CDP connection. The tool submits the command, polls for its result, and returns the command ID, value, and elapsed time.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
      command: z.enum(BRIDGE_COMMANDS).describe('Runtime bridge command to execute'),
      args: boundedRecord().optional().describe('Command-specific arguments (max 100 keys, depth 6)'),
      pollIntervalMs: z.number().int().min(10).max(1_000).optional().default(50)
        .describe('Delay between bridge result polls'),
      timeoutMs: z.number().int().min(100).max(60_000).optional().default(5_000)
        .describe('Maximum time for the bridge command'),
    },
    async ({ connectionId, command, args, pollIntervalMs, timeoutMs }) => {
      try {
        const result = await connections.callBridge({
          connectionId,
          command,
          args: args ?? {},
          pollIntervalMs,
          timeoutMs,
        });
        return toolResult(result, { projectWritten: false });
      } catch (error) {
        console.error('[call_bridge] failed:', error);
        return toolError(`Failed to call runtime bridge: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // -- subscribe_events / read_events / unsubscribe_events --

  // The bridge answers a bad subscription id with { error } rather than throwing; that is a failure here.
  const subscriptionCall = async (connectionId: string, command: string, args: Record<string, unknown>) => {
    const result = (await connections.callBridge({ connectionId, command, args, pollIntervalMs: 50, timeoutMs: 5_000 })).result as Record<string, unknown> | null;
    if (result && typeof result.error === 'string') throw new Error(result.error);
    return result ?? {};
  };

  server.tool(
    'subscribe_events',
    'Start observing a running game through its bridge: changes of one global variable, changes of the current layout, or custom events the game\'s script emits with globalThis.__c3bridge.emit(name, data). Events go into a bounded per-subscription buffer (oldest dropped when full) read by read_events, so a test can see what happened between polls.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
      eventType: z.enum(['globalVarChange', 'layoutChange', 'custom']).describe('What to observe'),
      filter: z.object({
        variable: z.string().min(1).max(200).optional().describe('For globalVarChange: the global variable to watch (required)'),
        name: z.string().min(1).max(200).optional().describe('For custom: only events emitted with this name (default: every custom event)'),
      }).strict().optional().describe('What to filter on, by event type'),
      bufferSize: z.number().int().min(1).max(1_000).optional().default(100).describe('Events kept per subscription; the oldest is dropped when full (default 100)'),
    },
    async ({ connectionId, eventType, filter, bufferSize }) => {
      try {
        if (eventType === 'globalVarChange' && !filter?.variable) {
          return toolError('subscribe_events with eventType "globalVarChange" needs filter.variable, the global variable to watch.');
        }
        const result = await subscriptionCall(connectionId, 'subscribeEvents', { eventType, filter: filter ?? {}, bufferSize });
        return toolResult({ subscriptionId: result.subscriptionId, eventType, filter: filter ?? {}, bufferSize }, { projectWritten: false });
      } catch (error) {
        console.error('[subscribe_events] failed:', error);
        return toolError(`Failed to subscribe: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    'read_events',
    'Read the events a subscription buffered since the last read, oldest first: { type, name, value, previousValue (global and layout changes), timestamp, tick }. Clears the buffer unless clear is false.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
      subscriptionId: z.string().min(1).max(100).describe('The subscriptionId returned by subscribe_events'),
      clear: z.boolean().optional().default(true).describe('Empty the buffer after reading (default true); false leaves the events for a later read'),
    },
    async ({ connectionId, subscriptionId, clear }) => {
      try {
        const result = await subscriptionCall(connectionId, 'readEvents', { subscriptionId, clear });
        return toolResult({ events: result.events, count: result.count }, { projectWritten: false });
      } catch (error) {
        console.error('[read_events] failed:', error);
        return toolError(`Failed to read events: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    'unsubscribe_events',
    'Stop a subscription and release its buffer. An unknown subscription is an error, not a silent success.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
      subscriptionId: z.string().min(1).max(100).describe('The subscriptionId returned by subscribe_events'),
    },
    async ({ connectionId, subscriptionId }) => {
      try {
        const result = await subscriptionCall(connectionId, 'unsubscribeEvents', { subscriptionId });
        return toolResult({ subscriptionId: result.subscriptionId, unsubscribed: result.unsubscribed === true }, { projectWritten: false });
      } catch (error) {
        console.error('[unsubscribe_events] failed:', error);
        return toolError(`Failed to unsubscribe: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── wait_for_condition ───────────────────────────────────

  server.tool(
    'wait_for_condition',
    'Poll a running game until a global variable, object property, layout name, or browser expression matches a target. Checks immediately, returns the last value on timeout, and does not throw merely because the condition was not met. The "expression" type runs the given JavaScript in the game page with the page\'s full rights; it is refused unless the server was started with the environment variable C3MCP_ALLOW_EVAL=1.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
      condition: runtimeConditionSchema.describe('Condition to evaluate on each poll'),
      pollIntervalMs: z.number().int().min(10).max(5_000).optional().default(100)
        .describe('Delay between condition checks'),
      timeoutMs: z.number().int().min(100).max(120_000).optional().default(30_000)
        .describe('Maximum time to wait before returning met: false'),
    },
    async ({ connectionId, condition, pollIntervalMs, timeoutMs }) => {
      try {
        const result = await connections.waitForCondition({
          connectionId,
          condition: condition as RuntimeCondition,
          pollIntervalMs,
          timeoutMs,
        });
        return toolResult({
          met: result.met,
          elapsedMs: result.elapsedMs,
          finalValue: result.finalValue,
        }, { projectWritten: false });
      } catch (error) {
        console.error('[wait_for_condition] failed:', error);
        return toolError(`Failed to wait for condition: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── simulate_input ───────────────────────────────────────

  server.tool(
    'simulate_input',
    'Send mouse, touch, keyboard, or text input to a connected game through the Chrome DevTools Protocol Input domain. Coordinates are CSS pixels relative to the page viewport by default; with coordinateSpace "canvas" they are CSS pixels relative to the game canvas top-left and are offset by the canvas position; with coordinateSpace "layout" they are layout coordinates on a layer, converted by the game itself (scaling, letterboxing and the canvas offset included) through the bridge. Use get_canvas_size to read the canvas geometry.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
      action: inputActionSchema.describe('Input action to dispatch'),
      delayMs: z.number().int().min(0).max(60_000).optional().default(0)
        .describe('Delay before dispatching the input action'),
      coordinateSpace: z.enum(['viewport', 'canvas', 'layout']).optional().default('viewport')
        .describe('Whether x/y (and endX/endY) are page-viewport CSS pixels, game-canvas CSS pixels, or layout coordinates on a layer'),
      layer: z.union([z.string().max(200), z.number().int().min(0)]).optional()
        .describe('For coordinateSpace "layout": the layer name or index whose coordinates x/y are in (default: layer 0)'),
    },
    async ({ connectionId, action, delayMs, coordinateSpace, layer }) => {
      try {
        const result = await connections.simulateInput({
          connectionId,
          action: action as SimulatedInputAction,
          delayMs,
          coordinateSpace,
          layer,
        });
        return toolResult(result, { projectWritten: false });
      } catch (error) {
        console.error('[simulate_input] failed:', error);
        return toolError(`Failed to simulate input: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── get_canvas_size ──────────────────────────────────────

  server.tool(
    'get_canvas_size',
    'Read the connected game canvas geometry: its CSS-pixel position and size in the page viewport, its backing-store pixel size, the device pixel ratio, and the viewport size. Use it to choose coordinates for simulate_input.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
    },
    async ({ connectionId }) => {
      try {
        return toolResult(await connections.getCanvasGeometry(connectionId), { projectWritten: false });
      } catch (error) {
        console.error('[get_canvas_size] failed:', error);
        return toolError(`Failed to read canvas size: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── screenshot_game ──────────────────────────────────────

  server.tool(
    'screenshot_game',
    'Capture the connected game page, or only its canvas, as a PNG or JPEG file on disk, so a run can keep visual evidence of a state without an editor or a browser tool. The file goes to an absolute path outside the open project, ends in .png (or .jpg/.jpeg for jpeg), and an existing file is replaced only with overwrite: true.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
      outputPath: z.string().min(1).max(4096).describe('Absolute path of the image file to write, outside the project folder (e.g. "C:/runs/after-click.png"); missing folders are created'),
      format: z.enum(['png', 'jpeg']).optional().default('png').describe('Image format (default: png)'),
      quality: z.number().int().min(0).max(100).optional().describe('JPEG quality 0-100 (jpeg only)'),
      canvasOnly: z.boolean().optional().default(false).describe('Capture only the game canvas rectangle (default: the whole viewport)'),
      overwrite: z.boolean().optional().default(false).describe('Replace outputPath if the file exists (default: false, an existing file is an error)'),
      timeoutMs: z.number().int().min(1_000).max(120_000).optional().default(30_000).describe('How long the capture may take (default 30000; a large canvas takes seconds)'),
    },
    async ({ connectionId, outputPath, format, quality, canvasOnly, overwrite, timeoutMs }) => {
      try {
        await checkScreenshotTarget(outputPath, format, overwrite, reader.getProjectDir());
        const shot = await connections.captureScreenshot({ connectionId, format, quality, canvasOnly, timeoutMs });
        await mkdir(dirname(outputPath), { recursive: true });
        // 'wx' fails rather than replace a file that appeared meanwhile.
        await writeFile(outputPath, shot.data, { flag: overwrite ? 'w' : 'wx' });
        return toolResult({ success: true, path: outputPath, bytes: shot.data.length, format: shot.format, clip: shot.clip }, { projectWritten: false });
      } catch (error) {
        console.error('[screenshot_game] failed:', error);
        return toolError(`Failed to capture a screenshot: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── serve_preview / stop_preview ─────────────────────────

  // Registered with a strict schema: the listening interface and the browser
  // executable are the operator's settings, so a call that names them (as the
  // first version of this tool allowed) is refused instead of silently
  // ignored.
  server.registerTool(
    'serve_preview',
    {
      description: 'Serve an exported Construct game (the HTML5 export folder that holds index.html) over HTTP on this machine (127.0.0.1 only), and optionally launch Chrome or Edge on it with a fresh profile and a remote-debugging port the browser picks itself, so connect_to_game can follow (the result names the port and the page endpoint). The browser comes from the CHROME_PATH environment variable or the usual install locations. A source project folder or a .c3p is refused: Construct exports only from its editor.',
      inputSchema: z.object({
        folder: z.string().min(1).max(4096).describe('The exported game folder (contains index.html)'),
        port: z.number().int().min(0).max(65535).optional().default(0).describe('HTTP port on 127.0.0.1 (default 0: any free port; a port another program answers on is refused)'),
        crossOriginIsolated: z.boolean().optional().default(false).describe('Send COOP same-origin and COEP require-corp so the game gets SharedArrayBuffer (default: false; require-corp blocks resources from other origins that do not allow it, such as a CDN script)'),
        launchBrowser: z.boolean().optional().default(false).describe('Launch Chrome (or Edge) on the served URL with a remote-debugging port (default: false)'),
        headless: z.boolean().optional().default(false).describe('Launch the browser headless with software WebGL (default: false, a visible window)'),
        windowWidth: z.number().int().min(100).max(10_000).optional().describe('Browser window width in pixels'),
        windowHeight: z.number().int().min(100).max(10_000).optional().describe('Browser window height in pixels'),
        readyTimeoutMs: z.number().int().min(1000).max(120_000).optional().default(15_000).describe('How long to wait for the browser\'s debugging port (default: 15000)'),
      }).strict(),
    },
    async (args) => {
      try {
        const info = await previews.serve({
          folder: args.folder,
          port: args.port,
          crossOriginIsolated: args.crossOriginIsolated,
          launch: args.launchBrowser ? {
            headless: args.headless,
            windowWidth: args.windowWidth,
            windowHeight: args.windowHeight,
            readyTimeoutMs: args.readyTimeoutMs,
          } : undefined,
        });
        return toolResult({
          success: true,
          ...info,
          next: info.browser
            ? `connect_to_game with ${info.browser.pageEndpoint ? `cdpEndpoint "${info.browser.pageEndpoint}"` : `host "127.0.0.1", port ${info.browser.cdpPort} and pageUrl "${info.url}"`}; the game must carry the runtime bridge (inject_runtime_bridge before the export).`
            : `Open ${info.url} in a browser started with --remote-debugging-port, then connect_to_game with that port and pageUrl "${info.url}"; or call again with launchBrowser: true.`,
        }, { projectWritten: false });
      } catch (error) {
        console.error('[serve_preview] failed:', error);
        return toolError(`Failed to serve the preview: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    'stop_preview',
    'Stop a preview server started by serve_preview, closing the browser it launched. Without serverId, stops every preview server this MCP server holds.',
    {
      serverId: z.string().uuid().optional().describe('The serverId returned by serve_preview (default: all)'),
    },
    async ({ serverId }) => {
      try {
        if (serverId === undefined) {
          const stopped = previews.list();
          await previews.closeAll();
          return toolResult({ success: true, stopped }, { projectWritten: false });
        }
        const stopped = await previews.stop(serverId);
        return toolResult({ success: true, stopped: [stopped] }, { projectWritten: false });
      } catch (error) {
        console.error('[stop_preview] failed:', error);
        return toolError(`Failed to stop the preview: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── generate_bridge_eval_script ───────────────────────────

  server.tool(
    'generate_bridge_eval_script',
    'Generate a shell command (using curl or python) to execute a bridge command in the running C3 game. The command interacts with the game via the browser remote debugging protocol.',
    {
      command: z.string().describe('Bridge command type (e.g. "callFunction", "getGlobalVar", "getObjectState")'),
      args: boundedRecord().optional().describe('Command arguments as key-value pairs (max 100 keys, depth 6)'),
    },
    async ({ command, args }) => {
      const bridgeCmd = JSON.stringify({ type: command, args: args ?? {} });

      // Generate a Python script that:
      // 1. Connects to Firefox CDP on localhost:9222
      // 2. Submits a command to __c3bridge
      // 3. Polls for the result
      const pythonScript = `
import json, time

# Submit command via __c3bridge
BRIDGE_CMD = ${JSON.stringify(bridgeCmd)}

# JavaScript to run in the browser
js_submit = f"""
(function() {{
  if (!globalThis.__c3bridge) return JSON.stringify({{error: "bridge not loaded"}});
  const id = globalThis.__c3bridge.submit({BRIDGE_CMD}.type, {BRIDGE_CMD}.args);
  return JSON.stringify({{id: id}});
}})()
"""

js_poll = """
(function(id) {
  if (!globalThis.__c3bridge) return JSON.stringify({error: "bridge not loaded"});
  const r = globalThis.__c3bridge.getResult(id);
  return r ? JSON.stringify(r) : JSON.stringify({pending: true});
})(%d)
"""

# Run this script in any environment with access to the browser CDP endpoint.
# Start Firefox/Chrome with: --remote-debugging-port=9222
# The actual CDP communication depends on the runtime bridge setup.
print(json.dumps({
  "js_submit": js_submit.strip(),
  "js_poll_template": js_poll.strip(),
  "bridge_command": json.loads(BRIDGE_CMD),
  "usage": "Execute js_submit in the browser console, get the returned id, then execute js_poll with that id"
}))
`.trim();

      return toolResult({
        command,
        args: args ?? {},
        pythonScript,
        manualUsage: {
          step1: `In Firefox DevTools console: globalThis.__c3bridge.submit("${command}", ${JSON.stringify(args ?? {})})`,
          step2: 'Note the returned ID (e.g., 1)',
          step3: 'globalThis.__c3bridge.getResult(1)',
        },
      });
    },
  );

  // ── export_for_preview ────────────────────────────────────

  server.tool(
    'export_for_preview',
    'Prepare the C3 project for runtime testing: injects the runtime bridge (unless injectBridge is false), reports where the runtime will run ("Use worker"; the bridge is reached on the page and in the worker alike) and lists the next steps: preview in the editor or export, serve_preview, connect_to_game.',
    {
      injectBridge: z.boolean().optional().default(true).describe('Whether to inject the runtime bridge script'),
    },
    async ({ injectBridge }) => {
      try {
        const projectDir = reader.getProjectDir();
        const metadata = reader.getMetadata();
        const projectData = reader.getProject();

        const checks: Array<{ check: string; status: string; detail?: string }> = [];

        // Where the runtime (and with it the bridge) runs. connect_to_game
        // reaches the bridge on the page and in the runtime's worker, so no
        // setting is required. "Auto" turns the worker off when the project
        // uses scripts (manual, "Projects" > "Use worker"), which it does
        // once the bridge is injected.
        // Stored as "auto", "dom" (No) or "worker" (Yes); older files hold a boolean.
        const useWorker: unknown = projectData.useWorker ?? 'auto';
        const runsInWorker = useWorker === 'worker' || useWorker === 'yes' || useWorker === true;
        const runsOnPage = useWorker === 'dom' || useWorker === 'no' || useWorker === false;
        checks.push({
          check: 'workerMode',
          status: 'ok',
          detail: runsOnPage
            ? `useWorker is ${JSON.stringify(useWorker)}: the runtime and the bridge run on the page.`
            : runsInWorker
              ? `useWorker is ${JSON.stringify(useWorker)}: the runtime and the bridge run in a worker; connect_to_game reaches the bridge there (bridgeContext "worker"), input and screenshots go to the page.`
              : `useWorker is ${JSON.stringify(useWorker)}: Construct turns the worker off when the project uses scripts, which it does with the bridge injected, so the runtime runs on the page; without scripts it would run in a worker, which connect_to_game reaches as well.`,
        });

        // Inject bridge if requested
        let install: BridgeInstall | undefined;
        if (injectBridge) {
          install = await installBridge(projectDir, reader.getProjectPath());
          await reader.loadProject();
          checks.push({ check: 'runtimeBridge', status: install.loadedAs === 'classic' ? 'warning' : 'ok', detail: loadingMessage(install) });
        }

        return toolResult({
          success: true,
          projectName: metadata.name,
          projectDir,
          runtime: projectData.runtime ?? 'c3',
          useWorker,
          ...(install ? installFields(install) : {}),
          checks,
          nextSteps: [
            'Reload the project in the Construct editor, then either preview it in a browser started with --remote-debugging-port, or export it (Menu > Project > Export > Web (HTML5)) and serve the exported folder with serve_preview (launchBrowser: true)',
            'connect_to_game with the cdpEndpoint serve_preview names, or with the host and debugging port of the browser running the preview',
            'Drive and observe the game with call_bridge, wait_for_condition, subscribe_events, simulate_input and screenshot_game; stop_preview and disconnect_from_game when done',
            'remove_runtime_bridge before shipping the project',
          ],
        }, { projectWritten: injectBridge });
      } catch (error) {
        console.error('[export_for_preview] failed:', error);
        return toolError(`Failed to prepare for preview: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── clone_project ─────────────────────────────────────────

  server.tool(
    'clone_project',
    'Clone the current C3 project to a new directory. Useful for creating test copies without modifying the original.',
    {
      targetDir: z.string().describe('Target directory for the cloned project'),
      includeBridge: z.boolean().optional().default(true).describe('Include the runtime bridge in the clone'),
    },
    async ({ targetDir, includeBridge }) => {
      try {
        const sourceDir = reader.getProjectDir();
        const { cp } = await import('node:fs/promises');

        await cp(sourceDir, targetDir, { recursive: true });

        if (includeBridge) {
          // Register the bridge in the cloned project, the same way as in the open one
          const c3projFiles = (await readdir(targetDir)).filter(f => f.endsWith('.c3proj'));
          if (c3projFiles.length > 0) {
            await installBridge(targetDir, join(targetDir, c3projFiles[0]));
          }
        }

        // Only the new copy was written, not the open project
        return toolResult({
          success: true,
          cloned: true,
          source: sourceDir,
          target: targetDir,
          bridgeIncluded: includeBridge,
        }, { projectWritten: false });
      } catch (error) {
        console.error('[clone_project] failed:', error);
        return toolError(`Failed to clone project: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── pack_project ──────────────────────────────────────────

  server.tool(
    'pack_project',
    'Pack the C3 project folder into a .c3p file (zip archive) that the Construct 3 editor opens. Unless injectBridge is false, it first adds the runtime bridge to the project itself, as inject_runtime_bridge does (the bridge file, its entry and a marked import line in the main script), so the game in the .c3p loads the bridge; the result says how (loadedAs) and warns. Pass injectBridge false to pack the project as it is, for instance to ship it.',
    {
      outputPath: z.string().describe('Output path for the .c3p file (e.g. "/tmp/game.c3p")'),
      injectBridge: z.boolean().optional().default(true).describe('Add the runtime bridge to the project before packing (default true; it changes the project folder too, see inject_runtime_bridge)'),
    },
    async ({ outputPath, injectBridge }) => {
      try {
        const projectDir = reader.getProjectDir();

        // Optionally inject bridge first
        let install: BridgeInstall | undefined;
        if (injectBridge) {
          install = await installBridge(projectDir, reader.getProjectPath());
          await reader.loadProject();
        }

        // Collect all project files
        const files = await collectFiles(projectDir);

        // Build the zip using Node.js built-in zlib
        // .c3p format is a standard zip file
        await buildZip(projectDir, files, outputPath);

        const outputStat = await stat(outputPath);

        // The .c3p goes outside the project; only bridge injection writes to it
        return toolResult({
          success: true,
          packed: true,
          outputPath,
          fileCount: files.length,
          sizeBytes: outputStat.size,
          sizeMB: (outputStat.size / 1024 / 1024).toFixed(2),
          bridgeInjected: injectBridge,
          ...(install ? {
            ...installFields(install),
            warning: `The packed game loads the runtime bridge (${loadingMessage(install)}) and exposes globalThis.__c3bridge. The project folder has the bridge now as well${install.importAdded ? `, and scripts/${install.mainScript} starts with its import line` : ''}. Before shipping, call remove_runtime_bridge and pack again with injectBridge false.`,
          } : {}),
        }, { projectWritten: injectBridge });
      } catch (error) {
        console.error('[pack_project] failed:', error);
        return toolError(`Failed to pack project: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  return {
    close: async () => {
      await connections.closeAll();
      await previews.closeAll();
    },
  };
}


// ── File helpers ──────────────────────────────────────────

/** Directories to skip when packing a C3 project. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.bak', '__MACOSX']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * Recursively collect all files in a directory, returning paths relative
 * to the root. Skips .git, node_modules, backups, and OS junk.
 */
async function collectFiles(rootDir: string, subDir = ''): Promise<string[]> {
  const results: string[] = [];
  const fullDir = subDir ? join(rootDir, subDir) : rootDir;
  const entries = await readdir(fullDir, { withFileTypes: true });

  for (const entry of entries) {
    if (SKIP_FILES.has(entry.name)) continue;
    const relPath = subDir ? `${subDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const subFiles = await collectFiles(rootDir, relPath);
      results.push(...subFiles);
    } else if (entry.isFile()) {
      // Skip .bak files from the writer's backup system
      if (entry.name.endsWith('.bak')) continue;
      results.push(relPath);
    }
  }

  return results;
}

/**
 * Build a .c3p (ZIP) file from a project directory.
 */
async function buildZip(projectDir: string, files: string[], outputPath: string): Promise<void> {
  const entries = await Promise.all(
    files.map(async (filePath) => ({
      path: filePath.replace(/\\/g, '/'), // ensure forward slashes in zip
      data: await readFile(join(projectDir, filePath)),
    })),
  );
  await writeZip(entries, outputPath);
}
