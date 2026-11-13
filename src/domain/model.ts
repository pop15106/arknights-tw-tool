export const SCHEMA_VERSION = 1 as const;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
export type Namespace = 'demo' | 'personal';
export interface EvidenceMeta {
  source: string;
  observedAt?: string;
  importedAt: string;
  confidence?: number;
  manuallyConfirmed: boolean;
  locator?: { kind: 'image' | 'video'; assetId: string; frameMs?: number; originalRetained: boolean };
}
export type Evidence<T = number | string | boolean> = EvidenceMeta & (
  { status: 'known'; value: T } | { status: 'unknown' | 'not-applicable'; value?: never }
);
export interface ModuleDefinition {
  id: string;
  name: string;
  kind: string;
  type?: 'original' | 'advanced';
  description?: string;
  unlock?: { elite: 0 | 1 | 2; level: number };
  missions?: { id: string; description: string }[];
  levels?: {
    level: 1 | 2 | 3;
    attributes: { key: string; label: string; value: number }[];
    // 保留各條件候選；不代表同時生效或已由個人幹員解鎖。
    effects: {
      kind: 'trait' | 'talent'; name: string; description: string; elite: 0 | 1 | 2; level: number; potential: 1 | 2 | 3 | 4 | 5 | 6;
      target?: string; isToken?: boolean; validInGameTag?: string; validInMapTag?: string; validModeIndices?: number[];
    }[];
    costs: { id: string; name: string; count: number }[];
    trust?: number;
  }[];
}
export interface OperatorDefinition {
  id: string;
  displayName: string;
  aliases: string[];
  rarity: 1 | 2 | 3 | 4 | 5 | 6;
  profession: string;
  branch: string;
  faction: string;
  portrait?: string;
  skills: { id: string; name: string; levels?: { level: number; description: string }[] }[];
  modules: ModuleDefinition[];
  // 保留各條件版本，並不代表角色目前已啟用所有天賦。
  talents?: { name: string; description: string; elite: 0 | 1 | 2; level: number; potential: 1 | 2 | 3 | 4 | 5 | 6 }[];
  availability: 'available' | 'unavailable' | 'unknown';
}
export interface DatasetMetadata {
  id: string;
  version: string;
  product: 'arknights';
  server: 'tw';
  namespace: Namespace;
  validFrom: string;
  validUntil?: string;
  acquiredAt: string;
  source: string;
  licenseStatus: 'self-authored' | 'permitted' | 'unknown';
  checksum: string;
}
export interface Dataset { metadata: DatasetMetadata; operators: OperatorDefinition[] }
export interface OwnedOperator { operatorId: string; fields: Record<string, Evidence> }
export interface ImportDocument {
  format: 'arknights-roster-import';
  schemaVersion: 1;
  product: 'arknights';
  server: 'tw';
  namespace: Namespace;
  dataset: Dataset;
  candidates: OwnedOperator[];
  completeness: 'partial' | 'complete';
  source: string;
  adapterVersion: string;
  createdAt: string;
}
export interface FieldConflict { id: string; operatorId: string; field: string; current: Evidence; incoming: Evidence; reasons: string[] }
export interface ImportCounts { added: number; changed: number; repeated: number; conflicts: number; missing: number }
export interface BatchRecord {
  id: string;
  kind: 'import' | 'undo';
  source: string;
  contentHash: string;
  createdAt: string;
  completeness: 'partial' | 'complete';
  adapterVersion: string;
  counts: ImportCounts;
  decisions: Record<string, 'keep' | 'incoming'>;
  candidates: OwnedOperator[];
  conflicts: FieldConflict[];
  duplicateOf?: string;
  revertedBatchId?: string;
}
export interface Settings {
  base: { facilities: { id: string; type: 'control' | 'manufacturing' | 'trading' | 'power' | 'dormitory'; level: number; product?: 'gold' | 'record' | 'lmd'; atmosphere?: number }[]; onlineSlots: string[] };
  analysis: { mode: 'story' | 'integrated-strategies' | 'reclamation' | 'stationary-security' | 'defense'; goal: string; budget: number };
  lastBackupAt?: string;
}
export interface AppState {
  schemaVersion: 1;
  profileId: string;
  revision: number;
  dataset: Dataset;
  roster: OwnedOperator[];
  settings: Settings;
  batches: BatchRecord[];
  undo?: { batchId: string; roster: OwnedOperator[]; dataset: Dataset };
}

