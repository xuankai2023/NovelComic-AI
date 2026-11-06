# OpenCreator 是怎么做到 Agent 工具、Skills 与 MCP 分层的

这篇按运行时视角讲一遍“谁装配谁、谁调用谁”。如果要看机制拆解，读 [00-Agent工具Skills与MCP技术点.md](./00-Agent工具Skills与MCP技术点.md)。如果要按 NovelComic 的实现顺序落文件，读 [02.文件编写顺序.md](./02.文件编写顺序.md)。

## 一句话结论

OpenCreator 把 Agent 能力拆成三层：Tool Registry 负责可执行工具，SkillsLoader 负责把仓内 `SKILL.md` 变成模型可读说明，MCP 代码负责把外部 MCP server 的工具包装成原生 Tool。当前代码主链里 Profile 装配的内建工具和仓内 Skills 生效，动态 MCP 注册代码存在但没有启用。

```text
AgentLoop 收到用户消息
  → AgentFactory.build(profile)
  → 创建 fresh ToolRegistry
  → 注册 Profile.tool_factories 产出的工具
  → 按 Profile allowlist 过滤 Skills
  → 如有 loadable_skills，注册 load_skill
  → 如允许 subagent，注册 subagent
  → 生成 system prompt
  → LLM 选择自然语言回复或 tool_call
  → ToolRegistry.execute()
  → 工具结果回到 Agent loop
```

必须分清四个概念：

- Tool：可执行函数，有 name、description、parameters 和 execute。
- Registry：当前 Agent 实例的工具表，每次 build 都新建。
- Skill：仓内 `SKILL.md` 指令材料，帮助模型理解什么时候怎么使用能力。
- MCP：外部工具协议适配层，当前代码存在但主循环没有动态注册。

---

## 1. Agent Profile 声明能力范围

主 Agent Profile 在 [profile.py](../../../../../opencreate/opencreator-agent/creato/agents/main/profile.py) 中定义。它声明三类关键内容：

```text
tool_factories
inline_skills
loadable_skills
```

`tool_factories` 是工具工厂列表，不是工具实例。比如 `_read_file`、`_web_search`、`_run_workflow`、`_edit_workflow`、`_search_templates`、`_video_search`、`_task_create` 等。

`loadable_skills` 是主 Agent 可以按需加载的技能 allowlist。当前主 Profile 包含：

```text
weather
workflow-core
video-review
editing-core
preset-authoring
planning-core
```

仓里有别的 `SKILL.md` 不代表这个 Agent 就能加载；Profile 没列出来就不会进入该实例上下文。`inline_skills` 也参与 allowlist 过滤，但 Skill 是否常驻注入仍看 `SKILL.md` 自己的 `always: true`。

---

## 2. AgentFactory 每次 build 都重新装配

装配入口是 [factory.py](../../../../../opencreate/opencreator-agent/creato/core/factory.py)。

核心流程：

```text
AgentFactory.build(profile)
  → tools = ToolRegistry()
  → for factory in profile.tool_factories:
        tools.register(factory(context))
  → allowed_skills = inline_skills + loadable_skills
  → filtered_skills = skills_loader.filtered(allowed_skills)
  → 如果有 loadable_skills，注册 LoadSkillTool
  → 如果有 subagent profile 且 depth < 3，注册 SubagentTool
  → build system prompt
  → 返回 AgentInstance
```

这说明 Registry 是实例级对象。工具如果需要 workspace、dao、API config、workflow engine，要通过 factory 从 `AgentContext` 注入，不要假设全局单例里总有正确上下文。

---

## 3. ToolRegistry 暴露工具定义

工具表实现是 [registry.py](../../../../../opencreate/opencreator-agent/creato/core/tools/registry.py)。

LLM 调用之前，Agent loop 会把工具定义给 provider：

```text
ToolRegistry.get_definitions()
  → tool.to_schema()
```

每个工具 schema 形状来自 [base.py](../../../../../opencreate/opencreator-agent/creato/core/tools/base.py)：

```text
{
  "type": "function",
  "function": {
    "name": tool.name,
    "description": tool.description,
    "parameters": tool.parameters
  }
}
```

所以工具名要稳定，描述要面向模型说明用途，参数 schema 要尽量精确。模糊 schema 会直接变成运行时传参错误。

