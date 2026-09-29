/**
 * add_event_to_sheet function options (issue #49): functionReturnType,
 * functionIsAsync and functionCopyPicked reach the event sheet file, checked
 * on a temp copy of the minimal fixture with the real reader and writer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { registerMutationTools } from '../../src/tools/mutations.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let tmpDir: string;
let server: MockServer;

async function sheetFunction(name: string): Promise<Record<string, unknown> | undefined> {
  const sheet = JSON.parse(await readFile(join(tmpDir, 'eventSheets', 'MainSheet.json'), 'utf-8'));
  return sheet.events.find((e: Record<string, unknown>) => e.eventType === 'function-block' && e.functionName === name);
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-funcopts-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  server = new MockServer();
  registerMutationTools(server as never, reader, new Construct3ProjectWriter(reader, idGen), idGen);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('add_event_to_sheet function options', () => {
  it('writes the return type, async and copy picked options given', async () => {
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'function',
      functionName: 'GetScore',
      functionParams: [{ name: 'bonus', type: 'number' }],
      functionReturnType: 'number',
      functionIsAsync: true,
      functionCopyPicked: true,
    });
    expect(result.isError, result.content[0].text).toBeUndefined();

    expect(await sheetFunction('GetScore')).toMatchObject({
      functionReturnType: 'number',
      functionIsAsync: true,
      functionCopyPicked: true,
      functionParameters: [expect.objectContaining({ name: 'bonus', type: 'number' })],
    });
  });

  it('writes each return type the editor offers', async () => {
    for (const returnType of ['none', 'number', 'string', 'any']) {
      const functionName = `Get_${returnType}`;
      const result = await server.callTool('add_event_to_sheet', {
        sheetName: 'MainSheet', eventType: 'function', functionName, functionReturnType: returnType,
      });
      expect(result.isError, result.content[0].text).toBeUndefined();
      expect((await sheetFunction(functionName))?.functionReturnType).toBe(returnType);
    }
  });

  it('keeps the defaults none/false/false when the options are left out', async () => {
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'function', functionName: 'Plain',
    });
    expect(result.isError, result.content[0].text).toBeUndefined();

    expect(await sheetFunction('Plain')).toMatchObject({
      functionReturnType: 'none',
      functionIsAsync: false,
      functionCopyPicked: false,
    });
  });

  it('refuses a return type the editor does not have, before writing', async () => {
    const before = await readFile(join(tmpDir, 'eventSheets', 'MainSheet.json'));
    await expect(server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'function', functionName: 'Bad', functionReturnType: 'boolean',
    })).rejects.toThrow();
    expect(Buffer.compare(await readFile(join(tmpDir, 'eventSheets', 'MainSheet.json')), before)).toBe(0);
  });
});
