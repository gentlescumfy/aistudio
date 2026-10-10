import type { LangflowConfig, LangflowRunStatus } from './types';

export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const parts = hostname.split('.');
    const loopbackIpv4 = parts.length === 4 && Number(parts[0]) === 127 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
    return ['http:', 'https:'].includes(url.protocol)
      && (hostname === 'localhost' || hostname === '::1' || loopbackIpv4)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function safeEditorHref(value: string): string | null {
  if (!isLoopbackUrl(value)) return null;
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/$/, '') || '/'}`;
}

export function validateLangflowConfig(config: LangflowConfig): string | null {
  if (!isLoopbackUrl(config.baseUrl)) return '服务地址必须使用本机回环地址（localhost、127.0.0.1 或 ::1），且不能包含账号、查询参数或片段。';
  if (config.authMode === 'api-key-env' && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(config.secretEnv)) return 'API 密钥环境变量名格式无效；请填写变量名，不要填写密钥值。';
  if (config.secretEnv && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(config.secretEnv)) return '环境变量名须以大写字母或下划线开头。';
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 120000) return '请求超时须为 1000–120000 毫秒的整数。';
  return null;
}

export function validateLangflowInput(input: string): string | null {
  if (!input.trim()) return '请填写本次运行输入。';
  if (input.trim().length > 2000) return '运行输入最多 2000 个字符。';
  return null;
}

export const langflowRunStatusLabel: Record<LangflowRunStatus, string> = {
  queued: '排队中', running: '运行中', succeeded: '已完成', failed: '运行失败', cancelled: '已取消', outcome_unknown: '结果待确认',
};

export const langflowRunStatusDescription: Record<LangflowRunStatus, string> = {
  queued: '已登记，等待 Langflow 处理。',
  running: 'Langflow 正在处理该流程。',
  succeeded: 'Langflow 已返回结果。',
  failed: 'Langflow 执行失败；此记录保留供查看。',
  cancelled: '任务已取消；已停止接收结果。',
  outcome_unknown: '请求可能已在 Langflow 执行，但未能确认结果。请先刷新历史，不要自动重提。',
};

export function isLangflowRunActive(status: LangflowRunStatus): boolean {
  return status === 'queued' || status === 'running';
}
