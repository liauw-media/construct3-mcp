/**
 * Event sheet tools: create_event_sheet, add_event_to_sheet, add_event_block, delete_event_sheet.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { C3Event, EventSheet, FunctionBlockEvent, WriteResult } from '../construct3/types.js';
import {
  validateName,
  validateSubfolder,
  toolResult,
  toolError,
  notFoundError,
  boundedRecord,
  caseClashError,
  folderCaseClashError,
} from './shared.js';
import { findFolderPathClash, findNameClash } from '../construct3/names.js';
import {
  SYSTEM_EXPRESSIONS_NOT_IN_R449,
  eventVariableNameUses,
  findEnclosingEvents,
  findEventVariableNameProblem,
  findNewEventVariableNameClashes,
} from '../construct3/event-variable-names.js';
import type { EventVariableNameProblem, NewEventVariableNameClash } from '../construct3/event-variable-names.js';
import {
  conditionSchema,
  actionSchema,
  childEventSchema,
  findGroupByPath,
  validateObjectClasses,
  collectObjectRefs,
  buildBlockEvent,
  buildCondition,
  buildStandardAction,
  resolveEventBySid,
  parseEventPath,
  ambiguousSidMessage,
  eventPathSchema,
  collectEventSids,
  eventSidsMatchingSeveral,
  countDescendants,
  summarizeEvents,
  loadBehaviorLookup,
  normalizeLegacyBehaviorKeys,
  snapshotEvents,
  checkLoadRulesBeforeWrite,
  checkLoadRulesBeforeSheetPairWrite,
  loadRuleErrorMessage,
} from './event-helpers.js';
import type { ObjectRef, SidMatch } from './event-helpers.js';
import { getProjectIndex, resetProjectIndex } from '../construct3/analyzers/index-builder.js';
import { scanLegacyBehaviorKeys } from '../construct3/analyzers/legacy-behavior-keys.js';
import { checkBehaviorName } from '../construct3/analyzers/behavior-refs.js';
import type { LegacyBehaviorKeyHit, LegacyBehaviorKeyConflict } from '../construct3/analyzers/legacy-behavior-keys.js';
import {
  createEmptySheet,
  createVariableEvent,
  createGroupEvent,
  createFunctionEvent,
  createIncludeEvent,
  createCommentEvent,
} from '../construct3/templates.js';

/** Per-sheet cap on change details returned by fix_legacy_behavior_keys. */
const MAX_REPORTED_CHANGES = 100;

