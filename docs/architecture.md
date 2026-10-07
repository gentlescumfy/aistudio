# AI Studio 架构设计

> 文档版本：0.1.0  
> 状态：首版设计基线（尚不代表生产能力已实现）  
> 契约基线：`docs/implementation-brief.md` 的 Initial API contract

## 1. 决策摘要

首版采用“Web SPA + 模块化 API + 持久化任务编排器 + mock 模型适配器”的垂直切片。API、任务调度和 mock worker 可部署在同一 Node.js 进程中，但代码边界必须允许以后把 worker 独立扩容。首版不引入微服务、消息队列或真实模型供应商；这些复杂度只有在可靠性、吞吐量或隔离需求出现后再引入。

关键约束如下：

- 当前共享契约只来自实施简报，本文不自行扩展或替换它。
- 只有品牌图片模板可执行；视频和 coding 模板只展示为 coming soon。
- 所有生成结果必须持续标记 `mode: "mock"`，成本为零，不暗示真实 AI 已调用。
- 先持久化 run，再执行工作；每次状态变化都持久化。
- 内部只承诺“至少一次调度 + 幂等收敛”，不宣称外部副作用 exactly-once。
- 已发布模板不可原地修改；run 固定引用创建时的模板版本和输入快照。

## 2. 范围与质量属性

### 2.1 首版范围

```text
Browser
  -> Web SPA (template picker / run form / node graph / history / gallery)
  -> JSON API
       -> Template catalog
       -> Run service
       -> Durable run repository
       -> Orchestrator
            -> MockModelAdapter
       -> Protected asset delivery
```

首版优化顺序：正确性与诚实标注 > 可恢复性 > 可维护性 > 性能。单机开发环境无需追求分布式吞吐量，但数据模型和适配器不能把单进程假设泄漏到领域契约中。

### 2.2 明确不在首版内

真实媒体供应商、生产身份认证与租户隔离、付费计量、GPU 调度、生产队列、视频编辑、任意代码执行沙箱、内容审核以及多区域容灾均不在首版内。路线图中的这些条目是缺口或计划，不是已实现能力。

## 3. 模块边界

建议后端保持一个模块化单体，边界如下：

| 模块 | 职责 | 不应承担 |
| --- | --- | --- |
| HTTP/API | 参数解析、状态码、错误信封、响应投影 | 工作流执行、供应商细节 |
| Template Catalog | 模板版本、启用状态、节点定义 | run 状态 |
| Run Service | 创建、查询、幂等键、重试、取消命令 | 直接调用 SDK |
| Orchestrator | 节点依赖、租约、状态归并、恢复 | HTTP 响应、供应商特有 DTO |
| Adapter Registry | 按模型/能力选择适配器 | 持久化领域状态 |
| Model Adapter | mock 或供应商协议翻译、提交/查询/取消 | 修改 run、计算业务状态 |
| Asset Store | blob 与元数据、受控下载、完整性校验 | 推断工作流状态 |
| Repository | 原子事务、并发控制、状态持久化 | 编排策略 |

首版可以让 API 进程同时驱动本地 worker；对外仍只暴露实施简报中的 API。worker 独立部署时，领域状态机和 adapter 接口不变。

## 4. 版本化工作流设计

### 4.1 核心规则

模板采用不可变发布版本：

1. `templateId` 是稳定业务标识；`revision` 是单调递增的不可变版本。
2. 草稿校验通过后发布；修改已发布模板必须创建新 revision。
3. `POST /api/runs` 在事务内解析当时启用的 revision，并把完整模板、节点顺序和输入规范化结果保存为 run snapshot。
4. 已创建 run 永远使用自己的 snapshot；后续模板发布、禁用或删除不改变历史 run 和 retry。
5. 模板禁用只阻止新 run，历史 run 仍可查看；是否允许 retry 由被快照版本的可执行性决定。
6. 只有向后兼容的数据读取迁移可以原地进行；状态语义或节点图变化必须通过模板 revision 表达。

