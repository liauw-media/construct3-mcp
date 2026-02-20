# Examples

Real-world examples of using the Construct3 MCP Server with Claude.

## Table of Contents

- [Getting Started](#getting-started)
- [Project Analysis](#project-analysis)
- [Deep Analysis](#deep-analysis)
- [Safe Modifications](#safe-modifications)
- [Finding References](#finding-references)
- [Understanding Code](#understanding-code)
- [Documentation Generation](#documentation-generation)
- [Advanced Workflows](#advanced-workflows)

---

## Getting Started

### First Connection

**Query:**
> "Are you connected to my Construct 3 project?"

**Response:**
> Yes! I'm connected to your project "Bonny's Fortune" (version 0.2.6). The project has:
> - 442 object types
> - 17 event sheets
> - 7 layouts
> - 14 families
>
> Would you like me to analyze any specific aspect?

### Quick Project Overview

**Query:**
> "Give me a quick overview of this project"

**Claude uses**: `get_project_summary`

---

## Project Analysis

### Analyze Project Structure

**Query:**
> "Analyze the structure and organization of this project"

**Claude uses**: `analyze_project` prompt

### Review Game Logic

**Query:**
> "Review the overall game logic architecture"

**Claude uses**: `review_game_logic` prompt

---

## Deep Analysis

### Event Sheet Flow Visualization

**Query:**
> "Show me the event sheet include hierarchy as a diagram"

**Claude uses**: `get_eventsheet_flow` with `format: "mermaid"`

**Result**: A Mermaid flowchart showing which sheets include which, and which layouts are bound to which sheets.

### Function Mapping

**Query:**
> "Map all the functions in the project and where they're called"

**Claude uses**: `get_function_map`

**Result**: List of all function definitions with their parameters, and all call sites across event sheets.

### Object Dependencies

**Query:**
> "What depends on the Player object?"

**Claude uses**: `get_object_dependencies` with `object: "Player"`

**Result**: Lists every event sheet that references "Player", every layout it's placed on, and every family it belongs to.

### Find Orphaned Objects

**Query:**
> "Are there any unused objects I can clean up?"

**Claude uses**: `find_orphaned_objects`

**Result**: Objects not referenced in any event sheet AND not placed in any layout.

### Asset Usage

**Query:**
> "Show me all sound assets and where they're used"

**Claude uses**: `get_asset_usage` with `type: "sound"`

### Performance Audit

**Query:**
> "Run a performance audit on my project"

**Claude uses**: `analyze_performance`

**Result**: Categorized issues (info/warning/critical) with specific recommendations.

---

## Safe Modifications

### Create a Sprite Object

**Query:**
> "Create a new Sprite object called Enemy"

**Claude uses**: `create_object` with `name: "Enemy"`, `pluginId: "Sprite"`

**What happens:**
1. Validates "Enemy" is unique and not reserved
2. Checks that "Sprite" is in `usedAddons`
3. Generates unique SIDs for the object and its default animation
4. Creates `objectTypes/Enemy.json` with proper template
5. Adds "Enemy" to `project.c3proj`

### Create Object in a Subfolder

**Query:**
> "Create a Text object called ScoreDisplay in the UI/HUD subfolder"

**Claude uses**: `create_object` with `name: "ScoreDisplay"`, `pluginId: "Text"`, `subfolder: "UI/HUD"`

### Add Variables and Behaviors to an Object

**Query:**
> "Add a health variable (number, default 100) and a Tween behavior to the Enemy object"

**Claude uses**: `update_object_properties` with:
```json
{
  "name": "Enemy",
  "addVariables": [{ "name": "health", "type": "number" }],
  "addBehaviors": [{ "behaviorId": "Tween", "name": "Tween" }]
}
```

**What happens:**
1. Reads the full existing `Enemy.json` (preserves all fields)
2. Validates "Tween" behavior is in `usedAddons` (auto-registers if known Scirra)
3. Generates unique SIDs for the new variable and behavior
4. Writes updated object back with backup

### Create an Event Sheet with Includes

**Query:**
> "Create an event sheet called MenuLogic that includes the MainData sheet"

**Claude uses**: `create_event_sheet` with `name: "MenuLogic"`, `includeSheets: ["MainData"]`

### Add Events to a Sheet

**Query:**
> "Add a function called InitMenu to the MenuLogic sheet with a layoutName string parameter"

**Claude uses**: `add_event_to_sheet` with:
```json
{
  "sheetName": "MenuLogic",
  "eventType": "function",
  "functionName": "InitMenu",
  "functionParams": [{ "name": "layoutName", "type": "string" }]
}
```

### Create a Layout

**Query:**
> "Create a new layout called LevelSelect with two layers: Background and UI"

**Claude uses**: `create_layout` with:
```json
{
  "name": "LevelSelect",
  "layers": ["Background", "UI"],
  "eventSheet": "MenuLogic"
}
```

### Place an Instance on a Layout

**Query:**
> "Place an Enemy sprite at position 400, 300 on the LevelSelect layout's UI layer"

**Claude uses**: `add_instance_to_layout` with:
```json
{
  "layoutName": "LevelSelect",
  "layerName": "UI",
  "objectType": "Enemy",
  "x": 400,
  "y": 300
}
```

**What happens:**
1. Validates layout, layer, and object all exist
2. Checks Enemy isn't a global-only plugin
3. Generates unique UID and SID
4. Auto-fills Sprite default instance properties
5. Adds instance to the layer's instances array

### Delete an Event Sheet

**Query:**
> "Delete the old MenuLogic event sheet"

**Claude uses**: `delete_event_sheet` with `name: "MenuLogic"`

**If referenced** (e.g., included by another sheet or bound to a layout):
```json
{
  "success": false,
  "action": "delete_blocked",
  "message": "Event sheet is still referenced. Use force=true to delete anyway.",
  "references": {
    "includedBy": ["MainSheet"],
    "boundLayouts": ["Menu"]
  }
}
```

**Force delete:**
> "Force delete MenuLogic even though it's referenced"

Returns success with a warning that references were NOT cleaned up.

### Delete a Layout

**Query:**
> "Delete the LevelSelect layout"

**Claude uses**: `delete_layout` with `name: "LevelSelect"`

**If it's the startup layout:**
Returns an error — the startup layout cannot be deleted.

**If it has placed objects or a bound event sheet:**
```json
{
  "success": false,
  "action": "delete_blocked",
  "references": {
    "boundEventSheet": "MenuLogic",
    "placedObjects": ["Enemy", "ScoreDisplay"]
  }
}
```

### Update Layout Properties

**Query:**
> "Change the Game layout to use the CombatSheet event sheet and set its size to 3840x2160"

**Claude uses**: `update_layout` with:
```json
{
  "name": "Game",
  "eventSheet": "CombatSheet",
  "width": 3840,
  "height": 2160
}
```

### Delete an Object (with reference checking)

**Query:**
> "Delete the Enemy object"

**Claude uses**: `delete_object` with `name: "Enemy"`

**If referenced** (e.g., placed on LevelSelect layout):
```json
{
  "success": false,
  "action": "delete_blocked",
  "message": "Object is still referenced. Use force=true to delete anyway.",
  "references": {
    "eventSheets": [],
    "layouts": ["LevelSelect"],
    "families": []
  }
}
```

**Force delete:**
> "Force delete Enemy even though it's referenced"

Returns success with a warning that references were NOT cleaned up.

### Update Project Metadata

**Query:**
> "Set the project version to 1.1.0 and author to MyStudio"

**Claude uses**: `update_project_metadata` with `version: "1.1.0"`, `author: "MyStudio"`

---

## Event Block Creation

### System Condition → Set Variable

**Query:**
> "On start of layout, set the Player's health to 100"

**Claude uses**: `add_event_block` with:
```json
{
  "sheetName": "GameSheet",
  "conditions": [
    { "id": "on-start-of-layout", "objectClass": "System" }
  ],
  "actions": [
    {
      "id": "set-instvar-value",
      "objectClass": "Player",
      "parameters": { "variable": "health", "value": "100" }
    }
  ]
}
```

### Keyboard Input → Platform Jump

**Query:**
> "When the player presses Space, make them jump using the Platform behavior"

**Claude uses**: `add_event_block` with:
```json
{
  "sheetName": "PlayerControls",
  "conditions": [
    { "id": "on-key-pressed", "objectClass": "Keyboard", "parameters": { "key": "32" } }
  ],
  "actions": [
    {
      "id": "simulate-control",
      "objectClass": "Player",
      "behavior-type": "Platform",
      "parameters": { "control": "jump" }
    }
  ]
}
```

### Collision → Destroy + Subtract Health (Multi-Action)

**Query:**
> "When Enemy collides with Bullet, destroy the bullet and subtract 10 from enemy health"

**Claude uses**: `add_event_block` with:
```json
{
  "sheetName": "CombatSheet",
  "conditions": [
    {
      "id": "on-collision-with-another-object",
      "objectClass": "Enemy",
      "parameters": { "object": "Bullet" }
    }
  ],
  "actions": [
    { "id": "destroy", "objectClass": "Bullet" },
    {
      "id": "set-instvar-value",
      "objectClass": "Enemy",
      "parameters": { "variable": "health", "value": "Enemy.health - 10" }
    }
  ]
}
```

### Event Inside a Group

**Query:**
> "Add a collision check inside the Movement > Physics group"

**Claude uses**: `add_event_block` with `groupPath: "Movement > Physics"`

### Inverted Condition

**Query:**
> "If the player is NOT overlapping SafeZone, subtract 1 from health every tick"

**Claude uses**: `add_event_block` with:
```json
{
  "sheetName": "GameSheet",
  "conditions": [
    {
      "id": "is-overlapping-another-object",
      "objectClass": "Player",
      "parameters": { "object": "SafeZone" },
      "isInverted": true
    }
  ],
  "actions": [
    {
      "id": "subtract-from-instvar",
      "objectClass": "Player",
      "parameters": { "variable": "health", "value": "1" }
    }
  ]
}
```

### Script Action

**Query:**
> "On start of layout, run a script that logs 'Game started'"

**Claude uses**: `add_event_block` with:
```json
{
  "sheetName": "GameSheet",
  "conditions": [
    { "id": "on-start-of-layout", "objectClass": "System" }
  ],
  "actions": [
    { "type": "script", "script": "console.log('Game started');" }
  ]
}
```

---

## Animation Management

### Add a Walk Animation

**Query:**
> "Add a Walk animation to the Player sprite with 8 frames at 12 FPS, looping"

**Claude uses**: `add_animation_to_sprite` with:
```json
{
  "objectName": "Player",
  "animationName": "Walk",
  "speed": 12,
  "isLooping": true,
  "frameCount": 8
}
```

### Update Animation Speed

**Query:**
> "Change the Player's Walk animation to 15 FPS and enable ping-pong"

**Claude uses**: `update_animation_properties` with:
```json
{
  "objectName": "Player",
  "animationName": "Walk",
  "speed": 15,
  "isPingPong": true
}
```

---

## Finding References

### Find Object Usage

**Query:**
> "Where is the spin_btn object used?"

**Claude uses**: `find_object_usage` prompt + `get_object_dependencies`

### Search for Objects

**Query:**
> "Find all button objects"

**Claude uses**: `search_objects` with `pattern: "btn"`

---

## Understanding Code

### Explain Event Sheet

**Query:**
> "Explain how the SpinMachine event sheet works"

**Claude uses**: `explain_eventsheet` prompt + `get_eventsheet_details`

### Understand Plugin Usage

**Query:**
> "How is the AJAX plugin used in this project?"

**Claude uses**: `get_object_details` + `get_object_dependencies`

---

## Documentation Generation

### Document an Object

**Query:**
> "Generate documentation for the Player object"

**Claude uses**: `document_object` prompt

### Document Event Sheet Hierarchy

**Query:**
> "Document all event sheets and their relationships"

**Claude uses**: `get_eventsheet_flow` + `list_eventsheets` + multiple `get_eventsheet_details`

---

## Advanced Workflows

### Full Feature Creation

**Query:**
> "Set up a new Inventory feature: create the event sheet, a Sprite object for items, and a Text object for item names"

**Claude calls in sequence:**
1. `create_event_sheet({ name: "Inventory" })`
2. `create_object({ name: "InventoryItem", pluginId: "Sprite", subfolder: "Inventory" })`
3. `create_object({ name: "ItemLabel", pluginId: "Text", subfolder: "Inventory" })`
4. `update_object_properties({ name: "InventoryItem", addVariables: [{ name: "itemId", type: "number" }] })`
5. `add_event_to_sheet({ sheetName: "Inventory", eventType: "function", functionName: "AddItem", functionParams: [{ name: "id", type: "number" }] })`

### Refactoring Analysis + Cleanup

**Query:**
> "Find unused objects and help me clean them up"

**Claude calls:**
1. `find_orphaned_objects()` — identify candidates
2. `get_object_dependencies({ object: "SomeOrphan" })` — double-check each
3. `delete_object({ name: "ConfirmedOrphan" })` — remove confirmed orphans

### Migration Preparation

**Query:**
> "Audit the project before I upgrade Construct 3"

**Claude calls:**
1. `get_project_summary()` — baseline snapshot
2. `analyze_performance()` — find existing issues
3. `get_eventsheet_flow({ format: "mermaid" })` — document architecture
4. `find_orphaned_objects()` — clean up before migration

---

**Last Updated**: 2026-02-21
