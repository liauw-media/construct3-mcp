/**
 * Project integrity validation for Construct 3 projects.
 * Checks file existence, required fields, duplicate IDs, broken references,
 * orphaned files, and more.
 */

import { readdir } from 'fs/promises';
import { join } from 'path';
import type { Construct3ProjectReader } from '../project-reader.js';
import type { C3Event, Construct3Project, Layout, ObjectType, EventSheet } from '../types.js';
import { getProjectIndex } from './index-builder.js';
import { findOrphanedObjects } from './object-deps.js';

// ─── Types ───────────────────────────────────────────────────

export interface IntegrityIssue {
  check: string;
  entity: string;
  message: string;
  suggestion?: string;
}

export interface IntegrityResult {
  valid: boolean;
  summary: {
    errors: number;
    warnings: number;
    info: number;
    checksRun: number;
    entitiesScanned: number;
  };
  errors: IntegrityIssue[];
  warnings: IntegrityIssue[];
  info: IntegrityIssue[];
}

// ─── Constants ───────────────────────────────────────────────

const MAX_SID_DEPTH = 50;
const MAX_SID_NODES = 100_000;

// ─── Entry Point ─────────────────────────────────────────────

export async function validateProjectIntegrity(
  reader: Construct3ProjectReader
): Promise<IntegrityResult> {
  const errors: IntegrityIssue[] = [];
  const warnings: IntegrityIssue[] = [];
  const info: IntegrityIssue[] = [];

  // Load all data once
  const project = reader.getProject();
  const objects = await reader.readAllObjectTypes();
  const eventSheets = await reader.readAllEventSheets();
  const layouts = await reader.readAllLayouts();
  const families = await reader.readAllFamilies();

  const registeredObjects = flattenContainer(project.objectTypes);
  const registeredSheets = flattenContainer(project.eventSheets);
  const registeredLayouts = flattenContainer(project.layouts);

  const entitiesScanned =
    registeredObjects.length + registeredSheets.length + registeredLayouts.length;

  // Error checks
  checkFileExistence(registeredObjects, objects, 'objectTypes', errors);
  checkFileExistence(registeredSheets, eventSheets, 'eventSheets', errors);
  checkFileExistence(registeredLayouts, layouts, 'layouts', errors);
  checkRequiredFieldsObjects(objects, errors);
  checkRequiredFieldsSheets(eventSheets, errors);
  checkRequiredFieldsLayouts(layouts, errors);
  checkNameConsistency(objects, eventSheets, layouts, errors);
  checkSubfolderStructure(project, errors);

  // Warning checks
  checkDuplicateSids(objects, eventSheets, layouts, families, warnings);
  checkDuplicateUids(layouts, objects, warnings);
  await checkBrokenObjectReferences(reader, families, warnings);
  checkBrokenEventSheetReferences(layouts, eventSheets, warnings);
  checkBrokenIncludes(eventSheets, warnings);
  checkMissingAddons(objects, reader, warnings);

  // Info checks
  await checkOrphanedFiles(reader, registeredObjects, registeredSheets, registeredLayouts, info);
  await checkBackupFiles(reader, info);
  await checkOrphanedObjects(reader, info);

  const checksRun = 13;

  return {
    valid: errors.length === 0,
    summary: {
      errors: errors.length,
      warnings: warnings.length,
      info: info.length,
      checksRun,
      entitiesScanned,
    },
    errors,
    warnings,
    info,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function flattenContainer(container: { items: string[]; subfolders: Array<{ items: string[]; subfolders: unknown[]; name: string }> }): string[] {
  const result = [...container.items];
  const walk = (subfolders: Array<{ items: string[]; subfolders: unknown[]; name: string }>) => {
    for (const sf of subfolders) {
      result.push(...sf.items);
      if (Array.isArray(sf.subfolders)) {
        walk(sf.subfolders as Array<{ items: string[]; subfolders: unknown[]; name: string }>);
      }
    }
  };
  walk(container.subfolders);
  return result;
}

// ─── Check 1: File Existence ─────────────────────────────────

function checkFileExistence(
  registered: string[],
  loaded: Map<string, unknown>,
  category: string,
  errors: IntegrityIssue[]
): void {
  for (const name of registered) {
    if (!loaded.has(name)) {
      errors.push({
        check: 'file-existence',
        entity: `${category}/${name}`,
        message: `Registered in c3proj but file is missing or contains invalid JSON`,
        suggestion: `Check that ${category}/${name}.json exists and is valid JSON`,
      });
    }
  }
}

// ─── Check 2: Required Fields ────────────────────────────────

function checkRequiredFieldsObjects(
  objects: Map<string, ObjectType>,
  errors: IntegrityIssue[]
): void {
  for (const [name, obj] of objects) {
    if (!obj.name) {
      errors.push({
        check: 'required-fields',
        entity: `objectTypes/${name}`,
        message: 'Missing required field: name',
      });
    }
    if (!obj['plugin-id']) {
      errors.push({
        check: 'required-fields',
        entity: `objectTypes/${name}`,
        message: 'Missing required field: plugin-id',
      });
    }
    if (obj.sid == null) {
      errors.push({
        check: 'required-fields',
        entity: `objectTypes/${name}`,
        message: 'Missing required field: sid',
      });
    }
  }
}

function checkRequiredFieldsSheets(
  sheets: Map<string, EventSheet>,
  errors: IntegrityIssue[]
): void {
  for (const [name, sheet] of sheets) {
    if (!sheet.name) {
      errors.push({
        check: 'required-fields',
        entity: `eventSheets/${name}`,
        message: 'Missing required field: name',
      });
    }
    if (!Array.isArray(sheet.events)) {
      errors.push({
        check: 'required-fields',
        entity: `eventSheets/${name}`,
        message: 'Missing required field: events (must be an array)',
      });
    }
  }
}

function checkRequiredFieldsLayouts(
  layouts: Map<string, Layout>,
  errors: IntegrityIssue[]
): void {
  for (const [name, layout] of layouts) {
    if (!layout.name) {
      errors.push({
        check: 'required-fields',
        entity: `layouts/${name}`,
        message: 'Missing required field: name',
      });
    }
    if (!Array.isArray(layout.layers)) {
      errors.push({
        check: 'required-fields',
        entity: `layouts/${name}`,
        message: 'Missing required field: layers (must be an array)',
      });
    }
    if (layout.sid == null) {
      errors.push({
        check: 'required-fields',
        entity: `layouts/${name}`,
        message: 'Missing required field: sid',
      });
    }
  }
}

// ─── Check 3: Name Consistency ───────────────────────────────

function checkNameConsistency(
  objects: Map<string, ObjectType>,
  sheets: Map<string, EventSheet>,
  layouts: Map<string, Layout>,
  errors: IntegrityIssue[]
): void {
  for (const [regName, obj] of objects) {
    if (obj.name && obj.name !== regName) {
      errors.push({
        check: 'name-consistency',
        entity: `objectTypes/${regName}`,
        message: `Internal name "${obj.name}" does not match registered name "${regName}"`,
        suggestion: `Rename the internal "name" field to "${regName}" or update the c3proj registration`,
      });
    }
  }
  for (const [regName, sheet] of sheets) {
    if (sheet.name && sheet.name !== regName) {
      errors.push({
        check: 'name-consistency',
        entity: `eventSheets/${regName}`,
        message: `Internal name "${sheet.name}" does not match registered name "${regName}"`,
      });
    }
  }
  for (const [regName, layout] of layouts) {
    if (layout.name && layout.name !== regName) {
      errors.push({
        check: 'name-consistency',
        entity: `layouts/${regName}`,
        message: `Internal name "${layout.name}" does not match registered name "${regName}"`,
      });
    }
  }
}

// ─── Check 3b: Subfolder Structure ───────────────────────────

function checkSubfolderStructure(
  project: Construct3Project,
  errors: IntegrityIssue[]
): void {
  const containers: Array<{ name: string; container: { items: unknown[]; subfolders: unknown[] } }> = [
    { name: 'objectTypes', container: project.objectTypes },
    { name: 'eventSheets', container: project.eventSheets },
    { name: 'layouts', container: project.layouts },
    { name: 'families', container: project.families },
    { name: 'timelines', container: project.timelines },
  ];

  for (const { name, container } of containers) {
    if (!container || !Array.isArray(container.subfolders)) continue;
    validateSubfolders(container.subfolders as Array<Record<string, unknown>>, name, errors);
  }
}

function validateSubfolders(
  subfolders: Array<Record<string, unknown>>,
  path: string,
  errors: IntegrityIssue[]
): void {
  for (let i = 0; i < subfolders.length; i++) {
    const sf = subfolders[i];
    if (typeof sf.name !== 'string' || sf.name === '') {
      errors.push({
        check: 'subfolder-structure',
        entity: `${path}/subfolders[${i}]`,
        message: `Subfolder at index ${i} is missing required "name" field`,
        suggestion: 'Add a "name" field to the subfolder object in project.c3proj',
      });
    }
    if (!Array.isArray(sf.items)) {
      errors.push({
        check: 'subfolder-structure',
        entity: `${path}/${sf.name || 'subfolders[' + i + ']'}`,
        message: 'Subfolder is missing required "items" array',
        suggestion: 'Add an "items" array to the subfolder object',
      });
    }
    if (Array.isArray(sf.subfolders)) {
      const childPath = sf.name ? `${path}/${sf.name}` : `${path}/subfolders[${i}]`;
      validateSubfolders(sf.subfolders as Array<Record<string, unknown>>, childPath, errors);
    }
  }
}

// ─── Check 4: Duplicate SIDs ─────────────────────────────────

function checkDuplicateSids(
  objects: Map<string, ObjectType>,
  sheets: Map<string, EventSheet>,
  layouts: Map<string, Layout>,
  families: Map<string, Record<string, unknown>>,
  warnings: IntegrityIssue[]
): void {
  const sidMap = new Map<number, string[]>(); // sid → [locations]

  const track = (sid: unknown, location: string) => {
    if (typeof sid !== 'number' || sid <= 0) return;
    const locations = sidMap.get(sid) || [];
    locations.push(location);
    sidMap.set(sid, locations);
  };

  // Objects
  for (const [name, obj] of objects) {
    track(obj.sid, `objectTypes/${name}`);
    // Behavior SIDs
    if (Array.isArray(obj.behaviorTypes)) {
      for (const b of obj.behaviorTypes) {
        track(b.sid, `objectTypes/${name}/behavior:${b.name}`);
      }
    }
    // Instance variable SIDs
    if (Array.isArray(obj.instanceVariables)) {
      for (const v of obj.instanceVariables) {
        track(v.sid, `objectTypes/${name}/var:${v.name}`);
      }
    }
    // Animation SIDs
    if (obj.animations && typeof obj.animations === 'object') {
      scanAnimationSidsForDupes(obj.animations as Record<string, unknown>, `objectTypes/${name}`, track);
    }
    // Singleglobal instance
    const sgi = obj['singleglobal-inst'];
    if (sgi) {
      track(sgi.sid, `objectTypes/${name}/singleglobal-inst`);
    }
  }

  // Event sheets
  for (const [name, sheet] of sheets) {
    track((sheet as unknown as Record<string, unknown>).sid, `eventSheets/${name}`);
    if (Array.isArray(sheet.events)) {
      scanEventSidsForDupes(sheet.events, `eventSheets/${name}`, track);
    }
  }

  // Layouts
  for (const [name, layout] of layouts) {
    track(layout.sid, `layouts/${name}`);
    if (Array.isArray(layout.layers)) {
      for (const layer of layout.layers) {
        track(layer.sid, `layouts/${name}/layer:${layer.name}`);
        if (Array.isArray(layer.instances)) {
          for (const inst of layer.instances) {
            track(inst.sid, `layouts/${name}/layer:${layer.name}/inst:${inst.type}:${inst.uid}`);
          }
        }
      }
    }
  }

  // Families
  for (const [name, family] of families) {
    track((family as Record<string, unknown>).sid, `families/${name}`);
  }

  // Report duplicates
  for (const [sid, locations] of sidMap) {
    if (locations.length > 1) {
      warnings.push({
        check: 'duplicate-sid',
        entity: locations[0],
        message: `SID ${sid} is used ${locations.length} times: ${locations.join(', ')}`,
        suggestion: 'Each entity must have a unique SID. Re-save the project in C3 to regenerate IDs.',
      });
    }
  }
}

function scanAnimationSidsForDupes(
  animations: Record<string, unknown>,
  prefix: string,
  track: (sid: unknown, location: string) => void
): void {
  const items = animations.items as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(items)) {
    for (const anim of items) {
      const animName = anim.name || 'unnamed';
      track(anim.sid, `${prefix}/anim:${animName}`);
      const frames = anim.frames as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(frames)) {
        for (let i = 0; i < frames.length; i++) {
          track(frames[i].sid, `${prefix}/anim:${animName}/frame:${i}`);
        }
      }
    }
  }
  const subfolders = animations.subfolders as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(subfolders)) {
    for (const sub of subfolders) {
      scanAnimationSidsForDupes(sub, prefix, track);
    }
  }
}

