// 公開招募：可招募幹員（gacha_table.recruitDetail）與標籤（gachaTags）；幹員標籤＝職業、站位、星級、招募標籤。
type Row = Record<string, any>;

export interface RecruitOperator { id: string; name: string; rarity: number; tags: string[]; recruitOnly: boolean }
export interface RecruitCatalog { tags: string[]; operators: RecruitOperator[]; rules: string[] }

const PROFESSION_TAG: Record<string, string> = { PIONEER: '先鋒幹員', WARRIOR: '近衛幹員', TANK: '重裝幹員', SNIPER: '狙擊幹員', CASTER: '術師幹員', MEDIC: '醫療幹員', SUPPORT: '輔助幹員', SPECIAL: '特種幹員' };
const POSITION_TAG: Record<string, string> = { MELEE: '近戰位', RANGED: '遠程位' };
const plain = (text: string) => text.replace(/<[@$][^>]*>|<\/>/gu, '');

export function buildRecruitCatalog(gacha: unknown, characters: Row): RecruitCatalog | undefined {
  const table = gacha as Row | undefined;
  const detail = typeof table?.recruitDetail === 'string' ? table.recruitDetail : '';
  const tags = Array.isArray(table?.gachaTags) ? table!.gachaTags.filter((tag: Row) => typeof tag?.tagName === 'string' && Number(tag.tagId) < 1000).map((tag: Row) => String(tag.tagName)) : [];
  if (!detail || !tags.length) return undefined;
  const byName = new Map<string, [string, Row]>();
  for (const [id, char] of Object.entries(characters)) if (id.startsWith('char_') && typeof char?.name === 'string' && !byName.has(char.name)) byName.set(char.name, [id, char]);
  const operators: RecruitOperator[] = [];
  let rarity = 0;
  for (const raw of detail.split('\n')) {
    const line = raw.trim();
    if (/^★+$/u.test(line)) { rarity = line.length; continue; }
    if (!rarity || line.startsWith('---')) continue;
    for (const part of line.split(' / ')) {
      const name = plain(part).trim();
      const found = byName.get(name);
      if (!name || !found) continue;
      const [id, char] = found;
      const own = [PROFESSION_TAG[char.profession], POSITION_TAG[char.position], ...(Array.isArray(char.tagList) ? char.tagList : [])].filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
      if (rarity === 6) own.push('高級資深幹員'); else if (rarity === 5) own.push('資深幹員');
      operators.push({ id, name, rarity, tags: [...new Set(own)].filter(tag => tags.includes(tag)), recruitOnly: part.includes('<@rc.eml>') });
    }
  }
  const rules = plain(detail).split('\n').map(line => line.trim()).filter(line => /招募時限|必得/u.test(line));
  return operators.length ? { tags, operators, rules } : undefined;
}
