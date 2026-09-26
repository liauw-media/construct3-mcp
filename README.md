# Construct3 MCP Server

> A Model Context Protocol (MCP) server that enables AI assistants (Claude, Cursor, Antigravity, and any MCP-compatible tool) to safely read, analyze, and modify Construct 3 game engine projects.

> **v1.8.1** — Full M1 primitive surface. See the [Roadmap](#roadmap) and [CHANGELOG](CHANGELOG.md) for details.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)

## Quick Start

```bash
# Install dependencies
npm install

# Build the server
npm run build

# Test with your project
node dist/index.js /path/to/your/project.c3proj
```

**Add to your MCP config** (Claude Code, Cursor, Antigravity — [see Usage](#usage) for config file locations):
```json
{
  "mcpServers": {
    "construct3": {
      "command": "node",
      "args": ["/absolute/path/to/construct3-mcp/dist/index.js"]
    }
  }
}
```

## Table of Contents

- [Why This Exists](#why-this-exists)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Safety Model](#safety-model)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Why This Exists

**The Problem**: When you ask Claude Code to work on Construct 3 projects, it directly edits JSON files and often breaks:
- Object references and unique IDs (SIDs/UIDs)
- Event sheet dependencies and includes
- Layout and instance relationships
- Plugin and behavior configurations
- The `usedAddons` registry

**The Solution**: This MCP server provides a **structured, validated interface** that:
- Understands Construct 3's internal file format and ID system
- Provides structured access to project data via resources and query tools
- Enables deep analysis (dependency graphs, orphan detection, performance audits)
- Safely creates, updates, and deletes project entities with automatic backup, ID generation, and validation
- Includes access to official Construct 3 documentation

## Features

### Resources (Read-Only Data Access)

| Resource | Description |
|----------|-------------|
| `construct3://project/info` | Project metadata and basic info |
| `construct3://project/structure` | Complete project structure overview |
| `construct3://project/addons` | All plugins, behaviors, and effects |
| `construct3://objects/{name}` | Specific object type details |
| `construct3://eventsheets/{name}` | Specific event sheet details |
| `construct3://layouts/{name}` | Specific layout details |
| `construct3://docs/index` | Index of documentation categories and popular topics |
| `construct3://docs/manual/{topic}` | Official Construct 3 documentation |

### Query Tools (Read-Only)

| Tool | Description |
|------|-------------|
| `list_objects` | List all object types with optional name filtering |
| `list_eventsheets` | List all event sheets |
| `list_layouts` | List all layouts |
| `list_families` | List all object families |
| `list_timelines` | List all timelines (root and subfolders); transitions are listed separately |
| `list_addons` | List addons in `usedAddons`, optionally filtered by type |
| `get_object_details` | Get detailed info about a specific object |
| `get_eventsheet_details` | Get detailed info about an event sheet |
| `get_layout_details` | Get detailed info about a layout |
| `get_timeline_details` | Get a timeline's full JSON (tracks and settings) |
| `search_objects` | Search objects by name pattern |
| `get_project_summary` | Get comprehensive project summary |

### Analysis Tools

| Tool | Description |
|------|-------------|
| `get_eventsheet_flow` | Event sheet include hierarchy and layout bindings (Mermaid or JSON) |
| `get_function_map` | Function definitions and call sites across event sheets |
| `get_object_dependencies` | Where objects are used (event sheets, layouts, families) |
| `find_orphaned_objects` | Find objects not referenced in any event sheet or layout |
| `get_asset_usage` | Track sound, image, font, and video asset usage |
| `analyze_performance` | Heuristic performance audit with categorized issues |
| `validate_project` | Integrity checks: missing files, required fields, duplicate SIDs/UIDs, broken references and includes, missing addons, legacy `"behavior-type"` keys, orphaned and backup files, plus the rules the C3 editor enforces at load (trigger placement, expression syntax, empty expressions, duplicate names/SIDs, family plugins). `valid` can be false on projects that load fine (known false positives in [API.md](docs/API.md#validate_project)) |
| `get_group_settings` | Event group settings (`isActiveOnStart`, disabled) across sheets, filterable by sheet and active state |

### Mutation Tools (Safe Write Operations)

**Objects and families**

| Tool | Description |
|------|-------------|
| `create_object` | Create a new object type (Sprite, Text, TiledBg, global plugins, etc.); refuses names that clash with an object type or family, ignoring case |
| `update_object_properties` | Add/remove instance variables and behaviors, change global status |
| `delete_object` | Delete an object (with reference checking and optional force) |
| `create_family` | Create a family; refuses name clashes and members of mixed plugins (load-time checked) |
| `update_family` | Add/remove members and shared instance variables; refuses member changes that mix plugins (load-time checked) |
| `delete_family` | Delete a family |

**Event sheets**

| Tool | Description |
|------|-------------|
| `create_event_sheet` | Create a new event sheet with optional includes |
| `add_event_to_sheet` | Add a group, function, variable, include, or comment to a sheet (load-time checked) |
| `add_event_block` | Add a block event with conditions + actions (gameplay logic); refuses writes that break the checked editor load-time rules (expression syntax, empty expressions, trigger placement) |
| `update_event_block` | Update an existing block: modify/add/remove actions and conditions (load-time checked) |
| `update_event_block_action` | Replace the parameters of one action in a block (by block SID and action index; load-time checked) |
| `update_event_variable` | Rename a variable or change its type, initial value, static or constant flag |
| `move_events_between_sheets` | Copy or move top-level events between sheets by SID (optionally into a group); load-time checked, so copying an event that breaks a load-time rule is refused |
| `delete_event_from_sheet` | Delete an event from a sheet by SID or include name (dry-run, force) |
| `remove_event_from_sheet` | Remove an include from a sheet by included sheet name |
| `delete_event_sheet` | Delete an event sheet (with reference checking and optional force) |
| `fix_legacy_behavior_keys` | Rename legacy `"behavior-type"` keys (written by older versions) to `"behaviorType"` in all event sheets, checking each name against the object's behaviors (dry-run by default) |

**Layouts, layers and instances**

| Tool | Description |
|------|-------------|
| `create_layout` | Create a new layout with configurable layers |
| `update_layout` | Update layout event sheet binding and dimensions |
| `delete_layout` | Delete a layout (blocks startup layout, checks references) |
| `add_layer` | Add a layer (position, visibility, transparency, parallax, blend mode) |
| `update_layer` | Rename a layer or change visibility, interactivity, parallax, blend mode, scale rate, Z elevation |
| `delete_layer` | Delete a layer (never the last one; blocked while it holds instances unless forced) |
| `add_instance_to_layout` | Place an object instance on a layout layer with full property control |
| `update_instance` | Update a placed instance by UID (position, size, angle, color, visibility, tags, instance variables) |
| `delete_instance_from_layout` | Remove a placed instance by UID (layers and non-world instances) |

**Sprite animations**

| Tool | Description |
|------|-------------|
| `add_animation_to_sprite` | Add a new animation to a Sprite object |
| `update_animation_properties` | Update animation speed, looping, ping-pong, repeat count |
| `rename_animation` | Rename an animation |
| `delete_animation` | Delete an animation (never the last one) |
| `add_frame_to_animation` | Add a blank frame (placeholder PNG) at an index |
| `update_frame` | Update a frame's duration, size or origin |
| `delete_frame_from_animation` | Delete a frame by index (never the last one) |
| `replace_sprite_image` | Replace a frame's image with base64 PNG data |

**Timelines**

| Tool | Description |
|------|-------------|
| `create_timeline` | Create a timeline (duration, loop, ping-pong, repeat count, start-on-layout) |
| `update_timeline` | Update timeline settings or enable/disable it |
| `delete_timeline` | Delete a timeline (backs up exactly the file it deletes; errors and leaves `project.c3proj` unchanged when the file is missing) |

**Project and addons**

| Tool | Description |
|------|-------------|
| `update_project_metadata` | Update project name, version, author, or description |
| `register_addon` | Add a plugin, behavior or effect to `usedAddons` |
| `unregister_addon` | Remove an addon from `usedAddons` (built-ins need `force`) |

### Runtime Tools (Live Game Control)

| Tool | Description |
|------|-------------|
| `inject_runtime_bridge` | Inject a bridge script into the C3 project that exposes the runtime via `globalThis.__c3bridge` |
| `remove_runtime_bridge` | Remove the bridge script and clean up the project |
| `get_bridge_commands` | List all commands the bridge supports (callFunction, getGlobalVar, getObjectState, etc.) |
| `generate_bridge_eval_script` | Generate a curl/python script to execute a bridge command via browser remote debugging |
| `export_for_preview` | Pre-flight checks (worker mode, bridge injection) for preview testing |
| `clone_project` | Deep-copy the project with optional bridge injection |
| `pack_project` | Pack the project folder into a `.c3p` file that Construct 3 can open (optionally injects the bridge first) |

The runtime bridge enables external tools (Playwright, browser console, curl) to control a running C3 game. Once injected and the game is previewed, you can:

```javascript
// From the browser console or any CDP-capable automation tool
globalThis.__c3bridge.submit("callFunction", { name: "StartGame", params: [] });
globalThis.__c3bridge.submit("getGlobalVar", { name: "Score" });
globalThis.__c3bridge.submit("getObjectState", { objectName: "Player" });
```

### Prompts (Workflow Templates)

| Prompt | Purpose |
|--------|---------|
| `analyze_project` | Analyze project structure and organization |
| `find_object_usage` | Find where a specific object is used |
| `explain_eventsheet` | Explain how an event sheet works |
| `review_game_logic` | Review overall game logic architecture |
| `document_object` | Generate documentation for an object |
| `optimize_project` | Get optimization suggestions |

## Safety Model

Mutation tools follow a strict safety protocol (exceptions below):

1. **Validation** — Names checked for reserved words, path traversal, format. Plugin/behavior IDs validated against `usedAddons`.
2. **Backup** — JSON files are backed up to `<filename>.bak` before modification.
3. **ID Generation** — SIDs (15-digit random), UIDs (sequential), and imageSpriteIds (7-digit) are collision-checked against the entire project.
4. **Write** — JSON is pre-validated (round-trip test, size limit), then written to a temp file and renamed into place. Files keep their text style (see below).
5. **Verify** — Files are read back, compared with what was written, and re-parsed to confirm integrity.
6. **Cache Invalidation** — All reader caches and indexes are cleared so subsequent reads see fresh data.

Steps 2, 4 and 5 apply in full to writes that go through the project writer: objects, families, event sheets, layouts, animations, project metadata and addon auto-registration. The other write paths do less:
- `register_addon` and `unregister_addon` replace `project.c3proj` through a temp file, with no `.bak` backup and no read-back check.
- The timeline tools back up the timeline file and `project.c3proj` and write through a temp file, but do not read the result back.
- The runtime tools (`inject_runtime_bridge`, `remove_runtime_bridge`, and `export_for_preview` / `pack_project` when they inject the bridge) write `project.c3proj` and the bridge script in place, with no backup or read-back check.
- PNG images are written without a backup.

**Close and reopen the project in Construct 3 before saving there.** The editor keeps an open project in memory, so saving from a session that was opened before these edits can overwrite them. Its Project Bar reload (F9) re-reads script files only, not event sheets, layouts or `project.c3proj`. Every response that reports a completed write carries this reminder as `editorNote`. Error responses do not, even when a multi-step tool (e.g. `create_object`) failed after an earlier step had already written.

Additional safeguards:
- **Reference checking** — `delete_object`, `delete_event_sheet`, and `delete_layout` scan for references before deleting.
- **Addon auto-registration** — When creating objects with new plugins or adding behaviors, known Scirra addons are automatically registered in `usedAddons`. Unknown/third-party addons are blocked with an error.
- **Global plugin protection** — Singleglobal-inst objects (Audio, AJAX, etc.) cannot be placed on layouts.
- **Plugin-specific defaults** — Instances are created with correct default properties for each plugin type (Sprite, Text, TiledBg, NinePatch).
- **Image generation** — Sprite and TiledBg creation automatically generates valid placeholder PNGs with correct naming conventions. Batch writes roll back on failure.
- **Layout instance sync** — When behaviors or variables are added to an object type, all layout instances of that object are automatically updated with the required `behaviors` and `instanceVariables` dicts so C3 can load the project correctly.
- **Text style preserved** — JSON is written the way Construct 3 saves it (tab indent). A file that already exists keeps its own line endings (e.g. CRLF from a git `core.autocrlf` checkout), exact trailing whitespace and BOM. A new file follows `project.c3proj`, then the first JSON file with line breaks in its target folder, then Construct 3's own style (LF, no trailing newline, no BOM). For files in Construct 3's tab layout, diffs show only the lines that changed; files indented another way (e.g. with spaces) are re-indented with tabs in full.

## Documentation

Detailed documentation is available in the `/docs` folder:

- [**Architecture**](docs/ARCHITECTURE.md) - System design, components, and data flow
- [**API Reference**](docs/API.md) - Complete reference for all resources, tools, and prompts
- [**Examples**](docs/EXAMPLES.md) - Usage examples and workflows
- [**Development Guide**](docs/DEVELOPMENT.md) - Contributing, adding tools, C3 format notes
- [**Troubleshooting**](docs/TROUBLESHOOTING.md) - Common issues and solutions

## Installation

### Prerequisites

- **Node.js** >= 18.0.0
- **npm** or **yarn**
- A Construct 3 project saved in **folder format** (.c3proj, not .c3p)

### Install Dependencies

```bash
cd construct3-mcp
npm install
```

### Build

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` folder.

## Usage

All MCP-compatible tools use the same JSON configuration format. The server auto-detects `.c3proj` in your working directory, or you can pass an explicit project path.

**MCP config** (same for all tools):
```json
{
  "mcpServers": {
    "construct3": {
      "command": "node",
      "args": ["/absolute/path/to/construct3-mcp/dist/index.js"]
    }
  }
}
```

To target a specific project instead of auto-detecting:
```json
"args": ["/path/to/construct3-mcp/dist/index.js", "/path/to/your-project"]
```

### With Claude Code

Add the config above to your project's `.mcp.json` or global `~/.claude/mcp.json`.

1. Open Claude Code inside any Construct 3 project folder
2. The MCP tools appear automatically

### With Claude Desktop

Add the config to your Claude Desktop settings file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Note: Claude Desktop doesn't change working directory per-project, so pass the project path explicitly in `args`.

### With Cursor

Add the config to `.cursor/mcp.json` in your project root (project-specific) or `~/.cursor/mcp.json` (global).

1. Restart Cursor after adding or modifying the config
2. The Construct 3 tools appear in Cursor's AI agent

### With Antigravity

Add the config to Antigravity's MCP configuration:

- **Via UI**: Click the `...` menu in the Agent panel → **MCP Servers** → **Manage MCP Servers** → **View raw config**
- **Direct edit**: `~/.gemini/antigravity/mcp_config.json`

Note: Antigravity doesn't set a working directory per-project, so pass the project path explicitly in `args`.

### Standalone Testing

```bash
# Auto-detect .c3proj in current directory
cd /path/to/project-folder
node /path/to/construct3-mcp/dist/index.js

# Or pass explicit path
node dist/index.js /path/to/project.c3proj
node dist/index.js /path/to/project-folder
```

### Example Queries

Once the MCP server is running, ask Claude:

**Project Analysis:**
- "What objects are in my Construct 3 project?"
- "Give me an overview of the project structure"
- "What plugins and behaviors are being used?"
- "Find orphaned objects that aren't used anywhere"
- "Run a performance audit on my project"

**Code Understanding:**
- "Explain how the MainSheet event sheet works"
- "Show me the event sheet include hierarchy"
- "Map all the functions in the project"
- "What objects depend on the Player?"

**Safe Modifications:**
- "Create a new Sprite object called Enemy"
- "Add a health variable to the Player object"
- "Create an event sheet for the menu logic"
- "Add a new layout called LevelSelect with two layers"
- "Place a Player instance at position 100, 200 on the Game layout"

**Documentation:**
- "Show me the Construct 3 documentation for the Sprite plugin"
- "What are the best practices for event sheets?"

## Development

### Project Structure

```
construct3-mcp/
├── src/
│   ├── index.ts                    # Main MCP server entry point
│   ├── construct3/
│   │   ├── project-reader.ts       # Project file parser and cache
│   │   ├── project-writer.ts       # Safe write operations with backup
│   │   ├── id-generator.ts         # SID/UID generation with collision avoidance
│   │   ├── templates.ts            # Object, event sheet, layout templates
│   │   ├── json-format.ts          # On-disk text style (line endings, trailing newline, BOM)
│   │   ├── path-utils.ts           # Path resolution inside the project folder
│   │   ├── png-generator.ts        # Zero-dep placeholder PNG generation
│   │   ├── types.ts                # TypeScript type definitions
│   │   └── analyzers/
│   │       ├── index-builder.ts    # Cross-reference index
│   │       ├── event-flow.ts       # Event sheet flow and function map
│   │       ├── object-deps.ts      # Object dependencies and orphaned objects
│   │       ├── asset-usage.ts      # Asset usage tracking
│   │       ├── performance.ts      # Performance heuristics
│   │       ├── integrity.ts        # Project integrity checks (validate_project)
│   │       ├── load-rules.ts       # Editor load-time rules (validate_project, pre-write checks)
│   │       ├── legacy-behavior-keys.ts # Legacy "behavior-type" key scan and repair
│   │       ├── behavior-refs.ts    # Behavior name checks against objects and families
│   │       └── group-settings.ts   # Event group settings (get_group_settings)
│   ├── resources/
│   │   ├── project.ts              # 6 project resources
│   │   └── docs.ts                 # 2 Construct 3 documentation resources
│   ├── runtime/
│   │   ├── bridge.ts               # Injectable C3 runtime bridge script generator
│   │   └── zip-writer.ts           # Zero-dep ZIP writer for .c3p packing
│   ├── tools/
│   │   ├── query.ts                # 9 query tools
│   │   ├── analysis.ts             # 8 analysis tools
│   │   ├── mutations.ts            # Registers the domain tool modules below
│   │   ├── shared.ts               # Shared validation, result/error helpers, editor reload note
│   │   ├── object-tools.ts         # Object and family tools (6)
│   │   ├── event-tools.ts          # Event sheet tools (10)
│   │   ├── event-helpers.ts        # Event Zod schemas, builders, validators
│   │   ├── layout-tools.ts         # Layout, layer and instance tools (9)
│   │   ├── animation-tools.ts      # Sprite animation and frame tools (8)
│   │   ├── timeline-tools.ts       # Timeline tools (5)
│   │   ├── project-tools.ts        # Project metadata and addon tools (4)
│   │   └── runtime-tools.ts        # 7 runtime control tools
│   └── prompts/
│       └── workflows.ts            # 6 workflow prompts
├── test/                           # Vitest suites, mocks and fixtures
├── dist/                           # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
├── CHANGELOG.md
└── README.md
```

### Development Commands

```bash
# Install dependencies
npm install

# Build (compile TypeScript)
npm run build

# Watch mode (auto-rebuild on changes)
npm run dev

# Run the test suite (vitest)
npm test

# Start the server
npm start
```

### Building from Source

```bash
git clone https://github.com/liauw-media/construct3-mcp.git
cd construct3-mcp
npm install
npm run build
```

## Contributing

We welcome contributions! Here's how to get started:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Make your changes**
4. **Build and test**: `npm run build && npm start`
5. **Commit your changes**: `git commit -m 'Add amazing feature'`
6. **Push to your branch**: `git push origin feature/amazing-feature`
7. **Open a Pull Request**

## Roadmap

### Phase 1: Foundation ✅
- [x] Read-only project access
- [x] 7 resources, 9 query tools, 6 prompts
- [x] Project structure parsing
- [x] Official documentation access

### Phase 2: Enhanced Analysis ✅
- [x] Event sheet flow visualization (Mermaid diagrams)
- [x] Object dependency graph
- [x] Performance analysis tools
- [x] Asset usage tracking
- [x] Orphaned object detection
- [x] Function mapping across event sheets

### Phase 3: Safe Modifications ✅
- [x] Object creation with proper SID/UID management
- [x] Instance variable and behavior management
- [x] Event sheet creation and event insertion
- [x] Layout creation and instance placement
- [x] Project metadata updates
- [x] Automatic backup, validation, and verification
- [x] Reference checking before deletion
- [x] Addon auto-registration for known plugins

### Phase 4: Event Blocks & Animation ✅
- [x] Event block creation (conditions + actions) with group path targeting
- [x] Script action support (inline JavaScript)
- [x] Animation management (add/update animations on Sprites)
- [x] Object class validation against project entities

### Phase 5: Event & Layout Operations ✅
- [x] Delete events from sheets by SID or include name (dry-run, force, function caller checking)
- [x] Update existing event blocks (modify/add/remove conditions and actions)
- [x] Delete layouts (with reference checking, startup layout protection)
- [x] Update layout properties (event sheet binding, dimensions)
- [x] Full instance property overrides (angle, color, instanceVariables, behaviors, tags, etc.)
- [x] 278 tests, type-safe templates, domain-split tool modules

### Phase 6: Runtime Control ✅
- [x] Injectable runtime bridge (runOnStartup, command queue, tick processing)
- [x] Bridge commands: callFunction, get/setGlobalVar, getObjectState, evaluateExpression, etc.
- [x] Project cloning with bridge injection
- [x] Export-for-preview pre-flight checks (worker mode, bridge registration)
- [x] Bridge eval script generation (curl/python for browser CDP)

### M1 Primitive Surface ✅ (v1.8)
- [x] Layers, instance updates and instance removal
- [x] Families (create, update members and variables, delete)
- [x] Animation frames (add, update, delete, replace image) and animation rename/delete
- [x] Timelines (create, update, delete, list, details)
- [x] Addon registry tools (`list_addons`, `register_addon`, `unregister_addon`)
- [x] Project integrity validation and event group settings
- [x] `.c3p` packing (`pack_project`) and an end-to-end acceptance test

### Phase 7: Advanced Features
- [ ] Opening .c3p (zipped) projects directly
- [ ] Rename with reference updates (dry-run preview)
- [ ] Bulk operations
- [ ] Plugin development assistance

## Known Limitations

- **Folder Format Only**: Works with .c3proj folder projects; `pack_project` can write a .c3p, but .c3p files cannot be opened
- **Editor Holds the Project in Memory**: Close and reopen the project in Construct 3 after MCP edits and before saving there, or the editor can overwrite them
- **No Rename Refactoring**: Renaming objects/sheets does not update cross-references (planned, see Phase 7)
- **Runtime Bridge Requires Browser Automation**: The runtime tools inject a bridge script but need an external tool (Playwright, curl, or any CDP-capable tool) to drive the browser and interact with the running game
- **No ACE Validation**: Event block conditions/actions are not validated against plugin schemas (the AI caller is expected to know valid ACE IDs). Only the editor load-time rules listed under `validate_project` are checked; triggers are recognised by the `on-` id convention, which third-party addons do not always follow, so their trigger problems are warnings only. OR blocks cannot be created: conditions are always AND-combined

## License

MIT License - see [LICENSE](LICENSE) file for details

## Authors

**Contributors**
- Initial development and architecture

## Acknowledgments

- [Anthropic](https://www.anthropic.com/) - For creating the Model Context Protocol
- [Scirra](https://www.construct.net/) - For Construct 3 game engine
- The MCP Community - For inspiration and examples

## Support

- **Issues**: [GitHub Issues](https://github.com/liauw-media/construct3-mcp/issues)
- **Discussions**: [GitHub Discussions](https://github.com/liauw-media/construct3-mcp/discussions)

---

**Made with care for the Construct 3 community**

[Back to top](#construct3-mcp-server)
