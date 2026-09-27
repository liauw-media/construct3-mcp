/**
 * Project integrity validation for Construct 3 projects.
 * Checks file existence, required fields, duplicate IDs, broken references,
 * orphaned files, editor load-time rules, and more.
 */

import { readdir } from 'fs/promises';
import { join } from 'path';
import type { Construct3ProjectReader } from '../project-reader.js';
import type { C3Event, Construct3Project, Layout, ObjectType, EventSheet } from '../types.js';
import { getProjectIndex } from './index-builder.js';
import { findOrphanedObjects } from './object-deps.js';
import { scanLegacyBehaviorKeys, hasOnlyLegacyBehaviorName, describeLegacyHit } from './legacy-behavior-keys.js';
import { checkBehaviorName } from './behavior-refs.js';
import type { BehaviorLookupData } from './behavior-refs.js';
import {
  checkEventLoadRules,
  checkFamilyPlugins,
  checkObjectClassNames,
  createAceOriginResolver,
  classifySidDuplicate,
  describeAce,
  describeEvent,
  type LoadRuleIssue,
} from './load-rules.js';

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
  await checkLegacyBehaviorKeys(reader, eventSheets, objects, families, errors, warnings);

  // Editor load-time rules (errors, or warnings where only partly verified)
  const aceOrigin = createAceOriginResolver({
    objects: objects as Map<string, Record<string, unknown>>,
    families,
    usedAddons: reader.getUsedAddons(),
  });
  for (const [name, sheet] of eventSheets) {
    if (!Array.isArray(sheet.events)) continue;
    addLoadRuleIssues(checkEventLoadRules(sheet.events, { sheet: `eventSheets/${name}`, aceOrigin }), errors, warnings);
  }
  addLoadRuleIssues(checkObjectClassNames(project), errors, warnings);
  addLoadRuleIssues(checkFamilyPlugins(families, objects as Map<string, Record<string, unknown>>), errors, warnings);

  // Duplicate SIDs: errors for object type/family SIDs, warnings otherwise
  checkDuplicateSids(objects, eventSheets, layouts, families, errors, warnings);

  // Warning checks
  checkDuplicateUids(layouts, objects, warnings);
  await checkBrokenObjectReferences(reader, families, warnings);
  checkBrokenEventSheetReferences(layouts, eventSheets, warnings);
  checkBrokenIncludes(eventSheets, warnings);
  checkMissingAddons(objects, reader, warnings);

  // Info checks
  await checkOrphanedFiles(reader, registeredObjects, registeredSheets, registeredLayouts, info);
  await checkBackupFiles(reader, info);
  await checkOrphanedObjects(reader, info);

  // 13 original checks + legacy-behavior-key + expression-syntax,
  // empty-expression, trigger-placement, duplicate-object-name,
  // family-plugin-mismatch
  const checksRun = 19;

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

