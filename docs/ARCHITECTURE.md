# Architecture

## System Overview

The Construct3 MCP Server is a TypeScript-based application that implements the Model Context Protocol (MCP) to provide safe, structured access to Construct 3 game engine projects.

```
┌─────────────────┐
│  Claude AI      │
│  (MCP Client)   │
└────────┬────────┘
         │
         │ MCP Protocol (stdio)
         │
┌────────▼────────────────────────────────────┐
│  Construct3 MCP Server                      │
│  ┌────────────────────────────────────────┐ │
│  │  MCP Protocol Layer                    │ │
│  │  • Resources • Tools • Prompts         │ │
│  └──────────┬──────────────────────────────┘ │
│             │                                │
│  ┌──────────▼──────────────────────────────┐ │
│  │  Business Logic Layer                   │ │
│  │  • Project Reader  • Validators         │ │
│  │  • Documentation Access                 │ │
│  └──────────┬──────────────────────────────┘ │
│             │                                │
│  ┌──────────▼──────────────────────────────┐ │
│  │  File System Layer                      │ │
│  │  • JSON Parsing  • File I/O             │ │
│  └──────────┬──────────────────────────────┘ │
└─────────────┼─────────────────────────────────┘
              │
┌─────────────▼─────────────────┐
│  Construct3 Project Files      │
│  • project.c3proj              │
│  • eventSheets/*.json          │
│  • objectTypes/*.json          │
│  • layouts/*.json              │
└────────────────────────────────┘
```

## Core Components

### 1. MCP Server (`src/index.ts`)

The main entry point that:
- Initializes the MCP server
- Registers handlers for resources, tools, and prompts
- Manages the stdio transport layer
- Handles project initialization and lifecycle

**Key Responsibilities:**
- Protocol compliance
- Request routing
- Error handling
- Project lifecycle management

### 2. Project Reader (`src/construct3/project-reader.ts`)

Handles all file I/O and parsing for Construct3 projects:

```typescript
class Construct3ProjectReader {
  // Core methods
  loadProject(): Promise<Construct3Project>
  readEventSheet(name: string): Promise<EventSheet>
  readObjectType(name: string): Promise<ObjectType>
  readLayout(name: string): Promise<Layout>

  // Query methods
  listEventSheets(): Promise<string[]>
  listObjectTypes(): Promise<string[]>
  searchObjects(pattern: string): string[]
  getMetadata(): ProjectMetadata
}
```

**Design Patterns:**
- **Singleton-like**: One reader instance per server
- **Lazy Loading**: Project files loaded on-demand
- **Caching**: Main project data cached after initial load

### 3. Type System (`src/construct3/types.ts`)

Complete TypeScript type definitions for Construct3 structures:

```typescript
// Main types
Construct3Project
EventSheet
ObjectType
Layout
Addon
ProjectProperties

// Container types
ObjectTypesContainer
EventSheetsContainer
LayoutsContainer
```

**Benefits:**
- Type safety throughout codebase
- IntelliSense support
- Compile-time error detection
- Self-documenting code

### 4. Resources Layer (`src/resources/`)

Implements MCP resources (read-only data access):

**Project Resources** (`project.ts`):
- `construct3://project/info` - Project metadata
- `construct3://project/structure` - Full structure
- `construct3://project/addons` - Plugin list
- `construct3://objects/{name}` - Object details
- `construct3://eventsheets/{name}` - Event sheet details
- `construct3://layouts/{name}` - Layout details

**Documentation Resources** (`docs.ts`):
- `construct3://docs/manual/{topic}` - Official C3 docs
- Fetches and caches documentation from Scirra

### 5. Tools Layer (`src/tools/`)

Implements MCP tools (executable functions):

```typescript
// Query tools (query.ts)
list_objects(filter?: string)
list_eventsheets()
list_layouts()
list_families()
get_object_details(name: string)
get_eventsheet_details(name: string)
get_layout_details(name: string)
search_objects(pattern: string)
get_project_summary()
```

**Tool Design:**
- Input validation using Zod schemas
- Structured error responses
- JSON-formatted outputs
- Idempotent operations

### 6. Prompts Layer (`src/prompts/`)

Implements MCP prompts (workflow templates):

```typescript
// Workflow prompts (workflows.ts)
analyze_project()
find_object_usage(objectName: string)
explain_eventsheet(eventSheetName: string)
review_game_logic()
document_object(objectName: string)
optimize_project()
```

**Prompt Architecture:**
- Contextual information gathering
- Structured prompt generation
- Integration with project data
- Parameterized templates

## Data Flow

### Resource Request Flow

```
1. Claude requests resource: construct3://objects/Player
                             ↓
2. Server parses URI and routes to resource handler
                             ↓
3. Resource handler calls ProjectReader.readObjectType('Player')
                             ↓
4. ProjectReader reads and parses: objectTypes/Player.json
                             ↓
5. Data returned as JSON string in MCP response
                             ↓
6. Claude receives and processes the object data
```

### Tool Execution Flow

