/**
 * Template builders for creating valid Construct 3 JSON structures.
 * Each function produces a minimal, valid entity with proper defaults.
 *
 * Field names and defaults are validated against real C3 project files.
 * Key conventions: C3 uses camelCase for most fields (isGlobal, not is-global).
 */

// ─── Object Templates ──────────────────────────────────────

/** Plugins that use singleglobal-inst (no layout placement) */
export const GLOBAL_PLUGINS = new Set([
  'Audio', 'AJAX', 'Mouse', 'Touch', 'Keyboard', 'Browser',
  'Geolocation', 'NWjs', 'Clipboard', 'Platform Info', 'Arr',
  'Json', 'Dictionary', 'LocalStorage', 'XMLParser', 'Multiplayer',
  'Facebook', 'IAP', 'Greenworks', 'Cryptography', 'Timeline',
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

export function createSpriteObject(name: string, sid: number, animSid: number): Record<string, unknown> {
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
          frames: [
            {
              width: 100,
              height: 100,
              originX: 0.5,
              originY: 0.5,
              originalSource: '',
              exportFormat: 'png',
              exportQuality: 1,
              fileType: 'image/png',
              duration: 1,
              tag: '',
            },
          ],
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

export function createTextObject(name: string, sid: number): Record<string, unknown> {
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

export function createTiledBgObject(name: string, sid: number): Record<string, unknown> {
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
      originX: 0,
      originY: 0,
      originalSource: '',
      exportFormat: 'png',
      exportQuality: 1,
      fileType: 'image/png',
      tag: '',
    },
  };
}

export function createGlobalObject(
  name: string,
  pluginId: string,
  sid: number,
  uid: number,
  sgiSid: number,
): Record<string, unknown> {
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

export function createGenericObject(name: string, pluginId: string, sid: number): Record<string, unknown> {
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
    'fill': 'stretch',
    'enable-collisions': true,
  },
};

// ─── Instance Variable & Behavior Templates ─────────────────

export function createInstanceVariable(
  name: string,
  type: 'number' | 'string' | 'boolean',
  initialValue: string | number,
  sid: number,
): Record<string, unknown> {
  return {
    name,
    type,
    initialValue: String(initialValue),
    comment: '',
    sid,
  };
}

export function createBehavior(
  behaviorId: string,
  name: string,
  sid: number,
): Record<string, unknown> {
  return {
    behaviorId,
    name,
    sid,
  };
}

// ─── Event Sheet Templates ─────────────────────────────────

export function createEmptySheet(name: string, sid: number): Record<string, unknown> {
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
): Record<string, unknown> {
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

export function createGroupEvent(title: string, sid: number): Record<string, unknown> {
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
  params?: Array<{ name: string; type: string }>,
): Record<string, unknown> {
  const functionParameters: Record<string, unknown>[] = [];
  if (params) {
    for (const p of params) {
      functionParameters.push({
        name: p.name,
        type: p.type,
        initialValue: p.type === 'number' ? '0' : p.type === 'boolean' ? 'false' : '',
        comment: '',
        sid: sid + functionParameters.length + 1,
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

export function createIncludeEvent(sheetName: string): Record<string, unknown> {
  return {
    eventType: 'include',
    includeSheet: sheetName,
  };
}

export function createCommentEvent(text: string): Record<string, unknown> {
  return {
    eventType: 'comment',
    text,
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
): Record<string, unknown> {
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

export function createLayer(name: string, sid: number): Record<string, unknown> {
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

export function createInstance(
  objectType: string,
  uid: number,
  sid: number,
  x: number,
  y: number,
  width: number,
  height: number,
  pluginProperties?: Record<string, unknown>,
): Record<string, unknown> {
  // Use provided properties, or look up defaults for known plugins, or empty
  const properties = pluginProperties ?? {};

  return {
    type: objectType,
    properties,
    uid,
    sid,
    tags: '',
    instanceVariables: {},
    behaviors: {},
    instanceFolderItem: {
      sid,
      expanded: true,
    },
    showing: true,
    locked: false,
    world: {
      x,
      y,
      width,
      height,
      originX: 0.5,
      originY: 0.5,
      color: [1, 1, 1, 1],
      angle: 0,
      zElevation: 0,
    },
  };
}
