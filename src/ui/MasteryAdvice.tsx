import { useMemo, useState } from 'preact/hooks';
import type { AppState } from '../domain/model';
import { rankMastery, skillAdvice, type SkillAdvice } from '../domain/masteryAdvice';
import { ABILITY_LABEL } from '../domain/abilities';
import { useGrowthCatalog } from './GrowthPage';
import { useModeAnalyses } from './modeAnalyses';
import { useCommunity } from './Community';

type Sort = 'mode' | 'gain' | 'community';

function AdviceDetail({ advice, mode, items }: { advice: SkillAdvice; mode: string; items: Record<string, { name: string }> }) {
  const modes = mode === '全部' ? [advice.daily, ...advice.modes].filter(item => item.points > 0).sort((a, b) => b.points - a.points).slice(0, 4) : [mode === '日常' ? advice.daily : advice.modes.find(item => item.mode === mode)].filter((item): item is NonNullable<typeof item> => !!item);
  return <div className="mastery-advice-detail">
    {advice.abilities.length > 0 && <p className="fine-print">技能能力：{advice.abilities.map(key => ABILITY_LABEL[key]).join('、')}</p>}
    {advice.gain && <p><strong>專精收益</strong>（7 級 → 專精 3）：{advice.gain.changes.join('；') || '說明沒有數值變化'}</p>}
    {modes.map(item => <div key={item.mode}><strong>{item.mode}</strong>（+{item.points}）<ul className="gap-list">{item.reasons.slice(0, 5).map(reason => <li key={reason}>{reason}</li>)}</ul></div>)}
    {advice.community.length > 0 && <div><strong>社群提到這個技能</strong><ul className="gap-list">{advice.community.flatMap(item => item.mentions.map(text => <li key={item.theme + text}>{item.theme}：{text}</li>))}</ul></div>}
    <p className="fine-print">成本：約 {advice.hours} 小時（未計訓練室加成）・材料 {advice.materials.map(item => `${items[item.id]?.name ?? item.id}×${item.count}`).join('、') || '—'}</p>
  </div>;
}

/** 技能專精建議：全帳號排行＋單一幹員逐技能比較。 */
export function MasteryAdviceTab({ state, isDemo, tabs }: { state: AppState; isDemo: boolean; tabs: preact.JSX.Element }) {
  const { catalog: growth, error } = useGrowthCatalog(isDemo);
  const analyses = useModeAnalyses(isDemo);
  const community = useCommunity();
  const [mode, setMode] = useState('全部');
  const [sort, setSort] = useState<Sort>('mode');
  const [query, setQuery] = useState('');
  const [operatorId, setOperatorId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const head = <header className="recommend-head"><div><p className="eyebrow">工具</p><h2>專精建議</h2></div>{tabs}</header>;
  const themeNames = useMemo(() => Object.fromEntries((analyses ?? []).map(item => [item.id, item.name])), [analyses]);
  const context = useMemo(() => growth ? { growth, analyses: analyses ?? [], community: community.data, themeNames } : null, [growth, analyses, community.data, themeNames]);
  const ranked = useMemo(() => {
    if (!context) return [];
    const list = rankMastery(state.dataset.operators, state.roster, context, mode);
    const key = (item: typeof list[number]) => sort === 'gain' ? item.advice.gain?.score ?? 0 : sort === 'community' ? item.advice.community.reduce((sum, c) => sum + c.mentions.length, 0) * 100 + item.modePoints : item.modePoints;
    return [...list].sort((a, b) => key(b) - key(a)).slice(0, 40);
  }, [context, state.dataset, state.roster, mode, sort]);
  if (error) return <section className="panel">{head}<p className="callout warning">{error}</p></section>;
  if (!growth || !context) return <section className="panel">{head}<p className="fine-print">讀取遊戲資料中…</p></section>;
  const definition = state.dataset.operators.find(def => def.id === operatorId);
  const matches = query.trim() ? state.dataset.operators.filter(def => def.displayName.includes(query.trim()) && growth.operators[def.id]).slice(0, 8) : [];
  const modeOptions = ['全部', '日常', ...(analyses ?? []).map(item => item.name)];
  return <>
    <section className="panel">
      {head}
      <p className="fine-print">依四種依據列出每個技能值不值得專精，<strong>每一項都附理由</strong>：① 專精收益（7 級 → 專精 3 的數值變化）② 模式需求（只保留這個技能時，對各模式敵人組成與首領的對應，含輸出強度估算）③ 社群評價有提到這個技能 ④ 成本（另外顯示、不計入排序）。技能與天賦都用同一套能力解析；文字解析算不出實際傷害，持續型與單發型技能的比較只能估算，請搭配理由判斷。</p>
      <div className="inline-actions">
        <select className="text-input" value={mode} aria-label="模式" onChange={event => setMode(event.currentTarget.value)}>{modeOptions.map(item => <option key={item} value={item}>{item}</option>)}</select>
        <select className="text-input" value={sort} aria-label="排序" onChange={event => setSort(event.currentTarget.value as Sort)}><option value="mode">依模式需求＋收益</option><option value="gain">依專精收益</option><option value="community">社群有提到的優先</option></select>
      </div>
      {!analyses && <p className="fine-print">模式關卡分析讀取中（首次需下載關卡檔）；目前只能看日常與專精收益。</p>}
    </section>
    <section className="panel">
      <h3>你的幹員（已精二、未專精 3）</h3>
      {!ranked.length ? <p className="fine-print">幹員庫裡沒有已精二、且技能還沒專精 3 的幹員（精英化與專精等級需為已知）。</p> : <ol className="mastery-rank">{ranked.map((item, rank) => { const id = `${item.operatorId}-${item.advice.skillId}`; return <li key={id}>
        <button type="button" className="mastery-rank-row" aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>
          <strong>{rank + 1}. {item.name}・技能 {item.advice.skillIndex + 1}「{item.advice.name}」</strong>
          <span className="fine-print">專精 {item.advice.currentMastery ?? '?'}→3・模式 +{item.modePoints}{item.advice.gain ? `・收益 ${item.advice.gain.score}` : ''}{item.advice.community.length ? '・社群有提到' : ''}</span>
        </button>
        {open === id && <AdviceDetail advice={item.advice} mode={mode} items={growth.items}/>}
      </li>; })}</ol>}
    </section>
    <section className="panel">
      <h3>查詢單一幹員</h3>
      <input className="text-input" placeholder="輸入幹員名稱…" value={query} onInput={event => setQuery(event.currentTarget.value)}/>
      {matches.length > 0 && <div className="growth-matches">{matches.map(def => <button key={def.id} type="button" className="button secondary small" onClick={() => { setOperatorId(def.id); setQuery(''); }}>{def.displayName}</button>)}</div>}
      {definition && <div className="mastery-compare">{skillAdvice(definition, state.roster.find(row => row.operatorId === definition.id), context).map(advice => <article key={advice.skillId} className="synergy-card">
        <header><strong>技能 {advice.skillIndex + 1}「{advice.name}」</strong><span className="fine-print">日常 +{advice.daily.points}</span></header>
        <AdviceDetail advice={advice} mode="全部" items={growth.items}/>
      </article>)}</div>}
    </section>
  </>;
}
