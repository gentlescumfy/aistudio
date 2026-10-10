import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addEdge, applyEdgeChanges, applyNodeChanges, Background, Controls, Handle, Position, ReactFlow, type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import { Archive, Bot, Check, CircleAlert, Clock3, FileText, Image, LoaderCircle, Plus, RotateCcw, Save, ShieldAlert, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { ApiError, api } from '../api';
import { connectionIssue, validateWorkflowDefinition } from '../workflowUtils';
import type { Role, RoleLibrary, Workflow, WorkflowDefinition, WorkflowLibrary, WorkflowNode, WorkflowValidation } from '../types';

type FlowData = {
  spec: WorkflowNode; role: Role | null;
  task?: string; input?: string; output?: string; handoffs?: string[]; runtimeConfig?: string;
};
type FlowNode = Node<FlowData, WorkflowNode['kind']>;
type WorkflowViewMode = 'handoff' | 'canvas';
type DraftMetadata = { name: string; description: string };
type FlowSnapshot = { metadata: DraftMetadata; definition: WorkflowDefinition };

const clone = <T,>(value: T): T => structuredClone(value);
const formatDate = (value: string) => new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const nodeTitle = (kind: WorkflowNode['kind']) => kind === 'prompt' ? '提示词节点' : kind === 'image' ? '图像节点' : '导出节点';
const localRoleName = (role: Role) => ({ scriptwriter: '脚本编剧', 'storyboard-director': '分镜导演', 'continuity-reviewer': '连贯性审查员', editor: '剪辑审校', architect: '架构师', developer: '开发工程师', 'code-reviewer': '代码审查员' }[role.id] || role.name);

function CanvasNode({ data, selected }: NodeProps<FlowNode>) {
  const spec = data.spec;
  const Icon = spec.kind === 'prompt' ? (spec.config.executionMode === 'agent' ? Bot : FileText) : spec.kind === 'image' ? Image : Check;
  const details = stageDetails(spec);
  const task = data.task || (spec.kind === 'prompt' && spec.config.roleRef ? `角色 v${spec.config.roleRef.revision} 未解析；此步骤仍按本地提示词模板执行。` : details.task);
  const owner = data.role ? `${localRoleName(data.role)} · v${data.role.revision} · ${spec.kind === 'prompt' && spec.config.executionMode === 'agent' ? '实际调用' : '职责参考'}` : spec.kind === 'prompt' && spec.config.roleRef ? '角色版本未加载' : details.kind;
  const input = data.input || details.input;
  const output = data.output || details.output;
  const handoffs = data.handoffs || [];
  return <div className={`config-node config-node-${spec.kind} ${data.role ? 'has-agent-role' : ''} ${selected ? 'selected' : ''}`} title={`${task}\n接收：${input}\n交付：${output}`}>
    <Handle type="target" position={Position.Left} id="input" aria-label={`${spec.name} 输入端`} />
    <span className="config-node-icon"><Icon size={15} /></span><span className="config-node-copy">
      <strong>{spec.name}</strong><small>{owner}</small>
      <span className="config-node-task">{task}</span>
      <span className="config-node-contract"><b>接收</b>{input}</span>
      <span className="config-node-contract"><b>交付</b>{output}</span>
      <span className="config-node-runtime">{data.runtimeConfig || details.runtime}</span>
      <span className="config-node-handoff">{handoffs.length ? `交接给：${handoffs.join('、')}` : '交付终点'}</span>
    </span>
    <Handle type="source" position={Position.Right} id="output" aria-label={`${spec.name} 输出端`} />
  </div>;
}

const nodeTypes = { prompt: CanvasNode, image: CanvasNode, export: CanvasNode };

function stageDetails(spec: WorkflowNode, hasPromptParent = false) {
  if (spec.kind === 'prompt' && spec.config.executionMode === 'agent') return { kind: '代理文本调用', task: '使用角色系统提示词处理当前任务，并将真实模型文本交给下游步骤。', input: `${hasPromptParent ? '上游代理输出' : '创作描述'} · 请求数量`, output: '代理返回的文本结果', runtime: '单轮 OpenAI 兼容文本调用 · 不执行工具' };
  if (spec.kind === 'prompt') return { kind: '提示词模板', task: '按保存的模板整理输入，并将生成的文本交给后续步骤。', input: `${hasPromptParent ? '上游文本' : '创作描述'} · 请求数量`, output: '模板展开后的文本', runtime: '本地模板处理，不调用模型' };
  if (spec.kind === 'image') return { kind: '本地模拟工具', task: '根据上游提示词与尺寸设置生成 SVG 模拟素材。', input: '上游提示词 · 尺寸 · 数量', output: 'SVG 模拟素材', runtime: `${spec.config.width} × ${spec.config.height} · ${spec.config.count === null ? '沿用请求数量' : `${spec.config.count} 张`}` };
  return { kind: '本地交付工具', task: '汇总上游图像产物，供结果区预览和下载。', input: '所有上游图像产物', output: '可预览、下载的素材清单', runtime: '汇总全部上游图像节点产物' };
}

const mergeRoleCatalogs = (...catalogs: Role[][]) => {
  const merged = new Map<string, Role>();
  for (const role of catalogs.flat()) merged.set(`${role.id}@${role.revision}`, role);
  return [...merged.values()];
};

const compactContract = (value: string, maxLength = 25) => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
};

const roleModelSource = (role: Role) => {
  const selection = role.modelSelection.kind === 'inherit'
    ? '继承工作台默认路由'
    : `角色绑定 ${role.modelSelection.binding.providerId} / ${role.modelSelection.binding.accountId} / ${role.modelSelection.binding.modelId}`;
  const availability = role.modelStatus === 'unavailable' ? ' · 当前配置不可用' : '';
  return `${selection}${availability}`;
};

