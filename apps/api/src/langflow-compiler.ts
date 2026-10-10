import type { Workflow, WorkflowDefinition, WorkflowNode, WorkflowEdge } from './workflow-contract.js';

export interface LangflowTemplateField {
  type: string;
  value?: unknown;
  show?: boolean;
  required?: boolean;
  [key: string]: unknown;
}

export interface LangflowNodeData {
  id: string;
  type: string;
  node: {
    display_name: string;
    description: string;
    template: Record<string, LangflowTemplateField>;
    inputs?: Array<{ name: string; display_name: string; type: string }>;
    outputs?: Array<{ name: string; display_name: string; types: string[] }>;
  };
}

export interface LangflowCompiledNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: LangflowNodeData;
}

export interface LangflowCompiledEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
}

export interface LangflowFlowPayload {
  name: string;
  description: string;
  data: {
    nodes: LangflowCompiledNode[];
    edges: LangflowCompiledEdge[];
    viewport: { x: number; y: number; zoom: number };
  };
  is_component: boolean;
  folder_id: string | null;
  project_id?: string | null;
}

export interface CompileOptions {
  projectId?: string;
  folderId?: string;
}

/**
 * 将自研工作流节点映射为 Langflow 1.12.5 原生节点数据
 */
function compileNode(node: WorkflowNode): LangflowCompiledNode {
  switch (node.kind) {
    case 'prompt': {
      const isAgent = node.config.executionMode === 'agent';
      const nodeType = isAgent ? 'Agent' : 'PromptTemplate';
      return {
        id: node.id,
        type: nodeType,
        position: { x: node.position.x, y: node.position.y },
        data: {
          id: node.id,
          type: nodeType,
          node: {
            display_name: node.name,
            description: isAgent ? 'Agent 提示词与智能体调用节点' : '模板提示词格式化节点',
            template: {
              template: { type: 'str', value: node.config.template, required: true },
              execution_mode: { type: 'str', value: node.config.executionMode ?? 'template' },
              role_id: { type: 'str', value: node.config.roleRef?.id ?? null },
              role_revision: { type: 'int', value: node.config.roleRef?.revision ?? null },
            },
            inputs: [{ name: 'input', display_name: 'Input Prompt', type: 'str' }],
            outputs: [{ name: 'output', display_name: 'Generated Text', types: ['str', 'Message'] }],
          },
        },
      };
    }
    case 'image': {
      return {
        id: node.id,
        type: 'ImageGenerator',
        position: { x: node.position.x, y: node.position.y },
        data: {
          id: node.id,
          type: 'ImageGenerator',
          node: {
            display_name: node.name,
            description: '根据提示词生成图像资源节点',
            template: {
              width: { type: 'int', value: node.config.width, required: true },
              height: { type: 'int', value: node.config.height, required: true },
              count: { type: 'int', value: node.config.count, required: false },
            },
            inputs: [{ name: 'prompt', display_name: 'Image Prompt', type: 'str' }],
            outputs: [{ name: 'images', display_name: 'Generated Images', types: ['Image', 'AssetList'] }],
          },
        },
      };
    }
    case 'export': {
      return {
        id: node.id,
        type: 'ExportOutput',
        position: { x: node.position.x, y: node.position.y },
        data: {
          id: node.id,
          type: 'ExportOutput',
          node: {
            display_name: node.name,
            description: '工作流最终产物打包与导出节点',
            template: {
              export_format: { type: 'str', value: 'zip', required: true },
            },
            inputs: [{ name: 'artifacts', display_name: 'Artifacts', type: 'AssetList' }],
            outputs: [{ name: 'archive', display_name: 'Export Archive', types: ['File'] }],
          },
        },
      };
    }
    default: {
      const exhaustiveCheck: never = node;
      throw new Error(`Unsupported workflow node kind: ${(exhaustiveCheck as { kind: string }).kind}`);
    }
  }
}

/**
 * 将自研工作流边映射为 Langflow 边
 */
function compileEdge(edge: WorkflowEdge): LangflowCompiledEdge {
  return {
    id: `edge-${edge.id}`,
    source: edge.source,
    target: edge.target,
    sourceHandle: `${edge.source}-output`,
    targetHandle: `${edge.target}-input`,
  };
}

/**
 * 将自研可视化工作流（Workflow 或 WorkflowDefinition）编译为 Langflow 1.12.5 原生 Flow JSON 格式
 */
export function compileWorkflowToLangflow(
  workflow: Workflow | WorkflowDefinition,
  options: CompileOptions = {}
): LangflowFlowPayload {
  const folderId = options.folderId ?? options.projectId ?? null;
  const nodes = workflow.nodes.map(compileNode);
  const edges = workflow.edges.map(compileEdge);

  return {
    name: workflow.name,
    description: workflow.description,
    data: {
      nodes,
      edges,
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    is_component: false,
    folder_id: folderId,
    project_id: options.projectId ?? null,
  };
}