function addLoadRuleIssues(
  issues: LoadRuleIssue[],
  errors: IntegrityIssue[],
  warnings: IntegrityIssue[]
): void {
  for (const issue of issues) {
    const entry: IntegrityIssue = {
      check: issue.rule,
      entity: issue.location,
      message: issue.message,
      suggestion: issue.suggestion,
    };
    (issue.severity === 'error' ? errors : warnings).push(entry);
  }
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

// ─── Check 3c: Legacy "behavior-type" Keys ──────────────────

/**
 * Behavior conditions/actions must carry "behaviorType". Older versions of
 * this server wrote "behavior-type", which Construct 3 does not read (issue
 * #16). One entry per affected sheet and severity:
 * - error: the behavior name sits only under the legacy key, so C3 looks the
 *   ACE up on the base plugin and the project fails to open. Names that match
 *   no behavior on the object (or its families) are called out, because
 *   renaming the key alone does not fix them.
 * - warning: the legacy key is a leftover next to a valid "behaviorType", or
 *   holds no behavior name — dead data that C3 does not read.
 */
async function checkLegacyBehaviorKeys(
  reader: Construct3ProjectReader,
  sheets: Map<string, EventSheet>,
  objects: Map<string, ObjectType>,
  families: Map<string, Record<string, unknown>>,
  errors: IntegrityIssue[],
  warnings: IntegrityIssue[]
): Promise<void> {
  const lookup: BehaviorLookupData = {
    objectNames: new Set(await reader.listObjectTypes()),
    familyNames: new Set(await reader.listFamilies()),
    objectTypes: objects,
    families,
  };
  const resolve = (objectClass: string, behaviorName: string) => checkBehaviorName(objectClass, behaviorName, lookup);

  for (const [name, sheet] of sheets) {
    if (!Array.isArray(sheet.events)) continue;
    const scan = scanLegacyBehaviorKeys(sheet.events, { resolve });
    const entity = `eventSheets/${name}`;
    const truncatedNote = scan.truncated
      ? ' The scan stopped at its size limit, so there may be more.'
      : '';

    // Behavior name only under the legacy key: the issue #16 load failure.
    const renamable = scan.fixable.filter(hasOnlyLegacyBehaviorName);
    const manual = [...scan.unresolved, ...scan.conflicts].filter(hasOnlyLegacyBehaviorName);
    const brokenCount = renamable.length + manual.length;
    if (brokenCount > 0) {
      let message =
        `${brokenCount} condition(s)/action(s) name their behavior only under the legacy "behavior-type" key: ` +
        `${listExamples([...renamable, ...manual].map(describeLegacyHit), ', ')}. Construct 3 reads "behaviorType", ` +
        `so it looks these up on the base plugin and fails to open the project (e.g. "missing action id").`;
      if (manual.length > 0) {
        message += ` ${manual.length} of them cannot be renamed automatically — ` +
          `${listExamples(manual.map(h => `${describeLegacyHit(h)}: ${h.reason}`), '; ')}.`;
      }
      const steps: string[] = [];
      if (renamable.length > 0) {
        steps.push(`Run fix_legacy_behavior_keys with dryRun: false to rename the key to "behaviorType" on ${renamable.length} of them (each sheet is backed up first).`);
      }
      if (manual.length > 0) {
        steps.push(`For the ${manual.length} it cannot rename, set "behaviorType" to the behavior's name by hand and remove "behavior-type".`);
      }
      errors.push({
        check: 'legacy-behavior-key',
        entity,
        message: message + truncatedNote,
        suggestion: steps.join(' '),
      });
    }

    // Legacy key next to a valid behaviorType, or holding no behavior name: dead data.
    const duplicates = scan.fixable.filter(h => !hasOnlyLegacyBehaviorName(h));
    const others = [...scan.unresolved, ...scan.conflicts].filter(h => !hasOnlyLegacyBehaviorName(h));
    const leftoverCount = duplicates.length + others.length;
    if (leftoverCount > 0) {
      const details = [
        ...duplicates.map(h => `${describeLegacyHit(h)}: same value as "behaviorType"`),
        ...others.map(h => `${describeLegacyHit(h)}: ${h.reason}`),
      ];
      const steps: string[] = [];
      if (duplicates.length > 0) {
        steps.push('Run fix_legacy_behavior_keys with dryRun: false to drop the leftover keys that repeat "behaviorType".');
      }
      if (others.length > 0) {
        steps.push(`Remove the other ${others.length} "behavior-type" key(s) by hand; if the condition/action belongs to a behavior, make sure "behaviorType" holds the behavior's name.`);
      }
      warnings.push({
        check: 'legacy-behavior-key',
        entity,
        message:
          `${leftoverCount} condition(s)/action(s) carry a leftover "behavior-type" key, which Construct 3 does not read: ` +
          `${listExamples(details, '; ')}.${brokenCount === 0 ? truncatedNote : ''}`,
        suggestion: steps.join(' '),
      });
    }

    if (scan.truncated && brokenCount === 0 && leftoverCount === 0) {
      warnings.push({
        check: 'legacy-behavior-key',
        entity,
        message: 'The legacy "behavior-type" scan stopped at its size limit (100,000 events or nesting depth 50); part of this sheet was not checked.',
      });
    }
  }
}

function listExamples(items: string[], separator: string, max = 3): string {
  const shown = items.slice(0, max).join(separator);
  return items.length > max ? `${shown}${separator}and ${items.length - max} more` : shown;
}

// ─── Check 4: Duplicate SIDs ─────────────────────────────────

/**
 * Records one SID occurrence. `location` is what the report shows; `container`
 * is the file it lives in (e.g. `eventSheets/Sheet1`), used to summarise long
 * lists; `kind` feeds classifySidDuplicate.
 */
type SidTracker = (sid: unknown, location: string, kind: string, container: string) => void;

interface SidLocation {
  location: string;
  kind: string;
  container: string;
}

/** Locations listed in full in a duplicate-sid message; the rest are counted. */
const MAX_LISTED_SID_LOCATIONS = 5;

function checkDuplicateSids(
  objects: Map<string, ObjectType>,
  sheets: Map<string, EventSheet>,
  layouts: Map<string, Layout>,
  families: Map<string, Record<string, unknown>>,
  errors: IntegrityIssue[],
  warnings: IntegrityIssue[]
): void {
  const sidMap = new Map<number, SidLocation[]>(); // sid → locations

  const track: SidTracker = (sid, location, kind, container) => {
    if (typeof sid !== 'number' || sid <= 0) return;
    const locations = sidMap.get(sid) || [];
    locations.push({ location, kind, container });
    sidMap.set(sid, locations);
  };

  // Objects
  for (const [name, obj] of objects) {
    const file = `objectTypes/${name}`;
    track(obj.sid, file, 'object', file);
    // Behavior SIDs
    if (Array.isArray(obj.behaviorTypes)) {
      for (const b of obj.behaviorTypes) {
        track(b.sid, `${file}/behavior:${b.name}`, 'behavior', file);
      }
    }
    // Instance variable SIDs
    if (Array.isArray(obj.instanceVariables)) {
      for (const v of obj.instanceVariables) {
        track(v.sid, `${file}/var:${v.name}`, 'instance-variable', file);
      }
    }
    // Animation SIDs
    if (obj.animations && typeof obj.animations === 'object') {
      scanAnimationSidsForDupes(obj.animations as Record<string, unknown>, file, track);
    }
    // Singleglobal instance
    const sgi = obj['singleglobal-inst'];
    if (sgi) {
      track(sgi.sid, `${file}/singleglobal-inst`, 'singleglobal-inst', file);
    }
  }

  // Event sheets
  for (const [name, sheet] of sheets) {
    const file = `eventSheets/${name}`;
    track(sheet.sid, file, 'event-sheet', file);
    if (Array.isArray(sheet.events)) {
      scanEventSidsForDupes(sheet.events, file, track);
    }
  }

  // Layouts
  for (const [name, layout] of layouts) {
    const file = `layouts/${name}`;
    track(layout.sid, file, 'layout', file);
    if (Array.isArray(layout.layers)) {
      for (const layer of layout.layers) {
        track(layer.sid, `${file}/layer:${layer.name}`, 'layer', file);
        if (Array.isArray(layer.instances)) {
          for (const inst of layer.instances) {
            track(inst.sid, `${file}/layer:${layer.name}/inst:${inst.type}:${inst.uid}`, 'layout-instance', file);
          }
        }
      }
    }
  }

  // Families (members do not repeat the family's behavior/variable SIDs in real projects)
  for (const [name, family] of families) {
    const file = `families/${name}`;
    track(family.sid, file, 'family', file);
    if (Array.isArray(family.behaviorTypes)) {
      for (const b of family.behaviorTypes as Array<Record<string, unknown>>) {
        track(b.sid, `${file}/behavior:${b.name}`, 'family-behavior', file);
      }
    }
    if (Array.isArray(family.instanceVariables)) {
      for (const v of family.instanceVariables as Array<Record<string, unknown>>) {
        track(v.sid, `${file}/var:${v.name}`, 'family-instance-variable', file);
      }
    }
  }

  // Report duplicates. Two object types/families sharing a SID are an error
  // (the editor refuses to open the project); every other duplicate is a
  // warning, worded by what is known about its load impact (see
  // classifySidDuplicate). None of them advise re-saving: the editor keeps
  // existing SIDs when it saves. Layout instanceFolderItem SIDs are not
  // tracked: they legitimately repeat the instance SID.
  for (const [sid, locations] of sidMap) {
    if (locations.length < 2) continue;
    const used = describeSidUse(sid, locations);
    const entity = locations[0].location;
    const impact = classifySidDuplicate(locations.map(l => l.kind));
    // Whatever else shares the SID, several events with it in one sheet make the SID-based event tools refuse it there
    const toolNote = eventToolNote(locations);
    if (impact === 'object-class') {
      errors.push({
        check: 'duplicate-sid',
        entity,
        message: `${used}. Object types and families need project-unique SIDs; Construct 3 fails to open the project with "object class sid already in use".`,
        suggestion: `Give each object type and family its own project-unique SID.${toolNote}`,
      });
    } else if (impact === 'parameter') {
      warnings.push({
        check: 'duplicate-sid',
        entity,
        message: `${used}. Parameter SIDs should be unique across the project: the editor's loader checks function parameter SIDs for uniqueness, so this clash may stop the project from opening.`,
        suggestion: `Give each function and custom action parameter its own project-unique SID.${toolNote}`,
      });
    } else if (impact === 'object-file') {
      warnings.push({
        check: 'duplicate-sid',
        entity,
        message: `${used}. SIDs in object type and family files should be unique across the project. No load failure is on record for this clash: the editor's loader checks only object type and family SIDs.`,
        suggestion: `Give each behavior and instance variable its own project-unique SID.${toolNote}`,
      });
    } else if (impact === 'event-or-instance') {
      warnings.push({
        check: 'duplicate-sid',
        entity,
        message: `${used}. No load failure is on record for duplicate event, condition, action or layout instance SIDs, and the editor keeps them when it saves the project.`,
        suggestion: `Give all but one of these nodes a new project-unique SID. Re-saving in Construct 3 does not change them.${toolNote}`,
      });
    } else {
      warnings.push({
        check: 'duplicate-sid',
        entity,
        message: `${used}. SIDs should be unique across the project. No load failure is on record for this clash: the editor's loader checks only object type, family and function parameter SIDs.`,
        suggestion: `Give all but one of these a new project-unique SID. Re-saving in Construct 3 does not change existing SIDs.${toolNote}`,
      });
    }
  }
}

/**
 * The note for a duplicate-sid suggestion when several events in one sheet
 * share the SID: the tools that find an event by SID refuse it there unless an
 * eventPath picks one. Empty when each sheet has at most one event with it.
 */
function eventToolNote(locations: SidLocation[]): string {
  const eventsPerSheet = new Map<string, number>();
  for (const l of locations) {
    if (l.kind === 'event') eventsPerSheet.set(l.container, (eventsPerSheet.get(l.container) ?? 0) + 1);
  }
  if (![...eventsPerSheet.values()].some(count => count > 1)) return '';
  return (
    ' Until then, update_event_block, update_event_block_action, update_event_variable and delete_event_from_sheet ' +
    'refuse this SID in a sheet where several events have it, unless eventPath names one of them ' +
    '(move_events_between_sheets: eventPaths, for top-level events). ' +
    'Take the events[...] path from the event locations above, from the refused call, or from locate_event.'
  );
}

/**
 * "SID 5 is used 2 times: a; b". Long lists show the first few locations, a
 * count of the rest and a summary per file and kind, e.g.
 * "SID 5 is used 41 times (41 actions in eventSheets/Sheet1): a; b; …; and 36 more".
 */
function describeSidUse(sid: number, locations: SidLocation[]): string {
  const listed = locations.slice(0, MAX_LISTED_SID_LOCATIONS).map(l => l.location);
  const rest = locations.length - listed.length;
  if (rest <= 0) return `SID ${sid} is used ${locations.length} times: ${listed.join('; ')}`;

  const groups = new Map<string, { kind: string; container: string; count: number }>();
  for (const l of locations) {
    const key = `${l.kind}\u0000${l.container}`;
    const group = groups.get(key) ?? { kind: l.kind, container: l.container, count: 0 };
    group.count++;
    groups.set(key, group);
  }
  const summary = [...groups.values()]
    .map(g => `${g.count} ${g.kind.replace(/-/g, ' ')}${g.count === 1 ? '' : 's'} in ${g.container}`)
    .join(', ');
  return `SID ${sid} is used ${locations.length} times (${summary}): ${listed.join('; ')}; and ${rest} more`;
}

function scanAnimationSidsForDupes(
  animations: Record<string, unknown>,
  prefix: string,
  track: SidTracker
): void {
  const items = animations.items as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(items)) {
    for (const anim of items) {
      const animName = anim.name || 'unnamed';
      track(anim.sid, `${prefix}/anim:${animName}`, 'animation', prefix);
      const frames = anim.frames as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(frames)) {
        for (let i = 0; i < frames.length; i++) {
          track(frames[i].sid, `${prefix}/anim:${animName}/frame:${i}`, 'frame', prefix);
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

/**
 * Track the SIDs of events, conditions, actions and parameters in one sheet.
 * Locations use the same path format as the load-rule checks, e.g.
 * `eventSheets/Sheet1 > group "UI" (sid 3) > block (sid 12) > action 0 "wait" (System)`.
 * An event's own location also names its JSON path (`... > block (sid 12) at
 * events[0].children[1]`), which tells apart events that share a SID under the
 * same parent and is what the eventPath argument of the SID-based event tools takes.
 */
function scanEventSidsForDupes(
  events: C3Event[],
  sheet: string,
  track: SidTracker
): void {
  const stack: Array<{ event: Record<string, unknown>; location: string; path: string; depth: number }> = [];
  const push = (list: unknown, parentLocation: string, parentPath: string, depth: number) => {
    if (!Array.isArray(list)) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const event = list[i];
      if (!isRecord(event)) continue;
      const path = parentPath ? `${parentPath}.children[${i}]` : `events[${i}]`;
      stack.push({ event, location: `${parentLocation} > ${describeEvent(event)}`, path, depth });
    }
  };
  push(events, sheet, '', 0);

  let nodeCount = 0;
  while (stack.length > 0) {
    if (nodeCount++ > MAX_SID_NODES) break;
    const { event, location, path, depth } = stack.pop()!;
    if (depth > MAX_SID_DEPTH) continue;

    track(event.sid, `${location} at ${path}`, 'event', sheet);

    // Conditions & actions
    const aces = (list: unknown, kind: 'condition' | 'action') => {
      if (!Array.isArray(list)) return;
      list.forEach((ace, i) => {
        if (isRecord(ace)) track(ace.sid, `${location} > ${describeAce(ace, kind, i)}`, kind, sheet);
      });
    };
    aces(event.conditions, 'condition');
    aces(event.actions, 'action');

    // Parameters of function blocks and custom action blocks
    const params = (list: unknown, kind: string) => {
      if (!Array.isArray(list)) return;
      list.forEach((p, i) => {
        if (isRecord(p)) track(p.sid, `${location} > parameter ${i} "${String(p.name)}"`, kind, sheet);
      });
    };
    params(event.functionParameters, 'function-parameter');
    params(event.parameters, 'parameter');

    push(event.children, location, path, depth + 1);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
