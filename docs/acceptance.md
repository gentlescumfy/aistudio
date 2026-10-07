# AI Studio 首版验收清单

> 适用范围：品牌素材 mock 垂直切片。  
> 契约来源：`docs/implementation-brief.md`。  
> 重要说明：本清单验证的是本地 mock 演示，不证明生产就绪或真实 AI 生成能力。

## 1. 验收前置条件

- Node.js 使用仓库声明的版本，依赖安装成功。
- API 使用默认 `http://localhost:4000`，且仅绑定本机开发接口。
- Web 使用配置项读取 API base URL，不硬编码生产地址。
- 测试期间不配置、不调用任何付费模型凭据。
- 下面命令使用当前根 `package.json` 提供的 npm 转发脚本。

开发者先执行：

```bash
npm run setup
npm --prefix apps/api test
npm --prefix apps/web run build
```

预期：三条命令退出码均为 0。测试不能依赖公网、真实供应商或秘密凭据。

启动 API（保持此终端运行）：

```bash
npm run dev:api
```

另开终端设置地址：

```bash
export API_BASE=http://localhost:4000
```

集成完成后还必须执行根级入口；它们验证协调者维护的跨应用流程：

```bash
npm test
npm run build
```

## 2. 自动化测试门禁

API 测试至少覆盖以下断言，并且所有用例使用临时隔离数据目录：

- [ ] prompt 会 trim；空值和仅空白值被拒绝。
- [ ] prompt 长度 2000 接受，2001 拒绝。
- [ ] count 仅接受 1–8 的整数；0、9、小数、字符串和缺失值拒绝。
- [ ] 未知 template 返回 404；disabled template 返回 409。
- [ ] 同一 idempotency key + 同一规范化输入返回同一 run；首次 201，重放 200。
- [ ] 同一 key + 不同 template/prompt/count 返回 409。
- [ ] 两个并发相同提交只创建一个 run，不生成两份资产。
- [ ] 状态按允许路径转换，持久化中不存在非法倒退。
- [ ] 进程重启后 run、节点、attempt 计数和资产仍存在；未完成 mock 工作安全恢复。
- [ ] retry 只重跑失败节点；成功节点、成功资产和已完成 attempt 不重复。
- [ ] 并发 retry 仅一个请求将 failed run 转为 queued 并返回 200，其他请求返回 409；最多创建一个新的活动 attempt。
- [ ] cancel 停止调度后继节点，pending 节点取消；重复 cancel 不产生新工作。
- [ ] 本地资产下载可用，目录穿越和未知 asset 被拒绝。
- [ ] CORS 只允许配置 origin；错误统一为 `{ error: { code, message } }`。
- [ ] mock run/asset 的 mode 始终为 `mock`，estimatedCost/actualCost 均为 0。

Web 自动化或组件测试至少覆盖：

- [ ] active run 轮询在完成、切换 run、组件卸载时清理。
- [ ] loading、空列表、API 错误、失败节点、取消中/已取消均有可理解状态。
- [ ] 只有适用状态显示 retry/cancel，点击会调用真实 API 而非装饰性 no-op。
- [ ] 图片、视频、coding 分类可见；禁用模板不可提交且明确显示 coming soon。
- [ ] 键盘可完成模板选择、表单提交、历史 run 选择和资产下载；焦点可见。
- [ ] mock 标签在创建表单、run 详情和资产区域持续可见。

## 3. API 契约实测

以下命令可逐条复制执行。每次先观察 HTTP 状态，再核对 JSON。示例中 `brand-assets` 应与 `GET /api/templates` 返回的、`category=image` 且 `enabled=true` 的实际 ID 核对。

### A01 健康检查

```bash
curl -i "$API_BASE/api/health"
```

通过条件：HTTP 200；body 精确包含 `status:"ok"` 和 `mode:"mock"`。

### A02 模板目录

```bash
curl -sS "$API_BASE/api/templates" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
 const x=JSON.parse(s); if(!Array.isArray(x.templates)) process.exit(1);
 const cats=new Set(x.templates.map(t=>t.category));
 for(const c of ["image","video","coding"]) if(!cats.has(c)) process.exit(2);
 const live=x.templates.filter(t=>t.enabled);
 if(live.length!==1 || live[0].category!=="image") process.exit(3);
 console.log(live[0].id);
});'
```

