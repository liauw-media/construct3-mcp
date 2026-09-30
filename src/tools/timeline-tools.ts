/**
 * Timeline tools: create_timeline, update_timeline, delete_timeline,
 * list_timelines, get_timeline_details.
 *
 * The project.c3proj timelines container tracks their names. Construct 3
 * mirrors its project-bar folders on disk: a timeline at the root is stored
 * in timelines/<name>.json, one in folder "A" > "B" in
 * timelines/A/B/<name>.json. The container's first-level subfolder without a
 * name is the editor's Transitions folder (see timeline-folders.ts): its items
 * are transitions (easing curves that timelines reference by name), stored in
 * timelines/transitions/<name>.json. A nameless folder anywhere else is
 * malformed: its names are not listed or resolved, and create_timeline
 * refuses them so they are not registered twice. The timeline tools list
 * transitions but never read, change or delete them.
 * JSON shape validated against real Construct 3 projects.
 */

import { z } from 'zod';
import { readFile, mkdir, copyFile, unlink, stat } from 'fs/promises';
import { dirname, relative, sep } from 'path';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult } from '../construct3/types.js';
import { newProjectFolder } from '../construct3/project-writer.js';
import { validateName, validateSubfolder, toolResult, toolError, folderCaseClashError } from './shared.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import { atomicReplace, existingSpelling, findFileIgnoringCase } from '../construct3/atomic-write.js';
import { findFolderPathClash, nameKey } from '../construct3/names.js';
import { jsonTextStyleOf, parseJsonText, resolveJsonTextStyle, serializeJson } from '../construct3/json-format.js';
import {
  TRANSITIONS_DIR,
  isNamelessFolder,
  transitionsFolderIndex,
  type ProjectFolderNode,
} from '../construct3/timeline-folders.js';
import { withProjectSync } from './project-sync.js';

// ─── Timeline Type ─────────────────────────────────────────

export interface Timeline {
  name: string;
  enabled: boolean;
  interpolationMode: string;
  resultMode: string;
  ease: string;
  pathMode: string;
  resizeMode: string;
  playheadTime: number;
  totalTime: number;
  stepTime: number;
  useStepTime: boolean;
  showingInterpolationModes: boolean;
  showingResultModes: boolean;
  showingEases: boolean;
  showingPathModes: boolean;
  scale: number;
  loop: boolean;
  pingPong: boolean;
  repeatCount: number;
  startOnLayout: string;
  transformWithSceneGraph: boolean;
  ignoreSystemTimescale: boolean;
  tracks: unknown[];
  tracksRoot: TimelineFolder;
  nestedTimelinesRoot: TimelineFolder;
  nestedData: Record<string, unknown>;
  transitionsData: unknown[];
  [key: string]: unknown;
}

export interface TimelineFolder {
  enabled: boolean;
  interpolationMode: string;
  resultMode: string;
  ease: string;
  pathMode: string;
  resizeMode: string;
  expanded: boolean;
  name: string;
  items: unknown[];
  subfolders: unknown[];
}

// ─── Template factory ──────────────────────────────────────

function createTimeline(name: string, totalTime = 5): Timeline {
  const folder = (): TimelineFolder => ({
    enabled: true,
    interpolationMode: 'default',
    resultMode: 'default',
    ease: 'default',
    pathMode: 'default',
    resizeMode: 'default',
    expanded: true,
    name: 'Track Folder',
    items: [],
    subfolders: [],
  });

  return {
    name,
    enabled: true,
    interpolationMode: 'default',
    resultMode: 'default',
    ease: 'noease',
    pathMode: 'line',
    resizeMode: 'size',
    playheadTime: 1,
    totalTime,
    stepTime: 0.1,
    useStepTime: true,
    showingInterpolationModes: false,
    showingResultModes: false,
    showingEases: false,
    showingPathModes: false,
    scale: 1,
    loop: false,
    pingPong: false,
    repeatCount: 1,
    startOnLayout: '',
    transformWithSceneGraph: true,
    ignoreSystemTimescale: true,
    tracks: [],
    tracksRoot: { ...folder(), name: 'Track Folder' },
    nestedTimelinesRoot: { ...folder(), name: 'Timelines' },
    nestedData: {},
    transitionsData: [],
  };
}

