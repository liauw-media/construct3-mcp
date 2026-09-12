import { describe, it, expect } from 'vitest';
import {
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
  createAnimationFrame,
  createAnimation,
  createLayout,
  createLayer,
  createInstance,
} from '../../src/construct3/templates.js';

describe('Object Templates', () => {
  it('createSpriteObject creates valid Sprite', () => {
    const obj = createSpriteObject('Hero', 100, 200);
    expect(obj.name).toBe('Hero');
    expect(obj['plugin-id']).toBe('Sprite');
    expect(obj.sid).toBe(100);
    expect(obj.isGlobal).toBe(false);
    expect(obj.animations).toBeDefined();
    expect(obj.animations!.items).toHaveLength(1);
    expect(obj.animations!.items[0].sid).toBe(200);
    expect(obj.animations!.items[0].name).toBe('Animation 1');
    expect(obj.animations!.items[0].frames).toHaveLength(1);
    expect(obj.animations!.items[0].frames[0].collisionPoly).toEqual({ points: [] });
    expect(obj.instanceVariables).toEqual([]);
    expect(obj.behaviorTypes).toEqual([]);
    expect(obj.effectTypes).toEqual([]);
  });

  it('createSpriteObject passes through imageSpriteId', () => {
    const obj = createSpriteObject('Hero', 100, 200, 5555555);
    const frame = obj.animations!.items[0].frames[0];
    expect(frame.imageSpriteId).toBe(5555555);
  });

  it('createSpriteObject omits imageSpriteId when not provided', () => {
    const obj = createSpriteObject('Hero', 100, 200);
    const frame = obj.animations!.items[0].frames[0];
    expect(frame.imageSpriteId).toBeUndefined();
  });

  it('createTextObject creates valid Text', () => {
    const obj = createTextObject('Label', 100);
    expect(obj.name).toBe('Label');
    expect(obj['plugin-id']).toBe('Text');
    expect(obj.sid).toBe(100);
    expect(obj.isGlobal).toBe(false);
    expect(obj.animations).toBeUndefined();
  });

  it('createTiledBgObject creates valid TiledBg', () => {
    const obj = createTiledBgObject('Background', 100);
    expect(obj.name).toBe('Background');
    expect(obj['plugin-id']).toBe('TiledBg');
    expect(obj.sid).toBe(100);
    expect((obj as any).image).toBeDefined();
    expect((obj as any).image.width).toBe(100);
    expect((obj as any).image.collisionPoly).toEqual({ points: [] });
  });

  it('createTiledBgObject passes through imageSpriteId', () => {
    const obj = createTiledBgObject('Background', 100, 7777777);
    expect((obj as any).image.imageSpriteId).toBe(7777777);
  });

  it('createGlobalObject creates valid global plugin', () => {
    const obj = createGlobalObject('Audio', 'Audio', 100, 1, 200);
    expect(obj.name).toBe('Audio');
    expect(obj['plugin-id']).toBe('Audio');
    expect(obj.sid).toBe(100);
    expect(obj['singleglobal-inst']).toBeDefined();
    expect(obj['singleglobal-inst']!.uid).toBe(1);
    expect(obj['singleglobal-inst']!.sid).toBe(200);
    expect(obj['singleglobal-inst']!.type).toBe('Audio');
  });

  it('createGenericObject creates valid generic', () => {
    const obj = createGenericObject('MyPlugin', 'CustomPlugin', 100);
    expect(obj.name).toBe('MyPlugin');
    expect(obj['plugin-id']).toBe('CustomPlugin');
    expect(obj.sid).toBe(100);
    expect(obj.isGlobal).toBe(false);
    expect(obj.instanceVariables).toEqual([]);
    expect(obj.behaviorTypes).toEqual([]);
  });
});

describe('Instance Variable & Behavior Templates', () => {
  it('createInstanceVariable creates valid variable', () => {
    const v = createInstanceVariable('health', 'number', 100);
    expect(v.name).toBe('health');
    expect(v.type).toBe('number');
    expect(v.sid).toBe(100);
    expect(v.desc).toBe('');
    expect(v.show).toBe(true);
  });

  it('createBehavior creates valid behavior', () => {
    const b = createBehavior('Platform', 'PlatformBehavior', 100);
    expect(b.behaviorId).toBe('Platform');
    expect(b.name).toBe('PlatformBehavior');
    expect(b.sid).toBe(100);
  });
});

