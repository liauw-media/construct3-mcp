# Construct3 MCP Server

> 🎮 A Model Context Protocol (MCP) server that enables AI assistants like Claude to safely read, analyze, and understand Construct 3 game engine projects.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Build the server
npm run build

# Test with your project
node dist/index.js /path/to/your/project.c3proj
```

**Add to Claude Code:**
```json
{
  "mcpServers": {
    "construct3": {
      "command": "node",
      "args": [
        "/absolute/path/to/construct3-mcp/dist/index.js",
        "/absolute/path/to/your-construct3-project"
      ]
    }
  }
}
```

## 📖 Table of Contents

- [Why This Exists](#why-this-exists)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Documentation](#documentation)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## 🤔 Why This Exists

**The Problem**: When you ask Claude Code to work on Construct3 projects, it directly edits JSON files and often breaks:
- Object references and unique IDs
- Event sheet dependencies
- Layout and instance relationships
- Plugin and behavior configurations

**The Solution**: This MCP server provides a **safe, read-only interface** that:
- ✅ Understands Construct3's internal structure
- ✅ Provides structured access to project data
- ✅ Prevents accidental file corruption
- ✅ Enables intelligent analysis and documentation
- ✅ Includes access to official Construct3 documentation

## ✨ Features

### 🔍 Resources (Read-Only Data Access)

| Resource | Description |
|----------|-------------|
| `construct3://project/info` | Project metadata and basic info |
| `construct3://project/structure` | Complete project structure overview |
| `construct3://project/addons` | All plugins, behaviors, and effects |
| `construct3://objects/{name}` | Specific object type details |
| `construct3://eventsheets/{name}` | Specific event sheet details |
| `construct3://layouts/{name}` | Specific layout details |
| `construct3://docs/manual/{topic}` | Official Construct3 documentation |

### 🛠️ Tools (Query Operations)

| Tool | Parameters | Description |
|------|------------|-------------|
| `list_objects` | `filter?: string` | List all object types with optional filtering |
| `list_eventsheets` | - | List all event sheets |
| `list_layouts` | - | List all layouts |
| `list_families` | - | List all object families |
| `get_object_details` | `name: string` | Get detailed info about a specific object |
| `get_eventsheet_details` | `name: string` | Get detailed info about an event sheet |
| `get_layout_details` | `name: string` | Get detailed info about a layout |
| `search_objects` | `pattern: string` | Search objects by name pattern |
| `get_project_summary` | - | Get comprehensive project summary |

### 📝 Prompts (Workflow Templates)

| Prompt | Parameters | Purpose |
|--------|------------|---------|
| `analyze_project` | - | Analyze project structure and organization |
| `find_object_usage` | `objectName` | Find where a specific object is used |
| `explain_eventsheet` | `eventSheetName` | Explain how an event sheet works |
| `review_game_logic` | - | Review overall game logic architecture |
| `document_object` | `objectName` | Generate documentation for an object |
| `optimize_project` | - | Get optimization suggestions |

## 📦 Installation

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

## 🎯 Usage

### With Claude Code

1. Open Claude Code settings
2. Navigate to MCP Servers configuration
3. Add the Construct3 MCP server:

```json
{
  "mcpServers": {
    "construct3": {
      "command": "node",
      "args": [
        "S:\\omnitronix\\construct3-mcp\\dist\\index.js",
        "S:\\omnitronix\\omnitronix-bonnysfortune-frontend"
      ]
    }
  }
}
```

4. Restart Claude Code
5. Look for the 🔌 MCP icon to confirm the server is connected

### With Claude Desktop

**macOS**: Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: Edit `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "construct3": {
      "command": "node",
      "args": [
        "/absolute/path/to/construct3-mcp/dist/index.js",
        "/absolute/path/to/your/construct3-project"
      ]
    }
  }
}
```

### Standalone Testing

Test the server directly from the command line:

```bash
# With specific project file
node dist/index.js /path/to/project.c3proj

# With project directory (auto-detects .c3proj)
node dist/index.js /path/to/project-folder
```

### Example Queries

Once the MCP server is running, ask Claude:

**Project Analysis:**
- "What objects are in my Construct3 project?"
- "Give me an overview of the project structure"
- "What plugins and behaviors are being used?"

