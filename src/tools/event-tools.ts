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
  resolveGroupPath,
  describeGroupPathProblem,
  isInFunctionBlock,
  validateObjectClasses,
  collectObjectRefs,
  buildBlockEvent,
  buildCondition,
  buildAction,
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
  loadFunctionSignatures,
  resolveFunctionMapParameter,
  functionCallArgumentSchema,
  unknownKeysErrorMap,
  EVENT_INPUT_DESCRIPTIONS,
} from './event-helpers.js';
import {
  isElseCondition,
  createElseCondition,
  setKeyAfterSid,
  setConditionParameters,
  isFunctionCall,
  isLegacyFunctionCall,
  toPositionalArguments,
  rewriteFunctionCallInPlace,
  checkFunctionCallArguments,
  mergeCallArguments,
  collectFunctionSignatures,
  resolveCallName,
  functionsObjectName,
  type FunctionArgument,
} from '../construct3/event-shapes.js';
import {
  findReferencesLeftByDelete,
  findVariableReferencesLostByChange,
  recordVariableScopes,
  variablesDeclaredIn,
  mapCopiedAces,
  definesFunctionsOrVariables,
  countDeleteReferences,
  namesVisibleToOtherSheets,
  type DeleteReference,
  type DeleteReferenceKind,
  type DeleteReferenceReport,
} from '../construct3/analyzers/delete-references.js';
import { scanLegacyEventShapes, type LegacyEventShapeHit } from '../construct3/analyzers/legacy-event-shapes.js';
import type { ObjectRef, SidMatch } from './event-helpers.js';
import { getProjectIndex, resetProjectIndex } from '../construct3/analyzers/index-builder.js';
import {
  blocksWithoutForce,
  checkUnscannedFiles,
  ownFileReports,
  unscannedFields,
  unscannedFilesOf,
  unscannedRefusal,
  unscannedWarnings,
  type UnscannedFileReport,
} from '../construct3/analyzers/unscanned-uses.js';
import { nameTerm } from '../construct3/raw-text-search.js';
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

/** What happens to the references delete_event_from_sheet reports (see delete-references.ts). */
const DANGLING_REFERENCE_CONSEQUENCE =
  'After loading a project, Construct 3 resolves these names and throws "invalid function name", ' +
  '"cannot find function" or "cannot find event variable" when one is missing (loader code; whether the project ' +
  'then fails to open has not been confirmed in the editor). A Functions.Name(...) expression would call a ' +
  'function that no longer exists, and an expression that uses an event variable by name would name a variable ' +
  'that no longer exists.';

const DANGLING_KIND_LABELS: Record<DeleteReferenceKind, string> = {
  callFunction: 'Call function action(s)',
  'function-map': 'function map registration(s)',
  expression: 'expression call(s)',
  'event-variable': 'condition(s)/action(s) reading or setting it',
  'variable-expression': 'expression(s) using it by name',
};

/** What happens to the uses a move takes out of their variable's scope (see findVariableReferencesLostByChange). */
const SCOPE_LOSS_CONSEQUENCE =
  'A variable that is not at the top level of a sheet is local: only the events beside it and below them see it. ' +
  'After loading a project, Construct 3 resolves these names and throws "cannot find event variable" when one is ' +
  'not in scope (loader code; whether the project then fails to open has not been confirmed in the editor), and an ' +
  'expression that uses it by name would name a variable that is not there.';

/**
 * One sentence per deleted function or variable that is still referenced
 * `outside` what is deleted ("outside the deleted events").
 */
function describeDanglingReferences(report: DeleteReferenceReport, outside = 'outside the deleted events'): string {
  const kinds = (refs: DeleteReference[]) => {
    const counts = new Map<DeleteReferenceKind, number>();
    for (const r of refs) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
    return [...counts].map(([kind, n]) => `${n} ${DANGLING_KIND_LABELS[kind]}`).join(', ');
  };
  return [
    ...report.functions.map(f => `Function "${f.name}" is still referenced ${f.references.length} time(s) ${outside} (${kinds(f.references)}).`),
    ...report.variables.map(v => `Event variable "${v.name}" is still used ${v.references.length} time(s) ${outside} (${kinds(v.references)}).`),
  ].join(' ');
}

/** The references of a report, for the delete_blocked result. */
function danglingReferenceList(report: DeleteReferenceReport): Record<string, unknown> {
  const entry = (r: DeleteReference) => ({ sheet: r.sheet, path: r.path, ...(r.sid !== undefined ? { sid: r.sid } : {}) });
  return {
    ...(report.functions.length > 0
      ? { callers: report.functions.flatMap(f => f.references.map(r => ({ function: f.name, via: r.kind, ...entry(r) }))) }
      : {}),
    ...(report.variables.length > 0
      ? {
        variableReferences: report.variables.flatMap(v => v.references.map(r => ({
          variable: v.name,
          via: r.kind === 'variable-expression' ? 'expression' : r.kind,
          ...entry(r),
        }))),
      }
      : {}),
  };
}

/**
 * Error for a parameter update on an action row that has no parameters:
 * editor-saved comment rows are { type, text, colours? } and script actions
 * { type, language, script, disabled? }. Null for other actions.
 */