describe('Event Sheet Templates', () => {
  it('createEmptySheet creates valid empty sheet', () => {
    const sheet = createEmptySheet('MainSheet', 100);
    expect(sheet.name).toBe('MainSheet');
    expect(sheet.events).toEqual([]);
    expect(sheet.sid).toBe(100);
  });

  it('createVariableEvent creates valid variable event', () => {
    const ev = createVariableEvent('score', 'number', '0', 100);
    expect(ev.eventType).toBe('variable');
    expect(ev.name).toBe('score');
    expect(ev.type).toBe('number');
    expect(ev.initialValue).toBe('0');
    expect(ev.sid).toBe(100);
    expect(ev.isStatic).toBe(false);
    expect(ev.isConstant).toBe(false);
  });

  it('createGroupEvent creates valid group', () => {
    const ev = createGroupEvent('Movement', 100);
    expect(ev.eventType).toBe('group');
    expect(ev.title).toBe('Movement');
    expect(ev.sid).toBe(100);
    expect(ev.children).toEqual([]);
    expect(ev.isActiveOnStart).toBe(true);
    expect(ev.disabled).toBe(false);
    expect(ev.description).toBe('');
  });

  it('createFunctionEvent creates valid function without params', () => {
    const ev = createFunctionEvent('DoStuff', 100);
    expect(ev.eventType).toBe('function-block');
    expect(ev.functionName).toBe('DoStuff');
    expect(ev.sid).toBe(100);
    expect(ev.functionParameters).toEqual([]);
    expect(ev.conditions).toEqual([]);
    expect(ev.actions).toEqual([]);
    expect(ev.functionReturnType).toBe('none');
    expect(ev.functionIsAsync).toBe(false);
  });

  it('createFunctionEvent creates valid function with params', () => {
    const ev = createFunctionEvent('Add', 100, [
      { name: 'a', type: 'number' },
      { name: 'b', type: 'string' },
    ]);
    expect(ev.functionParameters).toHaveLength(2);
    expect(ev.functionParameters![0].name).toBe('a');
    expect(ev.functionParameters![0].type).toBe('number');
    expect(ev.functionParameters![0].initialValue).toBe('0');
    expect(ev.functionParameters![1].name).toBe('b');
    expect(ev.functionParameters![1].initialValue).toBe('');
  });

  it('createFunctionEvent honours returnType/isAsync/copyPicked options', () => {
    const ev = createFunctionEvent('GetName', 100, undefined, {
      returnType: 'string',
      isAsync: true,
      copyPicked: true,
    });
    expect(ev.functionReturnType).toBe('string');
    expect(ev.functionIsAsync).toBe(true);
    expect(ev.functionCopyPicked).toBe(true);
  });

  it('createIncludeEvent creates valid include', () => {
    const ev = createIncludeEvent('SharedSheet');
    expect(ev.eventType).toBe('include');
    expect(ev.includeSheet).toBe('SharedSheet');
  });

  it('createCommentEvent creates valid comment', () => {
    const ev = createCommentEvent('TODO: Fix this');
    expect(ev.eventType).toBe('comment');
    expect(ev.text).toBe('TODO: Fix this');
  });
});

describe('Block Event Template', () => {
  it('creates basic block event', () => {
    const block = createBlockEvent(
      100,
      [{ id: 'on-start', objectClass: 'System', sid: 200 }],
      [{ id: 'destroy', objectClass: 'Player', sid: 300 }],
    );
    expect(block.eventType).toBe('block');
    expect(block.sid).toBe(100);
    expect(block.conditions).toHaveLength(1);
    expect(block.actions).toHaveLength(1);
    expect(block.children).toEqual([]);
    expect(block.disabled).toBeUndefined();
    expect(block.isElse).toBeUndefined();
  });

  it('creates disabled block', () => {
    const block = createBlockEvent(100, [], [], true);
    expect(block.disabled).toBe(true);
  });

  it('creates else block', () => {
    const block = createBlockEvent(100, [], [], undefined, undefined, true);
    expect(block.isElse).toBe(true);
  });

  it('creates block with children', () => {
    const child = createBlockEvent(200, [{ id: 'x', objectClass: 'System', sid: 300 }], []);
    const block = createBlockEvent(100, [{ id: 'y', objectClass: 'System', sid: 400 }], [], undefined, [child]);
    expect(block.children).toHaveLength(1);
  });
});

