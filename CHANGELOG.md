# Changelog

All notable changes to the Construct3 MCP Server are documented here.

## [1.4.0] - 2026-02-19

### Phase 4: Event Blocks & Animation

3 new mutation tools for gameplay logic and animation management (total: 11 mutation tools).

#### Added

- **`add_event_block`** — Add block events with conditions + actions to event sheets, with group path targeting, script action support, inverted conditions, and object class validation
- **`add_animation_to_sprite`** — Add named animations with configurable frame count, speed, looping, ping-pong to Sprite objects
- **`update_animation_properties`** — Modify speed, looping, ping-pong, repeat count on existing Sprite animations

#### Infrastructure

- **`createBlockEvent`** template — Generates valid block event JSON with conditions, actions, children array
- **`createAnimation` / `createAnimationFrame`** templates — Animation and frame JSON builders
- **`findGroupByPath()`** helper — Two-pass group traversal (verify-then-mutate) for safe nested event insertion
- **`validateObjectClasses()`** helper — Validates objectClass references against project objects, families, and System

#### Fixes (pre-push audit)

- `findGroupByPath` no longer mutates event data on failed path resolution
- All Phase 4 tools now return `backupFile` in results (consistency with Phase 3)
- Animation name validated as non-empty (`.min(1)`)
- Animation speed validated as non-negative (`.min(0)`)
- `createBlockEvent` includes `children: []` for sub-event consistency
- Fixed stale documentation: tool counts (8→11), roadmap references, manual test checklist

## [1.3.0] - 2026-02-16

### Phase 3: Safe Modifications

8 new mutation tools that safely create, update, and delete project entities.

#### Added

- **`create_object`** — Create Sprite, Text, TiledBg, NinePatch, and global plugin objects with proper SID/UID generation
- **`update_object_properties`** — Add/remove instance variables and behaviors on existing objects
- **`delete_object`** — Delete objects with reference checking (event sheets, layouts, families); supports `force` flag
- **`create_event_sheet`** — Create event sheets with optional auto-includes
- **`add_event_to_sheet`** — Add groups, functions, variables, includes, and comments to event sheets
- **`create_layout`** — Create layouts with configurable dimensions and layers
- **`add_instance_to_layout`** — Place object instances on layout layers with plugin-specific default properties
- **`update_project_metadata`** — Update project name, version, author, description

#### Safety infrastructure

- **ID Generator** (`id-generator.ts`) — Scans all existing SIDs/UIDs across the project, generates collision-free new ones (15-digit random SIDs, sequential UIDs)
- **Project Writer** (`project-writer.ts`) — Backup-before-write, JSON pre-validation (round-trip test, 5MB limit), post-write file verification, path traversal protection
- **Templates** (`templates.ts`) — Validated templates for all entity types with correct field names (`isGlobal` not `is-global`), `editorNewInstanceIsReplica`, plugin-specific instance properties
- **Addon validation** — Plugins and behaviors checked against `usedAddons`; known Scirra addons auto-registered, unknown addons blocked
- **Reserved name protection** — Blocks creation of objects named "System"
- **Global plugin protection** — Prevents placing singleglobal-inst objects on layouts
- **Cache invalidation** — Reader caches, project index, and ID generator all reset after writes

## [1.2.0] - 2026-02-15

### Phase 2: Enhanced Analysis

6 new analysis tools with cross-reference indexing.

#### Added

- **`get_eventsheet_flow`** — Event sheet include hierarchy and layout bindings, with Mermaid diagram output
- **`get_function_map`** — Function definitions and call sites across all event sheets
- **`get_object_dependencies`** — Object usage across event sheets, layouts, families, and co-occurring objects
- **`find_orphaned_objects`** — Detect objects not referenced in any event sheet or placed in any layout
- **`get_asset_usage`** — Track sound, music, image, font, and video asset usage
- **`analyze_performance`** — Heuristic performance audit with info/warning/critical categorized issues
- **Cross-reference index** (`index-builder.ts`) — Cached project-wide index for fast dependency lookups

#### Infrastructure

- Modular analyzer architecture (`src/construct3/analyzers/`)
- Configurable detail levels (summary/normal/full) across analysis tools

## [1.0.0] - 2026-02-14


### Phase 1: Foundation

Initial release with read-only project access.

#### Added

- **7 Resources**: Project info, structure, addons, object/eventsheet/layout details, C3 documentation
- **9 Query Tools**: List/search objects, event sheets, layouts, families; get details; project summary
- **6 Prompts**: Analyze project, find object usage, explain event sheet, review game logic, document object, optimize project
- Project file parser with caching
- Fuzzy name matching with suggestions
- Official Construct 3 documentation access via resources
