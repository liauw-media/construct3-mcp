/**
 * MCP Tools for Safe Modifications (Phases 3-5).
 * 14 write tools for creating, updating, and deleting C3 project entities,
 * including event block creation, animation management, and layout/event sheet lifecycle.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { Construct3ProjectWriter } from '../construct3/project-writer.js';
import type { IdGenerator } from '../construct3/id-generator.js';
import type { WriteResult } from '../construct3/types.js';
import { getProjectIndex } from '../construct3/analyzers/index-builder.js';
import {
  GLOBAL_PLUGINS,
  NONWORLD_GLOBAL_PLUGINS,
  RESERVED_NAMES,
  DEFAULT_INSTANCE_PROPERTIES,
  createSpriteObject,
  createTextObject,
  createTiledBgObject,
  createGlobalObject,
  createGenericObject,
  createInstanceVariable,
  createBehavior,
  createEmptySheet,
  createVariableEvent,
  createGroupEvent,
  createFunctionEvent,
  createIncludeEvent,
  createCommentEvent,
  createBlockEvent,
  createAnimation,
  createAnimationFrame,
  createLayout,
  createInstance,
} from '../construct3/templates.js';

/** Validate that a name is safe for use as a filename and C3 identifier. */
function validateName(name: string): void {
  if (!name || name.length === 0) {
    throw new Error('Name cannot be empty');
  }
  if (name.length > 200) {
    throw new Error('Name too long (max 200 characters)');
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_ ]*$/.test(name)) {
    throw new Error('Name must start with a letter or underscore and contain only alphanumeric characters, underscores, and spaces');
  }
  // Path traversal check
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error('Name contains invalid path characters');
  }
  // Reserved name check
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`"${name}" is a reserved name in Construct 3 and cannot be used`);
  }
}

/** Validate a subfolder path is safe. */
function validateSubfolder(subfolder: string): void {
  if (subfolder.includes('..') || subfolder.includes('\\') || subfolder.startsWith('/')) {
    throw new Error('Subfolder path contains invalid characters (use forward slashes only, no "..")');
  }
  const parts = subfolder.split('/');
  for (const part of parts) {
    if (part.length === 0 || part === '.' || part === '..') {
      throw new Error('Subfolder path contains invalid segments');
    }
  }
}

function toolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function toolError(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true as const,
  };
}

/** Traverse event tree to find a group by title path (e.g., "Movement > Collision").
 *  Two-pass: verify the full path resolves before mutating any data. */
function findGroupByPath(
  events: Record<string, unknown>[],
  groupPath: string,
): Record<string, unknown>[] | null {
  const segments = groupPath.split('>').map(s => s.trim());

  // First pass: verify all segments resolve without mutating
  let current = events;
  const groups: Array<Record<string, unknown>> = [];
  for (const seg of segments) {
    const group = current.find(
      (e) => e.eventType === 'group' && e.title === seg,
    ) as Record<string, unknown> | undefined;
    if (!group) return null;
    groups.push(group);
    current = Array.isArray(group.children) ? group.children as Record<string, unknown>[] : [];
  }

  // Full path resolved — ensure all groups have children arrays
  for (const g of groups) {
    if (!Array.isArray(g.children)) g.children = [];
  }

  return groups[groups.length - 1].children as Record<string, unknown>[];
}

/** Validate objectClass references against project objects, families, and "System". */
async function validateObjectClasses(
  reader: Construct3ProjectReader,
  refs: Array<{ objectClass: string; 'behavior-type'?: string }>,
): Promise<{ errors: string[]; warnings: string[] }> {
  const objects = await reader.listObjectTypes();
  let families: string[] = [];
  try {
    families = await reader.listFamilies();
  } catch {
    // families may not exist in all projects
  }
  const validClasses = new Set([...objects, ...families, 'System']);

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const ref of refs) {
    if (!validClasses.has(ref.objectClass)) {
      const suggestions = reader.findNearestName(ref.objectClass, 'objects');
      const hint = suggestions.length > 0
        ? ` Did you mean: ${suggestions.join(', ')}?`
        : '';
      errors.push(`Unknown objectClass "${ref.objectClass}".${hint}`);
    }
    if (ref['behavior-type']) {
      // Soft validate: warn but allow (behavior may come from families or third-party plugins)
      warnings.push(`Behavior-type "${ref['behavior-type']}" on "${ref.objectClass}" was not validated — ensure it exists on the object or its families.`);
    }
  }

  return { errors, warnings };
}

