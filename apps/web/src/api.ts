import type { AccountConfig, Capability, Inputs, LangflowConfig, LangflowConfigResponse, LangflowFlow, LangflowRun, LangflowStatus, ModelBinding, ModelConfig, ProjectRecord, ProjectsResponse, ProviderConfig, Role, RoleDefinition, RoleLibrary, RoleMutationResponse, RoleRevisionsResponse, Run, SettingsResponse, StudioSettings, Template, ToolDeclaration, Workflow, WorkflowDefinition, WorkflowLibrary, WorkflowMutationResponse, WorkflowRevisionsResponse, WorkflowValidation } from './types';

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000').replace(/\/+$/, '');
export class ApiError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const slug = (value: unknown) => typeof value === 'string' && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const unique = (items: unknown[]) => new Set(items).size === items.length;
const declaredCapabilities = ['text', 'code', 'image', 'video', 'audio'] as const;
const validBinding = (value: unknown): value is ModelBinding => record(value) && Object.keys(value).length === 3
  && Object.keys(value).every(key => ['providerId', 'accountId', 'modelId'].includes(key))
  && slug(value.providerId) && slug(value.accountId) && slug(value.modelId);
const roleCategories = ['media', 'engineering', 'operations', 'custom'] as const;
const roleLifecycle = ['draft', 'published', 'archived'] as const;
const uniqueStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string') && unique(value);
const validRoleDefinition = (value: unknown): value is RoleDefinition => record(value)
  && Object.keys(value).every(key => ['name', 'category', 'description', 'systemPrompt', 'inputContract', 'outputContract', 'tools', 'modelSelection', 'limits'].includes(key))
  && Object.keys(value).length === 9
  && typeof value.name === 'string' && value.name.trim().length >= 1 && value.name.length <= 80
  && roleCategories.includes(value.category as typeof roleCategories[number])
  && typeof value.description === 'string' && value.description.trim().length >= 1 && value.description.length <= 1000
  && typeof value.systemPrompt === 'string' && value.systemPrompt.trim().length >= 1 && value.systemPrompt.length <= 6000
  && typeof value.inputContract === 'string' && value.inputContract.trim().length >= 1 && value.inputContract.length <= 4000
  && typeof value.outputContract === 'string' && value.outputContract.trim().length >= 1 && value.outputContract.length <= 4000
  && uniqueStrings(value.tools) && value.tools.every(item => /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(item))
  && record(value.modelSelection) && (value.modelSelection.kind === 'inherit'
    ? Object.keys(value.modelSelection).length === 1
    : value.modelSelection.kind === 'binding' && Object.keys(value.modelSelection).length === 2 && validBinding(value.modelSelection.binding))
  && record(value.limits) && Object.keys(value.limits).length === 4
  && Object.keys(value.limits).every(key => ['maxSteps', 'maxToolCalls', 'deadlineMs', 'maxCost'].includes(key))
  && Number.isInteger(value.limits.maxSteps) && (value.limits.maxSteps as number) >= 1 && (value.limits.maxSteps as number) <= 100
  && Number.isInteger(value.limits.maxToolCalls) && (value.limits.maxToolCalls as number) >= 0 && (value.limits.maxToolCalls as number) <= 1000
  && Number.isInteger(value.limits.deadlineMs) && (value.limits.deadlineMs as number) >= 1000 && (value.limits.deadlineMs as number) <= 3600000
  && typeof value.limits.maxCost === 'number' && Number.isFinite(value.limits.maxCost) && value.limits.maxCost >= 0 && value.limits.maxCost <= 1000;
const validRole = (value: unknown): value is Role => record(value)
  && Object.keys(value).every(key => ['id', 'revision', 'builtIn', 'lifecycle', 'createdAt', 'updatedAt', 'modelStatus', 'name', 'category', 'description', 'systemPrompt', 'inputContract', 'outputContract', 'tools', 'modelSelection', 'limits'].includes(key))
  && Object.keys(value).length === 16
  && (slug(value.id) || typeof value.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id))
  && Number.isInteger(value.revision) && (value.revision as number) >= 1 && typeof value.builtIn === 'boolean'
  && roleLifecycle.includes(value.lifecycle as typeof roleLifecycle[number])
  && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
  && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
  && ['inherit', 'configured', 'unavailable'].includes(value.modelStatus as string)
  && validRoleDefinition(Object.fromEntries(['name', 'category', 'description', 'systemPrompt', 'inputContract', 'outputContract', 'tools', 'modelSelection', 'limits'].map(key => [key, value[key]])))
  && (value.builtIn ? slug(value.id) && value.lifecycle === 'published' : typeof value.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id));
