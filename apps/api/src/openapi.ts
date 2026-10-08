import { z } from 'zod';
import { assetSchema, createSchema, runSchema } from './domain.js';
import { legacySettingsSchema, saveSettingsSchema, settingsSchema } from './settings.js';
import { archiveRoleRequestSchema, roleDefinitionSchema } from './roles.js';
import { workflowArchiveRequestSchema, workflowDefinitionSchema, workflowMutationSchema, workflowPublishRequestSchema, workflowRecordSchema, workflowValidateRequestSchema } from './workflow-contract.js';
import { langflowConfigSchema, langflowRunRequestSchema, saveLangflowConfigSchema } from './langflow-contract.js';

const reference = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const wrapped = (name: string, schema: unknown) => ({ type: 'object', required: [name], properties: { [name]: schema } });
const errorResponses = Object.fromEntries([400, 403, 404, 409, 413, 415, 500, 502, 503].map((status) => [status, { description: 'Error', ...json(reference('Error')) }]));
const runResponse = { description: 'Run snapshot', ...json(wrapped('run', reference('Run'))) };
const runId = { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } };
const action = (description: string) => ({
  post: { description, parameters: [runId], responses: { 200: runResponse, ...errorResponses } },
});
export const openapi = {
  openapi: '3.1.0', info: { title: 'AI Studio local API', version: '0.1.0',
    description: 'Local AI Studio API. Published workflow prompt nodes may call one OpenAI-compatible text model per selected agent role; image generation remains deterministic local SVG. Native Langflow runs use the separately configured local Langflow service. Provider credentials are read only by the API process and are never stored or returned.' },
  servers: [{ url: 'http://localhost:4000' }],
  paths: {
    '/api/health': { get: { responses: { 200: { description: 'Healthy local API, single-turn text agent capability and workflow storage', ...json({ type: 'object', required: ['status', 'mode', 'roleStorage', 'workflowStorage'], properties: { status: { const: 'ok' }, mode: { enum: ['mock', 'mixed'] }, roleStorage: { type: 'object', required: ['available', 'mode'], properties: { available: { const: true }, mode: { const: 'single-turn-text' } } }, workflowStorage: { type: 'object', required: ['available', 'mode'], properties: { available: { const: true }, mode: { const: 'local-file' } } } } }) }, 503: errorResponses[503] } } },
    '/api/templates': { get: { responses: { 200: { description: 'Executable image template and disabled future templates', ...json(wrapped('templates', { type: 'array', items: reference('Template') })) } } } },
    '/api/workflows': {
      get: { description: 'Workflow catalogue with immutable snapshots. Prompt nodes can use a single-turn agent when explicitly configured; image nodes remain local SVG.', responses: { 200: { description: 'Workflow library', ...json(reference('WorkflowLibrary')) }, ...errorResponses } },
      post: { description: 'Create a draft workflow and append an immutable revision using optimistic catalogue revision.', requestBody: { required: true, ...json(reference('WorkflowMutationRequest')) }, responses: { 201: { description: 'Created workflow draft', ...json(reference('WorkflowMutation')) }, ...errorResponses } },
    },
    '/api/workflows/validate': { post: { description: 'Validate graph rules, agent role references and declared model bindings without saving, publishing, or executing.', requestBody: { required: true, ...json(reference('WorkflowValidateRequest')) }, responses: { 200: { description: 'Graph validation', ...json(reference('WorkflowValidation')) }, ...errorResponses } } },
    '/api/workflows/{id}': { post: { description: 'Append a draft revision. Existing published revisions remain runnable until archive.', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, ...json(reference('WorkflowMutationRequest')) }, responses: { 200: { description: 'Updated workflow draft', ...json(reference('WorkflowMutation')) }, ...errorResponses } } },
    '/api/workflows/{id}/publish': { post: { description: 'Validate and publish a new immutable revision, capturing exact role snapshots for agent-enabled prompt nodes. Role tool declarations remain non-executable.', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, ...json(z.toJSONSchema(workflowPublishRequestSchema)) }, responses: { 200: { description: 'Published revision', ...json(reference('WorkflowMutation')) }, ...errorResponses } } },
    '/api/workflows/{id}/archive': { post: { description: 'Archive a workflow while preserving published and draft history; prevents new runs.', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, ...json(z.toJSONSchema(workflowArchiveRequestSchema)) }, responses: { 200: { description: 'Archived workflow', ...json(reference('WorkflowMutation')) }, ...errorResponses } } },
    '/api/workflows/{id}/revisions': { get: { description: 'Return immutable workflow revisions in ascending order.', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Workflow revision history', ...json({ type: 'object', required: ['revisions'], properties: { revisions: { type: 'array', items: reference('Workflow') } } }) }, ...errorResponses } } },
    '/api/settings': {
      get: { description: 'Local provider, model, route metadata, agent capability and credential presence only. Never returns credential values.', responses: { 200: { description: 'Configuration snapshot', ...json(reference('SettingsResponse')) }, ...errorResponses } },
      post: { description: 'Accept schemaVersion=2 provider/account/model metadata or the legacy v1 {revision,settings} snapshot; persist as v2 with optimistic revision checks. Raw API keys are rejected; no external connection is made.', requestBody: { required: true, ...json(reference('SaveSettings')) }, responses: { 200: { description: 'Saved v2 configuration snapshot', ...json(reference('SettingsResponse')) }, ...errorResponses } },
    },
    '/api/settings/validate-agnesai': { post: { description: 'Use the API process AGNES_API_KEY (with legacy GNESAI_API_KEY fallback) to make one read-only GET request to the AgnesAI model catalogue. Never returns the key, saves settings or generates content.', requestBody: { required: true, ...json({ type: 'object', additionalProperties: false }) }, responses: { 200: { description: 'Credential and model-catalogue validation result', ...json(reference('AgnesAiValidation')) }, ...errorResponses } } },
    '/api/roles': {
      get: { description: 'Read the role library and non-executable allowlisted tool catalogue. Published workflow prompt nodes can invoke each selected role for a single text turn.', responses: { 200: { description: 'Role library snapshot', ...json(reference('RoleLibrary')) }, ...errorResponses } },
      post: { description: 'Create a custom role draft. Persist one immutable role revision with optimistic library revision checking.', requestBody: { required: true, ...json(reference('CreateRole')) }, responses: { 201: { description: 'Created draft', ...json(reference('RoleMutation')) }, ...errorResponses } },
    },
    '/api/roles/{id}': { post: { description: 'Append an immutable revision to an editable custom draft. Built-in and archived roles cannot be edited.', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], requestBody: { required: true, ...json(reference('EditRole')) }, responses: { 200: { description: 'Updated draft', ...json(reference('RoleMutation')) }, ...errorResponses } } },
    '/api/roles/{id}/archive': { post: { description: 'Append an archive revision; preserve all metadata and revision history.', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], requestBody: { required: true, ...json(z.toJSONSchema(archiveRoleRequestSchema)) }, responses: { 200: { description: 'Archived role', ...json(reference('RoleMutation')) }, ...errorResponses } } },
    '/api/roles/{id}/revisions': { get: { description: 'Return immutable role revisions in ascending order. Each binding status is resolved against current settings.', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Role revision history', ...json({ type: 'object', required: ['revisions'], properties: { revisions: { type: 'array', items: reference('Role') } } }) }, ...errorResponses } } },
    '/api/langflow/config': {
      get: { description: 'Read Langflow connection metadata and credential presence only; never returns a credential value.', responses: { 200: { description: 'Configuration snapshot', ...json(reference('LangflowConfigResponse')) }, ...errorResponses } },
      post: { description: 'Save a loopback-only Langflow endpoint and auth configuration using optimistic revision checks. Saving never probes or executes a flow.', requestBody: { required: true, ...json(reference('SaveLangflowConfig')) }, responses: { 200: { description: 'Saved configuration', ...json(reference('LangflowConfigResponse')) }, ...errorResponses } },
    },
    '/api/langflow/status': { get: { description: 'Perform bounded health and version checks against the configured Langflow service. Connectivity failures are reported as connected=false and do not affect core health.', responses: { 200: { description: 'Connection status', ...json(reference('LangflowStatus')) }, ...errorResponses } } },
    '/api/langflow/flows': { get: { description: 'Read native Langflow flow metadata only; graph and component contents are never returned.', responses: { 200: { description: 'Flow catalogue', ...json(wrapped('flows', { type: 'array', items: reference('LangflowFlow') })) }, ...errorResponses } } },
    '/api/langflow/runs': {
      get: { description: 'Return persisted Langflow execution receipts newest first.', responses: { 200: { description: 'Langflow run history', ...json(wrapped('runs', { type: 'array', items: reference('LangflowRun') })) }, ...errorResponses } },
      post: { description: 'Persist a receipt before asynchronously calling native Langflow v1 run. Same idempotency key/request replays the original receipt; changed input conflicts. Timed out or interrupted requests can have executed and are marked outcome_unknown.', requestBody: { required: true, ...json(reference('CreateLangflowRun')) }, responses: { 202: { description: 'New queued execution receipt', ...json(wrapped('run', reference('LangflowRun'))) }, 200: { description: 'Existing receipt replay', ...json(wrapped('run', reference('LangflowRun'))) }, ...errorResponses } },
    },
    '/api/langflow/runs/{id}': { get: { description: 'Read one persisted Langflow execution receipt.', parameters: [runId], responses: { 200: { description: 'Langflow run receipt', ...json(wrapped('run', reference('LangflowRun'))) }, ...errorResponses } } },
    '/api/runs': {
      get: { description: 'All runs, newest first. This local v1 has no pagination.', responses: { 200: { description: 'Run history', ...json(wrapped('runs', { type: 'array', items: reference('Run') })) } } },
      post: { description: 'Persist before asynchronous execution. Agent prompt nodes call the configured text model; image and export nodes remain local. Keys are scoped to this data directory; normalized same input returns existing run, different input returns 409.',
        requestBody: { required: true, ...json(reference('CreateRun')) }, responses: { 201: runResponse, 200: runResponse, ...errorResponses } },
    },
    '/api/runs/{id}': { get: { parameters: [runId], responses: { 200: runResponse, ...errorResponses } } },
    '/api/runs/{id}/retry': action('Retry a failed run only. Preserve successful nodes and assets; reset failed nodes to pending. Other states return 409.'),
    '/api/runs/{id}/cancel': action('Cancel queued/running work and stop subsequent scheduling. Repeated cancellation returns 200; other terminal states return 409.'),
    '/api/assets/{runId}/{assetId}': { get: {
      description: 'Only registered local mock SVG assets. Relative asset.url resolves against the API origin.',
      parameters: [
        { in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid' } },
        { in: 'path', name: 'assetId', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{24}$' } },
        { in: 'query', name: 'download', schema: { type: 'string', enum: ['0', '1'], default: '0' } },
      ], responses: { 200: { description: 'SVG preview, or attachment when download=1', content: { 'image/svg+xml': { schema: { type: 'string' } } } }, ...errorResponses },
    } },
    '/api/openapi.json': { get: { responses: { 200: { description: 'This OpenAPI specification', ...json({ type: 'object' }) } } } },
  },
  components: { schemas: {
    CreateRun: z.toJSONSchema(createSchema), Run: z.toJSONSchema(runSchema), Asset: z.toJSONSchema(assetSchema),
    Workflow: z.toJSONSchema(workflowRecordSchema), WorkflowDefinition: z.toJSONSchema(workflowDefinitionSchema),
    WorkflowLibrary: { type: 'object', required: ['revision', 'workflows', 'starterDefinition', 'runtime'], properties: {
      revision: { type: 'integer', minimum: 0 }, workflows: { type: 'array', items: reference('Workflow') }, starterDefinition: reference('WorkflowDefinition'),
      runtime: { type: 'object', required: ['mode', 'executableKinds', 'agentExecutionEnabled'], properties: { mode: { const: 'mixed' }, executableKinds: { const: ['prompt', 'image', 'export'] }, agentExecutionEnabled: { const: true } } },
    } },
    WorkflowMutationRequest: z.toJSONSchema(workflowMutationSchema), WorkflowValidateRequest: z.toJSONSchema(workflowValidateRequestSchema),
    WorkflowMutation: { type: 'object', required: ['revision', 'workflow'], properties: { revision: { type: 'integer', minimum: 0 }, workflow: reference('Workflow') } },
    WorkflowValidation: { type: 'object', required: ['valid', 'issues', 'warnings'], properties: {
      valid: { type: 'boolean' }, issues: { type: 'array', items: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, nodeId: { type: 'string' }, edgeId: { type: 'string' } } } }, warnings: { type: 'array', items: { type: 'string' } },
    } },
    Settings: z.toJSONSchema(settingsSchema),
    AgnesAiValidation: { type: 'object', required: ['ok', 'status', 'message', 'modelCount', 'checkedAt'], properties: {
      ok: { type: 'boolean' }, status: { enum: ['connected', 'missing_key', 'unauthorized', 'forbidden', 'rate_limited', 'upstream_error', 'network_error', 'invalid_response'] },
      message: { type: 'string' }, modelCount: { type: ['integer', 'null'], minimum: 0 }, checkedAt: { type: 'string', format: 'date-time' },
    } satisfies Record<string, unknown> },
    SettingsResponse: { type: 'object', required: ['schemaVersion', 'revision', 'settings', 'runtime', 'credentials'], properties: {
      schemaVersion: { const: 2 }, revision: { type: 'integer', minimum: 0 }, settings: reference('Settings'),
      runtime: { type: 'object', required: ['mode', 'activeImageModel', 'externalProvidersEnabled'], properties: { mode: { enum: ['mock', 'mixed'] }, activeImageModel: { const: 'mock-svg' }, externalProvidersEnabled: { type: 'boolean' } } },
      credentials: { type: 'array', items: { type: 'object', required: ['accountId', 'configured'], properties: { accountId: { type: 'string' }, configured: { type: 'boolean' } } } },
    } },
    LegacySettings: z.toJSONSchema(legacySettingsSchema),
    SaveSettings: { oneOf: [z.toJSONSchema(saveSettingsSchema.options[0]!), z.toJSONSchema(legacySettingsSchema)] },
    RoleDefinition: z.toJSONSchema(roleDefinitionSchema),
    CreateRole: { type: 'object', required: ['revision', 'role'], additionalProperties: false, properties: { revision: { type: 'integer', minimum: 0 }, role: reference('RoleDefinition') } },
    EditRole: { type: 'object', required: ['revision', 'role'], additionalProperties: false, properties: { revision: { type: 'integer', minimum: 0 }, role: reference('RoleDefinition') } },
    Role: { allOf: [reference('RoleDefinition'), { type: 'object', required: ['id', 'revision', 'builtIn', 'lifecycle', 'createdAt', 'updatedAt', 'modelStatus'], properties: {
      id: { type: 'string' }, revision: { type: 'integer', minimum: 1 }, builtIn: { type: 'boolean' }, lifecycle: { enum: ['draft', 'published', 'archived'] },
      createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' }, modelStatus: { enum: ['inherit', 'configured', 'unavailable'] },
    } }] },
    RoleMutation: { type: 'object', required: ['revision', 'role'], properties: { revision: { type: 'integer', minimum: 0 }, role: reference('Role') } },
    RoleLibrary: { type: 'object', required: ['revision', 'roles', 'tools', 'runtime'], properties: {
      revision: { type: 'integer', minimum: 0 }, roles: { type: 'array', items: reference('Role') },
      tools: { type: 'array', items: reference('ToolDeclaration') }, runtime: { type: 'object', required: ['enabled', 'mode'], properties: { enabled: { const: true }, mode: { const: 'single-turn-text' } } },
    } },
    ToolDeclaration: { type: 'object', required: ['id', 'name', 'description', 'risk', 'executable'], properties: {
      id: { enum: ['assets.read', 'context.search', 'images.generate', 'media.render', 'code.read', 'code.edit', 'code.test'] },
      name: { type: 'string' }, description: { type: 'string' }, risk: { enum: ['read', 'generate', 'write'] }, executable: { const: false },
    } },
    LangflowConfig: z.toJSONSchema(langflowConfigSchema),
    SaveLangflowConfig: z.toJSONSchema(saveLangflowConfigSchema),
    LangflowConfigResponse: { type: 'object', required: ['revision', 'config', 'credentialConfigured'], properties: {
      revision: { type: 'integer', minimum: 0 }, config: reference('LangflowConfig'), credentialConfigured: { type: 'boolean' },
    } },
    LangflowStatus: { type: 'object', required: ['connected', 'version', 'editorUrl', 'authMode', 'message'], properties: {
      connected: { type: 'boolean' }, version: { type: ['string', 'null'] }, editorUrl: { type: 'string', format: 'uri' },
      authMode: { enum: ['local-development', 'api-key-env'] }, message: { type: 'string' },
    } },
    LangflowFlow: { type: 'object', required: ['id', 'name', 'description', 'updatedAt'], properties: {
      id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, description: { type: 'string' }, updatedAt: { type: ['string', 'null'], format: 'date-time' },
    } },
    CreateLangflowRun: z.toJSONSchema(langflowRunRequestSchema),
    LangflowRun: { type: 'object', required: ['id', 'flowId', 'flowName', 'input', 'status', 'createdAt', 'updatedAt', 'output', 'error', 'provider'], properties: {
      id: { type: 'string', format: 'uuid' }, flowId: { type: 'string', format: 'uuid' }, flowName: { type: 'string' }, input: { type: 'string' },
      status: { enum: ['queued', 'running', 'succeeded', 'failed', 'outcome_unknown'] }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
      output: { type: ['string', 'null'], maxLength: 16000 }, error: { type: ['string', 'null'], maxLength: 500 }, provider: { const: 'langflow' },
    } },
    Error: wrapped('error', { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } }),
    Template: { type: 'object', required: ['id', 'name', 'description', 'category', 'enabled', 'nodes'], properties: {
      id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, category: { enum: ['image', 'video', 'coding'] }, enabled: { type: 'boolean' },
      workflowRevision: { type: 'integer', minimum: 1 }, source: { const: 'workflow' },
      nodes: { type: 'array', items: { type: 'object', required: ['id', 'name', 'kind'], properties: { id: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string' } } } },
    } },
  } },
};
