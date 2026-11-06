# Agent 工具、Skills 与 MCP question

## 核心概念

- 这一组讲的是什么？
  - 只讲 Agent 运行时如何获得工具、如何按需加载 Skills、以及 MCP 代码在 OpenCreator 里的真实边界。
  - 它不讲画布运行 DAG。
  - 它也不讲 Publisher / Consumer 的 workflow 命令幂等。

- 为什么要先背一句话？
  - Tool 是可执行能力。
  - Skill 是给模型看的操作说明。
  - MCP 是外部工具协议适配。
  - Publisher Agent Skills 是产品数据，不等于运行时仓内 `SKILL.md`。

- 工具最短链路是什么？
  - AgentProfile 用 `tool_factories` 声明可用工具工厂。
  - `AgentFactory.build()` 每次创建 fresh `ToolRegistry`。
  - `factory(ctx)` 生成 Tool 并 register。
  - LLM 收到 tool definitions 后发起 tool_call。
  - `ToolRegistry.execute()` 先 cast、再 validate、再 `tool.execute()`。
  - `ToolResult` / string 回填给模型。

- Skill 最短链路是什么？
  - `SkillsLoader` 扫描 `creato/core/skills/*/SKILL.md`。
  - 解析平铺 frontmatter，缓存 `SkillInfo`。
  - Profile allowlist 过滤。
  - `always=true` 且 available 的 skill body 进入 system prompt。
  - 非 always skill 只进入 skills summary，模型需要时调用 `load_skill(name)`。

- 当前动态 MCP 启用了吗？
  - 没有。
  - MCP 适配代码存在，但 `AgentLoop._connect_mcp()` 直接返回。
  - 写 NovelComic 时不能把 MCP 写成当前已连通能力。

## Tool 与 Registry

- `ToolRegistry` 是全局能力目录吗？
  - 不是。
  - 它只保存当前 Agent 实例可用的工具。
  - 每次 `AgentFactory.build()` 都会创建新的 Registry。

- 每个工具至少要提供什么？
  - `name`、`description`、`parameters`、`execute(**kwargs)`。
  - `parameters` 是 JSON Schema。
  - 模型看到的定义来自 `Tool.to_schema()`。

- 为什么工具不能只写一个 Python 函数？
  - 工具名、描述和 schema 会直接影响模型是否调用、如何传参。
  - 还要有参数转换、校验和错误回填。

- `ToolRegistry.execute()` 的固定顺序是什么？
  - 查 name。
  - `tool.cast_params(params)`。
  - `tool.validate_params(params)`。
  - `tool.execute(**params)`。

- `cast_params()` 做什么？
  - 字符串 `"1"` 可以转成 integer。
  - `"true"` / `"false"` 可以转成 boolean。
  - 字符串形式的 JSON array / object 可以解析。
  - 可选字段传 `null` 时会被移除。

- 参数校验等于业务授权吗？
  - 不等于。
  - `validate_params()` 只检查 required、类型、enum、长度、范围。
  - workflow 是否属于当前用户、文件是否越权，仍要由工具或下游服务检查。

## Profile 与工厂

- Agent Profile 决定什么？
  - `tool_factories`：这个 Agent 能获得哪些工具工厂。
  - `inline_skills` / `loadable_skills`：这个 Agent 能看到哪些仓内 Skills。

- 为什么工厂不是工具实例？
  - `AgentFactory.build()` 会把 `AgentContext` 传进去，生成本次实例自己的 Tool。
  - 不同 Profile 可以拥有不同工具集合。
  - 同一个 Profile 每次 build 都有独立 Registry。
  - 工具闭包可以拿到当前 workspace、dao、API config。

- 工具为什么要从 `ctx` 注入依赖？
  - 不要让工具在 `execute()` 里临时读取全局配置、创建不可控客户端。
  - Registry 不应该被当成跨用户共享对象。

- 主 Agent 常见工具有哪些？
  - 文件与检索：`read_file`、`web_search`、`web_fetch`。
  - 画布与工作流：`get_workflow`、`run_workflow`、`edit_workflow`、`update_canvas_node`、`get_workflow_results`、`get_node_spec`。
  - 模板与媒体：`search_templates`、`use_template`、`video_search`、`media_understanding`。
  - 任务：`task_create`、`task_update`。