建议模板内部模型：

```text
TemplateDefinition
- template_id
- revision
- schema_version
- name / description / category
- lifecycle: draft | published | retired
- enabled
- nodes[]: node_id, name, kind, dependencies[], adapter_key, config
- created_at / published_at
UNIQUE(template_id, revision)
```

当前公共 `Template` 没有 `revision`，因此首版响应仍严格按简报返回；revision 和 snapshot 先作为内部持久化字段。是否把版本暴露给客户端属于契约修改建议，见第 11 节。

### 4.2 发布流程

```text
编辑草稿 -> schema 校验 -> 节点 ID/依赖校验 -> mock 预演
         -> 发布不可变 revision -> 标记为当前启用版本
         -> 新 run 固定快照；历史 run 不迁移
```

最低发布校验：节点 ID 在该 revision 内唯一、依赖存在且无环、kind 可由已注册适配器处理、输入 schema 可解析、输出资产声明明确、非首版模板不得误标 `enabled: true`。

## 5. Run、节点尝试和资产数据设计

以下是逻辑模型，不强制具体数据库。首版可用事务型本地存储；生产建议 PostgreSQL + 对象存储。

```text
Run
- id
- template_id / template_revision
- template_snapshot
- normalized_inputs
- input_fingerprint
- idempotency_key
- status
- mode
- estimated_cost / actual_cost
- cancellation_requested_at
- created_at / updated_at
- row_version

RunNode
- run_id / node_id
- name / kind
- status
- attempts
- dependency_snapshot
- latest_error
- started_at / finished_at
- lease_owner / lease_expires_at / heartbeat_at
PRIMARY KEY(run_id, node_id)

NodeAttempt
- id / run_id / node_id / attempt_number
- adapter_key / adapter_version
- request_fingerprint
- external_operation_id
- status: prepared | submitted | running | succeeded | failed |
          cancelled | outcome_unknown
- error_code / safe_error_message
- started_at / finished_at
UNIQUE(run_id, node_id, attempt_number)

Asset
- id / run_id / node_id / attempt_id
- schema_version
- name / mime_type
- storage_key
- byte_size / sha256
- width / height
- mode
- lifecycle: staged | available | quarantined | deleted
- created_at
```

公共 API 继续只投影简报规定的 `Run`、`Run node` 和 `Asset` 字段。内部字段用于恢复、审计和生产演进，不应被偶然序列化。

### 5.1 资产原则

- blob 与元数据分离；数据库保存不可猜测的 `storage_key`，不保存用户提供的文件路径。
- 先写临时对象并计算 `sha256`，再在同一业务提交点把资产标记为 `available`；未提交的临时对象可由回收任务清理。
- `url` 是下载入口的投影，不是持久化主键。开发期可以是受保护的本地 URL；生产期应为短时签名 URL 或授权下载路由。
- 下载路由只通过 asset ID 查找 storage key，规范化路径并验证根目录，禁止拼接任意路径。
- mock 资产由稳定 seed 生成，seed 至少包含 run/node/输出序号；同一成功 attempt 的重放不得制造重复资产。
- retry 成功后保留旧 attempt 的审计记录；默认 gallery 只展示每个节点最新成功 attempt 的可用资产。删除和保留策略属于生产能力。

## 6. 长任务状态语义

### 6.1 Run 状态

| 当前状态 | 允许进入 | 触发条件 |
| --- | --- | --- |
| `queued` | `running`, `cancelled` | 已持久化等待调度；或取消尚未开始的 run |
| `running` | `succeeded`, `failed`, `cancelled` | 至少有一个节点运行或等待其依赖，最终由节点状态归并 |
| `failed` | `queued` | retry 重新排队失败节点；调度开始后创建新 attempt |
| `succeeded` | 无 | 终态；所有必需节点成功 |
| `cancelled` | 无 | 终态；取消请求已阻止后续工作且没有必须等待的本地操作 |

