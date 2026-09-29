import { describe, it, expect } from 'vitest';
import {
  animationEntries,
  animationsSharingImageFiles,
  countAnimationNameParameters,
  describeAvailableAnimations,
  everyAnimation,
  familiesContaining,
  findAnimation,
  frameImageExtension,
  planFrameImageRenames,
  planFrameImageShift,
  renameInitialAnimation,
  simulateImageRenames,
} from '../../src/construct3/animation-rename.js';

const png = { fileType: 'image/png' };
const jpeg = { fileType: 'image/jpeg' };

describe('frameImageExtension', () => {
  it('is "jpg" for JPEG frames, "png" for PNG frames and frames without fileType, undefined otherwise', () => {
    expect(frameImageExtension('image/jpeg')).toBe('jpg');
    expect(frameImageExtension('image/png')).toBe('png');
    expect(frameImageExtension(undefined)).toBe('png');
    expect(frameImageExtension('image/webp')).toBeUndefined();
  });
});

describe('planFrameImageRenames', () => {
  it('renames every frame file to the lowercase name for the new animation, keeping the extension', () => {
    const files = ['hero-walk-000.png', 'hero-walk-001.jpg', 'hero-walk-002.png', 'hero-idle-000.png', 'other.png'];
    const plan = planFrameImageRenames(files, 'Hero', 'Walk', 'Run Fast', [png, jpeg, {}]);
    expect(plan.renames).toEqual([
      { from: 'hero-walk-000.png', to: 'hero-run fast-000.png' },
      { from: 'hero-walk-001.jpg', to: 'hero-run fast-001.jpg' },
      { from: 'hero-walk-002.png', to: 'hero-run fast-002.png' },
    ]);
    expect(plan.missing).toEqual([]);
    expect(plan.clashes).toEqual([]);
  });

  it('keeps spaces and other characters of the names, lowercased', () => {
    const plan = planFrameImageRenames(['board-sign (en)-000.png'], 'Board', 'Sign (EN)', 'Sign_v2.Alt-B', [png]);
    expect(plan.renames).toEqual([{ from: 'board-sign (en)-000.png', to: 'board-sign_v2.alt-b-000.png' }]);
  });

  it('does not take the files of an animation whose name starts with the old one', () => {
    const files = ['hero-walk-000.png', 'hero-walk left-000.png', 'hero-walk-000.png.bak'];
    const plan = planFrameImageRenames(files, 'Hero', 'Walk', 'Run', [png]);
    expect(plan.renames).toEqual([{ from: 'hero-walk-000.png', to: 'hero-run-000.png' }]);
  });

  it('renames the file the frame\'s fileType points to and leaves another extension alone', () => {
    const files = ['hero-walk-000.jpg', 'hero-walk-000.png', 'hero-walk-001.png', 'hero-walk-001.jpg'];
    const plan = planFrameImageRenames(files, 'Hero', 'Walk', 'Run', [jpeg, png]);
    expect(plan.renames).toEqual([
      { from: 'hero-walk-000.jpg', to: 'hero-run-000.jpg' },
      { from: 'hero-walk-001.png', to: 'hero-run-001.png' },
    ]);
  });

  it('renames the files of a frame in another format with their extension', () => {
    const webp = { fileType: 'image/webp' };
    const plan = planFrameImageRenames(['hero-walk-000.webp'], 'Hero', 'Walk', 'Run', [webp, webp]);
    expect(plan.renames).toEqual([{ from: 'hero-walk-000.webp', to: 'hero-run-000.webp' }]);
    expect(plan.missing).toEqual(['hero-walk-001.*']);
  });

  it('only renames the files of existing frames', () => {
    const plan = planFrameImageRenames(['hero-walk-000.png', 'hero-walk-001.png'], 'Hero', 'Walk', 'Run', [png]);
    expect(plan.renames).toEqual([{ from: 'hero-walk-000.png', to: 'hero-run-000.png' }]);
  });

  it('finds mixed-case files and gives them the lowercase name', () => {
    const plan = planFrameImageRenames(['Hero-Walk-000.PNG'], 'Hero', 'Walk', 'Run', [png]);
    expect(plan.renames).toEqual([{ from: 'Hero-Walk-000.PNG', to: 'hero-run-000.png' }]);
  });

  it('renames nothing when only the case of the animation name changes', () => {
    const plan = planFrameImageRenames(['hero-walk-000.png'], 'Hero', 'Walk', 'WALK', [png]);
    expect(plan).toEqual({ renames: [], missing: [], clashes: [] });
    // ...except a mixed-case file, which gets the lowercase name
    const mixed = planFrameImageRenames(['Hero-Walk-000.png'], 'Hero', 'Walk', 'WALK', [png]);
    expect(mixed.renames).toEqual([{ from: 'Hero-Walk-000.png', to: 'hero-walk-000.png' }]);
    expect(mixed.clashes).toEqual([]);
  });

  it('lists frames without an image file as missing, with the extension of their fileType', () => {
    const plan = planFrameImageRenames(['hero-walk-000.png'], 'Hero', 'Walk', 'Run', [png, jpeg, {}]);
    expect(plan.missing).toEqual(['hero-walk-001.jpg', 'hero-walk-002.png']);
    expect(plan.renames).toHaveLength(1);
  });

  it('reports target names taken by other files, ignoring case', () => {
    const files = ['hero-walk-000.png', 'hero-walk-001.png', 'Hero-Run-001.png'];
    const plan = planFrameImageRenames(files, 'Hero', 'Walk', 'Run', [png, png]);
    expect(plan.clashes).toEqual(['hero-run-001.png']);
  });

  it('reports a clash when two files that differ only in case would get the same name', () => {
    // Possible on a case-sensitive file system
    const plan = planFrameImageRenames(['Hero-Walk-000.png', 'hero-walk-000.png'], 'Hero', 'Walk', 'Run', [png]);
    expect(plan.renames).toEqual([{ from: 'Hero-Walk-000.png', to: 'hero-run-000.png' }]);
    expect(plan.clashes).toEqual(['hero-run-000.png']);
  });
});