// ─── Helpers ───────────────────────────────────────────────

function timelineFilePath(projectDir: string, name: string, subfolder?: string): string {
  if (subfolder) {
    return resolveProjectPath(projectDir, 'timelines', subfolder, `${name}.json`);
  }
  return resolveProjectPath(projectDir, 'timelines', `${name}.json`);
}

async function readTimelineFile(filePath: string): Promise<Timeline> {
  const content = await readFile(filePath, 'utf-8');
  return parseJsonText(content) as Timeline;
}

/** Write a timeline file atomically; an existing file keeps its name on disk, including its case. */
async function atomicWriteTimeline(filePath: string, data: Timeline, projectPath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const target = await existingSpelling(filePath);
  // Keep the existing file's text style; a new file follows the project's
  const json = serializeJson(data, await resolveJsonTextStyle(target, projectPath, dirname(target)));
  await atomicReplace(target, json);
}

/**
 * Copy a file to <file>.bak, named after the file as spelled on disk. Returns
 * the backup path, or undefined when the file does not exist (nothing to back
 * up). A failed copy throws.
 */
async function backupTimeline(path: string): Promise<string | undefined> {
  const filePath = await existingSpelling(path);
  const bak = filePath + '.bak';
  try {
    await stat(filePath);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT') return undefined;
    throw e;
  }
  await copyFile(filePath, bak);
  return bak;
}

// ─── Locating timeline files ───────────────────────────────

interface TimelineLocation {
  kind: 'timeline' | 'transition';
  /** Named project-bar folders from the timelines root, outermost first. */
  folders: string[];
}

type TimelineFolderNode = ProjectFolderNode;

function folderItems(folder: TimelineFolderNode): string[] {
  return Array.isArray(folder.items) ? folder.items.filter((i): i is string => typeof i === 'string') : [];
}

function folderSubfolders(folder: TimelineFolderNode): TimelineFolderNode[] {
  return Array.isArray(folder.subfolders) ? folder.subfolders as TimelineFolderNode[] : [];
}

/** Every item name in a folder and all its subfolders. */
function allFolderItems(folder: TimelineFolderNode, into: Set<string>, depth = 0): void {
  if (depth > 50) return;
  for (const item of folderItems(folder)) into.add(item);
  for (const sub of folderSubfolders(folder)) allFolderItems(sub, into, depth + 1);
}

/**
 * Map every name in the project.c3proj timelines container to where it lives,
 * in project-bar order. Timelines and transitions are kept apart. Names the
 * tools cannot resolve to a file are collected in `unresolved`: those in a
 * nameless folder other than the Transitions folder (malformed, reported by
 * validate_project) and those in folders inside the Transitions folder.
 */
function locateTimelines(container: TimelineFolderNode | undefined): {
  timelines: Map<string, TimelineLocation>;
  transitions: Map<string, TimelineLocation>;
  unresolved: Set<string>;
} {
  const timelines = new Map<string, TimelineLocation>();
  const transitions = new Map<string, TimelineLocation>();
  const unresolved = new Set<string>();
  const transitionsFolder = container ? folderSubfolders(container)[transitionsFolderIndex(container)] : undefined;
  const walk = (folder: TimelineFolderNode, folders: string[]) => {
    for (const item of folderItems(folder)) {
      if (!timelines.has(item)) timelines.set(item, { kind: 'timeline', folders });
    }
    for (const sub of folderSubfolders(folder)) {
      if (sub === transitionsFolder) {
        for (const item of folderItems(sub)) {
          if (!transitions.has(item)) transitions.set(item, { kind: 'transition', folders: [] });
        }
        for (const inner of folderSubfolders(sub)) allFolderItems(inner, unresolved);
      } else if (!isNamelessFolder(sub)) {
        walk(sub, [...folders, sub.name as string]);
      } else {
        allFolderItems(sub, unresolved);
      }
    }
  };
  if (container) walk(container, []);
  return { timelines, transitions, unresolved };
}

