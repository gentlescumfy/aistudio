# 项目化改造方案（方案 A）

> 背景：业务以「项目」具象化，不引入赛道（Track）抽象。
> 生图/视频/小说/游戏/软件开发只是**用法差异**，不是结构差异。
> 基准：`main @ 608f794`

> **执行状态（2026-10-09）：1–3 已实现，细节见 `docs/implementation-notes.md`；4–5 未开始。所有改动均在工作区未提交。**

## 核心决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 隔离单元 | **Project** | 业务具象，非虚拟赛道 |
| 赛道抽象 | **不引入** | 各赛道结构相同，只是挂载的 MCP 与 SOP 内容不同 |
| Langflow 映射 | **单 user + 多 project** | 单租户下无需多 user 层；`project_id` 已在 URL 隔离 |
| 数据隔离 | **按项目分目录** | 复用现有 `writer.lock` per-directory 机制 |

## 一、Langflow 侧已具备（无需开发）

实证来源见 `docs/langflow-capability-research.md`。

```
POST   /api/v1/projects                     建项目
GET    /api/v1/projects
GET    /api/v1/projects/{project_id}
PATCH  /api/v1/projects/{project_id}
DELETE /api/v1/projects/{project_id}
GET    /api/v1/projects/download/{project_id}     项目导出
POST   /api/v1/projects/upload/

GET    /api/v1/mcp/{project_id}              项目 MCP 设置
PATCH  /api/v1/mcp/{project_id}              更新（含项目级 auth）
POST   /api/v1/mcp/{project_id}/install      安装 MCP server
GET    /api/v1/mcp/{project_id}/installed
GET    /api/v1/mcp/{project_id}/sse          项目级 MCP 端点

POST   /api/v1/build/{flow_id}/flow         异步执行（长任务）
GET    /api/v1/build/{job_id}/events
POST   /api/v1/build/{job_id}/cancel
```

**关键**：`update_project_mcp_settings` 的语义是
*"Update the MCP settings of **all flows in a project** and **project-level auth settings**"*
→ 中间件在项目级配置，该项目下所有 SOP 可用。这正是需求中「定义项目时指定中间件」。

`FolderCreate` 字段：`name`、`description`、`parent_id`、`components_list`、`flows_list`

## 二、需要改造的部分（自研层）

### 2.1 移除媒体赛道硬编码 ✅ 已实现

`apps/api/src/workflows.ts` 的 `validateWorkflow`：

| 约束 | 处理 | 理由 |
|---|---|---|
| `IMAGE_REQUIRED`（至少一个 image 节点） | **删除** | 纯软件开发 SOP 无图片，会被误拒 |
| `EXPORT_COUNT`（恰好一个 export） | **删除/放宽** | 非通用约束 |
| `ROOT_COUNT`（恰好一个根 prompt） | **放宽** | 允许多入口 |
| `IMAGE_PROMPT_PARENT` | **保留** | 媒体专属 (注: 实施中发现其包含 image 节点前置约束，暂作保留，见 implementation-notes.md) |
| `CYCLE`（无环） | **保留** | 通用安全约束 |
| ID 唯一、节点连通 | **保留** | 通用 |

保留的通用校验即可，赛道专属规则一律不下沉为策略——**直接移除**。

### 2.2 引入 projectId（四大 store → 六 store + pool）✅ 已实现

现状（全部全局单例，直挂 `dataDir`）：

```
apps/api/src/store.ts:22      runs.json
apps/api/src/settings.ts:213  settings.json
apps/api/src/roles.ts:177     roles.json
apps/api/src/workflows.ts:54  workflows.json
```

改造为按项目分目录：

```
dataDir/
  projects/
    {projectId}/
      runs.json
      settings.json
      roles.json
      workflows.json
      assets/
      writer.lock      ← 复用现有单写者锁
```

**为什么选分目录而非单文件加 key**：

- `FileStore` 的 `writer.lock` 是 `join(this.directory, 'writer.lock')`（`store.ts:38`）
  → 分目录天然获得**每项目独立锁**，无需改造锁逻辑