describe('planFrameImageShift', () => {
  const gif = { fileType: 'image/gif' };

  it('inserting moves the files from the index on one index up, last first, and names the new frame\'s file', () => {
    const files = ['hero-walk-000.png', 'hero-walk-001.jpg', 'hero-walk-002.gif', 'hero-idle-001.png'];
    const plan = planFrameImageShift(files, 'Hero', 'Walk', [png, jpeg, gif], { insertAt: 1 });
    expect(plan.renames).toEqual([
      { from: 'hero-walk-002.gif', to: 'hero-walk-003.gif' },
      { from: 'hero-walk-001.jpg', to: 'hero-walk-002.jpg' },
    ]);
    expect(plan.shifted).toEqual(plan.renames);
    expect(plan.newFrameFile).toBe('hero-walk-001.png');
    expect(plan).toMatchObject({ parked: [], backedUp: [], missing: [], clashes: [] });
  });

  it('appending moves nothing', () => {
    const plan = planFrameImageShift(['hero-walk-000.png'], 'Hero', 'Walk', [png], { insertAt: 1 });
    expect(plan.renames).toEqual([]);
    expect(plan.newFrameFile).toBe('hero-walk-001.png');
  });

  it('deleting keeps the deleted frame\'s files as .bak, then moves the later ones one index down', () => {
    const files = ['hero-walk-000.png', 'hero-walk-001.png', 'Hero-Walk-002.JPG', 'hero-walk-001.png.bak'];
    const plan = planFrameImageShift(files, 'Hero', 'Walk', [png, png, jpeg], { deleteAt: 1 });
    expect(plan.renames).toEqual([
      { from: 'hero-walk-001.png', to: 'hero-walk-001.png.1.bak' },
      { from: 'Hero-Walk-002.JPG', to: 'hero-walk-001.jpg' },
    ]);
    expect(plan.parked).toEqual([plan.renames[0]]);
    expect(plan.newFrameFile).toBeUndefined();
    expect(plan.clashes).toEqual([]);
  });

  it('renames a file no frame uses out of the way first, instead of replacing it', () => {
    // 002.png was left behind by a deleted frame; 000.png sits next to the JPEG frame's 000.jpg
    const files = ['hero-walk-000.jpg', 'hero-walk-000.png', 'hero-walk-001.png', 'hero-walk-002.png'];
    const plan = planFrameImageShift(files, 'Hero', 'Walk', [jpeg, png], { insertAt: 0 });
    expect(plan.backedUp).toEqual([
      { from: 'hero-walk-002.png', to: 'hero-walk-002.png.bak' },
      { from: 'hero-walk-000.png', to: 'hero-walk-000.png.bak' },
    ]);
    expect(plan.renames).toEqual([
      ...plan.backedUp,
      { from: 'hero-walk-001.png', to: 'hero-walk-002.png' },
      { from: 'hero-walk-000.jpg', to: 'hero-walk-001.jpg' },
    ]);
    expect(plan.clashes).toEqual([]);
    // A leftover under a name no moved image needs stays as it is
    const kept = planFrameImageShift(['hero-walk-000.png', 'hero-walk-001.jpg', 'hero-walk-001.png'], 'Hero', 'Walk', [png], { insertAt: 0 });
    expect(kept.backedUp).toEqual([{ from: 'hero-walk-001.png', to: 'hero-walk-001.png.bak' }]);
    const untouched = planFrameImageShift(['hero-walk-000.png', 'hero-walk-001.jpg'], 'Hero', 'Walk', [png], { insertAt: 0 });
    expect(untouched.backedUp).toEqual([]);
  });

  it('lists frames without a file as missing and moves the others', () => {
    const plan = planFrameImageShift(['hero-walk-002.png'], 'Hero', 'Walk', [png, jpeg, png], { insertAt: 0 });
    expect(plan.missing).toEqual(['hero-walk-001.jpg', 'hero-walk-000.png']);
    expect(plan.renames).toEqual([{ from: 'hero-walk-002.png', to: 'hero-walk-003.png' }]);
  });

  it('reports a clash when two files that differ only in case would get the same name', () => {
    // Possible on a case-sensitive file system
    const plan = planFrameImageShift(['Hero-Walk-000.png', 'hero-walk-000.png'], 'Hero', 'Walk', [png], { insertAt: 0 });
    expect(plan.clashes).toEqual([
      'images/hero-walk-000.png cannot be renamed to images/hero-walk-001.png: images/hero-walk-001.png would be replaced',
    ]);
  });
});

