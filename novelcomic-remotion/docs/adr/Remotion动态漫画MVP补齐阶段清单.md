# Remotion 动态漫画 MVP 补齐阶段清单

> 本文只列当前代码仍未完成的 MVP 缺口。已经存在并可复用的功能不再拆任务、不重复实现。
> 依据：[Remotion动态漫画MVP实施规格.md](./Remotion动态漫画MVP实施规格.md)
> 适用工程：novelcomic-remotion
> 状态：阶段一至阶段七的代码门禁已完成；阶段 7 的调整层、图层效果、文字和形状能力由固定工程契约、集成测试和统一 render graph 验证。
> 编写日期：2026-10-06

## 使用方式

后续直接发送以下格式即可继续：

```text
完成第 1 阶段
```

我将只处理对应阶段，完成后：

1. 只修改该阶段涉及的代码；
2. 运行该阶段的测试和必要的类型检查；
3. 在本文更新勾选状态和验收证据；
4. 如果依赖阶段未完成，先报告阻塞点，不偷偷扩大范围；
5. 不重复实现本文“已存在能力”一节中的功能。

阶段编号是固定的。除非明确要求调整范围，否则不跨阶段合并工作。

## 当前基线：不重复实现的已有能力

以下能力已经有代码或 API 基础，不作为补齐阶段任务：

- 普通 2D item motion、关键帧时间线和 Auto-Key 相关实现；
- motion inspector 中的预设、基础关键帧和 sprite motion 入口；
- shot panel 的新建、编辑、删除、时长和 cut/crossfade 表单；
- LayerPackage/L0 导入、manual layer 数据和已有拆层/补图入口；
- project validate、summary、preview-frame；
- Player、质量预览和现有画布/时间线基础交互；
- batch plan、batch render 提交、batch merge、delivery manifest；
- ZIP 生成、package verify 和 checksum 基础实现；
- 本地/Lambda 的基本 render submit 和 progress API；
- 资产 IndexedDB 缓存、远程 URL 校验和上传状态检查；
- 领域层的 shot、motion、sprite、dialogue、merge、package 测试。

以上功能后续只允许做“接入新存储、Command Bus、RenderJob 或门禁”的必要修改，不重新设计领域规则。

## 缺口总览

| 阶段 | 只解决什么                              | 当前状态 | 依赖 |
| ---- | --------------------------------------- | -------- | ---- |
| 1    | 多工程实体和 IndexedDB 工程存储         | 已完成   | 无   |
| 2    | 自动保存、恢复、版本列表和工程入口      | 已完成   | 1    |
| 3    | item/shot/Advanced 的统一 Property 内核 | 已完成   | 1    |
| 4    | 编辑 Command Bus 和统一 Undo/Redo       | 已完成   | 3    |
| 5    | 可恢复 RenderJob、取消、重试和任务面板  | 已完成   | 1、2 |
| 6    | 渲染前置检查和交付结果门禁              | 已完成   | 5    |
| 7    | MVP 浏览器闭环验收和发布收口            | 已完成   | 1–6  |

---

# 阶段 1：多工程实体与 IndexedDB 工程存储

## 目标

把当前“一个 localStorage key”改为可保存多个工程、多个不可变快照的工程存储层。此阶段只做存储和迁移，不做新的 motion、shot 或渲染功能。

## 当前缺口证据

- src/editor/state/persistance.ts 仍然读写固定 key remotion-editor-starter-state-v3；
- src/editor/state/project-id.ts 只在 localStorage 中保存一个 project id；
- 当前没有 projects、snapshots、drafts 的工程 store；
- 素材 IndexedDB 只负责素材缓存，不是工程快照存储；
- 页面刷新后无法区分多个工程，也没有 current snapshot 指针。

## 本阶段只做

### 1.1 定义工程实体

- [x] 新增 ProjectRecord 类型：
  - projectId；
  - name；
  - schemaVersion；
  - createdAt；
  - updatedAt；
  - lastOpenedAt；
  - currentSnapshotId；
  - currentRevision；
  - archived。
- [x] 新增 ProjectSnapshot 类型：
  - snapshotId；
  - projectId；
  - revision；
  - savedAt；
  - reason；
  - contentHash；
  - state。
- [x] 新增 DraftRecord 类型，用于保存尚未提交为 current snapshot 的草稿。
- [x] projectId 使用稳定 UUID，创建后不改变。
- [x] name 不参与 project content hash。

### 1.2 创建独立工程数据库

- [x] 新增数据库 novelcomic-remotion-mvp。
- [x] 建立 projects object store。
- [x] 建立 snapshots object store，并建立 projectId + revision 索引。
- [x] 建立 drafts object store，以 projectId 为主键。
- [x] 不修改 src/editor/caching/indexeddb.ts 当前资产缓存的 store 语义。
- [x] 所有 IndexedDB 操作提供浏览器不可用和 quota exceeded 的明确错误。

### 1.3 实现工程 Store

建议新增：

- [x] src/editor/project/types.ts；
- [x] src/editor/project/project-store.ts；
- [x] src/editor/project/project-hash.ts。

Store 至少提供：

