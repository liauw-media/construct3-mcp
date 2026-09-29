# Troubleshooting

Common issues and solutions for the Construct3 MCP Server.

## Server Won't Start

### "No .c3proj file found in directory"

**Cause**: The path you provided doesn't contain a `.c3proj` file directly. Only that folder is searched, not its subfolders or parent folders. The same message appears when:
- the path does not exist (a typo),
- the path is a `.c3p` file (single-file projects cannot be opened),
- the path is a subfolder of the project (e.g. `layouts/`) or a parent folder (e.g. a repository root with the game in `game/`),
- no path was given and the server was started in a folder without a `.c3proj`. Without an argument and without `C3_PROJECT_PATH` the server uses its working directory; Claude Code starts it in the folder where you started `claude`.

The server exits with code 1, so the client only reports that the connection closed. Run the command from your MCP config in a terminal to see this message.

**Solutions**:
- Pass the path directly to the `.c3proj` file: `node dist/index.js /path/to/project.c3proj`
- Or pass the directory that contains it: `node dist/index.js /path/to/project-folder/`
- Make sure the project is saved in **folder format**, not as a `.c3p` ZIP file

### "Invalid Construct3 project file"

**Cause**: The path ends in `.c3proj` but the file does not exist, isn't valid JSON, or lacks the top-level fields `projectFormatVersion` and `name`.

**Solutions**:
- Check the path (a missing `.c3proj` file gives this message, not "No .c3proj file found")
- Open the project in Construct 3 editor and re-save it
- Check the file isn't corrupted (open it in a text editor — it should be valid JSON with `projectFormatVersion` and `name`)

A file that passes this check but lacks other parts of a project (e.g. `objectTypes`) fails with `Failed to load Construct3 project: Cannot read properties of undefined (reading 'items')` instead.

### Started without a project path

There is no usage message. Without an argument and without `C3_PROJECT_PATH`, the server looks for a `.c3proj` in its working directory. If there is none, it prints `Failed to start server: No .c3proj file found in directory: <working directory>` and exits with code 1.

**Solutions**:
- Pass the path as the first argument: `node dist/index.js /path/to/project`
- Or set the environment variable: `C3_PROJECT_PATH=/path/to/project node dist/index.js`

## Connection Issues

### Server starts but Claude doesn't see the tools

