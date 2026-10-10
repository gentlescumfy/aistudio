import { FileStore } from './store.js';
import { AssetStore } from './assets.js';
import { RunEngine } from './engine.js';
import { MockProvider, type Provider } from './provider.js';
import { SettingsStore } from './settings.js';
import { RoleStore } from './roles.js';
import { WorkflowStore } from './workflows.js';
import { LangflowService } from './langflow.js';
import { TextAgentRuntime } from './agent-runtime.js';
import { projectDirectory, assertProjectId } from './projects.js';

/**
 * A fully-opened, isolated set of stores for a single project.
 * Each project owns its own directory, so the per-directory writer lock
 * provides isolation without changing the lock implementation.
 */
export type StoreSet = {
  projectId: string;
  file: FileStore;
  assets: AssetStore;
  settings: SettingsStore;
  roles: RoleStore;
  workflows: WorkflowStore;
  langflow: LangflowService;
  engine: RunEngine;
};

export type PoolOptions = {
  dataDir: string;
  provider?: Provider;
  mockDelayMs?: number;
  langflowFetch?: typeof fetch;
  agnesAiFetch?: typeof fetch;
  agnesAiEnvironment?: NodeJS.ProcessEnv;
  logError: (err: unknown, message: string) => void;
};

/** Lazily opens and caches one isolated StoreSet per project. */
export class StorePool {
  private readonly sets = new Map<string, StoreSet>();

  constructor(private readonly options: PoolOptions) {}

  async get(projectId: string): Promise<StoreSet> {
    const id = assertProjectId(projectId);
    const cached = this.sets.get(id);
    if (cached) return cached;
    const set = await this.open(id);
    this.sets.set(id, set);
    return set;
  }

  projectIds(): string[] { return [...this.sets.keys()]; }

  async evict(projectId: string): Promise<void> {
    const id = assertProjectId(projectId);
    const set = this.sets.get(id);
    if (!set) return;
    await this.closeOne(set);
    this.sets.delete(id);
  }

  async close(): Promise<void> {
    for (const set of this.sets.values()) await this.closeOne(set);
    this.sets.clear();
  }

  private async closeOne(set: StoreSet): Promise<void> {
    await set.engine.stop();
    await set.workflows.close();
    await set.roles.close();
    await set.settings.close();
    await set.langflow.close();
    await set.file.close();
  }

  private async open(projectId: string): Promise<StoreSet> {
    const root = projectDirectory(this.options.dataDir, projectId);
    const file = await FileStore.open(root);
    let assets: AssetStore | undefined;
    let settings: SettingsStore | undefined;
    let roles: RoleStore | undefined;
    let workflows: WorkflowStore | undefined;
    let langflow: LangflowService | undefined;
    let engine: RunEngine | undefined;
    try {
      assets = await AssetStore.open(root);
      settings = await SettingsStore.open(root);
      roles = await RoleStore.open(root);
      workflows = await WorkflowStore.open(root);
      langflow = await LangflowService.open(root, this.options.langflowFetch ?? fetch, (message) => this.options.logError(undefined, message));
      engine = new RunEngine(
        file, assets, this.options.provider ?? new MockProvider(this.options.mockDelayMs),
        (error) => this.options.logError(error, 'Executor stopped after storage failure'), workflows,
        (selection, deadlineMs) => settings!.resolveTextAgentTarget(selection.kind === 'binding' ? selection.binding : undefined, deadlineMs),
        new TextAgentRuntime(fetch, this.options.agnesAiEnvironment ?? process.env),
      );
      await engine.recover();
      return { projectId, file, assets, settings, roles, workflows, langflow, engine };
    } catch (error) {
      // Roll back any stores that opened before the failure so a half-open project leaks no writers.
      if (engine) await engine.stop();
      await workflows?.close();
      await roles?.close();
      await settings?.close();
      await langflow?.close();
      await file.close();
      throw error;
    }
  }
}
