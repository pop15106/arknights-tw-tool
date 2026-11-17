import type { OperatorDefinition } from './model.ts';

/* ------------------------------------------------------------------ */
/* 能力解析：逐句讀技能、天賦、模組的繁中服說明，抽出可判斷的能力標籤。       */
/* 白名單式比對，每個標籤都記下出處（哪個技能／天賦／模組、哪個等級）。       */
/* 讀不懂的句子不猜；契合度、簡評、專精建議都用這份結果。                   */
/* ------------------------------------------------------------------ */
export type AbilityKey =
  | 'aoe' | 'arts' | 'true' | 'ignoreDef' | 'defDown' | 'resDown' | 'fragile'
  | 'stun' | 'freeze' | 'bind' | 'silence' | 'slow' | 'shift' | 'antiAir'
  | 'heal' | 'shield' | 'dmgReduce' | 'dodge' | 'summon' | 'spSupport' | 'spSelf'
  | 'atkBuff' | 'aspdBuff' | 'allyBuff' | 'camouflage' | 'reveal' | 'blockUp' | 'eliteBonus' | 'burst';

export const ABILITY_LABEL: Record<AbilityKey, string> = {
  aoe: '群體攻擊', arts: '法術傷害', true: '真實傷害', ignoreDef: '無視防禦', defDown: '降低防禦', resDown: '降低法抗', fragile: '脆弱',
  stun: '暈眩', freeze: '凍結', bind: '束縛', silence: '沉默', slow: '減速／停頓', shift: '推拉位移', antiAir: '對空',
  heal: '治療', shield: '護盾', dmgReduce: '減傷', dodge: '閃避', summon: '召喚', spSupport: '技力供給（隊友）', spSelf: '技力回復（自身）',
  atkBuff: '攻擊力提升', aspdBuff: '攻速提升', allyBuff: '增益隊友', camouflage: '隱匿', reveal: '反隱（看穿隱匿）', blockUp: '阻擋數提升', eliteBonus: '對精英／領袖增傷', burst: '高倍率爆發',
};
/** 控場類：對精英、首領、大量敵人都有用。 */
export const CONTROL: AbilityKey[] = ['stun', 'freeze', 'bind', 'silence', 'slow', 'shift'];

export interface AbilitySource { kind: '技能' | '天賦' | '模組'; name: string; skillIndex?: number }
export interface Ability { key: AbilityKey; source: AbilitySource; text: string; value?: number; count?: number }

const RULES: { key: AbilityKey; test: RegExp }[] = [
  { key: 'true', test: /真實傷害/u },
  { key: 'arts', test: /法術傷害/u },
  { key: 'ignoreDef', test: /無視[^，。]{0,6}防禦/u },
  { key: 'defDown', test: /防禦力[-－]\d|防禦力降低|防禦力減少/u },
  { key: 'resDown', test: /法術抗性[-－]\d|法術抗性降低|法抗[-－]/u },
  { key: 'fragile', test: /脆弱/u },
  { key: 'stun', test: /暈眩/u },
  { key: 'freeze', test: /凍結/u },
  { key: 'bind', test: /束縛/u },
  { key: 'silence', test: /沉默/u },
  { key: 'slow', test: /停頓|減速|移動速度[-－]\d|移動速度降低/u },
  { key: 'shift', test: /推動|拉動|推開|拉向|拉近|擊退|力度/u },
  { key: 'antiAir', test: /(?:優先|只能|可以|能夠)攻擊[^，。]{0,4}(?:空中|飛行)|(?:空中|飛行)單位/u },
  { key: 'heal', test: /治療|恢復[^，。]{0,8}生命|回復[^，。]{0,8}生命/u },
  { key: 'shield', test: /護盾|屏障/u },
  { key: 'dmgReduce', test: /受到的[^，。]{0,6}傷害[-－]\d|傷害減免|減少[^，。]{0,4}受到的傷害/u },
  { key: 'dodge', test: /閃避/u },
  { key: 'summon', test: /召喚物|召喚/u },
  { key: 'reveal', test: /隱匿[^，。]{0,6}(?:失效|解除|可見)|(?:偵測|看穿|識破|攻擊)[^，。]{0,4}隱匿|使[^，。]{0,8}失去隱匿/u },
  { key: 'camouflage', test: /(?:獲得|處於|進入|保持)[^，。]{0,4}隱匿|隱匿狀態/u },
  { key: 'blockUp', test: /阻擋數[+＋]\d/u },
  { key: 'eliteBonus', test: /(?:精英|領袖)敵人[^。]{0,16}(?:傷害|攻擊力)/u },
];
const AOE = /至多(\d+)個|範圍內(?:的)?所有|周圍(?:的)?(?:所有)?敵人|多個目標|同時攻擊(\d+)|爆炸|擴散|濺射|全體|所有敵人/u;
const ALLY = /友方|隊友|所有[^，。]{0,6}幹員|周圍[^，。]{0,4}幹員/u;

