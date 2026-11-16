import { useMemo, useState } from 'preact/hooks';
import type { AppState, OperatorDefinition } from '../domain/model';
import { analyzeSynergies, DEBUFF_PARTNER, type SynergyLink } from '../domain/synergy';
import { useBaseCatalog } from './BasePage';
import { useGrowthCatalog } from './GrowthPage';
import { effectText } from './BasePage';
import { IS_THEMES, operatorReview } from '../domain/review';
import type { RogueAnalysis } from '../catalog/rogue';
import { fitLevel, themeFit, type ThemeFit } from '../domain/rogueFit';
import { operatorTexts } from '../domain/synergy';
import { buildSquad, operatorInfo, TEMPLATES } from '../domain/squad';
import { useEffect } from 'preact/hooks';
import type { EnemyCatalog } from '../catalog/enemies';
import { analyzeStage, parseDangerLevel, stageEnemyList, THRESHOLDS, type StageEnemy } from '../domain/stagePlan';
import { useStageData } from './gameData';

const TRIGGER_LABEL: Record<SynergyLink['trigger'], string> = { squad: '編入隊伍', deployed: '在場時', skill: '技能期間', always: '說明未寫條件' };
const KIND_ORDER: SynergyLink['target']['kind'][] = ['operator', 'group', 'profession', 'branch', 'rarity', 'position'];
const KIND_LABEL: Record<SynergyLink['target']['kind'], string> = { operator: '指定幹員', group: '陣營', profession: '職業', branch: '分支', rarity: '星級', position: '位置' };

