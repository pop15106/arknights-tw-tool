import { useEffect, useState } from 'preact/hooks';
import type { RogueAnalysis } from '../catalog/rogue';
import { cachedLoad, peekCache } from './gameData';

/** 各模式（集成戰略、保全派駐、生息演算）的關卡分析；資料服務會快取，首次需下載關卡檔。 */
export function useModeAnalyses(isDemo: boolean) {
  type Analysis = RogueAnalysis & { mode?: string };
  const [analyses, setAnalyses] = useState<Analysis[] | null>(() => isDemo ? null : peekCache<Analysis[]>('modes') ?? null);
  useEffect(() => {
    if (isDemo || peekCache('modes')) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const list = await fetch('/api/game-data/rogue', { credentials: 'omit', redirect: 'error', signal: controller.signal, cache: 'no-store' }).then(response => response.ok ? response.json() : []) as { id: string; mode: string }[];
        const queue = [...list]; const results: (RogueAnalysis & { mode?: string })[] = [];
        await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) { const theme = queue.shift()!; const response = await fetch(`/api/game-data/rogue-analysis?theme=${encodeURIComponent(theme.id)}`, { credentials: 'omit', redirect: 'error', signal: controller.signal, cache: 'no-store' }); if (response.ok) results.push({ ...(await response.json()), mode: theme.mode }); } }));
        const done = list.map(theme => results.find(item => item.id === theme.id)).filter((item): item is Analysis => !!item);
        // 全部主題都分析完才快取，第一次下載關卡檔途中的部分結果不留。
        if (done.length && done.length === list.length) void cachedLoad('modes', async () => done);
        if (!controller.signal.aborted) setAnalyses(done);
      } catch { /* 資料服務沒有模式資料時不顯示 */ }
    })();
    return () => controller.abort();
  }, [isDemo]);
  return analyses;
}
