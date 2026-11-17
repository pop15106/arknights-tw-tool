import { useEffect, useRef, useState } from 'preact/hooks';
import { createEmptyState, MAX_BACKUP_BYTES, MAX_IMPORT_BYTES } from './domain/model';
import type { AppState, Evidence, ImportDocument, Namespace } from './domain/model';
import { applyImport, previewImport, undoLastImport } from './domain/import';
import type { ImportPreview } from './domain/import';
import { createBackup, parseBackup } from './storage/backup';
import { loadState, openDatabase, overwriteRepaired, queryPersistence, readRawState, repairUnknownFields, requestPersistence, saveState } from './storage/database';
import { createDemoDataset, createDemoImport, createPersonalDataset } from './demo';
import { prepareLocalImportText } from './importers/local-file';
import { BatchEditor } from './BatchEditor';
import { Icon, type IconName } from './ui/Icon';
import { Notice } from './ui/Modal';
import { friendlyError, taipeiDate } from './ui/format';
import { useTheme } from './ui/theme';
import { RosterPage } from './ui/RosterPage';
import { BasePage } from './ui/BasePage';
import { GrowthPage } from './ui/GrowthPage';
import { StagePage } from './ui/StagePage';
import { TeamPage } from './ui/TeamPage';
import { ToolsPage } from './ui/ToolsPage';
import { PlannedPage, SettingsPage, type PlannedName } from './ui/pages';
import { DetailPanel, ImportPanel, PreviewPanel, RestorePanel, SwitchPanel, type Decisions } from './ui/panels';
import './styles.css';

type Page = '幹員庫' | '批次修正' | PlannedName | '關卡' | '工具' | '設定';
type Panel = 'import' | 'preview' | 'detail' | 'restore' | 'switch' | null;
const NAV: { label: Page; icon: IconName; hint: string }[] = [
  { label: '幹員庫', icon: 'roster', hint: '查詢與檢視' }, { label: '批次修正', icon: 'edit', hint: '逐列核對欄位' },
  { label: '基建', icon: 'base', hint: '設施配置與技能' }, { label: '養成', icon: 'grow', hint: '材料與龍門幣計算' }, { label: '關卡', icon: 'database', hint: '活動與材料掉落' }, { label: '搭配', icon: 'link', hint: '相性、編隊與關卡' }, { label: '工具', icon: 'check', hint: '公招、專精、體檢' },
  { label: '設定', icon: 'settings', hint: '保存、備份與來源' },
];
const SUBTITLE: Record<Page, string> = {
  幹員庫: '整理養成進度、核對資料缺口。', 批次修正: '左側勾選角色，右側直接改欄位；預覽確認後才保存。',
  基建: '設施配置、進駐名單與可追溯的技能加成。', 養成: '精英化、技能、專精與模組的材料計算。', 關卡: '台服活動時間表與材料掉落來源。', 工具: '公招計算、專精規劃與帳號體檢。', 搭配: '幹員相性、編隊建議與依關卡推薦。', 設定: '來源與版本、本機保存及備份。',
};

