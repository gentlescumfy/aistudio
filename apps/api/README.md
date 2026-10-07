# AI Studio local API

Node.js 22+ and npm are sufficient. The mock image workflow needs no external service. Native Langflow integration is optional and connects to a separately managed local Langflow service.

```sh
npm --prefix apps/api install --workspaces=false
npm --prefix apps/api run typecheck
npm --prefix apps/api test
npm --prefix apps/api run build
```

The development command is `npm --prefix apps/api run dev`; compiled startup is `npm --prefix apps/api start`. Use the project's AgentsRoom Dev Commands terminal for long-running services. This implementation did not start a long-running server through a shell.

Default API origin: `http://localhost:4000`, socket bound to `127.0.0.1`. `HOST` accepts only `127.0.0.1`, `localhost` or `::1`. `PORT` defaults to 4000. `FRONTEND_ORIGINS` is a comma-separated list of exact origins, defaulting to `http://localhost:5173,http://127.0.0.1:5173`. An empty list disallows browser origins. CORS credentials are not enabled. Host headers also must name loopback, preventing basic DNS rebinding. Non-browser local clients with no Origin are permitted. These controls are local development restrictions, not authentication.

`DATA_DIR` defaults to `apps/api/.data` for both TypeScript and compiled startup, independently of the working directory. An override is resolved relative to the working directory. `MOCK_DELAY_MS` defaults to 350 per node and accepts an integer from 0 through 10000. `.env.example` describes environment variables; the server reads the process environment and does not load `.env` automatically.

## HTTP contract

