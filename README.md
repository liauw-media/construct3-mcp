# Construct3 MCP Server

> A Model Context Protocol (MCP) server that enables AI assistants (Claude, Cursor, Antigravity, and any MCP-compatible tool) to safely read, analyze, and modify Construct 3 game engine projects.

> **Work in Progress** — Phases 1-4 are complete and functional. Phase 5 (advanced features) is in development. See the [Roadmap](#roadmap) for details.

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
| `construct3://docs/manual/{topic}` | Official Construct 3 documentation |

### Query Tools (Read-Only)

| Tool | Description |
|------|-------------|
| `list_objects` | List all object types with optional name filtering |
| `list_eventsheets` | List all event sheets |
| `list_layouts` | List all layouts |
| `list_families` | List all object families |
| `get_object_details` | Get detailed info about a specific object |
| `get_eventsheet_details` | Get detailed info about an event sheet |
| `get_layout_details` | Get detailed info about a layout |
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

### Mutation Tools (Safe Write Operations)

| Tool | Description |
|------|-------------|
| `create_object` | Create a new object type (Sprite, Text, TiledBg, global plugins, etc.) |
| `update_object_properties` | Add/remove instance variables and behaviors on an object |
| `delete_object` | Delete an object (with reference checking and optional force) |
| `create_event_sheet` | Create a new event sheet with optional includes |
| `add_event_to_sheet` | Add a group, function, variable, include, or comment to a sheet |
| `add_event_block` | Add a block event with conditions + actions (gameplay logic) |
| `delete_event_sheet` | Delete an event sheet (with reference checking and optional force) |
| `delete_event_from_sheet` | Delete an event from a sheet by SID or include name (dry-run, force) |
| `update_event_block` | Update an existing block: modify/add/remove actions and conditions |
| `create_layout` | Create a new layout with configurable layers |
| `add_instance_to_layout` | Place an object instance on a layout layer with full property control |
| `delete_layout` | Delete a layout (blocks startup layout, checks references) |
| `update_layout` | Update layout event sheet binding and dimensions |
| `update_project_metadata` | Update project name, version, author, or description |
| `add_animation_to_sprite` | Add a new animation to a Sprite object |
| `update_animation_properties` | Update animation speed, looping, ping-pong on a Sprite |

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

All mutation tools follow a strict safety protocol:

1. **Validation** — Names checked for reserved words, path traversal, format. Plugin/behavior IDs validated against `usedAddons`.
2. **Backup** — Every file is backed up to `<filename>.bak` before modification.
3. **ID Generation** — SIDs (15-digit random) and UIDs (sequential) are collision-checked against the entire project.
4. **Write** — JSON is pre-validated (round-trip test, size limit) before writing.
5. **Verify** — Files are read back and re-parsed after writing to confirm integrity.
6. **Cache Invalidation** — All reader caches and indexes are cleared so subsequent reads see fresh data.

Additional safeguards:
- **Reference checking** — `delete_object`, `delete_event_sheet`, and `delete_layout` scan for references before deleting.
- **Addon auto-registration** — When creating objects with new plugins or adding behaviors, known Scirra addons are automatically registered in `usedAddons`. Unknown/third-party addons are blocked with an error.
- **Global plugin protection** — Singleglobal-inst objects (Audio, AJAX, etc.) cannot be placed on layouts.
- **Plugin-specific defaults** — Instances are created with correct default properties for each plugin type (Sprite, Text, TiledBg, NinePatch).

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
│   │   ├── types.ts                # TypeScript type definitions
│   │   └── analyzers/
│   │       ├── index-builder.ts    # Cross-reference index
│   │       ├── eventsheet-flow.ts  # Event sheet flow analysis
│   │       ├── function-map.ts     # Function mapping
│   │       ├── object-deps.ts      # Object dependency analysis
│   │       ├── orphan-finder.ts    # Orphaned object detection
│   │       ├── asset-usage.ts      # Asset usage tracking
│   │       └── performance.ts      # Performance heuristics
│   ├── resources/
│   │   ├── project.ts              # MCP resources
│   │   └── docs.ts                 # Construct 3 documentation access
│   ├── tools/
│   │   ├── query.ts                # 9 query tools
│   │   ├── analysis.ts             # 6 analysis tools
│   │   ├── shared.ts               # Shared validation, error helpers
│   │   ├── event-tools.ts          # Event sheet mutation tools
│   │   ├── event-helpers.ts        # Event Zod schemas, builders, validators
│   │   ├── layout-tools.ts         # Layout mutation tools
│   │   ├── object-tools.ts         # Object mutation tools
│   │   ├── animation-tools.ts      # Animation mutation tools
│   │   └── project-tools.ts        # Project metadata tools
│   └── prompts/
│       └── workflows.ts            # 6 workflow prompts
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
- [x] 192 tests, type-safe templates, domain-split tool modules

### Phase 6: Advanced Features
- [ ] Support for .c3p (zipped) projects
- [ ] Rename with reference updates (dry-run preview)
- [ ] Bulk operations
- [ ] Plugin development assistance

## Known Limitations

- **Folder Format Only**: Works with .c3proj folder projects, not .c3p ZIP files
- **No Rename Refactoring**: Renaming objects/sheets does not update cross-references (planned for Phase 5)
- **No Runtime**: Cannot execute or test games, only analyze and modify structure
- **No ACE Validation**: Event block conditions/actions are not validated against plugin schemas (the AI caller is expected to know valid ACE IDs)

## License

MIT License - see [LICENSE](LICENSE) file for details

## Authors

**Omnitronix Team**
- Initial development for Bonny's Fortune game project

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
