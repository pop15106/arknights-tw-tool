import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { SkportClientError, type SkportDiagnostic } from './skport-client.ts';

export interface SkportAuditOptions { directory: string; maxBytes?: number; clock?: () => number }
export interface SkportAuditWriter { path: string; write(event: unknown): Promise<void>; flush(): Promise<void> }

const EVENTS = new Set(['service_start', 'service_stop', 'session_expired', 'http_request']);
const OPERATIONS = new Set(['session', 'login', 'roster', 'clear', 'sdk_start', 'sdk_stop', 'sdk_password_login', 'sdk_basic', 'sdk_grant', 'sdk_token_store', 'unknown']);
const METHODS = new Set(['GET', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'OTHER']);
const OUTCOMES = new Set(['success', 'failure', 'aborted']);
const STAGES = new Set(['configuration', 'session', 'exchange', 'community', 'bindings', 'roster', 'refresh']);
const CODES = new Set([
  'invalid_configuration', 'invalid_code', 'not_authenticated', 'invalid_role', 'session_changed',
  'upstream_network', 'upstream_timeout', 'upstream_http', 'upstream_business', 'credential_expired',
  'invalid_response', 'response_too_large', 'session_closed', 'invalid_request', 'unsupported_route',
  'unsupported_method', 'request_too_large', 'unsupported_media_type', 'upstream_busy',
  'CONTENT_TYPE', 'BODY_LIMIT', 'JSON', 'SCHEMA', 'RATE_LIMIT', 'SESSION_LIMIT', 'SESSION_ENDED',
  'ORIGIN', 'METHOD', 'PROXY_NOT_STARTED', 'BODY', 'CSRF', 'BUSY', 'ALREADY_CONNECTED', 'LOGIN_REQUIRED',
  'ROLE_CONFIRMATION', 'NOT_FOUND', 'HOST', 'PATH', 'LOCAL_ERROR',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const IO_MESSAGE = '本機 audit log 無法建立或寫入；未保證這筆紀錄已保存。';

function own(value: unknown, key: string): unknown {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property && Object.hasOwn(property, 'value') ? property.value : undefined;
  } catch { return; }
}

function project(event: unknown, clock: () => number): string {
  const kind = own(event, 'event');
  if (typeof kind !== 'string' || !EVENTS.has(kind)) throw new Error('Audit event 類型無效。');
  let now: number;
  try { now = clock(); } catch { throw new Error('Audit clock 無效。'); }
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw new Error('Audit clock 無效。');
  const output: Record<string, unknown> = { schemaVersion: 1, timestamp: new Date(now).toISOString(), event: kind };
  for (const [key, permitted] of [['operation', OPERATIONS], ['method', METHODS], ['outcome', OUTCOMES], ['code', CODES], ['stage', STAGES]] as const) {
    const value = own(event, key); if (typeof value === 'string' && permitted.has(value)) output[key] = value;
  }
  const requestId = own(event, 'requestId'); if (typeof requestId === 'string' && UUID.test(requestId)) output.requestId = requestId;
  for (const [key, min, max] of [['status', 100, 599], ['durationMs', 0, Number.MAX_SAFE_INTEGER], ['count', 0, 2000]] as const) {
    const value = own(event, key);
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max) output[key] = value;
  }
  const raw = own(event, 'diagnostic');
  const diagnostic = new SkportClientError('invalid_response', 'roster', {
    field: own(raw, 'field'), expected: own(raw, 'expected'), actual: own(raw, 'actual'),
  } as SkportDiagnostic).diagnostic;
  if (diagnostic) output.diagnostic = diagnostic;
  return JSON.stringify(output) + '\n';
}

async function statOrMissing(path: string) {
  try { return await fs.lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** 先檢查文字路徑的每一層，不讓 realpath 先跟隨 junction。 */
async function checkParents(path: string): Promise<void> {
  const chain: string[] = []; let current = path;
  for (;;) { chain.unshift(current); const parent = dirname(current); if (parent === current) break; current = parent; }
  for (const component of chain) {
    const entry = await statOrMissing(component);
    if (entry && (entry.isSymbolicLink() || !entry.isDirectory())) throw new Error(IO_MESSAGE);
  }
}

/** 初始化也在佇列內；啟動服務時 await flush() 可明確接收建立錯誤。單一目錄只配一個 writer。 */
export function createSkportAuditWriter(options: SkportAuditOptions): SkportAuditWriter {
  if (!options || typeof options.directory !== 'string' || !options.directory.trim() || options.directory.startsWith('\\\\') || options.directory.startsWith('//')) throw new Error('Audit directory 必須是本機路徑。');
  const directory = resolve(options.directory), file = join(directory, 'skport-audit.jsonl');
  if (!isAbsolute(directory)) throw new Error('Audit directory 無效。');
  const maxBytes = options.maxBytes ?? 1024 * 1024, clock = options.clock ?? Date.now;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > 1024 * 1024 || typeof clock !== 'function') throw new Error('Audit 設定無效。');
  const files = [file, file + '.1', file + '.2'];
  let identity: { dev: number; ino: number } | undefined;

  async function validate(): Promise<void> {
    await checkParents(directory);
    const current = await fs.lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || (identity && (current.dev !== identity.dev || current.ino !== identity.ino))) throw new Error(IO_MESSAGE);
    for (const target of files) {
      const entry = await statOrMissing(target);
      if (entry && (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1 || entry.size > maxBytes)) throw new Error(IO_MESSAGE);
    }
  }

  async function append(bytes: Buffer, exclusive = false): Promise<void> {
    await validate();
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (exclusive ? constants.O_EXCL : 0) | (constants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(file, flags, 0o600);
    try {
      const opened = await handle.stat(); await validate(); const current = await fs.lstat(file);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== current.dev || opened.ino !== current.ino || opened.size + bytes.length > maxBytes) throw new Error(IO_MESSAGE);
      if (bytes.length) await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
  }

  async function initialize(): Promise<void> {
    await checkParents(directory); await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await checkParents(directory);
    const current = await fs.lstat(directory); identity = { dev: current.dev, ino: current.ino };
    await append(Buffer.alloc(0));
  }

  let queue = initialize().catch(() => { throw new Error(IO_MESSAGE); });
  // 保留拒絕狀態供 write / flush 收到，同時避免呼叫者稍後才 await 時的未處理拒絕。
  void queue.catch(() => undefined);
  return {
    path: file,
    write(event: unknown): Promise<void> {
      let bytes: Buffer;
      try { bytes = Buffer.from(project(event, clock), 'utf8'); }
      catch { return Promise.reject(new Error('Audit event 或 clock 無效，未寫入紀錄。')); }
      if (bytes.length > maxBytes) return Promise.reject(new Error('Audit 紀錄超出單檔限制，未寫入。'));
      queue = queue.then(async () => {
        await validate();
        const active = await statOrMissing(file);
        if (active && active.size + bytes.length > maxBytes) {
          // 同一佇列內先關閉舊檔，再只輪替這三個固定檔名。
          if (await statOrMissing(files[2])) await fs.unlink(files[2]);
          if (await statOrMissing(files[1])) await fs.rename(files[1], files[2]);
          await fs.rename(file, files[1]);
          await append(bytes, true);
        } else await append(bytes);
      }).catch(() => { throw new Error(IO_MESSAGE); });
      void queue.catch(() => undefined);
      return queue;
    },
    flush(): Promise<void> { return queue; },
  };
}
