# Langflow integration milestone

This replaces the new-workflow React Flow/self-engine direction at the user's explicit request. Preserve all existing files/data and finish only necessary compile-safe checkpoints. Do not delete or destructively revert legacy work. New primary `/#workflows` connects to native Langflow editor and API; retained local mock flows must not be presented as Langflow execution.

## Ownership

Coordinator owns services/langflow, deployment commands, root browser/live-service tests and docs. Backend owns apps/api adapter/config/run ledger/routes/OpenAPI/tests. Frontend owns apps/web Langflow page/navigation/types/API/tests. Do not edit another owner's files, start shell background servers, create additional agents/QA, commit/push or read/modify app plumbing. Existing Studio API/Web dev commands stay in place.

## Runtime reference

Coordinator installs langflow-base1.12.5 with Python3.12/uv and launches its complete UI/API at http://127.0.0.1:7860 through Dev Commands. Local development uses LANGFLOW_AUTO_LOGIN=true and LANGFLOW_SKIP_AUTH_AUTO_LOGIN=true; this is loopback only. Official docs: https://docs.langflow.org/get-started-installation , https://docs.langflow.org/api-keys-and-authentication , https://docs.langflow.org/concepts-api/ . Use stable `/api/v1/flows/` and `/api/v1/run/:flowId?stream=false` for this milestone; do not rely on beta background contracts.

Native editor is the graph source of truth. Prefer a normal safe new-tab editor link, with an optional iframe only if installed response headers actually allow it and browser checks pass. Do not claim embedded editor support without verifying; no credential is passed in a URL.

## Config and adapter contract

```ts
type LangflowConfig = {
  baseUrl: string; // loopback HTTP(S) only for this milestone; no credentials/query/hash
  authMode: 'local-development' | 'api-key-env';
  secretEnv: string; // optional uppercase variable name, never the key value
  timeoutMs: number; // integer1000–120000
};
type ConfigResponse = { revision: number; config: LangflowConfig; credentialConfigured: boolean };
type LangflowStatus = {
  connected: boolean; version: string | null;
  editorUrl: string; authMode: LangflowConfig['authMode'];
  message: string;
};
type LangflowFlow = { id: string; name: string; description: string; updatedAt: string | null };
type LangflowRun = {
  id: string; flowId: string; flowName: string;
  input: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'outcome_unknown';
  createdAt: string; updatedAt: string;
  output: string | null; error: string | null;
  provider: 'langflow';
};
```

- GET/POST `/api/langflow/config`, save `{revision,config}` with serialized atomic revision checks; default loopback7860, local-development, empty secretEnv, timeoutMs30000. Independent ignored data file. Unknown fields/unsafe URL/raw key rejected. API-key mode injects x-api-key only server-side; no secret value is returned/logged.
- GET `/api/langflow/status`: bounded health/version checks. Offline/auth/malformed upstream yields connected:false and a safe readable message. Langflow offline must not break core `/api/health`/mock/roles/settings.
- GET `/api/langflow/flows`: `{flows:LangflowFlow[]}` from native API, metadata only. Never return full graph/component code or credential fields. Handle installed list response shape correctly; unsupported shape returns typed error.
- GET `/api/langflow/runs`: `{runs:LangflowRun[]}`, newest first.
- GET `/api/langflow/runs/:id`: `{run:LangflowRun}`.
- POST `/api/langflow/runs`: `{flowId,input,idempotencyKey}` returns202 `{run}` on a new persisted submission,200 existing receipt on same key/request,409 changed input. Input trimmed1–2000, key uses existing bound rules; flowId UUID. Read selected native flow metadata before starting; no arbitrary URL/component tweaks/body pass-through.

Persist run receipt before dispatch. In installed1.12.5, dispatch `/api/v1/run/:id?stream=false` with `{input_request:{input_value,input_type:'chat',output_type:'chat',session_id}}`; the OpenAPI uses a wrapper rather than legacy flattened fields, and a real Echo call verified this shape. Session ID derives from the Studio run. Parse known message/text output structures and cap display output at16000 characters; do not pass raw upstream objects/logs or errors to users. Empty recognized outputs can be reported as empty text success, unsupported response shape fails with a readable adapter error.

Installed flow header discovery is `/api/v1/flows/?header_flows=true&get_all=false&page=1&size=100`, returning `{items,total,page,size,pages}`. Returning get_all=true includes starter examples and full data; do not use it for normal metadata discovery. Node fetch handles gzip but limits must apply to decoded bytes.

No automatic retry of writes or sync run calls. Interrupted/disconnected/timed-out dispatch can have executed externally: mark outcome_unknown and disable automatic resubmission; on API restart any previously running task becomes outcome_unknown. Only undispatched queued work can resume. Idempotent replay returns original receipt regardless of current flow/config availability. No fake cancel or per-node breakpoint-resume claim; stable v1 integration lacks those guarantees. Existing local mock retries/cancel remain separate.

Config changes affect future runs. Snapshot internal endpoint/auth reference/timeout/flow metadata per submission so in-flight jobs are not redirected. Secret values are not persisted; API environment references are resolved server-side. Bound upstream response sizes, timeouts, redirects (reject), known routes/methods and local host policy. Treat graph content as upstream data; no eval/shell/import of flow code in the Studio API.

The application is local-only with current Host/Origin protection; real tenant authorization/production auth remains future work. Runtime integration is real Langflow, but no paid model execution is part of acceptance. Do not automatically run arbitrary existing flows to probe connectivity.

## Frontend

Replace primary `/#workflows` with a Langflow workspace: connection settings, status/version, native flow list/refresh, actual editor entry, selected-flow input/run action and native run history/output. Use existing warm themes/responsiveness; distinguish Langflow run status from local image mocks. Save/refresh needs real endpoints, not decorative controls. Credential field is a variable name. Unknown outcomes are visibly unresolved and have no unsafe retry button. Run requires an explicit click; saving config/listing flows never executes a model.

Preserve archived/local experimental custom-flow code/data if already implemented, but do not route users primarily to React Flow or claim it is Langflow. Existing workbench/templates/roles/settings behavior must continue; expose only capabilities actually implemented. Report stable labels for connection forms, editor link, flow selection, run input/history and error states.

## Acceptance

Coordinator owns the real local service, verifies editor loads, flow metadata refresh and a no-provider-cost Chat Input -> Chat Output echo flow through the native API and Studio adapter. Backend tests use bounded upstream mocks for auth injection, URL/size/timeouts, known output parsing, durable receipts/duplicates/conflicts, unknown outcomes and restart. Frontend tests cover configuration/state/history/error/dirty behavior. Final browser checks include actual Langflow run, deep/light/narrow views and existing Studio regression. No QA agent is delegated. Do not mark completed on mock-only tests if the actual service cannot start.