/** 解析一段文字（技能某等級、天賦或模組效果）。 */
export function parseAbilityText(text: string, source: AbilitySource): Ability[] {
  const out: Ability[] = [];
  const clean = text.replace(/\s+/gu, ' ');
  for (const rule of RULES) if (rule.test.test(clean)) out.push({ key: rule.key, source, text: clean });
  const aoe = AOE.exec(clean);
  if (aoe) out.push({ key: 'aoe', source, text: clean, ...(aoe[1] || aoe[2] ? { count: Number(aoe[1] ?? aoe[2]) } : {}) });
  const atk = [...clean.matchAll(/攻擊力(?:[+＋](\d+)%|提升至(\d+)%)|相當於攻擊力(\d+)%/gu)].map(match => Number(match[1] ?? match[2] ?? match[3]));
  if (atk.length) {
    const value = Math.max(...atk);
    out.push({ key: ALLY.test(clean) && source.kind !== '技能' ? 'allyBuff' : 'atkBuff', source, text: clean, value });
    // 技能倍率 ≥ 200%（或攻擊力 +100% 以上）視為高倍率爆發。
    if (source.kind === '技能' && (value >= 200 || /攻擊力[+＋](\d+)%/u.test(clean) && value >= 100)) out.push({ key: 'burst', source, text: clean, value });
  }
  const aspd = /攻擊速度[+＋](\d+)/u.exec(clean);
  if (aspd) out.push({ key: ALLY.test(clean) ? 'allyBuff' : 'aspdBuff', source, text: clean, value: Number(aspd[1]) });
  // 「攻擊間隔大幅度縮短」等同大幅提升攻速（大幅度≈50、一定程度≈30、少量≈15，換算為攻速值供比較）。
  const interval = /攻擊間隔(大幅度|大幅|較大幅度|一定程度|少量|略微|小幅)?縮短/u.exec(clean);
  if (interval && !aspd) out.push({ key: 'aspdBuff', source, text: clean, value: /大幅/u.test(interval[1] ?? '') ? 50 : /一定程度/u.test(interval[1] ?? '') ? 30 : 15 });
  if (/技力/u.test(clean)) {
    if (ALLY.test(clean) && /(?:恢復|回復|獲得|提供)[^。]{0,8}技力|技力[^。]{0,6}(?:恢復|回復)/u.test(clean)) out.push({ key: 'spSupport', source, text: clean });
    else if (/(?:獲得|恢復|回復)[^。]{0,6}技力/u.test(clean)) out.push({ key: 'spSelf', source, text: clean });
  }
  return out;
}

