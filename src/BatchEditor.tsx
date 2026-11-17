import { useEffect, useRef, useState } from 'preact/hooks';
import { fieldKeys, type AppState, type Evidence, type OperatorDefinition } from './domain/model';
import { BATCH_FIELDS, createGridEdit, matchingModules, type BatchField, type GridChange } from './domain/batch-edit';
import { previewImport, type ImportPreview } from './domain/import';
import { queryRoster } from './domain/roster-query';

type Draft = { status: Evidence['status']; value: string };
type Drafts = Record<string, Record<string, Draft>>;
type FieldInfo = { label: string; options?: { value: string; label: string }[]; min?: number; max?: number; boolean?: boolean };
const basics = Object.entries(BATCH_FIELDS) as [BatchField, typeof BATCH_FIELDS[BatchField]][];
const numbers = (min: number, max: number, label = (n: number) => String(n)) => Array.from({ length: max - min + 1 }, (_, i) => ({ value: String(min + i), label: label(min + i) }));
const fromEvidence = (value?: Evidence): Draft => ({ status: value?.status ?? 'unknown', value: value?.status === 'known' ? String(value.value) : '' });
const pending = (value?: Evidence) => !value || value.status === 'unknown' || (value.status === 'known' && !value.manuallyConfirmed && value.confidence !== undefined && value.confidence < .8);
const isOriginal = (module: OperatorDefinition['modules'][number]) => module.type === 'original' || module.kind.toUpperCase() === 'ORIGINAL';
function fieldInfo(field: string, definition: OperatorDefinition): FieldInfo {
  if (Object.hasOwn(BATCH_FIELDS, field)) {
    const config = BATCH_FIELDS[field as BatchField];
    return { ...config, ...(field === 'level' || field === 'trust' ? {} : { options: numbers(config.min, config.max, n => field === 'elite' ? ['未精英化', '精英一', '精英二'][n] : String(n)) }) };
  }
  if (field === 'equippedSkill' || field === 'equippedModule') return { label: field === 'equippedSkill' ? '選用技能' : '裝備模組', options: [{ value: 'none', label: field === 'equippedSkill' ? '未選用' : '未裝備' }, ...(field === 'equippedSkill' ? definition.skills : definition.modules).map(item => ({ value: item.id, label: item.name }))] };
  const [kind, id] = field.split(':');
  if (kind === 'mastery') return { label: `${definition.skills.find(item => item.id === id)?.name ?? id}・專精`, options: numbers(0, 3, n => n ? `專精 ${n}` : '未專精') };
  const module = definition.modules.find(item => item.id === id);
  if (field === 'owned' || kind === 'moduleAvailable' || kind === 'moduleUnlocked') return { label: field === 'owned' ? '已持有' : `${module?.name ?? id}・${kind === 'moduleAvailable' ? '本服開放' : '解鎖'}`, boolean: true, options: [{ value: 'true', label: '是' }, { value: 'false', label: '否' }] };
  return { label: `${module?.name ?? id}・等級`, options: numbers(0, module && isOriginal(module) ? 0 : 3, n => n ? `等級 ${n}` : '0（未升級）') };
}
function textValue(value: Draft, info: FieldInfo): string {
  if (value.status === 'unknown') return '未知';
  if (value.status === 'not-applicable') return '不適用';
  return info.options?.find(item => item.value === value.value)?.label ?? value.value;
}
function convert(draft: Draft, info: FieldInfo): GridChange {
  if (draft.status !== 'known') return { status: draft.status };
  if (!draft.value.trim()) throw new Error(`請填寫${info.label}，或明確設為未知。`);
  return { status: 'known', value: info.boolean ? draft.value === 'true' : info.min !== undefined || info.options?.every(item => /^\d+$/.test(item.value)) ? Number(draft.value) : draft.value };
}
function FieldControl({ value, info, label, busy, onChange }: { value: Draft; info: FieldInfo; label: string; busy: boolean; onChange: (value: Draft) => void }) {
  if (info.options) return <select className="filter" aria-label={label} disabled={busy} value={value.status === 'known' ? value.value : `__${value.status}`} onChange={event => { const next = event.currentTarget.value; onChange(next.startsWith('__') ? { status: next.slice(2) as Draft['status'], value: '' } : { status: 'known', value: next }); }}>
    <option value="" disabled>選擇新值</option><option value="__unknown">未知</option><option value="__not-applicable">不適用</option>{info.options.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
  </select>;
  return <div className="batch-number-control"><input className="text-input" type="number" inputMode="numeric" aria-label={label} min={info.min} max={info.max} step="1" placeholder={value.status === 'not-applicable' ? '不適用' : `未知 · ${info.min}–${info.max}`} disabled={busy} value={value.status === 'known' ? value.value : ''} onInput={event => onChange({ status: 'known', value: event.currentTarget.value })}/><select className="filter batch-value-status" aria-label={`${label}資料狀態`} value={value.status} disabled={busy} onChange={event => onChange({ status: event.currentTarget.value as Draft['status'], value: value.value })}><option value="known">已知</option><option value="unknown">未知</option><option value="not-applicable">不適用</option></select></div>;
}

export function BatchEditor({ state, initialId, onInitialHandled, onSave }: { state: AppState; initialId: string | null; onInitialHandled: () => void; onSave: (preview: ImportPreview) => Promise<void> }) {
  const [search, setSearch] = useState('');
  const [profession, setProfession] = useState('all');
  const [group, setGroup] = useState('all');
  const [onlyPending, setOnlyPending] = useState(true);
  const [selected, setSelected] = useState<string[]>(initialId ? [initialId] : []);
  const [page, setPage] = useState(0);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [bulk, setBulk] = useState<Partial<Record<BatchField, Draft>>>({});
  const [masteries, setMasteries] = useState<Record<string, string>>({});
  const [moduleKind, setModuleKind] = useState('X');
  const [moduleUnlocked, setModuleUnlocked] = useState('keep');
  const [moduleLevel, setModuleLevel] = useState('keep');
  const [moduleEquipped, setModuleEquipped] = useState('keep');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const previewRef = useRef<HTMLElement>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const definitions = new Map(state.dataset.operators.map(item => [item.id, item]));
  const rows = state.roster.map(row => ({ row, definition: definitions.get(row.operatorId)! }));
  const selectedSet = new Set(selected);
  const matched = queryRoster(rows, { search, profession, sort: 'name' });
  // 只看待確認時，隱藏此分類已無待確認欄位的角色；已勾選或有草稿的角色一律保留。
  const filtered = onlyPending ? matched.filter(({ row, definition }) => selectedSet.has(row.operatorId) || drafts[row.operatorId] || fieldsFor(definition).some(field => pending(row.fields[field]))) : matched;
  const hiddenComplete = matched.length - filtered.length;
  const pages = Math.max(1, Math.ceil(filtered.length / 12)), currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * 12, (currentPage + 1) * 12);
  const changedIds = selected.filter(id => Object.keys(drafts[id] ?? {}).length > 0);
  const changedCount = changedIds.reduce((count, id) => count + Object.keys(drafts[id]).length, 0);
  const hiddenSelected = selected.filter(id => !filtered.some(item => item.row.operatorId === id)).length;
  const usesModule = [moduleUnlocked, moduleLevel, moduleEquipped].some(value => value !== 'keep');
  const invalidModules = usesModule ? rows.filter(item => selectedSet.has(item.row.operatorId) && matchingModules(item.definition, moduleKind).length !== 1) : [];
  const latestRevision = useRef(state.revision);
  latestRevision.current = state.revision;
  useEffect(() => { setPreview(null); setAgreed(false); }, [state.revision]);
  useEffect(() => { if (initialId) { setSelected(current => current.includes(initialId) ? current : [...current, initialId]); onInitialHandled(); } }, [initialId]);
  useEffect(() => { if (preview) { previewRef.current?.focus(); previewRef.current?.scrollIntoView({ block: 'start' }); } }, [preview]);
  useEffect(() => { if (message) { messageRef.current?.focus(); messageRef.current?.scrollIntoView({ block: 'center' }); } }, [message]);
  useEffect(() => {
    if (!changedCount) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [changedCount]);
  function invalidate() { setPreview(null); setAgreed(false); setMessage(''); }
  function choose(ids: string[]) {
    invalidate(); setSelected(ids);
    setDrafts(current => Object.fromEntries(Object.entries(current).filter(([id]) => ids.includes(id))));
  }
  function edit(operatorId: string, field: string, value: Draft) {
    invalidate(); setSelected(current => current.includes(operatorId) ? current : [...current, operatorId]);
    setDrafts(current => ({ ...current, [operatorId]: { ...current[operatorId], [field]: value } }));
  }
  function resetField(operatorId: string, field: string) {
    invalidate(); setDrafts(current => { const next = { ...current, [operatorId]: { ...current[operatorId] } }; delete next[operatorId][field]; return next; });
  }
  function applyBulk() {
    invalidate();
    try {
      if (!selected.length) throw new Error('先勾選要修改的角色。');
      if (!Object.keys(bulk).length && !Object.values(masteries).some(value => value !== 'keep') && !usesModule) throw new Error('請選擇至少一個批次欄位。');
      if (invalidModules.length) throw new Error(`沒有唯一對應的 ${moduleKind} 類模組：${invalidModules.map(item => item.definition.displayName).join('、')}。請調整勾選。`);
      const next: Drafts = structuredClone(drafts);
      for (const id of selected) {
        const definition = definitions.get(id)!;
        next[id] = { ...next[id] };
        for (const [field, draft] of Object.entries(bulk)) { convert(draft, fieldInfo(field, definition)); next[id][field] = { ...draft }; }
        for (const [slot, value] of Object.entries(masteries)) if (value !== 'keep') {
          const skill = definition.skills[Number(slot)];
          if (!skill) throw new Error(`${definition.displayName}沒有第 ${Number(slot) + 1} 技能，請調整勾選。`);
          next[id][`mastery:${skill.id}`] = value === 'unknown' ? { status: 'unknown', value: '' } : { status: 'known', value };
        }
        if (usesModule) {
          const module = matchingModules(definition, moduleKind)[0];
          if (moduleUnlocked !== 'keep') next[id][`moduleUnlocked:${module.id}`] = moduleUnlocked === 'unknown' ? { status: 'unknown', value: '' } : { status: 'known', value: moduleUnlocked };
          if (moduleLevel !== 'keep') next[id][`moduleLevel:${module.id}`] = moduleLevel === 'unknown' ? { status: 'unknown', value: '' } : { status: 'known', value: moduleLevel };
          if (moduleEquipped !== 'keep') next[id].equippedModule = moduleEquipped === 'unknown' ? { status: 'unknown', value: '' } : { status: 'known', value: moduleEquipped === 'none' ? 'none' : module.id };
        }
      }
      setDrafts(next); setMessage(`已填入 ${selected.length} 名角色的草稿，尚未保存。可直接在右側微調，再預覽全部變更。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : '無法套用批次欄位。'); }
  }
  async function prepare() {
    setBusy(true); setMessage('');
    try {
      const changes = Object.fromEntries(changedIds.map(id => [id, Object.fromEntries(Object.entries(drafts[id]).map(([field, draft]) => [field, convert(draft, fieldInfo(field, definitions.get(id)!))]))]));
      const base = state.revision, next = await previewImport(state, createGridEdit(state, changes));
      // 預覽期間若其他操作已保存，捨棄這份過期預覽，避免保存時才被拒絕。
      if (latestRevision.current !== base) { setMessage('資料已在預覽期間更新，請重新預覽。'); return; }
      setPreview(next); setAgreed(false);
    } catch (error) { setPreview(null); setMessage(error instanceof Error ? error.message : '無法產生預覽。'); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!preview || !agreed || busy) return;
    setBusy(true); setMessage('');
    try { await onSave(preview); setPreview(null); setAgreed(false); setDrafts({}); setSelected([]); setMessage('修正已保存。可到設定撤銷最後一次匯入。'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '保存失敗，草稿保留。'); }
    finally { setBusy(false); }
  }
  function fieldsFor(definition: OperatorDefinition): string[] {
    return fieldKeys(definition).filter(field => {
      if (field === 'equippedModule' && !definition.modules.length) return false;
      if (field.startsWith('module') && definition.modules.some(module => isOriginal(module) && field.endsWith(`:${module.id}`))) return false;
      if (group === 'all') return true;
      if (group === 'basic') return Object.hasOwn(BATCH_FIELDS, field);
      if (group === 'skills') return field === 'skillLevel' || field === 'equippedSkill' || field.startsWith('mastery:');
      return field === 'equippedModule' || field.startsWith('module');
    });
  }
  return <section className="batch-editor" aria-label="批次修正幹員">
    <section className="panel batch-bulk" aria-label="批次填入欄位">
      <details><summary>批次填入 · 已選 {selected.length} 名角色<span className="fine-print">　可一次填多個欄位</span></summary>
        <p className="fine-print">勾選欄位並設定新值，按「套用到勾選角色」。會更新這些角色的同名草稿欄位，其他欄位保留。</p>
        <div className="batch-fields">{basics.map(([field, config]) => <div className="batch-field" key={field}>
          <label className="checkbox-line"><input type="checkbox" checked={!!bulk[field]} disabled={busy} onChange={event => { const checked = event.currentTarget.checked; setBulk(current => { const next = { ...current }; if (checked) next[field] = { status: 'known', value: '' }; else delete next[field]; return next; }); }}/><span>批次{config.label}</span></label>
          {bulk[field] ? <FieldControl label={`批次${config.label}新值`} info={fieldInfo(field, state.dataset.operators[0] ?? {} as OperatorDefinition)} value={bulk[field]} busy={busy} onChange={draft => setBulk(current => ({ ...current, [field]: draft }))}/> : <span className="fine-print">不修改</span>}
        </div>)}</div>
        <details className="plain-details"><summary>技能專精</summary><div className="batch-fields">{[0, 1, 2].map(slot => <label className="batch-field" key={slot}><span>第 {slot + 1} 技能專精</span><select className="filter" aria-label={`批次第${slot + 1}技能專精`} value={masteries[slot] ?? 'keep'} disabled={busy} onChange={event => setMasteries(current => ({ ...current, [slot]: event.currentTarget.value }))}><option value="keep">不修改</option><option value="unknown">未知</option>{numbers(0, 3).map(item => <option key={item.value} value={item.value}>{item.value === '0' ? '未專精' : `專精 ${item.value}`}</option>)}</select></label>)}</div><p className="fine-print">依此角色的技能順序對應；缺少該技能會阻擋。最終預覽會列出實際技能名稱。</p></details>
        <details className="plain-details"><summary>模組解鎖、等級與裝備</summary>
          <div className="batch-fields">
            <label className="batch-field"><span>模組類型</span><select className="filter" aria-label="批次模組類型" value={moduleKind} disabled={busy} onChange={event => setModuleKind(event.currentTarget.value)}>{['X', 'Y', 'D', 'A', 'B'].map(kind => <option key={kind} value={kind}>{kind} 類模組</option>)}</select></label>
            <label className="batch-field"><span>解鎖</span><select className="filter" aria-label="批次模組解鎖狀態" value={moduleUnlocked} disabled={busy} onChange={event => setModuleUnlocked(event.currentTarget.value)}><option value="keep">不修改</option><option value="true">已解鎖</option><option value="false">未解鎖</option><option value="unknown">未知</option></select></label>
            <label className="batch-field"><span>等級</span><select className="filter" aria-label="批次模組等級" value={moduleLevel} disabled={busy} onChange={event => setModuleLevel(event.currentTarget.value)}><option value="keep">不修改</option><option value="unknown">未知</option>{numbers(0, 3).map(item => <option key={item.value} value={item.value}>{item.value} 級</option>)}</select></label>
            <label className="batch-field"><span>裝備</span><select className="filter" aria-label="批次模組裝備狀態" value={moduleEquipped} disabled={busy} onChange={event => setModuleEquipped(event.currentTarget.value)}><option value="keep">不修改</option><option value="selected">裝備此類型</option><option value="none">全部未裝備</option><option value="unknown">未知</option></select></label>
          </div>
          {invalidModules.length > 0 && <div className="warning-note">沒有唯一對應的 {moduleKind} 類模組：{invalidModules.map(item => item.definition.displayName).join('、')}。<button type="button" className="button ghost small" disabled={busy} onClick={() => choose(selected.filter(id => !invalidModules.some(item => item.row.operatorId === id)))}>取消勾選這 {invalidModules.length} 名</button></div>}
        </details>
        <button type="button" className="button primary" disabled={busy || !selected.length} onClick={applyBulk}>套用到勾選角色（{selected.length} 名）</button>
      </details>
    </section>
    {message && <p ref={messageRef} tabIndex={-1} className="toast" role="status">{message}</p>}
    {preview && <section ref={previewRef} tabIndex={-1} className="panel batch-preview" aria-label="批次修正預覽"><h3>核對本次變更（{preview.input.candidates.length} 名）</h3><p>尚未寫入。以下列出每位角色的欄位與新值；其餘資料保持原值。</p>
      <div className="batch-diff-list">{preview.input.candidates.map(candidate => { const definition = definitions.get(candidate.operatorId)!; return <article className="batch-diff" key={candidate.operatorId}><h4>{definition.displayName}</h4>{Object.entries(candidate.fields).map(([field, incoming]) => { const info = fieldInfo(field, definition); return <p key={field}>{info.label}：<span>{textValue(fromEvidence(state.roster.find(row => row.operatorId === candidate.operatorId)?.fields[field]), info)}</span> → <strong>{textValue(fromEvidence(incoming), info)}</strong></p>; })}</article>; })}</div>
      <label className="checkbox-line"><input type="checkbox" disabled={busy} checked={agreed} onChange={event => setAgreed(event.currentTarget.checked)}/><span>我已核對以上 {preview.input.candidates.length} 名角色與欄位，確認保存。</span></label>
      <div className="inline-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => { setPreview(null); setAgreed(false); }}>返回修改</button><button type="button" className="button primary" disabled={busy || !agreed} onClick={() => void save()}>{busy ? '保存中…' : '確認保存'}</button></div>
    </section>}
    <section className="panel batch-grid-panel" aria-label="角色與待確認欄位">
      <div className="batch-filters"><input type="search" className="text-input" aria-label="搜尋批次修正幹員" placeholder="搜尋角色名稱、別名或 ID" value={search} disabled={busy} onInput={event => { setSearch(event.currentTarget.value); setPage(0); }}/><select className="filter" aria-label="批次修正職業篩選" value={profession} disabled={busy} onChange={event => { setProfession(event.currentTarget.value); setPage(0); }}><option value="all">所有職業</option>{[...new Set(rows.map(item => item.definition.profession))].sort().map(name => <option key={name} value={name}>{name}</option>)}</select><select className="filter" aria-label="顯示欄位分類" value={group} disabled={busy} onChange={event => setGroup(event.currentTarget.value)}><option value="all">全部欄位</option><option value="basic">養成欄位</option><option value="skills">技能與專精</option><option value="modules">模組欄位</option></select></div>
      <div className="inline-actions"><button type="button" className="button secondary small" disabled={busy || !filtered.length} onClick={() => choose([...new Set([...selected, ...filtered.map(item => item.row.operatorId)])])}>全選篩選結果（{filtered.length} 名）</button><button type="button" className="button ghost small" disabled={busy || !selected.length} onClick={() => choose([])}>取消全選與草稿</button><strong>已選 {selected.length} 名{hiddenSelected > 0 && `（篩選外 ${hiddenSelected} 名）`}</strong><label className="checkbox-line"><input type="checkbox" checked={onlyPending} disabled={busy} onChange={event => setOnlyPending(event.currentTarget.checked)}/><span>只顯示待確認欄位</span></label></div>
      <p className="fine-print">待確認包含未知及低信心匯入值；不代表資料有錯。編輯欄位會自動勾選角色。取消勾選會移除該角色草稿，搜尋與翻頁則保留。</p>
      {visible.length > 0 && <div className="batch-grid-head"><span>角色</span><span>{onlyPending ? '待確認欄位 · 直接修改' : '全部欄位 · 直接修改'}</span></div>}
      <div className="batch-roster">{visible.map(({ row, definition }) => {
        const rowDrafts = drafts[row.operatorId] ?? {}, allFields = fieldsFor(definition);
        const shown = allFields.filter(field => !onlyPending || pending(row.fields[field]) || rowDrafts[field]);
        const moduleMessage = group !== 'modules' && group !== 'all' ? null : !definition.modules.length ? '沒有模組資料。' : definition.modules.every(isOriginal) ? '只有原始證章，沒有可升級模組資料。' : null;
        return <article className={`batch-grid-row ${selectedSet.has(row.operatorId) ? 'is-selected' : ''}`} key={row.operatorId} aria-label={`${definition.displayName}欄位修正`}>
          <label className="batch-identity"><input type="checkbox" aria-label={`選取${definition.displayName}（${definition.profession}）`} disabled={busy} checked={selectedSet.has(row.operatorId)} onChange={event => choose(event.currentTarget.checked ? [...selected, row.operatorId] : selected.filter(id => id !== row.operatorId))}/><span><strong>{definition.displayName}</strong><small>{definition.profession} · {definition.rarity} 星</small><small>{allFields.filter(field => pending(row.fields[field])).length} 欄待確認{Object.keys(rowDrafts).length > 0 && ` · ${Object.keys(rowDrafts).length} 欄已修改`}</small></span></label>
          <div className="batch-cells">{moduleMessage && <p className="fine-print" style={{ gridColumn: '1 / -1', margin: 0 }}>{moduleMessage}</p>}{shown.map(field => {
            const info = fieldInfo(field, definition), evidence = row.fields[field], draft = rowDrafts[field], value = draft ?? fromEvidence(evidence), label = `${definition.displayName}・${info.label}`;
            return <div key={field} className={`batch-cell ${draft ? 'is-dirty' : pending(evidence) ? 'is-pending' : ''}`}>
              <div className="batch-cell-heading"><strong>{info.label}</strong><small>{draft ? '未保存' : evidence?.status === 'unknown' || !evidence ? '未知' : pending(evidence) ? '待確認' : '已知'}</small></div>
              <FieldControl label={label} info={info} value={value} busy={busy} onChange={next => edit(row.operatorId, field, next)}/>
              <div className="batch-cell-footer"><span>原：{textValue(fromEvidence(evidence), info)}</span>{draft ? <button type="button" disabled={busy} onClick={() => resetField(row.operatorId, field)} aria-label={`還原${label}`}>還原</button> : evidence?.status === 'known' && pending(evidence) ? <button type="button" disabled={busy} onClick={() => edit(row.operatorId, field, fromEvidence(evidence))} aria-label={`確認${label}原值`}>確認</button> : null}</div>
            </div>;
          })}{!shown.length && (allFields.length > 0 || !moduleMessage) && <p className="fine-print">{onlyPending && allFields.length > 0 ? '此分類沒有待確認欄位。取消「只顯示待確認欄位」即可修改既有值。' : '此分類沒有可編輯欄位。'}</p>}</div>
        </article>;
      })}</div>
      {hiddenComplete > 0 && <p className="fine-print batch-hidden-note">另有 {hiddenComplete} 名角色在此分類沒有待確認欄位，已隱藏。取消「只顯示待確認欄位」即可修改既有值。</p>}
      {!filtered.length && !hiddenComplete && <p>沒有符合條件的角色。</p>}
      {pages > 1 && <nav className="roster-pagination" aria-label="批次修正分頁"><span>第 {currentPage + 1} / {pages} 頁 · 勾選與草稿跨頁保留</span><div className="inline-actions"><button type="button" className="button secondary small" disabled={busy || currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一頁</button><button type="button" className="button secondary small" disabled={busy || currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>下一頁</button></div></nav>}
    </section>
    {changedCount > 0 && <aside className="batch-savebar" aria-label="草稿保存工具列"><span><strong>{changedIds.length} 名角色 · {changedCount} 個欄位</strong><small>草稿尚未保存</small></span><div className="inline-actions"><button type="button" className="button ghost small" disabled={busy} onClick={() => { invalidate(); setDrafts({}); }}>清空草稿</button><button type="button" className="button primary" disabled={busy} onClick={() => void prepare()}>{busy ? '處理中…' : '預覽全部變更'}</button></div></aside>}
  </section>;
}
