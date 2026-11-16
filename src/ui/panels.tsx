import { useState } from 'preact/hooks';
import { fieldKeys, MAX_IMPORT_BYTES, unknown, type AppState, type Evidence, type FieldConflict, type OperatorDefinition, type OwnedOperator } from '../domain/model';
import type { ImportPreview } from '../domain/import';
import { missingCount } from '../domain/roster-query';
import { OperatorEncyclopedia, OperatorPortrait } from '../OperatorEncyclopedia';
import { ReferenceDetails } from '../ReferenceDetails';
import { ScreenshotReview } from '../ScreenshotReview';
import { FieldEditor } from './FieldEditor';
import { Icon } from './Icon';
import { Modal, Notice } from './Modal';
import { fieldLabel, formatDate, isNewSourceConflict, valueText } from './format';

type NoticeValue = { text: string; error: boolean } | null;
export type Decisions = Record<string, 'keep' | 'incoming'>;

export const GATES = [
  ['G0', '使用權', '第三方用途與程式庫授權尚未通過查核。'],
  ['G1', '產品與繁中服', '公開程式線索不能證明現行本作繁中角色相容。'],
  ['G2', '安全登入與撤銷', '未驗證 iPhone 官方授權、到期、拒絕與解除連結。'],
  ['G3', '完整幹員庫', '未取得可核對持有總數的完整帳號回應。'],
  ['G4', '養成欄位', '專精、模組及其他欄位尚無本服實測樣本。'],
  ['G5', '副作用與穩定性', '未測試遊戲連線影響、更新頻率、錯誤與限流。'],
] as const;

export function ResearchGates() {
  return <ol className="gate-list">{GATES.map(([code, title, description]) => <li className="gate-row" key={code}><span className="gate-code">{code}</span><div><strong>{title}</strong><p>{description}</p></div><span className="tag amber">未通過</span></li>)}</ol>;
}

