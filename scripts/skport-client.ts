import { createHash, createHmac, randomUUID } from 'node:crypto';

export interface PublicRole { key: string; label: string; serverLabel: string }
export interface ResearchCharacter {
  charId: string;
  level?: number | null;
  evolvePhase?: number | null;
  favorPercent?: number | null;
  mainSkillLvl?: number | null;
  potentialRank?: number | null;
  defaultSkillId?: string | null;
  defaultEquipId?: string | null;
  skills?: { id: string; specializeLevel?: number | null }[] | null;
  // 只保留原值供研究；不推定 level 代表解鎖或本工具的模組等級。
  equip?: { id: string; level?: number | null; locked?: boolean | null }[] | null;
}
export interface ResearchRoster {
  format: 'skport-offline-research';
  schemaVersion: 1;
  gameData: { code: 0; data: { chars: ResearchCharacter[] } };
}
export interface ResearchRosterResult {
  document: ResearchRoster;
  retrievedAt: string;
  serverUnverified: true;
  summary: { count: number; fields: string[] };
}
export interface SkportClientOptions {
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
type Stage = 'configuration' | 'session' | 'exchange' | 'community' | 'bindings' | 'roster' | 'refresh';
type ErrorCode = 'invalid_configuration' | 'invalid_code' | 'not_authenticated' | 'invalid_role' | 'session_changed' | 'upstream_network' | 'upstream_timeout' | 'upstream_http' | 'upstream_business' | 'credential_expired' | 'invalid_response' | 'response_too_large';
export interface SkportDiagnostic { field: string; expected: string; actual: string }
type DiagnosticExpected = 'object' | 'integer' | 'identifier' | 'unique identifier' | 'nonnegative integer within limit' | 'array within limit' | 'boolean' | 'base64 string within limit' | 'UTF-8 JSON' | 'JSON object' | 'JSON within limit';
const MESSAGES: Record<ErrorCode, string> = {
  invalid_configuration: '本機連線設定無效。', invalid_code: '登入回呼未提供有效授權碼。',
  not_authenticated: '請先完成登入。', invalid_role: '角色不屬於目前登入工作階段。',
  session_changed: '登入工作階段已清除或變更，請重新操作。', upstream_network: '無法連線至上游服務。',
  upstream_timeout: '上游服務回應逾時。', upstream_http: '上游服務拒絕請求或暫時無法使用。',
  upstream_business: '上游服務未完成這項操作。', credential_expired: '登入憑證已失效，請重新登入。',
  invalid_response: '上游資料形狀不符合已查核契約。', response_too_large: '上游回應超出本機容量限制。',
};
export class SkportClientError extends Error {
  readonly code: ErrorCode;
  readonly stage: Stage;
  readonly diagnostic?: SkportDiagnostic;
  constructor(code: ErrorCode, stage: Stage, diagnostic?: SkportDiagnostic) {
    super(MESSAGES[code]); this.name = 'SkportClientError'; this.code = code; this.stage = stage;
    if (stage === 'roster') {
      const safe = sanitizeDiagnostic(diagnostic);
      if (safe) Object.defineProperty(this, 'diagnostic', { value: Object.freeze(safe), enumerable: true, writable: false, configurable: false });
    }
  }
}

const ORIGIN = 'https://zonai.skport.com';
const ROUTES = Object.freeze({
  exchange: { path: '/web/v1/user/auth/generate_cred_by_code', method: 'POST' },
  community: { path: '/web/v2/user', method: 'GET' },
  bindings: { path: '/api/v1/game/player/binding', method: 'GET' },
  roster: { path: '/api/v1/game/player/info', method: 'GET' },
  refresh: { path: '/web/v1/auth/refresh', method: 'GET' },
} as const);
type Route = keyof typeof ROUTES;
type ObjectValue = Record<string, unknown>;
interface Envelope { code: number; data?: unknown; timestamp?: unknown }
interface WireResult { envelope: Envelope; status: number }
interface Session { cred: string; signToken: string; communityId: string; clockOffset: number }
interface PrivateRole { publicRole: PublicRole; uid: string }
const scalarKeys = ['level', 'evolvePhase', 'favorPercent', 'mainSkillLvl', 'potentialRank'] as const;
const diagnosticExpected = new Set<DiagnosticExpected>(['object', 'integer', 'identifier', 'unique identifier', 'nonnegative integer within limit', 'array within limit', 'boolean', 'base64 string within limit', 'UTF-8 JSON', 'JSON object', 'JSON within limit']);
const diagnosticActual = new Set(['missing', 'null', 'array', 'object', 'string', 'empty string', 'number', 'integer', 'boolean', 'other']);

function diagnosticFieldAllowed(field: string): boolean {
  if (['response', 'response.code', 'data', 'data.content', 'data.chars'].includes(field)) return true;
  const char = /^data\.chars\[(0|[1-9]\d{0,3})\](.*)$/u.exec(field);
  if (!char || Number(char[1]) >= 2000) return false;
  if (['', '.charId', '.level', '.evolvePhase', '.favorPercent', '.mainSkillLvl', '.potentialRank', '.defaultSkillId', '.defaultEquipId', '.skills', '.equip'].includes(char[2])) return true;
  const child = /^\.(skills|equip)\[(0|[1-9]\d?)\](.*)$/u.exec(char[2]);
  if (!child || Number(child[2]) >= 20) return false;
  return (child[1] === 'skills' ? ['', '.id', '.specializeLevel'] : ['', '.id', '.level', '.locked']).includes(child[3]);
}
function sanitizeDiagnostic(value: unknown): SkportDiagnostic | undefined {
  // 不接收來源值、來源鍵或自由文字；即使外部直接建立錯誤，也只能使用已知欄位與固定詞彙。
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const { field, expected, actual } = value as SkportDiagnostic;
    if (typeof field !== 'string' || !diagnosticFieldAllowed(field) || !diagnosticExpected.has(expected as DiagnosticExpected) || !diagnosticActual.has(actual)) return;
    return { field, expected, actual };
  } catch { return; }
}
function diagnostic(field: string, expected: DiagnosticExpected, value: unknown): SkportDiagnostic {
  const actual = value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? Number.isInteger(value) ? 'integer' : 'number' : ['object', 'string', 'boolean'].includes(typeof value) ? typeof value : 'other';
  return { field, expected, actual };
}
function invalidResponse(stage: Stage, field?: string, expected: DiagnosticExpected = 'object', value?: unknown): SkportClientError {
  return new SkportClientError('invalid_response', stage, stage === 'roster' && field ? diagnostic(field, expected, value) : undefined);
}

