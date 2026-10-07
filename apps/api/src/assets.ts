import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, type Asset } from './domain.js';
import { atomicWrite } from './store.js';
import type { ProviderOutput } from './provider.js';

export class AssetStore {
  private constructor(private readonly root: string) {}
  static async open(directory: string): Promise<AssetStore> {
    const root = join(directory, 'assets');
    await mkdir(root, { recursive: true, mode: 0o700 });
    return new AssetStore(await realpath(root));
  }
  async write(output: ProviderOutput): Promise<void> {
    const path = join(this.root, output.asset.runId);
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (await realpath(path) !== path) throw new Error('Asset directory cannot be a symbolic link.');
    await atomicWrite(join(path, `${output.asset.id}.svg`), output.contents);
  }
  async read(asset: Asset): Promise<Buffer> {
    const folder = join(this.root, asset.runId);
    const path = join(folder, `${asset.id}.svg`);
    try {
      if (await realpath(folder) !== folder || await realpath(path) !== path) {
        throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset not found.');
      }
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid asset file.');
        return await file.readFile();
      } finally { await file.close(); }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset not found.');
      }
      throw error;
    }
  }
}