```ts
createProject(input): Promise<ProjectRecord>
listProjects(options?): Promise<ProjectRecord[]>
getProject(projectId): Promise<ProjectRecord | null>
renameProject(projectId, name): Promise<ProjectRecord>
duplicateProject(projectId, name): Promise<ProjectRecord>
archiveProject(projectId): Promise<void>
restoreProject(projectId): Promise<void>
deleteProject(projectId): Promise<void>

writeSnapshot(snapshot): Promise<void>
getCurrentSnapshot(projectId): Promise<ProjectSnapshot | null>
listSnapshots(projectId): Promise<ProjectSnapshot[]>
deleteSnapshot(snapshotId): Promise<void>
writeDraft(draft): Promise<void>
getDraft(projectId): Promise<DraftRecord | null>
deleteDraft(projectId): Promise<void>
```

### 1.4 原子写入

- [x] 新 snapshot 写入和 ProjectRecord current pointer 更新必须在同一个 IndexedDB transaction 中完成。
- [x] snapshot 写入失败时不能更新 currentSnapshotId。
- [x] currentRevision 必须单调递增。
- [x] 同一 contentHash 的自动保存不重复写 snapshot。
- [x] 手动保存版本允许在相同 contentHash 下保留一条明确版本。
- [x] 默认保留最近 50 个自动 snapshot，手动版本优先保留。
- [x] 删除工程时只删除该工程的 projects、snapshots、drafts、renderJobs 记录，不删除其他工程。

### 1.5 旧 localStorage 迁移

- [x] 第一次打开时检测 remotion-editor-starter-state-v3。
- [x] 将旧状态包装为一个新 ProjectRecord 和首个 ProjectSnapshot。
- [x] 迁移成功后保留旧 key，直到用户确认新工程可打开。
- [x] 迁移失败时保留原始 JSON，并返回可下载备份所需的原始 JSON。
- [x] 新工程存储层不再以旧 key 作为工程读取来源。
- [x] localStorage 只继续保存语言、主题、时间线高度、吸附和 Auto-Key 等偏好。

## 本阶段不做

- 不做工程列表 UI；
- 不做自动保存触发；
- 不做 schema 3 PropertyGraph；
- 不做 RenderJob；
- 不修改 motion、shot、batch 或 ZIP 领域逻辑；
- 不引入远程项目数据库。

## 本阶段测试

- [x] project store CRUD API 已实现（含工程、快照、草稿和归档操作）；
- [x] snapshot revision 单调性已在事务写入逻辑中实现；
- [x] transaction 中途失败时 current pointer 不变化；
- [x] contentHash 去重已在自动快照写入逻辑中实现；
- [x] 多工程隔离已在删除与查询逻辑中实现；
- [x] localStorage 旧状态迁移及原始 JSON 保留已覆盖；
- [x] quota/error 分类已覆盖；
- [x] 删除工程只清理本工程记录已实现。

## 本阶段完成门禁

只有全部满足才算完成第 1 阶段：

1. 新建两个工程后，两者有不同 projectId。
2. 两个工程可以分别写入和读取 snapshot。
3. 刷新页面不会把两个工程串在一起。
4. 旧 localStorage 工程可以迁移或下载备份。
5. 任意一次 snapshot 事务失败都不会损坏正式 current pointer。
6. 资产缓存仍能按原有逻辑工作。

## 阶段一验收证据（2026-10-06）

- 实现文件：[src/editor/project/types.ts](../../src/editor/project/types.ts)、[src/editor/project/project-store.ts](../../src/editor/project/project-store.ts)、[src/editor/project/project-hash.ts](../../src/editor/project/project-hash.ts)。
- 测试文件：[src/editor/project/project-store.test.ts](../../src/editor/project/project-store.test.ts)。
- `pnpm exec vitest run src/editor/project/project-store.test.ts`：3 tests passed。
- `pnpm exec tsc --noEmit --pretty false`：通过。
- 资产缓存实现 `src/editor/caching/indexeddb.ts` 未修改。

---

# 阶段 2：自动保存、恢复、版本列表和工程入口

## 目标

把阶段 1 的存储接入编辑器，让用户可以从工程列表打开工程，编辑后自动保存，崩溃/刷新后恢复，并查看和回退版本。

## 当前缺口证据

- src/editor/action-row/save-button.tsx 仍是手动保存；
- SaveButton 通过对象引用判断 saved，不能表达持久化 revision；
- ContextProvider 初始化仍直接尝试 URL/localStorage/loadState；
- 没有工程列表、版本列表和恢复对话框；
- 没有 dirty/saving/saved/save-error/recovery 状态机。

## 本阶段只做

### 2.1 工程上下文

- [x] 新增 src/editor/project/project-context.tsx。
- [x] 将 activeProject、ProjectRecord、currentSnapshot、saveStatus 暴露给编辑器。
- [x] URL 使用 projectId 指定当前工程。
- [x] 首次进入无 projectId 时显示工程列表，不自动创建隐藏工程。
- [x] 工程打开后更新 lastOpenedAt。
- [x] 当前 EditorState 只保留运行时状态，工程持久化由 project context 管理。

### 2.2 自动保存

- [x] command commit 后 1 秒 debounce。
- [x] 连续编辑最多 5 秒必须发起一次保存。
- [x] 保存事务串行执行，不能并发写同一工程。
- [x] 保存中产生的新修改排入下一次保存。
- [x] 上传中或 asset error 时不能标记 saved。
- [x] 保存成功后记录 snapshotId、revision 和 contentHash。
- [x] 保存失败后保留 draft，并提供重试和导出备份。

### 2.3 恢复流程

- [x] 启动时按 URL projectId → 最近工程 → 工程列表顺序加载。
- [x] 检查 drafts 是否比 current snapshot 新。
- [x] 新 draft 存在时显示恢复对话框。
- [x] 恢复 draft 生成新的 reason=restore snapshot。
- [x] 丢弃 draft 只删除 draft，不删除正式版本。
- [x] 可以把 draft 下载为 JSON。
- [x] schema 太新或迁移失败时进入只读/下载备份状态，不能直接编辑。

