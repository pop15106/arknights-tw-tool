import { useMemo, useState } from 'preact/hooks';
import type { AppState, OperatorDefinition } from '../domain/model';
import { analyzeSynergies, DEBUFF_PARTNER, type SynergyLink } from '../domain/synergy';
import { useBaseCatalog } from './BasePage';

const TRIGGER_LABEL: Record<SynergyLink['trigger'], string> = { squad: '編入隊伍', deployed: '在場時', skill: '技能期間', always: '說明未寫條件' };
const KIND_ORDER: SynergyLink['target']['kind'][] = ['operator', 'group', 'profession', 'branch', 'rarity', 'position'];
const KIND_LABEL: Record<SynergyLink['target']['kind'], string> = { operator: '指定幹員', group: '陣營', profession: '職業', branch: '分支', rarity: '星級', position: '位置' };

export function TeamPage({ state, isDemo }: { state: AppState; isDemo: boolean }) {
  const [tab, setTab] = useState<'synergy' | 'squad' | 'stage'>('synergy');
  const tabs = <div className="segmented" role="tablist">{([['synergy', '幹員相性'], ['squad', '編隊建議'], ['stage', '依關卡推薦']] as const).map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>;
  return <div className="team-page">
    {tab === 'synergy' && <SynergyTab state={state} isDemo={isDemo} tabs={tabs}/>}
    {tab !== 'synergy' && <section className="panel"><header className="recommend-head"><div><p className="eyebrow">搭配</p><h2>{tab === 'squad' ? '編隊建議' : '依關卡推薦'}</h2></div>{tabs}</header><p className="fine-print">施工中。</p></section>}
  </div>;
}

function SynergyTab({ state, isDemo, tabs }: { state: AppState; isDemo: boolean; tabs: preact.JSX.Element }) {
  const { catalog } = useBaseCatalog(isDemo, 0);
  const [ownedOnly, setOwnedOnly] = useState(true);
  const [query, setQuery] = useState('');
  const definitions = state.dataset.operators;
  const byId = useMemo(() => new Map(definitions.map(def => [def.id, def])), [definitions]);
  const owned = useMemo(() => new Set(state.roster.filter(row => !(row.fields.owned?.status === 'known' && row.fields.owned.value === false)).map(row => row.operatorId)), [state.roster]);
  const elite = (id: string) => { const value = state.roster.find(row => row.operatorId === id)?.fields.elite; return value?.status === 'known' && typeof value.value === 'number' ? value.value : undefined; };
  const result = useMemo(() => analyzeSynergies(definitions, id => catalog?.meta?.[id]?.groups ?? [], owned), [definitions, catalog, owned]);
  const name = (id: string) => byId.get(id)?.displayName ?? id;
  const q = query.trim();
  const hit = (link: SynergyLink) => !q || name(link.providerId).includes(q) || link.beneficiaries.some(id => name(id).includes(q)) || link.target.label.includes(q);
  const links = result.links.filter(link => (!ownedOnly || owned.has(link.providerId)) && hit(link))
    .sort((a, b) => KIND_ORDER.indexOf(a.target.kind) - KIND_ORDER.indexOf(b.target.kind) || b.beneficiaries.length - a.beneficiaries.length);
  const debuffs = result.debuffs.filter(item => (!ownedOnly || owned.has(item.providerId)) && (!q || name(item.providerId).includes(q)));
  const statuses = [...new Set(debuffs.map(item => item.status))];
  const chip = (id: string) => { const def = byId.get(id) as OperatorDefinition | undefined; const e = elite(id); return <span key={id} className={`op-chip ${owned.has(id) ? '' : 'missing'}`}>{def?.displayName ?? id}{e !== undefined ? <small>精{e}</small> : null}</span>; };
  return <>
    <section className="panel">
      <header className="recommend-head"><div><p className="eyebrow">搭配</p><h2>幹員相性</h2></div>{tabs}</header>
      <p className="fine-print">只依天賦、技能、模組說明中明寫的對象（【陣營】、【職業】、指定幹員）與對敵減益整理，每條都附原文；不含主觀強度評價。天賦取最高潛能與精英階段的版本。</p>
      <div className="inline-actions">
        <label className="checkbox-line"><input type="checkbox" checked={ownedOnly} onChange={event => setOwnedOnly(event.currentTarget.checked)}/><span>只看我持有的提供者</span></label>
        <input className="text-input" placeholder="搜尋幹員、陣營或職業…" value={query} onInput={event => setQuery(event.currentTarget.value)}/>
      </div>
    </section>
    <section className="panel" aria-label="隊伍加成">
      <h3>隊伍加成（{links.length}）</h3>
      <div className="synergy-grid">{links.map(link => <article key={`${link.providerId}-${link.target.kind}-${link.target.value}`} className="synergy-card">
        <header>{chip(link.providerId)}<span className="synergy-arrow">→</span><strong>{link.target.label}</strong><span className="tag muted">{KIND_LABEL[link.target.kind]}</span></header>
        <div className="synergy-tags"><span className="tag">{TRIGGER_LABEL[link.trigger]}</span>{link.minCount && <span className="tag amber">需 {link.minCount} 名</span>}{link.mode && <span className="tag amber">限【{link.mode}】</span>}</div>
        <p className="synergy-text">{link.source.kind}「{link.source.name}」：{link.source.description}</p>
        {link.more?.map(item => <p key={item.description} className="synergy-text more">{item.kind}「{item.name}」：{item.description}</p>)}
        <div className="synergy-beneficiaries">{link.beneficiaries.length ? <>你持有的受益者 {link.beneficiaries.length} 名：{link.beneficiaries.slice(0, 24).map(chip)}{link.beneficiaries.length > 24 && <small>…等 {link.beneficiaries.length} 名</small>}</> : <small>你目前沒有持有受益的幹員。</small>}</div>
      </article>)}</div>
      {!links.length && <p className="fine-print">沒有符合的相性。</p>}
    </section>
    <section className="panel" aria-label="對敵減益">
      <h3>對敵減益</h3>
      <p className="fine-print">會讓敵人更脆弱的幹員，適合和對應傷害類型的輸出一起編入。</p>
      <div className="synergy-grid">{statuses.map(status => <article key={status} className="synergy-card">
        <header><strong>{status}</strong><span className="tag muted">適合搭配{DEBUFF_PARTNER[status] ?? '輸出'}</span></header>
        {debuffs.filter(item => item.status === status).map(item => <details key={item.providerId} className="plain-details"><summary>{chip(item.providerId)} {item.source.kind}「{item.source.name}」</summary><p className="synergy-text">{item.source.description}</p></details>)}
      </article>)}</div>
    </section>
  </>;
}