export function ImportPanel({ isDemo, busy, notice, onClose, onFile, onText, onPreviewDemo }: {
  isDemo: boolean; busy: boolean; notice: NoticeValue; onClose: () => void;
  onFile: (file: File, confirmedTw: boolean) => void; onText: (text: string, confirmedTw: boolean) => void; onPreviewDemo: () => void;
}) {
  const [confirmedTw, setConfirmedTw] = useState(false);
  const [text, setText] = useState('');
  return <Modal title="匯入幹員資料" eyebrow="資料先預覽，確認後才保存" onClose={onClose} footer={<button type="button" className="button ghost" disabled={busy} onClick={onClose}>取消</button>}>
    <Notice notice={notice}/>
    <div className="import-methods">
      <div className="method"><Icon name="file"/><div><strong>JSON 資料</strong><span className="tag">可用</span><p>本工具候選、SKPORT 研究格式或 MAA 幹員辨識結果；來源保留未驗證標記。</p></div></div>
      <div className="method"><Icon name="image"/><div><strong>多張截圖</strong><span className="tag amber">研究中</span><p>載入 Windows 本機 OCR 結果並核對原圖。</p></div></div>
      <div className="method disabled"><Icon name="film"/><div><strong>影片辨識</strong><span className="tag muted">停用</span><p>尚無解碼與抽幀成功證據。</p></div></div>
    </div>
    <div className="step-card">
      <span className="step-number">1</span>
      <label className="checkbox-line"><input type="checkbox" checked={confirmedTw} disabled={busy} onChange={event => setConfirmedTw(event.currentTarget.checked)}/><span>我已核對這份資料適用《明日方舟》本作繁中服；不只依介面語言判斷服別。</span></label>
    </div>
    <div className={`step-card ${confirmedTw ? '' : 'is-locked'}`}>
      <span className="step-number">2</span>
      <div className="step-body">
        <label className="field-label" htmlFor="import-file">選擇匯入 JSON（最多 10 MB，檔案內容留在本機）</label>
        <input id="import-file" className="file-input" type="file" accept="application/json,.json" disabled={busy || !confirmedTw} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) onFile(file, confirmedTw); event.currentTarget.value = ''; }}/>
        <p className="fine-print">研究格式會讀取本機遊戲資料服務的幹員定義，補上中文姓名、職業、星級與能力說明；不把帳號檔案送去查詢來源。</p>
        <details className="plain-details"><summary>改為貼上 JSON 文字</summary>
          <label className="field-label" htmlFor="import-json">只貼候選或研究匯出資料，勿貼登入憑證</label>
          <textarea id="import-json" className="text-area" value={text} disabled={busy} onInput={event => setText(event.currentTarget.value)} placeholder={'{"format":"skport-offline-research", ...}'}/>
          <div className="inline-actions"><button type="button" className="button primary" disabled={busy || !confirmedTw || !text.trim()} onClick={() => onText(text, confirmedTw)}>解析並預覽</button></div>
        </details>
      </div>
    </div>
    {isDemo && <div className="inline-actions"><button type="button" className="button secondary" disabled={busy} onClick={onPreviewDemo}>改用 8 名虛構示範幹員</button></div>}
    <details className="plain-details"><summary>多圖辨識核對</summary><ScreenshotReview/></details>
    <details className="plain-details"><summary>SKPORT 本機研究（非官方接入）</summary>
      <ol className="skport-steps"><li><strong>官方登入</strong><span>目前官方網站使用 GRYPH LINE 登入；本工具尚未取得可用的第三方授權契約。</span></li><li><strong>選定本作繁中角色</strong><span>需確認產品與服別，不能由繁體介面或姓名推定。</span></li><li><strong>只讀資料與欄位轉換</strong><span>離線研究轉換器保留缺值與穩定 ID；資料來源仍須核對。</span></li><li><strong>預覽、確認與保存</strong><span>沿用本機合併流程。只有確認後才寫入幹員庫。</span></li></ol>
      <p className="fine-print">登入官方網站不會自動連接本工具。非官方研究頁需先在電腦執行 npm run build 與 npm run skport；讀取結果先預覽，不自動寫入幹員庫。</p>
      <div className="inline-actions">
        <a className="button primary" href="http://127.0.0.1:5187/skport.html" target="_blank" rel="noopener noreferrer">開啟非官方本機研究 ↗</a>
        <a className="button secondary" href="https://www.skport.com/" target="_blank" rel="noopener noreferrer">SKPORT 官方網站 ↗</a>
      </div>
      <details className="plain-details"><summary>G0–G5 驗證門檻</summary><ResearchGates/></details>
    </details>
    <p className="fine-print">貼上文字上限 {MAX_IMPORT_BYTES / 1024 / 1024} MB，超過時會在解析前拒絕。</p>
  </Modal>;
}

function Pager({ total, page, setPage, busy }: { total: number; page: number; setPage: (page: number) => void; busy: boolean }) {
  if (total <= 50) return null;
  return <div className="pagination compact"><button type="button" className="button secondary small" disabled={busy || page === 0} onClick={() => setPage(page - 1)}>上一頁</button><span>第 {page + 1} / {Math.ceil(total / 50)} 頁 · 每頁 50 欄</span><button type="button" className="button secondary small" disabled={busy || (page + 1) * 50 >= total} onClick={() => setPage(page + 1)}>下一頁</button></div>;
}

