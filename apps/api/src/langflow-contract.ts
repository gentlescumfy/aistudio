import { isIP } from 'node:net';
import { z } from 'zod';

export const langflowConfigSchema = z.strictObject({
  baseUrl: z.string().trim().min(1).max(500),
  authMode: z.enum(['local-development', 'api-key-env']),
  secretEnv: z.string().max(128),
  timeoutMs: z.number().int().min(1000).max(120_000),
}).superRefine((config, context) => {
  let url: URL;
  try { url = new URL(config.baseUrl); }
  catch { context.addIssue({ code: 'custom', path: ['baseUrl'], message: 'Enter a valid loopback HTTP(S) URL.' }); return; }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (!['http:', 'https:'].includes(url.protocol) || !loopback || url.username || url.password || url.search || url.hash) {
    context.addIssue({ code: 'custom', path: ['baseUrl'], message: 'Langflow URL must use loopback HTTP(S), without credentials, query, or fragment.' });
  }
  if (config.secretEnv !== '' && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(config.secretEnv)) {
    context.addIssue({ code: 'custom', path: ['secretEnv'], message: 'Use an uppercase environment variable name, never a credential value.' });
  }
  if (config.authMode === 'api-key-env' && config.secretEnv === '') {
    context.addIssue({ code: 'custom', path: ['secretEnv'], message: 'API-key mode requires an environment variable name.' });
  }
});

export const saveLangflowConfigSchema = z.strictObject({ revision: z.number().int().nonnegative(), config: langflowConfigSchema });
export const langflowRunRequestSchema = z.strictObject({
  flowId: z.uuid(), input: z.string().trim().min(1).max(2000),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
});

export const defaultLangflowConfig: LangflowConfig = {
  baseUrl: 'http://127.0.0.1:7860', authMode: 'local-development', secretEnv: '', timeoutMs: 30_000,
};

export type LangflowConfig = z.infer<typeof langflowConfigSchema>;
export type LangflowRunRequest = z.infer<typeof langflowRunRequestSchema>;
export type LangflowFlow = { id: string; name: string; description: string; updatedAt: string | null };
export type LangflowRun = {
  id: string; flowId: string; flowName: string;
  input: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'outcome_unknown';
  createdAt: string; updatedAt: string;
  output: string | null; error: string | null;
  provider: 'langflow';
};
export type LangflowStatus = {
  connected: boolean; version: string | null;
  editorUrl: string; authMode: LangflowConfig['authMode']; message: string;
};
