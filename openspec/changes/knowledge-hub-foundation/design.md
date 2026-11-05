# Design

## Context

现有工作区包含两个独立插件包，均以 TypeScript ESM、Node 22、esbuild 和 Vitest 构建；直播插件已经使用 `node:sqlite`，因此无需新增数据库依赖。直播 preset 与游戏 preset 均不挂载 `memory-evolve`，且不应为了知识消费获得文件或 Shell 权限。

三个外部插件的公开能力并不对称：B 站和抖音插件主要提供采集或自身记忆工具，`memory-evolve` 的工具写入可返回文本，但缺少中枢所需的来源唯一约束、结构化状态查询和可靠幂等语义。本设计因此把“核心事实存储”和“可选外部镜像”分开。动机与范围见 [proposal.md](proposal.md)。

## Goals / Non-Goals

**Goals:**

- 冻结可独立测试的 schema v1、服务方法、查询语义、错误分类和适配器端口。
- 让核心库在没有三个外部插件、没有宿主工具运行时的情况下完成完整持久化流程。
- 用同步 SQLite 事务保证条目、证据和使用事件的一致性，用异步公共服务边界保留未来远程存储的可能。
- 以结构化假运行时验证工具不可见、失败、取消和异常结果，不让这些故障穿透核心服务。
- 保持新增包与直播、游戏现有代码完全解耦，后续变更再选择消费入口。

**Non-Goals:**

- 不实现语义搜索、向量数据库、LLM 自动提炼或自动审核。
- 不实现 B 站日报、抖音记录的文件导入器；具体来源适配属于后续多源变更。
- 不在真实 `memory-evolve` 中写入测试数据，不读取其真实数据库或私人记忆文件。
- 不提供审核 UI、直播素材卡、游戏参考资料或验证执行器。
- 不在本次引入运行时 npm 依赖，也不修改其他包依赖版本。

## Decisions

### 1. 包边界与模块分层

新增 `packages/dsh-knowledge-hub`，默认入口只负责 DSH 加载、服务发布和释放；纯核心不导入 Cordis 或直播、游戏代码。

建议结构：

```text
src/
  index.ts                 # DSH 插件入口，发布 knowledgeHub
  core/
    contracts.ts           # 对外类型与服务接口
    errors.ts              # 稳定错误码
    validation.ts          # 输入规范化、大小和枚举校验
    identity.ts            # 来源键、条目标识和规范内容哈希
    service.ts             # 核心用例与事务边界
    sqlite-store.ts        # 主存储和迁移
  adapters/
    tool-runtime.ts        # 最小结构化 ToolRuntime 端口
    memory-evolve.ts       # 可选镜像；默认不启用
  testing/
    fixtures.ts            # 仅合成数据，供测试和后续 smoke test 复用
test/
  service.test.ts
  sqlite-store.test.ts
  tool-runtime.test.ts
  host.test.ts
```

包导出根入口和 `./contracts`，构建目标为 Node 22 ESM。核心服务以构造注入接收 `KnowledgeStore`、可选镜像、时钟和 ID/哈希函数，避免测试依赖真实宿主或真实时间。

**备选方案：** 把逻辑直接加入直播插件或复制三个外部插件源码。两者都会形成平台/场景耦合和私有接口依赖，因此不采用。

### 2. schema v1 数据契约

核心条目采用以下逻辑形状；`purposes` 是通用用途集合，不是素材类型：

```ts
interface KnowledgeItem {
  schemaVersion: 1
  id: string
  source: {
    platform: string
    externalId?: string
    url?: string
    author?: string
    publishedAt?: number
    observedAt: number
  }
  content: {
    title: string
    summary: string
    detail?: string
    rawRef?: string
  }
  labels: string[]
  purposes: KnowledgePurpose[]
  governance: {
    status: 'inbox' | 'approved' | 'blocked' | 'archived'
    expiresAt?: number
    reviewedAt?: number
    reviewNote?: string
  }
  trust: {
    level: 'unknown' | 'source-claim' | 'corroborated' | 'tested'
    evidence: KnowledgeEvidence[]
  }
  extensions: Record<string, unknown>
  createdAt: number
  updatedAt: number
}
```