export function registerEventTools({ server, reader, writer, idGen }: MutationToolDeps) {
  // ─── create_event_sheet ───────────────────────────────────

  server.tool(
    'create_event_sheet',
    'Create a new event sheet in the project',
    {
      name: z.string().max(200).describe('Event sheet name (must not match an existing event sheet name, ignoring case)'),
      subfolder: z.string().max(500).optional().describe('Subfolder path'),
      includeSheets: z.array(z.string()).optional().describe('Event sheets to auto-include'),
    },
    async (args) => {
      try {
        validateName(args.name);
        if (args.subfolder) validateSubfolder(args.subfolder);

        // Check uniqueness: the editor compares event sheet names ignoring case, project-wide
        const existing = await reader.listEventSheets();
        if (existing.includes(args.name)) {
          return toolError(`Event sheet "${args.name}" already exists.`);
        }
        const nameClash = findNameClash(args.name, existing);
        if (nameClash) {
          return toolError(caseClashError('event sheet', args.name, nameClash));
        }
        if (args.subfolder) {
          const folderClash = findFolderPathClash(reader.getProject().eventSheets, args.subfolder);
          if (folderClash) return toolError(folderCaseClashError(args.subfolder, folderClash));
        }
        // Never replace an existing file
        const fileRefusal = await writer.entityFileRefusal('eventSheets', args.name, args.subfolder);
        if (fileRefusal) return toolError(fileRefusal);

        // Validate include sheets exist
        if (args.includeSheets) {
          for (const sheet of args.includeSheets) {
            if (!existing.includes(sheet)) {
              return toolError(`Include sheet "${sheet}" does not exist. Use list_eventsheets to see available sheets.`);
            }
          }
        }

        const sid = await idGen.generateSid(reader);
        const data = createEmptySheet(args.name, sid);

        // Add include events
        if (args.includeSheets) {
          for (const sheet of args.includeSheets) {
            data.events.push(createIncludeEvent(sheet));
          }
        }

        await writer.writeEntityFile('eventSheets', args.name, data, args.subfolder, { createOnly: true });
        await writer.addToProject('eventSheets', args.name, args.subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'eventsheet',
          action: 'created',
          generatedSid: sid,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[create_event_sheet] failed:', error);
        return toolError(`Error creating event sheet: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_event_to_sheet ───────────────────────────────────

  server.tool(
    'add_event_to_sheet',
    'Add an event (group, function, variable, include, or comment) to an event sheet',
    {
      sheetName: z.string().max(200).describe('Target event sheet'),
      eventType: z.enum(['group', 'function', 'variable', 'include', 'comment']).describe('Type of event to add'),
      title: z.string().max(500).optional().describe('For groups: the group title'),
      functionName: z.string().max(200).optional().describe('For functions: function name'),
      functionParams: z.array(z.object({
        name: z.string().describe('Parameter name'),
        type: z.enum(['number', 'string', 'boolean']).describe('Parameter type'),
      })).optional().describe('For functions: parameter definitions. Names are refused like in the editor: a name that matches, ignoring case, a global variable of the project, another parameter of the function or a System expression, or that has whitespace, punctuation such as - . : or a leading underscore'),
      variableName: z.string().max(200).optional().describe('For variables: name of the new global variable. Refused like in the editor: a name that matches, ignoring case, any event variable or function parameter in the project or a System expression, or that has whitespace, punctuation such as - . : or a leading underscore'),
      variableType: z.enum(['number', 'string', 'boolean']).optional().describe('For variables: variable type'),
      initialValue: z.string().max(500).optional().default('').describe('For variables: initial value'),
      includeSheet: z.string().max(200).optional().describe('For includes: sheet name to include'),
      commentText: z.string().max(2000).optional().describe('For comments: comment text'),
      position: z.enum(['start', 'end']).optional().default('end').describe('Where to insert the event'),
    },
    async (args) => {
      try {
        // Read existing sheet — preserves ALL original events and fields
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }
        const beforeEvents = snapshotEvents(sheet.events);

        let event: C3Event;

        switch (args.eventType) {
          case 'group': {
            if (!args.title) return toolError('title is required for group events');
            const sid = await idGen.generateSid(reader);
            event = createGroupEvent(args.title, sid);
            break;
          }
          case 'function': {
            if (!args.functionName) return toolError('functionName is required for function events');
            // Parameter names are checked like in the editor's Function parameter dialog
            if (args.functionParams && args.functionParams.length > 0) {
              const sheets = await readEventSheetsFresh(reader, [[args.sheetName, sheet.events]]);
              const paramError = functionParameterNamesError(sheets, args.sheetName, args.functionParams.map(p => p.name));
              if (paramError) return toolError(paramError);
            }
            const sid = await idGen.generateSid(reader);
            // Pre-generate real SIDs for each parameter before passing to the template.
            const paramsWithSids = args.functionParams
              ? await Promise.all(
                  args.functionParams.map(async (p) => ({
                    ...p,
                    sid: await idGen.generateSid(reader),
                  }))
                )
              : undefined;
            event = createFunctionEvent(args.functionName, sid, paramsWithSids);
            break;
          }
          case 'variable': {
            if (!args.variableName) return toolError('variableName is required for variable events');
            // The variable goes to the top level of the sheet: a global variable
            const sheets = await readEventSheetsFresh(reader, [[args.sheetName, sheet.events]]);
            const nameError = eventVariableNameError(sheets, args.sheetName, [], args.variableName);
            if (nameError) return toolError(nameError);
            const varType = args.variableType || 'number';
            const defaultValue = args.initialValue || (varType === 'number' ? '0' : varType === 'boolean' ? 'false' : '');
            const sid = await idGen.generateSid(reader);
            event = createVariableEvent(args.variableName, varType, defaultValue, sid);
            break;
          }
          case 'include': {
            if (!args.includeSheet) return toolError('includeSheet is required for include events');
            const sheets = await reader.listEventSheets();
            if (!sheets.includes(args.includeSheet)) {
              return toolError(`Include sheet "${args.includeSheet}" does not exist.`);
            }
            event = createIncludeEvent(args.includeSheet);
            break;
          }
          case 'comment': {
            if (!args.commentText) return toolError('commentText is required for comment events');
            event = createCommentEvent(args.commentText);
            break;
          }
        }

        if (args.position === 'start') {
          sheet.events.unshift(event);
        } else {
          sheet.events.push(event);
        }

        // Editor load-time rules: block the write if it introduces an error
        const loadCheck = await checkLoadRulesBeforeWrite(reader, args.sheetName, beforeEvents, sheet.events);
        if (loadCheck.errors.length > 0) {
          sheet.events = beforeEvents;
          return toolError(loadRuleErrorMessage(loadCheck.errors));
        }

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          warnings: loadCheck.warnings.length > 0 ? loadCheck.warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[add_event_to_sheet] failed:', error);
        return toolError(`Error adding event: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_event_block ──────────────────────────────────────

  server.tool(
    'add_event_block',
    'Add a block event (conditions + actions) to an event sheet — the core of gameplay logic. Supports sub-events, else blocks, and per-action disabling. Conditions are AND-combined; C3 OR blocks cannot be created, so give each trigger its own event. Writes that would break a checked editor load-time rule (expression syntax, empty expressions, trigger placement) are refused.',
    {
      sheetName: z.string().max(200).describe('Target event sheet'),
      conditions: z.array(conditionSchema).optional().default([]).describe('Conditions array (at least one required, unless isElse is true)'),
      actions: z.array(actionSchema).optional().default([]).describe('Actions array (standard actions or script actions)'),
      groupPath: z.string().max(500).optional().describe('Insert inside group by title path (e.g., "Movement > Collision")'),
      position: z.enum(['start', 'end']).optional().default('end').describe('Where to insert the event block'),
      disabled: z.boolean().optional().default(false).describe('Create the event block disabled'),
      isElse: z.boolean().optional().default(false).describe('Mark as an else block (conditions become optional)'),
      children: z.array(childEventSchema).optional().default([]).describe('Sub-events nested inside this block (recursive, max depth 5, max 50 total events)'),
    },
    async (args) => {
      try {
        // Validate: non-else blocks must have at least one condition
        if (!args.isElse && args.conditions.length === 0) {
          return toolError('At least one condition is required (unless isElse is true).');
        }

        // Read the target event sheet
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }
        const beforeEvents = snapshotEvents(sheet.events);

        // Collect all objectClass references from entire tree (parent + descendants)
        const allRefs: ObjectRef[] = [];
        collectObjectRefs(
          args.conditions,
          args.actions as Array<Record<string, unknown>>,
          args.children,
          allRefs,
        );

        const { errors, warnings } = await validateObjectClasses(reader, allRefs);
        if (errors.length > 0) {
          return toolError(`Object class validation failed:\n${errors.join('\n')}`);
        }

        // Build the block event recursively (handles children, SIDs, safety limits)
        const counter = { count: 0, warnings: [] as string[] };
        const blockEvent = await buildBlockEvent(
          reader,
          idGen,
          {
            conditions: args.conditions,
            actions: args.actions,
            disabled: args.disabled,
            isElse: args.isElse,
            children: args.children,
          },
          1,
          counter,
        );
        warnings.push(...counter.warnings);
        const blockSid = blockEvent.sid as number;

        // Determine target events array
        let targetEvents: Record<string, unknown>[];
        const events = sheet.events as Record<string, unknown>[];

        if (args.groupPath) {
          const resolved = findGroupByPath(events, args.groupPath);
          if (!resolved) {
            const topGroups = events
              .filter(e => e.eventType === 'group')
              .map(e => e.title as string);
            const hint = topGroups.length > 0
              ? `\nAvailable top-level groups: ${topGroups.join(', ')}`
              : '\nNo groups found in this event sheet.';
            return toolError(`Group path "${args.groupPath}" not found in "${args.sheetName}".${hint}`);
          }
          targetEvents = resolved;
        } else {
          targetEvents = events;
        }

        // Insert at position
        if (args.position === 'start') {
          targetEvents.unshift(blockEvent);
        } else {
          targetEvents.push(blockEvent);
        }

        // Editor load-time rules, checked on the whole sheet so the insertion
        // context (the new block's ancestors) counts too
        const loadCheck = await checkLoadRulesBeforeWrite(reader, args.sheetName, beforeEvents, sheet.events);
        if (loadCheck.errors.length > 0) {
          sheet.events = beforeEvents;
          return toolError(loadRuleErrorMessage(loadCheck.errors));
        }
        warnings.push(...loadCheck.warnings);

        // Write back
        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          generatedSid: blockSid,
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[add_event_block] failed:', error);
        return toolError(`Error adding event block: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_event_sheet ───────────────────────────────────

  server.tool(
    'delete_event_sheet',
    'Delete an event sheet from the project (checks references first)',
    {
      name: z.string().max(200).describe('Event sheet name to delete'),
      force: z.boolean().optional().default(false).describe('If true, delete even if referenced (does NOT clean up references)'),
    },
    async (args) => {
      try {
        // Verify the event sheet exists
        const existing = await reader.listEventSheets();
        if (!existing.includes(args.name)) {
          return notFoundError('Event sheet', args.name, reader.findNearestName(args.name, 'eventsheets'), 'list_eventsheets');
        }

        // Check references via project index
        const index = await getProjectIndex(reader);

        // 1. Sheets that include this one
        const includedBy = index.eventSheetIncludedBy.get(args.name) || [];

        // 2. Layouts bound to this event sheet
        const boundLayouts: string[] = [];
        for (const [layoutName, sheetName] of index.layoutToEventSheet) {
          if (sheetName === args.name) {
            boundLayouts.push(layoutName);
          }
        }

        const hasRefs = includedBy.length > 0 || boundLayouts.length > 0;

        if (hasRefs && !args.force) {
          return toolResult({
            success: false,
            entity: args.name,
            category: 'eventsheet',
            action: 'delete_blocked',
            message: 'Event sheet is still referenced. Use force=true to delete anyway (references will NOT be cleaned up).',
            references: {
              includedBy,
              boundLayouts,
            },
          });
        }

        const warnings: string[] = [];
        if (hasRefs && args.force) {
          const refList = [...includedBy.map(s => `included by "${s}"`), ...boundLayouts.map(l => `bound to layout "${l}"`)];
          warnings.push(`Event sheet deleted but still referenced: ${refList.join(', ')}. References were NOT cleaned up.`);
        }

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.name);
        const backupPath = await writer.deleteEntityFile('eventSheets', args.name, subfolder);
        await writer.removeFromProject('eventSheets', args.name);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'eventsheet',
          action: 'deleted',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_event_sheet] failed:', error);
        return toolError(`Error deleting event sheet: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_event_from_sheet ────────────────────────────────

  server.tool(
    'delete_event_from_sheet',
    'Delete an event from an event sheet by SID (for blocks, groups, variables, functions) or by includeSheet name (for includes). Use get_eventsheet_details to find SIDs. A SID shared by several events in the sheet is refused with a list of candidates; pass eventPath to pick one.',
    {
      sheetName: z.string().max(200).describe('Target event sheet'),
      sid: z.number().int().positive().optional().describe('SID of the event to delete (for block, group, variable, function events)'),
      eventPath: eventPathSchema,
      includeSheet: z.string().max(200).optional().describe('For removing includes: the included sheet name'),
      dryRun: z.boolean().optional().default(false).describe('If true, report what would be deleted without actually deleting'),
      force: z.boolean().optional().default(false).describe('If true, delete function-blocks even if they have callers'),
    },
    async (args) => {
      try {
        // Validate exactly one identifier
        if ((args.sid === undefined) === (args.includeSheet === undefined)) {
          return toolError('Specify exactly one of: sid (for blocks/groups/variables/functions) or includeSheet (for includes).');
        }
        if (args.eventPath !== undefined && args.sid === undefined) {
          return toolError('eventPath picks one of several events that share a SID; pass it together with sid.');
        }

        // Read the event sheet
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        const events = sheet.events as Record<string, unknown>[];
        const warnings: string[] = [];

        // ── Include deletion path ──
        if (args.includeSheet !== undefined) {
          const matchIndex = events.findIndex(
            e => e.eventType === 'include' && e.includeSheet === args.includeSheet,
          );

          if (matchIndex === -1) {
            const currentIncludes = events
              .filter(e => e.eventType === 'include')
              .map(e => e.includeSheet as string);
            const hint = currentIncludes.length > 0
              ? `\nIncludes in "${args.sheetName}": ${currentIncludes.join(', ')}`
              : `\nNo includes found in "${args.sheetName}".`;
            return toolError(`No include for sheet "${args.includeSheet}" found in "${args.sheetName}".${hint}`);
          }

          if (args.dryRun) {
            return toolResult({
              success: true,
              dryRun: true,
              entity: args.sheetName,
              category: 'eventsheet',
              action: 'would_delete',
              deletedType: 'include',
              deletedTarget: args.includeSheet,
            });
          }

          events.splice(matchIndex, 1);

          const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
          const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
          resetProjectIndex();

          return toolResult({
            success: true,
            entity: args.sheetName,
            category: 'eventsheet',
            action: 'updated',
            deletedType: 'include',
            deletedTarget: args.includeSheet,
            warnings: warnings.length > 0 ? warnings : undefined,
            backupFile: backupPath,
          });
        }

        // ── SID deletion path ── (a SID shared by several events is refused, dry run included)
        const found = resolveEventBySid(events, args.sid!, {
          sheetName: args.sheetName,
          action: 'delete',
          eventPath: args.eventPath,
        });
        if ('error' in found) return toolError(found.error);

        const { event, parentArray, index, path } = found.match;
        const eventType = event.eventType as string;
        const childCount = countDescendants(event);

        // Check function-block references
        if (eventType === 'function-block' && !args.force) {
          const funcName = event.functionName as string;
          const projectIndex = await getProjectIndex(reader);
          const callers = projectIndex.functionCalls.get(funcName) || [];
          if (callers.length > 0) {
            return toolResult({
              success: false,
              entity: args.sheetName,
              category: 'eventsheet',
              action: 'delete_blocked',
              message: `Function "${funcName}" is called by ${callers.length} action(s). Use force=true to delete anyway.`,
              references: {
                callers: callers.map(c => ({ sheet: c.sheet, path: c.path })),
              },
            });
          }
        }

        // Report children for groups
        if (childCount > 0) {
          warnings.push(`Deleted ${eventType} contained ${childCount} child event(s) that were also removed.`);
        }

        if (args.dryRun) {
          return toolResult({
            success: true,
            dryRun: true,
            entity: args.sheetName,
            category: 'eventsheet',
            action: 'would_delete',
            deletedType: eventType,
            deletedSid: args.sid,
            eventPath: path,
            childrenCount: childCount,
            ...(eventType === 'group' ? { deletedTitle: event.title as string } : {}),
            ...(eventType === 'function-block' ? { deletedFunction: event.functionName as string } : {}),
          });
        }

        parentArray.splice(index, 1);

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult({
          ...result,
          deletedType: eventType,
          deletedSid: args.sid,
          eventPath: path,
          childrenRemoved: childCount,
        });
      } catch (error) {
        console.error('[delete_event_from_sheet] failed:', error);
        return toolError(`Error deleting event: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── remove_event_from_sheet ─────────────────────────────────

  server.tool(
    'remove_event_from_sheet',
    'Remove an include block from an event sheet by target sheet name. Use delete_event_from_sheet with a SID to remove other event types.',
    {
      sheetName: z.string().max(200).describe('Event sheet to modify'),
      includeSheet: z.string().max(200).describe('Name of the included sheet to remove'),
    },
    async (args) => {
      try {
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        const events = sheet.events as Record<string, unknown>[];
        const before = events.length;
        const filtered = events.filter(
          e => !(e.eventType === 'include' && e.includeSheet === args.includeSheet),
        );
        const removed = before - filtered.length;

        if (removed === 0) {
          const currentIncludes = events
            .filter(e => e.eventType === 'include')
            .map(e => e.includeSheet as string);
          const hint = currentIncludes.length > 0
            ? `\nIncludes in "${args.sheetName}": ${currentIncludes.join(', ')}`
            : `\nNo includes found in "${args.sheetName}".`;
          return toolError(`No include for sheet "${args.includeSheet}" found in "${args.sheetName}".${hint}`);
        }

        sheet.events = filtered as unknown as C3Event[];

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        return toolResult({
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          removedCount: removed,
          removedInclude: args.includeSheet,
          backupFile: backupPath,
        });
      } catch (error) {
        console.error('[remove_event_from_sheet] failed:', error);
        return toolError(`Error removing include: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_event_block_action ───────────────────────────────

  server.tool(
    'update_event_block_action',
    'Replace parameters on a single action within an existing event block. Identify the block by SID and the action by its 0-based index. Use get_eventsheet_details to find SIDs and action indices. A SID shared by several events in the sheet is refused with a list of candidates; pass eventPath to pick one. Parameters that would break a checked editor load-time rule (expression syntax, empty expressions) are refused.',
    {
      sheetName: z.string().max(200).describe('Target event sheet'),
      blockSid: z.number().int().positive().describe('SID of the block event containing the action'),
      eventPath: eventPathSchema,
      actionIndex: z.number().int().min(0).describe('0-based index of the action to update'),
      parameters: boundedRecord().describe('New parameter values — replaces existing parameters entirely (max 100 keys, depth 6)'),
    },
    async (args) => {
      try {
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        const events = sheet.events as Record<string, unknown>[];
        const found = resolveEventBySid(events, args.blockSid, {
          sheetName: args.sheetName,
          action: 'update',
          eventPath: args.eventPath,
        });
        if ('error' in found) return toolError(found.error);

        const { event, path } = found.match;
        const eventType = event.eventType as string;

        if (eventType !== 'block' && eventType !== 'function-block') {
          return toolError(`Event with SID ${args.blockSid} is a "${eventType}", not a block or function-block. Only block events have actions.`);
        }

        const actions = event.actions as Record<string, unknown>[];
        if (args.actionIndex < 0 || args.actionIndex >= actions.length) {
          return toolError(
            `Action index ${args.actionIndex} is out of range (block has ${actions.length} action(s), ` +
            `indices 0-${Math.max(0, actions.length - 1)}).`,
          );
        }

        const beforeEvents = snapshotEvents(sheet.events);
        const action = actions[args.actionIndex];
        action.parameters = args.parameters;
        // Don't re-emit a legacy "behavior-type" key on the edited action (issue #16)
        const warnings = await normalizeLegacyBehaviorKeys(reader, [{ ace: action, kind: 'action' }]);

        // Editor load-time rules (expression syntax, empty expressions)
        const loadCheck = await checkLoadRulesBeforeWrite(reader, args.sheetName, beforeEvents, sheet.events);
        if (loadCheck.errors.length > 0) {
          sheet.events = beforeEvents;
          return toolError(loadRuleErrorMessage(loadCheck.errors));
        }
        warnings.push(...loadCheck.warnings);

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        return toolResult({
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          updatedBlockSid: args.blockSid,
          eventPath: path,
          updatedActionIndex: args.actionIndex,
          actionId: action.id,
          ...(warnings.length > 0 ? { warnings } : {}),
          backupFile: backupPath,
        });
      } catch (error) {
        console.error('[update_event_block_action] failed:', error);
        return toolError(`Error updating action: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── move_events_between_sheets ──────────────────────────────

  server.tool(
    'move_events_between_sheets',
    'Copy (or move) top-level event blocks from one event sheet to another by SID. Set deleteSource=true to remove the events from the source sheet after copying (move semantics). SIDs and all nested children are preserved; the result warns when a copied SID then matches more than one event in the target sheet. A SID shared by several top-level events of the source is refused with a list of candidates; pass eventPaths to pick one. Runs the editor load-time gate over both sheets: moving an event that already breaks a load-time rule is allowed, copying it (deleteSource=false) is refused because it adds the problem to a second sheet.',
    {
      sourceSheet: z.string().max(200).describe('Event sheet to copy/move events from'),
      targetSheet: z.string().max(200).describe('Event sheet to copy/move events into'),
      sids: z.array(z.number().int().positive()).min(1).describe('SIDs of the top-level events to copy/move (each SID once)'),
      eventPaths: z.array(z.string().max(500)).max(100).optional().describe(
        'Only needed when a SID in sids matches more than one top-level event of the source sheet (the call is then refused with a list of candidates): ' +
        'the paths of the events you mean, e.g. ["events[4]"], one per ambiguous SID. Each must point at a top-level event whose SID is in sids.',
      ),
      deleteSource: z.boolean().optional().default(false).describe('If true, remove the events from the source sheet after copying (move semantics). A copy or move that would leave two event variables or function parameters whose names match ignoring case in one scope is refused, e.g. a copy of a global variable (its original keeps the name)'),
      targetGroupPath: z.string().max(500).optional().describe('Insert into a group in the target sheet by title path (e.g. "Movement > Collision")'),
      position: z.enum(['start', 'end']).optional().default('end').describe('Where to insert events in the target sheet or group'),
    },
    async (args) => {
      try {
        if (args.sourceSheet === args.targetSheet) {
          return toolError('sourceSheet and targetSheet must be different sheets.');
        }

        // Read source sheet
        let sourceSheetData: EventSheet;
        try {
          sourceSheetData = await reader.readEventSheet(args.sourceSheet);
        } catch {
          return notFoundError('Event sheet', args.sourceSheet, reader.findNearestName(args.sourceSheet, 'eventsheets'), 'list_eventsheets');
        }

        // Read target sheet
        let targetSheetData: EventSheet;
        try {
          targetSheetData = await reader.readEventSheet(args.targetSheet);
        } catch {
          return notFoundError('Event sheet', args.targetSheet, reader.findNearestName(args.targetSheet, 'eventsheets'), 'list_eventsheets');
        }

        const sourceEvents = sourceSheetData.events as Record<string, unknown>[];
        const targetEvents = targetSheetData.events as Record<string, unknown>[];

        // A SID listed twice would copy its event twice
        const repeated = [...new Set(args.sids.filter((sid, i) => args.sids.indexOf(sid) !== i))];
        if (repeated.length > 0) {
          return toolError(
            `sids lists ${repeated.map(sid => `SID ${sid}`).join(', ')} more than once. List each SID once; ` +
            'top-level events that share a SID are moved one per call, picked with eventPaths.',
          );
        }

        // eventPaths pick one of several top-level events sharing a SID
        const picked = new Map<number, number>(); // SID → index in the source's top-level events
        for (const eventPath of args.eventPaths ?? []) {
          const indices = parseEventPath(eventPath);
          if (!indices || indices.length !== 1) {
            return toolError(`eventPaths entry "${eventPath}" is not the path of a top-level event. Only top-level events can be moved; use the form events[3].`);
          }
          const event = sourceEvents[indices[0]] as Record<string, unknown> | undefined;
          const sid = typeof event === 'object' && event !== null ? event.sid : undefined;
          if (typeof sid !== 'number' || !args.sids.includes(sid)) {
            const what = typeof event === 'object' && event !== null
              ? `a ${String(event.eventType)}${typeof sid === 'number' ? ` with SID ${sid}` : ' without a SID'}`
              : 'no event';
            return toolError(`eventPaths entry "${eventPath}" points at ${what} in "${args.sourceSheet}", not at an event whose SID is listed in sids.`);
          }
          if (picked.has(sid) && picked.get(sid) !== indices[0]) {
            return toolError(`eventPaths names two events with SID ${sid}. Pick one per SID and move the other in a separate call.`);
          }
          picked.set(sid, indices[0]);
        }

        // Find each requested SID in the source top-level events only
        const eventsToMove: Record<string, unknown>[] = [];
        const notFoundSids: number[] = [];
        const ambiguous: Array<{ sid: number; matches: SidMatch[] }> = [];

        for (const sid of args.sids) {
          const pickedIndex = picked.get(sid);
          if (pickedIndex !== undefined) {
            eventsToMove.push(sourceEvents[pickedIndex]);
            continue;
          }
          const matches: SidMatch[] = [];
          sourceEvents.forEach((event, index) => {
            if (event.sid === sid) matches.push({ event, parentArray: sourceEvents, index, path: `events[${index}]`, depth: 0 });
          });
          if (matches.length === 0) {
            notFoundSids.push(sid);
          } else if (matches.length > 1) {
            ambiguous.push({ sid, matches });
          } else {
            eventsToMove.push(matches[0].event);
          }
        }

        if (notFoundSids.length > 0) {
          const summary = summarizeEvents(sourceEvents);
          return toolError(
            `SIDs not found as top-level events in "${args.sourceSheet}": ${notFoundSids.join(', ')}.\n\n` +
            `Only top-level events can be moved. Source sheet events:\n${summary}\n\n` +
            `Use get_eventsheet_details to see the full tree.`,
          );
        }

        if (ambiguous.length > 0) {
          return toolError(ambiguous.map(({ sid, matches }) => ambiguousSidMessage(args.sourceSheet, sourceEvents, sid, matches, {
            action: args.deleteSource ? 'move' : 'copy',
            argument: 'eventPaths (one entry per ambiguous SID)',
            scope: 'top-level',
          })).join('\n\n'));
        }

        // Source events are only replaced (never mutated), the target is edited in place
        const targetBefore = snapshotEvents(targetSheetData.events);

        // Determine target insertion array
        let insertTarget: Record<string, unknown>[];
        if (args.targetGroupPath) {
          const resolved = findGroupByPath(targetEvents, args.targetGroupPath);
          if (!resolved) {
            const topGroups = targetEvents
              .filter(e => e.eventType === 'group')
              .map(e => e.title as string);
            const hint = topGroups.length > 0
              ? `\nAvailable top-level groups in "${args.targetSheet}": ${topGroups.join(', ')}`
              : `\nNo groups found in "${args.targetSheet}".`;
            return toolError(`Group path "${args.targetGroupPath}" not found in "${args.targetSheet}".${hint}`);
          }
          insertTarget = resolved;
        } else {
          insertTarget = targetEvents;
        }

        // Deep-copy events to avoid reference aliasing between sheets
        const copiedEvents = eventsToMove.map(e => JSON.parse(JSON.stringify(e)) as Record<string, unknown>);

        // Insert into target
        if (args.position === 'start') {
          insertTarget.unshift(...copiedEvents);
        } else {
          insertTarget.push(...copiedEvents);
        }

        // If move semantics: remove exactly the copied events from source
        if (args.deleteSource) {
          const moved = new Set(eventsToMove);
          sourceSheetData.events = sourceEvents.filter(e => !moved.has(e)) as unknown as C3Event[];
        }

        // Event variable names: copies keep their names (the editor renames a
        // pasted variable whose name is taken), so refuse a copy or move that
        // would leave two names in one scope that the editor treats as the same
        const sheetsBefore = await readEventSheetsFresh(reader, [
          [args.sourceSheet, sourceEvents as unknown as C3Event[]],
          [args.targetSheet, targetBefore],
        ]);
        const sheetsAfter = new Map(sheetsBefore);
        sheetsAfter.set(args.sourceSheet, sourceSheetData.events);
        sheetsAfter.set(args.targetSheet, targetSheetData.events);
        const nameClashes = findNewEventVariableNameClashes(
          sheetsBefore, args.sourceSheet, eventsToMove as unknown as C3Event[],
          sheetsAfter, args.targetSheet, copiedEvents as unknown as C3Event[],
        );
        if (nameClashes.length > 0) {
          sourceSheetData.events = sourceEvents as unknown as C3Event[];
          targetSheetData.events = targetBefore;
          return toolError(movedEventVariableNameClashMessage(args.targetSheet, args.deleteSource, nameClashes));
        }

        // Editor load-time rules over both sheets: a copy of an event that
        // breaks a rule adds the problem to the target, a move only relocates it
        const loadCheck = await checkLoadRulesBeforeSheetPairWrite(reader, [
          { name: args.sourceSheet, before: sourceEvents as unknown as C3Event[], after: sourceSheetData.events },
          { name: args.targetSheet, before: targetBefore, after: targetSheetData.events },
        ]);
        if (loadCheck.errors.length > 0) {
          sourceSheetData.events = sourceEvents as unknown as C3Event[];
          targetSheetData.events = targetBefore;
          return toolError(loadRuleErrorMessage(loadCheck.errors));
        }

        // Copies keep their SIDs, so a copied event whose SID the target already
        // has leaves several events with that SID there. The editor opens such
        // sheets, so this is a warning, not a refusal.
        const warnings = [...loadCheck.warnings];
        const sharedSids = copiedSidsWarning(args.targetSheet, targetSheetData.events as unknown as Record<string, unknown>[], copiedEvents);
        if (sharedSids) warnings.push(sharedSids);

        // Write target sheet first, then source (if modified)
        const targetSubfolder = writer.getSubfolderForEntity('eventSheets', args.targetSheet);
        const targetBackup = await writer.writeEntityFile('eventSheets', args.targetSheet, targetSheetData, targetSubfolder);

        let sourceBackup: string | undefined;
        if (args.deleteSource) {
          const sourceSubfolder = writer.getSubfolderForEntity('eventSheets', args.sourceSheet);
          sourceBackup = await writer.writeEntityFile('eventSheets', args.sourceSheet, sourceSheetData, sourceSubfolder);
        }

        resetProjectIndex();

        return toolResult({
          success: true,
          sourceSheet: args.sourceSheet,
          targetSheet: args.targetSheet,
          movedSids: args.sids,
          movedCount: eventsToMove.length,
          deleteSource: args.deleteSource,
          backupFiles: [targetBackup, ...(sourceBackup ? [sourceBackup] : [])].filter(Boolean),
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      } catch (error) {
        console.error('[move_events_between_sheets] failed:', error);
        return toolError(`Error moving events: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_event_block ─────────────────────────────────────

  server.tool(
    'update_event_block',
    'Update an existing block event in an event sheet — modify action parameters, add/remove actions or conditions, toggle disabled state. Identify the block by its SID (use get_eventsheet_details to find it). A SID shared by several events in the sheet is refused with a list of candidates; pass eventPath to pick one.',
    {
      sheetName: z.string().max(200).describe('Target event sheet'),
      sid: z.number().int().positive().describe('SID of the block event to update'),
      eventPath: eventPathSchema,
      disabled: z.boolean().optional().describe('Enable or disable the entire block'),
      updateActions: z.array(z.object({
        index: z.number().int().min(0).describe('Action index (0-based)'),
        parameters: boundedRecord().optional().describe('New parameter values — merged with existing (max 100 keys, depth 6)'),
        disabled: z.boolean().optional().describe('Enable or disable this action'),
      })).optional().describe('Actions to update by index'),
      updateConditions: z.array(z.object({
        index: z.number().int().min(0).describe('Condition index (0-based)'),
        parameters: boundedRecord().optional().describe('New parameter values — merged with existing (max 100 keys, depth 6)'),
        isInverted: z.boolean().optional().describe('Toggle inversion'),
      })).optional().describe('Conditions to update by index'),
      addActions: z.array(actionSchema).optional().describe('Append new actions to the block'),
      addConditions: z.array(conditionSchema).optional().describe('Append new conditions to the block'),
      removeActionIndices: z.array(z.number().int().min(0)).optional().describe('Remove actions by index (0-based, applied before adds)'),
      removeConditionIndices: z.array(z.number().int().min(0)).optional().describe('Remove conditions by index (0-based, applied before adds)'),
    },
    async (args) => {
      try {
        // Validate at least one update is provided
        const hasUpdate = args.disabled !== undefined
          || (args.updateActions && args.updateActions.length > 0)
          || (args.updateConditions && args.updateConditions.length > 0)
          || (args.addActions && args.addActions.length > 0)
          || (args.addConditions && args.addConditions.length > 0)
          || (args.removeActionIndices && args.removeActionIndices.length > 0)
          || (args.removeConditionIndices && args.removeConditionIndices.length > 0);

        if (!hasUpdate) {
          return toolError('No updates provided. Specify at least one of: disabled, updateActions, updateConditions, addActions, addConditions, removeActionIndices, removeConditionIndices.');
        }

        // Read the event sheet
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        const events = sheet.events as Record<string, unknown>[];
        const beforeEvents = snapshotEvents(sheet.events);
        const found = resolveEventBySid(events, args.sid, {
          sheetName: args.sheetName,
          action: 'update',
          eventPath: args.eventPath,
        });
        if ('error' in found) return toolError(found.error);

        const { event, path } = found.match;
        const eventType = event.eventType as string;

        // Must be a block or function-block (not a group, variable, include, etc.)
        if (eventType !== 'block' && eventType !== 'function-block') {
          return toolError(`Event with SID ${args.sid} is a "${eventType}", not a block or function-block. Only block events can be updated with this tool.`);
        }

        const conditions = event.conditions as Record<string, unknown>[];
        const actions = event.actions as Record<string, unknown>[];
        const warnings: string[] = [];
        // Existing conditions/actions edited in place (checked for the legacy behavior key before writing)
        const touched: Array<{ ace: Record<string, unknown>; kind: 'condition' | 'action' }> = [];

        // ── Validate objectClasses of all additions up front, in one pass ──
        // (normalizes the deprecated behavior-type alias; throws on conflicting keys before anything changes)
        const addRefs: ObjectRef[] = [];
        collectObjectRefs(
          args.addConditions ?? [],
          (args.addActions ?? []) as Array<Record<string, unknown>>,
          [],
          addRefs,
        );
        if (addRefs.length > 0) {
          const { errors, warnings: valWarnings } = await validateObjectClasses(reader, addRefs);
          if (errors.length > 0) {
            return toolError(`Object class validation failed:\n${errors.join('\n')}`);
          }
          warnings.push(...valWarnings);
        }

        // ── Apply block-level disabled toggle ──
        if (args.disabled !== undefined) {
          if (args.disabled) {
            event.disabled = true;
          } else {
            delete event.disabled;
          }
        }

        // All index-based operations reference the ORIGINAL array positions.
        // Order: updates first (non-mutating on length), then removals (shrink array).
        // This ensures user-supplied indices are consistent across all operations.

        // ── Update existing conditions by index (merge parameters) ──
        if (args.updateConditions) {
          for (const upd of args.updateConditions) {
            if (upd.index < 0 || upd.index >= conditions.length) {
              return toolError(`Condition index ${upd.index} is out of range (block has ${conditions.length} condition(s), indices 0-${conditions.length - 1}).`);
            }
            const cond = conditions[upd.index];
            touched.push({ ace: cond, kind: 'condition' });
            if (upd.parameters) {
              cond.parameters = { ...(cond.parameters as Record<string, unknown> || {}), ...upd.parameters };
            }
            if (upd.isInverted !== undefined) {
              if (upd.isInverted) {
                cond.isInverted = true;
              } else {
                delete cond.isInverted;
              }
            }
          }
        }

        // ── Update existing actions by index (merge parameters) ──
        if (args.updateActions) {
          for (const upd of args.updateActions) {
            if (upd.index < 0 || upd.index >= actions.length) {
              return toolError(`Action index ${upd.index} is out of range (block has ${actions.length} action(s), indices 0-${actions.length - 1}).`);
            }
            const act = actions[upd.index];
            touched.push({ ace: act, kind: 'action' });
            if (upd.parameters) {
              act.parameters = { ...(act.parameters as Record<string, unknown> || {}), ...upd.parameters };
            }
            if (upd.disabled !== undefined) {
              if (upd.disabled) {
                act.disabled = true;
              } else {
                delete act.disabled;
              }
            }
          }
        }

        // ── Remove conditions by index (descending order to avoid index shifting) ──
        if (args.removeConditionIndices && args.removeConditionIndices.length > 0) {
          const sorted = [...new Set(args.removeConditionIndices)].sort((a, b) => b - a);
          for (const idx of sorted) {
            if (idx < 0 || idx >= conditions.length) {
              return toolError(`Condition index ${idx} is out of range (block has ${conditions.length} condition(s), indices 0-${conditions.length - 1}).`);
            }
            conditions.splice(idx, 1);
          }
        }

        // ── Remove actions by index (descending order) ──
        if (args.removeActionIndices && args.removeActionIndices.length > 0) {
          const sorted = [...new Set(args.removeActionIndices)].sort((a, b) => b - a);
          for (const idx of sorted) {
            if (idx < 0 || idx >= actions.length) {
              return toolError(`Action index ${idx} is out of range (block has ${actions.length} action(s), indices 0-${actions.length - 1}).`);
            }
            actions.splice(idx, 1);
          }
        }

        // ── Add new conditions (validated up front) ──
        if (args.addConditions && args.addConditions.length > 0) {
          for (const c of args.addConditions) {
            const condSid = await idGen.generateSid(reader);
            conditions.push(buildCondition(c, condSid));
          }
        }

        // ── Add new actions (validated up front) ──
        if (args.addActions && args.addActions.length > 0) {
          for (const a of args.addActions) {
            if ('type' in a && a.type === 'script') {
              const scriptAct: Record<string, unknown> = {
                type: 'script',
                script: a.script,
              };
              if (a.disabled) scriptAct.disabled = true;
              actions.push(scriptAct);
            } else if ('id' in a) {
              const actSid = await idGen.generateSid(reader);
              actions.push(buildStandardAction(a, actSid));
            }
          }
        }

        // Warn if all conditions were removed (checked after adds, not just removals)
        if (conditions.length === 0 && !event.isElse) {
          warnings.push('All conditions were removed — block will match unconditionally (always true).');
        }

        // Edited conditions/actions written by older versions may still carry
        // "behavior-type" (issue #16): normalize them instead of re-emitting it.
        warnings.push(...await normalizeLegacyBehaviorKeys(
          reader,
          touched.filter(t => (t.kind === 'condition' ? conditions : actions).includes(t.ace)),
        ));

        // Editor load-time rules, checked on the whole sheet so the block's
        // ancestors (an enclosing trigger or function) count too
        const loadCheck = await checkLoadRulesBeforeWrite(reader, args.sheetName, beforeEvents, sheet.events);
        if (loadCheck.errors.length > 0) {
          sheet.events = beforeEvents;
          return toolError(loadRuleErrorMessage(loadCheck.errors));
        }
        warnings.push(...loadCheck.warnings);

        // Write back
        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult({ ...result, eventPath: path });
      } catch (error) {
        console.error('[update_event_block] failed:', error);
        return toolError(`Error updating event block: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── fix_legacy_behavior_keys ───────────────────────────────

  server.tool(
    'fix_legacy_behavior_keys',
    'Repair event sheets written by older versions of this server: rename the legacy "behavior-type" key on conditions/actions to "behaviorType", the key Construct 3 reads. Without it C3 looks behavior ACEs up on the base plugin and fails to open the project ("missing action id"). Only names that match a behavior on the object or its families are renamed; the rest is reported. Dry run by default.',
    {
      dryRun: z.boolean().optional().default(true).describe('If true (default), only report what would change. Set false to rewrite the affected sheets (each is backed up first).'),
    },
    async (args) => {
      const writtenSheets: string[] = [];
      try {
        const sheetNames = await reader.listEventSheets();
        const unreadableSheets: string[] = [];
        const loaded: Array<{ sheetName: string; sheet: EventSheet }> = [];
        for (const sheetName of sheetNames) {
          try {
            const sheet = await reader.readEventSheet(sheetName);
            if (Array.isArray(sheet.events)) loaded.push({ sheetName, sheet });
          } catch {
            unreadableSheets.push(sheetName);
          }
        }

        // Load only the object types the legacy keys point at, then check each
        // name before renaming it: renaming turns the key into an active
        // behavior lookup, so a name C3 cannot resolve is reported instead.
        const referenced = new Set<string>();
        for (const { sheet } of loaded) {
          for (const hit of scanLegacyBehaviorKeys(sheet.events).fixable) {
            if (hit.objectClass) referenced.add(hit.objectClass);
          }
        }
        const lookup = await loadBehaviorLookup(reader, referenced);
        const resolve = (objectClass: string, behaviorName: string) => checkBehaviorName(objectClass, behaviorName, lookup);

        const sheets: Array<{
          sheetName: string;
          renamed: number;
          changes: LegacyBehaviorKeyHit[];
          changesTruncated?: boolean;
          unresolved?: LegacyBehaviorKeyConflict[];
          conflicts?: LegacyBehaviorKeyConflict[];
          scanTruncated?: boolean;
          backupFile?: string;
        }> = [];
        let totalRenamed = 0;
        let totalUnverified = 0;
        let totalUnresolved = 0;
        let totalConflicts = 0;
        const truncatedSheets: string[] = [];

        for (const { sheetName, sheet } of loaded) {
          const scan = scanLegacyBehaviorKeys(sheet.events, { apply: !args.dryRun, resolve });
          if (scan.truncated) truncatedSheets.push(sheetName);
          if (scan.fixable.length === 0 && scan.unresolved.length === 0 && scan.conflicts.length === 0) continue;

          const entry: (typeof sheets)[number] = {
            sheetName,
            renamed: scan.fixable.length,
            changes: scan.fixable.slice(0, MAX_REPORTED_CHANGES),
          };
          if (scan.fixable.length > MAX_REPORTED_CHANGES) entry.changesTruncated = true;
          if (scan.unresolved.length > 0) entry.unresolved = scan.unresolved;
          if (scan.conflicts.length > 0) entry.conflicts = scan.conflicts;
          if (scan.truncated) entry.scanTruncated = true;

          if (!args.dryRun && scan.fixable.length > 0) {
            const subfolder = writer.getSubfolderForEntity('eventSheets', sheetName);
            entry.backupFile = await writer.writeEntityFile('eventSheets', sheetName, sheet, subfolder);
            writtenSheets.push(sheetName);
          }

          totalRenamed += scan.fixable.length;
          totalUnverified += scan.fixable.filter(h => h.warning).length;
          totalUnresolved += scan.unresolved.length;
          totalConflicts += scan.conflicts.length;
          sheets.push(entry);
        }

        if (writtenSheets.length > 0) resetProjectIndex();

        const parts: string[] = [];
        if (totalRenamed > 0) {
          const verb = args.dryRun ? 'would be renamed' : 'renamed';
          parts.push(`${totalRenamed} condition(s)/action(s) in ${sheets.filter(s => s.renamed > 0).length} sheet(s) ${verb} from "behavior-type" to "behaviorType".`);
          if (totalUnverified > 0) {
            parts.push(`${totalUnverified} of them could not be checked against the object's behaviors (see the warning on each change).`);
          }
        }
        if (totalUnresolved > 0) {
          parts.push(`${totalUnresolved} condition(s)/action(s) were left untouched because their "behavior-type" value matches no behavior on the object or its families (see unresolved) — set "behaviorType" to the behavior's name by hand.`);
        }
        if (totalConflicts > 0) {
          parts.push(`${totalConflicts} condition(s)/action(s) were left untouched because their keys conflict or hold no behavior name (see conflicts) — resolve them by hand.`);
        }
        if (parts.length === 0) {
          parts.push(unreadableSheets.length > 0
            ? `No legacy "behavior-type" keys found in the ${loaded.length} readable sheet(s).`
            : 'No legacy "behavior-type" keys found.');
        }
        if (unreadableSheets.length > 0) {
          parts.push(`${unreadableSheets.length} sheet(s) could not be read and were not checked: ${unreadableSheets.join(', ')}.`);
        }
        if (truncatedSheets.length > 0) {
          parts.push(`The scan stopped at its size limit in ${truncatedSheets.join(', ')}; some conditions/actions there were not checked.`);
        }
        if (args.dryRun && totalRenamed > 0) {
          parts.push('Run again with dryRun: false to apply.');
        }

        return toolResult({
          success: true,
          dryRun: args.dryRun,
          category: 'eventsheet',
          action: args.dryRun ? 'would_fix' : 'fixed',
          sheetsScanned: loaded.length,
          totalRenamed,
          totalUnresolved,
          totalConflicts,
          sheets,
          ...(unreadableSheets.length > 0 ? { unreadableSheets } : {}),
          message: parts.join(' '),
          // A run with nothing to rename writes no sheet: no editor reload note
        }, { projectWritten: writtenSheets.length > 0 });
      } catch (error) {
        console.error('[fix_legacy_behavior_keys] failed:', error);
        const partial = writtenSheets.length > 0
          ? ` Sheets already rewritten before the failure: ${writtenSheets.join(', ')}.`
          : '';
        return toolError(`Error fixing legacy behavior keys: ${error instanceof Error ? error.message : String(error)}${partial}`);
      }
    }
  );

  // ─── update_event_variable ────────────────────────────────

  server.tool(
    'update_event_variable',
    'Update an existing event variable declaration (rename, change type, change initial value). A SID shared by several events in the sheet is refused with a list of candidates; pass eventPath to pick one.',
    {
      sheetName: z.string().max(200).describe('Event sheet containing the variable'),
      sid: z.number().int().describe('SID of the variable event to update'),
      eventPath: eventPathSchema,
      newName: z.string().max(200).optional().describe('New variable name. Refused like in the editor: a name that matches, ignoring case, an event variable or function parameter in the variable\'s scope (for a global variable: anywhere in the project) or a System expression, or that has whitespace, punctuation such as - . : or a leading underscore'),
      newType: z.enum(['number', 'string', 'boolean']).optional().describe('New variable type'),
      newInitialValue: z.string().max(1000).optional().describe('New initial value (as string — use "0", "false", or "" for defaults)'),
      isStatic: z.boolean().optional().describe('Mark as static (value persists between calls)'),
      isConstant: z.boolean().optional().describe('Mark as constant (cannot be changed at runtime)'),
    },
    async (args) => {
      try {
        const hasUpdates = args.newName !== undefined || args.newType !== undefined ||
          args.newInitialValue !== undefined || args.isStatic !== undefined || args.isConstant !== undefined;
        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: newName, newType, newInitialValue, isStatic, isConstant.');
        }

        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        // Find the variable event by SID (search flat and nested)
        const found = resolveEventBySid(sheet.events as Record<string, unknown>[], args.sid, {
          sheetName: args.sheetName,
          action: 'update',
          eventPath: args.eventPath,
        });
        if ('error' in found) return toolError(found.error);
        const findResult = found.match;
        if (findResult.event.eventType !== 'variable') {
          return toolError(`Event SID ${args.sid} is a "${findResult.event.eventType}" event, not a variable event.`);
        }

        const varEvent = findResult.event as unknown as import('../construct3/types.js').VariableEvent;

        // Check the new name against the variable's scope, as the editor does;
        // changing the case of this variable's own name is fine
        if (args.newName !== undefined && args.newName !== varEvent.name) {
          const parents = findEnclosingEvents(sheet.events, findResult.event as C3Event) ?? [];
          const sheets = await readEventSheetsFresh(reader, [[args.sheetName, sheet.events]]);
          const nameError = eventVariableNameError(
            sheets, args.sheetName, parents, args.newName, findResult.event as C3Event);
          if (nameError) return toolError(nameError);
          varEvent.name = args.newName;
        }

        if (args.newType !== undefined) varEvent.type = args.newType;
        if (args.newInitialValue !== undefined) varEvent.initialValue = args.newInitialValue;
        if (args.isStatic !== undefined) varEvent.isStatic = args.isStatic;
        if (args.isConstant !== undefined) varEvent.isConstant = args.isConstant;

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult({ ...result, eventPath: findResult.path });
      } catch (error) {
        console.error('[update_event_variable] failed:', error);
        return toolError(`Error updating event variable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}

/** SIDs listed in the copied-SIDs warning; the rest are counted. */
const MAX_LISTED_SHARED_SIDS = 10;

/**
 * Warning for events copied into a sheet (already inserted there) whose SIDs,
 * or those of their sub-events, now match more than one event of that sheet,
 * or undefined when every copied SID is unique there. Such SIDs are refused by
 * the SID-based tools in that sheet unless an eventPath picks one.
 */
function copiedSidsWarning(
  sheetName: string,
  sheetEvents: Record<string, unknown>[],
  copiedEvents: Record<string, unknown>[],
): string | undefined {
  let shared: Map<number, string[]>;
  try {
    shared = eventSidsMatchingSeveral(sheetEvents, collectEventSids(copiedEvents));
  } catch {
    return undefined; // Past the traversal limits: skip the warning, it must not block the write
  }
  if (shared.size === 0) return undefined;

  const entries = [...shared].map(([sid, paths]) => `SID ${sid} at ${paths.join(', ')}`);
  const listed = entries.slice(0, MAX_LISTED_SHARED_SIDS).join('; ');
  const more = entries.length > MAX_LISTED_SHARED_SIDS ? `; and ${entries.length - MAX_LISTED_SHARED_SIDS} more` : '';
  const one = shared.size === 1;
  return (
    `${one ? 'A SID' : `${shared.size} SIDs`} of the copied events now ${one ? 'matches' : 'match'} more than one event in "${sheetName}", ` +
    `because copied events keep their SIDs: ${listed}${more}. ` +
    `update_event_block, update_event_block_action, update_event_variable and delete_event_from_sheet refuse ${one ? 'this SID' : 'these SIDs'} ` +
    `in "${sheetName}" unless eventPath names one of the events.`
  );
}

/**
 * The events of every event sheet registered in the project, read from disk
 * rather than from the reader's cache (which does not see sheets saved
 * outside this server since its last write), with `overrides` (sheet name and
 * events) in place of the saved events. Unreadable sheets are skipped, as in
 * readAllEventSheets.
 */
async function readEventSheetsFresh(
  reader: MutationToolDeps['reader'],
  overrides: ReadonlyArray<readonly [string, C3Event[]]>,
): Promise<Map<string, C3Event[]>> {
  const sheets = new Map<string, C3Event[]>();
  for (const name of await reader.listEventSheets()) {
    try {
      const data = await reader.readEventSheet(name);
      if (Array.isArray(data.events)) sheets.set(name, data.events);
    } catch {
      // Skip unreadable sheets
    }
  }
  for (const [name, events] of overrides) sheets.set(name, events);
  return sheets;
}

/** The scope rules of the editor's Event variable and Function parameter dialogs, for error messages. */
const NAME_SCOPE_RULE = {
  global: 'Construct 3 requires a global variable name to differ, ignoring case, from every event variable and ' +
    'function parameter in the project.',
  local: 'Construct 3 requires a local variable name to differ, ignoring case, from every global variable, from the ' +
    'variables and function parameters of the events enclosing it and from those below its parent event.',
  parameter: 'Construct 3 requires a function parameter name to differ, ignoring case, from every global variable, ' +
    'from the other parameters of its function and from the variables below the function.',
};

/**
 * Error text for an event variable or function parameter name the editor
 * would refuse. `scopeRule` is one of NAME_SCOPE_RULE.
 */
function eventVariableNameMessage(
  problem: EventVariableNameProblem,
  name: string,
  what: 'event variable' | 'function parameter',
  scopeRule: string,
): string {
  const article = what === 'event variable' ? 'an' : 'a';
  if (problem.problem === 'invalid') {
    return `"${name}" is not a valid ${what} name: ${problem.reason}. Construct 3 does not accept whitespace, ` +
      'the characters . , " ( ) ? : \\ / ; * | \' - ` ! $ % ^ & + = < > { } [ ] @ # ~ ¬ £, the soft hyphen, ' +
      'the ideographic full stop 。, the full-width forms ， （ ） ？ ： of , ( ) ? :, ' +
      'the typographic double quotes “ ”, a leading underscore or a name made only of digits. ' +
      'Choose a different name.';
  }
  if (problem.problem === 'system-expression') {
    const newer = SYSTEM_EXPRESSIONS_NOT_IN_R449.has(problem.expression)
      ? ' Newer Construct 3 releases such as r495.2 have this System expression (r449 does not have it) and'
      : ' Construct 3';
    return `"${name}" is the name of the System expression "${problem.expression}"` +
      `${problem.expression === name ? '' : ' (ignoring case)'}.${newer} does not accept ${article} ${what} ` +
      'named like a System expression. Choose a different name.';
  }
  const { use } = problem;
  if (use.name === name) {
    return `A ${use.kind} named "${name}" already exists in sheet "${use.sheet}". ${scopeRule}`;
  }
  const kind = use.kind === 'variable' ? 'event variable' : 'function parameter';
  return `Sheet "${use.sheet}": ${caseClashError(kind, name, use.name)} ${scopeRule}`;
}

/**
 * Why the editor would refuse `name` for an event variable declared in sheet
 * `sheetName` under `parents` (the enclosing events, outermost first; empty
 * for a global variable), or undefined when it would accept it. `sheets` holds
 * the events of every event sheet (from readEventSheetsFresh); `self` is the
 * variable being renamed. See construct3/event-variable-names.ts for the rules.
 */
function eventVariableNameError(
  sheets: ReadonlyMap<string, readonly C3Event[]>,
  sheetName: string,
  parents: readonly C3Event[],
  name: string,
  self?: C3Event,
): string | undefined {
  const ownName = self ? (self as { name?: unknown }).name : undefined;
  const problem = findEventVariableNameProblem(
    name,
    eventVariableNameUses(sheets, sheetName, parents, self),
    typeof ownName === 'string' ? ownName : undefined,
  );
  if (!problem) return undefined;
  return eventVariableNameMessage(problem, name, 'event variable',
    parents.length === 0 ? NAME_SCOPE_RULE.global : NAME_SCOPE_RULE.local);
}

/**
 * Why the editor would refuse the parameter `names` of a new function that
 * goes to the top level of sheet `sheetName`, checked in order like the
 * editor's Function parameter dialog when the parameters are added one by
 * one; undefined when it would accept them all. `sheets` holds the events of
 * every event sheet (from readEventSheetsFresh).
 */
function functionParameterNamesError(
  sheets: ReadonlyMap<string, readonly C3Event[]>,
  sheetName: string,
  names: readonly string[],
): string | undefined {
  // The new function has no enclosing events and no sub-events yet, so a
  // parameter's scope is every global variable and the parameters before it
  const fn = { eventType: 'function-block', functionParameters: [] as Array<{ name: string }>, children: [] };
  for (const name of names) {
    const problem = findEventVariableNameProblem(name, eventVariableNameUses(sheets, sheetName, [fn as unknown as C3Event]));
    if (problem?.problem === 'in-use' && problem.use.kind === 'function parameter') {
      return problem.use.name === name
        ? `functionParams lists "${name}" more than once. ${NAME_SCOPE_RULE.parameter}`
        : `functionParams lists "${problem.use.name}" and "${name}", which differ only in case. Construct 3 treats ` +
          `them as the same function parameter name. ${NAME_SCOPE_RULE.parameter}`;
    }
    if (problem) return eventVariableNameMessage(problem, name, 'function parameter', NAME_SCOPE_RULE.parameter);
    fn.functionParameters.push({ name });
  }
  return undefined;
}

/** Error text for copied or moved events whose variable or parameter names clash in their new scope. */
function movedEventVariableNameClashMessage(
  targetSheet: string,
  deleteSource: boolean,
  clashes: readonly NewEventVariableNameClash[],
): string {
  const MAX_LISTED = 10;
  const lines = clashes.slice(0, MAX_LISTED).map(({ declaration, use }) => {
    const what = declaration.kind === 'function parameter'
      ? 'function parameter'
      : declaration.parents.length === 0 ? 'global variable' : 'local variable';
    const other = use.kind === 'variable' ? 'event variable' : 'function parameter';
    const relation = use.name === declaration.name ? 'has the same name as' : 'differs only in case from';
    return `- the ${what} "${declaration.name}" ${relation} the ${other} "${use.name}" in sheet "${use.sheet}"`;
  });
  if (clashes.length > MAX_LISTED) lines.push(`- and ${clashes.length - MAX_LISTED} more`);
  return `${deleteSource ? 'Moving' : 'Copying'} these events to "${targetSheet}" would put names that Construct 3 ` +
    'treats as the same (ignoring case) into one event variable scope:\n' +
    `${lines.join('\n')}\n\n` +
    'Construct 3 requires a global variable name to differ from every event variable and function parameter in ' +
    'the project, and a local variable or function parameter name to differ from every global variable, from those ' +
    'of the events enclosing it and from those below its parent event. The editor renames a pasted variable in this ' +
    'case; this tool keeps the names, so nothing was written. Rename one of them first (update_event_variable)' +
    `${deleteSource ? '' : ', or move a global variable to the other sheet (deleteSource: true) instead of copying it'}.`;
}