- Subagent 是不是独立通道？
  - 不是。
  - 它也是 Tool。
  - 存在子 Profile 且 `depth < 3` 时才注册 `SubagentTool`。
  - `depth >= 3` 不再注册，避免无限套娃。

## Skills

- `SkillsLoader` 扫描哪里？
  - `creato/core/skills/{skill_name}/SKILL.md`。

- frontmatter 有哪些限制？
  - opening `---` 必须在文件第一行。
  - 只支持平铺 `key: value`。
  - 不支持嵌套 YAML、JSON object、数组写法。
  - `name` 如果存在，必须和目录名一致。
  - `requires_bins` / `requires_env` 是逗号分隔字符串。
  - `always: true` 只有字符串 true 才算真。

- 仓里有 `SKILL.md` 就一定能被主 Agent 看到吗？
  - 不一定。
  - 还必须被 Profile allowlist 包含。
  - 还要满足 `requires_bins` / `requires_env`。

- always Skill 和 `load_skill` 有什么区别？
  - `always=true` 且 available 时，body 直接进入 system prompt。
  - `always=false` 时，模型只先看到 name / description / trigger，需要时再调用 `load_skill`。
  - `load_skill` 返回完整 `SKILL.md`，不是只返回正文。
  - 只有 Profile 有 `loadable_skills` 时才注册这个工具。

- Skill 会不会自己执行外部动作？
  - 不会。
  - Skill 只改变模型理解任务和使用工具的方式。
  - 真正执行仍然要靠 Tool。

- 修改 `SKILL.md` 会自动热更新吗？
  - 正常运行中不会每次调用都重新读磁盘。
  - 修改后要重启或调用 `reload()`。

- Publisher Agent Skills 是不是同一套东西？
  - 不是。
  - Publisher `/api/v3/agent-skills` 管用户侧技能资产：标题、描述、封面、视频、原始 prompt、场景、标签。
  - 它不是 `SkillsLoader` 的扫描源。
  - 当前运行时不会从 Publisher API 动态加载这些技能。

## MCP

- MCP wrapper 做什么？
  - 把远端工具包装成 `mcp_{server_name}_{tool_name}`。
  - 避免外部 server 的工具名直接和本地工具名冲突。
  - 执行时走 `session.call_tool(original_name, arguments=kwargs)`。

- MCP 支持哪三种传输？
  - 有 `command`：stdio。
  - url 以 `/sse` 结尾：SSE。
  - 其他 url：streamable HTTP。

- schema 为什么要做 OpenAI 兼容转换？
  - `type: ["string", "null"]` 会转成 `type: "string", nullable: true`。
  - `oneOf` / `anyOf` 中单个非 null 分支会被合并。
  - object schema 会补齐 `properties` 和 `required`。

- 为什么当前主循环没有启用动态 MCP？
  - `_connect_mcp()` 开头直接 `return`。
  - 注释说明是受限聊天 rollout 下不注册动态 MCP 工具。
  - 适配代码存在，不等于现网已连通。

- 如果以后要启用 MCP，还要补什么？
  - 恢复 `_connect_mcp()`。
  - 处理生命周期、鉴权、server 配置、工具白名单、超时和观测。
  - 一次远端工具异常不应该拖垮整个 Agent loop。

## 边界

- 工具系统替代下游幂等和授权吗？
  - 不替代。
  - 工具只管 name、schema、参数校验、execute、结果回填。
  - `run_workflow` 可以调用工作流服务，但 run 命令幂等仍由 Publisher command id、Consumer inbox 和事件回程保证。

- 为什么不能让 Agent 本地状态成为业务事实源？
  - 工具只是调用封装。
  - 工作流状态、积分、文件所有权仍归对应服务。

- 迁移完成的最小标准是什么？
  - Agent 实例能按 Profile 暴露工具定义。
  - 模型能调用工具，并经过参数转换、校验和执行。
  - 仓内 Skill 能被 allowlist 控制并按需加载。
  - 用户侧 Agent Skills 能增删改查，但不会和运行时 Skill 混淆。
  - MCP 的未启用状态被明确保留，或完整接通后再改文档口径。

## NovelComic 迁移

- 为什么不要一次性把所有业务 API 都暴露给模型？
  - 应该先写最小可用工具闭环，再逐步增加工具。
  - 工具描述和 schema 不精确，会直接变成运行时传参错误。

