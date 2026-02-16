# Architecture

## System Overview

The Construct3 MCP Server is a TypeScript application implementing the Model Context Protocol (MCP) to provide safe, structured access to Construct 3 game engine projects — including reading, analysis, and validated modifications.

```
                        MCP Protocol (stdio)
                              │
┌─────────────────────────────▼──────────────────────────────────┐
│  Construct3 MCP Server (v1.3.0)                                │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  MCP Protocol Layer                                      │  │
│  │  Resources (7) · Query Tools (9) · Analysis (6)          │  │
│  │  Mutations (8) · Prompts (6)                             │  │
│  └──────────┬───────────────────────────────────────────────┘  │
│             │                                                  │
│  ┌──────────▼──────────────────────────────────────────────┐   │
│  │  Business Logic Layer                                    │  │
│  │  ProjectReader · ProjectWriter · IdGenerator             │  │
│  │  Templates · Analyzers (6) · Cross-Reference Index       │  │
│  └──────────┬───────────────────────────────────────────────┘  │
│             │                                                  │
│  ┌──────────▼──────────────────────────────────────────────┐   │
│  │  File System Layer                                       │  │
│  │  JSON parsing · Backup · Validate · Write · Verify       │  │
│  └──────────┬───────────────────────────────────────────────┘  │
└─────────────┼──────────────────────────────────────────────────┘
              │
┌─────────────▼─────────────────┐
│  Construct 3 Project Files     │
│  project.c3proj                │
│  objectTypes/*.json            │
│  eventSheets/*.json            │
│  layouts/*.json                │
│  families/*.json               │
└────────────────────────────────┘
```

## Core Components

### 1. Entry Point (`src/index.ts`)

Initializes the MCP server, creates all core instances, and registers handlers:

```
reader  → registerProjectResources, registerDocsResources, registerQueryTools
          registerWorkflowPrompts, registerAnalysisTools
writer  → registerMutationTools (also needs reader + idGen)
idGen   → shared between writer and mutations
```

### 2. Project Reader (`src/construct3/project-reader.ts`)

Read-only access to all project data with lazy-loading and caching.

```typescript
class Construct3ProjectReader {
  // Core loading
  loadProject(): Promise<void>
  reloadProject(): Promise<void>

  // Read entities
  readObjectType(name: string): Promise<ObjectType>
  readEventSheet(name: string): Promise<EventSheet>
  readLayout(name: string): Promise<Layout>
  readAllObjectTypes(): Promise<Map<string, ObjectType>>
  readAllEventSheets(): Promise<Map<string, EventSheet>>
  readAllLayouts(): Promise<Map<string, Layout>>
  readAllFamilies(): Promise<Map<string, Family>>

  // Query
  listObjectTypes(): Promise<string[]>
  listEventSheets(): Promise<string[]>
  listLayouts(): Promise<string[]>
  listFamilies(): Promise<string[]>
  searchObjects(pattern: string): string[]
  findNearestName(name: string, category: string): string[]

  // Metadata
  getProject(): Construct3Project
  getMetadata(): ProjectMetadata
  getUsedAddons(): Addon[]
  getProjectDir(): string
  getProjectPath(): string

  // Cache management (called by writer after modifications)
  invalidateCaches(): void
}
```

**Design patterns:**
- **Lazy loading**: Entity files read on-demand and cached
- **Path mapping**: Built at load time from c3proj container structures (handles subfolders)
- **Fuzzy matching**: `findNearestName()` provides "Did you mean?" suggestions

### 3. Project Writer (`src/construct3/project-writer.ts`)

Safe write operations with the safety pipeline: **backup → validate → write → verify → invalidate**.

```typescript
class Construct3ProjectWriter {
  // Entity files
  writeEntityFile(category, name, data, subfolder?): Promise<string>
  deleteEntityFile(category, name, subfolder?): Promise<string>

  // c3proj container updates
  addToProject(category, name, subfolder?): Promise<void>
  removeFromProject(category, name): Promise<void>

  // Metadata
  updateProjectProperties(updates): Promise<string>

  // Addon management
  ensureAddonRegistered(type, id): Promise<string | undefined>

  // Helpers
  getSubfolderForEntity(category, name): string | undefined
}
```

**Safety guarantees:**
- **Path traversal protection**: All paths resolved and checked against project directory
- **Pre-write validation**: JSON round-trip test, null/type checks, 5MB size limit
- **Backup**: `.bak` file created before every overwrite
- **Post-write verification**: File read back and re-parsed after writing
- **Cache invalidation**: Reader caches, project index, and ID generator all reset

### 4. ID Generator (`src/construct3/id-generator.ts`)

Collision-free SID and UID generation.

