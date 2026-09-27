/**
 * Template builders for creating valid Construct 3 JSON structures.
 * Each function produces a minimal, valid entity with proper defaults.
 *
 * Field names and defaults are validated against real C3 project files.
 * Key conventions: C3 uses camelCase for most fields (isGlobal, not is-global).
 */

import type {
  ObjectType,
  Layout,
  Layer,
  Instance,
  EventSheet,
  VariableEvent,
  GroupEvent,
  FunctionBlockEvent,
  IncludeEvent,
  CommentEvent,
  BlockEvent,
  Animation,
  AnimationFrame,
  AnimationsContainer,
  InstanceVariable,
  BehaviorType,
  Condition,
  Action,
  C3Event,
} from './types.js';

// ─── Object Templates ──────────────────────────────────────

/** Plugins that use singleglobal-inst (no layout placement) */
export const GLOBAL_PLUGINS = new Set([
  'Audio', 'AJAX', 'Mouse', 'Touch', 'Keyboard', 'Browser',
  'Geolocation', 'NWjs', 'Clipboard', 'PlatformInfo',
  'LocalStorage', 'XMLParser', 'Multiplayer',
  'Facebook', 'IAP', 'Greenworks', 'Cryptography', 'Timeline',
]);

/** Plugins that are isGlobal but NOT singleglobal-inst (placed as nonworld instances) */
export const NONWORLD_GLOBAL_PLUGINS = new Set([
  'Arr', 'Json', 'Dictionary',
]);

/** Names reserved by C3 engine — cannot be used for object types */
export const RESERVED_NAMES = new Set([
  'System', 'system',
]);

/**
 * Known Scirra built-in plugin IDs → English display names.
 * Used to auto-register addons in usedAddons when creating objects.
 */
export const KNOWN_SCIRRA_PLUGINS: Record<string, string> = {
  AJAX: 'AJAX',
  Arr: 'Array',
  Audio: 'Audio',
  Browser: 'Browser',
  Button: 'Button',
  Clipboard: 'Clipboard',
  Cryptography: 'Cryptography',
  Dictionary: 'Dictionary',
  DrawingCanvas: 'Drawing canvas',
  Facebook: 'Facebook',
  FileChooser: 'File chooser',
  Geolocation: 'Geolocation',
  Greenworks: 'Greenworks',
  HTMLElement: 'HTML Element',
  IAP: 'IAP',
  Json: 'JSON',
  Keyboard: 'Keyboard',
  List: 'List',
  LocalStorage: 'Local storage',
  Mouse: 'Mouse',
  Multiplayer: 'Multiplayer',
  NWjs: 'NW.js',
  NinePatch: '9-patch',
  Particles: 'Particles',
  PlatformInfo: 'Platform info',
  ProgressBar: 'Progress bar',
  'Shadow Light': 'Shadow light',
  Sprite: 'Sprite',
  Spritefont2: 'Sprite font',
  Text: 'Text',
  TextBox: 'Text input',
  TiledBg: 'Tiled Background',
  Timeline: 'Timeline controller',
  Touch: 'Touch',
  Video: 'Video',
  XMLParser: 'XML',
  sliderbar: 'Slider bar',
};

/**
 * Known Scirra built-in behavior IDs → English display names.
 * Used to auto-register addons in usedAddons when adding behaviors.
 */
export const KNOWN_SCIRRA_BEHAVIORS: Record<string, string> = {
  '8Direction': '8 Direction',
  Anchor: 'Anchor',
  bound: 'Bound to layout',
  Bullet: 'Bullet',
  Car: 'Car',
  'destroy-outside-layout': 'Destroy outside layout',
  DragDrop: 'Drag & Drop',
  Fade: 'Fade',
  Flash: 'Flash',
  jumpthru: 'Jump-thru',
  LOS: 'Line of sight',
  MoveTo: 'Move to',
  Orbit: 'Orbit',
  Pathfinding: 'Pathfinding',
  Physics: 'Physics',
  Pin: 'Pin',
  Platform: 'Platform',
  Rotate: 'Rotate',
  ScrollTo: 'Scroll to',
  shadowcaster: 'Shadow caster',
  Sin: 'Sine',
  Solid: 'Solid',
  Timer: 'Timer',
  Tween: 'Tween',
  Turret: 'Turret',
  Wrap: 'Wrap',
};

