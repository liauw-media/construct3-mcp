/**
 * Layout tools: create_layout, add_instance_to_layout, delete_layout, update_layout,
 * add_layer, delete_layer, update_layer, delete_instance_from_layout, update_instance.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, Layout, Layer } from '../construct3/types.js';
import { validateName, toolResult, toolError, notFoundError, boundedRecord, caseClashError } from './shared.js';
import { findNameClash } from '../construct3/names.js';
import { getProjectIndex } from '../construct3/analyzers/index-builder.js';
import {
  DEFAULT_INSTANCE_PROPERTIES,
  createLayout,
  createInstance,
  createLayer,
} from '../construct3/templates.js';
import type { InstanceOverrides } from '../construct3/templates.js';
import {
  buildInstanceBehaviors,
  expectedInstanceBehaviors,
  readFamiliesForInstances,
} from '../construct3/instance-behaviors.js';
import {
  countInstancesInLayerTree,
  findInstanceByUid,
  findLayerNameClash,
  findLayersByName,
  layerEntries,
  layerPathLabel,
  type LayerEntry,
} from '../construct3/layers.js';

/** Every layer of a layout for messages, sub-layers as paths: "Background, Main, Main > HUD". */
function layerList(layout: Layout): string {
  return layerEntries(layout.layers).map(layerPathLabel).join(', ');
}

/**
 * The layer with this name anywhere in the layout's layer tree (sub-layers
 * included), or the error text when there is none, or several. A sub-layer can
 * also be given by its path as messages list it ("Main > HUD"): that picks one
 * of several layers with the same name, e.g. to rename it with update_layer.
 */
function resolveLayer(layout: Layout, layerName: string, layoutName: string): { entry: LayerEntry } | { error: string } {
  const matches = findLayersByName(layout.layers, layerName);
  if (matches.length === 1) return { entry: matches[0] };
  if (layerName.includes(' > ')) {
    const byPath = layerEntries(layout.layers).filter(e => e.depth > 0 && layerPathLabel(e) === layerName);
    if (byPath.length === 1) return { entry: byPath[0] };
  }
  if (matches.length === 0) {
    return { error: `Layer "${layerName}" not found in layout "${layoutName}". Available layers: ${layerList(layout)}` };
  }
  const paths = matches.map(layerPathLabel);
  // Sub-layers whose path tells them apart can be picked by that path
  const pickable = matches.filter((e, i) => e.depth > 0 && paths.indexOf(paths[i]) === paths.lastIndexOf(paths[i]));
  const how = pickable.length > 0
    ? `Give a sub-layer by its path to pick it (e.g. "${layerPathLabel(pickable[0])}") and rename it with update_layer.`
    : 'Their paths are the same too: rename all but one of them in the layout file.';
  return {
    error: `Layer name "${layerName}" is used by ${matches.length} layers in layout "${layoutName}" (${paths.join('; ')}). ` +
      `Layer names must be unique within a layout, sub-layers included. ${how}`,
  };
}

/**
 * Error text for a layer name that another layer of the layout (`clash`, from
 * findLayerNameClash) already uses, exactly or ignoring case.
 */
function layerNameClashError(name: string, clash: LayerEntry, layoutName: string): string {
  const where = clash.depth > 0 ? ` (sub-layer "${layerPathLabel(clash)}")` : '';
  if (clash.layer.name === name) {
    return `Layer "${name}" already exists in layout "${layoutName}"${where}. ` +
      'Layer names must be unique within a layout, sub-layers included.';
  }
  return `Layer "${name}" differs only in case from the existing layer "${String(clash.layer.name)}"${where} ` +
    `in layout "${layoutName}". Construct 3 treats layer names that differ only in case as the same name ` +
    '(sub-layers included). Choose a different name.';
}

/** Where an instance sits, for messages: 'layer "Main"', 'sub-layer "Main > Sub"' or 'the non-world instances'. */
function describeInstancePlace(entry: LayerEntry | undefined): string {
  if (!entry) return 'the non-world instances';
  return `${entry.depth > 0 ? 'sub-layer' : 'layer'} "${layerPathLabel(entry)}"`;
}

