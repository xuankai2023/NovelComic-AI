import { ToolResult, type FunctionToolSchema, type Tool } from './base.js';

const RETRY_HINT = '\n\n[Analyze the error above and try a different approach.]';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  public register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  public unregister(name: string): void {
    this.tools.delete(name);
  }

  public get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public getDefinitions(options: { exclude?: Set<string> } = {}): FunctionToolSchema[] {
    return [...this.tools.entries()]
      .filter(([name]) => !options.exclude?.has(name))
      .map(([, tool]) => tool.toSchema());
  }

  public async execute(name: string, params: unknown): Promise<string | ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return `Error: Tool '${name}' not found. Available: ${this.toolNames.join(', ')}`;

    try {
      const castedParams = tool.castParams(params);
      const validationErrors = tool.validateParams(castedParams);
      if (validationErrors.length > 0) {
        return `Error: Invalid parameters for tool '${name}': ${validationErrors.join('; ')}${RETRY_HINT}`;
      }

      const result = await tool.execute(castedParams as Record<string, unknown>);
      if (result instanceof ToolResult && result.content.startsWith('Error')) {
        const content = `${result.content}${RETRY_HINT}`;
        return result.error === undefined
          ? new ToolResult({ success: result.success, content })
          : new ToolResult({ success: result.success, content, error: result.error });
      }
      if (typeof result === 'string' && result.startsWith('Error')) return `${result}${RETRY_HINT}`;
      return result;
    } catch (error) {
      return `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}${RETRY_HINT}`;
    }
  }

  public get toolNames(): string[] {
    return [...this.tools.keys()];
  }

  public get size(): number {
    return this.tools.size;
  }

  public values(): Tool[] {
    return [...this.tools.values()];
  }
}