export default function App() {
  const [namespace, setNamespace] = useState<Namespace>(window.location.hash === '#personal' ? 'personal' : 'demo');
  const [state, setState] = useState<AppState | null>(null);
  const [initError, setInitError] = useState('');
  const [page, setPage] = useState<Page>('幹員庫');
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [batchInitialId, setBatchInitialId] = useState<string | null>(null);
  const [restored, setRestored] = useState<{ state: AppState; baseRevision: number } | null>(null);
  const [persistence, setPersistence] = useState<Awaited<ReturnType<typeof queryPersistence>> | null>(null);
  const database = useRef<IDBDatabase | null>(null);
  const repairable = useRef<IDBDatabase | null>(null);
  const [repairing, setRepairing] = useState(false);
  const operation = useRef(false);
  const theme = useTheme();

  useEffect(() => {
    let active = true;
    let opened: IDBDatabase | null = null;
    setState(null); setInitError(''); setNotice(null); setPanel(null); setPreview(null); setRestored(null);
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
      } catch (error) {
        // 其他版本寫入了本版不認得的欄位：保留連線，讓使用者先備份再修復。
        if (active && opened && error instanceof Error && /包含未允許欄位|缺少必要欄位/u.test(error.message)) { repairable.current = opened; setInitError(friendlyError(error)); return; }
        if (active) setInitError(friendlyError(error)); opened?.close();
      }
    })();
    return () => { active = false; opened?.close(); database.current = null; repairable.current = null; };
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

  function openPanel(next: Panel) { setNotice(null); setPanel(next); }
  function closePanel() {
    if (busy) return;
    setPanel(null); setPreview(null); setRestored(null); setNotice(null);
  }
  function goto(next: Page) { setPage(next); setBatchInitialId(null); setNotice(null); window.scrollTo({ top: 0 }); }

  async function prepareImport(input: ImportDocument) {
    if (!state) return;
    setPreview(await previewImport(state, input)); setPanel('preview');
  }
  const previewDemo = () => void run(async () => { if (namespace === 'demo') await prepareImport(createDemoImport(await createDemoDataset())); });

  function downloadBackup() {
    void run(async () => {
      if (!state) return;
      const createdAt = new Date().toISOString();
      const url = URL.createObjectURL(new Blob([await createBackup(state)], { type: 'application/json;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `arknights-${namespace}-backup-${taipeiDate(createdAt)}.json`;
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      await persist({ ...state, revision: state.revision + 1, settings: { ...state.settings, lastBackupAt: createdAt } }, state.revision);
      setNotice({ text: '已發起 JSON 備份下載，請到「檔案」或下載資料夾確認保存完成。瀏覽器無法確認下載是否真正落盤。', error: false });
    });
  }

  function acceptImport(decisions: Decisions, sourceAcceptedIds: string[]) {
    void run(async () => {
      if (!state || !preview) return;
      const next = applyImport(state, preview, decisions, { sourceAcceptedIds });
      const existing = new Map(state.roster.map(row => [row.operatorId, row]));
      const added = next.roster.filter(row => !existing.has(row.operatorId)).length;
      const changed = next.roster.filter(row => existing.has(row.operatorId) && JSON.stringify(row) !== JSON.stringify(existing.get(row.operatorId))).length;
      await persist(next, state.revision);
      setPanel(null); setPreview(null);
      setNotice({ text: `批次已保存至本機：實際新增 ${added} 名、更新 ${changed} 名。可在設定撤銷最後批次。`, error: false });
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

  function importText(text: string, confirmedTw: boolean) {
    void run(async () => {
      if (!state) return;
      if (!confirmedTw) throw new Error('請先確認這份資料適用《明日方舟》本作繁中服。');
      await prepareImport(await prepareLocalImportText(text, { dataset: state.dataset, confirmedTw, importedAt: new Date().toISOString() }));
    });
  }
  function importFile(file: File, confirmedTw: boolean) {
    if (file.size > MAX_IMPORT_BYTES) { setNotice({ text: '匯入檔案超過 10 MB 上限，原幹員庫未修改。', error: true }); return; }
    void file.text().then(text => importText(text, confirmedTw), () => setNotice({ text: '無法讀取這個檔案，原幹員庫未修改。', error: true }));
  }

  function readBackupFile(file: File) {
    void run(async () => {
      if (!state) return;
      if (file.size > MAX_BACKUP_BYTES) throw new Error('備份檔案超過 20 MB 上限，原幹員庫未修改。');
      const data = await parseBackup(await file.text());
      if (data.dataset.metadata.namespace !== namespace) throw new Error(`這是${data.dataset.metadata.namespace === 'demo' ? '示範' : '個人'}庫備份。請先切換到相同資料庫再復原，以免混合資料。`);
      setRestored({ state: data, baseRevision: state.revision }); openPanel('restore');
    });
  }

  async function repairDatabase() {
    const db = repairable.current;
    if (!db || repairing) return;
    setRepairing(true);
    try {
      const raw = await readRawState(db);
      const { state: repaired, removed, undecided } = await repairUnknownFields(raw);
      // 先把原樣內容存成檔案，修復失敗或想還原時都還有原始資料。
      const url = URL.createObjectURL(new Blob([JSON.stringify(raw)], { type: 'application/json;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `arknights-${namespace}-raw-before-repair-${taipeiDate(new Date().toISOString())}.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      await overwriteRepaired(db, repaired, raw);
      window.alert(`${removed.length ? `已移除不相容欄位：${removed.join('、')}。` : ''}${undecided ? `匯入紀錄中 ${undecided} 筆未決定的衝突已記為「保留現有值」（當時就沒有改動幹員庫）。` : ''}幹員與設定其餘內容保留，原始資料已下載備份。`);
      window.location.reload();
    } catch (error) { setInitError(friendlyError(error)); setRepairing(false); }
  }

  if (initError || !state) return <div className="loading">
    <div className="loading-mark"><Icon name={initError ? 'alert' : 'database'} size={24}/></div>
    <h1>{initError ? '本機資料庫未就緒' : '正在開啟本機幹員庫'}</h1>
    <p>{initError || '確認資料版本及本機儲存狀態，請稍候。'}</p>
    {initError && /包含未允許欄位|缺少必要欄位/u.test(initError) && <><p>這通常是用過其他版本留下的欄位。可以先下載原始資料，再移除本版不認得的欄位，幹員與設定其餘內容會保留。</p><button type="button" className="button" disabled={repairing} onClick={() => void repairDatabase()}>{repairing ? '修復中…' : '下載原始資料並修復'}</button></>}
    {initError && <><p>已停止所有寫入；請勿清除網站資料。請保留既有備份，確認瀏覽器允許儲存後重試。</p><button type="button" className="button secondary" onClick={() => window.location.reload()}>重新讀取</button></>}
  </div>;

  const isDemo = namespace === 'demo';
  const selectedRow = state.roster.find(row => row.operatorId === selectedId);
  const selectedDefinition = selectedRow && state.dataset.operators.find(op => op.id === selectedRow.operatorId);
  const panelNotice = panel ? notice : null;
  const nav = (mobile: boolean) => <nav aria-label={mobile ? '手機主導覽' : '主導覽'} className={mobile ? 'mobile-nav' : 'nav-list'}>
    {NAV.map(item => <button type="button" key={item.label} className={`nav-item ${page === item.label ? 'active' : ''}`} aria-current={page === item.label ? 'page' : undefined} onClick={() => goto(item.label)}>
      <Icon name={item.icon} size={mobile ? 20 : 18}/><span className="nav-label">{item.label}</span>{!mobile && <small>{item.hint}</small>}
    </button>)}
  </nav>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark" aria-hidden="true">檔</div><div><div className="brand-name">幹員檔案室</div><div className="brand-sub">繁中服 · 本機工具</div></div></div>
      {nav(false)}
      <div className="sidebar-footer">
        <button type="button" className={`workspace-switch ${isDemo ? 'demo' : 'personal'}`} disabled={busy} onClick={() => openPanel('switch')}>
          <span className="workspace-dot"/><span><strong>{isDemo ? '示範工作區' : '個人工作區'}</strong><small>點此切換</small></span>
        </button>
        <p>本機優先 · 無帳號連線<br/>版本 1.1.0</p>
      </div>
    </aside>
    <div className="main">
      <header className="topbar">
        <div className="mobile-brand"><div className="brand-mark" aria-hidden="true">檔</div></div>
        <div className="page-title"><h1>{page}</h1><p>{SUBTITLE[page]}</p></div>
        <div className="topbar-actions">
          <span className="tag amber prototype-tag" title={isDemo ? '姓名、養成與圖形皆為自製測試資料，與個人庫分開保存。' : '請勿貼入密碼、Cookie 或 Token。遊戲資料來源與繁中服相容性仍須核對。'}>{isDemo ? '示範庫' : '個人庫'} · 研究原型</span>
          <div className="segmented theme-switch" role="radiogroup" aria-label="顯示模式">
            {([['light', 'sun', '淺色'], ['dark', 'moon', '深色'], ['system', 'monitor', '系統']] as const).map(([value, icon, label]) => <button type="button" key={value} role="radio" aria-checked={theme.choice === value} className={theme.choice === value ? 'active' : ''} onClick={() => theme.setChoice(value)} title={value === 'system' ? '跟隨系統設定' : `${label}模式`}><Icon name={icon} size={15}/><span>{label}</span></button>)}
          </div>
          <button type="button" className="button secondary small hide-sm" disabled={busy} onClick={downloadBackup}><Icon name="download" size={16}/>備份</button>
          <button type="button" className="button primary small" disabled={busy} onClick={() => openPanel('import')}><Icon name="plus" size={16}/>匯入</button>
        </div>
      </header>
      <main className="content" id="main">
        {!panel && <Notice notice={notice}/>}
        {page === '幹員庫' && <RosterPage key={namespace} state={state} isDemo={isDemo} busy={busy} onImport={() => openPanel('import')} onPreviewDemo={previewDemo} onOpen={id => { setSelectedId(id); openPanel('detail'); }}/>}
        <div hidden={page !== '批次修正'}><BatchEditor key={namespace} state={state} initialId={batchInitialId} onInitialHandled={() => setBatchInitialId(null)} onSave={saveBatch}/></div>
        {page === '設定' && <SettingsPage state={state} isDemo={isDemo} busy={busy} persistence={persistence} onSwitch={() => openPanel('switch')} onPreviewDemo={previewDemo} onBackup={downloadBackup} onRestoreFile={readBackupFile}
          onRequestPersistence={() => void run(async () => { const granted = await requestPersistence(); setPersistence(await queryPersistence()); setNotice({ text: granted ? '瀏覽器已授予持久儲存；這不代表永不丟失，仍須備份。' : '瀏覽器尚未授予持久儲存。你仍可使用本機庫，請定期備份。', error: false }); })}
          onUndo={() => void run(async () => { await persist(undoLastImport(state), state.revision); setNotice({ text: '最後匯入批次已撤銷，復原結果已保存。撤銷紀錄已保留。', error: false }); })}/>}
        {page === '基建' && <BasePage key={namespace} state={state} isDemo={isDemo} busy={busy} onSave={base => void run(async () => { await persist({ ...state, revision: state.revision + 1, settings: { ...state.settings, base } }, state.revision); setNotice({ text: '基建配置已保存至本機。', error: false }); })}/>}
        {page === '養成' && <GrowthPage key={namespace} state={state} isDemo={isDemo} busy={busy} onSave={growth => void run(async () => { await persist({ ...state, revision: state.revision + 1, settings: { ...state.settings, growth } }, state.revision); setNotice({ text: '養成計畫已保存至本機。', error: false }); })}/>}
        {page === '關卡' && <StagePage key={namespace} isDemo={isDemo}/>}
        {page === '搭配' && <TeamPage key={namespace} state={state} isDemo={isDemo} onSaveNotes={reviewNotes => void run(async () => { await persist({ ...state, revision: state.revision + 1, settings: { ...state.settings, reviewNotes } }, state.revision); setNotice({ text: '簡評筆記已保存至本機。', error: false }); })}/>}
        {page === '工具' && <ToolsPage key={namespace} state={state} isDemo={isDemo}/>}
      </main>
    </div>
    {nav(true)}
    {panel === 'import' && <ImportPanel isDemo={isDemo} busy={busy} notice={panelNotice} onClose={closePanel} onFile={importFile} onText={importText} onPreviewDemo={previewDemo}/>}
    {panel === 'preview' && preview && <PreviewPanel preview={preview} busy={busy} notice={panelNotice} onClose={closePanel} onAccept={acceptImport}/>}
    {panel === 'detail' && selectedRow && selectedDefinition && <DetailPanel definition={selectedDefinition} row={selectedRow} personal={!isDemo} revision={state.revision} busy={busy} notice={panelNotice} onClose={closePanel} onPreview={previewManual}
      skin={state.settings.skins?.[selectedRow.operatorId]}
      onSkin={skin => void run(async () => { const skins = { ...(state.settings.skins ?? {}) }; if (skin) skins[selectedRow.operatorId] = skin; else delete skins[selectedRow.operatorId]; const { skins: _old, ...rest } = state.settings; await persist({ ...state, revision: state.revision + 1, settings: Object.keys(skins).length ? { ...rest, skins } : rest }, state.revision); })}
      onBatch={() => { setBatchInitialId(selectedRow.operatorId); setPanel(null); setPage('批次修正'); window.scrollTo({ top: 0 }); }}/>}
    {panel === 'restore' && restored && <RestorePanel state={state} restored={restored.state} isDemo={isDemo} busy={busy} notice={panelNotice} onClose={closePanel} onBackup={downloadBackup}
      onConfirm={() => void run(async () => { if (state.revision !== restored.baseRevision) throw new Error('復原預覽已過期，請重新選取備份。'); await persist({ ...restored.state, profileId: state.profileId, revision: state.revision + 1 }, restored.baseRevision); setPanel(null); setRestored(null); setNotice({ text: '備份已通過驗證並以交易取代目前工作區，修訂版本已遞增。', error: false }); })}/>}
    {panel === 'switch' && <SwitchPanel isDemo={isDemo} rosterSize={state.roster.length} busy={busy} notice={panelNotice} onClose={closePanel} onBackup={downloadBackup}
      onConfirm={() => { const next = isDemo ? 'personal' : 'demo'; window.history.replaceState(null, '', `#${next}`); setNamespace(next); setPage('幹員庫'); }}/>}
  </div>;
}
