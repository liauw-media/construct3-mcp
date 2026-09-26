/**
 * Sample event sheet data for event-outline tests.
 */

/**
 * Synthetic sheet shaped like real C3 JSON (behaviorType key, plus one condition
 * with the legacy "behavior-type" key older versions wrote, callFunction with
 * array parameters, script as string and as array of lines, action comment rows,
 * custom ACE block, event-level script block). Expected editor numbers in comments.
 */
export function nestedSheet() {
  return {
    name: 'es_game',
    sid: 1,
    events: [
      // events[0..2]: not numbered
      { eventType: 'variable', name: 'Score', type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid: 2 },
      { eventType: 'include', includeSheet: 'Common' },
      { eventType: 'comment', text: 'Main logic' },
      // #1
      {
        eventType: 'group', disabled: false, title: 'Movement', description: '', isActiveOnStart: true, sid: 10,
        children: [
          // #2
          {
            eventType: 'block', sid: 11,
            conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 110 }],
            actions: [
              { id: 'set-max-speed', objectClass: 'Player', behaviorType: 'Platform', sid: 111, parameters: { 'max-speed': '300' } },
              { callFunction: 'Spawn', sid: 112, parameters: ['"Enemy"', '3'] },
              { type: 'script', script: 'runtime.globalVars.Score = 0;\nconsole.log("start");' },
            ],
            children: [
              // #3
              {
                eventType: 'block', sid: 12,
                conditions: [{ id: 'is-on-floor', objectClass: 'Player', 'behavior-type': 'Platform', sid: 120, isInverted: true }],
                actions: [],
              },
              // #4
              {
                eventType: 'block', sid: 13,
                conditions: [{ id: 'else', objectClass: 'System', sid: 130 }],
                actions: [{ id: 'destroy', objectClass: 'Enemy', sid: 131 }],
              },
            ],
          },
          { eventType: 'comment', text: 'sub comment' },
          { eventType: 'variable', name: 'speed', type: 'number', initialValue: '5', comment: '', isStatic: true, isConstant: false, sid: 3 },
          // #5
          {
            eventType: 'block', sid: 14, disabled: true, isOrBlock: true,
            conditions: [
              { id: 'key-is-down', objectClass: 'Keyboard', sid: 140, parameters: { key: 37 } },
              { id: 'key-is-down', objectClass: 'Keyboard', sid: 141, parameters: { key: 39 } },
            ],
            actions: [{ id: 'set-x', objectClass: 'Player', sid: 142, disabled: true, parameters: { x: 'Self.X + 1' } }],
          },
          // #6
          {
            eventType: 'group', disabled: false, title: 'Nested', description: '', isActiveOnStart: false, sid: 15,
            children: [
              // #7
              {
                eventType: 'block', sid: 16,
                conditions: [{ id: 'key-is-down', objectClass: 'Keyboard', sid: 160, parameters: { key: 32 } }],
                actions: [{ id: 'simulate-control', objectClass: 'Player', behaviorType: 'Platform', sid: 161, parameters: { control: 'jump' } }],
              },
            ],
          },
        ],
      },
      // #8: function body lives in its own conditions/actions AND in children
      {
        eventType: 'function-block', functionName: 'DoThing', functionDescription: '', functionCategory: '',
        functionReturnType: 'number', functionCopyPicked: false, functionIsAsync: true,
        functionParameters: [{ name: 'a', type: 'number', initialValue: '0', comment: '', sid: 201 }],
        sid: 20,
        // Real function blocks can carry their own conditions (e.g. a for-each loop)
        conditions: [{ id: 'for-each', objectClass: 'System', sid: 203, parameters: { object: 'Enemy' } }],
        actions: [
          { type: 'script', language: 'javascript', script: ['// hi', 'console.log(localVars.a);'] },
          { type: 'comment', text: 'return twice a' },
          { id: 'set-function-return-value', objectClass: 'Functions', sid: 202, parameters: { value: 'a * 2' } },
        ],
        children: [
          // #9
          { eventType: 'block', sid: 21, conditions: [], actions: [{ callFunction: 'Other', sid: 210 }] },
        ],
      },
      // #10
      {
        eventType: 'custom-ace-block', aceType: 'action', aceName: 'jump', objectClass: 'Player',
        functionDescription: '', functionCategory: '', functionReturnType: 'none', functionCopyPicked: false,
        functionIsAsync: false, functionParameters: [], sid: 30,
        conditions: [
          { id: 'is-on-floor', objectClass: 'Player', behaviorType: 'Platform', sid: 300 },
          { id: 'compare-instance-variable', objectClass: 'Player', sid: 301, disabled: true, parameters: { 'instance-variable': 'lives', comparison: 4, value: '0' } },
        ],
        actions: [],
        children: [
          // #11
          { eventType: 'block', sid: 31, conditions: [], actions: [{ customAction: 'land', objectClass: 'Player', sid: 310 }] },
        ],
      },
      // #12: event-level script block (real ones carry no sid)
      { eventType: 'script', script: 'const x = 1;\nruntime.setReturnValue(x);' },
      // #13
      {
        eventType: 'block', sid: 40,
        conditions: [{ id: 'every-tick', objectClass: 'System', sid: 400 }],
        actions: [
          { type: 'comment', text: 'log the frame' },
          { type: 'script', script: 'console.log(runtime.tickCount);' },
          { id: 'add-to-eventvar', objectClass: 'System', sid: 401, parameters: { variable: 'Score', value: '1' } },
        ],
      },
    ],
  };
}