const validToolDeclaration = (value: unknown): value is ToolDeclaration => record(value)
  && Object.keys(value).length === 5 && Object.keys(value).every(key => ['id', 'name', 'description', 'risk', 'executable'].includes(key))
  && typeof value.id === 'string' && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value.id)
  && typeof value.name === 'string' && value.name.length > 0 && typeof value.description === 'string'
  && ['read', 'generate', 'write'].includes(value.risk as string) && value.executable === false;
const validRoleRef = (value: unknown) => record(value) && Object.keys(value).length === 2
  && Object.keys(value).every(key => ['id', 'revision'].includes(key))
  && (slug(value.id) || typeof value.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id))
  && Number.isInteger(value.revision) && (value.revision as number) >= 1;
const validWorkflowNode = (value: unknown) => {
  const position = record(value) ? value.position : undefined;
  if (!record(value) || Object.keys(value).length !== 5 || !['id', 'name', 'position', 'kind', 'config'].every(key => Object.hasOwn(value, key))
    || !slug(value.id) || typeof value.name !== 'string' || value.name.trim().length < 1 || value.name.length > 80
    || !record(position) || Object.keys(position).length !== 2 || !['x', 'y'].every(key => typeof position[key] === 'number' && Number.isFinite(position[key]) && Math.abs(position[key] as number) <= 10000)
    || !record(value.config)) return false;
  if (value.kind === 'prompt') return Object.keys(value.config).length >= 2 && Object.keys(value.config).length <= 3 && Object.keys(value.config).every(key => ['template', 'roleRef', 'executionMode'].includes(key))
    && Object.hasOwn(value.config, 'template') && Object.hasOwn(value.config, 'roleRef')
    && typeof value.config.template === 'string' && value.config.template.length <= 6000 && (value.config.roleRef === null || validRoleRef(value.config.roleRef))
    && (value.config.executionMode === undefined || value.config.executionMode === 'template' || value.config.executionMode === 'agent');
  if (value.kind === 'image') return Object.keys(value.config).length === 3 && Object.keys(value.config).every(key => ['width', 'height', 'count'].includes(key))
    && Number.isInteger(value.config.width) && (value.config.width as number) >= 512 && (value.config.width as number) <= 2048
    && Number.isInteger(value.config.height) && (value.config.height as number) >= 512 && (value.config.height as number) <= 2048
    && (value.config.count === null || Number.isInteger(value.config.count) && (value.config.count as number) >= 1 && (value.config.count as number) <= 8);
  return value.kind === 'export' && Object.keys(value.config).length === 0;
};
const validWorkflowEdge = (value: unknown) => record(value) && Object.keys(value).length === 3
  && Object.keys(value).every(key => ['id', 'source', 'target'].includes(key)) && slug(value.id) && slug(value.source) && slug(value.target);
const validWorkflowDefinition = (value: unknown): value is WorkflowDefinition => record(value) && Object.keys(value).length === 4
  && Object.keys(value).every(key => ['name', 'description', 'nodes', 'edges'].includes(key))
  && typeof value.name === 'string' && value.name.trim().length >= 1 && value.name.length <= 80
  && typeof value.description === 'string' && value.description.trim().length >= 1 && value.description.length <= 1000
  && Array.isArray(value.nodes) && value.nodes.length <= 20 && value.nodes.every(validWorkflowNode)
  && Array.isArray(value.edges) && value.edges.length <= 40 && value.edges.every(validWorkflowEdge)
  && unique(value.nodes.map(node => node.id)) && unique(value.edges.map(edge => edge.id));
