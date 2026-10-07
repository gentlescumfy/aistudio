# Configurable workflow milestone

Status: superseded as the primary workflow entry by the user's Langflow request. This contract describes the retained legacy React Flow/local mock experiment, now covered by regression tests. For actual Langflow integration see langflow-integration-contract.md; the framework statements below apply only to this legacy experiment.

## Scope and ownership

Implement a persisted visual workflow editor plus actual configuration-driven local mock execution. Frontend owns apps/web; backend owns apps/api; coordinator owns root tests/docs/integration. Keep existing settings, roles and brand-assets runs working. No new agents/QA, no commits/pushes, no shell background servers; existing managed servers watch changes.

Canvas framework: `@xyflow/react` (React Flow12), using controlled nodes/edges, handles, connection validation and saved positions. Official references: https://reactflow.dev/examples/interaction/save-and-restore and https://reactflow.dev/examples/interaction/validation . It is the UI canvas, not the backend engine. Backend extends the existing local persisted executor; no Langflow/Temporal integration is claimed.

Only prompt/image/export nodes execute, through the local mock adapter. Role references are versioned descriptive annotations, not agent execution or tool grants. No conditional/loop/RAG/API/shell nodes or real media providers are enabled.

## Shared types

```ts
type RoleRef = { id: string; revision: number };
type Position = { x: number; y: number };
type NodeBase = { id: string; name: string; position: Position };
type WorkflowNode =
  | (NodeBase & { kind: 'prompt'; config: { template: string; roleRef: RoleRef | null } })
  | (NodeBase & { kind: 'image'; config: { width: number; height: number; count: number | null } })
  | (NodeBase & { kind: 'export'; config: Record<string, never> });
type WorkflowEdge = { id: string; source: string; target: string };
type WorkflowDefinition = { name: string; description: string; nodes: WorkflowNode[]; edges: WorkflowEdge[] };
type RoleSnapshot = { nodeId: string; role: Role }; // Role matches the existing role library DTO
type Workflow = WorkflowDefinition & {
  id: string; revision: number; lifecycle: 'draft' | 'published' | 'archived';
  publishedRevision: number | null; createdAt: string; updatedAt: string;
  roleSnapshots: RoleSnapshot[];
};
type GraphIssue = { code: string; message: string; nodeId?: string; edgeId?: string };
type Validation = { valid: boolean; issues: GraphIssue[]; warnings: string[] };
type WorkflowLibrary = {
  revision: number; workflows: Workflow[];
  starterDefinition: WorkflowDefinition;
  runtime: { mode: 'mock'; executableKinds: ['prompt','image','export']; agentExecutionEnabled: false };
};
```

Each successful create/edit/publish/archive appends an immutable Workflow revision and increments the catalogue revision, mirroring role-library audit semantics. Publishing appends a published revision and sets publishedRevision to that new revision. Editing creates a draft revision but preserves the previous published pointer; the older published version remains executable. Archive preserves history but prevents new executions. No hard delete or restore in this milestone. Repeating archive at current catalogue revision can return the existing snapshot without increment.

## API

- GET `/api/workflows`: WorkflowLibrary; archived entries included for filtering. Starter graph is brief(prompt {{prompt}}) -> generate(image1024x1024,count:null) -> export, with saved positions.
- POST `/api/workflows`: `{revision, workflow: WorkflowDefinition}`, create UUID workflow draft,201 and `{revision, workflow}`.
- POST `/api/workflows/:id`: same body, append draft edit,200. Archived409, unknown404, stale catalogue revision409.
- POST `/api/workflows/validate`: `{workflow: WorkflowDefinition}`,200 with Validation. Does not save, publish or execute.
- POST `/api/workflows/:id/publish`: `{revision}`, reject graph/reference issues with400 `INVALID_WORKFLOW`; return `{revision, workflow}` for the new published snapshot. Resolve prompt roleRefs to immutable matching role revisions and attach roleSnapshots. Missing or archived referenced role revision is invalid. Current-role archival prevents new publishing; already published annotations remain immutable and runnable mock metadata.
- POST `/api/workflows/:id/archive`: `{revision}`,200 with `{revision, workflow}`. Preserve run and revision history.
- GET `/api/workflows/:id/revisions`: `{revisions: Workflow[]}`, ascending revision.

Persist schemaVersion1 workflow catalogue and immutable histories in workflows.json under the existing API data directory/writer lock. Atomic fsync/rename, optimistic concurrency, fail-closed storage/health and corrupt/unknown version startup rejection remain mandatory. Keep unpublished definitions and historical published pointers intact across restart. Save/validate requests may use128KiB route limits; no unbounded requests.

## Definition validation and graph rules

Names trimmed1–80, descriptions1–1000, node/edge IDs lowercase slug1–64, unique per collection. Node names1–80; positions finite within +/-10000. Max64 custom workflows including archived,20 nodes,40 edges. Drafts may be topologically incomplete; save validates field shapes/unique IDs but publication and execution require the complete graph rules below.

