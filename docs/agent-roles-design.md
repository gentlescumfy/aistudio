# Agent role architecture

Status: the role library remains the source of versioned personas and model bindings. The workflow canvas now supports an explicitly enabled, single-turn OpenAI-compatible text call for a role snapshot, and passes the model response to the next node. This is an initial text-only runtime slice, not a general agent platform: tools, instances, memory, loops, branching, team orchestration, usage accounting and image-model execution remain unimplemented. See `docs/scenarios.md` for the real coffee-launch handoff and `docs/verification.md` for the current live configuration blocker.

## Verified inspiration and adaptation

AgentsRoom's product knowledge base describes built-in/custom role personas, reusable full agent templates, project instances and team steps with instructions, skills and structured handoff. A role can be assigned different providers/models. Teams support conditional routing, bounded feedback and human waiting steps.

AI Studio adopts the separation between role definition, instance configuration and actual execution. It must implement server-enforced tool policy and durable media tasks separately; importing a persona alone does not create permissions, a sandbox or generation capabilities. No AgentsRoom credentials, templates or internal configuration are copied automatically.

## Four separate objects

| Object | Purpose | Lifetime |
| --- | --- | --- |
| RoleTemplate | Reusable responsibility and versioned operating contract | Draft -> immutable published revision -> retired |
| AgentInstance | Workspace-specific instance of a selected role revision | Configurable while idle; revisions snapshotted at run start |
| AgentStep | Workflow placement with instructions and typed inputs/outputs | Part of a versioned workflow definition |
| AgentRun | One execution with messages, tool attempts, artifacts and usage | Durable execution record; never stored inside the template |

Suggested logical models:

```ts
type RoleTemplate = {
  id: string;
  revision: number;
  name: string;
  category: 'media' | 'engineering' | 'operations' | 'custom';
  description: string;
  lifecycle: 'draft' | 'published' | 'retired';
  systemPrompt: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  skills: { id: string; revision: number }[];
  toolPolicy: ToolPolicy;
  defaultModel: { kind: 'inherit' } | { kind: 'binding'; binding: ModelBinding };
  limits: { maxSteps: number; maxToolCalls: number; maxCost: number; deadlineMs: number };
};

type AgentInstance = {
  id: string;
  workspaceId: string;
  name: string;
  roleRef: { id: string; revision: number };
  extraInstructions: string;
  modelSelection: { kind: 'inherit' } | { kind: 'binding'; binding: ModelBinding };
  policyRestriction: ToolPolicyRestriction;
  enabled: boolean;
};

type AgentStep = {
  id: string;
  agentInstanceId: string;
  instructions: string;
  inputMapping: TypedMapping;
  expectedOutputs: JsonSchema;
  completionGate: GateDefinition;
  retryLimit: number;
};
```

These types are proposed domain contracts, not existing exported interfaces. `ModelBinding` uses settings v2's providerId/accountId/modelId ownership chain. Instances/templates do not hold credential values or mutable execution messages.

## Model resolution and snapshots

For an inheriting selection, resolve permitted settings in this order: explicit per-run override -> workflow step -> agent instance -> role default -> workspace capability route. Every selection must remain consistent with the chosen account, adapter and required capability. Display the resolved provider/account/model and its source before starting.

At launch persist an immutable snapshot of role revision, prompt, skills revisions, workflow inputs, resolved model/adapter, credential reference/version, tool policy and budget. Changing defaults or publishing a new role affects future launches only. A missing/disabled referenced account fails with an explicit configuration error; do not silently substitute another wallet for historical retry.

Current settings model capabilities are manual declarations. The text adapter independently checks the provider/account/model chain, OpenAI-compatible protocol and API-process credential before accepting a run. A catalogue check does not prove generation access; a successful provider call is the only current proof that this endpoint/model accepts generation requests.

## Role responsibilities and initial library

| Role | Inputs | Outputs | Typical permitted tools |
| --- | --- | --- | --- |
| Scriptwriter | Creative brief, duration, audience | Structured script with scene/dialogue IDs | Approved context retrieval, draft asset writes |
| Storyboard director | Approved script, role/scene assets | Shot plan, camera descriptions, duration allocation | Read assets, submit storyboard/image tool jobs within budget |
| Character continuity reviewer | Character references and selected shots | Findings tied to shot IDs, bounded correction requests | Read images/references, quality analysis; no publication |
| Editor/reviewer | Approved clips, dialogue timing, audio assets | Timeline instructions, export checks | Submit approved render/validation jobs; final release approval gate |
| Architect | Requirements and repository metadata | Technical plan and interface contracts | Read repository/context, write plan artifacts |
| Developer | Approved plan, isolated repository snapshot | Patch and test evidence | Sandbox edits and bounded test commands |
| Code reviewer | Patch, policy and test outputs | Structured findings and review verdict | Read code, approved static analysis; no merge/deploy |