禁止状态倒退，例如 `succeeded -> running`。retry 只作用于 `failed` run 的失败节点；成功节点和资产不重跑。若依赖失败导致后继节点未执行，后继节点在 retry 时随依赖恢复重新变为可调度。

### 6.2 节点状态

节点遵循 `pending -> running -> succeeded|failed|cancelled`。每次真正执行前原子增加 `attempts` 并创建 `NodeAttempt`。任何状态转换都必须：

1. 校验允许的前置状态和 `row_version`；
2. 在同一事务写入状态、时间、attempt/error；
3. 提交后才发布进程内事件或开始下一节点；
4. 重新计算并持久化 run 聚合状态。

## 7. 恢复与租约

首版启动恢复流程：

1. 扫描 `queued`、`running` run。
2. 回收没有有效 lease 的节点；有效 lease 不被第二个 worker 抢占。
3. mock attempt 可从稳定输入重新计算并按 asset 唯一约束收敛：没有提交成功标记的 attempt 回到可运行状态。
4. 对已持久化为 `succeeded` 的节点只校验资产存在，不重新执行；资产缺失是数据完整性错误，应把 run 暴露为失败并记录明确错误。
5. 恢复完成后重新归并 run 状态并继续调度依赖已满足的节点。

生产 worker 使用短租约和心跳，领取条件是 `pending` 或 lease 已过期，并通过 compare-and-set 更新。进程崩溃最多导致重复调度，不得导致两个 worker 同时提交同一个受控 attempt。

真实付费调用必须区别以下情况：

- 尚未向供应商提交：可安全重试。
- 已获得 `external_operation_id`：只查询或 reconcile，不重新提交。
- 请求超时且不知道供应商是否接收：标记 `outcome_unknown`，暂停自动重试，等待供应商幂等查询或人工处理。

因此系统不承诺真实外部调用 exactly-once；承诺的是持久记录、可观察的不确定状态，以及在有供应商幂等能力时的安全收敛。

## 8. 幂等语义

`POST /api/runs` 的幂等性按以下步骤实现：

1. 校验并规范化输入：prompt 去首尾空白，count 转为已验证整数。
2. 对 `{templateId, inputs:{prompt,count}}` 做稳定键序列化并计算 fingerprint。
3. 在同一事务以 `idempotencyKey` 建唯一约束并创建 run。
4. 首次创建返回 201；同 key、同 fingerprint 返回原 run 和 200；同 key、不同 fingerprint 返回 409。
5. 并发重复请求依赖数据库唯一约束裁决，不使用“先查后写”作为正确性保证。

首版没有用户身份，key 的作用域只能是当前服务实例的数据域；这不是生产租户隔离。生产应改为 `(tenant_id, idempotency_key)` 唯一。幂等记录至少保留到对应 run 和其可下载资产的保留期结束。

`POST /retry` 当前契约没有命令幂等键。首版通过原子状态检查保证同一时刻最多创建一次 retry：仅 `failed` 可转为 `queued` 并返回 HTTP 200；其他状态均返回 HTTP 409，因此并发请求不能重复排队或创建 attempt。客户端收到冲突后刷新 run。如果这次重试再次失败，后续显式 retry 才代表新的重试意图。生产建议为 retry/cancel 增加命令级幂等键。

## 9. 取消语义

取消是“停止继续推进”，不是“保证撤销已发生的外部副作用”：

- 对 `queued` run：在事务内将 pending 节点和 run 标记 `cancelled`。
- 对 `running` run：记录内部 `cancellation_requested_at`，不再领取新节点；pending 节点转 `cancelled`；向当前 adapter 发送 best-effort abort/cancel。
- 本地 mock 节点应在可中断点检查取消信号并尽快转 `cancelled`。
- 若真实供应商不支持取消，继续 reconcile 已提交操作，但不得调度后继节点；返回的结果应隔离，不自动当作可发布资产。
- 对 `cancelled` run 再次取消返回当前 run 和 HTTP 200；对 `succeeded` 或 `failed` 返回 HTTP 409，不改变历史。