/**
 * Synthetic sheet whose events carry many actions each, so an outline page reaches the
 * size budget long before its event limit (300 blocks x 12 actions render to about 126K
 * characters in one page of 100 events). Mixed in: a variable before every 50th block, a
 * comment before every 40th, and after block 100 a group of 10 heavy blocks with a comment
 * row among them. Variable names and comment texts are unique, so each row can be found.
 */
export function actionHeavyEvents(nEvents = 300, actionsPerEvent = 12): Record<string, unknown>[] {
  let sid = 1;
  const heavyBlock = (): Record<string, unknown> => ({
    eventType: 'block',
    sid: sid++,
    conditions: [{ objectClass: 'Sprite1', id: 'compare-x', sid: sid++, parameters: { comparison: 0, 'x-co-ordinate': 0 } }],
    actions: Array.from({ length: actionsPerEvent }, () => ({
      objectClass: 'System', id: 'set-eventvar-value', sid: sid++,
      parameters: { variable: 'var1', value: `"${'x'.repeat(38)}"` },
    })),
  });
  const events: Record<string, unknown>[] = [];
  for (let n = 0; n < nEvents; n++) {
    if (n % 50 === 0) {
      events.push({
        eventType: 'variable', name: `var${n / 50 + 1}`, type: 'number', initialValue: '0', comment: '',
        isStatic: false, isConstant: false, sid: sid++,
      });
    }
    if (n % 40 === 20) events.push({ eventType: 'comment', text: `note ${n}` });
    events.push(heavyBlock());
    if (n === 99) {
      const children = Array.from({ length: 10 }, heavyBlock);
      children.splice(5, 0, { eventType: 'comment', text: 'note in group' });
      events.push({
        eventType: 'group', disabled: false, title: 'Group1', description: '', isActiveOnStart: true, sid: sid++, children,
      });
    }
  }
  return events;
}

// ─── Real sheet structures with editor-assigned numbers ─────

/** [kind, display number the editor wrote into the export (null = unnumbered), children] */
export type SkeletonNode = [string, number | null, SkeletonNode[]?];

/**
 * Event structure of fodi/construct-3-projects (MIT), FirstPersonShooter1
 * eventSheets/Main.json at commit 4cd3874. Only the shape is kept (event kinds and
 * nesting); the numbers are the display numbers the editor wrote into that project's
 * exported docs/FirstPersonShooter1/data.json, matched by sid (25 of 25).
 */