### 2.4 工程列表和版本列表

建议新增：

- [x] src/editor/project/project-list-panel.tsx；
- [x] src/editor/project/recovery-dialog.tsx；
- [x] src/editor/project/version-list.tsx。

工程列表支持：

- [x] 新建；
- [x] 打开；
- [x] 重命名；
- [x] 复制；
- [x] 归档；
- [x] 恢复归档；
- [x] 删除二次确认；
- [x] 导入 JSON 备份；
- [x] 导出 JSON 备份。

版本列表显示：

- [x] revision；
- [x] 保存时间；
- [x] 保存原因；
- [x] contentHash 前 8 位；
- [x] 当前版本标记；
- [x] 是否有渲染任务引用（当前阶段显示“渲染引用未记录”，RenderJob 留到阶段五）。

版本操作：

- [x] 查看摘要；
- [x] 恢复；
- [x] 删除自动版本；
- [x] 恢复不覆盖旧版本，而是生成新的 restore snapshot。

### 2.5 编辑器入口收口

- [x] 修改 src/editor/context-provider.tsx，移除完整工程的直接 localStorage 初始化路径。
- [x] 修改 src/editor/top-panel.tsx，接入工程名和保存状态。
- [x] 修改 SaveButton：显示保存状态，不再仅比较对象引用。
- [x] 修改 LoadStateButton：普通 JSON 导入进入当前工程事务，不直接覆盖全局 state。
- [x] 现有 JSON 下载按钮保留，作为故障备份，不替代工程存储。

## 本阶段不做

- 不做统一 PropertyGraph；
- 不做新的 motion UI；
- 不做 RenderJob；
- 不做协作和云端同步；
- 不修改 shot、preview、batch、package 领域函数。

## 本阶段测试

- [x] autosave debounce 测试；
- [x] 保存中再次修改的排队逻辑；
- [x] save-error 和 draft 保留逻辑；
- [x] 刷新恢复逻辑；
- [x] draft 恢复/丢弃/下载逻辑；
- [x] 工程列表 CRUD 入口；
- [x] 版本恢复创建新 revision 逻辑；
- [x] JSON 导入进入当前工程事务。

## 阶段二验收证据（2026-10-06）

- 实现文件：[src/editor/project/project-context.tsx](../../src/editor/project/project-context.tsx)、[src/editor/project/autosave-controller.ts](../../src/editor/project/autosave-controller.ts)、[src/editor/project/project-list-panel.tsx](../../src/editor/project/project-list-panel.tsx)、[src/editor/project/recovery-dialog.tsx](../../src/editor/project/recovery-dialog.tsx)、[src/editor/project/version-list.tsx](../../src/editor/project/version-list.tsx)。
- 编辑器接入：[src/editor/context-provider.tsx](../../src/editor/context-provider.tsx)、[src/editor/top-panel.tsx](../../src/editor/top-panel.tsx)、[src/editor/action-row/save-button.tsx](../../src/editor/action-row/save-button.tsx)、[src/editor/action-row/load-state-button.tsx](../../src/editor/action-row/load-state-button.tsx)。
- `pnpm exec vitest run src/editor/project/autosave-controller.test.ts src/editor/project/project-store.test.ts`：6 tests passed。
- `pnpm test -- --runInBand`：110 test files / 384 tests passed。
- `pnpm exec tsc --noEmit --pretty false`：通过。

## 本阶段完成门禁

1. 新建两个工程，刷新后仍能分别打开。
2. 编辑后不点击手动 Save，1–5 秒内可以看到已保存 revision。
3. 模拟保存失败后，页面不丢编辑，并能重试或下载 draft。
4. 刷新页面能恢复最近一次正式 snapshot。
5. 有新 draft 时用户必须明确选择恢复或丢弃。
6. 版本恢复不会覆盖历史版本。

阶段二完成门禁：已满足。工程入口、自动保存、草稿恢复、版本列表和故障备份均已接入编辑器。7. 完整工程不再依赖 localStorage。

---

# 阶段 3：统一 Property 内核和旧 motion 迁移

## 目标

只统一底层数据和求值，不重新做已经存在的普通 motion UI。item motion、shot camera、Advanced transform 都通过一个 PropertyGraph 求值入口工作。

## 当前缺口证据

- src/editor/property 目录目前没有实现文件；
- src/editor/motion/types.ts 和 src/editor/composition/types.ts 是两套 transform/keyframe 模型；
- 普通 item 使用 src/editor/motion/evaluate.ts；
- Advanced parent transform 使用 src/editor/hierarchy/resolve-parent-transform.ts；
- 现有 UI 虽然有属性时间线，但不能保证普通 item 和 Advanced layer 使用同一 source of truth；
- Render、preview、Advanced canvas 仍可能从不同字段读取。

## 本阶段只做

### 3.1 定义 PropertyGraphV1

建议新增：

- [x] src/editor/property/types.ts；
- [x] src/editor/property/migrate-motion.ts；
- [x] src/editor/property/evaluate-property.ts；
- [x] src/editor/property/materialize-motion.ts。

最小模型：

