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

export class ToolResult {
  public readonly success: boolean;
  public readonly content: string;
  public readonly error?: string;

  public constructor(input: { success: boolean; content: string; error?: string }) {
    this.success = input.success;
    this.content = input.content;
    if (input.error !== undefined) this.error = input.error;
  }
}

export abstract class Tool {
  public abstract readonly name: string;
  public abstract readonly description: string;
  public abstract readonly parameters: JsonSchema;

  public abstract execute(params: Record<string, unknown>): Promise<string | ToolResult> | string | ToolResult;

  public castParams(params: unknown): unknown {
    const schema = this.parameters ?? {};
    if (schema.type !== undefined && this.resolveType(schema.type) !== 'object') return params;
    return this.castObject(params, schema);
  }

  public validateParams(params: unknown): string[] {
    if (!this.isPlainObject(params)) return [`parameters must be an object, got ${this.describeType(params)}`];
    const schema = { ...this.parameters, type: 'object' as const };
    return this.validateValue(params, schema, '');
  }

  public toSchema(): FunctionToolSchema {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }

  private castObject(value: unknown, schema: JsonSchema): unknown {
    if (!this.isPlainObject(value)) return value;

    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const result: Record<string, unknown> = {};

    for (const [key, rawValue] of Object.entries(value)) {
      if (rawValue === null && !required.has(key)) continue;
      const propertySchema = properties[key];
      result[key] = propertySchema ? this.castValue(rawValue, propertySchema) : rawValue;
    }

    return result;
  }

  private castValue(value: unknown, schema: JsonSchema): unknown {
    const targetType = this.resolveType(schema.type);

    if (targetType === 'integer') {
      if (typeof value === 'number' && Number.isInteger(value)) return value;
      if (typeof value === 'string' && /^[-+]?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
      return value;
    }

    if (targetType === 'number') {
      if (typeof value === 'number') return value;
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isNaN(parsed) ? value : parsed;
      }
      return value;
    }

    if (targetType === 'boolean') {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const normalized = value.toLowerCase();
        if (['true', '1', 'yes'].includes(normalized)) return true;
        if (['false', '0', 'no'].includes(normalized)) return false;
      }
      return value;
    }

    if (targetType === 'string') return value === null || value === undefined ? value : String(value);

    if ((targetType === 'array' || targetType === 'object') && typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (targetType === 'array' && Array.isArray(parsed)) value = parsed;
          if (targetType === 'object' && this.isPlainObject(parsed)) value = parsed;
        } catch {
          return value;
        }
      }
    }

    if (targetType === 'array' && Array.isArray(value) && schema.items) {
      return value.map((item) => this.castValue(item, schema.items as JsonSchema));
    }

    if (targetType === 'object') return this.castObject(value, schema);

    return value;
  }

  private validateValue(value: unknown, schema: JsonSchema, path: string): string[] {
    const label = path || 'parameter';
    const rawType = schema.type;
    const targetType = this.resolveType(rawType);
    const nullable = schema.nullable === true || (Array.isArray(rawType) && rawType.includes('null'));

    if (value === null && nullable) return [];

    const typeError = this.validateType(value, targetType, label);
    if (typeError) return [typeError];

    const errors: string[] = [];
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${label} must be one of ${JSON.stringify(schema.enum)}`);

    if ((targetType === 'integer' || targetType === 'number') && typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${label} must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${label} must be <= ${schema.maximum}`);
    }

    if (targetType === 'string' && typeof value === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`${label} must be at least ${schema.minLength} chars`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`${label} must be at most ${schema.maxLength} chars`);
      }
    }

    if (targetType === 'object' && this.isPlainObject(value)) {
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) {
        if (!(key in value)) errors.push(`missing required ${path ? `${path}.${key}` : key}`);
      }
      for (const [key, nestedValue] of Object.entries(value)) {
        const propertySchema = properties[key];
        if (propertySchema) errors.push(...this.validateValue(nestedValue, propertySchema, path ? `${path}.${key}` : key));
      }
    }

    if (targetType === 'array' && Array.isArray(value) && schema.items) {
      value.forEach((item, index) => {
        errors.push(...this.validateValue(item, schema.items as JsonSchema, path ? `${path}[${index}]` : `[${index}]`));
      });
    }

    return errors;
  }

  private validateType(value: unknown, targetType: JsonSchemaType | undefined, label: string): string | null {
    if (!targetType || targetType === 'null') return null;
    if (targetType === 'integer') {
      return typeof value === 'number' && Number.isInteger(value) ? null : `${label} should be integer`;
    }
    if (targetType === 'number') {
      return typeof value === 'number' && !Number.isNaN(value) ? null : `${label} should be number`;
    }
    if (targetType === 'boolean') return typeof value === 'boolean' ? null : `${label} should be boolean`;
    if (targetType === 'string') return typeof value === 'string' ? null : `${label} should be string`;
    if (targetType === 'array') return Array.isArray(value) ? null : `${label} should be array`;
    if (targetType === 'object') return this.isPlainObject(value) ? null : `${label} should be object`;
    return null;
  }

  private resolveType(type: JsonSchema['type']): JsonSchemaType | undefined {
    if (Array.isArray(type)) return type.find((item) => item !== 'null');
    return type;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private describeType(value: unknown): string {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value;
  }
}
