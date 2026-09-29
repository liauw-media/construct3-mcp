/**
 * In-memory mock of Construct3ProjectReader for testing.
 * No filesystem I/O — all data supplied via constructor.
 */

import type { Construct3Project, EventSheet, ObjectType, Layout, FileItem } from '../../src/construct3/types.js';
import { scanIdsInText, type EntityCategory, type ReadFailure } from '../../src/construct3/project-reader.js';

export interface MockReaderData {
  objects?: Map<string, Record<string, unknown>>;
  eventSheets?: Map<string, Record<string, unknown>>;
  layouts?: Map<string, Record<string, unknown>>;
  families?: Map<string, Record<string, unknown>>;
  metadata?: {
    name?: string;
    version?: string;
    author?: string;
    description?: string;
    runtime?: string;
    viewportWidth?: number;
    viewportHeight?: number;
    firstLayout?: string;
  };
  usedAddons?: Array<{ type: string; id: string; name: string; author: string; bundled: boolean }>;
  /**
   * Project script files, listed under rootFileFolders.script. `path` is
   * relative to scripts/ ("importsForEvents.js" or "sub/x.ts"); `purpose` goes
   * into `script-info` (default "none").
   */
  scriptFiles?: Array<{ path: string; source: string; purpose?: string; type?: string }>;
  /**
   * Media and project files, listed under rootFileFolders.<folder>. `path` is
   * relative to the folder ("click.webm" or "sub/a.png"); `purpose` goes into
   * `file-info` (`icon-info` for icons; default "none", "app-icon" for icons);
   * `text` is what readProjectFileText returns for a general file (reading
   * fails without it).
   */
  files?: Array<{ folder: MockFileFolderKey; path: string; purpose?: string; text?: string }>;
  /** c3proj "containers" */
  containers?: unknown[];
  /**
   * Files below flowcharts/ and timelines/ (`path` relative to the folder);
   * reading one fails when it has no `text`.
   */
  dataFiles?: Array<{ folder: 'flowcharts' | 'timelines'; path: string; text?: string }>;
}

export type MockFileFolderKey = 'sound' | 'music' | 'video' | 'font' | 'icon' | 'general';

type MockScriptFolder = { items: FileItem[]; subfolders: Array<MockScriptFolder & { name: string }> };

export class MockReader {
  private objects: Map<string, Record<string, unknown>>;
  private eventSheets: Map<string, Record<string, unknown>>;
  private layouts: Map<string, Record<string, unknown>>;
  private families: Map<string, Record<string, unknown>>;
  private meta: NonNullable<MockReaderData['metadata']>;
  private addons: NonNullable<MockReaderData['usedAddons']>;
  private scriptFiles: NonNullable<MockReaderData['scriptFiles']>;
  private files: NonNullable<MockReaderData['files']>;
  private containers: unknown[];
  private dataFiles: NonNullable<MockReaderData['dataFiles']>;
  // Names registered in c3proj but without corresponding data (for file-existence testing)
  private registeredOnly: { objects: string[]; eventSheets: string[]; layouts: string[] } = {
    objects: [], eventSheets: [], layouts: [],
  };
  // Simulated bulk-read failures: category → name → typed failure (for unscanned-file testing)
  private readFailures: Map<string, Map<string, ReadFailure>> = new Map();
  // Raw text served by scanEntityIdsRaw for unreadable entities, keyed "category/name"
  private rawEntityText: Map<string, string> = new Map();
  // Forced raw-scan failures, keyed "category/name" (e.g. an ENOENT-coded fs error)
  private rawScanErrors: Map<string, Error> = new Map();

