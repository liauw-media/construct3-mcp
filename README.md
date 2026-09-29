# Construct3 MCP Server

> An MCP server that lets Claude, Cursor and other AI assistants read, analyze and safely edit Construct 3 projects — editor-faithful writes with backups and validation. New here? Start with the [User Guide](docs/USER-GUIDE.md).

> **v1.9.2** — Delete and removal tools no longer miss uses inside files the server cannot parse (over 10MB or invalid JSON). 1.9.1 brought frame images that move with their frames, no duplicate UIDs next to large layouts and a new [User Guide](docs/USER-GUIDE.md). See [What's new](#whats-new-in-192) and the [CHANGELOG](CHANGELOG.md).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)

## What's new in 1.9.2

- **Safer deletes next to unparsed files** — `delete_object`, `delete_family`, `delete_layout`, `delete_event_sheet`, `delete_event_from_sheet`, `update_object_properties`, `update_family` and `rename_animation` search registered files over the 10MB read limit or with invalid JSON as text and refuse without `force` on a possible use; results list the unchecked files in `unscannedFiles`.
- **Usage analysis says "possibly used"** — `find_orphaned_objects`, `get_object_dependencies` and `analyze_performance` no longer report objects as unused that such files may use.

## What's new in 1.9.1

- **Frame images stay with their frames** — `add_frame_to_animation` with `index` and `delete_frame_from_animation` move the image files with the frames, keep replaced or deleted images as `.bak`, refuse an index past the end and roll back on failure; `validate_project` reports frames without an image file (`frame-image`).
- **No duplicate UIDs next to files over 10MB** — such layouts and object types are scanned as text for their IDs; `validate_project` reports them as `unscanned-file` with `complete: false`, and `valid` is `false` whenever `complete` is.
- **Function options** — `add_event_to_sheet` takes `functionReturnType`, `functionIsAsync` and `functionCopyPicked`.
- **Per-project index cache** — tools no longer mix up two projects opened in one process.
- **[User Guide](docs/USER-GUIDE.md)** — install, connect your AI tool, first session, safe editing workflow, runtime bridge.

Full list: [CHANGELOG](CHANGELOG.md).

## What's new in 1.9.0

- **Editor load-time checks** — `validate_project` checks a set of rules the Construct 3 editor enforces when it opens a project, and event sheet writes that would add such an error are refused.
- **Behavior conditions and actions the editor reads** — written with `behaviorType`; `fix_legacy_behavior_keys` repairs sheets from older versions (`behavior-type` is still accepted as a deprecated input alias).
- **Find events by editor number** — `locate_event` and `get_eventsheet_outline` turn "sheet, event N, action M" into the event's JSON path.
- **Runtime traps** — `find_runtime_traps`, the `construct3://docs/pitfalls` resource and the `debug_stuck_game` prompt for logic that loads but hangs or fails silently.
- **Editor-faithful event shapes** — else-if and OR blocks, events without conditions, positional function calls, script lines and the Functions object as the editor saves them; `fix_legacy_event_shapes` converts older sheets.
- **Safer deletes and editor name rules** — deletes and removals of used behaviors, instance variables and family members are refused, ambiguous SIDs are refused (pick one with `eventPath`), case-only name clashes are refused, and nested sub-layers are supported everywhere.
- **Accurate reports** — `validate_project`, `find_orphaned_objects`, `get_asset_usage` and `analyze_performance` read editor-saved projects correctly (Transitions folder, animation folders, file assets, non-world instances, sub-layers) instead of reporting false problems.
- **Byte-faithful writes** — line endings, trailing newline, BOM and file-name case are kept; lowercase image file names and per-instance behavior entries match the editor; every write result carries an `editorNote`.

Full list: [CHANGELOG](CHANGELOG.md).

## Quick Start

**New to this server? Read the [User Guide](docs/USER-GUIDE.md).** It covers requirements, setup for each AI tool, a first session, the safe editing workflow (close the project in Construct 3 while the AI edits it) and runtime testing.

The server is not published on npm. Clone it and build it once (Node.js 18 or newer):

```bash
git clone https://github.com/liauw-media/construct3-mcp.git
cd construct3-mcp
npm ci    # installs dependencies and builds dist/ (prepare script)
```

Connect it to Claude Code with absolute paths to `dist/index.js` and to your project folder (the folder that contains `project.c3proj`; `.c3p` files cannot be opened):

```bash
claude mcp add construct3 --scope user -- node /absolute/path/to/construct3-mcp/dist/index.js "/absolute/path/to/My Game"
claude mcp list    # construct3: ... - ✔ Connected
```

Claude Desktop, Cursor, VS Code and others use a JSON config instead, see [Usage](#usage).

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
- Links to the official Construct 3 manual and includes a curated list of Construct 3 pitfalls

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
| `construct3://docs/manual/{topic}` | Link to the construct.net manual page for a topic (the page text is not fetched) |
| `construct3://docs/pitfalls` | Curated Construct 3 pitfalls (signals, scripts, picking, expressions), each tagged with its source |

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
| `get_function_map` | Function definitions and call sites across event sheets (Call function actions, `Functions.Name(...)` expression calls, function map registrations) |
| `get_object_dependencies` | Where objects are used (event sheets, layouts including sub-layers, families); objects that files it could not parse possibly use are marked (`possiblyReferencedIn`, `unscannedFiles`) |
| `find_orphaned_objects` | Find objects not used by any event (including object parameters, expressions and script actions) or layout (including sub-layers, non-world instances and object properties of other instances); objects that files it could not parse possibly use are listed as `possiblyUsed` instead |
| `get_asset_usage` | Track sound, image, font, video and project file usage (used, unused or not analysed) |
| `analyze_performance` | Heuristic performance audit with categorized issues |
| `validate_project` | Integrity checks: missing files, required fields, duplicate SIDs/UIDs, repeated layer names, function names shared by several function blocks, broken references and includes, behaviors and instance variables that events use but their object lacks, missing addons, legacy `"behavior-type"` keys, layout instances without behavior entries, event shapes older versions wrote that the editor never writes, scripts in the one-string shape of older Construct 3 releases, orphaned and backup files, plus the rules the C3 editor enforces at load (trigger and else placement, expression syntax limited to unterminated string literals and backslashes outside them, empty expressions, duplicate names/SIDs, family plugins). Rules verified only in part are reported as warnings (details in [API.md](docs/API.md#validate_project)). `valid` means no errors and every registered file was checked; `complete` (and so `valid`) is false when a registered file exists but was not checked (over the 10MB read limit, invalid JSON, unreadable; listed in `unscannedFiles`) |
| `get_group_settings` | Event group settings (`isActiveOnStart`, disabled) across sheets, filterable by sheet and active state |
| `locate_event` | Map an editor event number ("es_game, event 72, action 1") to its JSON path, sid, content and neighbouring events |
| `get_eventsheet_outline` | Readable, paged event sheet outline with editor event numbers (IF/DO/CALL/SCRIPT/GROUP/FUNCTION/VAR) |
| `find_runtime_traps` | Runtime traps: Wait for signal tags nothing signals, waits that start after a call already raised their tag, unused/dynamic signal tags, scripts using function parameters without `localVars` |

### Mutation Tools (Safe Write Operations)

**Objects and families**

| Tool | Description |
|------|-------------|
| `create_object` | Create a new object type (Sprite, Text, TiledBg, global plugins, etc.); refuses names that clash with an object type, a family, System or the Functions object, ignoring case |
| `update_object_properties` | Add/remove instance variables and behaviors, change global status; removing one that events still use is refused, listing the uses, unless forced |
| `delete_object` | Delete an object; refused while anything uses it (events, instances on any layer or sub-layer, families), listing where, unless forced |
| `create_family` | Create a family; refuses name clashes and members of mixed plugins (load-time checked) |
| `update_family` | Add/remove members and shared instance variables; refuses member changes that mix plugins (load-time checked), and removing an instance variable or member through which events still use the family's instance variables or behaviors, unless forced |
| `delete_family` | Delete a family; refused while events or object properties name it or events use its instance variables or behaviors through a member, listing where, unless forced |

**Event sheets**

| Tool | Description |
|------|-------------|
| `create_event_sheet` | Create a new event sheet with optional includes; refuses names that differ from an existing sheet only in case |
| `add_event_to_sheet` | Add a group, function, variable, include, or comment (with colours) to a sheet (load-time checked); functions take the editor's return type, *Asynchronous* and *Copy picked* options; the names of a new (global) variable, of a function and of its parameters are checked like in the editor (no second function with the same name, ignoring case); returns the new SIDs (`generatedSid`, `functionParameterSids`), `eventPath` and `backupFile` |
| `add_event_block` | Add a block event with conditions + actions (gameplay logic), written in the editor's own shapes: sub-events (also without conditions), else/else-if blocks, OR blocks, function calls, script actions, comment rows; refuses writes that break the checked editor load-time rules (unterminated string literals and backslashes outside them, empty expressions, trigger placement) and warns where Else cannot stand (after a triggered event) |
| `update_event_block` | Update an existing block: modify/add/remove actions and conditions, edit comment rows (text and colours) in place, make it an else or OR block (load-time checked) |
| `update_event_block_action` | Replace the parameters of one action in a block (by block SID and action index; function call arguments as an array; load-time checked) |
| `update_event_variable` | Rename a variable or change its type, initial value, static or constant flag; a new name is checked like in the editor |
| `move_events_between_sheets` | Copy or move top-level events between sheets by SID (optionally into a group); load-time checked, so copying an event that breaks a load-time rule is refused; a copy or move that would clash event variable names (e.g. a copied global variable) is refused, and so is (without `force`) a move that takes a used variable out of scope, e.g. a global variable moved into a group |
| `delete_event_from_sheet` | Delete an event from a sheet by SID or include name (dry-run, force); refuses while functions or event variables it removes are still referenced elsewhere (by calls, function maps, System variable ACEs or by name in expressions); warns about an else block the delete leaves behind |
| `remove_event_from_sheet` | Remove an include from a sheet by included sheet name |
| `delete_event_sheet` | Delete an event sheet (with reference checking and optional force): includes, layout bindings, and uses in other sheets of the functions and global variables it defines |
| `fix_legacy_behavior_keys` | Rename legacy `"behavior-type"` keys (written by older versions) to `"behaviorType"` in all event sheets, checking each name against the object's behaviors (dry-run by default) |
| `fix_legacy_event_shapes` | Convert event shapes written by older versions into the editor's own (block `isElse` to a System else condition, condition `isOr` to `isOrBlock`, old-shape function calls to positional arguments, one-string scripts, as older Construct 3 releases also saved them, to lines) where the result is unambiguous; reports the rest and which conversions can change how an event runs (dry-run by default) |

Event SIDs are not always unique in editor-saved sheets. The tools that find an event by SID refuse a SID shared by several events in the sheet and list the candidates; pass `eventPath` (the JSON path that `locate_event` returns, e.g. `events[3].children[1]`) to pick one. `move_events_between_sheets` keeps SIDs and warns when a copy leaves such a shared SID in the target sheet. See [API.md](docs/API.md#mutation-tools).

**Layouts, layers and instances**

| Tool | Description |
|------|-------------|
| `create_layout` | Create a new layout with configurable layers; refuses names that differ from an existing layout only in case |
| `update_layout` | Update layout event sheet binding and dimensions |
| `delete_layout` | Delete a layout (blocks startup layout, checks references) |
| `add_layer` | Add a layer (position, visibility, transparency, parallax, blend mode); refuses a name any layer or sub-layer of the layout uses, ignoring case |
| `update_layer` | Rename a layer or sub-layer or change visibility, interactivity, parallax, blend mode, scale rate, Z elevation; refuses a new name used by another layer or sub-layer, ignoring case |
| `delete_layer` | Delete a layer or sub-layer with its sub-layers (never the last top-level one; blocked while they hold instances unless forced) |
| `add_instance_to_layout` | Place an object instance on a layout layer or sub-layer with full property control |
| `update_instance` | Update a placed instance by UID on any layer or sub-layer (position, size, angle, color, visibility, tags, instance variables) |
| `delete_instance_from_layout` | Remove a placed instance by UID (layers, sub-layers and non-world instances) |

**Sprite animations**

| Tool | Description |
|------|-------------|
| `add_animation_to_sprite` | Add a new animation to a Sprite object |
| `update_animation_properties` | Update animation speed, looping, ping-pong, repeat count |
| `rename_animation` | Rename an animation with its frame image files and the layout instances starting with it |
| `delete_animation` | Delete an animation (never the last one) |
| `add_frame_to_animation` | Add a blank frame (placeholder PNG) at an index; later frame images move up with their frames |
| `update_frame` | Update a frame's duration, size or origin |
| `delete_frame_from_animation` | Delete a frame by index (never the last one); its image is kept as `.bak`, later frame images move down |
| `replace_sprite_image` | Replace a frame's image with base64 PNG data |

**Timelines**

| Tool | Description |
|------|-------------|
| `create_timeline` | Create a timeline (duration, loop, ping-pong, repeat count, start-on-layout); refuses a case variant of a timeline in the same folder |
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
| `generate_bridge_eval_script` | Return the browser-console lines that submit a bridge command and read its result, plus a Python snippet that only prints those lines (nothing connects to the browser) |
| `export_for_preview` | Pre-flight checks (worker mode, bridge injection) for preview testing; reports the worker mode without changing it, and injects the bridge into the project unless `injectBridge: false` |
| `clone_project` | Deep-copy the project with optional bridge injection |
| `pack_project` | Pack the project folder into a `.c3p` file that Construct 3 can open (injects the bridge into the project first unless `injectBridge: false`) |

The runtime bridge lets the browser console or a browser-automation tool (Playwright, anything that speaks the Chrome DevTools Protocol) control a running C3 game. The bridge is registered as a script with Purpose "(none)", and according to the Construct 3 manual Construct only runs the main script automatically, so import it from your main script (`import "./c3-runtime-bridge.js";`) or set its Purpose to Main script; this step is not yet confirmed in a live preview (see the [User Guide](docs/USER-GUIDE.md#testing-a-running-game-with-the-runtime-bridge)). With *Use worker* set to *No* and the game previewed, `submit()` queues a command and returns its id; the result is available after the next tick and can be read once with `getResult()`:

```javascript
// From the browser console or any CDP-capable automation tool
const id = globalThis.__c3bridge.submit("getGlobalVar", { name: "Score" });
globalThis.__c3bridge.getResult(id);   // { ok: true, value: ... }, null while pending
globalThis.__c3bridge.submit("callFunction", { name: "StartGame", params: [] });
globalThis.__c3bridge.submit("getObjectState", { objectName: "Player" });
```

Remove the bridge before exporting the game for players: while it runs, anyone with the browser console can change variables and call functions. `remove_runtime_bridge` deletes only the script file and its entry in `project.c3proj`, not an import line in your main script. So first delete the `import "./c3-runtime-bridge.js";` line from your main script in Construct 3 (save, close), then run `remove_runtime_bridge`. See the [User Guide](docs/USER-GUIDE.md#remove-the-bridge-before-you-export).

### Prompts (Workflow Templates)

| Prompt | Purpose |
|--------|---------|
| `analyze_project` | Analyze project structure and organization |
| `find_object_usage` | Find where a specific object is used |
| `explain_eventsheet` | Explain how an event sheet works |
| `review_game_logic` | Review overall game logic architecture |
| `document_object` | Generate documentation for an object |
| `optimize_project` | Get optimization suggestions |
| `debug_stuck_game` | Diagnose soft-locks and silently dead features (runs `find_runtime_traps`, uses the pitfalls doc) |

## Safety Model

Mutation tools follow a strict safety protocol (exceptions below):

1. **Validation** — Names checked for reserved words, path traversal, format. Plugin/behavior IDs validated against `usedAddons`.
2. **Backup** — JSON files are backed up to `<filename>.bak` before modification.
3. **ID Generation** — SIDs (15-digit random), UIDs (sequential), and imageSpriteIds (7-digit) are collision-checked against the entire project. Layouts and object types over the 10MB read limit or with invalid JSON are scanned as text for their UIDs and SIDs; when a registered layout or object type exists but cannot be read at all, a new UID is refused instead of guessed.
4. **Write** — JSON is pre-validated (round-trip test, size limit), then written to a temp file and renamed into place. Files keep their text style (see below).
5. **Verify** — Files are read back, compared with what was written, and re-parsed to confirm integrity.
6. **Cache Invalidation** — All reader caches and indexes are cleared so subsequent reads see fresh data.

Steps 2, 4 and 5 apply in full to writes that go through the project writer: objects, families, event sheets, layouts, animations, project metadata and addon auto-registration. The other write paths do less:
- `register_addon` and `unregister_addon` replace `project.c3proj` through a temp file, with no `.bak` backup and no read-back check.
- The timeline tools back up the timeline file and `project.c3proj` and write through a temp file, but do not read the result back.
- The runtime tools (`inject_runtime_bridge`, `remove_runtime_bridge`, and `export_for_preview` / `pack_project` when they inject the bridge) write `project.c3proj` and the bridge script in place, with no backup or read-back check.
- PNG images are written without a backup, except that the frame tools keep a file they would replace or remove as `.bak` (see *Frame images move with their frames* below).

**Close and reopen the project in Construct 3 before saving there.** The editor keeps an open project in memory, so saving from a session that was opened before these edits can overwrite them. Its Project Bar reload (F9) re-reads script files only, not event sheets, layouts or `project.c3proj`. Every response that reports a completed write carries this reminder as `editorNote`. Error responses do not, even when a multi-step tool (e.g. `create_object`) failed after an earlier step had already written.

Additional safeguards:
- **Reference checking** — `delete_object`, `delete_family`, `delete_event_sheet`, and `delete_layout` scan for references before deleting; `delete_event_from_sheet` and `delete_event_sheet` check for calls and uses of the functions and event variables they remove (for a deleted sheet: its functions and global variables, used from other sheets); `update_object_properties` and `update_family` check the events before removing an instance variable, a behavior or a family member. Registered files these checks cannot parse (over the 10MB read limit, not valid JSON) are searched as text for the names they look for: a match is a *possible* use (the name may be in another string), and it refuses without `force` just like a use, as does such a file that cannot be read at all. The response lists these files in `unscannedFiles`; without a match the tool goes ahead and warns that the file was only searched as text. `delete_object` and `delete_family` also refuse when the object type's or family's own file could not be parsed, and `rename_animation` refuses when such a layout possibly has instances that start with the animation. `delete_event_sheet`, `delete_event_from_sheet` and `move_events_between_sheets` walk the events of all event sheets for the uses of the functions and event variables they delete or move and stop after 100,000 events (sub-events included); in a project that large the uses beyond are unknown, so they refuse without `force` then as well.
- **Addon auto-registration** — When creating objects with new plugins or adding behaviors, known Scirra addons are automatically registered in `usedAddons`. Unknown/third-party addons are blocked with an error unless `register_addon` added them to `usedAddons` first (it does not check the ID or install anything).
- **Global plugin protection** — Singleglobal-inst objects (Audio, AJAX, etc.) cannot be placed on layouts.
- **Plugin-specific defaults** — Instances are created with correct default properties for each plugin type (Sprite, Text, TiledBg, NinePatch).
- **Image generation** — Sprite and TiledBg creation automatically generates valid placeholder PNGs, named like the editor names them: `images/<object>-<animation>-000.png`, all lowercase. Batch writes roll back on failure.
- **Frame images move with their frames** — The editor names a frame's image file after the frame's index, so `add_frame_to_animation` with an `index` and `delete_frame_from_animation` rename the image files of the later frames one index up or down (JPEG and other formats keep their extension). The deleted frame's image, and any unused file whose name a moved image or new placeholder needs, are kept as `<file>.bak` instead of being deleted or replaced. If a write fails, the placeholder is removed, the object file restored and the image files renamed back; when another write replaced the object file in the meantime, its content is kept and the image files are made to match it. The animation tools run one at a time, so parallel calls on one Sprite cannot move each other's images or write its object without each other's frames. `validate_project` reports frames without an image file (`frame-image`) and lists the `.bak` files in `images/` (`backup-file`).
- **Layout instance sync** — Like the editor, every layout instance carries an entry for each behavior of its object type and of the families it belongs to, with the built-in behaviors' default property values. `add_instance_to_layout` writes these entries; adding or removing a behavior (`update_object_properties`) or changing family membership (`update_family`, `delete_family`) updates the existing instances. Behavior or variable changes also make sure every instance of the object has the `behaviors` and `instanceVariables` dicts C3 expects.
- **Names compared like the editor** — Create and rename tools refuse a name that differs from an existing one only in case where Construct 3 compares names ignoring case: event sheets and layouts (project-wide), object types and families, the layers of one layout (sub-layers included; the editor cannot load a layout with two such layers), the animations of one sprite (in any animation folder), and sibling project-bar folders. Timeline names are compared exactly, as the editor does, but a case variant of a timeline in the same folder is refused because both would share one file on Windows and macOS. Tools that check an entity together with the rest of the project take its name only as registered, letter case included: `update_object_properties`, `update_family`, and the event sheet tools whose checks compare a sheet with the other sheets (`add_event_to_sheet`, `delete_event_sheet`, `delete_event_from_sheet`, `update_event_variable`, `move_events_between_sheets`).
- **Event variable names checked like the editor** — `add_event_to_sheet` and `update_event_variable` refuse the event variable and function parameter names the editor's variable and parameter dialogs refuse: a name that matches, ignoring case, an event variable or function parameter in its scope (for a global variable, any in the project; for a local one or a parameter, the globals, the variables and parameters of its enclosing events and those below its parent event or function), the name of a System expression (e.g. `time`, `random`), and names with whitespace, punctuation such as `-` `.` `:`, a leading underscore or only digits. Names of object types and families are allowed, as in the editor. `move_events_between_sheets` refuses a copy or move that would create such a clash, e.g. a copy of a global variable (the editor renames a pasted variable instead). Function names must differ, ignoring case, from every other function in the project and from System expression names; a function with a return type also follows the character rules above. `move_events_between_sheets` refuses to copy a function block, and `validate_project` reports names that several function blocks share (`duplicate-function-name`).
- **No overwrite on create** — Create tools refuse to write an entity JSON file (object type, family, event sheet, layout) or a timeline file where one already exists, also one whose name differs only in case (an unregistered file, or one registered under another spelling). Nothing is backed up or replaced. Placeholder PNGs are not covered: `create_object` and `add_animation_to_sprite` write them over an image file of the same name in `images/`, e.g. one left behind by a deleted object or animation; `add_frame_to_animation` renames such a file to `<file>.bak` first.
- **File names kept** — Rewriting an existing file keeps its name on disk exactly, including case (e.g. `Layout1.json` registered as `layout1`); the `.bak` backup takes the same name.
- **Text style preserved** — JSON is written the way Construct 3 saves it (tab indent). A file that already exists keeps its own line endings (e.g. CRLF from a git `core.autocrlf` checkout), exact trailing whitespace and BOM. A new file follows `project.c3proj`, then the first JSON file with line breaks in its target folder, then Construct 3's own style (LF, no trailing newline, no BOM). For files in Construct 3's tab layout, diffs show only the lines that changed; files indented another way (e.g. with spaces) are re-indented with tabs in full.

## Documentation

Detailed documentation is available in the `/docs` folder:

- [**User Guide**](docs/USER-GUIDE.md) - Install, connect your AI tool, first session, safe editing workflow, runtime testing
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

The package is not on npm. Clone the repository and install:

```bash
git clone https://github.com/liauw-media/construct3-mcp.git
cd construct3-mcp
npm ci
```

`npm install` works too. Do not install with `--omit=dev` or `--production`: the build step needs the TypeScript dev dependency and fails without it.

### Build

`npm ci` and `npm install` already build the server (the `prepare` script runs `npm run build`), which compiles TypeScript to JavaScript in the `dist/` folder. Run the build yourself only after changing the source:

```bash
npm run build
```

## Usage

Step-by-step instructions for each client are in the [User Guide](docs/USER-GUIDE.md#connect-your-ai-tool).

The server finds its project in this order: the first argument after `dist/index.js` (a project folder or the `.c3proj` file), the `C3_PROJECT_PATH` environment variable, the working directory it is started in. A folder must contain the `.c3proj` file directly; subfolders and parent folders are not searched. Most clients do not start the server in your project folder, so pass the project path.

**MCP config** (Claude Desktop, Antigravity, Windsurf and a hand-written Claude Code `.mcp.json`; Cursor and VS Code need `"type": "stdio"`, and VS Code uses a different top-level key, see below):
```json
{
  "mcpServers": {
    "construct3": {
      "command": "node",
      "args": ["/absolute/path/to/construct3-mcp/dist/index.js", "/absolute/path/to/your-project"]
    }
  }
}
```

On Windows, write paths in JSON with forward slashes (`"C:/Games/My Game"`) or doubled backslashes (`"C:\\Games\\My Game"`); single backslashes make the file invalid JSON. Each path is one array element, also when it contains spaces. Leave out the project path only if the client starts the server in the folder that contains the `.c3proj`.

### With Claude Code

Add the server with the CLI:

```bash
claude mcp add construct3 --scope user -- node /absolute/path/to/construct3-mcp/dist/index.js "/absolute/path/to/your-project"
claude mcp list
```

`claude mcp list` should show `construct3: ... - ✔ Connected`. Inside a session, `/mcp` shows the status and can reconnect the server.

- `--scope user` stores the server in `~/.claude.json` for every folder. Without `--scope` (local scope) it only applies when `claude` is started in the folder where you ran the command; if that folder is in a git repository, it applies anywhere in that repository (a second `claude mcp add construct3` for another game in the same repository fails with `already exists in local config`; see the [User Guide](docs/USER-GUIDE.md#which-scope) for several games). `--scope project` writes a `.mcp.json` into the current folder.
- A `.mcp.json` in the project folder (the JSON above) also works, but Claude Code does not start it until you approve it: `claude mcp list` shows `⏸ Pending approval` until you start `claude` in that folder, trust the folder and approve the server.
- Claude Code does not read `~/.claude/mcp.json`.
- Without a project path, the server only starts when Claude Code is started in the folder that directly contains the `.c3proj`. Started anywhere else, `claude mcp list` shows `✘ Failed to connect`.

Windows shell pitfalls (PowerShell and `--`, Git Bash and backslashes) and tool permissions: [User Guide](docs/USER-GUIDE.md#claude-code).

### With Claude Desktop

Add the config to your Claude Desktop settings file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Note: Claude Desktop doesn't change working directory per-project, so pass the project path explicitly in `args`. Quit Claude Desktop completely and start it again after editing the file; closing the window is not enough.

### With Cursor

Add the config to `.cursor/mcp.json` in your project root (project-specific) or `~/.cursor/mcp.json` (global). Cursor's documentation lists `"type": "stdio"` as a required field of each server entry. In `.cursor/mcp.json`, `"${workspaceFolder}"` can stand for the project path:

```json
{
  "mcpServers": {
    "construct3": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/construct3-mcp/dist/index.js", "${workspaceFolder}"]
    }
  }
}
```

1. Restart Cursor after adding or modifying the config
2. The Construct 3 tools appear in Cursor's AI agent

### With VS Code

VS Code (GitHub Copilot agent mode) reads `.vscode/mcp.json`, whose top-level key is `"servers"`, not `"mcpServers"`, and each entry needs `"type": "stdio"`:

```json
{
  "servers": {
    "construct3": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/construct3-mcp/dist/index.js", "${workspaceFolder}"]
    }
  }
}
```

### With Antigravity

Add the config to Antigravity's MCP configuration:

- **Via UI**: Click the `...` menu in the Agent panel → **MCP Servers** → **Manage MCP Servers** → **View raw config**
- **Direct edit**: the current Antigravity documentation names `~/.gemini/config/mcp_config.json` (global) and `.agents/mcp_config.json` (workspace); the UI route above opens the right file

Note: Antigravity doesn't set a working directory per-project, so pass the project path explicitly in `args`.

### With Windsurf

Windsurf (now Devin Desktop) uses the same `mcpServers` format. Its Cascade agent allows at most 100 tools in total, and this server alone brings 71.

### Standalone Testing

```bash
# Auto-detect .c3proj in current directory
cd /path/to/project-folder
node /path/to/construct3-mcp/dist/index.js

# Or pass explicit path
node dist/index.js /path/to/project.c3proj
node dist/index.js /path/to/project-folder
```

On success the server prints `Construct3 MCP Server ready` (on stderr) and then waits silently for an MCP client on stdin; that is not a hang. Press Ctrl+C to stop it. On a wrong path it prints `Failed to start server: ...` and exits with code 1.

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
- "Which Construct 3 pitfalls should I know about?" (reads `construct3://docs/pitfalls`)
- "Give me the manual link for the Sprite plugin" (the documentation resources return construct.net links, not the page text)

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
│   │   ├── event-shapes.ts         # The event shapes the editor writes (else, OR, calls, scripts)
│   │   ├── instance-behaviors.ts   # Behavior entries on layout instances
│   │   ├── animation-rename.ts     # Frame image files and layout instances a rename_animation changes, frame image moves on frame insert/delete
│   │   ├── json-format.ts          # On-disk text style (line endings, trailing newline, BOM)
│   │   ├── layers.ts               # Layer trees: every layer and sub-layer, their instances, layer names
│   │   ├── atomic-write.ts         # Temp-file-and-rename writes that keep file names on disk
│   │   ├── names.ts                # Case-insensitive name and folder comparison
│   │   ├── event-variable-names.ts # Editor name rules for event variables and function parameters
│   │   ├── path-utils.ts           # Path resolution inside the project folder
│   │   ├── png-generator.ts        # Zero-dep placeholder PNG generation
│   │   ├── raw-text-search.ts      # Streamed whole-word text search in files the reader skips
│   │   ├── timeline-folders.ts     # The editor's Transitions folder in the timelines container
│   │   ├── types.ts                # TypeScript type definitions
│   │   └── analyzers/
│   │       ├── index-builder.ts    # Cross-reference index
│   │       ├── event-flow.ts       # Event sheet flow and function map
│   │       ├── object-deps.ts      # Object dependencies and orphaned objects
│   │       ├── asset-usage.ts      # Asset usage tracking
│   │       ├── animations.ts       # Sprite animation trees (items + subfolders)
│   │       ├── event-outline.ts    # Editor event numbers, event sheet outline
│   │       ├── performance.ts      # Performance heuristics
│   │       ├── integrity.ts        # Project integrity checks (validate_project)
│   │       ├── load-rules.ts       # Editor load-time rules (validate_project, pre-write checks)
│   │       ├── legacy-behavior-keys.ts # Legacy "behavior-type" key scan and repair
│   │       ├── legacy-event-shapes.ts # Legacy isElse/isOr/function call/script shape scan and repair
│   │       ├── delete-references.ts # Function and variable names an event delete would leave dangling
│   │       ├── unscanned-uses.ts   # Possible uses in registered files the bulk reads skipped
│   │       ├── behavior-refs.ts    # Behavior name checks against objects and families
│   │       ├── group-settings.ts   # Event group settings (get_group_settings)
│   │       ├── runtime-traps.ts    # Signal pairing and order, script/parameter traps
│   │       └── script-scan.ts      # Lightweight JS/TS scanner for script actions
│   ├── resources/
│   │   ├── project.ts              # 6 project resources
│   │   ├── docs.ts                 # 3 Construct 3 documentation resources
│   │   └── pitfalls.ts             # Curated pitfalls doc (construct3://docs/pitfalls)
│   ├── runtime/
│   │   ├── bridge.ts               # Injectable C3 runtime bridge script generator
│   │   └── zip-writer.ts           # Zero-dep ZIP writer for .c3p packing
│   ├── tools/
│   │   ├── query.ts                # 9 query tools
│   │   ├── analysis.ts             # 11 analysis tools
│   │   ├── mutations.ts            # Registers the domain tool modules below
│   │   ├── shared.ts               # Shared validation, result/error helpers, editor reload note
│   │   ├── object-tools.ts         # Object and family tools (6)
│   │   ├── event-tools.ts          # Event sheet tools (12)
│   │   ├── event-helpers.ts        # Event Zod schemas, builders, validators
│   │   ├── layout-tools.ts         # Layout, layer and instance tools (9)
│   │   ├── animation-tools.ts      # Sprite animation and frame tools (8)
│   │   ├── timeline-tools.ts       # Timeline tools (5)
│   │   ├── project-tools.ts        # Project metadata and addon tools (4)
│   │   └── runtime-tools.ts        # 7 runtime control tools
│   └── prompts/
│       └── workflows.ts            # 7 workflow prompts
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
- [x] Delete events from sheets by SID or include name (dry-run, force, checks for references to the functions and event variables it removes)
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

### Editor Fidelity ✅ (v1.9)
- [x] Editor load-time checks in `validate_project` and before event sheet writes
- [x] Event shapes, names, image file names and instance behavior entries as the editor writes them, with repair tools for older sheets
- [x] Event locator and outline by editor event number, runtime trap analysis and curated pitfalls
- [x] Reference-checked deletes, ambiguous-SID protection and nested sub-layers in every layout tool
- [x] Byte-faithful writes (line endings, BOM, file-name case)

### Phase 7: Advanced Features
- [ ] Opening .c3p (zipped) projects directly
- [ ] Rename with reference updates (dry-run preview)
- [ ] Bulk operations
- [ ] Plugin development assistance

## Known Limitations

- **Folder Format Only**: Works with .c3proj folder projects; `pack_project` can write a .c3p, but .c3p files cannot be opened
- **Editor Holds the Project in Memory**: Close and reopen the project in Construct 3 after MCP edits and before saving there, or the editor can overwrite them
- **No Rename Refactoring**: Objects, families, event sheets, layouts and timelines cannot be renamed; renaming a layer (`update_layer`) or an event variable (`update_event_variable`) does not update the events that use the old name (issue #38). `rename_animation` renames the frame images and the layout instances' start animation, but not text in events. Renaming with reference updates is planned (Phase 7)
- **Runtime Bridge Requires Browser Automation**: The runtime tools inject a bridge script but need an external tool (Playwright, curl, or any CDP-capable tool) to drive the browser and interact with the running game
- **No ACE Validation**: Event block conditions/actions are not validated against plugin schemas (the AI caller is expected to know valid ACE IDs). Only the editor load-time rules listed under `validate_project` are checked; triggers are recognised by the `on-` id convention, which third-party addons do not always follow, so their trigger problems are warnings only. OR blocks are created with `isOrBlock`

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
