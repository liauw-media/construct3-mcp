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

### `construct3://docs/pitfalls`

Curated markdown list of Construct 3 behaviors that break game logic quietly: backslash escapes and empty expressions in event JSON, `Dictionary.Get` vs `GetDefault`, `int("")`/`int("0.20")`, *Compare two values* not picking, *Set animation* not restarting, signals not being queued, scripts needing `localVars` for function parameters, and exact window-size comparisons. Each item is tagged `[manual]`, `[projects]` or `[practice]` (reported in [komabear/c3-skill](https://github.com/komabear/c3-skill), MIT). The first two items are the `expression-syntax` and `empty-expression` load-time checks of [`validate_project`](#validate_project); the doc points to them and to `find_runtime_traps`. Also listed under `curated` in `construct3://docs/index`.

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

List all timeline names (root and subfolders) with a count, in project-bar order. No parameters. Transitions (the easing curves in the editor's Transitions folder, which `project.c3proj` keeps as the first-level `timelines` subfolder without a `name`) are returned separately in `transitions`. Any other subfolder without a name is malformed (reported by `validate_project`); its items are not listed, the other timeline tools report them as unresolvable, and `create_timeline` refuses their names so they are not registered twice.

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

Function definitions and call sites across event sheets. Call sites are *Call function* actions (`via: "callFunction"`), `Functions.Name(...)` calls in the expressions of conditions and actions, function call arguments included (`via: "expression"`), and *Map function* / *Map function default* actions of the Functions object (`via: "function-map"`). A function map registration does not call the function itself; it makes it callable by *Call mapped function*. All three count in `callCount` and `totalCallSites`, and a function that has any of them is not listed in `uncalledFunctions`. Function names are matched ignoring case, as the editor does. Scripts are not scanned.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `eventsheet` | string | No | Filter to a specific event sheet |
| `detail` | string | No | Detail level |

### `get_object_dependencies`

Where objects are used: event sheets, layouts, families, co-occurring objects. Event sheet uses include object parameters, expressions and script actions; layout uses include instances on sub-layers, non-world instances and object properties of other instances that hold the object's SID (see [`find_orphaned_objects`](#find_orphaned_objects)). The project-wide `orphanedObjects` list follows the same rule as `find_orphaned_objects`, and `totalReferenced` counts the other objects (use through a family included), so the two add up to `totalObjects`. `orphanedFamilyMembers` (present when there are any) lists the orphans that are members of a family, as `{ name, families }`: `delete_object` refuses them until they leave the family.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `object` | string | No | Specific object (omit for project-wide top 20) |
| `detail` | string | No | Detail level |

### `find_orphaned_objects`

Find objects not used by any event and not placed in any layout. No parameters.

An object counts as used when it is the object of a condition or action or the object a custom action block (`custom-ace-block`) defines its custom action for (the block's conditions, actions and sub-events count like any others), or through a family it belongs to (a family that events use), or when it has an instance on a layer or sub-layer (`layers[].subLayers`, nested to any depth) or among a layout's non-world instances (`nonworld-instances`, e.g. Array or Dictionary), or when an instance property of another object holds its SID (object properties such as the Particles *Object* property, which editor-saved projects store as the object type's SID). Events also use an object when (heuristics that rather find too many uses than too few):
- a parameter's whole value is its name, as in object parameters (`"object": "Sprite2"`, `"object-to-create"`, `"pin-to"`, `"child"`, ...), function call arguments included. Not counted: keys that hold other names (`"audio-file"`, `"instance-variable"`, `"variable"`, `"layout"`), and a bare name that is also a declared event variable or function parameter, since in an expression parameter a bare name is a variable (Construct 3 lets variables share names with objects). Object parameter keys count even then;
- a parameter expression uses it as `Name.` or `Name(` (`Sprite4.X`, `Sprite4(0).X`), outside `"..."` string literals and not as a member (`Label.Text` does not use an object named `Text`). An object parameter whose value is not a plain name (an expression written by hand) is scanned the same way;
- a script action or script event reads `runtime.objects.Name` or `runtime.objects["Name"]` (also through `this.runtime` and the like).

Only names of existing object types and families are matched. Not detected: project script files, dynamic lookups (`runtime.objects[name]`, destructuring) and objects created by name at runtime. `validate_project`, `get_object_dependencies`, `analyze_performance` and the `delete_object` reference check use the same index: every object `delete_object` refuses because of a use is not an orphan, and every orphan is deleted without `force`, except an orphan that is a member of a family no event uses. Such orphans list that family in `families`; `delete_object` refuses them until they leave the family (`update_family` with `removeMembers`).

### `get_asset_usage`

Track asset usage across the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"sound"` \| `"music"` \| `"image"` \| `"font"` \| `"video"` \| `"icon"` \| `"general"` \| `"all"` | No | Filter by asset type (default: all) |
| `detail` | string | No | Detail level |

Returns `{ summary, assets, notes }`. `summary` has `totalAssets`, `byType`, `usedCount`, `unusedCount`, `notAnalysedCount` and `mostReferenced`. Each asset has `name`, `type`, `status` (`used`, `unused` or `not-analysed`), `referencedIn` (`eventSheets`, `layouts`, and when found `objectTypes`, `scripts`, `flowcharts`, `timelines`, `projectFiles`), `via` (how it is referenced) and, when not used, a `reason`. `standard` detail lists 50 assets, unused and not-analysed first; `full` lists all.

- **Images** are object types with animations (sprites) or a single image (Tiled Background, 9-patch, Particles, Sprite font and other plugins that save an `image`), one entry per object type. A sprite has its `animations` and `frames` counts; a single-image object type has `frames: 1` and no `animations`. Animations are read as the editor saves them (`animations.items`, and the animations in `animations.subfolders`). An image is used when its object type is used by the rule of [`find_orphaned_objects`](#find_orphaned_objects) (used in an event, directly or through one of its families; an instance in a layout, sub-layers and non-world instances included; or named by an object property of another instance), or when System "Create object (by name)" creates it with a literal name.
- **Sounds and music** are used when an Audio file parameter names them (`"audio-file"`: the name without extension, saved as a string or as `{ "path": name }`), when a by-name Audio action (`"folder"` + `"audio-file-name"`) names them with a literal, or when a string in events, scripts, flowcharts, timelines, layout instance values or project files is their name. Tag, layer, animation and text parameters and properties, and instance variable definitions, are not file references.
- **Project files, fonts and videos** are used when a parameter, a string literal, a script, a layout or object type property (for example Video sources, or plugin properties naming data files), a flowchart or timeline string, or the text of another used project file names them. A Text object's `font` property and a CSS font declaration (`font-family: 'Pixel Sans'`, in HTML content, scripts or project files) name a font without its extension.
- **Not analysed** (never reported as unused):
  - icons (used by the export) and project files with a purpose other than `none` (such as stylesheets);
  - files a name built at runtime may produce: by-name Audio actions with an expression, `"prefix" & ...` or `... & ".ext"` concatenations, `ProjectFileNameAt()`, and in scripts `runtime.assets` calls with a computed name and `fetch()`, `import()` or XMLHttpRequest `open()` with a `"prefix" + ...` URL. A prefix that starts with a server URL (`https://...`, `//...`) does not name a project file;
  - objects that may be created or looked up by name: System "Create object (by name)" with an expression, a script that indexes `runtime.objects[...]` with a computed name or passes `runtime.objects` on (an alias, `Object.keys`), an object in a container, and an object whose name (or family name) appears in an expression, as a script identifier, or as a string literal in a parameter, variable or script;
  - what an unreadable file may name: an event sheet, script, layout, object type or family makes every unreferenced asset not analysed; a flowchart or timeline, the file assets; a project file, the file assets once that project file is itself used or not analysed.
- Names built at runtime without a literal part in the project (server data, user input), or by script code other than the calls above, are not seen.

### `analyze_performance`

Heuristic performance audit with categorized issues (info/warning/critical).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `scope` | string | No | Event sheet or layout name to scope analysis |
| `detail` | string | No | Detail level |

The frame count check reports object types with more than 50 animation frames, counting every animation, including those in animation subfolders.

### `validate_project`

Run integrity checks over the whole project. No parameters.

Returns `{ valid, summary, errors, warnings, info }`; each issue has `check`, `entity`, `message` and an optional `suggestion`. `valid` is true when there are no errors.

- **Errors:** registered entities whose file is missing or not valid JSON, missing required fields in objects, sheets and layouts, internal `name` differing from the registered name, malformed subfolder entries (a subfolder without a name or `items`; the first unnamed subfolder directly under `timelines` is the editor's Transitions folder, see [`list_timelines`](#list_timelines), and is accepted), conditions/actions that name their behavior only under the legacy `"behavior-type"` key (`legacy-behavior-key`, see [`fix_legacy_behavior_keys`](#fix_legacy_behavior_keys)), and the editor load-time rules below
- **Warnings:** duplicate SIDs and UIDs (except the SID duplicates listed below as errors), broken object references (conditions/actions on a class that is no object type, family, `System` or the built-in Functions object, which is named by `functionsName` in `project.c3proj`, `"Functions"` by default), behaviors and instance variables that events use but their object type or family does not have (`missing-behavior-or-variable`), layer names repeated within a layout (`duplicate-layer-name`), layouts bound to missing event sheets, broken includes, plugins or behaviors missing from `usedAddons`, leftover `"behavior-type"` keys next to a valid `"behaviorType"`, event shapes that differ from what the current editor saves (`legacy-event-shape`, see [`fix_legacy_event_shapes`](#fix_legacy_event_shapes): block-level `isElse`, per-condition `isOr` and function calls with `id`/`objectClass` or keyed parameters, which older versions of this server wrote and Construct 3 never writes, and scripts stored as one string or without `language`, the shape older Construct 3 releases saved, which is harmless to convert), entity files whose name differs from the registered name only in letter case (`file-name-case-mismatch`), layout instances without an entry for a behavior of their object type or its families (`missing-behavior-entry`, one warning per layout and object type with the instance UIDs; the editor saves an entry for every behavior, see [`add_instance_to_layout`](#add_instance_to_layout), and older versions of these tools placed instances without them), Sprite animation frames without their image file (`frame-image`, below), and the partly verified load-time rules below
- **Info:** JSON files in `objectTypes`, `eventSheets` and `layouts` (subfolders included) not registered in `project.c3proj`, leftover `.bak` files in `objectTypes`, `eventSheets`, `layouts`, `families`, `timelines` (subfolders included) and next to `project.c3proj`, orphaned objects (see [`find_orphaned_objects`](#find_orphaned_objects)), and image files named like frames past an animation's last frame that no frame uses (`frame-image`, below)

`frame-image`: the editor loads a frame's image from `images/<object>-<animation>-NNN.<ext>`, all lowercase, NNN being the frame's index (3 digits) and ext `jpg` for a JPEG frame (`fileType` `"image/jpeg"`), `png` otherwise; for another `fileType`, any file with that name and a single extension counts (shown as `…-003.*`). `images/` is read once and names are compared ignoring case. A warning per animation (in any animation folder) lists the frames whose file is missing, with the name each one needs. Older versions of `add_frame_to_animation` left the frames after an insert index without their image; what Construct 3 does when a frame's image file is missing is not verified, so this is a warning. An info entry per animation lists files named like frames past its last frame that no frame of any animation uses, such as the file older versions of `delete_frame_from_animation` left behind (`.bak` files are not listed). The check is skipped when the project has no `images/` folder.

Entity files are checked against the path each registered entity is read from: `<category>/<project-bar folders>/<name>.json`, since Construct 3 mirrors its project-bar folders on disk. `file-name-case-mismatch`: a file whose path differs from that path only in letter case, such as `layouts/Layout1.json` for a layout `layout1` at the root, is the entity's file on case-insensitive file systems (Windows, macOS by default), where it loads, but may not be found on case-sensitive ones (Linux). The suggestion is to rename it to the expected path; it is never reported as orphaned. Any other file is `orphaned-file`, including a copy named like a registered entity in another folder; its message names the path that entity is read from. The editor's `*.uistate.json` view-state files are not entity files and are skipped.

`duplicate-uid`: instance UIDs (instances on layers and sub-layers, non-world instances, single-global instances) must be unique across the project; locations of sub-layer instances name the layer path (`layouts/Layout1/layer:Main/layer:HUD/inst:Sprite`). According to Scirra ([Construct-bugs #8725](https://github.com/Scirra/Construct-bugs/issues/8725)), Construct 3 tries to cope by reassigning duplicated UIDs, which can still break hierarchies, timelines and events that refer to a specific UID, so re-saving is no fix: give the duplicates new unused UIDs by hand. Duplicates usually come from merging branches; projects edited on several branches should set the "UID numbering" project property to Random.

**Editor load-time rules.** The Construct 3 editor enforces these only when it opens a project, and breaking one can make the whole project fail to open. The rules come from [komabear/c3-skill](https://github.com/komabear/c3-skill) (MIT) and were checked against the Construct 3 manual, real editor-saved projects, and the error messages of the editor's project loader (release r495.2). Where only part of a rule could be verified, it is reported as a warning.

| Check | Severity | Rule |
|-------|----------|------|
| `expression-syntax` | error | A backslash outside a string literal, or an unterminated string literal, in any condition/action parameter (function and custom action call arguments included). C3 expressions have no escape sequences: a quote inside a string is written as two quotes (`"He said ""hi"""`), so `"{\"a\":1}"` fails with *Syntax error: Unknown character*. A backslash inside a string literal is fine. |
| `empty-expression` | error | A parameter whose value is `""` fails with *Empty expression: You must enter an expression*. Write an empty string literal as `"\"\""`. |
| `trigger-placement` | error / warning | Only one trigger per event, unless it is an OR block (`"isOrBlock": true` on the event), which may hold several. A branch holds one trigger: no trigger in a sub-event of a triggered event, of a function block or of a custom action block. Both fail with *cannot add another trigger to event branch*. Groups are transparent. A trigger that is not the first condition of its event is a warning: the editor moves it to the top when it opens the project. Triggers are conditions whose id starts with `on-`; the editor counts fake triggers (*On collision*, Timer *On timer*, Gamepad buttons) as triggers too. Problems involving third-party addon triggers are warnings, since those addons do not always follow the `on-` convention. |
| `else-placement` | warning | An else block (System `else` first condition) must come after a block without a trigger, with at most comments between them, and must not hold a trigger itself. The manual: *Else can only follow normal (non-triggered) events*; every else block in editor-saved projects follows such a block, directly or after comments. A trigger after `else` would be moved before it when the editor opens the project (see `trigger-placement`), so for else blocks this rule reports it instead. Whether the editor refuses to open a project that breaks the rule is not verified. |
| `duplicate-object-name` | error | Object types and families share one name namespace that ignores case. A name listed twice in the `project.c3proj` objectTypes or families tree, two names that differ only in case, and a family named like an object type all fail with *object class name 'X' already used*. The editor also creates the built-in System object and the built-in Functions object (named by `functionsName` in `project.c3proj`, `"Functions"` without it) in the same namespace for every project, so an object type or family named like either, ignoring case, fails the same way. |
| `family-plugin-mismatch` | error / warning | Every member of a family must use the same plugin; a mixed family fails with *wrong plugin* (error). Members that agree with each other but not with the family's `plugin-id` are a warning. |
| `duplicate-sid` | error / warning | Two object types or families sharing a SID fail with *object class sid already in use* (error). A SID shared by behaviors or instance variables of object type or family files is a warning: SIDs should be unique, but no load failure is on record for this clash, and the editor's loader checks only object type and family SIDs. Animation and frame SIDs repeated across object types are warnings: a Scirra example project does this and opens. SIDs shared by events, conditions, actions or layout instances are warnings: editor-saved projects contain such duplicates and open, and the editor keeps them when it saves, so re-saving does not fix them. A clash involving a function or custom action parameter is a warning that may break loading, since the loader checks function parameter SIDs. Event sheet locations name the event path and the condition/action index (e.g. `eventSheets/Sheet1 > block (sid 12) > action 0 "wait" (System)`), and an event's own location ends with its JSON path (`eventSheets/Sheet1 > block (sid 12) at events[0].children[1]`), so events sharing a SID under the same parent can be told apart. When events in one sheet share a SID, whatever else also uses it, the suggestion adds that the SID-based event tools refuse it there unless `eventPath` names one of them (see [Events that share a SID](#mutation-tools)); a SID used more than five times lists the first five locations and a count per file, and the paths of the others come from the refused tool call or [`locate_event`](#locate_event). Layout `instanceFolderItem` SIDs legitimately repeat the instance SID and are not checked. |

`broken-object-reference`: what `delete_object` and `delete_family` with `force: true` leave behind. Reported are a name that is no object type, family, `System` or the built-in Functions object, used as the object of a condition or action or as the whole value of an object parameter (`"object"`, `"object-to-create"`, `"pin-to"`, `"child"`); layout instances (on any layer or sub-layer, or non-world) of an object type that does not exist, one warning per layout and type with the instance UIDs; family members that are no object type (one warning per family); and object properties that hold the SID of no object type or family. The only object property known to hold a SID is the Particles `"object"` property (`-1` when no object is set), so only that one is checked. Not reported: uses of a deleted object or family in expressions and scripts, which are only recognised by the names of existing objects; the `force` warnings of `delete_object` and `delete_family` list them. Uses of a deleted family's instance variables and behaviors through its members are `missing-behavior-or-variable` (below). What Construct 3 does with these leftovers when it opens the project is not verified, so they are warnings.

`missing-behavior-or-variable`: what `update_object_properties`, `update_family` and `delete_family` with `force: true` leave behind. Reported are conditions and actions whose `"instance-variable"` parameter or `behaviorType` names an instance variable or behavior their object type does not have, neither itself nor through one of its families, an `"instance-variable"` parameter of the form `{ name, objectClass }` (System actions such as *Sort Z order*) whose object type does not have the variable, and `Object.Behavior.Expression` or `Self.Behavior.Expression` in parameter expressions whose middle part names no behavior of that object type or its families. A family's conditions, actions and expressions reach only the family's own instance variables and behaviors, so for a family the family itself is checked. One warning per event sheet, object and name, with the locations (`block > action:0 at events[3]`: the event path, which sibling events share, and the JSON path of the event) and the names the object has. Names are compared ignoring case. Not reported: `Object.name` or `Self.name` whose name is neither an instance variable nor a behavior, since it can be one of the plugin's expressions (`Sprite.X`), conditions and actions on an object that does not exist (`broken-object-reference`), the legacy `"behavior-type"` key (`legacy-behavior-key`), scripts and timeline tracks. What Construct 3 does with such a use when it opens the project is not verified, so these are warnings. None of the editor-saved projects checked has one.

`duplicate-layer-name`: two or more layers of one layout, sub-layers included, whose names are the same ignoring case, one warning per layout and name with the layer paths. The editor's project loader (release r495.2) looks layer names up ignoring case over all layers of a layout and cannot load such a layout; this was not reproduced in the editor, so it is a warning. [`update_layer`](#update_layer) can rename one of them: it finds a sub-layer by its path, such as `"Main > HUD"`.

### `get_group_settings`

Event group settings across event sheets: title, sheet, `isActiveOnStart`, `disabled`, nesting depth, parent group, child group and event counts. Returns `groups`, `summary` (totals) and `bySheet`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `eventsheet` | string | No | Filter to a specific event sheet |
| `activeOnly` | boolean | No | Only groups with `isActiveOnStart = true` |
| `inactiveOnly` | boolean | No | Only groups with `isActiveOnStart = false` |

### `locate_event`

Map an editor event number, as shown in the event sheet margin and in errors such as `es_game, event 72, action 1`, to the event's JSON path. Script syntax errors raised by the editor word it as `es_game, number 72, action 1, line 3`; the number is the same event number. The editor number is not the index into `events[]`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheet` | string | Yes | Event sheet name |
| `eventNumber` | integer ≥ 1 | Yes | Event number as shown by the editor or an error message (`event N` or `number N`) |
| `conditionNumber` | integer ≥ 1 | No | Condition within the event (1-based) |
| `actionNumber` | integer ≥ 0 | No | Action within the event, counted from `actionIndexBase` (by default `action M` is `actions[M-1]`) |
| `countActionComments` | boolean | No | Count action comment rows (`{ "type": "comment" }`) when resolving `actionNumber` (default `true`, verified for runtime script errors). Disabled action rows always count |
| `actionIndexBase` | integer 0-1 | No | Number of the first action: `1` (default, verified for runtime script errors) or `0` (editor load errors according to c3-skill, unverified) |

Returns JSON with:

- `event`: `number`, `path` (e.g. `events[3].children[1]`), `sid`, `kind` (`block`, `else`, `group`, `function`, `custom-ace`, `script`, or `unknown` for an event type this server does not know), `eventType`, `depth`, `disabled`, `enclosingGroups`, `enclosingFunction`, a one-line `summary`, and numbered `conditions` and `actions` lists
- `condition` / `action` (when requested): `number`, `index` and `path` (the item's position in the JSON, e.g. `events[3].children[1].actions[0]`), `kind`, `sid`, `disabled`, `text`
- `previousEvent` / `nextEvent`: events n-1 and n+1, so you can check the mapping against the editor
- `numbering`, `notes` (assumptions that affect this answer), `warnings`

An event, condition or action number that is out of range returns an error that names the valid range. When `countActionComments=false` skipped comment rows, the error also says so and names the action that counting them would pick.

When `actionNumber` is given, `notes` always names the action the other `actionIndexBase` would pick, because the base is only verified for runtime script errors. It also says when the action is a comment row, which cannot raise an error.

**Numbering rules.** Events are numbered in display order: a depth-first walk of `events[]` where each event's `children[]` come right after it. This covers group contents, sub-events and function bodies. Numbers are 1-based and start again at 1 in each sheet. Blocks (including else, OR and disabled blocks), groups, functions, custom ACE blocks and script blocks get a number. Variables, includes and comments do not. A function's own conditions and actions belong to the function's event number.

These rules come from [komabear/c3-skill](https://github.com/komabear/c3-skill) (MIT). They were checked against 32 exported projects (r232 to r466): the display number that the editor writes into each event of an export's `data.json` matched this walk for every event whose export and source still agreed (1219 events). The runtime prints script errors as `Unhandled exception running script <sheet>, event <display number>, action <index + 1>`. Exports of further projects (r449) that contain event-level script blocks, one of them nested two levels deep inside sub-events, confirm that a script block takes one number at its depth-first position and that every later event keeps matching.

Disabled events keep their numbers, also when only a parent group or event is disabled; the export leaves a gap for them.

Action comment rows count toward `action M`. Exports remove the comment rows but keep each script action's index. In [AshleyScirra/CommandAndConstruct](https://github.com/AshleyScirra/CommandAndConstruct), `Multiplayer join events` event 5 (function `StartJoinAttempt`) has a comment row at `actions[4]` and a script at `actions[5]`. The live export has four actions and then the script with index 5 (`MultiplayerJoinEvents_Event5_Act6` in `scriptsInEvents.js`). So a runtime error in that script reads `action 6`, which is `actions[5]` only if the comment row is counted. `countActionComments=false` gives the other reading.

Disabled action rows count too. Exports drop disabled actions just as they drop comment rows, but each script action keeps its `actions[]` index: a script after two disabled rows at `actions[2]` keeps index 2 and reads `action 3`. `countActionComments` does not change this.

Not verified:

- How errors that the editor raises itself (e.g. `Empty expression` when loading a project) number actions. c3-skill (`references/c3-json-surgical-rewrites.md`) says that for these errors `actions[j]` is `action j`, counted from 0. The editor's message strings do not settle it. Use `actionIndexBase`; `notes` always gives the other reading.
- Whether editor load errors number events the same way as the runtime.
- Whether condition numbers are 1-based. `locate_event` assumes they are, like action numbers.
- How event types this server does not know are numbered. They are counted as events, and a warning says so.

The walk stops at sub-events nested deeper than 50 levels, or after 100,000 rows, and says so in `warnings`. It does not skip them: that would give every later event a wrong number. Events after that point are reported as out of range.

`isElse` on a block and `isOr` on a condition are flags that the event tools of construct3-mcp 1.8.1 and earlier wrote. Construct 3 does not write them: real sheets mark an else block with a System `else` first condition, and OR a block's conditions with the block's `isOrBlock`. Both tools show such blocks as stored, marked `[non-standard isElse]` or `[non-standard isOr]`, with a warning that points to [`fix_legacy_event_shapes`](#fix_legacy_event_shapes). A condition or action that names its behavior only under the legacy `"behavior-type"` key (written by construct3-mcp 1.8.1 and earlier, which Construct 3 does not read) is shown with its behavior, marked `[legacy behavior-type]`, and a warning points to [`fix_legacy_behavior_keys`](#fix_legacy_behavior_keys).

### `get_eventsheet_outline`

A compact, readable outline of an event sheet that uses editor event numbers. It is paged for large sheets.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheet` | string | Yes | Event sheet name |
| `startEvent` | integer ≥ 1 | No | First event number to show (default 1) |
| `limit` | integer 1-1000 | No | Maximum events per page (default 100). With `maxDepth`, only the events shown count, so a page of a large group is not filled by hidden events. A page can end earlier because of the size budget (below) |
| `maxDepth` | integer 0-50 | No | Deepest nesting level to print (0 = top level only). Deeper events keep their numbers but are replaced by a `… events X-Y hidden` line |

Returns plain text: a header (event counts, the page range and the next `startEvent`, the numbering rule), then one line per row. Rows without an editor number are marked `-`. A page that starts inside a group, block or function begins with an `(inside event N: …)` line for each enclosing row. Each event lists at most 50 actions, followed by a `… (+N more actions; …)` line, and its header at most 50 conditions, followed by `… (+N more conditions)`; `locate_event` with `actionNumber` shows any single action.

**Size budget.** A page holds at most about 40,000 characters (roughly 10,000-13,000 tokens). This keeps it under common MCP client output limits, such as Claude Code's default `MAX_MCP_OUTPUT_TOKENS` of 25,000 tokens, which cut longer results. When the next event would take the page past the budget, the page ends before that event, even if fewer than `limit` events are shown, and the header says so:

```
Showing events 1-38. Page ended at the ~40000-character size budget before limit=100 was reached. Next page: startEvent=39.
```

A page always shows at least one event, so a single event larger than the budget is shown whole. Pages end only before an event that is shown, so the next page can start there. Follow `Next page: startEvent=N` until the header has no next page; do not assume that a page holds `limit` events.

```
 - VAR Score: number = 0
 - INCLUDE Common
 - COMMENT: Main logic
 1 GROUP [Movement]
 2   IF System.on-start-of-layout()
         DO Player[Platform].set-max-speed(max-speed=300)
         CALL Spawn("Enemy", 3)
         SCRIPT: runtime.globalVars.Score = 0; (+1 lines)
 3     IF NOT Player[Platform].is-on-floor()
 4     ELSE
           DO Enemy.destroy()
 -   COMMENT: sub comment
 -   VAR speed: number = 5 [static]
 5   IF Keyboard.key-is-down(key=37) OR Keyboard.key-is-down(key=39) [disabled]
         DO Player.set-x(x=Self.X + 1) [disabled]
```

`NOT` marks an inverted condition, `OR` joins the conditions of an OR block, and `[disabled]` marks disabled events, conditions and actions. `Obj[Behavior].ace-id` names a behavior ACE. Script actions show their first line. Functions and custom ACE blocks list their own conditions after the signature, e.g. `FUNCTION PlayAll() IF System.for-each(object=iframe)`. A custom action call that runs a family's custom action on an object type that overrides it shows the family as the editor does: `CALL monkey.PlayAnimation (Animals)()`.

### `find_runtime_traps`

Find event logic that loads fine but hangs or throws at runtime. Read-only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `eventsheet` | string | No | Only report issues located in this sheet (signal tags are still matched across all sheets) |
| `detail` | string | No | `summary` (first 10 issues, without suggestions, at most 3 related locations each), `standard` (all issues), `full` (issues + complete signal map) |

**Checks:**

| Check | Severity | Finding |
|-------|----------|---------|
| `signal-pairing` | warning | *Wait for signal* (or `runtime.waitForSignal()`) tag that no *Signal* action or `runtime.signal()` call raises anywhere: the wait can never finish. Reported as info instead when a signal with a non-literal tag may produce it, or when an event sheet could not be read. |
| `signal-pairing` | info | *Signal* nobody waits for or listens to; *On signal* nothing raises; tags that are not string literals (cannot be analyzed statically) |
| `signal-order` | info | *Wait for signal* whose tag was already raised before the wait starts, so the wait misses it: a *Signal* with that tag earlier in the same event or a parent event, or an earlier call (`callFunction` action, or `Functions.Name(...)` in an expression or condition) to a function that raises it before returning. A function raises a tag before returning when its *Signal* is reached on an unconditional path (no enabled conditions on the way) without passing a *Wait*, *Wait for signal* or *Wait for previous actions to complete* in its own event or an enclosing one; a *Wait* defers only the rest of its own event, so sibling sub-events after it still count. Calls are followed transitively, and a tag passed as a literal argument to a function that signals its parameter counts. Scripts are not followed. |
| `script-function-parameter` | warning | Script action/block inside a function block or custom action block (`functionParameters`) that uses a parameter as a bare JS identifier; it must be `localVars.<name>` |

A function registered in a function map (*Map function* / *Map function default* on the Functions object) can be called by *Call mapped function* with arguments chosen at runtime, so a tag forwarded through its parameters is treated as able to hold any value; mapped calls are not followed by `signal-order`, and a note says so when the project has function maps. Tags compare case-insensitively. A non-literal tag that starts with a literal (`"button_" & Button.type`, or `"step" + n` in a script) may produce any tag with that prefix: *On signal "button_ok"* next to it is not reported, and it only downgrades waits whose tag has that prefix. A *Signal* whose tag is a parameter of its function is resolved through the arguments at the function's call sites (event `callFunction` actions, `Functions.Name(...)` calls in expressions and `runtime.callFunction()` in scripts; function names compare case-insensitively). Disabled events, conditions and actions (`"disabled": true`) are skipped; groups that are only inactive on start are scanned. Names imported or declared in the *Imports for events* script (per language) count as in scope for scripts. Per-instance signals (the common *Signal* / *Wait for signal* / *On signal* of objects) are not analyzed. Script files are not scanned for `runtime.signal()`. In script actions, calls on `runtime`, on `x.runtime` (`inst.runtime`, `this.runtime`: the same IRuntime) and on a local alias (`const r = runtime`) are recognized, also as `runtime["signal"](...)`; a runtime passed in through a function parameter is not, and `inst.signal()` is a per-instance signal. A name the script declares itself (`let mode`) is not reported as a bare parameter use; a parameter of the script's own function or `catch` only hides the name inside that function. In TypeScript scripts, type positions (annotations, return types, `as` types, type arguments, index signatures) are ignored. Script actions are read in both saved shapes (`script` as a string or as an array of lines).

Locations are paths of event types (`function:Name > block > action:3`); `action:N` is the 0-based index into the event's `actions` array, not the action number the editor shows. Entries of `related` and of the signal map end with the SID of the event that holds the ACE (`(sid N)`), which the SID-based event tools accept; an event without a SID gets its index among its siblings instead (`block#2`).

**Response:**
```json
{
  "summary": { "warning": 1, "info": 0, "sheetsScanned": 3, "scriptsScanned": 2, "signalTags": 4 },
  "issues": [{
    "severity": "warning",
    "check": "signal-pairing",
    "location": "Battle > function:DoAttack > block > action:3",
    "eventSid": 123456789012345,
    "tag": "swingDone",
    "message": "Wait for signal \"swingDone\" can never finish: ...",
    "suggestion": "Add Signal \"swingDone\" where the awaited work completes, ...",
    "related": ["Battle > function:DoAttack > block > action:3 [Wait for signal] (sid 123456789012345)"]
  }],
  "notes": ["Signal tags are compared case-insensitively.", "..."]
}
```

---

## Mutation Tools

Mutation tools that write through the project writer (objects, families, event sheets, layouts, animations, project metadata, addon auto-registration) follow the safety pipeline: validate → backup → write → verify → invalidate caches. The other write paths do less: `register_addon` / `unregister_addon` use a temp file but make no `.bak` backup and no read-back check; the timeline tools back up and use a temp file but do not read back; the runtime tools write `project.c3proj` and the bridge script in place, with no backup or read-back check; PNG images are written without a backup. Mutation tools return a `WriteResult` object on success.

**Text style.** An overwritten file keeps its line endings (LF or CRLF), exact trailing whitespace and BOM. A new file follows `project.c3proj`, then the first JSON file with line breaks in its target folder, then Construct 3's own style: tab-indented JSON with LF line endings, no trailing newline and no BOM. Only files already in that tab layout get line-level diffs; files indented another way are re-indented in full.

**Names and file names.** Entity files are named after the entity (`<category>/<folders>/<name>.json`, folders mirroring the project bar), and on Windows and macOS names that differ only in case name the same file. Create and rename tools therefore compare names the way the Construct 3 editor does: event sheet and layout names project-wide ignoring case, object type and family names in one namespace ignoring case, layer names per layout ignoring case (sub-layers included; the editor cannot load a layout with two such layers), animation names per sprite ignoring case (in any animation folder), event variable names ignoring case within the variable's scope (see [Event variable names](#event-variable-names)), and sibling project-bar folders (`subfolder` segments) ignoring case — a case-only clash is refused with an error naming the existing entity or folder. Create tools also refuse to write an entity JSON file or a timeline file where one already exists, including one whose name differs only in case; nothing is backed up or replaced, and the error says to choose another name or, for a leftover of a deleted entity, to check and remove the file first. Placeholder PNGs are not covered: `create_object` and `add_animation_to_sprite` write them over an image file of the same name in `images/`; `add_frame_to_animation` renames such a file to `<file>.bak` first. Rewrites of an existing file keep its name on disk exactly, including case, and the `.bak` backup takes that name.

**Editor reload note.** Every response that reports a completed write includes `editorNote`: *"If this project is open in Construct 3, close and reopen it there before saving, or the editor can overwrite these changes."* The editor keeps an open project in memory, so saving from a session opened before the edit can overwrite it; its Project Bar reload (F9) re-reads script files only. A `WriteResult` with `success: true` counts as a write unless it is a dry run. Tools whose success does not imply a write carry no note: the `already_registered` no-op of `register_addon`, `fix_legacy_behavior_keys` with `dryRun: false` when it found nothing to rename, `fix_legacy_event_shapes` with `dryRun: false` when it found nothing to convert, `clone_project`, and `export_for_preview` / `pack_project` with `injectBridge: false`. Error responses never carry the note, even when a multi-step tool (e.g. `create_object`) failed after an earlier step had already written.

**Events that share a SID.** Event SIDs are not guaranteed to be unique: editor-saved sheets can contain two events with the same SID, and they open in the editor. The tools that find an event by SID (`delete_event_from_sheet`, `update_event_block`, `update_event_block_action`, `update_event_variable`, and `move_events_between_sheets` for top-level events) refuse a SID that matches more than one event in the sheet, dry runs included, and write nothing. The error lists the matches in document order (the first 20, then a count of the rest): each one's JSON path (e.g. `events[3].children[1]`, the format [`locate_event`](#locate_event) returns), editor event number, enclosing group and function or parent event, and a one-line summary. Pass the path of the event you mean as `eventPath` (`eventPaths` for `move_events_between_sheets`) to act on it; the path must point at an event with that SID, or the call is refused. A unique SID works without `eventPath`, as before. The results of the single-event tools include the `eventPath` of the event they acted on. [`validate_project`](#validate_project) reports such SIDs as `duplicate-sid` warnings that name the same paths.

### `create_object`

Create a new object type in the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Object name (unique, alphanumeric + underscore + spaces) |
| `pluginId` | string | Yes | Plugin ID: `"Sprite"`, `"Text"`, `"TiledBg"`, `"NinePatch"`, `"Audio"`, etc. |
| `isGlobal` | boolean | No | Auto-detected for known global plugins |
| `subfolder` | string | No | Subfolder path (e.g., `"UI/Buttons"`) |

**What it does:**
1. Validates name (uniqueness, reserved names, format). A name equal to an existing object type or family name, or to `"System"` or the name of the built-in Functions object (`functionsName`), ignoring case, is refused: the editor would fail to open the project (load-time rule `duplicate-object-name`, see [`validate_project`](#validate_project)).
2. Ensures plugin is registered in `usedAddons` (auto-adds known Scirra plugins)
3. Generates SID (+ UID for global plugins, + animation SID for Sprite)
4. Builds from plugin-specific template
5. Writes `objectTypes/<name>.json`
6. Adds name to `project.c3proj` objectTypes container

### `update_object_properties`

Update an existing object's instance variables and behaviors.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Existing object name, as registered: a name that differs only in letter case is refused as not found, naming the registered one |
| `isGlobal` | boolean | No | Change global status |
| `addVariables` | array | No | `[{ name, type: "number"\|"string"\|"boolean" }]` |
| `removeVariables` | string[] | No | Variable names to remove |
| `addBehaviors` | array | No | `[{ behaviorId: "Tween"\|"Sin"\|etc., name }]` |
| `removeBehaviors` | string[] | No | Behavior names to remove |
| `force` | boolean | No | Remove instance variables and behaviors even if events use them (default: false) |

**Removing what events use:** before anything is changed, the instance variables and behaviors to remove are checked against the events. A use is the `"instance-variable"` parameter or the `behaviorType` of a condition or action on the object, an `"instance-variable"` parameter that names the object itself as `{ "name": "hp", "objectClass": "Sprite" }` (the shape editor-saved System actions such as *Sort Z order* use, next to `"object": "Sprite"`), `Object.name`, `Object(0).name` or `Object.Behavior.Expression` in any parameter expression (function call arguments included), and `Self.name` or `Self.Behavior.Expression` in a parameter expression of a condition or action on the object. All these names are matched ignoring case: editor-saved projects spell object, instance variable and expression names in expressions in other case and open, and the `"instance-variable"` parameter and `behaviorType` are compared the same way, so a use that differs from the name only in letter case blocks the removal too (and `validate_project` does not report it). `Object.name` counts only when `name` is an instance variable or behavior of the object, since anything else there is one of the plugin's expressions (`Sprite.X`). A use that a family of the object still resolves after the removal (a family instance variable or behavior of the same name) does not count.
- If used and `force=false`: nothing is changed (`success: false`, `action: "update_blocked"`), also none of the other changes the call asks for. `message` sums up the uses; `references` holds `eventSheets` (names) and `uses` (`{ eventSheet, path, eventPath, sid, objectClass, kind, name, context, form }`), capped at 50 entries with `usesNotListed` counting the rest. `path` is the event path with the condition or action index (`block > action:0`), which sibling events share; `eventPath` is the JSON path of the event (`events[3].children[1]`), as [`locate_event`](#locate_event) returns it and the SID-based event tools take it; `sid` is the condition's or action's SID, when it has one. `kind` is `instance variable` or `behavior`, `context` is `condition`, `action` or `expression`, `form` is `instance-variable`, `behaviorType`, `legacy-behavior-type`, `behavior-expression` or `member-expression`
- If used and `force=true`: removes them with a warning that names the uses (they are NOT changed). [`validate_project`](#validate_project) then reports them as `missing-behavior-or-variable` (a behavior named under the legacy `"behavior-type"` key as `legacy-behavior-key`), except the uses written as `Object.name` or `Self.name` in expressions (form `member-expression`), which it cannot tell apart from the plugin's own expressions: a second warning lists those (`"Sheet1" block > action:0 at events[3]`)
- Scripts (script actions, script blocks and project script files) are not checked, since which object's instances they read cannot be told, and never block a removal. When a script reads a removed instance variable or behavior by name (`instVars.hp`, `instVars["hp"]`, `behaviors.Fade`, compared with their letter case, as in JavaScript) and the object no longer has one of that name, the result warns and says where, so the scripts can be reviewed
- Not checked: timeline tracks

**Notes:**
- Reads the full existing object and preserves all fields not being modified
- Validates behavior addon registration (auto-adds known Scirra behaviors)
- Generates unique SIDs for each new variable and behavior
- Warns on duplicate variable/behavior names (skips them)
- Updates the object's layout instances (all layers, sub-layers and `nonworld-instances`): each gets a default entry for an added behavior (see [`add_instance_to_layout`](#add_instance_to_layout)) and loses the entry of a removed one; existing entries keep their values and their order (a new entry goes next to the entries it follows in the editor's order)
- On any behavior or instance variable change, an instance that has no entry for another behavior of the object or its families (older versions of these tools placed instances without them) gets a default entry for it too, and a warning names these behaviors and counts the instances

### `delete_object`

Delete an object type from the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Object name to delete |
| `force` | boolean | No | Delete even if referenced (default: false) |

**Behavior:**
- Checks for references in event sheets, layouts, and families (what counts as a reference: see [`find_orphaned_objects`](#find_orphaned_objects); project script files are not scanned): uses in events, instances on any layer or sub-layer and non-world instances, object properties of other instances that hold its SID, and membership in any family
- If referenced and `force=false`: blocks (`action: "delete_blocked"`) and lists where the object is used. `message` sums it up; `references` holds `eventSheets`, `layouts` and `families` (names), `events` (`{ eventSheet, path, context }` with `context` `condition`, `action`, `parameter`, `expression`, `script` or `custom-action`), `instances` (`{ layout, layer, instances }` per layout and layer, `layer` being a path such as `"Main > HUD"` for a sub-layer and absent for non-world instances) and `instanceProperties` (`{ layout, layer, objectType, uid, property }`). Each list is capped at 50 entries; `eventsNotListed`, `instancesNotListed` and `instancePropertiesNotListed` count the rest
- If referenced and `force=true`: deletes with a warning that names the remaining uses (references NOT cleaned up). [`validate_project`](#validate_project) then reports the dangling instances, object parameters, family memberships and Particles object properties as `broken-object-reference`, but not the uses in expressions and scripts: a second warning lists those
- Backs up the JSON file and removes from c3proj

### `create_family`

Create a new family. Families group object types of one plugin and share instance variables and behaviors across them.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Family name (unique) |
| `pluginId` | string | Yes | Plugin ID all members share (e.g. `"Sprite"`, `"Text"`) |
| `members` | string[] | No | Initial member object names (default: `[]`); unknown names produce a warning |
| `subfolder` | string | No | Subfolder path (e.g. `"UI"`) |

**Load-time checks** (see [`validate_project`](#validate_project)): a name equal to an existing object type or family name, or to `"System"` or the name of the built-in Functions object, ignoring case, is refused (`duplicate-object-name`). Members must all use one plugin: a member whose plugin differs from the others is refused (`family-plugin-mismatch`, *wrong plugin*). Members that agree with each other but not with `pluginId` only produce a warning. Members that do not exist produce a warning.

### `update_family`

Add or remove family members and shared instance variables.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Family name, as registered: a name that differs only in letter case is refused as not found, naming the registered one |
| `addMembers` | string[] | No | Object names to add |
| `removeMembers` | string[] | No | Object names to remove |
| `addVariables` | array | No | `[{ name, type: "number"\|"string"\|"boolean" }]` |
| `removeVariables` | string[] | No | Variable names to remove |
| `force` | boolean | No | Remove instance variables and members even if events use them (default: false) |

At least one parameter besides `name` must be provided. Duplicates and missing entries are skipped with a warning.

**Removing what events use:** before anything is changed, the removal is checked against the events, with the uses and matching rules of [`update_object_properties`](#update_object_properties). A family's conditions, actions and expressions (`Family.name`, `Self.name` on the family) reach only its own instance variables and behaviors; a member object type reaches its own and those of all its families.
- `removeVariables`: uses on the family itself, and uses through a member that gets the variable from this family only (not one it declares itself or also gets from another family)
- `removeMembers`: uses through a leaving member of the family's instance variables and behaviors that it gets from this family only. Whether events that use the family itself rely on the member being in it (they no longer pick or affect its instances) cannot be checked: removing a member while events use the family succeeds with a warning that counts those uses
- If used and `force=false`: nothing is changed (`success: false`, `action: "update_blocked"`, `references` as for `update_object_properties`, where `objectClass` is the family or the member the use goes through). With `force=true` the change goes ahead with the same warnings as in `update_object_properties`
- Scripts: as in `update_object_properties`, a warning when scripts read by name an instance variable or behavior that a member loses (a removed variable, or for a leaving member each of the family's instance variables and behaviors that it does not declare itself or get from another family)

When the family has behaviors, the layout instances of members that join get default entries for them, and those of members that leave lose them. Entries these instances lack for the other behaviors of their object and its families are added too, as in [`update_object_properties`](#update_object_properties).

**Load-time check:** a member change that makes the family mix plugins is refused and nothing is written (`family-plugin-mismatch`, *wrong plugin*). A mix that was already there does not block other updates, and removing the odd member is allowed.

### `delete_family`

Delete a family. The member object types are kept. The layout instances of its members lose the entries for the family's behaviors, and get the entries they lack for their other behaviors (see [`update_object_properties`](#update_object_properties)).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Family name to delete |
| `force` | boolean | No | Delete even if referenced (default: false) |

**Behavior:**
- Checks for references first. Uses of the family's name count as for [`delete_object`](#delete_object): the family as the object of a condition or action or of a custom action, in object parameters, expressions and script actions (`runtime.objects.Family`), and object properties of instances that hold its SID. Uses through a member count too: the `"instance-variable"` parameter or the `behaviorType` of a condition or action whose object is a member, an `"instance-variable"` parameter `{ name, objectClass }` that names a member (System *Sort Z order*), `Member.name`, `Member(0).name` or `Member.Behavior.Expression` in a parameter expression, and `Self.name` or `Self.Behavior.Expression` in a parameter expression of a condition or action whose object is a member, where `name` is an instance variable or behavior the member gets from this family only (not one it declares itself or also gets from another family). Names are matched ignoring case, as in [`update_object_properties`](#update_object_properties). Not detected: project script files and script access to instance variables and behaviors of member instances (`instVars`, `behaviors`)
- If referenced and `force=false`: blocks (`action: "delete_blocked"`) and lists where the family is used. `message` sums it up; `references` holds `eventSheets` and `layouts` (names), `events` and `instanceProperties` (as for `delete_object`) and `memberUses` (`{ eventSheet, path, eventPath, sid, member, kind, name, context }`, `eventPath` and `sid` as for the `uses` of [`update_object_properties`](#update_object_properties), `kind` being `instance variable` or `behavior` and `context` `condition`, `action` or `expression`). Each list is capped at 50 entries; `eventsNotListed`, `instancePropertiesNotListed` and `memberUsesNotListed` count the rest
- If referenced and `force=true`: deletes with a warning that names the remaining uses (references NOT cleaned up). [`validate_project`](#validate_project) then reports the conditions, actions and object parameters that name the family and the Particles object properties that hold its SID as `broken-object-reference`, and the uses through members as `missing-behavior-or-variable`, but not the uses of the family's name in expressions and scripts, nor the uses through members written as `Member.name` or `Self.name` in expressions: a second warning lists those
- Values that member instances in layouts hold for the family's instance variables are left as they are; their entries for the family's behaviors are removed, and entries they lack for their other behaviors are added
- Backs up the JSON file and removes from c3proj

### `create_event_sheet`

Create a new event sheet.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Event sheet name |
| `subfolder` | string | No | Subfolder path |
| `includeSheets` | string[] | No | Sheets to auto-include (validated for existence) |

A name that differs from an existing event sheet (in any folder) only in case is refused, as is a `subfolder` folder that differs from an existing project-bar folder only in case (see [Names and file names](#mutation-tools)).

### `add_event_to_sheet`

Add a structural event to an existing event sheet.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `eventType` | enum | Yes | `"group"` \| `"function"` \| `"variable"` \| `"include"` \| `"comment"` |
| `title` | string | For groups | Group title |
| `functionName` | string | For functions | Function name |
| `functionParams` | array | For functions | `[{ name, type }]` (names checked, see below) |
| `variableName` | string | For variables | Variable name (checked, see below) |
| `variableType` | enum | For variables | `"number"` \| `"string"` \| `"boolean"` |
| `initialValue` | string | For variables | Initial value |
| `includeSheet` | string | For includes | Sheet to include (validated) |
| `commentText` | string | For comments | Comment text |
| `position` | enum | No | `"start"` \| `"end"` (default: end) |

Runs the same load-time gate as `add_event_block` before writing.

#### Event variable names

A variable added with `add_event_to_sheet` goes to the top level of the sheet, so it is a global variable; a function goes there too. The variable's name, the names in `functionParams` and a new name given to `update_event_variable` are refused where the Construct 3 editor's event variable and function parameter dialogs refuse them (checked against the editor code of releases r449 and r495.2, which agree; both dialogs run the same checks):

- **In use in the scope, ignoring case.** A global variable's name must differ from every event variable (global, local, static) and function parameter in every event sheet of the project. A local variable's name must differ from every global variable, from the variables and parameters of each event enclosing it, and from every variable and parameter below its parent event; locals in other branches or other sheets do not count. A function parameter has the scope of a local variable declared directly in its function: for a new function, its name must differ from every global variable and from the function's other parameters, while parameters of other functions and locals elsewhere do not count. Changing only the case of a variable's own name is allowed.
- **A System expression name, ignoring case** — e.g. `time`, `dt`, `random`, `max`, `LayoutName` (all 136 System expressions of r495.2, deprecated ones included). Five of them (`ColorToHexString`, `distance3d`, `HexColor`, `ProjectFileCount`, `ProjectFileNameAt`) are not in r449, whose editor accepts these names; they are refused anyway, since the r495.2 editor refuses them, and the error says so.
- **Characters the editor removes** — whitespace, the characters `. , " ( ) ? : \ / ; * | ' - ! ¬ £ $ % ^ & + = < > { } [ ] @ # ~`, the backtick, the soft hyphen, the ideographic full stop `。`, the full-width forms `， （ ） ？ ：` of `, ( ) ? :` and the typographic double quotes `“ ”`, a leading underscore, or a name of digits only. Other full-width forms, such as `．` and `／`, are accepted, as in the editor.

Names of object types and families are not compared: the editor accepts an event variable named like an object. Event sheet files that are not registered in `project.c3proj` are not read, as the editor does not load them. The other sheets are read from disk for each check, so sheets saved outside the server count as well.

`move_events_between_sheets` applies the scope rule to the variables and parameters it copies or moves, in their new place: see [`move_events_between_sheets`](#move_events_between_sheets).

### `add_event_block`

Add a block event (conditions + actions) to an event sheet — the core of gameplay logic. Supports sub-events (blocks, comments and scripts), events without conditions, else and else-if blocks, OR blocks, function calls, script actions, comment rows, and disabling single conditions and actions. Everything is written in the shapes the Construct 3 editor saves (see **Written shapes** below). Arguments and keys the tool does not know are refused, never dropped (see **Unknown keys** below).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `eventType` | `"block"` | No | Optional; only `"block"` is accepted. Any other value (e.g. `"comment"`) is refused: comments, groups, variables, functions and includes are added with `add_event_to_sheet`, and a comment or script can also be a sub-event in `children`. |
| `sid` | number | No | Ignored: a block copied from `get_eventsheet_details` may carry its SID, but the new block always gets a new one. |
| `conditions` | array | No | Conditions (default: `[]`). Each: `{ id, objectClass, behaviorType?, parameters?, isInverted?, disabled? }`. AND-combined, or OR-combined in an OR block. `[]` makes an event without conditions: at the top level (or in a group) it runs every tick, as a sub-event whenever its parent runs. |
| `actions` | array | No | Actions (default: `[]`). Plugin/behavior/System action: `{ id, objectClass, behaviorType?, parameters?, disabled?, breakpoint? }`. Function call: `{ callFunction, parameters?: [...], disabled? }`. Script: `{ type: "script", script, language?, disabled? }`. Comment row: `{ type: "comment", text, "text-color"?, "background-color"? }` |
| `groupPath` | string | No | Insert inside group by title path (e.g., `"Movement > Collision"`). Segments are split at `>`. A segment first matches a group title exactly as typed, one space on each side of `>` counting as part of the separator (`"HUD "` and `"Parent > HUD "` name the title `"HUD "`, `"HUD"` and `"Parent > HUD"` the title `"HUD"`), so each of two sibling groups titled `"HUD"` and `"HUD "` can be reached. The editor also saves titles with leading or trailing whitespace, so a segment without such a match then matches the one group whose trimmed title equals the trimmed segment (`"HUD"` finds a lone `"HUD "`). When several do (e.g. `"HUD"` next to `"HUD "` and `" HUD"`), the call is refused with the candidate titles. |
| `position` | enum | No | `"start"` \| `"end"` (default: end) |
| `disabled` | boolean | No | Create the block disabled (default: false) |
| `isElse` | boolean | No | Make it an else block (default: false): a System `else` condition is written first. Conditions given in `conditions` follow it and make an else-if. |
| `isOrBlock` | boolean | No | Make it an OR block: the event runs when any of its conditions is true (Construct 3 *Make 'Or' block*). An OR block may hold several triggers. |
| `children` | array | No | Sub-events nested inside this block (recursive), each one of: a block `{ eventType?: "block", conditions?, actions?, disabled?, isElse?, isOrBlock?, children? }`, a comment `{ eventType: "comment", text, "text-color"?, "background-color"? }` or a script `{ eventType: "script", script, language?, disabled? }`. Other event types are refused (see **Sub-events** below). |

**Condition fields:**
- `behaviorType` — For behavior conditions/actions: the behavior's *name* as defined on the object type or one of its families (e.g. `"Platform"`, `"8Direction"` — not the behaviorId `"EightDir"`). Omit for plugin and System ACEs. Written to the event sheet as `"behaviorType"`, the key Construct 3 reads.
- `"behavior-type"` — **Deprecated** alias for `behaviorType`, still accepted and written as `behaviorType` (with a warning). Passing both with different values is an error.
- `isInverted` — Negate the condition.
- `disabled` — Disable an individual condition.
- `isOr` — **Deprecated**, never written: Construct 3 ORs a whole event, never single conditions. When every condition after the first carries `isOr: true`, the block is written as an OR block (`isOrBlock`), with a warning. `isOr` on the first condition only has no effect and is dropped. `isOr` on only some of the later conditions is refused, since one event cannot express it: use `isOrBlock`, or move the alternatives into sub-events.

**Action fields:**
- `behaviorType` / deprecated `"behavior-type"` — same as for conditions.
- `disabled` — Disable an individual action (the action exists but won't run).
- `breakpoint` — A debugger breakpoint on a plugin/behavior/System action, as the editor saves it; written only when `true`.
- Comment rows — `text`, plus the optional colours `"text-color"` and `"background-color"`, each `[red, green, blue, alpha]` with values from 0 to 1 as the editor saves them. Other colour forms (e.g. `"#ffcc00"`) are refused.
- Function calls — `callFunction` names an event function, `parameters` is the argument list in the order of the function's parameters: expressions as strings (`"1"`, `"\"text\""`, `"Player.X"`; numbers are written as strings), `true`/`false` for boolean parameters. The older form `{ id, objectClass, callFunction, parameters: { ... } }` is still accepted: its `id`, `objectClass`, `behaviorType` and `"behavior-type"` are dropped with a warning, also next to positional parameters, and parameters keyed `"0"`, `"1"`, … or by the function's parameter names become the positional array (with a warning); other keys are refused. A `breakpoint` on a function call is refused in either form, since no editor-saved function call on record has one. A call to a function that no event sheet defines, a different number of arguments than the function has parameters, and a boolean parameter given an expression (or the reverse) are warnings. A name that differs from the function's only in case is written with the function's spelling, as editor saves always spell calls, with a warning.
- Script actions — `script` is an array of lines, as the editor saves it, or one string that is split into lines. `language` is `"javascript"` (the default and only value).
- The built-in Functions object — the editor saves *Set return value* and the function map actions on it, not on System: `{ "id": "set-function-return-value", "objectClass": "Functions", "parameters": { "value": "..." } }`, and likewise `map-function`, `map-function-default` and `call-mapped-function`. Its name is `functionsName` in `project.c3proj` (`"Functions"` in every project on record). Conditions, other action ids and `behaviorType` on it, and these actions given on `System`, are written with a warning, since no editor save on record has them. *Set return value* outside a function block gets a warning too: it sets the return value of the function its event runs in, and `add_event_block` never adds to a function block (use `update_event_block` on the function block or one of its sub-events). The `function` parameter of `map-function` / `map-function-default` names an event function: a name that differs from the function's only in case is written with the function's spelling (editor saves pick it from a list), with a warning, and a name no function block has gets a warning, since the editor's loader throws *cannot find function* for it. The same applies when `update_event_block` or `update_event_block_action` changes the parameters of a function map.

**Sub-events (`children`):**
- A child is a block, a comment or a script — the kinds of sub-events editor-saved sheets hold under blocks — told apart by `eventType`. A block may leave `eventType` out.
- A block child is a full block event with its own conditions, actions, and children.
- A comment child `{ eventType: "comment", text, "text-color"?, "background-color"? }` and a script child `{ eventType: "script", script, language?, disabled? }` are written as the editor saves them (see **Written shapes**). Like script actions, `script` is an array of lines or one string that is split into lines, and `language` is `"javascript"`.
- Other event types are refused with an error that names the sub-event's path, and nothing is written: event variables, groups, function blocks and includes cannot be added as sub-events with this tool, and an unknown `eventType` is refused too. Groups, functions and includes are added with `add_event_to_sheet`. An event variable inside an event is a local variable, which this tool does not add; `add_event_to_sheet` adds variables only at the top level of a sheet, where they are global variables, a different scope.
- Children without conditions are normal sub-events: they run whenever their parent runs.
- Children with `isElse: true` are else (or else-if) branches of the sub-event before them. An else block needs a block without a trigger before it, with at most comments between (manual: *Else can only follow normal (non-triggered) events*), so an else block that is the first sub-event (comments aside), is inserted with no block before it, follows a triggered block or holds a trigger itself gets an `else-placement` warning from the load-time gate. To branch inside a trigger, put a block with the condition and then the else block as sub-events of the triggered event.
- With `isElse: true` (or a System `else` first condition), a further System `else` condition in `conditions` is a duplicate and is dropped, with a warning.
- Max nesting depth: 10 levels. Max total events (parent + all descendants, comments and scripts included): 200.

**Unknown keys.** Conditions, actions and sub-events accept only the keys listed here (and the entries of `update_event_block` only theirs). Any other key is refused with an error that names it and its path, and nothing is written — it would otherwise be dropped with its content (a mistyped `params`, a comment's `text` on a child without `eventType: "comment"`). The one exception is `sid`, which conditions, actions and sub-events copied from `get_eventsheet_details` carry: it is ignored, since everything written gets a new SID. The arguments of `add_event_block` and `update_event_block` are checked the same way: an argument the tool does not take (a mistyped `actons`, `subEvents` for `children`, `children` on `update_event_block`) is refused, and nothing is written. `add_event_block` ignores a `sid` argument, as on a block copied from `get_eventsheet_details`, and refuses an `eventType` other than `"block"`.

**Written shapes.** These match editor-saved projects (Construct 3 r449):
- Blocks: `eventType, conditions, actions, sid, disabled?, children?, isOrBlock?`. `children` is left out when there are none, and false flags are not written.
- Else: the System condition `{ "id": "else", "objectClass": "System", "sid" }` at index 0. There is no block-level `isElse` key.
- Conditions: `id, objectClass, sid, disabled?, behaviorType?, parameters?, isInverted?`; `isInverted` comes last, after `parameters`, in every inverted condition the editor wrote in the projects on record. Actions: `id, objectClass, sid, disabled?, breakpoint?, behaviorType?, parameters?`.
- Function calls: `{ "callFunction", "sid", "disabled"?, "parameters"?: [...] }` without `id`/`objectClass`.
- Script actions: `{ "type": "script", "language": "javascript", "script": [lines], "disabled"? }`. Comment rows: `{ "type": "comment", "text", "text-color"?, "background-color"? }`. Neither has a SID.
- Comment sub-events: `{ "eventType": "comment", "text", "text-color"?, "background-color"? }`. Script sub-events: `{ "eventType": "script", "language": "javascript", "script": [lines], "disabled"? }`. Neither has a SID.

**Validation:**
- `objectClass` is hard-validated against project objects, families, `"System"` and the built-in Functions object — across the entire tree (parent + all descendants)
- `behaviorType` is soft-validated (warning only, never blocks the write): it must name a behavior on the object type or on a family the object belongs to (for a family `objectClass`: on the family). The warning lists the available behavior names and hints when a behaviorId was passed instead of the name. When the object type or a family file cannot be read, the warning says the behavior could not be verified instead.
- `id` (ACE identifier) is **not** validated — Claude knows the hundreds of C3 ACE IDs
- Script actions, comment rows, function calls and comment/script sub-events skip objectClass validation; script actions, comment rows and comment/script sub-events get no SID

**Load-time gate:** before writing, the sheet is checked against the editor load-time rules `expression-syntax`, `empty-expression`, `trigger-placement` and `else-placement` (see [`validate_project`](#validate_project)). The check covers the whole sheet, so the new block's position counts, and it compares the sheet before and after the change. A new error blocks the write with an explanation and nothing is written. New warnings are returned in `warnings`. Problems that were already in the sheet do not block the write, unless the change makes one of them worse (a warning that becomes an error); fixing part of an existing problem is allowed. The same gate runs in `add_event_to_sheet`, `update_event_block` and `update_event_block_action`. `move_events_between_sheets` runs it over the source and target sheets together: moving an event that already breaks a rule (`deleteSource: true`) is allowed, while copying it is refused, since the copy adds the problem to a second sheet.

Two triggers in one AND block are rejected. For "Space OR Up pressed", make it an OR block (`isOrBlock: true`) or add one event per trigger.

**What it does:**
1. Reads the target event sheet
2. Validates all `objectClass` references across the entire event tree
3. Recursively generates SIDs for each block, condition, action and function call
4. Builds conditions and actions in the editor's shapes and key order (see **Written shapes**)
5. Recursively builds child sub-events (blocks, comments, scripts), else branches and OR blocks
6. If `groupPath`: resolves nested group path (error with the groups at the level that did not match, titles quoted so outer whitespace shows)
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
| `eventPath` | string | No | With `sid`: picks one of several events that share the SID, e.g. `"events[3].children[1]"` (see [Events that share a SID](#mutation-tools)) |
| `includeSheet` | string | No* | For removing includes: the included sheet name |
| `dryRun` | boolean | No | Preview what would be deleted without deleting (default: false) |
| `force` | boolean | No | Delete even when functions or event variables the delete removes are still referenced (default: false); the references are listed in `references` and in a warning, and left dangling |

*Exactly one of `sid` or `includeSheet` must be provided.

**Behavior:**
- **SID deletion**: Finds the event anywhere in the tree (including nested inside groups) using iterative traversal. Reports children count for groups, checks the references below for the functions and variables it removes. A SID shared by several events is refused, also with `dryRun`, unless `eventPath` picks one; the result names the deleted event's `eventPath`.
- **Include deletion**: Finds and removes the include event by sheet name. Lists current includes in error messages.
- **Dry run**: Returns a preview of what would be deleted without writing changes, with the same `warnings` the delete would return. A dry run with `force=true` also lists the references the delete would leave dangling (`references`, as below).
- **Reference safety**: A delete removes the event with all its sub-events, so it can remove function blocks (the event itself, or ones inside a deleted group) and event variables (the event itself, or ones among the deleted sub-events). Unless `force=true`, it is refused (`success: false`, `action: "delete_blocked"`, also on a dry run) while anything outside the deleted events still names one of them, anywhere in the project:
  - functions: *Call function* actions, *Map function* / *Map function default* actions that register the function in a function map, and `Functions.Name(...)` calls in the expressions of conditions and actions (listed in `references.callers` with `function`, `via`, `sheet`, `path` and the `sid` of the event holding the condition/action);
  - event variables: the `variable` parameter of the System conditions and actions that compare, set, add to, subtract from, toggle or reset an event variable, and expressions that use the variable by name, such as `Score * 2` or a function call argument `Score` (listed in `references.variableReferences` with `variable`, `via`, `sheet`, `path` and `sid`; `via` is `event-variable` or `expression`). In expressions, names inside string literals, after a `.` (`Sprite.Score`) or before a `.` or `(` are not uses, and parameters that hold a name instead of an expression (object, instance variable, layout and audio file parameters) are not read; a combo value spelled like the variable is counted, so check the listed references and use `force=true` if none is a real use. Scope counts: a global variable (top level of a sheet) is visible in every sheet, any other variable to the events beside it and below them, and inside a function block a function parameter of the same name resolves the reference too.

  Names are compared ignoring case. A reference that another function or variable of the same name still resolves after the delete (e.g. a global of that name in another sheet) is not counted, and neither is one that was already dangling. After loading a project, the editor resolves these names and throws *invalid function name* (Call function), *cannot find function* (function maps) or *cannot find event variable* when one is missing (editor loader code, r495.2); whether the project then fails to open has not been confirmed in the editor. A `Functions.Name(...)` expression would call a function that no longer exists, and an expression that uses a deleted variable by name would name a variable that no longer exists. With `force=true` the delete goes ahead, and the references are named in a warning and listed in `references`. Scripts are not scanned, and `validate_project` does not report such references.
- **Load-time rules**: A delete takes an event out together with all its sub-events. The `expression-syntax`, `empty-expression` and `trigger-placement` rules look only at an event's own conditions and actions and at its ancestors, and no remaining event gains an ancestor or a condition, so a delete cannot introduce an issue of these rules; the names it leaves dangling are covered by the reference safety above. It can leave an else block without the block it belonged to (after a triggered block, after a non-block event or first in its list, comments aside): that `else-placement` warning is returned in `warnings`, also on a dry run. Include deletion is not checked (includes are not part of these rules).
- Error messages include a navigable summary of top-level events with their types and SIDs.

### `update_event_block`

Update an existing block event — modify action parameters, add/remove actions or conditions, toggle disabled state, make it an else or OR block.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `sid` | number | Yes | SID of the block event to update |
| `eventPath` | string | No | Picks one of several events that share the SID (see [Events that share a SID](#mutation-tools)) |
| `disabled` | boolean | No | Enable or disable the entire block |
| `isElse` | boolean | No | `true`: put the System `else` condition first (existing conditions then make an else-if); `false`: remove a leading `else` condition. Blocks only. A block-level `isElse` key left by older versions is dropped either way. |
| `isOrBlock` | boolean | No | `true`: make it an OR block; `false`: AND-combine its conditions again |
| `updateActions` | array | No | `[{ index, parameters?, disabled? }]` — update actions by index (merge semantics). For a function call, `parameters` is an argument array that replaces all arguments, or an object keyed by position (`"0"`, `"1"`, …) or parameter name that replaces single ones. Other keys are refused. |
| `updateConditions` | array | No | `[{ index, parameters?, isInverted?, disabled? }]` — update conditions by index. Other keys (e.g. `behaviorType`) are refused: remove the condition and add a new one instead. |
| `addActions` | array | No | Append new actions (same shapes as in `add_event_block`) |
| `addConditions` | array | No | Append new conditions |
| `removeActionIndices` | number[] | No | Remove actions by 0-based index |
| `removeConditionIndices` | number[] | No | Remove conditions by 0-based index |

At least one update parameter must be provided.

**Operation ordering** (all indices reference the ORIGINAL array positions):
1. Block toggles (`disabled`, `isOrBlock`)
2. Updates (non-length-mutating) — merge parameters, toggle flags
3. Removals (descending order, deduped) — shrink arrays
4. Additions (append) — grow arrays
5. `isElse` — adds or removes the leading `else` condition
6. Final state checks — warn if this call removed the last condition

**Notes:**
- Only works on `block` or `function-block` events (not groups, variables, etc.)
- New actions/conditions get fresh SIDs via the ID generator
- `objectClass` is validated on new conditions/actions; `behaviorType` is soft-validated and the deprecated `"behavior-type"` alias is normalized, as in `add_event_block`. All additions are validated in one pass before anything changes, so each warning appears once and a conflicting key aborts the call without writing.
- Existing conditions/actions edited through `updateConditions`/`updateActions` that still carry the legacy `"behavior-type"` key are normalized to `"behaviorType"` with the same rules as `fix_legacy_behavior_keys`, and each one is reported in `warnings`. `update_event_block_action` does the same for the action it edits.
- Duplicate removal indices are automatically deduplicated
- Warns only when this call removed the last condition (the block then runs whenever its parent runs; a function body on every call). Blocks that never had conditions, such as function blocks and condition-less sub-events, get no warning.
- `disabled` on the block, an action or a condition is written right after its `sid`, as the editor does. Parameters added to a condition that has `isInverted` but no `parameters` go before `isInverted`, and a new `isInverted` goes last, where the editor writes them.
- Added actions on the built-in Functions object are checked as in `add_event_block`; *Set return value* gets no warning when the block is a function block or one of its sub-events.
- An added condition with the deprecated `isOr` flag is refused unless the block is (or becomes) an OR block. An added System `else` condition is appended: on a block without conditions it becomes the first condition; in an else block, or with `isElse: true`, it is a duplicate and is dropped; otherwise it lands after the existing conditions with a warning (use `isElse: true` instead).
- Comment rows and script actions have no parameters: `parameters` on them is refused, and so is `disabled` on a comment row (editor-saved comment rows are `{ type, text }` with the optional colours `"text-color"` and `"background-color"`; none on record carries `disabled`).
- Arguments the tool does not take are refused, and nothing changes: `update_event_block` does not add sub-events, so `children` is refused too. Added conditions and actions, and the entries of `updateConditions` / `updateActions`, refuse keys they do not know, as in `add_event_block` (see **Unknown keys** there); a `sid` on an added condition or action is ignored.
- A function call stored in an older shape (with `id`/`objectClass` or keyed parameters) whose arguments are edited is rewritten in the editor's shape, with a warning. A call whose name differs from its function's only in case is written with the function's spelling, with a warning.
- Runs the load-time gate (see `add_event_block`) on the whole sheet, so a trigger added to a sub-event of a triggered event, of a function block or of a custom action block is rejected, as is a second trigger in one event. New conditions are appended, so a trigger added to a block that already has conditions ends up after them; that only warns, since the editor moves it to the top when it opens the project. A block made an else block where Else cannot stand (no block before it, comments aside, or a block with a trigger) gets an `else-placement` warning.

### `update_event_block_action`

Replace the parameters of a single action. The block is found by SID anywhere in the sheet; the action by its 0-based index.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Target event sheet |
| `blockSid` | number | Yes | SID of the `block` or `function-block` holding the action |
| `eventPath` | string | No | Picks one of several events that share the SID (see [Events that share a SID](#mutation-tools)) |
| `actionIndex` | number | Yes | 0-based action index |
| `parameters` | object \| array | Yes | New parameter values; replaces the existing `parameters` entirely (max 100 keys, depth 6). For a function call: the arguments in parameter order as an array; an object keyed `"0"`, `"1"`, … or by the function's parameter names is converted to that array. An array for any other action is refused. |

Runs the load-time gate (see [`add_event_block`](#add_event_block)): parameters that break `expression-syntax` or `empty-expression` are refused and nothing is written; function call arguments are checked position by position. A legacy `"behavior-type"` key on the edited action is normalized as in `update_event_block` and reported in `warnings`, and a function call stored in an older shape is rewritten in the editor's shape (with the function's spelling of its name). Comment rows and script actions have no parameters and are refused. The result names the action by `actionId`, or by `callFunction` for a function call.

### `update_event_variable`

Update an event variable declaration found by SID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sheetName` | string | Yes | Event sheet containing the variable |
| `sid` | number | Yes | SID of the `variable` event |
| `eventPath` | string | No | Picks one of several events that share the SID (see [Events that share a SID](#mutation-tools)) |
| `newName` | string | No | New name (checked, see [Event variable names](#event-variable-names)) |
| `newType` | `"number"` \| `"string"` \| `"boolean"` | No | New type |
| `newInitialValue` | string | No | New initial value, as a string |
| `isStatic` | boolean | No | Value persists between calls |
| `isConstant` | boolean | No | Value cannot change at runtime |

At least one change must be provided. References to the old name are not updated. A new name is refused where the editor refuses it (see [Event variable names](#event-variable-names)): for a global variable it must differ, ignoring case, from every event variable and function parameter in the project, for a local one from those in its scope; changing only the case of the variable's own name is allowed.

### `move_events_between_sheets`

Copy top-level events from one sheet to another by SID; with `deleteSource` they are moved. SIDs and nested children are kept as they are.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sourceSheet` | string | Yes | Sheet to copy/move from |
| `targetSheet` | string | Yes | Sheet to copy/move into (must differ from the source) |
| `sids` | number[] | Yes | SIDs of top-level events in the source sheet (min 1, each SID once) |
| `eventPaths` | string[] | No | Paths of top-level events (`"events[4]"`) that pick one of several top-level events sharing a SID in `sids`, one per such SID (see [Events that share a SID](#mutation-tools)) |
| `deleteSource` | boolean | No | Remove the events from the source after copying (default: false) |
| `targetGroupPath` | string | No | Insert into a group by title path (e.g. `"Movement > Collision"`), matched as `groupPath` in `add_event_block` (titles with leading/trailing whitespace included) |
| `position` | `"start"` \| `"end"` | No | Insert position (default: end) |

Copied and moved events keep their event variable and function parameter names. A copy or move that would give one of them a name that is in use, ignoring case, in its new scope (see [Event variable names](#event-variable-names)) is refused and nothing is written; the error lists the clashing names. The most common case is a copy of a global variable (`deleteSource: false`), since its original keeps the name; moving it is fine. A local variable or parameter moved into a group (`targetGroupPath`) can also clash with the group's variables. The editor renames a pasted variable in this case instead; rename it first with `update_event_variable`. Clashes that the events already had in their old place are not counted.

Runs the load-time gate (see [`add_event_block`](#add_event_block)) over the source and target sheets together, before anything is written. Moving an event that already breaks a load-time rule only relocates the problem and is allowed; copying it (`deleteSource: false`) adds the problem to a second sheet, so a copied error is refused and a copied warning is returned in `warnings`.

Only top-level events count: a SID shared by two top-level events of the source is refused unless `eventPaths` picks one, while a nested event with the same SID does not make it ambiguous. `deleteSource` removes exactly the copied events. A SID listed twice in `sids` is refused; top-level events that share a SID are moved one per call.

Copied events keep their SIDs. When a copied event, or one of its sub-events, has a SID that another event of the target sheet already has (for example, the same event copied twice), the copy is still written, since the editor opens such sheets, and `warnings` names each such SID with the paths of its events there: the SID-based event tools then refuse it in the target sheet unless `eventPath` picks one.

Returns `movedSids`, `movedCount`, `backupFiles` (target first, then source when modified) and `warnings`, if any: new load-time warnings and the shared-SID warning.

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

### `fix_legacy_event_shapes`

Repair event sheets written by construct3-mcp 1.8.1 and earlier, whose event tools used shapes that Construct 3 itself never writes (issue #32): a block-level `"isElse"` instead of the System `else` first condition, a per-condition `"isOr"` instead of the block's `"isOrBlock"`, and function calls with `id`/`objectClass` and keyed parameters instead of `{ callFunction, sid, parameters: [...] }`. Whether the editor ignores these or refuses the project is not verified; at best an `isElse` block runs like an ordinary block and an `isOr` block like an AND block.

The tool also converts scripts stored as one string or without `language`. Older Construct 3 releases saved scripts that way, and construct3-mcp 1.8.1 and earlier wrote script actions that way too; current releases save `{ type: "script", language: "javascript", script: [lines] }`. Converting them is harmless (one report says the desktop editor did not show a script action stored as one string).

**Converting else and OR blocks can change what a game does.** The conversion follows what the old flag asked for, not how the event ran: an `isElse` block that ran like an ordinary block runs only when the block before it did not, and an `isOr` block whose conditions were AND-combined runs when any of them is true. These changes carry `changesBehavior: true` and say so in their `detail`, the result counts them in `totalBehaviorChanges`, and the message asks to test those events in the game.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dryRun` | boolean | No | Only report what would change (default: **true**). Set `false` to rewrite the affected sheets. |

**Converted** (the result is unambiguous):
- `isElse: true` on a block without conditions whose previous sibling, not counting comments, is a block without a trigger: a System `else` condition with a new SID is put first and the key dropped. When the block already starts with the `else` condition, or the key is not `true`, the key is just dropped.
- `isOr` on every condition after the first: the block gets `isOrBlock: true` and the keys are dropped. `isOr` keys that never had an effect (on the first condition only, `false`, or in a block that already is an OR block) are dropped.
- Function calls: `id`, `objectClass` and behavior keys are dropped, and parameters keyed `"0"`, `"1"`, … or exactly by the function's parameter names become the positional array, in the order `callFunction, sid, disabled, parameters`.
- Script actions and script events: a script stored as one string becomes an array of lines (split at line breaks), and a missing `language` becomes `"javascript"`, in the order `type, language, script, disabled`.

**Reported under `manual`** (left untouched): an `isElse` block that has conditions (it would become an else-if that tests them: decide with `update_event_block` and `isElse: true` or `false`), an `isElse` block with no block before it (comments aside) or after a block with a trigger (Else can only follow non-triggered events), `isOr` on only some of the later conditions (make it an OR block, or split the event), calls whose parameter keys cannot be mapped, and scripts that are neither text nor a list of lines.

Only sheets with conversions are written, each backed up first. Returns `totalConverted`, `totalManual`, `totalBehaviorChanges` and per-sheet `changes` (kind, JSON path, SID, what changes, `changesBehavior`; capped at 100 per sheet), `manual` and `backupFile` when written. `validate_project` reports affected sheets as warnings with check `legacy-event-shape`.

### `create_layout`

Create a new layout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Layout name |
| `width` | number | No | Width in pixels (default: project viewport width) |
| `height` | number | No | Height in pixels (default: project viewport height) |
| `eventSheet` | string | No | Linked event sheet name (validated) |
| `layers` | string[] | No | Layer names (default: single `"Layer 0"`) |

A name that differs from an existing layout (in any folder) only in case is refused: the editor compares layout names ignoring case. So are `layers` that differ from each other only in case.

### `add_instance_to_layout`

Place an object instance on a layout layer or sub-layer. For copying instances between layouts, read the source with `get_layout_details` and pass instance properties here.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Target layout |
| `layerName` | string | Yes | Target layer: any layer or sub-layer of the layout, by name (a sub-layer also by its path, e.g. `"Main > HUD"`) |
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
| `behaviors` | object | No | Behavior property values as `{behaviorName: {properties: {prop: val}}}` (the shape `get_layout_details` returns) or `{behaviorName: {prop: val}}`; they override the defaults |
| `tags` | string | No | Comma-separated instance tags (alphanumeric only) |
| `showing` | boolean | No | Whether instance is initially visible (default: true) |
| `locked` | boolean | No | Whether instance is locked in the editor (default: false) |

**Notes:**
- Blocks global-only objects (singleglobal-inst) from being placed
- The new UID is above every UID in the project, sub-layer instances included, and the new SID is unused
- Nonworld-global objects (Array, JSON, Dictionary) are placed in `nonworld-instances` instead of on layers
- Auto-fills default instance properties for Sprite, Text, TiledBg, NinePatch
- Writes a behavior entry for every behavior of the object and of the families it belongs to, like the editor: family behaviors first, then the object's own, each as `{"properties": {...}}` with the built-in behavior's default values (from the Construct 3 r449 editor's behavior definitions). Values passed in `behaviors` override the defaults. A behavior without known defaults (third-party addons) gets `{"properties": {}}` and a warning; Construct 3 fills in missing properties with their defaults when it opens the project (Scirra's own example projects contain such entries). The warning also points out a behaviorId that is not one the editor defines, such as `"Solid"` for `"solid"`
- Warns on unknown instanceVariable keys (may be inherited from families), on behavior names that are not behaviors of the object or its families, on property ids that a built-in behavior does not have, and on values whose type differs from the property's default (e.g. a string for a check box)
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

Add a new top-level layer to a layout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout to add the layer to |
| `layerName` | string | Yes | New layer name, different from every layer of the layout (sub-layers included) ignoring case, as the editor compares layer names |
| `index` | number | No | Insert position (0 = bottom; default: on top) |
| `isInitiallyVisible` | boolean | No | Starts visible (default: true) |
| `isTransparent` | boolean | No | Transparent background (default: true) |
| `parallaxX` | number | No | Horizontal parallax rate (default: 1) |
| `parallaxY` | number | No | Vertical parallax rate (default: 1) |
| `blendMode` | enum | No | `"normal"` (default), `"additive"`, `"xor"`, `"copy"`, `"destination-over"`, `"source-in"`, `"destination-in"`, `"source-out"`, `"destination-out"`, `"source-atop"`, `"destination-atop"` |

A name used by another layer of the layout (sub-layers included) is refused, also when it differs only in case: the editor refuses such a layer name and cannot load a layout with two of them.

### `update_layer`

Update properties of an existing layer or sub-layer.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `layerName` | string | Yes | Layer or sub-layer to update, by name (a sub-layer also by its path, e.g. `"Main > HUD"`, which picks one of several layers with the same name) |
| `newName` | string | No | Rename the layer (must differ from the other layers of the layout, sub-layers included, ignoring case; changing the case of the layer's own name is fine) |
| `isInitiallyVisible` | boolean | No | Initial visibility |
| `isInitiallyInteractive` | boolean | No | Initial interactivity |
| `isTransparent` | boolean | No | Transparency |
| `parallaxX` | number | No | Horizontal parallax rate |
| `parallaxY` | number | No | Vertical parallax rate |
| `blendMode` | enum | No | Same values as `add_layer` |
| `scaleRate` | number | No | Scale rate (parallax zoom) |
| `zElevation` | number | No | Z elevation for 3D layering |

At least one property must be provided. A new name used by another layer of the layout (sub-layers included), also one that differs only in case, is refused; changing only the case of the layer's own name is allowed.

### `delete_layer`

Delete a layer or sub-layer from a layout, together with its sub-layers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `layoutName` | string | Yes | Layout name |
| `layerName` | string | Yes | Layer or sub-layer to delete, by name (a sub-layer also by its path, e.g. `"Main > HUD"`) |
| `force` | boolean | No | Delete even if the layer or its sub-layers hold instances; they are lost (default: false) |

**Behavior:**
- The last top-level layer of a layout cannot be deleted
- A layer whose own or sub-layers' instances are not empty returns `success: false`, `action: "delete_blocked"` with `instanceCount` (sub-layers included), and `subLayerCount` when the layer has sub-layers, unless `force=true`

### `update_instance`

Update a placed instance, found by UID on any layer or sub-layer or among the non-world instances (which ignore position, size, angle, Z elevation and color).

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

Remove a placed instance by UID from the layout's layers and sub-layers or its non-world instances.

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
- Checks animation name uniqueness within the sprite, including the animations in animation folders (their image file names do not contain the folder), ignoring case like the editor. A name that differs from an existing animation's only in case (`"walk"` next to `"Walk"`) is refused too: image file names are all lowercase, so both animations would use the same image files
- Refuses a name with a character that cannot be part of its image file names (`images/<object>-<animation>-NNN.png`): a path separator (`/`, `\`), a character Windows does not allow in file names (`:` `*` `?` `"` `<` `>` `|`) or a control character. The animation names of the editor-saved projects checked use only letters, digits, spaces, `_` and `-`. `add_frame_to_animation` and `replace_sprite_image` refuse an existing animation with such a name
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

Like the other tools that take an existing `animationName` (`delete_animation`, `rename_animation`, `add_frame_to_animation`, `delete_frame_from_animation`, `update_frame`, `replace_sprite_image`), it finds the animation by its exact name in any animation folder, where the animation stays. When the name is not found, the error lists the sprite's animations, those in animation folders with their folder path (e.g. `Moves/Walk`); pass the name alone.

### `rename_animation`

Rename an animation on a Sprite object.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Current animation name |
| `newName` | string | Yes | New animation name |

A new name that differs from another animation of the sprite (in any animation folder) only in case is refused (see [`add_animation_to_sprite`](#add_animation_to_sprite)); changing only the case of the animation's own name is allowed. `objectName` must be spelled exactly like the object's name: layout instances and event sheets name the object exactly, so a differently cased name (which Windows and macOS would still find the object file with) is refused.

The rename also does what the editor does when it renames an animation:
- **Frame image files** are renamed with it: for every frame, the file it uses, `images/<object>-<old name>-NNN.<ext>` (`.jpg` for a JPEG frame, `.png` otherwise), becomes `images/<object>-<new name>-NNN.<ext>`, all lowercase. A file whose name differs only in case is found too and gets the lowercase name. Frames, `sid` and `imageSpriteId`s stay as they are (the file name does not contain them). A frame without an image file is named in a warning. Files no frame uses (another extension, or an index past the last frame) keep their names.
- **Layout instances** of the object whose `initial-animation` is the old name get the new name (on every layer and sub-layer).

It is refused, and nothing is changed, when:
- a renamed image would replace an existing file in `images/` (also one whose name differs only in case);
- the new name has a character that cannot be part of a file name (see [`add_animation_to_sprite`](#add_animation_to_sprite));
- another animation of the object (in any animation folder) has frames and a name that differs from the old name only in case: both use the same image files, and renaming them would leave the other animation without images. Delete the duplicate first (`delete_animation` leaves the image files in place).

The image files are renamed first, then the object and the layouts are written; if a write fails, the files already written, and the file whose write failed if it was already replaced (e.g. its post-write check failed), are restored from their backups and the image files are renamed back.

Strings in event sheets that name the old animation (e.g. `"Walk"` in *Set animation*) are not changed; a warning lists the event sheets with such parameters on the conditions and actions of the object and of the families it belongs to. Parameters that compute a name (e.g. `"Walk" & n`) are not counted.

### `delete_animation`

Delete an animation from a Sprite object; an animation in an animation folder is removed from that folder. The last animation cannot be deleted (animations in folders count). The animation's image files are left in `images/`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation to delete |

### `add_frame_to_animation`

Add a blank frame (with a placeholder PNG in `images/`) to a Sprite animation. Like every image the tools write, the file is named as the editor names it: `<object>-<animation>-<frame, 3 digits>.png`, all lowercase, spaces kept (e.g. `hero-walk left-001.png`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |
| `index` | number | No | Insert at this frame index, 0 to the frame count (default: append) |
| `width` | number | No | Frame width in pixels (default: first frame's width) |
| `height` | number | No | Frame height in pixels (default: first frame's height) |
| `duration` | number | No | Frame duration (default: 1) |

An `index` greater than the frame count is refused before anything is written.

**Frame image files move with their frames.** The editor names a frame's image after the frame's index (`<object>-<animation>-NNN.<ext>`), so inserting at `index` renames the image files of the frames from `index` on one index up, the last frame first (`hero-walk-002.png` → `hero-walk-003.png`, then `hero-walk-001.png` → `hero-walk-002.png`), and the placeholder takes the freed name. Each file keeps the extension of its frame's `fileType` (`.jpg` for a JPEG frame, `.png` otherwise; for another `fileType`, every file with the frame's name and a single extension moves, e.g. `.gif`). Names are matched ignoring case, and moved files get the lowercase name. `warnings` names the renamed files and the frames after the index that have no image file.

No existing file is written over, also when appending: a file that no frame uses but has the name a moved image or the placeholder needs (e.g. an image left behind by `delete_frame_from_animation` of earlier versions, or a PNG next to a JPEG frame's `.jpg`) is renamed to `<file>.bak` (`<file>.1.bak`, … if that name is taken) and named in `warnings`. The image files are renamed first, then the placeholder and the object are written; if a step fails, the placeholder is removed, the object file is restored from its backup if it was already replaced, and the image files get their old names again. The call is refused, with nothing changed, if the renames cannot be done without replacing a file (e.g. two files whose names differ only in case on a case-sensitive file system).

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

Like [`add_frame_to_animation`](#add_frame_to_animation), it keeps the frames and their image files together: the deleted frame's image file is renamed to `<file>.bak` (kept, not deleted), then the image files of the frames after it are renamed one index down, with the extension of their `fileType`. `warnings` names the renamed and kept files. If the object write fails, the object file is restored from its backup if it was already replaced and the image files get their old names again.

### `replace_sprite_image`

Replace a frame's image with real PNG data. The PNG is written to the frame's file in `images/`; the object JSON is backed up and rewritten. The editor picks the file's extension from the frame's `fileType`, so a frame stored in another format (e.g. JPEG, in `<name>.jpg`) gets `fileType: "image/png"` and the new `<name>.png`; the old file is left in `images/` and a warning names it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objectName` | string | Yes | Sprite object name |
| `animationName` | string | Yes | Animation name |
| `frameIndex` | number | Yes | 0-based frame index |
| `pngBase64` | string | Yes | Base64-encoded PNG (checked for the PNG signature) |
| `width` | number | No | Image width in pixels; updates the frame metadata |
| `height` | number | No | Image height in pixels; updates the frame metadata |

### `create_timeline`

Create a timeline in `timelines/` (or `timelines/<subfolder>/`) and register it in `project.c3proj`, in the same project-bar folder. The name must not be used by another timeline, by a transition, or by an entry in a malformed nameless folder (see [`list_timelines`](#list_timelines)). Construct 3 compares timeline names exactly, but a name that differs only in case from a timeline in the same folder is refused: on Windows and macOS both would be one file. A case variant of a timeline in another folder, or of a transition, is created with a `warnings` entry. A `subfolder` folder that differs from an existing project-bar folder only in case is refused, and an existing file at the target path is never replaced (no backup is made on create).

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

Explain how an event sheet works. Parameter: `eventSheetName`. Asks to run `find_runtime_traps` for that sheet and to check `construct3://docs/pitfalls`.

### `review_game_logic`

Review overall game logic architecture, including a `find_runtime_traps` pass and the pitfalls in `construct3://docs/pitfalls`.

### `document_object`

Generate documentation for an object. Parameter: `objectName`.

### `optimize_project`

Get optimization suggestions.

### `debug_stuck_game`

Diagnose a game that gets stuck or a feature that silently does nothing. Optional parameter: `symptom`. Embeds the current `find_runtime_traps` findings and walks through signals, script exceptions, picking and animation restarts using `construct3://docs/pitfalls`. For a script exception in the console (`<sheet>, event N, action M`) it points to `locate_event`.

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
