import { MAX_IMPORT_BYTES, fieldKeys, known, unknown, validateDataset, validateImportDocument, verifyDatasetChecksum, type Dataset, type Evidence, type ImportDocument, type OperatorDefinition, type OwnedOperator } from '../domain/model.ts';

export interface SkportConversionOptions {
  dataset: Dataset;
  confirmation: { product: 'arknights'; server: 'tw'; confirmedByUser: true };
  importedAt: string;
}
export interface SkportIssue {
  code: 'unverified-source' | 'partial-only' | 'missing-field' | 'unsupported-potential' | 'unsupported-module-state';
  message: string;
  row?: number;
  field?: string;
}
export interface SkportConversionResult { document: ImportDocument; issues: SkportIssue[] }

type JsonObject = Record<string, unknown>;
const SOURCE = 'SKPORT 離線研究資料（來源未驗證）';
const MAX_ROWS = 2000;
const MAX_DEPTH = 20;
const MAX_NODES = 200_000;
// 分級模組圖鑑含大量公開條件節點；仍受相同深度、容量與資料集 schema 限制。
const MAX_CATALOG_OPTION_NODES = 500_000;
const sensitiveKey = /token|password|passwd|cookie|authorization|credential|session|secret|accesskey|ticket|^cred$/iu;
const numericFields = [
  ['evolvePhase', 'elite', 0, 2], ['level', 'level', 1, 90],
  ['favorPercent', 'trust', 0, 200], ['mainSkillLvl', 'skillLevel', 1, 7],
] as const;

function record(value: unknown, message: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(message);
  return value as JsonObject;
}

// 先驗證純 JSON 結構；不執行 getter，不把原始欄位、值或帳號資訊寫入錯誤。
function inspectJson(value: unknown, catalogOptions = false): void {
  const seen = new WeakSet<object>();
  const maxNodes = catalogOptions ? MAX_CATALOG_OPTION_NODES : MAX_NODES;
  let nodes = 0;
  let bytes = 0;
  const encoder = new TextEncoder();
  function visit(current: unknown, depth: number, path = ''): void {
    if (++nodes > maxNodes || depth > MAX_DEPTH) throw new Error('研究輸入超出 JSON 結構限制。');
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'string') {
      bytes += encoder.encode(current).byteLength;
      if (bytes > MAX_IMPORT_BYTES) throw new Error('研究輸入超出容量限制。');
      return;
    }
    if (typeof current === 'number' && Number.isFinite(current)) return;
    if (typeof current !== 'object') throw new Error('研究輸入必須是純 JSON 資料。');
    if (seen.has(current)) throw new Error('研究輸入不得包含循環或共用的非 JSON 物件。');
    seen.add(current);
    if (!Array.isArray(current)) record(current, '研究輸入必須是一般 JSON 物件。');
    for (const key of Reflect.ownKeys(current)) {
      if (Array.isArray(current) && key === 'length') continue;
      if (typeof key !== 'string') throw new Error('研究輸入必須是純 JSON 資料。');
      const property = Object.getOwnPropertyDescriptor(current, key)!;
      if (!Object.hasOwn(property, 'value') || !property.enumerable) throw new Error('研究輸入不得包含 JSON 以外的屬性。');
      const nextPath = path ? `${path}.${key}` : key;
      // 只允許呼叫端資料集的既定召喚物條件；原始研究輸入仍嚴格拒絕同名欄位。
      // 此後 validateDataset 會再次驗證完整路徑形狀、欄位與型別。
      const moduleTarget = catalogOptions && key === 'isToken' && typeof property.value === 'boolean'
        && /^dataset\.operators\.\d+\.modules\.\d+\.levels\.\d+\.effects\.\d+\.isToken$/u.test(nextPath);
      if (sensitiveKey.test(key.replace(/[-_\s]/gu, '')) && !moduleTarget) throw new Error('研究輸入包含登入憑證，已拒絕轉換。');
      visit(key, depth + 1);
      visit(property.value, depth + 1, nextPath);
    }
  }
  visit(value, 0);
}

