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
  ): Promise<string> {
    this.calls.push({ method: 'writeEntityFile', args: [category, name, data, subfolder] });
    return `/mock/backup/${category}/${name}.json.bak`;
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
    return `/mock/project/images/${objectName.toLowerCase()}-${animationName}-${String(frameIndex).padStart(3, '0')}.png`;
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
      `/mock/project/images/${f.objectName.toLowerCase()}-${f.animationName}-${String(f.frameIndex).padStart(3, '0')}.png`
    );
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
