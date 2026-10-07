# Local Langflow service

Pinned Langflow UI/API version: langflow-base1.12.5, Python3.12, isolated uv environment. Official installation documentation confirms langflow-base provides the same editor/API without curated provider extensions: https://docs.langflow.org/get-started-installation .

Install with `uv sync` in this directory. Long-running startup is managed through AgentsRoom Dev Commands, not shell background processes.

Local development command:

```sh
DO_NOT_TRACK=true LANGFLOW_CONFIG_DIR=./.data LANGFLOW_SAVE_DB_IN_CONFIG_DIR=true LANGFLOW_STORE_ENVIRONMENT_VARIABLES=false LANGFLOW_AUTO_LOGIN=true LANGFLOW_SKIP_AUTH_AUTO_LOGIN=true LANGFLOW_OPEN_BROWSER=false uv run langflow run --host 127.0.0.1 --port 7860
```

This is a loopback-only developer profile. Automatic editor/API login is explicit and not a production authentication setup. Authenticated deployment must disable auto-login/skip-auth and supply service credentials securely; the Studio adapter will support a server-side API-key environment reference. No model-provider credential is configured by this setup.

Data belongs to the service directory's ignored .data; dependency state is locked in uv.lock. Do not import or modify another Langflow instance's files. Installation, healthy API/version1.12.5, native editor and actual Studio-driven Echo execution have been verified; see ../../docs/verification.md.

From the repository root, `node scripts/langflow-echo.mjs --verify` provisions/verifies the owned Echo fixture. It checks that both nodes use native ChatInput/ChatOutput code, have no attachments and retain one canonical-port connection. Only this verified fixture may have its edge metadata repaired; other flows are untouched. The fixture is locked again after repair. No model credential or paid call is involved.
