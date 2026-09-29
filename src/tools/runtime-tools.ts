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
import { jsonTextStyleOf, parseJsonText, serializeJson } from '../construct3/json-format.js';

import { PreviewManager, isLoopbackHost } from '../runtime/preview-server.js';
import { RuntimeConnectionManager } from '../runtime/cdp-client.js';
import type { RuntimeCondition, SimulatedInputAction } from '../runtime/cdp-client.js';
/** The host part of a ws:// or wss:// endpoint, or the endpoint itself when it does not parse. */
function hostOfEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return endpoint;
  }
}

export interface RuntimeToolController {
  close(): Promise<void>;
}

const BRIDGE_COMMANDS = [
  'callFunction',
  'getGlobalVar',
  'setGlobalVar',
  'getObjectState',
  'getAllInstances',
  'getLayout',
  'goToLayout',
  'evaluateExpression',
  'layerToCssPx',
  'cssPxToLayer',
  'subscribeEvents',
  'readEvents',
  'unsubscribeEvents',
  'listObjects',
  'listGlobalVars',
  'ping',
] as const;

const conditionOperatorSchema = z.enum(['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains']);
const runtimeConditionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('globalVar'),
    name: z.string().min(1).max(200),
    operator: conditionOperatorSchema,
    value: z.unknown(),
  }),
  z.object({
    type: z.literal('objectProperty'),
    objectType: z.string().min(1).max(200),
    property: z.string().min(1).max(200),
    operator: conditionOperatorSchema,
    value: z.unknown(),
  }),
  z.object({
    type: z.literal('layout'),
    name: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal('expression'),
    expr: z.string().min(1).max(10_000).describe('JavaScript evaluated in the game page (only with C3MCP_ALLOW_EVAL=1 in the server environment)'),
    operator: conditionOperatorSchema,
    value: z.unknown(),
  }),
]).superRefine((condition, ctx) => {
  if (condition.type !== 'layout' && !Object.hasOwn(condition, 'value')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: 'value is required for this condition type',
    });
  }
});

const inputCoordinateSchema = z.number().finite().min(0).max(100_000);
const inputActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('click'),
    x: inputCoordinateSchema,
    y: inputCoordinateSchema,
    button: z.enum(['left', 'right', 'middle']).optional().default('left'),
    clickCount: z.union([z.literal(1), z.literal(2)]).optional().default(1),
  }),
  z.object({
    type: z.literal('touch'),
    x: inputCoordinateSchema,
    y: inputCoordinateSchema,
    gesture: z.enum(['tap', 'longPress', 'swipe']),
    endX: inputCoordinateSchema.optional(),
    endY: inputCoordinateSchema.optional(),
  }),
  z.object({
    type: z.literal('key'),
    key: z.string().min(1).max(100),
    modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).max(4).optional().default([]),
  }),
  z.object({
    type: z.literal('type'),
    text: z.string().min(1).max(1_000),
  }),
  z.object({
    type: z.literal('mouseMove'),
    x: inputCoordinateSchema,
    y: inputCoordinateSchema,
  }),
]).superRefine((action, ctx) => {
  if (action.type === 'touch' && action.gesture === 'swipe'
    && (action.endX === undefined || action.endY === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endX'],
      message: 'swipe gestures require endX and endY',
    });
  }
});

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