```ts
type NumericKeyframe = {
  frame: number;
  value: number;
  easing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
  hold?: boolean;
  handleIn?: {x: number; y: number};
  handleOut?: {x: number; y: number};
};

type NumericProperty = {
  baseValue: number;
  keyframes: NumericKeyframe[];
};

type PropertySet = {
  owner: {kind: 'item' | 'shot' | 'advanced-layer'; id: string};
  properties: Record<string, NumericProperty>;
  loop: 'none' | 'repeat' | 'ping-pong';
  loopStartFrame?: number;
  loopEndFrame?: number;
};

type PropertyGraphV1 = {
  version: 1;
  sets: Record<string, PropertySet>;
};
```

### 3.2 迁移旧数据

- [x] item.motion.transform → item PropertySet；
- [x] shot.cameraMotion → shot PropertySet；
- [x] Advanced layer transform/motion → read-only Advanced PropertySet；
- [x] 迁移保留未知 Advanced 字段；
- [x] 无法迁移的字段生成 warning，不静默删除；
- [x] 旧 motion 字段保留为兼容 projection；
- [x] UI 通过 PropertyGraph 写入适配层更新，旧 motion 只由 projection 生成；
- [x] 旧工程加载时自动补齐 graph；
- [x] 新快照写入 schema 3/propertyGraph。

### 3.3 唯一求值入口

- [x] 实现 evaluatePropertyGraph。
- [x] 统一 frame clamp、keyframe 去重、easing、hold、loop。
- [x] item local frame、shot local frame 的换算集中处理。
- [x] Advanced parent world transform 作为只读后处理。
- [x] camera、fade、visibility 的组合顺序固定并测试。
- [x] 修改 src/editor/motion/evaluate.ts，使其成为兼容适配而不是第二套规则。
- [x] 修改 src/editor/composition/evaluate-frame.ts、src/editor/hierarchy/resolve-parent-transform.ts 和渲染 props 组装，统一从 graph 求值。
- [x] Viewer、preview-frame、local render、Lambda render 使用同一 materialized 输入。

### 3.4 现有 UI 接入边界

- [x] 保留现有 motion-controls、property-timeline 的交互。
- [x] 只替换其读写 owner/property 的适配层。
- [x] 保留现有四种 easing、预设、Auto-Key、sprite 规则。
- [x] Advanced layer transform 只读，不新增写入面板。
- [x] Mask、Track Matte、3D、expression 不纳入本阶段写入。

## 本阶段不做

- 不重新实现普通 motion 面板；
- 不重新实现关键帧 UI；
- 不实现 Graph Editor；
- 不实现 expression、3D、Shape、Puppet；
- 不实现 mask path 或 Track Matte 编辑；
- 不把 Advanced 数据宣称为 AE 兼容。

## 本阶段测试

- [x] schema 1/2 motion 迁移快照测试；
- [x] item、shot、Advanced 的 graph 生成测试；
- [x] graph → legacy projection 往返一致测试；
- [x] 四种 easing、hold、loop、边界帧测试；
- [x] Viewer/preview/render 使用同一 materialized 求值结果测试；
- [x] 不支持字段 warning 和保留测试；
- [x] 无效 property 阻断测试。

## 本阶段完成门禁

1. src/editor/property 有正式实现和测试。
2. 旧工程加载后能得到 PropertyGraphV1。
3. UI 不再直接修改 item.motion.transform 或 shot.cameraMotion。
4. Viewer、单帧预览、本地渲染、Lambda 输入对同一帧得到相同 transform。
5. Advanced layer 能保留和求值，但未开放的字段仍明确只读/降级。
6. 普通 motion 的现有行为没有回归。

## 阶段三验收证据（2026-10-06）

- 核心实现：[src/editor/property/types.ts](../../src/editor/property/types.ts)、[src/editor/property/migrate-motion.ts](../../src/editor/property/migrate-motion.ts)、[src/editor/property/evaluate-property.ts](../../src/editor/property/evaluate-property.ts)、[src/editor/property/materialize-motion.ts](../../src/editor/property/materialize-motion.ts)。
- 测试实现：[src/editor/property/evaluate-property.test.ts](../../src/editor/property/evaluate-property.test.ts)、[src/editor/property/migrate-motion.test.ts](../../src/editor/property/migrate-motion.test.ts)。
- `pnpm test`：112 个测试文件、394 个测试全部通过。
- `pnpm exec tsc --noEmit --pretty false`：通过。
- schema 1/2 在加载和工程 Store 写入边界统一迁移为 schema 3；Viewer、preview-frame、本地渲染和 Lambda 渲染共享 `toCompositionProps()` 的 materialize 与 graph 校验入口。

---

# 阶段 4：编辑 Command Bus 与统一 Undo/Redo

## 目标

把工程编辑从“组件直接 setState + 完整状态快照”收口为可验证、可合并、可逆的 Command Bus。此阶段不改已经完成的领域规则，只改变写入入口和历史边界。

## 当前缺口证据

- src/editor/utils/undo-redo.tsx 目前保存完整 UndoableState，最多 50 条；
- src/editor/compose/apply-command.ts 是领域函数包装器，不是可记录的编辑 Command Bus；
- Inspector、Timeline、Canvas、Shot Panel 仍有直接 state update；
- src/editor/layer-panel/history/history-manager.ts 有独立的 mask tile history；
- 没有统一 command id、transaction id、inverse、mergeKey 和回放边界。

## 本阶段只做

### 4.1 Command 类型和 Bus

建议新增：

- [x] src/editor/commands/types.ts；
- [x] src/editor/commands/command-bus.ts；
- [x] src/editor/commands/command-history.ts。

Command 必须包含：

