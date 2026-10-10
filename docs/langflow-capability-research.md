# Langflow 能力调研报告

> 调研对象：`langflow-base==1.12.5`（`services/langflow/pyproject.toml` 指定）
> 方式：PyPI 元数据 + 下载 wheel 解包实证源码，**非依赖记忆**
> 基准：`main @ 608f794`

## 结论速览

| 问题 | 结论 | 证据强度 |
|---|---|---|
| 能否自定义 component？ | ✅ **能，且是官方一等机制** | 实证（源码） |
| MCP 是否内置？ | ✅ **是核心依赖，非可选 extra** | 实证（依赖清单） |
| MCP 是否按项目/用户隔离？ | ✅ 按 `user_id` 隔离，且有项目级路由 | 实证（表结构 + 路由） |
| 是否有沙箱/工具护栏？ | ⚠️ 存在 `sandbox`/`toolguard` extra，但非默认启用 | 实证（依赖标记） |
| 能否支撑长任务？ | ✅ **能** —— job 队列 + `polling` 事件投递 + 6 态状态机 | 实证（源码） |

---

## 1. 自定义组件：可以

`langflow-base` 是薄壳，真正的组件框架在 **`lfx==1.12.5`**（`Requires-Dist: lfx~=1.12.5`）。

实证路径：

```
langflow/custom/custom_component/custom_component.py   ← 壳
lfx/custom/custom_component/component.py               ← 真实基类
lfx/components/custom_component/custom_component.py    ← 组件注册
lfx/template/frontend_node/custom_components.py        ← 前端节点生成
```

关键能力：

- 基类 `Component` 支持 `build()` 返回任意类型，含 `Message | Data | StructuredTool`
- **`async def to_toolkit()`** —— 组件可导出为 LangChain `Tool` 列表，**这是业务节点接入代理工具的标准接口**
- `RequiredInputsVisitor` 基于 AST 静态分析必填输入，意味着组件能被静态校验
- 官方自带 starter project：`Custom Component Generator.json`

### ⚠️ 但有安全策略约束（重要）

`langflow/api/v1/custom_component_policy.py` 实现了 **目录策略 + 代码哈希校验**：

- `validate_catalog_policy_for_component_code()` —— 校验组件代码哈希
- `code_hash_matches_any_template()` —— 比对已知服务端模板
- `get_trusted_code_for_validation()` —— **受限模式下返回服务端可信副本，而非执行客户端提交的代码**
- 注释明确：*"Catalog denial is evaluated first and has no superuser bypass"*（目录拒绝优先，且**无超管绕过**）

**这意味着**：自定义组件不是"随便传段 Python 就执行"。要么走可信模板，要么需要配置放开。对"业务节点 → 编译成 flow"的方案是好事——它能防止注入任意代码——但需要你们预先把业务组件注册为可信模板。

**落地含义**：你们的"业务节点类型"（跑测试、连中间件、日志跟踪）需要**预先在 Langflow 侧注册为自定义组件**，而不是运行时动态生成代码。这实际上和你们的治理思路是一致的。

---

## 2. MCP：内置且成熟

`mcp<2.0.0,>=1.28.0` 出现在**主依赖**中（非 `extra`），说明是核心能力而非附加包。

相关模块：

```
langflow/api/v1/mcp.py              ← MCP 主 API
langflow/api/v1/mcp_projects.py     ← 项目级 MCP
langflow/api/v1/agentic_mcp.py      ← 代理式 MCP
langflow/api/v1/mcp_utils.py
langflow/api/v1/projects_mcp_helpers.py
langflow/api/v2/mcp.py              ← v2 已存在
langflow/agentic/mcp/
```

数据库迁移证据：

```
247308ce2598_add_mcp_server_table.py
  表 mcp_server: id, user_id, name, transport, config(JSON), enabled, version
  唯一约束: uq_mcp_server_name_user   ← 按用户隔离

0882f9657f22_encrypt_existing_mcp_auth_settings_.py    ← 认证配置加密
66f72f04a1de_add_mcp_support_with_project_settings_.py ← 项目级设置
```

**关键发现**：MCP server 按 `user_id` 隔离，配置加密存储，且有 `mcp_projects` 项目级路由。这比预期的完整——**中间件可配置化（按项目指定）这个需求，Langflow 侧已有对应结构**。

另有 `fastmcp>=3.2.0` 和 `langchain-mcp-adapters` 可选包。

---

## 3. 沙箱与工具护栏：存在但需显式启用

```
Requires-Dist: lfx[sandbox]~=1.12.5    ; extra == 'sandbox'
Requires-Dist: lfx[toolguard]~=1.12.5  ; extra == 'toolguard'
```

