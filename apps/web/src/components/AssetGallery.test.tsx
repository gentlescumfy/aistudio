import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Asset } from '../types';
import { AssetGallery } from './AssetGallery';

const asset: Asset = { id: 'asset-1', runId: 'run-1', nodeId: 'generate', name: '品牌素材.svg', url: '/api/assets/run-1/asset-1', mimeType: 'image/svg+xml', width: 1024, height: 768, mode: 'mock' };
describe('资产画廊', () => {
  it('轮询返回相同资产时保留预览，关闭按钮可退出', async () => {
    const user = userEvent.setup(); const { rerender } = render(<AssetGallery assets={[asset]} />);
    await user.click(screen.getByRole('button', { name: '预览 品牌素材.svg' }));
    expect(screen.getByRole('dialog')).toHaveAttribute('open');
    rerender(<AssetGallery assets={[{ ...asset }]} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('open');
    await user.click(screen.getByRole('button', { name: '关闭预览' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('下载从 API 获取 Blob 并使用素材文件名', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<svg />', { headers: { 'Content-Type': 'image/svg+xml' } })));
    const createObjectURL = vi.fn().mockReturnValue('blob:demo'); const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { expect(this.download).toBe(asset.name); });
    render(<AssetGallery assets={[asset]} />);
    fireEvent.click(screen.getByRole('button', { name: '下载 品牌素材.svg' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetch).toHaveBeenCalledWith('http://localhost:4000/api/assets/run-1/asset-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(click).toHaveBeenCalledOnce(); expect(createObjectURL).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); expect(revokeObjectURL).toHaveBeenCalledWith('blob:demo'); click.mockRestore();
  });
  it('下载错误提供反馈并允许再次尝试', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    const user = userEvent.setup(); render(<AssetGallery assets={[asset]} />);
    await user.click(screen.getByRole('button', { name: '下载 品牌素材.svg' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('下载失败'));
    expect(screen.getByRole('button', { name: '下载 品牌素材.svg' })).toBeEnabled();
  });
});
