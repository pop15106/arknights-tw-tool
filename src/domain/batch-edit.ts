import { fieldKeys, object, validateAppState, validateImportDocument, type AppState, type Evidence, type ImportDocument, type OperatorDefinition } from './model.ts';
import { changeModuleIssues, formatModuleIssues, isOriginalModule, type ModuleIssue } from './module-consistency.ts';

export function assertModuleConsistency(issues: readonly ModuleIssue[]): void {
  if (issues.length) throw new Error(`模組解鎖、等級或裝備互相矛盾，請一併調整相關欄位：${formatModuleIssues(issues)}`);
}

export const BATCH_FIELDS = {
  elite: { label: '精英階段', min: 0, max: 2 },
  level: { label: '等級', min: 1, max: 90 },
  potential: { label: '潛能', min: 1, max: 6 },
  trust: { label: '信賴', min: 0, max: 200 },
  skillLevel: { label: '技能等級', min: 1, max: 7 },
} as const;
export type BatchField = keyof typeof BATCH_FIELDS;
export type BatchChange = { status: 'known'; value: number } | { status: 'unknown' };
export type GridChange = { status: 'known'; value: number | string | boolean } | { status: 'unknown' | 'not-applicable' };
export interface BatchModuleChange {
  kind: string;
  unlocked?: 'yes' | 'no' | 'unknown';
  level?: BatchChange;
  equipped?: 'selected' | 'none' | 'unknown';
}

export function matchingModules(definition: OperatorDefinition, kind: string) {
  return definition.modules.filter(module => !isOriginalModule(module) && module.kind.split('-').at(-1) === kind);
}

export function createBatchEdit(state: AppState, operatorIds: readonly string[], changes: Partial<Record<BatchField, BatchChange>>, createdAt = new Date().toISOString(), moduleChange?: BatchModuleChange): ImportDocument {
  if (!operatorIds.length || operatorIds.length > state.roster.length || new Set(operatorIds).size !== operatorIds.length) throw new Error('請選取不重複的已建檔幹員。');
  const owned = new Set(state.roster.map(row => row.operatorId));
  if (operatorIds.some(id => !owned.has(id))) throw new Error('批次修正只能調整目前已建檔的幹員。');
  const entries = Object.entries(changes);
  if ((!entries.length && !moduleChange) || entries.some(([field]) => !Object.hasOwn(BATCH_FIELDS, field))) throw new Error('請勾選本次要調整的養成欄位。');
  const fields: Record<string, Evidence> = {};
  for (const [field, change] of entries) {
    if (!change || !['known', 'unknown'].includes(change.status) || Object.keys(change).some(key => !['status', 'value'].includes(key))) throw new Error('批次修正欄位格式錯誤。');
    const meta = { source: '使用者在本機批次修正', importedAt: createdAt, observedAt: createdAt, manuallyConfirmed: true };
    if (change.status === 'unknown') {
      if ('value' in change) throw new Error('未知欄位不能帶數值。');
      fields[field] = { ...meta, status: 'unknown' };
    } else {
      const limit = BATCH_FIELDS[field as BatchField];
      if (!Number.isInteger(change.value) || change.value < limit.min || change.value > limit.max) throw new Error(`${limit.label}須為 ${limit.min}–${limit.max} 的整數。`);
      fields[field] = { ...meta, status: 'known', value: change.value };
    }
  }
  if (moduleChange) {
    if (Object.entries(moduleChange).some(([key, value]) => !['kind', 'unlocked', 'level', 'equipped'].includes(key) || value === undefined || value === null) || !['X', 'Y', 'D', 'A', 'B'].includes(moduleChange.kind)
      || !['unlocked', 'level', 'equipped'].some(key => Object.hasOwn(moduleChange, key))) throw new Error('請選取模組類型與要調整的模組欄位。');
    if (moduleChange.unlocked !== undefined && !['yes', 'no', 'unknown'].includes(moduleChange.unlocked)) throw new Error('模組解鎖狀態無效。');
    if (moduleChange.equipped !== undefined && !['selected', 'none', 'unknown'].includes(moduleChange.equipped)) throw new Error('模組裝備狀態無效。');
    if (moduleChange.level !== undefined && (typeof moduleChange.level !== 'object' || moduleChange.level === null || Array.isArray(moduleChange.level))) throw new Error('模組等級格式錯誤。');
    if (moduleChange.level !== undefined && (Object.keys(moduleChange.level).some(key => !['status', 'value'].includes(key)) || !['known', 'unknown'].includes(moduleChange.level.status)
      || (moduleChange.level.status === 'known' ? !Number.isInteger(moduleChange.level.value) || moduleChange.level.value < 0 || moduleChange.level.value > 3 : 'value' in moduleChange.level))) throw new Error('模組等級須為 0–3 的整數，或明確設為未知。');
  }
  const definitions = new Map(state.dataset.operators.map(definition => [definition.id, definition]));
  const candidates = operatorIds.map(operatorId => {
    const nextFields = structuredClone(fields);
    if (moduleChange) {
      const definition = definitions.get(operatorId)!;
      const matches = matchingModules(definition, moduleChange.kind);
      if (matches.length !== 1) throw new Error(`${definition.displayName}沒有唯一對應的 ${moduleChange.kind} 類模組，請調整勾選範圍。`);
      const module = matches[0], meta = { source: '使用者在本機批次修正', importedAt: createdAt, observedAt: createdAt, manuallyConfirmed: true };
      if (moduleChange.unlocked !== undefined) nextFields[`moduleUnlocked:${module.id}`] = moduleChange.unlocked === 'unknown' ? { ...meta, status: 'unknown' } : { ...meta, status: 'known', value: moduleChange.unlocked === 'yes' };
      if (moduleChange.level !== undefined) nextFields[`moduleLevel:${module.id}`] = { ...meta, ...moduleChange.level };
      if (moduleChange.equipped !== undefined) nextFields.equippedModule = moduleChange.equipped === 'unknown' ? { ...meta, status: 'unknown' } : { ...meta, status: 'known', value: moduleChange.equipped === 'selected' ? module.id : 'none' };
      const row = state.roster.find(item => item.operatorId === operatorId)!;
      const moduleFields = Object.fromEntries(Object.entries(nextFields).filter(([key]) => key === 'equippedModule' || key.startsWith('module')));
      assertModuleConsistency(changeModuleIssues(definition, row, moduleFields));
    }
    return { operatorId, fields: nextFields };
  });
  return validateImportDocument({ format: 'arknights-roster-import', schemaVersion: 1, product: 'arknights', server: 'tw', namespace: state.dataset.metadata.namespace, dataset: structuredClone(state.dataset),
    candidates, completeness: 'partial', source: '使用者在本機批次修正', adapterVersion: 'manual-batch-1', createdAt });
}