All metadata endpoints return JSON; errors are `{ "error": { "code": "...", "message": "..." } }`. OpenAPI 3.1 is available at `GET /api/openapi.json`. Request/response tracing uses `X-Request-Id`, with safe supplied IDs accepted and other values replaced. Server request and executor errors use structured Fastify logs.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/health` | Mock mode plus run, role and workflow storage availability; 503 when storage/execution is unavailable |
| GET | `/api/templates` | Three built-in categories plus enabled, non-archived published workflow projections |
| GET | `/api/workflows` | Versioned workflow catalogue, starter graph and explicit mock-only runtime declaration |
| POST | `/api/workflows` | Create a draft with `{revision, workflow}`; append-only workflow history and optimistic library revision |
| POST | `/api/workflows/:id` | Append a draft revision while retaining the prior published pointer |
| POST | `/api/workflows/validate` | Validate graph structure and role references without saving or executing |
| POST | `/api/workflows/:id/publish` | Validate/publish a revision and snapshot exact role metadata; no agent/model/tool execution |
| POST | `/api/workflows/:id/archive` | Archive while preserving history and existing run snapshots |
| GET | `/api/workflows/:id/revisions` | Ascending immutable workflow revision history |
| GET | `/api/settings` | Always returns the v2 schema, revision, provider/account/model drafts and credential presence keyed by account; never raw keys |
| POST | `/api/settings` | Accepts `{schemaVersion:2, revision, settings}` or legacy v1 `{revision, settings}`; both save atomically as v2, stale revision returns 409 |
| GET | `/api/roles` | Role library snapshot, seven built-ins, custom roles including archived, non-executable tool catalogue and metadata-only runtime |
| POST | `/api/roles` | Create a UUID custom draft using `{revision, role}`; 201, append-only role revision and library revision |
| POST | `/api/roles/:id` | Append an edited custom draft revision; built-ins and archived roles return 409 |
| POST | `/api/roles/:id/archive` | Append an archive revision; repeated archive at the current library revision is idempotent |
| GET | `/api/roles/:id/revisions` | Ascending immutable role history, including built-in revision 1 |
| GET | `/api/langflow/config` | Loopback endpoint/auth metadata and credential presence; never returns credential values |
| POST | `/api/langflow/config` | Save Langflow endpoint and auth reference with an optimistic revision; does not probe or execute flows |
| GET | `/api/langflow/status` | Bounded local health/version check; Langflow outages do not affect core API health |
| GET | `/api/langflow/flows` | Native flow UUID/name/description/update metadata only; excludes graph and component data |
| POST | `/api/langflow/runs` | Persist a receipt, then asynchronously invoke the selected native Langflow flow; new 202, replay 200, changed idempotent request 409 |
| GET | `/api/langflow/runs` | Persisted Langflow execution receipts, newest first |
| GET | `/api/langflow/runs/:id` | Read one Langflow execution receipt |
| POST | `/api/runs` | 201 new durable queued run, 200 idempotent replay, 409 conflict |
| GET | `/api/runs` | All persisted run snapshots, newest first |
| GET | `/api/runs/:id` | Persisted run/node/asset snapshot; unknown UUID returns 404 |
| POST | `/api/runs/:id/retry` | Only failed → queued; successful nodes/assets retained; other states 409 |
| POST | `/api/runs/:id/cancel` | Queued/running → cancelled; repeated cancelled returns 200; failed/succeeded 409 |
| GET | `/api/assets/:runId/:assetId` | Registered local SVG preview only; `?download=1` returns an attachment |

Submission example:

```json
{
  "templateId": "brand-assets",
  "inputs": { "prompt": "A quiet blue coffee brand", "count": 3 },
  "idempotencyKey": "coffee-demo-1"
}
```

Prompts are trimmed and must contain 1–2000 characters; counts must be integers from 1–8. The key is required, 1–128 ASCII letters, digits or `._:-`. Keys are scoped to the entire persistent data directory, retained without expiry, and compared against a SHA-256 fingerprint of template ID and normalized input. Concurrent identical submissions serialize to one run. Different input with the same key returns `IDEMPOTENCY_CONFLICT`. Unknown templates return 404; `video-story` and `coding-assistant` return 409. Unknown fields are rejected, including user-supplied nodes, commands, URLs and providers. JSON bodies are limited to 16 KiB. Retry/cancel accept an absent body or an empty JSON object.

## Mock demonstration and downloads

The image workflow executes `brief` → `generate` → `export`. It creates deterministic, locally rendered 1024×1024 SVG concepts with prominent `MOCK DEMO`, `NOT AI GENERATED` and `COST 0` labeling. Prompt text is XML-escaped. These outputs demonstrate the workflow; they are not real AI images. The export node checks the expected asset count before reporting success. Every run and asset has `mode: "mock"`; `estimatedCost` and `actualCost` are numeric zero.

Asset `url` is relative to the **API origin**, e.g. `/api/assets/<run UUID>/<asset ID>`. The web client must resolve it against its configured API base URL. Append `?download=1` to download; the default is an inline preview. Assets live under `.data/assets/<run UUID>/<asset ID>.svg`. Only assets registered in a run snapshot can be served. IDs are strictly validated; symbolic links, traversal, directories and oversized files are rejected. SVG responses use restrictive CSP and `nosniff` headers.

Include `[mock:fail-once]` anywhere in a prompt to deliberately fail the generation node on its first attempt. Retrying resumes generation with attempt 2 and preserves the successful brief. This trigger belongs only to the free local mock demonstration; it is not an external provider failure.

## Persistence, recovery and failure semantics

The file store serializes mutations, validates snapshots, writes an exclusive temporary file, fsyncs, atomically renames to `runs.json`, and fsyncs the containing directory. In-memory state is published after this commit. Submissions, idempotency records, node attempts and transitions are persisted before executing provider work. Asset files are committed before successful node metadata. A partial local mock write is overwritten at its deterministic path during recovery. Unreferenced interrupted files are not served.

A single asynchronous worker processes runs in submission order. On startup, queued/running mock runs are reconciled back to queued, interrupted nodes become pending, and successful nodes remain unchanged. Attempts count execution starts, so an interrupted node gains one attempt when resumed. Failed/cancelled/finished runs stay terminal until an explicit permitted action. Historical inputs and nodes are stored in the run snapshot, not reconstructed from the latest templates. Idempotency replay also survives restart.

Retry resets failed nodes only. Concurrent retry requests admit one transition to queued, with other requests returning 409. Cancellation commits a terminal state before aborting local work, cancels remaining nodes, and retains already completed assets. A result arriving after cancellation cannot overwrite cancelled state or add assets. This does not promise cancellation of an external provider's effects.

The provider abstraction declares its recovery behavior. Only the local mock is configured. An interrupted provider with `manual-reconciliation`, or an execution raising `ProviderOutcomeUnknownError` for a timeout/disconnect after dispatch, is marked `PROVIDER_OUTCOME_UNKNOWN` and automatic execution/retry is refused. Future real providers must classify those uncertain outcomes explicitly; integration of a real paid provider and its reconciliation UI remains future work. No exactly-once external effects are claimed.

Native Langflow is a separate adapter at `http://127.0.0.1:7860` by default. Its config is stored in `langflow-config.json`; run receipts and internal config/flow snapshots are stored in `langflow-runs.json`. Both are single-process local files. The base URL must be loopback HTTP(S), with no credentials, query or fragment. `api-key-env` stores only an uppercase environment-variable name and sends its value server-side in `x-api-key`; the key itself is never persisted or returned. The API uses stable `/api/v1/flows/?header_flows=true&get_all=false&page=1&size=100` and `/api/v1/run/{flowId}?stream=false` routes. It asks for header-only flow metadata instead of downloading full starter graphs, relies on Node fetch to decompress supported encodings, caps the decoded upstream body at 2 MiB, applies a configurable 1–120 second timeout, and rejects redirects. It exposes only sanitized flow metadata and decoded text output (at most 16,000 characters). Saving settings, reading status, and listing flows never execute a flow.

