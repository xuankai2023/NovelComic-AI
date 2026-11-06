# Agent 工具、Skills 与 MCP：技术点

这组只讲 Agent 运行时如何获得工具、如何按需加载 Skills、以及 MCP 代码在 OpenCreator 里的真实边界。它不讲画布运行 DAG，也不讲 Publisher/Consumer 的 workflow 命令幂等。

先背一句话：

```text
Tool 是可执行能力；
Skill 是给模型看的操作说明；
MCP 是外部工具协议适配；
Publisher Agent Skills 是产品数据，不等于运行时仓内 SKILL.md。
```

最短链路如下：

```text
AgentProfile
  → tool_factories 声明可用工具工厂
  → AgentFactory.build()
  → 每次 build 创建 fresh ToolRegistry
  → factory(ctx) 生成 Tool
  → registry.register(tool)
  → LLM 收到 tool definitions
  → tool_call
  → ToolRegistry.execute(name, params)
  → cast_params()
  → validate_params()
  → tool.execute()
  → ToolResult / string 回填给模型
```

Skill 链路如下：

```text
SkillsLoader 初始化
  → 扫描 creato/core/skills/*/SKILL.md
  → 解析平铺 frontmatter
  → 缓存 SkillInfo
  → AgentFactory 按 profile allowlist 过滤
  → always=true 且 available 的 skill body 进入 system prompt
  → 非 always skill 只进入 skills summary
  → 模型需要时调用 load_skill(name)
  → 完整 SKILL.md 作为工具结果返回
```

MCP 代码链路如下：

```text
MCP server config
  → stdio / SSE / streamable HTTP
  → ClientSession.initialize()
  → list_tools()
  → MCPToolWrapper
  → mcp_{server}_{tool}
  → register 到 ToolRegistry
```

但当前主循环里 `_connect_mcp()` 直接返回，动态 MCP 工具注册没有在受限聊天 rollout 中启用。写 NovelComic 时不能把 MCP 写成当前已连通能力。

相关专题：

- 从登录到画布亮灯：[01-从登录到画布亮灯](../01-从登录到画布亮灯/01-从登录到画布亮灯.md)
- 工作流命令 DAG 与 HITL：[07-工作流命令DAG与HITL](../02-工作流命令DAG与HITL/07-工作流命令DAG与HITL.md)
- 可恢复 WebSocket：[03-可恢复WebSocket](../03-可恢复WebSocket/03-可恢复WebSocket.md)

---

## 1. Tool Registry 是运行时工具表

OpenCreator 对照：

- [registry.py](../../../../../opencreate/opencreator-agent/creato/core/tools/registry.py)
- [base.py](../../../../../opencreate/opencreator-agent/creato/core/tools/base.py)

`ToolRegistry` 只保存当前 Agent 实例可用的工具：

```text
register(tool)
unregister(name)
get(name)
get_definitions()
execute(name, params)
```

它不是全局能力目录，也不是跨会话持久状态。每次 `AgentFactory.build()` 都会创建新的 `ToolRegistry`，再按 Profile 的工具工厂重新装配工具。

---

## 2. 工具定义来自 Tool 类

每个工具至少要提供：

```text
name
description
parameters
execute(**kwargs)
```

`parameters` 是 JSON Schema。模型看到的工具定义来自：

```text
Tool.to_schema()
  → type=function
  → function.name
  → function.description
  → function.parameters
```

所以工具名、描述和 schema 会直接影响模型是否会调用、如何传参。NovelComic 迁移时不要只写一个 Python 函数，要把 schema、描述、参数校验一起落下来。

---

## 3. 执行前会先做参数转换和校验

`ToolRegistry.execute()` 固定顺序：

```text
查 name
  → tool.cast_params(params)
  → tool.validate_params(params)
  → tool.execute(**params)
```

`cast_params()` 会按 schema 做保守转换：

- 字符串 `"1"` 可以转成 integer。
- 字符串 `"true"` / `"false"` 可以转成 boolean。
- 字符串形式的 JSON array/object 可以解析成数组或对象。
- 可选字段传 `null` 时会被移除。

`validate_params()` 负责检查 required、类型、enum、长度、范围、数组 item 等。工具自己的业务校验仍然要放在 `execute()` 里。

---

## 4. Agent Profile 决定工具白名单

OpenCreator 对照：

- [profile.py](../../../../../opencreate/opencreator-agent/creato/agents/main/profile.py)
- [factory.py](../../../../../opencreate/opencreator-agent/creato/core/factory.py)

