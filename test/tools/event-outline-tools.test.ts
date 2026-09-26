import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { nestedSheet, actionHeavyEvents } from '../mocks/event-sheets.js';
import { registerAnalysisTools } from '../../src/tools/analysis.js';
import { OUTLINE_PAGE_CHAR_BUDGET } from '../../src/construct3/analyzers/event-outline.js';

function setup() {
  const server = new MockServer();
  const reader = new MockReader({
    eventSheets: new Map<string, Record<string, unknown>>([
      ['es_game', nestedSheet()],
      ['Empty', { name: 'Empty', events: [], sid: 9 }],
      ['Sheet1', { name: 'Sheet1', events: actionHeavyEvents(), sid: 8 }],
    ]),
  });
  registerAnalysisTools(server as any, reader as any);
  return { server, reader };
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('locate_event', () => {
  it('registers the tool', () => {
    expect(setup().server.hasTool('locate_event')).toBe(true);
  });

  it('maps an editor event number and action number to JSON', async () => {
    const { server } = setup();
    const result = await server.callTool('locate_event', { sheet: 'es_game', eventNumber: 9, actionNumber: 1 });
    expect(result.isError).toBeUndefined();
    const data = parseResult(result);
    expect(data.event).toMatchObject({
      number: 9,
      path: 'events[4].children[0]',
      sid: 21,
      kind: 'block',
      enclosingFunction: 'DoThing',
      summary: 'IF (no conditions) => CALL Other()',
    });
    expect(data.action).toMatchObject({ number: 1, path: 'events[4].children[0].actions[0]', kind: 'call', sid: 210 });
    expect(data.previousEvent).toMatchObject({ number: 8, path: 'events[4]' });
    expect(data.nextEvent).toMatchObject({ number: 10, path: 'events[5]' });
    expect(data.numbering).toContain('Not numbered: variables, includes, comments');
    expect(data.notes[0]).toContain('read that way (actionIndexBase=0), action 1 is no such action');
  });

  it('mentions the "number N" wording of editor script errors in its description', () => {
    const { server } = setup();
    expect(server.getTool('locate_event')!.description).toContain('"es_game, number 72, action 1"');
  });

  it('passes countActionComments through', async () => {
    const { server } = setup();
    const data = parseResult(await server.callTool('locate_event', {
      sheet: 'es_game', eventNumber: 13, actionNumber: 1, countActionComments: false,
    }));
    expect(data.action).toMatchObject({ index: 1, kind: 'script' });
  });

  it('passes actionIndexBase through', async () => {
    const { server } = setup();
    const data = parseResult(await server.callTool('locate_event', {
      sheet: 'es_game', eventNumber: 2, actionNumber: 0, actionIndexBase: 0,
    }));
    expect(data.action).toMatchObject({ number: 0, index: 0, path: 'events[3].children[0].actions[0]' });
    await expect(server.callTool('locate_event', { sheet: 'es_game', eventNumber: 2, actionNumber: 0, actionIndexBase: 2 }))
      .rejects.toThrow();
  });

  it('returns a clear error when the event number is out of range', async () => {
    const { server } = setup();
    const result = await server.callTool('locate_event', { sheet: 'es_game', eventNumber: 99 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Event 99 is out of range for event sheet "es_game": it has 13 numbered events (1-13).');
  });

  it('returns clear errors when the condition or action number is out of range', async () => {
    const { server } = setup();
    const condition = await server.callTool('locate_event', { sheet: 'es_game', eventNumber: 5, conditionNumber: 3 });
    expect(condition.isError).toBe(true);
    expect(condition.content[0].text).toBe(
      'Error: Condition 3 is out of range: event 5 in "es_game" has 2 condition(s) (1-2).',
    );
    const action = await server.callTool('locate_event', { sheet: 'es_game', eventNumber: 13, actionNumber: 4 });
    expect(action.isError).toBe(true);
    expect(action.content[0].text).toBe('Error: Action 4 is out of range: event 13 in "es_game" has 3 action(s) (1-3).');
    const zero = await server.callTool('locate_event', { sheet: 'es_game', eventNumber: 13, actionNumber: 0 });
    expect(zero.isError).toBe(true);
    expect(zero.content[0].text).toContain('If the number is 0-based, set actionIndexBase=0.');
  });

  it('returns an error for an unknown sheet', async () => {
    const { server } = setup();
    const result = await server.callTool('locate_event', { sheet: 'Nope', eventNumber: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Event sheet "Nope" not found');
  });

  it('passes the read error through for a listed sheet that cannot be read', async () => {
    const { server, reader } = setup();
    reader.readEventSheet = async () => {
      throw new Error('Failed to read event sheet "es_game": Unexpected token } in JSON at position 12');
    };
    for (const tool of ['locate_event', 'get_eventsheet_outline']) {
      const result = await server.callTool(tool, { sheet: 'es_game', eventNumber: 1 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        'Error reading event sheet "es_game": Failed to read event sheet "es_game": Unexpected token } in JSON at position 12',
      );
    }
  });

  it('rejects non-positive event numbers at the schema level', async () => {
    const { server } = setup();
    await expect(server.callTool('locate_event', { sheet: 'es_game', eventNumber: 0 })).rejects.toThrow();
  });
});

describe('get_eventsheet_outline', () => {
  it('registers the tool', () => {
    expect(setup().server.hasTool('get_eventsheet_outline')).toBe(true);
  });

  it('returns a numbered text outline', async () => {
    const { server } = setup();
    const result = await server.callTool('get_eventsheet_outline', { sheet: 'es_game' });
    expect(result.isError).toBeUndefined();
    const lines = result.content[0].text.split('\n');
    expect(lines[0]).toBe('Event sheet "es_game": 13 numbered event(s), 5 unnumbered row(s) (variables, includes, comments).');
    expect(lines).toContain(' 7     IF Keyboard.key-is-down(key=32)');
    expect(lines.some((l: string) => l.startsWith('10 CUSTOM ACTION Player.jump() IF Player[Platform].is-on-floor() AND '))).toBe(true);
  });

  it('applies startEvent, limit and maxDepth (only shown events count toward limit)', async () => {
    const { server } = setup();
    const result = await server.callTool('get_eventsheet_outline', { sheet: 'es_game', startEvent: 8, limit: 2, maxDepth: 0 });
    const text = result.content[0].text;
    expect(text).toContain('Showing events 8-11. Next page: startEvent=12.');
    expect(text).toContain(' 8 FUNCTION DoThing(a: number) -> number [async] IF System.for-each(object=Enemy)');
    expect(text).toContain('… event 9 hidden (maxDepth=0)');
    expect(text).toContain('10 CUSTOM ACTION Player.jump()');
    expect(text).toContain('… event 11 hidden (maxDepth=0)');
    expect(text).not.toContain('12 SCRIPT BLOCK');
  });

  it('ends a page early at the size budget and names the next page', async () => {
    const { server } = setup();
    const result = await server.callTool('get_eventsheet_outline', { sheet: 'Sheet1', limit: 1000 });
    expect(result.isError).toBeUndefined();
    const text: string = result.content[0].text;
    expect(text.length).toBeLessThanOrEqual(OUTLINE_PAGE_CHAR_BUDGET);
    expect(text.split('\n')[1]).toMatch(
      /^Showing events 1-\d+\. Page ended at the ~40000-character size budget before limit=1000 was reached\. Next page: startEvent=\d+\.$/,
    );
    const tool = server.getTool('get_eventsheet_outline')!;
    expect(tool.description).toContain('about 40,000 characters');
  });

  it('handles an empty sheet', async () => {
    const { server } = setup();
    const result = await server.callTool('get_eventsheet_outline', { sheet: 'Empty' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('0 numbered event(s)');
  });

  it('returns errors for an unknown sheet or a startEvent past the end', async () => {
    const { server } = setup();
    const missing = await server.callTool('get_eventsheet_outline', { sheet: 'Nope' });
    expect(missing.isError).toBe(true);
    const past = await server.callTool('get_eventsheet_outline', { sheet: 'es_game', startEvent: 20 });
    expect(past.isError).toBe(true);
    expect(past.content[0].text).toContain('startEvent 20 is out of range');
  });
});
