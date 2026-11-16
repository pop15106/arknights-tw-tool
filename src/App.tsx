import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { createEmptyState, fieldKeys, MAX_BACKUP_BYTES, MAX_IMPORT_BYTES, unknown } from './domain/model';
import type { AppState, Evidence, FieldConflict, ImportDocument, Namespace, OperatorDefinition } from './domain/model';
import { applyImport, previewImport, undoLastImport } from './domain/import';
import type { ImportPreview } from './domain/import';
import { createBackup, parseBackup } from './storage/backup';
import { describeCapacity, measureCapacity } from './storage/capacity';
import { loadState, openDatabase, queryPersistence, requestPersistence, saveState } from './storage/database';
import { createDemoDataset, createDemoImport, createPersonalDataset } from './demo';
import { ScreenshotReview } from './ScreenshotReview';
import { prepareLocalImportText } from './importers/local-file';
import { GameDataSettings, OperatorEncyclopedia, OperatorPortrait } from './OperatorEncyclopedia';
import { queryRoster, missingCount, unverifiedCount } from './domain/roster-query';
import type { RosterQuery } from './domain/roster-query';
import { ReferenceDetails } from './ReferenceDetails';
import { BatchEditor } from './BatchEditor';
import './styles.css';

type Page = '批次修正' | '幹員庫' | '基建' | '養成' | '搭配' | '設定';
type Panel = 'import' | 'preview' | 'detail' | 'restore' | 'switch' | null;
type IconName = 'roster' | 'base' | 'grow' | 'link' | 'settings' | 'plus' | 'download' | 'search' | 'shield' | 'file' | 'image' | 'film' | 'arrow';
const NAV: { label: Page; icon: IconName }[] = [
  { label: '幹員庫', icon: 'roster' }, { label: '批次修正', icon: 'file' }, { label: '基建', icon: 'base' }, { label: '養成', icon: 'grow' },
  { label: '搭配', icon: 'link' }, { label: '設定', icon: 'settings' },
];
const GATES = [
  ['G0', '使用權', '第三方用途與程式庫授權尚未通過查核。'],
  ['G1', '產品與繁中服', '公開程式線索不能證明現行本作繁中角色相容。'],
  ['G2', '安全登入與撤銷', '未驗證 iPhone 官方授權、到期、拒絕與解除連結。'],
  ['G3', '完整幹員庫', '未取得可核對持有總數的完整帳號回應。'],
  ['G4', '養成欄位', '專精、模組及其他欄位尚無本服實測樣本。'],
  ['G5', '副作用與穩定性', '未測試遊戲連線影響、更新頻率、錯誤與限流。'],
];

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ComponentChildren> = {
    roster: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    base: <><path d="M3 21V9l9-6 9 6v12M8 21v-7h8v7M3 10h18"/><path d="M8 7v3m8-3v3"/></>,
    grow: <><path d="M4 20h16M6 16v-4m6 4V8m6 8V4M5 8l6-5 5 2"/></>,
    link: <><path d="m9 15 6-6M8 17l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 7l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(0 -1) scale(.95)"/></>,
    settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor"/><circle cx="16" cy="17" r="3" fill="currentColor"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/></>,
    search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></>,
    file: <><path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8m-8 4h6"/></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="1"/><circle cx="8" cy="8" r="1"/><path d="m3 17 6-6 4 4 3-3 5 5"/></>,
    film: <><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M7 3v18m10-18v18M3 8h4m-4 8h4M17 8h4m-4 8h4m-10-7 4 3-4 3Z"/></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function formatDate(value?: string): string {
  if (!value) return '尚無紀錄';
  return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Taipei' }).format(new Date(value));
}

function valueText(evidence?: Evidence, field?: string, definition?: OperatorDefinition): string {
  if (!evidence || evidence.status === 'unknown') return '未知';
  if (evidence.status === 'not-applicable') return '不適用';
  if (typeof evidence.value === 'boolean') return evidence.value ? '是' : '否';
  if (evidence.value === 'none') return field === 'equippedSkill' ? '未選用' : '未裝備';
  if (field === 'equippedSkill') return definition?.skills.find(s => s.id === evidence.value)?.name ?? String(evidence.value);
  if (field === 'equippedModule') return definition?.modules.find(m => m.id === evidence.value)?.name ?? String(evidence.value);
  return String(evidence.value);
}

function fieldLabel(field: string, definition?: OperatorDefinition): string {
  const basic: Record<string, string> = { owned: '已持有', elite: '精英階段', level: '等級', potential: '潛能', trust: '信賴', skillLevel: '技能等級', equippedSkill: '選用技能', equippedModule: '裝備模組' };
  if (basic[field]) return basic[field];
  const [type, id] = field.split(':');
  if (type === 'mastery') return `${definition?.skills.find(s => s.id === id)?.name ?? id}・專精`;
  const moduleName = definition?.modules.find(m => m.id === id)?.name ?? id;
  return `${moduleName}・${type === 'moduleAvailable' ? '本服開放' : type === 'moduleUnlocked' ? '已解鎖' : '等級'}`;
}

function isNewSourceConflict(conflict: FieldConflict): boolean {
  return conflict.current.status === 'unknown' && !conflict.current.manuallyConfirmed &&
    conflict.incoming.status === 'known' && !conflict.incoming.manuallyConfirmed &&
    conflict.incoming.confidence !== undefined && conflict.incoming.confidence < 0.8 &&
    conflict.reasons.length === 1 && conflict.reasons[0] === '來源信心較低，須人工確認';
}

function friendlyError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return '本機儲存空間不足，本次變更沒有保存。請先下載備份，再釋出空間後重試。';
  if (error instanceof Error && /revision|另一|修訂|並行|過期|stale|concurrent/i.test(error.message)) return `${error.message} 請重新整理以讀取最新資料，再重新預覽。`;
  return error instanceof Error ? error.message : '操作未完成，原資料未修改。請重試或先下載備份。';
}

function Modal({ title, eyebrow, onClose, children, footer }: { title: string; eyebrow: string; onClose: () => void; children: ComponentChildren; footer?: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="modal-backdrop">
    <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1} onKeyDown={(event) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]') ?? []).filter(node => node.offsetParent !== null);
      if (!nodes.length) { event.preventDefault(); return; }
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus(); }
    }}>
      <div className="modal-header"><div><div className="eyebrow">{eyebrow}</div><h2 id="modal-title">{title}</h2></div><button className="close-button" aria-label="關閉視窗" onClick={onClose}>×</button></div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-footer">{footer}</div>}
    </div>
  </div>;
}

