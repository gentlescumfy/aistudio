# Integration verification evidence

## Snapshot verified on 2026-10-06

Environment: macOS, Node.js v25.9.0, npm 11.12.1. Node.js 22 is the declared minimum but has not been separately exercised in this verification.

Applications were still undergoing role-level delivery when this check ran; results describe the checked working-tree snapshot, not any subsequent changes.

| Command | Result |
| --- | --- |
| `npm test` | Exit 0: API 16/16; web 9/9 across 3 test files |
| `npm run build` | Exit 0: API TypeScript compilation and web TypeScript/Vite production build |

API tests exercised validation and JSON errors, template enablement, concurrent creation and idempotency conflict, persistence, local asset download/escaping, CORS and Host restrictions, path traversal and symlink rejection, failed-node retry, retained generation after export failure, queued/active/repeated cancellation, late completion suppression, real test-process kill/restart, queued startup recovery, uncertain-provider-outcome blocking, single-writer lock and corrupt-snapshot handling.

Web tests exercised API input/error behavior, hook behavior and UI creation/cancel/retry interactions. These use simulated HTTP responses and a DOM test environment; they do not establish real-browser/API integration, visual correctness or a complete accessibility audit.

## Frontend delivery recheck on 2026-10-06 at 23:14 UTC

After frontend delivery added asset gallery and response validation coverage, the coordinator reran only the changed application's checks: `npm --prefix apps/web test` passed 13/13 tests across 4 files; `npm --prefix apps/web run build` exited 0. The preceding API 16/16 result remains the earlier snapshot result, not a newly repeated backend check.

Known delivery limits: creation idempotency keys survive retries only within the current page lifecycle, not a reload; Vite preview at port 4173 needs a separately allowed API CORS origin. Browser integration is still untested, although an online connected Chrome browser is available. No development server was launched by this check.

## Final API delivery recheck on 2026-10-06 at 23:15 UTC

The coordinator reran the changed backend's checks after final delivery: `npm --prefix apps/api test` passed 20/20; `npm --prefix apps/api run typecheck` and `npm --prefix apps/api run build` both exited 0. The frontend remains at the separately verified 13/13 result without redundant reruns.

New coverage verifies that an uncertain provider timeout is durably blocked from retry/restart resubmission; submission persistence failure prevents any provider call and refuses further writes; background persistence failure stops scheduling and local mock work resumes after storage repair and restart; domain-validation failures roll back without poisoning valid future transactions.

Final role deliveries are received for architecture, frontend and backend. The runtime uses a single local writer and file snapshots, with fixed 1024 x 1024 SVG output. A leftover `recovery.lock` from a crash during stale-lock cleanup requires manual inspection with all writers stopped. No live browser/API verification has yet been performed.

## Browser integration verified on 2026-10-06 at 23:57 UTC

The coordinator started API4000 and Web5173 through saved AgentsRoom Dev Commands, then ran an independent Playwright Chromium browser against the actual services. No QA agent was used.

`npm run test:e2e` passed 3/3 scenarios:

- Create two assets, observe completion, load actual SVG preview, open and close the dialog with Escape, verify focus returns, download the SVG, inspect its mock watermark, reload and select persisted history.
- Trigger `[mock:fail-once]`, retry and verify attempts `[1,2,1]`, then cancel an active run and verify its persisted state.
- At 320px width, verify no document horizontal overflow and that the creation controls remain reachable.

The initial narrow-screen assertion incorrectly expected the intentionally hidden connection text to be visible. A visible connection status with an accessible name was added, and the tests now use that status. Screenshot inspection also identified banner decoration overlapping narrow-screen text; the decoration is hidden below 400px and navigation spacing adjusted. After those CSS changes the narrow-screen test passed again and the web build passed. After the accessibility change web unit/component tests passed 13/13.

Run `npx playwright install chromium` once after root dependency installation. The suite assumes both managed development servers are already running; it does not create background servers. It creates local mock history/assets in the development data directory and leaves them available for inspection. Screenshots and failure traces are written beneath ignored `test-results/`; subsequent runs replace that directory.

## Outstanding acceptance after browser integration

- Full keyboard-only navigation and accessibility audit; dialog Escape/focus return and narrow-screen layout have been checked.
- Node.js 22 compatibility if the minimum runtime is retained.
- Multi-size export: current mock provider produces 1024 x 1024 SVG output only.
- Recheck affected tests when roles make further implementation changes.

