/**
 * Object type tools: create_object, update_object_properties, delete_object,
 * create_family, update_family, delete_family.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, ObjectType, Instance, ObjectReference } from '../construct3/types.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { Construct3ProjectWriter } from '../construct3/project-writer.js';
import { validateName, validateSubfolder, toolResult, toolError, notFoundError, folderCaseClashError } from './shared.js';
import { findFolderPathClash } from '../construct3/names.js';
import { getProjectIndex, type FamilyMemberUse, type ObjectUsage } from '../construct3/analyzers/index-builder.js';
import { forEachLayoutInstance } from '../construct3/layers.js';
import {
  checkFamilyPlugins,
  findObjectClassNameClash,
  findBuiltinObjectClassClash,
  builtinObjectClassClashMessage,
  formatLoadRuleIssue,
  loadRuleErrorMessage,
  newLoadRuleIssues,
  objectClassNameClashMessage,
} from '../construct3/analyzers/load-rules.js';
import { functionsObjectName } from '../construct3/event-shapes.js';
import {
  GLOBAL_PLUGINS,
  NONWORLD_GLOBAL_PLUGINS,
  createSpriteObject,
  createTextObject,
  createTiledBgObject,
  createGlobalObject,
  createGenericObject,
  createInstanceVariable,
  createBehavior,
} from '../construct3/templates.js';
import {
  expectedInstanceBehaviors,
  readFamiliesForInstances,
  syncInstanceBehaviors,
  unknownDefaultsWarning,
  behaviorTypesOf,
} from '../construct3/instance-behaviors.js';
import type { InstanceBehavior } from '../construct3/instance-behaviors.js';

export function registerObjectTools({ server, reader, writer, idGen }: MutationToolDeps) {
  // ─── create_object ──────────────────────────────────────────

  server.tool(
    'create_object',
    'Create a new object type in the Construct3 project',
    {
      name: z.string().max(200).describe('Object name (alphanumeric + underscore; must not match an existing object type or family name, "System" or the name of the built-in Functions object, ignoring case)'),
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
        // Editor load-time rule: object types and families share one name namespace that ignores case
        const nameClash = findObjectClassNameClash(args.name, existing, await reader.listFamilies());
        if (nameClash) {
          return toolError(objectClassNameClashMessage(args.name, nameClash));
        }
        // ...and with the built-in System and Functions objects
        const builtinClash = findBuiltinObjectClassClash(args.name, functionsObjectName(reader));
        if (builtinClash) {
          return toolError(builtinObjectClassClashMessage(args.name, builtinClash));
        }
        if (args.subfolder) {
          const folderClash = findFolderPathClash(reader.getProject().objectTypes, args.subfolder);
          if (folderClash) return toolError(folderCaseClashError(args.subfolder, folderClash));
        }
        // Before any write (addon registration, placeholder images): never replace an existing file
        const fileRefusal = await writer.entityFileRefusal('objectTypes', args.name, args.subfolder);
        if (fileRefusal) return toolError(fileRefusal);

        // Ensure the plugin is registered in usedAddons
        const addonWarning = await writer.ensureAddonRegistered('plugin', args.pluginId);

        const sid = await idGen.generateSid(reader);
        const isSingleglobal = GLOBAL_PLUGINS.has(args.pluginId);
        const isNonworldGlobal = NONWORLD_GLOBAL_PLUGINS.has(args.pluginId);
        let data: ObjectType;
        let uid: number | undefined;

        if (isSingleglobal || (args.isGlobal && !isNonworldGlobal)) {
          uid = await idGen.generateUid(reader);
          const sgiSid = await idGen.generateSid(reader);
          data = createGlobalObject(args.name, args.pluginId, sid, uid, sgiSid);
        } else if (args.pluginId === 'Sprite') {
          const animSid = await idGen.generateSid(reader);
          const imageSpriteId = await idGen.generateImageSpriteId(reader);

          // Write placeholder PNG before JSON — abort if image fails
          await writer.writeImageFiles([{
            objectName: args.name,
            animationName: 'Animation 1',
            frameIndex: 0,
            pluginId: 'Sprite',
            width: 1,
            height: 1,
          }]);

          data = createSpriteObject(args.name, sid, animSid, imageSpriteId);
        } else if (args.pluginId === 'Text') {
          data = createTextObject(args.name, sid);
        } else if (args.pluginId === 'TiledBg') {
          const imageSpriteId = await idGen.generateImageSpriteId(reader);

          // Write placeholder PNG before JSON — abort if image fails
          await writer.writeImageFiles([{
            objectName: args.name,
            animationName: '',
            frameIndex: 0,
            pluginId: 'TiledBg',
            width: 1,
            height: 1,
          }]);

          data = createTiledBgObject(args.name, sid, imageSpriteId);
        } else {
          data = createGenericObject(args.name, args.pluginId, sid);
          // Nonworld-global plugins (Arr, Json, Dictionary) are isGlobal but not singleglobal-inst
          if (isNonworldGlobal) {
            data.isGlobal = true;
          }
        }

        await writer.writeEntityFile('objectTypes', args.name, data, args.subfolder, { createOnly: true });
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
        console.error('[create_object] failed:', error);
        return toolError(`Error creating object: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_object_properties ─────────────────────────────

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
        // Check at least one update is provided
        if (args.isGlobal === undefined && !args.addVariables?.length && !args.removeVariables?.length && !args.addBehaviors?.length && !args.removeBehaviors?.length) {
          return toolError('No updates provided. Specify at least one of: isGlobal, addVariables, removeVariables, addBehaviors, removeBehaviors.');
        }

        // Read existing object — preserves ALL original fields
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.name);
        } catch {
          return notFoundError('Object', args.name, reader.findNearestName(args.name, 'objects'), 'list_objects');
        }

        const warnings: string[] = [];
        const addedBehaviors: string[] = [];
        const removedBehaviors: string[] = [];

        // Update global status
        if (args.isGlobal !== undefined) {
          obj.isGlobal = args.isGlobal;
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
            addedBehaviors.push(b.name);
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
                removedBehaviors.push(bName);
              } else {
                warnings.push(`Behavior "${bName}" not found, skipping`);
              }
            }
          }
        }

        // Write updated object
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.name);
        const backupPath = await writer.writeEntityFile('objectTypes', args.name, obj, subfolder);

        // Sync layout instances: ensure all instances of this object have
        // behaviors/instanceVariables dicts so C3 can resolve them on load,
        // add an entry for each added behavior (and any other entry an
        // instance lacks) and drop the removed ones.
        if (args.addBehaviors?.length || args.removeBehaviors?.length || args.addVariables?.length || args.removeVariables?.length) {
          const expected = expectedInstanceBehaviors(args.name, obj, await readFamiliesForInstances(reader));
          const sync = await syncLayoutInstances(reader, writer, new Map([
            [args.name, { expected, add: addedBehaviors, drop: removedBehaviors }],
          ]));
          warnings.push(...sync.warnings);
        }

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
        console.error('[update_object_properties] failed:', error);
        return toolError(`Error updating object: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_object ────────────────────────────────────────

  server.tool(
    'delete_object',
    'Delete an object type from the project (checks references first: events, including object parameters, expressions and runtime.objects in script actions; layout instances on any layer or sub-layer, including non-world instances; object properties of other instances; families). Refused without force while anything refers to the object; the response lists where. References in project script files and objects created by name at runtime are not detected.',
    {
      name: z.string().max(200).describe('Object name to delete'),
      force: z.boolean().optional().default(false).describe('If true, delete even if referenced (does NOT clean up references)'),
    },
    async (args) => {
      try {
        // Verify the object exists
        const existing = await reader.listObjectTypes();
        if (!existing.includes(args.name)) {
          return notFoundError('Object', args.name, reader.findNearestName(args.name, 'objects'), 'list_objects');
        }

        // Check references: the same index find_orphaned_objects and get_object_dependencies use
        const index = await getProjectIndex(reader);
        const usage = index.getObjectUsage(args.name);
        const hasRefs = index.isObjectReferenced(args.name);
        const eventSheetRefs = [...new Set(usage.events.map(r => r.eventSheet))];
        const layoutRefs = [...new Set([...usage.placements, ...usage.instanceProperties].map(p => p.layout))];

        if (hasRefs && !args.force) {
          return toolResult({
            success: false,
            entity: args.name,
            category: 'object',
            action: 'delete_blocked',
            message: `Object is still referenced: ${describeObjectUsage(usage)}. ` +
              'Use force=true to delete anyway (references will NOT be cleaned up).',
            references: {
              eventSheets: eventSheetRefs,
              layouts: layoutRefs,
              families: usage.families,
              ...usageDetails(usage),
            },
          });
        }

        const warnings: string[] = [];
        if (hasRefs && args.force) {
          warnings.push(`Object deleted but still referenced: ${describeObjectUsage(usage)}. References were NOT cleaned up.`);
          const unreported = unreportedUsesWarning(usage.events);
          if (unreported) warnings.push(unreported);
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
        console.error('[delete_object] failed:', error);
        return toolError(`Error deleting object: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── create_family ────────────────────────────────────────

  server.tool(
    'create_family',
    'Create a new family in the project. Families let you group object types and share instance variables and behaviors across them.',
    {
      name: z.string().max(200).describe('Family name (must not match an existing object type or family name, "System" or the name of the built-in Functions object, ignoring case)'),
      pluginId: z.string().max(100).describe('Plugin ID all members must share (e.g. "Sprite", "Text"); members of another plugin are refused'),
      members: z.array(z.string().max(200)).optional().default([]).describe('Object type names to add as initial members'),
      subfolder: z.string().max(500).optional().describe('Subfolder path in project (e.g. "UI")'),
    },
    async (args) => {
      try {
        validateName(args.name);
        if (args.subfolder) validateSubfolder(args.subfolder);

        // Check uniqueness
        const existing = await reader.listFamilies();
        if (existing.includes(args.name)) {
          return toolError(`Family "${args.name}" already exists.`);
        }
        // Editor load-time rule: object types and families share one name namespace that ignores case
        const nameClash = findObjectClassNameClash(args.name, await reader.listObjectTypes(), existing);
        if (nameClash) {
          return toolError(objectClassNameClashMessage(args.name, nameClash));
        }
        // ...and with the built-in System and Functions objects
        const builtinClash = findBuiltinObjectClassClash(args.name, functionsObjectName(reader));
        if (builtinClash) {
          return toolError(builtinObjectClassClashMessage(args.name, builtinClash));
        }
        if (args.subfolder) {
          const folderClash = findFolderPathClash(reader.getProject().families, args.subfolder);
          if (folderClash) return toolError(folderCaseClashError(args.subfolder, folderClash));
        }
        // Never replace an existing file
        const fileRefusal = await writer.entityFileRefusal('families', args.name, args.subfolder);
        if (fileRefusal) return toolError(fileRefusal);

        // Validate members exist
        const warnings: string[] = [];
        const memberObjects = await readMemberObjects(reader, args.members);
        for (const memberName of args.members) {
          if (!memberObjects.has(memberName)) {
            warnings.push(`Member "${memberName}" does not exist as an object type. It will be listed but C3 may warn.`);
          }
        }

        // Editor load-time rule: all members of a family must use one plugin
        const pluginIssues = checkFamilyPlugins(
          new Map([[args.name, { 'plugin-id': args.pluginId, members: args.members }]]),
          memberObjects,
        );
        const pluginErrors = pluginIssues.filter(i => i.severity === 'error');
        if (pluginErrors.length > 0) {
          return toolError(loadRuleErrorMessage(pluginErrors.map(formatLoadRuleIssue)));
        }
        warnings.push(...pluginIssues.filter(i => i.severity === 'warning').map(formatLoadRuleIssue));

        const sid = await idGen.generateSid(reader);

        const familyData: Record<string, unknown> = {
          name: args.name,
          'plugin-id': args.pluginId,
          sid,
          instanceVariables: [],
          behaviorTypes: [],
          effectTypes: [],
          members: args.members,
        };

        await writer.writeEntityFile('families', args.name, familyData, args.subfolder, { createOnly: true });
        await writer.addToProject('families', args.name, args.subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'family',
          action: 'created',
          generatedSid: sid,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[create_family] failed:', error);
        return toolError(`Error creating family: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_family ────────────────────────────────────────

  server.tool(
    'update_family',
    'Update a family: add/remove members, add/remove shared instance variables or behaviors',
    {
      name: z.string().max(200).describe('Family name to update'),
      addMembers: z.array(z.string().max(200)).optional().describe('Object type names to add to the family'),
      removeMembers: z.array(z.string().max(200)).optional().describe('Object type names to remove from the family'),
      addVariables: z.array(z.object({
        name: z.string().describe('Variable name'),
        type: z.enum(['number', 'string', 'boolean']).describe('Variable type'),
      })).optional().describe('Instance variables to add to all family members'),
      removeVariables: z.array(z.string()).optional().describe('Instance variable names to remove'),
    },
    async (args) => {
      try {
        const hasUpdates = (args.addMembers?.length ?? 0) > 0 || (args.removeMembers?.length ?? 0) > 0 ||
          (args.addVariables?.length ?? 0) > 0 || (args.removeVariables?.length ?? 0) > 0;
        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: addMembers, removeMembers, addVariables, removeVariables.');
        }

        let family: Record<string, unknown>;
        try {
          family = await reader.readFamily(args.name);
        } catch {
          return toolError(`Family "${args.name}" not found. Use list_families to see available families.`);
        }

        const warnings: string[] = [];

        // Manage members
        if (!Array.isArray(family.members)) family.members = [];
        const members = family.members as string[];
        const membersBefore = [...members];

        if (args.addMembers) {
          for (const m of args.addMembers) {
            if (members.includes(m)) {
              warnings.push(`Member "${m}" already in family, skipping`);
            } else {
              members.push(m);
            }
          }
        }

        if (args.removeMembers) {
          for (const m of args.removeMembers) {
            const idx = members.indexOf(m);
            if (idx !== -1) {
              members.splice(idx, 1);
            } else {
              warnings.push(`Member "${m}" not in family, skipping`);
            }
          }
        }

        // Editor load-time rule: all members of a family must use one plugin.
        // Only problems this update introduces block it.
        if (args.addMembers || args.removeMembers) {
          const memberObjects = await readMemberObjects(reader, [...membersBefore, ...members]);
          const pluginIssues = newLoadRuleIssues(
            checkFamilyPlugins(new Map([[args.name, { ...family, members: membersBefore }]]), memberObjects),
            checkFamilyPlugins(new Map([[args.name, family]]), memberObjects),
          );
          const pluginErrors = pluginIssues.filter(i => i.severity === 'error');
          if (pluginErrors.length > 0) {
            family.members = membersBefore;
            return toolError(loadRuleErrorMessage(pluginErrors.map(formatLoadRuleIssue)));
          }
          warnings.push(...pluginIssues.filter(i => i.severity === 'warning').map(formatLoadRuleIssue));
        }

        // Manage instance variables
        if (!Array.isArray(family.instanceVariables)) family.instanceVariables = [];
        const vars = family.instanceVariables as Array<Record<string, unknown>>;

        if (args.addVariables) {
          for (const v of args.addVariables) {
            if (vars.some(ev => ev.name === v.name)) {
              warnings.push(`Variable "${v.name}" already exists, skipping`);
              continue;
            }
            const sid = await idGen.generateSid(reader);
            vars.push(createInstanceVariable(v.name, v.type, sid));
          }
        }

        if (args.removeVariables) {
          for (const varName of args.removeVariables) {
            const idx = vars.findIndex(v => v.name === varName);
            if (idx !== -1) {
              vars.splice(idx, 1);
            } else {
              warnings.push(`Variable "${varName}" not found, skipping`);
            }
          }
        }

        const subfolder = writer.getSubfolderForEntity('families', args.name);
        const backupPath = await writer.writeEntityFile('families', args.name, family, subfolder);

        // Instances of members that joined get entries for the family's
        // behaviors, instances of members that left lose them
        const familyBehaviors = behaviorTypesOf(family).map(b => b.name);
        const memberChanges = [...new Set([...(args.addMembers ?? []), ...(args.removeMembers ?? [])])]
          .filter(m => members.includes(m) !== membersBefore.includes(m))
          .map(m => ({ member: m, joined: members.includes(m) }));
        if (familyBehaviors.length > 0 && memberChanges.length > 0) {
          const families = new Map(await readFamiliesForInstances(reader));
          families.set(args.name, family);
          const plans = await familyMemberPlans(reader, families, memberChanges, familyBehaviors);
          warnings.push(...(await syncLayoutInstances(reader, writer, plans)).warnings);
        }

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'family',
          action: 'updated',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_family] failed:', error);
        return toolError(`Error updating family: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_family ────────────────────────────────────────

  server.tool(
    'delete_family',
    'Delete a family from the project (checks references first: events that name the family, including object parameters, expressions and runtime.objects in script actions; object properties of instances that hold its SID; its instance variables and behaviors used through a member object type, as the instance variable parameter or behavior of a condition/action on the member, as "Member.name" in an expression, or as "Self.name" in an expression of a condition/action on the member). Refused without force while anything refers to the family; the response lists where. The member object types are kept. References in project script files and script access to instance variables and behaviors of member instances are not detected.',
    {
      name: z.string().max(200).describe('Family name to delete'),
      force: z.boolean().optional().default(false).describe('If true, delete even if referenced (does NOT clean up references)'),
    },
    async (args) => {
      try {
        const existing = await reader.listFamilies();
        if (!existing.includes(args.name)) {
          return toolError(`Family "${args.name}" not found. Use list_families to see available families.`);
        }

        // Check references: uses by name (as for delete_object) and uses through members
        const index = await getProjectIndex(reader);
        const { events, instanceProperties } = index.getObjectUsage(args.name);
        const usage: ObjectUsage = { events, placements: [], instanceProperties, families: [], usedFamilies: [] };
        const memberUses = index.getFamilyMemberUses(args.name);
        const hasRefs = events.length > 0 || instanceProperties.length > 0 || memberUses.length > 0;
        const description = [describeObjectUsage(usage), describeMemberUses(memberUses)].filter(Boolean).join('; ');

        if (hasRefs && !args.force) {
          return toolResult({
            success: false,
            entity: args.name,
            category: 'family',
            action: 'delete_blocked',
            message: `Family is still referenced: ${description}. ` +
              'Use force=true to delete anyway (references will NOT be cleaned up).',
            references: {
              eventSheets: [...new Set([...events, ...memberUses].map(r => r.eventSheet))],
              layouts: [...new Set(instanceProperties.map(p => p.layout))],
              ...boundedLists({ events: eventUseList(events), instanceProperties, memberUses }),
            },
          });
        }

        const warnings: string[] = [];
        if (hasRefs && args.force) {
          warnings.push(`Family deleted but still referenced: ${description}. References were NOT cleaned up.`);
          const unreported = unreportedUsesWarning(events, memberUses);
          if (unreported) warnings.push(unreported);
        }

        // Read before deleting: the members' instances lose the entries for the family's behaviors
        let family: Record<string, unknown> | undefined;
        try {
          family = await reader.readFamily(args.name);
        } catch {
          family = undefined;
        }

        const subfolder = writer.getSubfolderForEntity('families', args.name);
        const backupPath = await writer.deleteEntityFile('families', args.name, subfolder);
        await writer.removeFromProject('families', args.name);

        const familyBehaviors = behaviorTypesOf(family).map(b => b.name);
        const formerMembers = Array.isArray(family?.members)
          ? family.members.filter((m): m is string => typeof m === 'string')
          : [];
        if (familyBehaviors.length > 0 && formerMembers.length > 0) {
          const families = new Map(await readFamiliesForInstances(reader));
          families.delete(args.name);
          const plans = await familyMemberPlans(
            reader, families, formerMembers.map(m => ({ member: m, joined: false })), familyBehaviors,
          );
          warnings.push(...(await syncLayoutInstances(reader, writer, plans)).warnings);
        }

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'family',
          action: 'deleted',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_family] failed:', error);
        return toolError(`Error deleting family: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}

/** At most this many uses of each kind are listed in a delete_object or delete_family response. */
const MAX_LISTED_USES = 50;