function scanEventSidsForDupes(
  events: C3Event[],
  prefix: string,
  track: (sid: unknown, location: string) => void
): void {
  const stack: Array<{ event: C3Event; depth: number }> = [];
  let nodeCount = 0;

  for (let i = events.length - 1; i >= 0; i--) {
    stack.push({ event: events[i], depth: 0 });
  }

  while (stack.length > 0) {
    if (nodeCount++ > MAX_SID_NODES) break;
    const { event, depth } = stack.pop()!;
    if (depth > MAX_SID_DEPTH) continue;

    const rec = event as Record<string, unknown>;
    track(rec.sid, `${prefix}/event`);

    // Conditions & actions
    if ('conditions' in event && Array.isArray(event.conditions)) {
      for (const c of event.conditions) {
        track(c.sid, `${prefix}/condition`);
      }
    }
    if ('actions' in event && Array.isArray(event.actions)) {
      for (const a of event.actions) {
        track((a as Record<string, unknown>).sid, `${prefix}/action`);
      }
    }

    // Function parameters
    if ('functionParameters' in event && Array.isArray(rec.functionParameters)) {
      for (const p of rec.functionParameters as Array<Record<string, unknown>>) {
        track(p.sid, `${prefix}/funcParam`);
      }
    }
    if ('parameters' in event && Array.isArray(rec.parameters)) {
      for (const p of rec.parameters as Array<Record<string, unknown>>) {
        track(p.sid, `${prefix}/param`);
      }
    }

    // Children
    if ('children' in event && Array.isArray(event.children)) {
      for (let i = event.children.length - 1; i >= 0; i--) {
        stack.push({ event: event.children[i], depth: depth + 1 });
      }
    }
  }
}

