# Workspace appearance

The visual direction is inspired by the official AgentsRoom real-session screenshot and its documented appearance/layout features. AI Studio uses its own branding and content; no AgentsRoom portraits or screenshot assets are embedded.

## Implemented direction

- Wide desktop workspace: left navigation/history, center creation or configuration editor, right inspector showing actual selected run inputs, progress, nodes and assets.
- Neutral warm surfaces, peach/orange accent, fine panel borders and restrained radii; the promotional illustration has been removed.
- Bottom status strip reports API connectivity and local mock output scope, with a configuration link.
- A header `界面主题` selector offers dark/light/system. Preferences use localStorage `aistudio-theme`; default is dark. System changes are observed only while system mode is selected. Storage failure preserves interactive switching.
- Resolved theme is exposed on html data-theme and native color-scheme. The configuration editor, inputs and dialogs share the same tokens.
- Narrow screens stack the panels and keep the theme selector reachable. This is a responsive web workspace, not an implementation of AgentsRoom's desktop terminal/agent runtime.

## Verification status

Coordinator frontend checks passed 26 tests and TypeScript/Vite build. The complete nine-scenario browser suite passed after theme contrast/palette corrections, including theme persistence, system changes, populated configuration, narrow controls and existing creation/download/retry/cancel behavior. After the final native-progress and tablet grid fixes, targeted contrast and1024px layout checks also passed, followed by another successful build. Actual button/success/download text contrast was checked at4.5:1 minimum in light and dark modes. This is scoped verification, not a full accessibility audit; detailed evidence is in docs/verification.md.

Existing API/model configuration behavior and mock output remain unchanged. Actual role execution, real media models and multi-size output are separate milestones.