export function TeamPage({ state, isDemo, onSaveNotes }: { state: AppState; isDemo: boolean; onSaveNotes?: (notes: NonNullable<AppState['settings']['reviewNotes']>) => void }) {
  const [tab, setTab] = useState<'synergy' | 'squad' | 'stage' | 'review' | 'rogue'>('synergy');
  const tabs = <div className="segmented" role="tablist">{([['synergy', '幹員相性'], ['squad', '編隊建議'], ['stage', '依關卡推薦'], ['review', '幹員簡評'], ['rogue', '集成戰略主題']] as const).map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>;
  return <div className="team-page">
    {tab === 'synergy' && <SynergyTab state={state} isDemo={isDemo} tabs={tabs}/>}
    {tab === 'squad' && <SquadTab state={state} isDemo={isDemo} tabs={tabs}/>}
    {tab === 'stage' && <StageTab state={state} isDemo={isDemo} tabs={tabs}/>}
    {tab === 'rogue' && <RogueTab state={state} isDemo={isDemo} tabs={tabs}/>}
    {tab === 'review' && <ReviewTab state={state} isDemo={isDemo} tabs={tabs} onSaveNotes={onSaveNotes}/>}
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

const MODES: { key: string; label: string }[] = [{ key: 'daily', label: '日常（主線／活動）' }, { key: 'base', label: '基建' }, ...IS_THEMES.map((theme, index) => ({ key: `is${index + 1}`, label: `集成戰略：${theme}` })), { key: 'reclamation', label: '生息演算' }, { key: 'security', label: '保全派駐' }];
function ReviewTab({ state, isDemo, tabs, onSaveNotes }: { state: AppState; isDemo: boolean; tabs: preact.JSX.Element; onSaveNotes?: (notes: NonNullable<AppState['settings']['reviewNotes']>) => void }) {
  const { catalog: growth } = useGrowthCatalog(isDemo);
  const { catalog: base } = useBaseCatalog(isDemo, 0);
  const [operatorId, setOperatorId] = useState('');
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const definitions = state.dataset.operators;
  const head = <header className="recommend-head"><div><p className="eyebrow">搭配</p><h2>幹員簡評</h2></div>{tabs}</header>;
  if (!growth) return <section className="panel">{head}<p className="fine-print">讀取遊戲資料中…</p></section>;
  const definition = definitions.find(def => def.id === operatorId);
  const matches = query.trim() ? definitions.filter(def => def.displayName.includes(query.trim()) && growth.operators[def.id]).slice(0, 10) : [];
  const review = definition ? operatorReview(definition, definitions, growth, base, effectText) : null;
  const rogue = useRogueFits(isDemo, state, growth, base);
  const saved = (definition && state.settings.reviewNotes?.[definition.id]) ?? {};
  const note = (key: string) => notes[key] ?? saved[key] ?? '';
  const dirty = definition && Object.keys(notes).some(key => (notes[key] ?? '') !== (saved[key] ?? ''));
  const list = (items: { kind: string; name: string; description: string }[]) => <ul className="gap-list">{items.map(item => <li key={item.description}>{item.kind}「{item.name}」：{item.description}</li>)}</ul>;
  const noteBox = (key: string) => <textarea className="text-area review-note" maxLength={1000} placeholder="我的筆記（只存在這台裝置）" value={note(key)} onInput={event => setNotes(current => ({ ...current, [key]: event.currentTarget.value }))}/>;
  return <>
    <section className="panel">
      {head}
      <p className="fine-print">只整理遊戲資料寫明的事實與可計算的比較：日常看數值在同分支的排位、費用與技能觸發；基建用本工具的技能解析；集成戰略、生息演算、保全派駐只列出資料明寫的專屬效果。本工具不做主觀強度評分，資料沒有的部分請用筆記補充。</p>
      <input className="text-input" placeholder="輸入幹員名稱…" value={query} onInput={event => setQuery(event.currentTarget.value)}/>
      {matches.length > 0 && <div className="growth-matches">{matches.map(def => <button key={def.id} type="button" className="button secondary small" onClick={() => { setOperatorId(def.id); setNotes({}); setQuery(''); }}>{def.displayName}</button>)}</div>}
    </section>
    {definition && review && <section className="panel" aria-label="簡評">
      <header className="recommend-head"><div><h3>{definition.displayName}</h3><p className="fine-print">{definition.rarity}★・{definition.profession}・{definition.branch}</p></div>
        {onSaveNotes && <button type="button" className="button primary" disabled={!dirty} onClick={() => { const next = { ...(state.settings.reviewNotes ?? {}) }; const merged = Object.fromEntries(Object.entries({ ...saved, ...notes }).filter(([, value]) => value.trim())); if (Object.keys(merged).length) next[definition.id] = merged; else delete next[definition.id]; onSaveNotes(next); setNotes({}); }}>保存筆記</button>}</header>
      <div className="review-grid">
        {MODES.map(mode => {
          let body: preact.JSX.Element;
          if (mode.key === 'daily') body = <><ul className="gap-list">{review.daily.facts.map(fact => <li key={fact}>{fact}</li>)}</ul><ul className="gap-list">{review.daily.skills.map(skill => <li key={skill}>{skill}</li>)}</ul></>;
          else if (mode.key === 'base') body = review.base.length ? <ul className="gap-list">{review.base.map(item => <li key={item.skill}><strong>{item.room}</strong>「{item.skill}」：{item.effects}{item.note ? `（${item.note}）` : ''}</li>)}</ul> : <p className="fine-print">沒有基建技能。</p>;
          else if (mode.key.startsWith('is')) {
            const theme = review.roguelike[Number(mode.key.slice(2)) - 1]; const items = [...theme.effects, ...review.roguelikeGeneral];
            const fit = rogue?.fits.get(theme.theme)?.get(definition.id), scores = rogue?.scores.get(theme.theme);
            body = <>{fit && scores ? <FitView fit={fit} level={fitLevel(fit.score, scores)}/> : <p className="fine-print">{rogue ? '此主題的關卡資料尚未分析。' : '分析主題關卡中…（首次需下載關卡檔）'}</p>}{items.length > 0 && list(items)}</>;
          }
          else if (mode.key === 'reclamation') body = review.reclamation.length ? list(review.reclamation) : <p className="fine-print">資料沒有生息演算的專屬效果。</p>;
          else body = review.security.length ? list(review.security) : <p className="fine-print">資料沒有保全派駐的專屬效果；保全派駐的表現取決於關卡與招募組合，本工具不評分。</p>;
          return <article key={mode.key} className="synergy-card review-card"><header><strong>{mode.label}</strong></header>{body}{noteBox(mode.key)}</article>;
        })}
      </div>
    </section>}
  </>;
}

/** 各主題的分析與全部幹員的契合度（主題關卡分析由資料服務快取）。 */
function useRogueFits(isDemo: boolean, state: AppState, growth: ReturnType<typeof useGrowthCatalog>['catalog'], base: ReturnType<typeof useBaseCatalog>['catalog']) {
  const [analyses, setAnalyses] = useState<RogueAnalysis[] | null>(null);
  useEffect(() => {
    if (isDemo) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const list = await fetch('/api/game-data/rogue', { credentials: 'omit', redirect: 'error', signal: controller.signal, cache: 'no-store' }).then(response => response.ok ? response.json() : []) as { id: string }[];
        const results: RogueAnalysis[] = [];
        for (const theme of list) { const response = await fetch(`/api/game-data/rogue-analysis?theme=${encodeURIComponent(theme.id)}`, { credentials: 'omit', redirect: 'error', signal: controller.signal, cache: 'no-store' }); if (response.ok) results.push(await response.json()); }
        if (!controller.signal.aborted) setAnalyses(results);
      } catch { /* 資料服務沒有集成戰略資料時不顯示 */ }
    })();
    return () => controller.abort();
  }, [isDemo]);
  return useMemo(() => {
    if (!analyses || !growth) return null;
    const definitions = state.dataset.operators.filter(def => growth.operators[def.id]?.stats);
    const debuffs = analyzeSynergies(state.dataset.operators, id => base?.meta?.[id]?.groups ?? []).debuffs;
    const fits = new Map<string, Map<string, ThemeFit>>(), scores = new Map<string, number[]>();
    for (const analysis of analyses) {
      const map = new Map(definitions.map(def => [def.id, themeFit(def, growth, analysis, debuffs, operatorTexts(def).filter(text => text.description.includes(`【${analysis.name}】`)).map(text => text.description))]));
      fits.set(analysis.name, map); scores.set(analysis.name, [...map.values()].map(item => item.score));
    }
    return { analyses, fits, scores };
  }, [analyses, growth, base, state.dataset]);
}