// ─── Check 5: Duplicate UIDs ─────────────────────────────────

function checkDuplicateUids(
  layouts: Map<string, Layout>,
  objects: Map<string, ObjectType>,
  warnings: IntegrityIssue[]
): void {
  const uidMap = new Map<number, string[]>();

  const track = (uid: unknown, location: string) => {
    if (typeof uid !== 'number') return;
    const locations = uidMap.get(uid) || [];
    locations.push(location);
    uidMap.set(uid, locations);
  };

  for (const [name, layout] of layouts) {
    if (Array.isArray(layout.layers)) {
      for (const layer of layout.layers) {
        if (Array.isArray(layer.instances)) {
          for (const inst of layer.instances) {
            track(inst.uid, `layouts/${name}/layer:${layer.name}/inst:${inst.type}`);
          }
        }
      }
    }
    // Nonworld instances
    const nonworld = (layout as Record<string, unknown>)['nonworld-instances'] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(nonworld)) {
      for (const inst of nonworld) {
        track(inst.uid, `layouts/${name}/nonworld:${inst.type}`);
      }
    }
  }

  // Singleglobal instance UIDs
  for (const [name, obj] of objects) {
    const sgi = obj['singleglobal-inst'];
    if (sgi) {
      track(sgi.uid, `objectTypes/${name}/singleglobal-inst`);
    }
  }

  for (const [uid, locations] of uidMap) {
    if (locations.length > 1) {
      warnings.push({
        check: 'duplicate-uid',
        entity: locations[0],
        message: `UID ${uid} is used ${locations.length} times: ${locations.join(', ')}`,
        suggestion: 'Each instance must have a unique UID. Re-save the project in C3 to fix.',
      });
    }
  }
}

