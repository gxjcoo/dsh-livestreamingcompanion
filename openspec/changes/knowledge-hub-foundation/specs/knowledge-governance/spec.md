# Spec Delta

## Purpose

为外部知识建立显式、可审计的治理过程，使素材进入收件箱、获得使用批准、具备事实依据以及真正被消费成为互不混淆的状态和事件。

## ADDED Requirements

### Requirement: 默认收件箱与显式审核

系统 SHALL 将未明确指定治理状态的新条目置为 `inbox`，并 SHALL 提供按标识将条目审核为 `approved`、`blocked` 或 `archived` 的操作；入库本身 MUST NOT 隐含着批准使用。

#### Scenario: 新素材等待审核

- **WHEN** 外部适配器提交一个未指定治理状态的新条目
- **THEN** 条目以 `inbox` 状态保存，并可出现在待审核列表中

#### Scenario: 明确批准素材

- **WHEN** 审核方将一个存在的收件箱条目标记为 `approved`
- **THEN** 系统保存批准状态及审核时间，不因此改变其可信等级

#### Scenario: 阻止不适用素材

- **WHEN** 审核方将条目设置为 `blocked` 或 `archived`
- **THEN** 系统保留条目及历史证据供审计，但消费者默认查询不再返回该条目

### Requirement: 治理状态与可信状态分离

系统 SHALL 独立保存治理状态与 `unknown`、`source-claim`、`corroborated`、`tested` 可信等级，任何单一审核或验证操作 MUST NOT 同时隐式修改另一维度。

#### Scenario: 未核实内容获得使用批准

- **WHEN** 一个可信等级为 `source-claim` 的条目被批准
- **THEN** 条目可以保持 `approved` 与 `source-claim`，系统不得宣称其已被实测或交叉印证

#### Scenario: 实测内容仍未批准

- **WHEN** 一个 `inbox` 条目获得足以标记为 `tested` 的证据
- **THEN** 系统可以更新可信等级，但条目仍保持 `inbox`，不能因此被消费者默认查询命中

### Requirement: 证据追加与可信升级约束

系统 SHALL 支持追加带来源、观察结果和记录时间的证据，并 SHALL 持久保存证据历史；可信升级 SHALL 是显式操作，标记为 `tested` 时 MUST 存在支持该结论的通过型验证证据。

#### Scenario: 追加交叉印证证据

- **WHEN** 调用方为条目附加独立来源的印证证据并显式请求 `corroborated`
- **THEN** 系统保存证据和新的可信等级，且既有证据仍可读

#### Scenario: 无通过证据却请求实测等级

- **WHEN** 调用方在没有通过型验证证据的情况下请求将条目标记为 `tested`
- **THEN** 系统拒绝该升级并保留原有可信状态

#### Scenario: 失败证据不伪造成功

- **WHEN** 调用方追加失败或无法确定的验证证据
- **THEN** 系统保存该证据，但不据此把条目升级为 `tested`

### Requirement: 时效独立于审核状态

系统 SHALL 支持可选过期时间，并 SHALL 在查询时排除已过期的条目；过期 MUST NOT 被自动改写为已验证、已阻止或已归档。

#### Scenario: 批准素材到期

- **WHEN** 一个 `approved` 条目的过期时间早于或等于当前查询时间
- **THEN** 默认消费者查询不返回该条目，同时其原始治理和可信记录仍可审计

#### Scenario: 无过期时间的长期资料

- **WHEN** 一个已批准条目没有过期时间
- **THEN** 系统仅依据其他查询条件判断其可见性，不自行添加默认有效期

### Requirement: 使用事件区分展示与实际采用

系统 SHALL 分别记录条目被提供给消费者的 `presented` 事件和消费者确认实际采用的 `used` 事件，并 SHALL 保存消费者、用途、场景和时间等可用上下文。

#### Scenario: 仅展示但未采用

- **WHEN** 系统把条目提供给消费者后仅记录 `presented`
- **THEN** 该事件不得被统计为实际采用，也不得自动产生另一条 `used` 事件

#### Scenario: 明确确认采用

- **WHEN** 消费者报告某个已展示条目被实际采用
- **THEN** 系统追加独立的 `used` 事件，并保留对应展示事件的关联信息（调用方已提供时）

### Requirement: 使用记录不自动改写治理结论

系统 MUST 将使用次数、消费者反馈和采用结果保存为审计数据，且 MUST NOT 仅凭这些数据自动批准、阻止、归档或升级条目可信等级。

#### Scenario: 条目获得多次采用

- **WHEN** 一个条目积累多次 `used` 事件或正面结果
- **THEN** 系统保留这些事件，但其治理状态与可信等级保持原值，直至收到独立显式操作
