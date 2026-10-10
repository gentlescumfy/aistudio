import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from './App';
import { installApi, makeRun } from './test-fixtures';

describe('中文工作台用户流程', () => {
  it('提供可访问的主题切换并应用浅色主题', async () => {
    installApi(); const user = userEvent.setup(); render(<App />);
    const selector = await screen.findByRole('combobox', { name: '界面主题' });
    expect(selector).toHaveValue('dark');
    await user.selectOptions(selector, 'light');
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
  });
  it('显示模拟标识、禁用未来功能，并支持输入、创建与取消', async () => {
    const fetchMock = installApi(); const user = userEvent.setup(); render(<App />);
    const submit = screen.getByRole('button', { name: '开始创作' });
    await waitFor(() => expect(submit).toBeEnabled());
    expect(screen.getByText('工作流运行', { exact: true })).toBeVisible();
    expect(screen.getByRole('button', { name: /视频创作/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /编码助手/ })).toBeDisabled();
    await user.click(submit); expect(screen.getByRole('alert')).toHaveTextContent('请描述');
    await user.type(screen.getByLabelText(/素材描述/), '  极简咖啡  ');
    await user.clear(screen.getByLabelText('生成数量')); await user.type(screen.getByLabelText('生成数量'), '2');
    await user.click(submit);
    await user.click(await screen.findByRole('button', { name: '取消运行' }));
    await waitFor(() => expect(screen.getByText(/已停止安排后续节点/)).toBeVisible());
    const creation = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/api/runs') && init?.method === 'POST');
    expect(JSON.parse(creation![1]!.body as string).inputs).toEqual({ prompt: '极简咖啡', count: 2 });
  });
  it('选择失败运行后可重试，并展示节点状态和进度', async () => {
    const fetchMock = installApi([makeRun('failed')]); const user = userEvent.setup(); render(<App />);
    await user.click(await screen.findByRole('button', { name: /极简咖啡.*执行失败/ }));
    await user.click(await screen.findByRole('button', { name: '重试失败节点' }));
    await screen.findByRole('button', { name: '取消运行' });
    expect(screen.getAllByRole('progressbar', { name: '工作流完成进度' })).toHaveLength(2);
    expect(screen.getAllByRole('progressbar', { name: '工作流完成进度' }).every(progress => progress.getAttribute('value') === '50')).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/run-1/retry'))).toBe(true);
  });
  it('服务离线时给出恢复入口并禁止创建', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline'))); render(<App />);
    await screen.findByRole('button', { name: '重新连接' });
    expect(screen.getByRole('button', { name: '开始创作' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('无法连接工作台服务');
  });
});
