/**
 * Runtime control tools for Construct 3 games.
 *
 * These tools bridge the gap between static project manipulation and
 * live game control. They work with any desktop automation tool (Playwright,
 * curl, etc.) to interact with a running C3 preview via an injected bridge
 * script.
 *
 * Generic — not tied to any specific game or addon.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { Construct3ProjectWriter } from '../construct3/project-writer.js';
import { generateBridgeScript, getBridgeScriptPath } from '../runtime/bridge.js';
import { writeFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { toolResult, toolError, boundedRecord } from './shared.js';
import { writeZip } from '../runtime/zip-writer.js';

const BRIDGE_FILENAME = 'c3-runtime-bridge.js';

interface RuntimeToolDeps {
  server: McpServer;
  reader: Construct3ProjectReader;
  writer: Construct3ProjectWriter;
}

/**
 * C3 projects register scripts in rootFileFolders.script.items[].
 * Each entry has: { name, type: "application/javascript", sid, "file-info": { purpose: "none" } }
 */
interface C3ScriptEntry {
  name: string;
  type: string;
  sid: number;
  'file-info': { purpose: string };
}

function findBridgeInScripts(c3proj: Record<string, unknown>): boolean {
  const rff = c3proj.rootFileFolders as Record<string, { items?: C3ScriptEntry[] }> | undefined;
  const scripts = rff?.script?.items ?? [];
  return scripts.some((s) => s.name === BRIDGE_FILENAME);
}

function addBridgeToScripts(c3proj: Record<string, unknown>): void {
  const rff = c3proj.rootFileFolders as Record<string, { items?: C3ScriptEntry[]; subfolders?: unknown[] }>;
  if (!rff.script) {
    rff.script = { items: [], subfolders: [] };
  }
  if (!rff.script.items) {
    rff.script.items = [];
  }
  // Generate a random SID matching C3's pattern (15-digit number)
  const sid = Math.floor(Math.random() * 900_000_000_000_000) + 100_000_000_000_000;
  rff.script.items.push({
    name: BRIDGE_FILENAME,
    type: 'application/javascript',
    sid,
    'file-info': { purpose: 'none' },
  });
}

function removeBridgeFromScripts(c3proj: Record<string, unknown>): void {
  const rff = c3proj.rootFileFolders as Record<string, { items?: C3ScriptEntry[] }> | undefined;
  if (rff?.script?.items) {
    rff.script.items = rff.script.items.filter((s) => s.name !== BRIDGE_FILENAME);
  }
}