// ─── Check 6: Broken Object References ──────────────────────

async function checkBrokenObjectReferences(
  reader: Construct3ProjectReader,
  families: Map<string, Record<string, unknown>>,
  warnings: IntegrityIssue[]
): Promise<void> {
  const index = await getProjectIndex(reader);
  const validNames = new Set<string>([
    ...index.allObjects,
    ...families.keys(),
    'System',
  ]);

  for (const [objName] of index.objectToEventSheets) {
    if (!validNames.has(objName)) {
      warnings.push({
        check: 'broken-object-reference',
        entity: `objectReference/${objName}`,
        message: `Object "${objName}" is referenced in events but does not exist as an object, family, or "System"`,
        suggestion: `Check for typos or deleted objects. Referenced in event sheets.`,
      });
    }
  }
}

// ─── Check 7: Broken Event Sheet References ─────────────────

function checkBrokenEventSheetReferences(
  layouts: Map<string, Layout>,
  sheets: Map<string, EventSheet>,
  warnings: IntegrityIssue[]
): void {
  const sheetNames = new Set(sheets.keys());

  for (const [layoutName, layout] of layouts) {
    const es = (layout as Record<string, unknown>)['eventSheet'] ?? layout['event-sheet'];
    if (typeof es === 'string' && es !== '' && !sheetNames.has(es)) {
      warnings.push({
        check: 'broken-eventsheet-reference',
        entity: `layouts/${layoutName}`,
        message: `Layout references event sheet "${es}" which does not exist`,
        suggestion: `Create the missing event sheet or update the layout's eventSheet field`,
      });
    }
  }
}

