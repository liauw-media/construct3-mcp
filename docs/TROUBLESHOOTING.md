# Troubleshooting

Common issues and solutions for the Construct3 MCP Server.

## Server Won't Start

### "No .c3proj file found in directory"

**Cause**: The path you provided doesn't contain a `.c3proj` file.

**Solutions**:
- Pass the path directly to the `.c3proj` file: `node dist/index.js /path/to/project.c3proj`
- Or pass the directory that contains it: `node dist/index.js /path/to/project-folder/`
- Make sure the project is saved in **folder format**, not as a `.c3p` ZIP file

### "Invalid Construct3 project file"

**Cause**: The `.c3proj` file exists but isn't valid JSON or is missing required fields.

**Solutions**:
- Open the project in Construct 3 editor and re-save it
- Check the file isn't corrupted (open it in a text editor — it should be valid JSON)
- Ensure it has required top-level fields: `name`, `objectTypes`, `eventSheets`, `layouts`

### "Usage: construct3-mcp <project-path>"

**Cause**: No project path was provided.

**Solutions**:
- Pass the path as the first argument: `node dist/index.js /path/to/project`
- Or set the environment variable: `C3_PROJECT_PATH=/path/to/project node dist/index.js`

## Connection Issues

### Server starts but Claude doesn't see the tools

**Solutions**:
- Verify your MCP config JSON is valid (check for trailing commas, etc.)
- Make sure the path to `dist/index.js` is absolute
- Restart Claude Code / Claude Desktop after changing MCP config
- Check stderr output for error messages: `node dist/index.js /path/to/project 2>debug.log`

### "Server disconnected" errors

**Cause**: The server process crashed.

**Solutions**:
- Check if the project files are accessible (not locked by another process)
- Run the server manually to see the error: `node dist/index.js /path/to/project`
- Ensure Node.js >= 18.0.0: `node --version`

## Query Tool Issues

### "Object type X not found"

**Cause**: The name doesn't match exactly (case-sensitive).

**Solutions**:
- Use `list_objects` to see all available names
- Use `search_objects` with a partial name
- The error message includes "Did you mean: ..." suggestions when a close match exists

### "Event sheet X not found" / "Layout X not found"

Same as above — use the corresponding `list_` tool to find the correct name.

### "File too large (... exceeds 10MB limit)"

**Cause**: The server reads object type, event sheet, layout and family files up to 10MB. `get_object_details`, `get_eventsheet_details` and `get_layout_details` refuse a larger file (without a "Did you mean" hint, since the name was right), and the analysis tools leave it out. `validate_project` reports it as an `unscanned-file` warning and returns `complete: false`: duplicate UIDs and SIDs, references and load-time errors inside that file are not reported, even when `valid` is true.

New UIDs are still allocated above the UIDs in the file, so `add_instance_to_layout` and `create_object` keep working: the file is scanned as text for its UIDs and SIDs. That scan reads the whole file, again for the first new UID or SID after each write, so it costs time and memory in proportion to the file's size (for a 150MB layout, one to two seconds per call). A file too large to read into memory as text (about 512MB) cannot be scanned, and new UIDs are refused (see "Cannot generate a safe UID" below).

Known gap: tools that edit the large file itself, such as `add_instance_to_layout` on that layout, report it as not found and suggest its own name.

**Solutions**:
- Check that file in the Construct 3 editor, or split a very large layout

### Stale data after editing in C3 editor

**Cause**: The reader caches project data at startup.

**Solution**: Restart the MCP server to pick up changes made in the C3 editor. The server caches data for performance — external changes aren't detected automatically.

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

**Cause**: `delete_family` found events or object properties that name the family, or conditions, actions and expressions that use its instance variables or behaviors through a member object type (`references.memberUses`).

**Solutions**:
- Remove those uses first, then delete
- Use `force: true` to delete anyway (references will NOT be cleaned up; `validate_project` reports the uses through members as `missing-behavior-or-variable`, but not the uses in expressions and scripts and not `Member.name` in expressions, so fix the ones the force warning lists)

### "Events still use what this update removes"

**Cause**: `update_object_properties` (`removeVariables`, `removeBehaviors`) or `update_family` (`removeVariables`, `removeMembers`) would take away an instance variable or behavior that conditions, actions or expressions still use (`references.uses`, each with its event path, the JSON path of its event as `eventPath` and the condition's or action's `sid`). Nothing was changed.

**Solutions**:
- Change or delete those conditions, actions and expressions first, then remove it
- Use `force: true` to remove it anyway (the uses are NOT changed; `validate_project` then reports them as `missing-behavior-or-variable`, except `Object.name` and `Self.name` in expressions, which the force warning lists)

### "Cannot generate a safe UID: project file(s) could not be scanned"

**Cause**: `add_instance_to_layout` or `create_object` (for a global plugin) needs a new UID, which must be above every UID in the project. A layout or object type named in the error is registered in `project.c3proj` and exists, but could not be read at all, not even as text (e.g. a folder where the file should be, no read access, or a file too large to read into memory as text, about 512MB), so its UIDs are unknown. Nothing was written. Files over the 10MB read limit (up to that size) and files with invalid JSON do not cause this: they are scanned as text. A registered name whose file does not exist does not cause it either.

**Solutions**:
- Fix the file named in the error (`validate_project` lists it in `unscannedFiles` and gives the reason), or remove its name from `project.c3proj` if it is not needed
- Then restart the MCP server, so the project is scanned again (a completed write through the tools also starts a new scan)

### "... not found: names are matched with their letter case"

**Cause**: `update_object_properties` or `update_family` was given a name that differs from the registered object type or family name only in letter case. On Windows and macOS such a name would open the file too, but the checks and the layout updates know the entity by its registered name only, so the call is refused.

**Solution**: Use the registered name the error suggests (`list_objects`, `list_families`).

### Backup files (.bak)

Every mutation creates `.bak` backup files next to the modified files. If something goes wrong:

1. Find the `.bak` file next to the affected file
2. Delete or rename the corrupted file
3. Rename the `.bak` file to remove the `.bak` extension
4. Restart the MCP server

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

## Getting Help

- **GitHub Issues**: [Report a bug](https://github.com/liauw-media/construct3-mcp/issues)
- **GitHub Discussions**: [Ask a question](https://github.com/liauw-media/construct3-mcp/discussions)

---

**Last Updated**: 2026-02-16