/** 幹員的全部能力：技能取最高等級（專精 3 或 7 級）、天賦取最高階段、模組取最高等級。 */
export function operatorAbilities(definition: OperatorDefinition): Ability[] {
  const out: Ability[] = [];
  definition.skills.forEach((skill, index) => {
    const last = skill.levels?.at(-1);
    if (last) out.push(...parseAbilityText(last.description, { kind: '技能', name: skill.name, skillIndex: index }));
  });
  const talents = new Map<string, string>();
  for (const talent of definition.talents ?? []) talents.set(talent.name, talent.description);
  for (const [name, description] of talents) out.push(...parseAbilityText(description, { kind: '天賦', name }));
  for (const module of definition.modules) for (const effect of module.levels?.at(-1)?.effects ?? []) out.push(...parseAbilityText(effect.description, { kind: '模組', name: module.name }));
  return out;
}

/** 依能力分組，每種能力只列出處（同一來源不重複）。 */
export function abilitySummary(abilities: readonly Ability[]): { key: AbilityKey; label: string; sources: string[] }[] {
  const map = new Map<AbilityKey, Set<string>>();
  for (const ability of abilities) {
    const label = ability.source.kind === '技能' ? `技能 ${(ability.source.skillIndex ?? 0) + 1}「${ability.source.name}」` : `${ability.source.kind}「${ability.source.name}」`;
    (map.get(ability.key) ?? map.set(ability.key, new Set()).get(ability.key)!).add(label);
  }
  return [...map].map(([key, sources]) => ({ key, label: ABILITY_LABEL[key], sources: [...sources] }));
}

/** 某能力的出處文字（給理由用），例如「技能 3「火山」」。 */
export function sourceText(ability: Ability): string {
  return ability.source.kind === '技能' ? `技能 ${(ability.source.skillIndex ?? 0) + 1}「${ability.source.name}」` : `${ability.source.kind}「${ability.source.name}」`;
}

/* ------------------------------------------------------------------ */
/* 專精收益：比較 7 級與專精 3 的說明文字，列出數字變化。                    */
/* ------------------------------------------------------------------ */
export interface MasteryGain { from: string; to: string; changes: string[]; score: number }
export function masteryGain(skill: OperatorDefinition['skills'][number]): MasteryGain | null {
  const levels = skill.levels ?? [];
  const l7 = levels.find(level => level.level === 7) ?? levels[6], m3 = levels.at(-1);
  if (!l7 || !m3 || l7 === m3) return null;
  // 取每個數字與它前面的說明（從上一個標點算起，最多 10 字），用來對齊兩個等級的數值。
  const tokens = (text: string) => [...text.matchAll(/([^\d，。、；\n]{0,10}?)([+＋\-－]?\d+(?:\.\d+)?)(%?)/gu)].map(match => ({ label: match[1].replace(/^[，。、；\s（）()]+|[\s（）()]+$/gu, '').trim(), value: Number(match[2].replace('＋', '+').replace('－', '-')), unit: match[3] }));
  const a = tokens(l7.description), b = tokens(m3.description);
  const changes: string[] = [];
  let score = 0;
  const gain = (before: number, after: number) => Math.min(100, Math.abs(after - before) / Math.max(1, Math.abs(before)) * 100);
  if (a.length === b.length) {
    a.forEach((item, index) => {
      const next = b[index];
      if (item.value === next.value) return;
      changes.push(`${next.label || item.label || '數值'}：${item.value}${item.unit} → ${next.value}${next.unit}`);
      score += gain(item.value, next.value);
    });
  } else {
    // 數值位置不同（專精後多了效果）：依說明對齊，對不到的列為新增。
    const used = new Set<number>();
    for (const next of b) {
      const index = a.findIndex((item, i) => !used.has(i) && item.label && item.label === next.label);
      if (index >= 0) { used.add(index); if (a[index].value !== next.value) { changes.push(`${next.label}：${a[index].value}${a[index].unit} → ${next.value}${next.unit}`); score += gain(a[index].value, next.value); } }
      else { changes.push(`新增「${next.label}${next.value}${next.unit}」`); score += 30; }
    }
  }
  if (!changes.length && l7.description !== m3.description) changes.push('說明文字有變化，請直接比對');
  return { from: l7.description, to: m3.description, changes, score: Math.round(score) };
}
