# User Guide

How to install construct3-mcp, connect it to your AI tool and use it on a Construct 3 project without losing work.

This guide is for Construct 3 developers who want to use the server with Claude Code, Claude Desktop, Cursor or VS Code. You do not need to know how MCP works. It was written for version 1.9.2. Unless a section says otherwise, the commands and outputs below come from real runs on Windows 11 with Node.js 22 and Claude Code 2.1.284. Sections that only repeat another vendor's documentation say so.

## Contents

- [What it does and what it doesn't](#what-it-does-and-what-it-doesnt)
- [Requirements](#requirements)
- [Install](#install)
- [Tell the server which project to open](#tell-the-server-which-project-to-open)
- [Connect your AI tool](#connect-your-ai-tool)
  - [Claude Code](#claude-code)
  - [Claude Desktop](#claude-desktop)
  - [Cursor](#cursor)
  - [VS Code](#vs-code)
  - [Other clients](#other-clients)
  - [Check that it works](#check-that-it-works)
- [First session](#first-session)
- [The safe editing workflow](#the-safe-editing-workflow)
- [Read tools and write tools](#read-tools-and-write-tools)
- [Testing a running game with the runtime bridge](#testing-a-running-game-with-the-runtime-bridge)
- [Troubleshooting and FAQ](#troubleshooting-and-faq)
- [Limits](#limits)

## What it does and what it doesn't

construct3-mcp is a small program (an "MCP server") that your AI tool starts in the background. It gives the AI 83 tools, 9 resources (5 fixed ones and 4 templates that take the name of an object, event sheet, layout or manual topic) and 7 prompts for one Construct 3 project:

- **Read and explain**: list objects, layouts, event sheets, families, timelines and addons, show an event sheet as a readable outline with the editor's event numbers, find where an object is used, map functions, find unused objects and assets.
- **Check**: `validate_project` runs 26 checks, including rules the Construct 3 editor enforces when it opens a project. `find_runtime_traps` looks for logic that loads fine but hangs or does nothing.
- **Edit**: create, change and delete objects, families, event sheets and events, layouts, layers, instances, animations and timelines, and change the project metadata (name, version, author, description). Names and references are checked before anything is written, and most rewritten files get a `.bak` copy (exceptions under [.bak files](#bak-files)).
- **Test the running game**: add a "bridge" script to your project, serve an export of the game, and let the AI read variables, call functions, wait for states, click, type and take screenshots in the running game.

What it does **not** do:

- It cannot open `.c3p` single-file projects, only projects saved as a folder.
- The Construct 3 editor does not notice its changes. You close and reopen the project yourself (see [the safe editing workflow](#the-safe-editing-workflow)).
- It does not know Construct's list of conditions and actions or their parameter names, and it does not parse full expressions. A misspelled action id or an expression like `Player.X +` is written without complaint.
- It does not download the Construct 3 manual. The documentation resources only return links.
- It does not export or preview your game: that only the Construct editor does. The runtime tools start from an export or from the editor's preview in Chrome or Edge.
- It cannot install third-party addons. `register_addon` only writes an entry into the project's addon list (`usedAddons`), and after that the server creates objects for that addon whether it is installed or not. Add third-party addons in the editor and don't let the AI register them.
- It does not listen on the network for your AI tool: the two talk over stdin/stdout only. Only the runtime tools use ports, and only on this machine: `serve_preview` serves an export on 127.0.0.1 and starts a browser with a debugging port, and `connect_to_game` connects to such a port (another machine only if you allow it, see [Testing a running game](#testing-a-running-game-with-the-runtime-bridge)).

## Requirements

- **Node.js 18 or newer.** Node 22 or 24 (both LTS releases) is recommended. Check with `node --version`. The server was built and run with Node 22.23.2 and with Node 18.20.8. Node 18 prints harmless `EBADENGINE` warnings for `vite` and `vitest` (test tools only). Node 18 is end-of-life.
- **git**, to download the server.
- **An MCP client**: Claude Code, Claude Desktop, Cursor, VS Code with GitHub Copilot, or another tool that supports local (stdio) MCP servers.
- **A Construct 3 project saved as a folder.** The folder contains `project.c3proj` next to folders such as `eventSheets/`, `layouts/` and `objectTypes/`.

### Converting a .c3p project to a folder project

A `.c3p` file will not load (see [Troubleshooting](#troubleshooting-and-faq)). Convert it once. According to the Construct 3 manual and Scirra's tutorials (not clicked through for this guide):

- In Construct 3 in Chrome or Edge (or Construct installed as an app from those browsers), open the project and choose **Menu > Project > Save as > Save as project folder...**, then pick an **empty** folder. Firefox and Safari do not offer this option.
- Or rename `MyGame.c3p` to `MyGame.zip` and extract it. A `.c3p` is a ZIP archive.

From then on, open the folder project in Construct 3 with **Menu > Project > Open**.

## Install

The server is not published on npm. Download and build it once.

First pick a permanent folder for it, outside your game projects, for example `C:\Tools` on Windows or `~/tools` on macOS. Create it and go there in your terminal: `cd C:\Tools` in PowerShell, `cd /d C:\Tools` in cmd, `cd /c/Tools` in Git Bash, `cd ~/tools` on macOS. Your AI tool will start the server from there. If you move the folder later, update the path in your AI tool. Then run:

```bash
git clone https://github.com/liauw-media/construct3-mcp.git
cd construct3-mcp
npm ci
```

`npm ci` installs the dependencies **and** compiles the server into `dist/` (the `prepare` script runs the build). It took 30 to 45 seconds in our tests. The output looks like this:

```
> construct3-mcp-server@1.9.2 prepare
> npm run build


> construct3-mcp-server@1.9.2 build
> tsc


added 154 packages, and audited 155 packages in 31s

43 packages are looking for funding
  run `npm fund` for details

17 vulnerabilities (2 low, 2 moderate, 11 high, 2 critical)

To address all issues, run:
  npm audit fix
...
```

`npm install` works the same way. You only need `npm run build` again if you change the source code.

- Do **not** use `npm ci --omit=dev` or `--production`. The build needs the TypeScript compiler, which is a dev dependency, so the install fails with `tsc` not found and no `dist/` folder.
- About the vulnerability summary (17 on 2026-09-29, 8 of them in runtime dependencies, the rest in test tools): 7 of the 8 runtime findings are in the HTTP server parts of the MCP SDK (express, hono and their dependencies), which this stdio server never loads. The eighth, `fast-uri`, is loaded as part of the SDK's JSON-schema validator (`ajv`). Its reported problems concern parsing untrusted URLs, which this server does not do. The server runs no HTTP server of the SDK: the MCP connection is stdio, and the only port it opens is the loopback preview server of `serve_preview`, which is its own code. You don't need to run `npm audit fix` to use it.
- To update later: `git pull`, then `npm ci` again, then restart or reconnect the server in your AI tool.

Every configuration below needs the **absolute path** to `dist/index.js` in your clone. To print it, run this inside the clone folder:

```bash
node -e "console.log(require('path').resolve('dist/index.js'))"
```

On Windows this prints backslashes (`C:\Tools\construct3-mcp\dist\index.js`). In JSON configuration files write them as forward slashes or doubled backslashes (see [Writing .mcp.json by hand](#writing-mcpjson-by-hand)).

This guide uses `C:/Tools/construct3-mcp/dist/index.js` (Windows) and `/Users/you/tools/construct3-mcp/dist/index.js` (macOS) as examples, and `C:/Games/My Game` as the project folder.

### Quick test in a terminal (optional)

```bash
node "C:/Tools/construct3-mcp/dist/index.js" "C:/Games/My Game"
```

Expected output:

```
Construct3 MCP Server starting...
Project path: C:/Games/My Game
Loaded Construct3 project: <your project name>
Construct3 MCP Server ready
```

After that the server prints nothing more and waits. That is correct: it waits for an AI tool to talk to it on stdin. Press Ctrl+C to stop it. You normally never start it by hand, your AI tool does. If the path is wrong you get an error instead and the server exits with code 1, see [Troubleshooting](#troubleshooting-and-faq).

To see the tool list without any AI tool, use the MCP Inspector in CLI mode:

```bash
npx -y @modelcontextprotocol/inspector --cli node "C:/Tools/construct3-mcp/dist/index.js" "C:/Games/My Game" --method tools/list
```

This prints a JSON list of 83 tools. The first run downloads the Inspector and can take a few minutes. It may also print a `npm warn deprecated` line and `Schema portability: 0 errors, 16 warnings across 8 tools`; both are harmless. Without `--cli` the Inspector starts a browser UI and keeps running.

### Alternative: run from GitHub without cloning

npm can build the server straight from GitHub:

```bash
npx -y github:liauw-media/construct3-mcp "C:/Games/My Game"
```

In our tests the first start took one to two minutes (download and build), later starts 7 to 8 seconds. It needs git and a network connection and always takes the default branch. Run it once in a terminal before you put it into an AI tool, because a client may give up while the first build is still running. The clone and `npm ci` route is more predictable: a fixed version that starts in one or two seconds.

## Tell the server which project to open

One server process works on exactly one project. It looks for the project in this order (the first match wins):

1. **The first argument** after `dist/index.js`: the project folder, or the `.c3proj` file itself.
2. **The environment variable `C3_PROJECT_PATH`.**
3. **The working directory** the server was started in.

A folder must contain the `.c3proj` file **directly**. The server does not look into subfolders or parent folders. If your repository keeps the game in `repo/game/project.c3proj`, pass `repo/game`.

The safest choice is to always pass the project path as an argument. Claude Desktop and most other apps do not start the server in your project folder, so there the path is required.

## Connect your AI tool

> **Quick path for Claude Code (3 steps).** Everything else in this chapter is detail and other clients.
>
> 1. `claude mcp add construct3 --scope user -- node "C:/Tools/construct3-mcp/dist/index.js" "C:/Games/My Game"` (your two paths, see [Recommended setup](#recommended-setup)).
> 2. `claude mcp list` must show `construct3: ... - ✔ Connected`.
> 3. Start `claude`, type `/mcp` to see `construct3` and its tools, then ask "Give me an overview of this project" and go on with the [first session](#first-session).

### Claude Code

#### Recommended setup

Add the server once, with the path to your project:

macOS / Linux:

```bash
claude mcp add construct3 --scope user -- node /Users/you/tools/construct3-mcp/dist/index.js "/Users/you/Games/My Game"
```

Windows (PowerShell, cmd or Git Bash):

```
claude mcp add construct3 --scope user -- node "C:/Tools/construct3-mcp/dist/index.js" "C:/Games/My Game"
```

- Everything after `--` is the command Claude Code runs to start the server.
- Put paths with spaces in double quotes. On Windows, forward slashes (`C:/Games/My Game`) work everywhere. Backslashes work in PowerShell and cmd, but in Git Bash only inside quotes (unquoted backslashes are removed).
- The Windows command was tested in PowerShell, cmd and Git Bash. The macOS/Linux line uses the same syntax but was not run on those systems.

Check the connection:

```
claude mcp list
```

```
construct3: node C:/Tools/construct3-mcp/dist/index.js C:/Games/My Game - ✔ Connected
```

`claude mcp get construct3` shows the details (`Scope: User config (available in all your projects)`, `Status: ✔ Connected`). Inside a running Claude Code session, `/mcp` shows the status and lets you **Reconnect** the server. Remove it again with `claude mcp remove construct3 -s user`.

`claude mcp add` does not check paths. A wrong path is saved with `Added stdio MCP server ...` and only fails when the server starts. Always run `claude mcp list` after adding.

#### Which scope?

| Scope | Command | Where it is stored | When it is active |
|-------|---------|--------------------|-------------------|
| `user` | `--scope user` | `~/.claude.json` (top-level `mcpServers`) | In every folder you start `claude` in, so the server also starts in sessions that have nothing to do with your game |
| `local` (default) | no `--scope` | `~/.claude.json`, under the folder you ran the command in, or under the repository root if that folder is in a git repository | Outside git: only when `claude` is started in exactly that folder, not in its parent or subfolders. Inside a git repository: anywhere in that repository |
| `project` | `--scope project` | `.mcp.json` in the current folder | In that folder, after you approve it (see below) |

**Several games.** A `user` entry with a path always opens the same game. For several games, either:

- add one `local` entry per game, from inside each game folder, if every game is its own folder or its own git repository:

  ```
  cd "C:/Games/My Game"
  claude mcp add construct3 -- node "C:/Tools/construct3-mcp/dist/index.js" "C:/Games/My Game"
  ```

  (in cmd, use `cd /d` if the game is on another drive) and always start `claude` in that game folder. This does not work for several games in **one** git repository: the entry belongs to the repository root, the second `claude mcp add` fails with `MCP server construct3 already exists in local config`, and in the second game's folder the server for the first game starts. Or
- add one `user` entry **without** a project path and always start `claude` in the folder that contains the `.c3proj` (this also works for several games in one repository):

  ```
  claude mcp add construct3 --scope user -- node "C:/Tools/construct3-mcp/dist/index.js"
  ```

  Started anywhere else, the server finds no project and `claude mcp list` shows `✘ Failed to connect — CONNECTION_CLOSED: Connection closed`. That is expected. Claude Code starts the server in the folder where you started `claude`, not in the repository root, so a game in a subfolder of your repository needs the path.

**Sharing the setup through `.mcp.json`.** `claude mcp add --scope project ...` writes a `.mcp.json` into the current folder. Claude Code does not start it until you approve it: `claude mcp list` shows ``construct3: ... - ⏸ Pending approval (run `claude` to approve)``. Start `claude` once in that folder, trust the folder and approve the `construct3` server. The file contains the absolute path to your clone, so it only works for teammates who use the same path. Construct 3 ignores the file. If you want to auto-approve it on your machine, add `{"enabledMcpjsonServers": ["construct3"]}` to `.claude/settings.local.json`. This only takes effect after the folder has been trusted once. `claude mcp reset-project-choices` resets your approvals.

**Do not use `~/.claude/mcp.json`.** Claude Code does not read that file, although the README of version 1.9.0 suggested it. Use `claude mcp add` or a `.mcp.json` in the project folder.

#### Writing .mcp.json by hand

This format works, and so does the one `claude mcp add` writes (the same with `"type": "stdio"` and `"env": {}` added):

```json
{
  "mcpServers": {
    "construct3": {
      "command": "node",
      "args": ["C:/Tools/construct3-mcp/dist/index.js", "C:/Games/My Game"]
    }
  }
}
```

- Use forward slashes or doubled backslashes (`"C:\\Games\\My Game"`). Single backslashes and trailing commas make the file invalid JSON. `claude mcp list` then shows `[Failed to parse] Project config (shared via .mcp.json)` and `MCP config is not a valid JSON`.
- Each path is one array element. Do not add extra quotes around a path with spaces (`"\"C:/Games/My Game\""` makes the server look for a folder whose name starts with a quote).

#### Windows shell pitfalls

- **PowerShell with `-e`.** If Claude Code was installed with npm, `claude` in Windows PowerShell 5.1 is a PowerShell script, and PowerShell drops an unquoted `--`. Together with `-e` this fails with `error: missing required argument 'commandOrUrl'`. Quote the separator or call `claude.cmd`:

  ```powershell
  claude mcp add construct3 --scope user -e C3_PROJECT_PATH="C:/Games/My Game" '--' node "C:/Tools/construct3-mcp/dist/index.js"
  ```

- **`-e` directly before the name.** `claude mcp add -e KEY=VALUE construct3 ...` fails with `Invalid environment variable format: construct3`. Put the name first (as above) or another option between `-e` and the name.
- **Git Bash** removes unquoted backslashes: `C:\Tools\...` becomes `C:Tools...`, is still saved, and fails later with `Cannot find module`. Use `C:/Tools/...` or `/c/Tools/...`.

#### Tool permissions

Claude Code asks before it uses an MCP tool. In Claude Code the tools are named `mcp__construct3__<tool>`, for example `mcp__construct3__list_objects`. The server does not mark its tools as read-only or destructive, so your client cannot tell them apart by itself. These rules allow exactly the 26 read-only tools and nothing else. Put them in `~/.claude/settings.json` (applies in every folder, which fits the `user` setup above), or in `.claude/settings.json` inside the game folder you start `claude` in (Claude Code reads it only from the start folder, not from parent folders, and applies its allow rules only after you trusted that folder). You can also add them with `/permissions`:

```json
{
  "permissions": {
    "allow": [
      "mcp__construct3__list_*",
      "mcp__construct3__get_*",
      "mcp__construct3__find_*",
      "mcp__construct3__search_objects",
      "mcp__construct3__locate_event",
      "mcp__construct3__validate_project",
      "mcp__construct3__analyze_performance",
      "mcp__construct3__generate_bridge_eval_script"
    ]
  }
}
```

Keep the write tools on "ask" so you see each change before it happens. The rule syntax is from the Claude Code permissions documentation. That the patterns match exactly the 26 read-only tools was checked against the server's tool list (MCP Inspector, 83 tools). `get_*` includes `get_canvas_size`, which reads the canvas of a game you connected to and changes nothing.

### Claude Desktop

*Based on the MCP and Claude Desktop documentation. The config file was checked to exist on Windows, the connection itself was not tested for this guide.*

Open **Settings > Developer > Edit Config**. This opens `claude_desktop_config.json`:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

Add the server inside `mcpServers` (keep other entries that are already there):

```json
{
  "mcpServers": {
    "construct3": {
      "command": "node",
      "args": ["C:/Tools/construct3-mcp/dist/index.js", "C:/Games/My Game"]
    }
  }
}
```

- Always pass the project path. Claude Desktop does not start the server in your project folder.
- Quit Claude Desktop completely (tray or menu bar icon > Quit) and start it again. Closing the window is not enough.
- Logs: `%APPDATA%\Claude\logs\` on Windows, `~/Library/Logs/Claude/` on macOS. `mcp-server-construct3.log` contains the server's own messages.
- Not from the documentation, but Node.js's general error for a program it cannot find: if the log says `spawn node ENOENT`, Claude Desktop probably cannot find Node.js in its `PATH`. Put the full path to Node in `"command"`: find it with `where node` (cmd), `(Get-Command node).Source` (PowerShell) or `which node` (macOS/Linux). After you change your Node installation, quit and restart Claude Desktop.

### Cursor

*From the Cursor documentation, not tested for this guide.*

Create `.cursor/mcp.json` in your project folder (or `~/.cursor/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "construct3": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/Tools/construct3-mcp/dist/index.js", "${workspaceFolder}"]
    }
  }
}
```

`${workspaceFolder}` is the folder that contains `.cursor/mcp.json`. In the global file use an absolute project path instead. Problems show up in the Output panel under **MCP Logs**. Cursor asks for approval before it uses MCP tools.

### VS Code

*From the VS Code documentation (GitHub Copilot agent mode), not tested for this guide.*

Open your game folder as the workspace and create `.vscode/mcp.json` in it. Note that the top-level key is `"servers"`, not `"mcpServers"`, so the JSON from the other sections does not work here unchanged:

```json
{
  "servers": {
    "construct3": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/Tools/construct3-mcp/dist/index.js", "${workspaceFolder}"]
    }
  }
}
```

Confirm the trust prompt when the server starts. Logs: Command Palette > **MCP: List Servers** > `construct3` > **Show Output**.

### Other clients

*From each vendor's documentation, not tested for this guide.* Always pass an explicit project path.

- **Windsurf** (now "Devin Desktop", agent "Cascade"): Cascade panel > `...` menu > **Open MCP config file**. Same `mcpServers` JSON as Claude Desktop. Cascade allows at most 100 tools in total and this server alone brings 83, so disable other servers or tools you don't need if you hit the limit.
- **Antigravity**: open the file through the Agent panel > **MCP Servers** > **Manage MCP Servers** > **View raw config**. Current documentation names `~/.gemini/config/mcp_config.json` (global) and `.agents/mcp_config.json` (per workspace).

### Check that it works

Your client should show `construct3` with 83 tools (plus 5 resources, 4 resource templates and 7 prompts). In Claude Code, start `claude` (in your game folder if your setup has no project path), type `/mcp` and select `construct3` to see its status and tools. Then type:

> Give me an overview of this project.

The AI calls `get_project_summary` and answers with your project's name, layouts, object and event sheet counts. If the client shows the server as failed or "Connection closed", see [Troubleshooting](#troubleshooting-and-faq).

After you save the project in Construct 3, reconnect the server (Claude Code: `/mcp` > `construct3` > **Reconnect**; other clients: restart the server or the app). The server reads the project list once at start, so lists like `list_objects` otherwise show the state from when the server started.

## First session

You don't need tool names. Ask in plain language and the AI picks the tools. The examples below show which tools sit behind typical requests and what they return. They come from a real session against the small test project in this repository (`TestProject`: one Sprite object, one layout `Layout 1` with the layer `Main`, one event sheet `MainSheet`). Responses are shortened.

### Explore

"Give me an overview of this project" calls `get_project_summary`:

```json
{
  "project": { "name": "TestProject", "version": "1.0.0", "viewportWidth": 1920, "viewportHeight": 1080, "firstLayout": "Layout 1", ... },
  "statistics": { "objectTypes": 1, "eventSheets": 1, "layouts": 1, "families": 0, "plugins": 1, "behaviors": 0, "effects": 0 },
  "lists": { "objects": ["Sprite"], "eventSheets": ["MainSheet"], "layouts": ["Layout 1"] },
  "note": "Lists are limited to first 10 items. Use specific list tools for complete data."
}
```

"Show me MainSheet" calls `get_eventsheet_outline {"sheet": "MainSheet"}` and returns text with the editor's event numbers:

```
1 IF System.on-start-of-layout()
      DO Sprite.set-position(x=100, y=200)
```

"The console says MainSheet, event 1, action 1. What is that?" calls `locate_event {"sheet": "MainSheet", "eventNumber": 1, "actionNumber": 1}` and returns the JSON path `events[0].actions[0]`, its SID and the text `DO Sprite.set-position(x=100, y=200)`.

"Where is Sprite used?" calls `get_object_dependencies {"object": "Sprite"}`:

```json
{ "object": { "objectName": "Sprite", "referencedIn": { "eventSheets": ["MainSheet"], "layouts": ["Layout 1"] }, "families": [], "coOccursWith": ["System"], "referenceCount": 2 } }
```

"Is the project OK?" calls `validate_project`:

```json
{ "valid": true, "complete": true, "summary": { "errors": 0, "warnings": 0, "info": 0, "checksRun": 26, "entitiesScanned": 3, "unscanned": 0 }, "errors": [], "warnings": [], "info": [], "unscannedFiles": [] }
```

### Make changes

> **Before your first change**, so that you can undo it:
>
> 1. Save and close the project in Construct 3.
> 2. Put the project folder under git and commit, as shown in step 2 of [the safe editing workflow](#the-safe-editing-workflow).
> 3. Read the rest of that workflow before you approve the first write.

Every successful write returns an `editorNote` (shortened to `"..."` below).

"Create a Sprite object called Player" calls `create_object {"name": "Player", "pluginId": "Sprite"}`:

```json
{ "success": true, "entity": "Player", "category": "object", "action": "created", "generatedSid": 182275957199257, "editorNote": "..." }
```

This adds `objectTypes/Player.json` and a 1x1 placeholder image `images/player-animation 1-000.png` (replace it in the editor or with `replace_sprite_image`).

"Put a Player on Layout 1 at 400, 300, 64 by 64 pixels" calls `add_instance_to_layout {"layoutName": "Layout 1", "layerName": "Main", "objectType": "Player", "x": 400, "y": 300, "width": 64, "height": 64}`:

```json
{ "success": true, "entity": "Layout 1", "category": "layout", "action": "updated", "generatedSid": 358663387518961, "generatedUid": 1, "editorNote": "..." }
```

The UID is what `update_instance` and `delete_instance_from_layout` need later. Without a size the instance is 100 x 100.

"Give Player a number instance variable health" calls `update_object_properties {"name": "Player", "addVariables": [{"name": "health", "type": "number"}]}`. The tool sets name and type only, not a start value.

"Add a global number variable Score" calls `add_event_to_sheet {"sheetName": "MainSheet", "eventType": "variable", "variableName": "Score", "variableType": "number", "initialValue": "0"}`.

"Add a comment 'Player setup (added via MCP)'" calls `add_event_to_sheet {"sheetName": "MainSheet", "eventType": "comment", "commentText": "Player setup (added via MCP)"}`.

"On start of layout set Player.health to 100" and "Every second subtract 1 from Player.health" call `add_event_block`:

```json
{
  "sheetName": "MainSheet",
  "conditions": [{ "id": "on-start-of-layout", "objectClass": "System" }],
  "actions": [{ "id": "set-instvar-value", "objectClass": "Player", "parameters": { "instance-variable": "health", "value": "100" } }]
}
```

```json
{
  "sheetName": "MainSheet",
  "conditions": [{ "id": "every-x-seconds", "objectClass": "System", "parameters": { "interval-seconds": "1" } }],
  "actions": [{ "id": "subtract-from-instvar", "objectClass": "Player", "parameters": { "instance-variable": "health", "value": "1" } }]
}
```

The outline afterwards:

```
1 IF System.on-start-of-layout()
      DO Sprite.set-position(x=100, y=200)
- VAR Score: number = 0
- COMMENT: Player setup (added via MCP)
2 IF System.on-start-of-layout()
      DO Player.set-instvar-value(instance-variable=health, value=100)
3 IF System.every-x-seconds(interval-seconds=1)
      DO Player.subtract-from-instvar(instance-variable=health, value=1)
```

Parameter values are Construct expressions written as strings (`"100"`, `"Player.health - 1"`). Text needs inner quotes: `"\"hello\""`. Parameter keys must be the ones the editor saves, for example `"instance-variable"` (not `"variable"`) in instance variable conditions and actions, and comparisons use a number (`"comparison": 0` is "equal to"). If you are unsure, build one example event in the editor, save, and ask the AI to copy its shape from `get_eventsheet_details`.

"Add keyboard input" calls `create_object {"name": "Keyboard", "pluginId": "Keyboard"}`. Built-in Scirra plugins and behaviors are added to the project automatically, with the warning `Auto-registered plugin "Keyboard" in usedAddons (was not previously in the project).`

### When the server says no

Mistakes are reported without writing anything, for example:

- `Object "Player" already exists. Use update_object_properties to modify it.`
- `Event sheet "Main" not found.` followed by `Did you mean: MainSheet?`
- `Layer "Background" not found in layout "Layout 1". Available layers: Main`
- `Object "Keyboard" is a global plugin (Keyboard) and cannot be placed on layouts.`
- `Error creating object: Plugin "Blorp" is not registered in the project's usedAddons and is not a known built-in Scirra addon. Add it to the project in the Construct 3 editor first.`
- An empty parameter: `Construct 3 load-time check failed; nothing was written.` with the reason (`... is empty. Construct 3 fails to open the project with "Empty expression: You must enter an expression" ...`).

Deleting something that is still used is refused, but **not** as an error. The answer is normal JSON with `"success": false`:

```json
{ "success": false, "action": "delete_blocked",
  "message": "Object is still referenced: used 2 time(s) in events of \"MainSheet\" (2 action object); 1 instance(s) in layout \"Layout 1\" (layer \"Main\"). Use force=true to delete anyway (references will NOT be cleaned up).",
  "references": { ... } }
```

Removing a used instance variable returns `"action": "update_blocked"` in the same way. Fix or delete the listed uses first. Only tell the AI to use `force: true` if you really want to leave broken references behind.

A layout, event sheet or family file the server cannot parse (over 10 MB, or not valid JSON) is searched as text for the names instead. A match refuses the same way, but it is only a *possible* use: the text search cannot tell a use from the same name in another string, such as a comment or a text property. `unscannedFiles` lists the files:

```json
{ "success": false, "action": "delete_blocked",
  "message": "There are possible uses in files that could not be parsed: layouts/Big (over the 10MB read limit), whose text names \"Enemy\". They were found by a text search, which cannot tell a use from the same name in another string. Use force=true to delete anyway (references will NOT be cleaned up).",
  "references": { ... },
  "unscannedFiles": [ { "file": "layouts/Big", "reason": "over the 10MB read limit", "textSearch": "possible-use", "names": ["Enemy"] } ] }
```

Check the named file in the editor before you allow `force: true`. A file that cannot be read even as text (`"textSearch": "unreadable"`) refuses too. When the search finds nothing, the tool goes ahead and warns that the file was only searched as text. Version 1.9.1 and older did not search these files (see [Limits](#limits)).

### Prompts

Prompts are ready-made requests that embed data from your project:

| Prompt | Arguments | What it does |
|--------|-----------|--------------|
| `analyze_project` | none | Structure, naming and organisation review |
| `find_object_usage` | `objectName` | Where an object is used |
| `explain_eventsheet` | `eventSheetName` | Walk-through of one event sheet |
| `review_game_logic` | none | Architecture review including a runtime-trap scan |
| `document_object` | `objectName` | Documentation for one object |
| `optimize_project` | none | Performance and organisation suggestions |
| `debug_stuck_game` | `symptom` (optional) | Soft-locks and features that silently do nothing |

According to the Claude Code documentation, Claude Code lists them in the `/` menu as `/construct3:analyze_project (MCP)`, and arguments follow the command separated by spaces (each argument is one word).

### Resources

Resources are read-only context the AI can attach: `construct3://project/info`, `construct3://project/structure`, `construct3://project/addons`, `construct3://objects/<Name>`, `construct3://eventsheets/<Name>`, `construct3://layouts/<Name>`, `construct3://docs/index` and `construct3://docs/pitfalls` (a curated list of Construct 3 gotchas). `construct3://docs/manual/<topic>` only returns a link to the construct.net manual page, not its text. construct.net blocks automated downloads, so paste the relevant manual text into the chat yourself when it matters.

## The safe editing workflow

Construct 3 keeps an open project in memory and does not notice files changed by the server. If you save in the editor after the AI changed files, the editor saves its own, older state of the files it considers changed. That can overwrite some or all of the AI's changes and leave the project inconsistent. Every successful write reminds you of this:

```
"editorNote": "If this project is open in Construct 3, close and reopen it there before saving, or the editor can overwrite these changes."
```

Work in this order:

1. **Save and close the project in Construct 3** (Menu > Project > Close project).
2. **Put the project under git and commit.** Open `.gitignore` in the project folder with a text editor and add this line. If there is no `.gitignore`, create one. Construct 3 writes one for `*.uistate.json` and `ts-defs` when you save a folder project (per Scirra's tutorial), but a project you unpacked from a `.c3p` may have none.

   ```
   *.bak
   ```

   Don't add the line with `echo *.bak >> .gitignore` in Windows PowerShell 5.1. It writes UTF-16, which git does not read as intended: in a new file the line has no effect, and appended to an existing `.gitignore` git read it as `*` and ignored every file in the project.

   Then run these commands in a terminal in the project folder (the one with `project.c3proj`, for example after `cd "C:/Games/My Game"`). `git init` is only needed the first time:

   ```bash
   git init
   git add -A
   git commit -m "before AI session"
   ```

   If git answers `Author identity unknown` and `Please tell me who you are`, run the two `git config` commands it prints, with your name and e-mail, and commit again.
3. **Reconnect the server** if you changed the project in the editor or with git since the server started (Claude Code: `/mcp` > `construct3` > **Reconnect**).
4. **Ask for the changes.** Read what each write tool is about to do before you approve it, and read the answers: `"success": false` means nothing was changed.
5. **Run `validate_project`.** `errors` are problems that can stop the editor from opening the project. `warnings` mean "check this": a project can be `"valid": true` and still have warnings such as `missing-behavior-or-variable`. `"valid": true` also requires `"complete": true`: every registered object type, family, event sheet and layout file was checked. If one exists but could not be checked (over the 10 MB read limit, invalid JSON, unreadable), `complete` is `false`, `unscannedFiles` names it and `valid` is `false`. A file over the 10 MB read limit is only an `unscanned-file` warning, so `summary.errors` can be 0; invalid JSON or an unreadable file is also a `file-existence` error. Nothing inside such a file was checked (see [Limits](#limits)). Info entries are hints: `backup-file` lists a `.bak` copy, `orphaned-object` an object that nothing uses yet (every newly created object, until an event uses it).
6. **Review the diff** with `git diff` and `git status`. A typical session changes `project.c3proj`, event sheet and layout JSON files, and adds `objectTypes/<Name>.json` and images for new sprites. For files saved by Construct 3, line endings and tab indentation are kept, so the diff shows only the lines that changed. The test project in this repository was written by hand, so its first change also spreads a few one-line number arrays (such as `"backgroundColor": [0, 0, 0, 0]`) over several lines; projects saved by Construct 3 already store them that way. After its first new sprite, `validate_project` also warns `frame-image` for its `Sprite`, whose image file the test project lacks.
7. **Reopen the project in Construct 3** and look at the new events and objects. Preview the game.
8. **Commit** and delete the `.bak` files you no longer need.

If you forgot to close the project: close it in Construct 3 **without saving**, then reopen it.

**F9 does not help here.** F9 ("Reload all script files from disk") and the Scripts folder option **Auto reload all on preview** reload only script files, not event sheets, layouts, objects or project settings. For those, close and reopen the project.

### .bak files

Before the server rewrites or deletes a JSON file or `project.c3proj`, it copies it to `<file>.bak` next to it, for example `eventSheets/MainSheet.json.bak` or `project.c3proj.bak`.

- There is only **one** such `.bak` per file. The next write to the same file overwrites it, so it holds the state before the **last write** to that file, not the state before your session. One request can write the same file twice: after "Add keyboard input", `project.c3proj.bak` already contains the new `Keyboard` addon entry.
- Sprite frame images work differently. The editor names a frame's image after the frame's index, so `add_frame_to_animation` with an `index` and `delete_frame_from_animation` rename the images of the later frames one index up or down, and every frame keeps its image. The image of a deleted frame, and an image file that no frame uses but sits where a moved image or the new placeholder has to go, are renamed to `<file>.bak` in `images/`, for example `images/player-animation 1-001.png.bak`. If that name is taken, the next one is `<file>.1.bak`, then `<file>.2.bak`, so older copies are kept. The tool's `warnings` name these files (the first three, then how many more).
- Nothing deletes them. They are not listed in `project.c3proj`, and `pack_project` leaves them out of the `.c3p`. `validate_project` lists them as `backup-file` info, including those in `images/`. Whether the Construct 3 editor shows or keeps them was not tested for this guide.
- Some writes make no `.bak` at all: `register_addon`, `unregister_addon`, the runtime-bridge tools (`inject_runtime_bridge`, `remove_runtime_bridge`, and `export_for_preview` / `pack_project` when they add the bridge, which also add or remove one line in your main script) and the other image writes. `replace_sprite_image` writes the new PNG over the frame's image, and `create_object` and `add_animation_to_sprite` write their placeholder PNGs over an image file of the same name, for example one left behind by a deleted object or animation.

To list or delete them:

```bash
find . -name '*.bak' -print            # macOS, Linux, Git Bash; use -delete to remove them
```

```powershell
Get-ChildItem -Recurse -Filter *.bak   # PowerShell; add "| Remove-Item" to delete them
```

### Undoing a session

Use git, not the `.bak` files:

```bash
git restore .      # undo changes to files that were already committed
git clean -nd      # list files and folders the session added (new objects, images)
git clean -fd      # delete them
```

`git restore .` alone leaves new files such as `objectTypes/Player.json` in place; `git status` shows them as untracked (`??`), and `git clean` removes them. Files in `.gitignore` (like `*.bak`) are not touched by `git clean -fd`. The `.bak` files now hold states from the session you undid, some of them for objects that no longer exist, and `validate_project` keeps listing them. Delete them (see [.bak files](#bak-files)).

Then **reconnect the server** (Claude Code: `/mcp` > `construct3` > **Reconnect**) before you ask for more changes. The server keeps the lists it read at start, so it still sees the undone objects. In our test, asking for the same object again then failed with `Object "Player" already exists. Use update_object_properties to modify it.`, and placing it with `Object type "Player" does not exist.` The project files stayed unchanged (`git status` showed nothing); after a reconnect, creating the object worked again.

### If Construct 3 refuses to open the project

Don't save anything. Go back to your last commit (see above), or ask the AI to run `validate_project` and fix what it reports. `missing action id '...'` on behavior actions usually means an event sheet written by a construct3-mcp version older than 1.9.0. Ask the AI to run `fix_legacy_behavior_keys` and then `fix_legacy_event_shapes`. Both only report what they would change by default (`dryRun: true`). Tell the AI to apply the changes once you agree.

## Read tools and write tools

**Read-only tools (26)**, safe to auto-approve:

- Browse: `get_project_summary`, `list_objects`, `list_layouts`, `list_eventsheets`, `list_families`, `list_addons`, `list_timelines`, `search_objects`
- Details: `get_object_details`, `get_layout_details`, `get_eventsheet_details`, `get_timeline_details`
- Understand and find: `get_object_dependencies`, `get_eventsheet_outline`, `locate_event`, `get_eventsheet_flow`, `get_function_map`, `get_group_settings`, `get_asset_usage`
- Check: `validate_project`, `find_orphaned_objects`, `find_runtime_traps`, `analyze_performance`
- Runtime helpers that only return text: `get_bridge_commands`, `generate_bridge_eval_script`
- Runtime read: `get_canvas_size` (the canvas geometry of a game you connected to with `connect_to_game`; it sends nothing to the game)

**Tools that write files (47)**, review before approving:

- Objects and families: `create_object`, `update_object_properties`, `delete_object`, `create_family`, `update_family`, `delete_family`
- Event sheets: `create_event_sheet`, `add_event_to_sheet`, `add_event_block`, `update_event_block`, `update_event_block_action`, `update_event_variable`, `move_events_between_sheets`, `delete_event_from_sheet`, `remove_event_from_sheet`, `delete_event_sheet`, `fix_legacy_behavior_keys`, `fix_legacy_event_shapes`
- Layouts, layers, instances: `create_layout`, `update_layout`, `delete_layout`, `add_layer`, `update_layer`, `delete_layer`, `add_instance_to_layout`, `update_instance`, `delete_instance_from_layout`
- Animations: `add_animation_to_sprite`, `update_animation_properties`, `rename_animation`, `delete_animation`, `add_frame_to_animation`, `update_frame`, `delete_frame_from_animation`, `replace_sprite_image`
- Timelines: `create_timeline`, `update_timeline`, `delete_timeline`
- Project and addons: `update_project_metadata`, `register_addon`, `unregister_addon`
- Runtime: `inject_runtime_bridge`, `remove_runtime_bridge`, `export_for_preview`, `clone_project`, `pack_project`, and `screenshot_game` (writes the image file you name, outside the project; an existing file only with `overwrite: true`)

**Tools that act on the running game** (they change nothing in the project, but run functions, set variables and send input in the game they connect to, and `serve_preview` starts a local web server and a browser): `connect_to_game`, `disconnect_from_game`, `call_bridge`, `wait_for_condition`, `subscribe_events`, `read_events`, `unsubscribe_events`, `simulate_input`, `serve_preview`, `stop_preview`.

Defaults to know:

- `export_for_preview` and `pack_project` add the runtime bridge **to your project folder** (with the import line in your main script) unless you pass `injectBridge: false`, and the `.c3p` then runs the bridge; `pack_project` says so in a `warning`. `clone_project` adds it to the copy unless you pass `includeBridge: false`.
- `fix_legacy_behavior_keys` and `fix_legacy_event_shapes` only report by default (`dryRun: true`).
- `force: true` means different things per tool:
  - On `delete_object`, `delete_family`, `delete_event_sheet`, `delete_event_from_sheet`, `delete_layout`, `update_object_properties` and `update_family` it skips the reference checks and leaves the references behind.
  - On `delete_layer` it deletes the layer together with the instances on it.
  - `unregister_addon` checks no references at all; `force` only allows removing a Scirra built-in addon. It also removes an addon that objects still use (it only adds the warning `If any objects/behaviors still reference it, C3 will error on load.`). Before you approve it, ask which objects use the addon. Afterwards `validate_project` reports leftover uses as `missing-addon` warnings, while the project still counts as `"valid": true`.
  - The other delete tools (`delete_animation`, `delete_frame_from_animation`, `delete_instance_from_layout`, `delete_timeline`, `remove_event_from_sheet`) have no `force` option.

Parameter names differ between tools. This only matters if you write tool calls yourself: `get_object_details` takes `name`, `get_object_dependencies` takes `object`, `get_eventsheet_outline` takes `sheet`, `add_event_block` takes `sheetName`. Every tool and parameter is described in the [API Reference](API.md). More request-to-tool examples are in [EXAMPLES.md](EXAMPLES.md).

## Testing a running game with the runtime bridge

The runtime bridge is a script (`scripts/c3-runtime-bridge.js`) that the server adds to your project. While the game runs, it lets the AI read and change global variables, call event sheet functions, read object state, switch layouts, wait for a state, record events, click and type into the game and take screenshots. The server talks to the game's browser tab over the Chrome DevTools Protocol, so it works with Chrome and Edge (Chromium-based browsers).

What you need: Node.js 22 or later for the connection tools (older versions say so when you use them), Chrome or Edge, and a way to run the game in that browser: an export of the game (Construct exports only from its editor) or the editor's preview in a browser started with a debugging port.

1. **Add the bridge**: ask for `inject_runtime_bridge`. Construct runs only the project's main script by itself, so the tool adds one marked line at the top of your main script:

   ```javascript
   import "./c3-runtime-bridge.js"; // construct3-mcp runtime bridge (remove_runtime_bridge removes this line)
   ```

   (with `../` in front when the main script is in a subfolder). A project without a main script gets the bridge as its main script. The answer says which (`"loadedAs": "import"` with `"mainScript"`, or `"loadedAs": "main"`). No `.bak` is written.
2. **Reopen the project in Construct 3.** *Use worker* can stay as it is: with *Auto* the project runs on the page because it now uses a script, and with *Yes* the server finds the bridge in the runtime's worker.
3. **Run the game.** Either export it (Menu > Project > Export > Web (HTML5)) and ask for `serve_preview` with the exported folder and `launchBrowser: true` (add `headless: true` for no window), or preview it in a Chrome started with a separate profile and a debugging port, for example `chrome --remote-debugging-port=9222 --user-data-dir=C:\Temp\c3-debug` (Chrome ignores the port for your normal profile; sign in to construct.net in that window). `serve_preview` answers with the address (`http://127.0.0.1:<port>/`) and the browser's `pageEndpoint`.
4. **Connect**: `connect_to_game` with the `cdpEndpoint` from `serve_preview`, or with `port: 9222` for your own browser. It tries every tab and keeps the one whose bridge answers, and brings it to the front: a tab in the background does not run, so commands would time out. `pageVisible: false` with a warning means the tab stayed hidden (a minimized window, for example). If more than one tab has a ready bridge (two previews, or a site that defines one of its own), it does not guess: the error lists the tabs, and you name the game with `pageUrl` (its address, such as `"http://127.0.0.1:53817/"` from `serve_preview`) or `urlContains` (such as `"preview"`; only the address and path count, not the query). If the game's page reloads, the game starts over and the connection ends with an error that says so; connect again.
5. **Drive the game** with the `connectionId`:

   - `call_bridge` runs one bridge command: `callFunction` `{ name: "StartGame", params: [] }`, `getGlobalVar` `{ name }`, `setGlobalVar` `{ name, value }`, `getObjectState` `{ objectName: "Player" }`, `getAllInstances`, `getLayout`, `goToLayout` `{ name }`, `evaluateExpression`, `listObjects`, `listGlobalVars`, `ping`. `get_bridge_commands` lists them all with their arguments.
   - `wait_for_condition` waits until a global variable, an object property or the layout matches, for example `{ type: "globalVar", name: "GameState", operator: "eq", value: "READY" }`.
   - `subscribe_events` and `read_events` record changes of a global variable, layout changes, or custom events your own script sends with `globalThis.__c3bridge.emit("Bonus", data)`.
   - `simulate_input` clicks, moves the mouse, taps, swipes, presses keys (`"Enter"`, `"Space"`, `"."`) and types text as key presses, in page, canvas or layout coordinates; `get_canvas_size` gives the canvas's position and size.
   - `screenshot_game` saves the page or only the canvas as a PNG or JPEG, to an absolute path outside the project folder, such as `"C:/Temp/runs/after-click.png"`. It does not replace an existing file unless you pass `overwrite: true`.
6. **Clean up**: `disconnect_from_game`, and `stop_preview`, which closes the browser it launched and deletes its temporary profile.

The bridge also works from the browser console: `globalThis.__c3bridge.submit("getGlobalVar", { name: "Score" })` returns a command id, and `globalThis.__c3bridge.getResult(id)` returns `{ ok: true, value: ... }` once, after the next game tick (`null` before). When the preview starts, the console shows `[c3-bridge] Runtime bridge initialized. Access via globalThis.__c3bridge`.

Two things are off unless you set them where the server starts (in the `env` of its entry in your AI tool's MCP configuration), because a tool call must not be able to turn them on:

- `C3MCP_ALLOW_EVAL=1` allows `wait_for_condition` with `{ type: "expression", expr: "..." }`, which runs any JavaScript in the game page with the page's rights.
- `C3MCP_ALLOW_REMOTE_CDP=1` allows `connect_to_game` to reach a browser on another machine.

`CHROME_PATH` chooses the browser `serve_preview` launches (by default Chrome, then Edge, from their usual install locations).

### Remove the bridge before you export

While the bridge is in the game, anyone who opens the browser console can change variables, call your functions and skip levels, and the script announces itself in the console. `validate_project` does not warn about a leftover bridge. Before you export a build for players:

1. Close the project in Construct 3.
2. Ask for `remove_runtime_bridge`. It removes the script, its entry in `project.c3proj` and every line in your scripts that only imports it: the marked line it added, and a plain `import "./c3-runtime-bridge.js";` you typed yourself (the v1.9.2 instructions had you do that). An empty `scripts/` folder may stay. If one of your scripts uses the bridge in another way, such as `import * as bridge from "./c3-runtime-bridge.js"`, it changes nothing and names that script: take that use out first, or the game would not load without the file.
3. Reopen the project and check that `c3-runtime-bridge.js` is gone from the Scripts folder.

To share a clean `.c3p`, ask for `pack_project` **with `injectBridge: false`**, for example `pack_project {"outputPath": "C:/Temp/MyGame.c3p", "injectBridge": false}`. Without that flag it adds the bridge to your project folder (with the import line in your main script) and to the `.c3p`, where it runs, and its answer carries a `warning` that says so.

## Troubleshooting and FAQ

More cases are in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

**My client says the server failed, or only "Connection closed".**
The server printed the reason to stderr and exited. Run the exact command from your configuration in a terminal to see it. In Claude Code, `claude mcp list` then shows `✘ Failed to connect — CONNECTION_CLOSED: Connection closed`. On Windows, Claude Code also logs the server's messages in `%LOCALAPPDATA%\claude-cli-nodejs\Cache\<start-folder>\mcp-logs-construct3\`, where `<start-folder>` is named after the folder you started `claude` in. Open the newest file there. Claude Desktop logs them in `mcp-server-construct3.log` (see [Claude Desktop](#claude-desktop)).

**`Failed to start server: No .c3proj file found in directory: <path>`**
The path does not exist, points to a `.c3p` file, or is a folder that does not contain the `.c3proj` directly (for example a parent folder, or the `layouts` subfolder). Without a path in the configuration the server searches the folder it was started in, which in Claude Code is the folder where you started `claude`. Pass the project folder explicitly, and convert `.c3p` projects to folder projects.

**`Failed to start server: Invalid Construct3 project file: <path>`**
The `.c3proj` path does not exist or the file is not valid Construct 3 project JSON. Check the path and re-save the project from Construct 3.

**The server hangs after "Construct3 MCP Server ready".**
That is normal when you start it in a terminal. It waits for an AI tool on stdin. Press Ctrl+C.

**`claude mcp list` shows `⏸ Pending approval`.**
The server comes from a `.mcp.json`. Start `claude` in that folder, trust the folder and approve the server.

**`claude mcp list` says `No MCP servers configured` in another folder.**
The server was added with the default `local` scope. Outside git it only applies to the exact folder you ran `claude mcp add` in; inside a git repository it applies to the whole repository. Use `--scope user` or start `claude` in that folder (see [Which scope?](#which-scope)).

**`MCP server construct3 already exists in local config`**
You ran `claude mcp add` for a second game in the same git repository, where the first game's `local` entry already applies. See [Which scope?](#which-scope) for setups with several games.

**`error: missing required argument 'commandOrUrl'`** (PowerShell) and **`Invalid environment variable format: ...`**
See [Windows shell pitfalls](#windows-shell-pitfalls).

**`MCP config is not a valid JSON`**
Single backslashes or a trailing comma in a hand-written `.mcp.json`. See [Writing .mcp.json by hand](#writing-mcpjson-by-hand).

**The AI's changes are gone after I saved in Construct 3.**
The editor still had the old project open and saved its older state over some or all of the changes. Use git to get them back if you committed, and follow [the safe editing workflow](#the-safe-editing-workflow) next time.

**The AI doesn't see a change I made in Construct 3 or with git.**
Reconnect the server (Claude Code: `/mcp` > `construct3` > **Reconnect**). The lists of objects, sheets and layouts are read once at start.

**`Object "Player" already exists` right after I undid the session with git.**
The server still has the lists from before the undo. Reconnect it, see [Undoing a session](#undoing-a-session).

**`validate_project` says valid, but the event is wrong or Construct 3 complains.**
`valid: true` is not a guarantee. Action and condition ids, parameter keys and most expression syntax are not checked. Open the project and look at the new events. Read the `warnings` too.

**`validate_project` says `valid: false`, but `summary.errors` is 0.**
A registered file over the 10 MB read limit, usually a large layout, was not checked (`unscanned-file` warning). `complete` is `false` and `unscannedFiles` names the file. See [Limits](#limits).

**npm reports vulnerabilities after installing.**
See [Install](#install). Most come from test tools and from HTTP parts of the MCP SDK that this stdio server never loads; `npm audit fix` is not needed.

**Can the AI read the Construct 3 manual?**
Only links. Paste the relevant text into the chat, or rely on `construct3://docs/pitfalls`.

**How do I use a third-party addon?**
Install it and add one object that uses the addon in the Construct 3 editor, save, close, and reconnect the server. Don't let the AI use `register_addon` for it: that only adds the name to the project's addon list and installs nothing. Global objects (Mouse, Keyboard, Audio, AJAX and similar) exist once per project and are never placed on a layout.

## Limits

- Folder projects only. `.c3p` files cannot be opened (`pack_project` can write one).
- One project per server process.
- Construct 3 does not see changes while the project is open. Close it before, or close without saving and reopen after.
- No check of condition and action ids, parameter names or full expression syntax. Only the editor load-time rules listed under [`validate_project`](API.md#validate_project) are checked.
- Renames do not update event sheets. A layer renamed with `update_layer` (issue #38) or an event variable renamed with `update_event_variable` is still named by its old name wherever events use it. `rename_animation` does rename the frame image files and the layout instances' start animation, like the editor, but not text in events that names the animation. Objects, families, event sheets, layouts and timelines cannot be renamed by the server.
- Files whose new JSON would be larger than 5 MB (very large layouts or event sheets) cannot be written; the write is refused with `Generated JSON for "..." is too large`.
- Layout, object type, event sheet and family files larger than 10 MB are not read. `validate_project` reports each one as an `unscanned-file` warning and returns `"complete": false` and `"valid": false`: duplicate UIDs and SIDs, broken references and load-time errors inside such a file are not reported. New UIDs still go above the UIDs in a large layout or object type, because the server scans that file as text, but the scan reads the whole file again for the first new UID or SID after each write (one to two seconds per call for a 150 MB layout). Tools that edit the large file itself, such as `add_instance_to_layout` on that layout, report it as not found. The reference checks of the delete and update tools search such a layout, event sheet or family file, and one that is not valid JSON, as text for the names they look for (`delete_object` and `delete_family` refuse without `force` when the object type's or family's own file is such a file, since its SID is unknown): a match, or a file that cannot be read at all, refuses without `force` as a possible use (see [When the server says no](#when-the-server-says-no)). `find_orphaned_objects` and `get_object_dependencies` list the objects such a file names as possibly used (`possiblyUsed`, `possiblyUsedObjects`, `possiblyReferencedIn`) instead of unused. The search reads the file again on every such call, up to its end unless it finds everything earlier (about 0.1 seconds for 50 MB, up to about 0.3 seconds when a name is common inside other names), and finds names, not uses: a name in another string refuses needlessly, and a name built at runtime is not found. Instances in such a layout are not updated when a behavior of their object changes; the tools warn about it. Version 1.9.1 and older did not search these files: there, `delete_object` without `force` deleted an object whose only instances were in a layout over 10 MB, without a warning. Details are under "File too large" in [TROUBLESHOOTING.md](TROUBLESHOOTING.md#file-too-large--exceeds-10mb-limit).
- Sprite frames inserted or deleted by index with version 1.9.0 or older can show their neighbour's image or have none, because those versions did not move the frame images. `validate_project` finds only part of this: after such an insert the last frame has no image file (`frame-image` warning), after such a delete a file past the last frame is left over (`frame-image` info). Frames that show their neighbour's image are not reported, and after a delete followed by an append nothing is reported at all. Check such animations in the editor; the image an old insert wrote over cannot be recovered from the project folder. [TROUBLESHOOTING.md](TROUBLESHOOTING.md#sprite-frames-show-the-wrong-image-or-validate_project-reports-frame-image) explains the repair. From 1.9.1 on, the frame tools move the images with their frames (see [.bak files](#bak-files)).
- New instances get sequential UIDs. The server ignores the project setting *UID numbering: Random*, which Scirra recommends for teams, so avoid placing instances with the server on two branches at the same time.
- Third-party addons must be installed and added in the editor; `register_addon` only edits the addon list.
- The documentation resources only return links to the Construct 3 manual.
- The runtime tools need Node.js 22 or later and Chrome or Edge, start from an export or the editor's preview (the server cannot export), and the bridge must be removed before you ship.
- Windsurf / Devin Desktop allows 100 tools in total; this server uses 83 of them.