export function createSpriteObject(name: string, sid: number, animSid: number, imageSpriteId?: number): ObjectType {
  return {
    name,
    'plugin-id': 'Sprite',
    isGlobal: false,
    editorNewInstanceIsReplica: true,
    sid,
    instanceVariables: [],
    behaviorTypes: [],
    effectTypes: [],
    animations: {
      items: [
        {
          frames: [createAnimationFrame(100, 100, imageSpriteId)],
          sid: animSid,
          name: 'Animation 1',
          isLooping: false,
          isPingPong: false,
          repeatCount: 1,
          repeatTo: 0,
          speed: 0,
        },
      ],
      subfolders: [],
    },
  };
}

export function createTextObject(name: string, sid: number): ObjectType {
  return {
    name,
    'plugin-id': 'Text',
    isGlobal: false,
    editorNewInstanceIsReplica: true,
    sid,
    instanceVariables: [],
    behaviorTypes: [],
    effectTypes: [],
  };
}

export function createTiledBgObject(name: string, sid: number, imageSpriteId?: number): ObjectType {
  return {
    name,
    'plugin-id': 'TiledBg',
    isGlobal: false,
    editorNewInstanceIsReplica: true,
    sid,
    instanceVariables: [],
    behaviorTypes: [],
    effectTypes: [],
    image: {
      width: 100,
      height: 100,
      originX: 0.5,
      originY: 0.5,
      originalSource: '',
      exportFormat: 'lossless',
      exportQuality: 0.8,
      fileType: 'image/png',
      tag: '',
      useCollisionPoly: true,
      collisionPoly: { points: [] },
      ...(imageSpriteId !== undefined ? { imageSpriteId } : {}),
    },
  };
}

export function createGlobalObject(
  name: string,
  pluginId: string,
  sid: number,
  uid: number,
  sgiSid: number,
): ObjectType {
  return {
    name,
    'plugin-id': pluginId,
    sid,
    'singleglobal-inst': {
      type: name,
      properties: {},
      uid,
      sid: sgiSid,
      tags: '',
    },
  };
}

export function createGenericObject(name: string, pluginId: string, sid: number): ObjectType {
  return {
    name,
    'plugin-id': pluginId,
    isGlobal: false,
    editorNewInstanceIsReplica: true,
    sid,
    instanceVariables: [],
    behaviorTypes: [],
    effectTypes: [],
  };
}

// ─── Default instance properties per plugin ─────────────────

/** Default properties that C3 expects when placing an instance on a layout. */
export const DEFAULT_INSTANCE_PROPERTIES: Record<string, Record<string, unknown>> = {
  Sprite: {
    'initially-visible': true,
    'initial-animation': 'Animation 1',
    'initial-frame': 0,
    'enable-collisions': true,
    'live-preview': false,
  },
  Text: {
    text: '',
    'enable-bbcode': true,
    font: 'Arial',
    size: 24,
    'line-height': 0,
    bold: false,
    italic: false,
    color: [1, 1, 1, 1],
    'horizontal-alignment': 'left',
    'vertical-alignment': 'top',
    wrapping: 'word',
    'text-direction': 'ltr',
    'icon-set': -1,
    'initially-visible': true,
    origin: 'top-left',
    'read-aloud': false,
  },
  TiledBg: {
    'initially-visible': true,
    origin: 'top-left',
    'wrap-horizontal': 'repeat',
    'wrap-vertical': 'repeat',
    'image-offset-x': 0,
    'image-offset-y': 0,
    'image-scale-x': 1,
    'image-scale-y': 1,
    'image-angle': 0,
    'enable-tile-randomization': false,
    'x-random': 1,
    'y-random': 1,
    'angle-random': 1,
    'blend-margin-x': 0.1,
    'blend-margin-y': 0.1,
  },
  NinePatch: {
    'initially-visible': true,
    'left-margin': 10,
    'right-margin': 10,
    'top-margin': 10,
    'bottom-margin': 10,
    edges: 'stretch',
    fill: 'stretch',
    origin: 'top-left',
    seams: 'overlap',
  },
};

// ─── Instance Variable & Behavior Templates ─────────────────

