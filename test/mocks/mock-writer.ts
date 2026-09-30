/**
 * Mock writer that records calls without filesystem I/O.
 */

export interface WriterCall {
  method: string;
  args: unknown[];
}

export class MockWriter {
  calls: WriterCall[] = [];

  async writeEntityFile(
    category: string,
    name: string,
    data: unknown,
    subfolder?: string,
    options?: { createOnly?: boolean },
  ): Promise<string> {
    this.calls.push({ method: 'writeEntityFile', args: [category, name, data, subfolder, options] });
    return `/mock/backup/${category}/${name}.json.bak`;
  }

  async entityFileRefusal(
    category: string,
    name: string,
    subfolder?: string,
  ): Promise<string | undefined> {
    this.calls.push({ method: 'entityFileRefusal', args: [category, name, subfolder] });
    return undefined;
  }

  async deleteEntityFile(
    category: string,
    name: string,
    subfolder?: string,
  ): Promise<string> {
    this.calls.push({ method: 'deleteEntityFile', args: [category, name, subfolder] });
    return `/mock/backup/${category}/${name}.json.bak`;
  }

  async addToProject(
    category: string,
    name: string,
    subfolder?: string,
  ): Promise<void> {
    this.calls.push({ method: 'addToProject', args: [category, name, subfolder] });
  }

  async removeFromProject(
    category: string,
    name: string,
  ): Promise<void> {
    this.calls.push({ method: 'removeFromProject', args: [category, name] });
  }

  async updateProjectProperties(updates: Record<string, unknown>): Promise<string> {
    this.calls.push({ method: 'updateProjectProperties', args: [updates] });
    return '/mock/backup/project.c3proj.bak';
  }

  async ensureAddonRegistered(
    type: 'plugin' | 'behavior',
    id: string,
  ): Promise<string | undefined> {
    this.calls.push({ method: 'ensureAddonRegistered', args: [type, id] });
    return undefined;
  }

  checkAddonRegistrable(_type: 'plugin' | 'behavior', _id: string): void {
    // every addon is registrable in the mock
  }

  async assertProjectFileCurrent(): Promise<void> {
    // the mock has no project file that could change
  }

  getSubfolderForEntity(
    _category: string,
    _name: string,
  ): string | undefined {
    return undefined;
  }

  async writeImageFile(
    objectName: string,
    animationName: string,
    frameIndex: number,
    pluginId?: string,
    width?: number,
    height?: number,
  ): Promise<string> {
    this.calls.push({ method: 'writeImageFile', args: [objectName, animationName, frameIndex, pluginId, width, height] });
    return `/mock/project/images/${objectName}-${animationName}-${String(frameIndex).padStart(3, '0')}.png`.toLowerCase();
  }

  async writeImageFiles(
    files: Array<{
      objectName: string;
      animationName: string;
      frameIndex: number;
      pluginId?: string;
      width?: number;
      height?: number;
    }>,
  ): Promise<string[]> {
    this.calls.push({ method: 'writeImageFiles', args: [files] });
    return files.map(f =>
      `/mock/project/images/${f.objectName}-${f.animationName}-${String(f.frameIndex).padStart(3, '0')}.png`.toLowerCase()
    );
  }

  /** Entries of images/ that listImageFiles returns */
  imageFiles: string[] = [];

  async listImageFiles(): Promise<string[]> {
    this.calls.push({ method: 'listImageFiles', args: [] });
    return [...this.imageFiles];
  }

  async renameImageFiles(renames: ReadonlyArray<{ from: string; to: string }>): Promise<void> {
    this.calls.push({ method: 'renameImageFiles', args: [renames.map(r => ({ ...r }))] });
  }

  async restoreEntityFile(backupPath: string): Promise<void> {
    this.calls.push({ method: 'restoreEntityFile', args: [backupPath] });
  }

  /** The mock changes no files, so undoing a tool call puts nothing back */
  async undoToolCall(): Promise<{ restored: string[]; left: Array<{ label: string; backup: string | null }> }> {
    this.calls.push({ method: 'undoToolCall', args: [] });
    return { restored: [], left: [] };
  }

  async deleteImageFile(name: string): Promise<boolean> {
    this.calls.push({ method: 'deleteImageFile', args: [name] });
    return false;
  }

  /** Runs `fn` right away (the real writer runs the calls one at a time) */
  async withAnimationLock<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  // Helper: get calls for a specific method
  callsFor(method: string): WriterCall[] {
    return this.calls.filter(c => c.method === method);
  }

  // Helper: reset all recorded calls
  reset(): void {
    this.calls = [];
  }
}