function object(value: unknown, stage: Stage, field?: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse(stage, field, 'object', value);
  return value as ObjectValue;
}
function opaque(value: unknown, stage: Stage): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,8192}$/u.test(value)) throw new SkportClientError('invalid_response', stage);
  return value;
}
function identifier(value: unknown, stage: Stage, allowEmpty = false, field?: string): string {
  if (allowEmpty && value === '') return '';
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,200}$/u.test(value)) {
    const detail = field ? diagnostic(field, 'identifier', value) : undefined;
    // 只在實際 identifier 空值時區分；其他 guard 可能以空字串作安全 placeholder。
    if (detail && value === '') detail.actual = 'empty string';
    throw new SkportClientError('invalid_response', stage, detail);
  }
  return value;
}
function skillIdentifier(value: unknown, field: string, allowEmpty = false): string {
  if (allowEmpty && value === '') return '';
  // 技能共用 ID 可帶尾端數字索引；不把這個語法放寬到幹員或模組 ID。
  if (typeof value !== 'string' || value.length > 200 || !/^[A-Za-z0-9_.-]+(?:\[\d+\])?$/u.test(value)) {
    const detail = diagnostic(field, 'identifier', value);
    if (value === '') detail.actual = 'empty string';
    throw new SkportClientError('invalid_response', 'roster', detail);
  }
  return value;
}
function displayText(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '').trim();
  return cleaned ? [...cleaned].slice(0, 80).join('') : undefined;
}
function optionalNumber(target: ObjectValue, source: ObjectValue, key: string, field: string): void {
  const value = source[key];
  if (value === undefined) return;
  if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000)) throw invalidResponse('roster', `${field}.${key}`, 'nonnegative integer within limit', value);
  target[key] = value;
}
function projectCharacters(value: unknown): ResearchCharacter[] {
  if (!Array.isArray(value) || value.length > 2000) throw invalidResponse('roster', 'data.chars', 'array within limit', value);
  const seen = new Set<string>();
  return value.map((input, index) => {
    const field = `data.chars[${index}]`;
    const raw = object(input, 'roster', field);
    const charId = identifier(raw.charId, 'roster', false, `${field}.charId`);
    if (seen.has(charId)) throw invalidResponse('roster', `${field}.charId`, 'unique identifier', charId);
    seen.add(charId);
    const char: ObjectValue = { charId };
    for (const key of scalarKeys) optionalNumber(char, raw, key, field);
    for (const key of ['defaultSkillId', 'defaultEquipId']) {
      if (raw[key] !== undefined) char[key] = raw[key] === null ? null
        : key === 'defaultSkillId' ? skillIdentifier(raw[key], `${field}.${key}`, true)
        : identifier(raw[key], 'roster', true, `${field}.${key}`);
    }
    for (const key of ['skills', 'equip']) {
      const children = raw[key];
      if (children === undefined) continue;
      if (children === null) { char[key] = null; continue; }
      if (!Array.isArray(children) || children.length > 20) throw invalidResponse('roster', `${field}.${key}`, 'array within limit', children);
      const childIds = new Set<string>();
      char[key] = children.map((inputChild, childIndex) => {
        const childField = `${field}.${key}[${childIndex}]`;
        const rawChild = object(inputChild, 'roster', childField);
        const id = key === 'skills' ? skillIdentifier(rawChild.id, `${childField}.id`) : identifier(rawChild.id, 'roster', false, `${childField}.id`);
        if (childIds.has(id)) throw invalidResponse('roster', `${childField}.id`, 'unique identifier', id);
        childIds.add(id);
        const child: ObjectValue = { id };
        optionalNumber(child, rawChild, key === 'skills' ? 'specializeLevel' : 'level', childField);
        if (key === 'equip' && rawChild.locked !== undefined) {
          if (rawChild.locked !== null && typeof rawChild.locked !== 'boolean') throw invalidResponse('roster', `${childField}.locked`, 'boolean', rawChild.locked);
          child.locked = rawChild.locked;
        }
        return child;
      });
    }
    return char as unknown as ResearchCharacter;
  });
}