Role-specific tools start from an explicit allowlist. Custom personas cannot add tools merely by requesting them. Actual code execution needs a separate sandbox milestone; the developer role is unavailable until that exists.

## Agent steps versus tool steps

Agent steps interpret goals, create plans and request approved operations. Deterministic tool steps perform model generation, file upload, render/transcode, repository checks and other long tasks through typed adapters. A video job belongs to the durable task engine; an agent must not hold a web request open or repeatedly regenerate while waiting.

Each tool request has an operation key, bounded typed parameters, asset references and a persistent attempt record. Unknown external outcomes require reconciliation, not blind resubmission. Agents consume tool results as untrusted data and cannot derive additional permissions from a response or prompt.

## Server-enforced authorization

Effective permission is the intersection of workspace/user authority, role allowlist, instance restrictions, workflow policy and any explicit approval. Role text and skills can explain policy but do not enforce it. Checks occur when a tool is committed, not only when a plan is generated.

Tool policies identify operation IDs, resource scopes, network destinations, write restrictions, quotas and approval requirements. Resource ownership is checked on every read/write. Credential injection happens within the authorized executor; secret values never enter prompts, handoff or normal metadata.

Publishing assets, changing external repositories, merging and deploying need explicit configured authority/approval. Read-only reviewers cannot become writers because another agent asks. A refused tool request returns a typed denial and cannot be bypassed through an arbitrary API/shell node.

## Structured handoff and bounded coordination

```ts
type Handoff = {
  schemaVersion: 1;
  fromStepId: string;
  result: 'completed' | 'needs_revision' | 'failed' | 'needs_human';
  summary: string;
  artifactRefs: { id: string; revision: number }[];
  findings: { severity: string; artifactId: string; message: string }[];
  evidenceRefs: string[];
  requestedChanges: { artifactId: string; instruction: string }[];
};
```

Validate this payload before advancing. Model assertions are not verification evidence: tests/render checks/approvals produce their own trusted gate results. Routing uses declared enums and typed flags; missing or conflicting results park the run with an explicit error instead of guessing a next step.

A media example: script -> approval -> storyboard -> generation tools -> continuity review -> bounded shot correction -> timeline/export tools -> human release gate. A coding example: plan -> approval -> sandbox implementation -> deterministic checks -> code review -> bounded revision -> draft PR -> human merge/deploy gate.

Enforce graph validation, per-node retry limits, overall cycle budget, cost cap, deadline and concurrency limit. Parallel steps must have separate writable scopes or explicit merge ownership. A human gate persists its input and approval revision; changed inputs invalidate prior approval. Define failure/cancellation and partial-artifact handling for every step.

## Suggested APIs and interface

- Role library: list/search/filter built-in and custom templates; create draft, validate, publish new immutable revision, archive.
- Agent instances: create from a template snapshot, choose model/inherit, restrict tools, inspect resolved policy and source.
- Workflow agent node: choose an instance, map inputs, define output contract and verification/approval gates.
- Runtime panel: actual role revision, model/account, step status, tool attempts, assets, usage and blockers.

The current role library has `/api/roles` and `/api/roles/:id/revisions`; workflow runs use `/api/runs` and snapshot the published workflow plus its role and text-model target. Dedicated agent instances, resumable conversations and `/api/agent-runs` are still proposed, not implemented. Authorization and stable revision contracts must precede adding tools or multi-turn APIs.

## Delivery phases

1. Read-only role catalogue and versioned draft editor, with explicit no-tool status; metadata does not grant runtime permissions. (Implemented.)
2. Agent instances and resolved model bindings with mock agent runs and schema-validated handoff. (Not implemented.)
3. One real text adapter for single-turn workflow nodes, with bounded timeout, durable receipts and unknown-outcome protection. (Initial text-only path implemented; budget enforcement, tools and model cost reporting remain.)
4. Media generation tool integration and human gates; coding executor only after sandbox isolation.
5. Team branching, bounded feedback, parallel isolation and production authorization/tenant boundaries.

Do not add role state to the settings v2 provider/account/model schema. Maintain separate data and revisions, linked through stable bindings. Acceptance requirements are in `docs/agent-roles-acceptance.md`.
