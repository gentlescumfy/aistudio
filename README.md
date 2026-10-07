# AI Studio

A visual orchestration studio for reusable image, video and coding workflows.

## Current milestone

The local Studio now integrates real Langflow1.12.5 for native visual editing and API execution, alongside versioned model settings, role metadata and explicitly labeled mock brand assets. Actual execution has been verified with a no-model Echo flow; paid providers and production deployment remain outside this delivery.

The application has three independently managed services:

- `apps/web`: React and TypeScript studio interface.
- `apps/api`: TypeScript API and persistent local execution.
- `services/langflow`: isolated Python3.12/uv environment, pinned Langflow editor/API.

Root scripts forward to each application's package scripts. With Node.js22 or later, install dependencies using `npm run setup`, build with `npm run build`, and run direct developer tests with `npm test`. Latest verification passed55 API tests/typecheck/build,48 web tests/build and16 actual-browser scenarios on Node.js25.9.0. Frontend Vitest is4.1.11 and its npm audit reports zero vulnerabilities. Node.js22 compatibility and a full accessibility audit remain unverified; see the verification evidence below.

Development commands are `npm run dev:api` and `npm run dev:web`; use the AgentsRoom Dev Commands panel to manage their long-running terminals. The API defaults to port 4000 and the web interface to port 5173. Frontend assets returned as relative paths are resolved against the configured API base URL.

The saved commands are named `AI Studio API` and `AI Studio 工作台`. The local workbench is available at `http://127.0.0.1:5173` while those commands are running. To repeat browser checks, install Chromium once with `npx playwright install chromium`, then run `npm run test:e2e` with API, Web and Langflow running. The suite creates persistent local demonstration records and uses its own browser profile.

## Native Langflow workflows

Open `http://127.0.0.1:5173/#workflows`. The workspace exposes connection configuration/status, native flow metadata, a new-tab editor link, explicit execution and persistent results/history. The real native editor runs at `http://127.0.0.1:7860`; it is not an embedded React Flow imitation.

Install/start the independent service through AgentsRoom Dev Commands using [the service instructions](services/langflow/README.md). The current profile explicitly enables automatic login on loopback for local development only. API credentials, when needed, use server-side environment-variable references, not raw keys in browser configuration. The base package has no curated provider extensions; install required components separately before using provider-specific flows.

The adapter lists metadata only, persists receipts before dispatch and supports idempotent replay/conflict detection. Interrupted running requests become `outcome_unknown` and are not automatically resubmitted. Native node-level resume/cancel, immutable external graph publication and production authentication are not claimed. Studio role/model metadata is not automatically injected into Langflow nodes.

`node scripts/langflow-echo.mjs --verify` provisions/verifies the owned, locked two-node ChatInput → ChatOutput fixture without model calls. The legacy React Flow/mock experiment remains available in source and regression tests; Langflow is the primary workflow entry.

## Configuration

The workspace uses a compact navigation/editor/run-inspector layout inspired by AgentsRoom's official desktop interface, with warm accents and a bottom connection status strip. The header's 界面主题 selector provides dark/light/system modes, persisted locally. Desktop/tablet/narrow layouts and actual task/configuration behavior have browser acceptance evidence in the verification report.

Open `http://127.0.0.1:5173/#settings` or choose 配置中心 in the navigation. Settings v2 separates up to 8 providers, 16 accounts and 64 manually maintained models. Providers define protocol/transport/endpoint; accounts hold environment-variable credential references; models hold external IDs, display names, declared capabilities and favourites. Search and favourite filtering are available. Default routes bind provider/account/model together; all external selections remain drafts and actual image generation stays local mock SVG.

Configuration metadata lives in the API data directory's `settings.json` and uses revision conflict checks. Legacy single-connection settings are converted in memory without changing the original file until successful save. The UI accepts a credential variable **name**, never a raw key; values are injected into the API process environment and never returned or stored in configuration metadata. Presence and manual capability declarations do not verify supplier access. Updated output-count defaults apply when returning to the creation view. Unsaved edits warn before exit; deletion confirms dependent account/model/route removal, and affected image bindings return to mock SVG.

## Role library

Open `http://127.0.0.1:5173/#roles` or choose 代理角色. Seven read-only built-ins can be copied into custom drafts. Custom roles support name/category/description, system prompt, input/output descriptions, intended tool permissions, inherited or explicit model bindings, declared execution limits, immutable revision history and archive. Saving does not run a model or grant a tool permission.

Role records are stored separately in `roles.json` with atomic writes and optimistic library revision checks. Removed model/account references remain in the role and are marked unavailable. Archived roles retain history and count toward the local64-custom-role limit; there is no destructive delete or runtime in this milestone. Changing immutable built-in seed definitions in code will require an explicit stored-data migration/revision strategy rather than silently rewriting published templates.

The backend failure demonstration uses `[mock:fail-once]` in the prompt: the generation node fails once, then a retry preserves already successful nodes. Both direct backend tests and actual browser integration verified this behavior.

Production authentication, billing, real media generation, video editing and isolated coding execution are outside the first milestone.

## Delivery contracts

- [Implementation brief](docs/implementation-brief.md): ownership, API and acceptance requirements.
- [Scenario specifications](docs/scenarios.md): first workflow and expansion boundaries.
- [Architecture](docs/architecture.md): runtime and data boundaries, including future production requirements.
- [Acceptance checklist](docs/acceptance.md): verification steps, not a completed test report.
- [Roadmap](docs/roadmap.md): milestone gates and production gaps.
- [Integration decisions](docs/integration-decisions.md): first-slice retry/cancel policy and deferred contract changes.
- [Model access design](docs/model-access-design.md): proposed provider/account/model configuration inspired by AgentsRoom, separate from current implementation.
- [Settings v2 contract](docs/settings-v2-contract.md) and [acceptance requirements](docs/settings-v2-acceptance.md): implemented provider/account/model separation and legacy migration; observed checks are recorded separately.
- [Agent role design](docs/agent-roles-design.md) and [future acceptance requirements](docs/agent-roles-acceptance.md): role templates, instances, permissions and handoff architecture; agent runtime is not implemented.
- [Role library contract](docs/role-library-contract.md) and [metadata acceptance](docs/role-library-acceptance.md): implemented versioned role templates/editor; agent execution remains future work.
- [Verification evidence](docs/verification.md): observed results and remaining acceptance.
- [Interface style](docs/interface-style.md): implemented appearance direction, themes and scoped verification.
- [Langflow integration contract](docs/langflow-integration-contract.md): native connection, flow listing, execution receipts and authentication boundaries.
- [Workflow configuration contract](docs/workflow-configuration-contract.md): retained legacy React Flow/parameter-driven mock experiment, superseded as the primary workflow entry.

Native Langflow and the existing Studio regressions passed. The original brand-assets template still emits1024 x1024 mock SVG; the legacy configurable mock supports size/count parameters. Neither is real AI image generation or a media-processing/export pipeline.
