import { ProviderOutcomeUnknownError } from './provider.js';
import type { AgentModelTarget } from './settings.js';
import type { RoleRecord } from './roles.js';

const maxResponseBytes = 1_000_000;
const maxOutputCharacters = 16_000;

export type AgentCompletion = { text: string; providerName: string; modelName: string; completedAt: string };

/** A bounded, single-turn text adapter. Role tool declarations are never executed. */
export class TextAgentRuntime {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async execute(role: RoleRecord, prompt: string, target: AgentModelTarget, signal: AbortSignal): Promise<AgentCompletion> {
    const apiKey = this.environment[target.secretEnv]?.trim();
    if (!apiKey) throw new Error(`AI Studio API 服务进程中未检测到 ${target.secretEnv}，请配置后重试。`);

    const timeout = AbortSignal.timeout(target.deadlineMs);
    const requestSignal = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.fetcher(chatCompletionsUrl(target.baseUrl), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: target.modelId,
          messages: [
            { role: 'system', content: `${role.systemPrompt}\n\n输入约定：${role.inputContract}\n输出约定：${role.outputContract}\n执行边界：本次仅进行单轮文本生成；不提供工具、文件系统、浏览器、网络访问或代码执行。` },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1600,
          temperature: 0.4,
        }),
        signal: requestSignal,
        redirect: 'error',
        cache: 'no-store',
      });
    } catch {
      const reason = signal.aborted ? '代理调用已取消，供应商可能已接收请求；请核对用量后再处理。'
        : timeout.aborted ? '代理调用超时，供应商可能已完成请求；请核对用量后再处理。'
          : '代理服务连接中断，调用结果未知；请核对供应商用量后再处理。';
      throw new ProviderOutcomeUnknownError(reason);
    }

    if (response.status === 401) throw new Error('模型服务认证失败，请检查 AI Studio API 服务进程中的密钥环境变量。');
    if (response.status === 403) throw new Error('模型服务拒绝当前账号访问，请检查服务商账号权限。');
    if (response.status === 429) throw new Error('模型服务限流，请稍后重试或检查账号额度。');
    if (response.status >= 500) throw new ProviderOutcomeUnknownError(`模型服务返回 HTTP ${response.status}，本次调用结果未知；请核对供应商用量后再处理。`);
    if (!response.ok) throw new Error(`模型服务拒绝请求（HTTP ${response.status}），请检查接口地址和模型 ID。`);

    let payload: unknown;
    try { payload = JSON.parse(await readBoundedResponse(response)); }
    catch (error) {
      if (error instanceof ProviderOutcomeUnknownError) throw error;
      throw new ProviderOutcomeUnknownError('模型服务已响应，但返回内容无法解析；请核对供应商用量后再处理。');
    }
    const text = responseText(payload);
    if (!text || text.length > maxOutputCharacters) {
      throw new ProviderOutcomeUnknownError('模型服务已响应，但没有返回可用文本或输出超出限制；请核对供应商用量后再处理。');
    }
    return { text, providerName: target.providerName, modelName: target.modelName, completedAt: new Date().toISOString() };
  }
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return /\/v1$/i.test(normalized) ? `${normalized}/chat/completions` : `${normalized}/v1/chat/completions`;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw new ProviderOutcomeUnknownError('模型服务响应超出大小限制；请核对供应商用量后再处理。');
  }
  if (!response.body) throw new ProviderOutcomeUnknownError('模型服务响应为空；请核对供应商用量后再处理。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        throw new ProviderOutcomeUnknownError('模型服务响应超出大小限制；请核对供应商用量后再处理。');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProviderOutcomeUnknownError) throw error;
    throw new ProviderOutcomeUnknownError('模型服务响应中断；请核对供应商用量后再处理。');
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concat(chunks, size));
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function responseText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) return undefined;
  const message = choices[0] && typeof choices[0] === 'object' ? (choices[0] as { message?: unknown }).message : undefined;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((part) => part && typeof part === 'object' && !Array.isArray(part)
    && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string'
    ? [(part as { text: string }).text] : []).join('').trim();
  return text || undefined;
}