export function known<T extends number | string | boolean>(value: T, source: string, options: Partial<Omit<EvidenceMeta, 'source'>> = {}): EvidenceMeta & { status: 'known'; value: T } {
  return { status: 'known', value, source, importedAt: new Date().toISOString(), manuallyConfirmed: false, ...options };
}
export function unknown(source: string, importedAt = new Date().toISOString()): EvidenceMeta & { status: 'unknown' } {
  return { status: 'unknown', source, importedAt, manuallyConfirmed: false };
}
export function createEmptyState(dataset: Dataset): AppState {
  validateDataset(dataset);
  return { schemaVersion: 1, profileId: `local-${crypto.randomUUID()}`, revision: 0, dataset: structuredClone(dataset), roster: [], settings: { base: { facilities: [], onlineSlots: [] }, analysis: { mode: 'story', goal: '尚未設定', budget: 0 } }, batches: [] };
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function hashValue(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
export async function sealDataset(dataset: { metadata: Omit<DatasetMetadata, 'checksum'>; operators: OperatorDefinition[] }): Promise<Dataset> {
  const result = { ...structuredClone(dataset), metadata: { ...dataset.metadata, checksum: await hashValue(dataset.operators) } };
  validateDataset(result);
  return result;
}
export async function verifyDatasetChecksum(dataset: Dataset): Promise<void> {
  if (await hashValue(dataset.operators) !== dataset.metadata.checksum) throw new Error('資料集校驗值不符，未修改原資料。');
}

type Obj = Record<string, unknown>;
export function object(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('格式錯誤：需要一般 JSON 物件。');
  const result = value as Obj;
  for (const key of Object.keys(result)) if (!allowed.includes(key)) throw new Error(`包含未允許欄位：${key}。請勿匯入憑證或帳號識別資訊。`);
  for (const key of Object.keys(result)) if (result[key] === undefined) throw new Error(`${key} 不能是 undefined；請省略選填欄位或使用明確的未知狀態。`);
  for (const key of required) if (!Object.hasOwn(result, key)) throw new Error(`缺少必要欄位：${key}。`);
  return result;
}
function text(value: unknown, label: string, max = 180): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) throw new Error(`${label} 文字格式錯誤或超出長度。`);
  if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu.test(value) || /(?:cookie|password|token|authorization|uid)\s*[:=]/iu.test(value)) throw new Error(`${label} 不得包含帳號識別資訊或登入憑證。`);
}
function id(value: unknown, label = 'ID'): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/u.test(value)) throw new Error(`${label} 格式錯誤。`);
}
function skillId(value: unknown): asserts value is string {
  // 共用技能可帶尾端數字索引；其餘 ID 規則與既有長度上限不變。
  if (typeof value !== 'string' || value.length > 101 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*(?:\[\d+\])?$/u.test(value)) throw new Error('技能 ID 格式錯誤。');
}
function description(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 6000) throw new Error(`${label} 文字格式錯誤或超出長度。`);
  // 允許一般換行；其餘控制字元與敏感文字仍沿用既有檢查。
  text(value.replace(/\r?\n/gu, ' '), label, 6000);
}
function timestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error('時間必須是有效 UTC ISO 日期。');
}
function integer(value: unknown, min: number, max: number, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label} 超出允許範圍 ${min}–${max}。`);
}
function list(value: unknown, max: number, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} 必須為陣列，最多 ${max} 筆。`);
}
function choice(value: unknown, values: readonly unknown[], label: string): void {
  if (!values.includes(value)) throw new Error(`${label} 不支援。`);
}
function boolean(value: unknown): void { if (typeof value !== 'boolean') throw new Error('欄位必須是布林值。'); }
function checksum(value: unknown): void { if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error('校驗值格式錯誤。'); }
function unique(values: string[], label: string): void { if (new Set(values).size !== values.length) throw new Error(`${label} 有重複 ID。`); }

