import {
  type AgentContext,
  type AgentInstance,
  type AgentProfile,
  ProfileRegistry,
  type SkillsLoaderLike,
} from './profile.js';
import type { Tool } from './tools/base.js';
import { ToolRegistry } from './tools/registry.js';

const DEFAULT_MAX_ITERATIONS = 40;
const MAX_SUBAGENT_DEPTH = 3;

export type LoadSkillToolFactory = (input: { skillsLoader: SkillsLoaderLike }) => Tool;

export type SubagentToolFactory = (input: {
  factory: AgentFactory;
  profileRegistry: ProfileRegistry;
  parentModel: string;
  depth: number;
}) => Tool;

export type AgentFactoryOptions = {
  context: AgentContext;
  defaultModel: string;
  skillsLoader?: SkillsLoaderLike;
  profileRegistry?: ProfileRegistry;
  loadSkillToolFactory?: LoadSkillToolFactory;
  subagentToolFactory?: SubagentToolFactory;
};

export class AgentFactory {
  public readonly context: AgentContext;
  public readonly defaultModel: string;
  public readonly profileRegistry: ProfileRegistry;

  private readonly skillsLoader?: SkillsLoaderLike;
  private readonly loadSkillToolFactory?: LoadSkillToolFactory;
  private readonly subagentToolFactory?: SubagentToolFactory;

  public constructor(options: AgentFactoryOptions) {
    this.context = options.context;
    this.defaultModel = options.defaultModel;
    this.profileRegistry = options.profileRegistry ?? new ProfileRegistry();
    if (options.skillsLoader !== undefined) this.skillsLoader = options.skillsLoader;
    if (options.loadSkillToolFactory !== undefined) this.loadSkillToolFactory = options.loadSkillToolFactory;
    if (options.subagentToolFactory !== undefined) this.subagentToolFactory = options.subagentToolFactory;
  }

  public build(profile: AgentProfile, depth = 0): AgentInstance {
    const tools = new ToolRegistry();
    for (const factory of profile.toolFactories) tools.register(factory(this.context));

    const allowedSkills = [...(profile.inlineSkills ?? []), ...(profile.loadableSkills ?? [])];
    const filteredSkillsLoader = this.skillsLoader?.filtered(allowedSkills);

    if ((profile.loadableSkills?.length ?? 0) > 0 && filteredSkillsLoader && this.loadSkillToolFactory) {
      tools.register(this.loadSkillToolFactory({ skillsLoader: filteredSkillsLoader }));
    }

    const subagentProfiles = this.profileRegistry.subagentProfiles();
    if (subagentProfiles.length > 0 && depth < MAX_SUBAGENT_DEPTH && this.subagentToolFactory) {
      const subagentRegistry = new ProfileRegistry();
      for (const subagentProfile of subagentProfiles) subagentRegistry.register(subagentProfile);
      tools.register(
        this.subagentToolFactory({
          factory: this,
          profileRegistry: subagentRegistry,
          parentModel: profile.model ?? this.defaultModel,
          depth,
        }),
      );
    }

    const systemPrompt =
      typeof profile.systemPrompt === 'function'
        ? profile.systemPrompt(
            filteredSkillsLoader
              ? { skillsLoader: filteredSkillsLoader, toolNames: tools.toolNames, context: this.context }
              : { toolNames: tools.toolNames, context: this.context },
          )
        : profile.systemPrompt;

    return {
      tools,
      systemPrompt,
      model: profile.model ?? this.defaultModel,
      maxIterations: profile.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    };
  }
}
