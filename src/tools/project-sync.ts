/**
 * Every tool call, resource read and prompt starts from the project as it is
 * on disk (#51): the handlers registered through withProjectSync() run as one
 * tool call scope (disk-state.ts) and first let the reader check
 * project.c3proj (Construct3ProjectReader.checkProjectFile); the files its
 * caches hold are checked when the call first uses them (ensureCachesFresh).
 * In the scope the writer backs each file up once, with its state from before
 * the call, and refuses to write a file that changed on disk after the call
 * read it.
 */

import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import { runInToolCall } from '../construct3/disk-state.js';
import { toolError } from './shared.js';

/** The registration methods whose last argument is the handler (McpServer and the test double). */
const TOOL_METHODS = new Set(['tool', 'registerTool']);
const OTHER_METHODS = new Set(['resource', 'registerResource', 'prompt', 'registerPrompt']);
const SYNCED = Symbol('construct3-mcp.projectSync');

/**
 * A view of `server` whose tool, resource and prompt registrations sync the
 * project with the disk before each call. A tool whose sync fails (the
 * project file changed and cannot be read) returns the reason as a tool
 * error; a resource read or prompt throws it. Wrapping a view again returns
 * it unchanged.
 */
export function withProjectSync<S extends object>(server: S, reader: Construct3ProjectReader): S {
  if ((server as Record<symbol, unknown>)[SYNCED]) return server;
  return new Proxy(server, {
    get(target, prop) {
      if (prop === SYNCED) return true;
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const isTool = typeof prop === 'string' && TOOL_METHODS.has(prop);
      if (!isTool && !(typeof prop === 'string' && OTHER_METHODS.has(prop))) return value.bind(target);
      return (...args: unknown[]) => {
        const last = args.length - 1;
        const handler = args[last];
        if (typeof handler === 'function') {
          args[last] = syncedHandler(handler as (...a: unknown[]) => unknown, reader, isTool);
        }
        return value.apply(target, args);
      };
    },
  });
}

function syncedHandler(
  handler: (...args: unknown[]) => unknown,
  reader: Construct3ProjectReader,
  isTool: boolean,
): (...args: unknown[]) => Promise<unknown> {
  return (...args: unknown[]) => runInToolCall(async () => {
    try {
      await reader.checkProjectFile();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTool) return toolError(message);
      throw new Error(message);
    }
    return handler(...args);
  });
}
