import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, readFile, readdir, writeFile, mkdir, rm, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { EDITOR_RELOAD_NOTE } from '../../src/tools/shared.js';
import { isCaseInsensitiveFs } from '../helpers/fs-case.js';

const caseInsensitive = isCaseInsensitiveFs();

// Pass-through mock so a single test can make unlink fail.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});

function setup(readerData: Record<string, unknown> = {}) {
  const server = new MockServer();
  const reader = new MockReader(readerData);
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerTimelineTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer, idGen };
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

// ─── list_timelines ───────────────────────────────────────

describe('list_timelines', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('list_timelines')).toBe(true);
  });

  it('returns empty list when no timelines', async () => {
    const { server } = setup();
    const result = await server.callTool('list_timelines', {});
    const data = parseResult(result);
    expect(data.timelines).toEqual([]);
    expect(data.count).toBe(0);
  });

  it('lists timelines from project root', async () => {
    // Override getProject to return timelines
    const server = new MockServer();
    const reader = new MockReader();
    // Patch getProject to include timelines
    const origGetProject = reader.getProject.bind(reader);
    (reader as any).getProject = () => ({
      ...origGetProject(),
      timelines: { items: ['Timeline 1', 'Timeline 2'], subfolders: [] },
    });
    const writer = new MockWriter();
    const idGen = new MockIdGenerator();
    registerTimelineTools({ server, reader, writer, idGen } as any);

    const result = await server.callTool('list_timelines', {});
    const data = parseResult(result);
    expect(data.count).toBe(2);
    expect(data.timelines).toContain('Timeline 1');
    expect(data.timelines).toContain('Timeline 2');
  });

  it('lists timelines from named subfolders and keeps transitions apart', async () => {
    // Shape taken from real projects: Construct 3 keeps transitions (easing
    // curves) in a first subfolder that has no name, stored on disk in
    // timelines/transitions/. Named subfolders hold timelines.
    const server = new MockServer();
    const reader = new MockReader();
    const origGetProject = reader.getProject.bind(reader);
    (reader as any).getProject = () => ({
      ...origGetProject(),
      timelines: {
        items: ['Timeline 1'],
        subfolders: [
          { items: ['Transition1', 'Transition2'], subfolders: [] },
          { name: 'UI', items: ['Intro'], subfolders: [{ name: 'Menus', items: ['Open'], subfolders: [] }] },
        ],
      },
    });
    const writer = new MockWriter();
    const idGen = new MockIdGenerator();
    registerTimelineTools({ server, reader, writer, idGen } as any);

    const result = await server.callTool('list_timelines', {});
    const data = parseResult(result);
    expect(data.timelines).toEqual(['Timeline 1', 'Intro', 'Open']);
    expect(data.count).toBe(3);
    expect(data.transitions).toEqual(['Transition1', 'Transition2']);
  });
});

// ─── get_timeline_details ─────────────────────────────────

describe('get_timeline_details', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('get_timeline_details')).toBe(true);
  });

  it('errors when timeline not in project', async () => {
    const { server } = setup();
    const result = await server.callTool('get_timeline_details', { name: 'Ghost' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"Ghost" not found');
  });
});

// ─── create_timeline ──────────────────────────────────────

