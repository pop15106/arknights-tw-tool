import { useEffect, useState } from 'preact/hooks';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'arknights-tw-theme';

function read(): ThemeChoice {
  try { const value = localStorage.getItem(KEY); return value === 'light' || value === 'dark' ? value : 'system'; } catch { return 'system'; }
}

/** 主題偏好只存在這台裝置；讀寫失敗（私密瀏覽等）時退回跟隨系統。 */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(read);
  useEffect(() => {
    const root = document.documentElement;
    if (choice === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', choice);
    try { if (choice === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice); } catch { /* 不影響使用 */ }
  }, [choice]);
  const systemDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  const effective = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;
  return { choice, effective, setChoice, toggle: () => setChoice(effective === 'dark' ? 'light' : 'dark') };
}
