import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ApiError } from './domain.js';
import { atomicWrite } from './store.js';

const idSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);
const protocolSchema = z.enum(['openai-compatible', 'anthropic', 'google']);
const capabilitySchema = z.enum(['text', 'code', 'image', 'video', 'audio']);
const secretEnvSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/).or(z.literal(''));

const endpointSchema = z.string().trim().min(1).max(1000).superRefine((value, context) => {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    const userInfo = /^https?:\/\/[^/?#]*@/i.test(value);
    if (url.username || url.password || userInfo || value.includes('?') || value.includes('#') ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
      context.addIssue({ code: 'custom', message: 'Use HTTPS or local HTTP; credentials and query parameters are not allowed.' });
    }
  } catch { context.addIssue({ code: 'custom', message: 'A valid HTTPS or loopback HTTP URL is required.' }); }
});

export const providerSchema = z.strictObject({
  id: idSchema,
  name: z.string().trim().min(1).max(80),
  transport: z.enum(['api', 'local']),
  protocol: protocolSchema,
  baseUrl: endpointSchema,
}).superRefine((provider, context) => {
  if (provider.transport !== 'local') return;
  try {
    const hostname = new URL(provider.baseUrl).hostname.toLowerCase();
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
      context.addIssue({ code: 'custom', path: ['baseUrl'], message: 'Local transport requires a loopback hostname.' });
    }
  } catch { /* endpointSchema provides the URL error. */ }
});

export const accountSchema = z.strictObject({
  id: idSchema,
  providerId: idSchema,
  label: z.string().trim().min(1).max(80),
  secretEnv: secretEnvSchema,
  enabled: z.boolean(),
});

export const modelSchema = z.strictObject({
  id: idSchema,
  accountId: idSchema,
  externalId: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(80),
  capabilities: z.array(capabilitySchema).min(1),
  pinned: z.boolean(),
}).superRefine((model, context) => {
  if (new Set(model.capabilities).size !== model.capabilities.length) {
    context.addIssue({ code: 'custom', path: ['capabilities'], message: 'Capabilities must be unique.' });
  }
});

export const bindingSchema = z.strictObject({ providerId: idSchema, accountId: idSchema, modelId: idSchema });
const routeBindingSchema = bindingSchema.nullable();
export const settingsSchema = z.strictObject({
  defaultCount: z.number().int().min(1).max(8),
  providers: z.array(providerSchema).max(8),
  accounts: z.array(accountSchema).max(16),
  models: z.array(modelSchema).max(64),
  routes: z.strictObject({ text: routeBindingSchema, image: z.union([z.literal('mock-svg'), bindingSchema]), video: routeBindingSchema }),
}).superRefine((settings, context) => {
  const unique = (items: { id: string }[], path: string) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.id)) context.addIssue({ code: 'custom', path: [path, index, 'id'], message: 'IDs must be unique within this collection.' });
      seen.add(item.id);
    });
  };
  unique(settings.providers, 'providers');
  unique(settings.accounts, 'accounts');
  unique(settings.models, 'models');

  const providers = new Map(settings.providers.map((item) => [item.id, item]));
  const accounts = new Map(settings.accounts.map((item) => [item.id, item]));
  const models = new Map(settings.models.map((item) => [item.id, item]));
  const externalModels = new Set<string>();
  settings.accounts.forEach((account, index) => {
    if (!providers.has(account.providerId)) context.addIssue({ code: 'custom', path: ['accounts', index, 'providerId'], message: 'Account must reference a saved provider.' });
  });
  settings.models.forEach((model, index) => {
    const account = accounts.get(model.accountId);
    if (!account) {
      context.addIssue({ code: 'custom', path: ['models', index, 'accountId'], message: 'Model must reference a saved account.' });
      return;
    }
    const key = `${model.accountId}\u0000${model.externalId}`;
    if (externalModels.has(key)) context.addIssue({ code: 'custom', path: ['models', index, 'externalId'], message: 'External model IDs must be unique per account.' });
    externalModels.add(key);
  });

  const validateBinding = (binding: z.infer<typeof bindingSchema> | null, capability: z.infer<typeof capabilitySchema> | 'text-or-code', path: (string | number)[]) => {
    if (!binding) return;
    const provider = providers.get(binding.providerId);
    const account = accounts.get(binding.accountId);
    const model = models.get(binding.modelId);
    if (!provider || !account || !model || account.providerId !== binding.providerId || model.accountId !== binding.accountId) {
      context.addIssue({ code: 'custom', path, message: 'Route must resolve through a consistent provider, account and model.' });
      return;
    }
    if (!account.enabled) context.addIssue({ code: 'custom', path, message: 'Route account must be enabled.' });
    const allowed = capability === 'text-or-code' ? ['text', 'code'] : [capability];
    if (!model.capabilities.some((item) => allowed.includes(item))) {
      context.addIssue({ code: 'custom', path, message: `Routed model must declare ${allowed.join(' or ')} capability.` });
    }
  };
  validateBinding(settings.routes.text, 'text-or-code', ['routes', 'text']);
  if (settings.routes.image !== 'mock-svg') validateBinding(settings.routes.image, 'image', ['routes', 'image']);
  validateBinding(settings.routes.video, 'video', ['routes', 'video']);
});

