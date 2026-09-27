/**
 * Cross-reference index builder for Construct 3 projects.
 * Foundation for all analysis features: builds lazily on first use, cached.
 *
 * Objects count as used in events when they are the object of a condition or
 * action, and also (heuristics that err on the side of finding a reference):
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
 *   files are not analysed.
 * Only names of existing object types and families are recorded this way, so
 * these references never show up as broken references. Layout placements
 * include non-world instances ("nonworld-instances", e.g. Array, Dictionary).
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
} from '../types.js';

const MAX_NODES = 100_000;
const MAX_DEPTH = 50;

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

/** Names accessed as runtime.objects.Name / runtime.objects["Name"] in script text */
export function scriptObjectTokens(script: string): string[] {
  return [...script.matchAll(SCRIPT_OBJECT_ACCESS)].map(m => m[1] ?? m[3]);
}

/** Script text of a script action or script event (a string or an array of lines). */
function scriptText(script: unknown): string {
  if (typeof script === 'string') return script;
  if (Array.isArray(script)) return script.filter((l): l is string => typeof l === 'string').join('\n');
  return '';
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

  /** Object → layout placements */
  objectToLayouts: Map<string, string[]> = new Map();

  /** Function definitions & call sites */
  functionDefinitions: Map<string, { sheet: string; params: string[] }> = new Map();
  functionCalls: Map<string, { sheet: string; path: string }[]> = new Map();

  /** Family membership */
  familyMembers: Map<string, string[]> = new Map();
  objectToFamilies: Map<string, string[]> = new Map();

  /** All event sheet names */
  allEventSheets: string[] = [];
  /** All object names */
  allObjects: string[] = [];
  /** All layout names */
  allLayouts: string[] = [];

  /** Warnings collected during indexing */
  warnings: string[] = [];

  /** Object type and family names that parameters, expressions and scripts can refer to */
  private referableNames: Set<string> = new Set();
  /** Event variable and function parameter names declared in any event sheet */
  private variableNames: Set<string> = new Set();

  private built = false;

  isBuilt(): boolean {
    return this.built;
  }

  async build(reader: Construct3ProjectReader): Promise<void> {
    if (this.built) return;

    this.allEventSheets = await reader.listEventSheets();
    this.allObjects = await reader.listObjectTypes();
    this.allLayouts = await reader.listLayouts();
    this.referableNames = new Set([...this.allObjects, ...(await reader.listFamilies())]);

    // Index event sheets (variable names first: parameters are checked against them)
    const eventSheets = await reader.readAllEventSheets();
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

    // Index layouts
    const layouts = await reader.readAllLayouts();
    for (const [layoutName, layout] of layouts) {
      this.indexLayout(layoutName, layout);
    }

    // Index families
    const families = await reader.readAllFamilies();
    for (const [familyName, familyData] of families) {
      this.indexFamily(familyName, familyData);
    }

    this.built = true;
  }

  private indexEventSheet(sheetName: string, events: C3Event[]): void {
    // Iterative (stack-based) traversal to avoid stack overflow
    const stack: Array<{ event: C3Event; path: string; depth: number }> = [];
    let nodeCount = 0;

    // Push events in reverse so we process in order
    for (let i = events.length - 1; i >= 0; i--) {
      stack.push({ event: events[i], path: '', depth: 0 });
    }

    while (stack.length > 0) {
      if (nodeCount++ > MAX_NODES) {
        this.warnings.push(`Event sheet "${sheetName}": traversal limit reached (${MAX_NODES} nodes)`);
        break;
      }

      const { event, path, depth } = stack.pop()!;
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
            this.indexCondition(sheetName, block.conditions[i], `${blockPath} > condition:${i}`);
          }
        }

        // Index actions
        if (block.actions) {
          for (let i = 0; i < block.actions.length; i++) {
            this.indexAction(sheetName, block.actions[i], `${blockPath} > action:${i}`);
          }
        }

        // Push children
        if (block.children) {
          for (let i = block.children.length - 1; i >= 0; i--) {
            stack.push({ event: block.children[i], path: blockPath, depth: depth + 1 });
          }
        }
      } else if (eventType === 'function-block') {
        const func = event as FunctionBlockEvent;
        const funcName = func.functionName || 'unknown';
        const funcPath = path ? `${path} > function:${funcName}` : `function:${funcName}`;

        // Record function definition
        const paramNames = func.parameters?.map(p => p.name) || [];
        this.functionDefinitions.set(funcName, { sheet: sheetName, params: paramNames });

        // Index conditions & actions
        if (func.conditions) {
          for (let i = 0; i < func.conditions.length; i++) {
            this.indexCondition(sheetName, func.conditions[i], `${funcPath} > condition:${i}`);
          }
        }
        if (func.actions) {
          for (let i = 0; i < func.actions.length; i++) {
            this.indexAction(sheetName, func.actions[i], `${funcPath} > action:${i}`);
          }
        }

        // Push children
        if (func.children) {
          for (let i = func.children.length - 1; i >= 0; i--) {
            stack.push({ event: func.children[i], path: funcPath, depth: depth + 1 });
          }
        }
      } else if (eventType === 'group') {
        const group = event as GroupEvent;
        const groupPath = path ? `${path} > group:${group.title}` : `group:${group.title}`;

        // Index children (even if disabled — they're part of the structure)
        if (group.children) {
          for (let i = group.children.length - 1; i >= 0; i--) {
            stack.push({ event: group.children[i], path: groupPath, depth: depth + 1 });
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
        this.indexScript(sheetName, (event as ScriptEvent).script, path ? `${path} > script` : 'script');
      }
      // variable, comment — no object references to index
    }
  }

  private indexCondition(sheetName: string, condition: Condition, path: string): void {
    if (condition.objectClass) {
      this.addObjectReference(condition.objectClass, sheetName, path, 'condition');
    }
    this.indexParameters(sheetName, condition.parameters, path, condition.objectClass);
  }

  private indexAction(sheetName: string, action: Action, path: string): void {
    // Script actions have type: 'script' instead of objectClass
    if ('type' in action && action.type === 'script') {
      this.indexScript(sheetName, action.script, path);
      return;
    }

    const stdAction = action as { objectClass?: string; callFunction?: string; id?: string; parameters?: unknown };
    if (stdAction.objectClass) {
      this.addObjectReference(stdAction.objectClass, sheetName, path, 'action');
    }
    this.indexParameters(sheetName, stdAction.parameters, path, stdAction.objectClass);

    // Check for function calls
    if (stdAction.callFunction) {
      const calls = this.functionCalls.get(stdAction.callFunction) || [];
      calls.push({ sheet: sheetName, path });
      this.functionCalls.set(stdAction.callFunction, calls);
    }

    // Also check id for "callFunction" pattern
    if (stdAction.id === 'callFunction' && stdAction.callFunction) {
      // Already handled above
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

  /** Objects a script action or script event accesses through runtime.objects. */
  private indexScript(sheetName: string, script: unknown, path: string): void {
    const names = new Set(scriptObjectTokens(scriptText(script)).filter(n => this.referableNames.has(n)));
    for (const name of names) this.addObjectReference(name, sheetName, path, 'script');
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

    // Index object placements from instances on layers and non-world instances
    if (Array.isArray(layout.layers)) {
      for (const layer of layout.layers) {
        if (Array.isArray(layer.instances)) {
          for (const instance of layer.instances) this.addLayoutPlacement(instance?.type, layoutName);
        }
      }
    }
    const nonworld = layout['nonworld-instances'];
    if (Array.isArray(nonworld)) {
      for (const instance of nonworld) this.addLayoutPlacement(instance?.type, layoutName);
    }
  }

  private addLayoutPlacement(type: unknown, layoutName: string): void {
    if (typeof type !== 'string' || type === '') return;
    if (!this.objectToLayouts.has(type)) {
      this.objectToLayouts.set(type, []);
    }
    const layouts = this.objectToLayouts.get(type)!;
    if (!layouts.includes(layoutName)) {
      layouts.push(layoutName);
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

  /**
   * Get unique event sheets that reference a given object
   */
  getEventSheetsForObject(objectName: string): string[] {
    const refs = this.objectToEventSheets.get(objectName) || [];
    return [...new Set(refs.map(r => r.eventSheet))];
  }

  /**
   * True when an object is used by an event (directly, or through one of its
   * families) or has an instance in a layout. Objects for which this is false
   * are the orphaned objects.
   */
  isObjectUsed(objectName: string): boolean {
    if (this.getEventSheetsForObject(objectName).length > 0) return true;
    if ((this.objectToLayouts.get(objectName) ?? []).length > 0) return true;
    return (this.objectToFamilies.get(objectName) ?? []).some(family => this.getEventSheetsForObject(family).length > 0);
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

/** Singleton lazy builder */
let cachedIndex: ProjectIndex | null = null;

export async function getProjectIndex(reader: Construct3ProjectReader): Promise<ProjectIndex> {
  if (cachedIndex && cachedIndex.isBuilt()) return cachedIndex;
  cachedIndex = new ProjectIndex();
  await cachedIndex.build(reader);
  return cachedIndex;
}

/** Reset the cached project index so it rebuilds on next use. */
export function resetProjectIndex(): void {
  cachedIndex = null;
}