function validateModule(value: unknown): void {
  const module = object(value, ['id', 'name', 'kind', 'type', 'description', 'unlock', 'missions', 'levels'], ['id', 'name', 'kind']);
  id(module.id); text(module.name, '模組名稱'); text(module.kind, '模組種類', 30);
  if (module.type !== undefined) choice(module.type, ['original', 'advanced'], '模組類別');
  if (module.description !== undefined) description(module.description, '模組背景');
  if (module.unlock !== undefined) {
    const unlock = object(module.unlock, ['elite', 'level']);
    integer(unlock.elite, 0, 2, '模組解鎖精英階段'); integer(unlock.level, 1, 90, '模組解鎖等級');
  }
  if (module.missions !== undefined) {
    list(module.missions, 20, '模組任務');
    for (const value of module.missions) { const mission = object(value, ['id', 'description']); id(mission.id); description(mission.description, '模組任務說明'); }
    unique((module.missions as { id: string }[]).map(mission => mission.id), '模組任務');
  }
  if (module.levels === undefined) return;
  list(module.levels, 3, '模組等級');
  if (module.type === 'original' && module.levels.length) throw new Error('原始模組不支援升級等級。');
  const levels = new Set<number>();
  for (const value of module.levels) {
    const level = object(value, ['level', 'attributes', 'effects', 'costs', 'trust'], ['level', 'attributes', 'effects', 'costs']);
    integer(level.level, 1, 3, '模組等級');
    if (levels.has(level.level)) throw new Error('模組有重複等級。'); levels.add(level.level);
    if (level.trust !== undefined) integer(level.trust, 0, 200, '模組信賴百分比');
    list(level.attributes, 32, '模組屬性'); list(level.effects, 60, '模組條件效果'); list(level.costs, 30, '模組材料');
    for (const value of level.attributes) {
      const attribute = object(value, ['key', 'label', 'value']); id(attribute.key, '模組屬性 key'); text(attribute.label, '模組屬性名稱');
      if (typeof attribute.value !== 'number' || !Number.isFinite(attribute.value)) throw new Error('模組屬性必須是有限數值。');
    }
    unique((level.attributes as { key: string }[]).map(attribute => attribute.key), '模組屬性');
    for (const value of level.effects) {
      const required = ['kind', 'name', 'description', 'elite', 'level', 'potential'];
      const effect = object(value, [...required, 'target', 'isToken', 'validInGameTag', 'validInMapTag', 'validModeIndices'], required);
      choice(effect.kind, ['trait', 'talent'], '模組效果類別'); text(effect.name, '模組效果名稱'); description(effect.description, '模組效果說明');
      integer(effect.elite, 0, 2, '模組效果精英階段'); integer(effect.level, 1, 90, '模組效果等級'); integer(effect.potential, 1, 6, '模組效果潛能');
      for (const key of ['target', 'validInGameTag', 'validInMapTag']) if (effect[key] !== undefined) text(effect[key], '模組效果來源條件', 100);
      if (effect.isToken !== undefined) boolean(effect.isToken);
      if (effect.validModeIndices !== undefined) {
        list(effect.validModeIndices, 20, '模組效果型態索引');
        effect.validModeIndices.forEach(value => integer(value, 0, 100, '模組效果型態索引'));
        if (new Set(effect.validModeIndices).size !== effect.validModeIndices.length) throw new Error('模組效果型態索引重複。');
      }
    }
    for (const value of level.costs) {
      const cost = object(value, ['id', 'name', 'count']); id(cost.id); text(cost.name, '模組材料名稱'); integer(cost.count, 1, Number.MAX_SAFE_INTEGER, '模組材料數量');
    }
    unique((level.costs as { id: string }[]).map(cost => cost.id), '模組材料');
  }
}

