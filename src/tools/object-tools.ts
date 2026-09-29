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
import {
  getProjectIndex,
  toFamilyMemberUse,
  type FamilyMemberUse,
  type MemberReference,
  type MemberRemoval,
  type ObjectUsage,
  type ProjectIndex,
} from '../construct3/analyzers/index-builder.js';
import { forEachLayoutInstance } from '../construct3/layers.js';
import {
  blocksWithoutForce,
  checkUnscannedFiles,
  describeReadFailure,
  describeUnscannedFile,
  mergeUnscannedReports,
  ownFileReports,
  unscannedFields,
  unscannedFilesOf,
  unscannedRefusal,
  unscannedWarnings,
  type UnscannedFileReport,
  type UseRule,
} from '../construct3/analyzers/unscanned-uses.js';
import { nameTerm, numberTerm } from '../construct3/raw-text-search.js';
import { classifyReadError, type EntityCategory } from '../construct3/project-reader.js';
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
import { planObjectImageParking, type ObjectImageParking } from '../construct3/object-images.js';
import {
  dropInstanceEffects,
  effectNamesOf,
  expectedInstanceEffects,
  expectedInstanceVariables,
  instanceVariablesOf,
  syncInstanceVariables,
  type InstanceVariableDef,
} from '../construct3/instance-variables.js';
import {
  effectUseLocation,
  familyEffectUsesThroughMembers,
  findEffectUses,
  type EffectUse,
} from '../construct3/analyzers/effect-uses.js';

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

        const isSingleglobal = GLOBAL_PLUGINS.has(args.pluginId);
        const isNonworldGlobal = NONWORLD_GLOBAL_PLUGINS.has(args.pluginId);
        // A global object's UID before any write too: generateUid refuses while
        // a project file's UIDs are unknown. Registering the addon below only
        // rewrites project.c3proj, which holds no UIDs, so the UID stays free.
        const uid = isSingleglobal || (args.isGlobal && !isNonworldGlobal)
          ? await idGen.generateUid(reader)
          : undefined;

        // Ensure the plugin is registered in usedAddons
        const addonWarning = await writer.ensureAddonRegistered('plugin', args.pluginId);

        const sid = await idGen.generateSid(reader);
        let data: ObjectType;

        if (uid !== undefined) {
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
    'Update properties of an existing object type (variables, behaviors, global status). Removing an instance variable or behavior that events still use is refused without force, listing the uses: the "instance-variable" parameter or behaviorType of conditions/actions on the object (also System actions such as Sort Z order that name the object with the variable), and "Object.name", "Object.Behavior.Expression" or (on the object) "Self.name" in expressions. Scripts are not checked; a warning names scripts that read a removed name (instVars.name, behaviors.Name). Event sheets that could not be parsed (over the 10MB read limit, not valid JSON) are searched as text: one that names a removed variable or behavior and the object (a possible use), or that cannot be read at all, also refuses without force; they are listed in unscannedFiles.',
    {
      name: z.string().max(200).describe('Existing object name, as registered (letter case included)'),
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
      force: z.boolean().optional().default(false).describe('If true, remove instance variables and behaviors even if events use them (the uses are NOT changed)'),
    },
    async (args) => {
      try {
        // Check at least one update is provided
        if (args.isGlobal === undefined && !args.addVariables?.length && !args.removeVariables?.length && !args.addBehaviors?.length && !args.removeBehaviors?.length) {
          return toolError('No updates provided. Specify at least one of: isGlobal, addVariables, removeVariables, addBehaviors, removeBehaviors.');
        }

        // The registered name only: on case-insensitive file systems another
        // spelling would open the file too, but nothing else knows it by that name
        const objectNames = await reader.listObjectTypes();
        if (!objectNames.includes(args.name)) {
          return entityNotFound('Object', args.name, objectNames, reader.findNearestName(args.name, 'objects'), 'list_objects');
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
        const addedVariables: string[] = [];
        const removedVariables: string[] = [];

        // Before any change: events that use an instance variable or behavior being removed
        const variablesToRemove = existingNames(obj.instanceVariables, args.removeVariables);
        const behaviorsToRemove = existingNames(obj.behaviorTypes, args.removeBehaviors);
        const removal: MemberRemoval = {
          variables: new Map([[args.name, variablesToRemove]]),
          behaviors: new Map([[args.name, behaviorsToRemove]]),
        };
        let unscanned: UnscannedFileReport[] = [];
        if (variablesToRemove.length > 0 || behaviorsToRemove.length > 0) {
          const index = await getProjectIndex(reader);
          const broken = index.findReferencesBrokenBy(removal);
          // Event sheets that could not be parsed: a use names the member and the object
          unscanned = await checkUnscannedFiles(reader, index.unscannedFiles, [{
            categories: ['eventSheets'],
            allOf: [[...variablesToRemove, ...behaviorsToRemove].map(n => nameTerm(n)), [nameTerm(args.name)]],
          }]);
          if ((broken.length > 0 || blocksWithoutForce(unscanned)) && !args.force) {
            return toolResult(removalBlocked(args.name, 'object', broken, unscanned));
          }
          warnings.push(...removalForcedWarnings(args.name, broken));
          warnings.push(...unscannedWarnings(unscanned, 'Removed'));
          warnings.push(...await scriptReadWarnings(reader, index, removal, [
            ...variablesToRemove.map(name => ({ objectClass: args.name, kind: 'instance variable' as const, name })),
            ...behaviorsToRemove.map(name => ({ objectClass: args.name, kind: 'behavior' as const, name })),
          ]));
        }

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
            addedVariables.push(v.name);
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
                removedVariables.push(varName);
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
        // add an entry for each added behavior and a default value for each
        // added instance variable (and any other entry or value an instance
        // lacks) and drop the removed ones.
        if (args.addBehaviors?.length || args.removeBehaviors?.length || args.addVariables?.length || args.removeVariables?.length) {
          const families = await readFamiliesForInstances(reader);
          const sync = await syncLayoutInstances(reader, writer, new Map([
            [args.name, {
              expected: expectedInstanceBehaviors(args.name, obj, families),
              add: addedBehaviors,
              drop: removedBehaviors,
              variables: expectedInstanceVariables(args.name, obj, families),
              addVariables: addedVariables,
              dropVariables: removedVariables,
            }],
          ]));
          warnings.push(...sync.warnings);
          unscanned = mergeUnscannedReports(unscanned, sync.unscanned);
        }

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'object',
          action: 'updated',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
          ...unscannedFields(unscanned),
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
    'Delete an object type from the project (checks references first: events, including object parameters, expressions and runtime.objects in script actions; layout instances on any layer or sub-layer, including non-world instances; object properties of other instances; families). Refused without force while anything refers to the object; the response lists where. Event sheets, layouts and families that could not be parsed (over the 10MB read limit, not valid JSON) are searched as text for the name (and, in layouts, the SID): a match is a possible use and refuses without force, as does such a file that cannot be read at all; unscannedFiles lists them. References in project script files and objects created by name at runtime are not detected. The frame image files (or single image) of the object in images/ are kept as <file>.bak.',
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
        // Files the index could not parse: the name, and the SID an object property holds.
        // The object type's own file: without it, its SID is unknown
        const unscanned = mergeUnscannedReports(
          ownFileReports(index.unscannedFiles, [{
            category: 'objectTypes',
            name: args.name,
            unchecked: 'its SID is unknown, so object properties of instances that hold it could not be checked',
          }]),
          await checkUnscannedFiles(reader, index.unscannedFiles, nameOrSidRules(
            args.name, index.sidOf(args.name), ['eventSheets', 'layouts', 'families'],
          )),
        );
        const unscannedBlock = blocksWithoutForce(unscanned);

        if ((hasRefs || unscannedBlock) && !args.force) {
          const reasons = [
            ...(hasRefs ? [`Object is still referenced: ${describeObjectUsage(usage)}.`] : []),
            ...(unscannedBlock ? [unscannedRefusal(unscanned)] : []),
          ];
          return toolResult({
            success: false,
            entity: args.name,
            category: 'object',
            action: 'delete_blocked',
            message: `${reasons.join(' ')} Use force=true to delete anyway (references will NOT be cleaned up).`,
            references: {
              eventSheets: eventSheetRefs,
              layouts: layoutRefs,
              families: usage.families,
              ...usageDetails(usage),
            },
            ...unscannedFields(unscanned),
          });
        }

        const warnings: string[] = [];
        if (hasRefs && args.force) {
          warnings.push(`Object deleted but still referenced: ${describeObjectUsage(usage)}. References were NOT cleaned up.`);
          const unreported = unreportedUsesWarning(usage.events);
          if (unreported) warnings.push(unreported);
        }
        warnings.push(...unscannedWarnings(unscanned, 'Deleted'));

        // Its frame images (or single image) lose their user: kept as .bak, like
        // the image of a deleted frame. Renamed first; when the object file cannot
        // be deleted or project.c3proj not updated, the object file is restored
        // and the images renamed back.
        const images = await planDeletedObjectImages(reader, writer, args.name);
        const renames = images.parking?.renames ?? [];
        if (renames.length > 0) await writer.renameImageFiles(renames);
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.name);
        let backupPath: string | undefined;
        try {
          backupPath = await writer.deleteEntityFile('objectTypes', args.name, subfolder);
          await writer.removeFromProject('objectTypes', args.name);
        } catch (error) {
          const rollback = await rollBackObjectDelete(writer, backupPath, renames);
          if (rollback === '') throw error;
          throw new Error(`${error instanceof Error ? error.message : String(error)}. ${rollback}`);
        }
        warnings.push(...images.warnings);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'object',
          action: 'deleted',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
          ...unscannedFields(unscanned),
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
    'Update a family: add/remove members, add/remove shared instance variables. Removing an instance variable that events still use (on the family, or through a member that gets it from this family only), or a member through which events use the family\'s instance variables or behaviors, is refused without force, listing the uses. Removing a member also warns when events use the family itself, since they no longer apply to that member. Scripts are not checked; a warning names scripts that read a name a member loses. Event sheets that could not be parsed (over the 10MB read limit, not valid JSON) are searched as text: one that names a removed variable (or, for a removed member, one of the family\'s variables or behaviors) together with the family or member (a possible use), or that cannot be read at all, also refuses without force; they are listed in unscannedFiles.',
    {
      name: z.string().max(200).describe('Family name to update, as registered (letter case included)'),
      addMembers: z.array(z.string().max(200)).optional().describe('Object type names to add to the family'),
      removeMembers: z.array(z.string().max(200)).optional().describe('Object type names to remove from the family'),
      addVariables: z.array(z.object({
        name: z.string().describe('Variable name'),
        type: z.enum(['number', 'string', 'boolean']).describe('Variable type'),
      })).optional().describe('Instance variables to add to all family members'),
      removeVariables: z.array(z.string()).optional().describe('Instance variable names to remove'),
      force: z.boolean().optional().default(false).describe('If true, remove instance variables and members even if events use them (the uses are NOT changed)'),
    },
    async (args) => {
      try {
        const hasUpdates = (args.addMembers?.length ?? 0) > 0 || (args.removeMembers?.length ?? 0) > 0 ||
          (args.addVariables?.length ?? 0) > 0 || (args.removeVariables?.length ?? 0) > 0;
        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: addMembers, removeMembers, addVariables, removeVariables.');
        }

        // The registered name only, as for update_object_properties
        const familyNames = await reader.listFamilies();
        if (!familyNames.includes(args.name)) {
          return entityNotFound('Family', args.name, familyNames, [], 'list_families');
        }

        let family: Record<string, unknown>;
        try {
          family = await reader.readFamily(args.name);
        } catch {
          return toolError(`Family "${args.name}" not found. Use list_families to see available families.`);
        }

        const warnings: string[] = [];

        // Before any change: events that use an instance variable, or the family's
        // instance variables and behaviors through a member, being removed
        const currentMembers = Array.isArray(family.members) ? family.members.filter((m): m is string => typeof m === 'string') : [];
        const leaving = [...new Set((args.removeMembers ?? []).filter(m => currentMembers.includes(m)))];
        const variablesToRemove = existingNames(family.instanceVariables, args.removeVariables);
        const removal: MemberRemoval = {
          variables: new Map([[args.name, variablesToRemove]]),
          members: new Map([[args.name, leaving]]),
        };
        let unscanned: UnscannedFileReport[] = [];
        if (leaving.length > 0 || variablesToRemove.length > 0) {
          const index = await getProjectIndex(reader);
          const broken = index.findReferencesBrokenBy(removal);
          // What member instances lose: the removed variables, and for a leaving member
          // all of the family's instance variables and behaviors
          const familyVariables = entryNamesOf(family.instanceVariables);
          const familyBehaviors = entryNamesOf(family.behaviorTypes);
          const familyEffects = effectNamesOf(family);
          // Event sheets that could not be parsed: a use names what is removed and the
          // family or member it goes through
          unscanned = await checkUnscannedFiles(reader, index.unscannedFiles, [
            {
              categories: ['eventSheets'],
              allOf: [variablesToRemove.map(n => nameTerm(n)), [args.name, ...currentMembers].map(n => nameTerm(n))],
            },
            {
              categories: ['eventSheets'],
              allOf: [[...familyVariables, ...familyBehaviors, ...familyEffects].map(n => nameTerm(n)), leaving.map(n => nameTerm(n))],
            },
          ]);
          // The family's effects, named by conditions and actions on a leaving member
          const effects = await familyEffectUses(reader, args.name, { ...family, members: currentMembers.filter(m => !leaving.includes(m)) }, leaving);
          if ((broken.length > 0 || effects.broken.length > 0 || blocksWithoutForce(unscanned)) && !args.force) {
            return toolResult(removalBlocked(args.name, 'family', broken, unscanned, effects.broken));
          }
          warnings.push(...removalForcedWarnings(args.name, broken));
          warnings.push(...effectUseWarnings(effects, 'Removed'));
          warnings.push(...unscannedWarnings(unscanned, 'Removed'));
          warnings.push(...await scriptReadWarnings(reader, index, removal, [...new Set(currentMembers)].flatMap(member => [
            ...(leaving.includes(member) ? familyVariables : variablesToRemove)
              .map(name => ({ objectClass: member, kind: 'instance variable' as const, name })),
            ...(leaving.includes(member) ? familyBehaviors : [])
              .map(name => ({ objectClass: member, kind: 'behavior' as const, name })),
          ])));
          // Not checkable: whether events that use the family itself rely on these members being in it
          const familyEvents = index.getObjectUsage(args.name).events;
          if (leaving.length > 0 && familyEvents.length > 0) {
            const sheets = [...new Set(familyEvents.map(r => `"${r.eventSheet}"`))];
            warnings.push(
              `Events use family "${args.name}" ${familyEvents.length} time(s) (in ${listSome(sheets)}); they no longer apply to ` +
              `${listSome(leaving.map(m => `"${m}"`))} once ${leaving.length === 1 ? 'it leaves' : 'they leave'} the family. ` +
              'Whether they rely on these members cannot be checked: review them.');
          }
        }

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

        const addedVariables: string[] = [];
        const removedVariables: string[] = [];
        if (args.addVariables) {
          for (const v of args.addVariables) {
            if (vars.some(ev => ev.name === v.name)) {
              warnings.push(`Variable "${v.name}" already exists, skipping`);
              continue;
            }
            const sid = await idGen.generateSid(reader);
            vars.push(createInstanceVariable(v.name, v.type, sid));
            addedVariables.push(v.name);
          }
        }

        if (args.removeVariables) {
          for (const varName of args.removeVariables) {
            const idx = vars.findIndex(v => v.name === varName);
            if (idx !== -1) {
              vars.splice(idx, 1);
              removedVariables.push(varName);
            } else {
              warnings.push(`Variable "${varName}" not found, skipping`);
            }
          }
        }

        const subfolder = writer.getSubfolderForEntity('families', args.name);
        const backupPath = await writer.writeEntityFile('families', args.name, family, subfolder);

        // Instances of members that joined get entries for the family's
        // behaviors and values for its instance variables, instances of members
        // that left lose them and the entries for its effects; instances of the
        // other members get values for added variables and lose removed ones
        const familyBehaviors = behaviorTypesOf(family).map(b => b.name);
        const familyVariables = instanceVariablesOf(family).map(v => v.name);
        const familyEffects = effectNamesOf(family);
        const memberChanges: FamilyMemberChange[] = [...new Set([...membersBefore, ...members])].map(member => {
          const joined = members.includes(member) && !membersBefore.includes(member);
          const left = membersBefore.includes(member) && !members.includes(member);
          if (joined) return { member, addBehaviors: familyBehaviors, addVariables: familyVariables };
          if (left) return { member, dropBehaviors: familyBehaviors, dropVariables: [...familyVariables, ...removedVariables], dropEffects: familyEffects };
          return { member, addVariables: addedVariables, dropVariables: removedVariables };
        }).filter(hasFamilyMemberChange);
        if (memberChanges.length > 0) {
          const families = new Map(await readFamiliesForInstances(reader));
          families.set(args.name, family);
          const { plans, warnings: planWarnings } = await familyMemberPlans(reader, families, memberChanges);
          const sync = await syncLayoutInstances(reader, writer, plans);
          warnings.push(...planWarnings, ...sync.warnings);
          unscanned = mergeUnscannedReports(unscanned, sync.unscanned);
        }

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'family',
          action: 'updated',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
          ...unscannedFields(unscanned),
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
    'Delete a family from the project (checks references first: events that name the family, including object parameters, expressions and runtime.objects in script actions; object properties of instances that hold its SID; its instance variables and behaviors used through a member object type, as the instance variable parameter or behavior of a condition/action on the member, as "Member.name" in an expression, or as "Self.name" in an expression of a condition/action on the member). Refused without force while anything refers to the family; the response lists where. Event sheets and layouts that could not be parsed (over the 10MB read limit, not valid JSON) are searched as text for the family\'s name and SID, and event sheets for its instance variables and behaviors together with a member\'s name: a match is a possible use and refuses without force, as does such a file that cannot be read at all; unscannedFiles lists them. The member object types are kept. The family\u2019s effects count too, when a condition or action on a member names one ("effect" parameter, e.g. Set effect parameter) and the member has no effect of that name itself or through another family. References in project script files and script access to instance variables and behaviors of member instances are not detected.',
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

        // Read before deleting: its effects are checked, and the members' instances lose
        // the entries for its behaviors and effects and the values of its variables
        let family: Record<string, unknown> | undefined;
        try {
          family = await reader.readFamily(args.name);
        } catch {
          family = undefined;
        }

        // Check references: uses by name (as for delete_object) and uses through members
        const index = await getProjectIndex(reader);
        const { events, instanceProperties } = index.getObjectUsage(args.name);
        const usage: ObjectUsage = { events, placements: [], instanceProperties, families: [], usedFamilies: [] };
        const memberUses = index.getFamilyMemberUses(args.name);
        // Its effects, named by conditions and actions on a member
        const effects = family
          ? await familyEffectUses(reader, args.name, undefined, index.familyMembers.get(args.name) ?? [], family)
          : { broken: [], unknown: [] };
        const hasRefs = events.length > 0 || instanceProperties.length > 0 || memberUses.length > 0 || effects.broken.length > 0;
        const description = [describeObjectUsage(usage), describeMemberUses(memberUses), describeEffectUses(effects.broken)]
          .filter(Boolean).join('; ');
        // Files the index could not parse: the family's name and SID, and in event sheets its
        // instance variables, behaviors and effects together with a member's name
        const familyMemberNames = [
          ...index.memberNamesOf(args.name, 'instance variable'),
          ...index.memberNamesOf(args.name, 'behavior'),
          ...effectNamesOf(family),
        ];
        // The family's own file: without it, its members, names and SID are unknown
        let unscanned = mergeUnscannedReports(
          ownFileReports(index.unscannedFiles, [{
            category: 'families',
            name: args.name,
            unchecked: 'its members, instance variables, behaviors and SID are unknown, so uses through its members ' +
              'and object properties of instances that hold its SID could not be checked',
          }]),
          await checkUnscannedFiles(reader, index.unscannedFiles, [
            ...nameOrSidRules(args.name, index.sidOf(args.name), ['eventSheets', 'layouts']),
            {
              categories: ['eventSheets'],
              allOf: [familyMemberNames.map(n => nameTerm(n)), (index.familyMembers.get(args.name) ?? []).map(n => nameTerm(n))],
            },
          ]),
        );
        const unscannedBlock = blocksWithoutForce(unscanned);

        if ((hasRefs || unscannedBlock) && !args.force) {
          const reasons = [
            ...(hasRefs ? [`Family is still referenced: ${description}.`] : []),
            ...(unscannedBlock ? [unscannedRefusal(unscanned)] : []),
          ];
          return toolResult({
            success: false,
            entity: args.name,
            category: 'family',
            action: 'delete_blocked',
            message: `${reasons.join(' ')} Use force=true to delete anyway (references will NOT be cleaned up).`,
            references: {
              eventSheets: [...new Set([...events, ...memberUses, ...effects.broken].map(r => r.eventSheet))],
              layouts: [...new Set(instanceProperties.map(p => p.layout))],
              ...boundedLists({
                events: eventUseList(events), instanceProperties, memberUses,
                ...(effects.broken.length > 0 ? { effectUses: effectUseList(effects.broken) } : {}),
              }),
            },
            ...unscannedFields(unscanned),
          });
        }

        const warnings: string[] = [];
        if (hasRefs && args.force) {
          warnings.push(`Family deleted but still referenced: ${description}. References were NOT cleaned up.`);
          // validate_project reports the other member uses: as missing-behavior-or-variable,
          // and those under the legacy "behavior-type" key as legacy-behavior-key
          const unreportedMemberUses = index.getFamilyMemberReferences(args.name)
            .filter(ref => ref.form === 'member-expression')
            .map(toFamilyMemberUse);
          const unreported = unreportedUsesWarning(events, unreportedMemberUses);
          if (unreported) warnings.push(unreported);
        }
        warnings.push(...effectUseWarnings({ broken: args.force ? effects.broken : [], unknown: effects.unknown }, 'Deleted'));
        warnings.push(...unscannedWarnings(unscanned, 'Deleted'));

        const subfolder = writer.getSubfolderForEntity('families', args.name);
        const backupPath = await writer.deleteEntityFile('families', args.name, subfolder);
        await writer.removeFromProject('families', args.name);

        // Instances of the former members lose the entries for the family's
        // behaviors and effects and the values of its instance variables
        const familyBehaviors = behaviorTypesOf(family).map(b => b.name);
        const formerMembers = Array.isArray(family?.members)
          ? [...new Set(family.members.filter((m): m is string => typeof m === 'string'))]
          : [];
        const memberChanges: FamilyMemberChange[] = formerMembers.map(member => ({
          member,
          dropBehaviors: familyBehaviors,
          dropVariables: instanceVariablesOf(family).map(v => v.name),
          dropEffects: effectNamesOf(family),
        })).filter(hasFamilyMemberChange);
        if (memberChanges.length > 0) {
          const families = new Map(await readFamiliesForInstances(reader));
          families.delete(args.name);
          const { plans, warnings: planWarnings } = await familyMemberPlans(reader, families, memberChanges);
          const sync = await syncLayoutInstances(reader, writer, plans);
          warnings.push(...planWarnings, ...sync.warnings);
          unscanned = mergeUnscannedReports(unscanned, sync.unscanned);
        }

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'family',
          action: 'deleted',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
          ...unscannedFields(unscanned),
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_family] failed:', error);
        return toolError(`Error deleting family: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}

/**
 * Undo what delete_object did before a step failed: restore the object file
 * from `backupPath` (when it was deleted) and rename the image files back
 * from .bak (`renames`, as made). Returns sentences on what was undone and
 * what could not be, naming the files to recover by hand; empty when there
 * was nothing to undo.
 */
async function rollBackObjectDelete(
  writer: Construct3ProjectWriter,
  backupPath: string | undefined,
  renames: ReadonlyArray<{ from: string; to: string }>,
): Promise<string> {
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const sentences: string[] = [];
  if (backupPath !== undefined) {
    try {
      await writer.restoreEntityFile(backupPath);
      sentences.push('The object file was restored from its backup.');
    } catch (e) {
      sentences.push(`Restoring the object file failed (${message(e)}): ${backupPath} holds it.`);
    }
  }
  if (renames.length > 0) {
    try {
      await writer.renameImageFiles(renames.map(r => ({ from: r.to, to: r.from })).reverse());
      sentences.push('Its image files were renamed back from .bak.');
    } catch (e) {
      sentences.push(`Renaming its image files back from .bak failed too (${message(e)}); rename them back by hand: ` +
        `${renames.map(r => `"images/${r.to}" → "images/${r.from}"`).join(', ')}.`);
    }
  }
  return sentences.join(' ');
}

/**
 * How delete_object keeps the image files of the object type it deletes (see
 * planObjectImageParking), with the warnings to return; no plan when the
 * object type's file cannot be parsed (its images are unknown).
 */
async function planDeletedObjectImages(
  reader: Construct3ProjectReader,
  writer: Construct3ProjectWriter,
  name: string,
): Promise<{ parking?: ObjectImageParking; warnings: string[] }> {
  let obj: ObjectType;
  try {
    obj = await reader.readObjectType(name);
  } catch (error) {
    if (classifyReadError(error) === 'E_FILE_NOT_FOUND') return { warnings: [] };
    return {
      warnings: [`The object type's file could not be parsed, so its image files in images/ are unknown and were left as they are. ` +
        'validate_project lists files in images/ named after no object type (orphaned-image).'],
    };
  }
  const stored = typeof obj.name === 'string' && obj.name !== '' ? obj.name : name;
  const objects = await reader.readAllObjectTypes();
  const failures = reader.getReadFailures('objectTypes');
  const others = new Map([...objects].filter(([other]) => other !== name));
  const unparsed = (await reader.listObjectTypes())
    .filter(other => other !== name && !objects.has(other) && failures.get(other)?.code !== 'E_FILE_NOT_FOUND');
  const parking = planObjectImageParking(stored, obj, await writer.listImageFiles(), others, unparsed);

  const warnings: string[] = [];
  if (parking.renames.length > 0) {
    warnings.push(`Kept the object's ${parking.renames.length} image file(s) in images/ as .bak: ${listSome(parking.renames.map(r => `"images/${r.from}" → "images/${r.to}"`), 3)}. ` +
      'No object uses them; delete them when they are no longer needed.');
  }
  if (parking.shared.length > 0) {
    warnings.push(`Left ${listSome(parking.shared.map(f => `"images/${f}"`), 3)} in place: another object type's frames use a file of the same name.`);
  }
  if (parking.unknownUse.length > 0) {
    warnings.push(`Left ${listSome(parking.unknownUse.map(f => `"images/${f}"`), 3)} in place: named after an object type whose file could not be parsed, ` +
      'which may use them.');
  }
  return { parking, warnings };
}