export function createInstanceVariable(
  name: string,
  type: 'number' | 'string' | 'boolean',
  sid: number,
): InstanceVariable {
  return {
    name,
    type,
    desc: '',
    show: true,
    sid,
  };
}

export function createBehavior(
  behaviorId: string,
  name: string,
  sid: number,
): BehaviorType {
  return {
    behaviorId,
    name,
    sid,
  };
}

/**
 * Default instance property values of Scirra's built-in behaviors, keyed by
 * behaviorId, in the order the editor writes them.
 *
 * Source: the property definitions (id + initial value) in the Construct 3
 * r449 editor's behaviors/allEditorBehaviors.js, which editor.construct.net
 * serves publicly. r495.2 only adds properties (Physics collision filter,
 * Rotate rotation-type, Solid use-instance-tags) and changes none of these.
 * Key sets and order match the entries in Scirra's public example projects
 * (github.com/Scirra/Construct-Example-Projects). Behaviors without
 * properties map to {} — the editor writes them as { properties: {} }.
 */
export const BEHAVIOR_INSTANCE_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  Anchor: {
    'left-edge': 'window-left', 'top-edge': 'window-top', 'right-edge': 'none', 'bottom-edge': 'none',
    enabled: true,
  },
  bound: { 'bound-by': 'edge' },
  Bullet: {
    speed: 400, acceleration: 0, gravity: 0, 'bounce-off-solids': false, 'set-angle': true, step: false,
    enabled: true,
  },
  Car: {
    'max-speed': 350, acceleration: 200, deceleration: 300, 'steer-speed': 225, 'drift-recover': 185,
    friction: 0.4, 'turn-while-stopped': false, 'set-angle': true, 'default-controls': true, enabled: true,
  },
  custom: { 'stepping-mode': 'none', 'pixels-per-step': 5, enabled: true },
  destroy: {},
  DragnDrop: { axes: 'both', enabled: true },
  EightDir: {
    'max-speed': 200, acceleration: 600, deceleration: 500, directions: 'dir-8', 'set-angle': 'smooth',
    'allow-sliding': false, 'default-controls': true, enabled: true,
  },
  Fade: {
    'fade-in-time': 0, 'wait-time': 0, 'fade-out-time': 1, destroy: true, enabled: true,
    'live-preview': false,
  },
  Flash: {},
  Follow: {
    mode: 'time', delay: 1, 'max-delay': 1, 'history-rate': 30, 'follow-x': true, 'follow-y': true,
    'follow-z-elevation': false, 'follow-width': false, 'follow-height': false, 'follow-angle': false,
    'follow-opacity': false, 'follow-visibility': false, 'follow-destroyed': true, enabled: true,
  },
  jumpthru: { enabled: true },
  LOS: { obstacles: 'solids', range: 10000, 'cone-of-view': 360, 'use-collision-cells': true },
  MoveTo: {
    'max-speed': 200, acceleration: 600, deceleration: 600, 'rotate-speed': 0, 'set-angle': true,
    'stop-on-solids': false, enabled: true,
  },
  NoSave: {},
  Orbit: {
    speed: 180, acceleration: 0, 'primary-axis': 100, 'secondary-axis': 100, 'offset-angle': 0,
    'match-rotation': true, enabled: true, 'live-preview': false,
  },
  Pathfinding: {
    'cell-size': 30, 'cell-border': -1, obstacles: 'solids', 'max-speed': 200, acceleration: 1000,
    deceleration: 2000, 'rotate-speed': 135, 'rotate-object': true, diagonals: true,
    'direct-movement': 'to-destination', enabled: true,
  },
  Persist: {},
  Physics: {
    immovable: false, 'collision-mask': 'use-collision-polygon', 'prevent-rotation': false, density: 1,
    friction: 0.5, elasticity: 0.2, 'linear-damping': 0, 'angular-damping': 0.01, bullet: false,
    enabled: true,
  },
  Pin: { destroy: false },
  Platform: {
    'max-speed': 330, acceleration: 1500, deceleration: 1500, 'jump-strength': 650, gravity: 1500,
    'max-fall-speed': 1000, 'double-jump': false, 'jump-sustain': 0, 'default-controls': true, enabled: true,
  },
  Rotate: { speed: 180, acceleration: 0, enabled: true, 'live-preview': false },
  scrollto: { enabled: true },
  shadowcaster: { height: 100, tag: '', enabled: true },
  Sin: {
    movement: 'horizontal', wave: 'sine', period: 4, 'period-random': 0, 'period-offset': 0,
    'period-offset-random': 0, magnitude: 50, 'magnitude-random': 0, enabled: true, 'live-preview': false,
  },
  solid: { enabled: true, tags: '' },
  TileMovement: {
    'grid-width': 32, 'grid-height': 32, 'grid-offset-x': 0, 'grid-offset-y': 0, 'speed-x': 100,
    'speed-y': 100, enabled: true, 'default-controls': true, isometric: false,
  },
  Timer: {},
  Turret: {
    range: 300, 'rate-of-fire': 1, rotate: true, 'rotate-speed': 180, 'target-mode': 'first-in-range',
    'predictive-aim': false, 'projectile-speed': 500, 'use-collision-cells': true, enabled: true,
  },
  Tween: { enabled: true },
  wrap: { 'wrap-to': 'layout' },
};

