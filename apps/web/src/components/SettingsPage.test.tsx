import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installApi, sampleSettings } from '../test-fixtures';
import { api } from '../api';
import App from '../App';
import { SettingsPage } from './SettingsPage';

beforeEach(() => window.history.replaceState(null, '', '#settings'));

describe('模型配置 v2', () => {
  it('按供应商、账号与手工模型逐层建立配置，并提交 schemaVersion 2', async () => {
    const fetchMock = installApi(); const user = userEvent.setup(); render(<SettingsPage />);
    await screen.findByRole('heading', { name: '创作默认值' });
    await user.click(screen.getByRole('button', { name: '添加供应商' }));
    const provider = screen.getByRole('region', { name: '供应商 1' });
    await user.type(within(provider).getByRole('textbox', { name: '供应商名称' }), 'Northstar');
    await user.type(within(provider).getByLabelText(/服务基础地址/), 'https://api.example.test/v1');
    await user.click(within(provider).getByRole('button', { name: '添加账号' }));
    const account = within(provider).getByRole('region', { name: '账号 1' });
    await user.type(within(account).getByRole('textbox', { name: '账号名称' }), '制作团队');
    await user.type(within(account).getByLabelText(/密钥环境变量名/), 'NORTHSTAR_API_KEY');
    await user.click(within(account).getByRole('button', { name: '添加模型' }));
    await user.type(within(account).getByRole('textbox', { name: '显示名称' }), 'Aurora Text');
    await user.type(within(account).getByRole('textbox', { name: '供应商模型 ID' }), 'aurora-v2');
    await user.click(within(account).getByRole('checkbox', { name: '图像' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '文本与代码' }), screen.getByRole('option', { name: 'Northstar / 制作团队 / Aurora Text' }));
    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await screen.findByText('配置已保存');

    const save = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/api/settings') && init?.method === 'POST');
    const body = JSON.parse(save![1]!.body as string) as { schemaVersion: number; revision: number; settings: { providers: { id: string }[]; accounts: { id: string; secretEnv: string }[]; models: { id: string; accountId: string; externalId: string; capabilities: string[] }[]; routes: { image: unknown; text: { providerId: string; accountId: string; modelId: string } } } };
    expect(body).toMatchObject({ schemaVersion: 2, revision: 1 });
    expect(body.settings.providers).toHaveLength(1); expect(body.settings.accounts[0].secretEnv).toBe('NORTHSTAR_API_KEY');
    expect(body.settings.models[0]).toMatchObject({ externalId: 'aurora-v2', capabilities: ['text', 'image'] });
    expect(body.settings.routes.text).toEqual({ providerId: body.settings.providers[0].id, accountId: body.settings.accounts[0].id, modelId: body.settings.models[0].id });
    expect(body.settings.routes.image).toBe('mock-svg');
    expect(screen.getByText(/服务端检测到变量存在/)).toBeVisible();
    expect(screen.getByText(/实际运行仅模拟/)).toBeVisible();
  });

  it('显示工作区默认的完整绑定，可搜索模型与切换收藏筛选', async () => {
    const user = userEvent.setup();
    installApi([], undefined, sampleSettings());
    const wrapper = render(<SettingsPage />);
    await screen.findByText('示例供应商');
    const routeSelect = await screen.findByRole('combobox', { name: '文本与代码' });
    expect(routeSelect).toHaveValue('provider-main/account-main/model-main');
    expect(screen.getAllByText('工作区默认').length).toBeGreaterThan(0);
    await user.type(screen.getByRole('searchbox', { name: '搜索供应商、账号或模型' }), '不存在的模型');
    expect(screen.getByText('没有找到匹配的模型，请调整搜索词。')).toBeVisible();
    await user.clear(screen.getByRole('searchbox', { name: '搜索供应商、账号或模型' }));
    await user.click(screen.getByRole('button', { name: /仅显示收藏/ }));
    expect(screen.getByRole('button', { name: /仅显示收藏/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('文本模型')).toBeVisible();
    wrapper.unmount();
  });

  it('显示 AgnesAI 只读目录验证结果，不要求在浏览器录入密钥', async () => {
    const user = userEvent.setup(); installApi();
    const validation = vi.spyOn(api, 'validateAgnesAi').mockResolvedValue({
      ok: true, status: 'connected', message: 'AgnesAI 模型目录读取成功，共 2 个模型；此验证不测试生成权限。', modelCount: 2, checkedAt: '2026-10-07T00:00:00.000Z',
    });
    render(<SettingsPage />); await screen.findByRole('heading', { name: '创作默认值' });
    expect(screen.queryByLabelText(/API密钥|密钥值/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '验证 AgnesAI' }));
    expect(await screen.findByText(/目录读取成功，共 2 个模型/)).toBeVisible();
    expect(validation).toHaveBeenCalledOnce();
    validation.mockRestore();
  });

  it('删除被引用的供应商前说明级联内容，确认后才保存清除后的关联', async () => {
    const user = userEvent.setup(); const fetchMock = installApi([], undefined, sampleSettings());
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    render(<SettingsPage />); await screen.findByText('示例供应商');
    await user.click(screen.getByRole('button', { name: '删除供应商 示例供应商' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('1 个账号、1 个模型及 1 条默认路由'));
    expect(screen.getByText('文本模型')).toBeVisible();
    expect(screen.getByRole('button', { name: '保存配置' })).toBeDisabled();
    vi.mocked(window.confirm).mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: '删除供应商 示例供应商' }));
    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await screen.findByText('配置已保存');
    const save = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/api/settings') && init?.method === 'POST');
    expect(JSON.parse(save![1]!.body as string).settings).toMatchObject({ providers: [], accounts: [], models: [], routes: { text: null, image: 'mock-svg' } });
  });

  it('删除引用了图像默认绑定的账号时将图像路由回退为 mock-svg', async () => {
    const settings = sampleSettings();
    settings.models[0]!.capabilities.push('image');
    settings.routes.image = { providerId: 'provider-main', accountId: 'account-main', modelId: 'model-main' };
    const fetchMock = installApi([], undefined, settings); const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    render(<SettingsPage />); await screen.findByText('示例供应商');
    await user.click(screen.getByRole('button', { name: '删除账号 团队账号' }));
    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await screen.findByText('配置已保存');
    const save = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/api/settings') && init?.method === 'POST');
    expect(JSON.parse(save![1]!.body as string).settings.routes.image).toBe('mock-svg');
  });

  it('删除引用了图像默认绑定的模型时保留有效的 mock-svg 路由', async () => {
    const settings = sampleSettings();
    settings.models[0]!.capabilities.push('image');
    settings.routes.image = { providerId: 'provider-main', accountId: 'account-main', modelId: 'model-main' };
    const fetchMock = installApi([], undefined, settings); const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    render(<SettingsPage />); await screen.findByText('示例供应商');
    await user.click(screen.getByRole('button', { name: '删除模型 文本模型' }));
    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await screen.findByText('配置已保存');
    const save = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/api/settings') && init?.method === 'POST');
    expect(JSON.parse(save![1]!.body as string).settings.routes.image).toBe('mock-svg');
  });

  it('在导航离开前保留脏编辑，拒绝时不改 hash', async () => {
    const user = userEvent.setup(); installApi();
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    render(<App />); await screen.findByRole('heading', { name: '创作默认值' });
    await user.clear(screen.getByRole('spinbutton', { name: /默认生成数量/ }));
    await user.type(screen.getByRole('spinbutton', { name: /默认生成数量/ }), '6');
    expect(screen.getByText('有未保存的修改')).toBeVisible();
    await user.click(screen.getByRole('link', { name: /创作工作台/ }));
    expect(window.confirm).toHaveBeenCalled(); expect(window.location.hash).toBe('#settings');
    expect(screen.getByText('有未保存的修改')).toBeVisible();
  });
});