No paid provider was required. Current verification is for local mock execution only; it does not establish production authentication, tenant isolation, billing, real model capabilities or distributed execution reliability.

## Configuration delivery verified on 2026-10-07 at 00:09 UTC

The new `/#settings` page and GET/POST `/api/settings` provide persisted provider metadata, credential environment-variable references, draft text/video routes and an active default output count. Configuration saves never invoke external providers. Image execution remains mock SVG.

- API typecheck passed; all 23 API tests passed, including metadata restart persistence, concurrent/stale revision conflict, raw-key rejection, unsafe URL rejection, route-reference and duplicate-ID validation.
- Web's 13 existing tests passed; both application builds passed.
- The expanded actual-browser suite initially passed 5/5 scenarios including two configuration scenarios and the previous three studio scenarios.
- After adding unsaved-navigation protection, all three configuration browser scenarios passed: save/reload/default count, 320px layout, and dismiss/accept the unsaved-edit warning. A final combined build and API23 check also passed.
- Browser tests restore the original development configuration with a revision check after saving their demonstration draft, so a concurrent newer configuration is never overwritten by cleanup.

Raw secret entry, actual provider connection verification and real model adapters are not implemented. Only variable names and presence status are supported. The configuration page is local-only under the API's existing loopback/Origin checks; it has no production authentication.

## Settings v2 backend delivery recheck on 2026-10-07 at 01:43 UTC

Coordinator verification passed all 29 API tests, API typecheck and build. Review confirmed schemaVersion2 provider/account/model separation, account-scoped credential presence, full ownership/capability validation and 128KiB settings request limit. Legacy GET/load migrates in memory while preserving original file bytes; only a successful explicit save writes v2 and increments revision. Legacy POST is accepted; unsupported/malformed versions fail without overwriting original data.

Frontend integration is still pending delivery. Root browser tests have been updated to cover two accounts on one provider, multiple manual models, search/pins, text/image bindings and deletion fallback. Those updated tests have not yet passed against the delivered final frontend. An image-binding deletion bug discovered during review was sent to the frontend owner for correction before handoff.

Role-template/instance design is an additional architecture task and does not imply an implemented agent runtime.

## Settings v2 integrated delivery verified on 2026-10-07 at 01:46 UTC

Coordinator checks passed the delivered frontend's 22 tests and TypeScript/Vite build; backend remains at the verified 29 tests/typecheck/build. The updated actual-browser suite passed 6/6 scenarios, including two accounts under one provider, multiple models, duplicate external ID across different accounts, full text/image bindings, persisted pins, search/favourite filters, default count, unsaved-edit protection and the existing generation/download/retry/cancel flow.

Review found deletion of an image-bound account/model could produce null. The frontend owner corrected this with a type-safe mock-svg fallback and two save-level regression tests; browser verification confirmed the model deletion fallback. A subsequent targeted populated 320px check passed, with both account profiles and all three models present, and a screenshot was inspected. No document horizontal overflow was observed. API and frontend work remain frozen after handoff.

Role-template/instance, permission and structured-handoff architecture is delivered in docs/agent-roles-design.md and docs/agent-roles-acceptance.md by the coordinator. These are future execution requirements, not an implemented role management UI or agent runtime. The original architecture role did not edit new files because its original assignment limited its scope; the coordinator completed the authorized new document task directly.

## Interface refresh in progress on 2026-10-07

The coordinator inspected the official AgentsRoom real-session screenshot and appearance/layout knowledge fiches, defined docs/interface-style-brief.md and assigned the frontend visual refresh. Root appearance browser tests are prepared for dark/light/system theme persistence, OS-following resolution and narrow-screen access. These new checks have not run or passed yet; existing 6/6 evidence above predates the refresh. API and configuration schema are unchanged by this task.

## Interface refresh verified on 2026-10-07 at 02:03 UTC

Frontend delivery implements warm neutral dark/light surfaces, compact three-pane desktop layout, a real run inspector, bottom status strip and persistent dark/light/system theme. Coordinator checks passed26 frontend tests and TypeScript/Vite build. API remains unchanged at the earlier29-test verified version.

