import { useEffect, useMemo, useState } from 'preact/hooks';
import type { GrowthCatalog } from '../catalog/growth';
import type { AppState, OperatorDefinition, Settings } from '../domain/model';
import { currentState, emptyTarget, expandRecipes, expToRecords, growthCost, LMD_ITEM, type GrowthCost, type GrowthState } from '../domain/growth';
import { OperatorPortrait } from '../OperatorEncyclopedia';
import { Icon } from './Icon';
import { useStageData } from './gameData';
import { materialSources, OCCURRENCE, sanityEstimate } from '../domain/stages';

type Growth = NonNullable<Settings['growth']>;
const fmt = (value: number) => value.toLocaleString('zh-TW');
const ELITE = ['精零', '精一', '精二'];

export function useGrowthCatalog(isDemo: boolean) {
  const [catalog, setCatalog] = useState<GrowthCatalog | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (isDemo) { setError('示範資料沒有養成成本；請切換到個人工作區並更新遊戲資料。'); return; }
    const controller = new AbortController();
    void fetch('/api/game-data/growth', { credentials: 'omit', redirect: 'error', signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        const body = await response.json().catch(() => null) as (GrowthCatalog & { error?: { message?: string } }) | null;
        if (!response.ok || !body?.operators) throw new Error(body?.error?.message ?? '');
        setCatalog(body);
      })
      .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error && err.message ? err.message : '無法讀取養成資料，請確認已執行 npm run game-data 並在設定更新遊戲資料。'); });
    return () => controller.abort();
  }, [isDemo]);
  return { catalog, error };
}

/** 依目前狀態建立「下一步」的常用目標。 */
const PRESETS: { label: string; apply: (state: GrowthState, definition: OperatorDefinition, catalog: GrowthCatalog) => GrowthState }[] = [
  { label: '精二 1 級', apply: state => ({ ...state, elite: Math.max(state.elite, 2), level: state.elite >= 2 ? state.level : 1 }) },
  { label: '滿級', apply: (state, definition, catalog) => { const phases = catalog.operators[definition.id]?.phases ?? []; return { ...state, elite: phases.length - 1, level: phases.at(-1)?.maxLevel ?? state.level }; } },
  { label: '技能 7', apply: state => ({ ...state, skillLevel: 7 }) },
  { label: '全技能專三', apply: (state, definition) => ({ ...state, skillLevel: 7, masteries: Object.fromEntries(definition.skills.map(skill => [skill.id, 3])) }) },
  { label: '模組 3 級', apply: (state, definition) => ({ ...state, modules: Object.fromEntries(definition.modules.filter(module => module.levels?.length).map(module => [module.id, 3])) }) },
];

function stateText(state: GrowthState, definition: OperatorDefinition): string {
  const masteries = definition.skills.map((skill, index) => state.masteries[skill.id] ? `S${index + 1}專${state.masteries[skill.id]}` : '').filter(Boolean);
  const modules = definition.modules.map(module => state.modules[module.id] ? `${module.kind} ${state.modules[module.id]} 級` : '').filter(Boolean);
  return [`${ELITE[state.elite] ?? `精${state.elite}`} ${state.level} 級`, `技能 ${state.skillLevel}`, ...masteries, ...modules].join(' · ');
}