- 三类 Skills / 工具为什么要分开迁？
  - 运行时工具层：`Tool` / `ToolRegistry` / `AgentProfile` / `AgentFactory`。
  - 仓内技能层：`SkillsLoader` / `SKILL.md` / `load_skill`。
  - 产品技能层：Publisher agent-skills API / dao / schema。

- MCP 第一轮应该怎么写？
  - 可以先落代码结构和配置模型。
  - 不要在第一轮就宣称动态 MCP 已启用。

## 面试短答

- 一句话讲 Agent 工具、Skills 与 MCP？
  - Tool Registry 负责当前实例可执行的工具，SkillsLoader 负责把仓内 `SKILL.md` 变成模型可读说明，MCP 只是外部工具适配层；当前主循环没有动态注册 MCP，Publisher Agent Skills 也不是运行时 Loader 的扫描源。

- 一句话讲 Skill 和 Tool 的区别？
  - Skill 告诉模型何时以及如何使用能力，Tool 才真正执行动作。

- 一句话讲为什么每次 build 都新建 Registry？
  - 工具闭包绑定的是这次请求的 workspace、用户和 dao，Registry 不能跨用户或跨会话复用。

- 一句话讲 MCP 现状？
  - 代码里有 stdio / SSE / HTTP 适配和 wrapper，但 `_connect_mcp()` 直接返回，所以不能写成现网已接通。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - 运行时有 `Tool`、`ToolRegistry`、`AgentFactory`、`SkillsLoader`，Profile 工具会进入 LLM tool definitions。
  - 仓内 Skill 有 allowlist、always 注入和 `load_skill`。
  - Publisher 有 `/api/v3/agent-skills`，并且按用户隔离。
  - MCP wrapper 已写，`AgentLoop._connect_mcp()` 直接返回，动态注册未启用。
  - 前端个人技能页面只是产品目录，不是运行时 Loader。

- 当前实现能不能算本章主链路打通？
  - 工具、仓内 Skills、产品技能和 MCP 边界要分开验收。
  - 技能卡片 CRUD 本身不等于 Agent 工具与 Skills 已完成。
  - 画布 `runAll()` 或首页 Skill mention 仍然不是运行时 Skill Loader。

- 当前测试要覆盖哪些本章风险？
  - Agent 启动后的 LLM tool definitions、未声明工具、独立 Registry。
  - cast / validate / execute，以及参数错误不进入业务逻辑。
  - `SKILL.md` 扫描、目录名校验、allowlist、always 与 `load_skill`。
  - Subagent 深度、MCP mock 包装，以及主循环不动态注册。
  - 产品技能增删改查、跨用户隔离，以及不写入 SkillsLoader。

- 为什么产品技能和仓内 Skill 仍然不是一层？
  - 产品技能是用户资产，保存在 Publisher。
  - 仓内 Skill 来自 `SKILL.md`，还要过 Profile allowlist。
  - 运行时不会把 `/api/v3/agent-skills` 的记录扫描进 SkillsLoader。

- MCP 现在能不能写成现网能力？
  - 不能。
  - 适配代码和 wrapper 存在，主循环没有调用 `connect_mcp_servers()`。
  - 文档、接口和运行时都要说“适配层存在，动态注册未启用”。

- 当前安全边界应该守住什么？
  - 工具执行不能绕过下游 JWT 和用户隔离。
  - `run_workflow` 这类工具不能在 Agent 本地伪造 command 幂等。
  - 文件类工具必须限制 workspace。
  - 产品技能 CRUD 必须按当前用户过滤。

- 如果产品上已经能看到“技能卡片”，应该怎么理解？
  - 那是个人技能目录。
  - 不等于 Registry 里有可执行工具，也不等于 `load_skill` 能加载这条产品记录。

- 什么时候才算本章完整验收？
  - Agent 能按 Profile 暴露工具定义。
  - 模型 tool_call 经过 cast / validate / execute。
  - 仓内 Skill 能被 allowlist 控制，always 与按需加载两条路径都成立。
  - Publisher Agent Skills 能增删改查，且不混进运行时 Loader。
  - MCP 适配存在，但动态注册保持未启用，除非以后同时改代码和文档。
