import { describe, expect, it } from 'vitest';
import { connectionIssue, validateWorkflowDefinition } from './workflowUtils';
import type { WorkflowDefinition } from './types';

const definition = (): WorkflowDefinition => ({
  name: '品牌图像工作流', description: '整理提示词并生成图像素材。',
  nodes: [
    { id: 'prompt-main', name: '创意提示词', kind: 'prompt', position: { x: 40, y: 80 }, config: { template: '{{prompt}}，共 {{count}} 张', roleRef: null } },
    { id: 'image-main', name: '图像生成', kind: 'image', position: { x: 300, y: 80 }, config: { width: 1024, height: 1024, count: null } },
    { id: 'export-main', name: '导出素材', kind: 'export', position: { x: 560, y: 80 }, config: {} },
  ],
  edges: [{ id: 'edge-prompt-image', source: 'prompt-main', target: 'image-main' }, { id: 'edge-image-export', source: 'image-main', target: 'export-main' }],
});

describe('工作流图编辑规则', () => {
  it('接受完整可达的提示词、图像和导出流程', () => {
    expect(validateWorkflowDefinition(definition())).toEqual({ valid: true, issues: [], warnings: [] });
  });

  it('阻止重复连线、错误节点方向、已有上游和循环', () => {
    const flow = definition();
    expect(connectionIssue(flow.nodes, flow.edges, 'prompt-main', 'image-main')).toMatch(/已经连接/);
    expect(connectionIssue(flow.nodes, flow.edges, 'image-main', 'prompt-main')).toMatch(/只允许/);
    expect(connectionIssue(flow.nodes, flow.edges, 'image-main', 'export-main')).toMatch(/已经连接/);
    expect(connectionIssue(flow.nodes, flow.edges, 'export-main', 'export-main')).toMatch(/自身/);
    const extraPrompt = { ...flow.nodes[0]!, id: 'prompt-extra', name: '备用提示词' };
    expect(connectionIssue([...flow.nodes, extraPrompt], flow.edges, 'prompt-extra', 'image-main')).toMatch(/最多只能有一个/);
    const promptChain = [...flow.edges, { id: 'edge-prompt-chain', source: 'prompt-main', target: 'prompt-extra' }];
    expect(connectionIssue([...flow.nodes, extraPrompt], promptChain, 'prompt-extra', 'prompt-main')).toMatch(/形成循环/);
  });

  it('标出未连接节点、非法模板变量和无效图像数量', () => {
    const flow = definition();
    flow.nodes[0] = { ...flow.nodes[0]!, kind: 'prompt', config: { template: '{{secret}}', roleRef: null } };
    flow.nodes[1] = { ...flow.nodes[1]!, kind: 'image', config: { width: 1024, height: 1024, count: 0 } };
    flow.edges = flow.edges.filter(edge => edge.target !== 'image-main');
    const result = validateWorkflowDefinition(flow);
    expect(result.valid).toBe(false);
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['PROMPT_PLACEHOLDER', 'IMAGE_COUNT', 'IMAGE_INPUT']));
  });

  it('接受不产生图像的软件开发流程（提示词直接到导出）', () => {
    const flow: WorkflowDefinition = {
      name: '需求开发流程', description: '分析需求、生成补丁并交付结果。',
      nodes: [
        { id: 'analyze', name: '需求分析', kind: 'prompt', position: { x: 40, y: 80 }, config: { template: '分析以下需求：{{prompt}}', roleRef: null } },
        { id: 'implement', name: '生成补丁', kind: 'prompt', position: { x: 300, y: 80 }, config: { template: '根据分析实现：{{prompt}}', roleRef: null } },
        { id: 'deliver', name: '交付结果', kind: 'export', position: { x: 560, y: 80 }, config: {} },
      ],
      edges: [
        { id: 'edge-analyze-implement', source: 'analyze', target: 'implement' },
        { id: 'edge-implement-deliver', source: 'implement', target: 'deliver' },
      ],
    };
    expect(validateWorkflowDefinition(flow)).toEqual({ valid: true, issues: [], warnings: [] });
  });
});
