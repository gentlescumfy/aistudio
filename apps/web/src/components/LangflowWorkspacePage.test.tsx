import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../api';
import { LangflowWorkspacePage } from './LangflowWorkspacePage';
import type { LangflowConfig, LangflowRun } from '../types';

const config: LangflowConfig = { baseUrl: 'http://127.0.0.1:7860', authMode: 'local-development', secretEnv: '', timeoutMs: 30000 };
const flow = { id: '18b59ef1-65a0-4a92-9b84-57ed19926d5e', name: 'Echo', description: '原生输入输出回显流程。', updatedAt: '2026-10-07T00:00:00.000Z' };
const run = (patch: Partial<LangflowRun> = {}): LangflowRun => ({
  id: 'run-receipt-1', flowId: flow.id, flowName: flow.name, input: 'hello', status: 'succeeded',
  createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:01.000Z', output: 'hello', error: null, provider: 'langflow', ...patch,
});

describe('Langflow 工作区', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.spyOn(api, 'langflowConfig').mockResolvedValue({ revision: 2, config, credentialConfigured: false });
    vi.spyOn(api, 'langflowStatus').mockResolvedValue({ connected: false, version: null, editorUrl: config.baseUrl, authMode: config.authMode, message: 'Langflow 服务未就绪。' });
    vi.spyOn(api, 'langflowFlows').mockResolvedValue({ flows: [flow] });
    vi.spyOn(api, 'langflowRuns').mockResolvedValue({ runs: [] });
  });

  it('服务未连接时说明状态、不伪造流程，并以环境变量名保存设置', async () => {
    const user = userEvent.setup();
    const saveSpy = vi.spyOn(api, 'saveLangflowConfig').mockResolvedValue({ revision: 3, config: { ...config, authMode: 'api-key-env', secretEnv: 'LANGFLOW_API_KEY' }, credentialConfigured: true });
    const flowsSpy = vi.mocked(api.langflowFlows);
    render(<LangflowWorkspacePage />);
    expect(await screen.findByText('Langflow 连接未就绪')).toBeVisible();
    expect(screen.getByText('连接未就绪')).toBeVisible();
    expect(screen.queryByRole('link', { name: /打开 Langflow 原生编辑器/ })).not.toBeInTheDocument();
    expect(flowsSpy).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText('Langflow 认证方式'), 'api-key-env');
    await user.type(screen.getByLabelText('API 密钥环境变量名'), 'LANGFLOW_API_KEY');
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: '刷新连接与流程' }));
    expect(screen.getByLabelText('API 密钥环境变量名')).toHaveValue('LANGFLOW_API_KEY');
    expect(api.langflowConfig).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '保存连接配置' }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith(2, { ...config, authMode: 'api-key-env', secretEnv: 'LANGFLOW_API_KEY' }, expect.any(AbortSignal)));
  });

  it('显示原生流程、安全编辑器入口、运行输出并显式提交输入', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'langflowStatus').mockResolvedValue({ connected: true, version: '1.12.5', editorUrl: config.baseUrl, authMode: config.authMode, message: 'Langflow 已连接。' });
    vi.spyOn(api, 'langflowRuns').mockResolvedValue({ runs: [run()] });
    const createSpy = vi.spyOn(api, 'createLangflowRun').mockResolvedValue({ run: run({ id: 'run-receipt-2', input: 'ping', status: 'queued', output: null, updatedAt: '2026-10-07T00:00:02.000Z' }) });
    render(<LangflowWorkspacePage />);

    expect(await screen.findByText('Langflow 已连接')).toBeVisible();
    expect((await screen.findAllByRole('button', { name: /Echo/ })).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /打开 Langflow 原生编辑器/ })).toHaveAttribute('href', 'http://127.0.0.1:7860/');
    expect(screen.getByRole('link', { name: /打开 Langflow 原生编辑器/ })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getAllByText('hello').length).toBeGreaterThan(0);

    await user.clear(screen.getByLabelText('本次运行输入'));
    await user.type(screen.getByLabelText('本次运行输入'), 'ping');
    await user.click(screen.getByRole('button', { name: '运行 Langflow 流程' }));
    expect((await screen.findAllByText('排队中')).length).toBeGreaterThan(0);
    expect(createSpy).toHaveBeenCalledWith(flow.id, 'ping', expect.any(String), expect.any(AbortSignal));
    expect(screen.queryByText('本地 SVG 模拟素材')).not.toBeInTheDocument();
  });

  it('将 outcome_unknown 显示为待确认，并锁定相同输入且不提供重试或取消', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'langflowStatus').mockResolvedValue({ connected: true, version: '1.12.5', editorUrl: config.baseUrl, authMode: config.authMode, message: 'Langflow 已连接。' });
    vi.spyOn(api, 'langflowRuns').mockResolvedValue({ runs: [] });
    const unknown = run({ id: 'run-unknown', input: 'ping', status: 'outcome_unknown', output: null, error: null });
    vi.spyOn(api, 'createLangflowRun').mockResolvedValue({ run: unknown });
    render(<LangflowWorkspacePage />);
    await screen.findByText('Langflow 已连接');
    await user.type(await screen.findByLabelText('本次运行输入'), 'ping');
    await user.click(screen.getByRole('button', { name: '运行 Langflow 流程' }));
    expect((await screen.findAllByText('结果待确认')).length).toBeGreaterThan(0);
    expect(screen.getByText(/不提供重试或取消操作/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /重试|取消/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '运行 Langflow 流程' })).toBeDisabled();
  });

  it('409 时保留连接配置草稿供用户处理', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'saveLangflowConfig').mockRejectedValue(new ApiError('配置版本冲突', 'REVISION_CONFLICT', 409));
    render(<LangflowWorkspacePage />);
    await screen.findByText('Langflow 连接未就绪');
    const address = screen.getByLabelText('Langflow 服务地址');
    await user.clear(address); await user.type(address, 'http://localhost:7860');
    await user.click(screen.getByRole('button', { name: '保存连接配置' }));
    expect(await screen.findByText(/配置版本已变化/)).toBeVisible();
    expect(address).toHaveValue('http://localhost:7860');
  });
});