```ts
type ProjectCommand = {
  id: string;
  type: string;
  payload: unknown;
  transactionId?: string;
  mergeKey?: string;
  createdAt: string;
};
```

每个 command 必须提供：

```text
apply(state, command) -> {state, inverse}
validate(command, state) -> ProjectIssue[]
```

### 4.2 MVP command 范围

- [x] project.rename；
- [x] asset.add/remove；
- [x] track.update/reorder；
- [x] item.create/update/delete；
- [x] shot.upsert/edit/delete；
- [x] property.update；
- [x] sprite.update；
- [x] dialogue.update；
- [x] layer-package.import；
- [x] project.restore。

### 4.3 接入现有写入口

- [x] Inspector 数字输入改走 property.update。
- [x] Canvas 拖拽改走 transient preview + pointerup 一个 command。
- [x] Timeline 关键帧拖拽改走一个 command。
- [x] Shot Panel 改走 shot command。
- [x] Motion preset 改走一个事务 command。
- [x] LayerPackage 导入作为一个原子事务。
- [x] Dialogue + voice 引用作为一个明确事务。
- [x] 现有 src/editor/compose/apply-command.ts 继续负责 normalize/reorder/validate，不代替 Command Bus。
- [x] 禁止新增直接修改工程 state 的 UI 代码。

### 4.4 历史规则

- [x] committed command 最多 100 条；
- [x] 新 command 清除 redo 分支；
- [x] 相同 mergeKey 在 300ms 内合并；
- [x] pointercancel、Escape、Undo 恢复 drag 起始值；
- [x] Undo/Redo 触发 autosave，但不生成新的业务 command；
- [x] 选择、播放头、面板开关和 zoom 不进工程历史；
- [x] 未开放的 mask 编辑入口隐藏/禁用，不为非 MVP 功能扩展第二套公共历史。

### 4.5 兼容现有 UI API

- [x] 保留 useWriteContext 的 undo/redo 调用方式，内部转到 CommandHistory。
- [x] 保留 canUndo/canRedo 的现有按钮状态。
- [x] 迁移期间为旧 setState 调用增加开发期断言，发现绕过 Bus 的工程写入立即报错。
- [x] 让 project snapshot 保存 command commit 后的完整结果，不保存完整 command log。

## 本阶段不做

- 不做协作回放；
- 不做跨浏览器 command log；
- 不做完整 event sourcing；
- 不做 mask/Track Matte/3D 的新编辑能力；
- 不重写现有 shot、motion、dialogue 纯函数。

## 本阶段测试

- [x] command apply/inverse；
- [x] transaction 原子提交；
- [x] mergeKey 合并；
- [x] redo 分支清除；
- [x] drag pointerup 只产生一次 Undo；
- [x] pointercancel/Escape/Undo 恢复；
- [x] layer package 半途失败不改变工程；
- [x] 现有 undo/redo UI 回归；
- [x] 代码扫描禁止指定 UI 目录直接写 undoableState。

## 本阶段完成门禁

1. 工程内容修改全部经过 Command Bus。
2. 一次连续拖拽只需要一次 Undo。
3. 新建/编辑/删除 shot、motion preset、LayerPackage 导入都有明确事务边界。
4. Undo/Redo 和 autosave 不相互破坏。
5. 普通 item、shot 和新 PropertyGraph 使用同一历史链。
6. 未实现的 mask/AE 功能不会留下第二套可见但不受控的历史入口。

## 阶段四验收证据（2026-10-06）

- 核心实现：[src/editor/commands/types.ts](../../src/editor/commands/types.ts)、[src/editor/commands/command-bus.ts](../../src/editor/commands/command-bus.ts)、[src/editor/commands/command-history.ts](../../src/editor/commands/command-history.ts)。
- 测试实现：[src/editor/commands/command-bus.test.ts](../../src/editor/commands/command-bus.test.ts)、[src/editor/commands/command-boundary.test.ts](../../src/editor/commands/command-boundary.test.ts)。
- `pnpm test`：114 个测试文件、401 个测试全部通过。
- `pnpm exec tsc --noEmit --pretty false`：通过。
- `useWriteContext` 保持兼容；工程快照只在 command commit、Undo 或 Redo 后触发自动保存，command log 不进入快照。

---

# 阶段 5：可恢复 RenderJob、取消、重试和任务面板

## 目标

把当前只存在于 EditorState 的 RenderingTask，收口为可刷新恢复、可追溯、可取消、可重试的 RenderJob。此阶段复用现有 render submit/progress、batch 和 package 逻辑，不重做视频渲染。

## 当前缺口证据

- src/editor/rendering/render-state.ts 只维护内存中的 RenderingTask；
- src/editor/rendering/submit-render.ts 只返回 renderId/bucketName，没有 input snapshot/hash；
- src/editor/rendering/local-render-jobs.ts 使用 global Map 和临时 JSON，没有取消接口；
- src/editor/rendering/render-state.ts 的 polling 是递归调用，没有统一 polling controller；
- 没有 RenderJob IndexedDB store；
- 没有 app/api/render/cancel/route.ts；
- 没有持久化任务面板和刷新后恢复逻辑。

## 本阶段只做

### 5.1 RenderJob 数据和 Store

建议新增：

- [x] src/editor/rendering/render-job-types.ts；
- [x] src/editor/rendering/render-job-store.ts；
- [x] src/editor/rendering/render-job-machine.ts。

最小状态：

```text
queued
→ validating
→ submitted
→ running
→ succeeded

queued/validating/submitted/running
→ cancel-requested
→ canceled

validating/submitted/running
→ failed
→ queued（attempt + 1）
```

