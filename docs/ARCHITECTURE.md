# Architecture

## System Overview

The Construct3 MCP Server is a TypeScript application implementing the Model Context Protocol (MCP) to provide safe, structured access to Construct 3 game engine projects — including reading, analysis, and validated modifications.

```
                        MCP Protocol (stdio)
                              │
┌─────────────────────────────▼──────────────────────────────────┐
│  Construct3 MCP Server                                         │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  MCP Protocol Layer                                      │  │
│  │  Resources (9) · Query Tools (9) · Analysis (11)         │  │
│  │  Mutations (43) · Runtime (7) · Prompts (7)              │  │
│  └──────────┬───────────────────────────────────────────────┘  │
│             │                                                  │
│  ┌──────────▼───────────────────────────────────────────────┐  │
│  │  Business Logic Layer                                    │  │
│  │  ProjectReader · ProjectWriter · IdGenerator             │  │
│  │  Templates · Analyzers (12) · Cross-Reference Index      │  │
│  │  Runtime bridge · ZIP writer · PNG generator             │  │
│  └──────────┬───────────────────────────────────────────────┘  │
│             │                                                  │
│  ┌──────────▼───────────────────────────────────────────────┐  │
│  │  File System Layer                                       │  │
│  │  JSON parsing · Backup · Validate · Write · Verify       │  │
│  │  Text style (line endings, BOM) · Path checks            │  │
│  └──────────┬───────────────────────────────────────────────┘  │
└─────────────┼──────────────────────────────────────────────────┘
              │
┌─────────────▼──────────────────┐
│  Construct 3 Project Files     │
│  project.c3proj                │
│  objectTypes/*.json            │
│  eventSheets/*.json            │
│  layouts/*.json                │
│  families/*.json               │
│  timelines/*.json              │
│  images/*.png · scripts/*.js   │
└────────────────────────────────┘
```

The server registers 70 tools, 9 resources and 7 prompts. The layer counts follow the module that registers each tool, so the read-only `list_addons`, `list_timelines` and `get_timeline_details` count as mutations: they live in the project and timeline modules.

## Core Components

### 1. Entry Point (`src/index.ts`)

Resolves the project path (first CLI argument, then `C3_PROJECT_PATH`, then the working directory; a directory is searched for a `.c3proj` file), loads the project, creates all core instances, and registers handlers:

```
reader  → registerProjectResources, registerQueryTools, registerWorkflowPrompts,
          registerAnalysisTools
(none)  → registerDocsResources (docs index, manual topics, pitfalls)
writer  → registerMutationTools (also needs reader + idGen)
          registerRuntimeTools (also needs reader)
idGen   → shared between writer and mutations
```

### 2. Project Reader (`src/construct3/project-reader.ts`)

Read-only access to all project data with lazy-loading and caching.

```typescript
class Construct3ProjectReader {
  // Core loading
  loadProject(): Promise<Construct3Project>
  reloadProject(): Promise<void>
  static isValidProject(projectPath: string): Promise<boolean>
  static findProjectFile(directory: string): Promise<string | null>

  // Read entities
  readObjectType(name: string): Promise<ObjectType>
  readEventSheet(name: string): Promise<EventSheet>
  readLayout(name: string): Promise<Layout>
  readFamily(name: string): Promise<Record<string, unknown>>
  readScriptFile(relativePath: string): Promise<string>
  readAllObjectTypes(): Promise<Map<string, ObjectType>>
  readAllEventSheets(): Promise<Map<string, EventSheet>>
  readAllLayouts(): Promise<Map<string, Layout>>
  readAllFamilies(): Promise<Map<string, Record<string, unknown>>>

  // Query
  listObjectTypes(): Promise<string[]>
  listEventSheets(): Promise<string[]>
  listLayouts(): Promise<string[]>
  listFamilies(): Promise<string[]>
  searchObjects(pattern: string): string[]
  findNearestName(name: string, category: 'objects' | 'eventsheets' | 'layouts'): string[]

  // Metadata
  getProject(): Construct3Project
  getMetadata(): { name, version, author, description, runtime,
                   viewportWidth, viewportHeight, firstLayout }
  getUsedAddons(): Addon[]
  getProjectDir(): string
  getProjectPath(): string

  // Cache management (called by writer after modifications)
  invalidateCaches(): void
}
```

