# Proposal

## Why

B 站、抖音等外部插件已经能够采集信息，`dsh-memory-evolve` 能够保存长期记忆，但采集结果目前缺少统一的来源、审核、可信状态、时效和使用记录，直播与游戏插件也没有安全、稳定的消费入口。现在先建立通用知识中枢的基础契约与持久化能力，避免把临时的“热梗”或“MC 技巧”示例固化为专用系统，也为后续素材整理、直播消费、游戏参考和复盘提供同一事实来源。

## What Changes

- 新增独立的 `packages/dsh-knowledge-hub` 插件，提供 `knowledgeHub` 服务和版本化通用知识条目契约，不复制三个外部插件源码。
- 建立带来源追踪、确定性去重、扩展字段和持久化恢复的入库与读取能力；外部内容一律作为不可信数据处理。
- 建立彼此独立的治理状态与可信状态，支持审核、归档、过期、证据和基础使用记录；入库不隐含着可用于直播。
- 提供按用途、标签、来源和治理条件查询的程序化接口，消费者查询默认只返回已批准且未过期的条目。
- 定义存储、来源适配器和宿主工具调用的薄边界，通过公开服务或公开工具连接外部插件；私有数据库、私有记忆文件和内部模块不属于合法接口。
- 用隔离的模拟数据验证 DSH 服务发现、跨插件工具可见性及存储适配行为，并据此冻结首版契约；不迁移现有直播观众记忆，不接入真实直播或游戏执行链。
- 本变更只覆盖 M0～M1。审核界面、直播素材包、自动多源整理、观众反馈复盘、游戏参考注入、实测门禁和检索进化分别留给后续独立变更。

## Capabilities

### New Capabilities

- `knowledge-ingestion`: 通用知识条目的校验、来源身份、幂等入库、持久化与按标识读取。
- `knowledge-governance`: 审核状态、可信状态、证据、时效与使用记录的独立管理和安全状态迁移。
- `knowledge-retrieval`: 面向程序消费者的条件查询、用途筛选、默认安全可见性与稳定结果结构。
- `knowledge-host-integration`: `knowledgeHub` 服务发布、弱依赖、公开工具适配、外部故障隔离及插件资源生命周期。

### Modified Capabilities

无。

## Impact

- 新增 `packages/dsh-knowledge-hub` 的 TypeScript 源码、测试、构建配置和包清单，并纳入现有 pnpm workspace。
- 新增独立于直播观众记忆和 `dsh-memory-evolve` 私有文件的知识存储；优先复用 Node 22 自带的 `node:sqlite`，不引入 Minecraft 或直播平台专用核心字段。
- 定义 `KnowledgeItem`、`KnowledgeStore`、`SourceAdapter`、`KnowledgeHub` 等公共契约及核心服务方法；后续消费者只依赖公开契约。
- 对 `dsh-bili-scroll`、`dsh-douyin-browser-local`、`dsh-memory-evolve` 仅做公开能力探测和薄适配，不修改其安装目录，不直接读取其私人数据。
- 本变更不修改 `dsh-livestreamingcompanion`、`dsh-game` 的 preset、提示词、话题生成、游戏动作或现有记忆库，也不启用自动发布、Shell、文件系统或游戏动作权限。
