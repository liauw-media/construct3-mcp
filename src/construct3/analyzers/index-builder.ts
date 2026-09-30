/**
 * Cross-reference index builder for Construct 3 projects.
 * Foundation for all analysis features: builds lazily on first use, cached
 * per project (per reader, see getProjectIndex).
 *
 * Objects count as used in events when they are the object of a condition or
 * action, or the objectClass of a custom action block (eventType
 * "custom-ace-block", context "custom-action"; its conditions, actions and
 * sub-events are indexed like those of a function block), and also
 * (heuristics that err on the side of finding a reference):
 * - parameter: a condition/action/function-call parameter whose whole value is
 *   the name of an object type or family, as in object parameters
 *   ("object", "object-to-create", "pin-to", "child", ...). Not counted: keys
 *   that hold other names ("audio-file", "instance-variable", "variable",
 *   "layout"), and a bare name that is also a declared event variable or
 *   function parameter (in an expression parameter a bare name is a variable;
 *   Construct 3 lets variables share names with objects);
 * - expression: "Name." or "Name(" (e.g. "Sprite.X", "Sprite(0).X") in a
 *   parameter expression, outside "..." string literals and not after a "."
 *   (so "Label.Text" does not count an object named Text);
 * - script: runtime.objects.Name or runtime.objects["Name"] (any `objects`
 *   property, e.g. this.runtime.objects) in script actions and script events.
 *   Dynamic lookups (runtime.objects[name]), destructuring and project script
 *   files are not analysed;
 * - create-by-name: the name System "Create object (by name)" creates when it
 *   is one string literal ("object-name": "\"Bullet\""), matched ignoring
 *   case as the runtime looks it up (createByNameTarget, the rule
 *   get_asset_usage uses). A name built by an expression is not analysed.
 * Only names of existing object types and families are recorded this way, so
 * these references never show up as broken references; the exception are the
 * object parameter keys below, whose values name an object type or family in
 * every editor-saved project checked, so a name-shaped value naming neither is
 * recorded and reported as a broken reference (an object deleted with force);
 * any other value there is scanned like an expression. Layout placements
 * cover instances on every layer and sub-layer (layers[].subLayers, nested to
 * any depth) and non-world instances ("nonworld-instances", e.g. Array,
 * Dictionary). An instance property whose value is the SID of an object type
 * or family (object properties such as the Particles "object" property, which
 * editor-saved projects store as the SID) is a reference to that object too.
 *
 * Uses of instance variables and behaviors (memberReferences, see
 * MemberReference) go through an object type or family: the "instance-variable"
 * parameter and the behaviorType of a condition/action on it, an
 * "instance-variable" parameter that names the object type itself as
 * { name, objectClass } (editor-saved System "Sort Z order" actions), and in
 * any parameter expression "Name.var", "Name(0).var", "Name.Behavior.Expression"
 * and, in a condition/action on it, "Self.var" and "Self.Behavior.Expression".
 * An object type has its own instance variables and behaviors and those of its
 * families; a family has only its own. All these names are matched ignoring
 * case (editor-saved projects spell object, instance variable and expression
 * names in expressions in other case, and open; the "instance-variable"
 * parameter and behaviorType are compared the same way, which errs on the side
 * of finding a use), and a two-part "Name.member" counts
 * only when the member names an instance variable or behavior of that object
 * type or family, since otherwise it is one of the plugin's expressions
 * ("Sprite.X"). These uses are what update_object_properties and update_family
 * check before removing an instance variable, a behavior or a family member
 * (findReferencesBrokenBy), what validate_project checks for names that no
 * longer resolve, and, through members, what delete_family checks
 * (getFamilyMemberUses): names a member gets from that family alone (not ones
 * it declares itself or also gets from another family) break when the family
 * is deleted. Scripts that read instance variables and behaviors by name
 * (instVars.name, behaviors.Name in script actions, script events and project
 * script files) are listed apart (getScriptMemberReads): which object's
 * instances they read is not known, so they only warrant a warning. A
 * registered object type whose file could not be parsed (over the read cap,
 * not valid JSON) still counts as an object type, with the names it gets
 * from its families only (its own are unknown), so the uses of its families'
 * names through it are found (issue #55).
 */

import type { Construct3ProjectReader } from '../project-reader.js';
import type {
  C3Event,
  BlockEvent,
  FunctionBlockEvent,
  GroupEvent,
  IncludeEvent,
  ScriptEvent,
  Condition,
  Action,
  ObjectReference,
  Layout,
  FileFolder,
  FileFolderSubfolder,
} from '../types.js';
import {
  createByNameTarget,
  functionsObjectName,
  findExpressionCalls,
  mappedFunctionName,
  parameterValues,
} from '../event-shapes.js';
import { forEachLayoutInstance, layerPathLabel } from '../layers.js';
import { unscannedFilesOf, type UnscannedFile } from './unscanned-uses.js';
import { diskEpochOf, ensureCachesFreshOf } from '../disk-state.js';

/** Instances of an object type in one layout, on one layer (or among the non-world instances). */
export interface InstancePlacement {
  layout: string;
  /** Layer path, e.g. "Main" or "Main > Sub" for a sub-layer; absent for non-world instances */
  layer?: string;
  /** Number of instances there */
  instances: number;
}

/** A layout instance property that holds an object type's or family's SID (an object property). */
export interface InstancePropertyReference {
  layout: string;
  /** Layer path of the instance; absent for a non-world instance */
  layer?: string;
  /** Object type and UID of the instance the property belongs to */
  objectType: string;
  uid: unknown;
  property: string;
}

/** Everything the index knows that refers to one object type. */
export interface ObjectUsage {
  /** Uses in events: condition/action object, object parameter, expression, script */
  events: ObjectReference[];
  /** Layout instances, per layout and layer (sub-layers and non-world instances included) */
  placements: InstancePlacement[];
  /** Instance properties of other objects that hold this object's SID */
  instanceProperties: InstancePropertyReference[];
  /** Families the object is a member of */
  families: string[];
  /** Of those, the families that events use */
  usedFamilies: string[];
}

/** A use of a family's instance variable or behavior through one of its member object types. */
export interface FamilyMemberUse {
  eventSheet: string;
  /** Event path, as in ObjectReference.path */
  path: string;
  /** JSON path of the event, as in MemberReference.eventPath */
  eventPath: string;
  /** SID of the condition or action, when it has one */
  sid?: number;
  /** The member object type the use goes through */
  member: string;
  kind: 'instance variable' | 'behavior';
  /** Name of the instance variable or behavior */
  name: string;
  /**
   * The "instance-variable" parameter or behaviorType of a condition or
   * action on the member, or a parameter expression ("Member.name", or
   * "Self.name" in a condition or action on the member)
   */
  context: 'condition' | 'action' | 'expression';
}

