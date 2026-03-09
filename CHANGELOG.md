# Changelog

All notable changes to the Construct3 MCP Server are documented here.

## [1.6.0] - 2026-03-02

### Sprite Image Pipeline

Automatic placeholder PNG generation for Sprites and TiledBg objects, with `imageSpriteId` linking between object JSON and image files.

#### Added

- **PNG Generator** (`png-generator.ts`) — Zero-dependency transparent PNG generation using zlib; follows C3 image naming conventions (`objectname-animation-000.png` for Sprites, `objectname.png` for TiledBg)
- **`writeImageFile`** — Write a single placeholder PNG to the `images/` directory with auto-created directories
- **`writeImageFiles`** — Batch write multiple PNGs with rollback on failure (cleans up already-written files)
- **`generateImageSpriteId`** — 7-digit collision-checked ID generator for linking animation frames to image files
- **`imageSpriteId` support** — `createSpriteObject`, `createTiledBgObject`, and `createAnimationFrame` templates now accept optional `imageSpriteId`
- **Image pipeline integration tests** — 7 tests covering PNG creation, valid signatures, batch writes, Sprite/TiledBg round-trips, and ID uniqueness

#### Fixed

- **Behavior addition breaks project** — When `update_object_properties` adds a behavior or variable to an object type, existing layout instances of that object now get `behaviors` and `instanceVariables` dicts auto-synced so C3 can resolve them on project load. Without these fields, C3 could fail to open the project.
- **Fixture layout instance** updated to include `behaviors`, `instanceVariables`, and `tags` fields matching real C3 projects

#### Infrastructure

- 278 tests (up from 262), 12 test files
- `IdGenerator` now tracks `existingImageSpriteIds` from animation frames across the project
- 6 behavior workflow integration tests (add behavior, addon registration, multiple behaviors, field preservation, layout instance sync, full round-trip)
- 3 behavior unit tests (layout sync when instances exist, skip when none, preserve existing overrides)

## [1.5.0] - 2026-02-21

### Event Sheet & Layout Lifecycle

3 new mutation tools for deleting event sheets/layouts and updating layout properties (total: 14 mutation tools).

#### Added

- **`delete_event_sheet`** — Delete event sheets with reference checking (included-by sheets, bound layouts); supports `force` flag to override
- **`delete_layout`** — Delete layouts with reference checking (bound event sheets, placed objects); blocks deletion of the startup layout unconditionally; supports `force` flag
- **`update_layout`** — Update layout properties: event sheet binding (validated), width, and height

#### Enhanced

- **`add_event_block`** — Now supports sub-events (`children`), else blocks (`isElse`), OR conditions (`isOr`), and per-action disabling (`disabled` on actions). Recursive child building with safety limits (max depth 5, max 50 total events). Object class validation covers the entire event tree.

#### Closes

- Issue #2: `delete_event_sheet`
- Issue #3: `delete_layout`
- Issue #4: `update_layout`
- Issue #7: `add_event_block` sub-events, else, OR, per-action disabled

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