```typescript
class IdGenerator {
  initialize(reader): Promise<void>   // Scan all existing IDs (lazy, once)
  generateSid(reader): Promise<number> // 15-digit random, collision-checked
  generateUid(reader): Promise<number> // Sequential (highest + 1)
  addSid(sid): void                    // Register newly created SID
  addUid(uid): void                    // Register newly created UID
  reset(): void                        // Force re-scan on next use
}
```

**SID strategy**: Random 15-digit integer (100,000,000,000,000 – 999,999,999,999,999), checked against a set of all existing SIDs scanned from the entire project. Retry up to 100 times on collision.

**UID strategy**: Find highest existing UID across all layout instances and singleglobal-inst entries, then increment.

**Scan sources**: c3proj file items, all object/eventsheet/layout/family JSON files — including SIDs on objects, events, actions, conditions, layers, instances, behaviors, variables, animations, frames, and function parameters.

### 5. Templates (`src/construct3/templates.ts`)

Builders for valid C3 JSON structures. All field names and defaults validated against real C3 project files.

- **Object templates**: Sprite (with animations), Text, TiledBg, NinePatch, global plugins, generic
- **Event templates**: empty sheet, variable, group, function (with params), include, comment
- **Layout templates**: layout (with layers), layer, instance
- **Instance variable & behavior templates**
- **Lookup tables**: `GLOBAL_PLUGINS`, `RESERVED_NAMES`, `DEFAULT_INSTANCE_PROPERTIES`, `KNOWN_SCIRRA_PLUGINS`, `KNOWN_SCIRRA_BEHAVIORS`

### 6. Analyzers (`src/construct3/analyzers/`)

Six analysis modules powered by a shared cross-reference index:

| Module | Purpose |
|--------|---------|
| `index-builder.ts` | Builds and caches project-wide cross-reference index |
| `eventsheet-flow.ts` | Include hierarchy and layout bindings (Mermaid output) |
| `function-map.ts` | Function definitions and call sites |
| `object-deps.ts` | Object usage across event sheets, layouts, families |
| `orphan-finder.ts` | Objects not referenced anywhere |
| `asset-usage.ts` | Sound, image, font, video asset tracking |
| `performance.ts` | Heuristic performance audit (info/warning/critical) |

The cross-reference index (`ProjectIndex`) is cached and reset when writes occur via `resetProjectIndex()`.

### 7. MCP Layers

| Layer | File(s) | Count | Purpose |
|-------|---------|-------|---------|
| Resources | `resources/project.ts`, `resources/docs.ts` | 7 | Read-only data access |
| Query Tools | `tools/query.ts` | 9 | List, search, get details |
| Analysis Tools | `tools/analysis.ts` | 6 | Deep analysis and visualization |
| Mutation Tools | `tools/mutations.ts` | 8 | Safe create, update, delete |
| Prompts | `prompts/workflows.ts` | 6 | Workflow templates |

## Data Flow

### Read Flow

```
Claude → list_objects({ filter: "btn" })
  → Zod schema validation
  → reader.searchObjects("btn")
  → in-memory filter on cached object list
  → JSON response to Claude
```

### Write Flow

```
Claude → create_object({ name: "Enemy", pluginId: "Sprite" })
  → validateName("Enemy")
  → writer.ensureAddonRegistered("plugin", "Sprite")
  → check uniqueness against reader.listObjectTypes()
  → idGen.generateSid() (scan all IDs if first use)
  → build template: createSpriteObject("Enemy", sid, animSid)
  → writer.writeEntityFile("objectTypes", "Enemy", data)
      → validateJsonData(data)     ← pre-write check
      → createBackup(filePath)      ← .bak copy
      → writeFile(filePath, json)   ← actual write
      → verifyWrittenFile(filePath) ← post-write read-back
      → invalidateAll()             ← clear all caches
  → writer.addToProject("objectTypes", "Enemy")
      → createBackup(c3proj)
      → add "Enemy" to objectTypes.items
      → writeFile + verify + reader.reloadProject()
  → return WriteResult to Claude
```

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

The mutation tools provide extra context on errors:
- Fuzzy name suggestions ("Did you mean: Player?")
- Reference lists when deletion is blocked
- Warnings for auto-registered addons or unknown plugin properties

## Security

- **Path traversal protection**: `resolveProjectPath()` rejects any path escaping the project directory
- **Reserved name blocking**: "System" and other C3 reserved names cannot be used
- **Input validation**: Zod schemas on all tool parameters with length limits
- **Addon gating**: Unknown third-party plugins/behaviors blocked from auto-registration
- **Size limits**: 5MB maximum for any generated JSON file

---

**Last Updated**: 2026-02-16