const v2SnapshotSchema = z.strictObject({ schemaVersion: z.literal(2), revision: z.number().int().nonnegative(), settings: settingsSchema });
export const modelBindingSchema = bindingSchema;
export type ModelBinding = z.infer<typeof modelBindingSchema>;

/** The on-disk/API compatibility shape that predates provider/account/model separation. */
export const legacySettingsSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  settings: z.strictObject({
    defaultCount: z.number().int().min(1).max(8),
    providers: z.array(z.strictObject({
      id: idSchema,
      name: z.string().trim().min(1).max(80),
      protocol: protocolSchema,
      baseUrl: endpointSchema,
      model: z.string().trim().min(1).max(160),
      secretEnv: secretEnvSchema,
    })).max(8),
    routes: z.strictObject({ text: idSchema.nullable(), image: z.literal('mock-svg'), video: idSchema.nullable() }),
  }).superRefine((settings, context) => {
    const ids = new Set(settings.providers.map((provider) => provider.id));
    if (ids.size !== settings.providers.length) context.addIssue({ code: 'custom', path: ['providers'], message: 'Provider IDs must be unique.' });
    for (const capability of ['text', 'video'] as const) {
      const id = settings.routes[capability];
      if (id !== null && !ids.has(id)) context.addIssue({ code: 'custom', path: ['routes', capability], message: 'Route must reference a saved provider.' });
    }
  }),
});

/** Both request formats are represented as input schemas; transforms happen after parsing. */
export const saveSettingsSchema = z.union([v2SnapshotSchema, legacySettingsSchema]);
export type SaveSettingsInput = z.infer<typeof saveSettingsSchema>;
type LegacySettingsInput = z.infer<typeof legacySettingsSchema>;
type Snapshot = { schemaVersion: 2; revision: number; settings: z.infer<typeof settingsSchema> };
export type SettingsResponse = Snapshot & {
  runtime: { mode: 'mock'; activeImageModel: 'mock-svg'; externalProvidersEnabled: false };
  credentials: { accountId: string; configured: boolean }[];
};

export function migrateLegacySettings(legacy: LegacySettingsInput): z.infer<typeof settingsSchema> {
  const usedAccounts = new Set<string>();
  const usedModels = new Set<string>();
  const accountIds = new Map<string, string>();
  const modelIds = new Map<string, string>();
  for (const provider of legacy.settings.providers) {
    accountIds.set(provider.id, derivedId('acct', provider.id, usedAccounts));
    modelIds.set(provider.id, derivedId('mdl', provider.id, usedModels));
  }

  const providers = legacy.settings.providers.map((item) => ({
    id: item.id,
    name: item.name,
    transport: isLoopback(item.baseUrl) ? 'local' as const : 'api' as const,
    protocol: item.protocol,
    baseUrl: item.baseUrl,
  }));
  const accounts = legacy.settings.providers.map((item) => ({
    id: accountIds.get(item.id)!, providerId: item.id, label: item.name, secretEnv: item.secretEnv, enabled: true,
  }));
  const models = legacy.settings.providers.map((item) => {
    const capabilities = new Set<z.infer<typeof capabilitySchema>>();
    if (legacy.settings.routes.text === item.id) { capabilities.add('text'); capabilities.add('code'); }
    if (legacy.settings.routes.video === item.id) capabilities.add('video');
    if (capabilities.size === 0) capabilities.add('text');
    return { id: modelIds.get(item.id)!, accountId: accountIds.get(item.id)!, externalId: item.model, name: item.model, capabilities: [...capabilities], pinned: false };
  });
  const binding = (providerId: string | null) => providerId === null ? null : ({
    providerId, accountId: accountIds.get(providerId)!, modelId: modelIds.get(providerId)!,
  });
  return settingsSchema.parse({
    defaultCount: legacy.settings.defaultCount,
    providers, accounts, models,
    routes: { text: binding(legacy.settings.routes.text), image: 'mock-svg', video: binding(legacy.settings.routes.video) },
  });
}

