/**
 * Asset usage tracking across the project.
 */

import type { Construct3ProjectReader } from '../project-reader.js';
import type { FileFolder, FileFolderSubfolder, FileItem, AssetUsageInfo } from '../types.js';
import { getProjectIndex } from './index-builder.js';

export type AssetType = 'sound' | 'music' | 'image' | 'font' | 'video' | 'icon' | 'general' | 'all';

export interface AssetUsageResult {
  summary: {
    totalAssets: number;
    byType: Record<string, number>;
    unusedCount: number;
    mostReferenced: Array<{ name: string; type: string; referenceCount: number }>;
  };
  assets?: AssetUsageInfo[];
}

/**
 * Track asset usage across the project.
 */
export async function getAssetUsage(
  reader: Construct3ProjectReader,
  options: {
    type?: AssetType;
    detail?: 'summary' | 'standard' | 'full';
  } = {}
): Promise<AssetUsageResult> {
  const index = await getProjectIndex(reader);
  const project = reader.getProject();
  const detail = options.detail || 'standard';
  const filterType = options.type || 'all';

  // Collect all assets from rootFileFolders
  const allAssets: Array<{ name: string; type: string; item: FileItem }> = [];

  const folderTypes: Array<{ key: keyof typeof project.rootFileFolders; type: string }> = [
    { key: 'sound', type: 'sound' },
    { key: 'music', type: 'music' },
    { key: 'video', type: 'video' },
    { key: 'font', type: 'font' },
    { key: 'icon', type: 'icon' },
    { key: 'general', type: 'general' },
  ];

  for (const { key, type } of folderTypes) {
    if (filterType !== 'all' && filterType !== type) continue;
    const folder = project.rootFileFolders[key];
    if (folder) {
      collectAssets(folder, type, allAssets);
    }
  }

  // Also collect image assets from object animations (sprites)
  if (filterType === 'all' || filterType === 'image') {
    const objectTypes = await reader.readAllObjectTypes();
    for (const [objName, objData] of objectTypes) {
      if (objData.animations && Array.isArray(objData.animations)) {
        for (const anim of objData.animations) {
          if (anim.frames && Array.isArray(anim.frames)) {
            allAssets.push({
              name: `${objName} (sprite: ${anim.frames.length} frames)`,
              type: 'image',
              item: { name: objName, type: 'image', sid: 0 },
            });
          }
        }
      }
    }
  }

  // Determine usage for each asset by checking object references
  const assetUsages: AssetUsageInfo[] = [];
  const objectNames = new Set(index.allObjects);

  for (const asset of allAssets) {
    const eventSheets: string[] = [];
    const layouts: string[] = [];
    let isGlobal = false;

    // Check if the asset name matches an object name
    const baseName = asset.item.name;
    if (objectNames.has(baseName)) {
      const objSheets = index.getEventSheetsForObject(baseName);
      eventSheets.push(...objSheets);
      const objLayouts = index.objectToLayouts.get(baseName) || [];
      layouts.push(...objLayouts);

      // Check if object is global
      const objectTypes = await reader.readAllObjectTypes();
      const objData = objectTypes.get(baseName);
      if (objData?.['is-global'] === true) {
        isGlobal = true;
      }
    }

    assetUsages.push({
      name: asset.name,
      type: asset.type as AssetUsageInfo['type'],
      referencedIn: { eventSheets, layouts },
      isGlobal,
    });
  }

  // Build summary
  const byType: Record<string, number> = {};
  for (const asset of allAssets) {
    byType[asset.type] = (byType[asset.type] || 0) + 1;
  }

  const unusedCount = assetUsages.filter(
    a => a.referencedIn.eventSheets.length === 0 && a.referencedIn.layouts.length === 0
  ).length;

  // Most referenced
  const sorted = [...assetUsages]
    .map(a => ({
      name: a.name,
      type: a.type,
      referenceCount: a.referencedIn.eventSheets.length + a.referencedIn.layouts.length,
    }))
    .sort((a, b) => b.referenceCount - a.referenceCount);

  const result: AssetUsageResult = {
    summary: {
      totalAssets: allAssets.length,
      byType,
      unusedCount,
      mostReferenced: sorted.slice(0, 10),
    },
  };

  if (detail !== 'summary') {
    result.assets = detail === 'full' ? assetUsages : assetUsages.slice(0, 50);
  }

  return result;
}

function collectAssets(
  folder: FileFolder,
  type: string,
  out: Array<{ name: string; type: string; item: FileItem }>
): void {
  for (const item of folder.items) {
    out.push({ name: item.name, type, item });
  }
  for (const sub of folder.subfolders) {
    collectSubfolderAssets(sub, type, out);
  }
}

function collectSubfolderAssets(
  subfolder: FileFolderSubfolder,
  type: string,
  out: Array<{ name: string; type: string; item: FileItem }>
): void {
  for (const item of subfolder.items) {
    out.push({ name: `${subfolder.name}/${item.name}`, type, item });
  }
  for (const sub of subfolder.subfolders) {
    collectSubfolderAssets(sub, type, out);
  }
}
