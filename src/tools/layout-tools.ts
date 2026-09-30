/**
 * Layout tools: create_layout, add_instance_to_layout, delete_layout, update_layout,
 * add_layer, delete_layer, update_layer, delete_instance_from_layout, update_instance.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, Layout, Layer, EventSheet } from '../construct3/types.js';
import { validateName, toolResult, toolError, notFoundError, boundedRecord, caseClashError } from './shared.js';
import { findNameClash } from '../construct3/names.js';
import { getProjectIndex } from '../construct3/analyzers/index-builder.js';
import {
  blocksWithoutForce,
  checkUnscannedFiles,
  describeUnscannedFile,
  unscannedFields,
  unscannedFilesOf,
  unscannedWarnings,
  type UnscannedFileReport,
  type UseRule,
} from '../construct3/analyzers/unscanned-uses.js';
import { nameTerm, patternTerm } from '../construct3/raw-text-search.js';
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
  forEachLayerInstance,
  findLayerNameClash,
  findLayersByName,
  layerEntries,
  layerNameKey,
  layerPathLabel,
  type LayerEntry,
} from '../construct3/layers.js';
import { hierarchyUnlinkWarnings, unlinkRemovedInstances } from '../construct3/hierarchy.js';
import {
  buildInstanceVariableValues,
  checkInstanceVariableValues,
  expectedInstanceVariables,
  type InstanceVariableDef,
} from '../construct3/instance-variables.js';
import { classifyReadError } from '../construct3/project-reader.js';
import {
  findLayerNameUses,
  layerNameUseLocation,
  renameLayerParameters,
  type LayerNameUse,
} from '../construct3/layer-references.js';
import { EntityWriteError, filesLeftClause } from '../construct3/project-writer.js';
import { StaleFileError } from '../construct3/disk-state.js';
import { withProjectSync } from './project-sync.js';

/**
 * What delete_layout looks for in the text of a layout file it could not
 * parse: instances (every layout instance has a "uid") and an event sheet
 * binding (a non-empty "eventSheet").
 */
const LAYOUT_CONTENT_TERMS = [
  patternTerm('instances', String.raw`"uid"\s{0,64}:\s{0,64}\d`, 140),
  patternTerm('an event sheet binding', String.raw`"eventSheet"\s{0,64}:\s{0,64}"(?!")`, 150),
];

/** Why delete_layout refuses a layout file it could not parse (the report of its text search). */
function layoutContentRefusal(reports: UnscannedFileReport[]): string {
  return reports.filter(r => r.textSearch !== 'no-match').map(r => r.textSearch === 'unreadable'
    ? `The layout file could not be parsed or searched: ${describeUnscannedFile(r)}, so its instances and event sheet binding were not checked.`
    : `The layout file could not be parsed: ${describeUnscannedFile(r)}. A text search of it found ${(r.names ?? []).join(' and ')} ` +
      '(possibly: the search cannot tell them from the same text in another string).').join(' ');
}

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

