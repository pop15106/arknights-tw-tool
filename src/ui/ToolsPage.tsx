import { useEffect, useMemo, useState } from 'preact/hooks';
import type { RecruitCatalog } from '../catalog/recruit';
import type { AppState } from '../domain/model';
import { recruitCombos } from '../domain/recruit';
import { planMastery } from '../domain/mastery';
import { currentState } from '../domain/growth';
import { useBaseCatalog } from './BasePage';
import { useGrowthCatalog } from './GrowthPage';

function useRecruitCatalog(isDemo: boolean) {
  const [catalog, setCatalog] = useState<RecruitCatalog | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (isDemo) { setError('示範資料沒有公開招募資料；請切換到個人工作區並更新遊戲資料。'); return; }
    const controller = new AbortController();
    void fetch('/api/game-data/recruit', { credentials: 'omit', redirect: 'error', signal: controller.signal, cache: 'no-store' }).then(async response => { const body = await response.json().catch(() => null); if (!response.ok || !Array.isArray(body?.operators)) throw new Error(body?.error?.message ?? ''); setCatalog(body); })
      .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error && err.message ? err.message : '無法讀取公開招募資料。'); });
    return () => controller.abort();
  }, [isDemo]);
  return { catalog, error };
}

export type ToolTab = 'recruit' | 'mastery' | 'checkup';
export function ToolsPage({ state, isDemo, extra }: { state: AppState; isDemo: boolean; extra?: Partial<Record<ToolTab, (tabs: preact.JSX.Element) => preact.JSX.Element>> }) {
  const [tab, setTab] = useState<ToolTab>('recruit');
  const tabs = <div className="segmented" role="tablist">{([['recruit', '公招計算'], ['mastery', '專精規劃'], ['checkup', '帳號體檢']] as const).map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>;
  return <div className="team-page">
    {tab === 'recruit' && <RecruitTab state={state} isDemo={isDemo} tabs={tabs}/>}
    {tab === 'mastery' && <MasteryTab state={state} isDemo={isDemo} tabs={tabs}/>}
    {tab === 'checkup' && (extra?.[tab]?.(tabs) ?? <section className="panel"><header className="recommend-head"><div><p className="eyebrow">工具</p><h2>帳號體檢</h2></div>{tabs}</header><p className="fine-print">施工中。</p></section>)}
  </div>;
}

const GROUPS: [string, (tag: string) => boolean][] = [['資歷', tag => /資深幹員|新手|支援機械/u.test(tag)], ['職業', tag => tag.endsWith('幹員') && !/資深|新手/u.test(tag)], ['站位', tag => tag.endsWith('位')], ['特性', () => true]];
function RecruitTab({ state, isDemo, tabs }: { state: AppState; isDemo: boolean; tabs: preact.JSX.Element }) {
  const { catalog, error } = useRecruitCatalog(isDemo);
  const [selected, setSelected] = useState<string[]>([]);
  const [longTime, setLongTime] = useState(true);
  const owned = useMemo(() => new Set(state.roster.filter(row => !(row.fields.owned?.status === 'known' && row.fields.owned.value === false)).map(row => row.operatorId)), [state.roster]);
  const head = <header className="recommend-head"><div><p className="eyebrow">工具</p><h2>公招計算</h2></div>{tabs}</header>;
  if (error) return <section className="panel">{head}<p className="callout warning">{error}</p></section>;
  if (!catalog) return <section className="panel">{head}<p className="fine-print">讀取遊戲資料中…</p></section>;
  const combos = recruitCombos(catalog, selected, { longTime });
  const toggle = (tag: string) => setSelected(list => list.includes(tag) ? list.filter(item => item !== tag) : list.length >= 5 ? list : [...list, tag]);
  const used = new Set<string>();
  const grouped = GROUPS.map(([label, test]) => [label, catalog.tags.filter(tag => { if (used.has(tag) || !test(tag)) return false; used.add(tag); return true; })] as const);
  return <>
    <section className="panel">
      {head}
      <p className="fine-print">選出招募畫面上的標籤（最多 5 個），列出每種 1～3 個標籤組合可能出現的幹員。可招募名單與標籤取自繁中服 gacha_table；六星只在選了「高級資深幹員」時出現（遊戲說明）。</p>
      {grouped.map(([label, list]) => <div key={label} className="recruit-tags"><span className="fine-print">{label}</span>{list.map(tag => <button key={tag} type="button" className={`tag-toggle ${selected.includes(tag) ? 'on' : ''}`} aria-pressed={selected.includes(tag)} onClick={() => toggle(tag)}>{tag}</button>)}</div>)}
      <div className="inline-actions">
        <label className="checkbox-line"><input type="checkbox" checked={longTime} onChange={event => setLongTime(event.currentTarget.checked)}/><span>招募時間 7:40 以上（不出一、二星；社群通行規則，遊戲內未明示）</span></label>
        {selected.length > 0 && <button type="button" className="button ghost small" onClick={() => setSelected([])}>清除標籤</button>}
      </div>
      {catalog.rules.map(rule => <p key={rule} className="fine-print">遊戲說明：{rule}</p>)}
    </section>
    {selected.length > 0 && <section className="panel" aria-label="組合結果">
      <h3>組合結果（{combos.length}）</h3>
      {combos.length ? <div className="recruit-list">{combos.map(combo => <article key={combo.tags.join('+')} className={`recruit-row min-${combo.min}`}>
        <header>{combo.tags.map(tag => <span key={tag} className="tag">{tag}</span>)}<span className={`recruit-badge r${combo.min}`}>{combo.min >= 4 ? `保底 ${combo.min}★` : `最低 ${combo.min}★`}</span>{combo.max === 6 && <span className="recruit-badge r6">可能 6★</span>}</header>
        <div className="recruit-ops">{combo.operators.map(op => <span key={op.id} className={`recruit-op r${op.rarity} ${owned.has(op.id) ? 'owned' : ''}`} title={`${op.rarity}★${op.recruitOnly ? '・只能公招取得' : ''}${owned.has(op.id) ? '・已持有' : ''}`}>{op.rarity}★ {op.name}{op.recruitOnly && <small>限公招</small>}</span>)}</div>
      </article>)}</div> : <p className="fine-print">這些標籤沒有可能出現的幹員。</p>}
      <p className="fine-print">已持有的幹員以實線框顯示（可用來換潛能）。</p>
    </section>}
  </>;
}

const hours = (value: number) => value >= 1 ? `${Math.floor(value)} 時 ${Math.round((value % 1) * 60)} 分` : `${Math.round(value * 60)} 分`;
function MasteryTab({ state, isDemo, tabs }: { state: AppState; isDemo: boolean; tabs: preact.JSX.Element }) {
  const { catalog: base } = useBaseCatalog(isDemo, 0);
  const { catalog: growth, error } = useGrowthCatalog(isDemo);
  const [operatorId, setOperatorId] = useState('');
  const [skillId, setSkillId] = useState('');
  const [query, setQuery] = useState('');
  const definitions = useMemo(() => new Map(state.dataset.operators.map(def => [def.id, def])), [state.dataset]);
  const rows = useMemo(() => new Map(state.roster.map(row => [row.operatorId, row])), [state.roster]);
  const head = <header className="recommend-head"><div><p className="eyebrow">工具</p><h2>專精規劃</h2></div>{tabs}</header>;
  if (error) return <section className="panel">{head}<p className="callout warning">{error}</p></section>;
  if (!growth || !base) return <section className="panel">{head}<p className="fine-print">讀取遊戲資料中…</p></section>;
  const definition = definitions.get(operatorId);
  const current = definition ? currentState(rows.get(operatorId), definition).state : undefined;
  const skills = definition?.skills.filter(skill => growth.operators[definition.id]?.masteries[skill.id]) ?? [];
  const skill = skills.find(item => item.id === skillId) ?? skills[0];
  const from = skill && current ? current.masteries[skill.id] ?? 0 : 0;
  const planned = (state.settings.growth?.plans ?? []).flatMap(plan => { const def = definitions.get(plan.operatorId); if (!def) return []; const now = currentState(rows.get(plan.operatorId), def).state; return def.skills.filter(item => (plan.target.masteries[item.id] ?? 0) > (now.masteries[item.id] ?? 0)).map(item => ({ def, skill: item })); });
  const plan = definition && skill && from < 3 ? planMastery(state.settings.base, base, growth, state.roster, definitions, { operatorId: definition.id, skillId: skill.id, from, to: 3 }) : null;
  const owned = state.roster.filter(row => !(row.fields.owned?.status === 'known' && row.fields.owned.value === false));
  const matches = query.trim() ? owned.map(row => definitions.get(row.operatorId)).filter((def): def is NonNullable<typeof def> => !!def && def.displayName.includes(query.trim()) && !!growth.operators[def.id] && Object.keys(growth.operators[def.id].masteries).length > 0).slice(0, 8) : [];
  return <>
    <section className="panel">
      {head}
      <p className="fine-print">專精所需時間取自技能表；協助者加成用基建頁同一套技能解析計算（依訓練中幹員的職業與目標專精等級），也包含控制中樞的訓練加成。訓練室等級取自基建配置，基礎加成 5% 假設在有協助者時生效。</p>
      <input className="text-input" placeholder="輸入要專精的幹員…" value={query} onInput={event => setQuery(event.currentTarget.value)}/>
      {matches.length > 0 && <div className="growth-matches">{matches.map(def => <button key={def.id} type="button" className="button secondary small" onClick={() => { setOperatorId(def.id); setSkillId(''); setQuery(''); }}>{def.displayName}</button>)}</div>}
      {planned.length > 0 && <div className="growth-matches"><span className="fine-print">養成計畫中的專精：</span>{planned.map(item => <button key={`${item.def.id}-${item.skill.id}`} type="button" className="button ghost small" onClick={() => { setOperatorId(item.def.id); setSkillId(item.skill.id); }}>{item.def.displayName}・{item.skill.name}</button>)}</div>}
      {definition && <div className="inline-actions"><strong>{definition.displayName}</strong><span className="fine-print">{definition.profession}</span>
        <select className="filter" value={skill?.id ?? ''} onChange={event => setSkillId(event.currentTarget.value)}>{skills.map((item, index) => <option key={item.id} value={item.id}>技能 {index + 1}「{item.name}」（目前專精 {current?.masteries[item.id] ?? 0}）</option>)}</select></div>}
    </section>
    {definition && skill && from >= 3 && <section className="panel"><p className="fine-print">這個技能已經專精 3。</p></section>}
    {plan && <section className="panel" aria-label="協助者比較">
      <h3>{definition!.displayName}「{skill!.name}」專精 {from} → 3</h3>
      {plan.notes.map(note => <p key={note} className="callout warning">{note}</p>)}
      <div className="table-scroll"><table className="stats-table"><thead><tr><th>協助者</th>{plan.steps.map(step => <th key={step.level}>專精 {step.level}（原 {hours(step.baseHours)}）</th>)}<th>合計</th></tr></thead><tbody>
        {plan.assistants.map((item, index) => <tr key={item.id} className={index === 0 ? 'best' : ''}><td>{item.name}</td>{item.hours.map((value, step) => <td key={step}>{hours(value)}<small className="fine-print">（+{item.bonus[step] + 5}%）</small></td>)}<td><strong>{hours(item.total)}</strong></td></tr>)}
        <tr><td>不放協助者</td>{plan.none.hours.map((value, step) => <td key={step}>{hours(value)}</td>)}<td>{hours(plan.none.total)}</td></tr>
      </tbody></table></div>
      <p className="fine-print">表中是整條專精鏈都由同一位協助者陪同的時間。「精神鍛煉」這類「上一階段協助滿 5 小時、下次訓練時間減半」的技能，以連續專精同一名幹員估計；中途換協助者會讓效果消失。</p>
    </section>}
  </>;
}