`KnowledgePurpose` 首版为规格列出的六种用途。`KnowledgeEvidence` 至少包含证据 ID、类型、结果（`supports`、`refutes`、`uncertain`）、摘要、来源说明和记录时间；只有 `type: 'verification'` 且 `outcome: 'supports'` 的证据可以支撑 `tested`。`KnowledgeUsageEvent` 单独保存，至少包含事件 ID、条目 ID、`presented | used`、消费者、用途、发生时间和可选展示关联 ID。

公共服务采用异步方法：

```ts
ingest(input): Promise<IngestResult>
get(id): Promise<KnowledgeItem | null>
query(input): Promise<KnowledgeItem[]>
review(id, input): Promise<KnowledgeItem>
listReview(input): Promise<KnowledgeItem[]>
addEvidence(id, input): Promise<KnowledgeItem>
recordUsage(input): Promise<KnowledgeUsageEvent>
close(): Promise<void>
```

`IngestResult` 包含 `item`、`created` 和可选适配警告，避免用布尔值或展示文本猜测是否新建。所有公开错误包含稳定代码：`invalid_input`、`not_found`、`conflict`、`closed`、`unavailable`、`timeout`、`cancelled`、`invalid_result`、`adapter_error` 和 `storage_error`。

输入校验包含字符串非空、有限时间戳、枚举、数组去重、扩展数据 JSON 可序列化及循环引用拒绝。首版限制标题 500 字、摘要 4000 字、详情 50000 字、单条扩展 JSON 100000 字节、标签最多 50 个；`rawRef` 只作为字符串保存，永不自动解引用。

**备选方案：** 使用 `kind: meme | minecraft-tip` 或把领域字段放进核心。该方案无法承载后续真实需求，因此不采用。

### 3. 来源身份、冲突与规范内容

适配器可以提供合法 ID；缺省时核心使用 SHA-256 从来源键生成确定性 ID。来源键优先级为：

1. `platform + externalId`；
2. `platform + 规范化 URL`；
3. `platform + author + publishedAt + 规范内容哈希`。

数据库对来源键设置唯一约束。相同 ID 或来源键且规范内容相同，返回既有记录和 `created: false`；核心内容不同则返回 `conflict`，不提供隐式 upsert。规范内容哈希覆盖来源身份、标题、摘要、详情、原始引用、排序后的标签和用途、过期时间及扩展数据，不覆盖审核时间、证据、使用事件和存储时间戳。

首版不提供内容更新方法，避免把“重试”与“修订”混为一谈。后续整理中心如需修订，必须以独立变更定义版本历史和冲突策略。

### 4. SQLite 是唯一核心事实来源

默认数据库位置为 `DSH_HOME/dsh-knowledge-hub/knowledge.db`；测试和嵌入方可显式传入文件或 `:memory:`。未设置 `DSH_HOME` 时使用操作系统临时目录下的插件专属子目录，并在日志中明确位置，绝不回退到直播或外部插件目录。

存储表分为 `items`、`evidence`、`usage_events`、`mirror_events` 和迁移元数据。`items` 保存完整 JSON 以及来源键、状态、用途、平台、可信等级、过期和排序所需索引列；证据与使用事件使用独立表，避免重写条目时丢失历史。多表写入使用事务，查询仅使用参数化 SQL。

普通查询默认固定 `status = approved` 且 `(expiresAt IS NULL OR expiresAt > now)`，按 `observedAt DESC, id ASC` 排序，默认 `limit = 10`、最大 50，`offset` 必须为非负安全整数。标签过滤采用全部包含语义，平台与可信等级采用集合内任一语义；首版不做文本排名。审核列表是独立方法，必须显式传入治理状态，避免普通查询通过一个布尔参数绕过安全默认值。

**备选方案：** 以 `memory-evolve` 作为主存储。它目前无法可靠承担结构化查询、来源唯一约束和状态机，因此只保留镜像可能；不直接 import 其内部 `store.js`。

### 5. 状态机与证据操作

缺省治理状态为 `inbox`，缺省可信等级为 `unknown`。`review` 只修改治理字段和审核元数据；`addEvidence` 只追加证据并按显式参数修改可信等级。每次操作重新读取完整记录，审核笔记与证据摘要均按不可信文本处理。

`addEvidence` 在同次事务中校验目标存在、追加证据并检查升级条件；请求 `tested` 时，本次或历史证据中必须存在支持型验证证据。`recordUsage` 只追加事件；若提供 `presentedEventId`，该事件必须属于同一条目且类型为 `presented`。任何使用事件均不触发审核或可信状态变化。