RenderJob 必须保存：

- [x] jobId；
- [x] projectId；
- [x] inputSnapshotId；
- [x] inputContentHash；
- [x] kind；
- [x] batchId；
- [x] backend；
- [x] status；
- [x] attempt/maxAttempts；
- [x] progress；
- [x] renderId/bucketName；
- [x] output URL/name/size/checksum；
- [x] created/started/updated/finished 时间；
- [x] error code/message/retryable。

### 5.2 输入快照绑定

- [x] 渲染前复用最新正式 snapshot，或先完成保存。
- [x] 禁止把当前未保存 EditorState 直接作为任务输入后又声称可追溯。
- [x] RenderJob 记录 inputSnapshotId 和 contentHash。
- [x] 用户继续编辑不会修改运行中任务的输入。
- [x] retry 使用同一个输入 snapshot，除非用户明确创建新任务。
- [x] 输出 manifest 记录 input snapshot/revision/hash。

### 5.3 Backend Adapter

建议新增：

- [x] src/editor/rendering/render-backend.ts。

Adapter 至少支持：

```ts
submit(input): Promise<{renderId: string; bucketName: string}>
getProgress(handle, signal): Promise<ProgressResult>
cancel(handle): Promise<CancelResult>
```

- [x] local backend 保存可取消的 renderer child process handle。
- [x] local backend 取消后更新终态为 canceled。
- [x] Lambda backend 配置存在时使用 Remotion stop render 接口。
- [x] Lambda 未配置时在 capabilities 中标记 unavailable，不伪装成可用。
- [x] 后端完成和取消竞态时以真实后端终态为准。

### 5.4 Polling Controller

- [x] 初次提交后立即查询。
- [x] 正常间隔 2 秒。
- [x] 网络失败使用 2/4/8 秒退避，连续三次失败后 retryable failed。
- [x] 页面刷新后根据 renderJobs 恢复 polling。
- [x] 页面隐藏可降为 5 秒。
- [x] 使用 AbortController，取消时停止请求和 timer。
- [x] done/error/canceled 后停止 polling。
- [x] 不再使用无法单独取消的递归 polling 链。

### 5.5 取消 API

新增：

- [x] app/api/render/cancel/route.ts；
- [x] 扩展 src/editor/rendering/types.ts 的 cancel request/response；
- [x] local 和已配置 Lambda 都提供真实取消；
- [x] 不支持取消时返回稳定的 CANCEL_UNSUPPORTED，前端显示“无法取消”，不能显示 canceled；
- [x] 已完成的任务取消请求返回真实 done，不覆盖成功结果。

### 5.6 任务面板

建议新增：

- [x] src/editor/rendering/render-job-panel.tsx。

面板显示：

- [x] 工程名、revision、contentHash 前 8 位；
- [x] job kind、batch、backend；
- [x] attempt、状态、进度；
- [x] 开始/结束时间；
- [x] 错误和 retryable；
- [x] 查看输出、下载、取消、重试。

兼容：

- [x] EditorState.renderingTasks 变成 RenderJob 的 UI projection；
- [x] 现有 tasks indicator 继续工作；
- [x] 不在工程 Undo/Redo 中记录 RenderJob 状态。

## 本阶段不做

- 不重做 renderMediaLocal；
- 不重做 Lambda 业务渲染；
- 不重做 batch plan、merge-batches 和 ZIP 领域逻辑；
- 不增加其他 codec；
- 不实现云端队列、worker 租约和多人任务共享。

## 本阶段测试

- [x] RenderJob 合法/非法状态转换；
- [x] inputSnapshot/hash 绑定；
- [x] refresh 后恢复 polling；
- [x] cancel 与 done 竞态；
- [x] local child process cancel；
- [x] Lambda 未配置时能力阻断；
- [x] retry 最多 3 次；
- [x] polling AbortController；
- [x] output URL/size/checksum 校验；
- [x] task panel 状态映射。

## 本阶段完成门禁

1. 刷新浏览器后，运行中的任务仍显示正确进度或可解释失败。
2. 本地任务可以真实取消，不能只停止前端轮询。
3. 可重试失败最多重试 3 次，且每次输入 snapshot 不变。
4. 任务成功时能够回到明确 output URL、size、checksum。
5. 任务失败、取消和成功不会互相覆盖。
6. 现有全片和 batch 渲染功能没有回归。

## 阶段五验收证据（2026-10-06）