export function GrowthPage({ state, isDemo, busy, onSave }: { state: AppState; isDemo: boolean; busy: boolean; onSave: (growth: Growth) => void }) {
  const { catalog, error } = useGrowthCatalog(isDemo);
  const { data: stageData } = useStageData(isDemo);
  const now = useMemo(() => Date.now(), [stageData]);
  const [draft, setDraft] = useState<Growth>(state.settings.growth ?? { plans: [] });
  const [query, setQuery] = useState('');
  const definitions = useMemo(() => new Map(state.dataset.operators.map(op => [op.id, op])), [state.dataset]);
  const rows = useMemo(() => new Map(state.roster.map(row => [row.operatorId, row])), [state.roster]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings.growth ?? { plans: [] });
  if (error) return <section className="panel"><h2>養成計算</h2><p className="callout warning">{error}</p></section>;
  if (!catalog) return <section className="panel"><h2>養成計算</h2><p className="fine-print">讀取遊戲資料中…</p></section>;

  const owned = state.roster.filter(row => !(row.fields.owned?.status === 'known' && row.fields.owned.value === false) && definitions.get(row.operatorId) && catalog.operators[row.operatorId]);
  const planned = new Set(draft.plans.map(plan => plan.operatorId));
  const matches = query.trim() ? owned.filter(row => { const def = definitions.get(row.operatorId)!; return !planned.has(row.operatorId) && [def.displayName, ...def.aliases].some(name => name.includes(query.trim())); }).slice(0, 8) : [];
  const setPlan = (operatorId: string, target: GrowthState | null) => setDraft(current => ({ ...current, plans: target ? current.plans.some(plan => plan.operatorId === operatorId) ? current.plans.map(plan => plan.operatorId === operatorId ? { operatorId, target } : plan) : [...current.plans, { operatorId, target }] : current.plans.filter(plan => plan.operatorId !== operatorId) }));

  const costs = draft.plans.map(plan => {
    const definition = definitions.get(plan.operatorId);
    if (!definition) return null;
    const { state: from, unknown } = currentState(rows.get(plan.operatorId), definition);
    return { plan, definition, from, unknown, cost: growthCost(catalog, definition, from, plan.target) };
  }).filter((item): item is NonNullable<typeof item> => !!item);
  const total: GrowthCost = { lmd: 0, exp: 0, items: {}, steps: [], notes: [] };
  for (const { cost } of costs) { total.lmd += cost.lmd; total.exp += cost.exp; for (const [id, count] of Object.entries(cost.items)) total.items[id] = (total.items[id] ?? 0) + count; }
  const expanded = draft.expand ? expandRecipes(catalog, total.items) : null;
  const items = expanded?.items ?? total.items;
  const inventory = draft.inventory ?? {};
  const lmd = total.lmd + (expanded?.lmd ?? 0);
  const records = expToRecords(catalog, total.exp);
  const list = Object.entries(items).map(([id, count]) => ({ id, count, item: catalog.items[id], have: inventory[id] ?? 0 }))
    .sort((a, b) => (b.item?.rarity ?? 0) - (a.item?.rarity ?? 0) || (a.item?.sortId ?? 0) - (b.item?.sortId ?? 0));
  const short = list.filter(entry => entry.count > entry.have).length;
  // 缺的材料去哪刷：取理智／件最低的關卡（沒有掉率時取機率等級最高者）。
  const best = new Map(stageData ? list.filter(entry => entry.count > entry.have).map(entry => [entry.id, materialSources(entry.id, stageData.stages, stageData.events, now, stageData.drops)[0]] as const) : []);
  const farmText = (entry: { id: string; count: number; have: number }) => {
    const source = best.get(entry.id);
    if (!source) return entry.count > entry.have ? (stageData ? (catalog.recipes[entry.id] ? '合成' : '無關卡掉落') : '…') : '';
    // 沒有掉率、且只有小概率／罕見掉落時，可合成的材料建議合成。
    if (source.apPerItem === undefined && (OCCURRENCE[source.drop.occurrence]?.rank ?? 9) >= 3 && catalog.recipes[entry.id]) return `合成（或 ${source.stage.code}・${OCCURRENCE[source.drop.occurrence]?.label}）`;
    return `${source.stage.code}${source.apPerItem !== undefined && Number.isFinite(source.apPerItem) ? `・${fmt(Math.round(source.apPerItem * 10) / 10)} 理智／件` : `・${OCCURRENCE[source.drop.occurrence]?.label ?? ''}`}`;
  };
  const sanity = list.reduce((sum, entry) => { const value = entry.count > entry.have ? sanityEstimate(entry.count - entry.have, best.get(entry.id)) : 0; return value === undefined ? NaN : sum + value; }, 0);
  const setHave = (id: string, value: string) => setDraft(current => { const next = { ...(current.inventory ?? {}) }; const count = Math.max(0, Math.min(10_000_000, Math.round(Number(value) || 0))); if (count) next[id] = count; else delete next[id]; return { ...current, inventory: next }; });

  return <div className="growth-page">
    <section className="panel">
      <header className="recommend-head"><div><p className="eyebrow">養成計算</p><h2>精英化、技能、專精與模組需要多少材料</h2></div><span className="tag muted">遊戲資料 {catalog.version.slice(0, 7)}</span></header>
      <p className="fine-print">目前狀態取自幹員庫；未知的欄位以最低值計算並標示。數值全部來自遊戲資料表（經驗與龍門幣表、精英化與技能材料、模組材料、加工配方）。</p>
      <label className="growth-search"><span className="sr-only">搜尋要加入計畫的幹員</span><input className="text-input" placeholder="輸入幹員名稱加入計畫…" value={query} disabled={busy} onInput={event => setQuery(event.currentTarget.value)}/></label>
      {matches.length > 0 && <div className="growth-matches">{matches.map(row => { const def = definitions.get(row.operatorId)!; return <button key={row.operatorId} type="button" className="button secondary small" onClick={() => { const { state: from } = currentState(row, def); setPlan(row.operatorId, PRESETS[0].apply(from, def, catalog)); setQuery(''); }}>{def.displayName}</button>; })}</div>}
      {query.trim() && !matches.length && <p className="fine-print">找不到持有中、尚未加入的幹員。</p>}
      <div className="inline-actions">
        <button type="button" className="button primary" disabled={busy || !dirty} onClick={() => onSave(draft)}>保存計畫</button>
        {dirty && <button type="button" className="button ghost" disabled={busy} onClick={() => setDraft(state.settings.growth ?? { plans: [] })}>還原</button>}
        <span className="fine-print">{dirty ? '有尚未保存的變更。' : '計畫與庫存只存在這台裝置。'}</span>
      </div>
    </section>

    {costs.length > 0 && <section className="panel" aria-label="合計">
      <div className="stats-cards">
        <div className="stats-card lmd"><span>龍門幣</span><strong>{fmt(lmd)}</strong><small>{expanded ? `含合成 ${fmt(expanded.lmd)}` : '不含加工合成'}</small></div>
        <div className="stats-card exp"><span>經驗</span><strong>{fmt(total.exp)}</strong><small>{records.map(record => `約 ${fmt(record.count)} 張${catalog.items[record.id]?.name ?? '作戰記錄'}`).join('')}</small></div>
        <div className="stats-card gold"><span>材料種類</span><strong>{list.length}</strong><small>{short ? `${short} 種庫存不足` : '庫存足夠'}</small></div>
        <div className="stats-card shift"><span>預估理智</span><strong>{stageData?.drops && Number.isFinite(sanity) ? fmt(sanity) : '—'}</strong><small>{!stageData ? '讀取關卡中' : !stageData.drops ? '需企鵝物流掉率' : Number.isFinite(sanity) ? `缺口照最佳關卡刷・${costs.length} 名幹員` : '部分材料沒有可刷關卡'}</small></div>
      </div>
      <div className="inline-actions">
        <label className="checkbox-line"><input type="checkbox" checked={!!draft.expand} disabled={busy} onChange={event => setDraft(current => ({ ...current, expand: event.currentTarget.checked || undefined }))}/><span>把精英材料展開成可合成的低階材料（加工站配方，不計副產品）</span></label>
      </div>
      <table className="stats-table growth-items"><thead><tr><th>材料</th><th>需要</th><th>庫存</th><th>缺</th><th>去哪刷</th></tr></thead><tbody>
        {list.map(entry => <tr key={entry.id} className={entry.count > entry.have ? 'short' : ''}><td><span className={`rarity r${entry.item?.rarity ?? 0}`}>{entry.item?.name ?? entry.id}</span>{farmText(entry) && <small className="growth-farm-inline">{farmText(entry)}</small>}</td><td>{fmt(entry.count)}</td>
          <td><input className="text-input small" type="number" min={0} value={entry.have || ''} placeholder="0" aria-label={`${entry.item?.name ?? entry.id}庫存`} disabled={busy} onInput={event => setHave(entry.id, event.currentTarget.value)}/></td>
          <td>{entry.count > entry.have ? fmt(entry.count - entry.have) : '—'}</td>
          <td className="growth-farm">{farmText(entry)}</td></tr>)}
      </tbody></table>
      {expanded && Object.keys(expanded.crafted).length > 0 && <p className="fine-print">需要合成：{Object.entries(expanded.crafted).map(([id, count]) => `${catalog.items[id]?.name ?? id}×${count}`).join('、')}。</p>}
    </section>}

    <div className="growth-plans">
      {costs.map(({ plan, definition, from, unknown, cost }) => {
        const op = catalog.operators[definition.id]!;
        const target = plan.target;
        const update = (patch: Partial<GrowthState>) => setPlan(definition.id, { ...target, ...patch });
        const maxLevel = op.phases[target.elite]?.maxLevel ?? 1;
        return <article key={plan.operatorId} className="panel growth-card" aria-label={`${definition.displayName}養成目標`}>
          <header className="growth-card-head">
            <OperatorPortrait definition={definition}/>
            <div><h3>{definition.displayName}</h3><p className="fine-print">目前：{stateText(from, definition)}</p>{unknown.length > 0 && <p className="fine-print amber">未知（以最低值計）：{unknown.join('、')}</p>}</div>
            <button type="button" className="icon-button" aria-label={`從計畫移除${definition.displayName}`} disabled={busy} onClick={() => setPlan(definition.id, null)}><Icon name="close" size={16}/></button>
          </header>
          <div className="growth-presets">{PRESETS.map(preset => <button key={preset.label} type="button" className="button ghost small" disabled={busy} onClick={() => setPlan(definition.id, preset.apply(target, definition, catalog))}>{preset.label}</button>)}</div>
          <div className="facility-controls">
            <label><span>精英</span><select className="filter" value={target.elite} disabled={busy} onChange={event => { const elite = Number(event.currentTarget.value); update({ elite, level: Math.min(target.level, op.phases[elite]?.maxLevel ?? 1) }); }}>{op.phases.map((_, index) => <option key={index} value={index}>{ELITE[index]}</option>)}</select></label>
            <label><span>等級（上限 {maxLevel}）</span><input className="text-input" type="number" min={1} max={maxLevel} value={target.level} disabled={busy} onInput={event => update({ level: Math.max(1, Math.min(maxLevel, Math.round(Number(event.currentTarget.value) || 1))) })}/></label>
            <label><span>技能等級</span><select className="filter" value={target.skillLevel} disabled={busy} onChange={event => update({ skillLevel: Number(event.currentTarget.value) })}>{[1, 2, 3, 4, 5, 6, 7].map(level => <option key={level} value={level}>{level}</option>)}</select></label>
            {definition.skills.filter(skill => op.masteries[skill.id]).map((skill, index) => <label key={skill.id}><span>技能 {index + 1}「{skill.name}」專精</span><select className="filter" value={target.masteries[skill.id] ?? 0} disabled={busy} onChange={event => update({ masteries: { ...target.masteries, [skill.id]: Number(event.currentTarget.value) } })}>{[0, 1, 2, 3].map(level => <option key={level} value={level}>{level ? `專精 ${level}` : '不專精'}</option>)}</select></label>)}
            {definition.modules.filter(module => module.levels?.length).map(module => <label key={module.id}><span>{module.name}</span><select className="filter" value={target.modules[module.id] ?? 0} disabled={busy} onChange={event => update({ modules: { ...target.modules, [module.id]: Number(event.currentTarget.value) } })}>{[0, 1, 2, 3].map(level => <option key={level} value={level}>{level ? `${level} 級` : '不開'}</option>)}</select></label>)}
          </div>
          <p className="growth-summary"><strong>目標：</strong>{stateText(cost.target ?? target, definition)}　<strong>需要：</strong>龍門幣 {fmt(cost.lmd)}、經驗 {fmt(cost.exp)}{Object.keys(cost.items).length ? `、材料 ${Object.keys(cost.items).length} 種` : ''}</p>
          {cost.notes.map(note => <p key={note} className="fine-print">{note}。</p>)}
          {cost.steps.length > 0 && <details className="plain-details"><summary>逐步明細（{cost.steps.length} 步）</summary><table className="stats-table"><thead><tr><th>步驟</th><th>龍門幣</th><th>經驗</th><th>材料</th></tr></thead><tbody>
            {cost.steps.map(step => <tr key={step.label}><td>{step.label}</td><td>{step.lmd ? fmt(step.lmd) : '—'}</td><td>{step.exp ? fmt(step.exp) : '—'}</td><td>{step.items.map(item => `${catalog.items[item.id]?.name ?? item.id}×${item.count}`).join('、') || '—'}</td></tr>)}
          </tbody></table></details>}
        </article>;
      })}
      {!costs.length && <section className="panel"><p className="fine-print">還沒有計畫。在上方輸入幹員名稱加入，預設目標為精二 1 級，之後可以逐項調整。</p></section>}
    </div>
    <details className="plain-details panel"><summary>計算方式</summary><ul className="gap-list">
      <li>升級：各精英階段逐級加總資料表 characterExpMap（經驗）與 characterUpgradeCostMap（龍門幣）；精英化龍門幣取 evolveGoldCost，材料取 character_table 的 evolveCost。</li>
      <li>技能等級 1→7 取 allSkillLvlup；專精取各技能 levelUpCostCond；模組取模組表 itemCost（其中的龍門幣計入龍門幣）。</li>
      <li>專精、技能 5 以上、模組的前提（精英階段、等級、技能 7）不足時，自動把前提一起計入並註明。</li>
      <li>展開合成：精英材料依加工站配方拆到罕見品質（藍）以下，加上每次合成的龍門幣；副產品是機率性的額外收穫，沒有扣除。</li>
      <li>經驗以高級作戰記錄（{fmt(catalog.expItems['2004'] ?? 2000)} 經驗）換算張數。{LMD_ITEM ? '' : ''}</li>
    </ul></details>
  </div>;
}