export function createGridEdit(state: AppState, edits: Record<string, Record<string, GridChange>>, createdAt = new Date().toISOString()): ImportDocument {
  validateAppState(state);
  const roster = new Map(state.roster.map(row => [row.operatorId, row]));
  const definitions = new Map(state.dataset.operators.map(definition => [definition.id, definition]));
  const entries = Object.entries(object(edits, [...roster.keys()], []));
  if (!entries.length) throw new Error('請選取已建檔幹員與本次要修正的欄位。');
  const source = '使用者在本機批次修正';
  const meta = { source, importedAt: createdAt, observedAt: createdAt, manuallyConfirmed: true };
  const candidates = entries.map(([operatorId, changes]) => {
    const definition = definitions.get(operatorId)!;
    const selected = Object.entries(object(changes, fieldKeys(definition), []));
    if (!selected.length) throw new Error(`${definition.displayName}尚未選取要修正的欄位。`);
    const fields: Record<string, Evidence> = {};
    for (const [field, value] of selected) {
      const change = object(value, ['status', 'value'], ['status']);
      if (!['known', 'unknown', 'not-applicable'].includes(change.status as string)) throw new Error('表格修正欄位狀態無效。');
      if (change.status === 'known' ? !Object.hasOwn(change, 'value') : Object.hasOwn(change, 'value')) throw new Error('已知欄位須帶值，未知或不適用欄位不能帶值。');
      fields[field] = { ...meta, ...structuredClone(change) } as Evidence;
    }
    return { operatorId, fields };
  });
  // 先核對所有列的欄位型別與範圍，再檢查模組關係；任一失敗都不產生可接受候選。
  const input = validateImportDocument({ format: 'arknights-roster-import', schemaVersion: 1, product: 'arknights', server: 'tw', namespace: state.dataset.metadata.namespace,
    dataset: structuredClone(state.dataset), candidates, completeness: 'partial', source, adapterVersion: 'manual-grid-1', createdAt });
  for (const candidate of input.candidates) assertModuleConsistency(changeModuleIssues(definitions.get(candidate.operatorId)!, roster.get(candidate.operatorId), candidate.fields));
  return input;
}