- `sandbox` —— 对应 roadmap 阶段 4 要求的"隔离沙箱"，**1.12.5 已提供，但需显式安装**
- `toolguard` —— 工具护栏，与 `agent-roles-design.md` 的 "server-enforced tool policy" 高度契合

⚠️ 这两个都是 extra，当前 `pyproject.toml` 只写了 `langflow-base==1.12.5`，**没有启用**。做软件开发赛道时必须补上。

---

## 4. 长任务：✅ 确认支持（异步 job + 轮询）

此项已从"待验证"改为**已确认**。以下为源码实证。

### 4.1 异步 API 面（`langflow/api/v1/chat.py`）

```
POST /api/v1/build/{flow_id}/flow          → 返回 job_id 【异步提交】
GET  /api/v1/build/{job_id}/events         → 轮询事件流
POST /api/v1/build/{job_id}/cancel         → 服务端取消
GET  /api/v1/build/{flow_id}/{vertex_id}/stream
POST /api/v1/build_public_tmp/{flow_id}/flow
GET  /api/v1/build_public_tmp/{job_id}/events
POST /api/v1/build_public_tmp/{job_id}/cancel
```

`build_flow` 的 docstring 原文：

> Build and process a flow, **returning a job ID for event polling**.
> `event_delivery: EventDeliveryType = EventDeliveryType.POLLING`

### 4.2 事件投递三种模式（`langflow/api/utils/core.py:107`）

```python
class EventDeliveryType(str, Enum):
    STREAMING = "streaming"
    DIRECT    = "direct"
    POLLING   = "polling"   ← 长任务用这个
```

### 4.3 Job 持久化模型（`langflow/services/database/models/jobs/model.py`）

```
JobStatus: queued · in_progress · completed · failed · cancelled · timed_out · suspended
JobType:   workflow · ingestion · evaluation · stop · pause
```

存在独立的 `services/jobs/`、`services/job_queue/`、`database/models/jobs/crud.py`
→ **job 是持久化实体，不是内存态**，进程重启可恢复。

### 4.4 对比你们当前用法

| | 你们现在（`langflow.ts:328`） | 应改为 |
|---|---|---|
| 端点 | `POST /api/v1/run/{flowId}?stream=false` | `POST /api/v1/build/{flow_id}/flow` |
| 形态 | 同步阻塞等结果 | 返回 `job_id`，轮询 `/events` |
| 超时 | `timeoutMs = 30_000`（30 秒） | 不受单次 HTTP 超时限制 |
| 取消 | 仅 abort 本地请求 | `POST /build/{job_id}/cancel`（服务端取消） |
| 状态 | 只有 succeeded/failed | 7 态完整状态机 |

### 4.5 注意事项

- `GET /api/v1/task/{task_id}` **已废弃**（源码直接抛 400，提示 "use /run instead"）
- `/run` 仍有 `stream: bool` 参数，但 `/build` 才是面向长任务的官方路径
- **仍需实测**：`polling` 下事件保留时长、job 清理策略、并发上限

---

## 5. 对架构方案的结论

### ✅ 可以确认成立的

1. **"业务节点 → 编译成 Langflow flow" 路径可行** —— 自定义组件是一等机制，且能被静态校验
2. **MCP 可直接用** —— 内置、按用户隔离、配置加密，中间件"按项目可配置"有现成落点
3. **长任务有官方方案** —— 异步 job + 轮询，且 job 持久化
4. **沙箱与工具护栏有现成基础** —— `sandbox`/`toolguard` extra

### ⚠️ 需要注意的

1. **自定义组件需预注册为可信模板** —— 不能运行时动态注入代码（这是安全设计，不是限制）
2. **长任务执行模型需改造** —— 当前同步 + 30s 超时撑不住软件开发/视频赛道
3. **`sandbox`/`toolguard` 需显式启用**

### ❓ 仍建议实测的三件事

1. 起 `langflow-base 1.12.5`，验证 `polling` 的事件保留时长与并发上限
2. 注册一个自定义组件，验证 `to_toolkit()` 能否被 Agent 组件消费
3. 装 `lfx[sandbox]`，验证沙箱隔离强度是否满足软件开发赛道要求

---

## 附：调研方法

```powershell
# 元数据
Invoke-WebRequest https://pypi.org/pypi/langflow-base/1.12.5/json
Invoke-WebRequest https://pypi.org/pypi/lfx/json

# 解包实证
下载 wheel → 复制为 .zip → Expand-Archive
检查 langflow/api/v1/*.py、langflow/services/database/models/jobs/
     lfx/custom/custom_component/component.py、alembic/versions/*
```

所有结论来自实际文件内容，未依赖模型记忆。
