import type { WorkflowDefinition, WorkflowEdge, WorkflowNode, WorkflowValidation } from './types';

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const allowedConnection = (source: WorkflowNode, target: WorkflowNode) =>
  source.kind === 'prompt' && (target.kind === 'prompt' || target.kind === 'image' || target.kind === 'export')
  || source.kind === 'image' && target.kind === 'export';

function reaches(from: string, to: string, edges: WorkflowEdge[]) {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const current = stack.pop()!;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    edges.filter(edge => edge.source === current).forEach(edge => stack.push(edge.target));
  }
  return false;
}

export function connectionIssue(nodes: WorkflowNode[], edges: WorkflowEdge[], sourceId: string | null, targetId: string | null): string | null {
  if (!sourceId || !targetId) return '请选择来源节点和目标节点。';
  if (sourceId === targetId) return '不能将节点连接到自身。';
  const source = nodes.find(node => node.id === sourceId);
  const target = nodes.find(node => node.id === targetId);
  if (!source || !target) return '连接引用了不存在的节点。';
  if (!allowedConnection(source, target)) return '连线只允许提示词→提示词/图像/导出、图像→导出。';
  if (edges.some(edge => edge.source === sourceId && edge.target === targetId)) return '这两个节点已经连接。';
  if (source.kind === 'prompt' && edges.filter(edge => edge.target === targetId).length >= 1) return '提示词和图像节点最多只能有一个上游节点。';
  if (reaches(targetId, sourceId, edges)) return '这条连线会形成循环。';
  return null;
}