export function validateDataset(value: unknown): Dataset {
  const data = object(value, ['metadata', 'operators']);
  const meta = object(data.metadata, ['id', 'version', 'product', 'server', 'namespace', 'validFrom', 'validUntil', 'acquiredAt', 'source', 'licenseStatus', 'checksum'], ['id', 'version', 'product', 'server', 'namespace', 'validFrom', 'acquiredAt', 'source', 'licenseStatus', 'checksum']);
  id(meta.id); text(meta.version, '版本', 60); choice(meta.product, ['arknights'], '產品'); choice(meta.server, ['tw'], '服別'); choice(meta.namespace, ['demo', 'personal'], '命名空間');
  timestamp(meta.validFrom); timestamp(meta.acquiredAt); if (meta.validUntil !== undefined) { timestamp(meta.validUntil); if (meta.validUntil < (meta.validFrom as string)) throw new Error('資料集有效期間錯誤。'); }
  text(meta.source, '來源'); choice(meta.licenseStatus, ['self-authored', 'permitted', 'unknown'], '授權狀態'); checksum(meta.checksum);
  list(data.operators, 2000, '幹員定義');
  for (const item of data.operators) {
    const required = ['id', 'displayName', 'aliases', 'rarity', 'profession', 'branch', 'faction', 'skills', 'modules', 'availability'];
    const op = object(item, [...required, 'portrait', 'talents'], required);
    id(op.id); if (meta.namespace === 'demo' && !(op.id as string).startsWith('demo-')) throw new Error('示範幹員 ID 必須使用 demo- 命名空間。');
    if (meta.namespace === 'personal' && (op.id as string).startsWith('demo-')) throw new Error('私人資料不能使用示範幹員 ID。');
    for (const key of ['displayName', 'profession', 'branch', 'faction']) text(op[key], key);
    integer(op.rarity, 1, 6, '稀有度'); choice(op.availability, ['available', 'unavailable', 'unknown'], '本服可用狀態');
    if (op.portrait !== undefined && (typeof op.portrait !== 'string' || !/^\/assets\/operators\/[A-Za-z0-9_.-]+\.png$/u.test(op.portrait))) throw new Error('幹員圖像必須是指定目錄的本機 PNG 路徑。');
    list(op.aliases, 30, '別名'); op.aliases.forEach(alias => text(alias, '別名'));
    list(op.skills, 10, '技能'); list(op.modules, 10, '模組');
    for (const skill of op.skills) {
      const entry = object(skill, ['id', 'name', 'levels'], ['id', 'name']); skillId(entry.id); text(entry.name, '技能名稱');
      if (entry.levels !== undefined) {
        list(entry.levels, 10, '技能等級說明');
        const levels = new Set<number>();
        for (const inputLevel of entry.levels) {
          const detail = object(inputLevel, ['level', 'description']);
          integer(detail.level, 1, 10, '技能說明等級'); description(detail.description, '技能說明');
          if (levels.has(detail.level)) throw new Error('技能說明有重複等級。');
          levels.add(detail.level);
        }
      }
    }
    for (const module of op.modules) validateModule(module);
    if (op.talents !== undefined) {
      list(op.talents, 30, '天賦條件版本');
      for (const inputTalent of op.talents) {
        const talent = object(inputTalent, ['name', 'description', 'elite', 'level', 'potential']);
        text(talent.name, '天賦名稱'); description(talent.description, '天賦說明');
        integer(talent.elite, 0, 2, '天賦精英階段'); integer(talent.level, 1, 90, '天賦等級'); integer(talent.potential, 1, 6, '天賦潛能');
      }
    }
    unique((op.skills as {id: string}[]).map(s => s.id), '技能'); unique((op.modules as {id: string}[]).map(m => m.id), '模組');
  }
  unique((data.operators as OperatorDefinition[]).map(op => op.id), '幹員定義');
  return value as Dataset;
}

