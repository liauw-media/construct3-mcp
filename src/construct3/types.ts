/**
 * TypeScript type definitions for Construct 3 project structures
 */

export interface Construct3Project {
  projectFormatVersion: number;
  savedWithRelease: number;
  name: string;
  runtime: string;
  useWorker: string;
  bundleAddons: boolean;
  usedAddons: Addon[];
  uniqueId: string;
  objectTypes: ObjectTypesContainer;
  families: FamiliesContainer;
  layouts: LayoutsContainer;
  eventSheets: EventSheetsContainer;
  rootFileFolders: RootFileFolders;
  timelines: TimelinesContainer;
  properties: ProjectProperties;
  viewportWidth: number;
  viewportHeight: number;
  firstLayout: string;
}

export interface Addon {
  type: 'plugin' | 'behavior' | 'effect';
  id: string;
  name: string;
  author: string;
  bundled: boolean;
  version?: string;
  sdkVersion?: number;
}

export interface ObjectTypesContainer {
  items: string[];
  subfolders: Subfolder[];
}

export interface FamiliesContainer {
  items: string[];
  subfolders: Subfolder[];
}

export interface LayoutsContainer {
  items: string[];
  subfolders: Subfolder[];
}

export interface EventSheetsContainer {
  items: string[];
  subfolders: Subfolder[];
}

export interface TimelinesContainer {
  items: string[];
  subfolders: Subfolder[];
}

export interface Subfolder {
  items: string[];
  subfolders: Subfolder[];
  name: string;
}

export interface RootFileFolders {
  script: FileFolder;
  sound: FileFolder;
  music: FileFolder;
  video: FileFolder;
  font: FileFolder;
  icon: FileFolder;
  general: FileFolder;
}

export interface FileFolder {
  items: FileItem[];
  subfolders: FileFolderSubfolder[];
}

export interface FileFolderSubfolder {
  items: FileItem[];
  subfolders: FileFolderSubfolder[];
  name: string;
}

export interface FileItem {
  name: string;
  type: string;
  sid: number;
  'file-info'?: {
    purpose: string;
  };
  'icon-info'?: {
    purpose: string;
  };
}

export interface ProjectProperties {
  description: string;
  version: string;
  autoIncrementVersion: boolean;
  author: string;
  authorEmail: string;
  authorWebsite: string;
  appId: string;
  pixelRounding: boolean;
  zAxisScale: string;
  fov: number;
  useLoaderLayout: boolean;
  fullscreenMode: string;
  fullscreenQuality: string;
  viewportFit: string;
  backgroundColor: number[];
  splashColor: number[];
  useThemeColor: boolean;
  themeColor: number[];
  orientations: string;
  webgpu: string;
  gpuPreference: string;
  scriptsType: string;
  framerateMode: string;
  sampling: string;
  downscaling: string;
  renderingMode: string;
  anisotropicFiltering: string;
  zNear: number;
  zFar: number;
  maxSpriteSheetSize: number;
  loaderStyle: string;
  preloadSounds: boolean;
  cordovaiOSScheme: string;
  cordovaAndroidScheme: string;
  exportFileStructure: string;
  uidAllocationMode: string;
}

export interface EventSheet {
  name: string;
  events: Event[];
}

export interface Event {
  eventType: string;
  [key: string]: unknown;
}

export interface ObjectType {
  name: string;
  'plugin-id': string;
  sid: number;
  [key: string]: unknown;
}

export interface Layout {
  name: string;
  layers: Layer[];
  sid: number;
  [key: string]: unknown;
}

export interface Layer {
  name: string;
  sid: number;
  instances: Instance[];
  [key: string]: unknown;
}

export interface Instance {
  type: string;
  properties: Record<string, unknown>;
  uid: number;
  sid: number;
  [key: string]: unknown;
}