- 迁移成本低：现有 `open(directory)` 签名只需传入项目目录
- 备份/删除/导出项目即拷目录

需改动：

1. `AppOptions` 增加项目解析（路径参数或 header）
2. `createApp` 中四个 `Store.open()` 传入项目目录
3. `domain.ts` 各记录增加 `projectId` 字段（可选，用于交叉校验）

### 2.3 项目生命周期与 Langflow 同步 ✅ 已实现（「画布节点 → 编译」未做）

```
创建项目
  ├─ 自研层：mkdir dataDir/projects/{id}
  └─ Langflow：POST /api/v1/projects  → 保存返回的 project_id

配置中间件（项目级）
  └─ POST /api/v1/mcp/{project_id}/install

发布 SOP
  └─ 画布节点 → 编译 → POST flow 到该项目

执行
  └─ POST /api/v1/build/{flow_id}/flow → job_id → 轮询 events
```

新增自研表：`projects.json`（`{ id, name, langflowProjectId, createdAt }`）

### 2.4 langflow.ts 改用异步接口 ⏳ 未实现

| | 现在 | 改为 |
|---|---|---|
| 端点 | `POST /api/v1/run/{flowId}?stream=false` | `POST /api/v1/build/{flow_id}/flow` |
| 形态 | 同步阻塞 | job_id + 轮询 `/events` |
| 超时 | 30s | 不受单次 HTTP 限制 |
| 取消 | abort 本地请求 | `POST /build/{job_id}/cancel` |
| 状态 | succeeded/failed | 映射 Langflow 7 态 |

Langflow `JobStatus`：`queued · in_progress · completed · failed · cancelled · timed_out · suspended`

映射建议（复用现有 `outcome_unknown` 语义）：

```
timed_out / cancelled(进行中) / 进程重启后 in_progress
    → unknownOutcome（禁止自动重投）
```

### 2.5 前置准备（软件开发赛道需要）⏳ 未实现

`services/langflow/pyproject.toml` 当前只有 `langflow-base==1.12.5`。
以下需显式启用：

```
lfx[sandbox]    ← 隔离沙箱
lfx[toolguard]  ← 工具护栏
```

## 三、改造顺序

按「后补成本」排序：

1. ✅ **移除媒体硬编码** —— 已完成，见 `docs/implementation-notes.md` §1
2. ✅ **引入 projectId + 分目录** —— 已完成，见 `docs/implementation-notes.md` §2
3. ✅ **项目 CRUD + Langflow 同步** —— 已完成，见 `docs/implementation-notes.md` §3
4. ✅ **langflow.ts 改异步** —— 已完成
5. ✅ **MCP 接入 + 治理网关** —— 已完成

## 四、治理网关（MCP 接入前必须先有）

Langflow 管「项目有哪些 MCP」，但**不管「这个角色能否调用」**。
权限校验需在自研层强制执行（对齐 `agent-roles-design.md:93`）：

```
代理请求 tool call
    ↓
【治理网关】唯一强制点
  ├─ 角色是否允许此 operation？
  ├─ 参数是否越界？（SSH 目标 host 白名单）
  ├─ 配额/预算是否还有？（注意：maxCost 当前从未被读取）
  ├─ 是否需人工审批？（DROP TABLE / rm -rf）
  └─ 写 attempt journal（幂等 + 审计）
    ↓
MCP server 执行
```

⚠️ 已知缺口：`maxSteps`/`maxToolCalls`/`maxCost` 在 `roles.ts` 声明但**代码中从未读取**。
迁移到 Langflow 后仍需自研实现——Langflow 不理解业务预算模型。

## 五、不做的部分

- ❌ 赛道（Track）枚举与赛道策略
- ❌ 多 user 层（单租户下多余）
- ❌ 运行时动态生成组件代码（Langflow 目录策略禁止，且不安全）
  → 业务节点需**预注册为可信组件**
