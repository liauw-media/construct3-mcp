# API Reference

Complete reference for all resources, tools, and prompts provided by the Construct3 MCP Server.

## Table of Contents

- [Resources](#resources)
- [Query Tools](#query-tools)
- [Analysis Tools](#analysis-tools)
- [Mutation Tools](#mutation-tools)
- [Prompts](#prompts)
- [Error Handling](#error-handling)
- [Type Definitions](#type-definitions)

---

## Resources

Resources provide read-only access to project data.

### `construct3://project/info`

Project metadata and basic info.

**Response:**
```json
{
  "name": "My Game",
  "version": "1.0.0",
  "author": "Developer",
  "runtime": "c3",
  "viewportWidth": 1920,
  "viewportHeight": 1080,
  "firstLayout": "Main"
}
```

### `construct3://project/structure`

Complete project structure with entity counts and folder hierarchy.

### `construct3://project/addons`

All used plugins, behaviors, and effects with metadata.

### `construct3://objects/{name}`

Full JSON for a specific object type.

### `construct3://eventsheets/{name}`

Full JSON for a specific event sheet.

### `construct3://layouts/{name}`

Full JSON for a specific layout.

### `construct3://docs/manual/{topic}`

Official Construct 3 documentation fetched from construct.net.

---

## Query Tools

### `list_objects`

List all object types with optional name filtering.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filter` | string | No | Case-insensitive name filter |

### `list_eventsheets`

List all event sheets. No parameters.

### `list_layouts`

List all layouts. No parameters.

### `list_families`

List all object families. No parameters.

### `get_object_details`

Get full details for a specific object type.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Object name (fuzzy suggestions on miss) |

### `get_eventsheet_details`

Get full details for a specific event sheet.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Event sheet name |

### `get_layout_details`

Get full details for a specific layout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Layout name |

### `search_objects`

Search objects by name pattern (case-insensitive substring match).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | Yes | Search pattern |

### `get_project_summary`

Comprehensive project overview including metadata, statistics, addon counts, and entity lists. No parameters.

---

## Analysis Tools

All analysis tools support an optional `detail` parameter: `"summary"`, `"normal"` (default), or `"full"`.

### `get_eventsheet_flow`

Event sheet include hierarchy and layout bindings.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `eventsheet` | string | No | Start from a specific sheet (omit for full project) |
| `format` | `"mermaid"` \| `"json"` | No | Output format (default: mermaid) |
| `detail` | string | No | Detail level |

### `get_function_map`

Function definitions and call sites across event sheets.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `eventsheet` | string | No | Filter to a specific event sheet |
| `detail` | string | No | Detail level |

### `get_object_dependencies`

Where objects are used: event sheets, layouts, families, co-occurring objects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `object` | string | No | Specific object (omit for project-wide top 20) |
| `detail` | string | No | Detail level |

### `find_orphaned_objects`

Find objects not referenced in any event sheet or placed in any layout. No parameters.

### `get_asset_usage`

Track asset usage across the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"sound"` \| `"music"` \| `"image"` \| `"font"` \| `"video"` \| `"icon"` \| `"general"` \| `"all"` | No | Filter by asset type (default: all) |
| `detail` | string | No | Detail level |

### `analyze_performance`

Heuristic performance audit with categorized issues (info/warning/critical).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `scope` | string | No | Event sheet or layout name to scope analysis |
| `detail` | string | No | Detail level |

---

## Mutation Tools

All mutation tools follow the safety pipeline: validate → backup → write → verify → invalidate caches. They return a `WriteResult` object on success.

### `create_object`

Create a new object type in the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Object name (unique, alphanumeric + underscore + spaces) |
| `pluginId` | string | Yes | Plugin ID: `"Sprite"`, `"Text"`, `"TiledBg"`, `"NinePatch"`, `"Audio"`, etc. |
| `isGlobal` | boolean | No | Auto-detected for known global plugins |
| `subfolder` | string | No | Subfolder path (e.g., `"UI/Buttons"`) |

**What it does:**
1. Validates name (uniqueness, reserved names, format)
2. Ensures plugin is registered in `usedAddons` (auto-adds known Scirra plugins)
3. Generates SID (+ UID for global plugins, + animation SID for Sprite)
4. Builds from plugin-specific template
5. Writes `objectTypes/<name>.json`
6. Adds name to `project.c3proj` objectTypes container

### `update_object_properties`

Update an existing object's instance variables and behaviors.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Existing object name |
| `isGlobal` | boolean | No | Change global status |
| `addVariables` | array | No | `[{ name, type: "number"\|"string"\|"boolean" }]` |
| `removeVariables` | string[] | No | Variable names to remove |
| `addBehaviors` | array | No | `[{ behaviorId: "Tween"\|"Sin"\|etc., name }]` |
| `removeBehaviors` | string[] | No | Behavior names to remove |

**Notes:**
- Reads the full existing object and preserves all fields not being modified
- Validates behavior addon registration (auto-adds known Scirra behaviors)
- Generates unique SIDs for each new variable and behavior
- Warns on duplicate variable/behavior names (skips them)

### `delete_object`

Delete an object type from the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Object name to delete |
| `force` | boolean | No | Delete even if referenced (default: false) |

**Behavior:**
- Checks for references in event sheets, layouts, and families
- If referenced and `force=false`: returns the reference list and blocks
- If referenced and `force=true`: deletes with warning (references NOT cleaned up)
- Backs up the JSON file and removes from c3proj

### `create_event_sheet`

Create a new event sheet.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Event sheet name |
| `subfolder` | string | No | Subfolder path |
| `includeSheets` | string[] | No | Sheets to auto-include (validated for existence) |

### `add_event_to_sheet`

Add a structural event to an existing event sheet.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `eventType` | enum | Yes | `"group"` \| `"function"` \| `"variable"` \| `"include"` \| `"comment"` |
| `title` | string | For groups | Group title |
| `functionName` | string | For functions | Function name |
| `functionParams` | array | For functions | `[{ name, type }]` |
| `variableName` | string | For variables | Variable name |
| `variableType` | enum | For variables | `"number"` \| `"string"` \| `"boolean"` |
| `initialValue` | string | For variables | Initial value |
| `includeSheet` | string | For includes | Sheet to include (validated) |
| `commentText` | string | For comments | Comment text |
| `position` | enum | No | `"start"` \| `"end"` (default: end) |

### `add_event_block`

Add a block event (conditions + actions) to an event sheet — the core of gameplay logic.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `conditions` | array | Yes | Conditions (min 1). Each: `{ id, objectClass, "behavior-type"?, parameters?, isInverted? }` |
| `actions` | array | No | Actions (default: `[]`). Standard: `{ id, objectClass, "behavior-type"?, parameters?, callFunction? }`. Script: `{ type: "script", script }` |
| `groupPath` | string | No | Insert inside group by title path (e.g., `"Movement > Collision"`) |
| `position` | enum | No | `"start"` \| `"end"` (default: end) |
| `disabled` | boolean | No | Create the block disabled (default: false) |

**Validation:**
- `objectClass` is hard-validated against project objects, families, and `"System"`
- `behavior-type` is soft-validated (warning only, since behaviors may come from families)
- `id` (ACE identifier) is **not** validated — Claude knows the hundreds of C3 ACE IDs
- Script actions (`type: "script"`) skip objectClass validation and SID generation

**What it does:**
1. Reads the target event sheet
2. Validates all `objectClass` references
3. Generates SIDs for the block + each condition + each standard action
4. Builds condition/action objects with optional fields (`behavior-type`, `parameters`, `isInverted`, `callFunction`)
5. If `groupPath`: resolves nested group path (error with available groups on miss)
6. Inserts at position (`start`/`end`)
7. Writes sheet back with backup

### `create_layout`

Create a new layout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Layout name |
| `width` | number | No | Width in pixels (default: project viewport width) |
| `height` | number | No | Height in pixels (default: project viewport height) |
| `eventSheet` | string | No | Linked event sheet name (validated) |
| `layers` | string[] | No | Layer names (default: single `"Layer 0"`) |

### `add_instance_to_layout`

Place an object instance on a layout layer.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Target layout |
| `layerName` | string | Yes | Target layer |
| `objectType` | string | Yes | Object type to place |
| `x` | number | Yes | X position |
| `y` | number | Yes | Y position |
| `width` | number | No | Instance width (default: 100) |
| `height` | number | No | Instance height (default: 100) |
| `properties` | object | No | Plugin-specific properties (auto-filled for known plugins) |

**Notes:**
- Blocks global-only objects (singleglobal-inst) from being placed
- Auto-fills default instance properties for Sprite, Text, TiledBg, NinePatch
- Warns when placing instances of unknown plugin types

### `update_project_metadata`

Update project-level metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | No | Project name |
| `version` | string | No | Project version |
| `author` | string | No | Author name |
| `description` | string | No | Project description |

At least one parameter must be provided.

### `add_animation_to_sprite`

Add a new animation to a Sprite object.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name (e.g., `"Idle"`, `"Walk"`) |
| `speed` | number | No | Frames per second (default: 5) |
| `isLooping` | boolean | No | Loop the animation (default: true) |
| `isPingPong` | boolean | No | Ping-pong playback (default: false) |
| `repeatCount` | number | No | Repeat count if not looping (default: 1) |
| `frameCount` | number | No | Number of blank frames to create (default: 1) |
| `frameWidth` | number | No | Frame width in pixels (default: existing sprite width) |
| `frameHeight` | number | No | Frame height in pixels (default: existing sprite height) |

**Notes:**
- Validates the object is a Sprite plugin (rejects non-Sprite objects)
- Checks animation name uniqueness within the sprite
- Frame dimensions default to the existing first animation's frame size

### `update_animation_properties`

Update properties of an existing animation on a Sprite object.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name to modify |
| `speed` | number | No | New speed (frames per second) |
| `isLooping` | boolean | No | New loop setting |
| `isPingPong` | boolean | No | New ping-pong setting |
| `repeatCount` | number | No | New repeat count |

At least one property must be provided.

---

## Prompts

### `analyze_project`

Analyze project structure, naming conventions, and organization.

### `find_object_usage`

Find where a specific object is referenced. Parameter: `objectName`.

### `explain_eventsheet`

Explain how an event sheet works. Parameter: `eventSheetName`.

### `review_game_logic`

Review overall game logic architecture.

### `document_object`

Generate documentation for an object. Parameter: `objectName`.

### `optimize_project`

Get optimization suggestions.

---

## Error Handling

### Success Response

```json
{
  "content": [{ "type": "text", "text": "{...JSON result...}" }]
}
```

### Error Response

```json
{
  "content": [{ "type": "text", "text": "Error: message" }],
  "isError": true
}
```

### WriteResult

Mutation tools return this structure on success:

```typescript
interface WriteResult {
  success: boolean;
  entity: string;        // name of the entity
  category: string;      // "object" | "eventsheet" | "layout" | "project"
  action: string;        // "created" | "updated" | "deleted"
  generatedSid?: number;
  generatedUid?: number;
  warnings?: string[];   // e.g., "Auto-registered plugin..."
  backupFile?: string;   // path to .bak file
}
```

### Common Errors

| Error | Cause | Resolution |
|-------|-------|------------|
| `Object "X" not found` | Misspelled name | Check suggestions or use `list_objects` |
| `Object "X" already exists` | Duplicate name | Use `update_object_properties` instead |
| `Plugin "X" is not registered` | Third-party addon not in project | Add addon in C3 editor first |
| `"System" is a reserved name` | Name conflicts with C3 engine | Choose a different name |
| `Path traversal detected` | Name contains `..` or `/` | Use simple alphanumeric names |
| `Object is still referenced` | Delete blocked by references | Use `force: true` or remove references first |

---

## Type Definitions

### Key Types

```typescript
interface Addon {
  type: 'plugin' | 'behavior' | 'effect';
  id: string;
  name: string;
  author: string;
  bundled: boolean;
  version?: string;
  sdkVersion?: number;
}

interface WriteResult {
  success: boolean;
  entity: string;
  category: string;
  action: string;
  generatedSid?: number;
  generatedUid?: number;
  warnings?: string[];
  backupFile?: string;
}

interface ReferenceCheckResult {
  safe: boolean;
  references: {
    eventSheets: string[];
    layouts: string[];
    families: string[];
  };
}
```

---

**Last Updated**: 2026-02-19
