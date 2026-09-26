/**
 * Unit tests for runtime trap detection (signal pairing and script actions
 * that use function parameters as bare identifiers).
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { MockReader, type MockReaderData } from '../mocks/mock-reader.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { findRuntimeTraps, parseC3StringLiteral, c3ConcatPrefix } from '../../src/construct3/analyzers/runtime-traps.js';

// ─── Event builders (shapes match editor-saved event sheets) ─────

let sidCounter = 500_000_000_000_000;
const nextSid = () => ++sidCounter;

/** C3 string literal as stored in event JSON: hit -> "\"hit\"" */
const lit = (s: string) => `"${s.replace(/"/g, '""')}"`;

const sysAction = (id: string, tag: string) => ({ id, objectClass: 'System', sid: nextSid(), parameters: { tag } });
const signal = (tag: string) => sysAction('signal', tag);
const waitForSignal = (tag: string) => sysAction('wait-for-signal', tag);
const onSignal = (tag: string) => ({ id: 'on-signal', objectClass: 'System', sid: nextSid(), parameters: { tag } });
const script = (source: string | string[], language?: 'javascript' | 'typescript') =>
  ({ type: 'script', ...(language ? { language } : {}), script: source });
const callFunction = (name: string, args: unknown[] = []) => ({ callFunction: name, sid: nextSid(), parameters: args });

function block(conditions: unknown[], actions: unknown[], children?: unknown[]) {
  return { eventType: 'block', conditions, actions, ...(children ? { children } : {}), sid: nextSid() };
}

function fn(name: string, params: string[], actions: unknown[], children?: unknown[]) {
  return {
    functionName: name,
    functionDescription: '',
    functionCategory: '',
    functionReturnType: 'none',
    functionCopyPicked: false,
    functionIsAsync: false,
    functionParameters: params.map(p => ({ name: p, type: 'string', initialValue: '', comment: '', sid: nextSid() })),
    eventType: 'function-block',
    conditions: [],
    actions,
    ...(children ? { children } : {}),
    sid: nextSid(),
  };
}

function readerWith(sheets: Record<string, unknown[]>, extra: Omit<MockReaderData, 'eventSheets'> = {}) {
  const map = new Map<string, Record<string, unknown>>();
  for (const [name, events] of Object.entries(sheets)) {
    map.set(name, { name, events, sid: nextSid() });
  }
  return new MockReader({ ...extra, eventSheets: map }) as any;
}

const onStart = () => ({ id: 'on-start-of-layout', objectClass: 'System', sid: nextSid() });

/** Editor-saved shapes carry `"disabled": true` on actions, conditions and events (toggled with D). */
const disabled = <T extends object>(item: T): T & { disabled: true } => ({ ...item, disabled: true });

function group(title: string, children: unknown[], flags: { disabled?: boolean; isActiveOnStart?: boolean } = {}) {
  return {
    eventType: 'group',
    disabled: flags.disabled ?? false,
    title,
    description: '',
    isActiveOnStart: flags.isActiveOnStart ?? true,
    children,
    sid: nextSid(),
  };
}

/** Real shape (Scirra example project airborne-explorer): a custom action block on an object type. */
function customAction(objectClass: string, aceName: string, params: string[], actions: unknown[]) {
  return {
    aceType: 'action',
    aceName,
    objectClass,
    functionDescription: '',
    functionCategory: '',
    functionReturnType: 'none',
    functionCopyPicked: false,
    functionIsAsync: false,
    functionParameters: params.map(p => ({ name: p, type: 'number', initialValue: '0', comment: '', sid: nextSid() })),
    eventType: 'custom-ace-block',
    conditions: [],
    actions,
    sid: nextSid(),
  };
}

const setEventVar = (value: string) =>
  ({ id: 'set-eventvar-value', objectClass: 'System', sid: nextSid(), parameters: { variable: 'v', value } });

// ─── parseC3StringLiteral ───────────────────────────────────

describe('parseC3StringLiteral', () => {
  it('parses a stored C3 string literal', () => {
    expect(parseC3StringLiteral('"hit"')).toBe('hit');
    expect(parseC3StringLiteral('  "loading complete"  ')).toBe('loading complete');
    expect(parseC3StringLiteral('""')).toBe('');
  });

  it('unescapes doubled quotes (the only escape C3 strings have)', () => {
    expect(parseC3StringLiteral('"say ""hi"""')).toBe('say "hi"');
  });

  it('keeps backslashes as literal characters', () => {
    expect(parseC3StringLiteral('"a\\b"')).toBe('a\\b');
  });

  it('returns null for anything but a single literal', () => {
    expect(parseC3StringLiteral('"step" & n')).toBeNull();
    expect(parseC3StringLiteral('tagVar')).toBeNull();
    expect(parseC3StringLiteral('"unterminated')).toBeNull();
    expect(parseC3StringLiteral('5')).toBeNull();
    expect(parseC3StringLiteral(undefined)).toBeNull();
  });
});

describe('c3ConcatPrefix', () => {
  it('returns the leading literal of a string concatenation', () => {
    expect(c3ConcatPrefix('"button_"&Button.type')).toBe('button_');
    expect(c3ConcatPrefix('"step" & (n + 1)')).toBe('step');
    expect(c3ConcatPrefix('"say ""hi""_" & name')).toBe('say "hi"_');
  });

  it('returns null when the value does not have to start with the literal', () => {
    expect(c3ConcatPrefix('tagVar')).toBeNull();
    expect(c3ConcatPrefix('name & "_done"')).toBeNull();
    expect(c3ConcatPrefix('"" & name')).toBeNull();
    expect(c3ConcatPrefix('"hit"')).toBeNull();
    expect(c3ConcatPrefix('"a" & n = 1 ? "x" : "y"')).toBeNull();
    expect(c3ConcatPrefix('"a" + n')).toBeNull();
  });

  it('ignores operators inside later string literals', () => {
    expect(c3ConcatPrefix('"lvl_" & n & "?"')).toBe('lvl_');
  });
});

