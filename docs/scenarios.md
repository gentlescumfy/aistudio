# Scenario specifications

## Brand asset batch generation

Suggested template ID: `brand-assets`. Category: `image`. Enabled in the first milestone. If the backend chooses another ID it must be returned by the templates endpoint; frontend clients must use returned IDs instead of hard-coding them.

Inputs: a nonempty trimmed brand/campaign prompt, maximum 2000 characters, and an integer asset count from 1 to 8.

Recommended sequence:

1. Prepare a structured creative brief.
2. Produce the requested batch through the mock image adapter.
3. Prepare downloadable assets and output metadata.

All output must be visibly labeled mock. A deterministic SVG illustration is acceptable as a local demonstration artifact; do not imply it came from an AI image model. Mock generation and processing have zero monetary cost.

## Custom workflow example: coffee launch campaign

The workflow canvas starter is a concrete launch campaign, not a generic three-box demo. Its saved description includes this complete example input:

> A small-batch light-roast coffee from Yunnan, 150 g whole-bean bag, floral aroma and citrus finish. Audience: home pour-over drinkers. Use a warm, quiet visual tone. Do not invent certifications, origin details or tasting claims beyond this brief.

| Step | Owner reference | Work | Handoff |
| --- | --- | --- | --- |
| Launch brief | Scriptwriter | Extract the audience, supported selling points, tone, tagline and visual direction; mark missing facts as unknown. | A compact creative brief grounded in the supplied product facts. |
| Product shots | Storyboard director | Plan three shots with stable product packaging, composition, lighting, background, palette and image prompts. | Ordered shot descriptions for continuity review. |
| Continuity review | Continuity reviewer | Find contradictions and return one corrected, self-contained hero-image prompt without unsupported claims. | The final image prompt. |
| Hero image | Image step | Render one 1024 × 1024 campaign image from the reviewed prompt. | An image asset. |
| Delivery | Export step | Collect the image asset for preview and download. | The deliverable asset list. |

The starter definition lives in `apps/api/src/workflow-contract.ts`. Its three prompt nodes are configured to call the versioned Scriptwriter, Storyboard director and Continuity reviewer roles through one OpenAI-compatible text route. Each model response is persisted as that node's output and substituted into the next role's prompt. The image node still creates a local SVG; this is a real multi-agent text handoff, not real image generation.

### Reproduce the example in the UI

1. Open **配置与工作流 → 工作流画布**, then choose **从起始模板新建**. The created draft is named **咖啡新品上市视觉全流程** and carries the sample brief above.
2. Inspect **代理职责与交接** to read each owner's task and handoff. The first three prompt nodes should show **实际调用代理**. Select a node to see its role, model source, input contract, expected output and next recipient. A run records both the exact task sent to the model and the response passed downstream.
3. Validate, save and publish the draft. In **创作工作台**, choose the published template, paste the same product brief, set the image count to 1 and start the run.
4. A successful run makes three text-model calls in order, then traverses the local image and export nodes. The run record shows each provider/model receipt, role response and handoff, then produces one 1024 × 1024 watermarked SVG that can be previewed and downloaded. The final SVG uses the continuity reviewer's returned prompt as input.

The workflow runs real single-turn text calls only after the API service has a valid secret environment variable and a saved OpenAI-compatible provider/account/model configuration. For each role, **模型选择** can inherit the workspace text route or bind a specific configured model; **配置中心 → 默认模型绑定 → 文本与代码** sets the inherited route. AgnesAI validation only reads its model catalogue and does not prove generation access. Provider text calls may incur charges; AI Studio currently does not report token-based costs. If the API has no route or credential, starting the run fails before creating a run and explains which configuration is missing. The separate Langflow workspace remains a distinct execution surface.

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
