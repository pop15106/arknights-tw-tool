import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNotifier } from '../scripts/notify.ts';
import { startGameDataServer } from '../scripts/game-data-server.ts';

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
type Call = { url: string; body?: unknown };
function fakeTelegram(options: { chats?: number[]; status?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (options.status) return new Response(JSON.stringify({ ok: false }), { status: options.status });
    const method = url.split('/').pop();
    const result = method === 'getUpdates' ? (options.chats ?? []).map(id => ({ message: { chat: { id, type: 'private' } } })) : method === 'getMe' ? { username: 'test_bot' } : { message_id: 1 };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}
async function setup(t: test.TestContext, telegram = fakeTelegram({ chats: [42, 987654321] }), now = () => Date.parse('2026-11-17T00:00:00Z')) {
  const dir = await mkdtemp(path.join(tmpdir(), 'notify-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'notify.json');
  return { file, telegram, notifier: createNotifier({ file, fetch: telegram.fetchImpl, now }) };
}

test('設定 token：驗證機器人，自動找到最近的私人對話，狀態不回傳 token', async t => {
  const { notifier, file, telegram } = await setup(t);
  const status = await notifier.setTelegram(TOKEN, undefined);
  assert.equal(status.telegram, true);
  assert.equal(status.chat, '…4321');
  assert.ok(!JSON.stringify(status).includes(TOKEN));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).telegram, { token: TOKEN, chatId: '987654321' });
  assert.deepEqual(telegram.calls.map(call => call.url.split('/').pop()), ['getMe', 'getUpdates']);
});

test('token 格式錯、找不到對話、token 被拒時給出可操作的說明', async t => {
  const { notifier } = await setup(t, fakeTelegram({ chats: [] }));
  await assert.rejects(notifier.setTelegram('not-a-token', undefined), /格式不對/);
  await assert.rejects(notifier.setTelegram(TOKEN, undefined), /傳一則任意訊息/);
  const rejected = await setup(t, fakeTelegram({ status: 401 }));
  await assert.rejects(rejected.notifier.setTelegram(TOKEN, '1'), /token 不正確/);
});

test('排程：到點發送一次並排下一次；發送失敗也往後排，不會每 30 秒重送', async t => {
  let clock = Date.parse('2026-11-17T00:00:00Z');
  const telegram = fakeTelegram({ chats: [42] });
  const { notifier } = await setup(t, telegram, () => clock);
  await notifier.setTelegram(TOKEN, '42');
  await notifier.setSchedule(clock + 60_000, 8, '該換班了');
  await notifier.tick();
  assert.equal(telegram.calls.filter(call => call.url.endsWith('sendMessage')).length, 0);
  clock += 61_000;
  await notifier.tick(); await notifier.tick();
  const sent = telegram.calls.filter(call => call.url.endsWith('sendMessage'));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { chat_id: '42', text: '該換班了' });
  assert.equal((await notifier.status()).schedule?.next, Date.parse('2026-11-17T00:01:00Z') + 8 * 3600_000);
});

test('本機服務：只接受本機頁面明確發出的 POST；狀態可讀', async t => {
  const { notifier } = await setup(t);
  const service = await startGameDataServer({ port: 0, load: async () => null, notifier });
  t.after(() => service.close());
  const headers = { 'Content-Type': 'application/json', Origin: service.origin, 'X-Notify': '1' };
  const ok = await fetch(`${service.origin}/api/notify/telegram`, { method: 'POST', headers, body: JSON.stringify({ token: TOKEN, chatId: '42' }) });
  assert.equal(ok.status, 200);
  assert.equal((await (await fetch(`${service.origin}/api/notify/status`)).json()).telegram, true);
  const foreign = await fetch(`${service.origin}/api/notify/test`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(foreign.status, 403);
  const noHeader = await fetch(`${service.origin}/api/notify/test`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: service.origin }, body: '{}' });
  assert.equal(noHeader.status, 403);
  const formPost = await fetch(`${service.origin}/api/notify/test`, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(formPost.status, 415);
});

test('Codex 回饋：發送中關閉提醒或移除機器人，送完不會把設定寫回來', async t => {
  let clock = Date.parse('2026-11-17T00:00:00Z');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const base = fakeTelegram({ chats: [42] });
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => { if (String(input).endsWith('sendMessage')) await gate; return base.fetchImpl(input, init); }) as typeof fetch;
  const { notifier } = await setup(t, { calls: base.calls, fetchImpl }, () => clock);
  await notifier.setTelegram(TOKEN, '42');
  await notifier.setSchedule(clock + 1000, 8, '該換班了');
  clock += 2000;
  const pending = notifier.tick();
  await new Promise(resolve => setImmediate(resolve));
  await notifier.clearSchedule();
  release(); await pending;
  assert.equal((await notifier.status()).schedule, undefined);
});

test('Codex 回饋：移除機器人時一併清除排程，頁面改回瀏覽器通知', async t => {
  const { notifier } = await setup(t);
  await notifier.setTelegram(TOKEN, '42');
  await notifier.setSchedule(Date.parse('2026-11-17T01:00:00Z'), 8, '該換班了');
  const status = await notifier.clearTelegram();
  assert.equal(status.telegram, false); assert.equal(status.schedule, undefined);
});