function orderedStages(nodes: FlowNode[], edges: Edge[]) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const indegree = new Map(nodes.map(node => [node.id, 0]));
  const targets = new Map<string, string[]>();
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
    targets.set(edge.source, [...(targets.get(edge.source) || []), edge.target]);
  }
  const compare = (left: FlowNode, right: FlowNode) => left.position.x - right.position.x || left.position.y - right.position.y;
  const ready = nodes.filter(node => indegree.get(node.id) === 0).sort(compare);
  const ordered: FlowNode[] = [];
  while (ready.length) {
    const node = ready.shift()!;
    ordered.push(node);
    for (const target of targets.get(node.id) || []) {
      const degree = (indegree.get(target) || 0) - 1;
      indegree.set(target, degree);
      if (degree === 0) ready.push(byId.get(target)!);
    }
    ready.sort(compare);
  }
  return [...ordered, ...nodes.filter(node => !ordered.some(item => item.id === node.id)).sort(compare)];
}

function WorkflowHandoffOverview({
  nodes, edges, selectedNodeId, onSelectNode,
}: {
  nodes: FlowNode[]; edges: Edge[];
  selectedNodeId: string | null; onSelectNode: (id: string) => void;
}) {
  const ordered = orderedStages(nodes, edges);
  const nodeById = new Map(nodes.map(node => [node.id, node]));

  return <section className="workflow-handoff-overview" aria-label="职责参考与模拟交接视图">
    <div className="workflow-overview-heading"><div><span className="workflow-overview-kicker">代理职责与数据交接</span><h2>每个代理做什么，真实输出交给谁</h2><p>选择任一步骤查看或编辑详情。卡片顺序按依赖关系排列。</p></div><span className="workflow-overview-count">{nodes.length} 个步骤 · {edges.length} 次交接</span></div>
    {ordered.length ? <ol className="workflow-handoff-list">{ordered.map((node, index) => {
      const spec = node.data.spec;
      const role = node.data.role;
      const roleRef = spec.kind === 'prompt' ? spec.config.roleRef : null;
      const hasPromptParent = edges.some(edge => edge.target === node.id);
      const details = stageDetails(spec, hasPromptParent);
      const handoffs = edges.filter(edge => edge.source === node.id).map(edge => nodeById.get(edge.target)?.data.spec.name || edge.target);
      const title = role ? localRoleName(role) : spec.name;
      return <li key={node.id}>
        <button type="button" className={`workflow-handoff-card ${selectedNodeId === node.id ? 'selected' : ''}`} aria-pressed={selectedNodeId === node.id} onClick={() => onSelectNode(node.id)}>
          <div className="workflow-handoff-card-heading"><span className="workflow-step-number">{String(index + 1).padStart(2, '0')}</span><span className={`workflow-step-kind ${roleRef ? 'role-reference' : ''}`}>{roleRef && spec.kind === 'prompt' && spec.config.executionMode === 'agent' ? '实际调用代理' : roleRef ? '职责模板' : details.kind}</span></div>
          <h3>{title}</h3><span className="workflow-stage-name">步骤名：{spec.name}{role && ` · 角色 v${role.revision}`}</span>
          <span className="workflow-stage-task-label">{spec.kind === 'prompt' && spec.config.executionMode === 'agent' ? '代理任务' : role || roleRef ? '角色职责' : '步骤职责'}</span>
          <p className="workflow-stage-task">{spec.kind === 'prompt' && spec.config.executionMode === 'agent' ? details.task : role?.description || (roleRef ? '此角色版本不可用；请检查角色历史或重新选择角色。' : details.task)}</p>
          <dl className="workflow-stage-contracts"><div><dt>接收</dt><dd title={details.input}>{details.input}</dd></div><div><dt>交付</dt><dd title={details.output}>{details.output}</dd></div></dl>
          {role && <dl className="workflow-stage-role-contracts"><div><dt>角色契约参考</dt><dd title={`接收：${role.inputContract}；交付：${role.outputContract}`}>接收：{role.inputContract} · 交付：{role.outputContract}</dd></div></dl>}
          <div className="workflow-handoff-destination"><span>{handoffs.length ? '交接给' : '交付终点'}</span><strong>{handoffs.length ? handoffs.join('、') : details.output}</strong></div>
          {roleRef && spec.kind === 'prompt' && spec.config.executionMode !== 'agent' && <span className="workflow-role-boundary">此步骤选择了模板处理，角色只提供职责说明；将执行本地模板。</span>}
        </button>
      </li>;
    })}</ol> : <div className="workflow-overview-empty"><WorkflowIcon size={20} /><strong>先添加一个步骤</strong><span>选择提示词、图像或导出节点，开始搭建流程。</span></div>}
    <p className="workflow-overview-boundary">运行方式：标记“实际调用代理”的提示词节点使用配置的文本模型；图像仍为本地 SVG 模拟，角色工具声明不执行。</p>
  </section>;
}

const fromDefinition = (definition: WorkflowDefinition): FlowSnapshot => ({
  metadata: { name: definition.name, description: definition.description },
  definition: clone(definition),
});
const resolveNodeRole = (spec: WorkflowNode, workflow: Workflow | null, roles: Role[]): Role | null => {
  if (spec.kind !== 'prompt' || !spec.config.roleRef) return null;
  const ref = spec.config.roleRef;
  return workflow?.roleSnapshots.find(item => item.nodeId === spec.id && item.role.id === ref.id && item.role.revision === ref.revision)?.role
    || roles.find(role => role.id === ref.id && role.revision === ref.revision)
    || null;
};
const toFlowNodes = (nodes: WorkflowNode[], workflow: Workflow | null, roles: Role[]): FlowNode[] => nodes.map(spec => ({
  id: spec.id, type: spec.kind, position: { ...spec.position }, data: { spec: clone(spec), role: resolveNodeRole(spec, workflow, roles) },
}));
const toDefinition = (metadata: DraftMetadata, nodes: FlowNode[], edges: Edge[]): WorkflowDefinition => ({
  name: metadata.name, description: metadata.description,
  nodes: nodes.map(node => ({ ...clone(node.data.spec), name: node.data.spec.name, position: { x: node.position.x, y: node.position.y } })) as WorkflowNode[],
  edges: edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target })),
});

