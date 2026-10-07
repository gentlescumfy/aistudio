import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError, databaseSchema, legacyDatabaseSchema, type Database } from './domain.js';

/** A serialized, atomic snapshot store. One process per data directory only. */
export class FileStore {
  private data: Database = { version: 2, runs: [], submissions: [] };
  private migrationBackup?: Buffer;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly lockToken = `${process.pid}:${randomUUID()}`;
  private closed = false;
  private fault: unknown;
  private constructor(readonly directory: string) {}

  static async open(directory: string): Promise<FileStore> {
    const store = new FileStore(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await store.acquireLock();
    try {
      let contents: Buffer | undefined;
      try { contents = await readFile(join(directory, 'runs.json')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (contents !== undefined) {
        const parsed: unknown = JSON.parse(contents.toString('utf8'));
        if (parsed && typeof parsed === 'object' && 'version' in parsed && parsed.version === 1) {
          const legacy = legacyDatabaseSchema.parse(parsed);
          store.data = { ...legacy, version: 2 };
          store.migrationBackup = contents;
        } else store.data = databaseSchema.parse(parsed);
      }
      // Never silently discard a corrupt/unsupported snapshot.
      return store;
    } catch (error) { await store.close(); throw error; }
  }

  private async acquireLock(): Promise<void> {
    const path = join(this.directory, 'writer.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const file = await open(path, 'wx', 0o600);
        try { await file.writeFile(this.lockToken); await file.sync(); }
        finally { await file.close(); }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // Serialize stale-lock inspection/removal. A second startup must not unlink
        // a new writer's lock based on a stale PID it read before the first restart.
        const recoveryPath = join(this.directory, 'recovery.lock');
        let recovery;
        try { recovery = await open(recoveryPath, 'wx', 0o600); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Lock recovery is already in progress. Inspect a stale recovery.lock manually.');
          throw error;
        }
        try {
          let token: string;
          try { token = await readFile(path, 'utf8'); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          const pid = Number(token.split(':')[0]);
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid writer lock; inspect it manually.');
          try { process.kill(pid, 0); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
              await unlink(path);
              continue;
            }
            throw error;
          }
          throw new Error('Data directory already has a live writer. Only one API process is supported.');
        } finally { await recovery.close(); await unlink(recoveryPath); }
      }
    }
    throw new Error('Could not acquire the data directory writer lock.');
  }

  snapshot(): Database { return structuredClone(this.data); }

  assertWritable(): void {
    if (this.fault || this.closed) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Local storage unavailable. Inspect storage and restart the API.');
  }

  transaction<T>(change: (data: Database) => T): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Store is closed.'));
    const task = this.tail.then(async () => {
      this.assertWritable();
      const next = structuredClone(this.data);
      const result = change(next);
      databaseSchema.parse(next);
      try {
        if (this.migrationBackup) await this.backupLegacySnapshot(this.migrationBackup);
        await atomicWrite(join(this.directory, 'runs.json'), JSON.stringify(next));
      }
      catch (error) {
        // A rename/fsync error may have an uncertain durable outcome. Fail closed:
        // do not accept a second write based on an older in-memory snapshot.
        this.fault = error;
        throw error;
      }
      this.data = next; // Publish only after the durable snapshot is committed.
      this.migrationBackup = undefined;
      return structuredClone(result);
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    const path = join(this.directory, 'writer.lock');
    if (await readFile(path, 'utf8') === this.lockToken) await unlink(path);
  }

  private async backupLegacySnapshot(contents: Buffer): Promise<void> {
    const path = join(this.directory, 'runs.json.v1.bak');
    try {
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readFile(path);
      if (!existing.equals(contents)) throw new Error('Existing runs.json.v1.bak does not match the legacy source; refusing migration.');
    }
  }
}

export async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(data); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    // Flush the rename as well as file contents on local filesystems.
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(() => undefined); }
}