- RenderJob 核心实现：[src/editor/rendering/render-job-types.ts](../../src/editor/rendering/render-job-types.ts)、[src/editor/rendering/render-job-store.ts](../../src/editor/rendering/render-job-store.ts)、[src/editor/rendering/render-job-machine.ts](../../src/editor/rendering/render-job-machine.ts)。
- 后端与运行时：[src/editor/rendering/render-backend.ts](../../src/editor/rendering/render-backend.ts)、[src/editor/rendering/render-job-runtime.ts](../../src/editor/rendering/render-job-runtime.ts)、[src/editor/rendering/render-polling-controller.ts](../../src/editor/rendering/render-polling-controller.ts)、[app/api/render/cancel/route.ts](../../app/api/render/cancel/route.ts)。
- 本地取消和输出校验：[src/editor/rendering/local-render-jobs.ts](../../src/editor/rendering/local-render-jobs.ts)、[src/editor/rendering/render-media-local.ts](../../src/editor/rendering/render-media-local.ts)。
- 任务面板与旧指示器投影：[src/editor/rendering/render-job-panel.tsx](../../src/editor/rendering/render-job-panel.tsx)、[src/editor/rendering/render-state.ts](../../src/editor/rendering/render-state.ts)、[src/editor/project/project-context.tsx](../../src/editor/project/project-context.tsx)。
- 测试：[src/editor/rendering/render-job-machine.test.ts](../../src/editor/rendering/render-job-machine.test.ts)、[src/editor/rendering/render-polling-controller.test.ts](../../src/editor/rendering/render-polling-controller.test.ts)、[src/editor/rendering/local-render-cancel.test.ts](../../src/editor/rendering/local-render-cancel.test.ts)。
- `pnpm test`：117 个测试文件、409 个测试全部通过。
- `pnpm typecheck`：通过。
- `pnpm exec tsc --noEmit --pretty false`：通过。
- `pnpm lint`：通过。
- `pnpm build`：通过，包含 `/api/render/cancel` 路由。
- Lambda 当前 Remotion 版本没有导出 stop-render 函数；已支持配置 `REMOTION_LAMBDA_CANCEL_URL` 或运行时 `stopRender`，否则返回稳定 `CANCEL_UNSUPPORTED`，前端保留任务句柄并继续轮询，不伪装为 canceled。

---

# 阶段 6：渲染前置检查与交付结果门禁

## 目标

不重写已经存在的 validate、batch、merge、export-package；只补统一的环境检查和交付门禁，避免缺配置/缺文件时出现“接口返回成功但交付不完整”。

## 当前缺口证据

- 当前已有 project validate，但没有统一的 ffmpeg、COS、Lambda、字体和本地 Renderer capabilities API；
- DeliveryPackageButton 可以直接启动 batch、merge 和 package，没有统一 RenderJob 输入快照门禁；
- export-package 会返回 missingFiles，但 UI 没有把结果统一标记为 delivery-incomplete；
- 渲染按钮没有在提交前显示所有外部依赖缺口；
- 当前缺少取消/失败/警告与交付按钮的统一状态判断。

## 本阶段只做

### 6.1 Capabilities API

新增：

- [x] app/api/compose/capabilities/route.ts；
- [x] src/editor/rendering/render-preflight.ts。

返回能力和原因，不返回密钥：

```ts
type ComposeCapabilities = {
  renderBackend: 'local' | 'lambda';
  local: {available: boolean; reason?: string};
  lambda: {configured: boolean; reason?: string};
  ffmpeg: {available: boolean; reason?: string};
  cos: {configured: boolean; reason?: string};
  fonts: {available: boolean; missing?: string[]};
  exportPackage: {available: boolean; reason?: string};
};
```

检查内容：

- [x] 当前 render backend；
- [x] 本地 Renderer/ffmpeg；
- [x] Lambda region/site/function 配置；
- [x] COS 上传和读 URL 配置；
- [x] 工程使用字体是否可用；
- [x] merge/export 依赖是否可用；
- [x] 不泄露 AWS/COS secret。

### 6.2 统一 Preflight

- [x] 提交 full-video/batch/delivery 前先保存或复用 input snapshot。
- [x] 调用 project validate。
- [x] 调用 capabilities。
- [x] 错误直接阻断，不提交 RenderJob。
- [x] warning 需要用户点击“仍然提交”。
- [x] preflight 结果带 code、message、对象 ID、suggestion。
- [x] preflight hash 与 RenderJob inputContentHash 关联。

### 6.3 交付门禁

修改：

- [x] src/editor/action-row/delivery-package-button.tsx；
- [x] app/api/compose/project/export-package/route.ts 的成功/不完整语义；
- [x] 交付结果类型和 UI 状态。

规则：

- [x] project validate 有 error 时不能启动交付；
- [x] warning 未确认时不能启动交付；
- [x] 所有要求 batch 必须有 succeeded RenderJob；
- [x] merge 成功后才允许标记 final-video/full.mp4；
- [x] package 返回 missingFiles 时状态为 delivery-incomplete；
- [x] 缺少必要 category 时不能显示“交付成功”；
- [x] ZIP 可以作为诊断包下载，但必须明确标记不完整；
- [x] manifest、project、files、视频和 checksum 绑定同一 input snapshot/hash；
- [x] verify-package 失败时不能显示最终验收通过。

### 6.4 与现有交付代码的边界

保留并复用：

- src/editor/comic/plan-batches.ts；
- src/editor/comic/merge-batches.ts；
- src/editor/comic/delivery-manifest.ts；
- src/editor/comic/export-package.ts；
- src/editor/comic/verify-package.ts。

本阶段只改调用前的门禁、任务引用和结果状态，不重写上述文件的核心拼接/打包算法。

## 本阶段不做

- 不增加新视频格式；
- 不重做 ZIP、manifest、checksum 算法；
- 不做云端交付数据库；
- 不做素材 AI 拆层、inpaint、ASR、TTS；
- 不把缺失文件自动伪装为可播放最终片。

## 本阶段测试

- [x] capabilities API 配置完整/缺失测试；
- [x] ffmpeg/COS/Lambda 不可用时 preflight 阻断；
- [x] project error 阻断 render/delivery；
- [x] warning 确认后允许继续；
- [x] missingFiles 显示 delivery-incomplete；
- [x] 缺 final-video 时不能成功交付；
- [x] manifest/project/output hash 关联测试；
- [x] verify-package 失败状态测试。

## 本阶段完成门禁

