import type { Evidence, ModuleDefinition, OperatorDefinition, OwnedOperator } from './model.ts';

// 單人更正、批次修正與一般匯入共用的模組關聯規則。
// 只比對已知值：未知與不適用不推論為零、未解鎖或未裝備。
export interface ModuleIssue { operatorId: string; moduleId: string; message: string }

const MODULE_PREFIXES = ['moduleAvailable:', 'moduleUnlocked:', 'moduleLevel:'] as const;

export function isOriginalModule(module: Pick<ModuleDefinition, 'type' | 'kind'>): boolean {
  return module.type === 'original' || module.kind.toUpperCase() === 'ORIGINAL';
}

type Fields = Record<string, Evidence | undefined>;
const knownValue = (fields: Fields, key: string) => { const evidence = fields[key]; return evidence?.status === 'known' ? evidence.value : undefined; };

/** 單一模組的矛盾說明（不含幹員名稱）；空陣列表示沒有可判定的矛盾。 */
export function moduleProblems(module: ModuleDefinition, fields: Fields): string[] {
  const original = isOriginalModule(module);
  const unlocked = knownValue(fields, `moduleUnlocked:${module.id}`), level = knownValue(fields, `moduleLevel:${module.id}`), equipped = knownValue(fields, 'equippedModule') === module.id;
  if (original && typeof level === 'number' && level > 0) return ['是原始證章，不可升級。'];
  const problems: string[] = [];
  if (unlocked === false && typeof level === 'number' && level > 0) problems.push('標示未解鎖，卻有模組等級。');
  if (unlocked === false && equipped) problems.push('標示未解鎖，卻設為裝備中。');
  // 原始證章沒有升級階段，0 級是正常狀態。
  if (!original && level === 0 && unlocked === true) problems.push('標示已解鎖，但等級為 0。');
  if (!original && level === 0 && equipped) problems.push('設為裝備中，但等級為 0。');
  return problems;
}

/** 檢查一筆合併後的有效紀錄；`moduleIds` 省略時檢查全部模組。 */
export function moduleIssuesFor(definition: OperatorDefinition, fields: Fields, moduleIds?: Iterable<string>): ModuleIssue[] {
  const ids = moduleIds ? new Set(moduleIds) : new Set(definition.modules.map(module => module.id));
  return definition.modules.filter(module => ids.has(module.id)).flatMap(module => moduleProblems(module, fields)
    .map(problem => ({ operatorId: definition.id, moduleId: module.id, message: `${definition.displayName}「${module.name}」${problem}` })));
}

/** 由本次變更欄位推得受影響模組，包含裝備前後兩個模組。 */
export function affectedModuleIds(changedFields: Iterable<string>, previous: Fields, next: Fields): Set<string> {
  const affected = new Set<string>();
  let equipChanged = false;
  for (const field of changedFields) {
    if (field === 'equippedModule') equipChanged = true;
    for (const prefix of MODULE_PREFIXES) if (field.startsWith(prefix)) affected.add(field.slice(prefix.length));
  }
  if (equipChanged) for (const fields of [previous, next]) {
    const value = knownValue(fields, 'equippedModule');
    if (typeof value === 'string' && value !== 'none') affected.add(value);
  }
  return affected;
}

/** 以「舊值＋本次變更」計算有效狀態，只回報本次觸及的模組，既有但未觸及的矛盾不阻擋其他修正。 */
export function changeModuleIssues(definition: OperatorDefinition, previous: OwnedOperator | undefined, changes: Fields, merged?: Fields): ModuleIssue[] {
  const before: Fields = previous?.fields ?? {};
  const after: Fields = merged ?? { ...before, ...Object.fromEntries(Object.entries(changes).filter(([, evidence]) => evidence !== undefined)) };
  return moduleIssuesFor(definition, after, affectedModuleIds(Object.keys(changes), before, after));
}

export function formatModuleIssues(issues: readonly ModuleIssue[], limit = 5): string {
  const shown = issues.slice(0, limit).map(issue => issue.message).join(' ');
  return issues.length > limit ? `${shown} 另有 ${issues.length - limit} 項。` : shown;
}