const validWorkflow = (value: unknown): value is Workflow => record(value) && Object.keys(value).length === 11
  && Object.keys(value).every(key => ['id', 'revision', 'lifecycle', 'publishedRevision', 'createdAt', 'updatedAt', 'roleSnapshots', 'name', 'description', 'nodes', 'edges'].includes(key))
  && (typeof value.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id))
  && Number.isInteger(value.revision) && (value.revision as number) >= 1 && ['draft', 'published', 'archived'].includes(value.lifecycle as string)
  && (value.publishedRevision === null || Number.isInteger(value.publishedRevision) && (value.publishedRevision as number) >= 1)
  && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
  && Array.isArray(value.roleSnapshots) && value.roleSnapshots.every(snapshot => record(snapshot) && Object.keys(snapshot).length === 2
    && typeof snapshot.nodeId === 'string' && validRole(snapshot.role))
  && validWorkflowDefinition(Object.fromEntries(['name', 'description', 'nodes', 'edges'].map(key => [key, value[key]])));
const validWorkflowLibrary = (value: unknown): value is WorkflowLibrary => record(value) && Object.keys(value).length === 4
  && Object.keys(value).every(key => ['revision', 'workflows', 'starterDefinition', 'runtime'].includes(key))
  && Number.isInteger(value.revision) && (value.revision as number) >= 0 && Array.isArray(value.workflows)
  && value.workflows.every(validWorkflow) && unique(value.workflows.map(workflow => workflow.id))
  && validWorkflowDefinition(value.starterDefinition) && record(value.runtime) && Object.keys(value.runtime).length === 3
  && Object.keys(value.runtime).every(key => ['mode', 'executableKinds', 'agentExecutionEnabled'].includes(key))
  && value.runtime.mode === 'mixed' && JSON.stringify(value.runtime.executableKinds) === JSON.stringify(['prompt', 'image', 'export']) && value.runtime.agentExecutionEnabled === true;
const validWorkflowValidation = (value: unknown): value is WorkflowValidation => record(value) && Object.keys(value).length === 3
  && Object.keys(value).every(key => ['valid', 'issues', 'warnings'].includes(key)) && typeof value.valid === 'boolean'
  && Array.isArray(value.issues) && value.issues.every(issue => record(issue) && Object.keys(issue).every(key => ['code', 'message', 'nodeId', 'edgeId'].includes(key))
    && typeof issue.code === 'string' && typeof issue.message === 'string' && (issue.nodeId === undefined || typeof issue.nodeId === 'string') && (issue.edgeId === undefined || typeof issue.edgeId === 'string'))
  && Array.isArray(value.warnings) && value.warnings.every(warning => typeof warning === 'string');
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const langflowAuthModes = ['local-development', 'api-key-env'] as const;
const localLangflowUrl = (value: unknown) => {
  if (typeof value !== 'string' || value.length > 500) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const parts = hostname.split('.');
    const loopbackIpv4 = parts.length === 4 && Number(parts[0]) === 127 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
    const loopback = hostname === 'localhost' || hostname === '::1' || loopbackIpv4;
    return loopback && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
};
const validLangflowConfig = (value: unknown): value is LangflowConfig => record(value) && Object.keys(value).length === 4
  && Object.keys(value).every(key => ['baseUrl', 'authMode', 'secretEnv', 'timeoutMs'].includes(key))
  && localLangflowUrl(value.baseUrl) && langflowAuthModes.includes(value.authMode as typeof langflowAuthModes[number])
  && typeof value.secretEnv === 'string' && value.secretEnv.length <= 128 && (value.secretEnv === '' || /^[A-Z_][A-Z0-9_]*$/.test(value.secretEnv))
  && Number.isInteger(value.timeoutMs) && (value.timeoutMs as number) >= 1000 && (value.timeoutMs as number) <= 120000;
const validLangflowConfigResponse = (value: unknown): value is LangflowConfigResponse => record(value) && Object.keys(value).length === 3
  && Object.keys(value).every(key => ['revision', 'config', 'credentialConfigured'].includes(key))
  && Number.isInteger(value.revision) && (value.revision as number) >= 0 && validLangflowConfig(value.config)
  && typeof value.credentialConfigured === 'boolean';
const validLangflowStatus = (value: unknown): value is LangflowStatus => record(value) && Object.keys(value).length === 5
  && Object.keys(value).every(key => ['connected', 'version', 'editorUrl', 'authMode', 'message'].includes(key))
  && typeof value.connected === 'boolean' && (value.version === null || typeof value.version === 'string' && value.version.length <= 80)
  && typeof value.editorUrl === 'string' && value.editorUrl.length <= 500
  && langflowAuthModes.includes(value.authMode as typeof langflowAuthModes[number])
  && typeof value.message === 'string' && value.message.length <= 1000;