**Solutions**:
- Verify your MCP config JSON is valid (check for trailing commas, etc.). On Windows use forward slashes or doubled backslashes in JSON paths
- Make sure the path to `dist/index.js` is absolute
- Restart Claude Code / Claude Desktop after changing MCP config (quit Claude Desktop completely; closing the window is not enough)
- Check stderr output for error messages: `node dist/index.js /path/to/project 2>debug.log`
- Claude Code: run `claude mcp list`. `✘ Failed to connect` means the server exited (run its command in a terminal to see why). `⏸ Pending approval` means a `.mcp.json` server that you still have to approve by starting `claude` in that folder. Claude Code does not read `~/.claude/mcp.json`; add servers with `claude mcp add` or a `.mcp.json` in the project folder. See the [User Guide](USER-GUIDE.md#claude-code)
- VS Code: `.vscode/mcp.json` uses the top-level key `"servers"`, not `"mcpServers"`

### "Server disconnected" errors

**Cause**: The server process crashed.

**Solutions**:
- Check if the project files are accessible (not locked by another process)
- Run the server manually to see the error: `node dist/index.js /path/to/project`
- Ensure Node.js >= 18.0.0: `node --version`

## Query Tool Issues

### "Object type X not found"

**Cause**: The name doesn't match. On Windows, read tools such as `get_object_details` also accept a name that differs only in letter case, because the file is found case-insensitively there; `update_object_properties` and `update_family` do not (see [below](#-not-found-names-are-matched-with-their-letter-case)).

**Solutions**:
- Use `list_objects` to see all available names
- Use `search_objects` with a partial name
- The error message includes "Did you mean: ..." suggestions when a close match exists

### "Event sheet X not found" / "Layout X not found"

Same as above — use the corresponding `list_` tool to find the correct name.

### "File too large (... exceeds 10MB limit)"

**Cause**: The server reads object type, event sheet, layout and family files up to 10MB. `get_object_details`, `get_eventsheet_details` and `get_layout_details` refuse a larger file (without a "Did you mean" hint, since the name was right), and the cross-reference index leaves it out. The reference checks of the delete and update tools, `find_orphaned_objects` and `get_object_dependencies` search it as text instead (see "Possible uses in files that could not be parsed" below). `validate_project` reports it as an `unscanned-file` warning and returns `complete: false`: duplicate UIDs and SIDs, references and load-time errors inside that file are not reported, and `valid` is `false`, also when `summary.errors` is 0.

New UIDs are still allocated above the UIDs in the file, so `add_instance_to_layout` and `create_object` keep working: the file is scanned as text for its UIDs and SIDs. That scan reads the whole file, again for the first new UID or SID after each write, so it costs time and memory in proportion to the file's size (for a 150MB layout, one to two seconds per call). A file too large to read into memory as text (about 512MB) cannot be scanned, and new UIDs are refused (see "Cannot generate a safe UID" below).

Known gap: tools that edit the large file itself, such as `add_instance_to_layout` on that layout, report it as not found and suggest its own name.

**Solutions**:
- Check that file in the Construct 3 editor, or split a very large layout

### Stale data after editing in C3 editor

**Cause**: The reader loads `project.c3proj` at startup and keeps it, so the lists of objects, event sheets and layouts (e.g. `list_objects`) stay as they were. Single entity files (an event sheet, an object type) are read from disk again, so the data can be a mix of old and new. The server reloads `project.c3proj` itself only after its own writes.

**Solution**: Restart or reconnect the MCP server to pick up changes made in the C3 editor (Claude Code: `/mcp` > `construct3` > **Reconnect**). External changes aren't detected automatically.

## Mutation Tool Issues

### "Object X already exists"

**Cause**: Trying to create an object with a name that's already taken.

**Solution**: Use `update_object_properties` to modify the existing object, or choose a different name.

### "Plugin X is not registered in usedAddons"

**Cause**: The plugin is a third-party addon not in the project's `usedAddons` list. The server can only auto-register known Scirra built-in addons.

**Solution**: Open the project in the Construct 3 editor, add an object using that plugin (which registers it), save, then restart the MCP server.

### "Behavior X is not registered in usedAddons"

Same as above but for behaviors. Add a behavior of that type to any object in the C3 editor first.

### "Object X is a global plugin and cannot be placed on layouts"

**Cause**: Trying to use `add_instance_to_layout` with a global-only plugin like Audio, AJAX, Mouse, etc.

**Solution**: Global plugins use `singleglobal-inst` and don't have layout instances. They're created once and accessible everywhere. Use `create_object` to add them to the project instead.

### "System is a reserved name"

**Cause**: "System" is used by the C3 engine and can't be used as an object name.

**Solution**: Choose a different name.

### "Path traversal detected"

**Cause**: The name or subfolder contains `..`, `/`, or `\` that would escape the project directory.

**Solution**: Use simple names with letters, numbers, underscores, and spaces only.

### "Object is still referenced"

**Cause**: `delete_object` found references in event sheets, layouts (instances on any layer or sub-layer, non-world instances, object properties of other instances), or families.

**Solutions**:
- Remove all references first, then delete
- Use `force: true` to delete anyway (references will NOT be cleaned up — you'll need to fix them manually; `validate_project` then reports the leftover instances, object parameters, family memberships and Particles object properties as `broken-object-reference`; uses in expressions and scripts are not reported, so fix the ones the force warning lists)
- The error response lists all locations where the object is referenced

### "Family is still referenced"

**Cause**: `delete_family` found events or object properties that name the family, or conditions, actions and expressions that use its instance variables or behaviors through a member object type (`references.memberUses`), or conditions and actions on a member that name one of its effects (`references.effectUses`).

**Solutions**:
- Remove those uses first, then delete
- Use `force: true` to delete anyway (references will NOT be cleaned up; `validate_project` reports the uses through members as `missing-behavior-or-variable`, but not the uses in expressions and scripts and not `Member.name` in expressions, so fix the ones the force warning lists)

### "Events still use what this update removes"

**Cause**: `update_object_properties` (`removeVariables`, `removeBehaviors`) or `update_family` (`removeVariables`, `removeMembers`) would take away an instance variable or behavior that conditions, actions or expressions still use (`references.uses`, each with its event path, the JSON path of its event as `eventPath` and the condition's or action's `sid`). Nothing was changed.

**Solutions**:
- Change or delete those conditions, actions and expressions first, then remove it
- Use `force: true` to remove it anyway (the uses are NOT changed; `validate_project` then reports them as `missing-behavior-or-variable`, except `Object.name` and `Self.name` in expressions, which the force warning lists)

### "Possible uses in files that could not be parsed"

**Cause**: A delete or removal (`delete_object`, `delete_family`, `delete_layout`, `delete_event_sheet`, `delete_event_from_sheet`, `update_object_properties`, `update_family`, `rename_animation`) refused with `delete_blocked` or `update_blocked` because a registered layout, event sheet or family file it could not parse (over the 10MB read limit, not valid JSON) names what the tool checks for. The cross-reference index cannot see inside such a file, so the tool searched its text for the names instead (whole words, ignoring case; `delete_layout` looks for instances and an event sheet binding in the layout's own file). A match is a *possible* use: the name may just as well be in another string there. `unscannedFiles` lists each file with its reason and `textSearch`: `possible-use` (with the `names` found), `unreadable` (the file exists but cannot be read even as text, e.g. a folder in its place or no read access; this refuses too) or `no-match` (only a warning). A registered name without a file is not listed and does not block.

**Solutions**:
- Open the project in the Construct 3 editor and check the named file for the use; remove it there if it is real
- Fix a file with invalid JSON (`validate_project` names it as a `file-existence` error), or split a very large layout, so the server can read it
- Use `force: true` if the match is a false alarm; the warning names the files again, and nothing in them is changed
- `find_orphaned_objects` and `get_object_dependencies` report such objects as possibly used (`possiblyUsed`, `possiblyUsedObjects`, `possiblyReferencedIn`) instead of unused, for the same reason
- *Its own file could not be parsed* (`"textSearch": "not-searched"`): `delete_object` or `delete_family` refuses because the object type's or family's own file is over the limit or not valid JSON, so its SID is unknown. Fix the file, or delete with `force: true`
- A file saved as UTF-16 without a byte order mark, or in UTF-16BE, cannot be searched and refuses as `unreadable`; save it as UTF-8 (the editor does)

### "Cannot generate a safe UID: project file(s) could not be scanned"

**Cause**: `add_instance_to_layout` or `create_object` (for a global plugin) needs a new UID, which must be above every UID in the project. A layout or object type named in the error is registered in `project.c3proj` and exists, but could not be read at all, not even as text (e.g. a folder where the file should be, no read access, or a file too large to read into memory as text, about 512MB), so its UIDs are unknown. Nothing was written. Files over the 10MB read limit (up to that size) and files with invalid JSON do not cause this: they are scanned as text. A registered name whose file does not exist does not cause it either.

**Solutions**:
- Fix the file named in the error (`validate_project` lists it in `unscannedFiles` and gives the reason), or remove its name from `project.c3proj` if it is not needed
- Then restart the MCP server, so the project is scanned again (a completed write through the tools also starts a new scan)

### "... not found: names are matched with their letter case"

**Cause**: `update_object_properties` or `update_family` was given a name that differs from the registered object type or family name only in letter case. On Windows and macOS such a name would open the file too, but the checks and the layout updates know the entity by its registered name only, so the call is refused.

**Solution**: Use the registered name the error suggests (`list_objects`, `list_families`).

### Sprite frames show the wrong image, or `validate_project` reports `frame-image`

**Cause**: The editor loads a frame's image from `images/<object>-<animation>-NNN.<ext>`, NNN being the frame's index. In construct3-mcp 1.9.0 and earlier, `add_frame_to_animation` with an `index` wrote its placeholder over the image at that index (without a backup) and did not move the later images, and `delete_frame_from_animation` did not move them either: the frames after the change show their neighbour's image, the last frame after an insert has no image file (`frame-image` warning), and the last file after a delete is left over (`frame-image` info), where a later append wrote its placeholder over it.

**Solution**: Later versions move the image files with their frames and keep replaced or deleted images as `<file>.bak`. For frames changed by an older version, restore the images from version control or a copy of the project, or rename the files in `images/` by hand so that each frame's file carries its index (all lowercase, `.jpg` for a JPEG frame), then run `validate_project` again. An image the old insert wrote over cannot be recovered from the project folder.

### Backup files (.bak)

Writes through the project writer copy each file to `<file>.bak` next to it before changing or deleting it. There is only one `.bak` per file and every write to the same file overwrites it, so it holds the state before the **last** write to that file, not the state before your session (one request can write the same file twice, e.g. `create_object` with a new built-in addon writes `project.c3proj` twice). `register_addon`, `unregister_addon`, the runtime-bridge tools (`inject_runtime_bridge`, `remove_runtime_bridge`, and `export_for_preview` / `pack_project` when they inject the bridge) and PNG image writes make no `.bak` (see [Safety Model](../README.md#safety-model)). Nothing deletes `.bak` files; `validate_project` lists them as `backup-file` info entries.

For undo across several steps, keep the project under git and commit before each session (see the [User Guide](USER-GUIDE.md#the-safe-editing-workflow)). To undo only the last change to one file:

1. Find the `.bak` file next to the affected file
2. Delete or rename the corrupted file
3. Rename the `.bak` file to remove the `.bak` extension
4. Restart the MCP server

In `images/`, `add_frame_to_animation` and `delete_frame_from_animation` keep a deleted frame's image and any file they would otherwise replace as `<file>.bak` (`<file>.1.bak`, … when that name is taken), and `delete_object` keeps the image files of the object it deletes the same way; their `warnings` name these files, and `validate_project` lists them as `backup-file` info. Image files that older versions of `delete_object` left in place are listed as `orphaned-image` info.

## Build Issues

### TypeScript compilation errors

```bash
npm run build
```

If you get type errors after modifying the code:
- Ensure you're using TypeScript 5.7+: `npx tsc --version`
- Run `npm install` to ensure dependencies are up to date
- Check that all imports use `.js` extensions (required for ESM)

### "Cannot find module" at runtime

**Cause**: Missing `.js` extension in import or file not compiled.

**Solutions**:
- All imports must end in `.js` (TypeScript ESM convention)
- Run `npm run build` to compile
- Check `dist/` folder has the compiled files

## Performance Issues

### Slow first query after startup

**Cause**: The ID generator scans all project files on first use to collect existing SIDs/UIDs.

**Solution**: This is expected and only happens once per session. Subsequent queries are fast.

### Slow analysis tools

**Cause**: Analysis tools like `get_eventsheet_flow` and `get_object_dependencies` need to read all project files to build the cross-reference index.

**Solution**: The index is cached after first build. Subsequent analysis queries are fast. After a write operation, the cache is cleared and will be rebuilt on next analysis query.

Files over the 10MB read limit or with invalid JSON are not in the index; the reference checks, `find_orphaned_objects` and `get_object_dependencies` search them as text on every call instead, only while there are such files. The search streams the file. Measured on a 50MB layout (Node 22, Windows 11): about 0.1 seconds with one name or with 200, while the names are rare in the text; about 0.2 to 0.3 seconds when a searched name is common inside other names (e.g. `Bullet` in 400,000 `EnemyBullet` instances); about 2 seconds in a constructed worst case of 200 very short names that occur everywhere (`e`, `i`, ...). `find_orphaned_objects` and `get_object_dependencies` with 200 unused objects on such a layout take about 0.1 seconds.

## Getting Help

- **GitHub Issues**: [Report a bug](https://github.com/liauw-media/construct3-mcp/issues)
- **GitHub Discussions**: [Ask a question](https://github.com/liauw-media/construct3-mcp/discussions)

---

**Last Updated**: 2026-09-29