function parameterlessRowError(action: Record<string, unknown>, index: number): string | null {
  if (action.type === 'comment') {
    return `Action ${index} is a comment row, which has no parameters. To change its text, remove it and add a new { type: "comment", text } with update_event_block.`;
  }
  if (action.type === 'script') {
    return `Action ${index} is a script action, which has no parameters. To change its code, remove it and add a new { type: "script", script } with update_event_block.`;
  }
  return null;
}

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
        resetProjectIndex(reader);

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
      functionReturnType: z.enum(['none', 'number', 'string', 'any']).optional()
        .describe('For functions: the editor\'s "Return type" (default "none"); a function with a return type sets its value with the Functions "Set return value" action'),
      functionIsAsync: z.boolean().optional().describe('For functions: the editor\'s "Asynchronous" option, so a call can be waited for with "Wait for previous actions to complete" (default false)'),
      functionCopyPicked: z.boolean().optional().describe('For functions: the editor\'s "Copy picked" option, which passes the instances picked where the function is called into the function (default false)'),
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
            event = createFunctionEvent(args.functionName, sid, paramsWithSids, {
              returnType: args.functionReturnType,
              isAsync: args.functionIsAsync,
              copyPicked: args.functionCopyPicked,
            });
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
        resetProjectIndex(reader);

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

  // Registered with a strict object schema, so unknown arguments are refused
  // (server.tool() with a raw shape would drop them; see Strict Input in event-helpers.ts).
  server.registerTool(
    'add_event_block',
    {
      description: 'Add a block event (conditions + actions) to an event sheet — the core of gameplay logic. Written in the shapes the Construct 3 editor saves: sub-events (blocks, also without conditions, which run whenever their parent runs; comments; scripts), else and else-if blocks (a System "else" first condition), OR blocks (isOrBlock), function calls ({ callFunction, parameters: [...] }), script actions (lines, language "javascript"), comment rows and per-condition/per-action disabling. Unknown keys, in the arguments and at any depth, are refused, never dropped. Writes that would break a checked editor load-time rule (expression syntax, empty expressions, trigger placement) are refused.',
      inputSchema: z.object({
        sheetName: z.string().max(200).describe('Target event sheet'),
        eventType: z.literal('block', {
          errorMap: (_issue, ctx) => ({
            message: `add_event_block adds a block event, not ${JSON.stringify(ctx.data)}; the call is refused. ` +
              'Comments, groups, variables, functions and includes are added with add_event_to_sheet; a comment or script can also be a sub-event in children.',
          }),
        }).optional().describe('Optional, only "block": this tool adds block events. Comments, groups, variables, functions and includes: add_event_to_sheet (comments and scripts can also be sub-events in children)'),
        sid: z.number().optional().describe('Ignored: a block copied from get_eventsheet_details may carry its SID, but the new block always gets a new one'),
        conditions: z.array(conditionSchema).optional().default([]).describe(EVENT_INPUT_DESCRIPTIONS.conditions),
        actions: z.array(actionSchema).optional().default([]).describe('Actions: plugin/behavior/System actions, function calls { callFunction, parameters: [...] }, script actions { type: "script", script } and comment rows { type: "comment", text, "text-color"?, "background-color"? }'),
        groupPath: z.string().max(500).optional().describe('Insert inside group by title path (e.g., "Movement > Collision"). Titles match exactly first, then ignoring leading/trailing whitespace when that fits one group'),
        position: z.enum(['start', 'end']).optional().default('end').describe('Where to insert the event block'),
        disabled: z.boolean().optional().default(false).describe('Create the event block disabled'),
        isElse: z.boolean().optional().default(false).describe(EVENT_INPUT_DESCRIPTIONS.isElse),
        isOrBlock: z.boolean().optional().describe(EVENT_INPUT_DESCRIPTIONS.isOrBlock),
        children: z.array(childEventSchema).optional().default([]).describe('Sub-events nested inside this block (recursive, max depth 10, max 200 total events): blocks { conditions?, actions?, disabled?, isElse?, isOrBlock?, children? }, comments { eventType: "comment", text } and scripts { eventType: "script", script }. Other event types (variables, groups, functions, includes) and unknown keys are refused'),
      }, {
        errorMap: unknownKeysErrorMap('the arguments of add_event_block', 'add_event_block takes sheetName, eventType, conditions, actions, groupPath, position, disabled, isElse, isOrBlock and children; a "sid" is ignored. Comments, groups, variables, functions and includes are added with add_event_to_sheet.'),
      }).strict(),
    },
    async (args) => {
      try {
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

        // The block goes to the top level or into a group, never into a function block
        const { errors, warnings } = await validateObjectClasses(reader, allRefs, { insideFunction: false });
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
            isOrBlock: args.isOrBlock,
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
          const resolved = resolveGroupPath(events, args.groupPath);
          if (resolved.problem) {
            return toolError(describeGroupPathProblem(resolved.problem, args.groupPath, args.sheetName));
          }
          targetEvents = resolved.children;
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
        // context (the new block's ancestors, the event before an else block) counts too
        const loadCheck = await checkLoadRulesBeforeWrite(reader, args.sheetName, beforeEvents, sheet.events);
        if (loadCheck.errors.length > 0) {
          sheet.events = beforeEvents;
          return toolError(loadRuleErrorMessage(loadCheck.errors));
        }
        warnings.push(...loadCheck.warnings);

        // Write back
        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex(reader);

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
    'Delete an event sheet from the project (checks references first; refused without force while there are any): sheets that include it, layouts bound to it, and uses in other event sheets of the functions and global variables it defines (Call function actions, function map registrations, Functions.Name(...) expression calls, System conditions/actions on the variable, expressions that use the variable by name; scripts are not checked). Event sheets and layouts that could not be parsed (over the 10MB read limit, not valid JSON) are searched as text for the sheet name, and event sheets also for those functions and global variables: a match (a possible use), or such a file that cannot be read at all, refuses without force (listed in unscannedFiles), as does a sheet to delete that could not be parsed itself.',
    {
      name: z.string().max(200).describe('Event sheet name to delete'),
      force: z.boolean().optional().default(false).describe('If true, delete even if referenced (does NOT clean up references; the uses of its functions and global variables left behind are listed in "references" and a warning)'),
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

        // 3. Functions and global variables the sheet defines that other
        // sheets still use (issue #58): the same check as
        // delete_event_from_sheet, with every event of the sheet deleted
        const sheets = await reader.readAllEventSheets();
        const ownEvents = sheets.get(args.name)?.events;
        let dangling: DeleteReferenceReport = { functions: [], variables: [], complete: true };
        const visibleNames = new Set<string>();
        if (Array.isArray(ownEvents)) {
          const sheetEvents = new Map<string, unknown>();
          for (const [name, other] of sheets) sheetEvents.set(name, other.events);
          dangling = findReferencesLeftByDelete(sheetEvents, ownEvents as object[], functionsObjectName(reader));
          for (const event of ownEvents) {
            for (const name of namesVisibleToOtherSheets(event, true)) visibleNames.add(name);
          }
        }
        const danglingCount = countDeleteReferences(dangling);

        // 4. Event sheets (includes; the functions and globals it defines) and
        // layouts (bindings) that could not be parsed. When the sheet itself
        // could not be parsed, what it defines is unknown.
        const otherFiles = index.unscannedFiles.filter(f => !(f.category === 'eventSheets' && f.name === args.name));
        const unscanned = [
          ...ownFileReports(index.unscannedFiles, [{
            category: 'eventSheets',
            name: args.name,
            unchecked: 'the functions and global variables it defines are unknown, so their uses in other event sheets could not be checked',
          }]),
          ...await checkUnscannedFiles(reader, otherFiles, [
            { categories: ['eventSheets', 'layouts'], allOf: [[nameTerm(args.name)]] },
            { categories: ['eventSheets'], allOf: [[...visibleNames].map(n => nameTerm(n))] },
          ]),
        ];
        const unscannedBlock = blocksWithoutForce(unscanned);
        const outsideSheet = `in other event sheets than "${args.name}"`;

        if ((hasRefs || danglingCount > 0 || unscannedBlock) && !args.force) {
          const reasons = [
            ...(hasRefs ? ['Event sheet is still referenced.'] : []),
            ...(danglingCount > 0 ? [`${describeDanglingReferences(dangling, outsideSheet)} ${DANGLING_REFERENCE_CONSEQUENCE}`] : []),
            ...(unscannedBlock ? [unscannedRefusal(unscanned)] : []),
          ];
          return toolResult({
            success: false,
            entity: args.name,
            category: 'eventsheet',
            action: 'delete_blocked',
            message: `${reasons.join(' ')} Use force=true to delete anyway (references will NOT be cleaned up).`,
            references: {
              includedBy,
              boundLayouts,
              ...danglingReferenceList(dangling),
            },
            ...unscannedFields(unscanned),
          });
        }

        const warnings: string[] = [];
        if (hasRefs && args.force) {
          const refList = [...includedBy.map(s => `included by "${s}"`), ...boundLayouts.map(l => `bound to layout "${l}"`)];
          warnings.push(`Event sheet deleted but still referenced: ${refList.join(', ')}. References were NOT cleaned up.`);
        }
        if (danglingCount > 0) {
          warnings.push(`Deleted with force=true: ${describeDanglingReferences(dangling, outsideSheet)} ` +
            `${DANGLING_REFERENCE_CONSEQUENCE} Fix them before opening the project in Construct 3.`);
        }
        if (!dangling.complete) {
          warnings.push('The check for uses of the functions and global variables the sheet defines stopped at its traversal limit; uses further on were not checked.');
        }
        warnings.push(...unscannedWarnings(unscanned, 'Deleted'));

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.name);
        const backupPath = await writer.deleteEntityFile('eventSheets', args.name, subfolder);
        await writer.removeFromProject('eventSheets', args.name);
        resetProjectIndex(reader);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'eventsheet',
          action: 'deleted',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
          ...unscannedFields(unscanned),
        };
        // With force=true, the uses of its functions and global variables left dangling
        return toolResult(danglingCount > 0 ? { ...result, references: danglingReferenceList(dangling) } : result);
      } catch (error) {
        console.error('[delete_event_sheet] failed:', error);
        return toolError(`Error deleting event sheet: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_event_from_sheet ────────────────────────────────

  server.tool(
    'delete_event_from_sheet',
    'Delete an event from an event sheet by SID (for blocks, groups, variables, functions) or by includeSheet name (for includes). Sub-events are deleted with their event. Use get_eventsheet_details to find SIDs. A SID shared by several events in the sheet is refused with a list of candidates; pass eventPath to pick one. Refuses (unless force=true) when a function or event variable it removes is still named outside the deleted events: Call function actions, function map registrations, Functions.Name(...) expression calls, System conditions/actions on the variable, expressions that use the variable by name (scripts are not checked). Other event sheets that could not be parsed (over the 10MB read limit, not valid JSON) are searched as text for the deleted functions and global variables: a match (a possible use), or such a sheet that cannot be read at all, also refuses without force (listed in unscannedFiles). Reports an else block the delete leaves without the block it belonged to (else-placement warning).',
    {
      sheetName: z.string().max(200).describe('Target event sheet'),
      sid: z.number().int().positive().optional().describe('SID of the event to delete (for block, group, variable, function events)'),
      eventPath: eventPathSchema,
      includeSheet: z.string().max(200).optional().describe('For removing includes: the included sheet name'),
      dryRun: z.boolean().optional().default(false).describe('If true, report what would be deleted without actually deleting'),
      force: z.boolean().optional().default(false).describe('If true, delete even when functions or event variables it removes are still referenced (the references are listed in "references" and a warning and left dangling; with dryRun, lists what the delete would leave dangling)'),
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
          resetProjectIndex(reader);

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

        // Names the delete would leave dangling: calls, function map
        // registrations and Functions.Name(...) expression calls of the
        // function blocks it removes (the event itself or ones inside a
        // deleted group), and event variable parameters naming the variables
        // it removes, anywhere in the project outside the deleted events.
        // Event sheets that could not be parsed are searched as text for the
        // functions and global variables the delete removes (issue #55).
        let dangling: DeleteReferenceReport = { functions: [], variables: [], complete: true };
        let unscanned: UnscannedFileReport[] = [];
        if (definesFunctionsOrVariables(event)) {
          const sheets = await reader.readAllEventSheets();
          const sheetFailures = reader.getReadFailures('eventSheets');
          const sheetEvents = new Map<string, unknown>();
          for (const [name, other] of sheets) {
            sheetEvents.set(name, name === args.sheetName ? sheet.events : other.events);
          }
          sheetEvents.set(args.sheetName, sheet.events);
          dangling = findReferencesLeftByDelete(sheetEvents, event, functionsObjectName(reader));
          const names = namesVisibleToOtherSheets(event, parentArray === events);
          if (names.length > 0) {
            const skipped = unscannedFilesOf('eventSheets', await reader.listEventSheets(), sheets, sheetFailures)
              .filter(f => f.name !== args.sheetName);
            unscanned = await checkUnscannedFiles(reader, skipped, [
              { categories: ['eventSheets'], allOf: [names.map(n => nameTerm(n))] },
            ]);
          }
        }
        const danglingCount = countDeleteReferences(dangling);
        const unscannedBlock = blocksWithoutForce(unscanned);
        if ((danglingCount > 0 || unscannedBlock) && !args.force) {
          const reasons = [
            ...(danglingCount > 0 ? [`${describeDanglingReferences(dangling)} ${DANGLING_REFERENCE_CONSEQUENCE}`] : []),
            ...(unscannedBlock ? [unscannedRefusal(unscanned)] : []),
          ];
          return toolResult({
            success: false,
            entity: args.sheetName,
            category: 'eventsheet',
            action: 'delete_blocked',
            message: `${reasons.join(' ')} Remove or change these references first, or use force=true to delete anyway.`,
            references: danglingReferenceList(dangling),
            ...unscannedFields(unscanned),
          });
        }
        if (danglingCount > 0) {
          warnings.push(`${args.dryRun ? 'Would delete' : 'Deleted'} with force=true: ${describeDanglingReferences(dangling)} ` +
            `${DANGLING_REFERENCE_CONSEQUENCE} ${args.dryRun ? 'The delete would leave these references dangling; fix' : 'Fix'} ` +
            'them before opening the project in Construct 3.');
        }
        warnings.push(...unscannedWarnings(unscanned, args.dryRun ? 'Would delete' : 'Deleted'));
        if (!dangling.complete) {
          warnings.push('The check for references to the deleted functions and variables stopped at its traversal limit; references further on were not checked.');
        }

        // Report children for groups
        if (childCount > 0) {
          warnings.push(args.dryRun
            ? `The ${eventType} contains ${childCount} child event(s) that would also be removed.`
            : `Deleted ${eventType} contained ${childCount} child event(s) that were also removed.`);
        }

        // Editor load-time rules of the gate (expression-syntax,
        // empty-expression, trigger-placement, else-placement). A delete
        // removes an event together with all its sub-events. The expression
        // rules look at an event's own parameters and the trigger rules at its
        // own conditions and its ancestors, and no remaining event gains an
        // ancestor or changes its conditions, so a delete cannot introduce an
        // issue of those rules. Else placement also looks at the event before
        // an else block (the nearest one that is not a comment): deleting the
        // block an else belongs to leaves the else after another event (or
        // first), which is reported as a warning. An error would still block
        // the delete. Names left dangling are checked above. The event is
        // taken out of the sheet for the check and put back for a dry run or
        // a refusal.
        const beforeEvents = snapshotEvents(sheet.events);
        parentArray.splice(index, 1);
        let loadCheck: Awaited<ReturnType<typeof checkLoadRulesBeforeWrite>>;
        try {
          loadCheck = await checkLoadRulesBeforeWrite(reader, args.sheetName, beforeEvents, sheet.events);
        } catch (error) {
          parentArray.splice(index, 0, event);
          throw error;
        }
        if (args.dryRun || loadCheck.errors.length > 0) {
          parentArray.splice(index, 0, event);
        }
        if (loadCheck.errors.length > 0) {
          return toolError(loadRuleErrorMessage(loadCheck.errors));
        }
        warnings.push(...loadCheck.warnings);
        // With force=true, the references the delete leaves dangling (a dry run lists them too)
        const references = danglingCount > 0 ? { references: danglingReferenceList(dangling) } : {};

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
            ...references,
            ...(warnings.length > 0 ? { warnings } : {}),
            ...unscannedFields(unscanned),
          });
        }

        // The event is already out of the sheet (load-time check above)
        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex(reader);

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
          ...references,
          ...unscannedFields(unscanned),
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
        resetProjectIndex(reader);

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
    'Replace parameters on a single action within an existing event block. Identify the block by SID and the action by its 0-based index. Use get_eventsheet_details to find SIDs and action indices. A SID shared by several events in the sheet is refused with a list of candidates; pass eventPath to pick one. Function calls take their arguments as an array in parameter order. Comment rows and script actions have no parameters and are refused. Parameters that would break a checked editor load-time rule (expression syntax, empty expressions) are refused.',
    {
      sheetName: z.string().max(200).describe('Target event sheet'),
      blockSid: z.number().int().positive().describe('SID of the block event containing the action'),
      eventPath: eventPathSchema,
      actionIndex: z.number().int().min(0).describe('0-based index of the action to update'),
      parameters: z.union([boundedRecord(), z.array(functionCallArgumentSchema).max(100)])
        .describe('New parameter values — replaces existing parameters entirely. Key-value pairs for plugin/behavior/System actions (max 100 keys, depth 6); for a function call, the arguments in parameter order as an array (an object keyed "0", "1", … or by parameter name is converted)'),
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
        const rowProblem = parameterlessRowError(action, args.actionIndex);
        if (rowProblem) return toolError(rowProblem);
        let warnings: string[];
        if (isFunctionCall(action)) {
          // Function calls take positional arguments, as the editor saves them
          const name = action.callFunction as string;
          const label = `Call to "${name}"`;
          const signature = (await loadFunctionSignatures(reader)).get(name.toLowerCase());
          let callArgs: FunctionArgument[];
          try {
            callArgs = toPositionalArguments(args.parameters, signature, label);
          } catch (error) {
            return toolError(error instanceof Error ? error.message : String(error));
          }
          warnings = checkFunctionCallArguments(callArgs, signature, name, label);
          if (isLegacyFunctionCall(action)) {
            warnings.push(`${label} was stored in an old shape; it was rewritten as { callFunction, sid, parameters: [...] } without id/objectClass, the shape Construct 3 saves.`);
          }
          rewriteFunctionCallInPlace(action, callArgs);
          action.callFunction = resolveCallName(name, signature, label, warnings);
        } else {
          if (Array.isArray(args.parameters)) {
            return toolError(`Action ${args.actionIndex} is not a function call: pass its parameters as key-value pairs, not an array.`);
          }
          action.parameters = args.parameters;
          // Don't re-emit a legacy "behavior-type" key on the edited action (issue #16)
          warnings = await normalizeLegacyBehaviorKeys(reader, [{ ace: action, kind: 'action' }]);
          await resolveFunctionMapParameter(reader, action, `Action ${args.actionIndex} ("${String(action.id)}")`, warnings,
            () => loadFunctionSignatures(reader));
        }

        // Editor load-time rules (expression syntax, empty expressions)
        const loadCheck = await checkLoadRulesBeforeWrite(reader, args.sheetName, beforeEvents, sheet.events);
        if (loadCheck.errors.length > 0) {
          sheet.events = beforeEvents;
          return toolError(loadRuleErrorMessage(loadCheck.errors));
        }
        warnings.push(...loadCheck.warnings);

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex(reader);

        return toolResult({
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          updatedBlockSid: args.blockSid,
          eventPath: path,
          updatedActionIndex: args.actionIndex,
          ...(isFunctionCall(action) ? { callFunction: action.callFunction } : { actionId: action.id }),
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
    'Copy (or move) top-level event blocks from one event sheet to another by SID. Set deleteSource=true to remove the events from the source sheet after copying (move semantics). SIDs and all nested children are preserved; the result warns when a copied SID then matches more than one event in the target sheet. A SID shared by several top-level events of the source is refused with a list of candidates; pass eventPaths to pick one. Runs the editor load-time gate over both sheets: moving an event that already breaks a load-time rule is allowed, copying it (deleteSource=false) is refused because it adds the problem to a second sheet. Refuses (unless force=true) a move that takes an event variable out of the scope of events that use it, e.g. a used global variable moved into a group (targetGroupPath), where it is a local variable; the uses are listed. Other event sheets that could not be parsed are searched as text for such a global variable.',
    {
      sourceSheet: z.string().max(200).describe('Event sheet to copy/move events from'),
      targetSheet: z.string().max(200).describe('Event sheet to copy/move events into'),
      sids: z.array(z.number().int().positive()).min(1).describe('SIDs of the top-level events to copy/move (each SID once)'),
      eventPaths: z.array(z.string().max(500)).max(100).optional().describe(
        'Only needed when a SID in sids matches more than one top-level event of the source sheet (the call is then refused with a list of candidates): ' +
        'the paths of the events you mean, e.g. ["events[4]"], one per ambiguous SID. Each must point at a top-level event whose SID is in sids.',
      ),
      deleteSource: z.boolean().optional().default(false).describe('If true, remove the events from the source sheet after copying (move semantics). A copy or move that would leave two event variables or function parameters whose names match ignoring case in one scope is refused, e.g. a copy of a global variable (its original keeps the name)'),
      targetGroupPath: z.string().max(500).optional().describe('Insert into a group in the target sheet by title path (e.g. "Movement > Collision"), matched like groupPath of add_event_block'),
      position: z.enum(['start', 'end']).optional().default('end').describe('Where to insert events in the target sheet or group'),
      force: z.boolean().optional().default(false).describe('If true, move even when events still use an event variable the move takes out of their scope (the uses are listed in "references" and a warning, and left dangling)'),
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

        // Where the uses of the variables the events declare resolve now, per
        // condition/action (compared by identity), for the scope check below
        const otherSheets = await readEventSheetsFresh(reader, [
          [args.sourceSheet, sourceEvents as unknown as C3Event[]],
          [args.targetSheet, targetEvents as unknown as C3Event[]],
        ]);
        const movedVariables = variablesDeclaredIn(eventsToMove);
        const scopesBefore = recordVariableScopes(otherSheets, movedVariables);
        const globalsBefore = topLevelVariableNames(otherSheets);

        // Determine target insertion array
        let insertTarget: Record<string, unknown>[];
        if (args.targetGroupPath) {
          const resolved = resolveGroupPath(targetEvents, args.targetGroupPath);
          if (resolved.problem) {
            return toolError(describeGroupPathProblem(resolved.problem, args.targetGroupPath, args.targetSheet));
          }
          insertTarget = resolved.children;
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
        const sheetsBefore = new Map(otherSheets);
        sheetsBefore.set(args.targetSheet, targetBefore);
        const sheetsAfter = new Map(otherSheets);
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

        // Uses of an event variable that the move takes out of their scope,
        // e.g. a used global variable moved into a group, where it is local
        // (issue #38). Copies are compared with the events they were copied from.
        const copiedAces = mapCopiedAces(eventsToMove, copiedEvents);
        const lost = findVariableReferencesLostByChange(scopesBefore, sheetsAfter, ace => copiedAces.get(ace) ?? ace);
        const lostCount = countDeleteReferences(lost);
        // Global variables that are global no longer: sheets that could not be parsed may use them
        const globalsAfter = topLevelVariableNames(sheetsAfter);
        const noLongerGlobal = [...movedVariables]
          .filter(([key]) => globalsBefore.has(key) && !globalsAfter.has(key))
          .map(([, name]) => name);
        let unscanned: UnscannedFileReport[] = [];
        if (noLongerGlobal.length > 0) {
          const allSheets = await reader.readAllEventSheets();
          const skipped = unscannedFilesOf('eventSheets', await reader.listEventSheets(), allSheets, reader.getReadFailures('eventSheets'))
            .filter(f => f.name !== args.sourceSheet && f.name !== args.targetSheet);
          unscanned = await checkUnscannedFiles(reader, skipped, [
            { categories: ['eventSheets'], allOf: [noLongerGlobal.map(n => nameTerm(n))] },
          ]);
        }
        const unscannedBlock = blocksWithoutForce(unscanned);
        const whereLost = 'where it is no longer in scope after the move';
        if ((lostCount > 0 || unscannedBlock) && !args.force) {
          sourceSheetData.events = sourceEvents as unknown as C3Event[];
          targetSheetData.events = targetBefore;
          const reasons = [
            ...(lostCount > 0 ? [`${describeDanglingReferences(lost, whereLost)} ${SCOPE_LOSS_CONSEQUENCE}`] : []),
            ...(unscannedBlock ? [unscannedRefusal(unscanned)] : []),
          ];
          return toolResult({
            success: false,
            sourceSheet: args.sourceSheet,
            targetSheet: args.targetSheet,
            category: 'eventsheet',
            action: 'move_blocked',
            message: `${reasons.join(' ')} Move the events that use it along, pick another place (a global variable stays global at the top level of a sheet), or use force=true to move anyway. Nothing was written.`,
            references: danglingReferenceList(lost),
            ...unscannedFields(unscanned),
          });
        }

        // Copies keep their SIDs, so a copied event whose SID the target already
        // has leaves several events with that SID there. The editor opens such
        // sheets, so this is a warning, not a refusal.
        const warnings = [...loadCheck.warnings];
        if (lostCount > 0) {
          warnings.push(`Moved with force=true: ${describeDanglingReferences(lost, whereLost)} ` +
            `${SCOPE_LOSS_CONSEQUENCE} Fix them before opening the project in Construct 3.`);
        }
        if (!lost.complete) {
          warnings.push('The check for uses of the moved event variables stopped at its traversal limit; uses further on were not checked.');
        }
        warnings.push(...unscannedWarnings(unscanned, 'Moved'));
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

        resetProjectIndex(reader);

        return toolResult({
          success: true,
          sourceSheet: args.sourceSheet,
          targetSheet: args.targetSheet,
          movedSids: args.sids,
          movedCount: eventsToMove.length,
          deleteSource: args.deleteSource,
          backupFiles: [targetBackup, ...(sourceBackup ? [sourceBackup] : [])].filter(Boolean),
          warnings: warnings.length > 0 ? warnings : undefined,
          ...(lostCount > 0 ? { references: danglingReferenceList(lost) } : {}),
          ...unscannedFields(unscanned),
        });
      } catch (error) {
        console.error('[move_events_between_sheets] failed:', error);
        return toolError(`Error moving events: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_event_block ─────────────────────────────────────

  // Registered with a strict object schema, so unknown arguments are refused (see add_event_block).
  server.registerTool(
    'update_event_block',
    {
      description: 'Update an existing block event in an event sheet — modify action parameters, add/remove actions or conditions, toggle disabled state, make it an else or OR block. Identify the block by its SID (use get_eventsheet_details to find it). A SID shared by several events in the sheet is refused with a list of candidates; pass eventPath to pick one. Unknown arguments and keys are refused, never dropped.',
      inputSchema: z.object({
        sheetName: z.string().max(200).describe('Target event sheet'),
        sid: z.number().int().positive().describe('SID of the block event to update'),
        eventPath: eventPathSchema,
        disabled: z.boolean().optional().describe('Enable or disable the entire block'),
        isElse: z.boolean().optional().describe('true: make the block an else block (puts the System "else" condition first; existing conditions then make an else-if). false: remove the leading "else" condition. Applied after all other condition changes.'),
        isOrBlock: z.boolean().optional().describe('true: make the block an OR block (its conditions are ORed); false: AND-combine them again'),
        updateActions: z.array(z.object({
          index: z.number().int().min(0).describe('Action index (0-based)'),
          parameters: z.union([boundedRecord(), z.array(functionCallArgumentSchema).max(100)]).optional()
            .describe('New parameter values — merged with existing (max 100 keys, depth 6). For a function call: an array replaces the arguments; an object keyed by position ("0", "1", …) or parameter name replaces single arguments'),
          disabled: z.boolean().optional().describe('Enable or disable this action'),
        }, {
          errorMap: unknownKeysErrorMap('an updateActions entry', 'An entry has index, parameters and disabled; to change anything else, remove the action (removeActionIndices) and add a new one (addActions).'),
        }).strict()).optional().describe('Actions to update by index'),
        updateConditions: z.array(z.object({
          index: z.number().int().min(0).describe('Condition index (0-based)'),
          parameters: boundedRecord().optional().describe('New parameter values — merged with existing (max 100 keys, depth 6)'),
          isInverted: z.boolean().optional().describe('Toggle inversion'),
          disabled: z.boolean().optional().describe('Enable or disable this condition'),
        }, {
          errorMap: unknownKeysErrorMap('an updateConditions entry', 'An entry has index, parameters, isInverted and disabled; to change anything else, remove the condition (removeConditionIndices) and add a new one (addConditions).'),
        }).strict()).optional().describe('Conditions to update by index'),
        addActions: z.array(actionSchema).optional().describe('Append new actions to the block (same shapes as add_event_block)'),
        addConditions: z.array(conditionSchema).optional().describe('Append new conditions to the block'),
        removeActionIndices: z.array(z.number().int().min(0)).optional().describe('Remove actions by index (0-based, applied before adds)'),
        removeConditionIndices: z.array(z.number().int().min(0)).optional().describe('Remove conditions by index (0-based, applied before adds)'),
      }, {
        errorMap: unknownKeysErrorMap('the arguments of update_event_block', 'update_event_block takes sheetName, sid, eventPath, disabled, isElse, isOrBlock, updateActions, updateConditions, addActions, addConditions, removeActionIndices and removeConditionIndices. It does not add sub-events.'),
      }).strict(),
    },
    async (args) => {
      try {
        // Validate at least one update is provided
        const hasUpdate = args.disabled !== undefined
          || args.isElse !== undefined
          || args.isOrBlock !== undefined
          || (args.updateActions && args.updateActions.length > 0)
          || (args.updateConditions && args.updateConditions.length > 0)
          || (args.addActions && args.addActions.length > 0)
          || (args.addConditions && args.addConditions.length > 0)
          || (args.removeActionIndices && args.removeActionIndices.length > 0)
          || (args.removeConditionIndices && args.removeConditionIndices.length > 0);

        if (!hasUpdate) {
          return toolError('No updates provided. Specify at least one of: disabled, isElse, isOrBlock, updateActions, updateConditions, addActions, addConditions, removeActionIndices, removeConditionIndices.');
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
        if (args.isElse !== undefined && eventType !== 'block') {
          return toolError('isElse applies to block events only; a function block cannot be an else block.');
        }

        if (!Array.isArray(event.conditions)) event.conditions = [];
        if (!Array.isArray(event.actions)) event.actions = [];
        const conditions = event.conditions as Record<string, unknown>[];
        const actions = event.actions as Record<string, unknown>[];
        const conditionCountBefore = conditions.length;
        const warnings: string[] = [];
        // Existing conditions/actions edited in place (checked for the legacy behavior key before writing)
        const touched: Array<{ ace: Record<string, unknown>; kind: 'condition' | 'action' }> = [];
        const where = `Block (SID ${args.sid})`;

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
          const { errors, warnings: valWarnings } = await validateObjectClasses(reader, addRefs, {
            insideFunction: isInFunctionBlock(events, event),
          });
          if (errors.length > 0) {
            return toolError(`Object class validation failed:\n${errors.join('\n')}`);
          }
          warnings.push(...valWarnings);
        }

        // The deprecated per-condition isOr flag is never written: it only
        // passes when the block ends up an OR block anyway.
        if ((args.addConditions ?? []).some(c => c.isOr === true)) {
          const willBeOrBlock = args.isOrBlock ?? event.isOrBlock === true;
          if (!willBeOrBlock) {
            return toolError('isOr on a condition is not written: Construct 3 ORs a whole event. Set isOrBlock: true to make this block an OR block.');
          }
          warnings.push(`${where}: the deprecated per-condition isOr flag is not written; the block is an OR block.`);
        }

        // Function signatures, loaded once if any call is added or edited
        let functions: Awaited<ReturnType<typeof loadFunctionSignatures>> | undefined;
        const signatureOf = async (name: string) => {
          functions ??= await loadFunctionSignatures(reader);
          return functions.get(name.toLowerCase());
        };

        // ── Apply block-level toggles (in the editor's key order: disabled right after sid) ──
        if (args.disabled !== undefined) {
          if (args.disabled) {
            setKeyAfterSid(event, 'disabled', true);
          } else {
            delete event.disabled;
          }
        }
        if (args.isOrBlock !== undefined) {
          if (args.isOrBlock) {
            event.isOrBlock = true;
          } else {
            delete event.isOrBlock;
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
              // Parameters go before isInverted, where the editor writes them
              setConditionParameters(cond, { ...(cond.parameters as Record<string, unknown> || {}), ...upd.parameters });
            }
            if (upd.isInverted !== undefined) {
              if (upd.isInverted) {
                cond.isInverted = true;
              } else {
                delete cond.isInverted;
              }
            }
            if (upd.disabled !== undefined) {
              if (upd.disabled) {
                setKeyAfterSid(cond, 'disabled', true);
              } else {
                delete cond.disabled;
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
              const rowProblem = parameterlessRowError(act, upd.index);
              if (rowProblem) return toolError(rowProblem);
            }
            if (upd.disabled !== undefined && act.type === 'comment') {
              return toolError(`Action ${upd.index} is a comment row, which cannot be disabled (editor-saved comment rows are { type, text } with optional "text-color" and "background-color"; none carries "disabled").`);
            }
            if (upd.parameters) {
              if (isFunctionCall(act)) {
                const name = act.callFunction as string;
                const label = `${where}, action ${upd.index} (call to "${name}")`;
                const signature = await signatureOf(name);
                const merged = mergeCallArguments(act.parameters, upd.parameters, signature, label);
                warnings.push(...checkFunctionCallArguments(merged, signature, name, label));
                if (isLegacyFunctionCall(act)) {
                  warnings.push(`${label} was stored in an old shape; it was rewritten as { callFunction, sid, parameters: [...] } without id/objectClass, the shape Construct 3 saves.`);
                }
                rewriteFunctionCallInPlace(act, merged);
                act.callFunction = resolveCallName(name, signature, label, warnings);
              } else {
                if (Array.isArray(upd.parameters)) {
                  return toolError(`Action ${upd.index} is not a function call: pass its parameters as key-value pairs, not an array.`);
                }
                touched.push({ ace: act, kind: 'action' });
                act.parameters = { ...(act.parameters as Record<string, unknown> || {}), ...upd.parameters };
                await resolveFunctionMapParameter(reader, act, `${where}, action ${upd.index} ("${String(act.id)}")`, warnings, async () => {
                  functions ??= await loadFunctionSignatures(reader);
                  return functions;
                });
              }
            } else if (!isFunctionCall(act)) {
              touched.push({ ace: act, kind: 'action' });
            }
            if (upd.disabled !== undefined) {
              if (upd.disabled) {
                setKeyAfterSid(act, 'disabled', true);
              } else {
                delete act.disabled;
              }
            }
          }
        }

        // ── Remove conditions by index (descending order to avoid index shifting) ──
        let removedConditions = false;
        if (args.removeConditionIndices && args.removeConditionIndices.length > 0) {
          const sorted = [...new Set(args.removeConditionIndices)].sort((a, b) => b - a);
          for (const idx of sorted) {
            if (idx < 0 || idx >= conditions.length) {
              return toolError(`Condition index ${idx} is out of range (block has ${conditions.length} condition(s), indices 0-${conditions.length - 1}).`);
            }
            conditions.splice(idx, 1);
            removedConditions = true;
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
            // An added "else" condition is appended: fine on a block without
            // conditions, a duplicate in an else block (or one isElse makes), misplaced otherwise
            if (isElseCondition(c) && conditions.length > 0) {
              if (args.isElse === true || isElseCondition(conditions[0])) {
                warnings.push(`${where}: dropped the added System "else" condition: the block ${args.isElse === true ? 'gets one first through isElse: true' : 'already starts with one'}, and Construct 3 saves Else once, as the first condition.`);
                continue;
              }
              warnings.push(`${where}: an added System "else" condition goes after the existing conditions, but Construct 3 saves Else as the first condition. Use isElse: true instead.`);
            }
            const condSid = await idGen.generateSid(reader);
            conditions.push(buildCondition(c, condSid));
          }
        }

        // ── Add new actions (validated up front) ──
        if (args.addActions && args.addActions.length > 0) {
          const ctx = { warnings, functions };
          for (const a of args.addActions) {
            actions.push(await buildAction(reader, idGen, a, ctx, where) as unknown as Record<string, unknown>);
          }
          functions = ctx.functions;
        }

        // ── Else: the System "else" condition first, applied after all other condition changes ──
        // (where the else block stands is checked by the load-time gate below)
        if (args.isElse !== undefined) {
          const hadLegacyFlag = 'isElse' in event;
          delete event.isElse;
          if (args.isElse && !isElseCondition(conditions[0])) {
            conditions.unshift(createElseCondition(await idGen.generateSid(reader)));
          } else if (!args.isElse && isElseCondition(conditions[0])) {
            conditions.shift();
            removedConditions = true;
          }
          if (hadLegacyFlag) {
            warnings.push(`${where}: dropped the block-level "isElse" key written by older versions (Construct 3 marks an else block with a System "else" first condition instead).`);
          }
        }

        // Only warn when this call removed the last condition. Blocks that
        // never had conditions (function blocks, sub-events) are normal.
        if (removedConditions && conditionCountBefore > 0 && conditions.length === 0) {
          warnings.push(eventType === 'function-block'
            ? 'All conditions were removed: the function body now runs on every call.'
            : 'All conditions were removed: the block now runs whenever its parent runs (every tick at the top level).');
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
        resetProjectIndex(reader);

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

        if (writtenSheets.length > 0) resetProjectIndex(reader);

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

  // ─── fix_legacy_event_shapes ────────────────────────────────

  server.tool(
    'fix_legacy_event_shapes',
    'Repair event sheets written by construct3-mcp 1.8.1 and earlier: convert event shapes Construct 3 itself never writes into the editor\'s own. A block-level "isElse" becomes a System "else" first condition, per-condition "isOr" flags become the block\'s "isOrBlock", and function calls with id/objectClass or keyed parameters become { callFunction, sid, parameters: [...] }. Scripts stored as one string or without "language" (also the shape older Construct 3 releases saved) become lines with language "javascript", as current releases save them; that conversion is harmless. Only unambiguous cases are converted; the rest is reported for a decision by hand. Converted else and OR blocks can run differently than before, so test them in the game. Dry run by default.',
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
        // Named call parameters map to positions through the function's parameters
        const functions = collectFunctionSignatures(loaded.map(l => l.sheet));

        const sheets: Array<{
          sheetName: string;
          converted: number;
          changes: LegacyEventShapeHit[];
          changesTruncated?: boolean;
          manual?: LegacyEventShapeHit[];
          scanTruncated?: boolean;
          backupFile?: string;
        }> = [];
        let totalConverted = 0;
        let totalManual = 0;
        let totalBehaviorChanges = 0;
        const truncatedSheets: string[] = [];

        for (const { sheetName, sheet } of loaded) {
          const scan = await scanLegacyEventShapes(sheet.events, {
            apply: !args.dryRun,
            newSid: () => idGen.generateSid(reader),
            functions,
          });
          if (scan.truncated) truncatedSheets.push(sheetName);
          if (scan.fixable.length === 0 && scan.manual.length === 0) continue;

          const entry: (typeof sheets)[number] = {
            sheetName,
            converted: scan.fixable.length,
            changes: scan.fixable.slice(0, MAX_REPORTED_CHANGES),
          };
          if (scan.fixable.length > MAX_REPORTED_CHANGES) entry.changesTruncated = true;
          if (scan.manual.length > 0) entry.manual = scan.manual;
          if (scan.truncated) entry.scanTruncated = true;

          if (!args.dryRun && scan.fixable.length > 0) {
            const subfolder = writer.getSubfolderForEntity('eventSheets', sheetName);
            entry.backupFile = await writer.writeEntityFile('eventSheets', sheetName, sheet, subfolder);
            writtenSheets.push(sheetName);
          }

          totalConverted += scan.fixable.length;
          totalManual += scan.manual.length;
          totalBehaviorChanges += scan.fixable.filter(h => h.changesBehavior).length;
          sheets.push(entry);
        }

        if (writtenSheets.length > 0) resetProjectIndex(reader);

        const parts: string[] = [];
        if (totalConverted > 0) {
          const verb = args.dryRun ? 'would be converted' : 'converted';
          parts.push(`${totalConverted} legacy event shape(s) in ${sheets.filter(s => s.converted > 0).length} sheet(s) ${verb} to the shapes Construct 3 saves.`);
        }
        if (totalBehaviorChanges > 0) {
          parts.push(
            `${totalBehaviorChanges} of them (else and OR blocks) ${args.dryRun ? 'can' : 'may'} change how the event runs: ` +
            'if Construct 3 ignored the old keys, an isElse block ran like an ordinary block and isOr conditions were AND-combined until now. ' +
            'Test those events in the game (see the details under changes).',
          );
        }
        if (totalManual > 0) {
          parts.push(`${totalManual} were left untouched because the conversion is ambiguous (see manual) — fix them by hand, e.g. with update_event_block (isElse, isOrBlock) or update_event_block_action (call arguments as an array).`);
        }
        if (parts.length === 0) {
          parts.push(unreadableSheets.length > 0
            ? `No legacy event shapes found in the ${loaded.length} readable sheet(s).`
            : 'No legacy event shapes found.');
        }
        if (unreadableSheets.length > 0) {
          parts.push(`${unreadableSheets.length} sheet(s) could not be read and were not checked: ${unreadableSheets.join(', ')}.`);
        }
        if (truncatedSheets.length > 0) {
          parts.push(`The scan stopped at its size limit in ${truncatedSheets.join(', ')}; some events there were not checked.`);
        }
        if (args.dryRun && totalConverted > 0) {
          parts.push('Run again with dryRun: false to apply.');
        }

        return toolResult({
          success: true,
          dryRun: args.dryRun,
          category: 'eventsheet',
          action: args.dryRun ? 'would_fix' : 'fixed',
          sheetsScanned: loaded.length,
          totalConverted,
          totalManual,
          totalBehaviorChanges,
          sheets,
          ...(unreadableSheets.length > 0 ? { unreadableSheets } : {}),
          message: parts.join(' '),
          // A run with nothing to convert writes no sheet: no editor reload note
        }, { projectWritten: writtenSheets.length > 0 });
      } catch (error) {
        console.error('[fix_legacy_event_shapes] failed:', error);
        const partial = writtenSheets.length > 0
          ? ` Sheets already rewritten before the failure: ${writtenSheets.join(', ')}.`
          : '';
        return toolError(`Error fixing legacy event shapes: ${error instanceof Error ? error.message : String(error)}${partial}`);
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
        resetProjectIndex(reader);

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

/** Lower-cased names of the variables at the top level of the sheets (the global variables). */
function topLevelVariableNames(sheets: ReadonlyMap<string, readonly C3Event[]>): Set<string> {
  const names = new Set<string>();
  for (const events of sheets.values()) {
    for (const event of events) {
      const name = (event as { name?: unknown }).name;
      if (event.eventType === 'variable' && typeof name === 'string') names.add(name.toLowerCase());
    }
  }
  return names;
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
