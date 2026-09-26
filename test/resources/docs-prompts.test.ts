/**
 * Tests for the pitfalls doc resource and the prompts that reference it.
 */

import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { registerDocsResources } from '../../src/resources/docs.js';
import { registerWorkflowPrompts } from '../../src/prompts/workflows.js';
import { PITFALLS_URI, PITFALLS_MARKDOWN } from '../../src/resources/pitfalls.js';

describe('construct3://docs/pitfalls resource', () => {
  function setup() {
    const server = new MockServer();
    registerDocsResources(server as any);
    return server;
  }

  it('is registered with the other docs resources', () => {
    const server = setup();
    expect(PITFALLS_URI).toBe('construct3://docs/pitfalls');
    expect(server.getResourceUris()).toEqual(expect.arrayContaining([
      'construct3://docs/index',
      'construct3://docs/pitfalls',
      'construct3://docs/manual/{topic}',
    ]));
    expect(server.getResource('docs-pitfalls')!.metadata!.mimeType).toBe('text/markdown');
  });

  it('serves the curated markdown', async () => {
    const server = setup();
    const res = await server.readResource(PITFALLS_URI);
    expect(res.contents).toHaveLength(1);
    expect(res.contents[0].uri).toBe(PITFALLS_URI);
    expect(res.contents[0].mimeType).toBe('text/markdown');
    expect(res.contents[0].text).toBe(PITFALLS_MARKDOWN);
  });

  it('covers each curated pitfall', () => {
    const headings = PITFALLS_MARKDOWN.split('\n').filter(l => l.startsWith('### '));
    expect(headings).toHaveLength(9);
    for (const topic of [
      'No backslash escapes',
      'never empty',
      'Dictionary.Get',
      'int("")',
      'Compare two values does not pick',
      'already playing',
      'Signals are not queued',
      'function parameters',
      'exact equality',
    ]) {
      expect(headings.some(h => h.includes(topic))).toBe(true);
    }
  });

  it('states that signals are not queued and how to latch them safely (item 7)', () => {
    const item = PITFALLS_MARKDOWN.slice(PITFALLS_MARKDOWN.indexOf('### 7.'), PITFALLS_MARKDOWN.indexOf('### 8.'));
    expect(item).toContain('Signals are not queued');
    expect(item).toContain('only resumes the waits that already exist');
    expect(item).toContain('[runtime');
    // Why a signal raised inside a called function can still reach the caller's wait
    expect(item).toContain('only when the function reaches a *Wait* before');
    expect(item).toContain('exactly once');
    expect(item).toContain('reset');
    expect(item).toContain('confirm the');
    expect(item).toContain('waits that start after a call');
    expect(item).not.toContain('could not rule out');
    expect(item).not.toMatch(/may not be queued/i);
    expect(PITFALLS_MARKDOWN).toContain('**[runtime]**');
  });

  it('marks sources and credits komabear/c3-skill', () => {
    expect(PITFALLS_MARKDOWN).toContain('[manual');
    expect(PITFALLS_MARKDOWN).toContain('[practice');
    expect(PITFALLS_MARKDOWN).toContain('komabear/c3-skill');
    expect(PITFALLS_MARKDOWN).toContain('MIT');
    expect(PITFALLS_MARKDOWN).toContain('localVars');
    expect(PITFALLS_MARKDOWN).toContain('find_runtime_traps');
  });

  it('points items 1 and 2 to the load-time checks of validate_project (#18)', () => {
    expect(PITFALLS_MARKDOWN).toContain('`validate_project` reports items 1 and 2');
    expect(PITFALLS_MARKDOWN).toContain('`expression-syntax`');
    expect(PITFALLS_MARKDOWN).toContain('`empty-expression`');
  });

  it('is listed in the docs index', async () => {
    const server = setup();
    const res = await server.readResource('construct3://docs/index');
    const index = JSON.parse(res.contents[0].text);
    expect(index.curated.pitfalls).toBe(PITFALLS_URI);
  });
});

