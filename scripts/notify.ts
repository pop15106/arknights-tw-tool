// 換班推播（Telegram）。在本機資料服務裡排程，到點時由本機發送。
// - Bot token 只存在本機 .local/notify.json（已列入 .gitignore），不進瀏覽器資料庫，也不會回傳給頁面。
// - 只接受本機頁面明確發出的 POST 請求（Origin、自訂標頭、JSON 內容大小都會檢查）。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';

export interface NotifySchedule { next: number; hours: number; text: string }
interface NotifyConfig { telegram?: { token: string; chatId: string }; schedule?: NotifySchedule }
export interface NotifyStatus { telegram: boolean; chat?: string; schedule?: NotifySchedule; lastError?: string }

const TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/u;
const CHAT = /^-?\d{1,20}$/u;
const MAX_BODY = 4096;
const HOUR = 3600_000;

export class NotifyError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface NotifierOptions { file?: string; fetch?: typeof fetch; now?: () => number }
export function createNotifier(options: NotifierOptions = {}) {
  const file = options.file ?? resolve(import.meta.dirname, '..', '.local', 'notify.json');
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let config: NotifyConfig | null = null;
  let lastError: string | undefined;
  let sending = false;

  async function load(): Promise<NotifyConfig> {
    if (config) return config;
    try { config = JSON.parse(await readFile(file, 'utf8')) as NotifyConfig; } catch { config = {}; }
    return config;
  }
  async function save(next: NotifyConfig): Promise<void> {
    config = next;
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
    await rename(temp, file);
  }
  async function telegram(token: string, method: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, body === undefined ? { method: 'GET', signal: AbortSignal.timeout(10_000) }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    } catch { throw new NotifyError(502, '連不到 Telegram，請確認網路後再試。'); }
    const data = await response.json().catch(() => null) as { ok?: boolean; result?: unknown; description?: string } | null;
    if (response.status === 401 || response.status === 404) throw new NotifyError(400, 'Bot token 不正確，請到 @BotFather 重新複製。');
    if (!response.ok || !data?.ok) throw new NotifyError(502, response.status === 403 ? '機器人被封鎖或還沒開始對話，請先在 Telegram 對機器人按「開始」。' : 'Telegram 拒絕了這次請求，請稍後再試。');
    return data.result;
  }
  const mask = (chatId: string) => chatId.length > 4 ? `…${chatId.slice(-4)}` : chatId;

  async function status(): Promise<NotifyStatus> {
    const current = await load();
    return { telegram: !!current.telegram, ...(current.telegram ? { chat: mask(current.telegram.chatId) } : {}), ...(current.schedule ? { schedule: current.schedule } : {}), ...(lastError ? { lastError } : {}) };
  }

  /** 設定機器人。沒給 chat ID 時，從機器人最近收到的私人訊息找出你的 chat ID。 */
  async function setTelegram(token: unknown, chatId: unknown): Promise<NotifyStatus> {
    if (typeof token !== 'string' || !TOKEN.test(token.trim())) throw new NotifyError(400, 'Bot token 格式不對，應該像「123456789:ABC…」。');
    if (chatId !== undefined && chatId !== '' && (typeof chatId !== 'string' || !CHAT.test(chatId.trim()))) throw new NotifyError(400, 'Chat ID 只能是數字。');
    const cleanToken = token.trim();
    await telegram(cleanToken, 'getMe');
    let chat = typeof chatId === 'string' && chatId.trim() ? chatId.trim() : '';
    if (!chat) {
      const updates = await telegram(cleanToken, 'getUpdates') as { message?: { chat?: { id?: number; type?: string } } }[];
      const found = [...(Array.isArray(updates) ? updates : [])].reverse().find(item => item.message?.chat?.type === 'private' && Number.isSafeInteger(item.message.chat.id));
      if (!found) throw new NotifyError(400, '找不到你的對話：請先在 Telegram 打開你的機器人、傳一則任意訊息，再按一次儲存。');
      chat = String(found.message!.chat!.id);
    }
    await save({ ...(await load()), telegram: { token: cleanToken, chatId: chat } });
    lastError = undefined;
    return status();
  }
  async function clearTelegram(): Promise<NotifyStatus> {
    const { telegram: _removed, ...rest } = await load();
    await save(rest);
    return status();
  }
  async function send(text: string): Promise<void> {
    const current = await load();
    if (!current.telegram) throw new NotifyError(400, '還沒設定 Telegram 機器人。');
    await telegram(current.telegram.token, 'sendMessage', { chat_id: current.telegram.chatId, text });
  }
  async function setSchedule(next: unknown, hours: unknown, text: unknown): Promise<NotifyStatus> {
    if (typeof next !== 'number' || !Number.isSafeInteger(next) || typeof hours !== 'number' || !(hours >= 1 && hours <= 24)) throw new NotifyError(400, '換班時間格式不正確。');
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new NotifyError(400, '提醒內容需為 1–1000 字。');
    let first = next; while (first <= now()) first += hours * HOUR;
    await save({ ...(await load()), schedule: { next: first, hours, text: text.trim() } });
    return status();
  }
  async function clearSchedule(): Promise<NotifyStatus> {
    const { schedule: _removed, ...rest } = await load();
    await save(rest);
    return status();
  }
  /** 到點就發送並排下一次；發送失敗也照樣往後排，避免每 30 秒重送。 */
  async function tick(): Promise<void> {
    if (sending) return;
    const current = await load();
    if (!current.schedule || !current.telegram || now() < current.schedule.next) return;
    sending = true;
    try {
      try { await send(current.schedule.text); lastError = undefined; }
      catch (error) { lastError = error instanceof NotifyError ? error.message : '推播失敗。'; }
      let next = current.schedule.next; while (next <= now()) next += current.schedule.hours * HOUR;
      await save({ ...current, schedule: { ...current.schedule, next } });
    } finally { sending = false; }
  }
  function start(intervalMs = 30_000): () => void {
    const timer = setInterval(() => { void tick().catch(() => {}); }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new NotifyError(415, '請以 JSON 送出。');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += (chunk as Buffer).length; if (size > MAX_BODY) throw new NotifyError(413, '內容太大。'); chunks.push(chunk as Buffer); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* 下方統一回報 */ }
    throw new NotifyError(400, 'JSON 格式錯誤。');
  }

  /** 處理 /api/notify/*；呼叫端已檢查 Host。這裡再檢查來源與方法。 */
  async function handle(req: IncomingMessage, res: ServerResponse, pathname: string, isAllowedOrigin: (origin: string | undefined) => boolean, reply: (res: ServerResponse, status: number, value: unknown) => void): Promise<void> {
    const action = pathname.slice('/api/notify/'.length);
    if (action === 'status') { if (req.method !== 'GET') throw new NotifyError(405, '不支援此請求方法。'); reply(res, 200, await status()); return; }
    if (!['telegram', 'telegram-clear', 'test', 'schedule', 'schedule-clear'].includes(action)) throw new NotifyError(404, '找不到此功能。');
    if (req.method !== 'POST') throw new NotifyError(405, '不支援此請求方法。');
    if (req.headers['x-notify'] !== '1' || !isAllowedOrigin(req.headers.origin)
      || (req.headers['sec-fetch-site'] !== undefined && !['same-origin', 'same-site'].includes(String(req.headers['sec-fetch-site'])))) throw new NotifyError(403, '只接受本機頁面明確發出的請求。');
    const body = await readJson(req);
    if (action === 'telegram') reply(res, 200, await setTelegram(body.token, body.chatId));
    else if (action === 'telegram-clear') reply(res, 200, await clearTelegram());
    else if (action === 'test') { await send('✅ 幹員檔案室：測試訊息，之後換班提醒會傳到這裡。'); reply(res, 200, await status()); }
    else if (action === 'schedule') reply(res, 200, await setSchedule(body.next, body.hours, body.text));
    else reply(res, 200, await clearSchedule());
  }

  return { status, setTelegram, clearTelegram, send, setSchedule, clearSchedule, tick, start, handle };
}
export type Notifier = ReturnType<typeof createNotifier>;
