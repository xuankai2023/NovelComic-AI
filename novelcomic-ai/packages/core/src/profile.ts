import type { Tool } from './tools/base.js';
import type { ToolRegistry } from './tools/registry.js';

export type AgentContext = {
  workspace: string;
  restrictToWorkspace: boolean;
  workflowDao?: unknown;
  workflowEngine?: unknown;
  apiConfig?: unknown;
  clients?: Record<string, unknown>;
};

export type SkillsLoaderLike = {
  filtered(skillNames: readonly string[]): SkillsLoaderLike;
};

export type SystemPromptFactoryInput = {
  skillsLoader?: SkillsLoaderLike;
  toolNames: readonly string[];
  context: AgentContext;
};

export type SystemPromptFactory = (input: SystemPromptFactoryInput) => string;
export type ToolFactory = (context: AgentContext) => Tool;

export type AgentProfile = {
  name: string;
  description: string;
  systemPrompt: string | SystemPromptFactory;
  toolFactories: readonly ToolFactory[];
  inlineSkills?: readonly string[];
  loadableSkills?: readonly string[];
  model?: string;
  maxIterations?: number;
};

export type AgentInstance = {
  tools: ToolRegistry;
  systemPrompt: string;
  model: string;
  maxIterations: number;
};

export class ProfileRegistry {
  private readonly profiles = new Map<string, AgentProfile>();

  public register(profile: AgentProfile): void {
    this.profiles.set(profile.name, profile);
  }

  public get(name: string): AgentProfile | undefined {
    return this.profiles.get(name);
  }

  public listProfiles(): AgentProfile[] {
    return [...this.profiles.values()];
  }

  public get names(): string[] {
    return [...this.profiles.keys()];
  }

  public subagentProfiles(): AgentProfile[] {
    return this.listProfiles().filter((profile) => profile.name !== 'main');
  }
}
