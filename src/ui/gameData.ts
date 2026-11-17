import { useEffect, useState } from 'preact/hooks';
import type { DropRates } from '../catalog/drops';
import type { GameEvent, Stage } from '../domain/stages';

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
  const [data, setData] = useState<StageData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (isDemo) { setError('示範資料沒有關卡資料；請切換到個人工作區並更新遊戲資料。'); return; }
    const controller = new AbortController();
    void (async () => {
      try {
        const [stages, events] = await Promise.all([readList<Stage>('stages', controller.signal), readList<GameEvent>('events', controller.signal)]);
        let drops: DropRates | null = null, dropsError = '';
        try {
          const response = await fetch('/api/game-data/drops', { credentials: 'omit', redirect: 'error', signal: controller.signal, cache: 'no-store' });
          const body = await response.json().catch(() => null) as (DropRates & { error?: { message?: string } }) | null;
          if (response.ok && body?.stages) drops = body; else dropsError = body?.error?.message ?? '無法讀取掉落統計。';
        } catch { if (!controller.signal.aborted) dropsError = '無法讀取掉落統計。'; }
        if (!controller.signal.aborted) setData({ stages, events, drops, dropsError });
      } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error && err.message ? err.message : '無法讀取關卡資料，請確認已執行 npm run game-data 並在設定更新遊戲資料。'); }
    })();
    return () => controller.abort();
  }, [isDemo]);
  return { data, error };
}
