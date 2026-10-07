# Scenario specifications

## Brand asset batch generation

Suggested template ID: `brand-assets`. Category: `image`. Enabled in the first milestone. If the backend chooses another ID it must be returned by the templates endpoint; frontend clients must use returned IDs instead of hard-coding them.

Inputs: a nonempty trimmed brand/campaign prompt, maximum 2000 characters, and an integer asset count from 1 to 8.

Recommended sequence:

1. Prepare a structured creative brief.
2. Produce the requested batch through the mock image adapter.
3. Prepare downloadable assets and output metadata.

All output must be visibly labeled mock. A deterministic SVG illustration is acceptable as a local demonstration artifact; do not imply it came from an AI image model. Mock generation and processing have zero monetary cost.

The implemented dimensions and formats must be shown honestly in the UI. Multi-size export is an intended milestone requirement; if only one size is delivered initially, report that limitation rather than showing an inactive export control.

Generated assets must preserve run/node attribution. Retry should retain successful outputs. A restarted worker should reconcile local work without silently discarding submitted runs. Cancelled work must stop scheduling subsequent operations.

## Video workflow expansion

Category: `video`. Disabled in the first milestone, explicitly presented as coming soon.

Future inputs include reference assets, shot descriptions, duration, aspect ratio and audio strategy. Expansion requires asynchronous provider job tracking, unknown-outcome reconciliation, asset download and validation, per-shot approval and selective regeneration. Provider-native audio and separately synthesized audio need distinct paths.

## Coding SOP expansion

Category: `coding`. Disabled in the first milestone, explicitly presented as coming soon.

Future inputs include repository selection, task specification and execution policy. Expansion requires a sandbox, ephemeral credentials, bounded resources, network permissions, test evidence and draft pull request generation. Merge and deployment require separately configured authority and approval. No arbitrary shell execution is enabled by the initial API.

## Acceptance priorities

- The user can submit a valid brand asset request and see it in history.
- Active runs progress visibly; errors can be understood without inspecting logs.
- Submission replay returns the original run, while key reuse with changed input fails.
- Output is downloadable and its actual type/dimensions are shown.
- Failure and cancellation semantics are exercised with direct developer tests.
- Mock demonstrations and unavailable future scenarios remain unambiguous.