**Design patterns:**
- **Lazy loading**: Entity files read on demand; the bulk `readAll*()` results are cached
- **Path mapping**: Built at load time from c3proj container structures (handles subfolders)
- **Fuzzy matching**: `findNearestName()` provides "Did you mean?" suggestions
- **Bounded reads**: Entity and script files over 10MB are refused; a leading BOM is stripped before parsing

### 3. Project Writer (`src/construct3/project-writer.ts`)

Safe write operations with the safety pipeline: **backup → validate → write → verify → invalidate**.

```typescript
class Construct3ProjectWriter {
  // Entity files (objectTypes, eventSheets, layouts, families)
  writeEntityFile(category, name, data, subfolder?, { createOnly? }): Promise<string>
  entityFileRefusal(category, name, subfolder?): Promise<string | undefined>  // file already on disk, ignoring case
  deleteEntityFile(category, name, subfolder?): Promise<string>

  // c3proj container updates
  addToProject(category, name, subfolder?): Promise<void>
  removeFromProject(category, name): Promise<void>

  // Metadata (keys checked against an allowlist)
  updateProjectProperties(updates): Promise<string>

  // Addon management
  ensureAddonRegistered(type, id): Promise<string | undefined>

  // Placeholder images
  writeImageFile(objectName, animationName, frameIndex, pluginId?, width?, height?): Promise<string>
  writeImageFiles(files): Promise<string[]>

  // Helpers
  getSubfolderForEntity(category, name): string | undefined
}
```

**Safety guarantees:**
- **Path traversal protection**: All paths resolved through `resolveProjectPath()` (`path-utils.ts`) and checked against the project directory
- **Pre-write validation**: JSON round-trip test, null/type checks, 5MB size limit
- **Backup**: `.bak` file created before every overwrite or delete
- **Atomic write**: Content goes to a `.tmp` file that is then renamed into place; an existing file keeps its name on disk, including its case (`atomic-write.ts`)
- **No overwrite on create**: Create tools pass `createOnly`, so a new entity is never written over a file that already exists, also one whose name differs only in case
- **Post-write verification**: File read back, compared with the text that was written, and re-parsed; different content that still parses is reported as a concurrent write
- **Project lock**: The writer's read-modify-writes of `project.c3proj` (`addToProject`, `removeFromProject`, `updateProjectProperties`, addon auto-registration) share one lock, so parallel writer calls cannot lose each other's updates
- **Text style**: An existing file keeps its line endings, trailing whitespace and BOM; a new file follows `project.c3proj` (`json-format.ts`)
- **Cache invalidation**: Reader caches, project index, and ID generator all reset
- **Image rollback**: `writeImageFiles()` deletes the images it already wrote when a later one fails

Timelines, `register_addon` / `unregister_addon` and the runtime tools write outside the writer, with fewer of these steps; the README's Safety Model lists the differences. None of them takes the project lock, and the timeline and addon tools use the same `project.c3proj.tmp` file as the writer, so running them in parallel with other writes can lose or fail a `project.c3proj` update. Run them one at a time.

### 4. ID Generator (`src/construct3/id-generator.ts`)

Collision-free SID, UID and imageSpriteId generation.

```typescript
class IdGenerator {
  initialize(reader): Promise<void>             // Scan all existing IDs (lazy, once)
  generateSid(reader): Promise<number>           // 15-digit random, collision-checked
  generateUid(reader): Promise<number>           // Sequential (highest + 1)
  generateImageSpriteId(reader): Promise<number> // 7-digit random, collision-checked
  addSid(sid): void                              // Register newly created SID
  addUid(uid): void                              // Register newly created UID
  reset(): void                                  // Force re-scan on next use
}
```

**SID strategy**: Random 15-digit integer (100,000,000,000,000 – 999,999,999,999,999), checked against a set of all existing SIDs scanned from the entire project. Retry up to 100 times on collision.

**UID strategy**: Find highest existing UID across all layout instances and singleglobal-inst entries, then increment.

**imageSpriteId strategy**: Random 7-digit integer, checked against the IDs of all existing animation frames. Links an animation frame to its image file.

**Scan sources**: c3proj file items, all object/eventsheet/layout/family JSON files — including SIDs on objects, events, actions, conditions, layers, instances, behaviors, variables, animations, frames, and function parameters.

### 5. Templates (`src/construct3/templates.ts`)

Builders for valid C3 JSON structures. All field names and defaults validated against real C3 project files.