export function registerRuntimeTools({ server, reader, writer }: RuntimeToolDeps) {

  // ── inject_runtime_bridge ─────────────────────────────────

  server.tool(
    'inject_runtime_bridge',
    'Inject the C3 runtime bridge script into the project. This enables external automation tools (Playwright, browser console, curl) to control the running game via globalThis.__c3bridge. The bridge script auto-runs via runOnStartup() and processes commands each tick.',
    {},
    async () => {
      try {
        const projectDir = reader.getProjectDir();
        const bridgePath = join(projectDir, getBridgeScriptPath());
        const bridgeDir = dirname(bridgePath);

        // Ensure scripts directory exists
        if (!existsSync(bridgeDir)) {
          await mkdir(bridgeDir, { recursive: true });
        }

        // Write the bridge script
        await writeFile(bridgePath, generateBridgeScript(), 'utf-8');

        // Register in project.c3proj (rootFileFolders.script.items)
        const c3projPath = reader.getProjectPath();
        const c3projRaw = await readFile(c3projPath, 'utf-8');
        const c3proj = JSON.parse(c3projRaw);

        if (!findBridgeInScripts(c3proj)) {
          addBridgeToScripts(c3proj);
          await writeFile(c3projPath, JSON.stringify(c3proj, null, '\t'), 'utf-8');
          await reader.loadProject();

          return toolResult({
            injected: true,
            path: bridgePath,
            registered: true,
            message: 'Runtime bridge injected and registered in project.c3proj. The bridge will activate when the game starts via runOnStartup().',
          });
        }

        return toolResult({
          injected: true,
          path: bridgePath,
          registered: false,
          message: 'Runtime bridge script updated (was already registered in project.c3proj).',
        });
      } catch (error) {
        console.error('[inject_runtime_bridge] failed:', error);
        return toolError(`Failed to inject runtime bridge: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── remove_runtime_bridge ─────────────────────────────────

  server.tool(
    'remove_runtime_bridge',
    'Remove the runtime bridge script from the project. Use this to clean up after testing.',
    {},
    async () => {
      try {
        const projectDir = reader.getProjectDir();
        const bridgePath = join(projectDir, getBridgeScriptPath());

        // Remove the file
        const { unlink } = await import('node:fs/promises');
        try {
          await unlink(bridgePath);
        } catch {
          // File might not exist
        }

        // Remove from project.c3proj
        const c3projPath = reader.getProjectPath();
        const c3projRaw = await readFile(c3projPath, 'utf-8');
        const c3proj = JSON.parse(c3projRaw);

        removeBridgeFromScripts(c3proj);
        await writeFile(c3projPath, JSON.stringify(c3proj, null, '\t'), 'utf-8');
        await reader.loadProject();

        return toolResult({
          removed: true,
          message: 'Runtime bridge removed from project.',
        });
      } catch (error) {
        console.error('[remove_runtime_bridge] failed:', error);
        return toolError(`Failed to remove runtime bridge: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── get_bridge_commands ───────────────────────────────────

  server.tool(
    'get_bridge_commands',
    'List all commands supported by the C3 runtime bridge. Use this to understand what you can do with call_bridge_command.',
    {},
    async () => {
      const commands = {
        ping: {
          description: 'Health check — returns { pong: true, time: <timestamp> }',
          args: {},
        },
        callFunction: {
          description: 'Call a C3 event sheet function by name',
          args: { name: 'string (function name)', params: 'array (optional parameters)' },
        },
        getGlobalVar: {
          description: 'Read a global variable value',
          args: { name: 'string (variable name)' },
        },
        setGlobalVar: {
          description: 'Set a global variable value',
          args: { name: 'string (variable name)', value: 'any (new value)' },
        },
        getObjectState: {
          description: 'Read properties from the first instance of an object type',
          args: {
            objectName: 'string (object type name)',
            properties: 'string[] (optional — defaults to x, y, width, height, isVisible, opacity)',
          },
        },
        getAllInstances: {
          description: 'List all instances of an object type (position, uid, visibility)',
          args: { objectName: 'string', limit: 'number (default 50)' },
        },
        getLayout: {
          description: 'Get current layout info (name, size, layers)',
          args: {},
        },
        goToLayout: {
          description: 'Navigate to a different layout',
          args: { name: 'string (layout name)' },
        },
        evaluateExpression: {
          description: 'Read a plugin expression from an object instance',
          args: {
            objectName: 'string (object type name, e.g. "MyPlugin")',
            expression: 'string (property/expression name on the instance)',
          },
        },
        listObjects: {
          description: 'List all object type names in the runtime',
          args: {},
        },
        listGlobalVars: {
          description: 'List all global variables and their current values',
          args: {},
        },
      };

      return toolResult(commands);
    },
  );

  // ── generate_bridge_eval_script ───────────────────────────

  server.tool(
    'generate_bridge_eval_script',
    'Generate a shell command (using curl or python) to execute a bridge command in the running C3 game. The command interacts with the game via the browser remote debugging protocol.',
    {
      command: z.string().describe('Bridge command type (e.g. "callFunction", "getGlobalVar", "getObjectState")'),
      args: boundedRecord().optional().describe('Command arguments as key-value pairs (max 100 keys, depth 6)'),
    },
    async ({ command, args }) => {
      const bridgeCmd = JSON.stringify({ type: command, args: args ?? {} });

      // Generate a Python script that:
      // 1. Connects to Firefox CDP on localhost:9222
      // 2. Submits a command to __c3bridge
      // 3. Polls for the result
      const pythonScript = `
import json, time

# Submit command via __c3bridge
BRIDGE_CMD = ${JSON.stringify(bridgeCmd)}

# JavaScript to run in the browser
js_submit = f"""
(function() {{
  if (!globalThis.__c3bridge) return JSON.stringify({{error: "bridge not loaded"}});
  const id = globalThis.__c3bridge.submit({BRIDGE_CMD}.type, {BRIDGE_CMD}.args);
  return JSON.stringify({{id: id}});
}})()
"""

js_poll = """
(function(id) {
  if (!globalThis.__c3bridge) return JSON.stringify({error: "bridge not loaded"});
  const r = globalThis.__c3bridge.getResult(id);
  return r ? JSON.stringify(r) : JSON.stringify({pending: true});
})(%d)
"""

# Run this script in any environment with access to the browser CDP endpoint.
# Start Firefox/Chrome with: --remote-debugging-port=9222
# The actual CDP communication depends on the runtime bridge setup.
print(json.dumps({
  "js_submit": js_submit.strip(),
  "js_poll_template": js_poll.strip(),
  "bridge_command": json.loads(BRIDGE_CMD),
  "usage": "Execute js_submit in the browser console, get the returned id, then execute js_poll with that id"
}))
`.trim();

      return toolResult({
        command,
        args: args ?? {},
        pythonScript,
        manualUsage: {
          step1: `In Firefox DevTools console: globalThis.__c3bridge.submit("${command}", ${JSON.stringify(args ?? {})})`,
          step2: 'Note the returned ID (e.g., 1)',
          step3: 'globalThis.__c3bridge.getResult(1)',
        },
      });
    },
  );

  // ── export_for_preview ────────────────────────────────────

  server.tool(
    'export_for_preview',
    'Prepare the C3 project for preview testing. Ensures the runtime bridge is injected and worker mode is set to "dom" (required for globalThis access). Returns info needed to serve and open the project.',
    {
      injectBridge: z.boolean().optional().default(true).describe('Whether to inject the runtime bridge script'),
    },
    async ({ injectBridge }) => {
      try {
        const projectDir = reader.getProjectDir();
        const metadata = reader.getMetadata();
        const projectData = reader.getProject();

        const checks: Array<{ check: string; status: string; detail?: string }> = [];

        // Check worker mode
        const useWorker = projectData.useWorker ?? 'auto';
        if (useWorker !== 'dom' && useWorker !== 'no') {
          checks.push({
            check: 'workerMode',
            status: 'warning',
            detail: `useWorker is "${useWorker}" — should be "dom" for runtime bridge access. Set to "dom" in project settings.`,
          });
        } else {
          checks.push({ check: 'workerMode', status: 'ok' });
        }

        // Inject bridge if requested
        if (injectBridge) {
          const bridgePath = join(projectDir, getBridgeScriptPath());
          const bridgeDir = dirname(bridgePath);

          if (!existsSync(bridgeDir)) {
            await mkdir(bridgeDir, { recursive: true });
          }

          await writeFile(bridgePath, generateBridgeScript(), 'utf-8');

          // Register in c3proj if needed
          const c3projPath = reader.getProjectPath();
          const c3projRaw = await readFile(c3projPath, 'utf-8');
          const c3proj = JSON.parse(c3projRaw);

          if (!findBridgeInScripts(c3proj)) {
            addBridgeToScripts(c3proj);
            await writeFile(c3projPath, JSON.stringify(c3proj, null, '\t'), 'utf-8');
            await reader.loadProject();
          }

          checks.push({ check: 'runtimeBridge', status: 'ok' });
        }

        return toolResult({
          projectName: metadata.name,
          projectDir,
          runtime: projectData.runtime ?? 'c3',
          useWorker,
          checks,
          nextSteps: [
            'Open the project in Construct 3 editor (construct.net)',
            'Click Preview to launch the game',
            'The runtime bridge will activate via runOnStartup()',
            'Access via: globalThis.__c3bridge.submit("ping", {})',
            'Or use Playwright or any CDP-capable tool to automate the entire flow',
          ],
        });
      } catch (error) {
        console.error('[export_for_preview] failed:', error);
        return toolError(`Failed to prepare for preview: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── clone_project ─────────────────────────────────────────

  server.tool(
    'clone_project',
    'Clone the current C3 project to a new directory. Useful for creating test copies without modifying the original.',
    {
      targetDir: z.string().describe('Target directory for the cloned project'),
      includeBridge: z.boolean().optional().default(true).describe('Include the runtime bridge in the clone'),
    },
    async ({ targetDir, includeBridge }) => {
      try {
        const sourceDir = reader.getProjectDir();
        const { cp } = await import('node:fs/promises');

        await cp(sourceDir, targetDir, { recursive: true });

        if (includeBridge) {
          const bridgePath = join(targetDir, getBridgeScriptPath());
          const bridgeDir = dirname(bridgePath);
          if (!existsSync(bridgeDir)) {
            await mkdir(bridgeDir, { recursive: true });
          }
          await writeFile(bridgePath, generateBridgeScript(), 'utf-8');

          // Register bridge in cloned project
          const { readFile: rf, writeFile: wf, readdir } = await import('node:fs/promises');
          const c3projFiles = (await readdir(targetDir)).filter(f => f.endsWith('.c3proj'));
          if (c3projFiles.length > 0) {
            const c3projPath = join(targetDir, c3projFiles[0]);
            const raw = await rf(c3projPath, 'utf-8');
            const c3proj = JSON.parse(raw);
            if (!findBridgeInScripts(c3proj)) {
              addBridgeToScripts(c3proj);
              await wf(c3projPath, JSON.stringify(c3proj, null, '\t'), 'utf-8');
            }
          }
        }

        return toolResult({
          cloned: true,
          source: sourceDir,
          target: targetDir,
          bridgeIncluded: includeBridge,
        });
      } catch (error) {
        console.error('[clone_project] failed:', error);
        return toolError(`Failed to clone project: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── pack_project ──────────────────────────────────────────

  server.tool(
    'pack_project',
    'Pack the C3 project folder into a .c3p file (zip archive). The .c3p can be opened directly in the Construct 3 editor. Optionally injects the runtime bridge before packing.',
    {
      outputPath: z.string().describe('Output path for the .c3p file (e.g. "/tmp/game.c3p")'),
      injectBridge: z.boolean().optional().default(true).describe('Inject the runtime bridge before packing'),
    },
    async ({ outputPath, injectBridge }) => {
      try {
        const projectDir = reader.getProjectDir();

        // Optionally inject bridge first
        if (injectBridge) {
          const bridgePath = join(projectDir, getBridgeScriptPath());
          const bridgeDir = dirname(bridgePath);
          if (!existsSync(bridgeDir)) {
            await mkdir(bridgeDir, { recursive: true });
          }
          await writeFile(bridgePath, generateBridgeScript(), 'utf-8');

          const c3projPath = reader.getProjectPath();
          const c3projRaw = await readFile(c3projPath, 'utf-8');
          const c3proj = JSON.parse(c3projRaw);
          if (!findBridgeInScripts(c3proj)) {
            addBridgeToScripts(c3proj);
            await writeFile(c3projPath, JSON.stringify(c3proj, null, '\t'), 'utf-8');
            await reader.loadProject();
          }
        }

        // Collect all project files
        const files = await collectFiles(projectDir);

        // Build the zip using Node.js built-in zlib
        // .c3p format is a standard zip file
        await buildZip(projectDir, files, outputPath);

        const outputStat = await stat(outputPath);

        return toolResult({
          packed: true,
          outputPath,
          fileCount: files.length,
          sizeBytes: outputStat.size,
          sizeMB: (outputStat.size / 1024 / 1024).toFixed(2),
          bridgeInjected: injectBridge,
        });
      } catch (error) {
        console.error('[pack_project] failed:', error);
        return toolError(`Failed to pack project: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
}


// ── File helpers ──────────────────────────────────────────

/** Directories to skip when packing a C3 project. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.bak', '__MACOSX']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * Recursively collect all files in a directory, returning paths relative
 * to the root. Skips .git, node_modules, backups, and OS junk.
 */
async function collectFiles(rootDir: string, subDir = ''): Promise<string[]> {
  const results: string[] = [];
  const fullDir = subDir ? join(rootDir, subDir) : rootDir;
  const entries = await readdir(fullDir, { withFileTypes: true });

  for (const entry of entries) {
    if (SKIP_FILES.has(entry.name)) continue;
    const relPath = subDir ? `${subDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const subFiles = await collectFiles(rootDir, relPath);
      results.push(...subFiles);
    } else if (entry.isFile()) {
      // Skip .bak files from the writer's backup system
      if (entry.name.endsWith('.bak')) continue;
      results.push(relPath);
    }
  }

  return results;
}

/**
 * Build a .c3p (ZIP) file from a project directory.
 */
async function buildZip(projectDir: string, files: string[], outputPath: string): Promise<void> {
  const entries = await Promise.all(
    files.map(async (filePath) => ({
      path: filePath.replace(/\\/g, '/'), // ensure forward slashes in zip
      data: await readFile(join(projectDir, filePath)),
    })),
  );
  await writeZip(entries, outputPath);
}