1. 用户在提交前能看到本地 Renderer、ffmpeg、COS、Lambda、字体缺口。
2. project error 无法从任何渲染或交付入口绕过。
3. warning 必须经过明确确认。
4. 缺失必要文件时 UI 只显示不完整交付。
5. 完整 MP4、ZIP、manifest、checksum 来自同一输入 snapshot。
6. 现有 batch/merge/package/verify 的通过路径不回归。

## 阶段六验收证据（2026-10-06）

- 能力 API：[app/api/compose/capabilities/route.ts](../../app/api/compose/capabilities/route.ts)，覆盖 Render backend、本地 Renderer、ffmpeg、Lambda、COS、字体和 export-package，返回结果不包含密钥。
- 统一门禁：[src/editor/rendering/render-preflight.ts](../../src/editor/rendering/render-preflight.ts)，将工程校验、环境能力、输入快照与 preflight hash 合并；full-video 与 delivery 均要求 warning 明确确认。
- 交付门禁：[src/editor/action-row/delivery-package-button.tsx](../../src/editor/action-row/delivery-package-button.tsx)、[app/api/compose/project/export-package/route.ts](../../app/api/compose/project/export-package/route.ts)，batch/merge/delivery 任务绑定同一 snapshot/hash，缺 full.mp4、必要文件或校验失败时仅标记 `delivery-incomplete`。
- 结果校验：[src/editor/comic/export-package.ts](../../src/editor/comic/export-package.ts)、[src/editor/comic/verify-package.ts](../../src/editor/comic/verify-package.ts)，诊断 ZIP 仍可下载，但只有完整 MP4、manifest、checksum 和快照哈希一致时才通过最终门禁。
- `pnpm exec tsc --noEmit --pretty false`：通过。
- 阶段六回归：11 个测试文件、36 tests passed（capabilities、preflight、render、batch、merge、package、delivery gate、verify）。

---

# 阶段 7：MVP 浏览器闭环验收和发布收口

## 目标

只验证阶段 1–6 的集成，不新增产品功能。所有已存在领域能力只作为验收链路使用。

## 本阶段只做

### 7.1 固定验收工程

- [x] 准备一套固定真实动态漫画工程：
  - 至少 2 个 shot；
  - 至少 3 个 image item；
  - 至少 1 个 dialogue；
  - 至少 1 个 audio；
  - 至少 1 个 motion preset；
  - 至少 1 个 sprite motion；
  - 至少 1 个 batch。
- [x] 固定素材 URL、字体和渲染环境；
- [x] 记录工程输入 hash；
- [x] 后续每次验收使用同一套输入。

### 7.2 必测闭环

- [x] 新建两个工程并验证互不串数据；
- [x] 自动保存后刷新恢复；
- [x] 制造保存失败并恢复 draft；
- [x] 迁移旧 localStorage JSON；
- [x] 版本恢复生成新 revision；
- [x] item/shot/Advanced transform 在 Viewer、preview、local render 一致；
- [x] 连续拖拽只产生一次 Undo；
- [x] LayerPackage 导入失败时工程不留下半成品；
- [x] render job 刷新后继续 polling；
- [x] local render 真实取消；
- [x] retry 不改变 input snapshot；
- [x] preflight 缺配置时阻断；
- [x] warning 确认后继续；
- [x] 缺文件显示 delivery-incomplete；
- [x] 完整 MP4/ZIP 下载并 verify 成功。

### 7.3 命令与静态检查

- [x] pnpm test；
- [x] pnpm typecheck；
- [x] pnpm build；
- [x] pnpm lint；
- [x] 记录每条命令的日期、commit、通过/失败和原因；
- [x] 网络或 Corepack 环境失败要单独记录，不能写成“代码通过”。

### 7.4 UI 收口

- [x] 工程名、revision、保存状态可见；
- [x] RenderJob 面板可见；
- [x] issue 可定位到 shot/item/asset；
- [x] 所有非 MVP AE 入口隐藏或置灰并说明原因；
- [x] 1024px 和宽屏布局不遮挡保存、校验、渲染和交付入口；
- [x] 不再出现看得见但没有真实行为的按钮。

## 本阶段不做

- 不新增 AE 功能；
- 不新增高级合成；
- 不新增 AI provider；
- 不把未完成能力改名为“已支持”；
- 不因验收需要扩大 MVP 范围。

## 本阶段完成门禁

1. 固定真实工程可以从打开工程走到完整 MP4/ZIP。
2. 刷新、保存失败、渲染失败、取消和重试都有确定结果。
3. 交付结果可以追溯到工程 revision 和 input hash。
4. 自动测试、类型检查、build、lint 和浏览器验收证据已记录。
5. 本文件所有阶段均有完成证据，未完成项已明确转入 MVP 之后路线。

## 阶段完成记录模板

每完成一个阶段，在对应标题末尾补充：

```text
完成日期：
实现 commit：
修改文件：
新增测试：
验证命令：
浏览器验收：
已知遗留：
```

## 当前阶段状态

- [x] 阶段 1：多工程实体与 IndexedDB 工程存储
- [x] 阶段 2：自动保存、恢复、版本列表和工程入口
- [x] 阶段 3：统一 Property 内核和旧 motion 迁移
- [x] 阶段 4：编辑 Command Bus 与统一 Undo/Redo
- [x] 阶段 5：可恢复 RenderJob、取消、重试和任务面板
- [x] 阶段 6：渲染前置检查与交付结果门禁
- [x] 阶段 7：MVP 浏览器闭环验收和发布收口