/**
 * How an event names an instance variable or behavior:
 * - "instance-variable": the "instance-variable" parameter of a condition/action
 *   on the object type or family, or one that names the object type itself as
 *   { name, objectClass } (System "Sort Z order");
 * - "behaviorType": the behaviorType of a condition/action ("behavior-type",
 *   the key older versions of this server wrote, is "legacy-behavior-type");
 * - "behavior-expression": "Name.Behavior.Expression" or "Self.Behavior.Expression"
 *   in a parameter expression, whose middle part can only be a behavior;
 * - "member-expression": "Name.member" or "Self.member" whose member names an
 *   instance variable or behavior of the object type or family (anything else
 *   there is one of the plugin's expressions, so these are only recorded while
 *   the name resolves).
 */
export type MemberReferenceForm =
  | 'instance-variable'
  | 'behaviorType'
  | 'legacy-behavior-type'
  | 'behavior-expression'
  | 'member-expression';

/** A use of an instance variable or behavior in a condition or action. */
export interface MemberReference {
  eventSheet: string;
  /** Event path, as in ObjectReference.path */
  path: string;
  /**
   * JSON path of the event that holds the condition or action, e.g.
   * "events[3].children[1]" (the form locate_event returns and the SID-based
   * event tools take as eventPath): `path` names no event index, so uses in
   * sibling events can share it
   */
  eventPath: string;
  /** SID of the condition or action, when it has one */
  sid?: number;
  /**
   * The object type or family it goes through (as spelled in the project): the
   * condition's or action's object, or the object named in the expression
   * ("Self" being the condition's or action's object)
   */
  objectClass: string;
  kind: 'instance variable' | 'behavior';
  /** Name as written in the event */
  name: string;
  /** Where: the condition's or action's own parameter or behavior, or a parameter expression */
  context: 'condition' | 'action' | 'expression';
  form: MemberReferenceForm;
}

/**
 * What a change removes: instance variables and behaviors (object type or
 * family → names, as spelled in its file) and family members (family →
 * object type names).
 */
export interface MemberRemoval {
  variables?: ReadonlyMap<string, readonly string[]>;
  behaviors?: ReadonlyMap<string, readonly string[]>;
  members?: ReadonlyMap<string, readonly string[]>;
}

/**
 * A script that reads an instance variable or behavior by name
 * (instVars.name, behaviors.Name): a script action or script event, or a
 * project script file.
 */
export interface ScriptMemberRead {
  /** Event sheet of the script action or script event; absent for a script file */
  eventSheet?: string;
  /** Event path (as in ObjectReference.path), or "scripts/<file path>" for a script file */
  path: string;
  /** JSON path of the event (as in MemberReference.eventPath); absent for a script file */
  eventPath?: string;
  kind: 'instance variable' | 'behavior';
  name: string;
}

/** Instance variable and behavior names of one object type or family. */
interface ClassMembers {
  isFamily: boolean;
  variables: string[];
  behaviors: string[];
  /**
   * The object type's file could not be parsed (issue #55): its own
   * instance variables and behaviors are unknown (variables and behaviors
   * are empty), only those it gets from its families are known
   */
  ownUnknown?: boolean;
}

const MAX_NODES = 100_000;
const MAX_DEPTH = 50;

/**
 * How a call site reaches its function: a "Call function" action
 * (`callFunction`), a function map action of the Functions object that
 * registers it for "Call mapped function" ("function-map"), or a
 * `Functions.Name(...)` call in an expression ("expression").
 */
export type FunctionCallVia = 'callFunction' | 'function-map' | 'expression';

export interface FunctionCallSite {
  sheet: string;
  path: string;
  via: FunctionCallVia;
}

/**
 * Parameter keys that hold an object type or family name (object parameters),
 * as found on editor-saved projects. Counted even when a variable has the name.
 */
const OBJECT_PARAMETER_KEYS = new Set(['object', 'object-to-create', 'pin-to', 'child']);
/**
 * Parameter keys whose value names something else: a sound (Audio "audio-file"),
 * an instance variable, an event variable, a layout. Never object references.
 */
const NON_OBJECT_PARAMETER_KEYS = new Set(['audio-file', 'instance-variable', 'variable', 'layout']);
/**
 * Shaped like an object type or family name: letters, digits and underscores,
 * at least one of them not a digit (editor-saved object names can start with a
 * digit). Object parameter values in editor-saved projects are always such names.
 */
const NAME_SHAPED = /^[\p{L}\p{N}_]*[\p{L}_][\p{L}\p{N}_]*$/u;
/**
 * Instance properties known to hold the SID of an object type or family, per
 * plugin. Editor-saved projects store the Particles "object" property (the
 * object to spawn as particles) as the object type's SID, or -1 when none is
 * set. SIDs are positive, so other values are no reference.
 */
export const OBJECT_SID_PROPERTIES: ReadonlyMap<string, readonly string[]> = new Map([
  ['Particles', ['object']],
]);

