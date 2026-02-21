/**
 * Mock MCP server that captures tool registrations.
 * Exposes callTool() to invoke handlers directly in tests.
 */

import { z } from 'zod';

interface ToolRegistration {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export class MockServer {
  private tools = new Map<string, ToolRegistration>();

  /**
   * Mimics McpServer.tool() — captures the registration.
   */
  tool(
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): void {
    this.tools.set(name, { name, description, schema, handler });
  }

  /**
   * Invoke a registered tool by name with the given args.
   * Applies Zod schema parsing (just like the real MCP server) so that
   * .optional().default() values are applied.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const reg = this.tools.get(name);
    if (!reg) {
      throw new Error(`Tool "${name}" not registered. Available: ${Array.from(this.tools.keys()).join(', ')}`);
    }
    // Parse through Zod schema to apply defaults, matching real MCP server behavior
    const schemaObj = z.object(reg.schema);
    const parsed = schemaObj.parse(args);
    return reg.handler(parsed) as Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>;
  }

  /**
   * Get all registered tool names.
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Check if a tool is registered.
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get a tool registration for schema inspection.
   */
  getTool(name: string): ToolRegistration | undefined {
    return this.tools.get(name);
  }
}
