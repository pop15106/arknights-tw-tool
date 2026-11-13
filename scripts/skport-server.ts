import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SkportClient, SkportClientError } from './skport-client.ts';
import { SkportLoginProxy, SkportProxyError } from './skport-proxy.ts';
import { createSkportAuditWriter } from './skport-audit.ts';

const DEFAULT_PORT = 5187;
const SESSION_TTL = 15 * 60_000;
const COOKIE = 'skport_local';
const MAX_BODY = 8192;
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
type Client = Pick<SkportClient, 'exchangeCode' | 'getBindings' | 'readRoster' | 'clear'>;
type LoginProxy = Pick<SkportLoginProxy, 'forward' | 'clear'>;
interface Session { id: string; csrf: string; expiresAt: number; client: Client; proxy: LoginProxy | null; proxyReads: number[]; authenticated: boolean; busy: boolean; reads: number[] }
interface ServerOptions { port?: number; clientFactory?: () => Client; proxyFactory?: () => LoginProxy; clock?: () => number; sessionTtlMs?: number; audit?: (event: Record<string, unknown>) => Promise<void> }
class LocalError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const random = () => randomBytes(32).toString('base64url');
function equal(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function safeHeaders(res: ServerResponse, sdkPage = false): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // SDK dynamically loads its official UI and styles. No arbitrary inline scripts or eval.
  res.setHeader('Content-Security-Policy', sdkPage
    ? "default-src 'self'; script-src 'self' https://web-api.gryphline.com https://web-static.hg-cdn.com; connect-src 'self' https://*.gryphline.com https://*.skport.com https://web-static.hg-cdn.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.hg-cdn.com https://*.gryphline.com https://*.skport.com; font-src 'self' data: https://*.hg-cdn.com; frame-src https://*.gryphline.com https://*.skport.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://*.gryphline.com"
    : "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
}
function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  safeHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
function setCookie(res: ServerResponse, id: string, ttlMs: number): void {
  // Loopback HTTP only; production HTTPS deployment is deliberately unsupported.
  res.setHeader('Set-Cookie', `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}`);
}
async function body(req: IncomingMessage, allowed: string[]): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(req.headers['content-type'] ?? '')) throw new LocalError(415, 'CONTENT_TYPE', '只接受 JSON。');
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new LocalError(413, 'BODY_LIMIT', '請求過大。');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > MAX_BODY) throw new LocalError(413, 'BODY_LIMIT', '請求過大。');
    chunks.push(bytes);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new LocalError(400, 'JSON', 'JSON 格式無效。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new LocalError(400, 'SCHEMA', '請求欄位無效。');
  return value as Record<string, unknown>;
}

