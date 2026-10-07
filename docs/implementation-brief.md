# AI Studio implementation brief

## Objective

Build a runnable first vertical slice for brand asset generation: choose a template, provide a prompt and output count, start a run, inspect node status and generated assets, and retry failed work. Keep image, video and coding template categories visible. Real provider integration follows a clearly labeled mock demonstration, never presented as actual AI generation.

## Ownership

- Coordinator: root configuration, integration, scenario templates and verification.
- Architect: `docs/architecture.md`, `docs/acceptance.md`, and `docs/roadmap.md` only. Review contracts and record implementation risks; do not edit application source.
- Frontend: `apps/web/` only. React + TypeScript + Vite, responsive and accessible studio interface.
- Backend: `apps/api/` only. Node.js + TypeScript API, provider abstraction, persistent run state and tests.
- Do not modify another owner's files, app-managed configuration, or initialize/commit/push Git. Do not launch a background process through a shell. Do not delegate QA or spawn more agents.

## Initial API contract

API base URL is configurable; development default is `http://localhost:4000`. Return JSON. Errors use `{ "error": { "code": "...", "message": "..." } }` with appropriate HTTP status.

- `GET /api/health`: `{ status: "ok", mode: "mock" }`.
- `GET /api/templates`: `{ templates: Template[] }`.
- `POST /api/runs`: body `{ templateId, inputs: { prompt, count }, idempotencyKey }`; response `{ run: Run }`, status 201 for new runs and 200 for replayed submissions.
- `GET /api/runs`: `{ runs: Run[] }`.
- `GET /api/runs/:id`: `{ run: Run }`.
- `POST /api/runs/:id/retry`: retry failed work only, response `{ run: Run }`.
- `POST /api/runs/:id/cancel`: stop scheduling subsequent work, response `{ run: Run }`.

Template fields: `id`, `name`, `description`, `category` (`image`, `video`, `coding`), `enabled`, `nodes` (array of `{ id, name, kind }`). Only the brand image template needs to execute in this slice; other templates are visibly marked coming soon.

Run fields: `id`, `templateId`, `status` (`queued`, `running`, `succeeded`, `failed`, `cancelled`), `inputs`, `createdAt`, `updatedAt`, `mode` (`mock`), `nodes`, `assets`, `estimatedCost`, `actualCost`, optional `error`.

Run node fields: `id`, `name`, `kind`, `status` (`pending`, `running`, `succeeded`, `failed`, `cancelled`), `attempts`, optional `error`.

Asset fields: `id`, `runId`, `nodeId`, `name`, `mimeType`, `url`, `width`, `height`, `mode` (`mock`). Provide clearly labeled local deterministic demo assets and downloadable output; never use a paid external service or require credentials for this slice. Costs for mocks are zero and must be labeled as such.

Inputs: trim prompt, require nonempty value with a maximum of 2000 characters; require integer count from 1 to 8. Unknown templates return 404; disabled templates return 409. Reusing an idempotency key with different input returns 409.

## Backend behavior

Persist submissions before execution and persist transitions. On restart reconcile pending work; local mock execution may safely resume. Model real paid calls separately: a timeout with unknown provider outcome must not automatically submit again. Avoid claims of exactly-once external effects. Protect file serving paths, restrict CORS to configured frontend origins, bind local development only, and do not expose arbitrary shell or API execution.

## Frontend behavior

Provide template selection, prompt/count form, workflow node visualization, run history, progress and asset gallery. Poll active runs with cleanup, show meaningful empty/loading/error states, allow retry/cancel when applicable, and keep mock execution labeling visible. Do not turn controls into decorative no-ops. Display disabled future features explicitly.

## Definition of done

Each role delivers files, setup commands, verification results and limitations. Verify input validation, duplicate submission handling, run transitions, restart persistence, retry/cancel behavior, and frontend build. Use regular tests directly; no QA agent was requested. Report partial implementations honestly. Production authentication, billing, GPU scheduling, real media providers, video editing and coding sandboxes are deferred, not implied to exist.