export function registerLayoutTools({ server, reader, writer, idGen }: MutationToolDeps) {
  // ─── create_layout ────────────────────────────────────────

  server.tool(
    'create_layout',
    'Create a new layout in the project',
    {
      name: z.string().max(200).describe('Layout name (must not match an existing layout name, ignoring case)'),
      width: z.number().int().positive().optional().describe('Width in pixels (default: project viewport width)'),
      height: z.number().int().positive().optional().describe('Height in pixels (default: project viewport height)'),
      eventSheet: z.string().max(200).optional().describe('Linked event sheet name'),
      layers: z.array(z.string()).optional().describe('Layer names, different from each other ignoring case (default: single "Layer 0")'),
    },
    async (args) => {
      try {
        validateName(args.name);

        // Check uniqueness: the editor compares layout names ignoring case, project-wide
        const existing = await reader.listLayouts();
        if (existing.includes(args.name)) {
          return toolError(`Layout "${args.name}" already exists.`);
        }
        const nameClash = findNameClash(args.name, existing);
        if (nameClash) {
          return toolError(caseClashError('layout', args.name, nameClash));
        }
        // The editor refuses a layer name used by another layer of the layout, ignoring case
        const newLayerNames = args.layers ?? [];
        for (let i = 1; i < newLayerNames.length; i++) {
          const layerClash = findLayerNameClash(newLayerNames.slice(0, i).map(name => ({ name })), newLayerNames[i]);
          if (layerClash) return toolError(layerNameClashError(newLayerNames[i], layerClash, args.name));
        }
        // Never replace an existing file
        const fileRefusal = await writer.entityFileRefusal('layouts', args.name);
        if (fileRefusal) return toolError(fileRefusal);

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

        await writer.writeEntityFile('layouts', args.name, data, undefined, { createOnly: true });
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
        console.error('[create_layout] failed:', error);
        return toolError(`Error creating layout: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_instance_to_layout ───────────────────────────────

  server.tool(
    'add_instance_to_layout',
    'Place an object instance on a layout layer or sub-layer. For copying instances between layouts, read the source with get_layout_details and pass instance properties here — all visual and behavioral properties (angle, color, instanceVariables, behaviors, etc.) are preserved when specified.',
    {
      layoutName: z.string().max(200).describe('Target layout'),
      layerName: z.string().max(200).describe('Target layer within layout (any layer or sub-layer, by name; a sub-layer can also be given by its path, e.g. "Main > HUD")'),
      objectType: z.string().max(200).describe('Object type name to place'),
      x: z.number().describe('X position'),
      y: z.number().describe('Y position'),
      width: z.number().optional().default(100).describe('Instance width'),
      height: z.number().optional().default(100).describe('Instance height'),
      properties: boundedRecord()
        .refine(obj => JSON.stringify(obj).length <= 50_000, 'Properties payload too large (max 50KB)')
        .optional()
        .describe('Plugin-specific instance properties — auto-filled for known plugins if omitted (max 100 keys, depth 6)'),
      // Instance-level overrides
      angle: z.number().optional().describe('Rotation angle in radians (default: 0)'),
      color: z.array(z.number().min(0).max(1)).length(4).optional().describe('RGBA tint as [r, g, b, a] with values 0-1 (default: [1,1,1,1])'),
      zElevation: z.number().optional().describe('Z elevation for 3D layering (default: 0)'),
      originX: z.number().min(0).max(1).optional().describe('Horizontal origin 0-1 (default: 0.5 = center)'),
      originY: z.number().min(0).max(1).optional().describe('Vertical origin 0-1 (default: 0.5 = center)'),
      instanceVariables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
        .describe('Instance variable values as {varName: value}'),
      behaviors: z.record(z.string(), boundedRecord())
        .refine(obj => Object.keys(obj).length <= 50, 'Too many behaviors (max 50)')
        .refine(obj => JSON.stringify(obj).length <= 50_000, 'Behaviors payload too large (max 50KB)')
        .optional()
        .describe('Behavior property values as {behaviorName: {properties: {prop: val}}} (the shape get_layout_details returns) or {behaviorName: {prop: val}}. Every behavior of the object and its families gets an entry with the built-in defaults; values given here override them. Use the property ids the editor writes (e.g. "max-speed"). Each behavior: max 100 keys, depth 6'),
      tags: z.string().max(500).regex(/^[a-zA-Z0-9_, ]*$/).optional()
        .describe('Comma-separated instance tags (default: empty)'),
      showing: z.boolean().optional().describe('Whether instance is initially visible (default: true)'),
      locked: z.boolean().optional().describe('Whether instance is locked in the editor (default: false)'),
    },
    async (args) => {
      try {
        // Validate object type exists and read its plugin ID
        let pluginId: string | undefined;
        let isNonworld = false;
        let objData: import('../construct3/types.js').ObjectType | undefined;
        try {
          const obj = await reader.readObjectType(args.objectType);
          objData = obj;
          pluginId = obj['plugin-id'];
          // Block global-only objects from being placed on layouts
          if (obj['singleglobal-inst']) {
            return toolError(`Object "${args.objectType}" is a global plugin (${pluginId}) and cannot be placed on layouts.`);
          }
          // Nonworld-global objects (Arr, Json, Dictionary) go in nonworld-instances, not on layers
          if (obj.isGlobal === true) {
            isNonworld = true;
          }
        } catch {
          return toolError(`Object type "${args.objectType}" does not exist. Use list_objects to see available objects.`);
        }

        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        const uid = await idGen.generateUid(reader);
        const sid = await idGen.generateSid(reader);
        const warnings: string[] = [];

        // Validate instanceVariables keys against object type definition
        if (args.instanceVariables && objData) {
          const definedVars = new Set((objData.instanceVariables ?? []).map(v => v.name));
          for (const key of Object.keys(args.instanceVariables)) {
            if (!definedVars.has(key)) {
              warnings.push(`Instance variable "${key}" is not defined on "${args.objectType}". Defined variables: ${[...definedVars].join(', ') || '(none)'}. It may be inherited from a family.`);
            }
          }
        }

        // One behavior entry per behavior of the object and its families, like
        // the editor writes them; caller values override the defaults
        const expectedBehaviors = expectedInstanceBehaviors(
          args.objectType, objData, await readFamiliesForInstances(reader),
        );
        const instanceBehaviors = buildInstanceBehaviors(args.objectType, expectedBehaviors, args.behaviors);
        warnings.push(...instanceBehaviors.warnings);

        // Build overrides from optional params
        const overrides: InstanceOverrides = {};
        if (args.angle !== undefined) overrides.angle = args.angle;
        if (args.color !== undefined) overrides.color = args.color;
        if (args.zElevation !== undefined) overrides.zElevation = args.zElevation;
        if (args.originX !== undefined) overrides.originX = args.originX;
        if (args.originY !== undefined) overrides.originY = args.originY;
        if (args.instanceVariables !== undefined) overrides.instanceVariables = args.instanceVariables;
        overrides.behaviors = instanceBehaviors.behaviors;
        if (args.tags !== undefined) overrides.tags = args.tags;
        if (args.showing !== undefined) overrides.showing = args.showing;
        if (args.locked !== undefined) overrides.locked = args.locked;

        if (isNonworld) {
          if (!layout['nonworld-instances']) layout['nonworld-instances'] = [];
          layout['nonworld-instances'].push({
            type: args.objectType,
            properties: args.properties ?? {},
            uid,
            sid,
            tags: overrides.tags ?? '',
            instanceVariables: overrides.instanceVariables ?? {},
            behaviors: instanceBehaviors.behaviors,
            showing: overrides.showing ?? true,
            locked: overrides.locked ?? false,
          });
          warnings.push(`"${args.objectType}" is a global (nonworld) object — placed in nonworld-instances instead of on a layer. Layer and position parameters were ignored.`);
        } else {
          // Any layer or sub-layer of the layout
          const resolved = resolveLayer(layout, args.layerName, args.layoutName);
          if ('error' in resolved) return toolError(resolved.error);
          const targetLayer = resolved.entry.layer;
          if (!Array.isArray(targetLayer.instances)) targetLayer.instances = [];

          const pluginProps = args.properties
            ?? (pluginId ? DEFAULT_INSTANCE_PROPERTIES[pluginId] : undefined)
            ?? {};

          if (!args.properties && pluginId && !DEFAULT_INSTANCE_PROPERTIES[pluginId]) {
            warnings.push(`No default instance properties known for plugin "${pluginId}". Instance created with empty properties — you may need to configure them in the C3 editor.`);
          }

          const instance = createInstance(
            args.objectType, uid, sid, args.x, args.y, args.width, args.height,
            pluginProps,
            overrides,
          );

          targetLayer.instances.push(instance);
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
        console.error('[add_instance_to_layout] failed:', error);
        return toolError(`Error adding instance: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_layout ────────────────────────────────────────

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
          return notFoundError('Layout', args.name, reader.findNearestName(args.name, 'layouts'), 'list_layouts');
        }

        // Block deletion of the startup layout unconditionally
        const metadata = reader.getMetadata();
        if (metadata.firstLayout === args.name) {
          return toolError(`Cannot delete "${args.name}" — it is the project's startup layout (firstLayout). Change the startup layout in project settings first.`);
        }

        // Check references via project index
        const index = await getProjectIndex(reader);

        const warnings: string[] = [];

        // Warn about bound event sheet
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
        console.error('[delete_layout] failed:', error);
        return toolError(`Error deleting layout: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_layout ────────────────────────────────────────

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
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.name);
        } catch {
          return notFoundError('Layout', args.name, reader.findNearestName(args.name, 'layouts'), 'list_layouts');
        }

        const warnings: string[] = [];

        // Validate and apply event sheet binding
        if (args.eventSheet !== undefined) {
          const sheets = await reader.listEventSheets();
          if (!sheets.includes(args.eventSheet)) {
            return notFoundError('Event sheet', args.eventSheet, reader.findNearestName(args.eventSheet, 'eventsheets'), 'list_eventsheets');
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
        console.error('[update_layout] failed:', error);
        return toolError(`Error updating layout: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_layer ────────────────────────────────────────────

  server.tool(
    'add_layer',
    'Add a new top-level layer to an existing layout',
    {
      layoutName: z.string().max(200).describe('Layout to add the layer to'),
      layerName: z.string().max(200).describe('New layer name (must not match any layer of the layout, sub-layers included, ignoring case)'),
      index: z.number().int().min(0).optional().describe('Insert at this position (0 = bottom, default: append to top)'),
      isInitiallyVisible: z.boolean().optional().default(true).describe('Layer starts visible (default: true)'),
      isTransparent: z.boolean().optional().default(true).describe('Layer is transparent (default: true)'),
      parallaxX: z.number().optional().default(1).describe('Horizontal parallax rate (default: 1)'),
      parallaxY: z.number().optional().default(1).describe('Vertical parallax rate (default: 1)'),
      blendMode: z.enum(['normal', 'additive', 'xor', 'copy', 'destination-over', 'source-in', 'destination-in', 'source-out', 'destination-out', 'source-atop', 'destination-atop']).optional().default('normal').describe('Blend mode (default: normal)'),
    },
    async (args) => {
      try {
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        // Check for a layer name used anywhere in this layout (sub-layers included), ignoring case like the editor
        const layerClash = findLayerNameClash(layout.layers, args.layerName);
        if (layerClash) {
          return toolError(layerNameClashError(args.layerName, layerClash, args.layoutName));
        }

        const layerSid = await idGen.generateSid(reader);
        const newLayer: Layer = {
          ...createLayer(args.layerName, layerSid),
          isInitiallyVisible: args.isInitiallyVisible,
          isTransparent: args.isTransparent,
          parallaxX: args.parallaxX,
          parallaxY: args.parallaxY,
          blendMode: args.blendMode,
        };

        if (args.index !== undefined) {
          layout.layers.splice(args.index, 0, newLayer);
        } else {
          layout.layers.push(newLayer);
        }

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          generatedSid: layerSid,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[add_layer] failed:', error);
        return toolError(`Error adding layer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_layer ─────────────────────────────────────────

  server.tool(
    'delete_layer',
    'Delete a layer or sub-layer from a layout, together with its sub-layers (a layout must keep at least one top-level layer)',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      layerName: z.string().max(200).describe('Layer name to delete (any layer or sub-layer; a sub-layer can also be given by its path, e.g. "Main > HUD")'),
      force: z.boolean().optional().default(false).describe('Delete even if the layer or its sub-layers contain instances (instances will be lost)'),
    },
    async (args) => {
      try {
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        const resolved = resolveLayer(layout, args.layerName, args.layoutName);
        if ('error' in resolved) return toolError(resolved.error);
        const { entry } = resolved;

        // Prevent deleting the last top-level layer
        if (entry.depth === 0 && entry.siblings.length <= 1) {
          return toolError(`Cannot delete the last layer in layout "${args.layoutName}". A layout must have at least one layer.`);
        }

        // Its sub-layers and all their instances go with it
        const instanceCount = countInstancesInLayerTree(entry.layer);
        const subLayerCount = layerEntries(entry.layer.subLayers).length;
        const withSubLayers = subLayerCount > 0 ? ` (including its ${subLayerCount} sub-layer(s))` : '';

        if (instanceCount > 0 && !args.force) {
          return toolResult({
            success: false,
            entity: args.layoutName,
            category: 'layout',
            action: 'delete_blocked',
            message: `Layer "${args.layerName}" contains ${instanceCount} instance(s)${withSubLayers}. ` +
              'Use force=true to delete the layer and all its instances.',
            instanceCount,
            ...(subLayerCount > 0 ? { subLayerCount } : {}),
          });
        }

        entry.siblings.splice(entry.index, 1);

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const warnings: string[] = [];
        if (instanceCount > 0) warnings.push(`Deleted layer contained ${instanceCount} instance(s)${withSubLayers} — they have been removed.`);
        if (subLayerCount > 0) warnings.push(`Its ${subLayerCount} sub-layer(s) were deleted with it.`);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_layer] failed:', error);
        return toolError(`Error deleting layer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_layer ─────────────────────────────────────────

  server.tool(
    'update_layer',
    'Update properties of an existing layer or sub-layer (name, visibility, parallax, blend mode, etc.)',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      layerName: z.string().max(200).describe('Layer name to update (any layer or sub-layer; a sub-layer can also be given by its path, e.g. "Main > HUD")'),
      newName: z.string().max(200).optional().describe('Rename the layer (must not match another layer of the layout, sub-layers included, ignoring case)'),
      isInitiallyVisible: z.boolean().optional().describe('Change initial visibility'),
      isInitiallyInteractive: z.boolean().optional().describe('Change initial interactivity'),
      isTransparent: z.boolean().optional().describe('Change transparency'),
      parallaxX: z.number().optional().describe('Horizontal parallax rate'),
      parallaxY: z.number().optional().describe('Vertical parallax rate'),
      blendMode: z.enum(['normal', 'additive', 'xor', 'copy', 'destination-over', 'source-in', 'destination-in', 'source-out', 'destination-out', 'source-atop', 'destination-atop']).optional().describe('Blend mode'),
      scaleRate: z.number().optional().describe('Scale rate (parallax zoom)'),
      zElevation: z.number().optional().describe('Z elevation for 3D layering'),
    },
    async (args) => {
      try {
        const hasUpdates = args.newName !== undefined || args.isInitiallyVisible !== undefined ||
          args.isInitiallyInteractive !== undefined || args.isTransparent !== undefined ||
          args.parallaxX !== undefined || args.parallaxY !== undefined ||
          args.blendMode !== undefined || args.scaleRate !== undefined || args.zElevation !== undefined;

        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: newName, isInitiallyVisible, isInitiallyInteractive, isTransparent, parallaxX, parallaxY, blendMode, scaleRate, zElevation.');
        }

        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        const resolved = resolveLayer(layout, args.layerName, args.layoutName);
        if ('error' in resolved) return toolError(resolved.error);
        const layer = resolved.entry.layer;

        // Check new name uniqueness like the editor: another layer's name (ignoring case, sub-layers
        // included) is taken, changing the case of this layer's own name is fine
        if (args.newName !== undefined && args.newName !== layer.name) {
          const layerClash = findLayerNameClash(layout.layers, args.newName, layer);
          if (layerClash) {
            return toolError(layerNameClashError(args.newName, layerClash, args.layoutName));
          }
          layer.name = args.newName;
        }

        if (args.isInitiallyVisible !== undefined) layer.isInitiallyVisible = args.isInitiallyVisible;
        if (args.isInitiallyInteractive !== undefined) layer.isInitiallyInteractive = args.isInitiallyInteractive;
        if (args.isTransparent !== undefined) layer.isTransparent = args.isTransparent;
        if (args.parallaxX !== undefined) layer.parallaxX = args.parallaxX;
        if (args.parallaxY !== undefined) layer.parallaxY = args.parallaxY;
        if (args.blendMode !== undefined) layer.blendMode = args.blendMode;
        if (args.scaleRate !== undefined) layer.scaleRate = args.scaleRate;
        if (args.zElevation !== undefined) layer.zElevation = args.zElevation;

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_layer] failed:', error);
        return toolError(`Error updating layer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_instance_from_layout ─────────────────────────

  server.tool(
    'delete_instance_from_layout',
    'Remove a placed object instance (on any layer or sub-layer, or a non-world instance) from a layout by its UID',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      uid: z.number().int().describe('UID of the instance to remove'),
    },
    async (args) => {
      try {
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        // Search every layer and sub-layer, then the non-world instances
        const found = findInstanceByUid(layout, args.uid);
        if (!found) {
          return toolError(`Instance with UID ${args.uid} not found in layout "${args.layoutName}". Use get_layout_details to see all instance UIDs.`);
        }
        const removedType = typeof found.instance.type === 'string' ? found.instance.type : undefined;
        found.list.splice(found.index, 1);

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
          warnings: removedType ? [`Removed instance of "${removedType}" (UID ${args.uid}) from ${describeInstancePlace(found.entry)}.`] : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_instance_from_layout] failed:', error);
        return toolError(`Error deleting instance: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_instance ─────────────────────────────────────

  server.tool(
    'update_instance',
    'Update properties of a placed instance on a layout, on any layer or sub-layer (position, size, angle, visibility, etc.; non-world instances ignore the spatial ones)',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      uid: z.number().int().describe('UID of the instance to update'),
      x: z.number().optional().describe('New X position'),
      y: z.number().optional().describe('New Y position'),
      width: z.number().optional().describe('New width'),
      height: z.number().optional().describe('New height'),
      angle: z.number().optional().describe('New rotation angle in radians'),
      zElevation: z.number().optional().describe('New Z elevation'),
      color: z.array(z.number().min(0).max(1)).length(4).optional().describe('New RGBA tint [r,g,b,a] values 0-1'),
      showing: z.boolean().optional().describe('Initial visibility'),
      locked: z.boolean().optional().describe('Locked in editor'),
      tags: z.string().max(500).optional().describe('Comma-separated tags'),
      instanceVariables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Instance variable values to update'),
    },
    async (args) => {
      try {
        const hasUpdates = args.x !== undefined || args.y !== undefined || args.width !== undefined ||
          args.height !== undefined || args.angle !== undefined || args.zElevation !== undefined ||
          args.color !== undefined || args.showing !== undefined || args.locked !== undefined ||
          args.tags !== undefined || args.instanceVariables !== undefined;

        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one property to update.');
        }

        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        // Find the instance on any layer or sub-layer, then among the non-world instances
        const found = findInstanceByUid(layout, args.uid);
        if (!found) {
          return toolError(`Instance with UID ${args.uid} not found in layout "${args.layoutName}". Use get_layout_details to see all instance UIDs.`);
        }
        const inst = found.instance;

        // Update world properties (non-world instances have none: spatial props are ignored for them)
        if (found.entry && inst.world) {
          if (args.x !== undefined) inst.world.x = args.x;
          if (args.y !== undefined) inst.world.y = args.y;
          if (args.width !== undefined) inst.world.width = args.width;
          if (args.height !== undefined) inst.world.height = args.height;
          if (args.angle !== undefined) inst.world.angle = args.angle;
          if (args.zElevation !== undefined) inst.world.zElevation = args.zElevation;
          if (args.color !== undefined) inst.world.color = args.color;
        }
        if (args.showing !== undefined) inst.showing = args.showing;
        if (args.locked !== undefined) inst.locked = args.locked;
        if (args.tags !== undefined) inst.tags = args.tags;
        if (args.instanceVariables !== undefined) {
          inst.instanceVariables = { ...(inst.instanceVariables ?? {}), ...args.instanceVariables };
        }

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_instance] failed:', error);
        return toolError(`Error updating instance: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