// ─── Check 8: Broken Includes ────────────────────────────────

function checkBrokenIncludes(
  sheets: Map<string, EventSheet>,
  warnings: IntegrityIssue[]
): void {
  const sheetNames = new Set(sheets.keys());

  for (const [sheetName, sheet] of sheets) {
    if (!Array.isArray(sheet.events)) continue;
    walkEventsForIncludes(sheet.events, sheetName, sheetNames, warnings);
  }
}

function walkEventsForIncludes(
  events: C3Event[],
  sheetName: string,
  sheetNames: Set<string>,
  warnings: IntegrityIssue[]
): void {
  const stack = [...events];
  let nodeCount = 0;

  while (stack.length > 0) {
    if (nodeCount++ > MAX_SID_NODES) break;
    const event = stack.pop()!;

    if (event.eventType === 'include') {
      const include = event as { includeSheet: string };
      if (include.includeSheet && !sheetNames.has(include.includeSheet)) {
        warnings.push({
          check: 'broken-include',
          entity: `eventSheets/${sheetName}`,
          message: `Includes event sheet "${include.includeSheet}" which does not exist`,
          suggestion: `Create the missing event sheet or remove the include`,
        });
      }
    }

    if ('children' in event && Array.isArray(event.children)) {
      stack.push(...event.children);
    }
  }
}

// ─── Check 9: Missing Addons ─────────────────────────────────

function checkMissingAddons(
  objects: Map<string, ObjectType>,
  reader: Construct3ProjectReader,
  warnings: IntegrityIssue[]
): void {
  const addons = reader.getUsedAddons();
  const addonIds = new Set<string>();
  for (const addon of addons) {
    addonIds.add(addon.id);
  }

  for (const [name, obj] of objects) {
    if (obj['plugin-id'] && !addonIds.has(obj['plugin-id'])) {
      warnings.push({
        check: 'missing-addon',
        entity: `objectTypes/${name}`,
        message: `Plugin "${obj['plugin-id']}" is not listed in usedAddons`,
        suggestion: `Add the plugin to the project's usedAddons list`,
      });
    }
    if (Array.isArray(obj.behaviorTypes)) {
      for (const b of obj.behaviorTypes) {
        if (b.behaviorId && !addonIds.has(b.behaviorId)) {
          warnings.push({
            check: 'missing-addon',
            entity: `objectTypes/${name}/behavior:${b.name}`,
            message: `Behavior "${b.behaviorId}" is not listed in usedAddons`,
            suggestion: `Add the behavior to the project's usedAddons list`,
          });
        }
      }
    }
  }
}