过期仅在查询时计算，不做后台批量状态改写。这样重启、时钟调整和历史审计不会隐藏原始批准结论。

### 6. ToolRuntime 薄适配与可选镜像

适配层声明最小结构端口，而不是依赖外部插件内部类型：

```ts
interface ToolRuntimePort {
  get(name: string, scope?: unknown): unknown
  execute(input: {
    callId: string
    name: string
    arguments: unknown
    signal?: AbortSignal
  }): Promise<unknown>
}
```

`ToolRuntimeAdapter` 统一处理不存在、拒绝、超时、取消、异常和不可解析结果，返回判别联合，不把文本“成功”当作结构化确认。每次调用使用新的调用 ID，可选取消信号与超时共同生效，并限制返回文本和错误日志长度。

`MemoryEvolveMirror` 仅在该公开工具被显式配置且探测通过时启用。镜像只接收已批准条目的摘要、来源和时效，不接收待审核条目，不授予文件或 Shell 能力。镜像失败写入 `mirror_events` 并体现在 `IngestResult` 或诊断日志中；核心提交不回滚、不伪报镜像成功。M1 默认配置不启用真实镜像，真实写入探测和自动同步留给后续集成变更。

**备选方案：** 每次核心操作都直接调用 `memory` 工具并以其文本作为提交结果。该方案会混淆两个存储的事务边界，且无法确认幂等，因此不采用。

### 7. DSH 生命周期和验证策略

入口创建服务后调用 `ctx.provide('knowledgeHub', service)`；可选工具运行时通过 `ctx.get?.()` 或宿主公开注入点弱获取，缺失时仅禁用对应适配器。释放入口先取消适配任务，再关闭数据库；`close` 幂等，关闭后的公开操作返回 `closed`。

测试分四层：

1. 契约与校验：所有枚举、边界、不可信文本和扩展 JSON。
2. 核心与 SQLite：幂等、冲突、状态机、证据、过期、查询、使用事件、重启恢复和事务回滚。
3. 适配器假运行时：工具作用域、异常、超时、取消、异常返回值和镜像失败隔离。
4. 宿主假上下文：服务发布、弱依赖缺失、独立数据目录和重复释放。

构建后运行新包的 `check`、`test`、`build`，再运行现有两个包的测试和类型检查，确认没有跨包副作用。真实 DSH 中的手动加载只使用合成条目和临时数据目录；若当前环境不能安全执行，则明确标记未实测，不以单元测试冒充真实宿主验证。

## Risks / Trade-offs

- [外部文本包含提示词注入] → 核心不解释内容、不解引用 `rawRef`，后续消费者仍必须在展示层进行结构隔离和审核。
- [`node:sqlite` 在不同 Node 22 小版本行为不同] → 构建与测试固定验证当前 Node 22 环境，数据库打开失败时给出明确 `storage_error`，不增加原生依赖。
- [同步 SQLite 在大详情或高并发下阻塞事件循环] → 限制输入和查询大小，首版只服务低频整理；出现真实负载后再通过独立变更评估 Worker 或异步存储。
- [同一 URL 的内容发生合法修订会被判为冲突] → 首版明确拒绝隐式覆盖，后续整理中心通过有版本的修订操作解决。
- [镜像成功与核心提交无法形成分布式事务] → 核心库是唯一事实来源，镜像结果单独记录，绝不在核心记录上伪造外部成功。
- [简单过滤不能满足后续“找相似素材”] → 首版只承诺确定性过滤；语义检索和排序由检索进化变更扩展，不提前引入向量依赖。
- [假宿主测试不等于真实 DSH 工具可见性] → 默认关闭真实镜像，验证报告分别列出自动测试证据与真实宿主未覆盖项。

## Migration Plan

1. 以新包和全新数据库发布，不迁移或修改现有直播、游戏及外部插件数据。
2. 数据库使用 `PRAGMA user_version = 1`；后续迁移必须顺序执行并在备份后升级。
3. 首版只在临时目录验证。真实启用前由用户明确选择数据目录和是否安装 preset，不在本变更自动挂载直播或游戏 preset。
4. 回滚时卸载新插件并移除工作区包引用；默认保留独立知识数据库供审计或恢复，不触碰任何既有数据库。删除知识数据必须由用户另行明确授权。
