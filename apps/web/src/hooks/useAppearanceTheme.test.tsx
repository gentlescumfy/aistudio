import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppearanceTheme } from './useAppearanceTheme';

const originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
const makeStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  };
};

describe('工作台外观主题', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: makeStorage() });
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.colorScheme = '';
  });
  afterEach(() => {
    if (originalStorage) Object.defineProperty(window, 'localStorage', originalStorage);
  });

  it('未设置时默认暗色，并持久化手动选择', async () => {
    const { result } = renderHook(useAppearanceTheme);
    expect(result.current.theme).toBe('dark');
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));

    act(() => result.current.setTheme('light'));
    expect(window.localStorage.getItem('aistudio-theme')).toBe('light');
    await waitFor(() => expect(document.documentElement.style.colorScheme).toBe('light'));
  });

  it('跟随系统外观变化并能卸载监听', async () => {
    let changed: ((event: MediaQueryListEvent) => void) | undefined;
    let matches = true;
    const remove = vi.fn();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      get matches() { return matches; },
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => { changed = listener; },
      removeEventListener: remove,
    }));
    window.localStorage.setItem('aistudio-theme', 'system');
    const { unmount } = renderHook(useAppearanceTheme);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    act(() => { matches = false; changed?.({ matches } as MediaQueryListEvent); });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    unmount();
    expect(remove).toHaveBeenCalled();
  });

  it('浏览器禁止本地存储时仍可切换主题', async () => {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } });
    const { result } = renderHook(useAppearanceTheme);
    act(() => result.current.setTheme('light'));
    expect(result.current.theme).toBe('light');
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
  });
});