function validateOptions(options: SkportConversionOptions): Dataset {
  inspectJson(options, true);
  const settings = record(options, '需要明確確認產品與服別。');
  const confirmed = record(settings.confirmation, '需要明確確認產品與服別。');
  if (confirmed.product !== 'arknights' || confirmed.server !== 'tw' || confirmed.confirmedByUser !== true) throw new Error('需要由呼叫者明確確認本作與繁中服；此確認不是登入實證。');
  if (Object.keys(settings).some(key => !['dataset', 'confirmation', 'importedAt'].includes(key)) || Object.keys(confirmed).some(key => !['product', 'server', 'confirmedByUser'].includes(key))) throw new Error('轉換設定包含未允許欄位。');
  let dataset: Dataset;
  try { dataset = validateDataset(settings.dataset); } catch { throw new Error('資料集格式無效；必須提供既有穩定 ID 定義。'); }
  if (dataset.metadata.namespace !== 'personal') throw new Error('SKPORT 研究轉換只接受私人資料集。');
  return dataset;
}

function decodedCharacters(value: unknown): unknown[] {
  const input = record(value, '需要明確標示 SKPORT 離線研究格式。');
  if (input.format !== 'skport-offline-research' || input.schemaVersion !== 1 || Object.keys(input).some(key => !['format', 'schemaVersion', 'gameData'].includes(key))) throw new Error('研究格式或版本不支援；不是官方匯出格式。');
  const response = record(input.gameData, '需要已解碼的研究回應封裝。');
  if (response.code !== 0) throw new Error('研究回應未明確成功，已拒絕轉換。');
  const data = record(response.data, '研究回應缺少資料物件。');
  if (!Array.isArray(data.chars)) throw new Error('研究回應缺少 chars 陣列；助戰或未解碼資料不能當持有庫。');
  if (data.chars.length > MAX_ROWS) throw new Error('幹員筆數超出限制。');
  return data.chars;
}

function missing(issues: SkportIssue[], row: number, field: string): void {
  issues.push({ code: 'missing-field', row, field, message: '欄位缺漏、為 null 或空字串，保留未知。' });
}

function numberField(value: unknown, min: number, max: number, row: number, field: string, importedAt: string, issues: SkportIssue[]): Evidence {
  if (value === undefined || value === null) { missing(issues, row, field); return unknown(SOURCE, importedAt); }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error('研究幹員欄位值不符合既有資料模型，已拒絕整批。');
  return researchValue(value, importedAt);
}

function researchValue(value: number | boolean | string, importedAt: string): Evidence {
  // 0 表示來源尚未驗證，用於要求逐欄確認；不是量測得到的辨識準確率。
  return known(value, SOURCE, { importedAt, confidence: 0, manuallyConfirmed: false });
}

function stableId(value: unknown, permitted: Set<string>): string {
  if (typeof value !== 'string' || !permitted.has(value)) throw new Error('來源缺少可核對的穩定 ID 定義，已拒絕整批；不使用序號猜測。');
  return value;
}

function equipped(value: unknown, ids: Set<string>, row: number, field: string, importedAt: string, issues: SkportIssue[]): Evidence {
  // 空 ID 只有缺值意義，不推定已確認未裝備。
  if (value === undefined || value === null || value === '') { missing(issues, row, field); return unknown(SOURCE, importedAt); }
  return researchValue(stableId(value, ids), importedAt);
}

function childRows(value: unknown, permitted: Set<string>): JsonObject[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 10) throw new Error('技能或模組清單形狀不支援或超出限制。');
  const seen = new Set<string>();
  return value.map(item => {
    const entry = record(item, '技能或模組需要一般 JSON 物件。');
    const id = stableId(entry.id, permitted);
    if (seen.has(id)) throw new Error('技能或模組有重複穩定 ID，已拒絕整批。');
    seen.add(id);
    return entry;
  });
}

