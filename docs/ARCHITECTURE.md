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
│  │  Mutations (44) · Runtime (7) · Prompts (7)              │  │
│  └──────────┬───────────────────────────────────────────────┘  │
│             │                                                  │
│  ┌──────────▼───────────────────────────────────────────────┐  │
│  │  Business Logic Layer                                    │  │
│  │  ProjectReader · ProjectWriter · IdGenerator             │  │
│  │  Templates · Analyzers (16) · Cross-Reference Index      │  │
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

The server registers 71 tools, 9 resources and 7 prompts. The layer counts follow the module that registers each tool, so the read-only `list_addons`, `list_timelines` and `get_timeline_details` count as mutations: they live in the project and timeline modules.

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

  // Files the bulk reads skipped
  getReadFailures(category): Map<string, ReadFailure>          // name → { code, message }
  scanEntityIdsRaw(category, name): Promise<{ highestUid, sids }> // text scan, no size limit
  searchEntityTextRaw(category, name, terms): Promise<Set<string>> // streamed name search, no size limit
  getEntityRelativePath(category, name): string                 // e.g. "layouts/Levels/Title.json"

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
- **Typed read failures**: The per-entity readers throw a `ProjectReadError` with a code (`E_FILE_TOO_LARGE`, `E_FILE_NOT_FOUND`, `E_INVALID_JSON`, `E_READ_ERROR`); the bulk `readAll*()` reads skip such files and record the code per name (`getReadFailures()`), so the ID generator and `validate_project` branch on the code, never on message text. A bulk read stores its failures together with its cached map when it finishes, and callers take them right after the read: a project reload by a concurrent tool call (`invalidateCaches()`) can then drop both, but never leave a cached map without the failures that go with it
- **Raw ID scan**: `scanEntityIdsRaw()` streams a skipped layout or object type without the size limit and without parsing (`scanFileIds` in `raw-text-search.ts`, read like the raw text search: 1MB chunks, UTF-8 or UTF-16LE after its byte order mark, UTF-16BE and NUL characters rejected) and collects its `"uid"` and `"sid"` values with a linear regex, keeping between chunks only the start of an entry a chunk boundary cut off; the path goes through the same path map and `resolveProjectPath()` check as the parsed readers
- **Raw text search**: `searchEntityTextRaw()` searches a skipped file for names (whole words, ignoring case), numbers and bounded patterns (`raw-text-search.ts`), through the same path check. It streams the file in 1MB chunks with an overlap, so memory does not grow with the file, and stops once every term was found; fs errors propagate unwrapped (ENOENT: no file, so no uses). The reference checks use it for the files the index could not parse (`unscanned-uses.ts`)

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

  // Placeholder images and frame image files in images/
  writeImageFile(objectName, animationName, frameIndex, pluginId?, width?, height?): Promise<string>
  writeImageFiles(files): Promise<string[]>
  listImageFiles(): Promise<string[]>
  renameImageFiles(renames): Promise<void>
  deleteImageFile(name): Promise<boolean>

  // Runs the animation tools one at a time
  withAnimationLock(fn): Promise<T>

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
- **Post-write verification**: File read back, compared with the text that was written, and re-parsed; different content that still parses is reported as a concurrent write. A failure once the backup exists (while or after replacing the file) throws an `EntityWriteError` carrying the backup path, so a change that spans several files can restore this one too (`restoreEntityFile`); its `changedByOtherWrite` tells a concurrent write (a `ConcurrentWriteError` cause) from other failures, so the caller does not restore an old backup over another write's content
- **Project lock**: The writer's read-modify-writes of `project.c3proj` (`addToProject`, `removeFromProject`, `updateProjectProperties`, addon auto-registration) share one lock, so parallel writer calls cannot lose each other's updates
- **Animation lock**: The animation tools run each call under `withAnimationLock()` and read the object inside it, so parallel calls cannot move each other's frame image files or write a Sprite's object file without each other's frames. Other tools that write an object file do not take it
- **Text style**: An existing file keeps its line endings, trailing whitespace and BOM; a new file follows `project.c3proj` (`json-format.ts`)
- **Cache invalidation**: Reader caches, project index, and ID generator all reset (for the written project only)
- **Image rollback**: `writeImageFiles()` deletes the images it already wrote when a later one fails; `renameImageFiles()` renames files in order (a name an earlier rename freed can be reused, so frame images can move along a chain), refuses to replace a file, and renames everything back when one rename fails

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

