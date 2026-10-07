export type Category = 'image' | 'video' | 'coding';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type NodeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface TemplateNode { id: string; name: string; kind: string }
export interface Template {
  id: string; name: string; description: string; category: Category;
  enabled: boolean; nodes: TemplateNode[];
  source?: 'builtin' | 'workflow'; workflowRevision?: number;
}
export interface Inputs { prompt: string; count: number }
export type Protocol = 'openai-compatible' | 'anthropic' | 'google';
export type Capability = 'text' | 'code' | 'image' | 'video' | 'audio';
export interface ProviderConfig {
  id: string; name: string; transport: 'api' | 'local'; protocol: Protocol; baseUrl: string;
}
export interface AccountConfig {
  id: string; providerId: string; label: string; secretEnv: string; enabled: boolean;
}
export interface ModelConfig {
  id: string; accountId: string; externalId: string; name: string;
  capabilities: Capability[]; pinned: boolean;
}
export interface ModelBinding { providerId: string; accountId: string; modelId: string }
export type RoleCategory = 'media' | 'engineering' | 'operations' | 'custom';
export type RoleLifecycle = 'draft' | 'published' | 'archived';
export interface RoleLimits { maxSteps: number; maxToolCalls: number; deadlineMs: number; maxCost: number }
export type RoleModelSelection = { kind: 'inherit' } | { kind: 'binding'; binding: ModelBinding };
export interface RoleDefinition {
  name: string; category: RoleCategory; description: string; systemPrompt: string;
  inputContract: string; outputContract: string; tools: string[];
  modelSelection: RoleModelSelection; limits: RoleLimits;
}
export interface Role extends RoleDefinition {
  id: string; revision: number; builtIn: boolean; lifecycle: RoleLifecycle;
  createdAt: string; updatedAt: string; modelStatus: 'inherit' | 'configured' | 'unavailable';
}
export interface ToolDeclaration { id: string; name: string; description: string; risk: 'read' | 'generate' | 'write'; executable: false }
export interface RoleLibrary { revision: number; roles: Role[]; tools: ToolDeclaration[]; runtime: { enabled: false; mode: 'metadata-only' } }
export interface RoleMutationResponse { revision: number; role: Role }
export interface RoleRevisionsResponse { revisions: Role[] }
export interface RoleRef { id: string; revision: number }
export interface WorkflowPosition { x: number; y: number }
export interface WorkflowNodeBase { id: string; name: string; position: WorkflowPosition }
export type WorkflowNode =
  | (WorkflowNodeBase & { kind: 'prompt'; config: { template: string; roleRef: RoleRef | null } })
  | (WorkflowNodeBase & { kind: 'image'; config: { width: number; height: number; count: number | null } })
  | (WorkflowNodeBase & { kind: 'export'; config: Record<string, never> });
export interface WorkflowEdge { id: string; source: string; target: string }
export interface WorkflowDefinition { name: string; description: string; nodes: WorkflowNode[]; edges: WorkflowEdge[] }
export interface RoleSnapshot { nodeId: string; role: Role }
export interface Workflow extends WorkflowDefinition {
  id: string; revision: number; lifecycle: 'draft' | 'published' | 'archived';
  publishedRevision: number | null; createdAt: string; updatedAt: string;
  roleSnapshots: RoleSnapshot[];
}
export interface GraphIssue { code: string; message: string; nodeId?: string; edgeId?: string }
export interface WorkflowValidation { valid: boolean; issues: GraphIssue[]; warnings: string[] }
export interface WorkflowLibrary {
  revision: number; workflows: Workflow[]; starterDefinition: WorkflowDefinition;
  runtime: { mode: 'mock'; executableKinds: ['prompt', 'image', 'export']; agentExecutionEnabled: false };
}
export interface WorkflowMutationResponse { revision: number; workflow: Workflow }
export interface WorkflowRevisionsResponse { revisions: Workflow[] }
export type LangflowAuthMode = 'local-development' | 'api-key-env';
export interface LangflowConfig { baseUrl: string; authMode: LangflowAuthMode; secretEnv: string; timeoutMs: number }
export interface LangflowConfigResponse { revision: number; config: LangflowConfig; credentialConfigured: boolean }
export interface LangflowStatus { connected: boolean; version: string | null; editorUrl: string; authMode: LangflowAuthMode; message: string }
export interface LangflowFlow { id: string; name: string; description: string; updatedAt: string | null }
export type LangflowRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'outcome_unknown';
export interface LangflowRun {
  id: string; flowId: string; flowName: string; input: string; status: LangflowRunStatus;
  createdAt: string; updatedAt: string; output: string | null; error: string | null; provider: 'langflow';
}
export interface LangflowConfigMutation { revision: number; config: LangflowConfig }
export interface LangflowRunMutation { flowId: string; input: string; idempotencyKey: string }
export type ImageRoute = 'mock-svg' | ModelBinding;
export interface StudioSettings {
  defaultCount: number; providers: ProviderConfig[]; accounts: AccountConfig[]; models: ModelConfig[];
  routes: { text: ModelBinding | null; image: ImageRoute; video: ModelBinding | null };
}
export interface SettingsResponse {
  schemaVersion: 2;
  revision: number; settings: StudioSettings;
  runtime: { mode: 'mock'; activeImageModel: 'mock-svg'; externalProvidersEnabled: false };
  credentials: { accountId: string; configured: boolean }[];
}
export interface RunNode extends TemplateNode {
  status: NodeStatus; attempts: number; error?: string | { code?: string; message: string };
  config?: WorkflowNode['config']; dependsOn?: string[]; outputPrompt?: string;
}
export interface Asset {
  id: string; runId: string; nodeId: string; name: string; mimeType: string;
  url: string; width: number; height: number; mode: 'mock';
}
export interface Run {
  id: string; templateId: string; status: RunStatus; inputs: Inputs;
  createdAt: string; updatedAt: string; mode: 'mock'; nodes: RunNode[]; assets: Asset[];
  estimatedCost: number; actualCost: number;
  error?: string | { code?: string; message: string };
  workflowSnapshot?: Workflow; expectedAssetCount?: number;
}
export const statusLabel: Record<RunStatus | NodeStatus, string> = {
  queued: '排队中', pending: '等待执行', running: '执行中', succeeded: '已完成',
  failed: '执行失败', cancelled: '已取消',
};
export const isActive = (run: Run) => run.status === 'queued' || run.status === 'running';
export const errorMessage = (error: Run['error']) => typeof error === 'string' ? error : error?.message;
