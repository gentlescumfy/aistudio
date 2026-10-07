# AgentsRoom-inspired interface refresh

Reference: AgentsRoom official homepage's real-session screenshot, `https://agentsroom.dev/agentsroom-desktop-app-real-session-ai-coding-agents-parallel-v2.jpg`, and product knowledge fiches appearance-customization/interface-elements. Reference screenshot inspected by coordinator; it shows a compact three-pane workspace, warm orange accent, fine surface boundaries, active-state borders and a bottom status strip. Do not reuse its branding, portraits or screenshot assets in the application.

## Implementation scope

Frontend owner: apps/web only. Coordinator: root browser tests and documentation. API/schema behavior must remain unchanged. Existing view/action labels and accessible form names should remain stable where possible.

## Intended interface

- Compact workspace shell: left project/navigation/history, center task/configuration view, right execution inspector at wide desktop widths. Use actual run/template data, not invented agents or decorative non-working controls.
- Replace the large promotional illustration/banner with useful compact workflow/runtime context. Preserve explicit mock generation labels and costs.
- Neutral warm dark surfaces and peach/orange accent, plus an equally readable light mode. Use design tokens for backgrounds, foregrounds, borders, accents, semantic status and focus.
- Real theme selector with accessible name `界面主题` and values `dark`, `light`, `system`, persisted as local appearance preference. Default dark if unset. System mode listens to OS changes. Storage failure cannot break the app.
- Apply the resolved theme to `document.documentElement.dataset.theme` (`dark` or `light`) and CSS `color-scheme`, so native inputs/dialogs and browser verification share the same resolved state.
- Compact headers, clear tab/navigation selected states, 8–12px panel radii, restrained shadow, readable Chinese typography and monospaced identifiers. Avoid excessive 9px supporting text.
- Bottom status strip with actual connection/mock mode and settings access; preserve keyboard navigation and visible focus.
- Configuration provider/account/model editors share the same tokens and visual hierarchy. Required controls remain usable; dark-mode browser inputs/dialogs must be correctly themed.
- At narrow widths collapse the inspector into normal document flow and stack the shell without horizontal overflow. Check populated configuration and task forms at320px.

## Verification and limitations

Run meaningful frontend tests for theme persistence/system changes, existing workflow/configuration interactions and production build. Coordinator will run real browser creation/download/retry/cancel, settings edit/search/pins/defaults, dark/light persistence and populated narrow viewport checks, and inspect screenshots.

No change to model execution, credentials or role runtime is authorized by this visual refresh. Do not implement disabled future capabilities as decorative active UI. Do not launch new background servers, spawn agents, delegate QA or edit root/e2e/API files. Existing dev commands already watch both services.