const EVENT_USE_LABELS: Record<ObjectReference['context'], string> = {
  condition: 'condition object',
  action: 'action object',
  parameter: 'object parameter',
  expression: 'expression',
  script: 'script',
  'custom-action': 'custom action definition',
};

/** A short list for messages: the first few items and how many more there are. */
function listSome(items: string[], max = 5): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/**
 * One sentence on what refers to an object, e.g. 'used 3 time(s) in events of
 * "Sheet1" (2 object parameter, 1 script); 2 instance(s) in layout "Layout1"
 * (layer "Main > Sub")'.
 */
function describeObjectUsage(usage: ObjectUsage): string {
  const parts: string[] = [];
  if (usage.events.length > 0) {
    const byContext = new Map<string, number>();
    for (const ref of usage.events) {
      const label = EVENT_USE_LABELS[ref.context] ?? ref.context;
      byContext.set(label, (byContext.get(label) ?? 0) + 1);
    }
    const sheets = [...new Set(usage.events.map(r => `"${r.eventSheet}"`))];
    const kinds = [...byContext].map(([label, count]) => `${count} ${label}`).join(', ');
    parts.push(`used ${usage.events.length} time(s) in events of ${listSome(sheets)} (${kinds})`);
  }
  if (usage.placements.length > 0) {
    const total = usage.placements.reduce((sum, p) => sum + p.instances, 0);
    const where = usage.placements.map(p =>
      `"${p.layout}" (${p.layer !== undefined ? `layer "${p.layer}"` : 'non-world'})`);
    parts.push(`${total} instance(s) in layout ${listSome(where)}`);
  }
  if (usage.instanceProperties.length > 0) {
    const where = usage.instanceProperties.map(p =>
      `"${p.property}" of "${p.objectType}" UID ${String(p.uid)} in layout "${p.layout}"`);
    parts.push(`named by the object propert${where.length === 1 ? 'y' : 'ies'} ${listSome(where)}`);
  }
  if (usage.families.length > 0) {
    parts.push(`member of family ${listSome(usage.families.map(f => `"${f}"`))}`);
  }
  return parts.join('; ');
}