// ─── Signal pairing ─────────────────────────────────────────

describe('findRuntimeTraps: signal pairing', () => {
  it('warns about a wait whose tag is never signalled', async () => {
    const reader = readerWith({
      Main: [block([onStart()], [waitForSignal(lit('hit'))])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.summary.warning).toBe(1);
    const issue = result.issues[0];
    expect(issue.check).toBe('signal-pairing');
    expect(issue.severity).toBe('warning');
    expect(issue.tag).toBe('hit');
    expect(issue.location).toBe('Main > block > action:0');
    expect(issue.message).toContain('can never finish');
    expect(issue.related).toHaveLength(1);
  });

  it('matches emitters and waits across event sheets', async () => {
    const reader = readerWith({
      Main: [block([onStart()], [waitForSignal(lit('hit'))])],
      Enemy: [block([], [signal(lit('hit'))])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toEqual([]);
    expect(result.summary.signalTags).toBe(1);
  });

  it('matches tags case-insensitively', async () => {
    const reader = readerWith({
      Main: [block([], [signal(lit('HIT')), waitForSignal(lit('hit'))])],
    });
    const result = await findRuntimeTraps(reader);
    // Paired; only the ordering check notes that the Signal runs before the wait starts
    expect(result.issues.map(i => [i.check, i.tag])).toEqual([['signal-order', 'hit']]);
  });

  it('parses tags with doubled quotes', async () => {
    const reader = readerWith({
      Main: [block([], [signal(lit('say "hi"'))]), block([], [waitForSignal(lit('say "hi"'))])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toEqual([]);
  });

  it('counts runtime.signal() in a string-form script as an emitter', async () => {
    const reader = readerWith({
      Main: [block([], [script('runtime.signal("hit");'), waitForSignal(lit('hit'))])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toEqual([]);
    expect(result.summary.scriptsScanned).toBe(1);
  });

  it('counts runtime.signal() in an array-form script as an emitter', async () => {
    const reader = readerWith({
      Main: [block([], [
        script(['if (done) {', '  runtime.signal("hit");', '}'], 'javascript'),
        waitForSignal(lit('hit')),
      ])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toEqual([]);
  });

  it('does not count a commented-out runtime.signal()', async () => {
    const reader = readerWith({
      Main: [block([], [script('// runtime.signal("hit");'), waitForSignal(lit('hit'))])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.summary.warning).toBe(1);
  });

  it('counts runtime.signal() through x.runtime, a local alias or a computed name as an emitter', async () => {
    const reader = readerWith({
      Main: [block([], [
        script('inst.runtime.signal("a");\nconst r = runtime;\nr.signal("b");\nruntime["signal"]("c");'),
        waitForSignal(lit('a')),
        waitForSignal(lit('b')),
        waitForSignal(lit('c')),
      ])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toEqual([]);
  });

  it('does not count a per-instance inst.signal() as a System signal', async () => {
    const reader = readerWith({
      Main: [block([], [script('inst.signal("hit");'), waitForSignal(lit('hit'))])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.summary.warning).toBe(1);
  });

  it('treats runtime.waitForSignal() as a wait', async () => {
    const reader = readerWith({
      Main: [block([], [script('await runtime.waitForSignal("ready");')])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues[0].severity).toBe('warning');
    expect(result.issues[0].tag).toBe('ready');
    expect(result.issues[0].location).toContain('script line 1');
  });

  it('reports a signal nobody waits for or listens to as info', async () => {
    const reader = readerWith({
      Main: [block([], [signal(lit('orphan'))])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.summary).toMatchObject({ warning: 0, info: 1 });
    expect(result.issues[0].message).toContain('nothing waits for it');
  });

  it('accepts an On signal listener as a consumer', async () => {
    const reader = readerWith({
      Main: [
        block([], [signal(lit('go'))]),
        block([onSignal(lit('go'))], []),
      ],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toEqual([]);
  });

  it('reports an On signal trigger that nothing raises as info', async () => {
    const reader = readerWith({
      Main: [block([onSignal(lit('never'))], [])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.summary).toMatchObject({ warning: 0, info: 1 });
    expect(result.issues[0].location).toBe('Main > block > condition:0');
  });

  it('reports non-literal tags as not statically analyzable', async () => {
    const reader = readerWith({
      Main: [block([], [waitForSignal('"step" & stepIndex')])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ severity: 'info', tag: null });
    expect(result.issues[0].message).toContain('cannot be analyzed statically');
  });

  it('downgrades an unmatched wait to info when non-literal signals exist', async () => {
    const reader = readerWith({
      Main: [block([], [waitForSignal(lit('step1')), signal('"step" & n')])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.summary.warning).toBe(0);
    const wait = result.issues.find(i => i.tag === 'step1')!;
    expect(wait.severity).toBe('info');
    expect(wait.related!.some(r => r.includes('[Signal]'))).toBe(true);
  });

  it('resolves a tag forwarded through a function parameter via call sites', async () => {
    const reader = readerWith({
      Main: [
        fn('EmitSignal', ['tag'], [signal('tag')]),
        block([onStart()], [callFunction('EmitSignal', [lit('hit')]), waitForSignal(lit('hit'))]),
      ],
    });
    const result = await findRuntimeTraps(reader, { detail: 'full' });
    // Paired; the call raises the signal before the wait starts, which the ordering check reports
    expect(result.issues.map(i => [i.check, i.tag])).toEqual([['signal-order', 'hit']]);
    const hit = result.signals!.find(s => s.tag === 'hit')!;
    expect(hit.emitters[0]).toContain('via EmitSignal()');
  });

  it('resolves a forwarded tag called from a script with a literal argument', async () => {
    const reader = readerWith({
      Main: [
        fn('EmitSignal', ['other', 'tag'], [signal('tag')]),
        block([], [script('runtime.callFunction("EmitSignal", 0, "hit");'), waitForSignal(lit('hit'))]),
      ],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toEqual([]);
  });

  it('keeps a forwarded tag dynamic when a call site passes a non-literal', async () => {
    const reader = readerWith({
      Main: [
        fn('EmitSignal', ['tag'], [signal('tag')]),
        block([], [callFunction('EmitSignal', ['someVar'])]),
      ],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain('not a string literal (tag)');
  });

  it('ignores signal-like ids on non-System objects', async () => {
    const reader = readerWith({
      Main: [block([], [{ id: 'wait-for-signal', objectClass: 'MyPlugin', sid: nextSid(), parameters: { tag: lit('x') } }])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toEqual([]);
    expect(result.summary.signalTags).toBe(0);
  });

  it('finds signals nested in groups, sub-events and function bodies', async () => {
    const reader = readerWith({
      Main: [{
        eventType: 'group', title: 'Battle', isActiveOnStart: true, disabled: false, sid: nextSid(),
        children: [block([], [], [fn('Attack', [], [], [block([], [waitForSignal(lit('swing'))])])])],
      }],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues[0].location).toBe('Main > group:Battle > block > function:Attack > block > action:0');
  });

  it('limits reported issues to the requested event sheet but pairs across all sheets', async () => {
    const reader = readerWith({
      Main: [block([], [waitForSignal(lit('a')), waitForSignal(lit('b'))])],
      Other: [block([], [waitForSignal(lit('c')), signal(lit('a'))])],
    });
    const result = await findRuntimeTraps(reader, { eventsheet: 'Main' });
    expect(result.issues.map(i => i.tag)).toEqual(['b']);
  });

  it('throws for an unknown event sheet', async () => {
    const reader = readerWith({ Main: [] });
    await expect(findRuntimeTraps(reader, { eventsheet: 'Nope' })).rejects.toThrow('Event sheet "Nope" not found');
  });

  it('includes the signal map only with detail "full" and caps summary output', async () => {
    const waits = Array.from({ length: 25 }, (_, i) => waitForSignal(lit(`t${i}`)));
    const reader = readerWith({ Main: [block([], waits)] });
    const standard = await findRuntimeTraps(reader);
    expect(standard.signals).toBeUndefined();
    expect(standard.issues).toHaveLength(25);
    expect(standard.issues[0].suggestion).toBeDefined();
    const summary = await findRuntimeTraps(reader, { detail: 'summary' });
    expect(summary.issues).toHaveLength(10);
    expect(summary.issues[0].suggestion).toBeUndefined();
    expect(summary.summary.warning).toBe(25);
    expect(summary.notes.some(n => n.includes('Showing the first 10 of 25 issues'))).toBe(true);
    const full = await findRuntimeTraps(reader, { detail: 'full' });
    expect(full.signals).toHaveLength(25);
  });

  it('caps related locations (3 in summary, 10 otherwise) with a count of the rest', async () => {
    const waits = Array.from({ length: 15 }, () => waitForSignal(lit('same')));
    const reader = readerWith({ Main: [block([], waits)] });
    const standard = await findRuntimeTraps(reader);
    expect(standard.issues[0].related).toHaveLength(11);
    expect(standard.issues[0].related![10]).toBe('... and 5 more');
    expect(standard.issues[0].message).toContain('15 wait(s) affected');
    const summary = await findRuntimeTraps(reader, { detail: 'summary' });
    expect(summary.issues[0].related).toHaveLength(4);
    expect(summary.issues[0].related![3]).toBe('... and 12 more');
  });

  it('reports unmatched waits as info when an event sheet could not be read', async () => {
    const reader = readerWith({ Main: [block([], [waitForSignal(lit('hit'))])] });
    // The project lists a sheet the reader could not parse (readAllEventSheets skips it)
    reader.listEventSheets = async () => ['Main', 'Broken'];
    const result = await findRuntimeTraps(reader);
    expect(result.summary.warning).toBe(0);
    expect(result.issues[0]).toMatchObject({ severity: 'info', tag: 'hit' });
    expect(result.issues[0].message).toContain('1 sheet(s) could not be read');
    expect(result.notes.some(n => n.includes('could not be read') && n.includes('Broken'))).toBe(true);
  });
});

// ─── Non-literal tags with a literal prefix ─────────────────

describe('findRuntimeTraps: non-literal tags', () => {
  it('treats On signal listeners matching a "prefix" & X signal as raised (dispatch pattern)', async () => {
    const reader = readerWith({
      Menus: [block([], [signal('"button_"&Button.type')])],
      Main: [
        block([onSignal(lit('button_ok'))], []),
        block([onSignal(lit('Button_Cancel'))], []),
      ],
    });
    const result = await findRuntimeTraps(reader);
    // Only the "cannot be analyzed statically" note for the dynamic Signal itself
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].tag).toBeNull();
    expect(result.issues[0].message).toContain('Its values start with "button_"');
  });

  it('still reports listeners the prefix cannot produce', async () => {
    const reader = readerWith({
      Main: [block([], [signal('"button_"&Button.type')]), block([onSignal(lit('menu_open'))], [])],
    });
    const result = await findRuntimeTraps(reader);
    const listener = result.issues.find(i => i.tag === 'menu_open')!;
    expect(listener.message).toContain('never fires');
  });

  it('words listeners as "may be raised" when a signal tag can be anything', async () => {
    const reader = readerWith({
      Main: [block([], [signal('tagVar')]), block([onSignal(lit('go'))], [])],
    });
    const result = await findRuntimeTraps(reader);
    const listener = result.issues.find(i => i.tag === 'go')!;
    expect(listener.severity).toBe('info');
    expect(listener.message).toContain('may be raised by one of the 1 signal(s)');
    expect(listener.message).not.toContain('never fires');
  });

  it('keeps a "can never finish" warning when the only non-literal signal has an unrelated prefix', async () => {
    const reader = readerWith({
      Main: [block([], [signal('"button_"&Button.type'), waitForSignal(lit('bossDone'))])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.summary.warning).toBe(1);
    expect(result.issues[0].tag).toBe('bossDone');
  });

  it('downgrades a wait whose tag a non-literal signal may produce, listing that signal', async () => {
    const reader = readerWith({
      Main: [block([], [signal('"step" & n'), signal('"button_" & b'), waitForSignal(lit('Step2'))])],
    });
    const result = await findRuntimeTraps(reader);
    const wait = result.issues.find(i => i.tag === 'Step2')!;
    expect(wait.severity).toBe('info');
    expect(wait.message).toContain('one of the 1 signal(s)');
    expect(wait.related!.filter(r => r.includes('[Signal]'))).toHaveLength(1);
  });

  it('uses the "prefix" + x form of runtime.signal() in scripts', async () => {
    const reader = readerWith({
      Main: [block([], [script('runtime.signal("step" + n);'), waitForSignal(lit('step3'))])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.summary.warning).toBe(0);
    expect(result.issues.find(i => i.tag === null)!.message).toContain('Its values start with "step"');
  });

  it('does not report a signal a prefixed non-literal wait may consume', async () => {
    const reader = readerWith({
      Main: [block([], [signal(lit('step1')), waitForSignal('"step" & n')])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues.map(i => i.tag)).toEqual([null]);
  });
});

// ─── Disabled events, conditions and actions ────────────────

describe('findRuntimeTraps: disabled items', () => {
  it('ignores a disabled Wait for signal', async () => {
    // Shape from an editor-saved sheet (ai-scott/AdventureLand eTitleScreen.json)
    const reader = readerWith({ Main: [block([onStart()], [disabled(waitForSignal(lit('LayoutChange')))])] });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toEqual([]);
    expect(result.summary.signalTags).toBe(0);
  });

  it('does not count a disabled Signal as an emitter', async () => {
    const reader = readerWith({ Main: [block([], [disabled(signal(lit('go'))), waitForSignal(lit('go'))])] });
    const result = await findRuntimeTraps(reader);
    expect(result.summary.warning).toBe(1);
    expect(result.issues[0].message).toContain('Wait for signal "go" can never finish');
  });

  it('skips disabled events and everything under them', async () => {
    const reader = readerWith({
      Main: [
        disabled(block([], [signal(lit('a'))])),
        group('Debug', [block([], [signal(lit('b'))])], { disabled: true }),
        block([], [waitForSignal(lit('a')), waitForSignal(lit('b'))]),
      ],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues.map(i => [i.severity, i.tag])).toEqual([['warning', 'a'], ['warning', 'b']]);
  });

  it('keeps groups that are only inactive on start (they can be activated at runtime)', async () => {
    const reader = readerWith({
      Main: [
        group('Later', [block([], [signal(lit('go'))])], { isActiveOnStart: false }),
        block([], [waitForSignal(lit('go'))]),
      ],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toEqual([]);
  });

  it('does not count a disabled On signal condition as a listener', async () => {
    const reader = readerWith({ Main: [block([], [signal(lit('go'))]), block([disabled(onSignal(lit('go')))], [])] });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain('nothing waits for it or listens to it');
  });

  it('does not check disabled script actions or disabled function blocks', async () => {
    const reader = readerWith({
      Main: [
        fn('A', ['mode'], [disabled(script('log(mode);'))]),
        disabled(fn('B', ['mode'], [script('log(mode);')])),
      ],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toEqual([]);
    expect(result.summary.scriptsScanned).toBe(0);
  });
});

// ─── Function call sites ────────────────────────────────────

describe('findRuntimeTraps: forwarded tags and function call sites', () => {
  it('resolves Functions.Name(...) calls in expressions', async () => {
    const reader = readerWith({
      Main: [
        fn('Emit', ['tag'], [signal('tag')]),
        block([], [callFunction('Emit', [lit('a')]), setEventVar('Functions.Emit("b")'), waitForSignal(lit('b'))]),
      ],
    });
    const result = await findRuntimeTraps(reader, { detail: 'full' });
    expect(result.summary.warning).toBe(0);
    expect(result.signals!.find(s => s.tag === 'b')!.emitters[0]).toContain('via Emit()');
  });

  it('finds calls nested in other call arguments and conditions', async () => {
    const reader = readerWith({
      Main: [
        fn('Emit', ['x', 'tag'], [signal('tag')]),
        block([{ id: 'compare-two-values', objectClass: 'System', sid: nextSid(), parameters: {
          'first-value': 'max(1, functions.emit(2, "b"))', comparison: 0, 'second-value': '1' } }], [waitForSignal(lit('b'))]),
      ],
    });
    const result = await findRuntimeTraps(reader);
    // Paired; the condition runs Emit before the wait starts
    expect(result.issues.map(i => [i.check, i.tag])).toEqual([['signal-order', 'b']]);
  });

  it('keeps the tag dynamic when an expression call passes a non-literal', async () => {
    const reader = readerWith({
      Main: [
        fn('Emit', ['tag'], [signal('tag')]),
        block([], [callFunction('Emit', [lit('a')]), setEventVar('Functions.Emit(name)'), waitForSignal(lit('b'))]),
      ],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.summary.warning).toBe(0);
    expect(result.issues.find(i => i.tag === 'b')!.severity).toBe('info');
  });

  it('matches function names case-insensitively (runtime.callFunction and events)', async () => {
    const reader = readerWith({
      Main: [
        fn('EmitSignal', ['tag'], [signal('tag')]),
        block([], [
          callFunction('emitsignal', [lit('other')]),
          script('runtime.callFunction("emitSignal", "hit");'),
          waitForSignal(lit('hit')),
          waitForSignal(lit('other')),
        ]),
      ],
    });
    const result = await findRuntimeTraps(reader);
    // Both paired; the event call raises "other" before its wait (scripts are not followed for ordering)
    expect(result.issues.map(i => [i.check, i.tag])).toEqual([['signal-order', 'other']]);
  });

  it('uses a renamed Functions object from the project file', async () => {
    const reader = readerWith({
      Main: [
        fn('Emit', ['tag'], [signal('tag')]),
        block([], [callFunction('Emit', [lit('a')]), setEventVar('Fn.Emit("b")'), waitForSignal(lit('b')), waitForSignal(lit('a'))]),
      ],
    });
    const project = reader.getProject();
    reader.getProject = () => ({ ...project, functionsName: 'Fn' });
    const result = await findRuntimeTraps(reader);
    // Both paired; both calls run before the waits
    expect(result.issues.map(i => [i.check, i.tag])).toEqual([['signal-order', 'b'], ['signal-order', 'a']]);
    expect(result.issues[0].related![0]).toContain('[Fn.Emit()]');
  });
});

// ─── Script actions using function parameters ───────────────

describe('findRuntimeTraps: script actions using function parameters', () => {
  it('warns about a parameter used as a bare identifier (string script)', async () => {
    const func = fn('PlaySound', ['mode', 'sound'], [script('console.log("playing", sound);')]);
    const reader = readerWith({ Main: [func] });
    const result = await findRuntimeTraps(reader);
    expect(result.summary.warning).toBe(1);
    const issue = result.issues[0];
    expect(issue.check).toBe('script-function-parameter');
    expect(issue.location).toBe('Main > function:PlaySound > action:0');
    expect(issue.eventSid).toBe(func.sid);
    expect(issue.message).toContain('"sound"');
    expect(issue.suggestion).toContain('localVars.sound');
  });

  it('warns for array-form scripts and reports line numbers', async () => {
    const reader = readerWith({
      Main: [fn('SetMode', ['mode'], [script(['const a = 1;', 'if (mode === 2) {}'], 'javascript')])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues[0].message).toContain('script line 2');
  });

  it('checks scripts in sub-events of a function', async () => {
    const reader = readerWith({
      Main: [fn('SetMode', ['mode'], [], [block([], [], [block([], [script('log(mode);')])])])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues[0].location).toBe('Main > function:SetMode > block > block > action:0');
  });

  it('accepts localVars, property access, strings and comments', async () => {
    const source = [
      'const m = localVars.mode;',
      'runtime.globalVars.mode = m;',
      'console.log("mode", `mode`); // mode',
      'const o = { mode: m };',
    ].join('\n');
    const reader = readerWith({ Main: [fn('SetMode', ['mode'], [script(source)])] });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toEqual([]);
  });

  it('accepts names the script declares itself', async () => {
    const reader = readerWith({
      Main: [fn('SetMode', ['mode'], [script('let mode = localVars.mode * 2;\nconsole.log(mode);')])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toEqual([]);
  });

  it('still warns when only a helper function in the script has a parameter of that name', async () => {
    const reader = readerWith({
      Main: [fn('SetMode', ['mode'], [script('function apply(mode) { return mode * 2; }\napply(mode);')])],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.summary.warning).toBe(1);
    expect(result.issues[0].message).toContain('"mode"');
    expect(result.issues[0].message).toContain('script line 2)');
  });

  it('ignores scripts outside any function', async () => {
    const reader = readerWith({
      Main: [
        fn('SetMode', ['mode'], []),
        block([onStart()], [script('console.log(mode);')]),
      ],
    });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toEqual([]);
  });

  it('accepts a TypeScript script that reuses parameter names as its own bindings', async () => {
    const source = [
      'type DataType = readonly string[] | Record<string, string>;',
      'const getData = (listType: string, index?: string): DataType => {',
      '  if (!index) return [];',
      '  const [year, month] = index.split("-").map(Number);',
      '  return [String(year), String(month)];',
      '};',
      'const data: DataType = getData(localVars.type, localVars.index);',
    ];
    const reader = readerWith({ Main: [fn('updateDropdown', ['type', 'index'], [script(source, 'typescript')])] });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toEqual([]);
  });

  it('checks scripts in custom action blocks (eventType "custom-ace-block")', async () => {
    const custom = customAction('Player', 'Hurt', ['amount'], [script('runtime.globalVars.hp -= amount;')]);
    const reader = readerWith({ Main: [custom] });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].location).toBe('Main > custom-action:Player.Hurt > action:0');
    expect(result.issues[0].message).toContain('Script in custom action "Player.Hurt" uses parameter "amount"');
  });

  it('treats names from the Imports for events script as in scope', async () => {
    const importsJs = {
      path: 'importsForEvents.js',
      purpose: 'imports-for-events',
      source: 'import * as Utils from "./utilities.js";\nimport { clamp, lerp as mix } from "./math.js";',
    };
    const funcs = [
      fn('A', ['Utils'], [script(['Utils.log(localVars.Utils);'], 'javascript')]),
      fn('B', ['mix'], [script('mix(1, 2);')]), // no language key: both import files apply
    ];
    const withImports = readerWith({ Main: funcs }, { scriptFiles: [importsJs] });
    expect((await findRuntimeTraps(withImports)).issues).toEqual([]);

    const without = readerWith({ Main: funcs });
    expect((await findRuntimeTraps(without)).issues.map(i => i.message)).toEqual([
      expect.stringContaining('uses parameter "Utils"'),
      expect.stringContaining('uses parameter "mix"'),
    ]);
  });

  it('applies Imports for events per language', async () => {
    const importsTs = {
      path: 'lib/importsForEvents.ts',
      purpose: 'imports-for-events',
      source: 'import * as Api from "./api.js";\nexport const VERSION = 2;',
    };
    const reader = readerWith({
      Main: [
        fn('Ts', ['Api', 'VERSION'], [script(['Api.go(VERSION);'], 'typescript')]),
        fn('Js', ['Api'], [script(['Api.go();'], 'javascript')]),
      ],
    }, { scriptFiles: [importsTs] });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].location).toBe('Main > function:Js > action:0');
  });

  it('notes an Imports for events script it cannot read', async () => {
    const reader = readerWith({ Main: [] }, {
      scriptFiles: [{ path: 'importsForEvents.js', purpose: 'imports-for-events', source: '' }],
    });
    reader.readScriptFile = async () => { throw new Error('ENOENT'); };
    const result = await findRuntimeTraps(reader);
    expect(result.notes.some(n => n.includes('"importsForEvents.js" could not be read'))).toBe(true);
  });

  it('only checks scripts in the filtered event sheet', async () => {
    const reader = readerWith({
      Main: [fn('A', ['mode'], [script('log(mode);')])],
      Other: [fn('B', ['mode'], [script('log(mode);')])],
    });
    const result = await findRuntimeTraps(reader, { eventsheet: 'Other' });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].location).toContain('Other > function:B');
  });
});

// ─── Signal order ───────────────────────────────────────────

const wait = (seconds = '0.1') => ({ id: 'wait', objectClass: 'System', sid: nextSid(), parameters: { seconds } });
const waitForPrevious = () => ({ id: 'wait-for-previous-actions', objectClass: 'System', sid: nextSid() });
const compareVar = (value: string) => ({
  id: 'compare-two-values', objectClass: 'System', sid: nextSid(),
  parameters: { 'first-value': 'Var1', comparison: 0, 'second-value': value },
});
const orderIssues = (result: { issues: Array<{ check: string }> }) => result.issues.filter(i => i.check === 'signal-order');

describe('findRuntimeTraps: signal order (wait starts after its tag was raised)', () => {
  it('reports a wait after a call whose last sub-event signals, after sub-events that wait', async () => {
    const signalling = block([], [signal(lit('tag1'))]);
    const fn1 = fn('Fn1', [], [], [block([], [callFunction('Fn2'), waitForSignal(lit('tag2')), wait()]), signalling]);
    const fn2 = fn('Fn2', [], [wait(), signal(lit('tag2'))]);
    const caller = block([onStart()], [callFunction('Fn1'), waitForSignal(lit('tag1')), setEventVar('1')]);
    const reader = readerWith({ Sheet1: [fn1, fn2, caller] });
    const result = await findRuntimeTraps(reader);
    expect(result.summary).toMatchObject({ warning: 0, info: 1 });
    const issue = result.issues[0];
    expect(issue).toMatchObject({
      severity: 'info',
      check: 'signal-order',
      tag: 'tag1',
      location: 'Sheet1 > block > action:1',
      eventSid: caller.sid,
    });
    expect(issue.message).toContain('Fn1 raises Signal "tag1" before it returns');
    expect(issue.message).toContain('before this Wait for signal starts');
    expect(issue.message).toContain('only finishes the next time "tag1" is raised');
    expect(issue.suggestion).toContain('construct3://docs/pitfalls');
    expect(issue.suggestion).toContain('confirm before changing it');
    expect(issue.related).toEqual([
      `Sheet1 > block > action:0 [call Fn1] (sid ${caller.sid})`,
      `Sheet1 > function:Fn1 > block > action:0 [Signal] (sid ${signalling.sid})`,
    ]);
    // Fn2 waits before its Signal, so the call returns first and the wait for "tag2" is in time
    expect(result.issues.some(i => i.tag === 'tag2')).toBe(false);
    expect(result.notes.some(n => n.includes('unconditional paths only'))).toBe(true);
  });

  it('reports a wait after a call to a function that signals at once', async () => {
    const reader = readerWith({
      Sheet1: [fn('Fn1', [], [signal(lit('tag1'))]), block([onStart()], [callFunction('Fn1'), waitForSignal(lit('tag1'))])],
    });
    const result = await findRuntimeTraps(reader);
    expect(orderIssues(result)).toHaveLength(1);
    expect(result.issues).toHaveLength(1);
  });

  it('reports a Signal earlier in the same action list', async () => {
    const reader = readerWith({ Sheet1: [block([onStart()], [signal(lit('tag1')), waitForSignal(lit('tag1'))])] });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ check: 'signal-order', tag: 'tag1', location: 'Sheet1 > block > action:1' });
    expect(result.issues[0].message).toContain('Signal "tag1" runs before this Wait for signal starts');
    expect(result.issues[0].related).toHaveLength(1);
    expect(result.issues[0].related![0]).toContain('> action:0 [Signal] (sid ');
  });

  it('follows Functions.Name() calls in expressions', async () => {
    const reader = readerWith({
      Sheet1: [
        fn('Fn1', [], [signal(lit('tag1'))]),
        block([onStart()], [setEventVar('Functions.Fn1()'), waitForSignal(lit('tag1'))]),
      ],
    });
    const result = await findRuntimeTraps(reader);
    expect(orderIssues(result)).toHaveLength(1);
    expect(result.issues[0].related![0]).toContain('[Functions.Fn1()]');
  });

  it('follows calls transitively', async () => {
    const fn1 = fn('Fn1', [], [signal(lit('tag1'))]);
    const reader = readerWith({
      Sheet1: [
        fn('Fn0', [], [callFunction('Fn1')]),
        fn1,
        block([onStart()], [callFunction('Fn0'), waitForSignal(lit('tag1'))]),
      ],
    });
    const result = await findRuntimeTraps(reader);
    expect(orderIssues(result)).toHaveLength(1);
    expect(result.issues[0].message).toContain('Fn0 raises Signal "tag1"');
    expect(result.issues[0].related![1]).toBe(`Sheet1 > function:Fn1 > action:0 [Signal] (sid ${fn1.sid})`);
  });

  it('reports a wait in a sub-event after a call in the parent event', async () => {
    const reader = readerWith({
      Sheet1: [
        fn('Fn1', [], [signal(lit('tag1'))]),
        block([onStart()], [callFunction('Fn1')], [block([], [waitForSignal(lit('tag1'))])]),
      ],
    });
    const result = await findRuntimeTraps(reader);
    expect(orderIssues(result)).toHaveLength(1);
    expect(result.issues[0].location).toBe('Sheet1 > block > block > action:0');
  });

  it('resolves a forwarded tag at the call, also through another function', async () => {
    const reader = readerWith({
      Sheet1: [
        fn('Fn1', ['p'], [signal('p')]),
        fn('Fn0', [], [callFunction('Fn1', [lit('tag2')])]),
        block([onStart()], [callFunction('Fn1', [lit('tag1')]), waitForSignal(lit('tag1')), waitForSignal(lit('tag3'))]),
        block([onStart()], [callFunction('Fn0'), waitForSignal(lit('tag2'))]),
        block([], [signal(lit('tag3'))]),
      ],
    });
    const result = await findRuntimeTraps(reader);
    expect(orderIssues(result).map(i => (i as { tag?: string }).tag)).toEqual(['tag1', 'tag2']);
  });

  it('does not report a function that waits before it signals', async () => {
    for (const before of [wait(), waitForSignal(lit('tag0')), waitForPrevious()]) {
      const reader = readerWith({
        Sheet1: [
          fn('Fn1', [], [before, signal(lit('tag1'))]),
          block([onStart()], [callFunction('Fn1'), waitForSignal(lit('tag1'))]),
          block([], [signal(lit('tag0'))]),
        ],
      });
      expect(orderIssues(await findRuntimeTraps(reader))).toEqual([]);
    }
  });

  it('does not report a Signal behind a condition', async () => {
    const reader = readerWith({
      Sheet1: [
        fn('Fn1', [], [], [block([compareVar('1')], [signal(lit('tag1'))])]),
        block([onStart()], [callFunction('Fn1'), waitForSignal(lit('tag1'))]),
      ],
    });
    expect((await findRuntimeTraps(reader)).issues).toEqual([]);
  });

  it('does not report a Signal in a child of a sub-event that waits first', async () => {
    const reader = readerWith({
      Sheet1: [
        fn('Fn1', [], [], [block([], [wait()], [block([], [signal(lit('tag1'))])])]),
        block([onStart()], [callFunction('Fn1'), waitForSignal(lit('tag1'))]),
      ],
    });
    expect((await findRuntimeTraps(reader)).issues).toEqual([]);
  });

  it('does not report a disabled Signal or a disabled Signal sub-event', async () => {
    for (const body of [
      fn('Fn1', [], [disabled(signal(lit('tag1')))]),
      fn('Fn1', [], [], [disabled(block([], [signal(lit('tag1'))]))]),
    ]) {
      const reader = readerWith({
        Sheet1: [body, block([onStart()], [callFunction('Fn1'), waitForSignal(lit('tag1'))]), block([], [signal(lit('tag1'))])],
      });
      expect(orderIssues(await findRuntimeTraps(reader))).toEqual([]);
    }
  });

  it('terminates on recursive functions', async () => {
    const reader = readerWith({
      Sheet1: [
        fn('Fn1', [], [callFunction('Fn2')]),
        fn('Fn2', [], [callFunction('Fn1')]),
        fn('Fn3', [], [callFunction('Fn3'), signal(lit('tag3'))]),
        block([onStart()], [callFunction('Fn1'), waitForSignal(lit('tag1')), callFunction('Fn3'), waitForSignal(lit('tag3'))]),
        block([], [signal(lit('tag1'))]),
      ],
    });
    const result = await findRuntimeTraps(reader);
    expect(orderIssues(result).map(i => (i as { tag?: string }).tag)).toEqual(['tag3']);
  });

  it('does not report a wait that starts before the call', async () => {
    const reader = readerWith({
      Sheet1: [fn('Fn1', [], [signal(lit('tag1'))]), block([onStart()], [waitForSignal(lit('tag1')), callFunction('Fn1')])],
    });
    expect((await findRuntimeTraps(reader)).issues).toEqual([]);
  });

  it('only reports waits in the requested event sheet', async () => {
    const reader = readerWith({
      Sheet1: [fn('Fn1', [], [signal(lit('tag1'))])],
      Sheet2: [block([onStart()], [callFunction('Fn1'), waitForSignal(lit('tag1'))])],
    });
    expect(orderIssues(await findRuntimeTraps(reader, { eventsheet: 'Sheet1' }))).toEqual([]);
    expect(orderIssues(await findRuntimeTraps(reader, { eventsheet: 'Sheet2' }))).toHaveLength(1);
  });
});

describe('findRuntimeTraps: unused signal wording', () => {
  it('says signals are not queued when nothing waits for a signal', async () => {
    const reader = readerWith({ Sheet1: [block([onStart()], [signal(lit('tag1'))])] });
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ severity: 'info', check: 'signal-pairing', tag: 'tag1' });
    expect(result.issues[0].suggestion).toContain('not queued');
  });
});

// ─── Locations: SIDs and sibling indexes ────────────────────

describe('findRuntimeTraps: related and signal map entries name the event', () => {
  it('ends every entry with the SID of the event that holds the ACE', async () => {
    const b1 = { ...block([], [waitForSignal(lit('tag1'))]), sid: 10 };
    const b2 = { ...block([], [waitForSignal(lit('tag1'))]), sid: 20 };
    const reader = readerWith({ Sheet1: [fn('Fn1', [], [], [b1, b2]), block([], [signal(lit('tag2'))])] });
    const result = await findRuntimeTraps(reader, { detail: 'full' });
    const warning = result.issues.find(i => i.severity === 'warning')!;
    expect(warning.eventSid).toBe(10);
    expect(warning.related).toEqual([
      'Sheet1 > function:Fn1 > block > action:0 [Wait for signal] (sid 10)',
      'Sheet1 > function:Fn1 > block > action:0 [Wait for signal] (sid 20)',
    ]);
    expect(new Set(result.signals!.find(t => t.tag === 'tag1')!.waiters).size).toBe(2);
  });

  it('names the call site of each forwarded signal', async () => {
    const reader = readerWith({
      Sheet1: [
        fn('Fn2', ['p'], [signal('p')]),
        { ...block([], [callFunction('Fn2', [lit('tag3')])]), sid: 30 },
        { ...block([], [callFunction('Fn2', [lit('tag3')])]), sid: 40 },
      ],
    });
    const result = await findRuntimeTraps(reader, { detail: 'full' });
    expect(result.signals!.find(t => t.tag === 'tag3')!.emitters).toEqual([
      'Sheet1 > block > action:0 [Signal via Fn2()] (sid 30)',
      'Sheet1 > block > action:0 [Signal via Fn2()] (sid 40)',
    ]);
  });

  it('gives events without a SID their sibling index', async () => {
    const noSid = () => {
      const { sid: _sid, ...rest } = block([], [waitForSignal(lit('tag1'))]);
      return rest;
    };
    const reader = readerWith({ Sheet1: [noSid(), noSid()] });
    const result = await findRuntimeTraps(reader, { detail: 'full' });
    expect(result.issues[0].location).toBe('Sheet1 > block#0 > action:0');
    expect(result.issues[0].eventSid).toBeUndefined();
    expect(result.issues[0].related).toEqual([
      'Sheet1 > block#0 > action:0 [Wait for signal]',
      'Sheet1 > block#1 > action:0 [Wait for signal]',
    ]);
  });
});

// ─── Real fixtures ──────────────────────────────────────────

async function loadFixture(fixture: string) {
  const reader = new Construct3ProjectReader(join(__dirname, '..', 'fixtures', fixture, 'project.c3proj'));
  await reader.loadProject();
  return reader;
}

/** Depth-first search for the first object in a sheet that matches `pred`. */
function findIn(node: unknown, pred: (o: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (!Array.isArray(node) && pred(node as Record<string, unknown>)) return node as Record<string, unknown>;
  for (const value of Object.values(node)) {
    const hit = findIn(value, pred);
    if (hit) return hit;
  }
  return undefined;
}

describe('findRuntimeTraps on fixtures', () => {
  for (const fixture of ['c3-loadable-minimal', 'minimal-project']) {
    it(`reports nothing for ${fixture}`, async () => {
      const reader = await loadFixture(fixture);
      const result = await findRuntimeTraps(reader, { detail: 'full' });
      expect(result.issues).toEqual([]);
      expect(result.summary.sheetsScanned).toBeGreaterThan(0);
    });
  }
});

// Editor-saved sheets from MIT-licensed projects (see test/fixtures/runtime-traps-real/README.md).
// Mutating the reader's cached sheets simulates small edits to the real files.
describe('findRuntimeTraps on real event sheets (runtime-traps-real)', () => {
  it('pairs the real Signal with its waits across sheets and finds no traps', async () => {
    const reader = await loadFixture('runtime-traps-real');
    const result = await findRuntimeTraps(reader, { detail: 'full' });
    expect(result.issues).toEqual([]);
    expect(result.summary).toMatchObject({ warning: 0, info: 0, sheetsScanned: 5, scriptsScanned: 9, signalTags: 1 });
    expect(result.signals).toEqual([{
      tag: 'next',
      emitters: ['dialogue > block > block > action:1 [Signal] (sid 891898090003918)'],
      waiters: [
        'lab_events > block > action:5 [Wait for signal] (sid 543349956017238)',
        'lab_events > block > action:7 [Wait for signal] (sid 543349956017238)',
        'lab_events > block > action:9 [Wait for signal] (sid 543349956017238)',
        'interrogation_text_events > block > action:3 [Wait for signal] (sid 661441930562210)',
      ],
      listeners: [],
    }]);
    expect(result.notes.some(n => n.includes('could not be read'))).toBe(false);
  });

  it('warns once the only Signal is disabled', async () => {
    const reader = await loadFixture('runtime-traps-real');
    const sheets = await reader.readAllEventSheets();
    const sig = findIn(sheets.get('dialogue'), o => o.id === 'signal' && o.objectClass === 'System')!;
    sig.disabled = true;
    const result = await findRuntimeTraps(reader);
    expect(result.summary.warning).toBe(1);
    expect(result.issues[0].message).toContain('Wait for signal "next" can never finish');
    expect(result.issues[0].message).toContain('4 wait(s) affected');
  });

  it('warns when a script in a real function uses a parameter without localVars', async () => {
    const reader = await loadFixture('runtime-traps-real');
    const sheets = await reader.readAllEventSheets();
    const getValue = findIn(sheets.get('c3_json_helper'), o => o.functionName === 'getValue')!;
    const action = (getValue.actions as Array<Record<string, unknown>>)[0];
    // Original: "const key = localVars.key;\nconst json_name = localVars.jsonName;\n..."
    action.script = (action.script as string).replace('const key = localVars.key;\n', '');
    const result = await findRuntimeTraps(reader);
    expect(result.summary.warning).toBe(1);
    expect(result.issues[0]).toMatchObject({
      check: 'script-function-parameter',
      location: 'c3_json_helper > group:Json HELPER > function:getValue > action:0',
    });
    expect(result.issues[0].message).toContain('uses parameter "key"');
  });

  it('reads the Imports for events script listed in project.c3proj', async () => {
    const reader = await loadFixture('runtime-traps-real');
    const sheets = await reader.readAllEventSheets();
    // scripts/importsForEvents.js imports `Globals`; a parameter with that name is shadowed by it
    const init = findIn(sheets.get('c3_json_helper'), o => o.functionName === 'initializeJSON')!;
    (init.functionParameters as Array<Record<string, unknown>>)[0].name = 'Globals';
    (init.actions as Array<Record<string, unknown>>)[0].script = 'Globals.log(localVars.Globals);';
    const result = await findRuntimeTraps(reader);
    expect(result.issues).toEqual([]);
    expect(await reader.readScriptFile('importsForEvents.js')).toContain('import * as Globals');
    await expect(reader.readScriptFile('../project.c3proj')).rejects.toThrow('Path traversal');
  });
});
