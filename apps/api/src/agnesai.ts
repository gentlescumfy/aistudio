export type AgnesAiValidationStatus =
  | 'connected'
  | 'missing_key'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'upstream_error'
  | 'network_error'
  | 'invalid_response';

export interface AgnesAiValidation {
  ok: boolean;
  status: AgnesAiValidationStatus;
  message: string;
  modelCount: number | null;
  checkedAt: string;
}

const modelCatalogUrl = 'https://apihub.agnes-ai.com/v1/models';
const timeoutMs = 8000;

function result(
  status: AgnesAiValidationStatus,
  message: string,
  modelCount: number | null = null,
): AgnesAiValidation {
  return { ok: status === 'connected', status, message, modelCount, checkedAt: new Date().toISOString() };
}

function isModelCatalog(value: unknown): value is { data: { id: string }[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = (value as { data?: unknown }).data;
  return Array.isArray(data) && data.every((item) => !!item && typeof item === 'object' && !Array.isArray(item)
    && typeof (item as { id?: unknown }).id === 'string' && (item as { id: string }).id.length > 0);
}

/** Read-only AgnesAI model-catalogue validation. Never sends prompts or returns credentials. */
export async function validateAgnesAi(
  fetcher: typeof fetch = fetch,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AgnesAiValidation> {
  const key = environment.AGNES_API_KEY?.trim() || environment.GNESAI_API_KEY?.trim();
  if (!key) return result('missing_key', 'AI Studio API 服务进程中未检测到 AGNES_API_KEY。');

  try {
    const response = await fetcher(modelCatalogUrl, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      cache: 'no-store',
    });
    if (response.status === 401) return result('unauthorized', 'AgnesAI 返回 HTTP 401：API 服务进程中的密钥未通过认证，请检查密钥有效性、账号状态和 API 访问权限。');
    if (response.status === 403) return result('forbidden', 'AgnesAI 返回 HTTP 403：当前密钥没有读取模型目录的权限。');
    if (response.status === 429) return result('rate_limited', 'AgnesAI 暂时限制了请求，请稍后重试。');
    if (!response.ok) return result('upstream_error', `AgnesAI 返回 HTTP ${response.status}，模型目录暂不可用。`);

    let payload: unknown;
    try { payload = await response.json(); }
    catch { return result('invalid_response', 'AgnesAI 已响应，但模型目录不是有效的 JSON。'); }
    if (!isModelCatalog(payload)) return result('invalid_response', 'AgnesAI 已响应，但返回格式不符合模型目录约定。');
    return result('connected', `AgnesAI 模型目录读取成功，共 ${payload.data.length} 个模型；此验证不测试生成权限。`, payload.data.length);
  } catch {
    return result('network_error', '无法连接 AgnesAI 或请求超时，请检查网络和服务状态。');
  }
}