export const FPS1_MAIN_SKELETON: SkeletonNode[] = [
  ['comment', null], ['comment', null],
  ['variable', null], ['variable', null], ['variable', null], ['variable', null], ['variable', null],
  ['variable', null], ['variable', null], ['comment', null], ['variable', null], ['variable', null],
  ['group', 1, [['comment', null], ['block', 2], ['comment', null], ['block', 3]]],
  ['group', 4, [
    ['comment', null], ['block', 5], ['block', 6], ['comment', null], ['block', 7], ['block', 8],
    ['comment', null], ['block', 9, [['block', 10]]], ['comment', null], ['block', 11], ['comment', null], ['block', 12],
  ]],
  ['group', 13, [
    ['comment', null], ['block', 14], ['comment', null], ['block', 15, [['block', 16]]], ['comment', null],
    ['block', 17, [['block', 18], ['else', 19]]], ['comment', null], ['block', 20], ['comment', null], ['function', 21],
  ]],
  ['group', 22, [['comment', null], ['block', 23], ['comment', null], ['block', 24], ['comment', null], ['function', 25]]],
];

/**
 * Event structure of fodi/construct-3-projects (MIT), FirstPersonShooter2
 * eventSheets/Actions/aPlayer*.json at commit 4cd3874 (custom ACE bodies), numbered
 * as in docs/FirstPersonShooter2/data.json (21 of 21).
 */
export const FPS2_APLAYER_SKELETON: SkeletonNode[] = [
  ['custom-ace', 1], ['custom-ace', 2], ['custom-ace', 3],
  ['custom-ace', 4, [
    ['comment', null], ['variable', null], ['variable', null], ['comment', null], ['variable', null], ['variable', null],
    ['variable', null], ['variable', null], ['comment', null], ['block', 5], ['block', 6], ['comment', null], ['block', 7],
    ['comment', null], ['block', 8], ['comment', null], ['block', 9],
  ]],
  ['custom-ace', 10, [
    ['comment', null], ['comment', null], ['block', 11, [['comment', null], ['block', 12], ['comment', null], ['block', 13]]],
    ['comment', null], ['else', 14], ['comment', null], ['block', 15], ['comment', null], ['block', 16], ['block', 17],
  ]],
  ['custom-ace', 18, [['block', 19], ['else', 20], ['else', 21]]],
];

/** Build real-shaped C3 events from a skeleton; sids count up from 1000. */
export function eventsFromSkeleton(skeleton: SkeletonNode[]): Record<string, unknown>[] {
  let sid = 1000;
  const build = ([kind, , children]: SkeletonNode): Record<string, unknown> => {
    const kids = children ? { children: children.map(build) } : {};
    switch (kind) {
      case 'comment': return { eventType: 'comment', text: 'note' };
      case 'variable': return { eventType: 'variable', name: `v${sid}`, type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid: sid++ };
      case 'group': return { eventType: 'group', disabled: false, title: `G${sid}`, description: '', isActiveOnStart: true, sid: sid++, ...kids };
      case 'function': return {
        eventType: 'function-block', functionName: `f${sid}`, functionDescription: '', functionCategory: '', functionReturnType: 'none',
        functionCopyPicked: false, functionIsAsync: false, functionParameters: [], conditions: [], actions: [], sid: sid++, ...kids,
      };
      case 'custom-ace': return {
        eventType: 'custom-ace-block', aceType: 'action', aceName: `a${sid}`, objectClass: 'Player', functionDescription: '',
        functionCategory: '', functionReturnType: 'none', functionCopyPicked: false, functionIsAsync: false, functionParameters: [],
        conditions: [], actions: [], sid: sid++, ...kids,
      };
      case 'else': return { eventType: 'block', conditions: [{ id: 'else', objectClass: 'System', sid: sid++ }], actions: [], sid: sid++, ...kids };
      default: return { eventType: 'block', conditions: [{ id: 'every-tick', objectClass: 'System', sid: sid++ }], actions: [], sid: sid++, ...kids };
    }
  };
  return skeleton.map(build);
}

/** Expected display numbers of a skeleton in display (pre-order) order. */
export function skeletonNumbers(skeleton: SkeletonNode[]): Array<number | null> {
  const out: Array<number | null> = [];
  const walk = (nodes: SkeletonNode[]) => nodes.forEach(([, n, children]) => { out.push(n); if (children) walk(children); });
  walk(skeleton);
  return out;
}
