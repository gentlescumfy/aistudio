import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError } from './domain.js';
import { atomicWrite } from './store.js';

/** Project ids are user-supplied path segments, so they must be strictly validated. */
const projectIdSchema = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type ProjectRecord = {
  id: string;
  name: string;
  langflowProjectId: string | null;
  createdAt: string;
};

export type ProjectIndex = { revision: number; projects: ProjectRecord[] };

/**
 * Resolves a validated project id into its own data directory.
 *
 * Every project owns an isolated directory, so the existing per-directory writer
 * lock applies per project without changing the lock implementation.
 */
export function assertProjectId(projectId: string): string {
  if (!projectIdSchema.test(projectId)) {
    throw new ApiError(400, 'INVALID_PROJECT_ID', '项目 ID 须为 1–64 位小写字母、数字或连字符，且不能以连字符开头或结尾。');
  }
  if (projectId.includes('..') || projectId.includes('/') || projectId.includes('\\')) {
    throw new ApiError(400, 'INVALID_PROJECT_ID', '项目 ID 不能包含路径分隔符。');
  }
  return projectId;
}

export function projectDirectory(dataDir: string, projectId: string): string {
  assertProjectId(projectId);
  // The default project keeps the legacy data directory so existing data and tests are unaffected;
  // every other project gets its own isolated subdirectory under projects/.
  return projectId === 'default' ? dataDir : join(dataDir, 'projects', projectId);
}

/** Lowercase hyphen-slug used when the client does not supply an explicit id. */
export function slugify(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return base || 'project';
}

export async function readProjectIndex(dataDir: string): Promise<ProjectIndex> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dataDir, 'projects.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { revision: 0, projects: [] };
    const record = parsed as Partial<ProjectIndex>;
    return { revision: typeof record.revision === 'number' ? record.revision : 0, projects: Array.isArray(record.projects) ? record.projects : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, projects: [] };
    throw error;
  }
}

export async function writeProjectIndex(dataDir: string, index: ProjectIndex): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await atomicWrite(join(dataDir, 'projects.json'), JSON.stringify(index));
}

/** Cross-project registry. Lives outside any single project directory; single-writer per process. */
export class ProjectRegistry {
  private index: ProjectIndex = { revision: 0, projects: [] };
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(private readonly dataDir: string) {}
  static async open(dataDir: string): Promise<ProjectRegistry> {
    const registry = new ProjectRegistry(dataDir);
    registry.index = await readProjectIndex(dataDir); // read-only; missing file yields an empty index
    return registry;
  }

  list(): ProjectRecord[] {
    const list = structuredClone(this.index.projects);
    if (!list.some((project) => project.id === 'default')) list.unshift(defaultRecord());
    return list;
  }
  revision(): number { return this.index.revision; }

  get(id: string): ProjectRecord | undefined {
    const found = this.index.projects.find((project) => project.id === id);
    if (found) return structuredClone(found);
    return id === 'default' ? defaultRecord() : undefined;
  }

  async create(input: { name: string; id?: string }, revision: number): Promise<ProjectRecord> {
    const task = this.tail.then(async () => {
      const current = await readProjectIndex(this.dataDir);
      if (revision !== current.revision) throw new ApiError(409, 'PROJECT_CONFLICT', '项目列表已变更，请刷新后重试。');
      const name = input.name.trim();
      if (!name || name.length > 80) throw new ApiError(400, 'PROJECT_NAME_INVALID', '项目名称必填，最多 80 个字符。');
      let id = input.id ? assertProjectId(input.id.trim()) : slugify(name);
      const exists = (candidate: string) => candidate === 'default' || current.projects.some((project) => project.id === candidate);
      if (exists(id)) {
        if (input.id) throw new ApiError(409, 'PROJECT_EXISTS', '项目 ID 已存在。');
        let suffix = 2;
        while (exists(`${id}-${suffix}`)) suffix += 1;
        id = `${id}-${suffix}`;
      }
      const record: ProjectRecord = { id, name, langflowProjectId: null, createdAt: new Date().toISOString() };
      current.projects.push(record);
      current.revision += 1;
      await writeProjectIndex(this.dataDir, current);
      this.index = current;
      return structuredClone(record);
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  async remove(id: string, revision: number): Promise<ProjectRecord> {
    const task = this.tail.then(async () => {
      const current = await readProjectIndex(this.dataDir);
      if (revision !== current.revision) throw new ApiError(409, 'PROJECT_CONFLICT', '项目列表已变更，请刷新后重试。');
      assertProjectId(id);
      if (id === 'default') throw new ApiError(409, 'PROJECT_NOT_REMOVABLE', '默认项目不可删除。');
      const found = current.projects.find((project) => project.id === id);
      if (!found) throw new ApiError(404, 'PROJECT_NOT_FOUND', '项目不存在。');
      current.projects = current.projects.filter((project) => project.id !== id);
      current.revision += 1;
      await writeProjectIndex(this.dataDir, current);
      this.index = current;
      return structuredClone(found);
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  async markLangflowSynced(id: string, langflowProjectId: string, revision: number): Promise<void> {
    const task = this.tail.then(async () => {
      const current = await readProjectIndex(this.dataDir);
      if (revision !== current.revision) throw new ApiError(409, 'PROJECT_CONFLICT', '项目列表已变更，请刷新后重试。');
      assertProjectId(id);
      const record = current.projects.find((project) => project.id === id);
      if (!record) throw new ApiError(404, 'PROJECT_NOT_FOUND', '项目不存在。');
      record.langflowProjectId = langflowProjectId;
      current.revision += 1;
      await writeProjectIndex(this.dataDir, current);
      this.index = current;
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
}

function defaultRecord(): ProjectRecord {
  return { id: 'default', name: '默认项目', langflowProjectId: null, createdAt: new Date(0).toISOString() };
}