**Code Understanding:**
- "Explain how the MainSheet event sheet works"
- "Show me the SpinMachine event logic"
- "What does the FreeSpin event sheet do?"

**Finding References:**
- "Find all uses of the 'spin_btn' object"
- "Where is the 'Touch' plugin used?"
- "Show me all layouts that use the 'Player' object"

**Documentation & Analysis:**
- "Generate documentation for the 'Audio' object"
- "Analyze the game logic architecture"
- "Suggest optimizations for this project"

**Access Construct3 Docs:**
- "Show me the Construct3 documentation for the Sprite plugin"
- "What are the best practices for event sheets?"
- "How do I use the AJAX plugin in Construct3?"

## 📚 Documentation

Comprehensive documentation is available in the `/docs` folder:

- [**Architecture**](docs/ARCHITECTURE.md) - System design and structure
- [**API Reference**](docs/API.md) - Complete API documentation
- [**Examples**](docs/EXAMPLES.md) - Usage examples and recipes
- [**Development Guide**](docs/DEVELOPMENT.md) - Contributing and development
- [**Troubleshooting**](docs/TROUBLESHOOTING.md) - Common issues and solutions

## 🛠️ Development

### Project Structure

```
construct3-mcp/
├── src/
│   ├── index.ts              # Main MCP server entry point
│   ├── construct3/
│   │   ├── project-reader.ts # Construct3 project file parser
│   │   ├── types.ts          # TypeScript type definitions
│   │   └── validator.ts      # Project validation utilities
│   ├── resources/
│   │   ├── project.ts        # MCP resources implementation
│   │   └── docs.ts           # Construct3 documentation access
│   ├── tools/
│   │   └── query.ts          # MCP tools implementation
│   └── prompts/
│       └── workflows.ts      # MCP prompts implementation
├── docs/                     # Comprehensive documentation
├── dist/                     # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
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

## 🤝 Contributing

We welcome contributions! Here's how to get started:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Make your changes**
4. **Build and test**: `npm run build && npm start`
5. **Commit your changes**: `git commit -m 'Add amazing feature'`
6. **Push to your branch**: `git push origin feature/amazing-feature`
7. **Open a Pull Request**

See [DEVELOPMENT.md](docs/DEVELOPMENT.md) for detailed contribution guidelines.

## 🗺️ Roadmap

### Phase 1: Foundation (Current) ✅
- [x] Read-only project access
- [x] Basic resources, tools, and prompts
- [x] Project structure parsing
- [x] Official documentation access

### Phase 2: Enhanced Analysis 🚧
- [ ] Event sheet flow visualization
- [ ] Object dependency graph
- [ ] Performance analysis tools
- [ ] Asset usage tracking

### Phase 3: Safe Modifications 🔮
- [ ] Safe property updates with validation
- [ ] Object creation with proper ID management
- [ ] Event sheet template generation
- [ ] Project scaffolding tools

### Phase 4: Advanced Features 🌟
- [ ] Support for .c3p (zipped) projects
- [ ] Integration with Construct3 CLI
- [ ] Real-time collaboration features
- [ ] Plugin development assistance

## 🐛 Known Limitations

- **Read-Only**: Currently does not support modifying projects
- **Folder Format Only**: Works with .c3proj folder projects, not .c3p ZIP files
- **Complex Events**: Deep event logic can be hard to interpret from JSON
- **No Runtime**: Cannot execute or test games, only analyze structure

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details

## 👥 Authors

**Omnitronix Team**
- Initial development for Bonny's Fortune game project

## 🙏 Acknowledgments

- [Anthropic](https://www.anthropic.com/) - For creating the Model Context Protocol
- [Scirra](https://www.construct.net/) - For Construct 3 game engine
- The MCP Community - For inspiration and examples

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/liauw-media/construct3-mcp/issues)
- **Discussions**: [GitHub Discussions](https://github.com/liauw-media/construct3-mcp/discussions)
- **Documentation**: [Wiki](https://github.com/liauw-media/construct3-mcp/wiki)

---

**Made with ❤️ for the Construct 3 community**

[⬆ back to top](#construct3-mcp-server)
