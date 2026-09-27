/**
 * Mock MCP server that captures tool, resource and prompt registrations.
 * Exposes callTool(), readResource() and getPrompt() to invoke handlers
 * directly in tests.
 */

import { z } from 'zod';

interface ToolRegistration {
  name: string;
  description: string;
  /** The argument shape (for registerTool: the shape of its object schema). */
  schema: Record<string, z.ZodTypeAny>;
  /** registerTool only: the object schema the arguments are parsed with, as given (e.g. strict). */
  inputSchema?: z.ZodTypeAny;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

interface ResourceRegistration {
  name: string;
  /** Static URI, or the URI template string for templated resources */
  uri: string;
  metadata?: Record<string, unknown>;
  handler: (uri: URL, variables?: Record<string, unknown>) => Promise<unknown>;
}

interface PromptRegistration {
  name: string;
  description?: string;
  schema?: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

type ResourceContents = { contents: Array<{ uri: string; mimeType?: string; text: string }> };
type PromptMessages = { messages: Array<{ role: string; content: { type: string; text: string } }> };

export class MockServer {
  private tools = new Map<string, ToolRegistration>();
  private resources = new Map<string, ResourceRegistration>();
  private prompts = new Map<string, PromptRegistration>();

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
   * Mimics McpServer.registerTool() — captures the registration. An object
   * schema given as inputSchema is used as it is, as the real server does
   * (so a strict schema refuses unknown arguments); a raw shape is wrapped
   * in z.object(), which strips them.
   */
  registerTool(
    name: string,
    config: { description?: string; inputSchema?: z.ZodTypeAny | Record<string, z.ZodTypeAny> },
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): void {
    const given = config.inputSchema ?? {};
    const inputSchema = given instanceof z.ZodType ? given : z.object(given);
    const schema = inputSchema instanceof z.ZodObject ? inputSchema.shape as Record<string, z.ZodTypeAny> : {};
    this.tools.set(name, { name, description: config.description ?? '', schema, inputSchema, handler });
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
    const schemaObj = reg.inputSchema ?? z.object(reg.schema);
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

  /**
   * Mimics McpServer.resource(name, uriOrTemplate, [metadata], handler).
   */
  resource(name: string, uriOrTemplate: unknown, ...rest: unknown[]): void {
    const handler = rest[rest.length - 1] as ResourceRegistration['handler'];
    const metadata = rest.length > 1 ? rest[0] as Record<string, unknown> : undefined;
    const uri = typeof uriOrTemplate === 'string'
      ? uriOrTemplate
      : String((uriOrTemplate as { uriTemplate?: unknown }).uriTemplate ?? uriOrTemplate);
    this.resources.set(name, { name, uri, metadata, handler });
  }

  /**
   * Mimics McpServer.prompt(name, [description], [argsSchema], handler).
   */
  prompt(name: string, ...rest: unknown[]): void {
    const handler = rest[rest.length - 1] as PromptRegistration['handler'];
    const description = typeof rest[0] === 'string' ? rest[0] : undefined;
    const schema = rest.slice(0, -1).find(r => typeof r === 'object' && r !== null) as PromptRegistration['schema'];
    this.prompts.set(name, { name, description, schema, handler });
  }

  /** Read a static (non-template) resource by URI. */
  async readResource(uri: string): Promise<ResourceContents> {
    const reg = [...this.resources.values()].find(r => r.uri === uri);
    if (!reg) {
      throw new Error(`Resource "${uri}" not registered. Available: ${this.getResourceUris().join(', ')}`);
    }
    return reg.handler(new URL(uri)) as Promise<ResourceContents>;
  }

  /** Get a prompt's messages, applying its argument schema like the real server. */
  async getPrompt(name: string, args: Record<string, unknown> = {}): Promise<PromptMessages> {
    const reg = this.prompts.get(name);
    if (!reg) {
      throw new Error(`Prompt "${name}" not registered. Available: ${this.getPromptNames().join(', ')}`);
    }
    const parsed = reg.schema ? z.object(reg.schema).parse(args) : {};
    return reg.handler(parsed) as Promise<PromptMessages>;
  }

  getResourceUris(): string[] {
    return [...this.resources.values()].map(r => r.uri);
  }

  getResource(name: string): ResourceRegistration | undefined {
    return this.resources.get(name);
  }

  getPromptNames(): string[] {
    return [...this.prompts.keys()];
  }
}
