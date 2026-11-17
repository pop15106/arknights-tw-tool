import type { AppState } from '../domain/model';
import { describeCapacity, measureCapacity } from '../storage/capacity';
import type { queryPersistence } from '../storage/database';
import { GameDataSettings } from '../OperatorEncyclopedia';
import { Icon } from './Icon';
import { ResearchGates } from './panels';
import { formatDate, mb } from './format';

type Persistence = Awaited<ReturnType<typeof queryPersistence>> | null;

export function SettingsPage({ state, isDemo, busy, persistence, onPreviewDemo, onBackup, onRequestPersistence, onRestoreFile, onUndo }: {
  state: AppState; isDemo: boolean; busy: boolean; persistence: Persistence;
  onPreviewDemo: () => void; onBackup: () => void; onRequestPersistence: () => void; onRestoreFile: (file: File) => void; onUndo: () => void;
}) {
  const meta = state.dataset.metadata;
  const capacity = measureCapacity(state);
  const license = meta.licenseStatus === 'self-authored' ? '自製資料' : meta.licenseStatus === 'permitted' ? '來源自述已獲允許，仍需核對' : '未知，待查核';
  return <div className="settings-grid">
    <section className="panel">
      <header className="panel-header"><Icon name="database"/><h2>資料版本</h2></header>
      <dl className="meta-list">
        <div><dt>目前工作區</dt><dd>{isDemo ? '示範庫（虛構）' : '個人庫（局部）'}</dd></div>
        <div><dt>格式 / 修訂</dt><dd>v{state.schemaVersion} / {state.revision}</dd></div>
        <div><dt>資料集</dt><dd>{meta.id} / {meta.version}</dd></div>
        <div><dt>來源</dt><dd>{meta.source}</dd></div>
        <div><dt>本服有效起點</dt><dd>{formatDate(meta.validFrom)}</dd></div>
        <div><dt>授權標示</dt><dd>{license}</dd></div>
        <div><dt>取得日期</dt><dd>{formatDate(meta.acquiredAt)}</dd></div>
      </dl>
      <details className="plain-details"><summary>查看資料校驗值</summary><code className="wrap-text">{meta.checksum}</code></details>
    </section>
    <section className="panel">
      <header className="panel-header"><Icon name="shield"/><h2>本機保存與備份</h2></header>
      <p className="fine-print">IndexedDB 不是永久備份。Safari 與主畫面版本可能使用不同儲存空間；清除網站資料或換機後，需用備份復原。</p>
      <dl className="meta-list">
        <div><dt>持久儲存</dt><dd>{!persistence ? '目前無法查詢' : !persistence.supported ? '此瀏覽器未提供查詢能力' : persistence.persisted ? '已授予；仍需備份' : '尚未授予'}</dd></div>
        <div><dt>網站儲存估計</dt><dd>{persistence?.usage !== undefined ? `${mb(persistence.usage)} MB` : '未知'}{persistence?.quota !== undefined && ` / 約 ${mb(persistence.quota, 0)} MB`}<small>同一網站來源的估計值，不是本庫精確大小。</small></dd></div>
        <div><dt>最近發起下載</dt><dd>{formatDate(state.settings.lastBackupAt)}<small>請自行確認檔案已保存。</small></dd></div>
      </dl>
      <div className="inline-actions">
        <button type="button" className="button primary" disabled={busy} onClick={onBackup}><Icon name="download" size={16}/>下載 JSON 備份</button>
        <button type="button" className="button secondary" disabled={busy || !persistence?.supported} onClick={onRequestPersistence}>請求持久儲存</button>
      </div>
      <label className="field-label" htmlFor="backup-file">從本工具備份復原（先預覽，最多 20 MB）</label>
      <input id="backup-file" type="file" accept="application/json,.json" className="file-input" disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) onRestoreFile(file); event.currentTarget.value = ''; }}/>
    </section>
    <section className="panel">
      <header className="panel-header"><Icon name="undo"/><h2>批次紀錄與撤銷</h2></header>
      <div className={`capacity capacity-${capacity.level}`} role={capacity.level === 'ok' ? undefined : 'status'}>
        <div className="capacity-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.round(capacity.ratio * 100))}%` }}/></div>
        <p>保存容量：{describeCapacity(capacity)}</p>
      </div>
      <p className="fine-print">每次接受候選都會記錄來源與確認決策。只能撤銷最後一個匯入；備份復原另有整庫取代確認。</p>
      <button type="button" className="button secondary" disabled={busy || !state.undo} onClick={onUndo}><Icon name="undo" size={16}/>撤銷最後匯入批次</button>
      <ul className="history-list">{state.batches.slice(-5).reverse().map(batch => <li key={batch.id}>
        <span><strong>{batch.kind === 'undo' ? '撤銷批次' : batch.duplicateOf ? '重複匯入紀錄' : batch.source}</strong><small>{formatDate(batch.createdAt)}</small></span>
        <span className="history-counts">{batch.kind === 'import' ? `新增 ${batch.counts.added} · 更新 ${batch.counts.changed}` : '已復原'}</span>
      </li>)}{!state.batches.length && <li className="fine-print">目前沒有批次紀錄。</li>}</ul>
    </section>
    <GameDataSettings/>
    <section className="panel">
      <header className="panel-header"><Icon name="alert"/><h2>帳號 API 驗證狀態</h2></header>
      <p className="fine-print">接口線索、使用權、安全登入與欄位完整性分別驗證。帳號資料需經研究匯出與本機預覽確認。</p>
      <ResearchGates/>
    </section>
  </div>;
}

const PLANNED = {
  基建: { title: '輪班建議需要可靠的規則與起點', gaps: ['待建立真實設施配置、產品、宿舍與可上線時段。', '待核對繁中規則：單人、組隊、跨設施、心情、零心情例外與恢復。', '待以事件模擬核對資源帳目、人員互斥及可重複輪班。'] },
  養成: { title: '依模式決定投資，不共用假排行', gaps: ['主線日常、集成戰略、生息演算、保全派駐、衛戍協議各自建模。', '待核對本服技能、專精、模組的前提與成本，未知不當作未完成。', '待取得目標、預算及已核對案例，才提供具體投資順序。'] },
  搭配: { title: '從技能條件驗證聯動關係', gaps: ['同陣營僅是分類，尚不構成實際技能聯動。', '待建立觸發、時序、互斥、需求技能與模組的來源證據。', '替代方案須說明保留與失去的功能，並區分已持有及理論選項。'] },
} as const;
export type PlannedName = keyof typeof PLANNED;

export function PlannedPage({ name, onRoster, onSettings }: { name: PlannedName; onRoster: () => void; onSettings: () => void }) {
  const info = PLANNED[name];
  return <section className="panel planned">
    <span className="tag amber">尚未實作規則 · 不提供推薦</span>
    <h2>{info.title}</h2>
    <p>這個工作台目前不計算任何遊戲建議。要先有可追溯的繁中服規則，才不會產生看似精確、實際沒有根據的結果。</p>
    <ul className="gap-list">{info.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>
    <div className="inline-actions"><button type="button" className="button secondary" onClick={onRoster}>回到幹員庫</button><button type="button" className="button ghost" onClick={onSettings}>查看資料與研究狀態</button></div>
  </section>;
}