- **Object templates**: Sprite (with animations), Text, TiledBg, global plugins, generic (any other plugin)
- **Event templates**: empty sheet, variable, group, function (with params), include, comment, block
- **Animation templates**: animation, animation frame
- **Layout templates**: layout (with layers), layer, instance
- **Instance variable & behavior templates**
- **Lookup tables**: `GLOBAL_PLUGINS`, `NONWORLD_GLOBAL_PLUGINS`, `RESERVED_NAMES`, `DEFAULT_INSTANCE_PROPERTIES`, `KNOWN_SCIRRA_PLUGINS`, `KNOWN_SCIRRA_BEHAVIORS`

Supporting modules next to the templates:

| Module | Purpose |
|--------|---------|
| `construct3/atomic-write.ts` | Temp-file-and-rename writes that keep an existing file's name on disk; case-insensitive file lookup |
| `construct3/names.ts` | Name comparison the way the editor does it (ignoring case) for names and project-bar folders |
| `construct3/event-variable-names.ts` | The editor's rules for event variable and function parameter names: scope, System expression names, characters it refuses |
| `construct3/json-format.ts` | On-disk text style: detects and reapplies line endings, trailing newline and BOM |
| `construct3/path-utils.ts` | `resolveProjectPath()`: joins path segments and rejects paths that leave the project folder |
| `construct3/png-generator.ts` | Zero-dependency placeholder PNGs and C3 image file names |
| `construct3/timeline-folders.ts` | The editor's Transitions folder in the timelines container (first nameless first-level folder, files in `timelines/transitions/`), shared by the timeline tools and `validate_project` |
| `construct3/types.ts` | TypeScript types for project files and analysis results |
| `runtime/bridge.ts` | Generates the injectable runtime bridge script (`globalThis.__c3bridge`) |
| `runtime/zip-writer.ts` | Zero-dependency ZIP writer used to pack `.c3p` files |

### 6. Analyzers (`src/construct3/analyzers/`)

A shared cross-reference index and twelve analysis modules, several of which build on the index:

| Module | Purpose |
|--------|---------|
| `index-builder.ts` | Builds and caches the project-wide cross-reference index |
| `event-flow.ts` | Include hierarchy and layout bindings (Mermaid output); function definitions and call sites |
| `object-deps.ts` | Object usage across event sheets, layouts, families; objects not referenced anywhere |
| `asset-usage.ts` | Sound, image, font, video asset tracking |
| `performance.ts` | Heuristic performance audit (info/warning/critical) |
| `integrity.ts` | Project integrity checks behind `validate_project` |
| `load-rules.ts` | Rules the Construct 3 editor enforces when it opens a project (expression syntax, empty parameters, trigger placement, name and SID clashes, family plugins); used by `validate_project` and the pre-write checks |
| `legacy-behavior-keys.ts` | Scan and repair of the legacy `"behavior-type"` key |
| `behavior-refs.ts` | Behavior name checks against objects and families |
| `group-settings.ts` | Event group settings (`get_group_settings`) |
| `event-outline.ts` | Editor event numbers, `locate_event` and the paged `get_eventsheet_outline` |
| `runtime-traps.ts` | Signal pairing and order, script/function-parameter traps (`find_runtime_traps`) |
| `script-scan.ts` | Lightweight JS/TS scanner for script actions, used by the runtime trap checks |

The cross-reference index (`ProjectIndex`) is cached and reset when writes occur via `resetProjectIndex()`.

### 7. MCP Layers

| Layer | File(s) | Count | Purpose |
|-------|---------|-------|---------|
| Resources | `resources/project.ts` (6), `resources/docs.ts` (3; the pitfalls text lives in `resources/pitfalls.ts`) | 9 | Read-only data access, Construct 3 docs, curated pitfalls |
| Query Tools | `tools/query.ts` | 9 | List, search, get details |
| Analysis Tools | `tools/analysis.ts` | 11 | Deep analysis, validation, event locating, runtime traps |
| Mutation Tools | `tools/mutations.ts` → `object-tools.ts` (6), `event-tools.ts` (11), `layout-tools.ts` (9), `animation-tools.ts` (8), `timeline-tools.ts` (5), `project-tools.ts` (4) | 43 | Safe create, update, delete |
| Runtime Tools | `tools/runtime-tools.ts` | 7 | Runtime bridge, preview checks, project clone, `.c3p` packing |
| Prompts | `prompts/workflows.ts` | 7 | Workflow templates |

