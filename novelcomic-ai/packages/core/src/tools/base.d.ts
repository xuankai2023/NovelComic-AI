export type JsonSchemaType = 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object' | 'null';
export type JsonSchema = {
    type?: JsonSchemaType | JsonSchemaType[];
    description?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    items?: JsonSchema;
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    nullable?: boolean;
};
export type FunctionToolSchema = {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: JsonSchema;
    };
};
export declare class ToolResult {
    readonly success: boolean;
    readonly content: string;
    readonly error?: string;
    constructor(input: {
        success: boolean;
        content: string;
        error?: string;
    });
}
export declare abstract class Tool {
    abstract readonly name: string;
    abstract readonly description: string;
    abstract readonly parameters: JsonSchema;
    abstract execute(params: Record<string, unknown>): Promise<string | ToolResult> | string | ToolResult;
    castParams(params: unknown): unknown;
    validateParams(params: unknown): string[];
    toSchema(): FunctionToolSchema;
    private castObject;
    private castValue;
    private validateValue;
    private validateType;
    private resolveType;
    private isPlainObject;
    private describeType;
}
