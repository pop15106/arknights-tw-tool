import { useEffect, useState } from 'preact/hooks';
import type { RogueAnalysis } from '../catalog/rogue';

/** 各模式（集成戰略、保全派駐、生息演算）的關卡分析；資料服務會快取，首次需下載關卡檔。 */
export function useModeAnalyses(isDemo: boolean) {
  const [analyses, setAnalyses] = useState<(RogueAnalysis & { mode?: string })[] | null>(null);
  useEffect(() => {
    if (isDemo) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const list = await fetch('/api/game-data/rogue', { credentials: 'omit', redirect: 'error', signal: controller.signal, cache: 'no-store' }).then(response => response.ok ? response.json() : []) as { id: string; mode: string }[];
        const queue = [...list]; const results: (RogueAnalysis & { mode?: string })[] = [];
        await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) { const theme = queue.shift()!; const response = await fetch(`/api/game-data/rogue-analysis?theme=${encodeURIComponent(theme.id)}`, { credentials: 'omit', redirect: 'error', signal: controller.signal, cache: 'no-store' }); if (response.ok) results.push({ ...(await response.json()), mode: theme.mode }); } }));
        if (!controller.signal.aborted) setAnalyses(list.map(theme => results.find(item => item.id === theme.id)).filter((item): item is RogueAnalysis & { mode?: string } => !!item));
      } catch { /* 資料服務沒有模式資料時不顯示 */ }
    })();
    return () => controller.abort();
  }, [isDemo]);
  return analyses;
}
