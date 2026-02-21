/**
 * Mutation tools orchestrator.
 * Delegates to domain-specific modules that register tools on the MCP server.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { Construct3ProjectWriter } from '../construct3/project-writer.js';
import type { IdGenerator } from '../construct3/id-generator.js';
import { registerObjectTools } from './object-tools.js';
import { registerEventTools } from './event-tools.js';
import { registerLayoutTools } from './layout-tools.js';
import { registerProjectTools } from './project-tools.js';
import { registerAnimationTools } from './animation-tools.js';

export function registerMutationTools(
  server: McpServer,
  reader: Construct3ProjectReader,
  writer: Construct3ProjectWriter,
  idGen: IdGenerator,
) {
  const deps = { server, reader, writer, idGen };
  registerObjectTools(deps);
  registerEventTools(deps);
  registerLayoutTools(deps);
  registerProjectTools(deps);
  registerAnimationTools(deps);
}