- Exactly one root prompt and one terminal export, with at least one image node.
- Prompt may receive at most one prompt parent; image receives exactly one prompt parent; export receives one or more image parents. Allowed edges: prompt->prompt, prompt->image, image->export only.
- No self-loop/cycle, duplicate source-target connection, dangling edge, disconnected or dead-end node. Every node is reachable from root and can reach export. Error messages identify node/edge where possible.
- Fan-out image branches are allowed; the local worker dispatches ready nodes serially. Do not claim parallel execution or dynamic conditions.
- Prompt template max6000; supports only {{prompt}} and {{count}} (optional whitespace). Unknown placeholders are validation errors; do not eval templates. Prompt parents supply their resolved prompt; root starts from request inputs. Expanded prompt cap16000, enforced before dispatch/storage to avoid amplification.
- Image width/height integers512–2048; count is null (use request count) or integer1–8. Configuration must affect actual SVG metadata/content size and per-node batch count.
- Export config is empty and export checks the expected total output count across image nodes.
- RoleRef identifies an existing non-archived role revision at publish. Role binding does not invoke the persona/model/tools; explicit warning remains visible.
- Unknown fields/kinds/tools/URLs/code or raw credentials rejected. Node kind allowlist does not expose shell/API execution.

## Run integration and snapshot semantics

Extend GET `/api/templates` with enabled non-archived published workflows projected to the existing template fields, category image, template ID = workflow UUID; include optional workflowRevision (published pointer) and source='workflow'. Preserve existing brand-assets/video-story/coding-assistant metadata and IDs.

POST `/api/runs` keeps existing fields and accepts optional workflowRevision. For workflow templates resolve only published history, never a draft; absent workflowRevision uses latest published. An explicit older published revision is allowed while the workflow is not archived. Snapshot definition, graph revision, roleSnapshots, dependency order, parameters and expanded prompt outputs into the run. For public Run add optional:

```ts
workflowSnapshot?: Workflow; // the exact published record
expectedAssetCount?: number; // sum(image.config.count ?? inputs.count)
// optional per RunNode: config, dependsOn:string[], outputPrompt?:string
```

History/retry/recovery use only that stored snapshot, never latest workflow or roles. Editing/publishing/archiving workflows cannot retarget an existing run. Preserve successful nodes/assets on retry and existing cancel/unknown-outcome protections. Failed downstream nodes must not execute before dependencies succeed. A corrupt/no-ready-node runtime state must not silently mark success.

Idempotency remains keyed by the submitted normalized request, including explicit requested workflowRevision if present. A replay with the same key/request returns the original run before consulting today's publication/archive state; a different request/revision conflicts409. Do not include newly resolved latest revision in an implicit replay fingerprint, which would break retries after publishing changes. Legacy brand-assets behavior and filenames remain compatible.

Asset IDs and custom filenames must distinguish image node IDs to prevent branch collisions. Aggregate count and export validation use the whole graph. For legacy runs without workflowSnapshot, retain current semantics and deterministic output identity; never discard prior runs.

If upgrading runs.json storage version, validate and migrate all old runs/submissions, preserving successful state, attempts, assets and idempotency. Create a recoverable original backup before first upgraded write; reject unsupported/corrupt versions. Tests must exercise existing v1 data and actual restart, not only fresh stores. Run schema templateId becomes a validated string instead of a brand-assets literal; keep existing public states and envelopes.

## Frontend and execution UI

Add `工作流配置` navigation and `/#workflows`. Show library, starter-template creation, metadata, real React Flow canvas, add/remove/select/drag nodes and connect/disconnect edges. Include accessible form-based connection controls as an alternative to pointer dragging. Node inspector edits prompt template/role revision annotation, image width/height/count override. Do not expose unavailable kinds as active buttons.

Actions: save draft, validate, publish, archive, inspect revisions; clear saved/published/draft state and current published pointer. Dirty navigation/refresh confirmation and revision409 preserve user edits. Canvas payload must strip React Flow UI-only fields before API save. Positions and parameters survive reload. Match existing warm themes and320px responsive editor; canvas has a bounded viewport so it does not create document overflow.

Published workflows appear in the existing template picker; users can start a mock run with the same prompt/count form. Send displayed workflowRevision when selecting that template. Show captured workflow revision and expected total asset count in history/results/inspector where available. Existing role/setting/history/theme behaviors must regress cleanly. No button may claim to start a real agent/model.

## Delivery checks

API: draft/publish/archive/history persistence, valid branching graph, graph rejection, role annotation snapshot, old data migration, idempotent replay across new publication/archive, actual parameter effects, branch asset uniqueness/export sum, retry/cancel/restart with immutable graph, corruption and concurrent writes.

Web: graph edit/serialization/validation, node parameters, role annotation, dirty/conflict states, published template run request and metadata, theme/responsiveness. Coordinator: real-browser save/reload/publish/run, SVG dimensions/count, edit/publish without changing old runs, role version snapshot, recovery/retry/cancel and full existing-suite regression. Report files, stable labels, test/build results and limits; freeze after handoff.