通过条件：退出码 0，并打印唯一可执行品牌图片模板 ID；每个模板有 `id/name/description/category/enabled/nodes`。

设置该 ID：

```bash
export TEMPLATE_ID=brand-assets
```

### A03 输入校验

```bash
curl -i -X POST "$API_BASE/api/runs" \
  -H 'content-type: application/json' \
  -d '{"templateId":"'"$TEMPLATE_ID"'","inputs":{"prompt":"   ","count":1},"idempotencyKey":"accept-empty"}'
```

```bash
curl -i -X POST "$API_BASE/api/runs" \
  -H 'content-type: application/json' \
  -d '{"templateId":"'"$TEMPLATE_ID"'","inputs":{"prompt":"logo","count":9},"idempotencyKey":"accept-count"}'
```

通过条件：两次均为 4xx；body 均符合统一错误信封，不回显堆栈。

### A04 创建与 trim

为避免与此前运行冲突，手工给 `RUN_KEY` 填一个本次唯一值：

```bash
export RUN_KEY=acceptance-001
curl -i -X POST "$API_BASE/api/runs" \
  -H 'content-type: application/json' \
  -d '{"templateId":"'"$TEMPLATE_ID"'","inputs":{"prompt":"  geometric fox brand mark  ","count":2},"idempotencyKey":"'"$RUN_KEY"'"}'
```

通过条件：首次 HTTP 201；返回 `run`，其 prompt 已 trim、count 为 2、mode 为 `mock`、成本为 0，节点与模板一致。

从响应复制 ID：

```bash
export RUN_ID=replace-with-returned-run-id
```

### A05 幂等重放与冲突

```bash
curl -i -X POST "$API_BASE/api/runs" \
  -H 'content-type: application/json' \
  -d '{"templateId":"'"$TEMPLATE_ID"'","inputs":{"prompt":"geometric fox brand mark","count":2},"idempotencyKey":"'"$RUN_KEY"'"}'
```

```bash
curl -i -X POST "$API_BASE/api/runs" \
  -H 'content-type: application/json' \
  -d '{"templateId":"'"$TEMPLATE_ID"'","inputs":{"prompt":"different request","count":2},"idempotencyKey":"'"$RUN_KEY"'"}'
```

通过条件：第一条 HTTP 200 且返回同一个 `RUN_ID`；第二条 HTTP 409；列表中没有重复 run 或资产。

### A06 查询、状态收敛与资产

```bash
curl -sS "$API_BASE/api/runs/$RUN_ID"
```

持续查询直到终态。通过条件：观察到合法状态，最终为 `succeeded`；所有节点成功、`attempts >= 1`；恰好有 count 对应的可下载资产；每个资产都有契约字段且 `mode:"mock"`。

```bash
curl -fL "replace-with-asset-url" -o /tmp/ai-studio-acceptance-asset
file /tmp/ai-studio-acceptance-asset
```

通过条件：下载成功，文件 MIME 与 `mimeType` 一致，非 HTML 错误页。

### A07 列表与 404

```bash
curl -i "$API_BASE/api/runs"
curl -i "$API_BASE/api/runs/not-a-real-run"
```

通过条件：列表 HTTP 200 且包含 `RUN_ID`；未知 run HTTP 404 且使用统一错误信封。

### A08 取消

创建一个新的多节点/足够慢的 mock run，立即执行：

```bash
curl -i -X POST "$API_BASE/api/runs/$RUN_ID/cancel"
curl -i -X POST "$API_BASE/api/runs/$RUN_ID/cancel"
```

通过条件：首次和重复取消均返回 HTTP 200 与 `cancelled` run；不会调度新的后继节点，未开始节点为 `cancelled`，重复请求不创建 attempt 或资产，迟到结果不覆盖取消状态。对 `succeeded` 或 `failed` run 取消应返回 409。若 run 在取消前已完成，记录为竞态证据并用新的 run 重试该项，不把已完成 run 强改为 cancelled。

### A09 失败与 retry

