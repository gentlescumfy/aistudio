# Settings v2 implementation contract

Scope: ship provider/account/model configuration and legacy metadata migration. No external model execution, credential-value storage, CLI login or catalogue discovery is enabled in this milestone.

## Ownership

- Backend role owns `apps/api/`: schema, migration, storage/API/OpenAPI and meaningful tests.
- Frontend role owns `apps/web/`: types, request validation, configuration interface and focused tests.
- Coordinator owns root scripts, `tests/e2e/`, docs and integration verification. Do not edit another owner's files. No additional agents, QA delegation, commits, pushes or shell background services.

## GET /api/settings response

```ts
type Protocol = 'openai-compatible' | 'anthropic' | 'google';
type Capability = 'text' | 'code' | 'image' | 'video' | 'audio';
type Provider = { id: string; name: string; transport: 'api' | 'local'; protocol: Protocol; baseUrl: string };
type Account = { id: string; providerId: string; label: string; secretEnv: string; enabled: boolean };
type Model = { id: string; accountId: string; externalId: string; name: string; capabilities: Capability[]; pinned: boolean };
type Binding = { providerId: string; accountId: string; modelId: string };
type Settings = {
  defaultCount: number;
  providers: Provider[];
  accounts: Account[];
  models: Model[];
  routes: { text: Binding | null; image: 'mock-svg' | Binding; video: Binding | null };
};
type Response = {
  schemaVersion: 2;
  revision: number;
  settings: Settings;
  runtime: { mode: 'mock'; activeImageModel: 'mock-svg'; externalProvidersEnabled: false };
  credentials: { accountId: string; configured: boolean }[];
};
```

## Save and migration

POST `/api/settings` accepts `{schemaVersion:2, revision, settings}`. Use existing optimistic concurrency (stale revision 409) and atomic writes/fail-closed storage. GET always returns v2. For compatibility, also accept the previous `{revision,settings}` shape where each provider contains `model` and `secretEnv` and routes are legacy provider IDs; convert it to v2 before persisting. OpenAPI must describe both accepted bodies without failing on transform schemas.

On load of a legacy persisted file, map each former connection to one provider, one account and one model. Preserve label, endpoint, protocol, model ID, secret environment reference, routes, default count and revision. Account/model IDs must be deterministic, collision-free for valid legacy IDs, and <=64 characters (e.g. prefix + hash). Infer declared draft model capabilities from the old routes: text selection -> text/code, video selection -> video; otherwise text. These declarations are user intent, never verified provider abilities. Keep the legacy file untouched until a user saves; do not automatically overwrite the only original copy. Reject malformed or unknown schema versions without replacing data.

Existing default empty config becomes v2 with empty provider/account/model arrays and mock image route.

## Validation

- IDs use existing lowercase slug rules; each collection has unique IDs.
- Maximums: 8 providers, 16 accounts, 64 models, default count 1–8.
- Provider name and account label/model display name: trimmed, nonempty, max80; external model ID max160.
- HTTPS or loopback HTTP endpoints only; no URL credentials, query or fragment. `local` transport requires loopback hostname.
- Protocol is a declared draft, not a verified connection. API/local modes are supported metadata; coding CLI remains unavailable.
- Accounts must reference a provider, models an account; externalId must be unique per account.
- secretEnv uses existing optional uppercase environment-variable-name rule. Reject raw keys/unknown fields.
- Model capabilities are nonempty, unique declared capability values. Each binding must resolve to the same provider/account/model ownership chain, an enabled account, and matching declared capability (`text` route allows text or code).
- Credential status returns account IDs and presence only. Never return/persist key values, never call a provider on save.
- Settings save may use a route-specific request body limit of 128KiB; other routes retain 16KiB.

## Frontend

Reorganize around provider panels, nested account profiles and per-account models. Adding accounts or models is distinct from adding a provider. Support manual model IDs, capability choices, search and pinned models. No fake refresh/connection/login controls: say the catalogue is manually configured and unverified. Show clear mock runtime and draft labels, and credential presence separately from supplier authentication.

Default routing selects full binding, displaying provider/account/model and source (workspace default); image can remain mock or select a draft binding but actual runtime stays mock. Node/project override controls wait for future workflow infrastructure. Delete cascades may remove dependent unsaved draft metadata and clear affected bindings, with explicit confirmation for referenced entities. Preserve revision conflict handling, dirty-navigation protection, loading/error states, responsiveness and active defaultCount behavior.

Deliver files, tests/build results and known limitations to coordinator via AgentsRoom mailbox. Freeze files after handoff. Root end-to-end tests will be updated for v2 by coordinator.
