/**
 * In-memory mock of Construct3ProjectReader for testing.
 * No filesystem I/O — all data supplied via constructor.
 */

import type { Construct3Project, EventSheet, ObjectType, Layout } from '../../src/construct3/types.js';

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
}

export class MockReader {
  private objects: Map<string, Record<string, unknown>>;
  private eventSheets: Map<string, Record<string, unknown>>;
  private layouts: Map<string, Record<string, unknown>>;
  private families: Map<string, Record<string, unknown>>;
  private meta: NonNullable<MockReaderData['metadata']>;
  private addons: NonNullable<MockReaderData['usedAddons']>;

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
      objectTypes: { items: Array.from(this.objects.keys()), subfolders: [] },
      families: { items: Array.from(this.families.keys()), subfolders: [] },
      layouts: { items: Array.from(this.layouts.keys()), subfolders: [] },
      eventSheets: { items: Array.from(this.eventSheets.keys()), subfolders: [] },
      rootFileFolders: {
        script: { items: [], subfolders: [] },
        sound: { items: [], subfolders: [] },
        music: { items: [], subfolders: [] },
        video: { items: [], subfolders: [] },
        font: { items: [], subfolders: [] },
        icon: { items: [], subfolders: [] },
        general: { items: [], subfolders: [] },
      },
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

  findNearestName(_name: string, _category: 'objects' | 'eventsheets' | 'layouts'): string[] {
    return [];
  }

  searchObjects(pattern: string): string[] {
    const lower = pattern.toLowerCase();
    return Array.from(this.objects.keys()).filter(n => n.toLowerCase().includes(lower));
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
}