const validLangflowFlow = (value: unknown): value is LangflowFlow => record(value) && Object.keys(value).length === 4
  && Object.keys(value).every(key => ['id', 'name', 'description', 'updatedAt'].includes(key))
  && uuid(value.id) && typeof value.name === 'string' && value.name.length <= 200
  && typeof value.description === 'string' && value.description.length <= 2000
  && (value.updatedAt === null || typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)));
const langflowRunStatuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown'] as const;
const validLangflowRun = (value: unknown): value is LangflowRun => record(value) && Object.keys(value).length === 10
  && Object.keys(value).every(key => ['id', 'flowId', 'flowName', 'input', 'status', 'createdAt', 'updatedAt', 'output', 'error', 'provider'].includes(key))
  && typeof value.id === 'string' && value.id.length >= 1 && value.id.length <= 128 && uuid(value.flowId) && typeof value.flowName === 'string' && value.flowName.length <= 200
  && typeof value.input === 'string' && value.input.trim().length > 0 && value.input.length <= 2000
  && langflowRunStatuses.includes(value.status as typeof langflowRunStatuses[number])
  && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
  && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
  && (value.output === null || typeof value.output === 'string' && value.output.length <= 16000)
  && (value.error === null || typeof value.error === 'string' && value.error.length <= 2000)
  && value.provider === 'langflow';