describe('create_timeline', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('create_timeline')).toBe(true);
  });

  it('rejects duplicate timeline name', async () => {
    const server = new MockServer();
    const reader = new MockReader();
    const origGetProject = reader.getProject.bind(reader);
    (reader as any).getProject = () => ({
      ...origGetProject(),
      timelines: { items: ['Timeline 1'], subfolders: [] },
    });
    const writer = new MockWriter();
    const idGen = new MockIdGenerator();
    registerTimelineTools({ server, reader, writer, idGen } as any);

    const result = await server.callTool('create_timeline', { name: 'Timeline 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });
});

// ─── update_timeline ──────────────────────────────────────

describe('update_timeline', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_timeline')).toBe(true);
  });

  it('errors with no updates', async () => {
    const server = new MockServer();
    const reader = new MockReader();
    const origGetProject = reader.getProject.bind(reader);
    (reader as any).getProject = () => ({
      ...origGetProject(),
      timelines: { items: ['Timeline 1'], subfolders: [] },
    });
    const writer = new MockWriter();
    const idGen = new MockIdGenerator();
    registerTimelineTools({ server, reader, writer, idGen } as any);

    const result = await server.callTool('update_timeline', { name: 'Timeline 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
  });

  it('errors when timeline not found', async () => {
    const { server } = setup();
    const result = await server.callTool('update_timeline', {
      name: 'Ghost',
      totalTime: 10,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"Ghost" not found');
  });
});

// ─── delete_timeline ──────────────────────────────────────

describe('delete_timeline', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('delete_timeline')).toBe(true);
  });

  it('errors when timeline not found', async () => {
    const { server } = setup();
    const result = await server.callTool('delete_timeline', { name: 'Ghost' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"Ghost" not found');
  });
});

// ─── Real project folder: timelines in subfolders ─────────
//
// Layout mirrors real Construct 3 folder projects: timelines in a named
// project-bar folder are stored in timelines/<folder>/<name>.json, and the
// first, nameless subfolder holds transitions in timelines/transitions/.

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

function timelineJson(name: string, totalTime: number): string {
  return JSON.stringify({
    name,
    enabled: true,
    interpolationMode: 'default',
    resultMode: 'absolute',
    ease: 'noease',
    pathMode: 'line',
    resizeMode: 'size',
    playheadTime: 0,
    totalTime,
    stepTime: 0.1,
    useStepTime: true,
    scale: 1,
    loop: false,
    pingPong: false,
    repeatCount: 1,
    startOnLayout: '',
    transformWithSceneGraph: true,
    ignoreSystemTimescale: true,
    tracks: [],
  }, null, '\t');
}

const TRANSITION_JSON = JSON.stringify({
  name: 'Note',
  linear: false,
  purpose: 'any',
  transitionKeyframes: [
    { x: 0, y: 0, sax: 0, say: 0, eax: 0, eay: 0, se: true, ee: false, sm: 'cubic' },
    { x: 1, y: 1, sax: 0, say: 0, eax: 0, eay: 0, se: false, ee: true, sm: 'cubic' },
  ],
}, null, '\t');

const PROJECT_TIMELINES = {
  items: ['Door'],
  subfolders: [
    { items: ['Note', 'Fade'], subfolders: [] },
    { items: ['KO', 'Round Intro', 'Fade'], subfolders: [], name: 'Steel and Stone' },
    { items: [], subfolders: [{ items: ['Deep'], subfolders: [], name: 'B' }], name: 'A' },
  ],
};

const PROJECT_FILES: Record<string, string> = {
  'timelines/Door.json': timelineJson('Door', 1),
  'timelines/transitions/Note.json': TRANSITION_JSON,
  'timelines/transitions/Fade.json': TRANSITION_JSON.replace('"Note"', '"Fade"'),
  'timelines/Steel and Stone/KO.json': timelineJson('KO', 1.1),
  'timelines/Steel and Stone/Round Intro.json': timelineJson('Round Intro', 2),
  'timelines/Steel and Stone/Fade.json': timelineJson('Fade', 0.5),
  'timelines/A/B/Deep.json': timelineJson('Deep', 3),
};

describe('timeline tools on a project folder', () => {
  let dir: string;
  let projPath: string;
  let server: MockServer;

  const file = (rel: string) => join(dir, ...rel.split('/'));
  const readText = (rel: string) => readFile(file(rel), 'utf-8');
  const c3projTimelines = async () => JSON.parse(await readFile(projPath, 'utf-8')).timelines;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'c3-timelines-'));
    await cp(FIXTURE_DIR, dir, { recursive: true });
    projPath = join(dir, 'project.c3proj');
    const project = JSON.parse(await readFile(projPath, 'utf-8'));
    project.timelines = PROJECT_TIMELINES;
    await writeFile(projPath, JSON.stringify(project, null, '\t'), 'utf-8');
    for (const [rel, content] of Object.entries(PROJECT_FILES)) {
      await mkdir(dirname(file(rel)), { recursive: true });
      await writeFile(file(rel), content, 'utf-8');
    }
    const reader = new Construct3ProjectReader(projPath);
    await reader.loadProject();
    server = new MockServer();
    registerTimelineTools({ server, reader, writer: new MockWriter(), idGen: new MockIdGenerator() } as any);
  });

  afterEach(async () => {
    vi.mocked(unlink).mockClear();
    await rm(dir, { recursive: true, force: true });
  });

  it('lists timelines from every folder and transitions separately', async () => {
    const data = parseResult(await server.callTool('list_timelines', {}));
    expect(data.timelines).toEqual(['Door', 'KO', 'Round Intro', 'Fade', 'Deep']);
    expect(data.count).toBe(5);
    expect(data.transitions).toEqual(['Note', 'Fade']);
  });

  it('get_timeline_details reads a timeline in a named subfolder', async () => {
    const result = await server.callTool('get_timeline_details', { name: 'KO' });
    expect(result.isError).toBeUndefined();
    const data = parseResult(result);
    expect(data.name).toBe('KO');
    expect(data.totalTime).toBe(1.1);
  });

  it('get_timeline_details reads a timeline in a nested subfolder', async () => {
    const result = await server.callTool('get_timeline_details', { name: 'Deep' });
    expect(result.isError).toBeUndefined();
    expect(parseResult(result).totalTime).toBe(3);
  });

  it('get_timeline_details prefers the timeline over a transition with the same name', async () => {
    const result = await server.callTool('get_timeline_details', { name: 'Fade' });
    expect(result.isError).toBeUndefined();
    expect(parseResult(result).totalTime).toBe(0.5);
  });

  it('update_timeline writes back to the subfolder file and creates no root file', async () => {
    const original = await readText('timelines/Steel and Stone/KO.json');
    const result = await server.callTool('update_timeline', { name: 'KO', loop: true });
    expect(result.isError).toBeUndefined();

    const updated = JSON.parse(await readText('timelines/Steel and Stone/KO.json'));
    expect(updated.loop).toBe(true);
    expect(updated.totalTime).toBe(1.1);
    expect(existsSync(file('timelines/KO.json'))).toBe(false);

    const bak = file('timelines/Steel and Stone/KO.json.bak');
    expect(parseResult(result).backupFile).toBe(bak);
    expect(await readFile(bak, 'utf-8')).toBe(original);
  });

  it('update_timeline writes back to a nested subfolder file', async () => {
    const result = await server.callTool('update_timeline', { name: 'Deep', totalTime: 7 });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(await readText('timelines/A/B/Deep.json')).totalTime).toBe(7);
    expect(existsSync(file('timelines/Deep.json'))).toBe(false);
  });

  it('delete_timeline deletes the subfolder file, backs up exactly that file and unregisters it', async () => {
    const original = await readText('timelines/Steel and Stone/KO.json');
    const result = await server.callTool('delete_timeline', { name: 'KO' });
    expect(result.isError).toBeUndefined();

    expect(existsSync(file('timelines/Steel and Stone/KO.json'))).toBe(false);
    const bak = file('timelines/Steel and Stone/KO.json.bak');
    expect(parseResult(result).backupFile).toBe(bak);
    expect(await readFile(bak, 'utf-8')).toBe(original);

    const timelines = await c3projTimelines();
    expect(timelines.subfolders[1].items).toEqual(['Round Intro', 'Fade']);
    expect(timelines.subfolders[0]).toEqual({ items: ['Note', 'Fade'], subfolders: [] });
    expect(timelines.items).toEqual(['Door']);

    const listed = parseResult(await server.callTool('list_timelines', {}));
    expect(listed.timelines).not.toContain('KO');
  });

  it('delete_timeline deletes a timeline in a nested subfolder', async () => {
    const result = await server.callTool('delete_timeline', { name: 'Deep' });
    expect(result.isError).toBeUndefined();
    expect(existsSync(file('timelines/A/B/Deep.json'))).toBe(false);
    expect(existsSync(file('timelines/A/B/Deep.json.bak'))).toBe(true);
    const timelines = await c3projTimelines();
    expect(timelines.subfolders[2].subfolders[0].items).toEqual([]);
  });

  it('delete_timeline removes the timeline entry, not a transition with the same name', async () => {
    const result = await server.callTool('delete_timeline', { name: 'Fade' });
    expect(result.isError).toBeUndefined();

    expect(existsSync(file('timelines/Steel and Stone/Fade.json'))).toBe(false);
    expect(await readText('timelines/transitions/Fade.json')).toBe(PROJECT_FILES['timelines/transitions/Fade.json']);
    const timelines = await c3projTimelines();
    expect(timelines.subfolders[0].items).toEqual(['Note', 'Fade']);
    expect(timelines.subfolders[1].items).toEqual(['KO', 'Round Intro']);
  });

  it('refuses to read, change or delete a transition', async () => {
    const before = await readFile(projPath, 'utf-8');
    for (const [tool, args] of [
      ['get_timeline_details', { name: 'Note' }],
      ['update_timeline', { name: 'Note', loop: true }],
      ['delete_timeline', { name: 'Note' }],
    ] as const) {
      const result = await server.callTool(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(result.content[0].text, tool).toContain('transition');
    }
    expect(await readText('timelines/transitions/Note.json')).toBe(TRANSITION_JSON);
    expect(existsSync(file('timelines/Note.json'))).toBe(false);
    expect(existsSync(file('timelines/Note.json.bak'))).toBe(false);
    expect(await readFile(projPath, 'utf-8')).toBe(before);
  });

  it('delete_timeline errors and leaves project.c3proj unchanged when the file is missing', async () => {
    await rm(file('timelines/Steel and Stone/Round Intro.json'));
    const before = await readFile(projPath, 'utf-8');

    const result = await server.callTool('delete_timeline', { name: 'Round Intro' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
    expect(await readFile(projPath, 'utf-8')).toBe(before);
    expect(existsSync(file('timelines/Steel and Stone/Round Intro.json.bak'))).toBe(false);
    expect(existsSync(file('timelines/Round Intro.json.bak'))).toBe(false);
  });

  it('delete_timeline errors and keeps the project entry when the file cannot be deleted', async () => {
    const before = await readFile(projPath, 'utf-8');
    vi.mocked(unlink).mockRejectedValueOnce(
      Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' }),
    );

    const result = await server.callTool('delete_timeline', { name: 'Door' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('EPERM');
    expect(await readText('timelines/Door.json')).toBe(PROJECT_FILES['timelines/Door.json']);
    expect(await readFile(projPath, 'utf-8')).toBe(before);
  });

  it('create_timeline in a custom subfolder can be read, updated and deleted', async () => {
    const created = await server.callTool('create_timeline', { name: 'Intro', subfolder: 'UI/Menus' });
    expect(created.isError).toBeUndefined();
    expect(parseResult(created).backupFile).toBeUndefined();
    expect(existsSync(file('timelines/UI/Menus/Intro.json'))).toBe(true);
    const ui = (await c3projTimelines()).subfolders.find((s: any) => s.name === 'UI');
    expect(Object.keys(ui)).toEqual(['items', 'subfolders', 'name']);
    expect(Object.keys(ui.subfolders[0])).toEqual(['items', 'subfolders', 'name']);

    expect(parseResult(await server.callTool('get_timeline_details', { name: 'Intro' })).name).toBe('Intro');

    const updated = await server.callTool('update_timeline', { name: 'Intro', loop: true });
    expect(updated.isError).toBeUndefined();
    expect(JSON.parse(await readText('timelines/UI/Menus/Intro.json')).loop).toBe(true);
    expect(existsSync(file('timelines/Intro.json'))).toBe(false);

    const deleted = await server.callTool('delete_timeline', { name: 'Intro' });
    expect(deleted.isError).toBeUndefined();
    expect(existsSync(file('timelines/UI/Menus/Intro.json'))).toBe(false);
    expect(existsSync(file('timelines/UI/Menus/Intro.json.bak'))).toBe(true);
  });

  it('create_timeline writes new project-bar folders in the editor key order', async () => {
    const result = await server.callTool('create_timeline', { name: 'Outro', subfolder: 'Folder1/Folder2' });
    expect(result.isError).toBeUndefined();
    const timelines = await c3projTimelines();
    const folder1 = timelines.subfolders.find((s: any) => s.name === 'Folder1');
    expect(Object.keys(folder1)).toEqual(['items', 'subfolders', 'name']);
    expect(Object.keys(folder1.subfolders[0])).toEqual(['items', 'subfolders', 'name']);
    expect(folder1.subfolders[0]).toEqual({ items: ['Outro'], subfolders: [], name: 'Folder2' });
    // The nameless transitions folder is left as it was
    expect(timelines.subfolders[0]).toEqual({ items: ['Note', 'Fade'], subfolders: [] });
  });

  it('create_timeline rejects the transitions folder as a subfolder', async () => {
    const before = await readFile(projPath, 'utf-8');
    for (const subfolder of ['transitions', 'Transitions/More']) {
      const result = await server.callTool('create_timeline', { name: 'Fade2', subfolder });
      expect(result.isError, subfolder).toBe(true);
      expect(result.content[0].text, subfolder).toContain('transitions');
    }
    expect(existsSync(file('timelines/transitions/Fade2.json'))).toBe(false);
    expect(await readFile(projPath, 'utf-8')).toBe(before);
  });

  it('create_timeline rejects a subfolder that leaves timelines/', async () => {
    const result = await server.callTool('create_timeline', { name: 'Escape', subfolder: '../objectTypes' });
    expect(result.isError).toBe(true);
    expect(existsSync(file('objectTypes/Escape.json'))).toBe(false);
  });

  // Issue #21 rules on the subfolder paths from issue #22

  it('completed writes in subfolders carry the editor reload note; reads and errors do not', async () => {
    const created = parseResult(await server.callTool('create_timeline', { name: 'Intro', subfolder: 'UI/Menus' }));
    expect(created.editorNote).toBe(EDITOR_RELOAD_NOTE);
    expect(parseResult(await server.callTool('update_timeline', { name: 'KO', loop: true })).editorNote).toBe(EDITOR_RELOAD_NOTE);
    expect(parseResult(await server.callTool('delete_timeline', { name: 'Deep' })).editorNote).toBe(EDITOR_RELOAD_NOTE);

    expect(parseResult(await server.callTool('list_timelines', {})).editorNote).toBeUndefined();
    expect(parseResult(await server.callTool('get_timeline_details', { name: 'KO' })).editorNote).toBeUndefined();

    // Nothing written: file missing, or a transition
    await rm(file('timelines/Steel and Stone/Round Intro.json'));
    for (const [tool, args] of [
      ['delete_timeline', { name: 'Round Intro' }],
      ['update_timeline', { name: 'Note', loop: true }],
    ] as const) {
      const result = await server.callTool(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(result.content[0].text, tool).not.toContain(EDITOR_RELOAD_NOTE);
    }
  });

  it('update_timeline and delete_timeline keep the text style of the files they rewrite', async () => {
    const crlf = (text: string) => text.replace(/\n/g, '\r\n');
    const koText = crlf(timelineJson('KO', 1.1)) + '\r\n';
    await writeFile(file('timelines/Steel and Stone/KO.json'), koText, 'utf-8');
    await writeFile(projPath, crlf(await readFile(projPath, 'utf-8')) + '\r\n', 'utf-8');

    expect((await server.callTool('update_timeline', { name: 'KO', loop: true })).isError).toBeUndefined();
    expect(await readText('timelines/Steel and Stone/KO.json')).toBe(koText.replace('"loop": false', '"loop": true'));

    expect((await server.callTool('delete_timeline', { name: 'Deep' })).isError).toBeUndefined();
    const project = await readFile(projPath, 'utf-8');
    expect(project.replace(/\r\n/g, '')).not.toContain('\n');
    expect(project.endsWith('}\r\n')).toBe(true);
    expect(JSON.parse(project).timelines.subfolders[2].subfolders[0].items).toEqual([]);
  });

  // Issue #29: names that differ only in case

  /** Every file below timelines/ plus project.c3proj, by project-relative path. */
  async function timelineFiles(): Promise<Record<string, string>> {
    const out: Record<string, string> = { 'project.c3proj': await readFile(projPath, 'utf-8') };
    const walk = async (rel: string) => {
      for (const entry of await readdir(file(rel), { withFileTypes: true })) {
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) await walk(child);
        else out[child] = await readText(child);
      }
    };
    await walk('timelines');
    return out;
  }

  async function expectCreateRefused(args: Record<string, unknown>, message: string): Promise<void> {
    const before = await timelineFiles();
    const result = await server.callTool('create_timeline', args);
    expect(result.isError, JSON.stringify(args)).toBe(true);
    expect(result.content[0].text).toContain(message);
    expect(await timelineFiles()).toEqual(before);
  }

  it('create_timeline refuses a case variant of a timeline in the same folder and leaves its file alone', async () => {
    await expectCreateRefused({ name: 'door' }, 'the existing timeline "Door" in the same folder');
    await expectCreateRefused({ name: 'DOOR', totalTime: 9 }, 'timelines/Door.json');
    await expectCreateRefused({ name: 'ko', subfolder: 'Steel and Stone' }, '"KO"');
    await expectCreateRefused({ name: 'deep', subfolder: 'A/B' }, '"Deep"');
    expect(await readText('timelines/Door.json')).toBe(PROJECT_FILES['timelines/Door.json']);
  });

  it('create_timeline refuses a project-bar folder that differs only in case', async () => {
    await expectCreateRefused({ name: 'Outro', subfolder: 'a/b' }, 'Use subfolder "A/B"');
    await expectCreateRefused({ name: 'Outro', subfolder: 'steel and stone/New' }, 'Use subfolder "Steel and Stone/New"');
  });

  it('create_timeline allows a case variant in another folder or of a transition, with a note', async () => {
    // The editor compares timeline names exactly; the files are in different folders
    const ko = parseResult(await server.callTool('create_timeline', { name: 'ko' }));
    expect(ko.success).toBe(true);
    expect(ko.warnings).toEqual([expect.stringContaining('the existing timeline "KO" (timelines/Steel and Stone/KO.json)')]);
    const note = parseResult(await server.callTool('create_timeline', { name: 'NOTE', subfolder: 'A' }));
    expect(note.warnings).toEqual([expect.stringContaining('the existing transition "Note" (timelines/transitions/Note.json)')]);
    expect(await readText('timelines/Steel and Stone/KO.json')).toBe(PROJECT_FILES['timelines/Steel and Stone/KO.json']);
    expect(existsSync(file('timelines/ko.json'))).toBe(true);
    expect(existsSync(file('timelines/A/NOTE.json'))).toBe(true);
    expect(parseResult(await server.callTool('create_timeline', { name: 'Brand New' })).warnings).toBeUndefined();
  });

  it('create_timeline never replaces a file that is already on disk', async () => {
    await writeFile(file('timelines/Orphan.json'), timelineJson('Orphan', 7), 'utf-8');
    await expectCreateRefused({ name: 'Orphan' }, 'timelines/Orphan.json already exists');
    await expectCreateRefused({ name: 'orphan' }, 'timelines/Orphan.json already exists');
    await expectCreateRefused({ name: 'ORPHAN' }, 'Choose another name, or, if the file is a leftover of a deleted timeline, check it and remove it first.');
  });

  describe.skipIf(!caseInsensitive)('on a case-insensitive file system', () => {
    // Registered as "timeline1" and "deep2", stored as Timeline1.json and Deep2.json
    beforeEach(async () => {
      const project = JSON.parse(await readFile(projPath, 'utf-8'));
      project.timelines.items.push('timeline1');
      project.timelines.subfolders[2].subfolders[0].items.push('deep2');
      await writeFile(projPath, JSON.stringify(project, null, '\t'), 'utf-8');
      await writeFile(file('timelines/Timeline1.json'), timelineJson('timeline1', 1), 'utf-8');
      await writeFile(file('timelines/A/B/Deep2.json'), timelineJson('deep2', 2), 'utf-8');
      const reader = new Construct3ProjectReader(projPath);
      await reader.loadProject();
      server = new MockServer();
      registerTimelineTools({ server, reader, writer: new MockWriter(), idGen: new MockIdGenerator() } as any);
    });

    it('update_timeline keeps the file name on disk and backs up under it', async () => {
      const result = parseResult(await server.callTool('update_timeline', { name: 'timeline1', loop: true }));
      expect(result.backupFile).toBe(file('timelines/Timeline1.json.bak'));
      const entries = await readdir(file('timelines'));
      expect(entries).toContain('Timeline1.json');
      expect(entries).toContain('Timeline1.json.bak');
      expect(entries).not.toContain('timeline1.json');
      expect(JSON.parse(await readText('timelines/Timeline1.json')).loop).toBe(true);

      expect((await server.callTool('update_timeline', { name: 'deep2', totalTime: 4 })).isError).toBeUndefined();
      expect((await readdir(file('timelines/A/B'))).sort()).toEqual(['Deep.json', 'Deep2.json', 'Deep2.json.bak']);
    });

    it('delete_timeline backs up under the file name on disk', async () => {
      const result = parseResult(await server.callTool('delete_timeline', { name: 'timeline1' }));
      expect(result.backupFile).toBe(file('timelines/Timeline1.json.bak'));
      const entries = await readdir(file('timelines'));
      expect(entries).toContain('Timeline1.json.bak');
      expect(entries).not.toContain('Timeline1.json');
    });
  });
});