describe('simulateImageRenames', () => {
  it('frees a name once an earlier rename moved its file away', () => {
    const result = simulateImageRenames(['a-000.png', 'a-001.png'], [
      { from: 'a-001.png', to: 'a-002.png' },
      { from: 'a-000.png', to: 'a-001.png' },
    ]);
    expect(result.clashes).toEqual([]);
    expect([...result.present.keys()].sort()).toEqual(['a-001.png', 'a-002.png']);
  });

  it('reports a target taken by a file, ignoring case, or by an earlier rename', () => {
    const result = simulateImageRenames(['a-000.png', 'A-001.png', 'b.png'], [
      { from: 'a-000.png', to: 'a-001.png' },
      { from: 'b.png', to: 'c.png' },
      { from: 'a-000.png', to: 'c.png' },
    ]);
    expect(result.clashes).toEqual([
      { from: 'a-000.png', to: 'a-001.png', occupant: 'A-001.png', renamedThere: false },
      { from: 'a-000.png', to: 'c.png', occupant: 'c.png', renamedThere: true },
    ]);
  });

  it('allows a rename that changes only the case of a name', () => {
    expect(simulateImageRenames(['A-000.png'], [{ from: 'A-000.png', to: 'a-000.png' }]).clashes).toEqual([]);
  });
});

function layoutWith(instances: unknown[], subInstances: unknown[] = [], nonworld: unknown[] = []) {
  return {
    name: 'Level',
    layers: [{ name: 'Main', instances, subLayers: [{ name: 'Sub', instances: subInstances, subLayers: [] }] }],
    'nonworld-instances': nonworld,
  };
}

