import { useEffect, useState } from 'react';
export type Theme = 'system' | 'light' | 'dark';
const key = 'postbox-theme';
function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(key);
    if (value === 'light' || value === 'dark') return value;
  } catch {}
  return 'system';
}
export function applyTheme(theme: Theme) {
  const dark =
    theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#171820' : '#f7f7fb');
  return dark;
}
applyTheme(savedTheme());
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(savedTheme),
    [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  useEffect(() => {
    const update = () => setDark(applyTheme(theme));
    update();
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [theme]);
  return {
    theme,
    dark,
    setTheme: (next: Theme) => {
      try {
        localStorage.setItem(key, next);
      } catch {}
      setDark(applyTheme(next));
      setTheme(next);
    },
  };
}