function unresolvedRefusal(name: string): string {
  return `"${name}" is registered in project.c3proj in a timelines folder the timeline tools cannot resolve: ` +
    'a folder without a name that is not the editor\'s Transitions folder (only the first unnamed folder directly under timelines is), ' +
    'or a folder inside the Transitions folder. Run validate_project and fix the folder in project.c3proj first.';
}

/** Folders below timelines/ that hold the file for this location. */
function locationDirs(location: TimelineLocation): string[] {
  return location.kind === 'transition' ? [TRANSITIONS_DIR] : location.folders;
}

/** Absolute path of the file for a located name, confined to timelines/. */
function locatedFilePath(projectDir: string, name: string, location: TimelineLocation): string {
  const timelinesDir = resolveProjectPath(projectDir, 'timelines');
  return resolveProjectPath(timelinesDir, ...locationDirs(location), `${name}.json`);
}

/** Project-relative path of the file for a located name, for messages. */
function locatedFileLabel(name: string, location: TimelineLocation): string {
  return ['timelines', ...locationDirs(location), `${name}.json`].join('/');
}

/** Whether two project-bar folder paths are the same folder (names compared ignoring case). */
function sameFolders(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((folder, i) => nameKey(folder) === nameKey(b[i]));
}

function transitionRefusal(name: string): string {
  return `"${name}" is a transition (an easing curve in timelines/${TRANSITIONS_DIR}/), not a timeline. ` +
    'The timeline tools do not read, change or delete transitions; edit them in the Construct 3 editor.';
}

/** Add a timeline name to project.c3proj timelines container. */
async function addTimelineToProject(
  projectPath: string,
  name: string,
  subfolder?: string,
): Promise<void> {
  const content = await readFile(projectPath, 'utf-8');
  const project = parseJsonText(content);

  if (!project.timelines) project.timelines = { items: [], subfolders: [] };
  const container = project.timelines;

  if (subfolder) {
    const parts = subfolder.split('/');
    type TFolder = { name?: string; items: string[]; subfolders: TFolder[] };
    let cur: TFolder = container as TFolder;
    for (const part of parts) {
      let found = (cur.subfolders as TFolder[]).find(sf => sf.name === part);
      if (!found) {
        // Same key order as the editor writes (items, subfolders, name)
        found = newProjectFolder(part);
        cur.subfolders.push(found);
      }
      cur = found;
    }
    if (!cur.items.includes(name)) cur.items.push(name);
  } else {
    if (!container.items.includes(name)) container.items.push(name);
  }

  await atomicReplace(projectPath, serializeJson(project, jsonTextStyleOf(content)));
}

/**
 * Remove a timeline name from the project.c3proj timelines container, from
 * exactly the named folder it was located in (never from the Transitions folder).
 */
async function removeTimelineFromProject(projectPath: string, name: string, folders: string[]): Promise<void> {
  const content = await readFile(projectPath, 'utf-8');
  const project = parseJsonText(content);

  let folder: TimelineFolderNode | undefined = project.timelines;
  for (const folderName of folders) {
    folder = folder && folderSubfolders(folder).find(sf => !isNamelessFolder(sf) && sf.name === folderName);
  }
  const items = folder && Array.isArray(folder.items) ? folder.items as unknown[] : [];
  const idx = items.indexOf(name);
  if (idx === -1) {
    throw new Error(`"${name}" is not registered in ${['timelines', ...folders].join('/')} of project.c3proj`);
  }
  items.splice(idx, 1);

  await atomicReplace(projectPath, serializeJson(project, jsonTextStyleOf(content)));
}

