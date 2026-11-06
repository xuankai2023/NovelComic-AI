import { type AgentContext, type AgentInstance, type AgentProfile, ProfileRegistry, type SkillsLoaderLike } from './profile.js';
import type { Tool } from './tools/base.js';
export type LoadSkillToolFactory = (input: {
    skillsLoader: SkillsLoaderLike;
}) => Tool;
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
export declare class AgentFactory {
    readonly context: AgentContext;
    readonly defaultModel: string;
    readonly profileRegistry: ProfileRegistry;
    private readonly skillsLoader?;
    private readonly loadSkillToolFactory?;
    private readonly subagentToolFactory?;
    constructor(options: AgentFactoryOptions);
    build(profile: AgentProfile, depth?: number): AgentInstance;
}
