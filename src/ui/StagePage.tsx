import { useMemo, useState } from 'preact/hooks';
import type { GrowthCatalog } from '../catalog/growth';
import { DROP_TYPE, eventPhase, forecastTwEvents, materialSources, OCCURRENCE, stagesOfEvent, type CnEvent, type EventPhase, type GameEvent } from '../domain/stages';
import { useEffect } from 'preact/hooks';
import { useStageData } from './gameData';
import { useGrowthCatalog } from './GrowthPage';

const fmt = (value: number, digits = 0) => value.toLocaleString('zh-TW', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const date = (value: string | null) => value ? new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' }).format(new Date(value)) : '—';
const PHASE: Record<EventPhase, string> = { ongoing: '進行中', upcoming: '即將開始', reward: '兌換期', ended: '已結束' };
function eventKind(type: string): string {
  if (/^TYPE_ACT\d+(SIDE|D\d)$/u.test(type)) return '支線活動';
  return ({ MINISTORY: '故事集', TYPE_MAINSS: '主線活動', BOSS_RUSH: '危機作戰', ENEMY_DUEL: '爭鋒頻道', AUTOCHESS_SEASON: '衛戍協議', ROGUELIKE: '集成戰略', MULTIPLAY_V3: '多人活動', VEC_BREAK_V2: '活動' } as Record<string, string>)[type] ?? '活動';
}
const STAGE_KIND: Record<string, string> = { MAIN: '主線', SUB: '支線', DAILY: '資源收集', ACTIVITY: '活動' };
function remaining(event: GameEvent, now: number): string {
  const target = eventPhase(event, now) === 'upcoming' ? event.startTime : eventPhase(event, now) === 'reward' ? event.rewardEndTime : event.endTime;
  if (!target) return '';
  const days = (Date.parse(target) - now) / 86_400_000;
  return days <= 0 ? '' : days < 1 ? `${Math.ceil(days * 24)} 小時` : `${Math.floor(days)} 天`;
}

export function StagePage({ isDemo }: { isDemo: boolean }) {
  const { data, error } = useStageData(isDemo);
  const { catalog } = useGrowthCatalog(isDemo);
  const [tab, setTab] = useState<'events' | 'farm'>('events');
  const [showAll, setShowAll] = useState(false);
  const [itemId, setItemId] = useState('');
  const [expanded, setExpanded] = useState(false);
  const now = useMemo(() => Date.now(), [data]);
  const [cn, setCn] = useState<{ fetchedAt: string; events: CnEvent[] } | null>(null);
  useEffect(() => { if (isDemo) return; const controller = new AbortController(); void fetch('/api/game-data/cn-events', { credentials: 'omit', redirect: 'error', signal: controller.signal, cache: 'no-store' }).then(async response => { const body = await response.json().catch(() => null); if (response.ok && Array.isArray(body?.events)) setCn(body); }).catch(() => undefined); return () => controller.abort(); }, [isDemo]);
  if (error) return <section className="panel"><h2>關卡與活動</h2><p className="callout warning">{error}</p></section>;
  if (!data) return <section className="panel"><h2>關卡與活動</h2><p className="fine-print">讀取遊戲資料中…</p></section>;
  const name = (id: string) => catalog?.items[id]?.name ?? id;
  const tabs = <div className="segmented" role="tablist">{([['events', '活動'], ['farm', '材料去哪刷']] as const).map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>;

  if (tab === 'events') {
    const groups = (['ongoing', 'upcoming', 'reward', 'ended'] as const).map(phase => ({ phase, list: data.events.filter(event => (showAll || event.hasStage) && eventPhase(event, now) === phase && (phase !== 'ended' || (event.endTime && now - Date.parse(event.endTime) < 30 * 86_400_000))).sort((a, b) => Date.parse(a.startTime ?? '') - Date.parse(b.startTime ?? '')) }));
    return <div className="stage-page">
      <section className="panel">
        <header className="recommend-head"><div><p className="eyebrow">關卡與活動</p><h2>台服活動時間表</h2></div>{tabs}</header>
        <label className="checkbox-line"><input type="checkbox" checked={showAll} onChange={event => setShowAll(event.currentTarget.checked)}/><span>也顯示沒有關卡的活動（簽到、登入等）</span></label>
        <p className="fine-print">時間以台灣時間顯示；資料來自繁中服活動表。已結束只列出 30 天內的活動。</p>
      </section>
      {(() => { const forecast = cn ? forecastTwEvents(data.events, cn.events, now) : null; return forecast && forecast.forecasts.length > 0 && <section className="panel" aria-label="未來活動預估">
        <h3>未來活動預估（依陸服時間表）</h3>
        <p className="fine-print">最近 {forecast.basis.length} 個兩服都有的活動，台服比陸服晚 {forecast.rangeDays[0]}～{forecast.rangeDays[1]} 天開始（中位數 {forecast.offsetDays} 天）。以下是陸服已開、台服尚未出現的活動，以中位數推估；活動名稱是陸服的簡體名稱，台服可能更名、調換順序或不實裝。</p>
        <div className="table-scroll"><table className="stats-table"><thead><tr><th>活動（陸服名稱）</th><th>陸服開始</th><th>台服預估</th><th>可能範圍</th></tr></thead><tbody>
          {forecast.forecasts.slice(0, 12).map(item => <tr key={item.event.id}><td>{item.event.name}</td><td>{date(new Date(item.event.startTime * 1000).toISOString())}</td><td><strong>{new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'Asia/Taipei' }).format(new Date(item.predicted))}</strong></td><td>{new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Taipei' }).format(new Date(item.earliest))}～{new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Taipei' }).format(new Date(item.latest))}</td></tr>)}
        </tbody></table></div>
        <details className="plain-details"><summary>推估依據</summary><ul className="gap-list">{forecast.basis.map(item => <li key={item.id}>{item.name}：台服晚 {item.days} 天</li>)}</ul></details>
      </section>; })()}
      {groups.filter(group => group.list.length).map(group => <section key={group.phase} className="panel" aria-label={PHASE[group.phase]}>
        <h3>{PHASE[group.phase]}（{group.list.length}）</h3>
        <div className="event-grid">{group.list.map(event => {
          const stages = stagesOfEvent(event, data.stages).filter(stage => stage.apCost && !stage.id.endsWith('#f#') && !/^(easy|tough)_/u.test(stage.id));
          const left = remaining(event, now);
          return <article key={event.id} className={`event-card phase-${group.phase}`}>
            <header><strong>{event.name}</strong><span className="tag muted">{eventKind(event.type)}</span>{event.isRerun && <span className="tag amber">復刻</span>}</header>
            <p className="fine-print">{date(event.startTime)} ～ {date(event.endTime)}{event.rewardEndTime && event.rewardEndTime !== event.endTime ? `・兌換至 ${date(event.rewardEndTime)}` : ''}</p>
            {left && <p className="event-left">{group.phase === 'upcoming' ? `${left}後開始` : group.phase === 'reward' ? `兌換剩 ${left}` : `剩 ${left}`}</p>}
            {stages.length > 0 && <details className="plain-details"><summary>{stages.length} 個關卡</summary><table className="stats-table"><thead><tr><th>關卡</th><th>理智</th><th>主要掉落</th></tr></thead><tbody>
              {stages.map(stage => <tr key={stage.id}><td>{stage.code} {stage.name}</td><td>{stage.apCost}</td><td>{stage.drops.filter(drop => drop.type === 'MATERIAL' && (drop.dropType === 'NORMAL' || drop.dropType === 'SPECIAL')).map(drop => `${name(drop.id)}（${OCCURRENCE[drop.occurrence]?.label ?? drop.occurrence}）`).join('、') || '—'}</td></tr>)}
            </tbody></table></details>}
          </article>;
        })}</div>
      </section>)}
    </div>;
  }

  const dropped = [...new Set(data.stages.flatMap(stage => stage.drops.filter(drop => drop.type === 'MATERIAL' && drop.dropType !== 'ONCE' && drop.dropType !== 'COMPLETE').map(drop => drop.id)))]
    .filter(id => catalog?.items[id]).sort((a, b) => (catalog!.items[b].rarity - catalog!.items[a].rarity) || catalog!.items[a].sortId - catalog!.items[b].sortId);
  const sources = itemId ? materialSources(itemId, data.stages, data.events, now, data.drops) : [];
  return <div className="stage-page">
    <section className="panel">
      <header className="recommend-head"><div><p className="eyebrow">關卡與活動</p><h2>材料去哪刷</h2></div>{tabs}</header>
      <label><span className="sr-only">選擇材料</span><select className="filter" value={itemId} onChange={event => { setItemId(event.currentTarget.value); setExpanded(false); }}>
        <option value="">選擇材料…</option>
        {[5, 4, 3, 2, 1].map(rarity => { const list = dropped.filter(id => catalog!.items[id].rarity === rarity); return list.length ? <optgroup key={rarity} label={`${rarity} 星材料`}>{list.map(id => <option key={id} value={id}>{name(id)}</option>)}</optgroup> : null; })}
      </select></label>
      {data.drops ? <p className="fine-print">掉率：{data.drops.source.name}（{data.drops.source.note}；{new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeZone: 'Asia/Taipei' }).format(new Date(data.drops.source.fetchedAt))} 同步）。樣本少於 100 次的不顯示掉率。</p>
        : <p className="callout warning">{data.dropsError}目前只依遊戲內的機率等級（固定、大概率…）排序，無法估算理智。</p>}
    </section>
    {itemId && <section className="panel" aria-label="掉落來源">
      <h3>{name(itemId)}：{sources.length} 個目前可刷的關卡</h3>
      {sources.length ? <><table className="stats-table stage-sources"><thead><tr><th>關卡</th><th>來源</th><th>理智</th><th>掉落</th>{data.drops && <><th>每次掉落</th><th>理智／件</th></>}</tr></thead><tbody>
        {(expanded ? sources : sources.slice(0, 12)).map(item => <tr key={item.stage.id}><td>{item.stage.code} {item.stage.name}</td><td>{item.event ? item.event.name : STAGE_KIND[item.stage.type] ?? item.stage.type}{item.stage.type === 'DAILY' ? '（依星期開放）' : ''}</td><td>{item.stage.apCost}</td>
          <td>{DROP_TYPE[item.drop.dropType] ?? item.drop.dropType}・{OCCURRENCE[item.drop.occurrence]?.label ?? item.drop.occurrence}</td>
          {data.drops && <><td>{item.rate !== undefined ? `${fmt(item.rate * 100, 1)}%` : '—'}</td><td>{item.apPerItem !== undefined && Number.isFinite(item.apPerItem) ? fmt(item.apPerItem, 1) : '—'}</td></>}</tr>)}
      </tbody></table>{sources.length > 12 && <button type="button" className="button ghost small" onClick={() => setExpanded(value => !value)}>{expanded ? '只看前 12 個' : `顯示全部 ${sources.length} 個`}</button>}</> : <p className="fine-print">目前沒有常駐或進行中活動的關卡掉落這個材料（可能只能從合成、商店或已結束的活動取得）。</p>}
    </section>}
  </div>;
}