`tools/mutations.ts` only calls the domain modules' `register*Tools()` functions. Shared tool code lives in `tools/shared.ts` (name and subfolder validation, `toolResult` / `toolError`, not-found suggestions, the editor reload note) and `tools/event-helpers.ts` (event Zod schemas, builders, validators and the load-time pre-write check).

## Data Flow

### Read Flow

```
Claude → list_objects({ filter: "btn" })
  → Zod schema validation
  → reader.searchObjects("btn")
  → in-memory filter on the object names mapped at load time
  → JSON response to Claude
```

### Write Flow

```
Claude → create_object({ name: "Enemy", pluginId: "Sprite" })
  → validateName("Enemy")
  → check uniqueness against reader.listObjectTypes()
  → findObjectClassNameClash()      ← same name as an object or family, ignoring case
  → writer.entityFileRefusal(...)   ← no file for the name on disk yet, ignoring case
  → writer.ensureAddonRegistered("plugin", "Sprite")
  → idGen.generateSid() / generateImageSpriteId() (scan all IDs if first use)
  → writer.writeImageFiles(...)     ← placeholder PNG for the first frame
  → build template: createSpriteObject("Enemy", sid, animSid, imageSpriteId)
  → writer.writeEntityFile("objectTypes", "Enemy", data, undefined, { createOnly: true })
      → validateJsonData(data)      ← pre-write check
      → resolveJsonTextStyle(...)   ← keep the file's line endings and BOM
      → createBackup(filePath)      ← .bak copy
      → atomicWrite(filePath, text) ← temp file, then rename
      → verifyWrittenFile(filePath) ← post-write read-back
      → invalidateAll()             ← clear all caches
  → writer.addToProject("objectTypes", "Enemy")
      → take the project lock
      → createBackup(c3proj)
      → add "Enemy" to objectTypes.items
      → validate + atomic write + verify, then reader.reloadProject()
  → toolResult(WriteResult)         ← adds the editorNote
```

Event sheet writes (`add_event_block`, `update_event_block`, `add_event_to_sheet`, `update_event_block_action`, `move_events_between_sheets`) run one more step before `writeEntityFile`: `checkLoadRulesBeforeWrite()` (for moves, `checkLoadRulesBeforeSheetPairWrite()`) compares the sheet's editor load-time issues before and after the change. A new error refuses the write; new warnings are returned with the result.

### Analysis Flow

```
Claude → get_object_dependencies({ object: "Player" })
  → getProjectIndex(reader) (builds or returns cached index)
      → reader.readAllEventSheets()
      → reader.readAllLayouts()
      → reader.readAllFamilies()
      → scan all events for objectClass references
      → scan all instances for type references
      → build maps: objectToEventSheets, objectToLayouts, objectToFamilies
  → look up "Player" in index
  → return dependency report
```

## Communication Protocol

Uses `StdioServerTransport` from MCP SDK:
- **Input**: JSON-RPC 2.0 messages on stdin
- **Output**: JSON-RPC 2.0 responses on stdout
- **Logging**: stderr for debug/error messages

## Error Handling

All tool handlers catch errors and return structured responses:

```typescript
// Success
{ content: [{ type: 'text', text: JSON.stringify(result) }] }

// Error
{ content: [{ type: 'text', text: 'Error message' }], isError: true }
```

The mutation tools provide extra context:
- Fuzzy name suggestions ("Did you mean: Player?")
- Reference lists when deletion is blocked
- Warnings for auto-registered addons, unknown plugin properties or new load-time warnings
- An `editorNote` on every response that reports a completed write: close and reopen the project in Construct 3 before saving there

## Security

- **Path traversal protection**: `resolveProjectPath()` rejects any path escaping the project directory
- **Reserved name blocking**: "System" and other C3 reserved names cannot be used
- **Name clash checks**: Names the editor compares ignoring case (event sheets, layouts, object types and families in one name space, layers, animations, event variables, project-bar folders) are refused when they differ from an existing one only in case (`names.ts`)
- **Input validation**: Zod schemas on all tool parameters with length limits
- **Addon gating**: Unknown third-party plugins/behaviors blocked from auto-registration
- **Load-time gate**: The five event-editing tools listed under Write Flow reject writes that add an error the editor would refuse at load
- **Size limits**: 5MB maximum for any generated JSON file, 10MB for entity and script files read

---

**Last Updated**: 2026-09-26
