import { useEffect, useState } from 'preact/hooks';
import type { AppState, Settings } from '../domain/model';
import type { BaseCatalog } from '../catalog/base';
import { candidatesFor, evaluateBase, FACILITY_LABEL, parseSkill, productMatches, PRODUCT_LABEL, ROOM_OF, type Facility, type FacilityResult, type FacilityType, type SkillEffect } from '../domain/base';
import { createDemoBaseCatalog } from '../demo';
import { Icon } from './Icon';

type Base = Settings['base'];
const TYPES: FacilityType[] = ['control', 'manufacturing', 'trading', 'power', 'dormitory'];
const TEMPLATES: { label: string; layout: [FacilityType, number, number, Facility['product']?][] }[] = [
  { label: '243（貿易 2、製造 4、發電 3）', layout: [['control', 1, 5], ['trading', 2, 3], ['manufacturing', 2, 3, 'gold'], ['manufacturing', 2, 3, 'record'], ['power', 3, 3], ['dormitory', 4, 5]] },
  { label: '153（貿易 1、製造 5、發電 3）', layout: [['control', 1, 5], ['trading', 1, 3], ['manufacturing', 2, 3, 'gold'], ['manufacturing', 3, 3, 'record'], ['power', 3, 3], ['dormitory', 4, 5]] },
  { label: '252（貿易 2、製造 5、發電 2）', layout: [['control', 1, 5], ['trading', 2, 3], ['manufacturing', 2, 3, 'gold'], ['manufacturing', 3, 3, 'record'], ['power', 2, 3], ['dormitory', 4, 5]] },
];
const newId = () => `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const signed = (value: number, unit = '%') => `${value >= 0 ? '+' : ''}${value}${unit}`;

function effectText(effect: SkillEffect): string {
  switch (effect.kind) {
    case 'productivity': return `${effect.product === 'gold' ? '赤金' : effect.product === 'record' ? '作戰記錄' : effect.product === 'originium' ? '源石類' : ''}生產力 ${signed(effect.value)}`;
    case 'capacity': return `倉庫上限 ${signed(effect.value, '')}`;
    case 'moodCost': return `心情消耗 ${signed(effect.value, '/時')}`;
    case 'order': return `訂單效率 ${signed(effect.value)}`;
    case 'orderLimit': return `訂單上限 ${signed(effect.value, '')}`;
    case 'drone': return `無人機充能 ${signed(effect.value)}`;
    case 'moodRecoverSelf': return `自身心情恢復 ${signed(effect.value, '/時')}`;
    case 'moodRecoverAll': return `全宿舍心情恢復 ${signed(effect.value, '/時')}（取最高）`;
  }
}

function useBaseCatalog(isDemo: boolean, attempt: number) {
  const [catalog, setCatalog] = useState<BaseCatalog | null>(isDemo ? createDemoBaseCatalog() : null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (isDemo) { setCatalog(createDemoBaseCatalog()); setError(''); return; }
    const controller = new AbortController();
    setCatalog(null); setError('');
    void fetch('/api/game-data/base', { credentials: 'omit', redirect: 'error', signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        const body = await response.json().catch(() => null) as (BaseCatalog & { error?: { message?: string } }) | null;
        if (!response.ok || !body || !Array.isArray(body.rooms) || !body.skills || !body.operators) throw new Error(body?.error?.message ?? '');
        setCatalog(body);
      })
      .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error && err.message ? err.message : '無法讀取基建資料，請確認已執行 npm run game-data 並在設定更新遊戲資料。'); });
    return () => controller.abort();
  }, [isDemo, attempt]);
  return { catalog, error };
}

function FacilityCard({ result, catalog, state, base, busy, onChange, onRemove, onAssign, onUnassign }: {
  result: FacilityResult; catalog: BaseCatalog; state: AppState; base: Base; busy: boolean;
  onChange: (patch: Partial<Facility>) => void; onRemove: () => void; onAssign: (operatorId: string) => void; onUnassign: (operatorId: string) => void;
}) {
  const { facility, room } = result;
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const assignedAnywhere = new Set(Object.values(base.assignments ?? {}).flat());
  const candidates = candidatesFor(facility, catalog, state.roster, definitions, assignedAnywhere);
  const full = result.capacity > 0 && result.operators.length >= result.capacity;
  const roomType = ROOM_OF[facility.type];
  const metrics: [string, string][] = [];
  if (roomType === 'MANUFACTURE') metrics.push(['生產力（已計入）', signed(result.totals.basic + result.totals.productivity)]);
  if (roomType === 'TRADING') metrics.push(['訂單效率（已計入）', signed(result.totals.basic + result.totals.order)]);
  if (roomType === 'POWER') metrics.push(['無人機充能（已計入）', signed(result.totals.drone)]);
  if (roomType === 'DORMITORY') metrics.push(['全宿舍恢復（已計入）', signed(result.totals.moodRecoverAll, '/時')]);
  const incomplete = result.unsupported.length + result.uncertain.length;
  return <article className={`facility-card facility-${facility.type}`} aria-label={result.label}>
    <header className="facility-head">
      <div><h3>{result.label}</h3><p className="fine-print">{result.capacity ? `進駐 ${result.operators.length}／${result.capacity}` : '等級資料不足'}{room && ` · 電力 ${room.phases[facility.level - 1]?.electricity ?? '—'}`}</p></div>
      <button type="button" className="icon-button" aria-label={`移除${result.label}`} disabled={busy} onClick={onRemove}><Icon name="close" size={16}/></button>
    </header>
    <div className="facility-controls">
      <label><span>等級</span><select className="filter" value={facility.level} disabled={busy} onChange={event => onChange({ level: Number(event.currentTarget.value) })}>{(room?.phases ?? [{}]).map((_, index) => <option key={index} value={index + 1}>{index + 1} 級</option>)}</select></label>
      {facility.type === 'manufacturing' && <label><span>產品</span><select className="filter" value={facility.product ?? ''} disabled={busy} onChange={event => onChange({ product: event.currentTarget.value as Facility['product'] })}><option value="" disabled>選擇產品</option><option value="gold">{PRODUCT_LABEL.gold}</option><option value="record">{PRODUCT_LABEL.record}</option></select></label>}
    </div>
    {metrics.length > 0 && <dl className="facility-metrics">{metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}{(roomType === 'MANUFACTURE' || roomType === 'TRADING') && <div><dt>其中基礎</dt><dd>{signed(result.totals.basic)}</dd></div>}</dl>}
    {incomplete > 0 && <p className="facility-warning"><Icon name="alert" size={14}/>有 {incomplete} 個技能未計入或待核對，合計不完整。</p>}
    {result.issues.map(issue => <p key={issue} className="facility-issue">{issue}</p>)}
    <ul className="facility-slots">
      {result.operators.map(op => <li key={op.operatorId}>
        <div className="slot-head"><strong>{op.name}</strong><button type="button" className="button ghost small" disabled={busy} onClick={() => onUnassign(op.operatorId)} aria-label={`將${op.name}移出${result.label}`}>移出</button></div>
        <div className="slot-skills">{op.skills.filter(skill => skill.applies).map((skill, index) => {
          const shown = skill.active ?? skill.maybeUpgraded ?? skill.next?.skill;
          if (!shown) return null;
          const parsed = skill.active ? parseSkill(skill.active) : undefined;
          const offProduct = !!parsed?.supported && !parsed.effects.some(effect => productMatches(effect, facility));
          const tone = skill.state === 'locked' ? 'muted' : skill.state === 'unknown' ? 'amber' : offProduct ? 'muted' : parsed?.supported ? 'ok' : 'info';
          return <details key={index} className={`skill-chip ${tone}`}>
            <summary><span>{shown.name}</span><em>{skill.state === 'locked' ? `未解鎖（精英 ${skill.next?.elite}・等級 ${skill.next?.level}）` : skill.state === 'unknown' ? '解鎖待核對' : offProduct ? '不適用目前產品' : parsed?.supported ? parsed.effects.map(effectText).join('、') : '未計入'}</em></summary>
            <p>{shown.description}</p>
            {skill.maybeUpgraded && skill.active && <p className="fine-print">可能已升級為「{skill.maybeUpgraded.name}」：養成數值未知，暫以已確認版本計算。</p>}
          </details>;
        })}{!op.skills.some(skill => skill.applies) && <span className="fine-print">沒有{FACILITY_LABEL[facility.type]}技能{roomType === 'MANUFACTURE' || roomType === 'TRADING' ? '，只計基礎加成' : ''}</span>}</div>
      </li>)}
    </ul>
    {!full && <label className="facility-add"><span className="sr-only">加入幹員到{result.label}</span><select className="filter" value="" disabled={busy || !candidates.length} onChange={event => { const id = event.currentTarget.value; if (id) onAssign(id); }}>
      <option value="">{candidates.length ? '＋ 加入幹員' : '沒有可加入的幹員'}</option>
      {(['ready', 'unknown', 'none'] as const).map(group => {
        const items = candidates.filter(item => item.state === group);
        if (!items.length) return null;
        return <optgroup key={group} label={group === 'ready' ? '有已解鎖的此設施技能' : group === 'unknown' ? '技能解鎖待核對' : '沒有此設施技能'}>{items.map(item => <option key={item.operatorId} value={item.operatorId}>{item.name}{item.summary ? `｜${item.summary}` : ''}{item.score ? `（已計入 ${signed(item.score, '')}）` : ''}</option>)}</optgroup>;
      })}
    </select></label>}
    {(result.unsupported.length > 0 || result.notApplicable.length > 0) && <details className="plain-details facility-notes"><summary>未計入與不適用的技能（{result.unsupported.length + result.notApplicable.length}）</summary>
      <ul>{result.unsupported.map(item => <li key={`u-${item.operatorId}-${item.skill.id}`}><strong>{definitions.get(item.operatorId)?.displayName}・{item.skill.name}</strong>：條件型或聯動效果，尚未支援計算。<br/><span className="fine-print">{item.skill.description}</span></li>)}
        {result.notApplicable.map(item => <li key={`n-${item.operatorId}-${item.skill.id}`}><strong>{definitions.get(item.operatorId)?.displayName}・{item.skill.name}</strong>：不適用目前產品。</li>)}</ul>
    </details>}
  </article>;
}

export function BasePage({ state, isDemo, busy, onSave }: { state: AppState; isDemo: boolean; busy: boolean; onSave: (base: Base) => void }) {
  const [attempt, setAttempt] = useState(0);
  const { catalog, error } = useBaseCatalog(isDemo, attempt);
  const [draft, setDraft] = useState<Base>(state.settings.base);
  const [addType, setAddType] = useState<FacilityType>('manufacturing');
  const saved = JSON.stringify(state.settings.base);
  useEffect(() => { setDraft(state.settings.base); }, [saved]);
  const dirty = JSON.stringify(draft) !== saved;

  if (error) return <section className="panel planned"><span className="tag amber">需要基建資料</span><h2>還沒有可用的基建資料</h2><p>{error}</p><div className="inline-actions"><button type="button" className="button secondary" onClick={() => setAttempt(value => value + 1)}>重新讀取</button></div></section>;
  if (!catalog) return <p className="fine-print" role="status">正在讀取基建資料…</p>;

  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const evaluation = evaluateBase(draft, catalog, state.roster, definitions);
  const update = (next: Base) => setDraft(next);
  const patchFacility = (id: string, patch: Partial<Facility>) => update({ ...draft, facilities: draft.facilities.map(f => f.id === id ? { ...f, ...patch } : f) });
  const removeFacility = (id: string) => { const assignments = { ...(draft.assignments ?? {}) }; delete assignments[id]; update({ ...draft, facilities: draft.facilities.filter(f => f.id !== id), assignments }); };
  const assign = (id: string, operatorId: string) => update({ ...draft, assignments: { ...(draft.assignments ?? {}), [id]: [...(draft.assignments?.[id] ?? []), operatorId] } });
  const unassign = (id: string, operatorId: string) => update({ ...draft, assignments: { ...(draft.assignments ?? {}), [id]: (draft.assignments?.[id] ?? []).filter(item => item !== operatorId) } });
  const addFacility = (type: FacilityType, level = 1, product?: Facility['product']) => ({ id: newId(), type, level, ...(product ? { product } : {}) });
  const applyTemplate = (index: number) => {
    const facilities = TEMPLATES[index].layout.flatMap(([type, count, level, product]) => Array.from({ length: count }, () => addFacility(type, level, product)));
    update({ ...draft, facilities, assignments: {} });
  };
  const { produced, consumed } = evaluation.electricity;
  const unsupportedTotal = evaluation.facilities.reduce((sum, f) => sum + f.unsupported.length + f.uncertain.length, 0);

  return <div className="base-page">
    {isDemo && <p className="callout warning">示範庫使用自製的虛構基建技能與數值，只用來體驗操作，不代表遊戲規則。</p>}
    <div className="base-summary">
      <div className="stat"><span className="stat-value">{draft.facilities.length}</span><span className="stat-label">設施<small>最多 20 座</small></span></div>
      <div className={`stat ${consumed > produced ? 'danger' : ''}`}><span className="stat-value">{produced - consumed}</span><span className="stat-label">剩餘電力<small>發電 {produced} · 用電 {consumed}</small></span></div>
      <div className={`stat ${unsupportedTotal ? 'amber' : ''}`}><span className="stat-value">{unsupportedTotal}</span><span className="stat-label">未計入／待核對技能<small>不當作零效果</small></span></div>
      <div className="base-actions">
        <button type="button" className="button ghost small" disabled={busy || !dirty} onClick={() => setDraft(state.settings.base)}>還原</button>
        <button type="button" className="button primary" disabled={busy || !dirty || draft.facilities.length > 20} onClick={() => onSave(draft)}>{dirty ? '保存配置' : '已保存'}</button>
      </div>
    </div>
    {evaluation.issues.length > 0 && <div className="callout danger" role="status"><strong>配置有 {evaluation.issues.length} 個問題</strong><ul>{evaluation.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div>}
    {!draft.facilities.length && <section className="empty-inline base-empty"><strong>先建立設施配置</strong><span>選一個常見布局作為起點，或逐一新增設施；之後可以再調整等級與數量。</span>
      <div className="inline-actions center">{TEMPLATES.map((template, index) => <button type="button" key={template.label} className="button secondary small" disabled={busy} onClick={() => applyTemplate(index)}>{template.label}</button>)}</div>
    </section>}
    <div className="facility-grid">
      {evaluation.facilities.map(result => <FacilityCard key={result.facility.id} result={result} catalog={catalog} state={state} base={draft} busy={busy}
        onChange={patch => patchFacility(result.facility.id, patch)} onRemove={() => removeFacility(result.facility.id)}
        onAssign={id => assign(result.facility.id, id)} onUnassign={id => unassign(result.facility.id, id)}/>)}
    </div>
    <div className="base-add">
      <select className="filter" aria-label="新增設施種類" value={addType} disabled={busy} onChange={event => setAddType(event.currentTarget.value as FacilityType)}>{TYPES.map(type => <option key={type} value={type}>{FACILITY_LABEL[type]}</option>)}</select>
      <button type="button" className="button secondary" disabled={busy || draft.facilities.length >= 20} onClick={() => update({ ...draft, facilities: [...draft.facilities, addFacility(addType, 1, addType === 'manufacturing' ? 'gold' : undefined)] })}><Icon name="plus" size={16}/>新增設施</button>
      {draft.facilities.length > 0 && <details className="base-templates"><summary className="button ghost small">改用常見布局</summary><div className="inline-actions">{TEMPLATES.map((template, index) => <button type="button" key={template.label} className="button secondary small" disabled={busy} onClick={() => applyTemplate(index)}>{template.label}</button>)}</div><p className="fine-print">套用會取代目前的設施與進駐名單（保存前可按「還原」）。</p></details>}
    </div>
    <details className="panel plain-details base-method"><summary>計算方式與限制</summary>
      <ul className="gap-list">
        <li>設施等級、進駐上限、電力與座數上限取自 {catalog.source}（版本 {catalog.version.slice(0, 12)}）。</li>
        <li>製造站與貿易站每名進駐幹員的基礎加成取自資料表（目前各 {catalog.basicSpeedPercent.MANUFACTURE}%／{catalog.basicSpeedPercent.TRADING}%）。</li>
        <li>技能只計入說明文字完全符合固定句型者（例如「進駐製造站時，生產力+15%」）。依人數、設施數、時間累積、其他幹員或特殊資源變動的技能，一律列為「未計入」，不當作零。</li>
        <li>同設施多名幹員的已計入技能直接相加；說明寫「同種效果取最高」者只取最高值。是否與遊戲內完全一致尚未逐條實測。</li>
        <li>心情消耗與恢復只列出技能數值，不模擬輪班；尚無可追溯的心情公式，因此不提供換班時間與收益排行。</li>
        <li>解鎖依幹員的精英階段與等級；欄位未知時標為「解鎖待核對」，不推論為已解鎖。</li>
      </ul>
    </details>
  </div>;
}
