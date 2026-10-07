import type { ModelBinding, Role, RoleCategory, RoleDefinition, SettingsResponse, StudioSettings, ToolDeclaration } from './types';

export const roleCategoryLabels: Record<RoleCategory, string> = {
  media: '媒体创作', engineering: '工程研发', operations: '运营协作', custom: '自定义',
};
export const roleCategoryOptions: RoleCategory[] = ['media', 'engineering', 'operations', 'custom'];
export const lifecycleLabels = { draft: '草稿', published: '已发布模板', archived: '已归档' } as const;
export const toolRiskLabels = { read: '读取声明', generate: '生成声明', write: '写入声明' } as const;
export const emptyRoleDefinition = (): RoleDefinition => ({
  name: '', category: 'custom', description: '', systemPrompt: '', inputContract: '', outputContract: '', tools: [],
  modelSelection: { kind: 'inherit' }, limits: { maxSteps: 8, maxToolCalls: 20, deadlineMs: 120000, maxCost: 1 },
});

export function roleDefinition(role: Role): RoleDefinition {
  return {
    name: role.name, category: role.category, description: role.description, systemPrompt: role.systemPrompt,
    inputContract: role.inputContract, outputContract: role.outputContract, tools: [...role.tools],
    modelSelection: role.modelSelection.kind === 'inherit' ? { kind: 'inherit' } : { kind: 'binding', binding: { ...role.modelSelection.binding } },
    limits: { ...role.limits },
  };
}

export const bindingValue = (binding: ModelBinding) => `${binding.providerId}/${binding.accountId}/${binding.modelId}`;
export function modelBindingOptions(settings: StudioSettings) {
  return settings.models.flatMap(model => {
    const account = settings.accounts.find(item => item.id === model.accountId);
    const provider = account && settings.providers.find(item => item.id === account.providerId);
    if (!account?.enabled || !provider || !model.capabilities.some(capability => capability === 'text' || capability === 'code')) return [];
    const binding = { providerId: provider.id, accountId: account.id, modelId: model.id };
    return [{ value: bindingValue(binding), binding, label: `${provider.name} / ${account.label} / ${model.name || model.externalId}` }];
  });
}
export function resolveBinding(settings: StudioSettings, binding: ModelBinding) {
  const account = settings.accounts.find(item => item.id === binding.accountId && item.providerId === binding.providerId);
  const provider = settings.providers.find(item => item.id === binding.providerId);
  const model = settings.models.find(item => item.id === binding.modelId && item.accountId === binding.accountId);
  const capable = !!model?.capabilities.some(capability => capability === 'text' || capability === 'code');
  const label = [provider?.name || binding.providerId, account?.label || binding.accountId, model?.name || model?.externalId || binding.modelId].join(' / ');
  return { available: !!account?.enabled && capable, label, account, model, provider };
}
export function modelStatusLabel(role: Role, settings: SettingsResponse['settings']) {
  if (role.modelSelection.kind === 'inherit') return settings.routes.text
    ? `继承工作区默认：${resolveBinding(settings, settings.routes.text).label}`
    : '继承工作区默认 · 尚未配置文本路由';
  const resolved = resolveBinding(settings, role.modelSelection.binding);
  if (role.modelStatus === 'unavailable' || !resolved.available) return `绑定不可用 · ${resolved.label}`;
  return `角色指定模型 · ${resolved.label}`;
}

export function validateRoleDefinition(role: RoleDefinition, tools: ToolDeclaration[], settings: StudioSettings): string | null {
  if (!role.name.trim() || role.name.trim().length > 80) return '角色名称必填，最多 80 个字符。';
  if (!role.description.trim() || role.description.trim().length > 1000) return '角色描述必填，最多 1000 个字符。';
  if (!role.systemPrompt.trim() || role.systemPrompt.length > 6000) return 'Persona 必填，最多 6000 个字符。';
  if (!role.inputContract.trim() || role.inputContract.length > 4000) return '输入契约说明必填，最多 4000 个字符。';
  if (!role.outputContract.trim() || role.outputContract.length > 4000) return '输出契约说明必填，最多 4000 个字符。';
  if (new Set(role.tools).size !== role.tools.length || role.tools.some(id => !tools.some(tool => tool.id === id))) return '工具声明包含重复或目录中不存在的工具。';
  const { maxSteps, maxToolCalls, deadlineMs, maxCost } = role.limits;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) return '最大步骤数需为 1–100 的整数。';
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 0 || maxToolCalls > 1000) return '最大工具调用数需为 0–1000 的整数。';
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 3600000) return '截止时间需为 1000–3600000 毫秒的整数。';
  if (!Number.isFinite(maxCost) || maxCost < 0 || maxCost > 1000) return '预算上限需为 0–1000。';
  if (role.modelSelection.kind === 'binding' && !resolveBinding(settings, role.modelSelection.binding).available) return '角色模型绑定已失效。请选择其他启用的文本/代码模型，或改为继承工作区默认。';
  return null;
}

export function newRoleLabel(role: Role, index = 0) { return role.name || `${role.builtIn ? '内置角色' : '自定义角色'} ${index + 1}`; }