describe('Animation Templates', () => {
  it('createAnimationFrame creates valid frame', () => {
    const frame = createAnimationFrame(64, 64);
    expect(frame.width).toBe(64);
    expect(frame.height).toBe(64);
    expect(frame.originX).toBe(0.5);
    expect(frame.originY).toBe(0.5);
    expect(frame.exportFormat).toBe('lossless');
    expect(frame.fileType).toBe('image/png');
    expect(frame.duration).toBe(1);
    expect(frame.useCollisionPoly).toBe(true);
    expect(frame.collisionPoly).toEqual({ points: [] });
  });

  it('createAnimationFrame includes imageSpriteId when provided', () => {
    const frame = createAnimationFrame(64, 64, 1234567);
    expect(frame.imageSpriteId).toBe(1234567);
  });

  it('createAnimationFrame omits imageSpriteId when not provided', () => {
    const frame = createAnimationFrame(64, 64);
    expect(frame.imageSpriteId).toBeUndefined();
  });

  it('createAnimation creates valid animation', () => {
    const frame = createAnimationFrame(100, 100);
    const anim = createAnimation('Walk', 100, 10, true, false, 1, [frame]);
    expect(anim.name).toBe('Walk');
    expect(anim.sid).toBe(100);
    expect(anim.speed).toBe(10);
    expect(anim.isLooping).toBe(true);
    expect(anim.isPingPong).toBe(false);
    expect(anim.repeatCount).toBe(1);
    expect(anim.repeatTo).toBe(0);
    expect(anim.frames).toHaveLength(1);
  });
});

describe('Layout Templates', () => {
  it('createLayout creates valid layout with default layer', () => {
    const layout = createLayout('Level 1', 100, 1920, 1080);
    expect(layout.name).toBe('Level 1');
    expect(layout.sid).toBe(100);
    expect(layout.width).toBe(1920);
    expect(layout.height).toBe(1080);
    expect(layout.layers).toHaveLength(1);
    expect(layout.layers[0].name).toBe('Layer 0');
    expect(layout.layers[0].sid).toBe(101); // sid + 1
    expect(layout['nonworld-instances']).toEqual([]);
    expect(layout.vpX).toBe(0.5);
    expect(layout.vpY).toBe(0.5);
    expect(layout.projection).toBe('perspective');
    expect(layout.eventSheet).toBeUndefined();
  });

  it('createLayout creates layout with custom layers', () => {
    const layout = createLayout('Level 2', 100, 800, 600, 'MainSheet', [
      { name: 'Background', sid: 200 },
      { name: 'Main', sid: 300 },
    ]);
    expect(layout.layers).toHaveLength(2);
    expect(layout.layers[0].name).toBe('Background');
    expect(layout.layers[1].name).toBe('Main');
    expect(layout.eventSheet).toBe('MainSheet');
  });

  it('createLayer creates valid layer', () => {
    const layer = createLayer('Main', 100);
    expect(layer.name).toBe('Main');
    expect(layer.sid).toBe(100);
    expect(layer.instances).toEqual([]);
    expect(layer.isInitiallyVisible).toBe(true);
    expect(layer.isInitiallyInteractive).toBe(true);
    expect(layer.parallaxX).toBe(1);
    expect(layer.parallaxY).toBe(1);
    expect(layer.blendMode).toBe('normal');
    expect(layer.zElevation).toBe(0);
  });

  it('createInstance creates valid instance with world data', () => {
    const inst = createInstance('Player', 1, 100, 500, 300, 64, 64, { 'initially-visible': true });
    expect(inst.type).toBe('Player');
    expect(inst.uid).toBe(1);
    expect(inst.sid).toBe(100);
    expect(inst.tags).toBe('');
    expect(inst.showing).toBe(true);
    expect(inst.locked).toBe(false);
    expect(inst.world).toBeDefined();
    expect(inst.world!.x).toBe(500);
    expect(inst.world!.y).toBe(300);
    expect(inst.world!.width).toBe(64);
    expect(inst.world!.height).toBe(64);
    expect(inst.properties['initially-visible']).toBe(true);
  });

  it('createInstance defaults to empty properties', () => {
    const inst = createInstance('Enemy', 2, 200, 0, 0, 32, 32);
    expect(inst.properties).toEqual({});
  });
});