function FitView({ fit, level }: { fit: ThemeFit; level: '高' | '中' | '低' }) {
  return <div className="fit-view">
    <p><span className={`fit-badge fit-${level === '高' ? 'high' : level === '中' ? 'mid' : 'low'}`}>契合度 {level}</span> <small className="fine-print">{fit.score} 分（依主題內容計算，不是強度）</small></p>
    {fit.reasons.length ? <ul className="gap-list">{fit.reasons.slice(0, 6).map(reason => <li key={reason.text}>+{reason.points}　{reason.text}</li>)}</ul> : <p className="fine-print">這個主題的敵人組成、地塊與藏品沒有特別對他有利的地方。</p>}
  </div>;
}

function RogueTab({ state, isDemo, tabs }: { state: AppState; isDemo: boolean; tabs: preact.JSX.Element }) {
  const { catalog: growth } = useGrowthCatalog(isDemo);
  const { catalog: base } = useBaseCatalog(isDemo, 0);
  const rogue = useRogueFits(isDemo, state, growth, base);
  const [themeName, setThemeName] = useState('');
  const head = <header className="recommend-head"><div><p className="eyebrow">搭配</p><h2>集成戰略主題分析</h2></div>{tabs}</header>;
  if (!rogue) return <section className="panel">{head}<p className="fine-print">分析各主題關卡中…（首次需下載所有關卡檔，約需 1～2 分鐘）</p></section>;
  const analysis = rogue.analyses.find(item => item.name === themeName) ?? rogue.analyses.at(-1)!;
  const owned = new Set(state.roster.filter(row => !(row.fields.owned?.status === 'known' && row.fields.owned.value === false)).map(row => row.operatorId));
  const fits = rogue.fits.get(analysis.name)!, scores = rogue.scores.get(analysis.name)!;
  const name = (id: string) => state.dataset.operators.find(def => def.id === id)?.displayName ?? id;
  const top = [...fits].filter(([id]) => owned.has(id)).sort((a, b) => b[1].score - a[1].score).slice(0, 12);
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const special = analysis.relics.filter(relic => /【(?!先鋒|近衛|重裝|狙擊|術師|醫療|輔助|特種)[^】]+】/u.test(relic.usage)).slice(0, 30);
  const tilesTotal = analysis.tiles.melee + analysis.tiles.ranged;
  return <>
    <section className="panel">
      {head}
      <p className="fine-print">讀取該主題全部關卡的敵人名單、數值與地塊（繁中服關卡檔，固定版本），以出現次數加權統計；藏品取自主題資料。契合度＝主題內容對幹員有利的程度，每一分都列出理由，不是強度排行。</p>
      <div className="segmented">{rogue.analyses.map(item => <button key={item.id} type="button" className={item.name === analysis.name ? 'active' : ''} onClick={() => setThemeName(item.name)}>{item.name}</button>)}</div>
    </section>
    <section className="panel" aria-label="主題概況">
      <h3>{analysis.name}：{analysis.analyzedStages} 關、敵人 {analysis.enemy.spawns.toLocaleString('zh-TW')} 隻次</h3>
      <div className="stats-cards">
        <div className="stats-card lmd"><span>飛行</span><strong>{pct(analysis.enemy.fly)}</strong><small>需要遠程輸出</small></div>
        <div className="stats-card exp"><span>高防禦（≥800）</span><strong>{pct(analysis.enemy.highDef)}</strong><small>適合法術輸出</small></div>
        <div className="stats-card gold"><span>高法抗（≥50）</span><strong>{pct(analysis.enemy.highRes)}</strong><small>適合物理輸出</small></div>
        <div className="stats-card shift"><span>法術攻擊／精英領袖</span><strong>{pct(analysis.enemy.magic)}／{pct(analysis.enemy.elite)}</strong><small>地面格 {tilesTotal ? pct(analysis.tiles.melee / tilesTotal) : '—'}</small></div>
      </div>
      <h3>常見敵人</h3>
      <p className="fine-print">{analysis.topEnemies.map(enemy => `${enemy.name}×${enemy.count}${enemy.fly ? '（飛行）' : ''}${enemy.magic ? '（法術）' : ''}`).join('、')}</p>
      <h3>領袖（{analysis.bosses.length}）</h3>
      <div className="table-scroll"><table className="stats-table"><thead><tr><th>領袖</th><th>出現關卡</th><th>生命</th><th>攻擊</th><th>防禦</th><th>法抗</th><th>特性</th></tr></thead><tbody>
        {analysis.bosses.map(boss => <tr key={boss.name}><td>{boss.name}</td><td>{boss.stage}</td><td>{boss.hp.toLocaleString('zh-TW')}</td><td>{boss.atk}</td><td className={boss.def >= 800 ? 'hot' : ''}>{boss.def}</td><td className={boss.res >= 50 ? 'hot' : ''}>{boss.res}</td><td>{[boss.fly ? '飛行' : '', boss.magic ? '法術攻擊' : '', ...boss.abilities.slice(0, 2)].filter(Boolean).join('；')}</td></tr>)}
      </tbody></table></div>
      {special.length > 0 && <details className="plain-details"><summary>點名特定分支／機制的藏品（{special.length}）</summary><ul className="gap-list">{special.map(relic => <li key={relic.id}><strong>{relic.name}</strong>：{relic.usage}</li>)}</ul></details>}
    </section>
    <section className="panel" aria-label="你的契合幹員">
      <h3>你持有的幹員中契合度最高</h3>
      <div className="synergy-grid">{top.map(([id, fit]) => <article key={id} className="synergy-card"><header><strong>{name(id)}</strong></header><FitView fit={fit} level={fitLevel(fit.score, scores)}/></article>)}</div>
    </section>
  </>;
}
