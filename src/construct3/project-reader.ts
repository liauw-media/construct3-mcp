/**
 * Utilities for reading and parsing Construct 3 project files
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, dirname } from 'path';
import type {
  Construct3Project,
  EventSheet,
  ObjectType,
  Layout,
} from './types.js';

export class Construct3ProjectReader {
  private projectPath: string;
  private projectData: Construct3Project | null = null;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /**
   * Load and parse the main project file
   */
  async loadProject(): Promise<Construct3Project> {
    try {
      const projectFile = await readFile(this.projectPath, 'utf-8');
      this.projectData = JSON.parse(projectFile) as Construct3Project;
      return this.projectData;
    } catch (error) {
      throw new Error(
        `Failed to load Construct3 project: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get the loaded project data
   */
  getProject(): Construct3Project {
    if (!this.projectData) {
      throw new Error('Project not loaded. Call loadProject() first.');
    }
    return this.projectData;
  }

  /**
   * Get project directory path
   */
  getProjectDir(): string {
    return dirname(this.projectPath);
  }

  /**
   * Read an event sheet file
   */
  async readEventSheet(name: string): Promise<EventSheet> {
    const eventSheetPath = join(
      this.getProjectDir(),
      'eventSheets',
      `${name}.json`
    );
    try {
      const content = await readFile(eventSheetPath, 'utf-8');
      return JSON.parse(content) as EventSheet;
    } catch (error) {
      throw new Error(
        `Failed to read event sheet "${name}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Read an object type file
   */
  async readObjectType(name: string): Promise<ObjectType> {
    const objectPath = join(
      this.getProjectDir(),
      'objectTypes',
      `${name}.json`
    );
    try {
      const content = await readFile(objectPath, 'utf-8');
      return JSON.parse(content) as ObjectType;
    } catch (error) {
      throw new Error(
        `Failed to read object type "${name}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Read a layout file
   */
  async readLayout(name: string): Promise<Layout> {
    const layoutPath = join(this.getProjectDir(), 'layouts', `${name}.json`);
    try {
      const content = await readFile(layoutPath, 'utf-8');
      return JSON.parse(content) as Layout;
    } catch (error) {
      throw new Error(
        `Failed to read layout "${name}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * List all event sheets
   */
  async listEventSheets(): Promise<string[]> {
    const project = this.getProject();
    return project.eventSheets.items;
  }

  /**
   * List all object types
   */
  async listObjectTypes(): Promise<string[]> {
    const project = this.getProject();
    return project.objectTypes.items;
  }

  /**
   * List all layouts
   */
  async listLayouts(): Promise<string[]> {
    const project = this.getProject();
    return project.layouts.items;
  }

  /**
   * List all families
   */
  async listFamilies(): Promise<string[]> {
    const project = this.getProject();
    return project.families.items;
  }

  /**
   * Get project metadata
   */
  getMetadata() {
    const project = this.getProject();
    return {
      name: project.name,
      version: project.properties.version,
      author: project.properties.author,
      description: project.properties.description,
      runtime: project.runtime,
      viewportWidth: project.viewportWidth,
      viewportHeight: project.viewportHeight,
      firstLayout: project.firstLayout,
    };
  }

  /**
   * Get all used addons (plugins and behaviors)
   */
  getUsedAddons() {
    const project = this.getProject();
    return project.usedAddons;
  }

  /**
   * Search for objects by name pattern
   */
  searchObjects(pattern: string): string[] {
    const project = this.getProject();
    const lowerPattern = pattern.toLowerCase();
    return project.objectTypes.items.filter((obj) =>
      obj.toLowerCase().includes(lowerPattern)
    );
  }

  /**
   * Check if project file exists and is valid
   */
  static async isValidProject(projectPath: string): Promise<boolean> {
    try {
      const stats = await stat(projectPath);
      if (!stats.isFile() || !projectPath.endsWith('.c3proj')) {
        return false;
      }
      const content = await readFile(projectPath, 'utf-8');
      const data = JSON.parse(content);
      return (
        typeof data === 'object' &&
        data !== null &&
        'projectFormatVersion' in data &&
        'name' in data
      );
    } catch {
      return false;
    }
  }

  /**
   * Find project file in a directory
   */
  static async findProjectFile(directory: string): Promise<string | null> {
    try {
      const files = await readdir(directory);
      const c3projFile = files.find((file) => file.endsWith('.c3proj'));
      return c3projFile ? join(directory, c3projFile) : null;
    } catch {
      return null;
    }
  }
}