/**
 * Conditions and actions on `members` that name an effect of the family
 * `familyName` that the member no longer has once the change is made
 * (`broken`), and those on such a member whose effect parameter is another
 * expression than a quoted name (`unknown`, which cannot be checked). The
 * family's effects come from `familyBefore` (default: `familyAfter`);
 * `familyAfter` is the family after the change (undefined: deleted). A member
 * whose object type file cannot be read counts as having none of the effects
 * itself.
 */
async function familyEffectUses(
  reader: Construct3ProjectReader,
  familyName: string,
  familyAfter: Record<string, unknown> | undefined,
  members: readonly string[],
  familyBefore: Record<string, unknown> | undefined = familyAfter,
): Promise<{ broken: EffectUse[]; unknown: EffectUse[] }> {
  const familyEffects = effectNamesOf(familyBefore);
  if (familyEffects.length === 0 || members.length === 0) return { broken: [], unknown: [] };
  const families = new Map(await readFamiliesForInstances(reader));
  if (familyAfter) families.set(familyName, familyAfter); else families.delete(familyName);
  const kept = new Map<string, string[]>();
  for (const member of members) {
    let obj: unknown;
    try {
      obj = await reader.readObjectType(member);
    } catch {
      obj = undefined;
    }
    kept.set(member, expectedInstanceEffects(member, obj, families));
  }
  let sheets;
  try {
    sheets = await reader.readAllEventSheets();
  } catch {
    return { broken: [], unknown: [] };
  }
  return familyEffectUsesThroughMembers(findEffectUses(sheets), familyEffects, members, kept);
}

