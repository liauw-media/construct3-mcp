/**
 * Renaming a layer and the event parameters that name it (issue #38): a
 * "layer" parameter whose whole expression is the quoted old name (ignoring
 * case, as the editor looks layer names up) is pointed at the new name,
 * unless another layout has a layer of the old name; other strings naming
 * the layer are listed in a warning, never changed. Checked on a temp copy of
 * the minimal fixture ("Layout 1" with layer "Main", event sheet "MainSheet")
 * with the real reader and writer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { expressionStringLiterals } from '../../src/construct3/layer-references.js';
import { isCaseInsensitiveFs } from '../helpers/fs-case.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

type Json = Record<string, any>;

const caseInsensitive = isCaseInsensitiveFs();

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const sheetPath = () => join(tmpDir, 'eventSheets', 'MainSheet.json');
const layoutPath = () => join(tmpDir, 'layouts', 'Layout 1.json');
const readJson = async (file: string): Promise<Json> => JSON.parse(await readFile(file, 'utf8'));
const call = async (tool: string, args: Json): Promise<Json> => {
  const result = await server.callTool(tool, args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text);
};
const rename = (newName: string, extra: Json = {}) =>
  call('update_layer', { layoutName: 'Layout 1', layerName: 'Main', newName, ...extra });

/** A second layout "Layout 2", with one layer named `layerName`. */
async function addLayout2(layerName: string): Promise<void> {
  const other = await readJson(layoutPath());
  other.name = 'Layout 2';
  other.layers[0].name = layerName;
  other.layers[0].instances = [];
  await writeFile(join(tmpDir, 'layouts', 'Layout 2.json'), JSON.stringify(other, null, '\t'));
  const project = await readJson(join(tmpDir, 'project.c3proj'));
  project.layouts.items.push('Layout 2');
  await writeFile(join(tmpDir, 'project.c3proj'), JSON.stringify(project, null, '\t'));
  await reader.loadProject();
}

/** Actions of the sheet's first event, after its set-position action. */
async function addActions(actions: Json[]): Promise<void> {
  const sheet = await readJson(sheetPath());
  sheet.events[0].actions.push(...actions.map((a, i) => ({ sid: 400000000000100 + i, ...a })));
  await writeFile(sheetPath(), JSON.stringify(sheet, null, '\t'));
  await reader.loadProject();
}
const params = async () => (await readJson(sheetPath())).events[0].actions.slice(1).map((a: Json) => a.parameters ?? a.script);

const LAYER_ACTIONS = [
  { id: 'create-object', objectClass: 'System', parameters: { 'object-to-create': 'Sprite', layer: '"Main"', x: '0', y: '0' } },
  { id: 'move-to-layer', objectClass: 'Sprite', parameters: { layer: ' "main" ' } },
  { id: 'set-layer-visible', objectClass: 'System', parameters: { layer: '"Main"', visibility: 'visible' } },
];

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-layer-rename-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerLayoutTools({ server, reader, writer, idGen } as never);
  resetProjectIndex();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('update_layer rename and the layer parameters that name the layer', () => {
  it('points the layer parameters that are the quoted old name (ignoring case) at the new name', async () => {
    await addActions(LAYER_ACTIONS);
    const data = await rename('Game');
    expect(data.success).toBe(true);
    expect((await readJson(layoutPath())).layers[0].name).toBe('Game');
    expect((await params()).map((p: Json) => p.layer)).toEqual(['"Game"', ' "Game" ', '"Game"']);
    expect(data.warnings.join(' ')).toContain('Pointed 3 "layer" parameter(s) that named "Main" at "Game", in event sheet(s) "MainSheet"');
  });

  it('writes a quote in the new name as two quotes', async () => {
    await addActions([LAYER_ACTIONS[0]]);
    await rename('Top "A"');
    expect((await params())[0].layer).toBe('"Top ""A"""');
  });

  it('lists other strings that may name the layer, without changing them', async () => {
    await addActions([
      { id: 'set-x', objectClass: 'Sprite', parameters: { x: 'LayerScale("Main") * 2' } },
      { id: 'move-to-layer', objectClass: 'Sprite', parameters: { layer: 'n = 1 ? "Main" : "HUD"' } },
      { type: 'script', language: 'javascript', script: ['runtime.layout.getLayer("Main").isVisible = false;'] },
    ]);
    const data = await rename('Game');
    expect(data.success).toBe(true);
    const [scale, conditional, script] = await params();
    expect(scale.x).toBe('LayerScale("Main") * 2');
    expect(conditional.layer).toBe('n = 1 ? "Main" : "HUD"');
    expect(script).toEqual(['runtime.layout.getLayer("Main").isVisible = false;']);
    const warning = data.warnings.join(' ');
    expect(warning).toContain('3 other expression(s) or script line(s) contain the string "Main"');
    expect(warning).toContain('"MainSheet" events[0] action 1 "x"');
    expect(warning).toContain('"MainSheet" events[0] action 3 script');
  });

  it('changes nothing in the events while another layout has a layer of the old name', async () => {
    await addActions(LAYER_ACTIONS);
    await addLayout2('MAIN');

    const data = await rename('Game');
    expect(data.success).toBe(true);
    expect((await params()).map((p: Json) => p.layer)).toEqual(['"Main"', ' "main" ', '"Main"']);
    expect(data.warnings.join(' ')).toContain('3 "layer" parameter(s) name "Main" and were NOT changed: layout(s) "Layout 2" has a layer of that name too');
  });

  it.skipIf(!caseInsensitive)('does not count the renamed layout as another one when layoutName differs from it in case', async () => {
    await addActions(LAYER_ACTIONS);
    const data = await call('update_layer', { layoutName: 'layout 1', layerName: 'Main', newName: 'Game' });
    expect(data.success).toBe(true);
    expect((await params()).map((p: Json) => p.layer)).toEqual(['"Game"', ' "Game" ', '"Game"']);
    expect(data.warnings.join(' ')).not.toContain('NOT changed');
  });

  it('changes no event sheet when the rename only changes the letter case', async () => {
    await addActions(LAYER_ACTIONS);
    await addLayout2('main');
    const before = await readFile(sheetPath(), 'utf8');

    const data = await rename('MAIN');
    expect(data.success).toBe(true);
    expect((await readJson(layoutPath())).layers[0].name).toBe('MAIN');
    expect(await readFile(sheetPath(), 'utf8')).toBe(before);
    expect(existsSync(`${sheetPath()}.bak`)).toBe(false);
    expect(data.warnings).toBeUndefined();
  });

  it('only warns with updateReferences: false', async () => {
    await addActions(LAYER_ACTIONS);
    const data = await rename('Game', { updateReferences: false });
    expect((await params()).map((p: Json) => p.layer)).toEqual(['"Main"', ' "main" ', '"Main"']);
    expect(data.warnings.join(' ')).toContain('3 "layer" parameter(s) still name "Main" (updateReferences is false)');
  });

  it('restores the layout when an event sheet write fails', async () => {
    await addActions(LAYER_ACTIONS);
    const write = writer.writeEntityFile.bind(writer);
    writer.writeEntityFile = async (category, ...rest) => {
      if (category === 'eventSheets') throw new Error('disk full');
      return write(category, ...rest);
    };
    const data = await rename('Game');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The rename was rolled back');
    expect((await readJson(layoutPath())).layers[0].name).toBe('Main');
    expect((await params())[0].layer).toBe('"Main"');
  });
});

