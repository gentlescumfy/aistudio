# ADR-003: 异步编排取消协同与结构化 Handoff 协作契约 (Async Orchestration & Structured Handoff)

## 状态 (Status)
**已接受 (Accepted)** - 2026-10-10

## 背景与上下文 (Context)
在深入对标 AgentsRoom 架构逆向成果后，我们发现 AI Studio 在长任务生命周期与多智能体协作流转上存在两处关键短板：
1. **外部引擎空转浪费算力**：原系统在取消任务时仅支持本地 Run 的内部标记，当调度外部编排系统（如 Langflow）时，前端断开并不会中止外部计算集群，导致长任务继续在后端空跑。
2. **多智能体上下文发散与缺乏明确目标**：上游智能体完成任务向下游传递时，原实现仅作简单的纯文本替换（`{{ prompt }}`）。下游智能体缺乏对上游角色的身份认知、成果总结以及具体的行动指引（Actionable Directive），极易在长链路中出现指令漂移。

## 架构决策 (Decisions)

### 1. 长任务双向取消协同机制 (Cancellation Propagation)
- **取消端点扩展**：在 `apps/api` 引入 `POST /api/langflow/runs/:id/cancel`，并在 OpenAPI 与前端 API 统一补全契约。
- **双向协同中止**：
  - 当 Run 处于 `queued` 状态时，直接在本地 Ledger 原子化更新为 `cancelled`；
  - 当 Run 处于 `running` 状态时，立刻中止本地活动中监听的 SSE 连接控制器（`active.abort()`），并向 Langflow 上游派发 `POST /api/v1/build/{jobId}/cancel`，停止远程计算；
  - 终态保护：对于已处于 `succeeded`、`failed`、`cancelled`、`outcome_unknown` 的 Run，拒绝取消请求并返回稳定的 `409 CANNOT_CANCEL`。

### 2. 结构化 Handoff 协作契约与模板渲染
在 `apps/api/src/handoff.ts` 抽象跨智能体标准交接报文 `HandoffPackage`：
- **核心契约结构**：
  - `sourceNodeId`: 上游节点唯一标识；
  - `roleName`: 上游智能体角色名称；
  - `summary`: 阶段性成果概括；
  - `directive`: 行动指引（Actionable Directive）——优先提取以“行动指令 / Directive / 建议下一步”开头的关键句子；
  - `artifacts`: 关联产出的工件与素材清单；
  - `metrics`: 步骤数与费用累积度量。
- **模板增强与向后兼容**：
  下游节点配置的 Prompt 模板除继续支持 `{{ prompt }}` 与 `{{ count }}` 保持 100% 向后兼容外，无缝支持 `{{ directive }}`、`{{ handoff.directive }}`、`{{ handoff.summary }}`、`{{ handoff.roleName }}` 等精确插值，确保下游智能体能直接遵从上游交付指令。
- **持久化审计追踪**：
  在 `RunNode` 契约中持久化记录 `handoffPackage`，为前端工作流可视化与全链路调用回溯提供结构化数据支持。

## 影响与后果 (Consequences)

### 正面效益 (Positive)
- **保护云端与本地算力**：任务被取消后立即掐断外部引擎计算，杜绝长任务后台空耗。
- **协作行为高度收敛**：通过结构化 Handoff 与行动指令约束，多 Agent 串联执行具备明确的目标推进路径。
- **完整契约闭环**：全流程均受 Zod Schema 校验与 OpenAPI 文档保护，前后端类型严格对齐。

### 兼容性考量 (Compatibility)
- 所有老旧模板（仅使用 `{{ prompt }}`）的行为与输出完全不变，仅在下游显式使用结构化占位符时才启用增强指令注入。