export function PreviewPanel({ preview, busy, notice, onClose, onAccept }: { preview: ImportPreview; busy: boolean; notice: NoticeValue; onClose: () => void; onAccept: (decisions: Decisions, sourceAcceptedIds: string[]) => void }) {
  const [decisions, setDecisions] = useState<Decisions>({});
  const [sourceAcceptedIds, setSourceAcceptedIds] = useState<string[]>([]);
  const [batchAgreed, setBatchAgreed] = useState(false);
  const [newPage, setNewPage] = useState(0);
  const [conflictPage, setConflictPage] = useState(0);
  const [search, setSearch] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const definitions = new Map(preview.input.dataset.operators.map(definition => [definition.id, definition]));
  const unresolved = preview.conflicts.filter(conflict => !decisions[conflict.id]).length;
  const newSource = preview.conflicts.filter(isNewSourceConflict);
  const pendingNew = newSource.filter(conflict => !decisions[conflict.id]);
  const actual = preview.conflicts.filter(conflict => !isNewSourceConflict(conflict));
  const query = search.trim().toLocaleLowerCase();
  const candidates = preview.input.candidates.filter(candidate => {
    const definition = definitions.get(candidate.operatorId);
    return !query || [candidate.operatorId, definition?.displayName ?? '', ...(definition?.aliases ?? [])].some(value => value.toLocaleLowerCase().includes(query));
  });
  const decide = (id: string, choice: 'keep' | 'incoming') => { setDecisions(current => ({ ...current, [id]: choice })); setSourceAcceptedIds(current => current.filter(item => item !== id)); };
  const renderConflict = (conflict: FieldConflict) => {
    const definition = definitions.get(conflict.operatorId), accepted = sourceAcceptedIds.includes(conflict.id);
    return <div className="conflict" key={conflict.id}>
      <h4>{definition?.displayName ?? conflict.operatorId} ／ {fieldLabel(conflict.field, definition)}</h4>
      <p className="fine-print">{conflict.reasons.join('；')}</p>
      {accepted && <p className="source-acceptance-note">已選擇採用來源值；保留低信心與未經人工確認。</p>}
      <div className="conflict-options">{(['keep', 'incoming'] as const).map(choice => {
        const evidence = choice === 'keep' ? conflict.current : conflict.incoming;
        return <label className="choice" key={choice}>
          <input type="radio" name={conflict.id} checked={decisions[conflict.id] === choice} disabled={busy} onChange={() => decide(conflict.id, choice)}/>
          <span><span className="choice-label">{choice === 'keep' ? '保留既有紀錄' : '採用新值'}</span><strong>{valueText(evidence, conflict.field, definition)}</strong>
            <span className="fine-print">{evidence.source}<br/>資料：{formatDate(evidence.observedAt)} · 匯入：{formatDate(evidence.importedAt)}<br/>{evidence.manuallyConfirmed ? '已人工確認' : '未經人工確認'}{evidence.confidence !== undefined && ` · 來源信心分數 ${evidence.confidence}（非正確機率）`}</span></span>
        </label>;
      })}</div>
    </div>;
  };
  const blocked = unresolved > 0;
  return <Modal size="lg" title="確認這次匯入" eyebrow="候選預覽 / 尚未寫入" onClose={onClose} footer={<>
    <span className="footer-status">{blocked ? `尚有 ${unresolved} 個衝突待決定` : '可以保存'}</span>
    <button type="button" className="button ghost" disabled={busy} onClick={onClose}>取消匯入</button>
    <button type="button" className="button primary" disabled={busy || blocked} onClick={() => onAccept(decisions, sourceAcceptedIds)}>{busy ? '保存中…' : '確認合併並保存'}</button>
  </>}>
    <Notice notice={notice}/>
    <div className="preview-stats">{([['新增', preview.counts.added], ['更新', preview.counts.changed], ['重複', preview.counts.repeated], ['衝突欄位', preview.counts.conflicts], ['缺漏欄位', preview.counts.missing]] as const).map(([label, value]) => <div className="preview-stat" key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
    <p className="callout">{preview.input.completeness === 'partial' ? '局部資料：未出現的幹員不會被刪除，缺值保持未知。' : '來源自述完整；完整性尚未獨立驗證。本流程只合併，不刪除未出現的幹員。'}{preview.duplicateOf && ' 此內容曾匯入，將保留重複批次紀錄，不新增重複幹員。'}</p>
    {preview.moduleIssues.length > 0 && <section className="callout danger" role="alert" aria-label="模組矛盾"><strong>模組紀錄互相矛盾（{preview.moduleIssues.length} 項）</strong><ul>{preview.moduleIssues.slice(0, 20).map(issue => <li key={`${issue.operatorId}/${issue.moduleId}/${issue.message}`}>{issue.message}</li>)}</ul>{preview.moduleIssues.length > 20 && <p>另有 {preview.moduleIssues.length - 20} 項。</p>}<p className="fine-print">若矛盾來自衝突欄位，可選擇保留既有值後再保存；其餘請修正來源或一併調整解鎖、等級與裝備。</p></section>}
    <dl className="meta-list"><div><dt>來源</dt><dd>{preview.input.source}</dd></div><div><dt>資料集</dt><dd>{preview.input.dataset.metadata.id} / {preview.input.dataset.metadata.version}</dd></div><div><dt>預覽依據</dt><dd>修訂 {preview.baseRevision}；其他分頁修改後保存會被拒絕</dd></div></dl>
    {newSource.length > 0 && <section className="review-block" aria-label="批次採用新資料">
      <h3>新欄位的來源確認 <span className="count">{newSource.length}</span></h3>
      <p>這些欄位目前為未知，只有「來源信心較低」的提醒。可一併採用；來源分數與未經人工確認的狀態會保留。已有不同值、人工確認、時間較舊或同批矛盾的欄位，仍須逐欄決定。</p>
      {pendingNew.length > 0 && <div className="review-actions">
        <label className="checkbox-line"><input type="checkbox" checked={batchAgreed} disabled={busy} onChange={event => setBatchAgreed(event.currentTarget.checked)}/><span>我同意採用尚未選擇的 {pendingNew.length} 個新欄位，並保留來源未驗證與低信心標記。</span></label>
        <button type="button" className="button primary small" disabled={busy || !batchAgreed} onClick={() => { const ids = pendingNew.map(conflict => conflict.id); setDecisions(current => ({ ...current, ...Object.fromEntries(ids.map(id => [id, 'incoming' as const])) })); setSourceAcceptedIds(current => [...new Set([...current, ...ids])]); setBatchAgreed(false); }}>採用這批新資料（{pendingNew.length} 欄）</button>
      </div>}
      {sourceAcceptedIds.length > 0 && <div className="inline-actions"><span className="source-acceptance-note" role="status">已選擇 {sourceAcceptedIds.length} 欄；尚未保存，未標記人工確認。</span><button type="button" className="button ghost small" disabled={busy} onClick={() => { setDecisions(current => Object.fromEntries(Object.entries(current).filter(([id]) => !sourceAcceptedIds.includes(id)))); setSourceAcceptedIds([]); setBatchAgreed(false); }}>取消批次採用</button></div>}
      <details className="plain-details"><summary>逐欄查看這 {newSource.length} 個新欄位</summary><p className="fine-print">個別更改選項會按逐欄人工決策記錄；批次按鈕只採用來源資料。</p><Pager total={newSource.length} page={newPage} setPage={setNewPage} busy={busy}/>{newSource.slice(newPage * 50, (newPage + 1) * 50).map(renderConflict)}<Pager total={newSource.length} page={newPage} setPage={setNewPage} busy={busy}/></details>
    </section>}
    {actual.length > 0 && <section className="review-block">
      <h3>逐欄核對衝突 <span className="count">{actual.length}</span></h3>
      <p className="fine-print">這些欄位不會由批次按鈕選取。請核對來源、時間及人工確認紀錄後逐欄決定，未選擇的項目會阻止保存。</p>
      <Pager total={actual.length} page={conflictPage} setPage={setConflictPage} busy={busy}/>{actual.slice(conflictPage * 50, (conflictPage + 1) * 50).map(renderConflict)}<Pager total={actual.length} page={conflictPage} setPage={setConflictPage} busy={busy}/>
    </section>}
    <section className="review-block">
      <h3>候選幹員 <span className="count">{preview.input.candidates.length}</span></h3>
      <label className="search-field"><Icon name="search" size={16}/><input type="search" aria-label="搜尋候選幹員名稱或 ID" value={search} onInput={event => { setSearch(event.currentTarget.value); setDetailId(null); }} placeholder="輸入名稱、別名或 ID"/></label>
      <div className="candidate-list">{candidates.slice(0, 100).map((candidate, index) => {
        const definition = definitions.get(candidate.operatorId), expanded = detailId === candidate.operatorId;
        return <article className="candidate-preview" key={`${candidate.operatorId}-${index}`}>
          <div className="candidate-row">
            <div className="candidate-identity">{definition && <div className="candidate-avatar"><OperatorPortrait definition={definition}/></div>}<div><strong>{definition?.displayName ?? candidate.operatorId}</strong><span className="fine-print">{definition ? `${missingCount(candidate, definition)} 欄未知` : '資料定義待補'}</span></div></div>
            {definition && <button type="button" className="button ghost small" aria-expanded={expanded} aria-controls={expanded ? `candidate-ability-${index}` : undefined} aria-label={`${expanded ? '收合' : '檢視'}${definition.displayName}能力`} onClick={() => setDetailId(expanded ? null : candidate.operatorId)}>{expanded ? '收合' : '能力'}</button>}
          </div>
          {expanded && definition && <div id={`candidate-ability-${index}`} className="candidate-ability"><OperatorEncyclopedia definition={definition} row={candidate}/></div>}
        </article>;
      })}</div>
      <p className="fine-print">{candidates.length > 100 ? `符合條件的 ${candidates.length} 筆中顯示前 100 筆。` : query ? `符合條件：${candidates.length} 筆。` : ''}確認會處理全部 {preview.input.candidates.length} 筆候選，搜尋不會排除匯入資料。</p>
    </section>
  </Modal>;
}

export function DetailPanel({ definition, row, personal, revision, busy, notice, onClose, onBatch, onPreview }: {
  definition: OperatorDefinition; row: OwnedOperator; personal: boolean; revision: number; busy: boolean; notice: NoticeValue;
  onClose: () => void; onBatch: () => void; onPreview: (field: string, evidence: Evidence) => void;
}) {
  const [tab, setTab] = useState<'ability' | 'fields'>('ability');
  return <Modal size="lg" title={definition.displayName} eyebrow={`${definition.profession} · ${definition.rarity} 星 · ${definition.id}`} onClose={onClose} footer={<>
    <button type="button" className="button secondary" onClick={onBatch}><Icon name="edit" size={16}/>在批次修正中開啟</button>
    <button type="button" className="button primary" disabled={busy} onClick={onClose}>完成</button>
  </>}>
    <Notice notice={notice}/>
    <div className="tabs" role="tablist" aria-label="幹員詳情分頁">
      <button type="button" role="tab" aria-selected={tab === 'ability'} className={tab === 'ability' ? 'active' : ''} onClick={() => setTab('ability')}>能力與圖鑑</button>
      <button type="button" role="tab" aria-selected={tab === 'fields'} className={tab === 'fields' ? 'active' : ''} onClick={() => setTab('fields')}>養成紀錄與修正</button>
    </div>
    {tab === 'ability' ? <ReferenceDetails key={`${row.operatorId}-${revision}`} definition={definition} row={row} personal={personal}/> : <>
      <p className="fine-print">每個欄位可獨立改為已知、未知或不適用。修正先進入候選預覽，接受後保留人工來源；這是例外修正流程，大量調整請用批次修正。</p>
      <div className="evidence-list">{fieldKeys(definition).map(field => <FieldEditor key={`${row.operatorId}-${field}-${revision}`} field={field} evidence={row.fields[field] ?? unknown('來源未提供此欄位')} definition={definition} busy={busy} onPreview={onPreview}/>)}</div>
    </>}
  </Modal>;
}

export function RestorePanel({ state, restored, isDemo, busy, notice, onClose, onBackup, onConfirm }: {
  state: AppState; restored: AppState; isDemo: boolean; busy: boolean; notice: NoticeValue; onClose: () => void; onBackup: () => void; onConfirm: () => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const restoreIds = new Set(restored.roster.map(row => row.operatorId)), currentIds = new Set(state.roster.map(row => row.operatorId));
  const added = restored.roster.filter(row => !currentIds.has(row.operatorId)).length;
  const removed = state.roster.filter(row => !restoreIds.has(row.operatorId)).length;
  const changed = restored.roster.filter(row => currentIds.has(row.operatorId) && JSON.stringify(row) !== JSON.stringify(state.roster.find(old => old.operatorId === row.operatorId))).length;
  return <Modal title="預覽備份復原" eyebrow="整庫取代 / 請先備份目前資料" onClose={onClose} footer={<>
    <button type="button" className="button ghost" disabled={busy} onClick={onClose}>取消復原</button>
    <button type="button" className="button danger" disabled={busy || !agreed} onClick={onConfirm}>{busy ? '復原中…' : '確認取代並復原'}</button>
  </>}>
    <Notice notice={notice}/>
    <p className="callout warning">此操作會以備份取代目前{isDemo ? '示範' : '個人'}庫的幹員、設定與批次歷史。未包含在備份的幹員將移除；復原不能用「撤銷最後匯入」返回。另一個工作區不受影響。</p>
    <div className="preview-stats three"><div className="preview-stat"><strong>{added}</strong><span>新增幹員</span></div><div className="preview-stat"><strong>{changed}</strong><span>變更幹員</span></div><div className="preview-stat danger"><strong>{removed}</strong><span>移除幹員</span></div></div>
    <dl className="meta-list">
      <div><dt>幹員總數</dt><dd>{state.roster.length} → {restored.roster.length}</dd></div>
      <div><dt>資料集版本</dt><dd>{state.dataset.metadata.id} / {state.dataset.metadata.version} → {restored.dataset.metadata.id} / {restored.dataset.metadata.version}</dd></div>
      <div><dt>設定</dt><dd>{JSON.stringify(state.settings) === JSON.stringify(restored.settings) ? '內容相同' : '內容不同，將採用備份設定'}</dd></div>
      <div><dt>批次紀錄</dt><dd>{state.batches.length} → {restored.batches.length} 筆，以備份內容取代</dd></div>
    </dl>
    <div className="inline-actions"><button type="button" className="button secondary" disabled={busy} onClick={onBackup}><Icon name="download" size={16}/>先下載目前資料備份</button></div>
    <p className="fine-print">下載備份會更新修訂版本，之後請重新選取待復原檔，取得最新差異預覽。</p>
    <label className="checkbox-line"><input type="checkbox" checked={agreed} onChange={event => setAgreed(event.currentTarget.checked)} disabled={busy}/><span>我已確認備份檔可取用，並理解此復原會取代目前工作區的內容。</span></label>
  </Modal>;
}

export function SwitchPanel({ isDemo, rosterSize, busy, notice, onClose, onBackup, onConfirm }: { isDemo: boolean; rosterSize: number; busy: boolean; notice: NoticeValue; onClose: () => void; onBackup: () => void; onConfirm: () => void }) {
  return <Modal title={`切換至${isDemo ? '個人' : '示範'}工作區`} eyebrow="兩份資料庫獨立保存" onClose={onClose} footer={<>
    <button type="button" className="button ghost" disabled={busy} onClick={onClose}>取消</button>
    <button type="button" className="button primary" disabled={busy} onClick={onConfirm}>確認切換</button>
  </>}>
    <p>目前 {rosterSize} 名幹員會留在原工作區，切換不會搬移或混合資料。首次個人工作區為空庫；私人 JSON 不可匯入示範庫。批次修正的未保存草稿會在切換時清除。</p>
    <p className="callout warning">建議先下載目前資料備份，並確認檔案已保存。兩個庫仍可能一起被瀏覽器清除。</p>
    <button type="button" className="button secondary" disabled={busy} onClick={onBackup}><Icon name="download" size={16}/>下載目前工作區備份</button>
    <Notice notice={notice}/>
  </Modal>;
}