Langflow submissions validate a UUID flow ID, read the selected flow's metadata, persist a queued idempotency receipt, then dispatch asynchronously using `input_request: { input_value, input_type: "chat", output_type: "chat", session_id }` with `stream=false` in the query string. On restart, queued receipts can resume; a run that had entered dispatch becomes `outcome_unknown`, because Langflow may have executed it before the API stopped. Replays return the original receipt even if the service is now offline. The Langflow endpoints intentionally provide no cancel or retry action and do not claim per-node recovery. The original `/api/workflows` and `/api/runs` local mock features remain separate from native Langflow execution.

Persistence failures fail closed: subsequent writes and health are refused until storage is inspected and the API restarts. Background write failures stop execution; they are not mislabeled as retryable provider failures. Corrupt or unsupported snapshots fail startup and are never replaced with empty data.

An exclusive PID/token writer lock refuses another live process using the same directory. Startup can remove a dead writer's lock on the same machine. A separate short-lived `recovery.lock` serializes stale-lock cleanup; if a process dies during that cleanup, inspect and remove that recovery lock only after confirming all writers have stopped. PID reuse is handled conservatively by refusing startup when the recorded PID is alive. Do not put this store on a shared/network filesystem.

## Verification and limits

Configuration stores `defaultCount` (1–8), up to eight providers, sixteen accounts, and sixty-four manually declared models, plus text/image/video route drafts. `routes.image` defaults to `mock-svg`; a draft image binding may be saved but runtime remains mock. Protocols are draft declarations: `openai-compatible`, `anthropic` or `google`. Remote addresses must use HTTPS, local loopback may use HTTP, local transport requires a loopback host, and URL credentials/query/hash are rejected. Accounts reference providers; models reference accounts; external model IDs are unique per account; routes must bind one ownership chain, an enabled account and a declared matching capability. `secretEnv` references an uppercase process environment-variable name; credential presence is reported by account ID. Raw API keys and unknown fields are rejected. No provider request or paid operation occurs on save. Metadata is persisted to `settings.json` with serialized optimistic revision checks; malformed saved configuration fails startup. A configuration write fault refuses further reads/writes and health checks until restart. Real provider execution remains unimplemented.

