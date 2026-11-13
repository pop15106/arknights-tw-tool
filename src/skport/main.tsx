import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { authorizeWithOfficialSdk, clearOfficialSdkSession } from './sdk';
import '../styles.css';
import './research.css';

interface Role { key: string; label: string; serverLabel: string }
interface LocalSession { csrf: string; authenticated: boolean; roles: Role[]; expiresAt: string }
interface Roster { document: { format: string; schemaVersion: number; gameData: { code: number; data: { chars: Array<Record<string, unknown>> } } }; retrievedAt: string; serverUnverified: true; summary: { count: number; fields: string[] } }
class LocalApiError extends Error { code: string; constructor(message: string, code: string) { super(message); this.code = code; } }
function ResearchPage() {
  const [session, setSession] = useState<LocalSession | null>(null);
  const [roleKey, setRoleKey] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState('正在連線至本機服務…');
  const [error, setError] = useState(false);
  const [roster, setRoster] = useState<Roster | null>(null);
  const generation = useRef(0);
  const authController = useRef<AbortController | null>(null);
  async function request<T>(path: string, data?: unknown, csrf = session?.csrf): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(45_000),
        headers: { 'X-Local-Research': '1', ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf ?? '' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
    } catch { throw new Error('無法連線至本機服務。請確認 npm run skport 正在執行。'); }
    let result: { error?: { message?: string; stage?: string; code?: string; diagnostic?: { field: string; expected: string; actual: string } } };
    try { result = await response.json(); } catch { throw new Error('本頁需要由本機研究服務開啟，請使用 http://127.0.0.1:5187/skport.html。'); }
    if (!response.ok) {
      const detail = result.error?.diagnostic;
      const trace = response.headers.get('X-Audit-Request-Id');
      const message = result.error?.message ? `${result.error.message}${result.error.stage ? `（階段：${result.error.stage}）` : ''}` : '本機服務無法完成此步驟。';
      throw new LocalApiError(`${message}${detail ? ` 欄位：${detail.field}；預期：${detail.expected}；收到：${detail.actual}。` : ''}${trace ? ` 追蹤碼：${trace}` : ''}`, result.error?.code ?? 'UNKNOWN');
    }
    return result as T;
  }
  async function bootstrap() {
    const current = await request<LocalSession>('/api/session'); setSession(current);
    setNotice(current.authenticated ? '本機連線已就緒，請選擇角色。' : '本機代理已就緒。按下登入後才啟用轉送並載入官方登入元件。'); setError(false);
  }
  useEffect(() => { void bootstrap().catch(error => { setNotice(error.message); setError(true); }); }, []);
  async function login() {
    authController.current?.abort();
    const controller = new AbortController(); authController.current = controller;
    const operation = ++generation.current; setBusy(true); setError(false); setRoster(null); setNotice('正在開啟官方登入元件…');
    try {
      await request('/api/sdk-start', {});
      if (generation.current !== operation) throw new Error('此登入已取消。');
      const status = await authorizeWithOfficialSdk(async code => {
        if (generation.current !== operation) throw new Error('此登入已取消。');
        setNotice('登入回呼已收到，正在確認本帳號的《明日方舟》角色…');
        const next = await request<LocalSession>('/api/login', { code });
        if (generation.current === operation) { setSession(next); setRoleKey(''); setConfirmed(false); }
      }, controller.signal);
      if (status === 'cancelled' && generation.current === operation) {
        await request('/api/sdk-stop', {});
        await clearOfficialSdkSession();
      }
      if (generation.current === operation) setNotice(status === 'cancelled' ? '已取消登入。沒有讀取幹員資料。' : '登入連線完成。請核對下方角色清單。');
    } catch (error) {
      if (generation.current === operation) {
        let cleanupFailed = false;
        try { await request('/api/sdk-stop', {}); } catch { cleanupFailed = true; }
        await clearOfficialSdkSession();
        if (generation.current === operation) {
          setNotice(`${error instanceof Error ? error.message : '登入失敗。'}${cleanupFailed ? ' 本機清理未確認，請按清除本機連線。' : ''}`); setError(true);
        }
      }
    }
    finally { if (authController.current === controller) authController.current = null; if (generation.current === operation) setBusy(false); }
  }
  async function read() {
    const operation = ++generation.current;
    setBusy(true); setError(false); setRoster(null); setNotice('正在唯讀取得所選角色的幹員資料…');
    try { const result = await request<Roster>('/api/roster', { roleKey, confirmedTw: confirmed }); if (operation === generation.current) { setRoster(result); setNotice(`已取得 ${result.summary.count} 筆幹員候選。請核對數量與欄位，再下載研究 JSON。`); } }
    catch (error) { if (operation === generation.current) { setNotice(error instanceof Error ? error.message : '讀取失敗。'); setError(true); } }
    finally { if (operation === generation.current) setBusy(false); }
  }
  async function clear() {
    authController.current?.abort(); authController.current = null;
    ++generation.current; setBusy(true); setClearing(true); setRoster(null); setError(false);
    try {
      // 先用目前已知 CSRF 撤銷；登入回應可能尚未送達，不能先建立另一個匿名工作階段。
      let clearCsrf = session?.csrf;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await request('/api/clear', {}, clearCsrf); break; }
        catch (error) {
          if (attempt === 1 || !(error instanceof LocalApiError) || !['CSRF', 'SESSION_ENDED'].includes(error.code)) throw error;
          clearCsrf = (await request<LocalSession>('/api/session')).csrf;
        }
      }
      await clearOfficialSdkSession();
      setSession(null); setRoleKey(''); setConfirmed(false);
      // 重新載入可丟棄官方 SDK 的舊視窗與記憶體；本機工作階段已先在後端失效。
      window.location.reload();
    }
    catch (error) { setNotice(error instanceof Error ? error.message : '清除失敗。'); setError(true); }
    finally { setBusy(false); setClearing(false); }
  }
  function download() {
    if (!roster) return;
    const blob = new Blob([JSON.stringify(roster.document, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `skport-research-${new Date().toISOString().slice(0,10)}.json`; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setNotice('已發起研究 JSON 下載，請確認檔案已保存。');
  }
  return <main className="research-shell">
    <header><a href="http://127.0.0.1:5173/" target="_blank" rel="noopener noreferrer">← 幹員檔案室</a><span className="tag amber">非官方 · 僅本機研究</span></header>
    <p className="eyebrow">SKPORT / READ-ONLY LOCAL RESEARCH</p><h1>把你的幹員資料帶回本機</h1>
    <p className="research-lead">使用官方登入元件驗證帳號，嘗試讀取你選定角色的幹員清單。這是自製接入，尚未獲官方支援或完成繁中服實測。</p>
    <section className="panel"><h2>1. 連線至 SKPORT</h2>
      <p>使用官方登入表單，經這台電腦的本機代理連至官方帳號服務。帳密會短暫經過本機服務轉送，不寫入檔案或紀錄；連線憑證只留在記憶體，15 分鐘後失效。</p>
      <div className="inline-actions"><button className="button primary" disabled={busy || !session || session.authenticated} onClick={() => void login()}>{session?.authenticated ? '本機連線已建立' : '透過本機代理登入'}</button><button className="button secondary" disabled={!session || clearing} onClick={() => void clear()}>{clearing ? '正在清除…' : '清除本機連線'}</button></div>
      <p className="fine-print">目前只接通既有帳號的密碼登入與本次授權；信箱驗證碼、註冊、重設密碼與帳號設定不在代理範圍。官方 SDK 在本頁執行，登入狀態暫存於本機工作階段；清除連線不等於官方授權撤銷。請勿將此頁部署至網路。</p>
      <p className="fine-print">本機 audit log 保存在專案 .local/audit/skport-audit.jsonl；記錄操作結果與安全診斷，不包含帳密、角色名稱或完整回應。錯誤追蹤碼可用來對照紀錄。</p>
    </section>
    <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{notice}</div>
    {session?.authenticated && <section className="panel"><h2>2. 選擇本作繁中服角色</h2>
      {!session.roles.length ? <p className="warning-note">登入成功，但回應中沒有可讀取的《明日方舟》本作角色。尚未取得幹員資料，也不會改讀《終末地》角色。</p> : <>
        <label className="field-label" htmlFor="skport-role">帳號回傳的《明日方舟》角色</label><select id="skport-role" className="filter" disabled={busy} value={roleKey} onChange={e => { setRoleKey(e.currentTarget.value); setConfirmed(false); setRoster(null); }}><option value="">請選擇角色</option>{session.roles.map(role => <option key={role.key} value={role.key}>{role.label} · {role.serverLabel || '服別未提供'}</option>)}</select>
        <label className="checkbox-line"><input type="checkbox" checked={confirmed} disabled={busy || !roleKey} onChange={e => setConfirmed(e.currentTarget.checked)}/><span>我確認所選角色是《明日方舟》本作繁中服。繁體介面本身不代表資料服別。</span></label>
        <button className="button primary" disabled={busy || !roleKey || !confirmed} onClick={() => void read()}>唯讀取得幹員資料</button>
      </>}
    </section>}
    {roster && <section className="panel"><h2>3. 檢視與下載研究結果</h2><p><strong>{roster.summary.count} 筆</strong>幹員候選 · {new Date(roster.retrievedAt).toLocaleString('zh-TW')}</p><p>資料仍標示為局部；尚未對照遊戲內總數，也尚未確認潛能與模組欄位的語義。不會自動寫入幹員庫。</p>
      <div className="research-table"><table><thead><tr><th>幹員 ID</th><th>等級</th><th>精英階段</th><th>技能等級</th><th>信賴</th></tr></thead><tbody>{roster.document.gameData.data.chars.slice(0, 50).map((char, index) => <tr key={index}><td>{String(char.charId ?? '未知')}</td>{['level','evolvePhase','mainSkillLvl','favorPercent'].map(field => <td key={field}>{typeof char[field] === 'number' ? char[field] as number : '未知'}</td>)}</tr>)}</tbody></table></div>
      <p className="fine-print">畫面最多顯示前 50 筆；下載包含本次全部候選。此 JSON 是本工具的研究封裝，非官方匯出格式，沒有帳號憑證或使用者 ID。</p><button className="button primary" onClick={download}>下載幹員研究 JSON</button>
    </section>}
  </main>;
}
render(<ResearchPage/>, document.getElementById('app')!);
