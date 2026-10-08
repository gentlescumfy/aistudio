# Agent role acceptance requirements

Status: broader agent-platform checklist; this is not a pass report. AI Studio currently implements only single-turn text calls from published workflow prompt nodes. The remaining checks for instances, tools, durable conversations, authorization, gates and team orchestration are future work.

## Definition and versioning

- Publishing freezes prompt, skills, input/output contracts, permissions and role revision.
- Editing a published template creates a new revision; existing instances/runs do not change silently.
- Creating an instance from a role does not copy credentials or execution history.
- Retiring a referenced role does not delete historical evidence.

## Resolution and authorization

- Show resolved provider/account/model and configuration source before launch; reject mismatched/disabled references.
- Snapshot role/model/policy/budget before execution; changing workspace defaults has no effect on active runs.
- Validate adapter operations independently of manually declared model capabilities.
- A reviewer cannot write, merge or deploy, even if prompted by a user artifact or another agent.
- Instance restrictions can narrow permissions but cannot enlarge the workspace/user/role authority.
- Tool denial cannot be bypassed by arbitrary shell, URL or dynamic code execution.
- Resource and tenant checks apply at operation commit time. Credential values never appear in metadata, prompts or handoff.

## Agent and tool execution

- Long model/render jobs have durable attempt IDs, independent from the agent conversation.
- Unknown provider outcome blocks resubmission pending reconciliation.
- Cancellation prevents subsequent tool dispatch and late results do not restore cancelled state.
- Prompt injection in assets/tool responses cannot add tools, alter policy or expand budgets.
- Tool call, step, retry, cost and deadline limits stop runaway execution.

## Handoff and gates

- Reject malformed/unknown handoff states; validate referenced assets/revisions.
- Conditional edges consume declared schema fields; missing/conflicting results are visible blockers.
- A model's claimed success cannot override failed deterministic checks or missing approval.
- Human approvals are bound to the reviewed inputs and artifact revisions; changes invalidate approval.
- Feedback loops terminate at their configured cycle limit.
- Parallel writers have isolated writable scopes or a designated merge owner.

## Scenario evidence

- Media demonstration: script, storyboard, continuity review and editing use stable scene/shot/asset IDs and selective correction; publication waits for human approval.
- Coding demonstration: plan, sandbox implementation and read-only review use an isolated repository snapshot; only a draft PR is produced without separately configured merge/deploy authority.
- Each runtime scenario records role/template revision, resolved model/account, tool attempts, artifacts and trusted verification evidence.

## Current project boundary

The current runtime snapshots a role, calls one OpenAI-compatible chat completion for each explicitly enabled prompt node, stores the returned text and passes it downstream. Tool declarations are never executed, and execution limits other than deadline are not enforced. Image nodes remain local mock SVG. Missing route/credential is rejected before a run is persisted. Live provider generation remains unverified until a valid model route and API-process credential are configured. Agent instances, reasoning loops, authorized tools, CLI login/sandbox, team execution and production tenant/auth boundaries remain unimplemented.