当前开发场景约定用 prompt 中的 `[mock:fail-once]` 触发一次确定性 mock 失败。创建该 run、确认其进入 `failed`，把返回 ID 写入 `RUN_ID`，然后执行：

```bash
curl -i -X POST "$API_BASE/api/runs/$RUN_ID/retry"
```

通过条件：HTTP 200 响应中的 run 为 `queued`；执行时仅失败节点 attempt 加一，成功节点 attempt 和资产不变；run 按 `queued -> running -> succeeded` 收敛。对其他状态 retry 返回 409。轮询可能错过短暂中间态，可结合响应与执行测试核验。`[mock:fail-once]` 仅是已记录的本地 mock 演示协议；真实供应商模式必须删除或禁用该触发器，不能让普通 prompt 操纵生产执行策略。

## 4. 重启恢复实测

1. 创建可观察到 `queued` 或 `running` 的 mock run，保存 `RUN_ID`。
2. 正常停止 API 进程，再按启动命令重启；不要删除数据目录。
3. 执行：

```bash
curl -sS "$API_BASE/api/runs/$RUN_ID"
```

4. 等待其进入终态，并再次查询列表及资产。

通过条件：

- [ ] run 未丢失且 ID 不变。
- [ ] 恢复只继续未完成工作，成功节点不重跑。
- [ ] 最终资产数量无重复，均可下载。
- [ ] `attempts` 与实际执行次数一致。
- [ ] 日志能看出恢复动作，但不泄露完整 prompt、凭据或内部堆栈。

再做一次强制终止场景（仅本地测试进程）：在 mock 节点运行时终止进程并重启。通过条件同上。真实供应商的未知结果不得套用 mock 自动重提策略。

## 5. 前端端到端人工验收

- [ ] 首屏能区分 image/video/coding；只有品牌图片模板可选择执行。
- [ ] 页面清楚显示“Mock / 演示资产 / 成本 0”，没有“真实 AI 已生成”等误导文案。
- [ ] 空 prompt、超长 prompt、非法 count 在提交前提示；服务端错误仍能正确展示。
- [ ] 提交后能看到 run、节点进度及状态变化；刷新页面后历史与当前 run 可恢复。
- [ ] 运行中的适用 run 可取消；失败 run 可 retry；按钮有 pending/disabled 防重复状态。
- [ ] 成功后 gallery 数量正确，图片可预览并下载。
- [ ] API 离线时显示可恢复错误；恢复后用户可重试，不出现无限 loading。
- [ ] 轮询期间切换历史 run 不串数据；终态后停止请求。
- [ ] 320px 宽度无关键控件被遮挡；常见桌面宽度布局完整。
- [ ] 键盘顺序合理、表单有 label、状态不只靠颜色表达、图片有合适 alt 文本。

## 6. 安全与边界验收

- [ ] API 监听地址、允许的前端 origin 均由配置控制；默认不暴露到公网。
- [ ] 未配置 origin 的跨域请求不获得宽泛 `Access-Control-Allow-Origin: *`。
- [ ] JSON body、prompt 和 count 均有服务端上限。
- [ ] 对 asset URL 尝试 `..`、编码后的路径穿越、绝对路径均不能读取目标目录外文件。
- [ ] 服务不接受任意 shell 命令、任意代码或任意供应商 URL。
- [ ] 错误响应和日志无凭据、文件系统绝对路径和原始敏感供应商响应。
- [ ] 仓库和运行产物中不存在付费供应商密钥。

## 7. 验收记录模板

执行者应把结果交给协调者，不要只写“通过”：

```text
Commit/工作区版本：
Node 与包管理器版本：
操作系统：
执行命令：
API 测试：通过/失败（数量与失败项）
Web 构建：通过/失败
API A01-A09：逐项结果
重启恢复：通过/失败（RUN_ID）
前端人工项：通过/失败/未测
安全边界项：通过/失败/未测
证据：关键响应、日志或截图位置
已知限制：
最终判定：通过 / 有条件通过 / 不通过
```

以下任一情况必须判定“不通过”：调用了真实付费服务；mock 标识缺失；幂等冲突创建重复 run；重启丢失数据；retry 重跑成功节点；cancel 后继续调度后继节点；资产存在目录穿越；基本构建或 API 测试失败。