**UID strategy**: Find highest existing UID across all layout instances and singleglobal-inst entries, then increment. Registered layouts and object types that are missing from the bulk reads (over the 10MB cap, invalid JSON) are scanned as text (`scanEntityIdsRaw`) for their UIDs and SIDs; the generator goes by the registered names, so a skipped file is scanned even when its failure record is gone. A registered file that does not exist holds no IDs and is ignored; when a file exists but even the text scan fails, `generateUid()` throws with the file names instead of risking a duplicate UID (SIDs, being random, are still generated).

**imageSpriteId strategy**: Random 7-digit integer, checked against the IDs of all existing animation frames. Links an animation frame to its image file.

**Scan sources**: c3proj file items, all object/eventsheet/layout/family JSON files — including SIDs on objects, events, actions, conditions, layers, instances, behaviors, variables, animations, frames, and function parameters.

### 5. Templates (`src/construct3/templates.ts`)

Builders for valid C3 JSON structures. All field names and defaults validated against real C3 project files.

- **Object templates**: Sprite (with animations), Text, TiledBg, global plugins, generic (any other plugin)
- **Event templates**: empty sheet, variable, group, function (with params), include, comment, block
- **Animation templates**: animation, animation frame
- **Layout templates**: layout (with layers), layer, instance
- **Instance variable & behavior templates**
- **Lookup tables**: `GLOBAL_PLUGINS`, `NONWORLD_GLOBAL_PLUGINS`, `RESERVED_NAMES`, `DEFAULT_INSTANCE_PROPERTIES`, `KNOWN_SCIRRA_PLUGINS`, `KNOWN_SCIRRA_BEHAVIORS`, `BEHAVIOR_INSTANCE_DEFAULTS`

Supporting modules next to the templates:

| Module | Purpose |
|--------|---------|
| `construct3/event-shapes.ts` | The event shapes the editor saves: System else condition, OR blocks, positional function calls, script lines |
| `construct3/atomic-write.ts` | Temp-file-and-rename writes that keep an existing file's name on disk; case-insensitive file lookup |
| `construct3/names.ts` | Name comparison the way the editor does it (ignoring case) for names and project-bar folders |
| `construct3/event-variable-names.ts` | The editor's rules for event variable and function parameter names: scope, System expression names, characters it refuses |
| `construct3/instance-behaviors.ts` | The behavior entries every layout instance carries (object and family behaviors, with default property values) |
| `construct3/animation-rename.ts` | Sprite animations in animation folders, and what renaming one changes: frame image file names, `initial-animation` of layout instances, event sheet strings naming it (counted for a warning); the frame image files that move one index up or down when a frame is inserted or deleted |
| `construct3/json-format.ts` | On-disk text style: detects and reapplies line endings, trailing newline and BOM |
| `construct3/layers.ts` | The layer tree of a layout: walks every layer and nested sub-layer and their instances (non-world instances included), finds layers and instances, compares layer names ignoring case; every walk over layers or layout instances goes through it |
| `construct3/path-utils.ts` | `resolveProjectPath()`: joins path segments and rejects paths that leave the project folder |
| `construct3/png-generator.ts` | Zero-dependency placeholder PNGs and C3 image file names (all lowercase) |
| `construct3/raw-text-search.ts` | Streamed text search in files the reader skips: whole-word names ignoring case (as JSON writes them in a string), whole numbers, bounded patterns; one alternation of literals, word boundaries checked where a literal matched. Also the streamed UID/SID scan of the ID generator (`RawIdScan`, `scanFileIds`) |
| `construct3/timeline-folders.ts` | The editor's Transitions folder in the timelines container (first nameless first-level folder, files in `timelines/transitions/`), shared by the timeline tools and `validate_project` |
| `construct3/types.ts` | TypeScript types for project files and analysis results |
| `runtime/bridge.ts` | Generates the injectable runtime bridge script (`globalThis.__c3bridge`) |
| `runtime/zip-writer.ts` | Zero-dependency ZIP writer used to pack `.c3p` files |

