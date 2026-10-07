import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { WorkflowConfigPage } from './WorkflowConfigPage';
import type { Workflow, WorkflowDefinition, WorkflowLibrary, WorkflowMutationResponse, WorkflowRevisionsResponse } from '../types';

vi.mock('@xyflow/react', () => ({
  addEdge: (edge: unknown, edges: unknown[]) => [...edges, edge],
  applyEdgeChanges: (_changes: unknown[], edges: unknown[]) => edges,
  applyNodeChanges: (_changes: unknown[], nodes: unknown[]) => nodes,
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  ReactFlow: (props: { nodes: Array<{ id: string; data: { spec: { name: string } } }>; onNodeClick?: (event: unknown, node: unknown) => void }) => <div aria-label="工作流画布">{props.nodes.map(node => <button key={node.id} type="button" onClick={() => props.onNodeClick?.({}, node)}>{node.data.spec.name}</button>)}</div>,
}));

const definition: WorkflowDefinition = {
  name: '图像创作起点', description: '提示词连接图像生成并导出。',
  nodes: [
    { id: 'prompt-main', name: '创意提示词', kind: 'prompt', position: { x: 40, y: 60 }, config: { template: '{{prompt}}', roleRef: null } },
    { id: 'image-main', name: '图像生成', kind: 'image', position: { x: 290, y: 60 }, config: { width: 1024, height: 1024, count: null } },
    { id: 'export-main', name: '导出素材', kind: 'export', position: { x: 540, y: 60 }, config: {} },
  ],
  edges: [{ id: 'edge-one', source: 'prompt-main', target: 'image-main' }, { id: 'edge-two', source: 'image-main', target: 'export-main' }],
};
const initialLibrary: WorkflowLibrary = {
  revision: 4, workflows: [], starterDefinition: definition,
  runtime: { mode: 'mock', executableKinds: ['prompt', 'image', 'export'], agentExecutionEnabled: false },
};
const makeWorkflow = (patch: Partial<Workflow> = {}): Workflow => ({
  ...structuredClone(definition), id: '8bb3500d-0734-48e8-81c5-96c5131ecfc9', revision: 1, lifecycle: 'draft', publishedRevision: null,
  createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z', roleSnapshots: [], ...patch,
});

describe('工作流配置页面', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.spyOn(api, 'workflows').mockResolvedValue(structuredClone(initialLibrary));
    vi.spyOn(api, 'roles').mockResolvedValue({ revision: 1, roles: [], tools: [], runtime: { enabled: false, mode: 'metadata-only' } });
  });

  it('从服务端起始图创建草稿，保存纯契约字段并读取修订历史', async () => {
    const user = userEvent.setup();
    const created = makeWorkflow({ name: '新的图像工作流', description: '从品牌图像工作流起步，可调整节点与参数。' });
    const createSpy = vi.spyOn(api, 'createWorkflow').mockResolvedValue({ revision: 5, workflow: created });
    const updateSpy = vi.spyOn(api, 'updateWorkflow').mockImplementation(async (_id, _revision, saved) => ({ revision: 6, workflow: makeWorkflow({ ...saved, revision: 2 }) } as WorkflowMutationResponse));
    const historySpy = vi.spyOn(api, 'workflowRevisions').mockResolvedValue({ revisions: [created] } as WorkflowRevisionsResponse);
    render(<WorkflowConfigPage />);

    expect(await screen.findByText(/真实代理、条件分支、循环/)).toBeVisible();
    await user.click(screen.getAllByRole('button', { name: '从起始模板新建' })[0]!);
    expect(await screen.findByLabelText('工作流名称')).toHaveValue('新的图像工作流');
    expect(createSpy).toHaveBeenCalledWith(4, expect.objectContaining({ name: '新的图像工作流', nodes: definition.nodes, edges: definition.edges }), expect.any(AbortSignal));
    expect(screen.getByLabelText('连线来源')).toBeVisible();

    await user.clear(screen.getByLabelText('工作流名称'));
    await user.type(screen.getByLabelText('工作流名称'), '春季品牌图像');
    await user.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    const saved = updateSpy.mock.calls[0]![2];
    expect(saved.name).toBe('春季品牌图像');
    expect(saved.nodes[0]).toMatchObject({ id: 'prompt-main', position: { x: 40, y: 60 }, config: { template: '{{prompt}}' } });
    expect(saved.nodes[0]).not.toHaveProperty('selected');
    expect(saved.edges[0]).not.toHaveProperty('sourceHandle');

    await user.click(screen.getByRole('button', { name: '查看修订历史' }));
    expect(await screen.findByRole('region', { name: '工作流修订历史' })).toHaveTextContent('新的图像工作流');
    expect(historySpy).toHaveBeenCalledWith(created.id, expect.any(AbortSignal));
  });

  it('取消 dirty 刷新确认时保留工作流草稿且不发起重载', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'createWorkflow').mockResolvedValue({ revision: 5, workflow: makeWorkflow() });
    const workflowsSpy = vi.mocked(api.workflows);
    render(<WorkflowConfigPage />);
    await user.click((await screen.findAllByRole('button', { name: '从起始模板新建' }))[0]!);
    const name = screen.getByLabelText('工作流名称');
    await user.clear(name); await user.type(name, '仍保留的草稿');
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await user.click(screen.getAllByRole('button', { name: '刷新工作流' })[0]!);
    expect(name).toHaveValue('仍保留的草稿');
    expect(workflowsSpy).toHaveBeenCalledTimes(1);
  });
});
