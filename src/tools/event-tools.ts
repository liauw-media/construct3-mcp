/**
 * Event sheet tools: create_event_sheet, add_event_to_sheet, add_event_block, delete_event_sheet.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult } from '../construct3/types.js';
import { validateName, validateSubfolder, toolResult, toolError } from './shared.js';
import {
  conditionSchema,
  actionSchema,
  childEventSchema,
  findGroupByPath,
  validateObjectClasses,
  collectObjectRefs,
  buildBlockEvent,
  findEventBySid,
  countDescendants,
  summarizeEvents,
} from './event-helpers.js';
import { getProjectIndex, resetProjectIndex } from '../construct3/analyzers/index-builder.js';
import {
  createEmptySheet,
  createVariableEvent,
  createGroupEvent,
  createFunctionEvent,
  createIncludeEvent,
  createCommentEvent,
} from '../construct3/templates.js';

export function registerEventTools({ server, reader, writer, idGen }: MutationToolDeps) {
  // ─── create_event_sheet ───────────────────────────────────

  server.tool(
    'create_event_sheet',
    'Create a new event sheet in the project',
    {
      name: z.string().max(200).describe('Event sheet name'),
      subfolder: z.string().max(500).optional().describe('Subfolder path'),
      includeSheets: z.array(z.string()).optional().describe('Event sheets to auto-include'),
    },
    async (args) => {
      try {
        validateName(args.name);
        if (args.subfolder) validateSubfolder(args.subfolder);

        // Check uniqueness
        const existing = await reader.listEventSheets();
        if (existing.includes(args.name)) {
          return toolError(`Event sheet "${args.name}" already exists.`);
        }

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

        await writer.writeEntityFile('eventSheets', args.name, data, args.subfolder);
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
      })).optional().describe('For functions: parameter definitions'),
      variableName: z.string().max(200).optional().describe('For variables: variable name'),
      variableType: z.enum(['number', 'string', 'boolean']).optional().describe('For variables: variable type'),
      initialValue: z.string().max(500).optional().default('').describe('For variables: initial value'),
      includeSheet: z.string().max(200).optional().describe('For includes: sheet name to include'),
      commentText: z.string().max(2000).optional().describe('For comments: comment text'),
      position: z.enum(['start', 'end']).optional().default('end').describe('Where to insert the event'),
    },
    async (args) => {
      try {
        // Read existing sheet — preserves ALL original events and fields
        let sheet: Record<string, unknown>;
        try {
          sheet = await reader.readEventSheet(args.sheetName) as unknown as Record<string, unknown>;
        } catch {
          const suggestions = reader.findNearestName(args.sheetName, 'eventsheets');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_eventsheets to see all available names.';
          return toolError(`Event sheet "${args.sheetName}" not found.${hint}`);
        }

        let event: Record<string, unknown>;

        switch (args.eventType) {
          case 'group': {
            if (!args.title) return toolError('title is required for group events');
            const sid = await idGen.generateSid(reader);
            event = createGroupEvent(args.title, sid);
            break;
          }
          case 'function': {
            if (!args.functionName) return toolError('functionName is required for function events');
            const sid = await idGen.generateSid(reader);
            event = createFunctionEvent(args.functionName, sid, args.functionParams);
            // Replace placeholder parameter SIDs with properly generated ones
            const funcParams = event.functionParameters as Array<Record<string, unknown>>;
            for (const p of funcParams) {
              p.sid = await idGen.generateSid(reader);
            }
            break;
          }
          case 'variable': {
            if (!args.variableName) return toolError('variableName is required for variable events');
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

        const events = sheet.events as Record<string, unknown>[];
        if (args.position === 'start') {
          events.unshift(event);
        } else {
          events.push(event);
        }

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error adding event: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_event_block ──────────────────────────────────────

  server.tool(
    'add_event_block',
    'Add a block event (conditions + actions) to an event sheet — the core of gameplay logic. Supports sub-events, else blocks, OR conditions, and per-action disabling.',
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
        let sheet: Record<string, unknown>;
        try {
          sheet = await reader.readEventSheet(args.sheetName) as unknown as Record<string, unknown>;
        } catch {
          const suggestions = reader.findNearestName(args.sheetName, 'eventsheets');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_eventsheets to see all available names.';
          return toolError(`Event sheet "${args.sheetName}" not found.${hint}`);
        }

        // Collect all objectClass references from entire tree (parent + descendants)
        const allRefs: Array<{ objectClass: string; 'behavior-type'?: string }> = [];
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
          const suggestions = reader.findNearestName(args.name, 'eventsheets');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_eventsheets to see all available names.';
          return toolError(`Event sheet "${args.name}" not found.${hint}`);
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
        return toolError(`Error deleting event sheet: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_event_from_sheet ────────────────────────────────

  server.tool(
    'delete_event_from_sheet',
    'Delete an event from an event sheet by SID (for blocks, groups, variables, functions) or by includeSheet name (for includes). Use get_eventsheet_details to find SIDs.',
    {
      sheetName: z.string().max(200).describe('Target event sheet'),
      sid: z.number().int().positive().optional().describe('SID of the event to delete (for block, group, variable, function events)'),
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

        // Read the event sheet
        let sheet: Record<string, unknown>;
        try {
          sheet = await reader.readEventSheet(args.sheetName) as unknown as Record<string, unknown>;
        } catch {
          const suggestions = reader.findNearestName(args.sheetName, 'eventsheets');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_eventsheets to see all available names.';
          return toolError(`Event sheet "${args.sheetName}" not found.${hint}`);
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

        // ── SID deletion path ──
        const found = findEventBySid(events, args.sid!);

        if (!found) {
          const summary = summarizeEvents(events);
          return toolError(
            `Event with SID ${args.sid} not found in sheet "${args.sheetName}".\n\n` +
            `Sheet "${args.sheetName}" contains ${events.length} top-level events:\n${summary}\n\n` +
            `Use get_eventsheet_details to see the full event tree with SIDs.`,
          );
        }

        const { event, parentArray, index } = found;
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
          childrenRemoved: childCount,
        });
      } catch (error) {
        return toolError(`Error deleting event: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_event_block ─────────────────────────────────────

  server.tool(
    'update_event_block',
    'Update an existing block event in an event sheet — modify action parameters, add/remove actions or conditions, toggle disabled state. Identify the block by its SID (use get_eventsheet_details to find it).',
    {
      sheetName: z.string().max(200).describe('Target event sheet'),
      sid: z.number().int().positive().describe('SID of the block event to update'),
      disabled: z.boolean().optional().describe('Enable or disable the entire block'),
      updateActions: z.array(z.object({
        index: z.number().int().min(0).describe('Action index (0-based)'),
        parameters: z.record(z.unknown()).optional().describe('New parameter values (merged with existing)'),
        disabled: z.boolean().optional().describe('Enable or disable this action'),
      })).optional().describe('Actions to update by index'),
      updateConditions: z.array(z.object({
        index: z.number().int().min(0).describe('Condition index (0-based)'),
        parameters: z.record(z.unknown()).optional().describe('New parameter values (merged with existing)'),
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
        let sheet: Record<string, unknown>;
        try {
          sheet = await reader.readEventSheet(args.sheetName) as unknown as Record<string, unknown>;
        } catch {
          const suggestions = reader.findNearestName(args.sheetName, 'eventsheets');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_eventsheets to see all available names.';
          return toolError(`Event sheet "${args.sheetName}" not found.${hint}`);
        }

        const events = sheet.events as Record<string, unknown>[];
        const found = findEventBySid(events, args.sid);

        if (!found) {
          const summary = summarizeEvents(events);
          return toolError(
            `Event with SID ${args.sid} not found in sheet "${args.sheetName}".\n\n` +
            `Sheet "${args.sheetName}" contains ${events.length} top-level events:\n${summary}\n\n` +
            `Use get_eventsheet_details to see the full event tree with SIDs.`,
          );
        }

        const { event } = found;
        const eventType = event.eventType as string;

        // Must be a block or function-block (not a group, variable, include, etc.)
        if (eventType !== 'block' && eventType !== 'function-block') {
          return toolError(`Event with SID ${args.sid} is a "${eventType}", not a block or function-block. Only block events can be updated with this tool.`);
        }

        const conditions = event.conditions as Record<string, unknown>[];
        const actions = event.actions as Record<string, unknown>[];
        const warnings: string[] = [];

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

        // ── Add new conditions ──
        if (args.addConditions && args.addConditions.length > 0) {
          // Validate objectClasses
          const refs = args.addConditions.map(c => ({
            objectClass: c.objectClass,
            'behavior-type': c['behavior-type'],
          }));
          const { errors, warnings: valWarnings } = await validateObjectClasses(reader, refs);
          if (errors.length > 0) {
            return toolError(`Object class validation failed:\n${errors.join('\n')}`);
          }
          warnings.push(...valWarnings);

          for (const c of args.addConditions) {
            const condSid = await idGen.generateSid(reader);
            const built: Record<string, unknown> = {
              id: c.id,
              objectClass: c.objectClass,
              sid: condSid,
            };
            if (c['behavior-type']) built['behavior-type'] = c['behavior-type'];
            if (c.parameters) built.parameters = c.parameters;
            if (c.isInverted) built.isInverted = true;
            if (c.isOr) built.isOr = true;
            conditions.push(built);
          }
        }

        // ── Add new actions ──
        if (args.addActions && args.addActions.length > 0) {
          // Validate objectClasses for standard actions
          const refs: Array<{ objectClass: string; 'behavior-type'?: string }> = [];
          for (const a of args.addActions) {
            if ('objectClass' in a && typeof a.objectClass === 'string') {
              refs.push({ objectClass: a.objectClass, 'behavior-type': a['behavior-type'] });
            }
          }
          if (refs.length > 0) {
            const { errors, warnings: valWarnings } = await validateObjectClasses(reader, refs);
            if (errors.length > 0) {
              return toolError(`Object class validation failed:\n${errors.join('\n')}`);
            }
            warnings.push(...valWarnings);
          }

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
              const built: Record<string, unknown> = {
                id: a.id,
                objectClass: a.objectClass,
                sid: actSid,
              };
              if (a['behavior-type']) built['behavior-type'] = a['behavior-type'];
              if (a.parameters) built.parameters = a.parameters;
              if (a.callFunction) built.callFunction = a.callFunction;
              if (a.disabled) built.disabled = true;
              actions.push(built);
            }
          }
        }

        // Warn if all conditions were removed (checked after adds, not just removals)
        if (conditions.length === 0 && !event.isElse) {
          warnings.push('All conditions were removed — block will match unconditionally (always true).');
        }

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
        return toolResult(result);
      } catch (error) {
        return toolError(`Error updating event block: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
