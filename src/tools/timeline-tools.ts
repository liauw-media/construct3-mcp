/**
 * Timeline tools: create_timeline, update_timeline, delete_timeline,
 * list_timelines, get_timeline_details.
 *
 * Timeline JSON files live in projectDir/timelines/<name>.json.
 * The project.c3proj timelines container tracks their names.
 * JSON shape validated against production slot-game projects.
 */

import { z } from 'zod';
import { readFile, writeFile, mkdir, copyFile, unlink, rename, stat } from 'fs/promises';
import { join, dirname } from 'path';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult } from '../construct3/types.js';
import { validateName, toolResult, toolError } from './shared.js';
import { resolveProjectPath } from '../construct3/path-utils.js';

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
  return JSON.parse(content) as Timeline;
}

async function atomicWriteTimeline(filePath: string, data: Timeline): Promise<void> {
  const json = JSON.stringify(data, null, '\t');
  const tmpPath = filePath + '.tmp';
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmpPath, json, 'utf-8');
  try {
    await rename(tmpPath, filePath);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'EEXIST') {
      await unlink(filePath);
      await rename(tmpPath, filePath);
    } else {
      try { await unlink(tmpPath); } catch { /* best-effort */ }
      throw e;
    }
  }
}

async function backupTimeline(filePath: string): Promise<string> {
  const bak = filePath + '.bak';
  try {
    await stat(filePath);
    await copyFile(filePath, bak);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT') return bak;
    throw e;
  }
  return bak;
}

/** Add a timeline name to project.c3proj timelines container. */
async function addTimelineToProject(
  projectPath: string,
  name: string,
  subfolder?: string,
): Promise<void> {
  const content = await readFile(projectPath, 'utf-8');
  const project = JSON.parse(content);

  if (!project.timelines) project.timelines = { items: [], subfolders: [] };
  const container = project.timelines;

  if (subfolder) {
    const parts = subfolder.split('/');
    type TFolder = { name?: string; items: string[]; subfolders: TFolder[] };
    let cur: TFolder = container as TFolder;
    for (const part of parts) {
      let found = (cur.subfolders as TFolder[]).find(sf => sf.name === part);
      if (!found) {
        found = { name: part, items: [], subfolders: [] };
        cur.subfolders.push(found);
      }
      cur = found;
    }
    if (!cur.items.includes(name)) cur.items.push(name);
  } else {
    if (!container.items.includes(name)) container.items.push(name);
  }

  const tmpPath = projectPath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(project, null, '\t'), 'utf-8');
  try {
    await rename(tmpPath, projectPath);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'EEXIST') {
      await unlink(projectPath);
      await rename(tmpPath, projectPath);
    } else {
      try { await unlink(tmpPath); } catch { /* best-effort */ }
      throw e;
    }
  }
}

/** Remove a timeline name from project.c3proj timelines container. */
async function removeTimelineFromProject(projectPath: string, name: string): Promise<void> {
  const content = await readFile(projectPath, 'utf-8');
  const project = JSON.parse(content);

  if (!project.timelines) return;
  const container = project.timelines;

  // Remove from root
  const idx = container.items.indexOf(name);
  if (idx !== -1) {
    container.items.splice(idx, 1);
  } else {
    // Search subfolders recursively
    const removeFromSubfolders = (subfolders: Array<{ name: string; items: string[]; subfolders: unknown[] }>): boolean => {
      for (const sf of subfolders) {
        const i = sf.items.indexOf(name);
        if (i !== -1) { sf.items.splice(i, 1); return true; }
        if (removeFromSubfolders(sf.subfolders as Array<{ name: string; items: string[]; subfolders: unknown[] }>)) return true;
      }
      return false;
    };
    removeFromSubfolders(container.subfolders);
  }

  const tmpPath = projectPath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(project, null, '\t'), 'utf-8');
  try {
    await rename(tmpPath, projectPath);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'EEXIST') {
      await unlink(projectPath);
      await rename(tmpPath, projectPath);
    } else {
      try { await unlink(tmpPath); } catch { /* best-effort */ }
      throw e;
    }
  }
}

/** Collect all timeline names from a timelines container (root + all subfolders). */
function collectTimelineNames(container: { items: string[]; subfolders: unknown[] }): string[] {
  const names: string[] = [...container.items];
  const walk = (subfolders: unknown[]) => {
    for (const sf of subfolders as Array<{ items: string[]; subfolders: unknown[] }>) {
      names.push(...sf.items);
      walk(sf.subfolders);
    }
  };
  walk(container.subfolders);
  return names;
}