  constructor(data: MockReaderData = {}) {
    this.objects = data.objects ?? new Map();
    this.eventSheets = data.eventSheets ?? new Map();
    this.layouts = data.layouts ?? new Map();
    this.families = data.families ?? new Map();
    this.meta = {
      name: 'TestProject',
      version: '1.0.0',
      author: 'Test',
      description: '',
      runtime: 'c3runtime',
      viewportWidth: 1920,
      viewportHeight: 1080,
      firstLayout: 'Layout 1',
      ...data.metadata,
    };
    this.scriptFiles = data.scriptFiles ?? [];
    this.files = data.files ?? [];
    this.containers = data.containers ?? [];
    this.dataFiles = data.dataFiles ?? [];
    this.addons = data.usedAddons ?? [
      { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
    ];
  }

  async listObjectTypes(): Promise<string[]> {
    return Array.from(this.objects.keys());
  }

  async listEventSheets(): Promise<string[]> {
    return Array.from(this.eventSheets.keys());
  }

  async listLayouts(): Promise<string[]> {
    return Array.from(this.layouts.keys());
  }

  async listFamilies(): Promise<string[]> {
    return Array.from(this.families.keys());
  }

  async readObjectType(name: string): Promise<ObjectType> {
    const obj = this.objects.get(name);
    if (!obj) throw new Error(`Object "${name}" not found`);
    return obj as unknown as ObjectType;
  }

  async readEventSheet(name: string): Promise<EventSheet> {
    const sheet = this.eventSheets.get(name);
    if (!sheet) throw new Error(`Event sheet "${name}" not found`);
    return sheet as unknown as EventSheet;
  }

  async readLayout(name: string): Promise<Layout> {
    const layout = this.layouts.get(name);
    if (!layout) throw new Error(`Layout "${name}" not found`);
    return layout as unknown as Layout;
  }

  async readFamily(name: string): Promise<Record<string, unknown>> {
    const family = this.families.get(name);
    if (!family) throw new Error(`Family "${name}" not found`);
    return family;
  }

  async readAllObjectTypes(): Promise<Map<string, ObjectType>> {
    return this.objects as unknown as Map<string, ObjectType>;
  }

  async readAllEventSheets(): Promise<Map<string, EventSheet>> {
    return this.eventSheets as unknown as Map<string, EventSheet>;
  }

  async readAllLayouts(): Promise<Map<string, Layout>> {
    return this.layouts as unknown as Map<string, Layout>;
  }

  async readAllFamilies(): Promise<Map<string, Record<string, unknown>>> {
    return this.families;
  }

  getMetadata() {
    return this.meta;
  }

  getUsedAddons() {
    return this.addons;
  }

  getProject(): Construct3Project {
    return {
      projectFormatVersion: 1,
      savedWithRelease: 40000,
      name: this.meta.name!,
      runtime: this.meta.runtime!,
      useWorker: 'auto',
      bundleAddons: false,
      usedAddons: this.addons as Construct3Project['usedAddons'],
      uniqueId: 'test-project-id',
      objectTypes: { items: [...Array.from(this.objects.keys()), ...this.registeredOnly.objects], subfolders: [] },
      families: { items: Array.from(this.families.keys()), subfolders: [] },
      layouts: { items: [...Array.from(this.layouts.keys()), ...this.registeredOnly.layouts], subfolders: [] },
      eventSheets: { items: [...Array.from(this.eventSheets.keys()), ...this.registeredOnly.eventSheets], subfolders: [] },
      rootFileFolders: {
        script: this.scriptFolder(),
        sound: this.mediaFolder('sound'),
        music: this.mediaFolder('music'),
        video: this.mediaFolder('video'),
        font: this.mediaFolder('font'),
        icon: this.mediaFolder('icon'),
        general: this.mediaFolder('general'),
      },
      containers: this.containers,
      timelines: { items: [], subfolders: [] },
      properties: {
        description: this.meta.description!,
        version: this.meta.version!,
        autoIncrementVersion: false,
        author: this.meta.author!,
        authorEmail: '',
        authorWebsite: '',
        appId: '',
        pixelRounding: false,
        zAxisScale: 'normalized',
        fov: 45,
        useLoaderLayout: false,
        fullscreenMode: 'letterbox-scale',
        fullscreenQuality: 'high',
        viewportFit: 'auto',
        backgroundColor: [1, 1, 1, 1],
        splashColor: [1, 1, 1, 1],
        useThemeColor: false,
        themeColor: [1, 1, 1, 1],
        orientations: 'any',
        webgpu: 'auto',
        multitexturing: 'auto',
        gpuPreference: 'high-performance',
        scriptsType: 'module',
        framerateMode: 'vsync',
        sampling: 'trilinear',
        downscaling: 'medium',
        renderingMode: 'auto',
        anisotropicFiltering: 'auto',
        zNear: 1,
        zFar: 10000,
        maxSpriteSheetSize: 2048,
        loaderStyle: 'splash',
        preloadSounds: true,
        cordovaiOSScheme: 'app',
        cordovaAndroidScheme: 'https',
        exportFileStructure: 'folders',
        uidAllocationMode: 'increment',
      },
      viewportWidth: this.meta.viewportWidth!,
      viewportHeight: this.meta.viewportHeight!,
      firstLayout: this.meta.firstLayout!,
    };
  }

  getProjectDir(): string {
    return '/mock/project';
  }

  getProjectPath(): string {
    return '/mock/project/project.c3proj';
  }

  async readScriptFile(relativePath: string): Promise<string> {
    const file = this.scriptFiles.find(f => f.path === relativePath);
    if (!file) throw new Error(`Failed to read script "${relativePath}"`);
    return file.source;
  }

  /** rootFileFolders.script built from `scriptFiles` (subfolders from the path). */
  private scriptFolder(): MockScriptFolder {
    const root: MockScriptFolder = { items: [], subfolders: [] };
    for (const [i, file] of this.scriptFiles.entries()) {
      const parts = file.path.split('/');
      const name = parts.pop()!;
      let folder = root;
      for (const part of parts) {
        let sub = folder.subfolders.find(s => s.name === part);
        if (!sub) {
          sub = { name: part, items: [], subfolders: [] };
          folder.subfolders.push(sub);
        }
        folder = sub;
      }
      folder.items.push({
        name,
        type: file.type ?? (name.endsWith('.ts') ? 'application/typescript' : 'application/javascript'),
        sid: 900_000_000_000_000 + i,
        'script-info': { purpose: file.purpose ?? 'none' },
      });
    }
    return root;
  }

  async readProjectFileText(relativePath: string): Promise<string> {
    const file = this.files.find(f => f.folder === 'general' && f.path === relativePath);
    if (file?.text === undefined) throw new Error(`Failed to read project file "${relativePath}"`);
    return file.text;
  }

  async listDataFiles(folder: 'flowcharts' | 'timelines'): Promise<string[]> {
    return this.dataFiles.filter(f => f.folder === folder).map(f => f.path).sort();
  }

  async readDataFileText(folder: 'flowcharts' | 'timelines', relativePath: string): Promise<string> {
    const file = this.dataFiles.find(f => f.folder === folder && f.path === relativePath);
    if (file?.text === undefined) throw new Error(`Failed to read ${folder} file "${relativePath}"`);
    return file.text;
  }

  /** rootFileFolders.<key> built from `files` (subfolders from the path). */
  private mediaFolder(key: MockFileFolderKey): MockScriptFolder {
    const root: MockScriptFolder = { items: [], subfolders: [] };
    for (const [i, file] of this.files.entries()) {
      if (file.folder !== key) continue;
      const parts = file.path.split('/');
      const name = parts.pop()!;
      let folder = root;
      for (const part of parts) {
        let sub = folder.subfolders.find(s => s.name === part);
        if (!sub) {
          sub = { name: part, items: [], subfolders: [] };
          folder.subfolders.push(sub);
        }
        folder = sub;
      }
      folder.items.push({
        name,
        type: 'application/octet-stream',
        sid: 910_000_000_000_000 + i,
        ...(key === 'icon'
          ? { 'icon-info': { purpose: file.purpose ?? 'app-icon' } }
          : { 'file-info': { purpose: file.purpose ?? 'none' } }),
      });
    }
    return root;
  }

  findNearestName(_name: string, _category: 'objects' | 'eventsheets' | 'layouts'): string[] {
    return [];
  }

  searchObjects(pattern: string): string[] {
    const lower = pattern.toLowerCase();
    return Array.from(this.objects.keys()).filter(n => n.toLowerCase().includes(lower));
  }

  getReadFailures(category: string): Map<string, ReadFailure> {
    return this.readFailures.get(category) ?? new Map();
  }

  getEntityRelativePath(category: string, name: string): string {
    return `${category}/${name}.json`;
  }

  async scanEntityIdsRaw(category: EntityCategory, name: string): Promise<{ highestUid: number; sids: number[] }> {
    const key = `${category}/${name}`;
    const forced = this.rawScanErrors.get(key);
    if (forced) throw forced;
    const content = this.rawEntityText.get(key);
    if (content === undefined) throw new Error(`${key}: raw text not available`);
    // The mock only fakes the I/O; the scan itself is the production one.
    return scanIdsInText(content);
  }

  invalidateCaches(): void {
    // no-op for mock
  }

  async reloadProject(): Promise<void> {
    // no-op for mock
  }

  // Helper: add an object at runtime (for tests that build state incrementally)
  addObject(name: string, data: Record<string, unknown>): void {
    this.objects.set(name, data);
  }

  addEventSheet(name: string, data: Record<string, unknown>): void {
    this.eventSheets.set(name, data);
  }

  addLayout(name: string, data: Record<string, unknown>): void {
    this.layouts.set(name, data);
  }

  /**
   * Register a name in c3proj containers without providing data.
   * Simulates a missing file for file-existence tests: like the real reader,
   * the bulk read records E_FILE_NOT_FOUND for it (registerUnreadableEntity
   * simulates a file that exists but cannot be read).
   */
  registerEntityName(category: 'objects' | 'eventSheets' | 'layouts', name: string): void {
    this.registeredOnly[category].push(name);
    const readerCategory = category === 'objects' ? 'objectTypes' : category;
    let failures = this.readFailures.get(readerCategory);
    if (!failures) {
      failures = new Map<string, ReadFailure>();
      this.readFailures.set(readerCategory, failures);
    }
    failures.set(name, {
      code: 'E_FILE_NOT_FOUND',
      message: `ENOENT: no such file or directory, stat '/mock/project/${readerCategory}/${name}.json'`,
    });
  }

  /**
   * Register an entity that is present in c3proj but unreadable by the bulk
   * reader (e.g. over the 10MB cap). It is absent from readAll*(), carries a
   * typed read failure, and (optionally) serves raw text to scanEntityIdsRaw
   * for high-water UID recovery.
   */
  registerUnreadableEntity(
    category: 'objectTypes' | 'layouts',
    name: string,
    failure: ReadFailure,
    rawText?: string
  ): void {
    this.registeredOnly[category === 'objectTypes' ? 'objects' : 'layouts'].push(name);
    let failures = this.readFailures.get(category);
    if (!failures) {
      failures = new Map<string, ReadFailure>();
      this.readFailures.set(category, failures);
    }
    failures.set(name, failure);
    if (rawText !== undefined) {
      this.rawEntityText.set(`${category}/${name}`, rawText);
    }
  }

  registerUnreadableLayout(name: string, failure: ReadFailure, rawText?: string): void {
    this.registerUnreadableEntity('layouts', name, failure, rawText);
  }

  /** Make the raw scan of this entity throw `error` (e.g. an ENOENT-coded fs error). */
  failRawScanWith(category: EntityCategory, name: string, error: Error): void {
    this.rawScanErrors.set(`${category}/${name}`, error);
  }
}
