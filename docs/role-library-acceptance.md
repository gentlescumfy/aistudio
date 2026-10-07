# Role library metadata acceptance

Status: implemented metadata milestone, with observed API/web/browser evidence in `docs/verification.md`. These requirements concern role definitions, not agent execution.

## API and persistence

- GET exposes seven stable read-only built-ins, known tool declarations with executable:false and runtime enabled:false.
- Create a custom draft with valid persona/contracts/model selection/budget; first role revision is1 and library revision increments only after persistence.
- Edit the draft with the current library revision, then restart; verify original and updated immutable revisions survive in order.
- Archive a custom draft; keep history and reject edits to archived/built-in roles. Unknown IDs404, stale writes409.
- Race two writes using one library revision; only one succeeds. Storage write failure must not return success and must fail health/future writes closed.
- Corrupt or unsupported roles.json refuses startup without discarding data.
- Reject unknown tools, duplicate tool declarations, raw credential properties, out-of-range budgets and unknown fields.
- Explicit model selection must match the provider/account/model chain, enabled account and declared text/code capability. After configuration removal, retain selection and expose unavailable; never substitute an account silently.

## Actual browser scenarios

1. Navigate through the new 代理角色 link and directly via /#roles; verify the metadata-only execution notice.
2. Search/filter built-ins, open a template, verify editor read-only, copy to a new custom draft and save.
3. Edit persona/contracts and intended tools, configure inherit or a full draft model binding, save and reload.
4. Inspect revision history to confirm retained earlier persona/contracts.
5. Confirm archive and verify active filtering hides the archived role while archived/history views preserve it.
6. Cancel archive/unsaved-navigation confirmation; changes and page state remain intact. Check409 keeps edits and offers explicit reload.
7. Check populated role editor at320px and desktop light/dark themes; required labels, controls and save actions stay visible and keyboard-operable.
8. Regression: generation, settings, theme selection and task inspector behavior still work.

## Handoff evidence

Coordinator records actual API/web test counts, builds, browser results and limitations in docs/verification.md. Agent instance creation, published custom execution, real tool authorization, model calls and team workflows remain unimplemented unless a later milestone explicitly supplies them.
