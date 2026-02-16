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

// Require explicit project path — no process.cwd() fallback
const projectPath: string = process.argv[2] || process.env.C3_PROJECT_PATH || (() => {
  console.error('Usage: construct3-mcp <project-path>');
  console.error('  project-path: Path to a .c3proj file or directory containing one');
  console.error('  Or set C3_PROJECT_PATH environment variable');
  process.exit(1);
})();

const server = new McpServer(
  { name: 'construct3-mcp-server', version: '2.0.0' },
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
