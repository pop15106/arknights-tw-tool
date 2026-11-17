import { useEffect, useState } from 'preact/hooks';

const KEY = 'arknights-tw-shift-reminder';
interface Reminder { next: number; hours: number }
const read = (): Reminder | null => { try { const value = JSON.parse(localStorage.getItem(KEY) ?? 'null'); return value && Number.isFinite(value.next) && Number.isFinite(value.hours) && value.hours > 0 ? value : null; } catch { return null; } };
const write = (value: Reminder | null) => { try { if (value) localStorage.setItem(KEY, JSON.stringify(value)); else localStorage.removeItem(KEY); } catch { /* 無法保存時只在本次開啟有效 */ } };
const time = (value: number) => new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));

interface NotifyStatus { telegram: boolean; chat?: string; schedule?: { next: number; hours: number; text: string }; lastError?: string }
/** 呼叫本機資料服務的推播功能；token 只送到本機服務，不存在瀏覽器。 */
async function notifyApi(action: string, body?: Record<string, unknown>): Promise<NotifyStatus> {
  const response = await fetch(`/api/notify/${action}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Notify': '1' }, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store' } : { credentials: 'omit', cache: 'no-store' });
  const data = await response.json().catch(() => null) as (NotifyStatus & { error?: { message?: string } }) | null;
  if (!response.ok || !data) throw new Error(data?.error?.message ?? '本機資料服務沒有回應，請用 start.cmd 啟動。');
  return data;
}
const reminderText = (hours: number) => `⏰ 該換班了：基建已經過 ${hours} 小時，記得換班與收取產物。`;

function TelegramSetup({ status, onChange }: { status: NotifyStatus | null; onChange: (value: NotifyStatus) => void }) {
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const run = async (action: () => Promise<NotifyStatus>, done: string) => {
    setBusy(true); setMessage('');
    try { onChange(await action()); setMessage(done); setToken(''); } catch (error) { setMessage(error instanceof Error ? error.message : '操作失敗。'); } finally { setBusy(false); }
  };
  return <details className="telegram-setup">
    <summary>Telegram 推播{status?.telegram ? `（已連結 ${status.chat ?? ''}）` : '（未設定）'}</summary>
    {status?.telegram ? <div className="inline-actions">
      <button type="button" className="button secondary small" disabled={busy} onClick={() => void run(() => notifyApi('test', {}), '已傳送測試訊息，請到 Telegram 確認。')}>傳送測試訊息</button>
      <button type="button" className="button ghost small" disabled={busy} onClick={() => void run(() => notifyApi('telegram-clear', {}), '已移除機器人設定。')}>移除</button>
    </div> : <>
      <ol className="telegram-steps">
        <li>在 Telegram 搜尋 <b>@BotFather</b>，傳 <code>/newbot</code> 照指示建立機器人，複製它給的 token。</li>
        <li>打開你的新機器人，按「開始」或傳任意一則訊息。</li>
        <li>把 token 貼在下面按「儲存」，會自動找到你的對話。</li>
      </ol>
      <div className="inline-actions">
        <input className="text-input" type="password" autoComplete="off" placeholder="Bot token" value={token} onInput={event => setToken(event.currentTarget.value)}/>
        <input className="text-input" inputMode="numeric" placeholder="Chat ID（選填）" value={chatId} onInput={event => setChatId(event.currentTarget.value)}/>
        <button type="button" className="button secondary small" disabled={busy || !token.trim()} onClick={() => void run(() => notifyApi('telegram', { token: token.trim(), ...(chatId.trim() ? { chatId: chatId.trim() } : {}) }), '已連結，可以按「傳送測試訊息」確認。')}>儲存</button>
      </div>
    </>}
    <small>{message || status?.lastError || 'token 只存在你電腦的本機資料服務（.local 資料夾），不會存進瀏覽器或上傳。推播需要電腦開著並執行 start.cmd。'}</small>
  </details>;
}

/** 換班提醒：瀏覽器通知（頁面開著時）；設定 Telegram 後由本機資料服務推播，關掉頁面也會送。 */
export function ShiftReminder({ hours }: { hours: number }) {
  const [reminder, setReminder] = useState<Reminder | null>(read);
  const [start, setStart] = useState(() => { const date = new Date(Date.now() + hours * 3600_000); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; });
  const [message, setMessage] = useState('');
  const [notify, setNotify] = useState<NotifyStatus | null>(null);
  useEffect(() => { notifyApi('status').then(setNotify, () => setNotify(null)); }, []);
  useEffect(() => {
    if (!reminder) return;
    const timer = setInterval(() => {
      if (Date.now() < reminder.next) return;
      // 已交給 Telegram 推播時不重複跳瀏覽器通知。
      if (!notify?.schedule) { try { new Notification('該換班了', { body: `基建已經過 ${reminder.hours} 小時，記得換班與收取產物。` }); } catch { /* 通知被拒絕時只更新時間 */ } }
      let next = reminder.next; while (next <= Date.now()) next += reminder.hours * 3600_000;
      const updated = { ...reminder, next }; write(updated); setReminder(updated);
    }, 30_000);
    return () => clearInterval(timer);
  }, [reminder, notify?.schedule]);
  const enable = async () => {
    const [h, m] = start.split(':').map(Number);
    const date = new Date(); date.setHours(h || 0, m || 0, 0, 0);
    let next = date.getTime(); while (next <= Date.now()) next += hours * 3600_000;
    const notes: string[] = [];
    if (notify?.telegram) {
      try { setNotify(await notifyApi('schedule', { next, hours, text: reminderText(hours) })); notes.push('Telegram 會在換班時間推播。'); }
      catch (error) { notes.push(error instanceof Error ? error.message : 'Telegram 排程失敗。'); }
    }
    if ('Notification' in window) {
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (permission !== 'granted' && !notify?.telegram) { setMessage('沒有通知權限，請在瀏覽器設定允許此頁面通知，或設定 Telegram 推播。'); return; }
    } else if (!notify?.telegram) { setMessage('這個瀏覽器不支援通知，可以改用 Telegram 推播。'); return; }
    const value = { next, hours }; write(value); setReminder(value); setMessage(notes.join(' '));
  };
  const disable = async () => {
    write(null); setReminder(null);
    if (notify?.schedule) { try { setNotify(await notifyApi('schedule-clear', {})); } catch { /* 本機服務沒開時，下次開啟仍會顯示排程 */ } }
  };
  return <div className="gold-balance ok shift-reminder">
    <strong>換班提醒</strong>
    {reminder ? <span>下次提醒：<b>{time(reminder.next)}</b>，之後每 {reminder.hours} 小時一次。<button type="button" className="button ghost small" onClick={() => void disable()}>關閉提醒</button></span>
      : <span>下次換班時間 <input className="text-input" type="time" value={start} onInput={event => setStart(event.currentTarget.value)}/>，每 {hours} 小時提醒 <button type="button" className="button secondary small" onClick={() => void enable()}>開啟提醒</button></span>}
    <small>{message || (notify?.schedule ? `Telegram 推播已排程（下次 ${time(notify.schedule.next)}），關掉頁面也會送。` : '使用瀏覽器通知，只在這個頁面開著時有效；設定 Telegram 後關掉頁面也會推播。')}</small>
    <TelegramSetup status={notify} onChange={setNotify}/>
  </div>;
}