/**
 * One sentence on the uses of a family's instance variables and behaviors
 * through its members, e.g. 'its instance variables or behaviors used 2
 * time(s) through members in events of "Sheet1" (instance variable "hp" of
 * "Sprite1", behavior "Fade" of "Sprite1")'; empty when there are none.
 */
function describeMemberUses(uses: FamilyMemberUse[]): string {
  if (uses.length === 0) return '';
  const sheets = [...new Set(uses.map(u => `"${u.eventSheet}"`))];
  const what = [...new Set(uses.map(u => `${u.kind} "${u.name}" of "${u.member}"`))];
  return `its instance variables or behaviors used ${uses.length} time(s) through members in events of ${listSome(sheets)} (${listSome(what)})`;
}

/** Event uses as listed in a refusal: where and how. */
function eventUseList(events: ObjectReference[]): Array<Pick<ObjectReference, 'eventSheet' | 'path' | 'context'>> {
  return events.map(({ eventSheet, path, context }) => ({ eventSheet, path, context }));
}

/** The uses behind a delete_object refusal, bounded to MAX_LISTED_USES per kind. */
function usageDetails(usage: ObjectUsage): Record<string, unknown> {
  return boundedLists({
    events: eventUseList(usage.events),
    instances: usage.placements,
    instanceProperties: usage.instanceProperties,
  });
}

