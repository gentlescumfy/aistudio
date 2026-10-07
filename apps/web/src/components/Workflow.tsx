import { ArrowDown, Bot, Check, Circle, FileText, Image, LoaderCircle, X, Workflow as WorkflowIcon } from 'lucide-react';
import { errorMessage, statusLabel, type Run, type RunNode, type Template, type WorkflowNode } from '../types';

const roleNames: Record<string, string> = {
  scriptwriter: '脚本编剧', 'storyboard-director': '分镜导演', 'continuity-reviewer': '连贯性审查员',
  editor: '剪辑审校', architect: '架构师', developer: '开发工程师', 'code-reviewer': '代码审查员',
};

function stageCopy(kind: string) {
  if (kind === 'prompt') return { input: '创作描述、生成数量', output: '填充后的提示词', task: '按模板整理创作描述，并把提示词交给后续步骤。' };
  if (kind === 'image') return { input: '上游提示词、尺寸与数量', output: '模拟 SVG 素材', task: '使用本地模拟器按指定规格生成素材，不调用图像模型。' };
  if (kind === 'export') return { input: '所有上游图像素材', output: '可预览、下载的素材清单', task: '汇总图像节点产物并提供给创作结果区。' };
  return { input: '上游步骤的输出', output: '当前步骤的结果', task: '执行工作流中的处理步骤。' };
}

export function Workflow({ run, template }: { run?: Run; template?: Template }) {
  const nodes: RunNode[] = run?.nodes || template?.nodes.map(node => ({ ...node, status: 'pending', attempts: 0 })) || [];
  const snapshot = run?.workflowSnapshot;
  const nodeSpecs = new Map<string, WorkflowNode>((snapshot?.nodes || []).map(node => [node.id, node]));
  const roleSnapshots = new Map((snapshot?.roleSnapshots || []).map(item => [item.nodeId, item.role]));
  const nextById = new Map<string, string[]>();
  for (const edge of snapshot?.edges || []) nextById.set(edge.source, [...(nextById.get(edge.source) || []), edge.target]);
  if (!snapshot?.edges.length) {
    for (const dependent of nodes) {
      for (const parentId of dependent.dependsOn || []) {
        nextById.set(parentId, [...(nextById.get(parentId) || []), dependent.id]);
      }
    }
  }
  const nameById = new Map(nodes.map(node => [node.id, node.name]));
  return <section className="panel workflow-panel" aria-labelledby="workflow-title">
    <div className="section-heading"><h2 id="workflow-title"><WorkflowIcon size={17} /> 工作流</h2><span>{nodes.length ? `${nodes.length} 个节点` : '等待选择模板'}</span></div>
    {nodes.length === 0 ? <p className="muted small">连接服务并选择模板后，这里将展示执行步骤。</p> : <ol className="workflow-nodes">
      {nodes.map((node, index) => {
        const state = node.status;
        const Icon = state === 'succeeded' ? Check : state === 'running' ? LoaderCircle : state === 'failed' || state === 'cancelled' ? X : Circle;
        const spec = nodeSpecs.get(node.id);
        const role = roleSnapshots.get(node.id);
        const copy = stageCopy(spec?.kind || node.kind);
        const next = (nextById.get(node.id) || []).map(id => nameById.get(id) || id);
        const kind = spec?.kind || node.kind;
        const AgentIcon = role ? Bot : kind === 'prompt' ? FileText : kind === 'image' ? Image : WorkflowIcon;
        return <li key={node.id} className={`workflow-node node-${state}`}>
          <span className="node-marker"><Icon size={16} aria-hidden="true" className={state === 'running' ? 'spin' : ''} /></span>
          <div className="workflow-node-content">
            <div className="workflow-node-heading"><span className="node-step">步骤 {String(index + 1).padStart(2, '0')}</span><span className={`workflow-owner-tag ${role ? 'is-role' : 'is-tool'}`}><AgentIcon size={12} />{role ? '代理职责快照' : '执行步骤'}</span></div>
            {role && <strong className="workflow-role-name">{roleNames[role.id] || role.name} · v{role.revision}</strong>}
            <strong>{node.name}</strong>
            <span className="workflow-task-copy">{role?.description || copy.task}</span>
            <div className="workflow-contract-copy"><span><b>输入</b>{role?.inputContract || copy.input}</span><span><b>交付</b>{role?.outputContract || copy.output}</span></div>
            <span className="node-state">{statusLabel[state]}{node.attempts > 0 ? ` · 第 ${node.attempts} 次尝试` : ''}</span>
            {next.length > 0 && <span className="workflow-handoff-copy"><ArrowDown size={12} />交接给 {next.join('、')}</span>}
            {role && <span className="workflow-runtime-boundary">角色只记录职责版本；此模拟流程没有调用代理或工具。</span>}
            {node.error && <p className="node-error">{errorMessage(node.error)}</p>}
          </div>
        </li>;
      })}
    </ol>}
    <p className="workflow-note">本地确定性模拟执行，费用为 ¥0。各节点的输入、交付和下一站会在这里显示。</p>
  </section>;
}