// ─── Registration ──────────────────────────────────────────

export function registerTimelineTools({ server: mcpServer, reader, writer }: MutationToolDeps) {
  const server = withProjectSync(mcpServer, reader);
  // ─── list_timelines ───────────────────────────────────────

  server.tool(
    'list_timelines',
    'List all timelines in the project (root and subfolders). Transitions (easing curves) are listed separately.',
    {},
    async () => {
      try {
        const { timelines, transitions } = locateTimelines(reader.getProject().timelines);
        const names = [...timelines.keys()];
        return toolResult({ timelines: names, count: names.length, transitions: [...transitions.keys()] });
      } catch (error) {
        console.error('[list_timelines] failed:', error);
        return toolError(`Error listing timelines: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── get_timeline_details ─────────────────────────────────

  server.tool(
    'get_timeline_details',
    'Get full details of a timeline including its tracks and settings',
    {
      name: z.string().max(200).describe('Timeline name'),
    },
    async (args) => {
      try {
        const { timelines, transitions, unresolved } = locateTimelines(reader.getProject().timelines);
        const location = timelines.get(args.name) ?? transitions.get(args.name);
        if (!location) {
          if (unresolved.has(args.name)) return toolError(unresolvedRefusal(args.name));
          const names = [...timelines.keys()];
          const hint = names.length > 0 ? `\nAvailable timelines: ${names.slice(0, 5).join(', ')}` : '\nNo timelines found in this project.';
          return toolError(`Timeline "${args.name}" not found.${hint}`);
        }
        if (location.kind === 'transition') return toolError(transitionRefusal(args.name));

        const filePath = locatedFilePath(reader.getProjectDir(), args.name, location);
        let data: Timeline;
        try {
          data = await readTimelineFile(filePath);
        } catch (e) {
          return toolError(`Timeline "${args.name}" is registered in the project but its file ${locatedFileLabel(args.name, location)} could not be read: ${e instanceof Error ? e.message : String(e)}`);
        }

        return toolResult(data);
      } catch (error) {
        console.error('[get_timeline_details] failed:', error);
        return toolError(`Error getting timeline details: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── create_timeline ──────────────────────────────────────

  server.tool(
    'create_timeline',
    'Create a new timeline in the project',
    {
      name: z.string().max(200).describe('Timeline name'),
      totalTime: z.number().positive().optional().default(5).describe('Total duration in seconds (default: 5)'),
      loop: z.boolean().optional().default(false).describe('Loop the timeline (default: false)'),
      pingPong: z.boolean().optional().default(false).describe('Ping-pong playback (default: false)'),
      repeatCount: z.number().int().min(1).optional().default(1).describe('Repeat count when not looping (default: 1)'),
      startOnLayout: z.string().max(200).optional().default('').describe('Layout name to auto-start on (default: empty = no auto-start)'),
      ignoreSystemTimescale: z.boolean().optional().default(true).describe('Ignore system timescale (default: true)'),
      subfolder: z.string().max(500).optional().describe('Project-bar folder within timelines/, "/"-separated (e.g. "UI" or "UI/Menus"). Not "transitions": Construct 3 keeps transitions there.'),
    },
    async (args) => {
      try {
        validateName(args.name);
        if (args.subfolder) {
          validateSubfolder(args.subfolder);
          if (args.subfolder.split('/')[0].toLowerCase() === TRANSITIONS_DIR) {
            return toolError(`Subfolder "${args.subfolder}" is not allowed: Construct 3 stores transitions in timelines/${TRANSITIONS_DIR}/. Choose another folder name.`);
          }
        }

        const container = reader.getProject().timelines;
        const { timelines, transitions, unresolved } = locateTimelines(container);
        if (timelines.has(args.name)) {
          return toolError(`Timeline "${args.name}" already exists.`);
        }
        if (transitions.has(args.name)) {
          return toolError(`A transition named "${args.name}" already exists. Choose another timeline name.`);
        }
        if (unresolved.has(args.name)) {
          return toolError(`${unresolvedRefusal(args.name)} Creating it again would register the name twice.`);
        }
        if (args.subfolder) {
          const folderClash = findFolderPathClash(container, args.subfolder);
          if (folderClash) return toolError(folderCaseClashError(args.subfolder, folderClash));
        }

        // The editor compares timeline names exactly (projectResources.js r495.2),
        // so a case variant in another folder is allowed, with a note. In the same
        // folder both would be stored in one file on Windows and macOS.
        const folders = args.subfolder ? args.subfolder.split('/') : [];
        const warnings: string[] = [];
        for (const [existing, location] of [...timelines, ...transitions]) {
          if (nameKey(existing) !== nameKey(args.name)) continue;
          const existingFile = locatedFileLabel(existing, location);
          if (location.kind === 'timeline' && sameFolders(location.folders, folders)) {
            return toolError(
              `"${args.name}" differs only in case from the existing timeline "${existing}" in the same folder. ` +
              `On Windows and macOS both names are the same file (${existingFile}), which creating this timeline would overwrite. Choose a different name.`,
            );
          }
          warnings.push(
            `"${args.name}" differs only in case from the existing ${location.kind} "${existing}" (${existingFile}). ` +
            'Construct 3 compares timeline names exactly and the files are in different folders, so both are kept.',
          );
        }

        const data = createTimeline(args.name, args.totalTime);
        data.loop = args.loop;
        data.pingPong = args.pingPong;
        data.repeatCount = args.repeatCount;
        data.startOnLayout = args.startOnLayout;
        data.ignoreSystemTimescale = args.ignoreSystemTimescale;

        // Never replace a file on create, also not one whose name differs only in case
        const filePath = timelineFilePath(reader.getProjectDir(), args.name, args.subfolder);
        const onDisk = await findFileIgnoringCase(filePath);
        if (onDisk) {
          const label = relative(reader.getProjectDir(), onDisk).split(sep).join('/');
          return toolError(
            `The file ${label} already exists: it is not a registered timeline, or it is registered under a name ` +
            'that differs only in case. It was left unchanged. Choose another name, or, if the file is a leftover of a ' +
            'deleted timeline, check it and remove it first.',
          );
        }
        // project.c3proj changed on disk since it was loaded: refused before any write (#51)
        await writer.assertProjectFileCurrent();
        await atomicWriteTimeline(filePath, data, reader.getProjectPath());

        // Register in project.c3proj (under lock via withProjectLock is internal to writer;
        // we use writer.addToProject which handles the lock — but timelines isn't a standard category.
        // We write project directly here, then reload via reader.
        const projectPath = reader.getProjectPath();
        await backupTimeline(projectPath);
        await addTimelineToProject(projectPath, args.name, args.subfolder);
        await reader.reloadProject();

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'timeline',
          action: 'created',
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[create_timeline] failed:', error);
        return toolError(`Error creating timeline: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_timeline ──────────────────────────────────────

  server.tool(
    'update_timeline',
    'Update properties of an existing timeline',
    {
      name: z.string().max(200).describe('Timeline name'),
      totalTime: z.number().positive().optional().describe('New total duration in seconds'),
      loop: z.boolean().optional().describe('Loop setting'),
      pingPong: z.boolean().optional().describe('Ping-pong playback'),
      repeatCount: z.number().int().min(1).optional().describe('Repeat count'),
      startOnLayout: z.string().max(200).optional().describe('Auto-start layout name (empty string = none)'),
      ignoreSystemTimescale: z.boolean().optional().describe('Ignore system timescale'),
      enabled: z.boolean().optional().describe('Enable/disable the timeline'),
    },
    async (args) => {
      try {
        const hasUpdates = args.totalTime !== undefined || args.loop !== undefined ||
          args.pingPong !== undefined || args.repeatCount !== undefined ||
          args.startOnLayout !== undefined || args.ignoreSystemTimescale !== undefined ||
          args.enabled !== undefined;

        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: totalTime, loop, pingPong, repeatCount, startOnLayout, ignoreSystemTimescale, enabled.');
        }

        const { timelines, transitions, unresolved } = locateTimelines(reader.getProject().timelines);
        const location = timelines.get(args.name) ?? transitions.get(args.name);
        if (!location) {
          if (unresolved.has(args.name)) return toolError(unresolvedRefusal(args.name));
          return toolError(`Timeline "${args.name}" not found. Use list_timelines to see available timelines.`);
        }
        if (location.kind === 'transition') return toolError(transitionRefusal(args.name));

        // Read and write back the one file the timeline is stored in
        const filePath = locatedFilePath(reader.getProjectDir(), args.name, location);
        let data: Timeline;
        try {
          data = await readTimelineFile(filePath);
        } catch (e) {
          return toolError(`Timeline "${args.name}" file ${locatedFileLabel(args.name, location)} could not be read: ${e instanceof Error ? e.message : String(e)}`);
        }

        if (args.totalTime !== undefined) data.totalTime = args.totalTime;
        if (args.loop !== undefined) data.loop = args.loop;
        if (args.pingPong !== undefined) data.pingPong = args.pingPong;
        if (args.repeatCount !== undefined) data.repeatCount = args.repeatCount;
        if (args.startOnLayout !== undefined) data.startOnLayout = args.startOnLayout;
        if (args.ignoreSystemTimescale !== undefined) data.ignoreSystemTimescale = args.ignoreSystemTimescale;
        if (args.enabled !== undefined) data.enabled = args.enabled;

        const backupPath = await backupTimeline(filePath);
        await atomicWriteTimeline(filePath, data, reader.getProjectPath());

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'timeline',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_timeline] failed:', error);
        return toolError(`Error updating timeline: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_timeline ──────────────────────────────────────

  server.tool(
    'delete_timeline',
    'Delete a timeline: backs up its file to <file>.bak, deletes the file and removes the timeline from project.c3proj',
    {
      name: z.string().max(200).describe('Timeline name to delete'),
    },
    async (args) => {
      try {
        const { timelines, transitions, unresolved } = locateTimelines(reader.getProject().timelines);
        const location = timelines.get(args.name) ?? transitions.get(args.name);
        if (!location) {
          if (unresolved.has(args.name)) return toolError(unresolvedRefusal(args.name));
          return toolError(`Timeline "${args.name}" not found. Use list_timelines to see available timelines.`);
        }
        if (location.kind === 'transition') return toolError(transitionRefusal(args.name));

        // project.c3proj changed on disk since it was loaded: refused before any change (#51)
        await writer.assertProjectFileCurrent();
        // Back up exactly the file that is deleted; a failed backup or delete aborts
        const filePath = locatedFilePath(reader.getProjectDir(), args.name, location);
        const fileLabel = locatedFileLabel(args.name, location);
        const backupPath = await backupTimeline(filePath);
        if (!backupPath) {
          return toolError(`Timeline "${args.name}" is registered in project.c3proj, but its file ${fileLabel} was not found. Nothing was deleted and project.c3proj was not changed.`);
        }
        await unlink(filePath);

        const projectPath = reader.getProjectPath();
        try {
          await backupTimeline(projectPath);
          await removeTimelineFromProject(projectPath, args.name, location.folders);
        } catch (e) {
          return toolError(`Deleted ${fileLabel} (backup: ${backupPath}), but could not remove "${args.name}" from project.c3proj: ${e instanceof Error ? e.message : String(e)}`);
        }
        await reader.reloadProject();

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'timeline',
          action: 'deleted',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_timeline] failed:', error);
        return toolError(`Error deleting timeline: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