/** 非官方僅本機研究 client。所有上游存取路由固定，無登入資訊落盤或一般代理功能。 */
export class SkportClient {
  #fetch: typeof globalThis.fetch;
  #clock: () => number;
  #timeoutMs: number;
  #maxBytes: number;
  #session: Session | undefined;
  #roles = new Map<string, PrivateRole>();
  #epoch = 0;
  #controllers = new Set<AbortController>();

  constructor(options: SkportClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    if (typeof this.#fetch !== 'function' || typeof this.#clock !== 'function' || !Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000 || !Number.isInteger(this.#maxBytes) || this.#maxBytes < 128 || this.#maxBytes > 16 * 1024 * 1024) throw new SkportClientError('invalid_configuration', 'configuration');
  }

  clear(): void {
    this.#epoch++;
    this.#session = undefined;
    this.#roles.clear();
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
  }

  getBindings(): PublicRole[] { return [...this.#roles.values()].map(role => ({ ...role.publicRole })); }

  async exchangeCode(code: string): Promise<PublicRole[]> {
    this.clear();
    const epoch = this.#epoch;
    if (typeof code !== 'string' || !/^[\x21-\x7e]{1,8192}$/u.test(code)) throw new SkportClientError('invalid_code', 'exchange');
    try {
      const response = await this.#wire('exchange', { kind: 1, code }, epoch);
      this.#ensureSuccess(response, 'exchange', epoch);
      const data = object(response.envelope.data, 'exchange');
      this.#assertCurrent(epoch);
      this.#session = { cred: opaque(data.cred, 'exchange'), signToken: opaque(data.token, 'exchange'), communityId: '', clockOffset: 0 };
      this.#adjustClock(response.envelope.timestamp);
      const community = object(await this.#signed('community', {}, epoch), 'community');
      const basic = object(object(community.user, 'community').basicUser, 'community');
      this.#requireSession(epoch).communityId = identifier(basic.id, 'community');
      const binding = object(await this.#signed('bindings', { uid: this.#requireSession(epoch).communityId }, epoch), 'bindings');
      const roles = this.#parseBindings(binding);
      this.#assertCurrent(epoch);
      this.#roles = roles;
      return this.getBindings();
    } catch (error) {
      if (epoch === this.#epoch) this.clear();
      throw this.#safeError(error, 'exchange');
    }
  }

  async readRoster(roleKey: string): Promise<ResearchRosterResult> {
    const epoch = this.#epoch;
    const session = this.#requireSession(epoch);
    const role = this.#roles.get(roleKey);
    if (!role) throw new SkportClientError('invalid_role', 'roster');
    const response = await this.#signed('roster', { uid: role.uid, userId: session.communityId }, epoch);
    let data = object(response, 'roster', 'data');
    // 只有缺省、null 或空字串可保留原 chars；其他型別一律依 content 契約驗證。
    if (data.content !== undefined && data.content !== null && data.content !== '') {
      if (typeof data.content !== 'string' || data.content.length > Math.ceil(this.#maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data.content)) throw invalidResponse('roster', 'data.content', 'base64 string within limit', data.content);
      const decoded = Buffer.from(data.content, 'base64');
      if (decoded.byteLength > this.#maxBytes) throw new SkportClientError('response_too_large', 'roster', diagnostic('data.content', 'base64 string within limit', data.content));
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)); }
      catch { throw invalidResponse('roster', 'data.content', 'UTF-8 JSON', data.content); }
      data = object(parsed, 'roster', 'data.content');
    }
    const chars = projectCharacters(data.chars);
    this.#assertCurrent(epoch);
    const fields = new Set<string>();
    for (const char of chars) for (const [key, value] of Object.entries(char)) {
      fields.add(key);
      if ((key === 'skills' || key === 'equip') && Array.isArray(value)) for (const entry of value) for (const childKey of Object.keys(entry)) fields.add(`${key}.${childKey}`);
    }
    return {
      document: { format: 'skport-offline-research', schemaVersion: 1, gameData: { code: 0, data: { chars } } },
      retrievedAt: new Date(this.#now()).toISOString(), serverUnverified: true,
      summary: { count: chars.length, fields: [...fields].sort() },
    };
  }

  #parseBindings(data: ObjectValue): Map<string, PrivateRole> {
    if (!Array.isArray(data.list) || data.list.length > 30) throw new SkportClientError('invalid_response', 'bindings');
    const result = new Map<string, PrivateRole>();
    const uids = new Set<string>();
    for (const rawGame of data.list) {
      const game = object(rawGame, 'bindings');
      if (game.appCode !== 'arknights') continue;
      if (!Array.isArray(game.bindingList) || game.bindingList.length > 100) throw new SkportClientError('invalid_response', 'bindings');
      for (const input of game.bindingList) {
        const binding = object(input, 'bindings');
        const uid = identifier(binding.uid, 'bindings');
        if (uids.has(uid)) throw new SkportClientError('invalid_response', 'bindings');
        uids.add(uid);
        const key = randomUUID();
        const label = displayText(binding.nickName) ?? displayText(binding.nickname) ?? `明日方舟角色 ${result.size + 1}`;
        const sourceLabel = displayText(binding.serverName) ?? displayText(binding.channelName);
        const serverLabel = sourceLabel ? `${sourceLabel}（服別未驗證）` : '服別未驗證';
        result.set(key, { uid, publicRole: { key, label, serverLabel } });
      }
    }
    return result;
  }

  #now(): number {
    let now: number;
    try { now = this.#clock(); } catch { throw new SkportClientError('invalid_configuration', 'configuration'); }
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw new SkportClientError('invalid_configuration', 'configuration');
    return now;
  }
  #assertCurrent(epoch: number): void { if (epoch !== this.#epoch) throw new SkportClientError('session_changed', 'session'); }
  #requireSession(epoch: number): Session {
    this.#assertCurrent(epoch);
    if (!this.#session) throw new SkportClientError('not_authenticated', 'session');
    return this.#session;
  }
  #safeError(error: unknown, stage: Stage): SkportClientError { return error instanceof SkportClientError ? error : new SkportClientError('upstream_network', stage); }
  #adjustClock(value: unknown): void {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,12}$/u.test(value) ? Number(value) : NaN;
    if (this.#session && Number.isSafeInteger(parsed) && parsed > 0 && parsed < 1e12) this.#session.clockOffset = parsed - Math.floor(this.#now() / 1000);
  }
  #ensureSuccess(result: WireResult, stage: Stage, epoch: number): void {
    this.#assertCurrent(epoch);
    if (result.envelope.code === 10002 || result.status === 401) {
      this.clear();
      throw new SkportClientError('credential_expired', stage);
    }
    if (result.envelope.code !== 0) throw new SkportClientError('upstream_business', stage);
  }
  async #signed(route: Exclude<Route, 'exchange' | 'refresh'>, params: Record<string, string>, epoch: number): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.#requireSession(epoch);
      const result = await this.#wire(route, params, epoch);
      const code = result.envelope.code;
      if (code === 10000 || code === 10003) {
        this.#adjustClock(result.envelope.timestamp);
        if (attempt === 1) { this.clear(); throw new SkportClientError('credential_expired', route); }
        if (code === 10000) {
          const refreshed = await this.#wire('refresh', {}, epoch);
          if ([10000, 10002, 10003].includes(refreshed.envelope.code)) { this.clear(); throw new SkportClientError('credential_expired', 'refresh'); }
          this.#ensureSuccess(refreshed, 'refresh', epoch);
          this.#requireSession(epoch).signToken = opaque(object(refreshed.envelope.data, 'refresh').token, 'refresh');
          this.#adjustClock(refreshed.envelope.timestamp);
        }
        continue;
      }
      this.#ensureSuccess(result, route, epoch);
      return result.envelope.data;
    }
    throw new SkportClientError('credential_expired', route);
  }

  async #wire(route: Route, params: Record<string, string | number>, epoch: number): Promise<WireResult> {
    this.#assertCurrent(epoch);
    const target = ROUTES[route];
    const query = target.method === 'GET' ? new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString() : '';
    const body = target.method === 'POST' ? JSON.stringify(params) : undefined;
    const url = ORIGIN + target.path + (query ? `?${query}` : '');
    const offset = route === 'exchange' ? 0 : this.#requireSession(epoch).clockOffset;
    const timestamp = String(Math.floor(this.#now() / 1000) + offset);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', platform: '3', vName: '1.0.0', timestamp, 'sk-language': 'zh_Hant' };
    if (route !== 'exchange') {
      const session = this.#requireSession(epoch);
      const signedHeaders = { platform: '3', timestamp, dId: '', vName: '1.0.0' };
      const message = target.path + (target.method === 'GET' ? query : body ?? '') + timestamp + JSON.stringify(signedHeaders);
      const hmac = createHmac('sha256', session.signToken).update(message).digest('hex');
      headers.sign = createHash('md5').update(hmac).digest('hex');
      headers.cred = session.cred;
    }
    if (route === 'roster') headers['x-transformed'] = 'base64';
    const controller = new AbortController();
    this.#controllers.add(controller);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new SkportClientError(timedOut ? 'upstream_timeout' : 'session_changed', route)), { once: true });
    });
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    let response: Response | undefined;
    try {
      const operation = async (): Promise<WireResult> => {
        response = await this.#fetch(url, { method: target.method, headers, ...(body === undefined ? {} : { body }), redirect: 'error', cache: 'no-store', credentials: 'omit', signal: controller.signal });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          throw new SkportClientError(timedOut ? 'upstream_timeout' : 'session_changed', route);
        }
        if ((response.status < 200 || response.status >= 300) && response.status !== 401) throw new SkportClientError('upstream_http', route);
        if (response.redirected || (response.url && new URL(response.url).origin !== ORIGIN)) throw new SkportClientError('upstream_http', route);
        const value = object(await this.#readJson(response, controller.signal, route), route, route === 'roster' ? 'response' : undefined);
        if (typeof value.code !== 'number' || !Number.isSafeInteger(value.code)) throw invalidResponse(route, 'response.code', 'integer', value.code);
        return { envelope: { code: value.code, data: value.data, timestamp: value.timestamp }, status: response.status };
      };
      const result = await Promise.race([operation(), aborted]);
      this.#assertCurrent(epoch);
      return result;
    } catch (error) {
      controller.abort();
      // Header rejection occurs before a reader exists; terminate that body too.
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
      this.#assertCurrent(epoch);
      throw this.#safeError(error, route);
    } finally {
      clearTimeout(timer);
      this.#controllers.delete(controller);
    }
  }

  async #readJson(response: Response, signal: AbortSignal, stage: Stage): Promise<unknown> {
    const length = response.headers.get('content-length');
    if (length !== null && /^\d+$/u.test(length) && Number(length) > this.#maxBytes) throw new SkportClientError('response_too_large', stage, stage === 'roster' ? diagnostic('response', 'JSON within limit', '') : undefined);
    if (!response.body) throw invalidResponse(stage, 'response', 'JSON object', undefined);
    const reader = response.body.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];
    let finished = false;
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        if (signal.aborted) throw new SkportClientError('upstream_timeout', stage);
        const { done, value } = await reader.read();
        if (done) { finished = true; break; }
        total += value.byteLength;
        if (total > this.#maxBytes) throw new SkportClientError('response_too_large', stage, stage === 'roster' ? diagnostic('response', 'JSON within limit', '') : undefined);
        chunks.push(value);
      }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))); }
      catch { throw invalidResponse(stage, 'response', 'JSON object', ''); }
    } finally {
      signal.removeEventListener('abort', cancel);
      if (!finished) cancel();
      reader.releaseLock();
    }
  }
}