```
1. Claude calls tool: list_objects({ filter: "btn" })
                      ↓
2. Server validates parameters with Zod schema
                      ↓
3. Tool handler calls ProjectReader.searchObjects("btn")
                      ↓
4. ProjectReader filters object list
                      ↓
5. Results formatted as JSON
                      ↓
6. Response returned to Claude with success/error status
```

### Prompt Generation Flow

```
1. Claude requests prompt: analyze_project()
                          ↓
2. Prompt handler gathers project data
                          ↓
3. Multiple ProjectReader calls to collect information
                          ↓
4. Data assembled into prompt template
                          ↓
5. Structured prompt messages returned to Claude
```

## Communication Protocol

### Transport Layer

Uses `StdioServerTransport` from MCP SDK:
- **Input**: JSON-RPC 2.0 messages on stdin
- **Output**: JSON-RPC 2.0 responses on stdout
- **Logging**: stderr for debug/error messages

### Message Types

**Capabilities Negotiation:**
```json
{
  "capabilities": {
    "resources": {},
    "tools": {},
    "prompts": {}
  }
}
```

**Resource Request:**
```json
{
  "method": "resources/read",
  "params": {
    "uri": "construct3://objects/Player"
  }
}
```

**Tool Call:**
```json
{
  "method": "tools/call",
  "params": {
    "name": "list_objects",
    "arguments": {
      "filter": "btn"
    }
  }
}
```

## Error Handling

### Error Hierarchy

```
Error Types:
├── ProjectInitializationError - Failed to load project
├── FileNotFoundError - Missing .c3proj or related files
├── ParseError - Invalid JSON in project files
├── ValidationError - Invalid parameters or data
└── ResourceNotFoundError - Requested resource doesn't exist
```

### Error Response Format

```typescript
{
  content: [{
    type: 'text',
    text: 'Error message with context'
  }],
  isError: true
}
```

### Recovery Strategies

1. **Graceful Degradation**: Return partial data when possible
2. **Clear Error Messages**: Include file paths and expected format
3. **Validation**: Check parameters before file operations
4. **Safe Defaults**: Provide empty arrays/objects rather than errors

## Performance Considerations

### Optimization Strategies

1. **Project Caching**: Main project file loaded once
2. **Lazy Loading**: Event sheets/objects loaded on-demand
3. **Selective Reading**: Only requested files are read
4. **Efficient Searching**: In-memory filtering vs. repeated I/O

### Resource Usage

**Memory:**
- Main project: ~500KB - 2MB (typical)
- Each event sheet: ~10KB - 500KB
- Cache size: Unbounded (consider LRU cache in future)

**I/O:**
- Initial load: 1 file read
- Per query: 0-10 file reads (typical)
- No file writes (read-only)

## Security Considerations

### Access Control

- **Read-Only**: No write operations supported
- **Path Traversal**: No prevention (runs with user permissions)
- **Validation**: Input validation on all tool parameters

### Future Security Enhancements

- [ ] Sandboxed file access
- [ ] Path traversal prevention
- [ ] Resource usage limits
- [ ] Rate limiting on requests

## Extension Points

### Adding New Resources

```typescript
// In src/resources/custom.ts
server.resource({
  uri: 'construct3://custom/mydata',
  name: 'My Custom Data',
  description: 'Custom resource description',
  mimeType: 'application/json',
}, async () => {
  const data = await reader.getCustomData();
  return {
    contents: [{
      uri: 'construct3://custom/mydata',
      mimeType: 'application/json',
      text: JSON.stringify(data, null, 2),
    }],
  };
});
```

### Adding New Tools

```typescript
// In src/tools/custom.ts
server.tool({
  name: 'custom_tool',
  description: 'My custom tool',
  parameters: z.object({
    param: z.string(),
  }),
}, async (args: { param: string }) => {
  const result = processCustomLogic(args.param);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result),
    }],
  };
});
```

### Adding New Prompts

```typescript
// In src/prompts/custom.ts
server.prompt({
  name: 'custom_prompt',
  description: 'My custom prompt',
  parameters: z.object({
    param: z.string(),
  }),
}, async (args: { param: string }) => {
  return {
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Custom prompt with ${args.param}`,
      },
    }],
  };
});
```

## Testing Strategy

### Unit Tests
- Project reader methods
- Type validation
- URI parsing
- Error handling

### Integration Tests
- Full MCP protocol flow
- Resource/tool/prompt handlers
- File system interactions

### E2E Tests
- Complete client-server communication
- Real Construct3 projects
- Error scenarios

## Future Architecture Changes

### Planned Improvements

1. **Plugin System**: Support for custom extensions
2. **Caching Layer**: LRU cache for frequently accessed data
3. **Validation Layer**: JSON schema validation for project files
4. **Write Support**: Safe modification with rollback
5. **WebSocket Transport**: Alternative to stdio for web clients

### Scalability Considerations

- **Multiple Projects**: Support concurrent project access
- **Large Projects**: Stream large files instead of loading entirely
- **Performance Monitoring**: Add metrics and telemetry
- **Resource Limits**: Implement quotas and rate limiting

---

**Document Version**: 1.0
**Last Updated**: 2025-10-12
**Authors**: Omnitronix Team