const validRoleLibrary = (value: unknown): value is RoleLibrary => {
  if (!record(value) || Object.keys(value).length !== 4 || Object.keys(value).some(key => !['revision', 'roles', 'tools', 'runtime'].includes(key))
    || !Number.isInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.roles) || !value.roles.every(validRole)
    || !unique(value.roles.map(role => role.id)) || !Array.isArray(value.tools) || !value.tools.every(validToolDeclaration)
    || !unique(value.tools.map(tool => tool.id)) || !record(value.runtime) || Object.keys(value.runtime).length !== 2
    || Object.keys(value.runtime).some(key => !['enabled', 'mode'].includes(key)) || value.runtime.enabled !== true || value.runtime.mode !== 'single-turn-text') return false;
  const roles = value.roles as Role[];
  const tools = value.tools as ToolDeclaration[];
  return roles.every(role => role.tools.every(toolId => tools.some(tool => tool.id === toolId)));
};
function validSettings(value: unknown): value is StudioSettings {
  if (!record(value) || !Number.isInteger(value.defaultCount) || (value.defaultCount as number) < 1 || (value.defaultCount as number) > 8
    || !Array.isArray(value.providers) || value.providers.length > 8 || !Array.isArray(value.accounts) || value.accounts.length > 16
    || !Array.isArray(value.models) || value.models.length > 64 || !record(value.routes)) return false;
  const providers = value.providers as ProviderConfig[];
  const accounts = value.accounts as AccountConfig[];
  const models = value.models as ModelConfig[];
  const sameFields = (item: Record<string, unknown>, allowed: string[]) => Object.keys(item).every(key => allowed.includes(key));
  const validEndpoint = (item: ProviderConfig) => {
    try {
      const url = new URL(item.baseUrl);
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const loopback = hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
      return item.baseUrl.trim().length > 0 && item.baseUrl.length <= 1000
        && !url.username && !url.password && !url.search && !url.hash
        && (url.protocol === 'https:' || url.protocol === 'http:' && loopback)
        && (item.transport !== 'local' || loopback);
    } catch { return false; }
  };
  if (!providers.every(item => record(item) && sameFields(item, ['id', 'name', 'transport', 'protocol', 'baseUrl'])
    && slug(item.id) && typeof item.name === 'string' && item.name.trim().length > 0 && item.name.length <= 80
    && ['api', 'local'].includes(item.transport as string) && ['openai-compatible', 'anthropic', 'google'].includes(item.protocol as string)
    && typeof item.baseUrl === 'string' && validEndpoint(item))) return false;
  if (!accounts.every(item => record(item) && sameFields(item, ['id', 'providerId', 'label', 'secretEnv', 'enabled'])
    && slug(item.id) && slug(item.providerId) && typeof item.label === 'string' && item.label.trim().length > 0 && item.label.length <= 80
    && typeof item.secretEnv === 'string' && (item.secretEnv === '' || /^[A-Z][A-Z0-9_]*$/.test(item.secretEnv))
    && typeof item.enabled === 'boolean')) return false;
  if (!models.every(item => record(item) && sameFields(item, ['id', 'accountId', 'externalId', 'name', 'capabilities', 'pinned'])
    && slug(item.id) && slug(item.accountId) && typeof item.externalId === 'string' && item.externalId.length > 0 && item.externalId.length <= 160
    && typeof item.name === 'string' && item.name.trim().length > 0 && item.name.length <= 80
    && Array.isArray(item.capabilities) && item.capabilities.length > 0 && item.capabilities.every(capability => declaredCapabilities.includes(capability as Capability))
    && unique(item.capabilities) && typeof item.pinned === 'boolean')) return false;
  if (!unique(providers.map(item => item.id)) || !unique(accounts.map(item => item.id)) || !unique(models.map(item => item.id))
    || !unique(models.map(item => `${item.accountId}/${item.externalId}`))) return false;
  if (accounts.some(account => !providers.some(provider => provider.id === account.providerId))) return false;
  if (models.some(model => !accounts.some(account => account.id === model.accountId))
    || models.some((model, index) => models.slice(0, index).some(other => other.accountId === model.accountId && other.externalId === model.externalId))) return false;
  const resolve = (route: unknown, capability: Capability): boolean => {
    if (!validBinding(route)) return false;
    const account = accounts.find(item => item.id === route.accountId && item.providerId === route.providerId && item.enabled);
    const model = models.find(item => item.id === route.modelId && item.accountId === route.accountId);
    return !!account && !!model && (model.capabilities.includes(capability) || capability === 'text' && model.capabilities.includes('code'));
  };
  const routes = value.routes;
  if (!['text', 'image', 'video'].every(key => Object.hasOwn(routes, key))
    || Object.keys(routes).some(key => !['text', 'image', 'video'].includes(key))) return false;
  return (routes.image === 'mock-svg' || resolve(routes.image, 'image'))
    && (routes.text === null || resolve(routes.text, 'text'))
    && (routes.video === null || resolve(routes.video, 'video'));
}
export function validateSettingsDraft(settings: StudioSettings): string | null {
  if (!validSettings(settings)) return '配置未通过本地校验，请检查名称、服务地址、账号关联和模型能力声明。';
  return null;
}
const validNode = (value: unknown) => record(value) && ['id', 'name', 'kind'].every(key => typeof value[key] === 'string');
const validRun = (value: unknown) => record(value) && typeof value.id === 'string' && typeof value.templateId === 'string'
  && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string' && ['mock', 'mixed'].includes(value.mode as string)
  && ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(value.status as string)
  && record(value.inputs) && typeof value.inputs.prompt === 'string' && typeof value.inputs.count === 'number'
  && Array.isArray(value.nodes) && value.nodes.every(node => validNode(node) && record(node)
    && ['pending', 'running', 'succeeded', 'failed', 'cancelled'].includes(node.status as string) && typeof node.attempts === 'number')
  && Array.isArray(value.assets) && value.assets.every(asset => record(asset) && ['id', 'runId', 'nodeId', 'url', 'name', 'mimeType'].every(key => typeof asset[key] === 'string')
    && typeof asset.width === 'number' && typeof asset.height === 'number' && asset.mode === 'mock')
  && (value.workflowSnapshot === undefined || validWorkflow(value.workflowSnapshot))
  && (value.expectedAssetCount === undefined || Number.isInteger(value.expectedAssetCount) && (value.expectedAssetCount as number) >= 1 && (value.expectedAssetCount as number) <= 160)
  && value.nodes.every(node => !record(node) || (node.config === undefined || record(node.config))
    && (node.dependsOn === undefined || Array.isArray(node.dependsOn) && node.dependsOn.every(id => typeof id === 'string'))
    && (node.outputPrompt === undefined || typeof node.outputPrompt === 'string')
    && (node.agentOutput === undefined || typeof node.agentOutput === 'string')
    && (node.agentExecution === undefined || record(node.agentExecution) && typeof node.agentExecution.providerName === 'string' && typeof node.agentExecution.modelName === 'string' && typeof node.agentExecution.completedAt === 'string'))
  && (value.estimatedCost === null || typeof value.estimatedCost === 'number')
  && (value.actualCost === null || typeof value.actualCost === 'number');
