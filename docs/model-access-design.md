# Model access design inspired by AgentsRoom

Status: provider/account/model configuration and legacy migration implemented under `docs/settings-v2-contract.md`, with API/frontend/browser verification recorded in `docs/verification.md`. External execution remains disabled. Later workflow bindings and CLI executors described here are still proposed.

## Verified reference behavior

AgentsRoom's product knowledge base describes provider-specific panels, separately managed account profiles, model pickers derived from supported CLI catalogues, manual model selection where supported, pinned/recent model lists, and global/project/agent defaults. Account selection is restricted to the chosen provider. Environment variables merge at provider, project and agent levels, with credential references resolved at launch. CLI accounts use local sign-in and isolated directories; a credential reference is not itself a credential or an authenticated session.

These are useful configuration and execution-boundary patterns. The exact source product is an orchestration shell for installed coding CLIs, whereas AI Studio's media generation requires server-side APIs. CLI subscription access must not be assumed to grant API access or image/video capabilities.

## Target domain boundaries

| Entity | Responsibility | Example fields |
| --- | --- | --- |
| Provider | Adapter protocol, transport and supported operations | id, name, transport, adapterKey, endpointPolicy |
| Account | One provider's credential/profile and usage boundary | id, providerId, label, credentialRef, enabled |
| Model | Account-accessible model and verified capabilities | id, providerId, accountId, externalId, capabilities, provenance |
| Binding | Default or overridden selection for a workload | providerId, accountId, modelId, parameters, sourceScope |
| Run snapshot | Immutable resolved execution choice | binding, adapterVersion, credentialRefVersion, policyRevision |

The current `providers[]` entries combine a connection, credential variable and a single model. They remain valid as v1 connection drafts until a migration exists. Do not silently reinterpret them as fully authenticated provider accounts.

## Connection modes

- API: server-side adapter for hosted text/image/video/audio services. Credential storage is separate from metadata. Catalogue discovery is provider-specific, and a successful catalogue read does not prove generation access.
- Local service: loopback/private inference endpoint with explicit network policy and health/capability validation.
- Coding CLI: a future isolated executor for coding SOPs. Official login happens in the execution environment, account profiles are isolated, and commands are allowlisted. This transport is separate from media APIs and is currently unavailable.

Only transports with implemented and verified adapters can be enabled. Draft forms and imported catalogues must retain their unverified state.

## Configuration interface

1. Choose a provider or custom gateway from a provider panel.
2. Select/add an account belonging to that provider; display credential and validation status separately.
3. Select an accessible model, with capability filters, search, favourites and recent choices. Support manual IDs as unverified entries when discovery is unavailable.
4. Choose global/workspace defaults; template/node selections can inherit or explicitly override them when workflow configuration supports it.
5. Show the resolved provider/account/model and configuration source before starting a run.

Proposed inheritance: workspace default -> template override -> node override -> permitted per-run override, with explicit inherit/reset controls. The present app has one local workspace; multi-tenant/global scope must wait for authentication and authorization.

## Validation and lifecycle

- Separate configured credential, authenticated account, discovered model and callable capability states.
- Refresh catalogues without discarding the previous catalogue on network failure; record freshness and provenance.
- Validate provider/account/model membership and operation compatibility server-side.
- Connection tests must state whether they only read metadata or make a billable request. No automatic generation during configuration save.
- Snapshot the resolved selection before a run starts. Changing defaults affects future runs, never a running or historical task.
- Deleting a referenced account/model must not silently switch historical retries. Block new calls or require explicit re-binding while preserving audit data.
- Keep credential values out of ordinary metadata, logs, prompts and returned settings. A desktop can use an OS vault; a hosted service needs a server-side encrypted secret manager and authorization.

## Delivery order

1. Introduce the provider/account/model domain and a backward-compatible v1 draft migration, preserving revision conflict checks.
2. Reorganize the configuration UI around those entities with truthful capability/status labels.
3. Implement and verify one actual API adapter and explicit connection/catalogue validation. The read-only AgnesAI `/v1/models` credential check is implemented; generation adapters remain future work.
4. Add workflow-level binding overrides and execution snapshots.
5. Add coding CLI execution only after sandbox/profile isolation is implemented.

Existing local mock generation stays available throughout migration. Current default count and saved connection drafts remain functional. No actual AgentsRoom account, setting, credential or internal configuration is imported or modified.
