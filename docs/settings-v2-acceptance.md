# Settings v2 integration acceptance

Status: implementation delivered and automated/browser checks recorded in `docs/verification.md`. This document remains the requirements checklist, not a claim that every future capability is implemented.

## Data migration

1. Open a legacy file containing two connections, different secret variable references, a text route and a video route. Verify v2 contains two providers/accounts/models and preserves exact endpoint/model/secret references and default count.
2. Compare original file bytes before/after GET; merely reading and converting must not overwrite the file.
3. Save with the original revision, restart, and verify persisted schemaVersion2 and the same bindings. Duplicate save with stale revision must return409 without losing other settings.
4. Unsupported schema version, dangling legacy route or corrupt JSON must refuse startup, not replace configuration with defaults.

## Ownership and capability boundaries

1. Create two accounts on one provider; add a differently named model on each account. A selected route must clearly identify provider/account/model.
2. Use a model ID with the wrong account or an account with the wrong provider; expect400 and no revision change.
3. Disable or delete an account referenced by a draft route; the UI must explicitly clear dependent bindings or block saving with an understandable error.
4. A video route can only select models declaring video. A text/code route can select text or code declarations. Declarations remain explicitly unverified.
5. Duplicate external model IDs on one account are rejected, but the same external ID on different accounts is permitted.
6. Provider and account deletion must explain dependent metadata removal, request confirmation, and preserve settings when cancelled.

## Interface behavior

1. Separate adding a provider, adding an account and adding a model; verify account credential reference is not repeated on each model.
2. Search a manual model directory, pin a model, save and reload; pin and model metadata persist.
3. Set a full default binding and defaultCount, save, reload, and return to creation; the count applies while generation remains mock.
4. Error/409 handling keeps the user's unsaved draft visible and offers explicit reload. Leaving an unsaved page warns before discarding edits.
5. At320px, adding accounts/models and saving stays reachable with no document horizontal overflow. Keyboard focus, field labels and confirmation behavior remain usable.

## Honest execution and credential handling

1. Saving configuration makes no external request. An explicit AgnesAI check makes one bounded GET to `/v1/models`; it never sends a prompt or starts generation.
2. Runtime stays mode mock with activeImageModel mock-svg, even when draft routes select other models.
3. API replies expose credential presence per account, not credential values. Raw keys are rejected.
4. Local transport requires a loopback endpoint. Unsupported CLI transport is not falsely enabled.
5. The AgnesAI check reads `AGNES_API_KEY` on the API process only (with legacy `GNESAI_API_KEY` fallback) and reports missing key, authorization/connection failure, or readable model count without returning the key or model IDs.

## Verification record

Run affected API tests/typecheck/build and frontend tests/build after delivery. Update root end-to-end scenarios to the delivered labels and actual v2 body shape. Record exact passing/failing counts, migration evidence, browser scenarios, and deferred capabilities in docs/verification.md. Do not describe this milestone as real model integration.
