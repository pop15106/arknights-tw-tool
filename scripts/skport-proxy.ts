export interface SkportLoginProxyOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
export interface SkportProxyInput {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: unknown;
}
export interface SkportProxyResult { status: number; data: unknown }

type ErrorCode = 'invalid_configuration' | 'session_closed' | 'invalid_request' | 'unsupported_route' | 'unsupported_method' | 'request_too_large' | 'unsupported_media_type' | 'upstream_busy' | 'upstream_network' | 'upstream_timeout' | 'upstream_http' | 'invalid_response' | 'response_too_large';
const ERRORS: Record<ErrorCode, { status: number; message: string }> = {
  invalid_configuration: { status: 500, message: '本機登入代理設定無效。' },
  session_closed: { status: 410, message: '本機登入工作階段已清除，請重新開始。' },
  invalid_request: { status: 400, message: '登入請求不符合允許的資料格式。' },
  unsupported_route: { status: 404, message: '本機登入代理不提供這個路由。' },
  unsupported_method: { status: 405, message: '這個登入路由不接受指定的方法。' },
  request_too_large: { status: 413, message: '登入請求超出本機容量限制。' },
  unsupported_media_type: { status: 415, message: '登入請求必須使用 JSON 格式。' },
  upstream_busy: { status: 429, message: '登入請求仍在處理中，請稍後重試。' },
  upstream_network: { status: 502, message: '無法連線至官方帳號服務。' },
  upstream_timeout: { status: 504, message: '官方帳號服務回應逾時。' },
  upstream_http: { status: 502, message: '官方帳號服務回應了不支援的 HTTP 狀態或重新導向。' },
  invalid_response: { status: 502, message: '官方帳號服務沒有回傳符合契約的 JSON。' },
  response_too_large: { status: 502, message: '官方帳號服務回應超出本機容量限制。' },
};
export class SkportProxyError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(ERRORS[code].message);
    this.name = 'SkportProxyError';
    this.status = ERRORS[code].status;
    this.code = code;
  }
}

const ACCOUNT_ORIGIN = 'https://as.gryphline.com';
const APP_CODE = '6eb76d4e13aa36e6';
const MAX_REQUEST_BYTES = 32 * 1024;
const STORE_PATH = '/web/cookie_store/account_token';
const LOGIN_PATH = '/account/user/auth/v1/token_by_email_password';
const BASIC_PATH = '/account/user/info/v1/basic';
const GRANT_PATH = '/account/user/oauth2/v2/grant';
const ACCOUNT_HEADERS = new Set(['accept', 'content-type', 'x-appcode', 'x-language', 'x-deviceid', 'x-devicemodel', 'x-devicetype', 'x-osver']);
type ObjectValue = Record<string, unknown>;
type AccountRequest = { kind: 'account'; method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body?: string };
type StoreRequest = { kind: 'store'; method: 'GET' | 'POST' | 'DELETE'; content?: string };

function record(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new SkportProxyError('invalid_request');
  return value as ObjectValue;
}
function keys(value: ObjectValue, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new SkportProxyError('invalid_request');
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,8192}$/u.test(value)) throw new SkportProxyError('invalid_request');
  return value;
}
function textField(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new SkportProxyError('invalid_request');
  return value;
}
function captcha(value: unknown): Record<string, string> {
  const input = record(value);
  const entries = Object.entries(input);
  // SDK 會傳入 Geetest 的 getValidate() 結果，並補上 challenge。
  // 保留受大小限制的平面字串映射，不推定供應商的欄位名稱。
  if (!entries.length || entries.length > 16) throw new SkportProxyError('invalid_request');
  const output: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new SkportProxyError('invalid_request');
    output[key] = token(value);
  }
  return output;
}
function normalizeHeaders(input: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(record(input))) {
    const key = name.toLowerCase();
    // 不外送 Host、Cookie、Origin、Referer、Authorization 或任意附加標頭。
    if (!ACCOUNT_HEADERS.has(key) || value === undefined) continue;
    if (Object.hasOwn(result, key) || typeof value !== 'string' || !/^[\x20-\x7e]{1,512}$/u.test(value)) throw new SkportProxyError('invalid_request');
    result[key] = value;
  }
  if (result['content-type'] !== undefined && !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(result['content-type'])) throw new SkportProxyError('unsupported_media_type');
  if (result['x-appcode'] !== undefined && result['x-appcode'] !== APP_CODE) throw new SkportProxyError('invalid_request');
  return result;
}
function safeError(error: unknown, fallback: ErrorCode): SkportProxyError {
  // 即使是本類別的錯誤也重新建立，避免注入的傳輸函式附加敏感 message 或 cause。
  return new SkportProxyError(error instanceof SkportProxyError && Object.hasOwn(ERRORS, error.code) ? error.code : fallback);
}