// ─── Registration ──────────────────────────────────────────

export function registerTimelineTools({ server, reader, writer }: MutationToolDeps) {
  // ─── list_timelines ───────────────────────────────────────

  server.tool(
    'list_timelines',
    'List all timelines in the project',
    {},
    async () => {
      try {
        const project = reader.getProject();
        const names = collectTimelineNames(project.timelines);
        return toolResult({ timelines: names, count: names.length });
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
        const project = reader.getProject();
        const names = collectTimelineNames(project.timelines);
        if (!names.includes(args.name)) {
          const hint = names.length > 0 ? `\nAvailable timelines: ${names.slice(0, 5).join(', ')}` : '\nNo timelines found in this project.';
          return toolError(`Timeline "${args.name}" not found.${hint}`);
        }

        const filePath = timelineFilePath(reader.getProjectDir(), args.name);
        let data: Timeline;
        try {
          data = await readTimelineFile(filePath);
        } catch {
          // Try transitions subfolder
          const transPath = timelineFilePath(reader.getProjectDir(), args.name, 'transitions');
          try {
            data = await readTimelineFile(transPath);
          } catch {
            return toolError(`Timeline "${args.name}" is registered in the project but its file could not be read.`);
          }
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
      subfolder: z.string().max(500).optional().describe('Subfolder within timelines/ (e.g. "transitions")'),
    },
    async (args) => {
      try {
        validateName(args.name);

        const project = reader.getProject();
        const existing = collectTimelineNames(project.timelines);
        if (existing.includes(args.name)) {
          return toolError(`Timeline "${args.name}" already exists.`);
        }

        const data = createTimeline(args.name, args.totalTime);
        data.loop = args.loop;
        data.pingPong = args.pingPong;
        data.repeatCount = args.repeatCount;
        data.startOnLayout = args.startOnLayout;
        data.ignoreSystemTimescale = args.ignoreSystemTimescale;

        const filePath = timelineFilePath(reader.getProjectDir(), args.name, args.subfolder);
        const backupPath = await backupTimeline(filePath);
        await atomicWriteTimeline(filePath, data);

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
          backupFile: backupPath,
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

        const project = reader.getProject();
        const names = collectTimelineNames(project.timelines);
        if (!names.includes(args.name)) {
          return toolError(`Timeline "${args.name}" not found. Use list_timelines to see available timelines.`);
        }

        const filePath = timelineFilePath(reader.getProjectDir(), args.name);
        let data: Timeline;
        try {
          data = await readTimelineFile(filePath);
        } catch {
          const transPath = timelineFilePath(reader.getProjectDir(), args.name, 'transitions');
          try {
            data = await readTimelineFile(transPath);
          } catch {
            return toolError(`Timeline "${args.name}" file could not be read.`);
          }
        }

        if (args.totalTime !== undefined) data.totalTime = args.totalTime;
        if (args.loop !== undefined) data.loop = args.loop;
        if (args.pingPong !== undefined) data.pingPong = args.pingPong;
        if (args.repeatCount !== undefined) data.repeatCount = args.repeatCount;
        if (args.startOnLayout !== undefined) data.startOnLayout = args.startOnLayout;
        if (args.ignoreSystemTimescale !== undefined) data.ignoreSystemTimescale = args.ignoreSystemTimescale;
        if (args.enabled !== undefined) data.enabled = args.enabled;

        const backupPath = await backupTimeline(filePath);
        await atomicWriteTimeline(filePath, data);

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
    'Delete a timeline from the project',
    {
      name: z.string().max(200).describe('Timeline name to delete'),
    },
    async (args) => {
      try {
        const project = reader.getProject();
        const names = collectTimelineNames(project.timelines);
        if (!names.includes(args.name)) {
          return toolError(`Timeline "${args.name}" not found. Use list_timelines to see available timelines.`);
        }

        const filePath = timelineFilePath(reader.getProjectDir(), args.name);
        const backupPath = await backupTimeline(filePath);

        try {
          await unlink(filePath);
        } catch (e: unknown) {
          // Try transitions subfolder
          if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT') {
            const transPath = timelineFilePath(reader.getProjectDir(), args.name, 'transitions');
            try { await unlink(transPath); } catch { /* already gone */ }
          }
        }

        const projectPath = reader.getProjectPath();
        await backupTimeline(projectPath);
        await removeTimelineFromProject(projectPath, args.name);
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
