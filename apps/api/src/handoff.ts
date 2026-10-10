import { z } from 'zod';

export const handoffMetricSchema = z.strictObject({
  steps: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const handoffPackageSchema = z.strictObject({
  sourceNodeId: z.string(),
  roleName: z.string().optional(),
  summary: z.string(),
  directive: z.string(),
  artifacts: z.array(z.string()).default([]),
  metrics: handoffMetricSchema.optional(),
  createdAt: z.string().datetime(),
});

export type HandoffPackage = z.infer<typeof handoffPackageSchema>;

/**
 * 结构化交接（Handoff）契约构建器
 * 借鉴 AgentsRoom 核心协作规范：
 * 1. 结构化上下文传递而非简单文本拼接；
 * 2. 明确下游行动指令（Actionable Directive），防止多 Agent 协作偏离主线；
 * 3. 附带步骤与成本度量指标，实现端到端治理闭环。
 */
export function buildHandoffPackage(
  sourceNodeId: string,
  rawOutput: string,
  options?: {
    roleName?: string;
    artifacts?: string[];
    steps?: number;
    cost?: number;
    durationMs?: number;
  },
): HandoffPackage {
  const trimmed = rawOutput.trim();
  let summary = trimmed;
  let directive = '请基于上游交付物，执行下一步既定任务。';

  const directiveMatch = trimmed.match(/(?:行动指令|下一步行动|建议行动|Directive):\s*([^\n\r]+)/i);
  if (directiveMatch && directiveMatch[1]) {
    directive = directiveMatch[1].trim();
  } else {
    // 自动提取末尾指导句或建议句
    const sentences = trimmed.split(/[。！？\n]+/).filter(Boolean);
    if (sentences.length > 0) {
      const lastSentence = sentences[sentences.length - 1]!.trim();
      if (lastSentence.length <= 120 && (lastSentence.includes('请') || lastSentence.includes('建议') || lastSentence.includes('下一步'))) {
        directive = lastSentence;
      }
    }
  }

  return {
    sourceNodeId,
    roleName: options?.roleName,
    summary,
    directive,
    artifacts: options?.artifacts ?? [],
    metrics: options ? {
      steps: options.steps ?? 1,
      cost: options.cost ?? 0,
      durationMs: options.durationMs,
    } : undefined,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 结构化 Handoff 占位符渲染函数
 * 支持 {{ prompt }}, {{ count }}, {{ directive }}, {{ handoff.directive }}, {{ handoff.summary }}, {{ handoff.roleName }}
 */
export function renderHandoffTemplate(
  template: string,
  inputs: { prompt: string; count: number },
  handoff?: HandoffPackage,
): string {
  return template.replace(/{{\s*([\w.]+)\s*}}/g, (match, key: string) => {
    if (key === 'prompt') return handoff?.summary ?? inputs.prompt;
    if (key === 'count') return String(inputs.count);
    if (key === 'directive' || key === 'handoff.directive') return handoff?.directive ?? '';
    if (key === 'summary' || key === 'handoff.summary') return handoff?.summary ?? '';
    if (key === 'roleName' || key === 'handoff.roleName') return handoff?.roleName ?? '';
    return match;
  });
}