/** Each list cut to MAX_LISTED_USES entries, with `<kind>NotListed` counting the rest. */
function boundedLists(lists: Record<string, unknown[]>): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const [kind, list] of Object.entries(lists)) {
    details[kind] = list.slice(0, MAX_LISTED_USES);
    if (list.length > MAX_LISTED_USES) details[`${kind}NotListed`] = list.length - MAX_LISTED_USES;
  }
  return details;
}

/**
 * The force-delete warning for the uses validate_project cannot report
 * afterwards (it reports the other leftovers as broken-object-reference):
 * uses in expressions and scripts, which are recognised by the names of
 * existing objects only, and uses of a family's instance variables and
 * behaviors through its members. Empty when there are none.
 */
function unreportedUsesWarning(events: ObjectReference[], memberUses: FamilyMemberUse[] = []): string {
  const inCode = events.filter(r => r.context === 'expression' || r.context === 'script');
  if (inCode.length === 0 && memberUses.length === 0) return '';
  const counts: string[] = [];
  if (inCode.length > 0) counts.push(`${inCode.length} use(s) in expressions and scripts`);
  if (memberUses.length > 0) counts.push(`${memberUses.length} use(s) of its instance variables and behaviors through members`);
  const where = [...new Set([...inCode, ...memberUses].map(r => `"${r.eventSheet}" ${r.path}`))];
  return `validate_project will not report its ${counts.join(' and ')} (${listSome(where)}): fix them now.`;
}

