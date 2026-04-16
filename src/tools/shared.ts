/**
 * Shared utilities for mutation tools.
 * Extracted from mutations.ts to reduce duplication.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { Construct3ProjectWriter } from '../construct3/project-writer.js';
import type { IdGenerator } from '../construct3/id-generator.js';
import { RESERVED_NAMES } from '../construct3/templates.js';

/** Dependency bundle passed to each domain's registerXTools() function. */
export interface MutationToolDeps {
  server: McpServer;
  reader: Construct3ProjectReader;
  writer: Construct3ProjectWriter;
  idGen: IdGenerator;
}

/** Validate that a name is safe for use as a filename and C3 identifier. */
export function validateName(name: string): void {
  if (!name || name.length === 0) {
    throw new Error('Name cannot be empty');
  }
  if (name.length > 200) {
    throw new Error('Name too long (max 200 characters)');
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_ ]*$/.test(name)) {
    throw new Error('Name must start with a letter or underscore and contain only alphanumeric characters, underscores, and spaces');
  }
  // Reserved name check
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`"${name}" is a reserved name in Construct 3 and cannot be used`);
  }
}

/** Validate a subfolder path is safe. */
export function validateSubfolder(subfolder: string): void {
  if (subfolder.includes('..') || subfolder.includes('\\') || subfolder.startsWith('/')) {
    throw new Error('Subfolder path contains invalid characters (use forward slashes only, no "..")');
  }
  const parts = subfolder.split('/');
  for (const part of parts) {
    if (part.length === 0 || part === '.' || part === '..') {
      throw new Error('Subfolder path contains invalid segments');
    }
  }
}

/** Format a successful tool result as MCP content. */
export function toolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** Format an error tool result as MCP content. */
export function toolError(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true as const,
  };
}

/**
 * Build a "not found" toolError response with name suggestions.
 * Replaces the copy-pasted 3-line suggestion block in all mutation tools.
 *
 * @param entityKind  Human-readable entity kind (e.g., 'Object', 'Event sheet', 'Layout')
 * @param name        The name that was not found
 * @param suggestions Names returned by reader.findNearestName()
 * @param listTool    The MCP tool name users can call to see all valid names (e.g., 'list_objects')
 */
export function notFoundError(
  entityKind: string,
  name: string,
  suggestions: string[],
  listTool: string,
): ReturnType<typeof toolError> {
  const hint = suggestions.length > 0
    ? `\nDid you mean: ${suggestions.join(', ')}?`
    : `\nUse ${listTool} to see all available names.`;
  return toolError(`${entityKind} "${name}" not found.${hint}`);
}

// ─── Parameter Naming Convention ────────────────────────────
//
// All MCP tool Zod schemas use the `<entityKind>Name` convention:
//   objectName    — name of the object type (Sprite, Text, etc.)
//   layoutName    — name of the layout
//   sheetName     — name of the event sheet
//   animationName — name of the animation
//   familyName    — name of the family
//   timelineName  — name of the timeline
//   layerName     — name of the layer
//
// Exception: `objectType` in add_instance_to_layout refers to the *kind* of
// object being instantiated (its plugin type identity), not a mutable entity
// name — it is intentionally kept distinct for semantic clarity.
//
// Generic `name` is used only when the tool itself creates an entity (the
// name of the thing being created), e.g., create_layout { name }, create_object { name }.

// ─── Bounded Record Validator ────────────────────────────────

/**
 * Computes the maximum nesting depth of an object value.
 * Returns early once `maxDepth` is exceeded to keep it O(nodes).
 */
function depthOf(value: unknown, maxDepth: number, currentDepth = 0): number {
  if (currentDepth > maxDepth) return currentDepth;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return currentDepth;
  }
  let max = currentDepth;
  for (const v of Object.values(value as Record<string, unknown>)) {
    const d = depthOf(v, maxDepth, currentDepth + 1);
    if (d > max) max = d;
    if (max > maxDepth) return max; // short-circuit
  }
  return max;
}

/**
 * A Zod record validator with explicit key-count and nesting-depth guards.
 * Prevents unbounded payloads from reaching C3 project files.
 *
 * @param maxKeys   Maximum number of top-level keys (default: 100)
 * @param maxDepth  Maximum object nesting depth (default: 6)
 */
export function boundedRecord(maxKeys = 100, maxDepth = 6) {
  return z.record(z.unknown()).superRefine((val, ctx) => {
    const keys = Object.keys(val);
    if (keys.length > maxKeys) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Too many keys: ${keys.length} (max ${maxKeys})`,
      });
    }
    if (depthOf(val, maxDepth) > maxDepth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Object nesting too deep (max depth ${maxDepth})`,
      });
    }
  });
}
