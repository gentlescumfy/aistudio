# Role library metadata milestone

Scope: implement a persistent role library and editor, not agent execution. No real model calls, tool execution, CLI login, sandbox or team dispatch is enabled.

## Ownership

Backend: apps/api only, including schema/store/routes/OpenAPI/tests. Frontend: apps/web only, including role library navigation/page/types/validation/tests and current theme styling. Coordinator: root browser tests/docs/integration. Do not modify another owner's files, create extra agents/QA, commit/push or start new shell background servers. Existing development servers already watch the code.

## Shared contract

```ts
type RoleCategory = 'media' | 'engineering' | 'operations' | 'custom';
type RoleDefinition = {
  name: string; category: RoleCategory; description: string; systemPrompt: string;
  inputContract: string; outputContract: string; // descriptive declarations, not executable JSON Schema
  tools: string[]; // known tool IDs; declarations only, not granted runtime authority
  modelSelection: { kind: 'inherit' } | { kind: 'binding'; binding: ModelBinding };
  limits: { maxSteps: number; maxToolCalls: number; deadlineMs: number; maxCost: number };
};
type Role = RoleDefinition & {
  id: string; revision: number; builtIn: boolean;
  lifecycle: 'draft' | 'published' | 'archived';
  createdAt: string; updatedAt: string;
  modelStatus: 'inherit' | 'configured' | 'unavailable';
};
type ToolDeclaration = { id: string; name: string; description: string; risk: 'read' | 'generate' | 'write'; executable: false };
type RoleLibrary = {
  revision: number; roles: Role[]; tools: ToolDeclaration[];
  runtime: { enabled: false; mode: 'metadata-only' };
};
```

ModelBinding matches Settings v2. Initial category entries: scriptwriter, storyboard director, continuity reviewer, editor, architect, developer, code reviewer. Built-ins are read-only published templates with stable IDs and descriptive contracts/prompts. Custom copies are drafts and configurable; neither published nor draft metadata can execute.

Suggested tool catalogue IDs: assets.read, context.search, images.generate, media.render, code.read, code.edit, code.test. All have executable:false; role tool checkboxes describe intended future permissions, not capabilities currently available. No arbitrary shell/API tool identifiers or skill marketplace imports.

## API

- GET `/api/roles`: RoleLibrary, including archived metadata (frontend hides by default and can filter archived).
- POST `/api/roles`: `{revision, role: RoleDefinition}`, creates a custom draft with UUID/id, revision1, returns `{revision, role}` with201.
- POST `/api/roles/:id`: `{revision, role: RoleDefinition}`, edits a custom non-archived draft, increments role revision and library revision, returns `{revision, role}` with200. Built-ins/archived updates409; unknown ID404.
- POST `/api/roles/:id/archive`: `{revision}`, preserves custom role and revision history, increments revisions and returns `{revision, role}`. Built-ins409; stale library revision409; already archived at matching library revision may return current snapshot without increment.
- GET `/api/roles/:id/revisions`: `{revisions: Role[]}` ordered by ascending revision, including built-in revision1.

All errors retain existing envelope. All writes require the current library revision (stale409); serialized atomic file writes persist before success. Local `roles.json` stores schemaVersion1, library revision and immutable role revisions. Keep the existing API single-writer lock and fail-closed behavior; corrupt/unknown data refuses startup and is never silently reset. Health includes role storage availability. Role POST limit64KiB, other endpoints retain current limits.

Validate trimmed name1–80, description1–1000, systemPrompt1–6000, input/output contract1–4000; tools known/unique; max64 custom roles, built-ins excluded. Limits: maxSteps1–100, maxToolCalls0–1000, deadlineMs1000–3600000, maxCost0–1000 (metadata only). IDs are UUIDs for custom roles; stable built-in slugs permitted in params. Unknown fields rejected. Credential values are never part of role metadata.

Explicit model bindings must resolve through one provider/enabled account/model and a declared text or code capability when creating/editing. Save does not prove actual provider access. If Settings later removes/disables the account/model, return the role's original selection with modelStatus unavailable on reads; do not silently substitute or refuse to load otherwise valid metadata. Inherit remains explicit and is displayed as workspace-default text binding or currently unconfigured; execution remains disabled.

## Frontend

Add working `代理角色` navigation to `/#roles`. Search/filter role cards by category/source/lifecycle; built-in details are read-only with a `复制为自定义角色` action, custom drafts can create/edit/archive. Editor covers persona, input/output declarations, intended tool permissions, model inheritance/full binding and budgets. Show role revision and unavailable references clearly. Provide saved/conflict/error/empty/loading states, archive confirmation and dirty-navigation protection consistent with settings page. Update heading/breadcrumb/hash behavior without breaking workbench/settings actions or count defaults.

Use existing warm dark/light/system theme and320px layouts. No enabled “run agent” button, no fake login or tool activity. Explicitly label metadata-only library and unimplemented execution/authorization. Model selector uses enabled account text/code models from GET `/api/settings`; no secrets or external discovery calls.

Coordinator browser checks will create/copy/edit/reload/archive a role, inspect retained history, verify draft model binding, dirty-navigation and dark/light/narrow layout. Report stable accessible labels and actual tests/build results, then freeze application files.