/** How the layout instances of one object type change (see syncInstanceBehaviors). */
interface InstanceSyncPlan {
  /** Behaviors the object's instances carry entries for, after the change */
  expected: InstanceBehavior[];
  /**
   * Behavior names the change added. Every expected entry an instance lacks
   * gets added; only those for other names are reported as missing before
   * the change.
   */
  add?: string[];
  /** Behavior names whose entries are removed unless still expected */
  drop?: string[];
}

/**
 * Update all layout instances (on every layer and sub-layer, and in
 * nonworld-instances) of the object types in `plans`: make sure they have
 * the `behaviors` and `instanceVariables` dicts C3 expects, give them a
 * default entry for every expected behavior they lack, and drop the entries
 * named in the plan's `drop` that are no longer expected. The editor stores
 * an entry for every behavior of the object and its families on each
 * instance, so besides the entries for behaviors the change added (`add`),
 * entries missing before the change are added too: older versions of these
 * tools wrote instances without them, and a hand edit can leave one out.
 * Existing entries keep their values and their saved order.
 *
 * Returns warnings naming the modified layouts, the entries that were missing
 * before the change, and any behavior that got an empty entry because its
 * defaults are not known.
 */
async function syncLayoutInstances(
  reader: Construct3ProjectReader,
  writer: Construct3ProjectWriter,
  plans: ReadonlyMap<string, InstanceSyncPlan>,
): Promise<{ warnings: string[] }> {
  const layouts = await reader.readAllLayouts();
  const modifiedLayouts: string[] = [];
  const unknownDefaults: InstanceBehavior[] = [];
  /** Per object type: instances that lacked entries the change did not add, and those behavior names */
  const backfilled = new Map<string, { instances: number; names: Set<string> }>();

  for (const [layoutName, layout] of layouts) {
    let modified = false;
    const visit = (instance: Instance) => {
      const plan = plans.get(instance.type);
      if (!plan) return;
      modified = ensureInstanceFields(instance) || modified;
      const synced = syncInstanceBehaviors(instance, plan.expected, {
        add: plan.expected.map(b => b.name),
        drop: plan.drop,
      });
      modified = synced.modified || modified;
      unknownDefaults.push(...synced.unknownDefaults);
      const missingBefore = synced.added.filter(name => !(plan.add ?? []).includes(name));
      if (missingBefore.length > 0) {
        const entry = backfilled.get(instance.type) ?? { instances: 0, names: new Set<string>() };
        entry.instances++;
        for (const name of missingBefore) entry.names.add(name);
        backfilled.set(instance.type, entry);
      }
    };

    forEachLayoutInstance(layout, visit);

    if (modified) {
      const subfolder = writer.getSubfolderForEntity('layouts', layoutName);
      await writer.writeEntityFile('layouts', layoutName, layout, subfolder);
      modifiedLayouts.push(layoutName);
    }
  }

  const warnings: string[] = [];
  if (modifiedLayouts.length > 0) {
    warnings.push(`Updated instances in layout(s): ${modifiedLayouts.join(', ')}`);
  }
  for (const [objectType, entry] of backfilled) {
    const expected = plans.get(objectType)?.expected ?? [];
    const names = expected.map(b => b.name).filter(name => entry.names.has(name));
    warnings.push(`Also added default entries for behavior(s) ${names.map(n => `"${n}"`).join(', ')} to ${entry.instances} instance(s) of "${objectType}" `
      + 'that had none (written by an older version of construct3-mcp or edited by hand). Construct 3 stores an entry for every behavior of the object and its families on each instance.');
  }
  if (unknownDefaults.length > 0) warnings.push(unknownDefaultsWarning(unknownDefaults));
  return { warnings };
}