/**
 * The per-instance entry for a behavior, as the editor stores it on layout
 * instances: { properties: {...} } with every property at its default.
 * For a behaviorId without known defaults (third-party addons) the entry is
 * { properties: {} } and `known` is false; the editor fills in the addon's
 * defaults for missing properties when it opens the project.
 */
export function createBehaviorInstanceEntry(behaviorId: string): {
  entry: { properties: Record<string, unknown> };
  known: boolean;
} {
  const defaults = Object.hasOwn(BEHAVIOR_INSTANCE_DEFAULTS, behaviorId)
    ? BEHAVIOR_INSTANCE_DEFAULTS[behaviorId]
    : undefined;
  return { entry: { properties: { ...defaults } }, known: defaults !== undefined };
}

// ─── Event Sheet Templates ─────────────────────────────────

export function createEmptySheet(name: string, sid: number): EventSheet {
  return {
    name,
    events: [],
    sid,
  };
}

export function createVariableEvent(
  varName: string,
  type: 'number' | 'string' | 'boolean',
  initialValue: string,
  sid: number,
): VariableEvent {
  return {
    eventType: 'variable',
    name: varName,
    type,
    initialValue,
    comment: '',
    isStatic: false,
    isConstant: false,
    sid,
  };
}

export function createGroupEvent(title: string, sid: number): GroupEvent {
  return {
    eventType: 'group',
    disabled: false,
    title,
    description: '',
    isActiveOnStart: true,
    children: [],
    sid,
  };
}

export function createFunctionEvent(
  funcName: string,
  sid: number,
  params?: Array<{ name: string; type: string; sid: number }>,
): FunctionBlockEvent {
  const functionParameters: Array<{ name: string; type: string; initialValue: string; comment: string; sid: number }> = [];
  if (params) {
    for (const p of params) {
      functionParameters.push({
        name: p.name,
        type: p.type,
        initialValue: p.type === 'number' ? '0' : p.type === 'boolean' ? 'false' : '',
        comment: '',
        sid: p.sid, // caller must supply a real SID from IdGenerator
      });
    }
  }

  return {
    functionName: funcName,
    functionDescription: '',
    functionCategory: '',
    functionReturnType: 'none',
    functionCopyPicked: false,
    functionIsAsync: false,
    functionParameters,
    eventType: 'function-block',
    conditions: [],
    actions: [],
    sid,
  };
}

export function createIncludeEvent(sheetName: string): IncludeEvent {
  return {
    eventType: 'include',
    includeSheet: sheetName,
  };
}

export function createCommentEvent(text: string): CommentEvent {
  return {
    eventType: 'comment',
    text,
  };
}

// ─── Block Event Template ──────────────────────────────────

/**
 * A block event in the editor's on-disk shape. Key order follows editor-saved
 * sheets: eventType, conditions, actions, sid, disabled, children, isOrBlock.
 * It leaves out false flags and an empty children array, as editor saves
 * almost always do (a few editor-saved blocks carry "children": []; the
 * editor loads both forms).
 * Else is not a block key: it is a System "else" first condition.
 */
