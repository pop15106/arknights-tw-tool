import type { OperatorDefinition } from './model.ts';

/* ------------------------------------------------------------------ */
/* 幹員相性：只依天賦、技能、模組說明文字中明寫的對象（【】標記、幹員名稱）。 */
/* ------------------------------------------------------------------ */
export type SynergyTrigger = 'squad' | 'deployed' | 'skill' | 'always';
export interface SynergyLink {
  providerId: string;
  source: { kind: '天賦' | '技能' | '模組'; name: string; description: string };
  /** 同一提供者對同一對象的其他相關說明（例如天賦與模組）。 */
  more?: { kind: '天賦' | '技能' | '模組'; name: string; description: string }[];
  trigger: SynergyTrigger;
  /** 受益對象：職業、分支、陣營、星級或指定幹員。 */
  target: { kind: 'profession' | 'branch' | 'group' | 'rarity' | 'operator' | 'position'; value: string; label: string };
  /** 需要至少幾名該對象才生效（例如「編隊中有 4 名」）。 */
  minCount?: number;
  /** 只在特定模式生效（例如集成戰略主題）。 */
  mode?: string;
  beneficiaries: string[];
}
export interface DebuffLink { providerId: string; status: string; source: { kind: '天賦' | '技能' | '模組'; name: string; description: string } }

export const PROFESSIONS = ['先鋒', '近衛', '重裝', '狙擊', '術師', '醫療', '輔助', '特種'];
const RARITY: Record<string, number> = { 一星: 1, 二星: 2, 三星: 3, 四星: 4, 五星: 5, 六星: 6 };
const STATUS = /^(法術|物理|元素)脆弱$/u;
/** 對敵人的減益類型 → 適合搭配的輸出類型。 */
export const DEBUFF_PARTNER: Record<string, string> = { 物理脆弱: '物理輸出', 法術脆弱: '法術輸出（術師等）', 元素脆弱: '元素損傷', 脆弱: '所有輸出', 防禦力降低: '物理輸出', 法術抗性降低: '法術輸出（術師等）' };
const DEBUFFS: [RegExp, string][] = [
  [/物理脆弱|受到的物理傷害(?:提升|增加)/u, '物理脆弱'], [/法術脆弱|受到的法術傷害(?:提升|增加)/u, '法術脆弱'], [/元素脆弱/u, '元素脆弱'],
  [/(?<![物法元][理術素])脆弱/u, '脆弱'], [/防禦力-|防禦力降低/u, '防禦力降低'], [/法術抗性-|法術抗性降低/u, '法術抗性降低'],
];
const TRIGGER: [RegExp, SynergyTrigger][] = [[/編入隊伍時|編隊中有|隊伍中有/u, 'squad'], [/在場時|在場，|每有.{0,10}在場|在場\d+秒/u, 'deployed'], [/技能(?:期間|開啟)/u, 'skill']];

interface Text { kind: '天賦' | '技能' | '模組'; name: string; description: string }
/** 每個天賦取最高條件（精英、等級、潛能）的版本；技能取最高等級；模組取最高等級的效果。 */
export function operatorTexts(definition: OperatorDefinition): Text[] {
  const talents = new Map<string, NonNullable<OperatorDefinition['talents']>[number]>();
  for (const talent of definition.talents ?? []) {
    const current = talents.get(talent.name);
    const rank = (item: typeof talent) => item.elite * 10000 + item.level * 10 + item.potential;
    if (!current || rank(talent) > rank(current)) talents.set(talent.name, talent);
  }
  return [
    ...[...talents.values()].map(talent => ({ kind: '天賦' as const, name: talent.name, description: talent.description })),
    ...definition.skills.flatMap(skill => { const last = skill.levels?.at(-1); return last ? [{ kind: '技能' as const, name: skill.name, description: last.description }] : []; }),
    ...definition.modules.flatMap(module => { const last = module.levels?.at(-1); return (last?.effects ?? []).map(effect => ({ kind: '模組' as const, name: module.name, description: effect.description })); }),
  ];
}

