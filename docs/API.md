# API Reference

Complete reference for all resources, tools, and prompts provided by the Construct3 MCP Server.

## Table of Contents

- [Resources](#resources)
- [Tools](#tools)
- [Prompts](#prompts)
- [Error Handling](#error-handling)
- [Type Definitions](#type-definitions)

## Resources

Resources provide read-only access to project data.

### `construct3://project/info`

Get basic metadata about the Construct3 project.

**Response:**
```json
{
  "name": "My Game",
  "version": "1.0.0",
  "author": "Developer Name",
  "description": "Game description",
  "runtime": "c3",
  "viewportWidth": 1920,
  "viewportHeight": 1080,
  "firstLayout": "Main"
}
```

**Example Query:**
> "Show me the project information"

---

### `construct3://project/structure`

Get complete overview of the project structure.

**Response:**
```json
{
  "metadata": { /* project metadata */ },
  "counts": {
    "objectTypes": 150,
    "eventSheets": 25,
    "layouts": 10,
    "families": 8,
    "addons": 30
  },
  "objectTypes": {
    "items": ["Player", "Enemy", "Bullet", ...],
    "subfolders": [...]
  },
  "eventSheets": { /* ... */ },
  "layouts": { /* ... */ },
  "families": { /* ... */ }
}
```

**Example Query:**
> "Give me an overview of the project structure"

---

### `construct3://project/addons`

List all plugins, behaviors, and effects used in the project.

**Response:**
```json
{
  "plugins": [
    {
      "type": "plugin",
      "id": "Sprite",
      "name": "Sprite",
      "author": "Scirra",
      "bundled": false
    }
  ],
  "behaviors": [...],
  "effects": [...],
  "total": 30
}
```

**Example Query:**
> "What plugins and behaviors are being used?"

---

### `construct3://objects/{name}`

Get detailed information about a specific object type.

**Parameters:**
- `name` (string) - The name of the object type

**Response:**
```json
{
  "name": "Player",
  "plugin-id": "Sprite",
  "sid": 123456789,
  "isGlobal": false,
  "instanceVariables": [...],
  "behaviors": [...],
  "effects": [...]
}
```

**Example Query:**
> "Show me details about the Player object"

---

### `construct3://eventsheets/{name}`

Get detailed information about a specific event sheet.

**Parameters:**
- `name` (string) - The name of the event sheet

**Response:**
```json
{
  "name": "MainSheet",
  "events": [
    {
      "eventType": "block",
      "conditions": [...],
      "actions": [...],
      "subEvents": [...]
    }
  ]
}
```

**Example Query:**
> "Show me the MainSheet event sheet"

---

### `construct3://layouts/{name}`

Get detailed information about a specific layout.

**Parameters:**
- `name` (string) - The name of the layout

**Response:**
```json
{
  "name": "Level1",
  "width": 1920,
  "height": 1080,
  "layers": [
    {
      "name": "Background",
      "visible": true,
      "locked": false,
      "instances": [...]
    }
  ]
}
```

**Example Query:**
> "Show me the Level1 layout"

---

### `construct3://docs/manual/{topic}`

Access official Construct3 documentation.

**Parameters:**
- `topic` (string) - Documentation topic or plugin name

**Response:**
```json
{
  "topic": "sprite",
  "url": "https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/sprite",
  "content": "Documentation content..."
}
```

**Example Query:**
> "Show me the Construct3 documentation for the Sprite plugin"

---

## Tools

Tools are executable functions that query and analyze project data.

### `list_objects`

List all object types in the project with optional filtering.

**Parameters:**
```typescript
{
  filter?: string  // Optional filter pattern (case-insensitive)
}
```

**Returns:**
```json
{
  "count": 25,
  "objects": ["Player", "Enemy", "Bullet", ...],
  "filtered": true
}
```

**Example:**
```
list_objects()
list_objects({ filter: "btn" })
```

**Example Query:**
> "List all objects that contain 'button'"

---

### `list_eventsheets`

List all event sheets in the project.

**Parameters:** None

**Returns:**
```json
{
  "count": 10,
  "eventSheets": ["MainSheet", "GameLogic", "UI", ...]
}
```

**Example Query:**
> "What event sheets exist in this project?"

---

### `list_layouts`

List all layouts in the project.

**Parameters:** None

**Returns:**
```json
{
  "count": 5,
  "layouts": ["Menu", "Level1", "Level2", ...]
}
```

**Example Query:**
> "List all layouts"

---

### `list_families`

List all object families in the project.

**Parameters:** None

**Returns:**
```json
{
  "count": 3,
  "families": ["Enemies", "Collectibles", "UI"]
}
```

**Example Query:**
> "What families are defined?"

---

### `get_object_details`

Get detailed information about a specific object type.

**Parameters:**
```typescript
{
  name: string  // The name of the object type (required)
}
```

**Returns:**
Complete object type JSON structure

**Example:**
```
get_object_details({ name: "Player" })
```

**Example Query:**
> "Get details about the Player object"

---

### `get_eventsheet_details`

Get detailed information about a specific event sheet.

**Parameters:**
```typescript
{
  name: string  // The name of the event sheet (required)
}
```

**Returns:**
Complete event sheet JSON structure with all events

**Example:**
```
get_eventsheet_details({ name: "MainSheet" })
```

**Example Query:**
> "Show me the MainSheet event details"

---

### `get_layout_details`

Get detailed information about a specific layout.

**Parameters:**
```typescript
{
  name: string  // The name of the layout (required)
}
```

**Returns:**
Complete layout JSON structure with layers and instances

**Example:**
```
get_layout_details({ name: "Level1" })
```

**Example Query:**
> "Get details about the Level1 layout"

---

### `search_objects`

Search for objects by name pattern (case-insensitive).

**Parameters:**
```typescript
{
  pattern: string  // Search pattern (required)
}
```

**Returns:**
```json
{
  "pattern": "btn",
  "count": 5,
  "results": ["start_btn", "pause_btn", "resume_btn", ...]
}
```

**Example:**
```
search_objects({ pattern: "btn" })
```

**Example Query:**
> "Find all objects with 'button' in the name"

---

### `get_project_summary`

Get a comprehensive summary of the entire project.

**Parameters:** None

**Returns:**
```json
{
  "project": {
    "name": "My Game",
    "version": "1.0.0",
    ...
  },
  "statistics": {
    "objectTypes": 150,
    "eventSheets": 25,
    "layouts": 10,
    "families": 8,
    "plugins": 20,
    "behaviors": 8,
    "effects": 2
  },
  "lists": {
    "objects": ["Top 10 objects..."],
    "eventSheets": ["Top 10 event sheets..."],
    "layouts": ["Top 10 layouts..."]
  },
  "note": "Lists are limited to first 10 items..."
}
```

**Example Query:**
> "Give me a complete project summary"

---

## Prompts

Prompts are workflow templates that generate structured queries.

### `analyze_project`

Get a detailed analysis of the project structure and organization.

**Parameters:** None

**Generated Prompt:**
Asks Claude to analyze:
1. Project structure overview
2. Naming conventions
3. Organizational improvements
4. Observed patterns

**Example:**
> Use the "analyze_project" prompt

---

### `find_object_usage`

Find where a specific object is used throughout the project.

**Parameters:**
```typescript
{
  objectName: string  // Name of the object to search for
}
```

**Generated Prompt:**
Asks Claude to search:
1. Event sheets (conditions and actions)
2. Layouts (instances)
3. Other objects (references)

**Example:**
```
find_object_usage({ objectName: "Player" })
```

---

### `explain_eventsheet`

Get a detailed explanation of how an event sheet works.

**Parameters:**
```typescript
{
  eventSheetName: string  // Name of the event sheet
}
```

**Generated Prompt:**
Asks Claude to explain:
1. High-level overview
2. Key events and logic flow
3. Included event sheets
4. Optimization suggestions

**Example:**
```
explain_eventsheet({ eventSheetName: "MainSheet" })
```

---

### `review_game_logic`

Review the overall game logic and architecture.

**Parameters:** None

**Generated Prompt:**
Asks Claude to analyze:
1. Event sheet organization
2. Layout flow
3. Separation of concerns
4. Architectural patterns
5. Improvement suggestions

---

### `document_object`

Generate documentation for a specific object type.

**Parameters:**
```typescript
{
  objectName: string  // Name of the object to document
}
```

**Generated Prompt:**
Asks Claude to create:
1. Purpose and description
2. Plugin/type information
3. Properties and meanings
4. Attached behaviors
5. Usage patterns
6. Related objects

**Example:**
```
document_object({ objectName: "Player" })
```

---

### `optimize_project`

Get optimization suggestions for the project.

**Parameters:** None

**Generated Prompt:**
Asks Claude to suggest optimizations for:
1. Performance
2. Asset organization
3. Event sheet structure
4. Object usage patterns
5. Best practices
6. Memory management

---

## Error Handling

### Error Response Format

All errors follow this format:

```json
{
  "content": [{
    "type": "text",
    "text": "Error message with context and details"
  }],
  "isError": true
}
```

### Common Error Types

#### Project Not Found
```
Error: No .c3proj file found in directory: /path/to/dir
```

**Solution:** Ensure the project path points to a valid Construct3 folder project.

#### Invalid Project
```
Error: Invalid Construct3 project file: /path/to/project.c3proj
```

**Solution:** Verify the project file is valid JSON and contains required fields.

#### Resource Not Found
```
Error: Object type "InvalidName" not found
```

**Solution:** Check the object name spelling and case sensitivity.

#### Missing Parameter
```
Error: Object name is required
```

**Solution:** Provide all required parameters for the tool.

---

## Type Definitions

### Construct3Project

```typescript
interface Construct3Project {
  projectFormatVersion: number;
  savedWithRelease: number;
  name: string;
  runtime: string;
  uniqueId: string;
  objectTypes: ObjectTypesContainer;
  families: FamiliesContainer;
  layouts: LayoutsContainer;
  eventSheets: EventSheetsContainer;
  properties: ProjectProperties;
  viewportWidth: number;
  viewportHeight: number;
  firstLayout: string;
}
```

### ObjectType

```typescript
interface ObjectType {
  name: string;
  'plugin-id': string;
  sid: number;
  instanceVariables?: InstanceVariable[];
  behaviors?: Behavior[];
  effects?: Effect[];
}
```

### EventSheet

```typescript
interface EventSheet {
  name: string;
  events: Event[];
}

interface Event {
  eventType: string;
  conditions?: Condition[];
  actions?: Action[];
  subEvents?: Event[];
}
```

### Layout

```typescript
interface Layout {
  name: string;
  width: number;
  height: number;
  layers: Layer[];
}

interface Layer {
  name: string;
  visible: boolean;
  locked: boolean;
  instances: Instance[];
}
```

---

**API Version**: 1.0
**Last Updated**: 2025-10-12
**Compatibility**: MCP Protocol 2025-06-18