主 Agent 的 Profile 里声明了 `tool_factories`：

```text
_read_file
_web_search
_web_fetch
_get_workflow_results
_run_workflow
_get_workflow
_get_node_spec
_edit_workflow
_update_canvas_node
...
```

这些不是工具实例，而是工厂函数。`AgentFactory.build()` 会把运行上下文 `AgentContext` 传进去，生成本次实例自己的 Tool 对象。

这样做的结果是：

- 不同 Profile 可以拥有不同工具集合。
- 同一个 Profile 每次 build 都有独立 Registry。
- 工具闭包可以拿到当前 workspace、workflow dao、API config、外部服务 client。
- Registry 不应该被当成跨用户共享对象。

---

## 5. 工具工厂负责绑定上下文

比如主 Profile 中的 `_read_file(ctx)` 会根据 `ctx.workspace` 和 `ctx.restrict_to_workspace` 创建 `ReadFileTool`。

OpenCreator 对照：

- [filesystem.py](../../../../../opencreate/opencreator-agent/creato/core/tools/filesystem.py)

`ReadFileTool` 会在执行时解析路径，并限制读目录。Skills 目录作为额外可读目录加入，是为了让 Agent 可以通过 `load_skill` 或必要读取访问内置技能材料。

NovelComic 写工具时要按这个模式绑定依赖：

```text
factory(ctx)
  → 从 ctx 取 dao / service / config / workspace
  → return Tool(...)
```

不要让工具在 `execute()` 里临时读取全局配置、创建不可控的客户端，除非这是项目内已有模式。

---

## 6. Skill Loader 扫描仓内 SKILL.md

OpenCreator 对照：

- [loader.py](../../../../../opencreate/opencreator-agent/creato/core/skills/loader.py)

`SkillsLoader` 初始化时扫描：

```text
creato/core/skills/{skill_name}/SKILL.md
```

解析规则很窄：

- opening `---` 必须在文件第一行。
- frontmatter 只支持平铺 `key: value`。
- 不支持嵌套 YAML、JSON object、数组写法。
- `name` 如果存在，必须和目录名一致。
- `requires_bins` 和 `requires_env` 是逗号分隔字符串。
- `always: true` 只有字符串 true 才算真。

解析后会缓存成 `SkillInfo`。正常运行中不会每次调用都重新读磁盘；修改 SKILL.md 后要重启或调用 `reload()` 才会重新扫描。

---

## 7. Profile 还决定 Skill allowlist

主 Profile 当前声明：

```text
inline_skills=()
loadable_skills=("weather", "workflow-core", "video-review", "editing-core", "preset-authoring", "planning-core")
```

`AgentFactory.build()` 会把 `inline_skills + loadable_skills` 合并成 allowlist，再调用：

```text
skills_loader.filtered(allowed_skills)
```

所以仓里存在某个 `SKILL.md`，不代表主 Agent 就能看到它。它还必须被 Profile allowlist 包含，并且满足 `requires_bins` / `requires_env`。

`inline_skills` 在当前装配里也是 allowlist 的一部分，不是另一套运行时加载器。某个 Skill 是否常驻注入，最终仍由 `SKILL.md` 的 `always: true` 和依赖可用性决定。

---

## 8. always Skill 和 load_skill 是两条路径

Skill 进入模型上下文有两种方式：

```text
always=true 且 available=true
  → get_always_skills()
  → load_skills_for_context()
  → 注入 system prompt

always=false
  → build_skills_summary()
  → 模型看到 name / description / trigger
  → 调用 load_skill(name)
  → 完整 SKILL.md 返回
```

`load_skill` 是一个普通 Tool，只在 Profile 有 `loadable_skills` 时注册。它返回的是完整 `SKILL.md`，不是只返回正文。

这里的核心约束是：Skill 本身不执行任何外部动作，它只改变模型理解任务和使用工具的方式。真正执行仍然要靠 Tool。

---

## 9. Subagent 也是 Tool

OpenCreator 的 `AgentFactory.build()` 会在存在子 Profile 且深度允许时注册 `SubagentTool`。

规则：

```text
depth < 3
  → 注册 SubagentTool

depth >= 3
  → 不再注册
```

因此 subagent 能力也属于工具系统的一部分。它不是绕过 Registry 的独立通道，而是由 Profile Registry 和 Tool Registry 一起控制。

---

## 10. MCP Wrapper 把远端工具包成 Tool

OpenCreator 对照：

- [mcp.py](../../../../../opencreate/opencreator-agent/creato/core/tools/mcp.py)