export function fieldKeys(definition: OperatorDefinition): string[] {
  return ['owned', 'elite', 'level', 'potential', 'trust', 'skillLevel', 'equippedSkill', 'equippedModule', ...definition.skills.map(s => `mastery:${s.id}`), ...definition.modules.flatMap(m => [`moduleAvailable:${m.id}`, `moduleUnlocked:${m.id}`, `moduleLevel:${m.id}`])];
}
function validateEvidence(value: unknown, field: string, definition: OperatorDefinition): void {
  const entry = object(value, ['status', 'value', 'source', 'observedAt', 'importedAt', 'confidence', 'manuallyConfirmed', 'locator'], ['status', 'source', 'importedAt', 'manuallyConfirmed']);
  choice(entry.status, ['known', 'unknown', 'not-applicable'], '證據狀態'); text(entry.source, '證據來源'); timestamp(entry.importedAt); boolean(entry.manuallyConfirmed);
  if (entry.observedAt !== undefined) timestamp(entry.observedAt);
  if (entry.confidence !== undefined && (typeof entry.confidence !== 'number' || !Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1)) throw new Error('信心超出允許範圍 0–1。');
  if (entry.locator !== undefined) {
    const locator = object(entry.locator, ['kind', 'assetId', 'frameMs', 'originalRetained'], ['kind', 'assetId', 'originalRetained']);
    choice(locator.kind, ['image', 'video'], '素材種類'); id(locator.assetId, '本機素材 ID'); boolean(locator.originalRetained);
    if (locator.frameMs !== undefined) integer(locator.frameMs, 0, 86_400_000, '影片時間');
    if (locator.kind === 'image' && locator.frameMs !== undefined) throw new Error('圖片不能帶影片時間。');
  }
  if (entry.status !== 'known') { if (Object.hasOwn(entry, 'value')) throw new Error('未知或不適用欄位不得帶值。'); return; }
  if (!Object.hasOwn(entry, 'value')) throw new Error('已知欄位必須帶值。');
  if (field === 'owned' || field.startsWith('moduleUnlocked:') || field.startsWith('moduleAvailable:')) boolean(entry.value);
  else if (field === 'equippedSkill') choice(entry.value, ['none', ...definition.skills.map(s => s.id)], '裝備技能 ID');
  else if (field === 'equippedModule') choice(entry.value, ['none', ...definition.modules.map(m => m.id)], '裝備模組 ID');
  else {
    const ranges: Record<string, [number, number]> = { elite: [0, 2], level: [1, 90], potential: [1, 6], trust: [0, 200], skillLevel: [1, 7] };
    const range = ranges[field] ?? [0, 3];
    integer(entry.value, range[0], range[1], field);
  }
}
export function validateRoster(value: unknown, dataset: Dataset, allowDuplicates = false): OwnedOperator[] {
  list(value, 2000, '個人幹員');
  const definitions = new Map(dataset.operators.map(op => [op.id, op]));
  for (const item of value) {
    const row = object(item, ['operatorId', 'fields']); id(row.operatorId);
    const definition = definitions.get(row.operatorId as string); if (!definition) throw new Error('找不到對應的幹員穩定 ID。');
    const fields = object(row.fields, fieldKeys(definition), []);
    for (const [field, evidence] of Object.entries(fields)) validateEvidence(evidence, field, definition);
  }
  if (!allowDuplicates) unique((value as OwnedOperator[]).map(row => row.operatorId), '個人幹員');
  return value as OwnedOperator[];
}
export function validateImportDocument(value: unknown): ImportDocument {
  const input = object(value, ['format', 'schemaVersion', 'product', 'server', 'namespace', 'dataset', 'candidates', 'completeness', 'source', 'adapterVersion', 'createdAt']);
  choice(input.format, ['arknights-roster-import'], '匯入格式'); choice(input.schemaVersion, [1], '格式版本'); choice(input.product, ['arknights'], '產品'); choice(input.server, ['tw'], '服別'); choice(input.namespace, ['demo', 'personal'], '命名空間');
  const dataset = validateDataset(input.dataset); if (dataset.metadata.namespace !== input.namespace) throw new Error('資料集與匯入命名空間不一致。');
  validateRoster(input.candidates, dataset, true); choice(input.completeness, ['partial', 'complete'], '完整度'); text(input.source, '來源'); text(input.adapterVersion, '轉換器版本', 60); timestamp(input.createdAt);
  return value as ImportDocument;
}
export function parseJson(textValue: string, maxBytes: number): unknown {
  if (new TextEncoder().encode(textValue).byteLength > maxBytes) throw new Error(`檔案過大，上限 ${maxBytes / 1024 / 1024} MB。`);
  try { return JSON.parse(textValue); } catch { throw new Error('JSON 內容無法解析；原資料未修改。'); }
}
export function parseImportText(textValue: string): ImportDocument { return validateImportDocument(parseJson(textValue, MAX_IMPORT_BYTES)); }

