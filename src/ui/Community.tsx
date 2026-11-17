import { useEffect, useState } from 'preact/hooks';
import { COMMUNITY_SOURCE_LABEL, isStale, rankCommunityPicks, type CommunityData, type CommunityPick } from '../catalog/community';

const STANCE: Record<CommunityPick['stance'], string> = { recommend: '推薦', situational: '看情況', avoid: '不推薦' };

/** 讀取社群評價（本機資料服務提供；同步會下載 GitHub 上的最新整理版）。 */
export function useCommunity() {
  const [data, setData] = useState<CommunityData | null>(null);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    let active = true;
    fetch('/api/game-data/community', { credentials: 'omit', redirect: 'error', cache: 'no-store' })
      .then(async response => { if (!response.ok) throw new Error('社群評價暫時無法讀取，請確認本機資料服務已啟動。'); return await response.json() as CommunityData; })
      .then(value => { if (active) setData(value); }, err => { if (active) setError(err instanceof Error ? err.message : '讀取失敗。'); });
    return () => { active = false; };
  }, []);
  const sync = async () => {
    setSyncing(true); setError('');
    try {
      const response = await fetch('/api/game-data/community-sync', { method: 'POST', headers: { 'X-Game-Data-Sync': '1' }, credentials: 'omit', redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw new Error('社群評價同步失敗；目前的資料仍可使用。');
      setData(await response.json() as CommunityData);
    } catch (err) { setError(err instanceof Error ? err.message : '同步失敗。'); } finally { setSyncing(false); }
  };
  return { data, error, syncing, sync };
}

function PickLine({ pick }: { pick: CommunityPick }) {
  return <li className={`community-pick stance-${pick.stance}`}>
    <span className="community-tag">{COMMUNITY_SOURCE_LABEL[pick.source]}・{STANCE[pick.stance]}</span>{' '}
    {pick.reason}{' '}
    <a href={pick.url} target="_blank" rel="noopener noreferrer">出處 ↗</a>
    {pick.date && <small className="fine-print"> {pick.date}{isStale(pick.date) ? '（發文超過兩年）' : ''}</small>}
  </li>;
}

/** 單一幹員在某主題的社群評價（幹員簡評用）。 */
export function CommunityForOperator({ data, themeId, operatorId }: { data: CommunityData | null; themeId?: string; operatorId: string }) {
  if (!data || !themeId) return null;
  const picks = data.themes[themeId]?.picks[operatorId];
  if (!picks?.length) return <p className="fine-print community-empty">社群評價：收錄的攻略沒有提到這位幹員。</p>;
  return <div className="community-block"><strong className="fine-print">社群評價（{new Set(picks.map(pick => pick.source)).size} 個來源）</strong><ul className="gap-list">{picks.map((pick, index) => <PickLine key={index} pick={pick}/>)}</ul></div>;
}

/** 主題層級：社群推薦排行、首領／機制應對、資料說明與同步按鈕（模式分析用）。 */
export function CommunityThemePanel({ community, themeId, owned, nameOf }: { community: ReturnType<typeof useCommunity>; themeId?: string; owned: Set<string>; nameOf: (id: string) => string }) {
  const { data, error, syncing, sync } = community;
  const theme = data && themeId ? data.themes[themeId] : undefined;
  const ranked = rankCommunityPicks(theme);
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? ranked : ranked.slice(0, 15);
  return <section className="panel" aria-label="社群評價">
    <div className="split-heading"><h3>社群評價</h3>
      <button type="button" className="button secondary small" disabled={syncing} onClick={() => void sync()}>{syncing ? '同步中…' : '同步社群評價'}</button></div>
    <p className="fine-print">整理自巴哈姆特、B 站與 PRTS，每條都附出處；排序依「幾個來源推薦 → 推薦次數」，不是強度排行，也不計入契合度分數。{data ? `資料更新：${data.updatedAt}。` : ''}</p>
    {error && <p role="alert" className="toast error">{error}</p>}
    {data && <details className="plain-details"><summary>各來源說明</summary><ul className="gap-list">{data.sources.map(source => <li key={source.id}><strong>{source.name}</strong>：{source.note}</li>)}</ul></details>}
    {theme?.notes?.map(note => <p key={note} className="callout">{note}</p>)}
    {!theme ? <p className="fine-print">{data ? '這個主題還沒有收錄社群評價。' : '讀取中…'}</p> : <>
      <div className="synergy-grid">{visible.map(item => <article key={item.operatorId} className={`synergy-card ${owned.has(item.operatorId) ? 'owned' : ''}`}>
        <header><strong>{nameOf(item.operatorId)}</strong>{owned.has(item.operatorId) && <span className="tag">持有</span>}</header>
        <p className="fine-print">{item.sources.map(source => COMMUNITY_SOURCE_LABEL[source]).join('、')}：推薦 {item.recommend}・看情況 {item.situational}{item.avoid ? `・不推薦 ${item.avoid}` : ''}</p>
        <ul className="gap-list">{theme.picks[item.operatorId].map((pick, index) => <PickLine key={index} pick={pick}/>)}</ul>
      </article>)}</div>
      {ranked.length > 15 && <button type="button" className="button ghost small" onClick={() => setShowAll(value => !value)}>{showAll ? '只顯示前 15 位' : `顯示全部 ${ranked.length} 位`}</button>}
      {theme.counters.length > 0 && <details className="plain-details" open><summary>首領／機制應對（{theme.counters.length}，依 PRTS 頁面整理）</summary><ul className="gap-list">{theme.counters.map(counter => <li key={counter.threat}><strong>{counter.threat}</strong>：{counter.needs} <a href={counter.url} target="_blank" rel="noopener noreferrer">PRTS ↗</a></li>)}</ul></details>}
    </>}
  </section>;
}
