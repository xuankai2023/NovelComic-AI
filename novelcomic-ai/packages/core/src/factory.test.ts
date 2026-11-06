import { describe, expect, it } from 'vitest';
import {
  AgentFactory,
  ProfileRegistry,
  Tool,
  type AgentContext,
  type AgentProfile,
  type JsonSchema,
  type SkillsLoaderLike,
} from './index.js';

class NamedTool extends Tool {
  public readonly description: string;
  public readonly parameters: JsonSchema = { type: 'object', properties: {} };

  public constructor(public readonly name: string) {
    super();
    this.description = `${name} tool`;
  }

  public execute(): string {
    return this.name;
  }
}

const context: AgentContext = {
  workspace: '/workspace/project',
  restrictToWorkspace: true,
};

describe('Agent profile and factory', () => {
  it('builds an empty profile with an empty tool registry', () => {
    const profile: AgentProfile = {
      name: 'empty',
      description: 'Empty agent',
      systemPrompt: 'You are an empty agent.',
      toolFactories: [],
    };
    const factory = new AgentFactory({ context, defaultModel: 'test-model' });

    const instance = factory.build(profile);

    expect(instance.tools.size).toBe(0);
    expect(instance.systemPrompt).toBe('You are an empty agent.');
    expect(instance.model).toBe('test-model');
    expect(instance.maxIterations).toBe(40);
  });

  it('creates isolated tool registries for repeated builds', () => {
    const profile: AgentProfile = {
      name: 'main',
      description: 'Main agent',
      systemPrompt: 'Main prompt',
      toolFactories: [() => new NamedTool('base')],
    };
    const factory = new AgentFactory({ context, defaultModel: 'test-model' });

    const first = factory.build(profile);
    const second = factory.build(profile);
    first.tools.register(new NamedTool('temporary'));

    expect(first.tools.has('temporary')).toBe(true);
    expect(second.tools.has('temporary')).toBe(false);
    expect(first.tools).not.toBe(second.tools);
  });

  it('registers profile tool factories and passes tool names into prompt factories', () => {
    const profile: AgentProfile = {
      name: 'prompted',
      description: 'Prompted agent',
      systemPrompt: ({ toolNames }) => `Tools: ${toolNames.join(', ')}`,
      toolFactories: [() => new NamedTool('read'), () => new NamedTool('write')],
      model: 'profile-model',
      maxIterations: 5,
    };
    const factory = new AgentFactory({ context, defaultModel: 'default-model' });

    const instance = factory.build(profile);

    expect(instance.tools.getDefinitions().map((definition) => definition.function.name)).toEqual(['read', 'write']);
    expect(instance.systemPrompt).toBe('Tools: read, write');
    expect(instance.model).toBe('profile-model');
    expect(instance.maxIterations).toBe(5);
  });

  it('filters declared skills and registers optional load-skill tool', () => {
    const filteredInputs: string[][] = [];
    const skillsLoader: SkillsLoaderLike = {
      filtered(skillNames) {
        filteredInputs.push([...skillNames]);
        return this;
      },
    };
    const profile: AgentProfile = {
      name: 'skills',
      description: 'Skills agent',
      systemPrompt: ({ toolNames }) => `Tools: ${toolNames.join(', ')}`,
      toolFactories: [],
      inlineSkills: ['planning-core'],
      loadableSkills: ['workflow-core'],
    };
    const factory = new AgentFactory({
      context,
      defaultModel: 'test-model',
      skillsLoader,
      loadSkillToolFactory: () => new NamedTool('load_skill'),
    });

    const instance = factory.build(profile);

    expect(filteredInputs).toEqual([['planning-core', 'workflow-core']]);
    expect(instance.tools.toolNames).toEqual(['load_skill']);
    expect(instance.systemPrompt).toBe('Tools: load_skill');
  });

  it('registers an optional subagent tool only before max depth', () => {
    const registry = new ProfileRegistry();
    registry.register({
      name: 'main',
      description: 'Main agent',
      systemPrompt: 'Main',
      toolFactories: [],
    });
    registry.register({
      name: 'research',
      description: 'Research subagent',
      systemPrompt: 'Research',
      toolFactories: [],
    });
    const profile = registry.get('main');
    if (!profile) throw new Error('missing main profile');
    const factory = new AgentFactory({
      context,
      defaultModel: 'test-model',
      profileRegistry: registry,
      subagentToolFactory: ({ profileRegistry }) => new NamedTool(`subagent_${profileRegistry.names.join('_')}`),
    });

    expect(factory.build(profile, 0).tools.toolNames).toEqual(['subagent_research']);
    expect(factory.build(profile, 3).tools.toolNames).toEqual([]);
  });
});