`MCPToolWrapper` 会把远端工具名包装成：

```text
mcp_{server_name}_{tool_name}
```

包装时会处理 schema：

- `type: ["string", "null"]` 会转成 `type: "string", nullable: true`。
- `oneOf` / `anyOf` 中单个非 null 分支会被合并。
- object schema 会补齐 `properties` 和 `required`。

执行时走：

```text
session.call_tool(original_name, arguments=kwargs)
  → 提取 TextContent
  → 拼成字符串返回
```

MCP 工具超时、取消或异常时返回错误文本，不应该让一次远端工具异常拖垮整个 Agent loop。

---

## 11. MCP 支持三种传输

`connect_mcp_servers()` 按配置选择：

```text
command 存在
  → stdio

url 以 /sse 结尾
  → SSE

其他 url
  → streamableHttp
```

注册时还会尊重 `enabled_tools`：

- `*` 表示允许该 server 的全部工具。
- 可以填远端原始工具名。
- 也可以填包装后的 `mcp_{server}_{tool}` 名。

这套代码说明 OpenCreator 已经有 MCP 适配层，但是否进入当前 Agent 的 Registry，取决于主循环是否调用 `_connect_mcp()`。

---

## 12. 当前动态 MCP 没启用

OpenCreator 对照：

- [loop.py](../../../../../opencreate/opencreator-agent/creato/core/loop.py)

`AgentLoop._connect_mcp()` 当前开头就是：

```text
return
```

注释说明是受限聊天 rollout 下不注册动态 MCP 工具。因此文档和 NovelComic 迁移都要写清楚：

- MCP 适配代码存在。
- 当前 Agent loop 不会把动态 MCP server 工具注册进 Registry。
- 如果要启用，需要恢复 `_connect_mcp()`，并处理生命周期、鉴权、server 配置、工具白名单和超时策略。

---

## 13. Publisher Agent Skills 是产品技能目录

OpenCreator 对照：

- [agent_skills.py](../../../../../opencreate/opencreator-publisher/controller/v3/agent_skills.py)
- [agent_skills.py](../../../../../opencreate/opencreator-publisher/schemas/agent_skills.py)
- [agent_skills.py](../../../../../opencreate/opencreator-publisher/services/agent_skills.py)
- [agent_skills.py](../../../../../opencreate/opencreator-publisher/dao/agent_skills.py)

Publisher 的 `/api/v3/agent-skills` 管的是用户侧技能资产：

```text
GET    /personal
POST   /generate-draft
POST   /
PATCH  /personal/{skill_id}
DELETE /personal/{skill_id}
```

它保存的是标题、描述、封面、视频、原始 prompt、场景、AI tags、source_type 等产品数据。这个目录不是 `SkillsLoader` 的扫描源，当前运行时不会从 Publisher API 动态加载这些技能。

迁移时要把两类 Skills 分开：

- 仓内 Skills：Agent 运行提示，来自 `creato/core/skills/*/SKILL.md`。
- 产品 Agent Skills：用户资产和素材化能力，来自 Publisher API 和数据库。

---

## 14. Tool 不替代业务幂等和授权

工具系统只管 Agent 这一层的调用规约：

```text
tool name
schema
参数校验
execute
结果回填
```

它不替代下游服务的授权、幂等、审计和状态机。比如 `run_workflow` 工具可以调用工作流服务，但 run 命令幂等仍要由 Publisher 的 command id、Consumer inbox 和事件回程链保证。

NovelComic 写工具时要把边界守住：工具可以封装调用，但不能让 Agent 侧本地状态成为业务事实源。

---

## 动手前置条件

开始实现这组之前，至少要有：

- `opencreator-agent` 或 NovelComic 对应 Agent 服务目录已经确定。
- Agent loop 能基于 Profile 创建实例，并能把 tool definitions 传给 LLM provider。
- 已有 `Tool` 抽象或准备按 OpenCreator 的 `Tool` / `ToolResult` 模型迁移。
- 主 Agent 的运行上下文 `AgentContext` 已经能提供 workspace、业务 dao、外部服务 config。
- 如果要接仓内 Skills，项目内已经确定技能目录和 `SKILL.md` frontmatter 规范。
- 如果要接 Publisher Agent Skills，已明确它只是产品目录，不直接混入运行时 Loader。

这组做完后，Agent 能稳定获得工具、按 Profile 暴露能力、按需加载仓内 Skills，并且清楚 MCP 只是可启用的外部工具适配层。