export function analyzeSynergies(definitions: readonly OperatorDefinition[], groupsOf: (id: string) => readonly string[], scope?: ReadonlySet<string>): { links: SynergyLink[]; debuffs: DebuffLink[] } {
  const allGroups = new Set(definitions.flatMap(def => groupsOf(def.id)));
  const branches = new Set(definitions.map(def => def.branch).filter(Boolean));
  const byName = new Map(definitions.map(def => [def.displayName, def]));
  const pool = definitions.filter(def => !scope || scope.has(def.id));
  const links: SynergyLink[] = [], debuffs: DebuffLink[] = [];
  const seen = new Set<string>();
  for (const provider of definitions) {
    for (const text of operatorTexts(provider)) {
      const d = text.description;
      const trigger = TRIGGER.find(([pattern]) => pattern.test(d))?.[1] ?? 'always';
      const mode = d.match(/在【([^】]+)】中/u)?.[1];
      for (const match of d.matchAll(/【([^】]+)】/gu)) {
        const value = match[1];
        if (value === mode) continue;
        const after = d.slice(match.index! + match[0].length, match.index! + match[0].length + 4);
        const before = d.slice(Math.max(0, match.index! - 4), match.index!);
        if (STATUS.test(value)) continue;
        // 敵人類型（感染生物、海怪等）不是我方相性。
        if (/^敵人|^的敵人|單位/u.test(after) && !/幹員/u.test(after)) continue;
        if (!/^(幹員|職業|的|分支)/u.test(after) && !/所有|友方|每有|有|名/u.test(before)) continue;
        const target: SynergyLink['target'] | undefined = PROFESSIONS.includes(value) ? { kind: 'profession', value, label: `${value}職業` }
          : branches.has(value) ? { kind: 'branch', value, label: `${value}分支` }
          : allGroups.has(value) ? { kind: 'group', value, label: value }
          : value === '近戰位' || value === '遠程位' ? { kind: 'position', value, label: value } : undefined;
        if (!target) continue;
        const minCount = Number(d.match(new RegExp(`(?:有|存在)(\\d+)名【${value}】`, 'u'))?.[1]) || undefined;
        const existing = links.find(link => link.providerId === provider.id && link.target.kind === target.kind && link.target.value === value);
        if (existing) { if (existing.source.description !== d && !existing.more?.some(item => item.description === d)) (existing.more ??= []).push(text); continue; }
        const beneficiaries = pool.filter(def => def.id !== provider.id && matches(def, target, groupsOf)).map(def => def.id);
        links.push({ providerId: provider.id, source: text, trigger, target, ...(minCount ? { minCount } : {}), ...(mode ? { mode } : {}), beneficiaries });
      }
      const rarity = d.match(/所有(一星|二星|三星|四星|五星|六星)幹員/u);
      if (rarity && trigger !== 'always') {
        const target = { kind: 'rarity' as const, value: String(RARITY[rarity[1]]), label: `${rarity[1]}幹員` };
        links.push({ providerId: provider.id, source: text, trigger, target, beneficiaries: pool.filter(def => def.id !== provider.id && matches(def, target, groupsOf)).map(def => def.id) });
      }
      // 對敵人的減益：以子句判斷，子句需提到敵人或目標，且不是作用在自身。
      for (const clause of d.split(/[，。；\n]/u)) {
        if (!/敵人|目標/u.test(clause) || /^自身|自身.{0,4}(?:脆弱|防禦力-|法術抗性-)/u.test(clause)) continue;
        for (const [pattern, status] of DEBUFFS) {
          if (!pattern.test(clause)) continue;
          const key = `${provider.id}|${status}`;
          if (seen.has(key)) continue; seen.add(key);
          debuffs.push({ providerId: provider.id, status, source: text });
        }
      }
      // 直接提到其他幹員名稱（排除自身名稱的異格形態，例如「濁心斯卡蒂」提到「斯卡蒂」）。
      for (const [name, other] of byName) {
        if (other.id === provider.id || name.length < 2 || !d.includes(name) || provider.displayName.includes(name)) continue;
        if (!/(優先|同時|一起|中有|編隊|在場)/u.test(d) || /可以使用|召喚/u.test(d)) continue;
        const key = `${provider.id}|op:${other.id}`;
        if (seen.has(key)) continue; seen.add(key);
        links.push({ providerId: provider.id, source: text, trigger, target: { kind: 'operator', value: other.id, label: name }, beneficiaries: !scope || scope.has(other.id) ? [other.id] : [] });
      }
    }
  }
  return { links, debuffs };
}

function matches(def: OperatorDefinition, target: SynergyLink['target'], groupsOf: (id: string) => readonly string[]): boolean {
  if (target.kind === 'profession') return def.profession === target.value;
  if (target.kind === 'branch') return def.branch === target.value;
  if (target.kind === 'group') return groupsOf(def.id).includes(target.value) || def.faction === target.value;
  if (target.kind === 'rarity') return String(def.rarity) === target.value;
  if (target.kind === 'operator') return def.id === target.value;
  return false;
}
