import { useMemo, useState } from 'preact/hooks';
import type { AppState, OperatorDefinition } from '../domain/model';
import { analyzeSynergies, DEBUFF_PARTNER, type SynergyLink } from '../domain/synergy';
import { useBaseCatalog } from './BasePage';
import { useGrowthCatalog } from './GrowthPage';
import { buildSquad, operatorInfo, TEMPLATES } from '../domain/squad';
import { useEffect } from 'preact/hooks';
import type { EnemyCatalog } from '../catalog/enemies';
import { analyzeStage, parseDangerLevel, stageEnemyList, THRESHOLDS, type StageEnemy } from '../domain/stagePlan';
import { useStageData } from './gameData';

const TRIGGER_LABEL: Record<SynergyLink['trigger'], string> = { squad: '編入隊伍', deployed: '在場時', skill: '技能期間', always: '說明未寫條件' };
const KIND_ORDER: SynergyLink['target']['kind'][] = ['operator', 'group', 'profession', 'branch', 'rarity', 'position'];
const KIND_LABEL: Record<SynergyLink['target']['kind'], string> = { operator: '指定幹員', group: '陣營', profession: '職業', branch: '分支', rarity: '星級', position: '位置' };

export function TeamPage({ state, isDemo }: { state: AppState; isDemo: boolean }) {
  const [tab, setTab] = useState<'synergy' | 'squad' | 'stage'>('synergy');
  const tabs = <div className="segmented" role="tablist">{([['synergy', '幹員相性'], ['squad', '編隊建議'], ['stage', '依關卡推薦']] as const).map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>;
  return <div className="team-page">
    {tab === 'synergy' && <SynergyTab state={state} isDemo={isDemo} tabs={tabs}/>}
    {tab === 'squad' && <SquadTab state={state} isDemo={isDemo} tabs={tabs}/>}
    {tab === 'stage' && <StageTab state={state} isDemo={isDemo} tabs={tabs}/>}
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

function SquadTab({ state, isDemo, tabs }: { state: AppState; isDemo: boolean; tabs: preact.JSX.Element }) {
  const { catalog: growth, error } = useGrowthCatalog(isDemo);
  const { catalog: base } = useBaseCatalog(isDemo, 0);
  const [template, setTemplate] = useState<keyof typeof TEMPLATES>('general');
  const [locked, setLocked] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const byId = useMemo(() => new Map(state.dataset.operators.map(def => [def.id, def])), [state.dataset]);
  const rows = useMemo(() => new Map(state.roster.map(row => [row.operatorId, row])), [state.roster]);
  const infos = useMemo(() => growth ? state.roster.filter(row => !(row.fields.owned?.status === 'known' && row.fields.owned.value === false) && byId.get(row.operatorId) && growth.operators[row.operatorId])
    .map(row => operatorInfo(byId.get(row.operatorId)!, rows.get(row.operatorId), growth)) : [], [growth, state.roster, byId, rows]);
  if (error) return <section className="panel"><header className="recommend-head"><div><p className="eyebrow">搭配</p><h2>編隊建議</h2></div>{tabs}</header><p className="callout warning">{error}</p></section>;
  if (!growth) return <section className="panel"><header className="recommend-head"><div><p className="eyebrow">搭配</p><h2>編隊建議</h2></div>{tabs}</header><p className="fine-print">讀取遊戲資料中…</p></section>;
  const roles = TEMPLATES[template].roles;
  const result = buildSquad(infos, roles, { locked, exclude: new Set(excluded) });
  const squad = new Set(result.picks.map(pick => pick.id));
  const synergy = analyzeSynergies(state.dataset.operators.filter(def => squad.has(def.id)), id => base?.meta?.[id]?.groups ?? [], squad);
  const active = synergy.links.filter(link => link.beneficiaries.length && (!link.minCount || link.beneficiaries.length + 1 >= link.minCount));
  const info = new Map(infos.map(item => [item.id, item]));
  const matches = query.trim() ? infos.filter(item => !squad.has(item.id) && item.definition.displayName.includes(query.trim())).slice(0, 8) : [];
  const unknownCount = result.picks.filter(pick => info.get(pick.id)?.unknown).length;
  return <>
    <section className="panel">
      <header className="recommend-head"><div><p className="eyebrow">搭配</p><h2>編隊建議</h2></div>{tabs}</header>
      <p className="fine-print">依官方招募標籤（費用回復、防護、治療、輸出、群攻、控場…）分配職責，再從你持有的幹員中挑養成度最高者。養成度＝星級、精英階段、等級、技能等級、專精與模組（都來自幹員庫）；不使用主觀強度排行。同一職業最多 4 名；養成度相同時依名稱排序，可按「換掉」看下一位。</p>
      <div className="inline-actions">
        <label><span className="sr-only">模板</span><select className="filter" value={template} onChange={event => setTemplate(event.currentTarget.value as keyof typeof TEMPLATES)}>{Object.entries(TEMPLATES).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label>
        <span className="fine-print">{TEMPLATES[template].note}職責：{roles.map(role => `${role.label}×${role.count}`).join('、')}，其餘為彈性位。</span>
      </div>
      <div className="inline-actions">
        <input className="text-input" placeholder="指定必帶的幹員…" value={query} onInput={event => setQuery(event.currentTarget.value)}/>
        {matches.map(item => <button key={item.id} type="button" className="button secondary small" onClick={() => { setLocked(list => [...list, item.id]); setExcluded(list => list.filter(id => id !== item.id)); setQuery(''); }}>{item.definition.displayName}</button>)}
        {excluded.length > 0 && <button type="button" className="button ghost small" onClick={() => setExcluded([])}>還原排除（{excluded.length}）</button>}
      </div>
    </section>
    <section className="panel" aria-label="建議隊伍">
      <h3>建議隊伍（{result.picks.length}／12）</h3>
      {result.missing.length > 0 && <p className="callout warning">職責不足：{result.missing.map(item => `${item.role}（需要 ${item.need}，只有 ${item.got}）`).join('、')}。持有的幹員中沒有更多符合標籤的人選。</p>}
      {unknownCount > 0 && <p className="fine-print amber">{unknownCount} 名的精英階段或等級在幹員庫中是未知，以最低值計算養成度。</p>}
      <div className="squad-grid">{result.picks.map(pick => { const item = info.get(pick.id)!; const isLocked = locked.includes(pick.id); return <article key={pick.id} className={`squad-card ${isLocked ? 'locked' : ''}`}>
        <header><strong>{item.definition.displayName}</strong><span className="tag">{pick.role}</span></header>
        <p className="fine-print">{item.definition.profession}・{item.definition.branch}</p>
        <p className="squad-reason">{pick.reason}</p>
        <div className="inline-actions">{isLocked ? <button type="button" className="button ghost small" onClick={() => setLocked(list => list.filter(id => id !== pick.id))}>取消必帶</button>
          : <button type="button" className="button ghost small" onClick={() => setExcluded(list => [...list, pick.id])}>換掉</button>}</div>
      </article>; })}</div>
    </section>
    <section className="panel" aria-label="隊伍內相性">
      <h3>隊伍內生效的相性（{active.length}）</h3>
      {active.length ? <ul className="gap-list">{active.map(link => <li key={`${link.providerId}-${link.target.value}`}><strong>{byId.get(link.providerId)?.displayName}</strong> → {link.target.label}（{link.beneficiaries.map(id => byId.get(id)?.displayName).join('、')}）：{link.source.description}</li>)}</ul>
        : <p className="fine-print">這支隊伍裡沒有天賦或技能明寫的陣營／職業加成。</p>}
    </section>
  </>;
}

const STAGE_TYPES = new Set(['MAIN', 'SUB', 'DAILY', 'ACTIVITY', 'CAMPAIGN']);
const RANK: Record<StageEnemy['rank'], string> = { NORMAL: '一般', ELITE: '精英', BOSS: '領袖' };
function StageTab({ state, isDemo, tabs }: { state: AppState; isDemo: boolean; tabs: preact.JSX.Element }) {
  const { data } = useStageData(isDemo);
  const { catalog: growth } = useGrowthCatalog(isDemo);
  const { catalog: base } = useBaseCatalog(isDemo, 0);
  const [enemyCatalog, setEnemyCatalog] = useState<EnemyCatalog | null>(null);
  const [query, setQuery] = useState('');
  const [stageId, setStageId] = useState('');
  const [detail, setDetail] = useState<{ stageId: string; enemies: { id: string; level: number; count: number }[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (isDemo) return;
    const controller = new AbortController();
    void fetch('/api/game-data/enemies', { credentials: 'omit', redirect: 'error', signal: controller.signal, cache: 'no-store' }).then(async response => { const body = await response.json().catch(() => null); if (!response.ok || !body || body.error) throw new Error(body?.error?.message ?? '無法讀取敵人資料。'); setEnemyCatalog(body); }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '無法讀取敵人資料。'); });
    return () => controller.abort();
  }, [isDemo]);
  useEffect(() => {
    if (!stageId) return;
    const controller = new AbortController();
    setDetail(null); setError('');
    void fetch(`/api/game-data/stage-enemies?id=${encodeURIComponent(stageId)}`, { credentials: 'omit', redirect: 'error', signal: controller.signal, cache: 'no-store' }).then(async response => { const body = await response.json().catch(() => null); if (!response.ok || !Array.isArray(body?.enemies)) throw new Error(body?.error?.message ?? '無法讀取關卡敵人。'); setDetail(body); }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '無法讀取關卡敵人。'); });
    return () => controller.abort();
  }, [stageId]);
  const byId = useMemo(() => new Map(state.dataset.operators.map(def => [def.id, def])), [state.dataset]);
  const rows = useMemo(() => new Map(state.roster.map(row => [row.operatorId, row])), [state.roster]);
  const infos = useMemo(() => growth ? state.roster.filter(row => !(row.fields.owned?.status === 'known' && row.fields.owned.value === false) && byId.get(row.operatorId) && growth.operators[row.operatorId]).map(row => operatorInfo(byId.get(row.operatorId)!, rows.get(row.operatorId), growth)) : [], [growth, state.roster, byId, rows]);
  const owned = useMemo(() => new Set(infos.map(info => info.id)), [infos]);
  const debuffs = useMemo(() => analyzeSynergies(state.dataset.operators, id => base?.meta?.[id]?.groups ?? [], owned).debuffs, [state.dataset, base, owned]);
  const head = <header className="recommend-head"><div><p className="eyebrow">搭配</p><h2>依關卡推薦</h2></div>{tabs}</header>;
  if (!data || !enemyCatalog || !growth) return <section className="panel">{head}{error ? <p className="callout warning">{error}</p> : <p className="fine-print">讀取遊戲資料中…</p>}</section>;
  const q = query.trim().toUpperCase();
  const matches = q ? data.stages.filter(stage => STAGE_TYPES.has(stage.type) && (stage as { levelId?: string }).levelId && !/^(easy|tough)_|#f#$/u.test(stage.id) && (stage.code.toUpperCase().includes(q) || stage.name.includes(query.trim()) || stage.id.toUpperCase() === q)).slice(0, 12) : [];
  const stage = data.stages.find(item => item.id === stageId);
  const enemies = detail && detail.stageId === stageId ? stageEnemyList(detail.enemies, enemyCatalog) : [];
  const threats = enemies.length ? analyzeStage(enemies, infos, debuffs) : [];
  const danger = parseDangerLevel(stage?.dangerLevel);
  const info = new Map(infos.map(item => [item.id, item]));
  const below = (id: string) => { if (!danger) return false; const row = rows.get(id); const e = row?.fields.elite, l = row?.fields.level; const elite = e?.status === 'known' ? Number(e.value) : undefined, level = l?.status === 'known' ? Number(l.value) : undefined; return elite !== undefined && level !== undefined && (elite < danger.elite || (elite === danger.elite && level < danger.level)); };
  return <>
    <section className="panel">
      {head}
      <p className="fine-print">讀取關卡的敵人名單與數值（繁中服關卡檔與敵人資料庫，固定版本），找出需要對應的威脅，再從你持有的幹員中依招募標籤與養成度挑選。高防禦（≥{THRESHOLDS.highDef}）、高法抗（≥{THRESHOLDS.highRes}）、敵人數量多（≥{THRESHOLDS.crowd}）是本工具的判斷門檻，下方會列出實際數值。</p>
      <input className="text-input" placeholder="輸入關卡代號或名稱，例如 1-7、S3-3…" value={query} onInput={event => setQuery(event.currentTarget.value)}/>
      {matches.length > 0 && <div className="growth-matches">{matches.map(item => <button key={item.id} type="button" className={`button ${item.id === stageId ? 'primary' : 'secondary'} small`} onClick={() => { setStageId(item.id); setQuery(''); }}>{item.code} {item.name}</button>)}</div>}
    </section>
    {stage && <section className="panel" aria-label="關卡敵人">
      <h3>{stage.code} {stage.name}{stage.dangerLevel && stage.dangerLevel !== '-' ? `（建議 ${stage.dangerLevel}）` : ''}</h3>
      {error && <p className="callout warning">{error}</p>}
      {!detail && !error && <p className="fine-print">下載關卡檔中…</p>}
      {enemies.length > 0 && <div className="table-scroll"><table className="stats-table enemy-table"><thead><tr><th>敵人</th><th>等級</th><th>數量</th><th>生命</th><th>攻擊</th><th>防禦</th><th>法抗</th><th>移動</th><th>傷害</th></tr></thead><tbody>
        {enemies.map(enemy => <tr key={enemy.id}><td>{enemy.name}</td><td>{RANK[enemy.rank]}</td><td>{enemy.count}</td><td>{enemy.stats.hp.toLocaleString('zh-TW')}</td><td>{enemy.stats.atk}</td><td className={enemy.stats.def >= THRESHOLDS.highDef ? 'hot' : ''}>{enemy.stats.def}</td><td className={enemy.stats.res >= THRESHOLDS.highRes ? 'hot' : ''}>{enemy.stats.res}</td><td>{enemy.stats.motion === 'FLY' ? '飛行' : '地面'}</td><td>{enemy.damage.map(type => ({ PHYSIC: '物理', MAGIC: '法術', HEAL: '治療', NO_DAMAGE: '無' } as Record<string, string>)[type] ?? type).join('、')}</td></tr>)}
      </tbody></table></div>}
    </section>}
    {threats.length > 0 && <section className="panel" aria-label="需要對應的威脅">
      <h3>需要對應的威脅（{threats.length}）</h3>
      <div className="synergy-grid">{threats.map(threat => <article key={threat.key} className="synergy-card">
        <header><strong>{threat.title}</strong></header>
        <p className="fine-print">{threat.evidence}</p>
        <p className="synergy-text">{threat.advice}</p>
        {threat.candidates.length ? <ul className="threat-list">{threat.candidates.map(item => <li key={item.id}><strong>{info.get(item.id)?.definition.displayName ?? byId.get(item.id)?.displayName}</strong>{below(item.id) && <span className="tag amber">低於建議等級</span>}<small>{item.reason}</small></li>)}</ul>
          : <p className="fine-print">{threat.key === 'stealth' ? '需要看幹員說明判斷，這裡不自動推薦。' : '你持有的幹員中沒有符合的人選。'}</p>}
      </article>)}</div>
    </section>}
    {enemies.length > 0 && !threats.length && <section className="panel"><p className="fine-print">這關沒有超過門檻的威脅，一般配置即可。</p></section>}
  </>;
}
