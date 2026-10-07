import { useEffect, useState } from 'react';

export type AppearanceTheme = 'dark' | 'light' | 'system';
const STORAGE_KEY = 'aistudio-theme';

function readPreference(): AppearanceTheme {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'system' || value === 'dark' ? value : 'dark';
  } catch {
    return 'dark';
  }
}

export function useAppearanceTheme() {
  const [preference, setPreference] = useState<AppearanceTheme>(readPreference);
  const [systemDark, setSystemDark] = useState(() => {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
    catch { return true; }
  });

  useEffect(() => {
    if (preference !== 'system') return;
    let media: MediaQueryList;
    try { media = window.matchMedia('(prefers-color-scheme: dark)'); }
    catch { return; }
    const update = () => setSystemDark(media.matches);
    update();
    if (media.addEventListener) {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, [preference]);

  useEffect(() => {
    const effective = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = effective;
    document.documentElement.style.colorScheme = effective;
  }, [preference, systemDark]);

  const setTheme = (next: AppearanceTheme) => {
    setPreference(next);
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* appearance remains usable without storage */ }
  };

  return { theme: preference, setTheme };
}