/**
 * An event sheet write refused because the sheet changed on disk during the
 * call (#51): the writer puts back the layout the call wrote, or names it
 * when it has to leave it as it is; update_layer never restores it over a
 * save of the editor.
 */
describe('update_layer refused because a file changed on disk during the call', () => {
  /** The editor saves the event sheet with a comment added. */
  async function saveSheetInEditor(): Promise<void> {
    const sheet = await readJson(sheetPath());
    sheet.events.push({ eventType: 'comment', text: 'saved in the editor' });
    await writeFile(sheetPath(), JSON.stringify(sheet, null, '\t'));
  }

  it('leaves putting the layout back to the writer', async () => {
    await addActions(LAYER_ACTIONS);
    const layoutBefore = await readFile(layoutPath(), 'utf8');
    const write = writer.writeEntityFile.bind(writer);
    writer.writeEntityFile = async (category, ...rest) => {
      const backup = await write(category, ...rest);
      if (category === 'layouts') await saveSheetInEditor();
      return backup;
    };

    const data = await rename('Game');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('eventSheets/MainSheet.json was changed on disk after this server read it');
    expect(data.text).toContain('were put back as they were before the call (layouts/Layout 1.json), so the call changed nothing');
    expect(data.text).not.toContain('The rename was rolled back');
    expect(await readFile(layoutPath(), 'utf8')).toBe(layoutBefore);
    const sheet = await readJson(sheetPath());
    expect(sheet.events[sheet.events.length - 1].text).toBe('saved in the editor');
    expect((await params())[0].layer).toBe('"Main"');
  });

  it('leaves a layout the editor saved again after the call wrote it as it is', async () => {
    await addActions(LAYER_ACTIONS);
    const write = writer.writeEntityFile.bind(writer);
    writer.writeEntityFile = async (category, ...rest) => {
      const backup = await write(category, ...rest);
      if (category === 'layouts') {
        const layout = await readJson(layoutPath());
        layout.width = 12345;
        await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
        await saveSheetInEditor();
      }
      return backup;
    };

    const data = await rename('Game');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('left as they are (changed on disk again after this call wrote them, or their backup was replaced): ' +
      'layouts/Layout 1.json (its state from before the call is in layouts/Layout 1.json.bak)');
    expect(data.text).not.toContain('The rename was rolled back');
    const layout = await readJson(layoutPath());
    expect(layout.width).toBe(12345);
    expect(layout.layers[0].name).toBe('Game');
    expect((await params())[0].layer).toBe('"Main"');
  });
});

describe('expressionStringLiterals', () => {
  it('finds the literals of an expression, two quotes being one', () => {
    expect(expressionStringLiterals('LayerScale("Main") & "a""b"').map(l => l.text)).toEqual(['Main', 'a"b']);
    expect(expressionStringLiterals('"unterminated')).toEqual([]);
  });
});