---

## 4. 工具调用先过 Registry

当模型返回 tool call 时，不是直接调用工具函数，而是：

```text
ToolRegistry.execute(name, params)
  → 查工具是否存在
  → cast_params()
  → validate_params()
  → await tool.execute(**params)
```

找不到工具时，Registry 会返回错误文本，并列出当前可用工具名。参数校验失败时，也会返回错误文本并提示模型换一种方式。

工具执行结果可以是字符串，也可以是 `ToolResult`。如果结果以 `Error` 开头，Registry 会追加提示，鼓励模型分析错误后换方法。

---

## 5. Tool 类负责参数规约

工具基类在 [base.py](../../../../../opencreate/opencreator-agent/creato/core/tools/base.py)。

它用 JSON Schema 做两件事：

```text
cast_params()
  → 对字符串数字、boolean、JSON array/object 做保守转换

validate_params()
  → 检查 required、类型、enum、长度、范围、数组元素
```

这层解决的是“模型传参形状不完全稳定”的问题，但不是业务兜底。比如 workflow 是否属于当前用户、模板是否可访问、文件是否越权，仍然要由对应 Tool 或下游服务检查。

---

## 6. 内建工具由 Profile 工厂接入业务系统

主 Profile 中的工具工厂会把 Agent 能力接到不同服务：

```text
read_file
web_search
web_fetch
get_workflow_results
run_workflow
get_workflow
get_node_spec
edit_workflow
update_canvas_node
search_templates
use_template
cos_upload
video_search
media_understanding
cut_video_concat
task_create
task_update
save_constraint_pack
```

这些工具不是同一类能力。有些读本地文件，有些查模板，有些启动工作流，有些调用外部媒体理解服务。共同点是它们都被包装成 `Tool`，再由同一个 Registry 执行。

NovelComic 迁移时，应该先把最小可用工具闭环写出来，再逐步增加工具，不要一次性把所有业务 API 都暴露给模型。

---

## 7. SkillsLoader 启动时扫描仓内 Skills

Skill 运行时在 [loader.py](../../../../../opencreate/opencreator-agent/creato/core/skills/loader.py)。

初始化流程：

```text
SkillsLoader()
  → 遍历 creato/core/skills/*
  → 找每个目录下的 SKILL.md
  → 解析 frontmatter
  → 校验 name 与目录名
  → 检查 requires_bins / requires_env
  → 缓存 SkillInfo
```

`SKILL.md` 的 frontmatter 只支持平铺单行字段。比如：

```text
name: workflow-core
description: ...
trigger: ...
always: true
requires_bins: curl, jq
requires_env: API_KEY
```

不支持嵌套 YAML，也不支持数组对象写法。这个限制要写进 NovelComic 的技能规范里，否则加载器会忽略或跳过字段。

---

## 8. Skills 进入模型上下文有两种方式

第一种是 always skill：

```text
always=true
  → available=true
  → get_always_skills()
  → load_skills_for_context()
  → body 进入 system prompt
```

第二种是按需加载：

```text
always=false
  → build_skills_summary()
  → 模型看到 name / description / trigger
  → 模型调用 load_skill(name)
  → 完整 SKILL.md 返回给模型
```

`load_skill` 本身也是工具，实现在 [filesystem.py](../../../../../opencreate/opencreator-agent/creato/core/tools/filesystem.py)。只有 Profile 有 `loadable_skills` 时，`AgentFactory` 才会注册它。

---

## 9. Skill 不是可执行工具

Skill 常被误解成一种插件。OpenCreator 里不是这样。

Skill 的作用是：

```text
告诉模型什么时候使用某个能力
告诉模型具体步骤、约束和注意事项
提供引用文件、命令示例、验收口径
```

它不直接执行动作。真正执行动作的仍然是 Tool，比如 `read_file`、`run_workflow`、`edit_workflow` 或某个 MCP wrapper。

因此迁移时不能只建一个产品技能表就认为 Agent 拥有了新能力。必须同时回答两个问题：

- 模型知道如何使用这个能力吗？
- Registry 里真的有可执行工具吗？

---

## 10. Subagent 能力也走工具系统

`AgentFactory.build()` 会检查 Profile Registry 中是否有 subagent profile。如果有，且当前深度小于 3，就注册 `SubagentTool`。

