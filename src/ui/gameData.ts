import { useEffect, useState } from 'preact/hooks';
import type { DropRates } from '../catalog/drops';
import type { GameEvent, Stage } from '../domain/stages';

/* ------------------------------------------------------------------ */
/* 遊戲資料快取：同一次開啟期間只讀一次，切換頁面不再重新讀取（不會一直「讀取中」）。 */
/* 失敗不快取；「更新遊戲資料」完成後呼叫 clearGameDataCache() 重新讀。          */
/* ------------------------------------------------------------------ */
const cache = new Map<string, unknown>();
const pending = new Map<string, Promise<unknown>>();
// 每次清除快取就換一個世代：清除前就開始的讀取，完成時不能再寫回快取（避免舊資料蓋掉更新後的資料）。
const generation = new Map<string, number>();
let globalGeneration = 0;
const currentGeneration = (key: string) => `${globalGeneration}:${generation.get(key) ?? 0}`;
export function cachedLoad<T>(key: string, loader: () => Promise<T>): Promise<T> {
  if (cache.has(key)) return Promise.resolve(cache.get(key) as T);
  const running = pending.get(key) as Promise<T> | undefined;
  if (running) return running;
  const started = currentGeneration(key);
  const next = loader().then(value => {
    if (currentGeneration(key) === started) { cache.set(key, value); pending.delete(key); }
    return value;
  }, err => { if (currentGeneration(key) === started) pending.delete(key); throw err; });
  pending.set(key, next);
  return next;
}
export const peekCache = <T,>(key: string): T | undefined => cache.get(key) as T | undefined;
export function clearGameDataCache(key?: string) {
  if (key) { cache.delete(key); pending.delete(key); generation.set(key, (generation.get(key) ?? 0) + 1); }
  else { cache.clear(); pending.clear(); globalGeneration++; }
}

/** 讀取分頁清單（關卡、活動），每頁最多 1000 筆。 */
async function readList<T>(name: 'stages' | 'events', signal: AbortSignal): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const response = await fetch(`/api/game-data/${name}?limit=1000&offset=${offset}`, { credentials: 'omit', redirect: 'error', signal, cache: 'no-store' });
    const body = await response.json().catch(() => null) as { items?: T[]; total?: number; error?: { message?: string } } | null;
    if (!response.ok || !Array.isArray(body?.items)) throw new Error(body?.error?.message ?? '');
    out.push(...body.items);
    if (out.length >= (body.total ?? 0) || !body.items.length) break;
  }
  return out;
}

export interface StageData { stages: Stage[]; events: GameEvent[]; drops: DropRates | null; dropsError: string }

/** 關卡、活動與企鵝物流掉落統計（後者可能尚未同步，失敗不影響前兩者）。 */
export function useStageData(isDemo: boolean) {
  const [data, setData] = useState<StageData | null>(() => isDemo ? null : peekCache<StageData>('stages') ?? null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (isDemo) { setError('示範資料沒有關卡資料；請切換到個人工作區並更新遊戲資料。'); return; }
    let active = true;
    // 共用的讀取不綁元件的 AbortController，切走再切回來可以接著用同一份結果。
    const controller = new AbortController();
    cachedLoad<StageData>('stages', async () => {
      const [stages, events] = await Promise.all([readList<Stage>('stages', controller.signal), readList<GameEvent>('events', controller.signal)]);
      let drops: DropRates | null = null, dropsError = '';
      try {
        const response = await fetch('/api/game-data/drops', { credentials: 'omit', redirect: 'error', cache: 'no-store' });
        const body = await response.json().catch(() => null) as (DropRates & { error?: { message?: string } }) | null;
        if (response.ok && body?.stages) drops = body; else dropsError = body?.error?.message ?? '無法讀取掉落統計。';
      } catch { dropsError = '無法讀取掉落統計。'; }
      return { stages, events, drops, dropsError };
    }).then(value => { if (active) setData(value); }, err => { if (active) setError(err instanceof Error && err.message ? err.message : '無法讀取關卡資料，請確認已執行 npm run game-data 並在設定更新遊戲資料。'); });
    return () => { active = false; };
  }, [isDemo]);
  return { data, error };
}
