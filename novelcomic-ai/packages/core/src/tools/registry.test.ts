import { describe, expect, it } from 'vitest';
import { Tool, ToolRegistry, type JsonSchema } from '../index.js';

class EchoTool extends Tool {
  public readonly name = 'echo';
  public readonly description = 'Echoes a message with a repeat count.';
  public readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      message: { type: 'string', minLength: 1 },
      count: { type: 'integer', minimum: 1, maximum: 3 },
    },
    required: ['message', 'count'],
  };

  public execute(params: Record<string, unknown>): string {
    return Array.from({ length: params.count as number }, () => params.message).join(' ');
  }
}

class StrictTool extends Tool {
  public readonly name = 'strict';
  public readonly description = 'Fails the test if executed after invalid params.';
  public readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['safe'] },
    },
    required: ['mode'],
  };

  public executed = false;

  public execute(): string {
    this.executed = true;
    return 'executed';
  }
}

describe('Tool and ToolRegistry', () => {
  it('returns registered function schemas in registration order', () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    registry.register(new StrictTool());

    expect(registry.getDefinitions().map((definition) => definition.function.name)).toEqual(['echo', 'strict']);
    expect(registry.toolNames).toEqual(['echo', 'strict']);
  });

  it('casts conservative parameter types before validation and execution', async () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool());

    await expect(registry.execute('echo', { message: 'hello', count: '2' })).resolves.toBe('hello hello');
  });

  it('returns validation errors for missing required parameters', async () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool());

    const result = await registry.execute('echo', { message: 'hello' });

    expect(result).toContain("Error: Invalid parameters for tool 'echo'");
    expect(result).toContain('missing required count');
  });

  it('does not execute a tool when parameter validation fails', async () => {
    const registry = new ToolRegistry();
    const strictTool = new StrictTool();
    registry.register(strictTool);

    const result = await registry.execute('strict', { mode: 'danger' });

    expect(result).toContain('mode must be one of ["safe"]');
    expect(strictTool.executed).toBe(false);
  });

  it('returns a clear error for unknown tools', async () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool());

    await expect(registry.execute('missing', {})).resolves.toBe("Error: Tool 'missing' not found. Available: echo");
  });
});