export function registerMutationTools(
  server: McpServer,
  reader: Construct3ProjectReader,
  writer: Construct3ProjectWriter,
  idGen: IdGenerator,
) {
  // ─── Tool 1: create_object ─────────────────────────────────

  server.tool(
    'create_object',
    'Create a new object type in the Construct3 project',
    {
      name: z.string().max(200).describe('Object name (must be unique, alphanumeric + underscore)'),
      pluginId: z.string().max(100).describe('Plugin ID — "Sprite", "Text", "TiledBg", "NinePatch", "Audio", etc.'),
      isGlobal: z.boolean().optional().default(false).describe('Whether object is global (auto-detected for known global plugins)'),
      subfolder: z.string().max(500).optional().describe('Subfolder path in project (e.g., "UI/Buttons")'),
    },
    async (args) => {
      try {
        validateName(args.name);
        if (args.subfolder) validateSubfolder(args.subfolder);

        // Check uniqueness
        const existing = await reader.listObjectTypes();
        if (existing.includes(args.name)) {
          return toolError(`Object "${args.name}" already exists. Use update_object_properties to modify it.`);
        }

        // Ensure the plugin is registered in usedAddons
        const addonWarning = await writer.ensureAddonRegistered('plugin', args.pluginId);

        const sid = await idGen.generateSid(reader);
        const isSingleglobal = GLOBAL_PLUGINS.has(args.pluginId);
        const isNonworldGlobal = NONWORLD_GLOBAL_PLUGINS.has(args.pluginId);
        let data: Record<string, unknown>;
        let uid: number | undefined;

        if (isSingleglobal || (args.isGlobal && !isNonworldGlobal)) {
          uid = await idGen.generateUid(reader);
          const sgiSid = await idGen.generateSid(reader);
          data = createGlobalObject(args.name, args.pluginId, sid, uid, sgiSid);
        } else if (args.pluginId === 'Sprite') {
          const animSid = await idGen.generateSid(reader);
          data = createSpriteObject(args.name, sid, animSid);
        } else if (args.pluginId === 'Text') {
          data = createTextObject(args.name, sid);
        } else if (args.pluginId === 'TiledBg') {
          data = createTiledBgObject(args.name, sid);
        } else {
          data = createGenericObject(args.name, args.pluginId, sid);
          // Nonworld-global plugins (Arr, Json, Dictionary) are isGlobal but not singleglobal-inst
          if (isNonworldGlobal) {
            data.isGlobal = true;
          }
        }

        await writer.writeEntityFile('objectTypes', args.name, data, args.subfolder);
        await writer.addToProject('objectTypes', args.name, args.subfolder);

        const warnings: string[] = [];
        if (addonWarning) warnings.push(addonWarning);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'object',
          action: 'created',
          generatedSid: sid,
          generatedUid: uid,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error creating object: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── Tool 2: update_object_properties ──────────────────────

  server.tool(
    'update_object_properties',
    'Update properties of an existing object type (variables, behaviors, global status)',
    {
      name: z.string().max(200).describe('Existing object name'),
      isGlobal: z.boolean().optional().describe('Change global status'),
      addVariables: z.array(z.object({
        name: z.string().describe('Variable name'),
        type: z.enum(['number', 'string', 'boolean']).describe('Variable type'),
      })).optional().describe('Instance variables to add'),
      removeVariables: z.array(z.string()).optional().describe('Instance variable names to remove'),
      addBehaviors: z.array(z.object({
        behaviorId: z.string().describe('Behavior plugin ID (e.g., "Tween", "Sin", "Timer")'),
        name: z.string().describe('Behavior instance name'),
      })).optional().describe('Behaviors to add'),
      removeBehaviors: z.array(z.string()).optional().describe('Behavior names to remove'),
    },
    async (args) => {
      try {
        // Read existing object — preserves ALL original fields
        let obj: Record<string, unknown>;
        try {
          obj = await reader.readObjectType(args.name) as unknown as Record<string, unknown>;
        } catch {
          const suggestions = reader.findNearestName(args.name, 'objects');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_objects to see all available names.';
          return toolError(`Object "${args.name}" not found.${hint}`);
        }

        const warnings: string[] = [];

        // Update global status — use whichever key the object already has
        if (args.isGlobal !== undefined) {
          if ('isGlobal' in obj) {
            obj.isGlobal = args.isGlobal;
          } else {
            // Fallback: use the key name the real file uses (isGlobal is standard)
            obj.isGlobal = args.isGlobal;
          }
        }

        // Add variables
        if (args.addVariables && args.addVariables.length > 0) {
          if (!Array.isArray(obj.instanceVariables)) {
            obj.instanceVariables = [];
          }
          const vars = obj.instanceVariables as Array<Record<string, unknown>>;
          for (const v of args.addVariables) {
            if (vars.some(existing => existing.name === v.name)) {
              warnings.push(`Variable "${v.name}" already exists, skipping`);
              continue;
            }
            const sid = await idGen.generateSid(reader);
            vars.push(createInstanceVariable(v.name, v.type, sid));
          }
        }

        // Remove variables
        if (args.removeVariables && args.removeVariables.length > 0) {
          if (Array.isArray(obj.instanceVariables)) {
            const vars = obj.instanceVariables as Array<Record<string, unknown>>;
            for (const varName of args.removeVariables) {
              const idx = vars.findIndex(v => v.name === varName);
              if (idx !== -1) {
                vars.splice(idx, 1);
              } else {
                warnings.push(`Variable "${varName}" not found, skipping`);
              }
            }
          }
        }

        // Add behaviors
        if (args.addBehaviors && args.addBehaviors.length > 0) {
          // Validate all behavior addons are registered before making changes
          for (const b of args.addBehaviors) {
            const bWarning = await writer.ensureAddonRegistered('behavior', b.behaviorId);
            if (bWarning) warnings.push(bWarning);
          }

          if (!Array.isArray(obj.behaviorTypes)) {
            obj.behaviorTypes = [];
          }
          const behaviors = obj.behaviorTypes as Array<Record<string, unknown>>;
          for (const b of args.addBehaviors) {
            if (behaviors.some(existing => existing.name === b.name)) {
              warnings.push(`Behavior "${b.name}" already exists, skipping`);
              continue;
            }
            const sid = await idGen.generateSid(reader);
            behaviors.push(createBehavior(b.behaviorId, b.name, sid));
          }
        }

        // Remove behaviors
        if (args.removeBehaviors && args.removeBehaviors.length > 0) {
          if (Array.isArray(obj.behaviorTypes)) {
            const behaviors = obj.behaviorTypes as Array<Record<string, unknown>>;
            for (const bName of args.removeBehaviors) {
              const idx = behaviors.findIndex(b => b.name === bName);
              if (idx !== -1) {
                behaviors.splice(idx, 1);
              } else {
                warnings.push(`Behavior "${bName}" not found, skipping`);
              }
            }
          }
        }

        // Write updated object — preserves all original fields we didn't touch
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.name);
        const backupPath = await writer.writeEntityFile('objectTypes', args.name, obj, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'object',
          action: 'updated',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error updating object: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── Tool 3: delete_object ─────────────────────────────────

  server.tool(
    'delete_object',
    'Delete an object type from the project (checks references first)',
    {
      name: z.string().max(200).describe('Object name to delete'),
      force: z.boolean().optional().default(false).describe('If true, delete even if referenced (does NOT clean up references)'),
    },
    async (args) => {
      try {
        // Verify the object exists
        const existing = await reader.listObjectTypes();
        if (!existing.includes(args.name)) {
          const suggestions = reader.findNearestName(args.name, 'objects');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_objects to see all available names.';
          return toolError(`Object "${args.name}" not found.${hint}`);
        }

        // Check references
        const index = await getProjectIndex(reader);
        const eventSheetRefs = index.getEventSheetsForObject(args.name);
        const layoutRefs = index.objectToLayouts.get(args.name) || [];
        const familyRefs = index.objectToFamilies.get(args.name) || [];

        const hasRefs = eventSheetRefs.length > 0 || layoutRefs.length > 0 || familyRefs.length > 0;

        if (hasRefs && !args.force) {
          return toolResult({
            success: false,
            entity: args.name,
            category: 'object',
            action: 'delete_blocked',
            message: 'Object is still referenced. Use force=true to delete anyway (references will NOT be cleaned up).',
            references: {
              eventSheets: eventSheetRefs,
              layouts: layoutRefs,
              families: familyRefs,
            },
          });
        }

        const warnings: string[] = [];
        if (hasRefs && args.force) {
          warnings.push(`Object deleted but still referenced in: ${[...eventSheetRefs, ...layoutRefs].join(', ')}. References were NOT cleaned up.`);
        }

        const subfolder = writer.getSubfolderForEntity('objectTypes', args.name);
        const backupPath = await writer.deleteEntityFile('objectTypes', args.name, subfolder);
        await writer.removeFromProject('objectTypes', args.name);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'object',
          action: 'deleted',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error deleting object: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── Tool 4: create_event_sheet ────────────────────────────

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
        const data = createEmptySheet(args.name, sid) as { events: Record<string, unknown>[] };

        // Add include events
        if (args.includeSheets) {
          for (const sheet of args.includeSheets) {
            data.events.push(createIncludeEvent(sheet));
          }
        }

        await writer.writeEntityFile('eventSheets', args.name, data, args.subfolder);
        await writer.addToProject('eventSheets', args.name, args.subfolder);

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

  // ─── Tool 5: add_event_to_sheet ────────────────────────────

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

  // ─── Tool 6: add_event_block ──────────────────────────────

  // Condition schema shared by top-level and child events
  const conditionSchema = z.object({
    id: z.string().describe('Condition ACE id (kebab-case, e.g., "on-start-of-layout", "on-collision-with-another-object")'),
    objectClass: z.string().describe('Object name or "System"'),
    'behavior-type': z.string().optional().describe('Behavior type (e.g., "Platform", "8Direction")'),
    parameters: z.record(z.unknown()).optional().describe('Condition parameters as key-value pairs'),
    isInverted: z.boolean().optional().describe('Negate the condition'),
    isOr: z.boolean().optional().describe('OR-combine with previous condition (default: AND)'),
  });

  // Action schema shared by top-level and child events
  const standardActionSchema = z.object({
    id: z.string().describe('Action ACE id (kebab-case, e.g., "set-instvar-value", "destroy")'),
    objectClass: z.string().describe('Object name or "System"'),
    'behavior-type': z.string().optional().describe('Behavior type'),
    parameters: z.record(z.unknown()).optional().describe('Action parameters as key-value pairs'),
    callFunction: z.string().optional().describe('For function call actions'),
    disabled: z.boolean().optional().describe('Disable this individual action'),
  });

  const scriptActionSchema = z.object({
    type: z.literal('script').describe('Script action type'),
    script: z.string().describe('Inline JavaScript code'),
    disabled: z.boolean().optional().describe('Disable this individual script action'),
  });

  const actionSchema = z.union([standardActionSchema, scriptActionSchema]);

  // Recursive child event schema using z.lazy()
  interface ChildEventInput {
    conditions?: Array<z.infer<typeof conditionSchema>>;
    actions?: Array<z.infer<typeof standardActionSchema> | z.infer<typeof scriptActionSchema>>;
    disabled?: boolean;
    isElse?: boolean;
    children?: ChildEventInput[];
  }

  const childEventSchema: z.ZodType<ChildEventInput> = z.lazy(() => z.object({
    conditions: z.array(conditionSchema).optional().default([]),
    actions: z.array(actionSchema).optional().default([]),
    disabled: z.boolean().optional(),
    isElse: z.boolean().optional(),
    children: z.array(childEventSchema).optional().default([]),
  }));

  /** Safety limits for recursive event building */
  const MAX_NESTING_DEPTH = 5;
  const MAX_TOTAL_EVENTS = 50;
  const MAX_ITEMS_PER_BLOCK = 100;

  /** Collect all objectClass references from a block and all its descendants. */
  function collectObjectRefs(
    conditions: Array<{ objectClass: string; 'behavior-type'?: string }>,
    actions: Array<Record<string, unknown>>,
    children: ChildEventInput[],
    refs: Array<{ objectClass: string; 'behavior-type'?: string }>,
  ): void {
    for (const c of conditions) {
      refs.push({ objectClass: c.objectClass, 'behavior-type': c['behavior-type'] });
    }
    for (const a of actions) {
      if ('objectClass' in a && typeof a.objectClass === 'string') {
        refs.push({ objectClass: a.objectClass, 'behavior-type': a['behavior-type'] as string | undefined });
      }
    }
    for (const child of children) {
      collectObjectRefs(
        child.conditions ?? [],
        (child.actions ?? []) as Array<Record<string, unknown>>,
        child.children ?? [],
        refs,
      );
    }
  }

  /** Recursively build a block event with conditions, actions, and children.
   *  Returns the built block and the count of events created (for safety limit). */
  async function buildBlockEvent(
    block: {
      conditions: Array<z.infer<typeof conditionSchema>>;
      actions: Array<z.infer<typeof standardActionSchema> | z.infer<typeof scriptActionSchema>>;
      disabled?: boolean;
      isElse?: boolean;
      children: ChildEventInput[];
    },
    depth: number,
    counter: { count: number; warnings: string[] },
  ): Promise<Record<string, unknown>> {
    if (depth > MAX_NESTING_DEPTH) {
      throw new Error(`Sub-event nesting exceeds maximum depth of ${MAX_NESTING_DEPTH}`);
    }
    counter.count++;
    if (counter.count > MAX_TOTAL_EVENTS) {
      throw new Error(`Total event count exceeds maximum of ${MAX_TOTAL_EVENTS}`);
    }

    // Validate: non-else blocks must have at least one condition
    if (!block.isElse && block.conditions.length === 0) {
      throw new Error(`Non-else event block at depth ${depth} has no conditions. Add conditions or set isElse: true.`);
    }

    // Cap conditions and actions per block to prevent SID amplification
    if (block.conditions.length > MAX_ITEMS_PER_BLOCK) {
      throw new Error(`Block has ${block.conditions.length} conditions (max ${MAX_ITEMS_PER_BLOCK})`);
    }
    if (block.actions.length > MAX_ITEMS_PER_BLOCK) {
      throw new Error(`Block has ${block.actions.length} actions (max ${MAX_ITEMS_PER_BLOCK})`);
    }

    // Warn: isElse blocks with conditions (C3 ignores them)
    if (block.isElse && block.conditions.length > 0) {
      counter.warnings.push(`Else block at depth ${depth} has ${block.conditions.length} condition(s) — C3 ignores conditions on else blocks.`);
    }

    // Warn: isOr on the first condition is meaningless
    if (block.conditions.length > 0 && block.conditions[0].isOr) {
      counter.warnings.push(`First condition at depth ${depth} has isOr: true — this is ignored by C3 (no previous condition to OR with).`);
    }

    const blockSid = await idGen.generateSid(reader);

    // Build conditions with SIDs
    const builtConditions: Array<Record<string, unknown>> = [];
    for (const c of block.conditions) {
      const condSid = await idGen.generateSid(reader);
      const cond: Record<string, unknown> = {
        id: c.id,
        objectClass: c.objectClass,
        sid: condSid,
      };
      if (c['behavior-type']) cond['behavior-type'] = c['behavior-type'];
      if (c.parameters) cond.parameters = c.parameters;
      if (c.isInverted) cond.isInverted = true;
      if (c.isOr) cond.isOr = true;
      builtConditions.push(cond);
    }

    // Build actions with SIDs (or as script actions)
    const builtActions: Array<Record<string, unknown>> = [];
    for (const a of block.actions) {
      if ('type' in a && a.type === 'script') {
        const scriptAct: Record<string, unknown> = {
          type: 'script',
          script: a.script,
        };
        if (a.disabled) scriptAct.disabled = true;
        builtActions.push(scriptAct);
      } else if ('id' in a) {
        const actSid = await idGen.generateSid(reader);
        const act: Record<string, unknown> = {
          id: a.id,
          objectClass: a.objectClass,
          sid: actSid,
        };
        if (a['behavior-type']) act['behavior-type'] = a['behavior-type'];
        if (a.parameters) act.parameters = a.parameters;
        if (a.callFunction) act.callFunction = a.callFunction;
        if (a.disabled) act.disabled = true;
        builtActions.push(act);
      }
    }

    // Recursively build children
    const builtChildren: Array<Record<string, unknown>> = [];
    for (const child of block.children) {
      const childBlock = await buildBlockEvent(
        {
          conditions: child.conditions ?? [],
          actions: child.actions ?? [],
          disabled: child.disabled,
          isElse: child.isElse,
          children: child.children ?? [],
        },
        depth + 1,
        counter,
      );
      builtChildren.push(childBlock);
    }

    return createBlockEvent(
      blockSid,
      builtConditions,
      builtActions,
      block.disabled || undefined,
      builtChildren.length > 0 ? builtChildren : undefined,
      block.isElse || undefined,
    );
  }

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

  // ─── Tool 7: delete_event_sheet ──────────────────────────────

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

  // ─── Tool 8: create_layout ─────────────────────────────────

  server.tool(
    'create_layout',
    'Create a new layout in the project',
    {
      name: z.string().max(200).describe('Layout name'),
      width: z.number().int().positive().optional().describe('Width in pixels (default: project viewport width)'),
      height: z.number().int().positive().optional().describe('Height in pixels (default: project viewport height)'),
      eventSheet: z.string().max(200).optional().describe('Linked event sheet name'),
      layers: z.array(z.string()).optional().describe('Layer names (default: single "Layer 0")'),
    },
    async (args) => {
      try {
        validateName(args.name);

        // Check uniqueness
        const existing = await reader.listLayouts();
        if (existing.includes(args.name)) {
          return toolError(`Layout "${args.name}" already exists.`);
        }

        // Validate event sheet
        if (args.eventSheet) {
          const sheets = await reader.listEventSheets();
          if (!sheets.includes(args.eventSheet)) {
            return toolError(`Event sheet "${args.eventSheet}" does not exist. Use list_eventsheets to see available sheets.`);
          }
        }

        const metadata = reader.getMetadata();
        const width = args.width || metadata.viewportWidth;
        const height = args.height || metadata.viewportHeight;

        const layoutSid = await idGen.generateSid(reader);

        // Generate layer SIDs
        let layerDefs: Array<{ name: string; sid: number }>;
        if (args.layers && args.layers.length > 0) {
          layerDefs = [];
          for (const layerName of args.layers) {
            layerDefs.push({ name: layerName, sid: await idGen.generateSid(reader) });
          }
        } else {
          const layerSid = await idGen.generateSid(reader);
          layerDefs = [{ name: 'Layer 0', sid: layerSid }];
        }

        const data = createLayout(args.name, layoutSid, width, height, args.eventSheet, layerDefs);

        await writer.writeEntityFile('layouts', args.name, data);
        await writer.addToProject('layouts', args.name);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'layout',
          action: 'created',
          generatedSid: layoutSid,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error creating layout: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── Tool 9: add_instance_to_layout ────────────────────────

  server.tool(
    'add_instance_to_layout',
    'Place an object instance on a layout layer',
    {
      layoutName: z.string().max(200).describe('Target layout'),
      layerName: z.string().max(200).describe('Target layer within layout'),
      objectType: z.string().max(200).describe('Object type name to place'),
      x: z.number().describe('X position'),
      y: z.number().describe('Y position'),
      width: z.number().optional().default(100).describe('Instance width'),
      height: z.number().optional().default(100).describe('Instance height'),
      properties: z.record(z.unknown()).optional().describe('Plugin-specific instance properties (auto-filled for known plugins if omitted)'),
    },
    async (args) => {
      try {
        // Validate object type exists and read its plugin ID
        let pluginId: string | undefined;
        let isNonworld = false;
        try {
          const objData = await reader.readObjectType(args.objectType);
          pluginId = objData['plugin-id'];
          // Block global-only objects from being placed on layouts
          if ((objData as Record<string, unknown>)['singleglobal-inst']) {
            return toolError(`Object "${args.objectType}" is a global plugin (${pluginId}) and cannot be placed on layouts.`);
          }
          // Nonworld-global objects (Arr, Json, Dictionary) go in nonworld-instances, not on layers
          if ((objData as Record<string, unknown>).isGlobal === true) {
            isNonworld = true;
          }
        } catch {
          return toolError(`Object type "${args.objectType}" does not exist. Use list_objects to see available objects.`);
        }

        let layout: Record<string, unknown>;
        try {
          layout = await reader.readLayout(args.layoutName) as unknown as Record<string, unknown>;
        } catch {
          const suggestions = reader.findNearestName(args.layoutName, 'layouts');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_layouts to see all available names.';
          return toolError(`Layout "${args.layoutName}" not found.${hint}`);
        }

        const uid = await idGen.generateUid(reader);
        const sid = await idGen.generateSid(reader);
        const warnings: string[] = [];

        if (isNonworld) {
          // Nonworld-global objects (Array, JSON, Dictionary) are placed in layout's nonworld-instances array
          const nonworldInstances = layout['nonworld-instances'] as Array<Record<string, unknown>>;
          nonworldInstances.push({
            type: args.objectType,
            properties: args.properties ?? {},
            uid,
            sid,
            tags: '',
            instanceVariables: {},
            behaviors: {},
          });
          warnings.push(`"${args.objectType}" is a global (nonworld) object — placed in nonworld-instances instead of on a layer. Layer and position parameters were ignored.`);
        } else {
          // Normal world objects go on a layer
          const layers = layout.layers as Array<Record<string, unknown>>;
          const targetLayer = layers.find(l => l.name === args.layerName);
          if (!targetLayer) {
            const layerNames = layers.map(l => l.name).join(', ');
            return toolError(`Layer "${args.layerName}" not found in layout "${args.layoutName}". Available layers: ${layerNames}`);
          }

          // Use provided properties, or auto-fill from plugin defaults
          const pluginProps = args.properties
            ?? (pluginId ? DEFAULT_INSTANCE_PROPERTIES[pluginId] : undefined)
            ?? {};

          if (!args.properties && pluginId && !DEFAULT_INSTANCE_PROPERTIES[pluginId]) {
            warnings.push(`No default instance properties known for plugin "${pluginId}". Instance created with empty properties — you may need to configure them in the C3 editor.`);
          }

          const instance = createInstance(args.objectType, uid, sid, args.x, args.y, args.width, args.height, pluginProps);

          const instances = targetLayer.instances as Array<Record<string, unknown>>;
          instances.push(instance);
        }

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          generatedSid: sid,
          generatedUid: uid,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error adding instance: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── Tool 10: delete_layout ──────────────────────────────────

  server.tool(
    'delete_layout',
    'Delete a layout from the project (checks references first)',
    {
      name: z.string().max(200).describe('Layout name to delete'),
      force: z.boolean().optional().default(false).describe('If true, delete even if referenced (does NOT clean up references)'),
    },
    async (args) => {
      try {
        // Verify the layout exists
        const existing = await reader.listLayouts();
        if (!existing.includes(args.name)) {
          const suggestions = reader.findNearestName(args.name, 'layouts');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_layouts to see all available names.';
          return toolError(`Layout "${args.name}" not found.${hint}`);
        }

        // Block deletion of the startup layout unconditionally
        const metadata = reader.getMetadata();
        if (metadata.firstLayout === args.name) {
          return toolError(`Cannot delete "${args.name}" — it is the project's startup layout (firstLayout). Change the startup layout in project settings first.`);
        }

        // Check references via project index
        const index = await getProjectIndex(reader);

        const warnings: string[] = [];

        // Warn about bound event sheet (will become orphaned if no other layout uses it)
        const boundSheet = index.layoutToEventSheet.get(args.name);
        if (boundSheet) {
          warnings.push(`Layout was bound to event sheet "${boundSheet}". The event sheet was NOT deleted.`);
        }

        // Warn about objects placed on this layout
        const placedObjects: string[] = [];
        for (const [objName, layouts] of index.objectToLayouts) {
          if (layouts.includes(args.name)) {
            placedObjects.push(objName);
          }
        }
        if (placedObjects.length > 0) {
          warnings.push(`Objects placed on this layout: ${placedObjects.join(', ')}. Instances were removed with the layout file.`);
        }

        if (!args.force && (placedObjects.length > 0 || boundSheet)) {
          return toolResult({
            success: false,
            entity: args.name,
            category: 'layout',
            action: 'delete_blocked',
            message: 'Layout has associated data. Use force=true to delete anyway.',
            references: {
              boundEventSheet: boundSheet || null,
              placedObjects,
            },
          });
        }

        const subfolder = writer.getSubfolderForEntity('layouts', args.name);
        const backupPath = await writer.deleteEntityFile('layouts', args.name, subfolder);
        await writer.removeFromProject('layouts', args.name);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'layout',
          action: 'deleted',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error deleting layout: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── Tool 11: update_layout ─────────────────────────────────

  server.tool(
    'update_layout',
    'Update layout properties (event sheet binding, dimensions)',
    {
      name: z.string().max(200).describe('Layout name to update'),
      eventSheet: z.string().max(200).optional().describe('New event sheet binding (validated for existence)'),
      width: z.number().int().positive().optional().describe('New layout width in pixels'),
      height: z.number().int().positive().optional().describe('New layout height in pixels'),
    },
    async (args) => {
      try {
        // Check at least one update is provided
        if (args.eventSheet === undefined && args.width === undefined && args.height === undefined) {
          return toolError('No updates provided. Specify at least one of: eventSheet, width, height.');
        }

        // Read existing layout
        let layout: Record<string, unknown>;
        try {
          layout = await reader.readLayout(args.name) as unknown as Record<string, unknown>;
        } catch {
          const suggestions = reader.findNearestName(args.name, 'layouts');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_layouts to see all available names.';
          return toolError(`Layout "${args.name}" not found.${hint}`);
        }

        const warnings: string[] = [];

        // Validate and apply event sheet binding
        if (args.eventSheet !== undefined) {
          const sheets = await reader.listEventSheets();
          if (!sheets.includes(args.eventSheet)) {
            const suggestions = reader.findNearestName(args.eventSheet, 'eventsheets');
            const hint = suggestions.length > 0
              ? ` Did you mean: ${suggestions.join(', ')}?`
              : ' Use list_eventsheets to see available sheets.';
            return toolError(`Event sheet "${args.eventSheet}" does not exist.${hint}`);
          }
          layout.eventSheet = args.eventSheet;
        }

        // Apply dimension updates
        if (args.width !== undefined) layout.width = args.width;
        if (args.height !== undefined) layout.height = args.height;

        // Write back
        const subfolder = writer.getSubfolderForEntity('layouts', args.name);
        const backupPath = await writer.writeEntityFile('layouts', args.name, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'layout',
          action: 'updated',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error updating layout: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── Tool 12: update_project_metadata ───────────────────────

  server.tool(
    'update_project_metadata',
    'Update project metadata (name, version, author, description)',
    {
      name: z.string().max(200).optional().describe('Project name'),
      version: z.string().max(50).optional().describe('Project version'),
      author: z.string().max(200).optional().describe('Author name'),
      description: z.string().max(1000).optional().describe('Project description'),
    },
    async (args) => {
      try {
        const updates: Record<string, unknown> = {};
        if (args.name !== undefined) updates.name = args.name;
        if (args.version !== undefined) updates.version = args.version;
        if (args.author !== undefined) updates.author = args.author;
        if (args.description !== undefined) updates.description = args.description;

        if (Object.keys(updates).length === 0) {
          return toolError('No updates provided. Specify at least one of: name, version, author, description.');
        }

        const backupPath = await writer.updateProjectProperties(updates);

        const result: WriteResult = {
          success: true,
          entity: 'project',
          category: 'project',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error updating project metadata: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── Tool 13: add_animation_to_sprite ─────────────────────

  server.tool(
    'add_animation_to_sprite',
    'Add a new animation to a Sprite object',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name (e.g., "Idle", "Walk", "Jump")'),
      speed: z.number().min(0).optional().default(5).describe('Frames per second (default: 5)'),
      isLooping: z.boolean().optional().default(true).describe('Loop the animation (default: true)'),
      isPingPong: z.boolean().optional().default(false).describe('Ping-pong playback (default: false)'),
      repeatCount: z.number().int().min(1).optional().default(1).describe('Repeat count if not looping (default: 1)'),
      frameCount: z.number().int().min(1).max(100).optional().default(1).describe('Number of blank frames to create (default: 1)'),
      frameWidth: z.number().int().positive().optional().describe('Frame width in pixels (default: existing sprite width)'),
      frameHeight: z.number().int().positive().optional().describe('Frame height in pixels (default: existing sprite height)'),
    },
    async (args) => {
      try {
        // Read existing object
        let obj: Record<string, unknown>;
        try {
          obj = await reader.readObjectType(args.objectName) as unknown as Record<string, unknown>;
        } catch {
          const suggestions = reader.findNearestName(args.objectName, 'objects');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_objects to see all available names.';
          return toolError(`Object "${args.objectName}" not found.${hint}`);
        }

        // Verify it's a Sprite
        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is a "${obj['plugin-id']}" plugin, not a Sprite. Only Sprite objects have animations.`);
        }

        // Navigate to animations.items
        const animations = obj.animations as Record<string, unknown> | undefined;
        if (!animations || !Array.isArray(animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure. It may be corrupted.`);
        }
        const animItems = animations.items as Array<Record<string, unknown>>;

        // Check for duplicate animation name
        if (animItems.some(a => a.name === args.animationName)) {
          return toolError(`Animation "${args.animationName}" already exists on "${args.objectName}". Use update_animation_properties to modify it.`);
        }

        // Determine frame dimensions from existing animation if not specified
        let frameWidth = args.frameWidth ?? 100;
        let frameHeight = args.frameHeight ?? 100;
        if ((!args.frameWidth || !args.frameHeight) && animItems.length > 0) {
          const existingFrames = animItems[0].frames as Array<Record<string, unknown>> | undefined;
          if (existingFrames && existingFrames.length > 0) {
            if (!args.frameWidth) frameWidth = (existingFrames[0].width as number) ?? 100;
            if (!args.frameHeight) frameHeight = (existingFrames[0].height as number) ?? 100;
          }
        }

        // Generate frames
        const frames: Array<Record<string, unknown>> = [];
        for (let i = 0; i < args.frameCount; i++) {
          frames.push(createAnimationFrame(frameWidth, frameHeight));
        }

        // Generate SID for the animation
        const animSid = await idGen.generateSid(reader);

        const anim = createAnimation(
          args.animationName,
          animSid,
          args.speed,
          args.isLooping,
          args.isPingPong,
          args.repeatCount,
          frames,
        );

        animItems.push(anim);

        // Write back
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          generatedSid: animSid,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error adding animation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── Tool 14: update_animation_properties ─────────────────

  server.tool(
    'update_animation_properties',
    'Update properties of an existing animation on a Sprite object',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name to modify'),
      speed: z.number().min(0).optional().describe('New speed (frames per second)'),
      isLooping: z.boolean().optional().describe('New loop setting'),
      isPingPong: z.boolean().optional().describe('New ping-pong setting'),
      repeatCount: z.number().int().min(1).optional().describe('New repeat count'),
    },
    async (args) => {
      try {
        // Read existing object
        let obj: Record<string, unknown>;
        try {
          obj = await reader.readObjectType(args.objectName) as unknown as Record<string, unknown>;
        } catch {
          const suggestions = reader.findNearestName(args.objectName, 'objects');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_objects to see all available names.';
          return toolError(`Object "${args.objectName}" not found.${hint}`);
        }

        // Verify it's a Sprite
        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is a "${obj['plugin-id']}" plugin, not a Sprite. Only Sprite objects have animations.`);
        }

        // Navigate to animations.items
        const animations = obj.animations as Record<string, unknown> | undefined;
        if (!animations || !Array.isArray(animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure.`);
        }
        const animItems = animations.items as Array<Record<string, unknown>>;

        // Find the target animation
        const anim = animItems.find(a => a.name === args.animationName);
        if (!anim) {
          const availableNames = animItems.map(a => a.name as string).join(', ');
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available animations: ${availableNames}`);
        }

        // Check at least one property is being updated
        if (args.speed === undefined && args.isLooping === undefined && args.isPingPong === undefined && args.repeatCount === undefined) {
          return toolError('No updates provided. Specify at least one of: speed, isLooping, isPingPong, repeatCount.');
        }

        // Apply updates
        if (args.speed !== undefined) anim.speed = args.speed;
        if (args.isLooping !== undefined) anim.isLooping = args.isLooping;
        if (args.isPingPong !== undefined) anim.isPingPong = args.isPingPong;
        if (args.repeatCount !== undefined) anim.repeatCount = args.repeatCount;

        // Write back
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        return toolError(`Error updating animation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