export function validateWorkflowDefinition(definition: WorkflowDefinition): WorkflowValidation {
  const issues: WorkflowValidation['issues'] = [];
  const issue = (code: string, message: string, extras: { nodeId?: string; edgeId?: string } = {}) => issues.push({ code, message, ...extras });
  if (!definition.name.trim() || definition.name.trim().length > 80) issue('WORKFLOW_NAME', '名称必填，最多 80 个字符。');
  if (!definition.description.trim() || definition.description.trim().length > 1000) issue('WORKFLOW_DESCRIPTION', '说明必填，最多 1000 个字符。');
  if (definition.nodes.length > 20) issue('NODE_LIMIT', '工作流最多包含 20 个节点。');
  if (definition.edges.length > 40) issue('EDGE_LIMIT', '工作流最多包含 40 条连线。');
  const nodeIds = definition.nodes.map(node => node.id);
  const edgeIds = definition.edges.map(edge => edge.id);
  if (new Set(nodeIds).size !== nodeIds.length) issue('DUPLICATE_NODE_ID', '节点 ID 必须唯一。');
  if (new Set(edgeIds).size !== edgeIds.length) issue('DUPLICATE_EDGE_ID', '连线 ID 必须唯一。');
  for (const node of definition.nodes) {
    if (!idPattern.test(node.id) || node.id.length > 64) issue('NODE_ID', '节点 ID 须为 1–64 位小写字母、数字或连字符。', { nodeId: node.id });
    if (!node.name.trim() || node.name.length > 80) issue('NODE_NAME', '节点名称必填，最多 80 个字符。', { nodeId: node.id });
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y) || Math.abs(node.position.x) > 10000 || Math.abs(node.position.y) > 10000) issue('NODE_POSITION', '节点位置必须在 ±10000 范围内。', { nodeId: node.id });
    if (node.kind === 'prompt') {
      if (node.config.template.length > 6000) issue('PROMPT_TEMPLATE', '提示词模板最多 6000 个字符。', { nodeId: node.id });
      const placeholders = [...node.config.template.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map(match => match[1]);
      if (placeholders.some(name => name !== 'prompt' && name !== 'count')) issue('PROMPT_PLACEHOLDER', '提示词模板只支持 {{prompt}} 和 {{count}}。', { nodeId: node.id });
      if (node.config.roleRef && (!idPattern.test(node.config.roleRef.id) || !Number.isInteger(node.config.roleRef.revision) || node.config.roleRef.revision < 1)) issue('ROLE_REFERENCE', '角色引用格式无效。', { nodeId: node.id });
    } else if (node.kind === 'image') {
      if (!Number.isInteger(node.config.width) || node.config.width < 512 || node.config.width > 2048 || !Number.isInteger(node.config.height) || node.config.height < 512 || node.config.height > 2048) issue('IMAGE_SIZE', '图像宽高须为 512–2048 的整数。', { nodeId: node.id });
      if (node.config.count !== null && (!Number.isInteger(node.config.count) || node.config.count < 1 || node.config.count > 8)) issue('IMAGE_COUNT', '图像数量须为空或 1–8 的整数。', { nodeId: node.id });
    } else if (Object.keys(node.config).length !== 0) issue('EXPORT_CONFIG', '导出节点不接受配置字段。', { nodeId: node.id });
  }
  const nodeById = new Map(definition.nodes.map(node => [node.id, node]));
  const pairs = new Set<string>();
  for (const edge of definition.edges) {
    if (!idPattern.test(edge.id) || edge.id.length > 64) issue('EDGE_ID', '连线 ID 须为 1–64 位小写字母、数字或连字符。', { edgeId: edge.id });
    if (edge.source === edge.target) issue('SELF_LOOP', '不能将节点连接到自身。', { edgeId: edge.id });
    const pair = `${edge.source}\u0000${edge.target}`;
    if (pairs.has(pair)) issue('DUPLICATE_EDGE', '节点之间不能重复连线。', { edgeId: edge.id });
    pairs.add(pair);
    const source = nodeById.get(edge.source), target = nodeById.get(edge.target);
    if (!source || !target) { issue('DANGLING_EDGE', '连线引用了不存在的节点。', { edgeId: edge.id }); continue; }
    if (!allowedConnection(source, target)) issue('EDGE_KIND', '连线只允许提示词→提示词/图像、图像→导出。', { edgeId: edge.id });
  }
  const roots = definition.nodes.filter(node => !definition.edges.some(edge => edge.target === node.id));
  const terminals = definition.nodes.filter(node => !definition.edges.some(edge => edge.source === node.id));
  if (!roots.length) issue('ROOT_REQUIRED', '工作流至少需要一个没有上游连接的起始节点。');
  if (!terminals.length) issue('TERMINAL_REQUIRED', '工作流至少需要一个没有下游连接的终点节点。');
  for (const node of definition.nodes.filter(node => node.kind === 'prompt')) {
    if (definition.edges.filter(edge => edge.target === node.id).length > 1) issue('PROMPT_INPUTS', '提示词节点最多只能有一个上游提示词节点。', { nodeId: node.id });
  }
  for (const node of definition.nodes.filter(node => node.kind === 'image')) {
    const parents = definition.edges.filter(edge => edge.target === node.id);
    if (parents.length !== 1 || !parents.some(edge => nodeById.get(edge.source)?.kind === 'prompt')) issue('IMAGE_INPUT', '图像节点必须连接一个上游提示词节点。', { nodeId: node.id });
  }
  for (const node of definition.nodes.filter(node => node.kind === 'export')) {
    const parents = definition.edges.filter(edge => edge.target === node.id);
    if (!parents.length) issue('EXPORT_INPUT', '导出节点必须连接至少一个上游节点。', { nodeId: node.id });
  }
  for (const edge of definition.edges) if (reaches(edge.target, edge.source, definition.edges)) issue('CYCLE', '工作流不能包含循环。', { edgeId: edge.id });
  if (roots.length && terminals.length) {
    for (const node of definition.nodes) {
      const connected = definition.edges.some(edge => edge.source === node.id || edge.target === node.id);
      if (!connected && definition.nodes.length > 1) issue('DISCONNECTED', '节点没有与任何其他节点相连。', { nodeId: node.id });
      else {
        const fromRoot = roots.some(root => root.id === node.id || reaches(root.id, node.id, definition.edges));
        const toTerminal = terminals.some(terminal => terminal.id === node.id || reaches(node.id, terminal.id, definition.edges));
        if (!fromRoot || !toTerminal) issue('DISCONNECTED', '每个节点都必须从某个起始节点可达，并可到达某个终点节点。', { nodeId: node.id });
      }
    }
  }
  return { valid: issues.length === 0, issues, warnings: [] };
}