function validPayload(path: string, payload: unknown, body?: unknown): boolean {
  if (!record(payload)) return false;
  if (path === '/api/langflow/config') return validLangflowConfigResponse(payload);
  if (path === '/api/langflow/status') return validLangflowStatus(payload);
  if (path === '/api/langflow/flows') return Object.keys(payload).length === 1 && Array.isArray(payload.flows)
    && payload.flows.every(validLangflowFlow) && unique(payload.flows.map(flow => flow.id));
  if (path === '/api/langflow/runs' && body === undefined) return Object.keys(payload).length === 1
    && Array.isArray(payload.runs) && payload.runs.every(validLangflowRun);
  if (path === '/api/langflow/runs' || /^\/api\/langflow\/runs\/[^/]+(?:\/cancel)?$/.test(path)) return Object.keys(payload).length === 1 && validLangflowRun(payload.run);
  if (path === '/api/workflows' && body === undefined) return validWorkflowLibrary(payload);
  if (path === '/api/workflows/validate') return validWorkflowValidation(payload);
  if (/^\/api\/workflows\/[a-z0-9-]+\/revisions$/.test(path)) return Object.keys(payload).length === 1
    && Array.isArray(payload.revisions) && payload.revisions.every(validWorkflow)
    && (payload.revisions as Workflow[]).every((workflow, index, revisions) => index === 0 || revisions[index - 1]!.revision <= workflow.revision);
  if (path === '/api/workflows' || /^\/api\/workflows\/[a-z0-9-]+(?:\/(?:publish|archive))?$/.test(path)) return Object.keys(payload).length === 2
    && Object.keys(payload).every(key => ['revision', 'workflow'].includes(key))
    && Number.isInteger(payload.revision) && (payload.revision as number) >= 0 && validWorkflow(payload.workflow);
  if (path === '/api/roles' && body === undefined) return validRoleLibrary(payload);
  if (/^\/api\/roles\/[a-z0-9-]+\/revisions$/.test(path)) return Object.keys(payload).length === 1
    && Array.isArray(payload.revisions) && payload.revisions.every(validRole)
    && (payload.revisions as Role[]).every((role, index, revisions) => index === 0 || revisions[index - 1]!.revision <= role.revision);
  if (path === '/api/roles' || /^\/api\/roles\/[a-z0-9-]+(?:\/archive)?$/.test(path)) return Object.keys(payload).length === 2
    && Object.keys(payload).every(key => ['revision', 'role'].includes(key))
    && Number.isInteger(payload.revision) && (payload.revision as number) >= 0 && validRole(payload.role);
  if (path === '/api/settings') return Object.keys(payload).every(key => ['schemaVersion', 'revision', 'settings', 'runtime', 'credentials'].includes(key))
    && payload.schemaVersion === 2 && Number.isInteger(payload.revision) && (payload.revision as number) >= 0
    && validSettings(payload.settings) && record(payload.runtime) && ['mock', 'mixed'].includes(payload.runtime.mode as string)
    && Object.keys(payload.runtime).every(key => ['mode', 'activeImageModel', 'externalProvidersEnabled'].includes(key))
    && payload.runtime.activeImageModel === 'mock-svg' && typeof payload.runtime.externalProvidersEnabled === 'boolean'
    && Array.isArray(payload.credentials) && payload.credentials.length === (payload.settings as StudioSettings).accounts.length
    && payload.credentials.every(item => record(item) && Object.keys(item).every(key => ['accountId', 'configured'].includes(key))
      && slug(item.accountId) && typeof item.configured === 'boolean'
      && (payload.settings as StudioSettings).accounts.some(account => account.id === item.accountId))
    && unique(payload.credentials.map(item => record(item) ? item.accountId : null));
  if (path === '/api/health') return payload.status === 'ok' && typeof payload.mode === 'string';
  if (path === '/api/templates') return Array.isArray(payload.templates) && payload.templates.every(template => record(template)
    && ['id', 'name', 'description'].every(key => typeof template[key] === 'string')
    && ['image', 'video', 'coding'].includes(template.category as string) && typeof template.enabled === 'boolean'
    && Array.isArray(template.nodes) && template.nodes.every(validNode)
    && (template.source === undefined || template.source === 'builtin' || template.source === 'workflow')
    && (template.workflowRevision === undefined || Number.isInteger(template.workflowRevision) && (template.workflowRevision as number) >= 1)
    && (template.agentNodeCount === undefined || Number.isInteger(template.agentNodeCount) && (template.agentNodeCount as number) >= 0 && (template.agentNodeCount as number) <= template.nodes.length)
    && (template.source !== 'workflow' || Number.isInteger(template.workflowRevision) && (template.workflowRevision as number) >= 1));
  if (path === '/api/projects' && body === undefined) return record(payload)
    && Number.isInteger(payload.revision) && Array.isArray(payload.projects);
  if (path === '/api/projects' && body !== undefined) return record(payload) && record(payload.record);
  if (/^\/api\/projects\/[^/]+\/sync-langflow$/.test(path)) return record(payload) && typeof payload.projectId === 'string';
  if (/^\/api\/projects\/[^/]+\/delete$/.test(path)) return record(payload) && typeof payload.removed === 'object';
  if (path === '/api/runs' && body === undefined) return Array.isArray(payload.runs) && payload.runs.every(validRun);
  return validRun(payload.run);
}
let globalProjectId = localStorage.getItem('studio_project_id') || 'default';
export const setProjectId = (id: string) => { globalProjectId = id; localStorage.setItem('studio_project_id', id); };
export const getProjectId = () => globalProjectId;