首版本地 mock 的取消在原子提交 `cancelled` 状态并禁止后续推进后返回 HTTP 200，同时中断当前本地操作；迟到结果不得覆盖取消状态或发布新资产。前端以返回的 run 状态更新界面。真实供应商的取消中状态、请求记录与对账属于后续契约，不能把本地取消响应理解为供应商已经撤销。

## 10. 模型适配器边界

建议接口表达能力和异步生命周期，而不是把某家 SDK 类型暴露给编排器：

```ts
type AdapterRequest = {
  operationKey: string;
  model: string;
  prompt: string;
  outputCount: number;
  outputSpec: { mimeTypes: string[]; width?: number; height?: number };
};

type SubmitResult =
  | { kind: "completed"; outputs: AdapterOutput[]; usage?: AdapterUsage }
  | { kind: "accepted"; externalOperationId: string }
  | { kind: "outcome_unknown"; safeMessage: string };

interface ModelAdapter {
  readonly key: string;
  readonly capabilities: AdapterCapabilities;
  submit(request: AdapterRequest, signal: AbortSignal): Promise<SubmitResult>;
  poll?(externalOperationId: string, signal: AbortSignal): Promise<PollResult>;
  cancel?(externalOperationId: string): Promise<CancelResult>;
}
```

边界规则：

- Orchestrator 负责事务、attempt、重试策略、取消和状态归并；adapter 不直接写数据库。
- adapter 负责鉴权注入、超时、协议翻译、供应商错误分类和响应校验；不得接收任意 URL、shell 命令或未声明参数。
- `operationKey` 在 retry 中稳定，可映射到支持幂等键的供应商；不支持时必须使用 `externalOperationId` reconcile。
- adapter 返回规范化错误类别：`invalid_request`、`rate_limited`、`provider_unavailable`、`content_rejected`、`timeout`、`outcome_unknown`。公共 `error.message` 必须安全，不包含凭据或原始响应中的敏感内容。
- mock adapter 必须与真实 adapter 走相同边界，但输出 `mode: "mock"`、零成本、确定性本地资产；不能用不同的旁路直接改 run。
- 能力不匹配（例如模板请求视频而 adapter 只支持图片）在发布校验或创建 run 时失败，不在执行到一半后静默降级。

## 11. 对共享 API 契约的建议（尚未生效）

下列项目只记录建议，实施前需由协调者统一修改契约和两端实现：

1. 在 `Template` 和 `Run` 中公开 `templateRevision`，便于 UI、支持人员和审计确认实际执行版本。
2. 给 retry/cancel 接受命令级 `idempotencyKey`，避免网络重放产生多次 retry 意图。
3. 首版 retry/cancel 的状态码已由 `docs/integration-decisions.md` 明确；真实供应商模式的取消受理与完成语义仍需独立定义。
4. 为取消中的 run 增加 `cancelling` 状态或 `cancellationRequestedAt`，避免 UI 把 `running` 误解为未受理取消。
5. 生产资产 URL 建议改为授权下载端点或短时签名 URL，并定义过期语义。
6. 列表接口在进入生产数据量前增加游标分页、稳定排序和过滤条件。
7. 错误信封增加可选 `details`/`retryable`/`requestId`，同时保持现有 `code`、`message` 向后兼容。

在协调者采纳前，开发和验收均以实施简报现有字段与状态集合为准。

## 12. 安全、可运维性与扩展路径

首版最低防线：仅绑定本机开发地址；CORS 使用配置的精确 origin；限制 JSON body 和 prompt 大小；所有输入做 allowlist 校验；资产路径不可由请求直接映射；日志清除 prompt/凭据；无 shell、动态代码或任意 API 执行。

进入生产前至少补齐：身份认证、租户授权、速率与配额限制、密钥托管、审计日志、内容安全、供应链扫描、数据库备份恢复、对象生命周期、可观测性、SLO/告警、供应商熔断与退避。生产缺口与门禁详见 `docs/roadmap.md`。
