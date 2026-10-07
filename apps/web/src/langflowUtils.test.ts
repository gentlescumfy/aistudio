import { describe, expect, it } from 'vitest';
import { isLangflowRunActive, isLoopbackUrl, langflowRunStatusLabel, safeEditorHref, validateLangflowConfig, validateLangflowInput } from './langflowUtils';
import type { LangflowConfig } from './types';

const config: LangflowConfig = { baseUrl: 'http://127.0.0.1:7860', authMode: 'local-development', secretEnv: '', timeoutMs: 30000 };

describe('Langflow 前端边界规则', () => {
  it('只接受无凭据、无查询的本机 HTTP(S) 地址作为编辑器入口', () => {
    expect(isLoopbackUrl('http://127.0.0.1:7860')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:7860')).toBe(true);
    expect(isLoopbackUrl('https://localhost:7860/editor')).toBe(true);
    for (const value of ['https://example.com', 'http://127.0.0.1:7860/?key=secret', 'http://user:pass@localhost:7860', 'javascript:alert(1)']) {
      expect(isLoopbackUrl(value)).toBe(false);
      expect(safeEditorHref(value)).toBeNull();
    }
    expect(safeEditorHref('http://127.0.0.1:7860/')).toBe('http://127.0.0.1:7860/');
  });

  it('校验 API 密钥环境变量名而不接受密钥值，限制连接超时和运行输入', () => {
    expect(validateLangflowConfig(config)).toBeNull();
    expect(validateLangflowConfig({ ...config, authMode: 'api-key-env', secretEnv: 'LANGFLOW_API_KEY' })).toBeNull();
    expect(validateLangflowConfig({ ...config, authMode: 'api-key-env' })).toMatch(/环境变量名/);
    expect(validateLangflowConfig({ ...config, secretEnv: 'sk-live-secret' })).toMatch(/大写/);
    expect(validateLangflowConfig({ ...config, baseUrl: 'http://192.168.1.10:7860' })).toMatch(/回环地址/);
    expect(validateLangflowConfig({ ...config, timeoutMs: 999 })).toMatch(/超时/);
    expect(validateLangflowInput('  ')).toMatch(/填写/);
    expect(validateLangflowInput('x'.repeat(2001))).toMatch(/2000/);
    expect(validateLangflowInput('  Echo  ')).toBeNull();
  });

  it('将未知运行结果明确标为待确认且不当作活动运行', () => {
    expect(langflowRunStatusLabel.outcome_unknown).toBe('结果待确认');
    expect(isLangflowRunActive('queued')).toBe(true);
    expect(isLangflowRunActive('running')).toBe(true);
    expect(isLangflowRunActive('outcome_unknown')).toBe(false);
  });
});