/**
 * Sync plans for family members whose family behaviors changed: members that
 * joined get entries for `familyBehaviors`, members that left (or whose
 * family was deleted) lose them. `families` is the project's families after
 * the change.
 */
async function familyMemberPlans(
  reader: Construct3ProjectReader,
  families: ReadonlyMap<string, unknown>,
  changes: Array<{ member: string; joined: boolean }>,
  familyBehaviors: string[],
): Promise<Map<string, InstanceSyncPlan>> {
  const memberObjects = await readMemberObjects(reader, changes.map(c => c.member));
  const plans = new Map<string, InstanceSyncPlan>();
  for (const { member, joined } of changes) {
    const obj = memberObjects.get(member);
    if (!obj) continue; // missing object type: it has no instances to update
    plans.set(member, {
      expected: expectedInstanceBehaviors(member, obj, families),
      ...(joined ? { add: familyBehaviors } : { drop: familyBehaviors }),
    });
  }
  return plans;
}

/**
 * Ensure an instance has the standard fields C3 expects.
 * Returns true if the instance was modified.
 */
function ensureInstanceFields(instance: Instance): boolean {
  let modified = false;
  const inst = instance as Record<string, unknown>;

  if (!inst.behaviors || typeof inst.behaviors !== 'object') {
    inst.behaviors = {};
    modified = true;
  }
  if (!inst.instanceVariables || typeof inst.instanceVariables !== 'object') {
    inst.instanceVariables = {};
    modified = true;
  }

  return modified;
}

/** The given object types that exist, by name (missing ones are left out). */
async function readMemberObjects(
  reader: Construct3ProjectReader,
  names: Iterable<string>,
): Promise<Map<string, Record<string, unknown>>> {
  const objects = new Map<string, Record<string, unknown>>();
  for (const name of new Set(names)) {
    try {
      objects.set(name, await reader.readObjectType(name) as unknown as Record<string, unknown>);
    } catch {
      // Missing member: reported separately where it matters
    }
  }
  return objects;
}