On startup, unversioned v1 settings files are validated and migrated to v2 in memory. Each old provider becomes a provider plus deterministic account/model IDs; legacy text/video routes become full bindings and imply declared draft capabilities. The original `settings.json` remains byte-for-byte untouched until a successful settings save, which atomically writes a versioned v2 snapshot and advances the same optimistic revision. Unknown versions and malformed v1/v2 files refuse startup without replacing their source. The POST endpoint also accepts the old unversioned body and always persists/returns v2. OpenAPI documents both request variants with a `oneOf` input schema.

Role metadata is stored independently in `roles.json` using a schema version, library revision and append-only role snapshots. Seven stable built-in slugs each have immutable published revision 1; custom UUID roles are drafts and can be edited by appending revisions or archived without deleting history. Writes serialize by a library-level optimistic revision, use the same atomic file writer and fail closed. The seven known tool IDs are declarations only, each with `executable:false`; no role action dispatches tools, a model, a CLI or a team. Role creation/editing validates explicit full provider/account/model bindings against enabled Settings v2 accounts and declared text/code capabilities. Reads dynamically mark removed or disabled bindings `unavailable` while preserving their original selection and history. Health includes role storage availability. Role POST bodies allow 64 KiB; all other requests retain existing route/global limits.

Configurable workflow metadata and append-only snapshots are stored in `workflows.json`; create/edit/publish/archive use a serialized catalogue revision and atomic fail-closed writes. Drafts can be structurally incomplete, while publish validates one root prompt, a terminal export, image nodes, allowed DAG edges, reachability, acyclicity, safe `{{prompt}}` / `{{count}}` placeholders, dimensions/counts and referenced role revisions. Role annotations are copied into the published snapshot for description only. Only published prompt/image/export nodes run through the local mock adapter, serially in dependency order. Expanded prompts, node configuration, dependency IDs, role snapshots, expected total assets and the exact published workflow are stored on each run; retries and recovery never read current workflow or role state. Workflow image parameters change SVG dimensions and counts, per-branch asset IDs/names remain distinct, and export verifies the aggregate asset count. No conditional, loop, shell, arbitrary API, real model, agent or tool execution exists.

The run catalogue was upgraded from schema version 1 to version 2 to support workflow IDs and snapshots. Existing v1 runs and idempotency entries are retained; before the first upgraded write, the original bytes are fsynced into `runs.json.v1.bak`. If that backup exists with different bytes, startup/write fails closed. The backup is a local recovery aid, not a managed backup or restore workflow.

Tests run directly with Node's test runner through `tsx`; no QA agent is used. The suite exercises strict inputs, concurrent idempotency, state transitions, deterministic/escaped SVG download, CORS/Host/path protections, concurrent retries, preservation of successful generation, queued/active/repeated cancellation, late provider results, workflow CRUD/publication/history, DAG validation, role snapshots, parameterized branching outputs, immutable workflow run retry/recovery, idempotency across republish/archive, v1 backup migration, actual child-process SIGKILL and restart recovery, corrupt snapshots, exclusive writers and injected storage failures. Child fixtures have bounded lifetimes and never listen on a network port.

This is a single-machine, single-process, non-production vertical slice. It has no Studio authentication, multi-tenant isolation, billing, paid model execution, GPU scheduling, video editing or coding sandbox. Shell and arbitrary API nodes are unavailable. History and idempotency are unpaginated/unbounded, snapshots rewrite the whole document, and there is no retention, asset garbage collection, distributed lease, backup workflow or production rate limit. Use local storage with enough free space. Production durability, access control and scheduling require a later design rather than multiple API replicas sharing this directory. Langflow's own service and native editor are deployed and managed separately; this package does not start that service.
