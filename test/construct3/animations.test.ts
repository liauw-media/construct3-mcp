/**
 * Tests for reading sprite animations as the editor saves them
 * (`animations` as { items, subfolders } with the frames inside) and the
 * animation frame check of analyze_performance (issue #34). Synthetic data.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MockReader } from '../mocks/mock-reader.js';
import { analyzePerformance } from '../../src/construct3/analyzers/performance.js';
import { listAnimations, countAnimationFrames } from '../../src/construct3/analyzers/animations.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

let sid = 1000;
const frame = () => ({ width: 32, height: 32, originX: 0.5, originY: 0.5, duration: 1, sid: sid++ });
const anim = (name: string, frames: number) => ({
  name, sid: sid++, speed: 5, isLooping: false, isPingPong: false, repeatCount: 1, repeatTo: 0,
  frames: Array.from({ length: frames }, frame),
});
const sprite = (name: string, animations: unknown) =>
  ({ name, 'plugin-id': 'Sprite', sid: sid++, isGlobal: false, animations });

beforeEach(() => {
  resetProjectIndex();
});

describe('listAnimations / countAnimationFrames', () => {
  it('reads the editor shape, animations in nested subfolders included', () => {
    const animations = {
      items: [anim('Idle', 2)],
      subfolders: [
        { name: 'Moves', items: [anim('Walk', 3)], subfolders: [{ name: 'Fast', items: [anim('Run', 4)], subfolders: [] }] },
      ],
    };
    expect(listAnimations(animations).map(a => a.name)).toEqual(['Idle', 'Walk', 'Run']);
    expect(countAnimationFrames(animations)).toEqual({ animations: 3, frames: 9 });
  });

  it('accepts a bare array and tolerates malformed entries', () => {
    expect(countAnimationFrames([anim('A', 2), anim('B', 1)])).toEqual({ animations: 2, frames: 3 });
    expect(countAnimationFrames({ items: [{ name: 'NoFrames' }, null], subfolders: [null, { items: 'x' }] }))
      .toEqual({ animations: 1, frames: 0 });
    expect(countAnimationFrames(undefined)).toEqual({ animations: 0, frames: 0 });
    expect(countAnimationFrames('nope')).toEqual({ animations: 0, frames: 0 });
  });
});

describe('analyze_performance: animation frames', () => {
  it('counts frames of all animations, subfolders included, on the editor shape', async () => {
    const big = sprite('Big', {
      items: [anim('A', 20)],
      subfolders: [{ name: 'More', items: [anim('B', 20)], subfolders: [{ name: 'Deep', items: [anim('C', 20)], subfolders: [] }] }],
    });
    const small = sprite('Small', { items: [anim('A', 30)], subfolders: [{ name: 'More', items: [anim('B', 20)], subfolders: [] }] });
    const r = new MockReader({ objects: new Map([['Big', big], ['Small', small]]) });
    const result = await analyzePerformance(r as never, { detail: 'full' });
    const frameIssues = result.issues.filter(i => i.category === 'memory');
    expect(frameIssues).toEqual([expect.objectContaining({ location: 'Big', message: 'Object has 60 animation frames total' })]);
  });
});
