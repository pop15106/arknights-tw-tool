import { useEffect, useState } from 'preact/hooks';

const KEY = 'arknights-tw-shift-reminder';
interface Reminder { next: number; hours: number }
const read = (): Reminder | null => { try { const value = JSON.parse(localStorage.getItem(KEY) ?? 'null'); return value && Number.isFinite(value.next) && Number.isFinite(value.hours) && value.hours > 0 ? value : null; } catch { return null; } };
const write = (value: Reminder | null) => { try { if (value) localStorage.setItem(KEY, JSON.stringify(value)); else localStorage.removeItem(KEY); } catch { /* 無法保存時只在本次開啟有效 */ } };
const time = (value: number) => new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));

/** 換班提醒：瀏覽器通知，只在這個頁面開著時有效（不使用背景服務）。 */
export function ShiftReminder({ hours }: { hours: number }) {
  const [reminder, setReminder] = useState<Reminder | null>(read);
  const [start, setStart] = useState(() => { const date = new Date(Date.now() + hours * 3600_000); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; });
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!reminder) return;
    const timer = setInterval(() => {
      if (Date.now() < reminder.next) return;
      try { new Notification('該換班了', { body: `基建已經過 ${reminder.hours} 小時，記得換班與收取產物。` }); } catch { /* 通知被拒絕時只更新時間 */ }
      let next = reminder.next; while (next <= Date.now()) next += reminder.hours * 3600_000;
      const updated = { ...reminder, next }; write(updated); setReminder(updated);
    }, 30_000);
    return () => clearInterval(timer);
  }, [reminder]);
  const enable = async () => {
    if (!('Notification' in window)) { setMessage('這個瀏覽器不支援通知。'); return; }
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') { setMessage('沒有通知權限，請在瀏覽器設定允許此頁面通知。'); return; }
    const [h, m] = start.split(':').map(Number);
    const date = new Date(); date.setHours(h || 0, m || 0, 0, 0);
    let next = date.getTime(); while (next <= Date.now()) next += hours * 3600_000;
    const value = { next, hours }; write(value); setReminder(value); setMessage('');
  };
  return <div className="gold-balance ok shift-reminder">
    <strong>換班提醒</strong>
    {reminder ? <span>下次提醒：<b>{time(reminder.next)}</b>，之後每 {reminder.hours} 小時一次。<button type="button" className="button ghost small" onClick={() => { write(null); setReminder(null); }}>關閉提醒</button></span>
      : <span>下次換班時間 <input className="text-input" type="time" value={start} onInput={event => setStart(event.currentTarget.value)}/>，每 {hours} 小時提醒 <button type="button" className="button secondary small" onClick={() => void enable()}>開啟提醒</button></span>}
    <small>{message || '使用瀏覽器通知，只在這個頁面開著時有效。'}</small>
  </div>;
}