function FieldEditor({ field, evidence, definition, busy, onPreview }: { field: string; evidence: Evidence; definition: OperatorDefinition; busy: boolean; onPreview: (field: string, evidence: Evidence) => void }) {
  const [status, setStatus] = useState<Evidence['status']>(evidence.status);
  const [value, setValue] = useState(evidence.status === 'known' ? String(evidence.value) : '');
  const isBoolean = field === 'owned' || field.startsWith('moduleUnlocked:') || field.startsWith('moduleAvailable:');
  const items = field === 'equippedSkill' ? definition.skills : field === 'equippedModule' ? definition.modules : null;
  const moduleMessage = field !== 'equippedModule' ? null : !definition.modules.length ? '沒有模組資料。' : definition.modules.every(module => module.type === 'original' || module.kind.toUpperCase() === 'ORIGINAL') ? '只有原始證章，沒有可升級模組資料。' : null;
  const ranges: Record<string, [number, number]> = { elite: [0, 2], level: [1, 90], potential: [1, 6], trust: [0, 200], skillLevel: [1, 7] };
  const range = ranges[field] ?? [0, 3];
  return <div className="evidence-field">
    <div className="evidence-heading"><strong>{fieldLabel(field, definition)}</strong><span className={`tag ${evidence.status === 'unknown' ? 'amber' : ''}`}>{valueText(evidence, field, definition)}</span></div>
    {moduleMessage && <p className="fine-print">{moduleMessage}</p>}
    <div className="evidence-meta">來源：{evidence.source}<br/>資料時間：{formatDate(evidence.observedAt)} ／ 匯入：{formatDate(evidence.importedAt)}<br/>
      {evidence.manuallyConfirmed ? '已人工確認' : '未經人工確認'}{evidence.confidence !== undefined && ` ／ 來源信心分數 ${evidence.confidence}（非正確機率）`}
      {evidence.locator && <><br/>素材位置：{evidence.locator.assetId}{evidence.locator.frameMs !== undefined && `，${evidence.locator.frameMs} 毫秒`} ／ 本原型未提供原檔檢視</>}
      {!evidence.locator && <><br/>沒有原圖或影片證據；本次不保存媒體原檔。</>}
    </div>
    <form className="evidence-edit" onSubmit={(event) => {
      event.preventDefault();
      const meta = { source: '使用者在本機手動更正', importedAt: new Date().toISOString(), observedAt: new Date().toISOString(), manuallyConfirmed: true };
      const next: Evidence = status === 'known' ? { ...meta, status, value: isBoolean ? value === 'true' : items ? value : Number(value) } : { ...meta, status };
      onPreview(field, next);
    }}>
      <select aria-label={`${fieldLabel(field, definition)}狀態`} className="filter" value={status} disabled={busy} onChange={event => setStatus(event.currentTarget.value as Evidence['status'])}>
        <option value="known">已知</option><option value="unknown">未知</option><option value="not-applicable">不適用</option>
      </select>
      {status === 'known' && (isBoolean ? <select className="filter" required aria-label={`${fieldLabel(field, definition)}新值`} value={value} disabled={busy} onChange={event => setValue(event.currentTarget.value)}><option value="">選擇狀態</option><option value="true">是</option><option value="false">否</option></select>
        : items ? <select className="filter" required aria-label={`${fieldLabel(field, definition)}新值`} value={value} disabled={busy} onChange={event => setValue(event.currentTarget.value)}><option value="">選擇項目</option><option value="none">{field === 'equippedSkill' ? '未選用' : '未裝備'}</option>{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        : <input type="number" required min={range[0]} max={range[1]} step="1" inputMode="numeric" aria-label={`${fieldLabel(field, definition)}新值`} value={value} disabled={busy} onInput={event => setValue(event.currentTarget.value)}/>)}
      <button className="button secondary small" type="submit" aria-label={`預覽修正${fieldLabel(field, definition)}`} disabled={busy}>預覽修正</button>
    </form>
  </div>;
}

function ResearchGates() {
  return <div className="gate-list">{GATES.map(([code, title, description]) => <div className="gate-row" key={code}><span>{code}</span><div><strong>{title}</strong><p>{description}</p></div><span className="tag amber">未通過</span></div>)}</div>;
}

export default function App() {
  const [namespace, setNamespace] = useState<Namespace>(window.location.hash === '#personal' ? 'personal' : 'demo');
  const [state, setState] = useState<AppState | null>(null);
  const [initError, setInitError] = useState('');
  const [page, setPage] = useState<Page>('幹員庫');
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [search, setSearch] = useState('');
  const [profession, setProfession] = useState('all');
  const [rarity, setRarity] = useState<NonNullable<RosterQuery['rarity']>>('all');
  const [elite, setElite] = useState<NonNullable<RosterQuery['elite']>>('all');
  const [dataStatus, setDataStatus] = useState<NonNullable<RosterQuery['status']>>('all');
  const [sort, setSort] = useState<NonNullable<RosterQuery['sort']>>('id');
  const [rosterPage, setRosterPage] = useState(0);
  const rosterHeading = useRef<HTMLHeadingElement>(null);
  const [importText, setImportText] = useState('');
  const [confirmedTw, setConfirmedTw] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [candidateSearch, setCandidateSearch] = useState('');
  const [previewDetailId, setPreviewDetailId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, 'keep' | 'incoming'>>({});
  const [sourceAcceptedIds, setSourceAcceptedIds] = useState<string[]>([]);
  const [batchSourceAgreed, setBatchSourceAgreed] = useState(false);
  const [newDataPage, setNewDataPage] = useState(0);
  const [conflictPage, setConflictPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [batchInitialId, setBatchInitialId] = useState<string | null>(null);
  const [restored, setRestored] = useState<{ state: AppState; baseRevision: number } | null>(null);
  const [restoreAgreed, setRestoreAgreed] = useState(false);
  const [persistence, setPersistence] = useState<Awaited<ReturnType<typeof queryPersistence>> | null>(null);
  const database = useRef<IDBDatabase | null>(null);
  const operation = useRef(false);
  const modalOpen = panel !== null;

  useEffect(() => {
    if (!modalOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [modalOpen]);

  useEffect(() => {
    let active = true;
    let opened: IDBDatabase | null = null;
    setState(null); setInitError(''); setNotice(null); setPanel(null); setPreview(null); setRestored(null);
    setSearch(''); setProfession('all'); setRarity('all'); setElite('all'); setDataStatus('all'); setSort('id'); setRosterPage(0); setCandidateSearch(''); setPreviewDetailId(null);
    setConfirmedTw(false); setSourceAcceptedIds([]); setBatchSourceAgreed(false); setNewDataPage(0); setConflictPage(0);
    void (async () => {
      try {
        opened = await openDatabase(`arknights-tw-roster-${namespace}`);
        const current = await loadState(opened);
        const initial = current ?? createEmptyState(await (namespace === 'demo' ? createDemoDataset() : createPersonalDataset()));
        if (initial.dataset.metadata.namespace !== namespace) throw new Error('資料庫命名空間不符，已停止寫入。請保留資料並回報問題。');
        if (!active) { opened.close(); return; }
        if (!current) await saveState(opened, initial, -1);
        if (!active) { opened.close(); return; }
        database.current = opened; setState(initial);
        void queryPersistence().then(result => { if (active) setPersistence(result); }).catch(() => { if (active) setPersistence(null); });
      } catch (error) { if (active) setInitError(friendlyError(error)); opened?.close(); }
    })();
    return () => { active = false; opened?.close(); database.current = null; };
  }, [namespace]);

  async function run(action: () => Promise<void>) {
    if (operation.current || !state || !database.current) return;
    operation.current = true; setBusy(true); setNotice(null);
    try { await action(); }
    catch (error) { setNotice({ text: friendlyError(error), error: true }); }
    finally { operation.current = false; setBusy(false); }
  }

  async function persist(next: AppState, baseRevision: number) {
    if (!database.current) throw new Error('儲存尚未就緒，沒有修改資料。');
    await saveState(database.current, next, baseRevision);
    setState(next);
  }

  function closePanel() {
    if (busy) return;
    setPanel(null); setPreview(null); setRestored(null); setRestoreAgreed(false); setNotice(null);
    setCandidateSearch(''); setPreviewDetailId(null);
    setSourceAcceptedIds([]); setBatchSourceAgreed(false); setConfirmedTw(false);
  }

  async function prepareImport(input: ImportDocument) {
    if (!state) return;
    const nextPreview = await previewImport(state, input);
    setCandidateSearch(''); setPreviewDetailId(null);
    setPreview(nextPreview); setDecisions({}); setSourceAcceptedIds([]); setBatchSourceAgreed(false); setNewDataPage(0); setConflictPage(0); setPanel('preview');
  }

  function previewDemo() {
    void run(async () => {
      if (namespace !== 'demo' || !state) return;
      await prepareImport(createDemoImport(await createDemoDataset()));
    });
  }

  function downloadBackup() {
    void run(async () => {
      if (!state) return;
      const createdAt = new Date().toISOString();
      const text = await createBackup(state);
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `arknights-${namespace}-backup-${createdAt.slice(0, 10)}.json`;
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      await persist({ ...state, revision: state.revision + 1, settings: { ...state.settings, lastBackupAt: createdAt } }, state.revision);
      setNotice({ text: '已發起 JSON 備份下載，請在「檔案」確認保存完成。瀏覽器無法確認下載是否真正落盤。', error: false });
    });
  }

  function acceptImport() {
    void run(async () => {
      if (!state || !preview) return;
      const next = applyImport(state, preview, decisions, { sourceAcceptedIds });
      const existing = new Map(state.roster.map(row => [row.operatorId, row]));
      const added = next.roster.filter(row => !existing.has(row.operatorId)).length;
      const changed = next.roster.filter(row => existing.has(row.operatorId) && JSON.stringify(row) !== JSON.stringify(existing.get(row.operatorId))).length;
      await persist(next, state.revision);
      setPanel(null); setPreview(null);
      setSourceAcceptedIds([]); setBatchSourceAgreed(false); setConfirmedTw(false);
      setNotice({ text: `批次已保存至本機：實際新增 ${added} 名、更新 ${changed} 名。衝突依確認結果處理；可在設定撤銷最後批次。`, error: false });
    });
  }

  async function saveBatch(batchPreview: ImportPreview) {
    if (operation.current || !state || !database.current) throw new Error('目前有操作正在進行，請稍後重試。');
    operation.current = true; setBusy(true);
    try {
      // 使用者已在批次差異表確認所有選取欄位，沿用既有交易、版本檢查與撤銷機制。
      const decisions = Object.fromEntries(batchPreview.conflicts.map(item => [item.id, 'incoming' as const]));
      await persist(applyImport(state, batchPreview, decisions), state.revision);
    } finally { operation.current = false; setBusy(false); }
  }

  function previewManual(field: string, evidence: Evidence) {
    void run(async () => {
      if (!state || !selectedId) return;
      await prepareImport({ format: 'arknights-roster-import', schemaVersion: 1, product: 'arknights', server: 'tw', namespace, dataset: state.dataset,
        candidates: [{ operatorId: selectedId, fields: { [field]: evidence } }], completeness: 'partial', source: '使用者在本機手動更正', adapterVersion: 'manual-1', createdAt: new Date().toISOString() });
    });
  }

  function readImportFile(file?: File) {
    if (!file) return;
    void run(async () => {
      if (!state) return;
      if (!confirmedTw) throw new Error('請先確認這份資料適用《明日方舟》本作繁中服。');
      if (file.size > MAX_IMPORT_BYTES) throw new Error('匯入檔案超過 10 MB 上限，原幹員庫未修改。');
      await prepareImport(await prepareLocalImportText(await file.text(), { dataset: state.dataset, confirmedTw, importedAt: new Date().toISOString() }));
    });
  }

  function readBackupFile(file?: File) {
    if (!file) return;
    void run(async () => {
      if (!state) return;
      if (file.size > MAX_BACKUP_BYTES) throw new Error('備份檔案超過 20 MB 上限，原幹員庫未修改。');
      const data = await parseBackup(await file.text());
      if (data.dataset.metadata.namespace !== namespace) throw new Error(`這是${data.dataset.metadata.namespace === 'demo' ? '示範' : '個人'}庫備份。請先切換到相同資料庫再復原，以免混合資料。`);
      setRestored({ state: data, baseRevision: state.revision }); setRestoreAgreed(false); setPanel('restore');
    });
  }

  const nav = (mobile = false) => <nav aria-label={mobile ? '手機主導覽' : '主導覽'} className={mobile ? 'mobile-nav' : 'nav-list'}>{NAV.map(item => <button key={item.label} className={`nav-item ${page === item.label ? 'active' : ''}`} aria-current={page === item.label ? 'page' : undefined} onClick={() => { setPage(item.label); setBatchInitialId(null); setNotice(null); window.scrollTo({ top: 0 }); }}><Icon name={item.icon}/><span>{item.label}</span></button>)}</nav>;

  if (initError || !state) return <div className="loading"><div className="loading-symbol"><Icon name="shield" size={24}/></div><h1>{initError ? '本機資料庫未就緒' : '正在開啟本機幹員庫'}</h1><p>{initError || '確認資料版本及本機儲存狀態，請稍候。'}</p>{initError && <><p>已停止所有寫入；請勿清除網站資料。請保留既有備份，確認瀏覽器允許儲存後重試。</p><button className="button secondary" onClick={() => window.location.reload()}>重新讀取</button></>}</div>;

  const capacity = page === '設定' ? measureCapacity(state) : null;
  const definitions = new Map(state.dataset.operators.map(definition => [definition.id, definition]));
  const operators = state.roster.map(row => ({ row, definition: definitions.get(row.operatorId)! }));
  const filtered = queryRoster(operators, { search, profession, rarity, elite, status: dataStatus, sort });
  const pageSize = 48;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentRosterPage = Math.min(rosterPage, pageCount - 1);
  const visibleOperators = filtered.slice(currentRosterPage * pageSize, (currentRosterPage + 1) * pageSize);
  const hasRosterFilters = Boolean(search || profession !== 'all' || rarity !== 'all' || elite !== 'all' || dataStatus !== 'all');
  function resetRosterFilters() { setSearch(''); setProfession('all'); setRarity('all'); setElite('all'); setDataStatus('all'); setRosterPage(0); }
  function changeRosterPage(next: number) { setRosterPage(next); rosterHeading.current?.scrollIntoView({ block: 'start' }); }
  const pagination = (position: string) => <nav className="roster-pagination" aria-label={`幹員分頁（${position}）`}>
    <span aria-live="polite">{filtered.length ? `${currentRosterPage * pageSize + 1}–${Math.min((currentRosterPage + 1) * pageSize, filtered.length)} / ${filtered.length} 名` : '0 名'} · 第 {currentRosterPage + 1} / {pageCount} 頁</span>
    <div className="inline-actions"><button className="button secondary small" disabled={currentRosterPage === 0} onClick={() => changeRosterPage(currentRosterPage - 1)}>上一頁</button><button className="button secondary small" disabled={currentRosterPage >= pageCount - 1} onClick={() => changeRosterPage(currentRosterPage + 1)}>下一頁</button></div>
  </nav>;
  const needReview = operators.filter(({ row, definition }) => missingCount(row, definition) > 0 || unverifiedCount(row, definition) > 0).length;
  const selected = operators.find(({ row }) => row.operatorId === selectedId);
  const lastBatch = state.batches.at(-1);
  const isDemo = namespace === 'demo';
  const unresolved = preview?.conflicts.filter(conflict => !decisions[conflict.id]).length ?? 0;
  const newSourceFields = preview?.conflicts.filter(isNewSourceConflict) ?? [];
  const pendingNewSourceFields = newSourceFields.filter(conflict => !decisions[conflict.id]);
  const actualConflicts = preview?.conflicts.filter(conflict => !isNewSourceConflict(conflict)) ?? [];
  const previewDefinitions = new Map(preview?.input.dataset.operators.map(definition => [definition.id, definition]) ?? []);
  const candidateQuery = candidateSearch.trim().toLocaleLowerCase();
  const visibleCandidates = preview?.input.candidates.filter(candidate => {
    const definition = previewDefinitions.get(candidate.operatorId);
    return !candidateQuery || [candidate.operatorId, definition?.displayName ?? '', ...(definition?.aliases ?? [])].some(value => value.toLocaleLowerCase().includes(candidateQuery));
  }) ?? [];
  const renderConflict = (conflict: FieldConflict) => {
    const definition = previewDefinitions.get(conflict.operatorId), sourceAccepted = sourceAcceptedIds.includes(conflict.id);
    return <div className="conflict" key={conflict.id}><h3>{definition?.displayName ?? conflict.operatorId} ／ {fieldLabel(conflict.field, definition)}</h3><p>{conflict.reasons.join('；')}</p>{sourceAccepted && <p className="source-acceptance-note">已選擇採用來源值；保留低信心與未經人工確認。</p>}<div className="conflict-options">{(['keep', 'incoming'] as const).map(choice => {
      const evidence = choice === 'keep' ? conflict.current : conflict.incoming;
      return <label className="choice" key={choice}><input type="radio" name={conflict.id} checked={decisions[conflict.id] === choice} disabled={busy} onChange={() => { setDecisions(current => ({ ...current, [conflict.id]: choice })); setSourceAcceptedIds(current => current.filter(id => id !== conflict.id)); }}/><span>{choice === 'keep' ? '保留既有紀錄' : '逐欄確認採用'}<strong>{valueText(evidence, conflict.field, definition)}</strong><span className="fine-print">{evidence.source}<br/>資料：{formatDate(evidence.observedAt)}<br/>匯入：{formatDate(evidence.importedAt)}<br/>{evidence.manuallyConfirmed ? '已人工確認' : '未經人工確認'}{evidence.confidence !== undefined && <><br/>來源信心分數 {evidence.confidence}（非正確機率）</>}</span></span></label>;
    })}</div></div>;
  };
  const conflictPagination = (total: number, currentPage: number, setCurrentPage: (page: number) => void) => total > 50 && <div className="conflict-pagination"><button type="button" className="button secondary small" disabled={busy || currentPage === 0} onClick={() => setCurrentPage(currentPage - 1)}>上一頁</button><span>第 {currentPage + 1} / {Math.ceil(total / 50)} 頁 · 每頁最多 50 欄</span><button type="button" className="button secondary small" disabled={busy || (currentPage + 1) * 50 >= total} onClick={() => setCurrentPage(currentPage + 1)}>下一頁</button></div>;
  const restoreIds = new Set(restored?.state.roster.map(row => row.operatorId));
  const currentIds = new Set(state.roster.map(row => row.operatorId));
  const restoreAdded = restored?.state.roster.filter(row => !currentIds.has(row.operatorId)).length ?? 0;
  const restoreRemoved = state.roster.filter(row => !restoreIds.has(row.operatorId)).length;
  const restoreChanged = restored?.state.roster.filter(row => currentIds.has(row.operatorId) && JSON.stringify(row) !== JSON.stringify(state.roster.find(old => old.operatorId === row.operatorId))).length ?? 0;

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><Icon name="roster" size={22}/></div><div><div className="brand-name">幹員檔案室</div><div className="brand-sub">ARKNIGHTS · TW</div></div></div><p className="nav-title">工作空間</p>{nav()}<div className="sidebar-footer"><span className="status-dot"/>本機優先 · 無帳號連線<br/>研究原型 0.1.0<br/>繁中服資料尚待驗證</div></aside>
    <main className="main">
      <header className="topbar"><div className="mobile-brand"><div className="brand-mark"><Icon name="roster" size={18}/></div>幹員檔案室</div><div className="topbar-path">工作空間 <span>/</span><strong>{page}</strong></div><div className="profile-badge"><span className="status-dot"/>{isDemo ? '示範工作區' : '個人工作區'}<div className="avatar">TW</div></div></header>
      <section className="hero"><div><div className="eyebrow">繁中服 / 本機資料庫</div><h1>{page === '幹員庫' ? '你的幹員，一目了然。' : page === '設定' ? '資料由你掌握。' : `${page}工作台`}</h1><p className="hero-description">{page === '幹員庫' ? '整理養成進度、核對資料缺口，從可信的紀錄開始。' : page === '設定' ? '查看來源與版本，管理本機保存及備份。' : '先補齊可靠資料與規則，再提供可追溯的建議。'}</p></div><div className="hero-actions"><button className="button secondary" disabled={busy} onClick={downloadBackup}><Icon name="download" size={16}/>備份資料</button><button className="button primary" disabled={busy} onClick={() => { setPanel('import'); setNotice(null); }}><Icon name="plus" size={16}/>匯入幹員</button></div></section>
      <div className="prototype-note"><span className="tag amber">研究原型</span><span><strong>{isDemo ? '目前為虛構示範庫。' : '目前為個人本機庫。'}</strong> {isDemo ? '姓名、養成與圖形皆為自製測試資料，與個人庫分開保存。' : '可預覽本工具與 SKPORT 研究 JSON，請勿貼入密碼、Cookie 或 Token。'} 遊戲資料來源與繁中服相容性仍須核對。</span></div>
      {notice && !panel && <div role={notice.error ? 'alert' : 'status'} className={`toast ${notice.error ? 'error' : ''}`}>{notice.text}</div>}
      {page === '幹員庫' && <>
        <div className="metrics"><div className="metric"><div className="metric-label">已建檔幹員<Icon name="roster" size={15}/></div><div className="metric-number">{state.roster.length}<span>名</span></div><div className="metric-foot">{isDemo ? '虛構資料 · 非遊戲帳號' : '局部幹員庫 · 不推定完整'}</div></div><div className="metric amber"><div className="metric-label">有欄位待確認<Icon name="search" size={15}/></div><div className="metric-number">{needReview}<span>名</span></div><div className="metric-foot">未知保留，不以零值代替</div></div><div className="metric cyan"><div className="metric-label">本機匯入批次<Icon name="shield" size={15}/></div><div className="metric-number">{state.batches.filter(batch => batch.kind === 'import').length}<span>次</span></div><div className="metric-foot">{lastBatch ? `修訂版本 ${state.revision}` : '尚未接受任何候選資料'}</div></div></div>
        <div className="section-heading"><h2 ref={rosterHeading}>幹員檔案<span>{filtered.length} / {state.roster.length}</span></h2><span>來源及缺值皆可展開</span></div>
        <div className="toolbar roster-toolbar">
          <label className="search-wrap"><Icon name="search" size={17}/><input aria-label="搜尋幹員" placeholder="搜尋名稱、別名或完整 ID" value={search} onInput={event => { setSearch(event.currentTarget.value); setRosterPage(0); }}/></label>
          <select className="filter" aria-label="職業篩選" value={profession} onChange={event => { setProfession(event.currentTarget.value); setRosterPage(0); }}><option value="all">所有職業</option>{Array.from(new Set(state.dataset.operators.map(op => op.profession))).map(job => <option key={job} value={job}>{job}</option>)}</select>
          <select className="filter" aria-label="星級篩選" value={rarity} onChange={event => { setRarity(event.currentTarget.value === 'all' ? 'all' : Number(event.currentTarget.value) as NonNullable<RosterQuery['rarity']>); setRosterPage(0); }}><option value="all">所有星級</option>{[6, 5, 4, 3, 2, 1].map(value => <option key={value} value={value}>{value} 星</option>)}</select>
          <select className="filter" aria-label="精英階段篩選" value={elite} onChange={event => { const value = event.currentTarget.value; setElite(value === 'all' || value === 'unknown' ? value : Number(value) as NonNullable<RosterQuery['elite']>); setRosterPage(0); }}><option value="all">所有精英階段</option><option value="2">精英 2</option><option value="1">精英 1</option><option value="0">精英 0</option><option value="unknown">精英階段未知</option></select>
          <select className="filter" aria-label="資料狀態篩選" value={dataStatus} onChange={event => { setDataStatus(event.currentTarget.value as NonNullable<RosterQuery['status']>); setRosterPage(0); }}><option value="all">所有資料狀態</option><option value="unknown">有未知欄位</option><option value="unverified">來源值待核對</option></select>
          <select className="filter" aria-label="幹員排序" value={sort} onChange={event => { setSort(event.currentTarget.value as NonNullable<RosterQuery['sort']>); setRosterPage(0); }}><option value="id">依幹員 ID</option><option value="name">依中文名稱</option><option value="rarity">星級高至低</option><option value="level">精英、等級高至低</option></select>
          {hasRosterFilters && <button className="button ghost small" onClick={resetRosterFilters}>清除篩選</button>}
        </div>
        {pagination('上方')}
        <div className="roster-grid">{visibleOperators.map(({ row, definition }) => <article className="operator-card" key={row.operatorId} data-testid="operator-card"><div className="operator-art"><OperatorPortrait definition={definition}/><span className="operator-code">{definition.id.toUpperCase()}</span><span className="operator-stars" aria-label={`${definition.rarity} 星`}>{'✦'.repeat(definition.rarity)}</span></div><div className="operator-content"><div className="operator-title"><h3>{definition.displayName}</h3><span className="tag muted">{definition.profession}</span></div><div className="operator-subtitle">{isDemo ? '自製測試定義 · 非真實幹員' : `分支：${definition.branch}`}</div><div className="operator-source-warning">{unverifiedCount(row, definition) > 0 && <span className="tag amber" title="這些匯入值的來源信心較低且尚未人工確認，不表示已發現錯誤。">{unverifiedCount(row, definition)} 個匯入值未人工確認</span>}</div><div className="operator-stats">{[['elite', '精英階段'], ['level', '等級'], ['skillLevel', '技能等級']].map(([field, label]) => <div key={field}><div className="stat-label">{label}</div><div className={`stat-value ${!row.fields[field] || row.fields[field].status === 'unknown' ? 'unknown' : ''}`}>{field === 'elite' && row.fields[field]?.status === 'known' ? `E${valueText(row.fields[field])}` : valueText(row.fields[field])}</div></div>)}</div><div className="operator-foot"><span>{missingCount(row, definition) ? `${missingCount(row, definition)} 個欄位未知` : '欄位皆有明示狀態'}</span><button className="card-open" aria-label={`檢視與修正 ${definition.displayName}（${definition.profession}）`} onClick={() => { setSelectedId(row.operatorId); setPanel('detail'); setNotice(null); }}>檢視與修正 ↗</button></div></div></article>)}
          {!filtered.length && <div className="empty-state"><div className="empty-icon"><Icon name="roster" size={25}/></div><h3>{state.roster.length ? '沒有符合條件的幹員' : '從一份可核對的資料開始'}</h3><p>{state.roster.length ? '試著調整名稱、職業、星級、精英階段或資料狀態。' : isDemo ? '先預覽 8 名虛構幹員，體驗合併、未知欄位、手動修正及備份；確認前不會寫入。' : '可匯入 SKPORT 研究 JSON 或本工具候選資料，先補齊中文定義，再預覽養成欄位。確認前不會寫入。'}</p>{!state.roster.length && isDemo && <button className="button primary" disabled={busy} onClick={previewDemo}>預覽示範批次<Icon name="arrow" size={16}/></button>}{!state.roster.length && <button className="button secondary" disabled={busy} onClick={() => setPanel('import')}>選擇 JSON 檔案</button>}</div>}
        </div>{pageCount > 1 && pagination('下方')}<div className="bottom-caption"><span><span className="status-dot"/>本機 IndexedDB 保存 · 請定期匯出備份</span><span>資料集 {state.dataset.metadata.version} · 繁中服 · 格式 v{state.schemaVersion}</span></div>
      </>}
      <div hidden={page !== '批次修正'}><BatchEditor key={namespace} state={state} initialId={batchInitialId} onInitialHandled={() => setBatchInitialId(null)} onSave={saveBatch}/></div>
      {page === '設定' && <div className="settings-grid">
        <section className="panel"><h2>工作區與資料版本</h2><dl className="definition-list"><div><dt>目前工作區</dt><dd>{isDemo ? '示範庫（虛構）' : '個人庫（局部）'}</dd></div><div><dt>格式 / 修訂</dt><dd>v{state.schemaVersion} / {state.revision}</dd></div><div><dt>資料集</dt><dd>{state.dataset.metadata.id} / {state.dataset.metadata.version}</dd></div><div><dt>來源</dt><dd>{state.dataset.metadata.source}</dd></div><div><dt>本服有效起點</dt><dd>{formatDate(state.dataset.metadata.validFrom)}</dd></div><div><dt>授權標示</dt><dd>{state.dataset.metadata.licenseStatus === 'self-authored' ? '自製資料' : state.dataset.metadata.licenseStatus === 'permitted' ? '來源自述已獲允許，仍需核對' : '未知，待查核'}</dd></div><div><dt>取得日期</dt><dd>{formatDate(state.dataset.metadata.acquiredAt)}</dd></div></dl><details className="plain-details"><summary>查看資料校驗值</summary><span className="wrap-text">{state.dataset.metadata.checksum}</span></details><div className="inline-actions"><button className="button secondary" disabled={busy} onClick={() => setPanel('switch')}>切換至{isDemo ? '個人' : '示範'}庫</button>{isDemo && <button className="button ghost" disabled={busy} onClick={previewDemo}>再次預覽示範批次</button>}</div></section>
        <section className="panel"><h2>本機保存與備份</h2><p>IndexedDB 不是永久備份。Safari 與主畫面版本可能使用不同儲存空間；清除網站資料或換機後，需用備份復原。</p><dl className="definition-list"><div><dt>持久儲存</dt><dd>{!persistence ? '目前無法查詢' : !persistence.supported ? '此瀏覽器未提供查詢能力' : persistence.persisted ? '已授予；仍需備份' : '尚未授予'}</dd></div><div><dt>網站儲存估計</dt><dd>{persistence?.usage !== undefined ? `${(persistence.usage / 1024 / 1024).toFixed(2)} MB` : '未知'}{persistence?.quota !== undefined && ` / 約 ${(persistence.quota / 1024 / 1024).toFixed(0)} MB`}<br/><span className="fine-print">同一網站來源的估計值，不是本庫精確大小。</span></dd></div><div><dt>最近發起下載</dt><dd>{formatDate(state.settings.lastBackupAt)}<br/><span className="fine-print">請自行確認檔案已保存。</span></dd></div></dl><div className="inline-actions"><button className="button primary" disabled={busy} onClick={downloadBackup}>下載 JSON 備份</button><button className="button secondary" disabled={busy || !persistence?.supported} onClick={() => void run(async () => { const granted = await requestPersistence(); setPersistence(await queryPersistence()); setNotice({ text: granted ? '瀏覽器已授予持久儲存；這不代表永不丟失，仍須備份。' : '瀏覽器尚未授予持久儲存。你仍可使用本機庫，請定期備份。', error: false }); })}>請求持久儲存</button></div><hr className="divider"/><label className="field-label" htmlFor="backup-file">從本工具備份復原（先預覽，最多 20 MB）</label><input id="backup-file" type="file" accept="application/json,.json" className="file-input" disabled={busy} onChange={event => { readBackupFile(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }}/></section>
        <section className="panel"><h2>批次紀錄與撤銷</h2><p>每次接受候選均記錄來源與確認決策。只支援撤銷最後一個可撤銷匯入；備份復原另有整庫取代確認。</p>{capacity && <p className={capacity.level === 'ok' ? 'fine-print' : 'warning-note'} role={capacity.level === 'ok' ? undefined : 'status'}>保存容量：{describeCapacity(capacity)}</p>}<button className="button secondary" disabled={busy || !state.undo} onClick={() => void run(async () => { const next = undoLastImport(state); await persist(next, state.revision); setNotice({ text: '最後匯入批次已撤銷，復原結果已保存。撤銷紀錄已保留。', error: false }); })}>撤銷最後匯入批次</button><div className="candidate-list" style={{ marginTop: '16px' }}>{state.batches.slice(-5).reverse().map(batch => <div className="candidate-row" key={batch.id}><span>{batch.kind === 'undo' ? '撤銷批次' : batch.duplicateOf ? '重複匯入紀錄' : batch.source}<br/><span className="fine-print">{formatDate(batch.createdAt)}</span></span><span>{batch.kind === 'import' ? `新增 ${batch.counts.added}` : '已復原'}</span></div>)}{!state.batches.length && <p className="fine-print">目前沒有批次紀錄。</p>}</div></section>
        <GameDataSettings/><section className="panel"><h2>帳號 API 驗證狀態</h2><p>接口線索、使用權、安全登入與欄位完整性分別驗證。帳號資料需經研究匯出與本機預覽確認。</p><ResearchGates/></section>
      </div>}
      {(['基建', '養成', '搭配'] as Page[]).includes(page) && <section className="panel"><span className="tag amber">尚未實作規則 · 無推薦結果</span><div className="coming-number">{page === '基建' ? '02' : '03'}</div><h2>{page === '基建' ? '輪班建議需要可靠的規則與起點' : page === '養成' ? '依模式決定投資，不共用假排行' : '從技能條件驗證聯動關係'}</h2><p>目前交付幹員庫與匯入流程骨架，這個工作台尚未計算任何遊戲建議。</p><ul className="gap-list">{(page === '基建' ? ['待建立真實設施配置、產品、宿舍與可上線時段。', '待核對繁中規則：單人、組隊、跨設施、心情、零心情例外與恢復。', '待以事件模擬核對資源帳目、人員互斥及可重複輪班。'] : page === '養成' ? ['主線日常、集成戰略、生息演算、保全派駐、衛戍協議各自建模。', '待核對本服技能、專精、模組的前提與成本，未知不當作未完成。', '待取得目標、預算及已核對案例，才提供具體投資順序。'] : ['同陣營僅是分類，尚不構成實際技能聯動。', '待建立觸發、時序、互斥、需求技能與模組的來源證據。', '替代方案須說明保留與失去的功能，並區分已持有及理論選項。']).map(gap => <li key={gap}>{gap}</li>)}</ul><div className="inline-actions"><button className="button secondary" onClick={() => setPage('幹員庫')}>回到幹員庫</button><button className="button ghost" onClick={() => setPage('設定')}>查看資料與研究狀態</button></div></section>}
    </main>{nav(true)}
    {panel === 'import' && <Modal title="匯入幹員資料" eyebrow="資料先預覽，確認後才保存" onClose={closePanel} footer={<button className="button ghost" disabled={busy} onClick={closePanel}>取消</button>}>
      {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</div>}
      <div className="import-methods"><div className="method"><Icon name="file"/><strong>JSON 資料匯入</strong><span className="tag">先預覽</span><p>接受本工具候選或 SKPORT 研究格式，並核對中文幹員定義。來源仍保留未驗證標記。</p></div><div className="method"><Icon name="image"/><strong>多張截圖</strong><span className="tag amber">研究中</span><p>可載入 Windows 本機 OCR 結果並核對原圖。正式 ID、圖示與 iPhone 辨識待完成。</p></div><div className="method disabled"><Icon name="film"/><strong>影片辨識</strong><span className="tag amber">停用</span><p>待原檔解碼、抽幀與 iPhone 容量實測，尚無成功證據。</p></div></div>
      {isDemo && <div className="warning-note">SKPORT 研究資料只能匯入個人庫；目前是虛構示範庫。<div className="inline-actions"><button className="button secondary small" disabled={busy} onClick={() => setPanel('switch')}>切換至個人庫</button></div></div>}
      <label className="checkbox-line"><input type="checkbox" checked={confirmedTw} disabled={busy} onChange={event => setConfirmedTw(event.currentTarget.checked)}/><span>我已核對這份資料適用《明日方舟》本作繁中服；不只依介面語言判斷服別。</span></label>
      <label className="field-label" htmlFor="import-file">選擇匯入 JSON（最多 10 MB，檔案內容留在本機）</label><input id="import-file" className="file-input" type="file" accept="application/json,.json" disabled={busy || !confirmedTw} onChange={event => { readImportFile(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }}/>
      <p className="fine-print">研究格式會讀取本機遊戲資料服務的幹員定義，補上中文姓名、職業、星級與能力說明；不把帳號檔案送去查詢來源。</p>
      <details className="plain-details"><summary>貼上 JSON 文字</summary><label className="field-label" htmlFor="import-json">只貼候選或研究匯出資料，勿貼登入憑證</label><textarea id="import-json" className="text-area" value={importText} maxLength={MAX_IMPORT_BYTES} disabled={busy} onInput={event => setImportText(event.currentTarget.value)} placeholder={'{"format":"skport-offline-research", ...}'}/><div className="inline-actions"><button className="button primary" disabled={busy || !confirmedTw || !importText.trim()} onClick={() => void run(async () => { if (!confirmedTw) throw new Error('請先核對本作繁中服。'); await prepareImport(await prepareLocalImportText(importText, { dataset: state.dataset, confirmedTw, importedAt: new Date().toISOString() })); })}>解析並預覽</button></div></details>
      {isDemo && <div className="inline-actions"><button className="button secondary" disabled={busy} onClick={previewDemo}>預覽 8 名虛構示範幹員</button></div>}
      <hr className="divider"/><details className="plain-details"><summary>開啟多圖辨識核對</summary><ScreenshotReview/></details>
      <hr className="divider"/><div className="split-heading"><h3>SKPORT 本機研究</h3><span className="tag amber">非官方接入 · 待帳號驗證</span></div>
      <ol className="skport-steps"><li><strong>官方登入</strong><span>目前官方網站使用 GRYPH LINE 登入；本工具尚未取得可用的第三方授權契約。</span></li><li><strong>選定本作繁中角色</strong><span>需確認產品與服別，不能由繁體介面或姓名推定。</span></li><li><strong>只讀資料與欄位轉換</strong><span>離線研究轉換器保留缺值與穩定 ID；資料來源仍須核對。</span></li><li><strong>預覽、確認與保存</strong><span>沿用本機合併流程。只有確認後才寫入幹員庫。</span></li></ol>
      <p className="fine-print">登入官方網站不會自動連接本工具。非官方研究頁需先在電腦執行 npm run build 與 npm run skport；登入成功後才列出角色，讀取結果先預覽，不自動寫入幹員庫。</p>
      <a className="button primary" href="http://127.0.0.1:5187/skport.html" target="_blank" rel="noopener noreferrer">開啟非官方本機研究 ↗</a>
      <a className="button secondary" href="https://www.skport.com/" target="_blank" rel="noopener noreferrer">開啟 SKPORT 官方網站 ↗</a>
      <details className="plain-details"><summary>查看 G0–G5 驗證門檻</summary><ResearchGates/></details>
    </Modal>}
    {panel === 'preview' && preview && <Modal title="確認這次匯入" eyebrow="候選預覽 / 尚未寫入" onClose={closePanel} footer={<><button className="button ghost" disabled={busy} onClick={closePanel}>取消匯入</button><button className="button primary" disabled={busy || unresolved > 0} onClick={acceptImport}>{busy ? '保存中…' : unresolved ? `尚有 ${unresolved} 個衝突` : '確認合併並保存'}</button></>}>
      {notice && <div className="toast error" role="alert">{notice.text}</div>}
      <div className="warning-note">{preview.input.completeness === 'partial' ? '局部資料：未出現的幹員不會被刪除，缺值保持未知。' : '來源自述完整；完整性尚未獨立驗證。本流程只合併，不刪除未出現的幹員。'}{preview.duplicateOf && ' 此內容曾匯入，將保留重複批次紀錄，不新增重複幹員。'}</div>
      <div className="preview-stats">{[['新增', preview.counts.added], ['更新', preview.counts.changed], ['重複', preview.counts.repeated], ['衝突欄位', preview.counts.conflicts], ['缺漏欄位', preview.counts.missing]].map(([label, value]) => <div className="preview-stat" key={String(label)}><strong>{value}</strong><span>{label}</span></div>)}</div>
      {preview.moduleIssues.length > 0 && <section className="warning-note" role="alert" aria-label="模組矛盾"><strong>模組紀錄互相矛盾（{preview.moduleIssues.length} 項），目前無法保存。</strong><ul>{preview.moduleIssues.slice(0, 20).map(issue => <li key={`${issue.operatorId}/${issue.moduleId}/${issue.message}`}>{issue.message}</li>)}</ul>{preview.moduleIssues.length > 20 && <p>另有 {preview.moduleIssues.length - 20} 項。</p>}<p className="fine-print">若矛盾來自衝突欄位，可選擇保留既有值後再保存；其餘請修正來源或一併調整解鎖、等級與裝備。</p></section>}
      <p className="fine-print">來源：{preview.input.source}<br/>資料集：{preview.input.dataset.metadata.id} / {preview.input.dataset.metadata.version}<br/>預覽依據：修訂 {preview.baseRevision}。若其他分頁已修改，本次保存會被拒絕。</p>
      {newSourceFields.length > 0 && <section className="batch-source-review" aria-label="批次採用新資料"><h3>新欄位的來源確認</h3><p>這批有 <strong>{newSourceFields.length}</strong> 個欄位目前為未知，且只有來源信心較低的提醒。可一併選擇採用；來源分數與未經人工確認的狀態會保留。</p><p className="fine-print">已有不同值、人工確認值、來源時間較舊或同批重複矛盾的欄位，都必須另行逐欄決定。</p>
        {pendingNewSourceFields.length > 0 && <><label className="checkbox-line"><input type="checkbox" checked={batchSourceAgreed} disabled={busy} onChange={event => setBatchSourceAgreed(event.currentTarget.checked)}/><span>我同意採用尚未選擇的 {pendingNewSourceFields.length} 個新欄位，並保留來源未驗證與低信心標記。</span></label><button className="button primary" disabled={busy || !batchSourceAgreed} onClick={() => { if (!batchSourceAgreed) return; const ids = pendingNewSourceFields.map(conflict => conflict.id); setDecisions(current => ({ ...current, ...Object.fromEntries(ids.map(id => [id, 'incoming' as const])) })); setSourceAcceptedIds(current => [...new Set([...current, ...ids])]); setBatchSourceAgreed(false); }}>採用這批新資料（{pendingNewSourceFields.length} 欄）</button></>}
        {sourceAcceptedIds.length > 0 && <div className="inline-actions"><span className="source-acceptance-note" role="status">已選擇 {sourceAcceptedIds.length} 欄；尚未保存，未標記人工確認。</span><button className="button ghost small" disabled={busy} onClick={() => { setDecisions(current => Object.fromEntries(Object.entries(current).filter(([id]) => !sourceAcceptedIds.includes(id)))); setSourceAcceptedIds([]); setBatchSourceAgreed(false); }}>取消批次採用選擇</button></div>}
        <details className="plain-details"><summary>逐欄查看這 {newSourceFields.length} 個新欄位</summary><p className="fine-print">個別更改下方選項會按逐欄人工決策記錄；批次按鈕只採用來源資料。</p>{conflictPagination(newSourceFields.length, newDataPage, setNewDataPage)}{newSourceFields.slice(newDataPage * 50, (newDataPage + 1) * 50).map(renderConflict)}{conflictPagination(newSourceFields.length, newDataPage, setNewDataPage)}</details>
      </section>}
      {actualConflicts.length > 0 && <><h3>逐欄核對其他衝突（{actualConflicts.length} 欄）</h3><p className="fine-print">這些欄位不會由批次按鈕選取。請核對來源、時間及人工確認紀錄後逐欄決定，所有未選擇項目都會阻止保存。</p>{conflictPagination(actualConflicts.length, conflictPage, setConflictPage)}{actualConflicts.slice(conflictPage * 50, (conflictPage + 1) * 50).map(renderConflict)}{conflictPagination(actualConflicts.length, conflictPage, setConflictPage)}</>}
      <h3>候選幹員（{preview.input.candidates.length} 筆）</h3>
      <p className="fine-print">可先查看每位幹員的技能與天賦；檢視或關閉能力說明都不會更動上方確認決策。</p>
      <label className="field-label" htmlFor="candidate-search">搜尋候選幹員名稱或 ID</label><input id="candidate-search" className="text-input candidate-search" type="search" value={candidateSearch} onInput={event => { setCandidateSearch(event.currentTarget.value); setPreviewDetailId(null); }} placeholder="輸入名稱、別名或 ID"/>
      <div className="candidate-list">{visibleCandidates.slice(0, 100).map((candidate, index) => {
        const definition = previewDefinitions.get(candidate.operatorId), expanded = previewDetailId === candidate.operatorId;
        return <article className="candidate-preview" key={`${candidate.operatorId}-${index}`}>
          <div className="candidate-row candidate-preview-row"><div className="candidate-identity">{definition && <div className="candidate-avatar"><OperatorPortrait definition={definition}/></div>}<div><strong>{definition?.displayName ?? candidate.operatorId}</strong><span className="fine-print">{definition ? `${missingCount(candidate, definition)} 欄未知` : '資料定義待補'}</span></div></div>{definition && <button className="button secondary small" aria-expanded={expanded} aria-controls={`candidate-ability-${index}`} aria-label={`${expanded ? '收合' : '檢視'}${definition.displayName}能力`} onClick={() => setPreviewDetailId(expanded ? null : candidate.operatorId)}>{expanded ? '收合能力' : '檢視能力'}</button>}</div>
          {expanded && definition && <div id={`candidate-ability-${index}`} className="candidate-ability"><OperatorEncyclopedia definition={definition} row={candidate}/><button className="button ghost small" onClick={() => setPreviewDetailId(null)}>收合能力說明</button></div>}
        </article>;
      })}</div>
      {!visibleCandidates.length && <p className="fine-print">沒有符合搜尋條件的候選幹員。</p>}
      <p className="fine-print">{visibleCandidates.length > 100 ? `符合條件的 ${visibleCandidates.length} 筆中顯示前 100 筆，可輸入名稱或 ID 找到其他幹員。` : candidateQuery ? `符合條件：${visibleCandidates.length} 筆。` : ''}確認會處理全部 {preview.input.candidates.length} 筆候選，搜尋不會排除匯入資料。上方欄位核對以每頁 50 欄顯示。</p>
    </Modal>}
    {panel === 'detail' && selected && <Modal title={selected.definition.displayName} eyebrow="欄位證據 / 可預覽手動修正" onClose={closePanel} footer={<button className="button secondary" disabled={busy} onClick={closePanel}>完成檢視</button>}>
      {notice && <div className="toast error" role="alert">{notice.text}</div>}<ReferenceDetails key={`${selected.row.operatorId}-${state.revision}`} definition={selected.definition} row={selected.row} personal={!isDemo}/><hr className="divider"/><div className="inline-actions"><button className="button primary" onClick={() => { setBatchInitialId(selected.row.operatorId); setPanel(null); setPage('批次修正'); window.scrollTo({ top: 0 }); }}>前往批次修正（已選此幹員）</button></div><details className="plain-details"><summary>單一幹員欄位修正（含專精與模組）</summary><h3>養成紀錄與來源</h3><p className="fine-print">穩定 ID：{selected.row.operatorId}<br/>每個欄位可獨立改為已知、未知或不適用。修正先進入候選預覽，接受後保留人工來源；這是例外修正流程，不能代替大量匯入。</p><div className="evidence-list">{fieldKeys(selected.definition).map(field => <FieldEditor key={`${selected.row.operatorId}-${field}-${state.revision}`} field={field} evidence={selected.row.fields[field] ?? unknown('來源未提供此欄位')} definition={selected.definition} busy={busy} onPreview={previewManual}/>)}</div></details>
    </Modal>}
    {panel === 'restore' && restored && <Modal title="預覽備份復原" eyebrow="整庫取代 / 請先備份目前資料" onClose={closePanel} footer={<><button className="button ghost" disabled={busy} onClick={closePanel}>取消復原</button><button className="button danger" disabled={busy || !restoreAgreed} onClick={() => void run(async () => { if (state.revision !== restored.baseRevision) throw new Error('復原預覽已過期，請重新選取備份。'); const next = { ...restored.state, profileId: state.profileId, revision: state.revision + 1 }; await persist(next, restored.baseRevision); setPanel(null); setRestored(null); setRestoreAgreed(false); setNotice({ text: '備份已通過驗證並以交易取代目前工作區，修訂版本已遞增。', error: false }); })}>{busy ? '復原中…' : '確認取代並復原'}</button></>}>
      {notice && <div className="toast error" role="alert">{notice.text}</div>}<div className="warning-note">此操作會以備份取代目前{isDemo ? '示範' : '個人'}庫的幹員、設定與批次歷史。未包含在備份的幹員將移除；復原不能用「撤銷最後匯入」返回。另一個工作區不受影響。</div><div className="restore-counts" style={{ marginTop: '18px' }}><div>新增幹員<strong>{restoreAdded}</strong></div><div>變更幹員<strong>{restoreChanged}</strong></div><div>移除幹員<strong>{restoreRemoved}</strong></div></div><dl className="definition-list"><div><dt>幹員總數</dt><dd>{state.roster.length} → {restored.state.roster.length}</dd></div><div><dt>資料集版本</dt><dd>{state.dataset.metadata.id} / {state.dataset.metadata.version} → {restored.state.dataset.metadata.id} / {restored.state.dataset.metadata.version}</dd></div><div><dt>設定</dt><dd>{JSON.stringify(state.settings) === JSON.stringify(restored.state.settings) ? '內容相同' : '內容不同，將採用備份設定'}</dd></div><div><dt>批次紀錄</dt><dd>{state.batches.length} → {restored.state.batches.length} 筆，以備份內容取代</dd></div></dl><div className="inline-actions"><button className="button secondary" disabled={busy} onClick={downloadBackup}>先下載目前資料備份</button></div><p className="fine-print">下載備份會更新修訂版本，之後請重新選取待復原檔，取得最新差異預覽。</p><label className="checkbox-line"><input type="checkbox" checked={restoreAgreed} onChange={event => setRestoreAgreed(event.currentTarget.checked)} disabled={busy}/><span>我已確認備份檔可取用，並理解此復原會取代目前工作區的內容。</span></label>
    </Modal>}
    {panel === 'switch' && <Modal title={`切換至${isDemo ? '個人' : '示範'}工作區`} eyebrow="兩份資料庫獨立保存" onClose={closePanel} footer={<><button className="button ghost" disabled={busy} onClick={closePanel}>取消</button><button className="button primary" disabled={busy} onClick={() => { const next = isDemo ? 'personal' : 'demo'; window.location.hash = next; setNamespace(next); setPage('幹員庫'); }}>確認切換</button></>}><p>目前 {state.roster.length} 名幹員會留在原工作區，切換不會搬移或混合資料。首次個人工作區為空庫；私人 JSON 不可匯入示範庫。批次修正的未保存草稿會在切換工作區時清除，請先保存需要保留的變更。</p><p className="warning-note">建議先下載目前資料備份，並在 iPhone「檔案」確認已保存。兩個庫仍可能一起被瀏覽器清除。</p><button className="button secondary" disabled={busy} onClick={downloadBackup}>下載目前工作區備份</button>{notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</div>}</Modal>}
  </div>;
}