export async function startSkportServer(options: ServerOptions = {}) {
  const clock = options.clock ?? Date.now;
  const ttl = options.sessionTtlMs ?? SESSION_TTL;
  const sessions = new Map<string, Session>();
  // 輪換前的 cookie 只可搭配原 CSRF 撤銷後繼工作階段，不能拿來讀資料。
  const clearLinks = new Map<string, { csrf: string; successor: Session; expiresAt: number }>();
  const loginAttempts: number[] = [], passwordAttempts: number[] = [], bootstrapAttempts: number[] = [];
  let origin = '', host = '';
  const factory = options.clientFactory ?? (() => new SkportClient());
  const proxyFactory = options.proxyFactory ?? (() => new SkportLoginProxy());
  const pendingAudits = new Set<Promise<void>>();
  function audit(event: Record<string, unknown>): Promise<void> {
    if (!options.audit) return Promise.resolve();
    const pending = Promise.resolve().then(() => options.audit!(event)).catch(() => {
      console.error('SKPORT audit log 寫入失敗；這筆操作可能沒有保存，請檢查本機磁碟與目錄權限。');
    }).finally(() => pendingAudits.delete(pending));
    pendingAudits.add(pending); return pending;
  }
  function remove(session: Session) {
    session.proxy?.clear(); session.client.clear(); sessions.delete(session.id);
    for (const [id, link] of clearLinks) if (link.successor === session) clearLinks.delete(id);
  }
  function prune() {
    for (const session of sessions.values()) if (session.expiresAt <= clock()) { remove(session); void audit({ event: 'session_expired', outcome: 'success' }); }
    for (const [id, link] of clearLinks) if (link.expiresAt <= clock() || sessions.get(link.successor.id) !== link.successor) clearLinks.delete(id);
  }
  function limit(list: number[], count: number, windowMs: number) {
    while (list.length && list[0] <= clock() - windowMs) list.shift();
    if (list.length >= count) throw new LocalError(429, 'RATE_LIMIT', '操作太頻繁，請稍後再試。');
    list.push(clock());
  }
  function newSession() {
    if (sessions.size >= 10) throw new LocalError(429, 'SESSION_LIMIT', '本機工作階段已達上限，請稍後再試。');
    const session: Session = { id: random(), csrf: random(), expiresAt: clock() + ttl, client: factory(), proxy: null, proxyReads: [], authenticated: false, busy: false, reads: [] };
    sessions.set(session.id, session); return session;
  }
  function cookieId(req: IncomingMessage): string | undefined {
    const cookies = (req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${COOKIE}=`));
    if (cookies.length !== 1) return;
    return cookies[0].slice(COOKIE.length + 1);
  }
  function findSession(req: IncomingMessage): Session | undefined {
    const id = cookieId(req); return id === undefined ? undefined : sessions.get(id);
  }
  function findClearSession(req: IncomingMessage): Session {
    const id = cookieId(req);
    const current = id === undefined ? undefined : sessions.get(id);
    const link = id === undefined ? undefined : clearLinks.get(id);
    const pending = link && link.expiresAt > clock() && sessions.get(link.successor.id) === link.successor ? link : undefined;
    const target = current ?? pending?.successor;
    if (!target) throw new LocalError(401, 'SESSION_ENDED', '本機工作階段已結束，請重新開啟連線。');
    if (!equal(req.headers['x-csrf-token'], current?.csrf ?? pending!.csrf)) throw new LocalError(403, 'CSRF', '頁面已過期，請重新整理後再試。');
    stillActive(target); return target;
  }
  function publicSession(session: Session) {
    return { csrf: session.csrf, authenticated: session.authenticated, roles: session.client.getBindings(), expiresAt: new Date(session.expiresAt).toISOString() };
  }
  function stillActive(session: Session) {
    if (sessions.get(session.id) !== session || session.expiresAt <= clock()) throw new LocalError(401, 'SESSION_ENDED', '本機工作階段已結束，請重新開啟連線。');
  }
  async function sdkApi(req: IncomingMessage, res: ServerResponse, auditEvent: Record<string, unknown>) {
    // 官方 SDK 無自訂 CSRF header hook；此分支改為強制同源 Fetch Metadata，不接受缺值或導航請求。
    if (req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-dest'] !== 'empty'
      || (req.headers.origin !== undefined && req.headers.origin !== origin)) throw new LocalError(403, 'ORIGIN', '登入代理只接受本機同源頁面的請求。');
    if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) throw new LocalError(405, 'METHOD', '不支援此登入請求方法。');
    if (req.method !== 'GET' && req.headers.origin !== origin) throw new LocalError(403, 'ORIGIN', '登入代理只接受本機同源頁面的請求。');
    prune();
    const session = findSession(req);
    if (!session) throw new LocalError(401, 'SESSION_ENDED', '本機工作階段已結束，請重新開啟連線。');
    const proxy = session.proxy;
    if (!proxy) throw new LocalError(403, 'PROXY_NOT_STARTED', '請先從本機頁面啟動登入代理。');
    const path = req.url!.slice('/api/sdk'.length);
    let input: Record<string, unknown> | undefined;
    if (req.method === 'POST') input = await body(req, ['email', 'password', 'captcha', 'token', 'appCode', 'type', 'content']);
    else if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) throw new LocalError(400, 'BODY', '此請求方法不接受內容。');
    stillActive(session);
    if (session.proxy !== proxy) throw new LocalError(401, 'SESSION_ENDED', '登入代理已停止或重新開始。');
    limit(session.proxyReads, 40, 60_000);
    if (path.split('?')[0] === '/account/user/auth/v1/token_by_email_password') limit(passwordAttempts, 5, 15 * 60_000);
    const headers: Record<string, string | undefined> = {};
    for (const name of ['accept', 'content-type', 'x-appcode', 'x-language', 'x-deviceid', 'x-devicemodel', 'x-devicetype', 'x-osver']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const result = await proxy.forward({ method: req.method!, path, headers, body: input });
    stillActive(session);
    if (session.proxy !== proxy) throw new LocalError(401, 'SESSION_ENDED', '登入代理已停止或重新開始。');
    if (result.data && typeof result.data === 'object' && 'status' in result.data && result.data.status !== 0) { auditEvent.outcome = 'failure'; auditEvent.code = 'upstream_business'; }
    json(res, result.status, result.data);
  }
  async function api(req: IncomingMessage, res: ServerResponse, path: string, auditEvent: Record<string, unknown>) {
    if (req.headers['x-local-research'] !== '1' || (req.headers.origin !== undefined && req.headers.origin !== origin) || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) throw new LocalError(403, 'ORIGIN', '只接受本機同源頁面的請求。');
    prune();
    if (path === '/api/session' && req.method === 'GET') {
      limit(bootstrapAttempts, 60, 60_000);
      const session = findSession(req) ?? newSession();
      setCookie(res, session.id, Math.max(0, session.expiresAt - clock()));
      json(res, 200, publicSession(session)); return;
    }
    if (req.method !== 'POST') throw new LocalError(405, 'METHOD', '不支援此請求方法。');
    if (req.headers.origin !== origin) throw new LocalError(403, 'ORIGIN', '只接受本機同源頁面的請求。');
    if (path === '/api/clear') {
      // 等 body 收完再定位，避免讀 body 期間登入剛好完成輪換。
      await body(req, []); remove(findClearSession(req)); setCookie(res, '', 0); json(res, 200, { cleared: true }); return;
    }
    const session = findSession(req);
    if (!session) throw new LocalError(401, 'SESSION_ENDED', '本機工作階段已結束，請重新開啟連線。');
    if (!equal(req.headers['x-csrf-token'], session.csrf)) throw new LocalError(403, 'CSRF', '頁面已過期，請重新整理後再試。');
    if (path === '/api/sdk-start' || path === '/api/sdk-stop') {
      await body(req, []); stillActive(session);
      if (session.busy) throw new LocalError(409, 'BUSY', '另一個操作尚未完成。');
      if (path === '/api/sdk-start' && session.authenticated) throw new LocalError(409, 'ALREADY_CONNECTED', '請先清除本機連線再重新登入。');
      session.proxy?.clear(); session.proxy = null;
      if (path === '/api/sdk-start') session.proxy = proxyFactory();
      json(res, 200, { proxyReady: session.proxy !== null }); return;
    }
    if (session.busy) throw new LocalError(409, 'BUSY', '另一個操作尚未完成。');
    if (path === '/api/login') {
      const input = await body(req, ['code']);
      if (typeof input.code !== 'string' || !input.code || input.code.length > 4096 || /[\u0000-\u001f\u007f]/u.test(input.code)) throw new LocalError(400, 'SCHEMA', '登入回呼未提供有效的授權碼。');
      if (session.authenticated) throw new LocalError(409, 'ALREADY_CONNECTED', '請先清除本機連線再重新登入。');
      stillActive(session);
      if (session.busy) throw new LocalError(409, 'BUSY', '另一個操作尚未完成。');
      limit(loginAttempts, 5, 15 * 60_000);
      session.busy = true;
      try {
        const code = input.code; input.code = undefined;
        await session.client.exchangeCode(code); stillActive(session);
        const next: Session = { ...session, id: random(), csrf: random(), expiresAt: clock() + ttl, authenticated: true, busy: false };
        sessions.delete(session.id); sessions.set(next.id, next);
        clearLinks.set(session.id, { csrf: session.csrf, successor: next, expiresAt: Math.min(session.expiresAt, clock() + SESSION_TTL) });
        setCookie(res, next.id, ttl); auditEvent.count = next.client.getBindings().length; json(res, 200, publicSession(next));
      } catch (error) { session.client.clear(); throw error; } finally { session.busy = false; }
      return;
    }
    if (path === '/api/roster') {
      const input = await body(req, ['roleKey', 'confirmedTw']);
      if (!session.authenticated) throw new LocalError(401, 'LOGIN_REQUIRED', '請先完成登入連線。');
      if (typeof input.roleKey !== 'string' || input.roleKey.length > 128 || input.confirmedTw !== true) throw new LocalError(400, 'ROLE_CONFIRMATION', '請選擇角色並確認是本作繁中服。');
      stillActive(session);
      if (session.busy) throw new LocalError(409, 'BUSY', '另一個操作尚未完成。');
      limit(session.reads, 5, 60_000); session.busy = true;
      try { const result = await session.client.readRoster(input.roleKey); stillActive(session); auditEvent.count = result.summary.count; json(res, 200, result); }
      finally { session.busy = false; }
      return;
    }
    throw new LocalError(404, 'NOT_FOUND', '找不到此功能。');
  }
  const server = createServer({ requestTimeout: 20_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (req, res) => {
    const startedAt = performance.now();
    const requestId = randomUUID();
    const path = (req.url ?? '').split('?')[0];
    const operations: Record<string, string> = {
      '/api/session': 'session', '/api/login': 'login', '/api/roster': 'roster', '/api/clear': 'clear',
      '/api/sdk-start': 'sdk_start', '/api/sdk-stop': 'sdk_stop',
      '/api/sdk/account/user/auth/v1/token_by_email_password': 'sdk_password_login',
      '/api/sdk/account/user/info/v1/basic': 'sdk_basic', '/api/sdk/account/user/oauth2/v2/grant': 'sdk_grant',
      '/api/sdk/web/cookie_store/account_token': 'sdk_token_store',
    };
    const tracked = path.startsWith('/api/');
    const auditEvent: Record<string, unknown> = { event: 'http_request', requestId, operation: operations[path] ?? 'unknown', method: req.method, outcome: 'success' };
    if (tracked) res.setHeader('X-Audit-Request-Id', requestId);
    try {
      if (req.headers.host !== host) throw new LocalError(403, 'HOST', '只接受固定的本機網址。');
      if (req.url?.startsWith('/api/sdk/')) { await sdkApi(req, res, auditEvent); return; }
      if (!req.url || !/^\/[A-Za-z0-9_./-]*$/u.test(req.url)) throw new LocalError(400, 'PATH', '網址格式無效。');
      if (req.url.startsWith('/api/')) { await api(req, res, req.url, auditEvent); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new LocalError(405, 'METHOD', '不支援此請求方法。');
      const file = req.url === '/' || req.url === '/skport.html' ? 'skport.html'
        : /^\/assets\/[a-zA-Z0-9_-]+\.(?:js|css)$/u.test(req.url) ? req.url.slice(1) : null;
      if (!file) throw new LocalError(404, 'NOT_FOUND', '找不到此資源。');
      const root = await realpath(DIST), path = await realpath(resolve(root, file));
      if (!path.startsWith(root + sep)) throw new LocalError(404, 'NOT_FOUND', '找不到此資源。');
      const content = await readFile(path);
      safeHeaders(res, true);
      res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      auditEvent.outcome = 'failure';
      if (error instanceof LocalError || error instanceof SkportProxyError || error instanceof SkportClientError) auditEvent.code = error.code;
      else auditEvent.code = 'LOCAL_ERROR';
      if (error instanceof SkportClientError) { auditEvent.stage = error.stage; auditEvent.diagnostic = error.diagnostic; }
      if (error instanceof LocalError) json(res, error.status, { error: { code: error.code, message: error.message } });
      else if (error instanceof SkportProxyError) json(res, error.status, { error: { code: error.code, message: error.message } });
      else if (error instanceof SkportClientError) json(res, 502, { error: { code: error.code, stage: error.stage, message: error.message, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) } });
      else json(res, 500, { error: { code: 'LOCAL_ERROR', message: '本機服務無法完成此步驟。請確認已建置頁面，或重新啟動服務。' } });
    } finally {
      if (tracked) {
        auditEvent.status = res.writableEnded ? res.statusCode : 499;
        if (!res.writableEnded) auditEvent.outcome = 'aborted';
        else if (res.statusCode >= 400) auditEvent.outcome = 'failure';
        auditEvent.durationMs = Math.max(0, Math.round(performance.now() - startedAt));
        await audit(auditEvent);
      }
    }
  });
  const timer = setInterval(prune, 10_000); timer.unref();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_PORT, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('無法啟動本機服務。')); return; }
      host = `127.0.0.1:${address.port}`; origin = `http://${host}`; resolveListen();
    });
  });
  server.once('close', () => { clearInterval(timer); for (const session of sessions.values()) remove(session); clearLinks.clear(); });
  await audit({ event: 'service_start', outcome: 'success' });
  return { server, origin, close: async () => {
    await new Promise<void>((resolveClose, reject) => { server.close(error => error ? reject(error) : resolveClose()); server.closeAllConnections(); });
    await audit({ event: 'service_stop', outcome: 'success' });
    await Promise.all([...pendingAudits]);
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const writer = await createSkportAuditWriter({ directory: resolve(dirname(fileURLToPath(import.meta.url)), '../.local/audit') });
    await writer.flush();
    const service = await startSkportServer({ audit: event => writer.write(event) });
    console.info(`SKPORT 非官方本機研究頁：${service.origin}/skport.html（僅本機，Ctrl+C 停止並清除憑證）`);
    console.info(`Audit log：${writer.path}（只含操作與安全診斷，不含帳密或原始回應）`);
    const stop = () => { void service.close().then(() => process.exit(0), () => process.exit(1)); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch { console.error('本機研究服務啟動失敗。請確認 5187 未被使用，且 .local/audit 目錄可寫；不會自動換通訊埠。'); process.exitCode = 1; }
}