function validate(input: SkportProxyInput): AccountRequest | StoreRequest {
  if (!input || typeof input.method !== 'string' || typeof input.path !== 'string' || input.path.length > 20_000 || /[#\\\u0000-\u0020]/u.test(input.path)) throw new SkportProxyError('invalid_request');
  const separator = input.path.indexOf('?');
  const path = separator < 0 ? input.path : input.path.slice(0, separator);
  const query = separator < 0 ? undefined : input.path.slice(separator + 1);
  if (![STORE_PATH, LOGIN_PATH, BASIC_PATH, GRANT_PATH].includes(path)) throw new SkportProxyError('unsupported_route');
  const headers = normalizeHeaders(input.headers);
  if (path === STORE_PATH) {
    if (!['GET', 'POST', 'DELETE'].includes(input.method)) throw new SkportProxyError('unsupported_method');
    if (query !== undefined) throw new SkportProxyError('invalid_request');
    if (input.method === 'POST') {
      const body = record(input.body); keys(body, ['content']);
      return { kind: 'store', method: 'POST', content: token(body.content) };
    }
    if (input.body !== undefined) throw new SkportProxyError('invalid_request');
    return { kind: 'store', method: input.method as 'GET' | 'DELETE' };
  }
  const method = path === BASIC_PATH ? 'GET' : 'POST';
  if (input.method !== method) throw new SkportProxyError('unsupported_method');
  headers.accept = 'application/json';
  headers['x-appcode'] = APP_CODE;
  let url = ACCOUNT_ORIGIN + path.slice('/account'.length);
  if (path === BASIC_PATH) {
    if (input.body !== undefined || query === undefined) throw new SkportProxyError('invalid_request');
    const params = new URLSearchParams(query);
    if ([...params.keys()].length !== 1 || !params.has('token')) throw new SkportProxyError('invalid_request');
    url += '?' + new URLSearchParams({ token: token(params.get('token')) }).toString();
    delete headers['content-type'];
    return { kind: 'account', method: 'GET', url, headers };
  }
  if (query !== undefined) throw new SkportProxyError('invalid_request');
  const raw = record(input.body);
  let body: ObjectValue;
  if (path === LOGIN_PATH) {
    keys(raw, ['email', 'password'], ['captcha']);
    body = { email: textField(raw.email, 320), password: textField(raw.password, 128) };
  } else {
    keys(raw, ['token', 'appCode', 'type'], ['captcha']);
    if (raw.appCode !== APP_CODE || raw.type !== 0) throw new SkportProxyError('invalid_request');
    body = { token: token(raw.token), appCode: APP_CODE, type: 0 };
  }
  if (Object.hasOwn(raw, 'captcha')) body.captcha = captcha(raw.captcha);
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) throw new SkportProxyError('request_too_large');
  headers['content-type'] = 'application/json';
  return { kind: 'account', method: 'POST', url, headers, body: serialized };
}

/** 單一本機工作階段的 SDK 主機轉接器；不提供任意 URL 代理、Cookie 轉送或磁碟保存。 */
export class SkportLoginProxy {
  #fetch: typeof globalThis.fetch;
  #timeoutMs: number;
  #maxBytes: number;
  #closed = false;
  #token: string | null = null;
  #controllers = new Set<AbortController>();

  constructor(options: SkportLoginProxyOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxBytes = options.maxResponseBytes ?? 1024 * 1024;
    if (typeof this.#fetch !== 'function' || !Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000 || !Number.isInteger(this.#maxBytes) || this.#maxBytes < 128 || this.#maxBytes > 4 * 1024 * 1024) throw new SkportProxyError('invalid_configuration');
  }

  clear(): void {
    this.#closed = true;
    this.#token = null;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
  }

  #assertOpen(): void { if (this.#closed) throw new SkportProxyError('session_closed'); }

  async forward(input: SkportProxyInput): Promise<SkportProxyResult> {
    this.#assertOpen();
    let request: AccountRequest | StoreRequest;
    try { request = validate(input); }
    catch (error) { throw safeError(error, 'invalid_request'); }
    if (request.kind === 'store') {
      if (request.method === 'POST') this.#token = request.content!;
      else if (request.method === 'DELETE') this.#token = null;
      const result = { status: 200, data: { code: 0, data: { content: request.method === 'GET' ? this.#token : null } } };
      await Promise.resolve();
      this.#assertOpen();
      return result;
    }
    return this.#request(request);
  }

  async #request(request: AccountRequest): Promise<SkportProxyResult> {
    this.#assertOpen();
    if (this.#controllers.size >= 4) throw new SkportProxyError('upstream_busy');
    const controller = new AbortController();
    this.#controllers.add(controller);
    let timedOut = false;
    let response: Response | undefined;
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new SkportProxyError(timedOut ? 'upstream_timeout' : 'session_closed')), { once: true });
    });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    try {
      const operation = async (): Promise<SkportProxyResult> => {
        response = await this.#fetch(request.url, {
          method: request.method, headers: request.headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
        });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          throw new SkportProxyError(timedOut ? 'upstream_timeout' : 'session_closed');
        }
        if (response.status < 200 || response.status > 599 || (response.status >= 300 && response.status < 400) || response.redirected || (response.url && response.url !== request.url)) throw new SkportProxyError('upstream_http');
        if (!/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/iu.test(response.headers.get('content-type')?.trim() ?? '')) throw new SkportProxyError('invalid_response');
        const data = await this.#readJson(response, controller.signal);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new SkportProxyError('invalid_response');
        const envelope = data as ObjectValue;
        const hasStatus = typeof envelope.status === 'number' && Number.isSafeInteger(envelope.status);
        // SDK 模組 7515 解析 HTTPError 的 JSON；模組 2864 也接受只有 msg/message 的錯誤。
        // 這類回應不必具有業務 status，應保留原 HTTP 失敗狀態。
        const hasHttpErrorMessage = response.status >= 400 && (typeof envelope.msg === 'string' || typeof envelope.message === 'string');
        if (!hasStatus && !hasHttpErrorMessage) throw new SkportProxyError('invalid_response');
        return { status: response.status, data };
      };
      const result = await Promise.race([operation(), aborted]);
      this.#assertOpen();
      return result;
    } catch (error) {
      controller.abort();
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
      this.#assertOpen();
      throw safeError(error, 'upstream_network');
    } finally {
      clearTimeout(timer);
      this.#controllers.delete(controller);
    }
  }

  async #readJson(response: Response, signal: AbortSignal): Promise<unknown> {
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > this.#maxBytes) throw new SkportProxyError('response_too_large');
    if (!response.body) throw new SkportProxyError('invalid_response');
    const reader = response.body.getReader();
    let finished = false;
    let total = 0;
    const chunks: Uint8Array[] = [];
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        if (signal.aborted) throw new SkportProxyError('upstream_timeout');
        const { done, value } = await reader.read();
        if (done) { finished = true; break; }
        total += value.byteLength;
        if (total > this.#maxBytes) throw new SkportProxyError('response_too_large');
        chunks.push(value);
      }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))); }
      catch { throw new SkportProxyError('invalid_response'); }
    } finally {
      signal.removeEventListener('abort', cancel);
      if (!finished) cancel();
      reader.releaseLock();
    }
  }
}
