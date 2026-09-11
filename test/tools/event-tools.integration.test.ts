/**
 * Real-writer test for update_event_block script actions.
 *
 * The mock tests assert the shape the handler builds; this one proves what
 * lands on disk through the real writer: the canonical C3 form
 * { type, language: "javascript", script: [lines] }, no SID on the script
 * action, and existing action SIDs preserved.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerEventTools } from '../../src/tools/event-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
// From test/fixtures/minimal-project/eventSheets/MainSheet.json
const BLOCK_SID = 400000000000003;
const EXISTING_ACTION_SID = 400000000000002;

describe('update_event_block script actions (real project on disk)', () => {
  let tmpDir: string;
  let reader: Construct3ProjectReader;
  let server: MockServer;

  beforeEach(async () => {
    resetProjectIndex();
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-event-int-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });

    reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerEventTools({ server, reader, writer, idGen } as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('appends a script action in canonical C3 form and leaves existing actions untouched', async () => {
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: BLOCK_SID,
      addActions: [{ type: 'script', script: 'const a = 1;\nconsole.log(a);' }],
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).success).toBe(true);

    const onDisk = JSON.parse(await readFile(join(tmpDir, 'eventSheets', 'MainSheet.json'), 'utf-8'));
    const actions = onDisk.events[0].actions;
    expect(actions).toHaveLength(2);
    expect(actions[0].sid).toBe(EXISTING_ACTION_SID);
    expect(actions[1]).toEqual({ type: 'script', language: 'javascript', script: ['const a = 1;', 'console.log(a);'] });
    expect('sid' in actions[1]).toBe(false);
    await expect(stat(join(tmpDir, 'eventSheets', 'MainSheet.json.bak'))).resolves.toBeDefined();

    // The reader sees the same thing once the writer has invalidated its caches
    const reread = await reader.readEventSheet('MainSheet');
    expect((reread.events[0] as any).actions[1].script).toEqual(['const a = 1;', 'console.log(a);']);
  });
});
