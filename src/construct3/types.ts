/**
 * TypeScript type definitions for Construct 3 project structures
 */

// ─── Project Root ───────────────────────────────────────────

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

// ─── Container Types ────────────────────────────────────────

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

// ─── File Folders ───────────────────────────────────────────

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

// ─── Project Properties ─────────────────────────────────────

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

// ─── Event Sheet Types (Discriminated Unions) ───────────────

export interface EventSheet {
  name: string;
  events: C3Event[];
}

/** Condition within an event block */
export interface Condition {
  id: string;
  objectClass: string;
  sid: number;
  'behavior-type'?: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Standard action referencing an object */
export interface StandardAction {
  id: string;
  objectClass: string;
  sid: number;
  'behavior-type'?: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Function call action */
export interface FunctionCallAction {
  id: string;
  objectClass: string;
  sid: number;
  callFunction?: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Script action */
export interface ScriptAction {
  type: 'script';
  script: string;
  [key: string]: unknown;
}

export type Action = StandardAction | FunctionCallAction | ScriptAction;

/** Block event — the most common: has conditions, actions, optional children */
export interface BlockEvent {
  eventType: 'block';
  conditions: Condition[];
  actions: Action[];
  children?: C3Event[];
  sid?: number;
  disabled?: boolean;
  [key: string]: unknown;
}

/** Variable declaration event */
export interface VariableEvent {
  eventType: 'variable';
  name: string;
  type: string;
  initialValue: string;
  comment?: string;
  sid?: number;
  isStatic?: boolean;
  isConstant?: boolean;
  [key: string]: unknown;
}

/** Function block event — defines a function */
export interface FunctionBlockEvent {
  eventType: 'function-block';
  functionName?: string;
  conditions: Condition[];
  actions: Action[];
  children?: C3Event[];
  parameters?: Array<{ name: string; type: string }>;
  sid?: number;
  [key: string]: unknown;
}

/** Group event — organizes events into named groups */
export interface GroupEvent {
  eventType: 'group';
  title: string;
  disabled?: boolean;
  isActiveOnStart?: boolean;
  children: C3Event[];
  sid?: number;
  [key: string]: unknown;
}

/** Include event — includes another event sheet */
export interface IncludeEvent {
  eventType: 'include';
  includeSheet: string;
  [key: string]: unknown;
}

/** Comment event */
export interface CommentEvent {
  eventType: 'comment';
  text: string;
  [key: string]: unknown;
}

/** Script block event — inline JavaScript */
export interface ScriptEvent {
  eventType: 'script';
  script: string;
  [key: string]: unknown;
}

/** Catch-all for unknown event types */
export interface UnknownEvent {
  eventType: string;
  [key: string]: unknown;
}

export type C3Event =
  | BlockEvent
  | VariableEvent
  | FunctionBlockEvent
  | GroupEvent
  | IncludeEvent
  | CommentEvent
  | ScriptEvent
  | UnknownEvent;

// ─── Object & Layout Types ─────────────────────────────────

export interface ObjectType {
  name: string;
  'plugin-id': string;
  sid: number;
  'is-global'?: boolean;
  instanceVariables?: Record<string, unknown>;
  behaviors?: Array<{ 'behavior-type': string; [key: string]: unknown }>;
  animations?: Array<{
    frames: Array<{ width: number; height: number; [key: string]: unknown }>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface Layout {
  name: string;
  layers: Layer[];
  sid: number;
  'event-sheet'?: string;
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

// ─── Analysis Result Types ──────────────────────────────────

/** A reference to an object found in an event sheet */
export interface ObjectReference {
  objectName: string;
  eventSheet: string;
  path: string; // e.g., "group:CheckBigWin > block:3 > action:2"
  context: 'condition' | 'action';
}

/** Node in the event sheet flow graph */
export interface EventSheetFlowNode {
  name: string;
  includes: string[];
  includedBy: string[];
  layout?: string;
  eventCount: number;
  functionCount: number;
  groupCount: number;
}

/** Node in the object dependency graph */
export interface ObjectDependencyNode {
  objectName: string;
  referencedIn: {
    eventSheets: string[];
    layouts: string[];
  };
  families: string[];
  coOccursWith: string[];
  referenceCount: number;
}

/** Performance issue found by heuristic analysis */
export interface PerformanceIssue {
  severity: 'info' | 'warning' | 'critical';
  category: string;
  location: string;
  message: string;
  suggestion: string;
}

/** Asset usage information */
export interface AssetUsageInfo {
  name: string;
  type: 'sound' | 'music' | 'image' | 'font' | 'video' | 'icon' | 'general';
  referencedIn: {
    eventSheets: string[];
    layouts: string[];
  };
  isGlobal: boolean;
}

// ─── Write Result Types ────────────────────────────────────

/** Result of a write operation */
export interface WriteResult {
  success: boolean;
  entity: string;
  category: string;
  action: string;
  generatedSid?: number;
  generatedUid?: number;
  warnings?: string[];
  backupFile?: string;
}

/** Result of checking references before deletion */
export interface ReferenceCheckResult {
  safe: boolean;
  references: {
    eventSheets: string[];
    layouts: string[];
    families: string[];
  };
}