export function createBlockEvent(
  sid: number,
  conditions: Condition[],
  actions: Action[],
  options: { disabled?: boolean; children?: C3Event[]; isOrBlock?: boolean } = {},
): BlockEvent {
  return {
    eventType: 'block',
    conditions,
    actions,
    sid,
    ...(options.disabled ? { disabled: true } : {}),
    ...(options.children && options.children.length > 0 ? { children: options.children } : {}),
    ...(options.isOrBlock ? { isOrBlock: true } : {}),
  };
}

// ─── Animation Templates ──────────────────────────────────

export function createAnimationFrame(
  width: number,
  height: number,
  imageSpriteId?: number,
): AnimationFrame {
  return {
    width,
    height,
    originX: 0.5,
    originY: 0.5,
    originalSource: '',
    exportFormat: 'lossless',
    exportQuality: 0.8,
    fileType: 'image/png',
    duration: 1,
    tag: '',
    useCollisionPoly: true,
    collisionPoly: { points: [] },
    ...(imageSpriteId !== undefined ? { imageSpriteId } : {}),
  };
}

export function createAnimation(
  name: string,
  sid: number,
  speed: number,
  isLooping: boolean,
  isPingPong: boolean,
  repeatCount: number,
  frames: AnimationFrame[],
): Animation {
  return {
    frames,
    sid,
    name,
    isLooping,
    isPingPong,
    repeatCount,
    repeatTo: 0,
    speed,
  };
}

// ─── Layout Templates ──────────────────────────────────────

export function createLayout(
  name: string,
  sid: number,
  width: number,
  height: number,
  eventSheet?: string,
  layers?: Array<{ name: string; sid: number }>,
): Layout {
  const layerData = (layers && layers.length > 0)
    ? layers.map(l => createLayer(l.name, l.sid))
    : [createLayer('Layer 0', sid + 1)];

  return {
    name,
    layers: layerData,
    'scene-graphs-folder-root': {
      items: [],
      subfolders: [],
    },
    sid,
    'nonworld-instances': [],
    effectTypes: [],
    width,
    height,
    unboundedScrolling: false,
    vpX: 0.5,
    vpY: 0.5,
    projection: 'perspective',
    ...(eventSheet ? { eventSheet } : {}),
  };
}

export function createLayer(name: string, sid: number): Layer {
  return {
    name,
    overriden: 0,
    subLayers: [],
    instances: [],
    sid,
    effectTypes: [],
    isInitiallyVisible: true,
    isInitiallyInteractive: true,
    isHTMLElementsLayer: false,
    color: [1, 1, 1, 1],
    backgroundColor: [1, 1, 1, 1],
    isTransparent: true,
    parallaxX: 1,
    parallaxY: 1,
    scaleRate: 1,
    forceOwnTexture: false,
    renderingMode: '3d',
    drawOrder: 'z-order',
    useRenderCells: false,
    blendMode: 'normal',
    zElevation: 0,
    global: false,
  };
}

export interface InstanceOverrides {
  angle?: number;
  color?: number[];
  zElevation?: number;
  originX?: number;
  originY?: number;
  instanceVariables?: Record<string, unknown>;
  behaviors?: Record<string, unknown>;
  tags?: string;
  showing?: boolean;
  locked?: boolean;
}

export function createInstance(
  objectType: string,
  uid: number,
  sid: number,
  x: number,
  y: number,
  width: number,
  height: number,
  pluginProperties?: Record<string, unknown>,
  overrides?: InstanceOverrides,
): Instance {
  // Use provided properties, or look up defaults for known plugins, or empty
  const properties = pluginProperties ?? {};

  return {
    type: objectType,
    properties,
    uid,
    sid,
    tags: overrides?.tags ?? '',
    instanceVariables: overrides?.instanceVariables ?? {},
    behaviors: overrides?.behaviors ?? {},
    showing: overrides?.showing ?? true,
    locked: overrides?.locked ?? false,
    world: {
      x,
      y,
      width,
      height,
      originX: overrides?.originX ?? 0.5,
      originY: overrides?.originY ?? 0.5,
      color: overrides?.color ?? [1, 1, 1, 1],
      angle: overrides?.angle ?? 0,
      zElevation: overrides?.zElevation ?? 0,
    },
  };
}