const sprite = (type: string, animation: string) => ({ type, properties: { 'initial-animation': animation, 'initial-frame': 0 } });

describe('renameInitialAnimation', () => {
  it('counts, and then renames, the instances of the object that start with the old animation', () => {
    const layout = layoutWith(
      [sprite('Hero', 'Walk'), sprite('Hero', 'Idle'), sprite('Enemy', 'Walk'), { type: 'Hero' }],
      [sprite('Hero', 'Walk')],
      [sprite('Hero', 'Walk')],
    );
    expect(renameInitialAnimation(layout, 'Hero', 'Walk')).toBe(3);
    expect(layout.layers[0].instances[0]).toEqual(sprite('Hero', 'Walk'));

    expect(renameInitialAnimation(layout, 'Hero', 'Walk', 'Run')).toBe(3);
    expect(layout.layers[0].instances).toEqual([
      sprite('Hero', 'Run'), sprite('Hero', 'Idle'), sprite('Enemy', 'Walk'), { type: 'Hero' },
    ]);
    expect(layout.layers[0].subLayers[0].instances).toEqual([sprite('Hero', 'Run')]);
    expect(layout['nonworld-instances']).toEqual([sprite('Hero', 'Run')]);
  });

  it('matches the stored name exactly', () => {
    const layout = layoutWith([sprite('Hero', 'walk')]);
    expect(renameInitialAnimation(layout, 'Hero', 'Walk', 'Run')).toBe(0);
    expect(layout.layers[0].instances[0]).toEqual(sprite('Hero', 'walk'));
  });

  it('ignores malformed layouts', () => {
    expect(renameInitialAnimation(null, 'Hero', 'Walk', 'Run')).toBe(0);
    expect(renameInitialAnimation({ layers: [null, { instances: [null, 1] }] }, 'Hero', 'Walk', 'Run')).toBe(0);
  });
});

describe('countAnimationNameParameters', () => {
  it('counts string parameters naming the animation on the object\'s conditions and actions, in sub-events too', () => {
    const sheet = {
      name: 'Game',
      events: [
        {
          eventType: 'block',
          conditions: [{ id: 'is-animation-playing', objectClass: 'Hero', parameters: { animation: '"Walk"' } }],
          actions: [
            { id: 'set-animation', objectClass: 'Hero', parameters: { animation: '"Walk"', from: 'beginning' } },
            { id: 'set-animation', objectClass: 'Enemy', parameters: { animation: '"Walk"', from: 'beginning' } },
            { id: 'set-animation', objectClass: 'Hero', parameters: { animation: 'Hero.AnimationName', from: 'beginning' } },
          ],
          children: [{
            eventType: 'block',
            conditions: [],
            actions: [{ id: 'set-animation', objectClass: 'Hero', parameters: { animation: '"walk"', from: 'beginning' } }],
            children: [{
              eventType: 'block',
              conditions: [],
              actions: [{ id: 'set-animation', objectClass: 'Hero', parameters: { animation: '"Walk"', from: 'current-frame' } }],
            }],
          }],
        },
      ],
    };
    expect(countAnimationNameParameters(sheet, 'Hero', 'Walk')).toBe(3);
    expect(countAnimationNameParameters(sheet, 'Enemy', 'Walk')).toBe(1);
    expect(countAnimationNameParameters(sheet, 'Hero', 'Idle')).toBe(0);
  });

  it('counts the parameters of every given object class (the object and its families)', () => {
    const sheet = {
      events: [{
        eventType: 'block',
        conditions: [{ id: 'is-animation-playing', objectClass: 'Characters', parameters: { animation: '"Walk"' } }],
        actions: [
          { id: 'set-animation', objectClass: 'Hero', parameters: { animation: '"Walk"', from: 'beginning' } },
          { id: 'set-animation', objectClass: 'Props', parameters: { animation: '"Walk"', from: 'beginning' } },
          { id: 'set-animation', objectClass: 'Characters', parameters: { animation: '"Walk" & n', from: 'beginning' } },
        ],
      }],
    };
    expect(countAnimationNameParameters(sheet, ['Hero', 'Characters'], 'Walk')).toBe(2);
    expect(countAnimationNameParameters(sheet, [], 'Walk')).toBe(0);
  });
});

