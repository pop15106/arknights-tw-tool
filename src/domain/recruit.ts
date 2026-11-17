import type { RecruitCatalog, RecruitOperator } from '../catalog/recruit.ts';

/* ------------------------------------------------------------------ */
/* 公開招募：選出的標籤取 1～3 個的所有組合，列出可能出現的幹員與保底星級。 */
/* 規則：六星只在選了「高級資深幹員」時出現（遊戲說明）；                   */
/* 招募時間 7:40 以上不會出現一、二星（社群通行規則，遊戲內未明示）。        */
/* ------------------------------------------------------------------ */
export interface RecruitCombo { tags: string[]; operators: RecruitOperator[]; min: number; max: number }

export function recruitCombos(catalog: RecruitCatalog, selected: readonly string[], options: { longTime: boolean } = { longTime: true }): RecruitCombo[] {
  const tags = [...new Set(selected)].filter(tag => catalog.tags.includes(tag)).slice(0, 5);
  const combos: RecruitCombo[] = [];
  const total = 1 << tags.length;
  for (let mask = 1; mask < total; mask++) {
    const subset = tags.filter((_, index) => mask & (1 << index));
    if (subset.length > 3) continue;
    const operators = catalog.operators.filter(op => subset.every(tag => op.tags.includes(tag))
      && (op.rarity !== 6 || subset.includes('高級資深幹員'))
      && (!options.longTime || op.rarity >= 3))
      .sort((a, b) => b.rarity - a.rarity || a.name.localeCompare(b.name, 'zh-Hant'));
    if (!operators.length) continue;
    combos.push({ tags: subset, operators, min: Math.min(...operators.map(op => op.rarity)), max: Math.max(...operators.map(op => op.rarity)) });
  }
  return combos.sort((a, b) => b.min - a.min || b.max - a.max || a.operators.length - b.operators.length || a.tags.length - b.tags.length);
}
