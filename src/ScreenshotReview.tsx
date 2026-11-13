import { useEffect, useRef, useState } from 'preact/hooks';
import { parseScreenshotReviewText, type ScreenshotReview as Review } from './importers/screenshots';

// 原圖只以暫時的 Blob URL 顯示，不寫入資料庫或傳送至服務端。
export function ScreenshotReview() {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [images, setImages] = useState<Record<string, string>>(() => Object.create(null));
  const [selected, setSelected] = useState<{ assetId: string; x: number; y: number; width: number; height: number } | null>(null);
  const generation = useRef(0);
  const urls = useRef<string[]>([]);
  function clearImages() { urls.current.forEach(URL.revokeObjectURL); urls.current = []; setImages(Object.create(null)); setSelected(null); }
  useEffect(() => () => { generation.current++; urls.current.forEach(URL.revokeObjectURL); }, []);

  async function readResult(file?: File) {
    if (!file || busy) return;
    const current = ++generation.current;
    setBusy(true); setError('');
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('辨識結果上限為 10 MB。');
      const next = parseScreenshotReviewText(await file.text());
      if (current !== generation.current) return;
      clearImages(); setReview(next); setQuery('');
    } catch { if (current === generation.current) setError('無法讀取辨識結果。請選擇本機 OCR 工具產生、10 MB 以內的有效 review JSON。'); }
    finally { if (current === generation.current) setBusy(false); }
  }

  async function attachImages(files: File[]) {
    if (!review || !files.length || busy) return;
    const current = ++generation.current;
    setBusy(true); setError('');
    const staged: Record<string, string> = Object.create(null);
    const pendingUrls: string[] = [];
    try {
      if (files.length > 20 || files.reduce((total, file) => total + file.size, 0) > 80 * 1024 * 1024) throw new Error('每次最多選 20 張、合計 80 MB。');
      for (const file of files) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 15 * 1024 * 1024) throw new Error('僅接受 JPEG、PNG、WebP，每張上限 15 MB。');
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
        if (current !== generation.current) return;
        const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        const matches = review.images.filter(item => item.sha256.replace(/^sha256:/, '') === hash);
        if (!matches.length) throw new Error('有圖片與辨識結果的校驗值不符；請重選當時使用的原圖。');
        const url = URL.createObjectURL(file); pendingUrls.push(url);
        const decoded = new Image(); decoded.src = url;
        try { await decoded.decode(); } catch { throw new Error('原圖無法解碼，未載入圖片。'); }
        if (current !== generation.current) return;
        if (matches.some(match => match.width !== decoded.naturalWidth || match.height !== decoded.naturalHeight)) throw new Error('辨識結果的尺寸與實際原圖不符，無法可靠標示來源位置。');
        for (const match of matches) {
          if (staged[match.assetId]) URL.revokeObjectURL(staged[match.assetId]);
          staged[match.assetId] = url;
        }
      }
      clearImages(); urls.current = Object.values(staged); setImages(staged);
    } catch (cause) {
      pendingUrls.forEach(URL.revokeObjectURL);
      if (current === generation.current) setError(cause instanceof Error ? cause.message : '原圖未載入。');
    } finally {
      if (current !== generation.current) pendingUrls.forEach(URL.revokeObjectURL);
      else setBusy(false);
    }
  }

  const rows = review?.rows.filter(row => !query || (row.name ?? '').includes(query)) ?? [];
  const selectedImage = review?.images.find(item => item.assetId === selected?.assetId);
  return <section className="recognition-review" aria-label="多圖辨識核對">
    <h3>多圖辨識核對</h3>
    <p>選取本機 OCR 產生的結果，檢查候選值與跨圖重疊。這裡不會寫入幹員庫；姓名尚未對應正式幹員 ID，圖示欄位保留未知。</p>
    <label className="field-label" htmlFor="ocr-review-file">選擇辨識結果 JSON</label>
    <input id="ocr-review-file" type="file" accept="application/json,.json" className="file-input" disabled={busy} onChange={event => { void readResult(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }}/>
    <p className="fine-print">目前辨識引擎在 Windows 本機執行；本頁可查看結果。iPhone 直接選圖辨識尚未完成。</p>
    {busy && <p role="status">正在本機讀取檔案…</p>}
    {error && <div className="toast error" role="alert">{error}</div>}
    {review && <>
      <div className="warning-note">所有數字都是未經人工確認的 OCR 候選，重疊按完整姓名分組，不能當成正式 ID 合併或正確率。</div>
      <div className="preview-stats">
        {([['來源圖', review.summary.imageCount], ['出現列', review.summary.rowOccurrences], ['候選組', review.summary.uniqueCandidates], ['重疊列', review.summary.overlapOccurrences]] as const).map(([label, value]) => <div className="preview-stat" key={label}><strong>{value}</strong><span>{label}</span></div>)}
      </div>
      <p className="fine-print">引擎：{review.engine.name} / {review.engine.language}<br/>未對應 ID：{review.summary.unmapped} 組；半列：{review.summary.partialRows} 列。</p>
      <label className="field-label" htmlFor="ocr-originals">選擇原圖以核對位置（可多選，僅本次開啟有效）</label>
      <input id="ocr-originals" type="file" accept="image/jpeg,image/png,image/webp" multiple className="file-input" disabled={busy} onChange={event => { void attachImages(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }}/>
      <p className="fine-print">以 SHA-256 比對原檔。已載入 {Object.keys(images).length} 張；關閉視窗即釋放，不保存圖片。</p>
      <label className="field-label" htmlFor="ocr-search">篩選辨識姓名</label>
      <input id="ocr-search" className="text-input" value={query} onInput={event => setQuery(event.currentTarget.value)} placeholder="輸入完整或部分候選名稱"/>
      {selected && selectedImage && images[selected.assetId] && <figure className="ocr-source">
        <div className="ocr-source-image"><img src={images[selected.assetId]} alt="使用者選擇的辨識原圖"/><span className="ocr-highlight" style={{ left: `${selected.x / selectedImage.width * 100}%`, top: `${selected.y / selectedImage.height * 100}%`, width: `${selected.width / selectedImage.width * 100}%`, height: `${selected.height / selectedImage.height * 100}%` }}/></div>
        <figcaption>框線標示原圖列的位置；圖示狀態仍需另行驗證。</figcaption>
      </figure>}
      <div className="ocr-candidates">{rows.slice(0, 150).map(row => <article className="ocr-candidate" key={row.candidateId}>
        <div className="split-heading"><strong>{row.name ?? '姓名未辨識'}</strong><span className="tag amber">未對應 ID</span></div>
        <dl className="ocr-fields">{(['level', 'trust', 'skillLevel'] as const).map(field => <div key={field}><dt>{field === 'level' ? '等級' : field === 'trust' ? '信賴' : '技能等級'}</dt><dd>{row.fields[field].status === 'candidate' ? `${row.fields[field].value}（候選）` : row.fields[field].status === 'conflict' ? '跨圖值衝突' : '未知'}</dd></div>)}</dl>
        <div className="inline-actions">{row.sources.map((source, index) => <button type="button" className="button secondary small" key={`${source.assetId}-${index}`} disabled={!images[source.assetId]} onClick={() => setSelected({ assetId: source.assetId, ...source.bounds })}>{source.assetId}・第 {source.rowIndex} 列</button>)}</div>
        {row.issues.length > 0 && <p className="fine-print">{row.issues.join('；')}</p>}
        <details className="plain-details"><summary>查看 OCR 文字證據</summary>{(['level', 'trust', 'skillLevel'] as const).map(field => <p className="fine-print" key={field}>{field === 'level' ? '等級' : field === 'trust' ? '信賴' : '技能'}：{row.fields[field].evidence.map(item => `${item.assetId} ${item.rawText}`).join(' / ') || '未取得'}</p>)}</details>
      </article>)}</div>
      <p className="fine-print">顯示 {Math.min(rows.length, 150)}／{rows.length} 組，最多顯示 150 組；可用姓名縮小範圍。</p>
    </>}
  </section>;
}
