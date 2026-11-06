import { ToolResult, type FunctionToolSchema, type Tool } from './base.js';
export declare class ToolRegistry {
    private readonly tools;
    register(tool: Tool): void;
    unregister(name: string): void;
    get(name: string): Tool | undefined;
    has(name: string): boolean;
    getDefinitions(options?: {
        exclude?: Set<string>;
    }): FunctionToolSchema[];
    execute(name: string, params: unknown): Promise<string | ToolResult>;
    get toolNames(): string[];
    get size(): number;
    values(): Tool[];
}