function convertCharacter(input: unknown, definition: OperatorDefinition, row: number, importedAt: string, issues: SkportIssue[]): OwnedOperator {
  const char = record(input, '幹員需要一般 JSON 物件。');
  const fields = Object.fromEntries(fieldKeys(definition).map(key => [key, unknown(SOURCE, importedAt)])) as Record<string, Evidence>;
  const skills = new Set(definition.skills.map(skill => skill.id));
  const modules = new Set(definition.modules.map(module => module.id));
  fields.owned = researchValue(true, importedAt);
  for (const [sourceKey, field, min, max] of numericFields) fields[field] = numberField(char[sourceKey], min, max, row, field, importedAt, issues);
  fields.equippedSkill = equipped(char.defaultSkillId, skills, row, 'equippedSkill', importedAt, issues);
  fields.equippedModule = equipped(char.defaultEquipId, modules, row, 'equippedModule', importedAt, issues);
  for (const skill of childRows(char.skills, skills)) {
    const field = `mastery:${skill.id as string}`;
    fields[field] = numberField(skill.specializeLevel, 0, 3, row, field, importedAt, issues);
  }
  childRows(char.equip, modules);
  if (definition.skills.some(skill => fields[`mastery:${skill.id}`].status === 'unknown')) missing(issues, row, 'mastery');
  issues.push({ code: 'unsupported-potential', row, field: 'potential', message: '潛能原始值的起算方式未驗證，保留未知。' });
  if (definition.modules.length) issues.push({ code: 'unsupported-module-state', row, message: '模組開放、解鎖與等級語義未驗證，全部保留未知。' });
  return { operatorId: definition.id, fields };
}

/**
 * 只處理本工具自訂的離線研究封裝：
 * { format: 'skport-offline-research', schemaVersion: 1, gameData: { code: 0, data: { chars: [...] } } }。
 * gameData 必須已解碼；不接受 HTTP/base64 封裝，不提供取得資料、登入或網路功能。
 * 呼叫者確認產品／服別不代表來源可信。結果一律 partial，已知值仍須人工確認。
 */
export async function convertSkportOffline(input: unknown, options: SkportConversionOptions): Promise<SkportConversionResult> {
  // 非研究格式先拒絕，避免把官方匯出或任意 HTTP 資料誤認成支援格式。
  const initial = record(input, '需要明確標示 SKPORT 離線研究格式。');
  inspectJson(input);
  if (initial.format !== 'skport-offline-research') throw new Error('需要明確標示 SKPORT 離線研究格式。');
  const dataset = validateOptions(options);
  const document: ImportDocument = {
    format: 'arknights-roster-import', schemaVersion: 1, product: 'arknights', server: 'tw', namespace: 'personal',
    dataset: structuredClone(dataset), candidates: [], completeness: 'partial', source: SOURCE, adapterVersion: 'skport-offline-research-1', createdAt: options.importedAt,
  };
  validateImportDocument(document);
  const rows = decodedCharacters(initial);
  const definitions = new Map(dataset.operators.map(definition => [definition.id, definition]));
  const issues: SkportIssue[] = [
    { code: 'unverified-source', message: '來源、回應與繁中相容性未經帳號實測；呼叫者確認不等於官方驗證，所有已知值須人工確認。' },
    { code: 'partial-only', message: '僅投影 chars 中可核對的欄位；不推定角色持有庫或養成欄位完整，也不使用助戰清單。' },
  ];
  const seen = new Set<string>();
  const ids = new Set(definitions.keys());
  document.candidates = rows.map((value, index) => {
    const char = record(value, '幹員需要一般 JSON 物件。');
    const id = stableId(char.charId, ids);
    if (seen.has(id)) throw new Error('幹員有重複穩定 ID，已拒絕整批。');
    seen.add(id);
    return convertCharacter(char, definitions.get(id)!, index + 1, options.importedAt, issues);
  });
  validateImportDocument(document);
  // 所有來源讀取與投影在第一個 await 前完成；非同步校驗只讀取獨立輸出快照。
  try { await verifyDatasetChecksum(document.dataset); } catch { throw new Error('資料集校驗值不符，已拒絕轉換。'); }
  return { document, issues };
}