The first browser run found a stale marketing-heading test; that assertion now targets the new workspace heading. Review also found low-contrast light semantic backgrounds, a primary-button contrast of4.41:1 and old purple asset controls. The frontend corrected those tokens and controls. The following full suite passed9/9: theme persistence/settings consistency; live system-following; actual primary-button/success-label/download contrast >=4.5 in both modes; provider/account/model configuration with populated320px capture; narrow settings; unsaved navigation; creation/preview/Escape focus/download/history; retry/cancel;320px task controls.

The coordinator then fixed tablet footer row overlap (status strip row3 beneath inspector row2 under1180px) and themed native browser progress bars. Targeted browser checks for1024px tablet geometry and final button/status/download contrast passed2/2, and web build passed again. The total browser suite now contains10 scenarios, but the final run was targeted rather than a repeated full10-scenario run. Desktop light/dark and populated narrow screenshots were generated and inspected during acceptance.

Appearance preferences use localStorage key aistudio-theme, do not contain secrets, and fall back to interactive switching when storage is unavailable. A full keyboard/contrast audit and Node22-specific check remain outside this scoped verification. No real model, role runtime or API/schema change was introduced by the visual task.

## Role library verified on 2026-10-07 at 03:46 UTC

Coordinator verification passed36 API tests, API typecheck/build,31 frontend tests and frontend TypeScript/Vite build. The full expanded actual-browser suite passed13/13, including all existing appearance/settings/generation scenarios and three new role scenarios.

Role scenarios verify built-in copy, custom editing, persisted revision1/2/3 history, reload/search, confirm/cancel archive, archived filtering, dark/light and populated320px capture, dirty-navigation dismissal, manual full model binding and a removed configuration reference becoming unavailable without silent substitution. Browser test roles are archived after acceptance; their revision history remains and consumes custom-role capacity. Temporary model configuration is restored with a revision check, avoiding overwrite of a newer concurrent save.

During frontend request-controller refinement an early browser diagnostic loaded a temporary unresolved helper; the final handoff separates read/write controllers and all role scenarios finish without page errors. Two root selectors were also corrected to use the navigation link's actual accessible name and anchored form labels, avoiding accidental matching of textarea content. Frontend regression tests cover dirty refresh confirmation and preventing read controls from aborting active metadata writes.

Role data is metadata-only: tool declarations all report executable:false, runtime enabled:false. Custom drafts are not publishable/executable in this milestone; input/output contracts are descriptive text, not enforced JSON Schema. Limits, credentials, model capabilities and permissions do not imply actual service access. Immutable built-in seed contents require explicit future migration if changed. Node22, full accessibility, production tenant/auth and real execution remain unverified/unimplemented.

## Configurable workflow implementation in progress on 2026-10-07

The coordinator defined docs/workflow-configuration-contract.md and assigned the frontend/backend milestones. The frontend is to adopt @xyflow/react for the canvas, while the local persisted executor gains validated prompt/image/export graph definitions, immutable publication/run snapshots and parameter effects. Langflow/Temporal are not integrated. Root workflows browser/API scenarios are prepared for size/count, role annotation snapshots, republishing without retargeting existing runs, archived idempotent replay, invalid graph rejection and branch asset uniqueness. These new scenarios have not been executed or passed yet.

## Native Langflow integration verified on 2026-10-07 at 08:53 UTC

This section supersedes the preceding in-progress workflow status. The user requested Langflow, which is now the primary workflow workspace; the earlier configurable mock remains a separately verified legacy experiment.

Docker's daemon was unavailable, so Langflow-base1.12.5 was installed in an isolated uv/Python3.12 environment. The managed loopback service on7860 returned its healthy status/version and served its real native editor. No model credentials were added.

Observed checks: API55/55 tests plus typecheck/build; Web48/48 tests plus production build; full Playwright16/16 scenarios. Frontend Vitest4.1.11 and npm audit --audit-level=moderate report zero vulnerabilities. This is not a full audit of the Python dependency graph, accessibility or production security.

The trusted Echo fixture contains two native IO nodes and one visible connecting edge. The browser opened its native editor from Studio, executed through the real Langflow API, received the exact input back, verified persistent history/reload, idempotent replay200 and changed-input conflict409, and captured dark desktop/light320px layouts. Other model-backed starters were not executed. Native port handles were canonicalized only on the verified owned fixture, restoring the visible edge without touching other flows.

