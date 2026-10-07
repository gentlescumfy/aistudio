// Finite IPC fixture: no HTTP listener, credentials or long-running dev service.
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/app.js';
import type { Run } from '../src/domain.js';

const app = await createApp({ dataDir: process.env.TEST_DATA_DIR!, mockDelayMs: 150 });
const mode = process.env.TEST_WORKER_MODE;
try {
  let id: string;
  if (mode === 'seed') {
    const response = await app.inject({ method: 'POST', url: '/api/runs', payload: {
      templateId: 'brand-assets', inputs: { prompt: 'Crash-safe mock', count: 2 }, idempotencyKey: 'restart-key',
    } });
    if (response.statusCode !== 201) throw new Error(response.body);
    id = response.json<{ run: Run }>().run.id;
  } else if (mode === 'workflow-seed') {
    const workflow = {
      name: 'Crash-safe workflow', description: 'Worker restart snapshot fixture.',
      nodes: [
        { id: 'brief', name: 'Brief', position: { x: 0, y: 0 }, kind: 'prompt', config: { template: 'Recovery {{prompt}} {{count}}', roleRef: { id: 'architect', revision: 1 } } },
        { id: 'image-a', name: 'Image A', position: { x: 300, y: 0 }, kind: 'image', config: { width: 512, height: 768, count: 1 } },
        { id: 'image-b', name: 'Image B', position: { x: 300, y: 180 }, kind: 'image', config: { width: 1536, height: 1024, count: null } },
        { id: 'export', name: 'Export', position: { x: 600, y: 0 }, kind: 'export', config: {} },
      ],
      edges: [
        { id: 'brief-a', source: 'brief', target: 'image-a' }, { id: 'brief-b', source: 'brief', target: 'image-b' },
        { id: 'a-export', source: 'image-a', target: 'export' }, { id: 'b-export', source: 'image-b', target: 'export' },
      ],
    };
    const created = await app.inject({ method: 'POST', url: '/api/workflows', payload: { revision: 0, workflow } });
    if (created.statusCode !== 201) throw new Error(created.body);
    const draft = created.json<{ revision: number; workflow: { id: string } }>();
    const published = await app.inject({ method: 'POST', url: `/api/workflows/${draft.workflow.id}/publish`, payload: { revision: draft.revision } });
    if (published.statusCode !== 200) throw new Error(published.body);
    const publishedResult = published.json<{ revision: number; workflow: { revision: number } }>();
    const response = await app.inject({ method: 'POST', url: '/api/runs', payload: {
      templateId: draft.workflow.id, workflowRevision: publishedResult.workflow.revision,
      inputs: { prompt: 'Crash-safe graph', count: 2 }, idempotencyKey: 'workflow-restart-key',
    } });
    if (response.statusCode !== 201) throw new Error(response.body);
    id = response.json<{ run: Run }>().run.id;
    const changed = structuredClone(workflow);
    changed.name = 'Updated after run submission';
    (changed.nodes[1]!.config as { width: number }).width = 2048;
    const edit = await app.inject({ method: 'POST', url: `/api/workflows/${draft.workflow.id}`, payload: { revision: publishedResult.revision, workflow: changed } });
    if (edit.statusCode !== 200) throw new Error(edit.body);
    const edited = edit.json<{ revision: number }>();
    const republished = await app.inject({ method: 'POST', url: `/api/workflows/${draft.workflow.id}/publish`, payload: { revision: edited.revision } });
    if (republished.statusCode !== 200) throw new Error(republished.body);
  } else {
    id = (await app.inject('/api/runs')).json<{ runs: Run[] }>().runs[0]!.id;
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const run = (await app.inject(`/api/runs/${id}`)).json<{ run: Run }>().run;
    if ((mode === 'seed' && run.nodes[1]!.status === 'running') || (mode === 'workflow-seed' && run.nodes[0]!.status === 'running')) {
      process.send?.({ type: 'checkpoint', run });
      // The parent kills us abruptly after observing durable in-flight state.
      await new Promise<void>((resolve) => { setTimeout(resolve, 8000); });
      throw new Error('Parent did not terminate the crash fixture.');
    }
    if (mode !== 'seed' && mode !== 'workflow-seed' && run.status === 'succeeded') {
      process.send?.({ type: 'recovered', run });
      await app.close();
      process.disconnect?.();
      break;
    }
    await delay(5);
  }
  if (mode === 'seed') throw new Error('Crash fixture did not reach its checkpoint.');
} catch (error) {
  process.send?.({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  await app.close();
  process.disconnect?.();
  process.exitCode = 1;
}
