# AI Studio

A visual orchestration studio for reusable image, video and coding workflows.

## Current milestone

The local Studio integrates real Langflow1.12.5 for native visual editing and API execution, alongside versioned model settings, role metadata and explicitly labeled mock brand assets. Workflow canvas prompt nodes can make a bounded, single-turn OpenAI-compatible text call and hand the result to the next node. The coffee-launch path is implemented, but its live model call is not verified yet: AgnesAI provider/account/model metadata and the default text route are saved, while the API process lacks its secret environment variable; a minimal request with the available agent-shell key returned AgnesAI HTTP 401. Production deployment remains outside this delivery.

The application has three independently managed services:

- `apps/web`: React and TypeScript studio interface.
- `apps/api`: TypeScript API and persistent local execution.
- `services/langflow`: isolated Python3.12/uv environment, pinned Langflow editor/API.

Root scripts forward to each application's package scripts. With Node.js22 or later, install dependencies using `npm run setup`, build with `npm run build`, and run direct developer tests with `npm test`. Latest verification passed55 API tests/typecheck/build,48 web tests/build and16 actual-browser scenarios on Node.js25.9.0. Frontend Vitest is4.1.11 and its npm audit reports zero vulnerabilities. Node.js22 compatibility and a full accessibility audit remain unverified; see the verification evidence below.

Development commands are `npm run dev:api` and `npm run dev:web`; use the AgentsRoom Dev Commands panel to manage their long-running terminals. The API defaults to port 4000 and the web interface to port 5173. Frontend assets returned as relative paths are resolved against the configured API base URL.

The saved commands are named `AI Studio API` and `AI Studio 工作台`. The local workbench is available at `http://127.0.0.1:5173` while those commands are running. To repeat browser checks, install Chromium once with `npx playwright install chromium`, then run `npm run test:e2e` with API, Web and Langflow running. The suite creates persistent local demonstration records and uses its own browser profile.

## Native Langflow workflows

Open `http://127.0.0.1:5173/#workflows` for the separately managed native Langflow workspace. It exposes connection configuration/status, native flow metadata, a new-tab editor link, explicit execution and persistent results/history. The real native editor runs at `http://127.0.0.1:7860`; it is not an embedded React Flow imitation. The primary AI Studio workflow builder is the canvas at `/#workflow-canvas`.

Install/start the independent service through AgentsRoom Dev Commands using [the service instructions](services/langflow/README.md). The current profile explicitly enables automatic login on loopback for local development only. API credentials, when needed, use server-side environment-variable references, not raw keys in browser configuration. The base package has no curated provider extensions; install required components separately before using provider-specific flows.

The adapter lists metadata only, persists receipts before dispatch and supports idempotent replay/conflict detection. Interrupted running requests become `outcome_unknown` and are not automatically resubmitted. Native node-level resume/cancel, immutable external graph publication and production authentication are not claimed. Studio role/model metadata is not automatically injected into Langflow nodes.

`node scripts/langflow-echo.mjs --verify` provisions/verifies the owned, locked two-node ChatInput → ChatOutput fixture without model calls. The React Flow canvas owns AI Studio's versioned coffee-launch workflow and the run history/asset handoff described below; Langflow remains a distinct native workspace.

## Configuration

The workspace uses a compact navigation/editor/run-inspector layout inspired by AgentsRoom's official desktop interface, with warm accents and a bottom connection status strip. The header's 界面主题 selector provides dark/light/system modes, persisted locally. Desktop/tablet/narrow layouts and actual task/configuration behavior have browser acceptance evidence in the verification report.

Open `http://127.0.0.1:5173/#settings` or choose **配置与工作流 → 配置中心**. Settings v2 separates up to 8 providers, 16 accounts and 64 manually maintained models. Providers define protocol/transport/endpoint; accounts hold environment-variable credential references; models hold external IDs, display names, declared capabilities and favourites. Search and favourite filtering are available. The default text route binds provider/account/model together and is used by roles set to inherit; a role may bind a specific text model in **代理角色**. In the **工作流画布**, prompt nodes invoke the selected role only when set to **调用代理**. Image generation stays local mock SVG.