export function registerRuntimeTools({ server, reader, writer }: RuntimeToolDeps): RuntimeToolController {
  const connections = new RuntimeConnectionManager();
  const previews = new PreviewManager();

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
        const c3proj = parseJsonText(c3projRaw);

        if (!findBridgeInScripts(c3proj)) {
          addBridgeToScripts(c3proj);
          await writeFile(c3projPath, serializeJson(c3proj, jsonTextStyleOf(c3projRaw)), 'utf-8');
          await reader.loadProject();

          return toolResult({
            success: true,
            injected: true,
            path: bridgePath,
            registered: true,
            message: 'Runtime bridge injected and registered in project.c3proj. The bridge will activate when the game starts via runOnStartup().',
          }, { projectWritten: true });
        }

        // The bridge script inside the project folder was still rewritten
        return toolResult({
          success: true,
          injected: true,
          path: bridgePath,
          registered: false,
          message: 'Runtime bridge script updated (was already registered in project.c3proj).',
        }, { projectWritten: true });
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
        const c3proj = parseJsonText(c3projRaw);

        removeBridgeFromScripts(c3proj);
        await writeFile(c3projPath, serializeJson(c3proj, jsonTextStyleOf(c3projRaw)), 'utf-8');
        await reader.loadProject();

        return toolResult({
          success: true,
          removed: true,
          message: 'Runtime bridge removed from project.',
        }, { projectWritten: true });
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

  // ── connect_to_game ──────────────────────────────────────

  server.tool(
    'connect_to_game',
    'Connect to a running Construct game over Chrome DevTools Protocol. Provide a page WebSocket endpoint directly, or a host and debugging port to discover the first page target. The tool waits for globalThis.__c3bridge to become ready and keeps the connection for later runtime calls. Only browsers on this machine are reached, unless the server was started with C3MCP_ALLOW_REMOTE_CDP=1.',
    {
      cdpEndpoint: z.string().url().refine(
        (value) => value.startsWith('ws://') || value.startsWith('wss://'),
        'cdpEndpoint must use ws:// or wss://',
      ).optional().describe('Direct CDP page WebSocket endpoint'),
      host: z.string().min(1).max(255).optional().describe('CDP discovery host (default: localhost)'),
      port: z.number().int().min(1).max(65535).optional().describe('CDP discovery port (default: 9222)'),
      timeoutMs: z.number().int().min(100).max(60_000).optional().default(10_000)
        .describe('Maximum time to connect and wait for the runtime bridge'),
    },
    async ({ cdpEndpoint, host, port, timeoutMs }) => {
      try {
        const target = cdpEndpoint !== undefined ? hostOfEndpoint(cdpEndpoint) : (host ?? 'localhost');
        if (process.env.C3MCP_ALLOW_REMOTE_CDP !== '1' && !isLoopbackHost(target)) {
          return toolError(`Refusing to connect to "${target}": only this machine (localhost, 127.0.0.1, ::1) is allowed unless the server was started with the environment variable C3MCP_ALLOW_REMOTE_CDP=1. The runtime bridge runs script in whatever page it reaches.`);
        }
        const connected = await connections.connect({ cdpEndpoint, host, port, timeoutMs });
        return toolResult(connected, { projectWritten: false });
      } catch (error) {
        console.error('[connect_to_game] failed:', error);
        return toolError(`Failed to connect to game: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── disconnect_from_game ─────────────────────────────────

  server.tool(
    'disconnect_from_game',
    'Close a persistent game connection created by connect_to_game.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
    },
    async ({ connectionId }) => {
      try {
        const stopped = await connections.disconnect(connectionId);
        if (!stopped) return toolError(`Unknown or closed connection: ${connectionId}`);
        return toolResult({ connectionId, disconnected: true }, { projectWritten: false });
      } catch (error) {
        console.error('[disconnect_from_game] failed:', error);
        return toolError(`Failed to disconnect from game: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── call_bridge ──────────────────────────────────────────

  server.tool(
    'call_bridge',
    'Execute a command through the injected Construct runtime bridge using a persistent CDP connection. The tool submits the command, polls for its result, and returns the command ID, value, and elapsed time.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
      command: z.enum(BRIDGE_COMMANDS).describe('Runtime bridge command to execute'),
      args: boundedRecord().optional().describe('Command-specific arguments (max 100 keys, depth 6)'),
      pollIntervalMs: z.number().int().min(10).max(1_000).optional().default(50)
        .describe('Delay between bridge result polls'),
      timeoutMs: z.number().int().min(100).max(60_000).optional().default(5_000)
        .describe('Maximum time for the bridge command'),
    },
    async ({ connectionId, command, args, pollIntervalMs, timeoutMs }) => {
      try {
        const result = await connections.callBridge({
          connectionId,
          command,
          args: args ?? {},
          pollIntervalMs,
          timeoutMs,
        });
        return toolResult(result, { projectWritten: false });
      } catch (error) {
        console.error('[call_bridge] failed:', error);
        return toolError(`Failed to call runtime bridge: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // -- subscribe_events / read_events / unsubscribe_events --

  // The bridge answers a bad subscription id with { error } rather than throwing; that is a failure here.
  const subscriptionCall = async (connectionId: string, command: string, args: Record<string, unknown>) => {
    const result = (await connections.callBridge({ connectionId, command, args, pollIntervalMs: 50, timeoutMs: 5_000 })).result as Record<string, unknown> | null;
    if (result && typeof result.error === 'string') throw new Error(result.error);
    return result ?? {};
  };

  server.tool(
    'subscribe_events',
    'Start observing a running game through its bridge: changes of one global variable, changes of the current layout, or custom events the game\'s script emits with globalThis.__c3bridge.emit(name, data). Events go into a bounded per-subscription buffer (oldest dropped when full) read by read_events, so a test can see what happened between polls.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
      eventType: z.enum(['globalVarChange', 'layoutChange', 'custom']).describe('What to observe'),
      filter: z.object({
        variable: z.string().min(1).max(200).optional().describe('For globalVarChange: the global variable to watch (required)'),
        name: z.string().min(1).max(200).optional().describe('For custom: only events emitted with this name (default: every custom event)'),
      }).strict().optional().describe('What to filter on, by event type'),
      bufferSize: z.number().int().min(1).max(1_000).optional().default(100).describe('Events kept per subscription; the oldest is dropped when full (default 100)'),
    },
    async ({ connectionId, eventType, filter, bufferSize }) => {
      try {
        if (eventType === 'globalVarChange' && !filter?.variable) {
          return toolError('subscribe_events with eventType "globalVarChange" needs filter.variable, the global variable to watch.');
        }
        const result = await subscriptionCall(connectionId, 'subscribeEvents', { eventType, filter: filter ?? {}, bufferSize });
        return toolResult({ subscription_id: result.subscription_id, eventType, filter: filter ?? {}, bufferSize }, { projectWritten: false });
      } catch (error) {
        console.error('[subscribe_events] failed:', error);
        return toolError(`Failed to subscribe: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    'read_events',
    'Read the events a subscription buffered since the last read, oldest first: { type, name, value, previousValue (global and layout changes), timestamp, tick }. Clears the buffer unless clear is false.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
      subscriptionId: z.string().min(1).max(100).describe('The subscription_id returned by subscribe_events'),
      clear: z.boolean().optional().default(true).describe('Empty the buffer after reading (default true); false leaves the events for a later read'),
    },
    async ({ connectionId, subscriptionId, clear }) => {
      try {
        const result = await subscriptionCall(connectionId, 'readEvents', { subscriptionId, clear });
        return toolResult({ events: result.events, count: result.count }, { projectWritten: false });
      } catch (error) {
        console.error('[read_events] failed:', error);
        return toolError(`Failed to read events: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    'unsubscribe_events',
    'Stop a subscription and release its buffer. An unknown subscription is an error, not a silent success.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
      subscriptionId: z.string().min(1).max(100).describe('The subscription_id returned by subscribe_events'),
    },
    async ({ connectionId, subscriptionId }) => {
      try {
        const result = await subscriptionCall(connectionId, 'unsubscribeEvents', { subscriptionId });
        return toolResult({ subscription_id: result.subscription_id, unsubscribed: result.unsubscribed === true }, { projectWritten: false });
      } catch (error) {
        console.error('[unsubscribe_events] failed:', error);
        return toolError(`Failed to unsubscribe: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── wait_for_condition ───────────────────────────────────

  server.tool(
    'wait_for_condition',
    'Poll a running game until a global variable, object property, layout name, or browser expression matches a target. Checks immediately, returns the last value on timeout, and does not throw merely because the condition was not met. The "expression" type runs the given JavaScript in the game page with the page\'s full rights; it is refused unless the server was started with the environment variable C3MCP_ALLOW_EVAL=1.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
      condition: runtimeConditionSchema.describe('Condition to evaluate on each poll'),
      pollIntervalMs: z.number().int().min(10).max(5_000).optional().default(100)
        .describe('Delay between condition checks'),
      timeoutMs: z.number().int().min(100).max(120_000).optional().default(30_000)
        .describe('Maximum time to wait before returning met: false'),
    },
    async ({ connectionId, condition, pollIntervalMs, timeoutMs }) => {
      try {
        const result = await connections.waitForCondition({
          connectionId,
          condition: condition as RuntimeCondition,
          pollIntervalMs,
          timeoutMs,
        });
        return toolResult({
          met: result.met,
          elapsed_ms: result.elapsedMs,
          final_value: result.finalValue,
        }, { projectWritten: false });
      } catch (error) {
        console.error('[wait_for_condition] failed:', error);
        return toolError(`Failed to wait for condition: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── simulate_input ───────────────────────────────────────

  server.tool(
    'simulate_input',
    'Send mouse, touch, keyboard, or text input to a connected game through the Chrome DevTools Protocol Input domain. Coordinates are CSS pixels relative to the page viewport by default; with coordinateSpace "canvas" they are CSS pixels relative to the game canvas top-left and are offset by the canvas position; with coordinateSpace "layout" they are layout coordinates on a layer, converted by the game itself (scaling, letterboxing and the canvas offset included) through the bridge. Use get_canvas_size to read the canvas geometry.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
      action: inputActionSchema.describe('Input action to dispatch'),
      delayMs: z.number().int().min(0).max(60_000).optional().default(0)
        .describe('Delay before dispatching the input action'),
      coordinateSpace: z.enum(['viewport', 'canvas', 'layout']).optional().default('viewport')
        .describe('Whether x/y (and endX/endY) are page-viewport CSS pixels, game-canvas CSS pixels, or layout coordinates on a layer'),
      layer: z.union([z.string().max(200), z.number().int().min(0)]).optional()
        .describe('For coordinateSpace "layout": the layer name or index whose coordinates x/y are in (default: layer 0)'),
    },
    async ({ connectionId, action, delayMs, coordinateSpace, layer }) => {
      try {
        const result = await connections.simulateInput({
          connectionId,
          action: action as SimulatedInputAction,
          delayMs,
          coordinateSpace,
          layer,
        });
        return toolResult(result, { projectWritten: false });
      } catch (error) {
        console.error('[simulate_input] failed:', error);
        return toolError(`Failed to simulate input: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── get_canvas_size ──────────────────────────────────────

  server.tool(
    'get_canvas_size',
    'Read the connected game canvas geometry: its CSS-pixel position and size in the page viewport, its backing-store pixel size, the device pixel ratio, and the viewport size. Use it to choose coordinates for simulate_input.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
    },
    async ({ connectionId }) => {
      try {
        return toolResult(await connections.getCanvasGeometry(connectionId), { projectWritten: false });
      } catch (error) {
        console.error('[get_canvas_size] failed:', error);
        return toolError(`Failed to read canvas size: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── screenshot_game ──────────────────────────────────────

  server.tool(
    'screenshot_game',
    'Capture the connected game page, or only its canvas, as a PNG or JPEG file on disk, so a run can keep visual evidence of a state without an editor or a browser tool.',
    {
      connectionId: z.string().uuid().describe('Connection ID returned by connect_to_game'),
      outputPath: z.string().min(1).max(4096).describe('File to write (e.g. "C:/runs/after-click.png")'),
      format: z.enum(['png', 'jpeg']).optional().default('png').describe('Image format (default: png)'),
      quality: z.number().int().min(0).max(100).optional().describe('JPEG quality 0-100 (jpeg only)'),
      canvasOnly: z.boolean().optional().default(false).describe('Capture only the game canvas rectangle (default: the whole viewport)'),
    },
    async ({ connectionId, outputPath, format, quality, canvasOnly }) => {
      try {
        const shot = await connections.captureScreenshot({ connectionId, format, quality, canvasOnly });
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, shot.data);
        return toolResult({ success: true, path: outputPath, bytes: shot.data.length, format: shot.format, clip: shot.clip }, { projectWritten: false });
      } catch (error) {
        console.error('[screenshot_game] failed:', error);
        return toolError(`Failed to capture a screenshot: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // ── serve_preview / stop_preview ─────────────────────────

  // Registered with a strict schema: the listening interface and the browser
  // executable are the operator's settings, so a call that names them (as the
  // first version of this tool allowed) is refused instead of silently
  // ignored.
  server.registerTool(
    'serve_preview',
    {
      description: 'Serve an exported Construct game (the HTML5 export folder that holds index.html) over HTTP on this machine (127.0.0.1 only), and optionally launch Chrome or Edge on it with a fresh profile and a remote-debugging port the browser picks itself, so connect_to_game can follow (the result names the port and the page endpoint). The browser comes from the CHROME_PATH environment variable or the usual install locations. A source project folder or a .c3p is refused: Construct exports only from its editor.',
      inputSchema: z.object({
        folder: z.string().min(1).max(4096).describe('The exported game folder (contains index.html)'),
        port: z.number().int().min(0).max(65535).optional().default(0).describe('HTTP port on 127.0.0.1 (default 0: any free port)'),
        crossOriginIsolated: z.boolean().optional().default(false).describe('Send COOP same-origin and COEP require-corp so the game gets SharedArrayBuffer (default: false; require-corp blocks resources from other origins that do not allow it, such as a CDN script)'),
        launchBrowser: z.boolean().optional().default(false).describe('Launch Chrome (or Edge) on the served URL with a remote-debugging port (default: false)'),
        headless: z.boolean().optional().default(false).describe('Launch the browser headless with software WebGL (default: false, a visible window)'),
        windowWidth: z.number().int().min(100).max(10_000).optional().describe('Browser window width in pixels'),
        windowHeight: z.number().int().min(100).max(10_000).optional().describe('Browser window height in pixels'),
        readyTimeoutMs: z.number().int().min(1000).max(120_000).optional().default(15_000).describe('How long to wait for the browser\'s debugging port (default: 15000)'),
      }).strict(),
    },
    async (args) => {
      try {
        const info = await previews.serve({
          folder: args.folder,
          port: args.port,
          crossOriginIsolated: args.crossOriginIsolated,
          launch: args.launchBrowser ? {
            headless: args.headless,
            windowWidth: args.windowWidth,
            windowHeight: args.windowHeight,
            readyTimeoutMs: args.readyTimeoutMs,
          } : undefined,
        });
        return toolResult({
          success: true,
          ...info,
          next: info.browser
            ? `connect_to_game with ${info.browser.pageEndpoint ? `cdpEndpoint "${info.browser.pageEndpoint}"` : `host "127.0.0.1" and port ${info.browser.cdpPort}`}; the game must carry the runtime bridge (inject_runtime_bridge before the export).`
            : `Open ${info.url} in a browser started with --remote-debugging-port, then connect_to_game; or call again with launchBrowser: true.`,
        }, { projectWritten: false });
      } catch (error) {
        console.error('[serve_preview] failed:', error);
        return toolError(`Failed to serve the preview: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    'stop_preview',
    'Stop a preview server started by serve_preview, closing the browser it launched. Without serverId, stops every preview server this MCP server holds.',
    {
      serverId: z.string().uuid().optional().describe('The serverId returned by serve_preview (default: all)'),
    },
    async ({ serverId }) => {
      try {
        if (serverId === undefined) {
          const stopped = previews.list();
          await previews.closeAll();
          return toolResult({ success: true, stopped }, { projectWritten: false });
        }
        const stopped = await previews.stop(serverId);
        return toolResult({ success: true, stopped: [stopped] }, { projectWritten: false });
      } catch (error) {
        console.error('[stop_preview] failed:', error);
        return toolError(`Failed to stop the preview: ${error instanceof Error ? error.message : String(error)}`);
      }
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
          const c3proj = parseJsonText(c3projRaw);

          if (!findBridgeInScripts(c3proj)) {
            addBridgeToScripts(c3proj);
            await writeFile(c3projPath, serializeJson(c3proj, jsonTextStyleOf(c3projRaw)), 'utf-8');
            await reader.loadProject();
          }

          checks.push({ check: 'runtimeBridge', status: 'ok' });
        }

        return toolResult({
          success: true,
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
        }, { projectWritten: injectBridge });
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
            const c3proj = parseJsonText(raw);
            if (!findBridgeInScripts(c3proj)) {
              addBridgeToScripts(c3proj);
              await wf(c3projPath, serializeJson(c3proj, jsonTextStyleOf(raw)), 'utf-8');
            }
          }
        }

        // Only the new copy was written, not the open project
        return toolResult({
          success: true,
          cloned: true,
          source: sourceDir,
          target: targetDir,
          bridgeIncluded: includeBridge,
        }, { projectWritten: false });
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
          const c3proj = parseJsonText(c3projRaw);
          if (!findBridgeInScripts(c3proj)) {
            addBridgeToScripts(c3proj);
            await writeFile(c3projPath, serializeJson(c3proj, jsonTextStyleOf(c3projRaw)), 'utf-8');
            await reader.loadProject();
          }
        }

        // Collect all project files
        const files = await collectFiles(projectDir);

        // Build the zip using Node.js built-in zlib
        // .c3p format is a standard zip file
        await buildZip(projectDir, files, outputPath);

        const outputStat = await stat(outputPath);

        // The .c3p goes outside the project; only bridge injection writes to it
        return toolResult({
          success: true,
          packed: true,
          outputPath,
          fileCount: files.length,
          sizeBytes: outputStat.size,
          sizeMB: (outputStat.size / 1024 / 1024).toFixed(2),
          bridgeInjected: injectBridge,
        }, { projectWritten: injectBridge });
      } catch (error) {
        console.error('[pack_project] failed:', error);
        return toolError(`Failed to pack project: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  return {
    close: async () => {
      await connections.closeAll();
      await previews.closeAll();
    },
  };
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