### 6. Analyzers (`src/construct3/analyzers/`)

A shared cross-reference index and sixteen analysis modules, several of which build on the index:

| Module | Purpose |
|--------|---------|
| `index-builder.ts` | Builds the project-wide cross-reference index and caches it per reader |
| `event-flow.ts` | Include hierarchy and layout bindings (Mermaid output); function definitions and call sites |
| `object-deps.ts` | Object usage across event sheets, layouts, families; objects not referenced anywhere, and apart from them the objects whose own object type file could not be parsed (`unanalysedObjects`: their SID is unknown) |
| `asset-usage.ts` | Sound, music, image, font, video, icon and project file usage (used, unused or not analysed); images follow the index's object usage |
| `animations.ts` | Sprite animation trees as the editor saves them (items and animation subfolders); frame counts for the asset and performance analyses |
| `performance.ts` | Heuristic performance audit (info/warning/critical) |
| `integrity.ts` | Project integrity checks behind `validate_project` |
| `load-rules.ts` | Rules the Construct 3 editor enforces when it opens a project (expression syntax, empty parameters, trigger and else placement, name and SID clashes, family plugins); used by `validate_project` and the pre-write checks |
| `legacy-behavior-keys.ts` | Scan and repair of the legacy `"behavior-type"` key |
| `legacy-event-shapes.ts` | Scan and repair of event shapes older versions wrote (block `isElse`, condition `isOr`, old function calls, one-string scripts) |
| `delete-references.ts` | Calls, function map registrations and variable uses that deleting an event would leave pointing at nothing (`delete_event_from_sheet`) |
| `unscanned-uses.ts` | Possible uses in registered files the bulk reads skipped (over the 10MB read limit, not valid JSON): the index lists these files (`unscannedFiles`), and the reference checks and `find_orphaned_objects` / `get_object_dependencies` search them as text; a match or an unreadable file refuses without force |
| `behavior-refs.ts` | Behavior name checks against objects and families |
| `group-settings.ts` | Event group settings (`get_group_settings`) |
| `event-outline.ts` | Editor event numbers, `locate_event` and the paged `get_eventsheet_outline` |
| `runtime-traps.ts` | Signal pairing and order, script/function-parameter traps (`find_runtime_traps`) |
| `script-scan.ts` | Lightweight JS/TS scanner for script actions, used by the runtime trap checks |

The cross-reference index (`ProjectIndex`) is cached per reader, so projects opened side by side in one process (scripts, tests, embeddings) each keep their own; a write through the writer or the event tools resets the index of its project only, via `resetProjectIndex(reader)`. It records the registered files its bulk reads skipped (`unscannedFiles`, not files that do not exist), which nothing in it covers.

### 7. MCP Layers

| Layer | File(s) | Count | Purpose |
|-------|---------|-------|---------|
| Resources | `resources/project.ts` (6), `resources/docs.ts` (3; the pitfalls text lives in `resources/pitfalls.ts`) | 9 | Read-only data access, Construct 3 docs, curated pitfalls |
| Query Tools | `tools/query.ts` | 9 | List, search, get details |
| Analysis Tools | `tools/analysis.ts` | 11 | Deep analysis, validation, event locating, runtime traps |
| Mutation Tools | `tools/mutations.ts` → `object-tools.ts` (6), `event-tools.ts` (12), `layout-tools.ts` (9), `animation-tools.ts` (8), `timeline-tools.ts` (5), `project-tools.ts` (4) | 44 | Safe create, update, delete |
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
  → getProjectIndex(reader) (builds or returns the index cached for this reader)
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
- **Size limits**: 5MB maximum for any generated JSON file, 10MB for entity and script files read. The UID/SID text scan of skipped layouts and object types (again for the first ID after each write) and the name search of the reference checks stream skipped files without a limit

---

**Last Updated**: 2026-09-29