/** C3 expression string literal ("" escapes a quote); an unterminated one runs to the end. */
const EXPRESSION_STRING_LITERAL = /"(?:[^"]|"")*(?:"|$)/g;
/** Identifier followed by "." or "(" that is not itself a member ("a.b.c" yields only "a"). */
const EXPRESSION_OBJECT_TOKEN = /(?<![\p{L}\p{N}_.$])([\p{L}_][\p{L}\p{N}_]*)\s*[.(]/gu;
/** runtime.objects.Name, runtime.objects?.Name, runtime.objects["Name"] */
const SCRIPT_OBJECT_ACCESS =
  /(?<![\p{L}\p{N}_$])objects\s*(?:\?\.|\.)\s*([\p{L}_$][\p{L}\p{N}_$]*)|(?<![\p{L}\p{N}_$])objects\s*(?:\?\.)?\s*\[\s*(["'`])([^"'`\\]+)\2\s*\]/gu;

/** Names in a C3 expression that are used like objects ("Name." / "Name(") */
export function expressionObjectTokens(expression: string): string[] {
  const code = expression.replace(EXPRESSION_STRING_LITERAL, '""');
  return [...code.matchAll(EXPRESSION_OBJECT_TOKEN)].map(m => m[1]);
}

/**
 * In a C3 expression of a condition or action, the object the condition or
 * action is on ("Self.X"). Editor-saved projects write it with this case; it
 * is matched ignoring case, like other names in expressions.
 */
const SELF = 'self';

/**
 * Identifier that does not continue another name or a member access ("a.b"
 * and "a . b" yield only "a").
 */
const EXPRESSION_IDENTIFIER = /(?<![\p{L}\p{N}_.$])(?<!\.\s+)[\p{L}_][\p{L}\p{N}_]*/gu;
/** ".name" right at lastIndex, whitespace allowed around the dot */
const EXPRESSION_MEMBER_NAME = /\s*\.\s*([\p{L}_][\p{L}\p{N}_]*)/uy;

/** "Name.member" or "Name(index).member" in a C3 expression, and the part after it in "Name.Behavior.Expression". */
export interface ExpressionMemberChain {
  object: string;
  member: string;
  /** "Expression" of "Name.Behavior.Expression" */
  next?: string;
}

/**
 * Member accesses on names in a C3 expression: "Sprite.hp" and
 * "Sprite(Sprite.Count - 1).hp" yield { object: "Sprite", member: "hp" } (and
 * the inner Sprite.Count); "Sprite.Fade.Time" yields { object: "Sprite",
 * member: "Fade", next: "Time" }. String literals are skipped.
 */
export function expressionMemberChains(expression: string): ExpressionMemberChain[] {
  const code = expression.replace(EXPRESSION_STRING_LITERAL, '""');
  const chains: ExpressionMemberChain[] = [];
  for (const match of code.matchAll(EXPRESSION_IDENTIFIER)) {
    let i = match.index + match[0].length;
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] === '(') {
      // Instance index: skip to the matching ")"
      let depth = 0;
      for (; i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')' && --depth === 0) break;
      }
      if (depth !== 0) continue;
      i++;
    }
    EXPRESSION_MEMBER_NAME.lastIndex = i;
    const member = EXPRESSION_MEMBER_NAME.exec(code);
    if (!member) continue;
    const next = EXPRESSION_MEMBER_NAME.exec(code);
    chains.push({ object: match[0], member: member[1], ...(next ? { next: next[1] } : {}) });
  }
  return chains;
}

/**
 * Member accesses on names in a C3 expression, as [name, member] pairs:
 * "Sprite.hp" and "Sprite(Sprite.Count - 1).hp" yield ["Sprite", "hp"] (and
 * the inner ["Sprite", "Count"]); "Sprite.Fade.Time" yields ["Sprite", "Fade"].
 * String literals are skipped.
 */
export function expressionMemberAccesses(expression: string): Array<[string, string]> {
  return expressionMemberChains(expression).map(chain => [chain.object, chain.member]);
}

/** Names of the named entries (instance variables, behaviors) of an object type or family. */
function entryNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map(entry => (entry && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string' && name !== '');
}

/**
 * Parameter keys that hold a name rather than an expression (object, instance
 * variable, layout and sound names); not scanned for "Name.member". A layout
 * name such as "Menu.Main" is no member access.
 */
const NAME_PARAMETER_KEYS = new Set([...OBJECT_PARAMETER_KEYS, 'instance-variable', 'layout', 'audio-file']);

/** Names accessed as runtime.objects.Name / runtime.objects["Name"] in script text */
export function scriptObjectTokens(script: string): string[] {
  return [...script.matchAll(SCRIPT_OBJECT_ACCESS)].map(m => m[1] ?? m[3]);
}

/** instVars.name, instVars?.name, instVars["name"] and the same for behaviors, in script text */
const SCRIPT_MEMBER_ACCESS =
  /(?<![\p{L}\p{N}_$])(instVars|behaviors)\s*(?:\?\.|\.)\s*([\p{L}_$][\p{L}\p{N}_$]*)|(?<![\p{L}\p{N}_$])(instVars|behaviors)\s*(?:\?\.)?\s*\[\s*(["'`])([^"'`\\]+)\4\s*\]/gu;

/**
 * Instance variables and behaviors that script text reads by name
 * (inst.instVars.hp, inst.instVars["hp"], inst.behaviors.Fade), each once.
 * Which object's instances the script reads them from is not known.
 */
export function scriptMemberAccesses(script: string): Array<{ kind: MemberReference['kind']; name: string }> {
  const found = new Map<string, { kind: MemberReference['kind']; name: string }>();
  for (const m of script.matchAll(SCRIPT_MEMBER_ACCESS)) {
    const kind = (m[1] ?? m[3]) === 'instVars' ? 'instance variable' : 'behavior';
    const name = m[2] ?? m[5];
    found.set(`${kind}\0${name}`, { kind, name });
  }
  return [...found.values()];
}

/** The instance variables and behaviors the project script files (rootFileFolders.script) read by name. */
async function readScriptFileMemberReads(
  reader: Construct3ProjectReader,
): Promise<{ reads: ScriptMemberRead[]; unreadable: string[] }> {
  const reads: ScriptMemberRead[] = [];
  const unreadable: string[] = [];
  let folder: FileFolder | undefined;
  try {
    folder = typeof reader.getProject === 'function' ? reader.getProject().rootFileFolders?.script : undefined;
  } catch {
    return { reads, unreadable };
  }
  if (!folder || typeof reader.readScriptFile !== 'function') return { reads, unreadable };

  const paths: string[] = [];
  const walk = (f: FileFolder | FileFolderSubfolder, prefix: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const item of Array.isArray(f.items) ? f.items : []) {
      if (item && typeof item.name === 'string' && item.name !== '') paths.push(prefix + item.name);
    }
    for (const sub of Array.isArray(f.subfolders) ? f.subfolders : []) {
      if (sub && typeof sub.name === 'string') walk(sub, `${prefix}${sub.name}/`, depth + 1);
    }
  };
  walk(folder, '', 0);

  for (const path of paths) {
    let source: string;
    try {
      source = await reader.readScriptFile(path);
    } catch {
      unreadable.push(path);
      continue;
    }
    for (const access of scriptMemberAccesses(source)) reads.push({ path: `scripts/${path}`, ...access });
  }
  return { reads, unreadable };
}

/** A use through a member (getFamilyMemberReferences) in the FamilyMemberUse shape delete_family lists. */
export function toFamilyMemberUse(ref: MemberReference): FamilyMemberUse {
  const { eventSheet, path, eventPath, sid, objectClass, kind, name, context } = ref;
  return { eventSheet, path, eventPath, ...(sid !== undefined ? { sid } : {}), member: objectClass, kind, name, context };
}

/** Script text of a script action or script event (a string or an array of lines). */
function scriptText(script: unknown): string {
  if (typeof script === 'string') return script;
  if (Array.isArray(script)) return script.filter((l): l is string => typeof l === 'string').join('\n');
  return '';
}

/**
 * Parameter names of a function block: its `functionParameters`, the key the
 * editor saves them under, or `parameters` on a block without that key.
 */
function functionParameterNames(func: FunctionBlockEvent): string[] {
  const list = Array.isArray(func.functionParameters) ? func.functionParameters
    : Array.isArray(func.parameters) ? func.parameters : [];
  return list
    .map(p => (p && typeof p === 'object' ? (p as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string');
}

/**
 * Names of the event variables (global and local) and function parameters
 * declared in a sheet's events, added to `into`.
 */
function collectVariableNames(events: C3Event[], into: Set<string>): void {
  const stack: Array<{ event: C3Event; depth: number }> = events.map(event => ({ event, depth: 0 }));
  let nodeCount = 0;
  while (stack.length > 0 && nodeCount++ <= MAX_NODES) {
    const { event, depth } = stack.pop()!;
    if (!event || typeof event !== 'object' || depth > MAX_DEPTH) continue;
    if (event.eventType === 'variable' && typeof event.name === 'string') into.add(event.name);
    const functionParameters = (event as FunctionBlockEvent).functionParameters;
    if (Array.isArray(functionParameters)) {
      for (const p of functionParameters) if (typeof p?.name === 'string') into.add(p.name);
    }
    const children = (event as { children?: unknown }).children;
    if (Array.isArray(children)) {
      for (const child of children) stack.push({ event: child as C3Event, depth: depth + 1 });
    }
  }
}

export class ProjectIndex {
  /** Object → where used in events */
  objectToEventSheets: Map<string, ObjectReference[]> = new Map();

  /** Event sheet include graph */
  eventSheetIncludes: Map<string, string[]> = new Map();
  eventSheetIncludedBy: Map<string, string[]> = new Map();

  /** Layout → event sheet binding */
  layoutToEventSheet: Map<string, string> = new Map();

  /** Object → layouts with an instance of it (any layer or sub-layer, or non-world) */
  objectToLayouts: Map<string, string[]> = new Map();
  /** Object → its instances per layout and layer */
  objectPlacements: Map<string, InstancePlacement[]> = new Map();
  /** Object or family → instance properties that hold its SID */
  objectToInstanceProperties: Map<string, InstancePropertyReference[]> = new Map();

  /**
   * Function definitions & call sites. Call sites are callFunction actions,
   * `Functions.Name(...)` calls in the expressions of conditions and actions,
   * and the function map actions of the Functions object ("Map function",
   * "Map function default"), which register a function for "Call mapped
   * function". Call sites are keyed by lower-cased function name (the editor
   * looks functions up ignoring case); use getFunctionCalls.
   */
  functionDefinitions: Map<string, { sheet: string; params: string[] }> = new Map();
  functionCalls: Map<string, FunctionCallSite[]> = new Map();

  /** Family membership */
  familyMembers: Map<string, string[]> = new Map();
  objectToFamilies: Map<string, string[]> = new Map();

  /** Uses of instance variables and behaviors in events, in sheet order (see MemberReference) */
  memberReferences: MemberReference[] = [];

  /** All event sheet names */
  allEventSheets: string[] = [];
  /** All object names */
  allObjects: string[] = [];
  /** All layout names */
  allLayouts: string[] = [];

  /** Warnings collected during indexing */
  warnings: string[] = [];

  /**
   * Registered event sheets, layouts, object types and families the bulk
   * reads skipped (over the size cap, not valid JSON, unreadable; not files
   * that do not exist). Nothing in them is indexed: the reference checks
   * search them as text (unscanned-uses.ts).
   */
  unscannedFiles: UnscannedFile[] = [];

  /** Object type and family names that parameters, expressions and scripts can refer to */
  private referableNames: Set<string> = new Set();
  /** Lower-cased object type or family name → the name (for names matched ignoring case) */
  private referableNamesLower: Map<string, string> = new Map();
  /** Event variable and function parameter names declared in any event sheet */
  private variableNames: Set<string> = new Set();
  /** SID → name of every object type and family (for object properties that store a SID) */
  private namesBySid: Map<number, string> = new Map();
  /** Name → SID of every object type and family that could be read */
  private sidsByName: Map<string, number> = new Map();
  /** Instance variable and behavior names of every object type and family that could be read */
  private classMembers: Map<string, ClassMembers> = new Map();
  /** Lower-cased name → name, for the object types and families in classMembers */
  private classNamesLower: Map<string, string> = new Map();
  /** Object type → the families that list it as a member (families that could be read) */
  private familiesOfObject: Map<string, string[]> = new Map();
  /** Some family file could not be read: an object type may get more names than classMembers shows */
  private unreadableFamilies = false;
  /** Instance variables and behaviors that script actions and script events read by name */
  private eventScriptMemberReads: ScriptMemberRead[] = [];
  /** The same for project script files, read on first use (getScriptMemberReads) */
  private scriptFileMemberReads: Promise<{ reads: ScriptMemberRead[]; unreadable: string[] }> | null = null;

  private built = false;
  /** Name of the built-in Functions object (project.c3proj functionsName) */
  private functionsName = 'Functions';

  isBuilt(): boolean {
    return this.built;
  }

  async build(reader: Construct3ProjectReader): Promise<void> {
    if (this.built) return;

    this.allEventSheets = await reader.listEventSheets();
    this.allObjects = await reader.listObjectTypes();
    this.allLayouts = await reader.listLayouts();
    this.referableNames = new Set([...this.allObjects, ...(await reader.listFamilies())]);
    for (const name of this.referableNames) {
      if (!this.referableNamesLower.has(name.toLowerCase())) this.referableNamesLower.set(name.toLowerCase(), name);
    }

    // Instance variables and behaviors of object types and families (for the uses found in events).
    // Each bulk read's failures are taken right away: a reload by a concurrent call clears them.
    const objectTypes = await reader.readAllObjectTypes();
    const objectTypeFailures = reader.getReadFailures('objectTypes');
    const families = await reader.readAllFamilies();
    const familyFailures = reader.getReadFailures('families');
    const familyNames = await reader.listFamilies();
    const unparsedObjectTypes = unscannedFilesOf('objectTypes', this.allObjects, objectTypes, objectTypeFailures);
    this.indexClassMembers(objectTypes, families, unparsedObjectTypes.map(f => f.name));
    this.unreadableFamilies = familyNames.some(name => !families.has(name));
    this.functionsName = functionsObjectName(reader);

    // Index event sheets (variable names first: parameters are checked against them)
    const eventSheets = await reader.readAllEventSheets();
    const eventSheetFailures = reader.getReadFailures('eventSheets');
    for (const [, sheet] of eventSheets) {
      if (Array.isArray(sheet.events)) collectVariableNames(sheet.events, this.variableNames);
    }
    for (const [sheetName, sheet] of eventSheets) {
      this.eventSheetIncludes.set(sheetName, []);
      if (Array.isArray(sheet.events)) {
        this.indexEventSheet(sheetName, sheet.events);
      }
    }

    // Build includedBy reverse map
    for (const [sheet, includes] of this.eventSheetIncludes) {
      for (const included of includes) {
        if (!this.eventSheetIncludedBy.has(included)) {
          this.eventSheetIncludedBy.set(included, []);
        }
        this.eventSheetIncludedBy.get(included)!.push(sheet);
      }
    }

    // SIDs of object types and families, which object properties of instances store
    for (const [name, data] of [...objectTypes, ...families]) {
      const sid = (data as { sid?: unknown } | null)?.sid;
      if (typeof sid === 'number' && !this.namesBySid.has(sid)) this.namesBySid.set(sid, name);
      if (typeof sid === 'number') this.sidsByName.set(name, sid);
    }

    // Index layouts
    const layouts = await reader.readAllLayouts();
    const layoutFailures = reader.getReadFailures('layouts');
    for (const [layoutName, layout] of layouts) {
      this.indexLayout(layoutName, layout);
    }

    this.unscannedFiles = [
      ...unscannedFilesOf('eventSheets', this.allEventSheets, eventSheets, eventSheetFailures),
      ...unscannedFilesOf('layouts', this.allLayouts, layouts, layoutFailures),
      ...unparsedObjectTypes,
      ...unscannedFilesOf('families', familyNames, families, familyFailures),
    ];

    // Index families
    for (const [familyName, familyData] of families) {
      this.indexFamily(familyName, familyData);
    }

    this.built = true;
  }

  private indexEventSheet(sheetName: string, events: C3Event[]): void {
    // Iterative (stack-based) traversal to avoid stack overflow
    const stack: Array<{ event: C3Event; path: string; eventPath: string; depth: number }> = [];
    let nodeCount = 0;

    // Push events in reverse so we process in order
    for (let i = events.length - 1; i >= 0; i--) {
      stack.push({ event: events[i], path: '', eventPath: `events[${i}]`, depth: 0 });
    }

    while (stack.length > 0) {
      if (nodeCount++ > MAX_NODES) {
        this.warnings.push(`Event sheet "${sheetName}": traversal limit reached (${MAX_NODES} nodes)`);
        break;
      }

      const { event, path, eventPath, depth } = stack.pop()!;
      if (depth > MAX_DEPTH) {
        this.warnings.push(`Event sheet "${sheetName}": max depth exceeded at ${path}`);
        continue;
      }

      const eventType = event.eventType;

      if (eventType === 'block') {
        const block = event as BlockEvent;
        const blockPath = path ? `${path} > block` : 'block';

        // Index conditions
        if (block.conditions) {
          for (let i = 0; i < block.conditions.length; i++) {
            this.indexCondition(sheetName, block.conditions[i], `${blockPath} > condition:${i}`, eventPath);
          }
        }

        // Index actions
        if (block.actions) {
          for (let i = 0; i < block.actions.length; i++) {
            this.indexAction(sheetName, block.actions[i], `${blockPath} > action:${i}`, eventPath);
          }
        }

        // Push children
        if (block.children) {
          for (let i = block.children.length - 1; i >= 0; i--) {
            stack.push({ event: block.children[i], path: blockPath, eventPath: `${eventPath}.children[${i}]`, depth: depth + 1 });
          }
        }
      } else if (eventType === 'function-block') {
        const func = event as FunctionBlockEvent;
        const funcName = func.functionName || 'unknown';
        const funcPath = path ? `${path} > function:${funcName}` : `function:${funcName}`;

        // Record function definition. The editor (and add_event_to_sheet) saves the
        // parameters under functionParameters; "parameters" is only read when that is absent
        this.functionDefinitions.set(funcName, { sheet: sheetName, params: functionParameterNames(func) });

        // Index conditions & actions
        if (func.conditions) {
          for (let i = 0; i < func.conditions.length; i++) {
            this.indexCondition(sheetName, func.conditions[i], `${funcPath} > condition:${i}`, eventPath);
          }
        }
        if (func.actions) {
          for (let i = 0; i < func.actions.length; i++) {
            this.indexAction(sheetName, func.actions[i], `${funcPath} > action:${i}`, eventPath);
          }
        }

        // Push children
        if (func.children) {
          for (let i = func.children.length - 1; i >= 0; i--) {
            stack.push({ event: func.children[i], path: funcPath, eventPath: `${eventPath}.children[${i}]`, depth: depth + 1 });
          }
        }
      } else if ((eventType as string) === 'custom-ace-block') {
        // Custom action block: a custom action of its objectClass (object type or
        // family), with conditions, actions and sub-events like a function block
        const custom = event as unknown as {
          objectClass?: unknown; aceName?: unknown; conditions?: Condition[]; actions?: Action[]; children?: C3Event[];
        };
        const customLabel = `custom-action:${String(custom.objectClass)}.${String(custom.aceName)}`;
        const customPath = path ? `${path} > ${customLabel}` : customLabel;
        if (typeof custom.objectClass === 'string' && custom.objectClass !== '') {
          this.addObjectReference(custom.objectClass, sheetName, customPath, 'custom-action');
        }
        if (Array.isArray(custom.conditions)) {
          for (let i = 0; i < custom.conditions.length; i++) {
            this.indexCondition(sheetName, custom.conditions[i], `${customPath} > condition:${i}`, eventPath);
          }
        }
        if (Array.isArray(custom.actions)) {
          for (let i = 0; i < custom.actions.length; i++) {
            this.indexAction(sheetName, custom.actions[i], `${customPath} > action:${i}`, eventPath);
          }
        }
        if (Array.isArray(custom.children)) {
          for (let i = custom.children.length - 1; i >= 0; i--) {
            stack.push({ event: custom.children[i], path: customPath, eventPath: `${eventPath}.children[${i}]`, depth: depth + 1 });
          }
        }
      } else if (eventType === 'group') {
        const group = event as GroupEvent;
        const groupPath = path ? `${path} > group:${group.title}` : `group:${group.title}`;

        // Index children (even if disabled — they're part of the structure)
        if (group.children) {
          for (let i = group.children.length - 1; i >= 0; i--) {
            stack.push({ event: group.children[i], path: groupPath, eventPath: `${eventPath}.children[${i}]`, depth: depth + 1 });
          }
        }
      } else if (eventType === 'include') {
        const include = event as IncludeEvent;
        const includes = this.eventSheetIncludes.get(sheetName) || [];
        if (!includes.includes(include.includeSheet)) {
          includes.push(include.includeSheet);
          this.eventSheetIncludes.set(sheetName, includes);
        }
      } else if (eventType === 'script') {
        this.indexScript(sheetName, (event as ScriptEvent).script, path ? `${path} > script` : 'script', eventPath);
      }
      // variable, comment — no object references to index
    }
  }

  private indexCondition(sheetName: string, condition: Condition, path: string, eventPath: string): void {
    if (!condition || typeof condition !== 'object') return;
    this.indexExpressionCalls(condition as unknown as Record<string, unknown>, sheetName, path);
    if (condition.objectClass) {
      this.addObjectReference(condition.objectClass, sheetName, path, 'condition');
    }
    this.indexParameters(sheetName, condition.parameters, path, condition.objectClass);
    this.indexMemberReferences(sheetName, condition as unknown as Record<string, unknown>, path, eventPath, 'condition');
  }

  private indexAction(sheetName: string, action: Action, path: string, eventPath: string): void {
    if (!action || typeof action !== 'object') return;
    // Script actions have type: 'script' instead of objectClass
    if ('type' in action && action.type === 'script') {
      this.indexScript(sheetName, action.script, path, eventPath);
      return;
    }

    const record = action as unknown as Record<string, unknown>;
    const stdAction = action as { objectClass?: string; callFunction?: string; id?: string; parameters?: unknown };
    if (stdAction.objectClass) {
      this.addObjectReference(stdAction.objectClass, sheetName, path, 'action');
    }
    this.indexParameters(sheetName, stdAction.parameters, path, stdAction.objectClass);
    this.indexMemberReferences(sheetName, action as unknown as Record<string, unknown>, path, eventPath, 'action');

    // System "Create object (by name)" with a literal name creates that object type (or a family member)
    const created = createByNameTarget(record);
    const createdName = typeof created === 'string' ? this.referableNamesLower.get(created.toLowerCase()) : undefined;
    if (createdName !== undefined) this.addObjectReference(createdName, sheetName, path, 'create-by-name');

    // Check for function calls
    if (typeof stdAction.callFunction === 'string' && stdAction.callFunction) {
      this.addFunctionCall(stdAction.callFunction, sheetName, path, 'callFunction');
    }

    // Function maps name the mapped function in their "function" parameter
    const mapped = mappedFunctionName(record, this.functionsName);
    if (mapped !== undefined) this.addFunctionCall(mapped, sheetName, path, 'function-map');

    this.indexExpressionCalls(record, sheetName, path);
  }

  /** Record `Functions.Name(...)` calls in the expression parameters of a condition or action. */
  private indexExpressionCalls(ace: Record<string, unknown>, sheetName: string, path: string): void {
    for (const value of parameterValues(ace)) {
      if (typeof value !== 'string') continue;
      for (const call of findExpressionCalls(value, this.functionsName)) {
        this.addFunctionCall(call.name, sheetName, path, 'expression');
      }
    }
  }

  /**
   * Object and family names in the parameters (a map, or the argument array of
   * a function call) of one condition/action. `ownObject` (its objectClass) is
   * already recorded and is not repeated.
   */
  private indexParameters(sheetName: string, parameters: unknown, path: string, ownObject?: string): void {
    // Function call arguments have no keys
    const entries: Array<[string | undefined, unknown]> = Array.isArray(parameters)
      ? parameters.map(value => [undefined, value])
      : parameters && typeof parameters === 'object' ? Object.entries(parameters) : [];
    const found = new Map<string, ObjectReference['context']>();
    for (const [key, value] of entries) {
      if (typeof value !== 'string') continue;
      const whole = value.trim();
      if (this.referableNames.has(whole)) {
        if (!found.has(whole) && this.isObjectParameter(key, whole)) found.set(whole, 'parameter');
        continue;
      }
      // An object parameter holding a name of no object type or family (e.g. one deleted
      // with force): recorded, so validate_project reports it as a broken reference. Any
      // other value (an expression written by hand) is scanned for object names below.
      if (key !== undefined && OBJECT_PARAMETER_KEYS.has(key) && NAME_SHAPED.test(whole)) {
        if (!found.has(whole)) found.set(whole, 'parameter');
        continue;
      }
      for (const name of expressionObjectTokens(value)) {
        if (this.referableNames.has(name) && !found.has(name)) found.set(name, 'expression');
      }
    }
    for (const [name, context] of found) {
      if (name !== ownObject) this.addObjectReference(name, sheetName, path, context);
    }
  }

  /**
   * Whether a parameter whose whole value is an object/family name refers to
   * that object: always for object parameter keys, never for keys that hold
   * other names, otherwise unless a variable or function parameter has the name.
   */
  private isObjectParameter(key: string | undefined, name: string): boolean {
    if (key !== undefined && OBJECT_PARAMETER_KEYS.has(key)) return true;
    if (key !== undefined && NON_OBJECT_PARAMETER_KEYS.has(key)) return false;
    return !this.variableNames.has(name);
  }

  /**
   * Instance variable and behavior names of the object types and families,
   * and each object type's families. A registered object type whose file
   * could not be parsed (`unparsedObjectTypes`) is a class whose own names are
   * unknown: the uses of the names it gets from a family are still found and
   * checked (delete_family, update_family), and validate_project does not
   * report its uses as unresolved.
   */
  private indexClassMembers(
    objectTypes: ReadonlyMap<string, unknown>,
    families: ReadonlyMap<string, Record<string, unknown>>,
    unparsedObjectTypes: readonly string[],
  ): void {
    const add = (name: string, data: unknown, isFamily: boolean, ownUnknown = false) => {
      const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
      this.classMembers.set(name, {
        isFamily,
        variables: entryNames(record.instanceVariables),
        behaviors: entryNames(record.behaviorTypes),
        ...(ownUnknown ? { ownUnknown } : {}),
      });
      if (!this.classNamesLower.has(name.toLowerCase())) this.classNamesLower.set(name.toLowerCase(), name);
    };
    for (const [name, data] of objectTypes) add(name, data, false);
    for (const name of unparsedObjectTypes) add(name, undefined, false, true);
    for (const [name, data] of families) {
      add(name, data, true);
      if (!Array.isArray(data?.members)) continue;
      for (const member of new Set(data.members)) {
        if (typeof member !== 'string') continue;
        if (!this.familiesOfObject.has(member)) this.familiesOfObject.set(member, []);
        this.familiesOfObject.get(member)!.push(name);
      }
    }
  }

  /**
   * Whether an object type or family has an instance variable or behavior of
   * this name (ignoring case) after `removal`: its own, or for an object type
   * one of a family it stays a member of. An object type whose file could not
   * be parsed has no known names of its own, so a use of a family's name
   * through it counts as broken when it loses that family's name.
   */
  hasMember(
    objectClass: string, kind: MemberReference['kind'], name: string, removal: MemberRemoval = {},
  ): boolean {
    const key = name.toLowerCase();
    const has = (owner: string) => {
      const members = this.classMembers.get(owner);
      if (!members) return false;
      const removed = (kind === 'instance variable' ? removal.variables : removal.behaviors)?.get(owner) ?? [];
      const names = kind === 'instance variable' ? members.variables : members.behaviors;
      return names.some(n => n.toLowerCase() === key && !removed.includes(n));
    };
    if (has(objectClass)) return true;
    if (this.classMembers.get(objectClass)?.isFamily !== false) return false;
    return (this.familiesOfObject.get(objectClass) ?? []).some(family =>
      !(removal.members?.get(family) ?? []).includes(objectClass) && has(family));
  }

  /**
   * Uses of instance variables and behaviors in one condition/action (see
   * MemberReference): its "instance-variable" parameter and behaviorType when
   * its objectClass is an object type or family, an "instance-variable"
   * parameter that names its object type itself (System "Sort Z order"), and
   * "Name.member" / "Name.Behavior.Expression" in its parameter expressions,
   * "Self" being its objectClass. One entry per object, kind, name and context.
   */
  private indexMemberReferences(
    sheetName: string, ace: Record<string, unknown>, path: string, eventPath: string, context: 'condition' | 'action',
  ): void {
    if (this.classMembers.size === 0) return;
    const found = new Map<string, MemberReference>();
    const sid = typeof ace.sid === 'number' ? { sid: ace.sid } : {};
    const record = (
      objectClass: string, kind: MemberReference['kind'], name: string,
      useContext: MemberReference['context'], form: MemberReferenceForm,
    ) => {
      const key = [objectClass, kind, name.toLowerCase(), useContext].join('\0');
      if (!found.has(key)) {
        found.set(key, { eventSheet: sheetName, path, eventPath, ...sid, objectClass, kind, name, context: useContext, form });
      }
    };

    const parameters = ace.parameters;
    const keyed = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
      ? parameters as Record<string, unknown>
      : undefined;
    // The condition's or action's own object type or family, as spelled in the project
    const own = typeof ace.objectClass === 'string' && this.classMembers.has(ace.objectClass) ? ace.objectClass : undefined;
    const variable = keyed?.['instance-variable'];
    if (typeof variable === 'string') {
      if (own !== undefined && variable !== '') record(own, 'instance variable', variable, context, 'instance-variable');
    } else if (variable && typeof variable === 'object' && !Array.isArray(variable)) {
      // Editor-saved System actions such as "Sort Z order" name the object type
      // with the variable, whatever their own object: {"name": "hp",
      // "objectClass": "Sprite"}, next to "object": "Sprite"
      const { name, objectClass } = variable as Record<string, unknown>;
      const through = [objectClass, keyed?.object]
        .find((c): c is string => typeof c === 'string' && this.classMembers.has(c));
      if (typeof name === 'string' && name !== '' && through !== undefined) {
        record(through, 'instance variable', name, context, 'instance-variable');
      }
    }
    if (own !== undefined) {
      if (typeof ace.behaviorType === 'string' && ace.behaviorType !== '') {
        record(own, 'behavior', ace.behaviorType, context, 'behaviorType');
      } else if (typeof ace['behavior-type'] === 'string' && ace['behavior-type'] !== '') {
        // The key older versions of this server wrote
        record(own, 'behavior', ace['behavior-type'], context, 'legacy-behavior-type');
      }
    }

    const entries: Array<[string | undefined, unknown]> = Array.isArray(parameters)
      ? parameters.map(value => [undefined, value])
      : parameters && typeof parameters === 'object' ? Object.entries(parameters) : [];
    for (const [key, value] of entries) {
      if (typeof value !== 'string' || !value.includes('.') || (key !== undefined && NAME_PARAMETER_KEYS.has(key))) continue;
      for (const { object, member, next } of expressionMemberChains(value)) {
        const objectClass = object.toLowerCase() === SELF ? own : this.classNamesLower.get(object.toLowerCase());
        if (objectClass === undefined) continue;
        if (next !== undefined) {
          // "Name.Behavior.Expression": the middle part can only be a behavior
          record(objectClass, 'behavior', member, 'expression', 'behavior-expression');
        } else if (this.hasMember(objectClass, 'instance variable', member)) {
          record(objectClass, 'instance variable', member, 'expression', 'member-expression');
        } else if (this.hasMember(objectClass, 'behavior', member)) {
          record(objectClass, 'behavior', member, 'expression', 'member-expression');
        }
      }
    }

    this.memberReferences.push(...found.values());
  }

  /**
   * Objects a script action or script event accesses through runtime.objects,
   * and the instance variables and behaviors it reads by name (instVars.name,
   * behaviors.Name).
   */
  private indexScript(sheetName: string, script: unknown, path: string, eventPath: string): void {
    const text = scriptText(script);
    const names = new Set(scriptObjectTokens(text).filter(n => this.referableNames.has(n)));
    for (const name of names) this.addObjectReference(name, sheetName, path, 'script');
    for (const access of scriptMemberAccesses(text)) {
      this.eventScriptMemberReads.push({ eventSheet: sheetName, path, eventPath, ...access });
    }
  }

  private addFunctionCall(functionName: string, sheetName: string, path: string, via: FunctionCallVia): void {
    const key = functionName.toLowerCase();
    const calls = this.functionCalls.get(key) || [];
    calls.push({ sheet: sheetName, path, via });
    this.functionCalls.set(key, calls);
  }

  /** Call sites of a function, matched ignoring case (as the editor looks functions up). */
  getFunctionCalls(functionName: string): FunctionCallSite[] {
    return this.functionCalls.get(functionName.toLowerCase()) ?? [];
  }

  private addObjectReference(objectName: string, sheetName: string, path: string, context: ObjectReference['context']): void {
    if (!this.objectToEventSheets.has(objectName)) {
      this.objectToEventSheets.set(objectName, []);
    }
    this.objectToEventSheets.get(objectName)!.push({
      objectName,
      eventSheet: sheetName,
      path,
      context,
    });
  }

  private indexLayout(layoutName: string, layout: Layout): void {
    // Bind layout to its event sheet (field is 'eventSheet' in C3 layout JSON)
    const eventSheet = (layout as Record<string, unknown>)['eventSheet'] ?? layout['event-sheet'];
    if (typeof eventSheet === 'string') {
      this.layoutToEventSheet.set(layoutName, eventSheet);
    }

    // Index object placements from instances on every layer and sub-layer and
    // non-world instances, and object properties that hold a SID
    forEachLayoutInstance(layout, (instance, entry) => {
      const layer = entry ? layerPathLabel(entry) : undefined;
      this.addLayoutPlacement(instance.type, layoutName, layer);
      this.indexInstanceProperties(instance.properties, {
        layout: layoutName,
        ...(layer !== undefined ? { layer } : {}),
        objectType: typeof instance.type === 'string' ? instance.type : String(instance.type),
        uid: instance.uid,
      });
    });
  }

  private addLayoutPlacement(type: unknown, layoutName: string, layer: string | undefined): void {
    if (typeof type !== 'string' || type === '') return;
    if (!this.objectToLayouts.has(type)) {
      this.objectToLayouts.set(type, []);
    }
    const layouts = this.objectToLayouts.get(type)!;
    if (!layouts.includes(layoutName)) {
      layouts.push(layoutName);
    }
    if (!this.objectPlacements.has(type)) {
      this.objectPlacements.set(type, []);
    }
    const placements = this.objectPlacements.get(type)!;
    const same = placements.find(p => p.layout === layoutName && p.layer === layer);
    if (same) {
      same.instances++;
    } else {
      placements.push({ layout: layoutName, ...(layer !== undefined ? { layer } : {}), instances: 1 });
    }
  }

  /** Instance property values that are the SID of an object type or family (object properties). */
  private indexInstanceProperties(properties: unknown, instance: Omit<InstancePropertyReference, 'property'>): void {
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return;
    for (const [property, value] of Object.entries(properties)) {
      if (typeof value !== 'number') continue;
      const name = this.namesBySid.get(value);
      if (name === undefined) continue;
      if (!this.objectToInstanceProperties.has(name)) {
        this.objectToInstanceProperties.set(name, []);
      }
      this.objectToInstanceProperties.get(name)!.push({ ...instance, property });
    }
  }

  private indexFamily(familyName: string, familyData: Record<string, unknown>): void {
    const members = familyData.members as string[] | undefined;
    if (!Array.isArray(members)) return;

    this.familyMembers.set(familyName, members);
    for (const member of members) {
      if (!this.objectToFamilies.has(member)) {
        this.objectToFamilies.set(member, []);
      }
      this.objectToFamilies.get(member)!.push(familyName);
    }
  }

  /** SID of an object type or family whose file could be read. */
  sidOf(name: string): number | undefined {
    return this.sidsByName.get(name);
  }

  /**
   * Get unique event sheets that reference a given object
   */
  getEventSheetsForObject(objectName: string): string[] {
    const refs = this.objectToEventSheets.get(objectName) || [];
    return [...new Set(refs.map(r => r.eventSheet))];
  }

  /** Everything the index knows that refers to an object type (see ObjectUsage). A family counts as used when events or object properties name it. */
  getObjectUsage(objectName: string): ObjectUsage {
    const families = [...new Set(this.objectToFamilies.get(objectName) ?? [])];
    return {
      events: this.objectToEventSheets.get(objectName) ?? [],
      placements: this.objectPlacements.get(objectName) ?? [],
      instanceProperties: this.objectToInstanceProperties.get(objectName) ?? [],
      families,
      usedFamilies: families.filter(family =>
        this.getEventSheetsForObject(family).length > 0 || (this.objectToInstanceProperties.get(family) ?? []).length > 0),
    };
  }

  /**
   * Uses of a family's instance variables and behaviors through its member
   * object types (see FamilyMemberUse); these break when the family is deleted.
   */
  getFamilyMemberUses(familyName: string): FamilyMemberUse[] {
    return this.getFamilyMemberReferences(familyName).map(toFamilyMemberUse);
  }

  /** The uses behind getFamilyMemberUses, as MemberReference (objectClass being the member). */
  getFamilyMemberReferences(familyName: string): MemberReference[] {
    const members = this.familyMembers.get(familyName) ?? [];
    if (members.length === 0) return [];
    const objectTypes = new Set(members.filter(m => this.classMembers.get(m)?.isFamily === false));
    return this.findReferencesBrokenBy({ members: new Map([[familyName, members]]) })
      .filter(ref => objectTypes.has(ref.objectClass));
  }

  /**
   * Uses of instance variables and behaviors in events that resolve now and
   * would no longer resolve after `removal` (instance variables, behaviors or
   * family members removed), in sheet order. A use still resolves when the
   * object type or family keeps a variable or behavior of that name, ignoring
   * case (for an object type: its own or one of a family it stays in).
   */
  findReferencesBrokenBy(removal: MemberRemoval): MemberReference[] {
    return this.memberReferences.filter(ref =>
      this.hasMember(ref.objectClass, ref.kind, ref.name) && !this.hasMember(ref.objectClass, ref.kind, ref.name, removal));
  }

  /**
   * The instance variables or behaviors an object type or family has: its own
   * and, for an object type, those of its families (in project order, each
   * name once).
   */
  memberNamesOf(objectClass: string, kind: MemberReference['kind']): string[] {
    const owners = this.classMembers.get(objectClass)?.isFamily === false
      ? [objectClass, ...(this.familiesOfObject.get(objectClass) ?? [])]
      : [objectClass];
    const names = owners.flatMap(owner => {
      const members = this.classMembers.get(owner);
      return members ? (kind === 'instance variable' ? members.variables : members.behaviors) : [];
    });
    return [...new Set(names)];
  }

  /**
   * Uses of instance variables and behaviors in events that name one the
   * object type or family does not have (for an object type: neither itself
   * nor any of its families; for a family: the family itself), ignoring case.
   * Only the forms that must name one are checked: the "instance-variable"
   * parameter, behaviorType and "Name.Behavior.Expression"; a "Name.member"
   * that names none is one of the plugin's expressions, and the legacy
   * "behavior-type" key is validate_project's legacy-behavior-key check. Uses
   * through an object type are left out while a family file could not be read,
   * and uses through an object type whose own file could not be parsed.
   */
  findUnresolvedMemberReferences(): MemberReference[] {
    return this.memberReferences.filter(ref =>
      ref.form !== 'member-expression' && ref.form !== 'legacy-behavior-type' &&
      !(this.unreadableFamilies && this.classMembers.get(ref.objectClass)?.isFamily === false) &&
      !this.classMembers.get(ref.objectClass)?.ownUnknown &&
      !this.hasMember(ref.objectClass, ref.kind, ref.name));
  }

  /**
   * Instance variables and behaviors that scripts read by name (see
   * scriptMemberAccesses): script actions and script events, then project
   * script files (rootFileFolders.script), which are read on the first call.
   * `unreadable` names the script files that could not be read.
   */
  async getScriptMemberReads(reader: Construct3ProjectReader): Promise<{ reads: ScriptMemberRead[]; unreadable: string[] }> {
    this.scriptFileMemberReads ??= readScriptFileMemberReads(reader);
    const files = await this.scriptFileMemberReads;
    return { reads: [...this.eventScriptMemberReads, ...files.reads], unreadable: files.unreadable };
  }

  /** The object type or family with this SID, if any (for object properties that store a SID). */
  objectNameForSid(sid: number): string | undefined {
    return this.namesBySid.get(sid);
  }

  /**
   * True when an object is used by an event (directly, or through one of its
   * families), has an instance in a layout (any layer or sub-layer, or
   * non-world) or is named by another instance's object property. Objects for
   * which this is false are the orphaned objects.
   */
  isObjectUsed(objectName: string): boolean {
    const usage = this.getObjectUsage(objectName);
    return usage.events.length > 0 || usage.placements.length > 0 ||
      usage.instanceProperties.length > 0 || usage.usedFamilies.length > 0;
  }

  /**
   * True when deleting the object would leave something that refers to it:
   * any use (isObjectUsed) or a family membership, even of a family no event
   * uses. delete_object refuses these objects without force.
   */
  isObjectReferenced(objectName: string): boolean {
    return this.isObjectUsed(objectName) || (this.objectToFamilies.get(objectName) ?? []).length > 0;
  }

  /**
   * Get objects that co-occur in the same event blocks as the given object
   */
  getCoOccurringObjects(objectName: string): string[] {
    const refs = this.objectToEventSheets.get(objectName) || [];
    const coObjects = new Set<string>();

    for (const ref of refs) {
      // Find all other objects referenced in the same event sheet
      for (const [otherObj, otherRefs] of this.objectToEventSheets) {
        if (otherObj === objectName) continue;
        for (const otherRef of otherRefs) {
          if (otherRef.eventSheet === ref.eventSheet) {
            coObjects.add(otherObj);
            break;
          }
        }
      }
    }

    return [...coObjects];
  }

  /**
   * Get the total number of events in an event sheet (from the raw events array)
   */
  countEvents(events: C3Event[]): number {
    let count = 0;
    const stack = [...events];
    while (stack.length > 0) {
      count++;
      const event = stack.pop()!;
      if ('children' in event && Array.isArray(event.children)) {
        stack.push(...event.children);
      }
    }
    return count;
  }
}

/**
 * The built index of each project, keyed by its reader: two projects opened in
 * one process (scripts, tests, embeddings) never see each other's index. Each
 * notes the reader's disk epoch it was built in.
 */
let cachedIndexes = new WeakMap<Construct3ProjectReader, { index: ProjectIndex; epoch: number }>();

/**
 * The cross-reference index of the reader's project: built on first use, then
 * cached for that reader until a write resets it or the reader finds a change
 * on disk the server did not make (its disk epoch moves, #51).
 */
export async function getProjectIndex(reader: Construct3ProjectReader): Promise<ProjectIndex> {
  // In a tool call: a file the index was built from may have changed on disk since
  await ensureCachesFreshOf(reader);
  const epoch = diskEpochOf(reader);
  const cached = cachedIndexes.get(reader);
  if (cached && cached.epoch === epoch && cached.index.isBuilt()) return cached.index;
  const index = new ProjectIndex();
  // Cached before the build: a reset while it runs drops it, so the next call rebuilds
  cachedIndexes.set(reader, { index, epoch });
  await index.build(reader);
  return index;
}

/**
 * Reset the cached index of the reader's project so it rebuilds on next use;
 * other projects keep theirs. Without a reader, every project's index is reset.
 */
export function resetProjectIndex(reader?: Construct3ProjectReader): void {
  if (reader) cachedIndexes.delete(reader);
  else cachedIndexes = new WeakMap();
}