export function WorkflowConfigPage() {
  const [library, setLibrary] = useState<WorkflowLibrary | null>(null);
  const [roles, setRoles] = useState<RoleLibrary | null>(null);
  const [historicalRoles, setHistoricalRoles] = useState<Role[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<WorkflowViewMode>('canvas');
  const [metadata, setMetadata] = useState<DraftMetadata>({ name: '', description: '' });
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [validation, setValidation] = useState<WorkflowValidation | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [statusFilter, setStatusFilter] = useState<'unarchived' | 'all' | Workflow['lifecycle']>('unarchived');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<Workflow[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const readController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const roleRevisionController = useRef<AbortController | null>(null);
  const historicalRolesRef = useRef<Role[]>([]);
  const selectedWorkflowRef = useRef<Workflow | null>(null);
  const baseSnapshot = useRef<FlowSnapshot | null>(null);

  const selected = library?.workflows.find(workflow => workflow.id === selectedId) || null;
  const definition = useMemo(() => toDefinition(metadata, nodes, edges), [metadata, nodes, edges]);
  const dirty = !!selected && !!baseSnapshot.current && JSON.stringify({ metadata, definition }) !== JSON.stringify(baseSnapshot.current);
  const currentNode = nodes.find(node => node.id === selectedNodeId) || null;
  const filteredWorkflows = (library?.workflows || []).filter(workflow => statusFilter === 'all' || (statusFilter === 'unarchived' ? workflow.lifecycle !== 'archived' : workflow.lifecycle === statusFilter));
  const roleOptions = useMemo(() => mergeRoleCatalogs(roles?.roles || [], historicalRoles), [roles, historicalRoles]);
  const canvasNodes = useMemo(() => {
    const nameById = new Map(nodes.map(node => [node.id, node.data.spec.name]));
    return nodes.map(node => {
      const spec = node.data.spec;
      const details = stageDetails(spec, edges.some(edge => edge.target === node.id));
      const task = spec.kind === 'prompt' && spec.config.executionMode === 'agent' ? details.task
        : node.data.role?.description || (spec.kind === 'prompt' && spec.config.roleRef
          ? `角色 v${spec.config.roleRef.revision} 未解析；此步骤仍按本地提示词模板执行。` : details.task);
      const handoffs = edges.filter(edge => edge.source === node.id).map(edge => nameById.get(edge.target) || edge.target);
      return { ...node, data: { ...node.data, task, input: details.input, output: details.output, handoffs, runtimeConfig: details.runtime } };
    });
  }, [nodes, edges]);
  const canvasEdges = useMemo(() => edges.map(edge => {
    const source = nodes.find(node => node.id === edge.source);
    const target = nodes.find(node => node.id === edge.target);
    if (!source || !target) return edge;
    const output = stageDetails(source.data.spec).output;
    const input = stageDetails(target.data.spec, edges.some(item => item.target === target.id)).input;
    return { ...edge, label: `${compactContract(output, 18)} → ${compactContract(input, 18)}` };
  }), [edges, nodes]);

  const newReadController = () => { readController.current?.abort(); const controller = new AbortController(); readController.current = controller; return controller; };
  const newWriteController = () => { writeController.current?.abort(); const controller = new AbortController(); writeController.current = controller; return controller; };
  const installWorkflow = (workflow: Workflow, availableRoles: Role[] = roles?.roles || []) => {
    roleRevisionController.current?.abort();
    selectedWorkflowRef.current = workflow;
    const snapshot = fromDefinition(workflow);
    baseSnapshot.current = clone(snapshot);
    const roleCatalog = mergeRoleCatalogs(availableRoles, historicalRolesRef.current);
    setSelectedId(workflow.id); setMetadata(snapshot.metadata); setNodes(toFlowNodes(workflow.nodes, workflow, roleCatalog));
    setEdges(workflow.edges.map(edge => ({ ...edge }))); setSelectedNodeId(workflow.nodes[0]?.id || null);
    setHistory(null); setHistoryOpen(false); setHistoryLoading(false); setValidation(null); setConnectionError(null); setError(null); setConflict(false);
  };
  const loadMissingRoleRevisions = (workflow: Workflow, availableRoles: Role[]) => {
    const roleCatalog = mergeRoleCatalogs(availableRoles, historicalRolesRef.current);
    const unresolvedRoleIds = [...new Set(workflow.nodes.flatMap(spec => {
      if (spec.kind !== 'prompt' || !spec.config.roleRef || resolveNodeRole(spec, workflow, roleCatalog)) return [];
      return [spec.config.roleRef.id];
    }))];
    if (!unresolvedRoleIds.length) return;

    roleRevisionController.current?.abort();
    const controller = new AbortController();
    roleRevisionController.current = controller;
    void Promise.all(unresolvedRoleIds.map(async id => {
      try { return (await api.roleRevisions(id, controller.signal)).revisions; }
      catch { return []; }
    })).then(revisionSets => {
      if (controller.signal.aborted || selectedWorkflowRef.current?.id !== workflow.id) return;
      const fetched = revisionSets.flat();
      historicalRolesRef.current = mergeRoleCatalogs(historicalRolesRef.current, fetched);
      setHistoricalRoles(historicalRolesRef.current);
      const updatedCatalog = mergeRoleCatalogs(availableRoles, historicalRolesRef.current);
      setNodes(current => current.map(node => ({
        ...node,
        data: { ...node.data, role: resolveNodeRole(node.data.spec, selectedWorkflowRef.current, updatedCatalog) },
      })));
    });
  };
  const load = async () => {
    if (busy) return;
    const controller = newReadController(); setLoading(true); setError(null); setConflict(false); setHistoryLoading(false);
    try {
      const [nextLibrary, roleLibrary] = await Promise.all([api.workflows(controller.signal), api.roles(controller.signal)]);
      if (controller.signal.aborted) return;
      setLibrary(nextLibrary); setRoles(roleLibrary);
      const next = nextLibrary.workflows.find(workflow => workflow.lifecycle === 'draft') || nextLibrary.workflows.find(workflow => workflow.lifecycle !== 'archived');
      if (next) { installWorkflow(next, roleLibrary.roles); loadMissingRoleRevisions(next, roleLibrary.roles); }
      else { roleRevisionController.current?.abort(); selectedWorkflowRef.current = null; setSelectedId(null); setMetadata({ name: '', description: '' }); setNodes([]); setEdges([]); baseSnapshot.current = null; }
    } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message || '工作流暂不可用。'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { readController.current?.abort(); writeController.current?.abort(); roleRevisionController.current?.abort(); }; }, []);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } };
    const guardNavigation = (event: MouseEvent) => {
      if ((!dirty && !busy) || !(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>('a[href^="#"]');
      if (!link || link.hash === '#workflow-canvas') return;
      event.preventDefault();
      if (busy) return;
      if (window.confirm('工作流有未保存的修改，离开会丢弃这些内容。确定离开吗？')) window.location.hash = link.hash;
    };
    window.addEventListener('beforeunload', beforeUnload); document.addEventListener('click', guardNavigation, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', guardNavigation, true); };
  }, [dirty, busy]);

  const confirmDiscard = () => !dirty || window.confirm('工作流有未保存的修改，继续会丢弃这些内容。确定继续吗？');
  const selectWorkflow = (workflow: Workflow) => {
    if (busy || !confirmDiscard()) return;
    readController.current?.abort();
    const availableRoles = mergeRoleCatalogs(roles?.roles || [], historicalRolesRef.current);
    installWorkflow(workflow, availableRoles);
    loadMissingRoleRevisions(workflow, availableRoles);
  };
  const updateNode = (id: string, updater: (node: WorkflowNode) => WorkflowNode) => {
    setNodes(current => current.map(node => {
      if (node.id !== id) return node;
      const spec = updater(clone(node.data.spec));
      return { ...node, data: { spec, role: resolveNodeRole(spec, selectedWorkflowRef.current, roleOptions) } };
    }));
    setValidation(null); setError(null);
  };
  const addNode = (kind: WorkflowNode['kind']) => {
    if (busy || nodes.length >= 20) return;
    const id = newId(kind);
    const position = { x: 80 + (nodes.length % 3) * 300, y: 75 + Math.floor(nodes.length / 3) * 190 };
    const spec: WorkflowNode = kind === 'prompt' ? { id, name: '提示词', kind, position, config: { template: '{{prompt}}', roleRef: null } }
      : kind === 'image' ? { id, name: '图像生成', kind, position, config: { width: 1024, height: 1024, count: null } }
        : { id, name: '导出', kind, position, config: {} };
    setNodes(current => [...current, { id, type: kind, position, data: { spec, role: null } }]);
    setSelectedNodeId(id); setValidation(null); setError(null);
  };
  const removeNode = (id: string) => {
    setNodes(current => current.filter(node => node.id !== id));
    setEdges(current => current.filter(edge => edge.source !== id && edge.target !== id));
    setSelectedNodeId(null); setValidation(null);
  };
  const removeEdge = (id: string) => { setEdges(current => current.filter(edge => edge.id !== id)); setValidation(null); };
  const makeEdge = (source: string, target: string): Edge => ({ id: newId('edge'), source, target, animated: false });
  const addConnection = () => {
    const issue = connectionIssue(definition.nodes, definition.edges, sourceId, targetId);
    if (issue) { setConnectionError(issue); return; }
    setEdges(current => [...current, makeEdge(sourceId, targetId)]); setConnectionError(null); setValidation(null);
  };
  const onConnect = useCallback((connection: Connection) => {
    setEdges(current => {
      const issue = connectionIssue(definition.nodes, current.map(edge => ({ id: edge.id, source: edge.source, target: edge.target })), connection.source, connection.target);
      if (issue) { setConnectionError(issue); return current; }
      setConnectionError(null); setValidation(null);
      return addEdge({ ...connection, id: newId('edge') }, current);
    });
  }, [definition.nodes]);
  const isValidConnection = useCallback((connection: Edge | Connection) => !connectionIssue(definition.nodes, definition.edges, connection.source, connection.target), [definition]);
  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const removed = changes.filter(change => change.type === 'remove').map(change => change.id);
    setNodes(current => applyNodeChanges(changes, current));
    if (removed.length) {
      setEdges(current => current.filter(edge => !removed.includes(edge.source) && !removed.includes(edge.target)));
      if (selectedNodeId && removed.includes(selectedNodeId)) setSelectedNodeId(null);
    }
  }, [selectedNodeId]);
  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => setEdges(current => applyEdgeChanges(changes, current)), []);

  const applyResponse = (workflow: Workflow, revision: number) => {
    setLibrary(current => current && ({ ...current, revision, workflows: current.workflows.some(item => item.id === workflow.id)
      ? current.workflows.map(item => item.id === workflow.id ? workflow : item) : [...current.workflows, workflow] }));
    const availableRoles = mergeRoleCatalogs(roles?.roles || [], historicalRolesRef.current);
    installWorkflow(workflow, availableRoles);
    loadMissingRoleRevisions(workflow, availableRoles);
  };
  const handleFailure = (failure: unknown, action: string) => {
    const apiFailure = failure as ApiError;
    if (apiFailure.status === 409) { setConflict(true); setError(`工作流目录版本已变化，当前草稿仍保留。重新加载后再${action}。`); }
    else setError(apiFailure.message || `${action}失败，请稍后重试。`);
  };
  const createWorkflow = async () => {
    if (!library || busy || !confirmDiscard()) return;
    const controller = newWriteController(); setBusy(true); setError(null); setConflict(false);
    try {
      const starter = clone(library.starterDefinition);
      const response = await api.createWorkflow(library.revision, starter, controller.signal);
      if (!controller.signal.aborted) applyResponse(response.workflow, response.revision);
    } catch (failure) { if (!controller.signal.aborted) handleFailure(failure, '创建'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const saveDraft = async () => {
    if (!library || !selected || busy || !dirty) return;
    const controller = newWriteController(); setBusy(true); setError(null); setConflict(false);
    try {
      const response = await api.updateWorkflow(selected.id, library.revision, definition, controller.signal);
      if (!controller.signal.aborted) applyResponse(response.workflow, response.revision);
    } catch (failure) { if (!controller.signal.aborted) handleFailure(failure, '保存'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const validate = async () => {
    if (busy) return;
    const local = validateWorkflowDefinition(definition);
    if (!local.valid) { setValidation(local); return; }
    const controller = newWriteController(); setBusy(true); setValidation(null); setError(null);
    try { setValidation(await api.validateWorkflow(definition, controller.signal)); }
    catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message || '验证工作流失败。'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const publish = async () => {
    if (!library || !selected || busy) return;
    if (dirty) { setError('请先保存工作流草稿，再发布当前修订。'); return; }
    if (!window.confirm(`发布“${selected.name}”当前修订？已开启“调用代理”的提示词节点会请求外部文本模型；图像节点仍生成本地 SVG 模拟素材。`)) return;
    const controller = newWriteController(); setBusy(true); setError(null); setConflict(false);
    try {
      const response = await api.publishWorkflow(selected.id, library.revision, controller.signal);
      if (!controller.signal.aborted) applyResponse(response.workflow, response.revision);
    } catch (failure) { if (!controller.signal.aborted) handleFailure(failure, '发布'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const archive = async () => {
    if (!library || !selected || busy || selected.lifecycle === 'archived') return;
    if (!window.confirm(`归档“${selected.name}”后将不再显示为可运行模板，修订历史和已有运行会保留。${dirty ? '当前未保存修改也会丢弃。' : ''}确定归档吗？`)) return;
    const controller = newWriteController(); setBusy(true); setError(null); setConflict(false);
    try {
      const response = await api.archiveWorkflow(selected.id, library.revision, controller.signal);
      if (!controller.signal.aborted) applyResponse(response.workflow, response.revision);
    } catch (failure) { if (!controller.signal.aborted) handleFailure(failure, '归档'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const reloadLatest = () => {
    if (busy || !confirmDiscard()) return;
    baseSnapshot.current = null; void load();
  };
  const toggleHistory = async () => {
    if (!selected || busy || historyLoading) return;
    if (historyOpen) { setHistoryOpen(false); return; }
    const controller = newReadController(); setHistoryOpen(true); setHistory(null); setHistoryLoading(true); setError(null);
    try { const response = await api.workflowRevisions(selected.id, controller.signal); if (!controller.signal.aborted) setHistory(response.revisions); }
    catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message || '读取工作流修订历史失败。'); }
    finally { if (!controller.signal.aborted) setHistoryLoading(false); }
  };

  const selectedRoleRef = currentNode?.data.spec.kind === 'prompt' ? currentNode.data.spec.config.roleRef : null;
  const selectedRoleValue = selectedRoleRef ? `${selectedRoleRef.id}@${selectedRoleRef.revision}` : '';
  const currentNodeDetails = currentNode ? stageDetails(currentNode.data.spec, edges.some(edge => edge.target === currentNode.id)) : null;
  const currentHandoffs = currentNode ? edges.filter(edge => edge.source === currentNode.id).map(edge => nodes.find(node => node.id === edge.target)?.data.spec.name || edge.target) : [];
  const currentModelSource = currentNode?.data.role ? `${roleModelSource(currentNode.data.role)}${currentNode.data.spec.kind === 'prompt' && currentNode.data.spec.config.executionMode === 'agent' ? ' · 单轮调用' : ' · 此节点未调用'}`
    : selectedRoleRef ? `角色 v${selectedRoleRef.revision} 未解析；不会改用其他修订。`
      : '本地模拟节点，不调用外部模型。';
  const updateMetadata = (key: keyof DraftMetadata, value: string) => { setMetadata(current => ({ ...current, [key]: value })); setValidation(null); };

  return <section className="workflow-config-page" aria-labelledby="workflow-config-title">
    <div className="page-heading workflow-config-heading"><div><div className="eyebrow">画布编排 · 代理与本地工具混合执行</div><h1 id="workflow-config-title">工作流画布</h1><p>为每个提示词步骤选择本地模板或真实代理；代理节点使用角色提示词，模型文本会传给下游。</p></div><span className="mock-badge"><WorkflowIcon size={13} />单轮文本代理</span></div>
    <div className="workflow-runtime-note" role="note"><ShieldAlert size={16} /><p>代理节点调用配置中心的 OpenAI 兼容文本模型；图像仍由本地 SVG 模拟。运行前需设置账号密钥环境变量并重启 API；角色声明的工具、循环和条件分支尚不执行，供应商可能按调用计费。</p></div>
    {error && <div className="inline-error workflow-error" role="alert">{error}{conflict && <button type="button" className="secondary-button" onClick={reloadLatest} disabled={busy}><RotateCcw size={14} />重新加载最新版本</button>}</div>}
    {loading ? <p className="workflow-loading" role="status"><LoaderCircle size={16} className="spin" />正在读取工作流与角色目录…</p> : !library || !roles ? <div className="workflow-load-error"><p>工作流服务暂不可用。</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw size={14} />重新连接</button></div> : <>
      <div className="workflow-library-toolbar">
        <label><span className="sr-only">工作流状态筛选</span><select aria-label="工作流状态筛选" value={statusFilter} onChange={event => setStatusFilter(event.target.value as typeof statusFilter)}><option value="unarchived">未归档</option><option value="all">全部状态</option><option value="draft">草稿</option><option value="published">已发布</option><option value="archived">已归档</option></select></label>
        <button type="button" className="secondary-button" onClick={reloadLatest} disabled={busy}><RotateCcw size={14} />刷新工作流</button>
        <button type="button" className="primary-button" onClick={() => void createWorkflow()} disabled={busy || library.workflows.length >= 64}><Plus size={15} />从起始模板新建</button>
      </div>
      <div className="workflow-editor-layout">
        <aside className="panel workflow-catalog" aria-label="工作流目录">
          <div className="workflow-catalog-heading"><div><strong>我的工作流</strong><span>{filteredWorkflows.length} 项 · 目录修订 {library.revision}</span></div><button type="button" className="icon-button" aria-label="刷新工作流" onClick={reloadLatest} disabled={busy}><RotateCcw size={14} /></button></div>
          {filteredWorkflows.length ? <ul>{filteredWorkflows.map(workflow => <li key={workflow.id}><button type="button" className={`workflow-catalog-item ${workflow.id === selectedId ? 'selected' : ''}`} aria-pressed={workflow.id === selectedId} onClick={() => selectWorkflow(workflow)} disabled={busy}><span><strong>{workflow.name}</strong><em className={`workflow-lifecycle lifecycle-${workflow.lifecycle}`}>{workflow.lifecycle === 'draft' ? '草稿' : workflow.lifecycle === 'published' ? '已发布' : '已归档'}</em></span><small>修订 v{workflow.revision}{workflow.publishedRevision ? ` · 已发布 v${workflow.publishedRevision}` : ''}</small></button></li>)}</ul> : <div className="workflow-catalog-empty"><WorkflowIcon size={20} /><strong>还没有自定义工作流</strong><span>起始模板包含咖啡新品上市全流程：简报、分镜、审查、出图和交付。</span></div>}
        </aside>
        <div className="workflow-editor-main">
          {selected ? <>
            <section className="panel workflow-metadata-form" aria-label="工作流信息">
              <div className="workflow-selected-heading"><div><span className={`workflow-lifecycle lifecycle-${selected.lifecycle}`}>{selected.lifecycle === 'draft' ? '草稿' : selected.lifecycle === 'published' ? '已发布' : '已归档'}</span><span className="workflow-revision">修订 v{selected.revision}</span></div><p>{selected.publishedRevision ? `当前可运行修订 v${selected.publishedRevision}` : '尚未发布'}</p></div>
              <div className="workflow-meta-fields"><label className="workflow-field">工作流名称<input aria-label="工作流名称" maxLength={80} value={metadata.name} onChange={event => updateMetadata('name', event.target.value)} disabled={busy || selected.lifecycle === 'archived'} /></label><label className="workflow-field">工作流说明<textarea aria-label="工作流说明" maxLength={1000} rows={2} value={metadata.description} onChange={event => updateMetadata('description', event.target.value)} disabled={busy || selected.lifecycle === 'archived'} /></label></div>
            </section>
            <div className="workflow-authoring-toolbar" aria-label="节点工具栏">
              <span>添加节点</span><button className="secondary-button" type="button" onClick={() => addNode('prompt')} disabled={busy || nodes.length >= 20 || selected.lifecycle === 'archived'}>＋提示词</button><button className="secondary-button" type="button" onClick={() => addNode('image')} disabled={busy || nodes.length >= 20 || selected.lifecycle === 'archived'}>＋图像</button><button className="secondary-button" type="button" onClick={() => addNode('export')} disabled={busy || nodes.length >= 20 || selected.lifecycle === 'archived'}>＋导出</button><span className="workflow-node-count">{nodes.length}/20 节点 · {edges.length}/40 连线</span>
            </div>
            <div className="workflow-view-switch" role="group" aria-label="工作流可视化方式">
              <button type="button" className={viewMode === 'canvas' ? 'active' : ''} aria-pressed={viewMode === 'canvas'} onClick={() => setViewMode('canvas')}>节点画布</button>
              <button type="button" className={viewMode === 'handoff' ? 'active' : ''} aria-pressed={viewMode === 'handoff'} onClick={() => setViewMode('handoff')}>代理职责与交接</button>
            </div>
            {viewMode === 'handoff' ? <WorkflowHandoffOverview nodes={nodes} edges={edges} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} /> :
              <div className={`workflow-canvas-shell ${busy ? 'is-busy' : ''}`} aria-label="工作流画布区域">
                <ReactFlow<FlowNode, Edge> nodes={canvasNodes} edges={canvasEdges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
                  onNodeClick={(_, node) => setSelectedNodeId(node.id)} onConnect={onConnect} isValidConnection={isValidConnection}
                  nodesDraggable={!busy && selected.lifecycle !== 'archived'} nodesConnectable={!busy && selected.lifecycle !== 'archived'} elementsSelectable={!busy}
                  deleteKeyCode={selected.lifecycle === 'archived' ? null : ['Backspace', 'Delete']} fitView minZoom={0.2} maxZoom={1.6} aria-label="工作流画布">
                  <Background gap={18} size={1} color="var(--canvas-dot)" /><Controls showInteractive={false} />
                </ReactFlow>
              </div>}
            <section className="panel workflow-connections" aria-labelledby="connections-title">
              <div className="workflow-section-title"><h2 id="connections-title">节点连线</h2><span>可拖动连接点，也可用表单键盘添加</span></div>
              <form className="workflow-connect-form" onSubmit={event => { event.preventDefault(); addConnection(); }}>
                <label>连线来源<select aria-label="连线来源" value={sourceId} onChange={event => setSourceId(event.target.value)}><option value="">选择来源节点</option>{nodes.map(node => <option key={node.id} value={node.id}>{node.data.spec.name}（{nodeTitle(node.data.spec.kind)}）</option>)}</select></label>
                <label>连线目标<select aria-label="连线目标" value={targetId} onChange={event => setTargetId(event.target.value)}><option value="">选择目标节点</option>{nodes.map(node => <option key={node.id} value={node.id}>{node.data.spec.name}（{nodeTitle(node.data.spec.kind)}）</option>)}</select></label>
                <button className="secondary-button" type="submit" disabled={busy || selected.lifecycle === 'archived'}>添加连线</button>
              </form>
              {connectionError && <p className="inline-error" role="alert">{connectionError}</p>}
              {edges.length ? <ul className="workflow-edge-list">{edges.map(edge => {
                const source = nodes.find(node => node.id === edge.source);
                const target = nodes.find(node => node.id === edge.target);
                const output = source ? stageDetails(source.data.spec).output : '上游结果';
                const input = target ? stageDetails(target.data.spec, edges.some(item => item.target === target.id)).input : '下游输入';
                const summary = `${source?.data.spec.name || edge.source} · ${output} → ${target?.data.spec.name || edge.target} · ${input}`;
                return <li key={edge.id}><span title={summary}>{summary}</span><button type="button" className="text-button" aria-label={`删除连线 ${edge.id}`} onClick={() => removeEdge(edge.id)} disabled={busy || selected.lifecycle === 'archived'}><Trash2 size={13} />删除</button></li>;
              })}</ul> : <p className="muted small">还没有连线。</p>}
            </section>
            <div className="workflow-savebar"><p role="status">{dirty ? '有未保存的修改' : '当前修订已保存'} · 发布后按各提示词节点的执行方式运行</p><button type="button" className="secondary-button" onClick={() => void validate()} disabled={busy}><Check size={14} />验证工作流</button><button type="button" className="primary-button" onClick={() => void saveDraft()} disabled={busy || !dirty || selected.lifecycle === 'archived'}>{busy ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}保存草稿</button><button type="button" className="primary-button" onClick={() => void publish()} disabled={busy || selected.lifecycle === 'archived'}>发布工作流</button><button type="button" className="secondary-button destructive-icon" onClick={() => void archive()} disabled={busy || selected.lifecycle === 'archived'}><Archive size={14} />归档工作流</button></div>
            {validation && <section className={`workflow-validation ${validation.valid ? 'valid' : 'invalid'}`} aria-label="工作流验证结果" role="region"><h2>{validation.valid ? '验证通过' : `发现 ${validation.issues.length} 项问题`}</h2>{validation.issues.length > 0 && <ul>{validation.issues.map((issue, index) => <li key={`${issue.code}-${issue.nodeId || issue.edgeId || index}`}><CircleAlert size={14} /><span>{issue.message}{issue.nodeId ? `（节点 ${nodes.find(node => node.id === issue.nodeId)?.data.spec.name || issue.nodeId}）` : ''}</span></li>)}</ul>}{validation.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</section>}
            {currentNode && currentNodeDetails && <section className="panel workflow-node-inspector" aria-label="节点配置"><div className="workflow-section-title"><h2>节点配置</h2><span>{nodeTitle(currentNode.data.spec.kind)}</span></div>
              <section className="workflow-node-brief" aria-label="职责与数据交接">
                <div className="workflow-brief-owner"><strong>{currentNode.data.role ? `${localRoleName(currentNode.data.role)} · v${currentNode.data.role.revision}` : currentNodeDetails.kind}</strong><span>{currentNode.data.spec.kind === 'prompt' && currentNode.data.spec.config.executionMode === 'agent' ? '实际调用代理' : currentNode.data.role ? '角色职责模板' : '本地步骤'}</span></div>
                <p>{currentNode.data.spec.kind === 'prompt' && currentNode.data.spec.config.executionMode === 'agent' ? currentNodeDetails.task : currentNode.data.role?.description || (selectedRoleRef ? `引用的角色 v${selectedRoleRef.revision} 未找到；不会回退到其他版本。` : currentNodeDetails.task)}</p>
                <dl><div><dt>接收</dt><dd title={currentNodeDetails.input}>{currentNodeDetails.input}</dd></div><div><dt>交付</dt><dd title={currentNodeDetails.output}>{currentNodeDetails.output}</dd></div><div><dt>执行方式</dt><dd title={currentNodeDetails.runtime}>{currentNodeDetails.runtime}</dd></div><div><dt>交接对象</dt><dd>{currentHandoffs.length ? currentHandoffs.join('、') : '工作流交付终点'}</dd></div><div><dt>模型来源</dt><dd>{currentModelSource}</dd></div>
                  {currentNode.data.role && <div className="workflow-role-contract"><dt>角色契约参考</dt><dd title={`接收：${currentNode.data.role.inputContract}；交付：${currentNode.data.role.outputContract}`}>接收：{currentNode.data.role.inputContract} · 交付：{currentNode.data.role.outputContract}</dd></div>}
                </dl>
                <small>{currentNode.data.spec.kind === 'prompt' && currentNode.data.spec.config.executionMode === 'agent' ? '将角色系统提示词、输入/输出契约和节点任务一起发送给文本模型；声明的工具不会执行。' : '选择“调用代理”后，该角色才会参与运行；默认路由和账号密钥在配置中心维护。'}</small>
              </section>
              <label className="workflow-field">节点名称<input aria-label="节点名称" maxLength={80} value={currentNode.data.spec.name} onChange={event => updateNode(currentNode.id, node => ({ ...node, name: event.target.value }))} disabled={busy || selected.lifecycle === 'archived'} /></label>
              {currentNode.data.spec.kind === 'prompt' && <div className="workflow-node-config-grid">
                <label className="workflow-field">执行方式<select aria-label="提示词节点执行方式" value={currentNode.data.spec.config.executionMode || 'template'} onChange={event => updateNode(currentNode.id, node => node.kind === 'prompt' ? { ...node, config: { ...node.config, executionMode: event.target.value as 'template' | 'agent' } } : node)} disabled={busy || selected.lifecycle === 'archived'}><option value="template">本地模板处理</option><option value="agent">调用代理角色</option></select><small>代理调用会发送角色提示词和任务到已配置模型，并可能产生费用。</small></label>
                <label className="workflow-field workflow-field-wide">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>提示词模板</span>
                    <span style={{ display: 'flex', gap: '4px' }}>
                      <button type="button" className="text-button" onClick={() => updateNode(currentNode.id, node => node.kind === 'prompt' ? { ...node, config: { ...node.config, template: node.config.template + '{{ directive }}' } } : node)} disabled={busy || selected.lifecycle === 'archived'} style={{ fontSize: '0.8em', padding: '0 4px' }}>+ 行动指南</button>
                      <button type="button" className="text-button" onClick={() => updateNode(currentNode.id, node => node.kind === 'prompt' ? { ...node, config: { ...node.config, template: node.config.template + '{{ handoff.summary }}' } } : node)} disabled={busy || selected.lifecycle === 'archived'} style={{ fontSize: '0.8em', padding: '0 4px' }}>+ 上游总结</button>
                      <button type="button" className="text-button" onClick={() => updateNode(currentNode.id, node => node.kind === 'prompt' ? { ...node, config: { ...node.config, template: node.config.template + '{{ handoff.roleName }}' } } : node)} disabled={busy || selected.lifecycle === 'archived'} style={{ fontSize: '0.8em', padding: '0 4px' }}>+ 上游角色</button>
                    </span>
                  </div>
                  <textarea aria-label="提示词模板" maxLength={6000} rows={5} value={currentNode.data.spec.config.template} onChange={event => updateNode(currentNode.id, node => node.kind === 'prompt' ? { ...node, config: { ...node.config, template: event.target.value } } : node)} disabled={busy || selected.lifecycle === 'archived'} />
                  <small>支持 {'{{prompt}}'}、{'{{count}}'} 及协作变量 {'{{ directive }}'}、{'{{ handoff.summary }}'}、{'{{ handoff.roleName }}'}。</small>
                </label>
                <label className="workflow-field">角色引用版本<select aria-label="角色引用版本" value={selectedRoleValue} onChange={event => {
                  const [id, rev] = event.target.value.split('@');
                  const roleRef = id && rev ? { id, revision: Number(rev) } : null;
                  updateNode(currentNode.id, node => node.kind === 'prompt' ? { ...node, config: { ...node.config, roleRef } } : node);
                }} disabled={busy || selected.lifecycle === 'archived'}><option value="">不引用角色</option>{roleOptions.map(role => <option key={`${role.id}-${role.revision}`} value={`${role.id}@${role.revision}`} disabled={role.lifecycle === 'archived'}>{localRoleName(role)} · v{role.revision}{role.lifecycle === 'archived' ? '（已归档）' : ''}</option>)}</select><small>{currentNode.data.spec.config.executionMode === 'agent' ? '角色快照决定系统提示词、模型绑定和输入输出契约。' : '本地模板步骤会保存角色快照，但不会调用模型。'}</small></label>
              </div>}
              {currentNode.data.spec.kind === 'image' && <div className="workflow-node-config-grid"><label className="workflow-field">图像宽度<input aria-label="图像宽度" type="number" min={512} max={2048} step={1} value={currentNode.data.spec.config.width} onChange={event => updateNode(currentNode.id, node => node.kind === 'image' ? { ...node, config: { ...node.config, width: event.target.valueAsNumber } } : node)} disabled={busy || selected.lifecycle === 'archived'} /></label><label className="workflow-field">图像高度<input aria-label="图像高度" type="number" min={512} max={2048} step={1} value={currentNode.data.spec.config.height} onChange={event => updateNode(currentNode.id, node => node.kind === 'image' ? { ...node, config: { ...node.config, height: event.target.valueAsNumber } } : node)} disabled={busy || selected.lifecycle === 'archived'} /></label><label className="workflow-field">图像数量覆盖<select aria-label="图像数量覆盖" value={currentNode.data.spec.config.count ?? 'inherit'} onChange={event => updateNode(currentNode.id, node => node.kind === 'image' ? { ...node, config: { ...node.config, count: event.target.value === 'inherit' ? null : Number(event.target.value) } } : node)} disabled={busy || selected.lifecycle === 'archived'}><option value="inherit">沿用创作请求数量</option>{Array.from({ length: 8 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} 张</option>)}</select></label></div>}
              {currentNode.data.spec.kind === 'export' && <p className="workflow-export-note">汇总全部上游图像节点的产物数量；导出节点不含可编辑参数。</p>}
              <button type="button" className="secondary-button destructive-icon" onClick={() => removeNode(currentNode.id)} disabled={busy || selected.lifecycle === 'archived'}><Trash2 size={14} />删除节点及相关连线</button>
            </section>}
            <div className="workflow-history-controls"><button type="button" className="secondary-button" onClick={() => void toggleHistory()} disabled={busy || historyLoading}><Clock3 size={14} />{historyOpen ? '隐藏修订历史' : '查看修订历史'}</button></div>
            {historyOpen && <section className="panel workflow-history" aria-label="工作流修订历史" role="region"><h2>工作流修订历史</h2>{historyLoading ? <p role="status">正在加载历史…</p> : !history?.length ? <p>没有可显示的修订记录。</p> : <ol>{history.map(revision => <li key={`${revision.id}-${revision.revision}`}><details><summary><span>v{revision.revision} · {revision.name}</span><span>{revision.lifecycle === 'published' ? '已发布' : revision.lifecycle === 'archived' ? '已归档' : '草稿'}</span><span>{formatDate(revision.updatedAt)}</span></summary><p>{revision.description}</p><p>{revision.nodes.length} 个节点 · {revision.edges.length} 条连线{revision.publishedRevision ? ` · 发布修订 v${revision.publishedRevision}` : ''}</p></details></li>)}</ol>}</section>}
          </> : <section className="panel workflow-empty-state"><WorkflowIcon size={25} /><h2>创建第一个工作流</h2><p>从咖啡新品上市案例起步：脚本编剧整理卖点，分镜导演规划镜头，连续性审查员修正提示词，再生成并交付主视觉。</p><button className="primary-button" type="button" onClick={() => void createWorkflow()} disabled={busy || library.workflows.length >= 64}><Plus size={15} />从起始模板新建</button></section>}
        </div>
      </div>
    </>}
  </section>;
}