async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      signal: controller.signal, method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? undefined : { 'Content-Type': 'application/json' }),
        'x-project-id': globalProjectId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!response.ok) {
      const failure = payload as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(failure?.error?.message || `请求失败（${response.status}），请稍后重试。`, failure?.error?.code || 'REQUEST_FAILED', response.status);
    }
    if (!validPayload(path, payload, body)) throw new ApiError('服务返回了无效数据，请刷新后重试。', 'INVALID_RESPONSE', response.status);
    return payload as T;
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ApiError) throw error;
    throw new ApiError(controller.signal.aborted ? '服务响应超时，请稍后重试。' : '无法连接工作台服务，请确认本地 API 已启动后重试。', 'NETWORK_ERROR', 0);
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
}
export const api = {
  langflowConfig: (signal: AbortSignal) => request<LangflowConfigResponse>('/api/langflow/config', signal),
  saveLangflowConfig: (revision: number, config: LangflowConfig, signal: AbortSignal) => request<LangflowConfigResponse>('/api/langflow/config', signal, { revision, config }),
  langflowStatus: (signal: AbortSignal) => request<LangflowStatus>('/api/langflow/status', signal),
  langflowFlows: (signal: AbortSignal) => request<{ flows: LangflowFlow[] }>('/api/langflow/flows', signal),
  langflowRuns: (signal: AbortSignal) => request<{ runs: LangflowRun[] }>('/api/langflow/runs', signal),
  langflowRun: (id: string, signal: AbortSignal) => request<{ run: LangflowRun }>(`/api/langflow/runs/${encodeURIComponent(id)}`, signal),
  createLangflowRun: (flowId: string, input: string, idempotencyKey: string, signal: AbortSignal) =>
    request<{ run: LangflowRun }>('/api/langflow/runs', signal, { flowId, input, idempotencyKey }),
  cancelLangflowRun: (id: string, signal: AbortSignal) =>
    request<{ run: LangflowRun }>(`/api/langflow/runs/${encodeURIComponent(id)}/cancel`, signal, {}),
  settings: (signal: AbortSignal) => request<SettingsResponse>('/api/settings', signal),
  saveSettings: (revision: number, settings: StudioSettings, signal: AbortSignal) => request<SettingsResponse>('/api/settings', signal, { schemaVersion: 2, revision, settings }),
  roles: (signal: AbortSignal) => request<RoleLibrary>('/api/roles', signal),
  createRole: (revision: number, role: RoleDefinition, signal: AbortSignal) => request<RoleMutationResponse>('/api/roles', signal, { revision, role }),
  updateRole: (id: string, revision: number, role: RoleDefinition, signal: AbortSignal) => request<RoleMutationResponse>(`/api/roles/${encodeURIComponent(id)}`, signal, { revision, role }),
  archiveRole: (id: string, revision: number, signal: AbortSignal) => request<RoleMutationResponse>(`/api/roles/${encodeURIComponent(id)}/archive`, signal, { revision }),
  roleRevisions: (id: string, signal: AbortSignal) => request<RoleRevisionsResponse>(`/api/roles/${encodeURIComponent(id)}/revisions`, signal),
  workflows: (signal: AbortSignal) => request<WorkflowLibrary>('/api/workflows', signal),
  createWorkflow: (revision: number, workflow: WorkflowDefinition, signal: AbortSignal) => request<WorkflowMutationResponse>('/api/workflows', signal, { revision, workflow }),
  updateWorkflow: (id: string, revision: number, workflow: WorkflowDefinition, signal: AbortSignal) => request<WorkflowMutationResponse>(`/api/workflows/${encodeURIComponent(id)}`, signal, { revision, workflow }),
  validateWorkflow: (workflow: WorkflowDefinition, signal: AbortSignal) => request<WorkflowValidation>('/api/workflows/validate', signal, { workflow }),
  publishWorkflow: (id: string, revision: number, signal: AbortSignal) => request<WorkflowMutationResponse>(`/api/workflows/${encodeURIComponent(id)}/publish`, signal, { revision }),
  archiveWorkflow: (id: string, revision: number, signal: AbortSignal) => request<WorkflowMutationResponse>(`/api/workflows/${encodeURIComponent(id)}/archive`, signal, { revision }),
  workflowRevisions: (id: string, signal: AbortSignal) => request<WorkflowRevisionsResponse>(`/api/workflows/${encodeURIComponent(id)}/revisions`, signal),
  health: (signal: AbortSignal) => request<{ status: 'ok'; mode: 'mock' | 'mixed' }>('/api/health', signal),
  templates: (signal: AbortSignal) => request<{ templates: Template[] }>('/api/templates', signal),
  runs: (signal: AbortSignal) => request<{ runs: Run[] }>('/api/runs', signal),
  run: (id: string, signal: AbortSignal) => request<{ run: Run }>(`/api/runs/${encodeURIComponent(id)}`, signal),
  create: (templateId: string, inputs: Inputs, idempotencyKey: string, signal: AbortSignal, workflowRevision?: number) =>
    request<{ run: Run }>('/api/runs', signal, { templateId, inputs, idempotencyKey, ...(workflowRevision === undefined ? {} : { workflowRevision }) }),
  action: (id: string, action: 'retry' | 'cancel', signal: AbortSignal) =>
    request<{ run: Run }>(`/api/runs/${encodeURIComponent(id)}/${action}`, signal, {}),
  projects: (signal: AbortSignal) => request<ProjectsResponse>('/api/projects', signal),
  createProject: (name: string, id: string | undefined, signal: AbortSignal, revision?: number) =>
    request<{ record: ProjectRecord }>('/api/projects', signal, { name, ...(id ? { id } : {}), ...(revision !== undefined ? { revision } : {}) }),
  syncLangflowProject: (id: string, signal: AbortSignal) =>
    request<{ projectId: string; langflowProjectId: string | null; syncStatus: 'synced' | 'pending' }>(`/api/projects/${encodeURIComponent(id)}/sync-langflow`, signal, {}),
  deleteProject: (id: string, signal: AbortSignal) =>
    request<{ removed: ProjectRecord }>(`/api/projects/${encodeURIComponent(id)}/delete`, signal, {}),
};
export function validateInputs(prompt: string, count: number): string | null {
  if (!prompt.trim()) return '请描述你想创作的品牌素材。';
  if (prompt.trim().length > 2000) return '素材描述最多为 2000 个字符。';
  if (!Number.isInteger(count) || count < 1 || count > 8) return '生成数量必须是 1 到 8 之间的整数。';
  return null;
}
export function assetUrl(url: string): string {
  const resolved = new URL(url, `${API_BASE_URL}/`);
  if (!['http:', 'https:'].includes(resolved.protocol)) throw new Error('资产地址无效。');
  return resolved.href;
}