Configuration metadata lives in the API data directory's `settings.json` and uses revision conflict checks. Legacy single-connection settings are converted in memory without changing the original file until successful save. The UI accepts a credential variable **name**, never a raw key; the API reads that variable from its own process environment. The UI does not inject it into the API. Presence and manual capability declarations do not verify supplier access. Updated output-count defaults apply when returning to the creation view. Unsaved edits warn before exit; deletion confirms dependent account/model/route removal, and affected image bindings return to mock SVG.

## Role library

Open `http://127.0.0.1:5173/#roles` or choose 代理角色. Seven read-only built-ins can be copied into custom drafts. Custom roles support name/category/description, system prompt, input/output descriptions, intended tool permissions, inherited or explicit model bindings, declared execution limits, immutable revision history and archive. Saving does not run a model or grant a tool permission.

Role records are stored separately in `roles.json` with atomic writes and optimistic library revision checks. Removed model/account references remain in the role and are marked unavailable. Archived roles retain history and count toward the local64-custom-role limit; there is no destructive delete. Workflow agent nodes make a single bounded text call and persist the response for downstream handoff. Tool declarations, multi-turn runs, budget enforcement, model cost reporting and image-model execution are not implemented. Changing immutable built-in seed definitions in code will require an explicit stored-data migration/revision strategy rather than silently rewriting published templates.

The backend failure demonstration uses `[mock:fail-once]` in the prompt: the generation node fails once, then a retry preserves already successful nodes. Both direct backend tests and actual browser integration verified this behavior.

Production authentication, billing, real media generation, video editing and isolated coding execution are outside the first milestone.

## Delivery contracts

- [Implementation brief](docs/implementation-brief.md): ownership, API and acceptance requirements.
- [Scenario specifications](docs/scenarios.md): first workflow and expansion boundaries.
- [Architecture](docs/architecture.md): runtime and data boundaries, including future production requirements.
- [Acceptance checklist](docs/acceptance.md): verification steps, not a completed test report.
- [Roadmap](docs/roadmap.md): milestone gates and production gaps.
- [Integration decisions](docs/integration-decisions.md): first-slice retry/cancel policy and deferred contract changes.
- [Model access design](docs/model-access-design.md): provider/account/model foundations and remaining access work.
- [Settings v2 contract](docs/settings-v2-contract.md) and [acceptance requirements](docs/settings-v2-acceptance.md): provider/account/model routes, legacy migration and text-agent configuration boundary.
- [Agent role design](docs/agent-roles-design.md) and [acceptance requirements](docs/agent-roles-acceptance.md): implemented single-turn workflow text adapter plus remaining instance, tool and orchestration design.
- [Role library contract](docs/role-library-contract.md) and [acceptance](docs/role-library-acceptance.md): versioned role templates/editor and single-turn text invocation boundary.
- [Verification evidence](docs/verification.md): observed results and remaining acceptance.
- [Interface style](docs/interface-style.md): implemented appearance direction, themes and scoped verification.
- [Langflow integration contract](docs/langflow-integration-contract.md): native connection, flow listing, execution receipts and authentication boundaries.
- [Workflow configuration contract](docs/workflow-configuration-contract.md): React Flow canvas contracts, mixed text-agent/local-SVG execution and immutable handoff snapshots.

Native Langflow and existing Studio regressions passed as recorded in `docs/verification.md`. The coffee-launch workflow is implemented to call three text roles when the API has a valid route and credential; the development settings contain the AgnesAI route, but live generation is not verified until the API process has a valid `AGNES_API_KEY`. A minimal request with the prior agent-shell credential returned HTTP 401, so the full workflow is not live-verified. Image steps still emit 1024 × 1024 mock SVG, not AI-generated images or a media-processing/export pipeline.
