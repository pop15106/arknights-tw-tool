import { useEffect, useState } from 'preact/hooks';
import { COMMUNITY_SOURCE_LABEL, isStale, rankCommunityPicks, type CommunityData, type CommunityPick } from '../catalog/community';
import { buzzPicks, type BuzzData, type BuzzMode } from '../catalog/buzz';

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
    {pick.reason}{pick.inferred && <small className="fine-print" title="原文用暱稱或簡稱，幹員是整理時判讀的，請點出處核對。">（依暱稱判讀）</small>}{' '}
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
export function CommunityThemePanel({ community, themeId, owned, nameOf, buzzMode = 'reference', onBuzzMode }: { community: ReturnType<typeof useCommunity>; themeId?: string; owned: Set<string>; nameOf: (id: string) => string; buzzMode?: BuzzMode; onBuzzMode?: (mode: BuzzMode) => void }) {
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
      <BuzzSection themeId={themeId} mode={buzzMode} onMode={onBuzzMode} owned={owned} nameOf={nameOf} recommended={new Set(ranked.map(item => item.operatorId))}/>
      {theme.counters.length > 0 && <details className="plain-details" open><summary>首領／機制應對（{theme.counters.length}，依 PRTS 頁面整理）</summary><ul className="gap-list">{theme.counters.map(counter => <li key={counter.threat}><strong>{counter.threat}</strong>：{counter.needs} <a href={counter.url} target="_blank" rel="noopener noreferrer">PRTS ↗</a></li>)}</ul></details>}
    </>}
  </section>;
}

const BUZZ_MODES: { key: BuzzMode; label: string }[] = [{ key: 'off', label: '關閉' }, { key: 'reference', label: '只當參考' }, { key: 'recommend', label: '列入推薦' }];

/** 讀取最新討論熱度；同步在本機資料服務背景執行，這裡每 2 秒查一次直到完成。 */
function useBuzz(enabled: boolean) {
  const [state, setState] = useState<{ running: boolean; error?: string; data: BuzzData | null } | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true, timer: number | undefined, failures = 0;
    const read = async () => {
      try {
        const response = await fetch('/api/game-data/buzz', { credentials: 'omit', redirect: 'error', cache: 'no-store' });
        if (!response.ok) throw new Error('最新討論暫時無法讀取，請確認本機資料服務已啟動。');
        const next = await response.json() as { running: boolean; error?: string; data: BuzzData | null };
        if (!active) return;
        failures = 0; setError(''); setState(next);
        if (next.running) timer = window.setTimeout(() => void read(), 2000);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : '讀取失敗。');
        // 抓取進行中時，一次讀取失敗不代表結束：稍後重試；連續失敗 5 次就放開按鈕，讓使用者自行重試。
        failures++;
        if (failures < 5) timer = window.setTimeout(() => void read(), 3000);
        else setState(current => current ? { ...current, running: false } : current);
      }
    };
    void read();
    return () => { active = false; window.clearTimeout(timer); };
  }, [enabled, tick]);
  const sync = async () => {
    setError('');
    try {
      const response = await fetch('/api/game-data/buzz-sync', { method: 'POST', headers: { 'X-Game-Data-Sync': '1' }, credentials: 'omit', redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw new Error('無法開始抓取，請確認本機資料服務已啟動。');
      setState(current => ({ data: current?.data ?? null, running: true }));
      setTick(value => value + 1);  // 重新讀取並開始輪詢進度
    } catch (err) { setError(err instanceof Error ? err.message : '無法開始抓取。'); }
  };
  return { state, error, sync };
}

/** 最新討論熱度：自動抓巴哈姆特與 B 站搜尋結果，統計提到次數；三段切換決定怎麼用。 */
function BuzzSection({ themeId, mode, onMode, owned, nameOf, recommended }: { themeId?: string; mode: BuzzMode; onMode?: (mode: BuzzMode) => void; owned: Set<string>; nameOf: (id: string) => string; recommended: Set<string> }) {
  const { state, error, sync } = useBuzz(mode !== 'off');
  const theme = themeId ? state?.data?.themes[themeId] : undefined;
  const picks = buzzPicks(theme).filter(item => !recommended.has(item.operatorId));
  return <div className="buzz-section">
    <div className="split-heading"><h4>最新討論熱度</h4>
      <div className="segmented" role="group" aria-label="最新討論熱度用法">{BUZZ_MODES.map(item => <button key={item.key} type="button" className={mode === item.key ? 'active' : ''} disabled={!onMode} onClick={() => onMode?.(item.key)}>{item.label}</button>)}</div></div>
    {mode === 'off' ? <p className="fine-print">已關閉：不抓取最新討論。</p> : <>
      <p className="fine-print">按「抓取最新討論」會到巴哈姆特與 B 站搜尋這個主題的新文章，統計標題與摘要裡提到的幹員次數。<strong>被提到不等於被推薦</strong>，熱門或新角色會偏高；單字名稱（如「年」「令」）與主題簡稱同名的幹員（傀影、水月）容易誤判，不列入統計；B 站可能要求驗證而抓不到。NGA 需登入，不抓取。</p>
      <div className="inline-actions"><button type="button" className="button secondary small" disabled={state?.running} onClick={() => void sync()}>{state?.running ? '抓取中…' : '抓取最新討論'}</button>
        {state?.data && <small className="fine-print">上次抓取：{new Date(state.data.fetchedAt).toLocaleString('zh-TW')}</small>}</div>
      {(error || state?.error) && <p role="alert" className="toast error">{error || state?.error}</p>}
      {theme?.errors.map(item => <p key={item} className="fine-print">⚠ {item}</p>)}
      {!theme ? <p className="fine-print">{state?.data ? '這個主題沒有抓到資料。' : '還沒有抓取過。'}</p> : <>
        {mode === 'recommend' && picks.length > 0 && <div className="community-block"><strong className="fine-print">依討論熱度列入推薦（自動，至少 2 篇、3 次以上）</strong>
          <div className="synergy-grid">{picks.map(item => <article key={item.operatorId} className={`synergy-card ${owned.has(item.operatorId) ? 'owned' : ''}`}><header><strong>{nameOf(item.operatorId)}</strong><span className="tag amber">依討論熱度</span>{owned.has(item.operatorId) && <span className="tag">持有</span>}</header><p className="fine-print">{item.posts} 篇文章、共提到 {item.count} 次；不是人工整理的推薦。</p></article>)}</div></div>}
        <details className="plain-details" open={mode === 'reference'}><summary>提到次數排行（{theme.mentions.length}）</summary>
          <ol className="buzz-rank">{theme.mentions.slice(0, 15).map(item => <li key={item.operatorId}>{nameOf(item.operatorId)}{owned.has(item.operatorId) ? '（持有）' : ''}：{item.posts} 篇、{item.count} 次</li>)}</ol></details>
        <details className="plain-details"><summary>抓到的文章（{theme.posts.length}）</summary>
          <ul className="gap-list">{theme.posts.slice(0, 40).map(post => <li key={post.url}><span className="community-tag">{post.source === 'bahamut' ? '巴哈姆特' : 'B 站'}</span> <a href={post.url} target="_blank" rel="noopener noreferrer">{post.title}</a>{post.date && <small className="fine-print"> {post.date}</small>}</li>)}</ul></details>
      </>}
    </>}
  </div>;
}