/** Local configuration metadata only. Raw credentials are never accepted or returned. */
export class SettingsStore {
  private state: Snapshot = { schemaVersion: 2, revision: 0, settings: { defaultCount: 4, providers: [], accounts: [], models: [], routes: { text: null, image: 'mock-svg', video: null } } };
  private tail: Promise<unknown> = Promise.resolve();
  private fault: unknown;
  private constructor(private readonly path: string) {}

  static async open(directory: string): Promise<SettingsStore> {
    const store = new SettingsStore(join(directory, 'settings.json'));
    let contents: string;
    try { contents = await readFile(store.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store; throw error; }

    const parsed: unknown = JSON.parse(contents);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid settings snapshot.');
    if ('schemaVersion' in parsed) {
      if (parsed.schemaVersion !== 2) throw new Error('Unsupported settings schemaVersion.');
      const snapshot = v2SnapshotSchema.parse(parsed);
      store.state = snapshot;
      return store;
    }
    const legacy = legacySettingsSchema.parse(parsed);
    store.state = { schemaVersion: 2, revision: legacy.revision, settings: migrateLegacySettings(legacy) };
    // Intentionally do not persist this in-memory migration. The original v1
    // settings.json remains byte-for-byte intact until a successful user save.
    return store;
  }

  assertAvailable(): void {
    if (this.fault) throw new ApiError(503, 'SETTINGS_UNAVAILABLE', '配置存储不可用，请检查存储并重启服务。');
  }

  read(): SettingsResponse {
    this.assertAvailable();
    const snapshot = structuredClone(this.state);
    return {
      ...snapshot,
      runtime: { mode: 'mock', activeImageModel: 'mock-svg', externalProvidersEnabled: false },
      credentials: snapshot.settings.accounts.map((account) => ({
        accountId: account.id,
        configured: account.secretEnv !== '' && Boolean(process.env[account.secretEnv]),
      })),
    };
  }

  hasDeclaredTextModelBinding(binding: ModelBinding): boolean {
    this.assertAvailable();
    const settings = this.state.settings;
    const provider = settings.providers.find((item) => item.id === binding.providerId);
    const account = settings.accounts.find((item) => item.id === binding.accountId);
    const model = settings.models.find((item) => item.id === binding.modelId);
    return Boolean(provider && account && model && account.providerId === provider.id && account.enabled && model.accountId === account.id && model.capabilities.some((capability) => capability === 'text' || capability === 'code'));
  }

  save(input: SaveSettingsInput): Promise<SettingsResponse> {
    const task = this.tail.then(async () => {
      this.assertAvailable();
      if (input.revision !== this.state.revision) throw new ApiError(409, 'SETTINGS_CONFLICT', '配置已在其他页面更新，请重新加载后再保存。');
      const settings = 'schemaVersion' in input ? input.settings : migrateLegacySettings(input);
      const next: Snapshot = { schemaVersion: 2, revision: this.state.revision + 1, settings: structuredClone(settings) };
      try { await atomicWrite(this.path, JSON.stringify(next)); }
      catch (error) { this.fault = error; throw error; }
      this.state = next;
      return this.read();
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  async close() { await this.tail; }
}

function isLoopback(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase();
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

function derivedId(prefix: 'acct' | 'mdl', legacyId: string, used: Set<string>): string {
  const digest = createHash('sha256').update(legacyId).digest('hex');
  const maxLength = 64 - prefix.length - 1;
  for (let length = 12; ; length = Math.min(length + 4, maxLength)) {
    const candidate = `${prefix}-${digest.slice(0, length)}`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
    if (length === maxLength) break;
  }
  // Practically unreachable SHA-256 collision fallback remains deterministic.
  for (let counter = 1; ; counter++) {
    const suffix = createHash('sha256').update(`${legacyId}\u0000${counter}`).digest('hex').slice(0, 12);
    const candidate = `${prefix}-${digest.slice(0, 46)}-${suffix}`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
}
