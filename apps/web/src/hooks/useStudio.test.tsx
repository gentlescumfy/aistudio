import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { installApi, makeRun } from '../test-fixtures';
import { useStudio } from './useStudio';

describe('工作台提交与轮询', () => {
  it('网络结果不确定时复用幂等键，成功后的新创作使用新键', async () => {
    const keys: string[] = [];
    let calls = 0;
    installApi([], async body => {
      keys.push(body.idempotencyKey as string); calls += 1;
      if (calls === 1) throw new TypeError('network');
      return Response.json({ run: makeRun() });
    });
    const { result } = renderHook(useStudio);
    await waitFor(() => expect(result.current.connected).toBe(true));
    await act(async () => { await result.current.createRun('brand-image', { prompt: '咖啡', count: 2 }); });
    expect(result.current.actionError).toMatch(/无法连接/);
    await act(async () => { await result.current.createRun('brand-image', { prompt: '咖啡', count: 2 }); });
    await act(async () => { await result.current.createRun('brand-image', { prompt: '咖啡', count: 2 }); });
    expect(keys[1]).toBe(keys[0]); expect(keys[2]).not.toBe(keys[0]);
  });
  it('快速重复提交只发送一个创建请求', async () => {
    const fetchMock = installApi(); const { result } = renderHook(useStudio);
    await waitFor(() => expect(result.current.connected).toBe(true));
    await act(async () => { await Promise.all([result.current.createRun('brand-image', { prompt: '咖啡', count: 2 }), result.current.createRun('brand-image', { prompt: '咖啡', count: 2 })]); });
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/runs') && init?.method === 'POST')).toHaveLength(1);
  });
  it('卸载后清理轮询和未完成的请求', async () => {
    vi.useFakeTimers(); const fetchMock = installApi([makeRun()]);
    const { unmount } = renderHook(useStudio);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    const before = fetchMock.mock.calls.length;
    expect(before).toBeGreaterThan(3);
    const signals = fetchMock.mock.calls.map(([, init]) => init?.signal).filter(Boolean);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(fetchMock.mock.calls).toHaveLength(before);
    // Any request still pending at unmount is aborted; resolved requests leave no timers.
    expect(signals.length).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
