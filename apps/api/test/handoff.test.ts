import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHandoffPackage, renderHandoffTemplate, handoffPackageSchema } from '../src/handoff.js';

test('buildHandoffPackage extracts explicit directive and options correctly', () => {
  const rawText = `这是前置架构师节点的分析总结。
系统的核心差异在于治理网关与长任务取消。
行动指令: 请生成包含治理拦截时序的 SVG 架构图`;

  const pkg = buildHandoffPackage('node-architect', rawText, {
    roleName: 'System Architect',
    artifacts: ['arch-analysis.md'],
    steps: 2,
    cost: 0.05,
    durationMs: 1200,
  });

  // Verify Schema conformance
  assert.doesNotThrow(() => handoffPackageSchema.parse(pkg));

  assert.equal(pkg.sourceNodeId, 'node-architect');
  assert.equal(pkg.roleName, 'System Architect');
  assert.equal(pkg.directive, '请生成包含治理拦截时序的 SVG 架构图');
  assert.deepEqual(pkg.artifacts, ['arch-analysis.md']);
  assert.equal(pkg.metrics?.steps, 2);
  assert.equal(pkg.metrics?.cost, 0.05);
});

test('buildHandoffPackage falls back to actionable last sentence or default', () => {
  const textWithActionableLast = `已完成提示词润色。建议下一步生成符合品牌色彩的标志`;
  const pkg1 = buildHandoffPackage('node-prompt', textWithActionableLast);
  assert.equal(pkg1.directive, '建议下一步生成符合品牌色彩的标志');

  const plainText = `纯静态陈述，无明确指导。`;
  const pkg2 = buildHandoffPackage('node-plain', plainText);
  assert.equal(pkg2.directive, '请基于上游交付物，执行下一步既定任务。');
});

test('renderHandoffTemplate substitutes handoff variables and preserves backward compatibility', () => {
  const handoff = buildHandoffPackage('node-1', '上游智能体生成的成果总结。\nDirective: 严格遵循深色主题规范', {
    roleName: 'Designer',
  });

  const inputs = { prompt: '原始用户提示词', count: 3 };

  // 1. Backward compatible {{ prompt }} & {{ count }}
  const tpl1 = '根据 {{ prompt }} 绘制 {{ count }} 个素材';
  assert.equal(renderHandoffTemplate(tpl1, inputs, handoff), `根据 ${handoff.summary} 绘制 3 个素材`);

  // 2. Directive substitution
  const tpl2 = '请接收指令：{{ directive }}，开始绘制';
  assert.equal(renderHandoffTemplate(tpl2, inputs, handoff), '请接收指令：严格遵循深色主题规范，开始绘制');

  // 3. Namespace handoff.directive and handoff.roleName
  const tpl3 = '来自 [{{ handoff.roleName }}] 的任务：{{ handoff.directive }}';
  assert.equal(renderHandoffTemplate(tpl3, inputs, handoff), '来自 [Designer] 的任务：严格遵循深色主题规范');
});