// ─── Check 10: Orphaned Files ────────────────────────────────

async function checkOrphanedFiles(
  reader: Construct3ProjectReader,
  registeredObjects: string[],
  registeredSheets: string[],
  registeredLayouts: string[],
  info: IntegrityIssue[]
): Promise<void> {
  const projectDir = reader.getProjectDir();

  await scanDirForOrphans(projectDir, 'objectTypes', new Set(registeredObjects), info);
  await scanDirForOrphans(projectDir, 'eventSheets', new Set(registeredSheets), info);
  await scanDirForOrphans(projectDir, 'layouts', new Set(registeredLayouts), info);
}

async function scanDirForOrphans(
  projectDir: string,
  dirName: string,
  registered: Set<string>,
  info: IntegrityIssue[]
): Promise<void> {
  try {
    const dirPath = join(projectDir, dirName);
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const baseName = entry.name.replace(/\.json$/, '');
        if (!registered.has(baseName)) {
          info.push({
            check: 'orphaned-file',
            entity: `${dirName}/${entry.name}`,
            message: `File exists on disk but is not registered in c3proj`,
            suggestion: `Delete the file or register it in the project`,
          });
        }
      }
    }
    // Recurse into subdirectories
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await scanSubdirForOrphans(join(dirPath, entry.name), dirName, entry.name, registered, info);
      }
    }
  } catch {
    // Directory doesn't exist or not readable — skip (common in tests)
  }
}

async function scanSubdirForOrphans(
  subDirPath: string,
  category: string,
  subDirName: string,
  registered: Set<string>,
  info: IntegrityIssue[]
): Promise<void> {
  try {
    const entries = await readdir(subDirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const baseName = entry.name.replace(/\.json$/, '');
        if (!registered.has(baseName)) {
          info.push({
            check: 'orphaned-file',
            entity: `${category}/${subDirName}/${entry.name}`,
            message: `File exists on disk but is not registered in c3proj`,
            suggestion: `Delete the file or register it in the project`,
          });
        }
      }
    }
  } catch {
    // Skip unreadable
  }
}

// ─── Check 11: Backup Files ─────────────────────────────────

async function checkBackupFiles(
  reader: Construct3ProjectReader,
  info: IntegrityIssue[]
): Promise<void> {
  const projectDir = reader.getProjectDir();
  const dirs = ['objectTypes', 'eventSheets', 'layouts', 'families'];

  for (const dirName of dirs) {
    try {
      const dirPath = join(projectDir, dirName);
      await scanDirForBackups(dirPath, dirName, info);
    } catch {
      // Skip missing directories
    }
  }
}

async function scanDirForBackups(
  dirPath: string,
  prefix: string,
  info: IntegrityIssue[]
): Promise<void> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.bak')) {
        info.push({
          check: 'backup-file',
          entity: `${prefix}/${entry.name}`,
          message: `Backup file found — may be left over from a failed write operation`,
          suggestion: `Review and delete if no longer needed`,
        });
      }
      if (entry.isDirectory()) {
        await scanDirForBackups(join(dirPath, entry.name), `${prefix}/${entry.name}`, info);
      }
    }
  } catch {
    // Skip unreadable
  }
}

// ─── Check 12: Orphaned Objects ──────────────────────────────

async function checkOrphanedObjects(
  reader: Construct3ProjectReader,
  info: IntegrityIssue[]
): Promise<void> {
  const result = await findOrphanedObjects(reader);
  for (const orphan of result.orphanedObjects) {
    info.push({
      check: 'orphaned-object',
      entity: `objectTypes/${orphan.name}`,
      message: `Object "${orphan.name}" (${orphan.pluginId}) is not referenced in any event sheet or placed in any layout`,
      suggestion: `Remove the object if unused, or add it to a layout/event sheet`,
    });
  }
}