/** One sentence on uses of a family's effects through members, e.g. 'effect "Glow" of "Sprite1" used 2 time(s) in events of "Sheet1"'. */
function describeEffectUses(uses: EffectUse[]): string {
  if (uses.length === 0) return '';
  const what = [...new Set(uses.map(u => `effect "${u.name ?? u.expression}" of "${u.objectClass}"`))];
  const sheets = [...new Set(uses.map(u => `"${u.eventSheet}"`))];
  return `its effects used ${uses.length} time(s) through members in events of ${listSome(sheets)} (${listSome(what)})`;
}

/** Effect uses as listed in a refusal. */
function effectUseList(uses: EffectUse[]): Array<Record<string, unknown>> {
  return uses.map(u => ({
    eventSheet: u.eventSheet, eventPath: u.eventPath, ace: u.ace, ...(u.sid !== undefined ? { sid: u.sid } : {}),
    member: u.objectClass, effect: u.name,
  }));
}

/**
 * Warnings about a family's effects used through members: uses a forced
 * change leaves behind (validate_project does not check effect names), and
 * uses whose effect cannot be told.
 */
function effectUseWarnings(uses: { broken: EffectUse[]; unknown: EffectUse[] }, verb: 'Removed' | 'Deleted'): string[] {
  const warnings: string[] = [];
  if (uses.broken.length > 0) {
    warnings.push(`${verb} although events still use the family's effects through members: ${describeEffectUses(uses.broken)} ` +
      `(${listSome([...new Set(uses.broken.map(effectUseLocation))])}). The uses were NOT changed, and validate_project does not check ` +
      'effect names: fix them now.');
  }
  if (uses.unknown.length > 0) {
    warnings.push(`Conditions or actions on a member name an effect with an expression that is not a quoted name, so whether they use ` +
      `the family's effects could not be checked: ${listSome([...new Set(uses.unknown.map(u => `${effectUseLocation(u)} (${u.expression})`))])}. Review them.`);
  }
  return warnings;
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

/** Of the requested names, those of an existing entry (instance variable or behavior), as the removal matches them. */
function existingNames(entries: unknown, requested: string[] | undefined): string[] {
  if (!Array.isArray(entries) || !requested?.length) return [];
  const names = new Set(entries.map(e => (e && typeof e === 'object' ? (e as { name?: unknown }).name : undefined)));
  return [...new Set(requested.filter(name => names.has(name)))];
}

/**
 * One sentence on uses of instance variables and behaviors, e.g.
 * 'instance variable "hp" used 3 time(s) (2 condition, 1 expression); behavior
 * "Fade" through "Sprite1" used 1 time(s) (1 action) in events of "Sheet1"'.
 * "through" names the object type or family the use goes through when it is
 * not `entity` itself.
 */
function describeMemberReferences(entity: string, uses: MemberReference[]): string {
  const groups = new Map<string, { label: string; contexts: Map<string, number>; count: number }>();
  for (const use of uses) {
    const key = [use.kind, use.name.toLowerCase(), use.objectClass].join('\0');
    const group = groups.get(key) ?? {
      label: `${use.kind} "${use.name}"${use.objectClass !== entity ? ` through "${use.objectClass}"` : ''}`,
      contexts: new Map<string, number>(),
      count: 0,
    };
    group.contexts.set(use.context, (group.contexts.get(use.context) ?? 0) + 1);
    group.count++;
    groups.set(key, group);
  }
  const parts = [...groups.values()].map(g =>
    `${g.label} used ${g.count} time(s) (${[...g.contexts].map(([label, n]) => `${n} ${label}`).join(', ')})`);
  const shown = parts.slice(0, 5).join('; ') + (parts.length > 5 ? `; and ${parts.length - 5} more` : '');
  const sheets = [...new Set(uses.map(u => `"${u.eventSheet}"`))];
  return `${shown} in events of ${listSome(sheets)}`;
}

/** Uses of instance variables and behaviors as listed in a refusal. */
function memberUseList(uses: MemberReference[]): MemberReference[] {
  return uses.map(({ eventSheet, path, eventPath, sid, objectClass, kind, name, context, form }) =>
    ({ eventSheet, path, eventPath, ...(sid !== undefined ? { sid } : {}), objectClass, kind, name, context, form }));
}

/**
 * Where a use is, e.g. '"Sheet1" block > action:0 at events[3]' (the event's
 * JSON path tells apart sibling events whose event path is the same), or
 * 'scripts/main.js' for a script file.
 */
function useLocation(use: { eventSheet?: string; path: string; eventPath?: string }): string {
  if (use.eventSheet === undefined) return use.path;
  return `"${use.eventSheet}" ${use.path}${use.eventPath !== undefined ? ` at ${use.eventPath}` : ''}`;
}

/** Names of the named entries (instance variables, behaviors) of an object type or family file. */
function entryNamesOf(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map(e => (e && typeof e === 'object' ? (e as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string');
}

/**
 * One warning per instance variable or behavior that `lost` names (an object
 * type or family that has it now and no longer has it after `removal`) and
 * that scripts read by name (instVars.hp, behaviors.Fade in script actions,
 * script events and project script files). Scripts are not checked: which
 * object's instances they read cannot be told, so this only warns.
 */
async function scriptReadWarnings(
  reader: Construct3ProjectReader,
  index: ProjectIndex,
  removal: MemberRemoval,
  lost: Array<{ objectClass: string; kind: MemberReference['kind']; name: string }>,
): Promise<string[]> {
  const losers = new Map<string, { kind: MemberReference['kind']; name: string; objects: Set<string> }>();
  for (const { objectClass, kind, name } of lost) {
    if (!index.hasMember(objectClass, kind, name) || index.hasMember(objectClass, kind, name, removal)) continue;
    const key = `${kind}\0${name}`;
    if (!losers.has(key)) losers.set(key, { kind, name, objects: new Set() });
    losers.get(key)!.objects.add(objectClass);
  }
  if (losers.size === 0) return [];

  const { reads, unreadable } = await index.getScriptMemberReads(reader);
  const warnings: string[] = [];
  for (const { kind, name, objects } of losers.values()) {
    // Script property names are case-sensitive
    const where = [...new Set(reads.filter(r => r.kind === kind && r.name === name).map(useLocation))];
    if (where.length === 0) continue;
    const access = kind === 'instance variable' ? `instVars.${name}` : `behaviors.${name}`;
    const owners = listSome([...objects].map(o => `"${o}"`));
    warnings.push(`Scripts read ${kind} "${name}" by name (${access}) in ${listSome(where)}, and ${owners} ` +
      `${objects.size === 1 ? 'no longer has' : 'no longer have'} it. Scripts are not checked, so whether they read it from ` +
      `${objects.size === 1 ? 'that object' : 'these objects'} cannot be told: review them.`);
  }
  if (warnings.length > 0 && unreadable.length > 0) {
    warnings.push(`${unreadable.length} script file(s) could not be read and were not searched: ${listSome(unreadable)}.`);
  }
  return warnings;
}

/**
 * The refusal of update_object_properties / update_family while events use
 * what it removes, or event sheets that could not be parsed possibly do.
 */
function removalBlocked(
  entity: string, category: 'object' | 'family', uses: MemberReference[], unscanned: UnscannedFileReport[],
  effectUses: EffectUse[] = [],
): Record<string, unknown> {
  const reasons = [
    ...(uses.length > 0 ? [`Events still use what this update removes: ${describeMemberReferences(entity, uses)}.`] : []),
    ...(effectUses.length > 0 ? [`Events still use the family's effects through a leaving member: ${describeEffectUses(effectUses)}.`] : []),
    ...(blocksWithoutForce(unscanned) ? [unscannedRefusal(unscanned)] : []),
  ];
  return {
    success: false,
    entity,
    category,
    action: 'update_blocked',
    message: `${reasons.join(' ')} Nothing was changed. Use force=true to remove anyway (the uses will NOT be changed).`,
    references: {
      eventSheets: [...new Set([...uses, ...effectUses].map(u => u.eventSheet))],
      ...boundedLists({ uses: memberUseList(uses), ...(effectUses.length > 0 ? { effectUses: effectUseList(effectUses) } : {}) }),
    },
    ...unscannedFields(unscanned),
  };
}

/**
 * What delete_object and delete_family look for in files the index could not
 * parse: the name in files of `categories`, and in layouts the SID (object
 * properties of instances store an object type's or family's SID).
 */
function nameOrSidRules(name: string, sid: number | undefined, categories: EntityCategory[]): UseRule[] {
  return [
    { categories, allOf: [[nameTerm(name)]] },
    ...(sid !== undefined && categories.includes('layouts')
      ? [{ categories: ['layouts'] as EntityCategory[], allOf: [[numberTerm(sid, `SID ${sid} of "${name}"`)]] }]
      : []),
  ];
}

/**
 * The warnings of a forced removal that leaves uses behind: what is left, and
 * the uses validate_project cannot report afterwards ("Name.member" in
 * expressions, which reads like one of the plugin's expressions once the name
 * is gone). validate_project reports the others as missing-behavior-or-variable,
 * except a behavior named under the legacy "behavior-type" key, which it reports
 * as legacy-behavior-key. Empty when nothing is left behind.
 */
function removalForcedWarnings(entity: string, uses: MemberReference[]): string[] {
  if (uses.length === 0) return [];
  const warnings = [`Removed although events still use it: ${describeMemberReferences(entity, uses)}. The uses were NOT changed.`];
  const unreported = uses.filter(u => u.form === 'member-expression');
  if (unreported.length > 0) {
    const where = [...new Set(unreported.map(useLocation))];
    const reportedAs = [
      ...(uses.some(u => u.form !== 'member-expression' && u.form !== 'legacy-behavior-type') ? ['missing-behavior-or-variable'] : []),
      ...(uses.some(u => u.form === 'legacy-behavior-type') ? ['legacy-behavior-key (the "behavior-type" key)'] : []),
    ];
    const others = reportedAs.length > 0 ? `reports the other uses as ${reportedAs.join(' or ')}, but ` : '';
    warnings.push(`validate_project ${others}will not report the ${unreported.length} use(s) written as "Name.member" or "Self.member" ` +
      `in expressions (${listSome(where)}), which it cannot tell apart from the plugin's own expressions: fix them now.`);
  }
  return warnings;
}

/**
 * Not found, for update_object_properties / update_family: names that differ
 * only in letter case get their own hint, since the name must be the
 * registered one.
 */
function entityNotFound(
  kind: 'Object' | 'Family', name: string, registered: string[], suggestions: string[], listTool: string,
): ReturnType<typeof toolError> {
  const sameIgnoringCase = registered.find(n => n.toLowerCase() === name.toLowerCase());
  if (sameIgnoringCase !== undefined) {
    return toolError(`${kind} "${name}" not found: names are matched with their letter case. Did you mean "${sameIgnoringCase}"?`);
  }
  return notFoundError(kind, name, suggestions, listTool);
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
 * afterwards (it reports the other leftovers as broken-object-reference and
 * missing-behavior-or-variable): uses in expressions and scripts, which are
 * recognised by the names of existing objects only, and the uses of a
 * family's instance variables and behaviors through its members written as
 * "Member.name" in expressions (`memberUses`: the caller passes only those).
 * Empty when there are none.
 */
function unreportedUsesWarning(events: ObjectReference[], memberUses: FamilyMemberUse[] = []): string {
  const inCode = events.filter(r => r.context === 'expression' || r.context === 'script');
  if (inCode.length === 0 && memberUses.length === 0) return '';
  const counts: string[] = [];
  if (inCode.length > 0) counts.push(`${inCode.length} use(s) in expressions and scripts`);
  if (memberUses.length > 0) {
    counts.push(`${memberUses.length} use(s) of its instance variables and behaviors through members written as "Member.name" in expressions`);
  }
  const where = [...new Set([...inCode, ...memberUses].map(useLocation))];
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
  /**
   * Instance variables the object's instances hold values for, after the
   * change; when given, every instance gets the default value of each one it
   * lacks (see syncInstanceVariables)
   */
  variables?: InstanceVariableDef[];
  /** Instance variable names the change added; values the instance lacked for other names are reported as missing before */
  addVariables?: string[];
  /** Instance variable names whose values are removed unless still expected */
  dropVariables?: string[];
  /** Effect names whose instance entries are removed unless the object type or its families still have the effect */
  dropEffects?: string[];
  /** The effects the object's instances carry entries for, after the change (with dropEffects) */
  effects?: string[];
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
 * defaults are not known. Layouts that could not be parsed (over the read
 * cap, not valid JSON) are not updated (issue #55): when a plan adds or drops
 * entries, their text is searched for the object types' names, and
 * `unscanned` reports them; a warning names those that possibly hold their
 * instances or could not be searched.
 */
async function syncLayoutInstances(
  reader: Construct3ProjectReader,
  writer: Construct3ProjectWriter,
  plans: ReadonlyMap<string, InstanceSyncPlan>,
): Promise<{ warnings: string[]; unscanned: UnscannedFileReport[] }> {
  const layouts = await reader.readAllLayouts();
  const layoutFailures = reader.getReadFailures('layouts');
  const modifiedLayouts: string[] = [];
  const unknownDefaults: InstanceBehavior[] = [];
  /** Per object type: instances that lacked entries the change did not add, and those behavior names */
  const backfilled = new Map<string, { instances: number; names: Set<string> }>();
  /** The same for instance variable values */
  const backfilledValues = new Map<string, { instances: number; names: Set<string> }>();
  const noteBackfill = (map: typeof backfilled, type: string, names: string[]) => {
    if (names.length === 0) return;
    const entry = map.get(type) ?? { instances: 0, names: new Set<string>() };
    entry.instances++;
    for (const name of names) entry.names.add(name);
    map.set(type, entry);
  };

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
      noteBackfill(backfilled, instance.type, synced.added.filter(name => !(plan.add ?? []).includes(name)));
      if (plan.variables) {
        const values = syncInstanceVariables(instance, plan.variables, { drop: plan.dropVariables });
        modified = values.modified || modified;
        noteBackfill(backfilledValues, instance.type, values.added.filter(name => !(plan.addVariables ?? []).includes(name)));
      }
      if (plan.dropEffects?.length) {
        modified = dropInstanceEffects(instance, plan.dropEffects, plan.effects ?? []).length > 0 || modified;
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
  for (const [objectType, entry] of backfilledValues) {
    const expected = plans.get(objectType)?.variables ?? [];
    const names = expected.map(v => v.name).filter(name => entry.names.has(name));
    warnings.push(`Also added default values for instance variable(s) ${names.map(n => `"${n}"`).join(', ')} to ${entry.instances} instance(s) of "${objectType}" `
      + 'that had none (written by an older version of construct3-mcp or edited by hand). Construct 3 stores a value for every instance variable of the object and its families on each instance.');
  }
  if (unknownDefaults.length > 0) warnings.push(unknownDefaultsWarning(unknownDefaults));

  const changing = [...plans].filter(([, plan]) => [plan.add, plan.drop, plan.addVariables, plan.dropVariables, plan.dropEffects]
    .some(list => (list?.length ?? 0) > 0));
  const skipped = unscannedFilesOf('layouts', await reader.listLayouts(), layouts, layoutFailures);
  const unscanned = changing.length > 0 && skipped.length > 0
    ? await checkUnscannedFiles(reader, skipped, [{ categories: ['layouts'], allOf: [changing.map(([name]) => nameTerm(name))] }])
    : [];
  warnings.push(...unsyncedLayoutWarnings(unscanned));
  return { warnings, unscanned };
}

/**
 * Warnings for the layouts syncLayoutInstances could not parse: those whose
 * text names an object type whose instances it updates (possibly instances,
 * left as they were), and those it could not search.
 */
function unsyncedLayoutWarnings(reports: readonly UnscannedFileReport[]): string[] {
  const warnings: string[] = [];
  const possible = reports.filter(r => r.textSearch === 'possible-use');
  const unreadable = reports.filter(r => r.textSearch === 'unreadable');
  if (possible.length > 0) {
    warnings.push('Instances in layouts that could not be parsed were NOT updated: ' +
      possible.map(r => `${describeUnscannedFile(r)}, whose text names ${(r.names ?? []).map(n => `"${n}"`).join(', ')}`).join('; ') +
      '. Instances there possibly still have the old behavior entries, instance variable values or effect entries (a text search cannot tell an instance from the same name ' +
      'in another string); check them in the Construct 3 editor.');
  }
  if (unreadable.length > 0) {
    warnings.push('Layouts that could not be parsed could not be searched for instances either, and were NOT updated: ' +
      `${unreadable.map(describeUnscannedFile).join(', ')}.`);
  }
  return warnings;
}

/**
 * What a family change adds to or removes from the instances of one member:
 * behavior entries, instance variable values, effect entries (names of the
 * family's behaviors, variables and effects). A name is only removed while
 * the member does not keep it through itself or another family.
 */
interface FamilyMemberChange {
  member: string;
  addBehaviors?: string[];
  dropBehaviors?: string[];
  addVariables?: string[];
  dropVariables?: string[];
  dropEffects?: string[];
}

function hasFamilyMemberChange(change: FamilyMemberChange): boolean {
  return [change.addBehaviors, change.dropBehaviors, change.addVariables, change.dropVariables, change.dropEffects]
    .some(list => (list?.length ?? 0) > 0);
}

/**
 * Sync plans for family members whose instances a family change affects
 * (see FamilyMemberChange). `families` is the project's families after the
 * change.
 */
async function familyMemberPlans(
  reader: Construct3ProjectReader,
  families: ReadonlyMap<string, unknown>,
  changes: FamilyMemberChange[],
): Promise<{ plans: Map<string, InstanceSyncPlan>; warnings: string[] }> {
  const plans = new Map<string, InstanceSyncPlan>();
  const warnings: string[] = [];
  for (const change of changes) {
    const { member } = change;
    let obj: unknown;
    try {
      obj = await reader.readObjectType(member);
    } catch (error) {
      // A missing object type has no instances to update. One whose file could not be
      // parsed does (issue #55), but the entries its instances should have are unknown
      const code = classifyReadError(error);
      if (code !== 'E_FILE_NOT_FOUND') {
        const names = [
          ...(change.addBehaviors ?? []), ...(change.dropBehaviors ?? []),
          ...(change.addVariables ?? []), ...(change.dropVariables ?? []), ...(change.dropEffects ?? []),
        ];
        warnings.push(`Instances of "${member}" were NOT updated: objectTypes/${member} (${describeReadFailure(code)}) could not ` +
          `be parsed, so the behaviors, instance variables and effects its instances need entries for are unknown. Their entries and values ` +
          `for the family's ${[...new Set(names)].map(b => `"${b}"`).join(', ')} were left as they were; check them in the Construct 3 editor.`);
      }
      continue;
    }
    plans.set(member, {
      expected: expectedInstanceBehaviors(member, obj, families),
      add: change.addBehaviors ?? [],
      drop: change.dropBehaviors ?? [],
      variables: expectedInstanceVariables(member, obj, families),
      addVariables: change.addVariables ?? [],
      dropVariables: change.dropVariables ?? [],
      dropEffects: change.dropEffects ?? [],
      effects: expectedInstanceEffects(member, obj, families),
    });
  }
  return { plans, warnings };
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
