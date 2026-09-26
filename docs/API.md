# API Reference

Complete reference for all resources, tools, and prompts provided by the Construct3 MCP Server.

## Table of Contents

- [Resources](#resources)
- [Query Tools](#query-tools)
- [Analysis Tools](#analysis-tools)
- [Mutation Tools](#mutation-tools)
- [Runtime Tools](#runtime-tools)
- [Prompts](#prompts)
- [Error Handling](#error-handling)
- [Type Definitions](#type-definitions)

---

## Resources

Resources provide read-only access to project data.

### `construct3://project/info`

Project metadata and basic info.

**Response:**
```json
{
  "name": "My Game",
  "version": "1.0.0",
  "author": "Developer",
  "runtime": "c3",
  "viewportWidth": 1920,
  "viewportHeight": 1080,
  "firstLayout": "Main"
}
```

### `construct3://project/structure`

Complete project structure with entity counts and folder hierarchy.

### `construct3://project/addons`

All used plugins, behaviors, and effects with metadata.

### `construct3://objects/{name}`

Full JSON for a specific object type.

### `construct3://eventsheets/{name}`

Full JSON for a specific event sheet.

### `construct3://layouts/{name}`

Full JSON for a specific layout.

### `construct3://docs/index`

Index of documentation: the manual URL, topic categories (interface, project, plugins, behaviors, effects, scripting, publishing) and popular plugin topics.

### `construct3://docs/manual/{topic}`

Official Construct 3 documentation fetched from construct.net.

---

## Query Tools

### `list_objects`

List all object types with optional name filtering.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filter` | string | No | Case-insensitive name filter |

### `list_eventsheets`

List all event sheets. No parameters.

### `list_layouts`

List all layouts. No parameters.

### `list_families`

List all object families. No parameters.

### `get_object_details`

Get full details for a specific object type.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Object name (fuzzy suggestions on miss) |

### `get_eventsheet_details`

Get full details for a specific event sheet.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Event sheet name |

### `get_layout_details`

Get full details for a specific layout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Layout name |

### `search_objects`

Search objects by name pattern (case-insensitive substring match).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | Yes | Search pattern |

### `get_project_summary`

Comprehensive project overview including metadata, statistics, addon counts, and entity lists. No parameters.

### `list_timelines`

List all timeline names (root and subfolders) with a count, in project-bar order. No parameters. Transitions (the easing curves in the editor's Transitions folder, which `project.c3proj` keeps as the `timelines` subfolder without a `name`) are returned separately in `transitions`.

### `get_timeline_details`

Full timeline JSON, including tracks and settings. The file is located from the timeline's folder in `project.c3proj`: `timelines/<name>.json` at the root, `timelines/<folder>/.../<name>.json` in a subfolder. Transitions (stored in `timelines/transitions/`) are refused: the timeline tools never read, change or delete them.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Timeline name |

### `list_addons`

List the addons registered in the project's `usedAddons`, with a count.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"plugin"` \| `"behavior"` \| `"effect"` \| `"all"` | No | Filter by addon type (default: all) |

---

## Analysis Tools

The analysis tools with a `detail` parameter accept `"summary"` (under ~2K tokens), `"standard"` (default), or `"full"`.

### `get_eventsheet_flow`

Event sheet include hierarchy and layout bindings.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `eventsheet` | string | No | Start from a specific sheet (omit for full project) |
| `format` | `"mermaid"` \| `"json"` | No | Output format (default: mermaid) |
| `detail` | string | No | Detail level |

### `get_function_map`

Function definitions and call sites across event sheets.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `eventsheet` | string | No | Filter to a specific event sheet |
| `detail` | string | No | Detail level |

### `get_object_dependencies`

Where objects are used: event sheets, layouts, families, co-occurring objects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `object` | string | No | Specific object (omit for project-wide top 20) |
| `detail` | string | No | Detail level |

### `find_orphaned_objects`

Find objects not referenced in any event sheet or placed in any layout. No parameters.

### `get_asset_usage`

Track asset usage across the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"sound"` \| `"music"` \| `"image"` \| `"font"` \| `"video"` \| `"icon"` \| `"general"` \| `"all"` | No | Filter by asset type (default: all) |
| `detail` | string | No | Detail level |

### `analyze_performance`

Heuristic performance audit with categorized issues (info/warning/critical).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `scope` | string | No | Event sheet or layout name to scope analysis |
| `detail` | string | No | Detail level |

### `validate_project`

Run integrity checks over the whole project. No parameters.

Returns `{ valid, summary, errors, warnings, info }`; each issue has `check`, `entity`, `message` and an optional `suggestion`. `valid` is true when there are no errors.

- **Errors:** registered entities whose file is missing or not valid JSON, missing required fields in objects, sheets and layouts, internal `name` differing from the registered name, malformed subfolder entries, conditions/actions that name their behavior only under the legacy `"behavior-type"` key (`legacy-behavior-key`, see [`fix_legacy_behavior_keys`](#fix_legacy_behavior_keys)), and the editor load-time rules below
- **Warnings:** duplicate SIDs and UIDs (except the SID duplicates listed below as errors), broken object references, layouts bound to missing event sheets, broken includes, plugins or behaviors missing from `usedAddons`, leftover `"behavior-type"` keys next to a valid `"behaviorType"`, and the partly verified load-time rules below
- **Info:** JSON files not registered in `project.c3proj`, leftover `.bak` files, orphaned objects

**Editor load-time rules.** The Construct 3 editor enforces these only when it opens a project, and breaking one can make the whole project fail to open. The rules come from [komabear/c3-skill](https://github.com/komabear/c3-skill) (MIT) and were checked against the Construct 3 manual, real editor-saved projects, and the error messages of the editor's project loader (release r495.2). Where only part of a rule could be verified, it is reported as a warning.

| Check | Severity | Rule |
|-------|----------|------|
| `expression-syntax` | error | A backslash outside a string literal, or an unterminated string literal, in any condition/action parameter (function and custom action call arguments included). C3 expressions have no escape sequences: a quote inside a string is written as two quotes (`"He said ""hi"""`), so `"{\"a\":1}"` fails with *Syntax error: Unknown character*. A backslash inside a string literal is fine. |
| `empty-expression` | error | A parameter whose value is `""` fails with *Empty expression: You must enter an expression*. Write an empty string literal as `"\"\""`. |
| `trigger-placement` | error / warning | Only one trigger per event, unless it is an OR block (`"isOrBlock": true` on the event), which may hold several. A branch holds one trigger: no trigger in a sub-event of a triggered event, of a function block or of a custom action block. Both fail with *cannot add another trigger to event branch*. Groups are transparent. A trigger that is not the first condition of its event is a warning: the editor moves it to the top when it opens the project. Triggers are conditions whose id starts with `on-`; the editor counts fake triggers (*On collision*, Timer *On timer*, Gamepad buttons) as triggers too. Problems involving third-party addon triggers are warnings, since those addons do not always follow the `on-` convention. |
| `duplicate-object-name` | error | Object types and families share one name namespace that ignores case. A name listed twice in the `project.c3proj` objectTypes or families tree, two names that differ only in case, and a family named like an object type all fail with *object class name 'X' already used*. |
| `family-plugin-mismatch` | error / warning | Every member of a family must use the same plugin; a mixed family fails with *wrong plugin* (error). Members that agree with each other but not with the family's `plugin-id` are a warning. |
| `duplicate-sid` | error / warning | Two object types or families sharing a SID fail with *object class sid already in use* (error). A SID shared by behaviors or instance variables of object type or family files is a warning: SIDs should be unique, but no load failure is on record for this clash, and the editor's loader checks only object type and family SIDs. Animation and frame SIDs repeated across object types are warnings: a Scirra example project does this and opens. SIDs shared by events, conditions, actions or layout instances are warnings: editor-saved projects contain such duplicates and open, and the editor keeps them when it saves, so re-saving does not fix them. A clash involving a function or custom action parameter is a warning that may break loading, since the loader checks function parameter SIDs. Event sheet locations name the event path and the condition/action index (e.g. `eventSheets/Sheet1 > block (sid 12) > action 0 "wait" (System)`); a SID used more than five times lists the first five locations and a count per file. Layout `instanceFolderItem` SIDs legitimately repeat the instance SID and are not checked. |

**Known false positives.** Projects that open fine in Construct 3 can still get these reports; the first one makes `valid` false:
- Construct 3 itself writes a subfolder without a `name` into `timelines` (its Transitions folder, see [`list_timelines`](#list_timelines)), which is reported as a `subfolder-structure` error.
- Built-in function actions use `"objectClass": "Functions"`, which is reported as a `broken-object-reference` warning.
- The editor's `*.uistate.json` files, and lowercase file names written by older releases (e.g. `objectTypes/text.json` for `Text`), are reported as `orphaned-file` info with the suggestion to delete them. Do not delete them.

### `get_group_settings`

Event group settings across event sheets: title, sheet, `isActiveOnStart`, `disabled`, nesting depth, parent group, child group and event counts. Returns `groups`, `summary` (totals) and `bySheet`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `eventsheet` | string | No | Filter to a specific event sheet |
| `activeOnly` | boolean | No | Only groups with `isActiveOnStart = true` |
| `inactiveOnly` | boolean | No | Only groups with `isActiveOnStart = false` |

---

## Mutation Tools

Mutation tools that write through the project writer (objects, families, event sheets, layouts, animations, project metadata, addon auto-registration) follow the safety pipeline: validate → backup → write → verify → invalidate caches. The other write paths do less: `register_addon` / `unregister_addon` use a temp file but make no `.bak` backup and no read-back check; the timeline tools back up and use a temp file but do not read back; the runtime tools write `project.c3proj` and the bridge script in place, with no backup or read-back check; PNG images are written without a backup. Mutation tools return a `WriteResult` object on success.

**Text style.** An overwritten file keeps its line endings (LF or CRLF), exact trailing whitespace and BOM. A new file follows `project.c3proj`, then the first JSON file with line breaks in its target folder, then Construct 3's own style: tab-indented JSON with LF line endings, no trailing newline and no BOM. Only files already in that tab layout get line-level diffs; files indented another way are re-indented in full.

**Editor reload note.** Every response that reports a completed write includes `editorNote`: *"If this project is open in Construct 3, close and reopen it there before saving, or the editor can overwrite these changes."* The editor keeps an open project in memory, so saving from a session opened before the edit can overwrite it; its Project Bar reload (F9) re-reads script files only. A `WriteResult` with `success: true` counts as a write unless it is a dry run. Tools whose success does not imply a write carry no note: the `already_registered` no-op of `register_addon`, `fix_legacy_behavior_keys` with `dryRun: false` when it found nothing to rename, `clone_project`, and `export_for_preview` / `pack_project` with `injectBridge: false`. Error responses never carry the note, even when a multi-step tool (e.g. `create_object`) failed after an earlier step had already written.

### `create_object`

Create a new object type in the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Object name (unique, alphanumeric + underscore + spaces) |
| `pluginId` | string | Yes | Plugin ID: `"Sprite"`, `"Text"`, `"TiledBg"`, `"NinePatch"`, `"Audio"`, etc. |
| `isGlobal` | boolean | No | Auto-detected for known global plugins |
| `subfolder` | string | No | Subfolder path (e.g., `"UI/Buttons"`) |

**What it does:**
1. Validates name (uniqueness, reserved names, format). A name equal to an existing object type or family name, ignoring case, is refused: the editor would fail to open the project (load-time rule `duplicate-object-name`, see [`validate_project`](#validate_project)).
2. Ensures plugin is registered in `usedAddons` (auto-adds known Scirra plugins)
3. Generates SID (+ UID for global plugins, + animation SID for Sprite)
4. Builds from plugin-specific template
5. Writes `objectTypes/<name>.json`
6. Adds name to `project.c3proj` objectTypes container

### `update_object_properties`

Update an existing object's instance variables and behaviors.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Existing object name |
| `isGlobal` | boolean | No | Change global status |
| `addVariables` | array | No | `[{ name, type: "number"\|"string"\|"boolean" }]` |
| `removeVariables` | string[] | No | Variable names to remove |
| `addBehaviors` | array | No | `[{ behaviorId: "Tween"\|"Sin"\|etc., name }]` |
| `removeBehaviors` | string[] | No | Behavior names to remove |

**Notes:**
- Reads the full existing object and preserves all fields not being modified
- Validates behavior addon registration (auto-adds known Scirra behaviors)
- Generates unique SIDs for each new variable and behavior
- Warns on duplicate variable/behavior names (skips them)

### `delete_object`

Delete an object type from the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Object name to delete |
| `force` | boolean | No | Delete even if referenced (default: false) |

**Behavior:**
- Checks for references in event sheets, layouts, and families
- If referenced and `force=false`: returns the reference list and blocks
- If referenced and `force=true`: deletes with warning (references NOT cleaned up)
- Backs up the JSON file and removes from c3proj

### `create_family`

Create a new family. Families group object types of one plugin and share instance variables and behaviors across them.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Family name (unique) |
| `pluginId` | string | Yes | Plugin ID all members share (e.g. `"Sprite"`, `"Text"`) |
| `members` | string[] | No | Initial member object names (default: `[]`); unknown names produce a warning |
| `subfolder` | string | No | Subfolder path (e.g. `"UI"`) |

**Load-time checks** (see [`validate_project`](#validate_project)): a name equal to an existing object type or family name, ignoring case, is refused (`duplicate-object-name`). Members must all use one plugin: a member whose plugin differs from the others is refused (`family-plugin-mismatch`, *wrong plugin*). Members that agree with each other but not with `pluginId` only produce a warning. Members that do not exist produce a warning.

### `update_family`

Add or remove family members and shared instance variables.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Family name |
| `addMembers` | string[] | No | Object names to add |
| `removeMembers` | string[] | No | Object names to remove |
| `addVariables` | array | No | `[{ name, type: "number"\|"string"\|"boolean" }]` |
| `removeVariables` | string[] | No | Variable names to remove |

At least one parameter besides `name` must be provided. Duplicates and missing entries are skipped with a warning.

**Load-time check:** a member change that makes the family mix plugins is refused and nothing is written (`family-plugin-mismatch`, *wrong plugin*). A mix that was already there does not block other updates, and removing the odd member is allowed.

### `delete_family`

Delete a family (backs up the JSON file and removes it from c3proj). No reference check.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Family name to delete |

### `create_event_sheet`

Create a new event sheet.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Event sheet name |
| `subfolder` | string | No | Subfolder path |
| `includeSheets` | string[] | No | Sheets to auto-include (validated for existence) |

### `add_event_to_sheet`

Add a structural event to an existing event sheet.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `eventType` | enum | Yes | `"group"` \| `"function"` \| `"variable"` \| `"include"` \| `"comment"` |
| `title` | string | For groups | Group title |
| `functionName` | string | For functions | Function name |
| `functionParams` | array | For functions | `[{ name, type }]` |
| `variableName` | string | For variables | Variable name |
| `variableType` | enum | For variables | `"number"` \| `"string"` \| `"boolean"` |
| `initialValue` | string | For variables | Initial value |
| `includeSheet` | string | For includes | Sheet to include (validated) |
| `commentText` | string | For comments | Comment text |
| `position` | enum | No | `"start"` \| `"end"` (default: end) |

Runs the same load-time gate as `add_event_block` before writing.

### `add_event_block`

Add a block event (conditions + actions) to an event sheet — the core of gameplay logic. Supports sub-events, else blocks, and per-action disabling. Conditions are AND-combined: C3 OR blocks cannot be created with these tools, so give each trigger its own event.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `conditions` | array | No* | Conditions. Each: `{ id, objectClass, behaviorType?, parameters?, isInverted?, isOr? }`. *Required (min 1) unless `isElse` is true. |
| `actions` | array | No | Actions (default: `[]`). Standard: `{ id, objectClass, behaviorType?, parameters?, callFunction?, disabled? }`. Script: `{ type: "script", script }` |
| `groupPath` | string | No | Insert inside group by title path (e.g., `"Movement > Collision"`) |
| `position` | enum | No | `"start"` \| `"end"` (default: end) |
| `disabled` | boolean | No | Create the block disabled (default: false) |
| `isElse` | boolean | No | Mark as an else block — conditions become optional (default: false) |
| `children` | array | No | Sub-events nested inside this block (recursive). Each child has the same shape: `{ conditions?, actions?, disabled?, isElse?, children? }` |

**Condition fields:**
- `behaviorType` — For behavior conditions/actions: the behavior's *name* as defined on the object type or one of its families (e.g. `"Platform"`, `"8Direction"` — not the behaviorId `"EightDir"`). Omit for plugin and System ACEs. Written to the event sheet as `"behaviorType"`, the key Construct 3 reads.
- `"behavior-type"` — **Deprecated** alias for `behaviorType`, still accepted and written as `behaviorType` (with a warning). Passing both with different values is an error.
- `isOr` — legacy flag, written as given. It does **not** make a C3 OR: Construct 3 ORs a whole event (an OR block, `"isOrBlock": true` on the event), never single conditions, and the editor ignores a per-condition `isOr`. The conditions stay AND-combined. The event tools cannot create OR blocks.
- `isInverted` — Negate the condition.

**Action fields:**
- `behaviorType` / deprecated `"behavior-type"` — same as for conditions.
- `disabled` — Disable an individual action (the action exists but won't run).

**Sub-events (`children`):**
- Each child is a full block event with its own conditions, actions, and children.
- Children with `isElse: true` act as "Else" branches and don't require conditions.
- Max nesting depth: 5 levels. Max total events (parent + all descendants): 50.

**Validation:**
- `objectClass` is hard-validated against project objects, families, and `"System"` — across the entire tree (parent + all descendants)
- `behaviorType` is soft-validated (warning only, never blocks the write): it must name a behavior on the object type or on a family the object belongs to (for a family `objectClass`: on the family). The warning lists the available behavior names and hints when a behaviorId was passed instead of the name. When the object type or a family file cannot be read, the warning says the behavior could not be verified instead.
- `id` (ACE identifier) is **not** validated — Claude knows the hundreds of C3 ACE IDs
- Script actions (`type: "script"`) skip objectClass validation and SID generation

**Load-time gate:** before writing, the sheet is checked against the editor load-time rules `expression-syntax`, `empty-expression` and `trigger-placement` (see [`validate_project`](#validate_project)). The check covers the whole sheet, so the new block's position counts, and it compares the sheet before and after the change. A new error blocks the write with an explanation and nothing is written. New warnings are returned in `warnings`. Problems that were already in the sheet do not block the write, unless the change makes one of them worse (a warning that becomes an error); fixing part of an existing problem is allowed. The same gate runs in `add_event_to_sheet`, `update_event_block` and `update_event_block_action`. `move_events_between_sheets` runs it over the source and target sheets together: moving an event that already breaks a rule (`deleteSource: true`) is allowed, while copying it is refused, since the copy adds the problem to a second sheet.

Two triggers in one block are rejected even with `isOr` set (see `isOr` above). For "Space OR Up pressed", add one event per trigger.

**What it does:**
1. Reads the target event sheet
2. Validates all `objectClass` references across the entire event tree
3. Recursively generates SIDs for each block, condition, and standard action
4. Builds condition/action objects with optional fields (`behaviorType`, `parameters`, `isInverted`, `isOr`, `callFunction`, `disabled`)
5. Recursively builds child sub-events with `isElse` support
6. If `groupPath`: resolves nested group path (error with available groups on miss)
7. Inserts at position (`start`/`end`)
8. Runs the load-time gate (blocks on new errors)
9. Writes sheet back with backup

### `delete_event_sheet`

Delete an event sheet from the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Event sheet name to delete |
| `force` | boolean | No | Delete even if referenced (default: false) |

**Behavior:**
- Checks for references: sheets that include this one, layouts bound to it
- If referenced and `force=false`: returns the reference list and blocks
- If referenced and `force=true`: deletes with warning (references NOT cleaned up)
- Backs up the JSON file and removes from c3proj

### `delete_event_from_sheet`

Delete an event from an event sheet by SID or include name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `sid` | number | No* | SID of the event to delete (block, group, variable, function) |
| `includeSheet` | string | No* | For removing includes: the included sheet name |
| `dryRun` | boolean | No | Preview what would be deleted without deleting (default: false) |
| `force` | boolean | No | Delete function-blocks even if they have callers (default: false) |

*Exactly one of `sid` or `includeSheet` must be provided.

**Behavior:**
- **SID deletion**: Finds the event anywhere in the tree (including nested inside groups) using iterative traversal. Reports children count for groups, checks function callers for function-blocks.
- **Include deletion**: Finds and removes the include event by sheet name. Lists current includes in error messages.
- **Dry run**: Returns a preview of what would be deleted without writing changes.
- **Function safety**: Blocks deletion of function-blocks that have callers (unless `force=true`).
- Error messages include a navigable summary of top-level events with their types and SIDs.

### `update_event_block`

Update an existing block event — modify action parameters, add/remove actions or conditions, toggle disabled state.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `sid` | number | Yes | SID of the block event to update |
| `disabled` | boolean | No | Enable or disable the entire block |
| `updateActions` | array | No | `[{ index, parameters?, disabled? }]` — update actions by index (merge semantics) |
| `updateConditions` | array | No | `[{ index, parameters?, isInverted? }]` — update conditions by index |
| `addActions` | array | No | Append new actions (standard or script) |
| `addConditions` | array | No | Append new conditions |
| `removeActionIndices` | number[] | No | Remove actions by 0-based index |
| `removeConditionIndices` | number[] | No | Remove conditions by 0-based index |

At least one update parameter must be provided.

**Operation ordering** (all indices reference the ORIGINAL array positions):
1. Updates (non-length-mutating) — merge parameters, toggle flags
2. Removals (descending order, deduped) — shrink arrays
3. Additions (append) — grow arrays
4. Final state checks — warn if all conditions removed

**Notes:**
- Only works on `block` or `function-block` events (not groups, variables, etc.)
- New actions/conditions get fresh SIDs via the ID generator
- `objectClass` is validated on new conditions/actions; `behaviorType` is soft-validated and the deprecated `"behavior-type"` alias is normalized, as in `add_event_block`. All additions are validated in one pass before anything changes, so each warning appears once and a conflicting key aborts the call without writing.
- Existing conditions/actions edited through `updateConditions`/`updateActions` that still carry the legacy `"behavior-type"` key are normalized to `"behaviorType"` with the same rules as `fix_legacy_behavior_keys`, and each one is reported in `warnings`. `update_event_block_action` does the same for the action it edits.
- Duplicate removal indices are automatically deduplicated
- Warns when all conditions are removed (block becomes unconditional)
- Runs the load-time gate (see `add_event_block`) on the whole sheet, so a trigger added to a sub-event of a triggered event, of a function block or of a custom action block is rejected, as is a second trigger in one event. New conditions are appended, so a trigger added to a block that already has conditions ends up after them; that only warns, since the editor moves it to the top when it opens the project.

### `update_event_block_action`

Replace the parameters of a single action. The block is found by SID anywhere in the sheet; the action by its 0-based index.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `blockSid` | number | Yes | SID of the `block` or `function-block` holding the action |
| `actionIndex` | number | Yes | 0-based action index |
| `parameters` | object | Yes | New parameter values; replaces the existing `parameters` entirely (max 100 keys, depth 6) |

Runs the load-time gate (see [`add_event_block`](#add_event_block)): parameters that break `expression-syntax` or `empty-expression` are refused and nothing is written. A legacy `"behavior-type"` key on the edited action is normalized as in `update_event_block` and reported in `warnings`.

### `update_event_variable`

Update an event variable declaration found by SID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet containing the variable |
| `sid` | number | Yes | SID of the `variable` event |
| `newName` | string | No | New name (must be unused in the sheet) |
| `newType` | `"number"` \| `"string"` \| `"boolean"` | No | New type |
| `newInitialValue` | string | No | New initial value, as a string |
| `isStatic` | boolean | No | Value persists between calls |
| `isConstant` | boolean | No | Value cannot change at runtime |

At least one change must be provided. References to the old name are not updated.

### `move_events_between_sheets`

Copy top-level events from one sheet to another by SID; with `deleteSource` they are moved. SIDs and nested children are kept as they are.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sourceSheet` | string | Yes | Sheet to copy/move from |
| `targetSheet` | string | Yes | Sheet to copy/move into (must differ from the source) |
| `sids` | number[] | Yes | SIDs of top-level events in the source sheet (min 1) |
| `deleteSource` | boolean | No | Remove the events from the source after copying (default: false) |
| `targetGroupPath` | string | No | Insert into a group by title path (e.g. `"Movement > Collision"`) |
| `position` | `"start"` \| `"end"` | No | Insert position (default: end) |

Runs the load-time gate (see [`add_event_block`](#add_event_block)) over the source and target sheets together, before anything is written. Moving an event that already breaks a load-time rule only relocates the problem and is allowed; copying it (`deleteSource: false`) adds the problem to a second sheet, so a copied error is refused and a copied warning is returned in `warnings`.

Returns `movedSids`, `movedCount`, `backupFiles` (target first, then source when modified) and new load-time `warnings`, if any.

### `remove_event_from_sheet`

Remove include events for a given sheet from an event sheet. Use `delete_event_from_sheet` with a SID for other event types.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet to modify |
| `includeSheet` | string | Yes | Name of the included sheet to remove |

### `fix_legacy_behavior_keys`

Repair event sheets written by construct3-mcp 1.8.1 and earlier, which stored the behavior of a condition/action under `"behavior-type"`. Construct 3 reads `"behaviorType"`; with only the legacy key it looks the ACE up on the object's base plugin and fails to open the project (e.g. `Error: missing action id 'flash'`, issue #16).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dryRun` | boolean | No | Only report what would change (default: **true**). Set `false` to rewrite the affected sheets. |

**Behavior:**
- Scans every event sheet, including groups, sub-events and function blocks.
- Renames `"behavior-type"` to `"behaviorType"` in place (key order is kept); drops the legacy key when an identical `"behaviorType"` already exists.
- Before renaming, checks that the value names a behavior on the object type or one of its families (as `add_event_block` does). Values that match no behavior — e.g. a behaviorId such as `"EightDir"` instead of the name `"8Direction"` — are reported under `unresolved` with a hint and left untouched, since renaming them would not make the project loadable. Values that cannot be checked (unreadable object type or family file) are renamed and carry a `warning`.
- Conditions/actions where both keys disagree, or the legacy value is not a non-empty string, are reported under `conflicts` and left untouched.
- Only sheets with changes are written, each through the normal pipeline (backup → validate → write → verify → invalidate caches).
- Returns `totalRenamed`, `totalUnresolved`, `totalConflicts` and per-sheet `changes` (SID, ACE id, objectClass; capped at 100 per sheet), `unresolved`, `conflicts` plus `backupFile` when written. Sheets that could not be read are listed in `unreadableSheets` and named in the message.
- If a write fails part-way, the error names the sheets already rewritten.

`validate_project` reports affected sheets with check `legacy-behavior-key`:
- **error** when a condition/action names its behavior only under `"behavior-type"` (the load failure above). The message calls out values that match no behavior, and the suggestion only points to this tool for the ones it can rename.
- **warning** when the legacy key is a leftover next to a valid `"behaviorType"` or holds no behavior name — Construct 3 does not read the key, so it is dead data.

### `create_layout`

Create a new layout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Layout name |
| `width` | number | No | Width in pixels (default: project viewport width) |
| `height` | number | No | Height in pixels (default: project viewport height) |
| `eventSheet` | string | No | Linked event sheet name (validated) |
| `layers` | string[] | No | Layer names (default: single `"Layer 0"`) |

### `add_instance_to_layout`

Place an object instance on a layout layer. For copying instances between layouts, read the source with `get_layout_details` and pass instance properties here.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Target layout |
| `layerName` | string | Yes | Target layer |
| `objectType` | string | Yes | Object type to place |
| `x` | number | Yes | X position |
| `y` | number | Yes | Y position |
| `width` | number | No | Instance width (default: 100) |
| `height` | number | No | Instance height (default: 100) |
| `properties` | object | No | Plugin-specific properties (auto-filled for known plugins) |
| `angle` | number | No | Rotation angle in radians (default: 0) |
| `color` | number[4] | No | RGBA tint as `[r, g, b, a]` with values 0-1 (default: [1,1,1,1]) |
| `zElevation` | number | No | Z elevation for 3D layering (default: 0) |
| `originX` | number | No | Horizontal origin 0-1 (default: 0.5 = center) |
| `originY` | number | No | Vertical origin 0-1 (default: 0.5 = center) |
| `instanceVariables` | object | No | Instance variable values as `{varName: value}` |
| `behaviors` | object | No | Behavior runtime state as `{behaviorName: {prop: val}}` |
| `tags` | string | No | Comma-separated instance tags (alphanumeric only) |
| `showing` | boolean | No | Whether instance is initially visible (default: true) |
| `locked` | boolean | No | Whether instance is locked in the editor (default: false) |

**Notes:**
- Blocks global-only objects (singleglobal-inst) from being placed
- Nonworld-global objects (Array, JSON, Dictionary) are placed in `nonworld-instances` instead of on layers
- Auto-fills default instance properties for Sprite, Text, TiledBg, NinePatch
- Warns on unknown instanceVariable or behavior keys (may be inherited from families)
- All visual and behavioral properties are preserved when specified

### `delete_layout`

Delete a layout from the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Layout name to delete |
| `force` | boolean | No | Delete even if referenced (default: false) |

**Behavior:**
- Blocks unconditionally if the layout is the project's startup layout (`firstLayout`)
- Checks for bound event sheets and placed objects
- If referenced and `force=false`: returns the reference list and blocks
- If referenced and `force=true`: deletes with warning (references NOT cleaned up)
- Backs up the JSON file and removes from c3proj

### `update_layout`

Update layout properties (event sheet binding, dimensions).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Layout name to update |
| `eventSheet` | string | No | New event sheet binding (validated for existence) |
| `width` | number | No | New layout width in pixels |
| `height` | number | No | New layout height in pixels |

At least one parameter must be provided.

### `add_layer`

Add a new layer to a layout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout to add the layer to |
| `layerName` | string | Yes | New layer name (unique within the layout) |
| `index` | number | No | Insert position (0 = bottom; default: on top) |
| `isInitiallyVisible` | boolean | No | Starts visible (default: true) |
| `isTransparent` | boolean | No | Transparent background (default: true) |
| `parallaxX` | number | No | Horizontal parallax rate (default: 1) |
| `parallaxY` | number | No | Vertical parallax rate (default: 1) |
| `blendMode` | enum | No | `"normal"` (default), `"additive"`, `"xor"`, `"copy"`, `"destination-over"`, `"source-in"`, `"destination-in"`, `"source-out"`, `"destination-out"`, `"source-atop"`, `"destination-atop"` |

### `update_layer`

Update properties of an existing layer.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `layerName` | string | Yes | Layer to update |
| `newName` | string | No | Rename the layer (must be unused in the layout) |
| `isInitiallyVisible` | boolean | No | Initial visibility |
| `isInitiallyInteractive` | boolean | No | Initial interactivity |
| `isTransparent` | boolean | No | Transparency |
| `parallaxX` | number | No | Horizontal parallax rate |
| `parallaxY` | number | No | Vertical parallax rate |
| `blendMode` | enum | No | Same values as `add_layer` |
| `scaleRate` | number | No | Scale rate (parallax zoom) |
| `zElevation` | number | No | Z elevation for 3D layering |

At least one property must be provided.

### `delete_layer`

Delete a layer from a layout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `layerName` | string | Yes | Layer to delete |
| `force` | boolean | No | Delete even if the layer holds instances; they are lost (default: false) |

**Behavior:**
- The last layer of a layout cannot be deleted
- A layer with instances returns `success: false`, `action: "delete_blocked"` unless `force=true`

### `update_instance`

Update a placed instance, found by UID on any layer or among the non-world instances (which ignore position, size, angle, Z elevation and color).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `uid` | number | Yes | UID of the instance |
| `x`, `y` | number | No | New position |
| `width`, `height` | number | No | New size |
| `angle` | number | No | New angle in radians |
| `zElevation` | number | No | New Z elevation |
| `color` | number[4] | No | RGBA tint `[r, g, b, a]`, values 0-1 |
| `showing` | boolean | No | Initial visibility |
| `locked` | boolean | No | Locked in the editor |
| `tags` | string | No | Comma-separated tags |
| `instanceVariables` | object | No | Values merged into the instance's existing `instanceVariables` |

At least one property must be provided.

### `delete_instance_from_layout`

Remove a placed instance by UID from the layout's layers or its non-world instances.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `uid` | number | Yes | UID of the instance to remove |

### `update_project_metadata`

Update project-level metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | No | Project name |
| `version` | string | No | Project version |
| `author` | string | No | Author name |
| `description` | string | No | Project description |

At least one parameter must be provided.

### `register_addon`

Add an addon to the project's `usedAddons`. Known Scirra plugins and behaviors are registered automatically by `create_object` and `update_object_properties`; effects are not, so register them with this tool.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"plugin"` \| `"behavior"` \| `"effect"` | Yes | Addon type |
| `id` | string | Yes | Addon ID (e.g. `"Sprite"`, `"Tween"`, `"hsladjust"`) |
| `name` | string | Yes | Display name |
| `author` | string | No | Author (default: `"Scirra"`) |
| `bundled` | boolean | No | Value of the entry's `bundled` flag (default: false) |

An addon that is already registered returns `action: "already_registered"` and nothing is written.

### `unregister_addon`

Remove an addon from `usedAddons`. Construct 3 errors on load if objects or behaviors still use it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"plugin"` \| `"behavior"` \| `"effect"` | Yes | Addon type |
| `id` | string | Yes | Addon ID |
| `force` | boolean | No | Required to remove a known Scirra built-in plugin or behavior (default: false) |

### `add_animation_to_sprite`

Add a new animation to a Sprite object.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name (e.g., `"Idle"`, `"Walk"`) |
| `speed` | number | No | Frames per second (default: 5) |
| `isLooping` | boolean | No | Loop the animation (default: true) |
| `isPingPong` | boolean | No | Ping-pong playback (default: false) |
| `repeatCount` | number | No | Repeat count if not looping (default: 1) |
| `frameCount` | number | No | Number of blank frames to create (default: 1) |
| `frameWidth` | number | No | Frame width in pixels (default: existing sprite width) |
| `frameHeight` | number | No | Frame height in pixels (default: existing sprite height) |

**Notes:**
- Validates the object is a Sprite plugin (rejects non-Sprite objects)
- Checks animation name uniqueness within the sprite
- Frame dimensions default to the existing first animation's frame size

### `update_animation_properties`

Update properties of an existing animation on a Sprite object.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name to modify |
| `speed` | number | No | New speed (frames per second) |
| `isLooping` | boolean | No | New loop setting |
| `isPingPong` | boolean | No | New ping-pong setting |
| `repeatCount` | number | No | New repeat count |

At least one property must be provided.

### `rename_animation`

Rename an animation on a Sprite object.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Current animation name |
| `newName` | string | Yes | New animation name |

### `delete_animation`

Delete an animation from a Sprite object. The last animation cannot be deleted.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation to delete |

### `add_frame_to_animation`

Add a blank frame (with a placeholder PNG in `images/`) to a Sprite animation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |
| `index` | number | No | Insert at this frame index (default: append) |
| `width` | number | No | Frame width in pixels (default: first frame's width) |
| `height` | number | No | Frame height in pixels (default: first frame's height) |
| `duration` | number | No | Frame duration (default: 1) |

### `update_frame`

Update per-frame properties of a Sprite animation frame.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |
| `frameIndex` | number | Yes | 0-based frame index |
| `width` | number | No | New frame width in pixels |
| `height` | number | No | New frame height in pixels |
| `duration` | number | No | New frame duration |
| `originX` | number | No | Horizontal origin 0-1 (0.5 = center) |
| `originY` | number | No | Vertical origin 0-1 (0.5 = center) |

### `delete_frame_from_animation`

Delete a frame by index. The last frame of an animation cannot be deleted.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |
| `frameIndex` | number | Yes | 0-based frame index |

### `replace_sprite_image`

Replace a frame's image with real PNG data. The PNG is written to the frame's file in `images/`; the object JSON is backed up and rewritten.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |
| `frameIndex` | number | Yes | 0-based frame index |
| `pngBase64` | string | Yes | Base64-encoded PNG (checked for the PNG signature) |
| `width` | number | No | Image width in pixels; updates the frame metadata |
| `height` | number | No | Image height in pixels; updates the frame metadata |

### `create_timeline`

Create a timeline in `timelines/` (or `timelines/<subfolder>/`) and register it in `project.c3proj`, in the same project-bar folder. The name must not be used by another timeline or by a transition.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Timeline name (unique) |
| `totalTime` | number | No | Total duration in seconds (default: 5) |
| `loop` | boolean | No | Loop the timeline (default: false) |
| `pingPong` | boolean | No | Ping-pong playback (default: false) |
| `repeatCount` | number | No | Repeat count when not looping (default: 1) |
| `startOnLayout` | string | No | Layout to auto-start on (default: `""` = none) |
| `ignoreSystemTimescale` | boolean | No | Ignore the system timescale (default: true) |
| `subfolder` | string | No | Project-bar folder within `timelines/`, `/`-separated (e.g. `"UI"` or `"UI/Menus"`). Not `"transitions"`: Construct 3 keeps transitions there |

### `update_timeline`

Update the settings of an existing timeline, in whichever `project.c3proj` folder it is. The file is backed up to `<file>.bak` and rewritten at the same path. Transitions are refused.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Timeline name |
| `totalTime` | number | No | New total duration in seconds |
| `loop` | boolean | No | Loop setting |
| `pingPong` | boolean | No | Ping-pong playback |
| `repeatCount` | number | No | Repeat count |
| `startOnLayout` | string | No | Auto-start layout (`""` = none) |
| `ignoreSystemTimescale` | boolean | No | Ignore the system timescale |
| `enabled` | boolean | No | Enable or disable the timeline |

At least one setting must be provided.

### `delete_timeline`

Delete a timeline: back up exactly the file that is deleted to `<file>.bak`, delete it, and remove the timeline from its folder in `project.c3proj`. When the file is missing or cannot be deleted, the tool returns an error and `project.c3proj` is not changed. Transitions are refused.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Timeline name to delete |

---

## Runtime Tools

These tools let external automation (Playwright, a browser console, anything that speaks the Chrome DevTools Protocol) drive a running preview through an injected bridge script, `scripts/c3-runtime-bridge.js`, exposed as `globalThis.__c3bridge`.

### `inject_runtime_bridge`

Write the bridge script and register it in `project.c3proj` (`rootFileFolders.script.items`). The script starts through `runOnStartup()` and processes commands each tick. No parameters.

### `remove_runtime_bridge`

Delete the bridge script and remove its registration from `project.c3proj`. No parameters.

### `get_bridge_commands`

List the commands the bridge understands (`ping`, `callFunction`, `getGlobalVar`, `setGlobalVar`, `getObjectState`, `getAllInstances`, `getLayout`, `goToLayout`, `evaluateExpression`, `listObjects`, `listGlobalVars`) with their arguments. No parameters.

### `generate_bridge_eval_script`

Generate a Python script and manual console steps that submit a bridge command and poll for its result.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Bridge command (e.g. `"callFunction"`, `"getGlobalVar"`) |
| `args` | object | No | Command arguments (max 100 keys, depth 6) |

### `export_for_preview`

Pre-flight check for preview testing: reports the project's worker mode (`useWorker` should be `"dom"` so the bridge can reach `globalThis`) and, by default, injects the bridge.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `injectBridge` | boolean | No | Inject the runtime bridge (default: true) |

### `clone_project`

Copy the project folder to a new directory, optionally with the bridge injected into the copy. The original project is not modified.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `targetDir` | string | Yes | Target directory for the copy |
| `includeBridge` | boolean | No | Inject the bridge into the copy (default: true) |

### `pack_project`

Pack the project folder into a `.c3p` file (ZIP archive) that the Construct 3 editor can open. Skips `.git`, `node_modules`, `.bak` files, `.DS_Store` and `Thumbs.db`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `outputPath` | string | Yes | Output path for the `.c3p` file |
| `injectBridge` | boolean | No | Inject the bridge into the project before packing (default: true) |

Returns `success`, `packed`, `outputPath`, `fileCount`, `sizeBytes`, `sizeMB` and `bridgeInjected`.

---

## Prompts

### `analyze_project`

Analyze project structure, naming conventions, and organization.

### `find_object_usage`

Find where a specific object is referenced. Parameter: `objectName`.

### `explain_eventsheet`

Explain how an event sheet works. Parameter: `eventSheetName`.

### `review_game_logic`

Review overall game logic architecture.

### `document_object`

Generate documentation for an object. Parameter: `objectName`.

### `optimize_project`

Get optimization suggestions.

---

## Error Handling

### Success Response

```json
{
  "content": [{ "type": "text", "text": "{...JSON result...}" }]
}
```

### Error Response

```json
{
  "content": [{ "type": "text", "text": "Error: message" }],
  "isError": true
}
```

### WriteResult

Mutation tools return this structure on success:

```typescript
interface WriteResult {
  success: boolean;
  entity: string;        // name of the entity
  category: string;      // "object" | "family" | "eventsheet" | "layout" | "timeline" | "project" | "addon"
  action: string;        // "created" | "updated" | "deleted" (also "delete_blocked", "would_delete", "already_registered")
  generatedSid?: number;
  generatedUid?: number;
  warnings?: string[];   // e.g., "Auto-registered plugin..."
  backupFile?: string;   // path to .bak file
  editorNote?: string;   // not in the TypeScript type: toolResult adds it to every completed write
}
```

Some tools add their own fields (for example `deletedSid`, `movedSids`, `backupFiles`). Responses with `success: false` (`action: "delete_blocked"`), dry runs and no-ops carry no `editorNote`.

### Common Errors

| Error | Cause | Resolution |
|-------|-------|------------|
| `Object "X" not found` | Misspelled name | Check suggestions or use `list_objects` |
| `Object "X" already exists` | Duplicate name | Use `update_object_properties` instead |
| `Plugin "X" is not registered` | Third-party addon not in project | Add addon in C3 editor first |
| `"System" is a reserved name` | Name conflicts with C3 engine | Choose a different name |
| `Path traversal detected` | Name contains `..` or `/` | Use simple alphanumeric names |
| `Object is still referenced` | Delete blocked by references | Use `force: true` or remove references first |

---

## Type Definitions

### Key Types

```typescript
interface Addon {
  type: 'plugin' | 'behavior' | 'effect';
  id: string;
  name: string;
  author: string;
  bundled: boolean;
  version?: string;
  sdkVersion?: number;
}

interface WriteResult {
  success: boolean;
  entity: string;
  category: string;
  action: string;
  generatedSid?: number;
  generatedUid?: number;
  warnings?: string[];
  backupFile?: string;
}

interface ReferenceCheckResult {
  safe: boolean;
  references: {
    eventSheets: string[];
    layouts: string[];
    families: string[];
  };
}
```

---

**Last Updated**: 2026-09-25