```text
subagent profile 存在
  → depth < 3
  → tools.register(SubagentTool(...))
```

这让主 Agent 可以把某些任务委托给子 Agent，但递归深度被限制住，避免无限套娃。它和普通工具一样进入 Tool Registry，也一样受 Profile 控制。

---

## 11. MCP 代码把外部工具包装成原生 Tool

MCP 适配在 [mcp.py](../../../../../opencreate/opencreator-agent/creato/core/tools/mcp.py)。

连接流程：

```text
connect_mcp_servers(mcp_servers, registry, stack)
  → 按 server config 选择 stdio / sse / streamableHttp
  → ClientSession.initialize()
  → session.list_tools()
  → MCPToolWrapper(session, server_name, tool_def)
  → registry.register(wrapper)
```

包装后的工具名是：

```text
mcp_{server_name}_{tool_name}
```

这样可以避免外部 server 的工具名直接和本地工具名冲突。

---

## 12. MCP schema 会做 OpenAI 兼容转换

MCP 远端工具返回的是 JSON Schema。OpenCreator 注册前会做一次轻量归一化：

```text
type: ["string", "null"]
  → type: "string", nullable: true

oneOf / anyOf 中只有一个非 null 分支
  → 合并该分支，并标记 nullable

object schema
  → 补 properties 和 required
```

之后 MCP wrapper 就像普通 Tool 一样被 Registry 暴露给模型。

---

## 13. 当前主循环没有启用动态 MCP 注册

主循环在 [loop.py](../../../../../opencreate/opencreator-agent/creato/core/loop.py) 中保留了 MCP 生命周期字段：

```text
_mcp_servers
_mcp_stack
_mcp_connected
_mcp_connecting
close_mcp()
```

但 `_connect_mcp()` 当前直接返回：

```text
Disabled for the restricted chatbot rollout
```

因此当前代码口径是：MCP client 和 wrapper 代码存在，但动态 MCP server 工具不会注册进主 Agent Registry。文档和 NovelComic 迁移都必须保留这个边界。

---

## 14. Publisher Agent Skills 是用户资产

Publisher 侧接口在 [agent_skills.py](../../../../../opencreate/opencreator-publisher/controller/v3/agent_skills.py)。

它提供：

```text
GET    /api/v3/agent-skills/personal
POST   /api/v3/agent-skills/generate-draft
POST   /api/v3/agent-skills
PATCH  /api/v3/agent-skills/personal/{skill_id}
DELETE /api/v3/agent-skills/personal/{skill_id}
```

服务层在 [agent_skills.py](../../../../../opencreate/opencreator-publisher/services/agent_skills.py)，schema 在 [agent_skills.py](../../../../../opencreate/opencreator-publisher/schemas/agent_skills.py)。

这些接口用于维护用户的个人技能目录、生成草稿、保存标题/描述/封面/视频/原始 prompt/场景/标签。它不是 Agent 进程启动时扫描的 `SKILL.md`，也不会自动变成 `load_skill` 能加载的运行时 Skill。

---

## 15. 和 NovelComic 的迁移边界

NovelComic 如果要对齐 OpenCreator 的 Agent 工具、Skills 与 MCP，建议按三个层次迁移：

```text
运行时工具层
  → Tool / ToolResult / ToolRegistry / AgentProfile / AgentFactory

仓内技能层
  → SkillsLoader / SKILL.md 规范 / load_skill / system prompt 注入

产品技能层
  → Publisher agent-skills API / dao / schema / media draft generation
```

MCP 可以先落代码结构和配置模型，但不要在第一轮就宣称动态 MCP 已启用。除非同时恢复 Agent loop 的 `_connect_mcp()`，并补好 server 配置、鉴权、白名单、超时、生命周期关闭和观测。

迁移完成的最小标准不是“能显示一个技能卡片”，而是：

- Agent 实例能按 Profile 暴露工具定义。
- 模型能调用工具，并经过参数转换、校验和执行。
- 仓内 Skill 能被 allowlist 控制并按需加载。
- 用户侧 Agent Skills 能增删改查，但不会和运行时 Skill 混淆。
- MCP 的未启用状态被明确保留，或完整接通后再改文档口径。