describe('familiesContaining', () => {
  it('lists the families that have the object as a member, in map order', () => {
    const families = new Map<string, unknown>([
      ['Characters', { name: 'Characters', members: ['Hero', 'Enemy'] }],
      ['Props', { name: 'Props', members: ['Crate'] }],
      ['Movers', { name: 'Movers', members: ['Enemy', 'Hero'] }],
      ['Broken', { name: 'Broken' }],
      ['Null', null],
    ]);
    expect(familiesContaining('Hero', families)).toEqual(['Characters', 'Movers']);
    expect(familiesContaining('hero', families)).toEqual([]);
    expect(familiesContaining('Crate', families)).toEqual(['Props']);
  });
});

describe('everyAnimation', () => {
  it('lists the animations at the top level and in animation folders at any depth', () => {
    const animations = {
      items: [{ name: 'Idle' }],
      subfolders: [
        { name: 'Moves', items: [{ name: 'Walk' }, null], subfolders: [{ name: 'Fast', items: [{ name: 'Run' }], subfolders: [] }] },
        { name: 'Empty', items: [], subfolders: [] },
      ],
    };
    expect(everyAnimation(animations).map(a => a.name)).toEqual(['Idle', 'Walk', 'Run']);
    expect(everyAnimation(undefined)).toEqual([]);
  });
});

describe('animationEntries / findAnimation / describeAvailableAnimations', () => {
  const walk = { name: 'Walk' };
  const run = { name: 'Run' };
  const animations = {
    items: [{ name: 'Idle' }],
    subfolders: [
      { name: 'Moves', items: [walk], subfolders: [{ name: 'Fast', items: [run, { name: 'Walk' }], subfolders: [] }] },
    ],
  };

  it('gives each animation with the items list that holds it and its folder path', () => {
    expect(animationEntries(animations).map(e => [e.animation.name, e.folders])).toEqual([
      ['Idle', []], ['Walk', ['Moves']], ['Run', ['Moves', 'Fast']], ['Walk', ['Moves', 'Fast']],
    ]);
    const found = findAnimation(animations, 'Run');
    expect(found?.animation).toBe(run);
    expect(found?.items).toBe(animations.subfolders[0].subfolders[0].items);
  });

  it('finds a name exactly, the first one when it is used twice', () => {
    expect(findAnimation(animations, 'Walk')?.animation).toBe(walk);
    expect(findAnimation(animations, 'walk')).toBeUndefined();
    expect(findAnimation(undefined, 'Walk')).toBeUndefined();
  });

  it('lists animations in folders with their folder path, and adds the note only then', () => {
    expect(describeAvailableAnimations(animations)).toBe('Idle, Moves/Walk, Moves/Fast/Run, Moves/Fast/Walk '
      + '(animations in animation folders are shown with their folder path; pass the animation name alone)');
    expect(describeAvailableAnimations({ items: [{ name: 'Idle' }, { name: 'Jump' }], subfolders: [] })).toBe('Idle, Jump');
  });
});

describe('animationsSharingImageFiles', () => {
  const frames = [{ fileType: 'image/png' }];
  it('finds other animations with frames whose names differ only in case, in any folder', () => {
    const walk = { name: 'Walk', frames };
    const animations = {
      items: [walk, { name: 'Idle', frames }, { name: 'walk', frames }],
      subfolders: [{ name: 'Old', items: [{ name: 'WALK', frames }, { name: 'wAlK', frames: [] }], subfolders: [] }],
    };
    expect(animationsSharingImageFiles(animations, walk)).toEqual(['walk', 'WALK']);
    expect(animationsSharingImageFiles(animations, animations.items[1])).toEqual([]);
  });
});
