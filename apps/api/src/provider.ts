import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Asset, Run, RunNode } from './domain.js';

export interface ProviderOutput { asset: Asset; contents: Buffer }
export interface Provider {
  readonly mode: 'mock';
  /** Real paid integrations must use manual reconciliation for unknown outcomes. */
  readonly recovery: 'safe-local-replay' | 'manual-reconciliation';
  execute(run: Run, node: RunNode, signal: AbortSignal): Promise<ProviderOutput[]>;
}

/** Timeout/disconnect after dispatch: the provider may already have applied effects. */
export class ProviderOutcomeUnknownError extends Error {}

export class MockProvider implements Provider {
  readonly mode = 'mock';
  readonly recovery = 'safe-local-replay';
  constructor(private readonly delayMs = 350) {}

  async execute(run: Run, node: RunNode, signal: AbortSignal): Promise<ProviderOutput[]> {
    await delay(this.delayMs, undefined, { signal });
    if (node.kind === 'prompt') return [];
    if (node.kind === 'export') {
      const expected = run.expectedAssetCount ?? run.inputs.count;
      if (run.assets.length !== expected) throw new Error(`Mock export expected ${expected} generated assets but found ${run.assets.length}.`);
      return [];
    }
    if (node.kind !== 'image') throw new Error('Unsupported node kind.');
    if (run.inputs.prompt.includes('[mock:fail-once]') && node.attempts === 1) {
      throw new Error('Simulated mock failure. Retry will resume this node; no paid call was made.');
    }
    const workflowImage = node.config && 'width' in node.config ? node.config : undefined;
    const width = workflowImage?.width ?? 1024;
    const height = workflowImage?.height ?? 1024;
    const count = workflowImage?.count ?? run.inputs.count;
    const promptSource = node.outputPrompt ?? run.inputs.prompt;
    return Array.from({ length: count }, (_, index) => {
      const seedInput = node.config ? `${run.id}:${node.id}:${index}:${promptSource}` : `${run.inputs.prompt}:${index}`;
      const seed = createHash('sha256').update(seedInput).digest('hex');
      const id = seed.slice(0, 24);
      const asset: Asset = {
        id, runId: run.id, nodeId: node.id, name: node.config ? `mock-${node.id}-${index + 1}.svg` : `mock-brand-${index + 1}.svg`,
        mimeType: 'image/svg+xml', url: `/api/assets/${run.id}/${id}`,
        width, height, mode: 'mock',
      };
      const hue = parseInt(seed.slice(0, 4), 16) % 360;
      const prompt = escapeXml(promptSource.slice(0, 90));
      const scale = Math.min(width, height) / 1024;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Local mock brand demonstration">
<rect width="${width}" height="${height}" fill="hsl(${hue},45%,13%)"/>
<g transform="scale(${scale})">
<circle cx="740" cy="270" r="260" fill="hsl(${hue},70%,65%)" opacity=".25"/>
<path d="M150 640L380 220L610 640Z" fill="hsl(${hue},70%,70%)"/>
<circle cx="380" cy="510" r="75" fill="hsl(${hue},45%,13%)"/>
<text x="80" y="760" fill="white" font-family="sans-serif" font-size="52">BRAND CONCEPT ${index + 1}</text>
<text x="80" y="815" fill="white" font-family="sans-serif" font-size="18">${prompt}</text>
<rect x="0" y="904" width="1024" height="120" fill="#080d16"/>
<text x="60" y="972" fill="#f8d57e" font-family="sans-serif" font-size="26">MOCK DEMO · LOCAL SVG · NOT AI GENERATED · COST 0</text>
</g>
</svg>`;
      return { asset, contents: Buffer.from(svg) };
    });
  }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]!).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}
