/**
 * Group settings analyzer for Construct 3 projects.
 * Extracts all groups from all event sheets with their isActiveOnStart,
 * disabled status, and nesting hierarchy.
 */

import type { Construct3ProjectReader } from '../project-reader.js';
import type { C3Event, GroupEvent } from '../types.js';

export interface GroupInfo {
  title: string;
  eventSheet: string;
  isActiveOnStart: boolean;
  disabled: boolean;
  depth: number;
  parentGroup?: string;
  childGroupCount: number;
  childEventCount: number;
}

export interface GroupSettingsResult {
  groups: GroupInfo[];
  summary: {
    totalGroups: number;
    activeOnStart: number;
    inactiveOnStart: number;
    disabled: number;
  };
  bySheet: Record<string, GroupInfo[]>;
}

function isGroupEvent(event: C3Event): event is GroupEvent {
  return event.eventType === 'group';
}

function extractGroups(
  events: C3Event[],
  sheetName: string,
  depth: number,
  parentGroup?: string,
): GroupInfo[] {
  const groups: GroupInfo[] = [];
  if (!Array.isArray(events)) return groups;

  for (const event of events) {
    if (isGroupEvent(event)) {
      const childGroups = event.children
        ? extractGroups(event.children, sheetName, depth + 1, event.title)
        : [];

      groups.push({
        title: event.title,
        eventSheet: sheetName,
        isActiveOnStart: event.isActiveOnStart ?? true,
        disabled: event.disabled ?? false,
        depth,
        parentGroup,
        childGroupCount: childGroups.length,
        childEventCount: event.children ? event.children.length : 0,
      });

      groups.push(...childGroups);
    }

    // Also check children of non-group events (blocks, functions)
    if ('children' in event && Array.isArray((event as Record<string, unknown>).children)) {
      groups.push(
        ...extractGroups(
          (event as Record<string, unknown>).children as C3Event[],
          sheetName,
          depth,
          parentGroup,
        ),
      );
    }
  }

  return groups;
}

/**
 * Get all group settings across the project.
 */
export async function getGroupSettings(
  reader: Construct3ProjectReader,
  options?: { eventsheet?: string; activeOnly?: boolean; inactiveOnly?: boolean },
): Promise<GroupSettingsResult> {
  const allGroups: GroupInfo[] = [];

  if (options?.eventsheet) {
    // Single event sheet
    const sheet = await reader.readEventSheet(options.eventsheet);
    allGroups.push(...extractGroups(sheet.events, options.eventsheet, 0));
  } else {
    // All event sheets
    const sheets = await reader.readAllEventSheets();
    for (const [name, sheet] of sheets) {
      if (Array.isArray(sheet.events)) {
        allGroups.push(...extractGroups(sheet.events, name, 0));
      }
    }
  }

  // Apply filters
  let filtered = allGroups;
  if (options?.activeOnly) {
    filtered = filtered.filter(g => g.isActiveOnStart);
  }
  if (options?.inactiveOnly) {
    filtered = filtered.filter(g => !g.isActiveOnStart);
  }

  // Build by-sheet map
  const bySheet: Record<string, GroupInfo[]> = {};
  for (const group of filtered) {
    if (!bySheet[group.eventSheet]) bySheet[group.eventSheet] = [];
    bySheet[group.eventSheet].push(group);
  }

  return {
    groups: filtered,
    summary: {
      totalGroups: filtered.length,
      activeOnStart: filtered.filter(g => g.isActiveOnStart).length,
      inactiveOnStart: filtered.filter(g => !g.isActiveOnStart).length,
      disabled: filtered.filter(g => g.disabled).length,
    },
    bySheet,
  };
}