function validateSettings(value: unknown): void {
  const settings = object(value, ['base', 'analysis', 'lastBackupAt'], ['base', 'analysis']);
  const base = object(settings.base, ['facilities', 'onlineSlots']); list(base.facilities, 20, '設施'); list(base.onlineSlots, 24, '可上線時段');
  for (const item of base.facilities) {
    const facility = object(item, ['id', 'type', 'level', 'product', 'atmosphere'], ['id', 'type', 'level']); id(facility.id); choice(facility.type, ['control', 'manufacturing', 'trading', 'power', 'dormitory'], '設施種類'); integer(facility.level, 1, 5, '設施等級');
    if (facility.product !== undefined) choice(facility.product, ['gold', 'record', 'lmd'], '產品'); if (facility.atmosphere !== undefined) integer(facility.atmosphere, 0, 10000, '氛圍');
  }
  unique((base.facilities as { id: string }[]).map(f => f.id), '設施');
  for (const slot of base.onlineSlots) if (typeof slot !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(slot)) throw new Error('可上線時段必須為 HH:mm。');
  const analysis = object(settings.analysis, ['mode', 'goal', 'budget']); choice(analysis.mode, ['story', 'integrated-strategies', 'reclamation', 'stationary-security', 'defense'], '分析模式'); text(analysis.goal, '目標'); integer(analysis.budget, 0, 1_000_000_000, '預算');
  if (settings.lastBackupAt !== undefined) timestamp(settings.lastBackupAt);
}
export function validateAppState(value: unknown): AppState {
  const state = object(value, ['schemaVersion', 'profileId', 'revision', 'dataset', 'roster', 'settings', 'batches', 'undo'], ['schemaVersion', 'profileId', 'revision', 'dataset', 'roster', 'settings', 'batches']);
  choice(state.schemaVersion, [1], '資料庫格式版本'); id(state.profileId); if (!(state.profileId as string).startsWith('local-')) throw new Error('設定檔 ID 必須是本機產生的 local- ID。'); integer(state.revision, 0, Number.MAX_SAFE_INTEGER, '修訂版本');
  const dataset = validateDataset(state.dataset); validateRoster(state.roster, dataset); validateSettings(state.settings); list(state.batches, 1000, '批次紀錄');
  for (const item of state.batches) {
    const batch = object(item, ['id', 'kind', 'source', 'contentHash', 'createdAt', 'completeness', 'adapterVersion', 'counts', 'decisions', 'candidates', 'conflicts', 'duplicateOf', 'revertedBatchId'], ['id', 'kind', 'source', 'contentHash', 'createdAt', 'completeness', 'adapterVersion', 'counts', 'decisions', 'candidates', 'conflicts']);
    id(batch.id); choice(batch.kind, ['import', 'undo'], '批次種類'); text(batch.source, '來源'); checksum(batch.contentHash); timestamp(batch.createdAt); choice(batch.completeness, ['partial', 'complete'], '完整度'); text(batch.adapterVersion, '轉換器版本', 60);
    for (const key of ['duplicateOf', 'revertedBatchId']) if (batch[key] !== undefined) id(batch[key]);
    const counts = object(batch.counts, ['added', 'changed', 'repeated', 'conflicts', 'missing']); for (const count of Object.values(counts)) integer(count, 0, 200_000, '批次數量');
    validateRoster(batch.candidates, dataset); list(batch.conflicts, 50_000, '衝突');
    for (const itemConflict of batch.conflicts) {
      const conflict = object(itemConflict, ['id', 'operatorId', 'field', 'current', 'incoming', 'reasons']); text(conflict.id, '衝突 ID', 240); id(conflict.operatorId); text(conflict.field, '衝突欄位');
      validateRoster([{ operatorId: conflict.operatorId, fields: { [conflict.field as string]: conflict.current } }, { operatorId: conflict.operatorId, fields: { [conflict.field as string]: conflict.incoming } }], dataset, true);
      list(conflict.reasons, 10, '衝突原因'); conflict.reasons.forEach(reason => text(reason, '衝突原因'));
    }
    const conflictIds = (batch.conflicts as FieldConflict[]).map(c => c.id); unique(conflictIds, '衝突');
    const decisions = object(batch.decisions, conflictIds, batch.kind === 'import' ? conflictIds : []); Object.values(decisions).forEach(decision => choice(decision, ['keep', 'incoming'], '衝突決策'));
  }
  unique((state.batches as BatchRecord[]).map(batch => batch.id), '批次');
  if (state.undo !== undefined) { const undo = object(state.undo, ['batchId', 'roster', 'dataset']); id(undo.batchId); if (!(state.batches as BatchRecord[]).some(batch => batch.id === undo.batchId && batch.kind === 'import')) throw new Error('撤銷快照找不到匯入批次。'); const previousDataset = validateDataset(undo.dataset); if (previousDataset.metadata.namespace !== dataset.metadata.namespace) throw new Error('撤銷命名空間不一致。'); validateRoster(undo.roster, previousDataset); }
  return value as AppState;
}
