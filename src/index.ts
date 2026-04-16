#!/usr/bin/env node

/**
 * Construct3 MCP Server
 * Model Context Protocol server for Construct 3 game engine projects
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Construct3ProjectReader } from './construct3/project-reader.js';
import { registerProjectResources } from './resources/project.js';
import { registerDocsResources } from './resources/docs.js';
import { registerQueryTools } from './tools/query.js';
import { registerWorkflowPrompts } from './prompts/workflows.js';
import { registerAnalysisTools } from './tools/analysis.js';
import { registerMutationTools } from './tools/mutations.js';
import { Construct3ProjectWriter } from './construct3/project-writer.js';
import { IdGenerator } from './construct3/id-generator.js';
import { registerRuntimeTools } from './tools/runtime-tools.js';

// Use explicit path if given, otherwise auto-detect .c3proj in current working directory
const projectPath: string = process.argv[2] || process.env.C3_PROJECT_PATH || process.cwd();

const server = new McpServer(
  { name: 'construct3-mcp-server', version: '1.8.1' },
  { capabilities: { resources: {}, tools: {}, prompts: {} } }
);

async function initializeProject(path: string): Promise<Construct3ProjectReader> {
  let projectFile = path;
  if (!path.endsWith('.c3proj')) {
    const found = await Construct3ProjectReader.findProjectFile(path);
    if (!found) {
      throw new Error(`No .c3proj file found in directory: ${path}`);
    }
    projectFile = found;
  }

  const isValid = await Construct3ProjectReader.isValidProject(projectFile);
  if (!isValid) {
    throw new Error(`Invalid Construct3 project file: ${projectFile}`);
  }

  const reader = new Construct3ProjectReader(projectFile);
  await reader.loadProject();
  console.error(`Loaded Construct3 project: ${reader.getMetadata().name}`);
  return reader;
}

async function main() {
  try {
    console.error('Construct3 MCP Server starting...');
    console.error(`Project path: ${projectPath}`);

    const reader = await initializeProject(projectPath);

    // Register all modular handlers
    registerProjectResources(server, reader);
    registerDocsResources(server);
    registerQueryTools(server, reader);
    registerWorkflowPrompts(server, reader);
    registerAnalysisTools(server, reader);

    // Phase 3: Safe Modifications
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    registerMutationTools(server, reader, writer, idGen);

    // Runtime Control (for live game testing via browser automation)
    registerRuntimeTools({ server, reader, writer });

    // Start transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error('Construct3 MCP Server ready');
  } catch (error) {
    console.error(
      `Failed to start server: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

main();
