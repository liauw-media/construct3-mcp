# Development Guide

Guide for contributing to and developing the Construct3 MCP Server.

## Prerequisites

- **Node.js** >= 18.0.0
- **npm** >= 9.0.0
- **TypeScript** 5.7+
- A Construct 3 project in **folder format** (.c3proj) for testing

## Setup

```bash
git clone https://github.com/liauw-media/construct3-mcp.git
cd construct3-mcp
npm install
npm run build
```

## Development Commands

```bash
# Build (compile TypeScript to dist/)
npm run build

# Watch mode (auto-rebuild on file changes)
npm run dev

# Start the server with a test project
node dist/index.js /path/to/your/project.c3proj

# Or set the environment variable
C3_PROJECT_PATH=/path/to/project npm start
```

## Project Structure

```
construct3-mcp/
├── src/
│   ├── index.ts                    # Entry point — server init, registration
│   ├── construct3/                 # Core project logic
│   │   ├── project-reader.ts       # Read-only file access with caching
│   │   ├── project-writer.ts       # Safe writes (backup/validate/write/verify)
│   │   ├── id-generator.ts         # SID/UID generation with collision avoidance
│   │   ├── templates.ts            # Entity templates and known addon maps
│   │   ├── types.ts                # TypeScript type definitions
│   │   └── analyzers/              # Analysis modules
│   │       ├── index-builder.ts    # Cross-reference index (cached)
│   │       ├── eventsheet-flow.ts  # Include hierarchy visualization
│   │       ├── function-map.ts     # Function definition/call mapping
│   │       ├── object-deps.ts      # Object dependency tracking
│   │       ├── orphan-finder.ts    # Unused object detection
│   │       ├── asset-usage.ts      # Asset tracking
│   │       └── performance.ts      # Performance heuristics
│   ├── resources/                  # MCP resource handlers
│   │   ├── project.ts              # Project data resources (6)
│   │   └── docs.ts                 # C3 documentation resource (1)
│   ├── tools/                      # MCP tool handlers
│   │   ├── query.ts                # Query tools (9)
│   │   ├── analysis.ts             # Analysis tools (6)
│   │   └── mutations.ts            # Mutation tools (8)
│   └── prompts/                    # MCP prompt handlers
│       └── workflows.ts            # Workflow prompts (6)
├── docs/                           # Documentation
├── dist/                           # Compiled output (gitignored)
├── package.json
├── tsconfig.json
├── CHANGELOG.md
└── README.md
```

## Key Patterns

### Adding a New Query Tool

1. Open `src/tools/query.ts`
2. Add a `server.tool()` call inside `registerQueryTools()`:

```typescript
server.tool(
  'my_tool_name',
  'Description of what the tool does',
  {
    param: z.string().max(200).describe('Parameter description'),
  },
  async (args) => {
    try {
      const result = await reader.someMethod(args.param);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);
```

### Adding a New Analysis Tool

1. Create an analyzer in `src/construct3/analyzers/my-analyzer.ts`
2. Export an async function that takes `reader` and options
3. Register the tool in `src/tools/analysis.ts`
4. The analyzer can use `getProjectIndex(reader)` for cross-reference data

### Adding a New Mutation Tool

1. Add the tool in `src/tools/mutations.ts` inside `registerMutationTools()`
2. Follow the safety pattern:
   - Validate inputs (use `validateName()`, `validateSubfolder()`)
   - Check addon registration with `writer.ensureAddonRegistered()`
   - Generate IDs with `idGen.generateSid()` / `idGen.generateUid()`
   - Build data from templates in `templates.ts`
   - Write with `writer.writeEntityFile()` (handles backup/validate/verify)
   - Update c3proj with `writer.addToProject()` if needed
   - Return a `WriteResult`

### Adding a New Template

1. Open `src/construct3/templates.ts`
2. Add a builder function that returns `Record<string, unknown>`
3. Validate all field names against a real C3 project file — C3 uses a mix of camelCase (`isGlobal`) and kebab-case (`plugin-id`)
4. Export and use in `mutations.ts`

## C3 File Format Notes

Key things to know when working with Construct 3 project files:

- **SIDs** are ~15-digit random integers, globally unique across ALL entities in the project
- **UIDs** are sequential integers, only on layout instances and singleglobal-inst objects
- **Cross-references are by NAME** — event sheets reference objects as `"objectClass": "Name"`, layouts as `"type": "Name"`
- **c3proj containers** use `{ items: string[], subfolders: Subfolder[] }` recursive structure
- **usedAddons** in c3proj must list every plugin, behavior, and effect used
- **Global plugins** (Audio, AJAX, Mouse, etc.) use `singleglobal-inst` instead of layout placement
- **JSON formatting**: C3 uses tab indentation (`\t`)
- **Field naming**: Mostly camelCase for object properties (`isGlobal`, `behaviorTypes`), kebab-case for some identifiers (`plugin-id`, `initially-visible`)

## Cache Invalidation

After any write operation, three caches must be cleared:

1. **Reader caches** — `reader.invalidateCaches()` clears entity caches
2. **Project index** — `resetProjectIndex()` clears the cross-reference index
3. **ID generator** — `idGen.reset()` forces re-scan of existing IDs

The `ProjectWriter.invalidateAll()` method handles all three. The `addToProject()` and `removeFromProject()` methods also call `reader.reloadProject()` which re-reads the c3proj file.

## Testing

Currently tested manually against real C3 projects. To test:

1. Build: `npm run build`
2. Start with a test project: `node dist/index.js /path/to/test-project`
3. Connect via Claude Code or Claude Desktop
4. Run through the verification steps in the CHANGELOG

### Manual Test Checklist

**Query tools:**
- [ ] `list_objects` with and without filter
- [ ] `get_object_details` with valid and invalid names
- [ ] `get_project_summary`

**Analysis tools:**
- [ ] `get_eventsheet_flow` in mermaid and JSON format
- [ ] `find_orphaned_objects`
- [ ] `analyze_performance`

**Mutation tools:**
- [ ] `create_object` with Sprite, Text, and global plugin
- [ ] `update_object_properties` adding variables and behaviors
- [ ] `create_event_sheet` with includes
- [ ] `add_event_to_sheet` for each event type
- [ ] `create_layout` with custom layers
- [ ] `add_instance_to_layout`
- [ ] `delete_object` with and without force
- [ ] `update_project_metadata`
- [ ] Verify `.bak` backup files are created
- [ ] Verify all read tools still work after writes

**Safety tests:**
- [ ] Path traversal: `create_object({ name: "../../evil" })` — must reject
- [ ] Reserved name: `create_object({ name: "System" })` — must reject
- [ ] Global on layout: `add_instance_to_layout` with Audio object — must reject
- [ ] Unknown plugin: `create_object({ pluginId: "NonExistent" })` — must reject
- [ ] Duplicate name: `create_object` with existing name — must reject

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes and build: `npm run build`
4. Test against a real C3 project
5. Commit with clear message
6. Push and open a Pull Request

### Code Style

- TypeScript strict mode
- No `any` types — use `unknown` with type guards
- All tool handlers must catch errors and return structured responses
- Mutation tools must follow the backup/validate/write/verify pattern
- Use existing helper functions (`validateName`, `toolResult`, `toolError`)

---

**Last Updated**: 2026-02-16