export function registerLayoutTools({ server: mcpServer, reader, writer, idGen }: MutationToolDeps) {
  const server = withProjectSync(mcpServer, reader);
  /**
   * The instance variables the instances of `objectType` hold values for (its
   * own and its families'); a warning instead when its file could not be
   * parsed, and an error when it does not exist.
   */
  async function declaredInstanceVariables(
    objectType: unknown,
  ): Promise<{ variables: InstanceVariableDef[] } | { variables?: undefined; warning: string } | { error: string }> {
    const name = String(objectType);
    try {
      const obj = await reader.readObjectType(name);
      return { variables: expectedInstanceVariables(name, obj, await readFamiliesForInstances(reader)) };
    } catch (error) {
      if (classifyReadError(error) === 'E_FILE_NOT_FOUND') {
        return { error: `The instance's object type "${name}" does not exist, so it has no instance variables to set. Nothing was changed.` };
      }
      return {
        warning: `The object type "${name}" could not be parsed, so the instance variable names were not checked against its variables.`,
      };
    }
  }

  /**
   * Registered family files the reader could not parse (over the 10MB read
   * limit, not valid JSON) whose text names the object type `objectName`, or
   * that cannot be read at all: the object is possibly a member of such a
   * family, whose instance variables and behaviors are unknown. Their text is
   * also searched for `variableNames`; a report lists those it found next to
   * the object's name in `names`.
   */
  async function unparsedFamiliesNaming(objectName: string, variableNames: readonly string[]): Promise<UnscannedFileReport[]> {
    const families = await readFamiliesForInstances(reader);
    const files = unscannedFilesOf('families', await reader.listFamilies(), families, reader.getReadFailures('families'));
    if (files.length === 0) return [];
    const object = [nameTerm(objectName)];
    const rules: UseRule[] = [{ categories: ['families'], allOf: [object] }];
    if (variableNames.length > 0) rules.push({ categories: ['families'], allOf: [object, variableNames.map(n => nameTerm(n))] });
    return (await checkUnscannedFiles(reader, files, rules)).filter(r => r.textSearch !== 'no-match');
  }

  /**
   * Check the instance variable values `given` for an instance of
   * `objectName` against the variables it has (`expected`: those of its
   * object type and the families that could be parsed). A name it has no
   * variable of is refused (`error`), unless a family file that could not be
   * parsed possibly declares it (its text names the object and the variable,
   * or it cannot be read at all): such a name is in `unlisted`, to be written
   * as given, with a warning. For a `newInstance`, the warning also says that
   * such a family's other variables and its behaviors got nothing.
   * `unscanned` lists the family files the warnings are about.
   */
  async function checkGivenInstanceVariables(
    objectName: string,
    expected: InstanceVariableDef[],
    given: Record<string, unknown>,
    newInstance: boolean,
  ): Promise<{ error: string } | { error?: undefined; unlisted: string[]; warnings: string[]; unscanned: UnscannedFileReport[] }> {
    const check = checkInstanceVariableValues(expected, given);
    let families: UnscannedFileReport[] = [];
    let unlisted: string[] = [];
    if (check.unknown.length > 0 || newInstance) {
      families = await unparsedFamiliesNaming(objectName, check.unknown);
      const unreadable = families.some(r => r.textSearch === 'unreadable');
      const found = new Set(families.flatMap(r => r.names ?? []));
      unlisted = check.unknown.filter(name => unreadable || found.has(name));
    }
    const refused = check.unknown.filter(name => !unlisted.includes(name));
    if (refused.length > 0) {
      return { error: undeclaredVariablesError(objectName, { ...check, unknown: refused }, expected, families) };
    }

    const warnings: string[] = [];
    if (check.mistyped.length > 0) {
      warnings.push(`Instance variable values of another type than the variable: ${check.mistyped.join('; ')}. Written as given.`);
    }
    const concerned = newInstance || unlisted.length > 0 ? families : [];
    if (concerned.length > 0) {
      const files = concerned.map(r => r.textSearch === 'unreadable'
        ? describeUnscannedFile(r)
        : `${describeUnscannedFile(r)}, whose text names "${objectName}"`);
      warnings.push(`Family file(s) that could not be parsed possibly list "${objectName}" as a member: ${files.join('; ')}. ` +
        (unlisted.length > 0
          ? `Their instance variables are unknown, so ${unlisted.map(n => `"${n}"`).join(', ')} ${unlisted.length === 1 ? 'was' : 'were'} written as given, without a check. `
          : '') +
        (newInstance ? 'The new instance got no values for their other instance variables and no entries for their behaviors. ' : '') +
        'Check the instance in the Construct 3 editor once the file is repaired.');
    }
    return { unlisted, warnings, unscanned: concerned };
  }

  /**
   * What renaming the layer `oldName` of `layoutName` to `newName` changes in
   * the event sheets (see layer-references.ts): the sheets to rewrite (the
   * definite uses, unless `update` is false or another layout has a layer of
   * the old name, ignoring case, in which case a layer parameter may name
   * that one), and the warnings. Layouts the reader could not parse are
   * searched as text for the old name (a match counts as such a layer), event
   * sheets it could not parse for the old name (possibly uses, not updated).
   */
  async function planLayerReferences(
    layoutName: string, oldName: string, newName: string, update: boolean,
  ): Promise<{ rewrites: Map<string, EventSheet>; warnings: string[]; unscanned: UnscannedFileReport[] }> {
    const sheets = await reader.readAllEventSheets();
    const sheetFailures = reader.getReadFailures('eventSheets');
    const uses = findLayerNameUses(sheets, oldName);
    const definite = uses.filter(u => u.definite);
    const possible = uses.filter(u => !u.definite);

    // Other layouts with a layer of the old name: a layer parameter may name that one.
    // The renamed layout by its registered name (layoutName may differ in case, which
    // the file system accepts), or the cached copy with the old layer name counts as another
    const layouts = await reader.readAllLayouts();
    const layoutFailures = reader.getReadFailures('layouts');
    const registered = await reader.listLayouts();
    const own = findNameClash(layoutName, registered) ?? layoutName;
    const key = layerNameKey(oldName);
    const sameName = [...layouts]
      .filter(([name, other]) => name !== own && layerEntries(other.layers).some(e => typeof e.layer.name === 'string' && layerNameKey(e.layer.name) === key))
      .map(([name]) => name);
    const unscannedLayouts = await checkUnscannedFiles(reader,
      unscannedFilesOf('layouts', registered, layouts, layoutFailures).filter(f => f.name !== own),
      [{ categories: ['layouts'], allOf: [[nameTerm(oldName)]] }]);
    const unscannedSheets = await checkUnscannedFiles(reader,
      unscannedFilesOf('eventSheets', await reader.listEventSheets(), sheets, sheetFailures),
      [{ categories: ['eventSheets'], allOf: [[nameTerm(oldName)]] }]);
    const maybeSameName = unscannedLayouts.filter(r => r.textSearch === 'possible-use' || r.textSearch === 'unreadable');

    const warnings: string[] = [];
    const rewrites = new Map<string, EventSheet>();
    const where = (list: LayerNameUse[]) => listUses(list.map(layerNameUseLocation));
    if (definite.length > 0) {
      if (!update) {
        warnings.push(`${definite.length} "layer" parameter(s) still name "${oldName}" (updateReferences is false): ${where(definite)}. ` +
          `Update them to "${newName}" if they mean this layer.`);
      } else if (sameName.length > 0 || maybeSameName.length > 0) {
        const others = [
          ...sameName.map(n => `"${n}"`),
          ...maybeSameName.map(r => `${r.file} (could not be parsed; ${r.textSearch === 'unreadable' ? 'not searched' : 'its text names it'})`),
        ];
        warnings.push(`${definite.length} "layer" parameter(s) name "${oldName}" and were NOT changed: layout(s) ${listUses(others)} ` +
          `${sameName.length + maybeSameName.length === 1 ? 'has' : 'possibly have'} a layer of that name too, and a layer parameter names a layer of ` +
          `whatever layout runs the event sheet. Update those meant for this layer to "${newName}": ${where(definite)}.`);
      } else {
        for (const sheetName of new Set(definite.map(u => u.eventSheet))) {
          const sheet = await reader.readEventSheet(sheetName);
          if (renameLayerParameters(sheet, oldName, newName) > 0) rewrites.set(sheetName, sheet);
        }
        warnings.push(`Pointed ${definite.length} "layer" parameter(s) that named "${oldName}" at "${newName}", in event sheet(s) ` +
          `${listUses([...rewrites.keys()].map(n => `"${n}"`))}: ${where(definite)}.`);
      }
    }
    if (possible.length > 0) {
      warnings.push(`${possible.length} other expression(s) or script line(s) contain the string "${oldName}", which may name this layer ` +
        `(e.g. LayerScale("${oldName}")) or something else of that name; they were NOT changed: ${where(possible)}.`);
    }
    for (const report of unscannedSheets.filter(r => r.textSearch !== 'no-match')) {
      warnings.push(`${report.file} could not be parsed (${report.reason}) and ` +
        (report.textSearch === 'unreadable' ? 'could not be searched either' : `its text names "${oldName}"`) +
        ': strings there that name the layer were NOT updated; check it in the Construct 3 editor.');
    }
    return { rewrites, warnings, unscanned: [...unscannedLayouts, ...unscannedSheets] };
  }

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
        .describe('Instance variable values as {varName: value}; every instance variable of the object and its families not given gets its default (0, "" or false); a name the object and its families have no variable of is refused'),
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

        const warnings: string[] = [];
        const families = await readFamiliesForInstances(reader);

        // A value for every instance variable of the object and its families, like the
        // editor writes them; values given for a variable it does not have are refused
        // (unless a family file that could not be parsed possibly declares it)
        const expectedVariables = expectedInstanceVariables(args.objectType, objData, families);
        const variableCheck = await checkGivenInstanceVariables(args.objectType, expectedVariables, args.instanceVariables ?? {}, true);
        if (variableCheck.error !== undefined) return toolError(variableCheck.error);
        warnings.push(...variableCheck.warnings);
        const instanceVariables = {
          // Possibly variables of a family that could not be parsed, which come first
          ...Object.fromEntries(variableCheck.unlisted.map(name => [name, args.instanceVariables![name]])),
          ...buildInstanceVariableValues(expectedVariables, args.instanceVariables),
        };

        const uid = await idGen.generateUid(reader);
        const sid = await idGen.generateSid(reader);

        // One behavior entry per behavior of the object and its families, like
        // the editor writes them; caller values override the defaults
        const expectedBehaviors = expectedInstanceBehaviors(args.objectType, objData, families);
        const instanceBehaviors = buildInstanceBehaviors(args.objectType, expectedBehaviors, args.behaviors);
        warnings.push(...instanceBehaviors.warnings);

        // Build overrides from optional params
        const overrides: InstanceOverrides = {};
        if (args.angle !== undefined) overrides.angle = args.angle;
        if (args.color !== undefined) overrides.color = args.color;
        if (args.zElevation !== undefined) overrides.zElevation = args.zElevation;
        if (args.originX !== undefined) overrides.originX = args.originX;
        if (args.originY !== undefined) overrides.originY = args.originY;
        overrides.instanceVariables = instanceVariables;
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
            instanceVariables,
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
          ...unscannedFields(variableCheck.unscanned),
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
    'Delete a layout from the project (checks references first: instances placed on it and its event sheet binding; refused without force while there are any). A layout file that could not be parsed (over the 10MB read limit, not valid JSON) is searched as text for instances and a binding: a match, or a file that cannot be read at all, refuses without force (listed in unscannedFiles).',
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

        // The layout's own file could not be parsed (over the read limit, not valid
        // JSON): its instances and binding are not in the index, so search its text
        const unscanned = await checkUnscannedFiles(
          reader,
          index.unscannedFiles.filter(f => f.category === 'layouts' && f.name === args.name),
          [{ categories: ['layouts'], allOf: [LAYOUT_CONTENT_TERMS] }],
        );
        const unscannedBlock = blocksWithoutForce(unscanned);

        if (!args.force && (placedObjects.length > 0 || boundSheet || unscannedBlock)) {
          return toolResult({
            success: false,
            entity: args.name,
            category: 'layout',
            action: 'delete_blocked',
            message: `Layout has associated data.${unscannedBlock ? ` ${layoutContentRefusal(unscanned)}` : ''} ` +
              'Use force=true to delete anyway.',
            references: {
              boundEventSheet: boundSheet || null,
              placedObjects,
            },
            ...unscannedFields(unscanned),
          });
        }
        if (unscannedBlock) {
          warnings.push(`Deleted with force=true: ${layoutContentRefusal(unscanned)}`);
        }
        warnings.push(...unscannedWarnings(unscanned.filter(r => r.textSearch === 'no-match'), 'Deleted'));

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
          ...unscannedFields(unscanned),
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
    'Delete a layer or sub-layer from a layout, together with its sub-layers (a layout must keep at least one top-level layer). Hierarchy links of instances on other layers to the deleted instances are removed (children stay, without a parent).',
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

        // Hierarchy links go across layers: links of instances left in the
        // layout to the instances deleted with the layer are removed
        const removedUids = new Set<number>();
        forEachLayerInstance([entry.layer], instance => {
          if (typeof instance.uid === 'number') removedUids.add(instance.uid);
        });
        entry.siblings.splice(entry.index, 1);
        const unlink = unlinkRemovedInstances(layout, removedUids);

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const warnings: string[] = [];
        if (instanceCount > 0) warnings.push(`Deleted layer contained ${instanceCount} instance(s)${withSubLayers} — they have been removed.`);
        if (subLayerCount > 0) warnings.push(`Its ${subLayerCount} sub-layer(s) were deleted with it.`);
        warnings.push(...hierarchyUnlinkWarnings(unlink));

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
    'Update properties of an existing layer or sub-layer (name, visibility, parallax, blend mode, etc.). A rename also updates the "layer" parameters of conditions and actions that are exactly the quoted old name (ignoring case), unless another layout has a layer of that name, and warns about other strings that name the layer.',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      layerName: z.string().max(200).describe('Layer name to update (any layer or sub-layer; a sub-layer can also be given by its path, e.g. "Main > HUD")'),
      newName: z.string().max(200).optional().describe('Rename the layer (must not match another layer of the layout, sub-layers included, ignoring case). Event parameters that name the layer are updated (see updateReferences)'),
      updateReferences: z.boolean().optional().default(true).describe('With newName: point the "layer" parameters of conditions and actions whose whole expression is the quoted old name (ignoring case) at the new name, unless another layout has a layer of the old name (default: true). Other strings that name the layer are listed in a warning, never changed'),
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
        const oldName = typeof layer.name === 'string' ? layer.name : undefined;
        const renamed = args.newName !== undefined && args.newName !== layer.name;
        if (renamed) {
          const layerClash = findLayerNameClash(layout.layers, args.newName!, layer);
          if (layerClash) {
            return toolError(layerNameClashError(args.newName!, layerClash, args.layoutName));
          }
          layer.name = args.newName!;
        }
        // Event sheet strings that name the old name (read before any write). A rename that
        // only changes the letter case breaks none: the editor looks layer names up ignoring case
        const references = renamed && oldName !== undefined && layerNameKey(oldName) !== layerNameKey(args.newName!)
          ? await planLayerReferences(args.layoutName, oldName, args.newName!, args.updateReferences)
          : undefined;

        if (args.isInitiallyVisible !== undefined) layer.isInitiallyVisible = args.isInitiallyVisible;
        if (args.isInitiallyInteractive !== undefined) layer.isInitiallyInteractive = args.isInitiallyInteractive;
        if (args.isTransparent !== undefined) layer.isTransparent = args.isTransparent;
        if (args.parallaxX !== undefined) layer.parallaxX = args.parallaxX;
        if (args.parallaxY !== undefined) layer.parallaxY = args.parallaxY;
        if (args.blendMode !== undefined) layer.blendMode = args.blendMode;
        if (args.scaleRate !== undefined) layer.scaleRate = args.scaleRate;
        if (args.zElevation !== undefined) layer.zElevation = args.zElevation;

        // The layout first, then the event sheets; a failure puts back what was written
        // (rollBackLayerRename), except a file changed on disk after the call wrote it,
        // which is left as it is and named. A write refused because its file changed on
        // disk during the call (StaleFileError) has had the writer do so already
        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);
        try {
          for (const [sheetName, sheet] of references?.rewrites ?? []) {
            await writer.writeEntityFile('eventSheets', sheetName, sheet, writer.getSubfolderForEntity('eventSheets', sheetName));
          }
        } catch (error) {
          if (error instanceof StaleFileError) throw error;
          throw new Error(await rollBackLayerRename(writer, error));
        }

        const warnings = references?.warnings ?? [];
        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
          warnings: warnings.length > 0 ? warnings : undefined,
          ...(references ? unscannedFields(references.unscanned) : {}),
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
    'Remove a placed object instance (on any layer or sub-layer, or a non-world instance) from a layout by its UID. Hierarchy links to it are removed: its children stay in the layout without a parent, and its parent no longer lists it.',
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
        // Hierarchy links name UIDs: its children lose their parent, its parent the child entry
        const unlink = unlinkRemovedInstances(layout, new Set([args.uid]));

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const warnings = [
          ...(removedType ? [`Removed instance of "${removedType}" (UID ${args.uid}) from ${describeInstancePlace(found.entry)}.`] : []),
          ...hierarchyUnlinkWarnings(unlink),
        ];
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
      instanceVariables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Instance variable values to update (names of instance variables of the object type or its families; others are refused)'),
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

        // Only the instance variables its object type and families have (or a family
        // file that could not be parsed possibly declares)
        const warnings: string[] = [];
        let unscanned: UnscannedFileReport[] = [];
        if (args.instanceVariables !== undefined) {
          const declared = await declaredInstanceVariables(inst.type);
          if ('error' in declared) {
            return toolError(declared.error);
          }
          if (declared.variables) {
            const check = await checkGivenInstanceVariables(String(inst.type), declared.variables, args.instanceVariables, false);
            if (check.error !== undefined) return toolError(check.error);
            warnings.push(...check.warnings);
            unscanned = check.unscanned;
          } else {
            warnings.push(declared.warning);
          }
        }

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
          warnings: warnings.length > 0 ? warnings : undefined,
          ...unscannedFields(unscanned),
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_instance] failed:', error);
        return toolError(`Error updating instance: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}

/**
 * Error for instance variable values given for names the object type and its
 * families have no instance variable of. `unparsedFamilies`: family files
 * that could not be parsed whose text names the object type, but not these
 * names.
 */
function undeclaredVariablesError(
  objectType: string,
  check: { unknown: string[]; suggestions: Map<string, string> },
  expected: InstanceVariableDef[],
  unparsedFamilies: readonly UnscannedFileReport[] = [],
): string {
  const names = check.unknown.map(name => {
    const suggestion = check.suggestions.get(name);
    return suggestion ? `"${name}" (names are matched with their letter case: "${suggestion}"?)` : `"${name}"`;
  });
  const defined = expected.map(v => `${v.name} (${v.type})`).join(', ') || '(none)';
  const unparsed = unparsedFamilies.length > 0
    ? `Family file(s) ${unparsedFamilies.map(describeUnscannedFile).join('; ')} could not be parsed; their text names "${objectType}" but not ` +
      `${check.unknown.length === 1 ? 'this name' : 'these names'}. `
    : '';
  return `"${objectType}" and its families have no instance variable ${names.join(', ')}. Its instance variables: ${defined}. ${unparsed}` +
    'Add the variable to the object type (update_object_properties) or its family (update_family) first. Nothing was changed.';
}

/**
 * Undo an update_layer rename whose event sheet write failed for a reason
 * other than a refusal as stale, and return the error message. The layout
 * and the event sheets written before are put back by the writer
 * (undoToolCall), which leaves a file saved again in the editor after the
 * call wrote it as it is. The event sheet whose write failed is restored from
 * its backup, unless another write replaced it during this one
 * (EntityWriteError.changedByOtherWrite): only a write from outside the
 * server can land there, such as a save in the editor, so it is left as that
 * write left it.
 */
async function rollBackLayerRename(writer: MutationToolDeps['writer'], error: unknown): Promise<string> {
  // A refusal of the writer ends with a full stop already
  const cause = (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');
  const failed: string[] = [];
  let otherWrite = '';
  if (error instanceof EntityWriteError) {
    if (error.changedByOtherWrite) {
      otherWrite = ' The event sheet was left as that write left it.';
    } else {
      try {
        await writer.restoreEntityFile(error.backupPath);
      } catch {
        failed.push(error.backupPath.replace(/\.bak$/, ''));
      }
    }
  }
  const undo = await writer.undoToolCall();
  if (undo.left.length === 0 && failed.length === 0) {
    return `${cause}.${otherWrite} The rename was rolled back: the layout and the event sheets written before were restored from their backups.`;
  }
  const parts = [
    ...(undo.restored.length > 0 ? [`put back as they were before the call: ${undo.restored.join(', ')}`] : []),
    ...(undo.left.length > 0 ? [filesLeftClause(undo.left)] : []),
    ...(failed.length > 0 ? [`restoring failed for: ${failed.join(', ')} (the .bak file holds the previous JSON)`] : []),
  ];
  return `${cause}.${otherWrite} The rename was rolled back only in part: ${parts.join('; ')}. ` +
    'Check the project (validate_project, git diff) before you run the tool again.';
}

/** The first few locations and how many more there are. */
function listUses(items: string[], max = 5): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}