describe('workflow prompts referencing runtime traps', () => {
  function setup(events: unknown[] = []) {
    const server = new MockServer();
    const reader = new MockReader({
      eventSheets: new Map([['Main', { name: 'Main', events, sid: 1 }]]),
    });
    registerWorkflowPrompts(server as any, reader as any);
    return server;
  }

  const text = (res: { messages: Array<{ content: { text: string } }> }) => res.messages[0].content.text;

  it('registers debug_stuck_game next to the existing prompts', () => {
    const server = setup();
    expect(server.getPromptNames()).toEqual(expect.arrayContaining([
      'analyze_project', 'find_object_usage', 'explain_eventsheet', 'review_game_logic',
      'document_object', 'optimize_project', 'debug_stuck_game',
    ]));
  });

  it('review_game_logic points to the tool and the pitfalls resource', async () => {
    const out = text(await setup().getPrompt('review_game_logic'));
    expect(out).toContain('find_runtime_traps');
    expect(out).toContain(PITFALLS_URI);
  });

  it('explain_eventsheet points to the tool for that sheet and the pitfalls resource', async () => {
    const out = text(await setup().getPrompt('explain_eventsheet', { eventSheetName: 'Main' }));
    expect(out).toContain('find_runtime_traps tool with eventsheet "Main"');
    expect(out).toContain(PITFALLS_URI);
  });

  it('debug_stuck_game embeds the current trap scan and the symptom', async () => {
    const events = [{
      eventType: 'block',
      conditions: [],
      actions: [{ id: 'wait-for-signal', objectClass: 'System', sid: 2, parameters: { tag: '"bossDone"' } }],
      sid: 3,
    }];
    const out = text(await setup(events).getPrompt('debug_stuck_game', { symptom: 'boss fight freezes' }));
    expect(out).toContain('Symptom: boss fight freezes');
    expect(out).toContain('Wait for signal "bossDone" can never finish');
    expect(out).toContain(PITFALLS_URI);
    // Console script errors name an editor event number; locate_event maps it (#19)
    expect(out).toContain('locate_event maps it');
  });

  it('debug_stuck_game says when the embedded issue list is truncated', async () => {
    const events = [{
      eventType: 'block',
      conditions: [],
      actions: Array.from({ length: 12 }, (_, i) =>
        ({ id: 'wait-for-signal', objectClass: 'System', sid: 10 + i, parameters: { tag: `"t${i}"` } })),
      sid: 3,
    }];
    const out = text(await setup(events).getPrompt('debug_stuck_game'));
    expect(out).toContain('found 12 warning(s) and 0 info item(s) (showing the first 10; run find_runtime_traps for all):');
    expect(out.match(/^- \[warning\]/gm)).toHaveLength(10);
  });

  it('debug_stuck_game does not mention truncation when every issue is listed', async () => {
    const events = [{
      eventType: 'block',
      conditions: [],
      actions: [{ id: 'wait-for-signal', objectClass: 'System', sid: 2, parameters: { tag: '"bossDone"' } }],
      sid: 3,
    }];
    const out = text(await setup(events).getPrompt('debug_stuck_game'));
    expect(out).toContain('found 1 warning(s) and 0 info item(s):');
    expect(out).not.toContain('showing the first');
  });

  it('debug_stuck_game names the called-function race and the SIDs of signal map entries', async () => {
    const out = text(await setup().getPrompt('debug_stuck_game', { symptom: 'stuck' }));
    expect(out).toContain('Signals are not queued');
    expect(out).toContain('before its first Wait');
    expect(out).toContain('signal-order');
    expect(out).toContain('SID');
    expect(out).not.toContain('waits inside called functions');
  });

  it('debug_stuck_game works without a symptom and without findings', async () => {
    const out = text(await setup().getPrompt('debug_stuck_game'));
    expect(out).toContain('(not described)');
    expect(out).toContain('find_runtime_traps found no issues.');
  });
});
