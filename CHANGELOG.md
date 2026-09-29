# Changelog

All notable changes to the Construct3 MCP Server are documented here.

## [1.9.2] - 2026-09-29

### Highlights

- **Deletes no longer miss uses in files the server cannot parse.** The delete and removal tools search registered layouts, event sheets and families over the 10MB read limit or with invalid JSON as text, and refuse without `force` when the name possibly appears there. Before, `delete_object` deleted an object whose only instances were in such a layout (#55).
- **Honest usage analysis.** `find_orphaned_objects`, `get_object_dependencies` and `analyze_performance` report such objects as possibly used and list the files they could not parse, instead of calling them unused (#55).

### Changed

- `get_object_dependencies` and `find_orphaned_objects` no longer report an object as unused while a registered event sheet, layout or family file they could not parse (over the 10MB read limit, not valid JSON) names it or holds its SID, or cannot be read at all: `find_orphaned_objects` lists it in `possiblyUsed` instead of `orphanedObjects` (`count` counts the orphans only), and `get_object_dependencies` gives it `possiblyReferencedIn` (not counted in `referenceCount`) and, project-wide, lists it in `possiblyUsedObjects` instead of `orphanedObjects`. Both return `unscannedFiles`. The new fields appear only while there are such files (#55).
- The delete and removal tools listed under Fixed, and `rename_animation`, return `unscannedFiles` (each skipped file with its reason and the outcome of the text search: `possible-use` with the `names` found, `no-match` with what it was `searchedFor`, `unreadable`, or `not-searched` with what was `unchecked` for the tool's own object type or family file) whenever there is such a file; `get_object_dependencies` and `find_orphaned_objects` list them whenever there are any, `not-searched` when no object was left to search them for (#55).
- `rename_animation` has `force`. Without it, a layout it could not parse whose text names the object and the old animation (possibly instances that start with it, which it cannot update), or that cannot be read at all, refuses the rename with `update_blocked`; before, the rename went ahead with a warning (#55).
- `analyze_performance` counts unused objects like `find_orphaned_objects` and says how many more files it could not parse possibly use; `validate_project` reports no `orphaned-object` for them either (#55).

### Fixed

- The reference checks see uses inside registered files the bulk reads skip (over the 10MB read limit, not valid JSON, unreadable). Before, `delete_object` without `force` deleted an object whose only instances were in a layout over 10MB, without a warning, and the other checks missed such uses the same way. Such files are now searched as text (streamed, without a size limit; for a 50MB file about 0.1 s while the names are rare in the text, up to about 0.3 s when a name is common inside other words) for the names each check looks for, also as `\u` escapes for names outside ASCII, and UTF-16LE files with a byte order mark as such (a file in another encoding counts as unreadable): `delete_object` (the name in event sheets, layouts and families, the SID in layouts), `delete_family` (name and SID; its instance variables and behaviors together with a member's name), `delete_layout` (instances and an event sheet binding in the layout's own file), `delete_event_sheet` (the sheet name in event sheets and layouts), `delete_event_from_sheet` (the deleted functions and global variables in other event sheets), and the removals of `update_object_properties` and `update_family` (the removed names together with the object, family or leaving member). A match is a possible use: the text search cannot tell a use from the same name in another string, and the message says so. A match, or a file that cannot be read even as text, refuses without `force` and names the files; with `force` the tool goes ahead and names them in a warning; without a match it goes ahead and warns that the file was only searched as text. A registered name without a file does not block. Only these files are searched, and only when there are any (#55).
- `delete_object` and `delete_family` refuse without `force` when the object type's or family's own file could not be parsed: its SID (and a family's members and names) is unknown, so object properties that hold it and uses through members could not be checked. Before, they deleted without a word (#55).
- `delete_family` and `update_family` find uses of the family's instance variables and behaviors through a member whose object type file could not be parsed (`Enemy.armor` in a parsed sheet); before, they removed the family, variable or member without `force` (#55).
- `update_object_properties`, `update_family` and `delete_family` warn when layouts they could not parse possibly hold instances whose behavior entries they would have updated, and when a member's object type file could not be parsed; before, those instances were skipped silently (#55).
- `rename_animation` no longer leaves layouts it could not parse out silently (see Changed) and warns about such event sheets that possibly name the animation (#55).

## [1.9.1] - 2026-09-29

### Highlights

- **Frame images stay with their frames.** Inserting or deleting a sprite frame by index moves the positional image files with the frames instead of overwriting or misaligning them. Replaced and deleted images are kept as `.bak`, a failed step rolls back images and the object file, and `validate_project` reports frames without an image file (#36).
- **No duplicate UIDs next to very large files.** Layouts and object types over the 10MB read limit are scanned as text for their UIDs and SIDs, so new instances no longer reuse an ID. `validate_project` reports such files honestly (`unscanned-file`, `complete: false`, `valid: false`) instead of calling them missing (#49, based on work by @BeatsByZann).
- **Function options.** `add_event_to_sheet` sets a new function's return type, *Asynchronous* and *Copy picked* options (#49).
- **One cross-reference index per project.** Tools no longer mix up the index of two projects opened in one process, which could let a delete guard miss real uses (#38).
- **User guide.** [docs/USER-GUIDE.md](docs/USER-GUIDE.md) covers installing the server, connecting Claude Code, Claude Desktop, Cursor and VS Code, a first session, the safe editing workflow and the runtime bridge, verified step by step (#50).

### Added

- `docs/USER-GUIDE.md`, a verified user guide; README setup instructions corrected (Claude Code does not read `~/.claude/mcp.json`; the server is a stdio server that waits for a client) (#50).
- `validate_project` check `frame-image`: a warning for Sprite animation frames without their image file in `images/` (the name follows the frame's index and `fileType`, compared ignoring case and Unicode normalization), and info for files named like frames past an animation's last frame that no frame uses. The `backup-file` info also lists `.bak` files directly in `images/`, where the frame tools keep images (#36).
- `add_event_to_sheet` takes the function options `functionReturnType` (`none`, `number`, `string`, `any`), `functionIsAsync` and `functionCopyPicked`, the editor's *Return type*, *Asynchronous* and *Copy picked*, instead of always writing `none`/`false`/`false` (#49).
- `validate_project` returns `complete` and `unscannedFiles`: `complete` is false when a registered object type, family, event sheet or layout file exists but was not checked (over the 10MB read limit, invalid JSON, unreadable), and `unscannedFiles` names those files (#49).

### Changed

- `validate_project` reports a file over the 10MB read limit as an `unscanned-file` warning instead of a wrong "missing or contains invalid JSON" error, and `valid` is `false` whenever `complete` is `false`: nothing in such a file was checked, duplicate UIDs and SIDs included, so the project is not vouched for. A project whose only finding is such a file returns `valid: false` with `summary.errors: 0` (before: `valid: false` with a wrong error) (#49).
- `validate_project` checks the files of registered families too: a registered family whose file is missing, unreadable or not valid JSON is now a `file-existence` error, so `valid` can be `false` for a project that passed before (#49).
- `add_event_to_sheet` refuses a `functionReturnType` other than `none`, `number`, `string` and `any`; before, the option was unknown and any value was dropped without an error (#49).

### Fixed

- `add_frame_to_animation` with `index` renames the image files of the frames from that index on one index up, so every frame keeps its image, instead of writing the placeholder over the image at the index without a backup and leaving the last frame without one. JPEG, GIF and other frames keep their own extension, file names that differ in case or Unicode normalization (e.g. decomposed, as macOS HFS+ lists them) are found, and the names follow the object's name as stored in its file (#36).
- `delete_frame_from_animation` keeps the deleted frame's image as `<file>.bak` and renames the image files of the frames after it one index down, instead of leaving every later frame showing its predecessor's image and the last file behind, where the next appended frame's placeholder overwrote it (#36).
- `add_frame_to_animation` refuses an `index` greater than the frame count before writing anything, instead of appending the frame while writing its image under the index's name (#36).
- `add_frame_to_animation`, also when appending, no longer writes over an image file that no frame uses (e.g. one left behind by a deleted frame): the file is kept as `<file>.bak` and named in `warnings`. If a later step fails, both frame tools remove the placeholder (also one a failed write left part written), restore the object file and rename the image files back; when another write replaced the object file during theirs, they keep its content instead of restoring an older backup over it, and make the image files match it (#36).
- The animation tools run one at a time. Two calls on the same Sprite in parallel could write its object file without each other's changes, and a frame insert or delete could rename image files another call was moving (#36).
- `add_instance_to_layout` and `create_object` no longer allocate a UID that a layout or object type over the 10MB read limit already uses: files the reader skips are scanned as text for their UIDs and SIDs, and when a registered file exists but cannot be read at all, a new UID is refused with the file's name, before anything is written, instead of guessed. A registered name without a file does not block (#49).
- `validate_project` reports a file over the 10MB read limit as an `unscanned-file` warning instead of a "missing or contains invalid JSON" error, names the path a missing file is read from, and gives the reason for other read failures without the absolute project path (#49).
- `get_object_details`, `get_eventsheet_details` and `get_layout_details` no longer suggest other names ("Did you mean") when the file was found but could not be read, e.g. over the 10MB limit (#49).
- The cross-reference index is cached per project (per reader) instead of once per process. With two projects open in one process, the analysis tools (`validate_project`, `find_orphaned_objects`, `get_object_dependencies`, `get_asset_usage`, `get_eventsheet_flow`, `get_function_map`, `analyze_performance`) and the reference checks and warnings of `delete_object`, `delete_family`, `delete_event_sheet`, `delete_layout`, `update_object_properties` and `update_family` used the index of whichever project had built it first: `validate_project` reported the other project's objects as broken references, `delete_object` deleted an object the project still used, and `update_object_properties` removed an instance variable its events still used. A write through the project writer or the event tools now resets only the index of the project it wrote to. The MCP server opens one project per process and was not affected; scripts, tests and embeddings that open several projects in one process were (#38).

## [1.9.0] - 2026-09-27

### Highlights

- **Editor load-time checks.** `validate_project` checks the rules the Construct 3 editor enforces when it opens a project, and event sheet writes that would add such an error are refused before anything is written.
- **Behavior conditions and actions the editor can read.** They are written with the `behaviorType` key instead of `behavior-type`, which made the editor refuse to open the project; `fix_legacy_behavior_keys` repairs sheets written by older versions.
- **Find events by their editor number.** `locate_event` and `get_eventsheet_outline` map an editor location such as "sheet, event N, action M" to the event sheet JSON.
- **Runtime-trap analysis.** `find_runtime_traps`, the `construct3://docs/pitfalls` resource and the `debug_stuck_game` prompt find event logic that loads but hangs or fails silently.
- **Editor-faithful event shapes.** Else and else-if blocks, OR blocks, events without conditions, positional function calls, script lines and the built-in Functions object are written the way the editor saves them; `fix_legacy_event_shapes` converts sheets written by older versions.
- **Safer deletes and case-insensitive names.** Deletes, and removals of behaviors, instance variables and family members, are refused while something still uses what they remove, SID-addressed event tools refuse SIDs shared by several events, and names that differ from an existing one only in case are refused wherever the editor compares names ignoring case.
- **`validate_project` without false reports.** Editor-saved projects no longer come out invalid or with destructive advice; object and asset usage count every real use, nested sub-layers included.
- **Byte-faithful writes.** Files keep their line endings, trailing newline, BOM and file-name case, and every write result carries an `editorNote` about reopening the project in the editor.

### Added

- `validate_project` checks rules the Construct 3 editor enforces when it opens a project: expression syntax, empty parameters, trigger placement, duplicate object/family names, family plugin mismatches and object class SID clashes (#18).
- Event sheet writes (`add_event_block`, `update_event_block`, `add_event_to_sheet`, `update_event_block_action`, `move_events_between_sheets`) are refused when they add a new load-time error; new warnings are returned, existing problems do not block edits (#18).
- `fix_legacy_behavior_keys` tool: renames legacy `"behavior-type"` keys to `"behaviorType"` in all event sheets, checking each value against the object's behaviors first (dry-run by default) (#16).
- `fix_legacy_event_shapes` tool: converts event shapes that older versions wrote (block `isElse`, condition `isOr`, old-shape function calls, one-string scripts) into the editor's own where the result is unambiguous, and flags conversions that can change how an event runs (dry-run by default) (#32).
- `locate_event` tool: maps an editor location such as "sheet, event N, action M" to the event's JSON path, SID, enclosing group/function, summary and neighbouring events (#19).
- `get_eventsheet_outline` tool: paged, readable outline of an event sheet with the editor's event numbers; rows that still use the legacy `"behavior-type"` key are marked (#19).
- `find_runtime_traps` tool: finds event logic that loads but hangs or fails at runtime, such as waits for signals nothing raises, waits that start after their signal was raised, and scripts that use function parameters without `localVars` (#20).
- `construct3://docs/pitfalls` resource with curated Construct 3 pitfalls, and a `debug_stuck_game` prompt that embeds the current trap scan (#20).
- New `validate_project` checks: `legacy-behavior-key` (error when a condition/action names its behavior only under the legacy key, warning for leftover keys; #16), `legacy-event-shape` (shapes the current editor never writes; #32), `else-placement` (an else block that does not follow a non-triggered block, or holds a trigger; #32), `file-name-case-mismatch` (an entity file whose name differs from its registered name only in case, instead of reporting a live file as orphaned; #31), `duplicate-layer-name` (layers of one layout, sub-layers included, whose names are the same ignoring case; #35) and `missing-behavior-entry` (layout instances that lack the entry for a behavior of their object type or its families; #33).
- `add_event_block` and `update_event_block` write else-if blocks, OR blocks (`isOrBlock`), events without conditions, positional function calls, multi-line script actions and comment rows; `update_event_block` can make a block an else or OR block (#32).
- `eventPath` parameter (`eventPaths` for `move_events_between_sheets`) on the SID-addressed event tools: picks one of several events that share a SID; single-event results name the `eventPath` they acted on (#30).
- `delete_family` checks references before deleting (events, object properties, uses of its instance variables and behaviors through members) and takes `force` (#35).
- Every response that reports a completed project write carries an `editorNote`: the Construct 3 editor keeps the open project in memory, so close and reopen it there before saving, or it overwrites the change (#21).
- `validate_project` check `missing-behavior-or-variable`: conditions, actions and expressions that use an instance variable or behavior which the object type, its families or the family do not have (#37).

### Changed

- Event blocks are written in the shapes and key order the editor saves: Else as a System `else` condition at index 0, `isOrBlock` on OR blocks, function calls as `{ callFunction, sid, parameters: [...] }`, scripts as `{ type: "script", language: "javascript", script: [lines] }`, `disabled` after `sid`, `isInverted` after `parameters`. The per-condition `isOr` input is deprecated (#32).
- `update_event_block` and `update_event_block_action` normalize the legacy `"behavior-type"` key on the conditions/actions they edit and report it in `warnings`; `update_event_block` validates all additions before changing anything (#16).
- Create and rename tools compare names the way the Construct 3 editor does: a name that differs from an existing event sheet, layout, object type or family, layer, animation, event variable or project-bar folder only in case is refused; `create_timeline` refuses a case variant of a timeline in the same folder (#29).
- `add_event_to_sheet`, `update_event_variable` and `move_events_between_sheets` check event variable and function parameter names like the editor: no clash within the variable's scope (ignoring case), no System expression names, none of the characters the editor removes (#29).
- `create_object` and `create_family` refuse names that clash, ignoring case, with another object type or family (#18) or with System or the built-in Functions object (#32); `create_family` and `update_family` refuse family members that mix plugins (#18).
- Duplicate-SID reports locate event sheet entries by event path and index, end each event location with its JSON path, and no longer advise re-saving the project; behavior and instance variable SID clashes are warnings (#18, #30).
- `move_events_between_sheets` warns when a copy leaves a SID shared by several events in the target sheet (#30).
- `delete_event_from_sheet` refuses, unless forced, to delete functions or event variables that calls, function maps, System variable conditions/actions or expressions elsewhere still use; a forced dry run lists the references the delete would leave dangling (#32).
- A blocked `delete_object` or `delete_family` lists where the object is used; a forced delete names the uses it leaves behind, and `validate_project` reports dangling instances, object parameters, family members and object properties as `broken-object-reference` (#35).
- Layout tools handle nested sub-layers (`layers[].subLayers`): `add_instance_to_layout`, `update_instance`, `delete_instance_from_layout`, `update_layer` and `delete_layer` find layers and instances at any depth (a sub-layer also by a path such as `"Main > HUD"`), and `add_layer` refuses a name any layer or sub-layer uses (#35).
- Layout instances carry a behavior entry, with the built-in behaviors' default property values, for every behavior of their object type and its families: `add_instance_to_layout` writes them, and `update_object_properties`, `update_family` and `delete_family` add or remove them on existing instances (#33).
- `rename_animation` also renames the frame image files and updates layout instances whose `initial-animation` is the old name, as the editor does; it refuses renames that would replace an existing image file or leave another animation without images, and restores the files when a write fails (#33).
- The animation tools find animations inside animation folders and refuse animation names that cannot be part of an image file name (#33).
- `get_asset_usage` gives each asset a `status` (`used`, `unused` or `not-analysed`), where and how it is referenced (`referencedIn`, `via`) and a `reason` when not used; assets that names built at runtime may reach are reported as not analysed instead of unused (#34).
- `get_function_map` counts `Functions.Name(...)` expression calls and function map registrations as call sites (#32).
- `validate_project` lists leftover `.bak` files in `timelines/` and next to `project.c3proj` too, and its `duplicate-uid` advice gives accurate guidance instead of suggesting a re-save in Construct 3 (#31).
- `list_timelines` returns the editor's transitions separately in `transitions`; the timeline tools refuse to read, change or delete transitions. `create_timeline` rejects unsafe `subfolder` paths and `"transitions"`, and writes new folders in the editor's key order (#22).
- The `review_game_logic` and `explain_eventsheet` prompts point to `find_runtime_traps` and the pitfalls resource (#20).
- Runtime tools that change the open project report `success: true` (#21).
- Documentation: README and `docs/API.md` document every registered tool and the real source tree (#21); `docs/ARCHITECTURE.md` and `docs/DEVELOPMENT.md` are refreshed to match the code: source tree, write flow (backups, atomic writes, project lock), analyzers and the load-time gate.
- Event tool input is checked strictly: unknown keys in conditions, actions, sub-events and `update_event_block` entries are refused instead of silently dropped, and comment and script sub-events are written the way the editor saves them (#32).

### Fixed

- Behavior conditions/actions are written with the `behaviorType` key that Construct 3 reads, instead of `behavior-type`, which made the editor refuse to open the project. `"behavior-type"` is still accepted as a deprecated input alias (#16).
- Writes keep each file's line endings, trailing newline and BOM instead of rewriting CRLF files with LF (whole-file diffs on Windows checkouts); new files follow the style of `project.c3proj` (#21).
- Rewriting an existing file keeps its name on disk, including its case, instead of renaming it to the registered spelling (#29).
- Create tools no longer overwrite an existing entity or timeline file whose name differs only in case (Windows, macOS); they refuse to write where a file already exists (#29).
- Timeline tools find timelines in any `project.c3proj` subfolder, and `update_timeline` writes back to the same file. `delete_timeline` backs up exactly the file it deletes and leaves `project.c3proj` unchanged when that file is missing (#22).
- `delete_event_from_sheet`, `update_event_block`, `update_event_block_action`, `update_event_variable` and `move_events_between_sheets` refuse a SID shared by several events in the sheet, dry runs included, and list the candidates, instead of acting on the first match (#30).
- `validate_project` accepts the editor's Transitions folder in `timelines` instead of reporting a `subfolder-structure` error, so editor-saved projects are no longer `valid: false`; only a nameless folder elsewhere is reported as malformed (#31).
- `validate_project` skips the editor's `*.uistate.json` files and checks entity files against the path each registered entity is read from (#31).
- `find_orphaned_objects`, `get_object_dependencies` and `validate_project` count non-world instances, object parameters, expressions and script actions as object uses, so such objects are no longer reported as unused (#31).
- `delete_object` without `force` no longer deletes object types that are still used as non-world instances, in object parameters, expressions or scripts, on sub-layers, or through object properties of other instances (#35).
- New instance UIDs are allocated above every UID in the project, sub-layer instances included, and the duplicate UID/SID checks and the dependency and orphan analysis look into sub-layers (#35).
- The built-in `Functions` object class (e.g. *Set return value*) is accepted by the event tools and no longer reported as a broken object reference by `validate_project` (#32).
- `groupPath` finds groups whose titles have leading or trailing whitespace (#32).
- `update_event_block` no longer warns that all conditions were removed on blocks that never had conditions, such as function blocks (#32).
- `get_asset_usage` reads sprite animations as the editor saves them (`animations.items` and animation subfolders), lists single-image object types as images, and counts an image as used by the same rule as `find_orphaned_objects` (#34).
- `get_asset_usage` matches sounds, music, fonts, videos and project files to their real uses (Audio file parameters, strings in events, scripts, flowcharts, timelines, properties, CSS font declarations) instead of reporting every file asset as unused (#34).
- `analyze_performance` counts the frames of editor-saved animations, animation subfolders included (#34).
- Placeholder image files are named all lowercase, as the editor names them (`images/<object>-<animation>-000.png`), instead of keeping the case of the animation name (#33).
- `replace_sprite_image` on a frame stored in another format (e.g. JPEG) sets the frame's `fileType` to PNG to match the new `.png` file and names the old file in a warning (#33).
- `update_object_properties` and `update_family` no longer remove an instance variable, behavior or family member that conditions, actions or expressions still use: they refuse, list the uses, and go ahead only with `force` (#37).

## [1.8.1] - 2026-04-16

### VAL-02 Remediation — Honest Acceptance Contract

Post-release: VAL-02's original "builds a minimal playable project" claim was structurally verified but never proven against the Construct 3 editor itself. When attempted, C3 rejected the output with "Failed to open project" — the hand-built fixture was never a valid C3 project. Fixed:

#### Added

- **`scripts/derive-minimal-fixture.ts`** — Reproducer that prunes a known-good C3 project into a minimal, shippable fixture. Two-stage prune (drop third-party addons → aggressive minimize to one empty layout + one empty event sheet). Iterated via live Construct 3 editor feedback.
- **`test/fixtures/c3-loadable-minimal/`** — 11 files, ~18 KB packed. IP-free. **Validated 2026-04-16** by loading into Construct 3 editor via editor automation — opens cleanly, no "Failed to open project" dialog.
- **Third VAL-02 test** — Packs the C3-loadable fixture and verifies structural invariants. Protects the committed fixture from drift.

#### Changed

- **`test/acceptance/m1-end-to-end.test.ts`** — Renamed suite + test to "M1 Structural Round-Trip Acceptance" / "builds a structurally consistent project." Docstring now explicitly warns against self-referential validation: reader/writer sharing blind spots can pass a structural test while the output is rejected by C3.

#### Learnings (preserved for future fixture work)

- C3 halts load on any reference from manifest to missing file (`rootFileFolders.general` entries pointing at deleted files surface as "missing file path 'X'").
- Event-sheet `objectClass` references to dropped object types halt load with "cannot find object 'X'". Empty-out `events[]` in every sheet clears this class of refs in one pass.
- Pruning subdirectories under `objectTypes/` must be recursive — top-level readdir misses grouped plugins (e.g. `objectTypes/Array/*.json`).

#### Tests

- 418 passing (up from 417), no skips

## [1.8.0] - 2026-04-16

### M1 Release — Community Governance & End-to-End Validation

Milestone 1 closure: full primitive surface, community-ready codebase, end-to-end acceptance test.

#### GOV-01 — Internal reference scrub

- Removed all references to internal tooling, company names and internal platforms from `src/` and `test/`
- `src/runtime/bridge.ts` — doc comment rewritten to generic automation language (Playwright, curl, CDP)
- `src/tools/runtime-tools.ts` — all five internal tool references replaced with generic equivalents; a company-specific plugin example replaced with `MyPlugin`
- `src/index.ts` — Phase 4 comment updated to remove an internal tool reference

#### GOV-02 — Public docs scrub

- `README.md` — removed a cross-link to an internal project and a genre-specific reference; updated Authors section; reworded internal tool references to Playwright/CDP; updated roadmap and Known Limitations
- `docs/EXAMPLES.md` — replaced a company-name author example with a generic one
- `package.json` — `author` field changed from a company name to `construct3-mcp contributors`

#### GOV-03 — Version bump

- `package.json` version: `1.6.0` → `1.8.0` (minor bump; new tools are additive, no breaking changes)
- `src/index.ts` MCP server version: `1.5.0` → `1.8.0`
- Version rationale: Phases 6–7 added runtime tools, pack_project, and acceptance test infrastructure — all additive; backward compatible with existing tool callers

#### VAL-01 — Test suite

- 415 tests across 15 test files — all passing (no regressions from Phases 1–6)

#### VAL-02 — End-to-end acceptance test

- New: `test/acceptance/m1-end-to-end.test.ts`
- Exercises the full primitive tool chain using real MCP tool handler functions (no direct JSON manipulation):
  1. `create_object` (Sprite with animation)
  2. `create_event_sheet`
  3. `create_layout` (with layer)
  4. `add_instance_to_layout`
  5. `add_event_block` (condition + action)
  6. `pack_project` → `.c3p` ZIP archive
- Asserts: `.c3p` exists on disk, ZIP unpacks without error, event sheet referenced by layout exists, object referenced in layout exists, structure is internally consistent

#### VAL-03 — Coverage gate

- Audited all tools added in Phases 4–7 against existing test coverage
- All tools have at least one passing test; no gaps found requiring new additions beyond VAL-02

#### Infrastructure

- `pack_project` tool description updated (removed an internal upload tool reference)
- `generate_bridge_eval_script` description updated (generic CDP language)

## [1.6.0] - 2026-03-02

### Sprite Image Pipeline

Automatic placeholder PNG generation for Sprites and TiledBg objects, with `imageSpriteId` linking between object JSON and image files.

#### Added

- **PNG Generator** (`png-generator.ts`) — Zero-dependency transparent PNG generation using zlib; follows C3 image naming conventions (`objectname-animation-000.png` for Sprites, `objectname.png` for TiledBg)
- **`writeImageFile`** — Write a single placeholder PNG to the `images/` directory with auto-created directories
- **`writeImageFiles`** — Batch write multiple PNGs with rollback on failure (cleans up already-written files)
- **`generateImageSpriteId`** — 7-digit collision-checked ID generator for linking animation frames to image files
- **`imageSpriteId` support** — `createSpriteObject`, `createTiledBgObject`, and `createAnimationFrame` templates now accept optional `imageSpriteId`
- **Image pipeline integration tests** — 7 tests covering PNG creation, valid signatures, batch writes, Sprite/TiledBg round-trips, and ID uniqueness

#### Fixed

- **Behavior addition breaks project** — When `update_object_properties` adds a behavior or variable to an object type, existing layout instances of that object now get `behaviors` and `instanceVariables` dicts auto-synced so C3 can resolve them on project load. Without these fields, C3 could fail to open the project.
- **Fixture layout instance** updated to include `behaviors`, `instanceVariables`, and `tags` fields matching real C3 projects

#### Infrastructure

- 278 tests (up from 262), 12 test files
- `IdGenerator` now tracks `existingImageSpriteIds` from animation frames across the project
- 6 behavior workflow integration tests (add behavior, addon registration, multiple behaviors, field preservation, layout instance sync, full round-trip)
- 3 behavior unit tests (layout sync when instances exist, skip when none, preserve existing overrides)

## [1.5.0] - 2026-02-21

### Event Sheet & Layout Lifecycle

3 new mutation tools for deleting event sheets/layouts and updating layout properties (total: 14 mutation tools).

#### Added

- **`delete_event_sheet`** — Delete event sheets with reference checking (included-by sheets, bound layouts); supports `force` flag to override
- **`delete_layout`** — Delete layouts with reference checking (bound event sheets, placed objects); blocks deletion of the startup layout unconditionally; supports `force` flag
- **`update_layout`** — Update layout properties: event sheet binding (validated), width, and height

#### Enhanced

- **`add_event_block`** — Now supports sub-events (`children`), else blocks (`isElse`), OR conditions (`isOr`), and per-action disabling (`disabled` on actions). Recursive child building with safety limits (max depth 5, max 50 total events). Object class validation covers the entire event tree.

#### Closes

- Issue #2: `delete_event_sheet`
- Issue #3: `delete_layout`
- Issue #4: `update_layout`
- Issue #7: `add_event_block` sub-events, else, OR, per-action disabled

## [1.4.0] - 2026-02-19

### Phase 4: Event Blocks & Animation

3 new mutation tools for gameplay logic and animation management (total: 11 mutation tools).

#### Added

- **`add_event_block`** — Add block events with conditions + actions to event sheets, with group path targeting, script action support, inverted conditions, and object class validation
- **`add_animation_to_sprite`** — Add named animations with configurable frame count, speed, looping, ping-pong to Sprite objects
- **`update_animation_properties`** — Modify speed, looping, ping-pong, repeat count on existing Sprite animations

#### Infrastructure

- **`createBlockEvent`** template — Generates valid block event JSON with conditions, actions, children array
- **`createAnimation` / `createAnimationFrame`** templates — Animation and frame JSON builders
- **`findGroupByPath()`** helper — Two-pass group traversal (verify-then-mutate) for safe nested event insertion
- **`validateObjectClasses()`** helper — Validates objectClass references against project objects, families, and System

#### Fixes (pre-push audit)

- `findGroupByPath` no longer mutates event data on failed path resolution
- All Phase 4 tools now return `backupFile` in results (consistency with Phase 3)
- Animation name validated as non-empty (`.min(1)`)
- Animation speed validated as non-negative (`.min(0)`)
- `createBlockEvent` includes `children: []` for sub-event consistency
- Fixed stale documentation: tool counts (8→11), roadmap references, manual test checklist

## [1.3.0] - 2026-02-16

### Phase 3: Safe Modifications

8 new mutation tools that safely create, update, and delete project entities.

#### Added

- **`create_object`** — Create Sprite, Text, TiledBg, NinePatch, and global plugin objects with proper SID/UID generation
- **`update_object_properties`** — Add/remove instance variables and behaviors on existing objects
- **`delete_object`** — Delete objects with reference checking (event sheets, layouts, families); supports `force` flag
- **`create_event_sheet`** — Create event sheets with optional auto-includes
- **`add_event_to_sheet`** — Add groups, functions, variables, includes, and comments to event sheets
- **`create_layout`** — Create layouts with configurable dimensions and layers
- **`add_instance_to_layout`** — Place object instances on layout layers with plugin-specific default properties
- **`update_project_metadata`** — Update project name, version, author, description

#### Safety infrastructure

- **ID Generator** (`id-generator.ts`) — Scans all existing SIDs/UIDs across the project, generates collision-free new ones (15-digit random SIDs, sequential UIDs)
- **Project Writer** (`project-writer.ts`) — Backup-before-write, JSON pre-validation (round-trip test, 5MB limit), post-write file verification, path traversal protection
- **Templates** (`templates.ts`) — Validated templates for all entity types with correct field names (`isGlobal` not `is-global`), `editorNewInstanceIsReplica`, plugin-specific instance properties
- **Addon validation** — Plugins and behaviors checked against `usedAddons`; known Scirra addons auto-registered, unknown addons blocked
- **Reserved name protection** — Blocks creation of objects named "System"
- **Global plugin protection** — Prevents placing singleglobal-inst objects on layouts
- **Cache invalidation** — Reader caches, project index, and ID generator all reset after writes

## [1.2.0] - 2026-02-15

### Phase 2: Enhanced Analysis

6 new analysis tools with cross-reference indexing.

#### Added

- **`get_eventsheet_flow`** — Event sheet include hierarchy and layout bindings, with Mermaid diagram output
- **`get_function_map`** — Function definitions and call sites across all event sheets
- **`get_object_dependencies`** — Object usage across event sheets, layouts, families, and co-occurring objects
- **`find_orphaned_objects`** — Detect objects not referenced in any event sheet or placed in any layout
- **`get_asset_usage`** — Track sound, music, image, font, and video asset usage
- **`analyze_performance`** — Heuristic performance audit with info/warning/critical categorized issues
- **Cross-reference index** (`index-builder.ts`) — Cached project-wide index for fast dependency lookups

#### Infrastructure

- Modular analyzer architecture (`src/construct3/analyzers/`)
- Configurable detail levels (summary/normal/full) across analysis tools

## [1.0.0] - 2026-02-14


### Phase 1: Foundation

Initial release with read-only project access.

#### Added

- **7 Resources**: Project info, structure, addons, object/eventsheet/layout details, C3 documentation
- **9 Query Tools**: List/search objects, event sheets, layouts, families; get details; project summary
- **6 Prompts**: Analyze project, find object usage, explain event sheet, review game logic, document object, optimize project
- Project file parser with caching
- Fuzzy name matching with suggestions
- Official Construct 3 documentation access via resources
