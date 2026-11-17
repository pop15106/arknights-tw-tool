import { useEffect, useRef, useState } from 'preact/hooks';

// 未保存的草稿暫存在這台裝置（localStorage）：切換頁面、關掉再開都還在，按「保存」後才清掉。
// 只在草稿當初依據的「已保存版本」沒變時還原，避免用舊草稿蓋掉之後保存（或從備份復原）的資料。
const PREFIX = 'arknights-tw-draft:';
const readJson = <T,>(key: string): T | null => { try { return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null; } catch { return null; } };
const writeJson = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 空間不足或無法寫入：只在本次有效 */ } };
const remove = (key: string) => { try { localStorage.removeItem(key); } catch { /* 不影響使用 */ } };

export function usePersistentDraft<T>(name: string, saved: T): { draft: T; setDraft: (next: T | ((current: T) => T)) => void; restored: boolean; discard: () => void } {
  const key = PREFIX + name;
  const savedJson = JSON.stringify(saved);
  const [initial] = useState(() => {
    const stored = readJson<{ saved: string; draft: T }>(key);
    if (stored && stored.saved === savedJson && JSON.stringify(stored.draft) !== savedJson) return { draft: stored.draft, restored: true };
    if (stored) remove(key);
    return { draft: saved, restored: false };
  });
  const [draft, setDraft] = useState<T>(initial.draft);
  const [restored, setRestored] = useState(initial.restored);
  // 已保存的版本改變（按了保存、從備份復原）時，草稿改用新的已保存版本；第一次掛載不算。
  const lastSaved = useRef(savedJson);
  useEffect(() => {
    if (lastSaved.current === savedJson) return;
    lastSaved.current = savedJson;
    setDraft(JSON.parse(savedJson) as T); setRestored(false);
  }, [savedJson]);
  useEffect(() => {
    if (JSON.stringify(draft) === savedJson) remove(key);
    else writeJson(key, { saved: savedJson, draft });
  }, [draft, savedJson, key]);
  return { draft, setDraft, restored, discard: () => { setDraft(JSON.parse(savedJson) as T); setRestored(false); remove(key); } };
}

/** 一般的頁面狀態（目前分頁、篩選、計算結果等）：記在這台裝置，下次開啟沿用。 */
export function useRemembered<T>(name: string, fallback: T, valid: (value: unknown) => value is T = (_value: unknown): _value is T => true): [T, (next: T) => void] {
  const key = 'arknights-tw-ui:' + name;
  const [value, setValue] = useState<T>(() => { const stored = readJson<unknown>(key); return stored !== null && valid(stored) ? stored : fallback; });
  return [value, (next: T) => { setValue(next); writeJson(key, next); }];
}