Actual1.12.5 compatibility was verified: paginated header_flows=true/get_all=false metadata listing, offset timestamps, gzip decoded response limiting to2MiB, and run JSON containing the input_request wrapper. Persistent receipts are written before native dispatch; interrupted running requests become outcome_unknown, with no automatic retry. Connection snapshots do not make externally edited native graphs immutable.

Legacy regression checks cover parameter-driven size/count, immutable publication/run and role-annotation snapshots, archived idempotent replay, invalid graphs and branch asset uniqueness. A final fix propagates each prompt node's outputPrompt to its image node, so template prefixes affect actual SVG output; backend assertions and the full suite passed afterward. Stored runs use the versioned migration/backup strategy documented in the legacy contract.

Remaining boundaries: local auto-login/skip-auth is not production authentication; native node-level cancellation/resume and immutable external graph publication are not implemented. Studio model/role metadata does not automatically execute through Langflow. Real paid providers, video/media processing and production tenant/isolation/billing still require separate implementation and acceptance.

## AgnesAI configuration validation verified on 2026-10-07 at 12:51 UTC

The settings page now has an explicit AgnesAI model-catalogue check. API validation uses only `GET /v1/models`, reads `GNESAI_API_KEY` from the API service process, applies an 8-second timeout, rejects redirects, and returns a sanitized status/model count. It never accepts a key from the browser, stores credentials or sends generation input.

- `npm test` passed API59/59 and Web49/49. New API cases cover missing credentials without a request, successful catalogue parsing, sanitized 401/network errors and the strict validation route. A component case checks success feedback and confirms no browser key field is required.
- `npm run test:e2e` passed16/16 actual-browser scenarios across appearance, Langflow, roles, settings, studio and workflows.
- `npm run build` passed both API TypeScript compilation and the Web TypeScript/Vite production build.
- Manual validation from the agent environment reached AgnesAI but received HTTP401. The local API service did not inherit the agent environment variable and reported `missing_key`; these are separate process environments. No generation request was made.

The model-catalogue check proves only read access to the catalogue. Actual model generation, provider-specific model capability verification and handing the agent's secret into the separate API service remain unimplemented.

## Single-turn text-agent integration recheck on 2026-10-07 at 23:34 UTC

The workflow canvas now has an implemented single-turn OpenAI-compatible text adapter. Agent-enabled prompt nodes use the snapshotted role prompt and model route, persist the response, and pass it to downstream prompt/image nodes. The coffee-launch example contains three real text-agent steps followed by the local SVG image/export steps. Roles can inherit the workspace text route or bind an explicit configured text model.

- Final `npm run build` passed for the API TypeScript build and Web TypeScript/Vite production build; `git diff --check` passed. This recheck did not run automated tests.
- The live API Settings v2 revision 32 contains the AgnesAI provider, account, `agnes-2.5-flash` model and default text route. The account references `AGNES_API_KEY`, but the API process reports the credential unconfigured and the read-only validation returns `missing_key`.
- `GET /api/workflows` confirmed the coffee-launch starter has five nodes, including three `executionMode: agent` text prompts followed by one local SVG image and one export step. It was created and published as `咖啡新品上市视觉全流程` for this run attempt.
- A prior agent-shell `GET /v1/models` returned 200 with 12 model IDs, while a minimal `POST /v1/chat/completions` returned HTTP 401 `Invalid token`; catalogue access is not proof of generation permission. In the current recheck neither `AGNES_API_KEY` nor the legacy `GNESAI_API_KEY` is present in the agent shell.
- Submitting the published coffee workflow returned HTTP 409 `MODEL_CREDENTIAL_MISSING` before creating a run. No provider generation request was made. The corrected variable name has not reached the running API process; set a valid `AGNES_API_KEY` there and restart the API before retrying.

This recheck confirms the initial runtime implementation and its configuration locations, not live provider acceptance. AgnesAI's official integration reference specifies the OpenAI-compatible base URL and bearer authentication; the current 401 points to credential/account access, not a need to change the API route. See the [official AgnesAI model catalog](https://github.com/AgnesAI-Labs/AgnesAI-Models/blob/main/MODEL_CATALOG.md) and [official troubleshooting guide](https://github.com/AgnesAI-Labs/AgnesAI-Models/blob/main/docs/TROUBLESHOOTING.md).
