/**
 * A family's effects used through a member (issue #38): the editor saves the
 * effect of Set effect parameter / Set effect enabled as a quoted name in the
 * "effect" parameter, and an action on a member can name an effect of its
 * family (Scirra's winter-tree example: family "Branches" with effect
 * "AdjustHSL", `set-effect-parameter` on member "Branch" with
 * `"effect": "\"AdjustHSL\""`). delete_family and update_family removeMembers
 * refuse without force while such a use is left without its effect. Checked
 * on a temp copy of the minimal fixture with the real reader and writer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { effectNameOf } from '../../src/construct3/analyzers/effect-uses.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

type Json = Record<string, any>;

let tmpDir: string;
let reader: Construct3ProjectReader;
let server: MockServer;

const call = async (tool: string, args: Json): Promise<Json> => JSON.parse((await server.callTool(tool, args)).content[0].text);
const path = (...parts: string[]) => join(tmpDir, ...parts);
const readJson = async (file: string): Promise<Json> => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file: string, data: Json) => writeFile(file, JSON.stringify(data, null, '\t'));

/** The family "Glowers" (effect "Glow", member Sprite) and an action on Sprite with this effect parameter. */
async function setup(effect: string, spriteEffects: Json[] = []): Promise<void> {
  expect((await call('create_family', { name: 'Glowers', pluginId: 'Sprite', members: ['Sprite'] })).success).toBe(true);
  const family = await readJson(path('families', 'Glowers.json'));
  family.effectTypes = [{ effectId: 'glowhorizontal', name: 'Glow' }];
  await writeJson(path('families', 'Glowers.json'), family);
  const sprite = await readJson(path('objectTypes', 'Sprite.json'));
  sprite.effectTypes = spriteEffects;
  await writeJson(path('objectTypes', 'Sprite.json'), sprite);
  const sheet = await readJson(path('eventSheets', 'MainSheet.json'));
  sheet.events[0].actions.push({
    id: 'set-effect-parameter', objectClass: 'Sprite', sid: 400000000000077,
    parameters: { effect, 'parameter-index': '0', value: '1' },
  });
  await writeJson(path('eventSheets', 'MainSheet.json'), sheet);
  await reader.loadProject();
  resetProjectIndex();
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-family-effects-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  server = new MockServer();
  registerObjectTools({ server, reader, writer: new Construct3ProjectWriter(reader, idGen), idGen } as never);
  resetProjectIndex();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('delete_family and a family effect used through a member', () => {
  it('refuses without force, listing the use', async () => {
    await setup('"Glow"');
    const data = await call('delete_family', { name: 'Glowers' });
    expect(data.success).toBe(false);
    expect(data.action).toBe('delete_blocked');
    expect(data.message).toContain('effect "Glow" of "Sprite"');
    expect(data.references.effectUses).toEqual([
      { eventSheet: 'MainSheet', eventPath: 'events[0]', ace: 'action 1', sid: 400000000000077, member: 'Sprite', effect: 'Glow' },
    ]);
    expect(reader.getProject().families.items).toContain('Glowers');
  });

  it('matches the effect name ignoring case, and deletes with force and a warning', async () => {
    await setup('"glow"');
    expect((await call('delete_family', { name: 'Glowers' })).success).toBe(false);
    const forced = await call('delete_family', { name: 'Glowers', force: true });
    expect(forced.success).toBe(true);
    expect(forced.warnings.join(' ')).toContain('validate_project does not check effect names');
  });

  it('does not count a use the member resolves through an effect of its own', async () => {
    await setup('"Glow"', [{ effectId: 'glowhorizontal', name: 'Glow' }]);
    expect((await call('delete_family', { name: 'Glowers' })).success).toBe(true);
  });

  it('warns about an effect parameter that is not a quoted name', async () => {
    await setup('"Gl" & "ow"');
    const data = await call('delete_family', { name: 'Glowers' });
    expect(data.success).toBe(true);
    expect(data.warnings.join(' ')).toContain('could not be checked: "MainSheet" events[0] action 1 ("Gl" & "ow")');
  });
});

describe('update_family removeMembers and a family effect used through the member', () => {
  it('refuses without force and removes with force', async () => {
    await setup('"Glow"');
    const blocked = await call('update_family', { name: 'Glowers', removeMembers: ['Sprite'] });
    expect(blocked.success).toBe(false);
    expect(blocked.action).toBe('update_blocked');
    expect(blocked.message).toContain('Events still use the family\'s effects through a leaving member');
    expect(blocked.references.effectUses[0]).toMatchObject({ member: 'Sprite', effect: 'Glow' });
    expect((await readJson(path('families', 'Glowers.json'))).members).toEqual(['Sprite']);

    const forced = await call('update_family', { name: 'Glowers', removeMembers: ['Sprite'], force: true });
    expect(forced.success).toBe(true);
    expect((await readJson(path('families', 'Glowers.json'))).members).toEqual([]);
  });
});

describe('effectNameOf', () => {
  it('reads the quoted name the editor saves, and nothing else', () => {
    expect(effectNameOf('"AdjustHSL"')).toBe('AdjustHSL');
    expect(effectNameOf(' "A ""b""" ')).toBe('A "b"');
    expect(effectNameOf('"a" & "b"')).toBeUndefined();
    expect(effectNameOf('Glow')).toBeUndefined();
  });
});
