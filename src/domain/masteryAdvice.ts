import type { GrowthCatalog } from '../catalog/growth.ts';
import type { RogueAnalysis } from '../catalog/rogue.ts';
import type { CommunityData } from '../catalog/community.ts';
import type { OperatorDefinition, OwnedOperator } from './model.ts';
import { ABILITY_LABEL, masteryGain, parseAbilityText, type AbilityKey, type MasteryGain } from './abilities.ts';
import { themeFit } from './rogueFit.ts';

/* ------------------------------------------------------------------ */
/* 技能專精建議：結合四種依據，每項都附理由，不是強度排行。                   */
/*  1. 專精收益：7 級 → 專精 3 的數值變化（技能說明文字）                     */
/*  2. 模式契合：只保留這個技能時，各模式契合度的差異（同一套能力解析）         */
/*  3. 社群提到的技能：社群評價裡「3技能」「S2」這類寫法                       */
/*  4. 成本：專精材料與時間（另外顯示，不計入排序）                            */
/* ------------------------------------------------------------------ */
export interface ModeScore { mode: string; points: number; reasons: string[] }
export interface SkillAdvice {
  skillId: string; skillIndex: number; name: string; currentMastery?: number;
  gain: MasteryGain | null; abilities: AbilityKey[];
  daily: ModeScore; modes: ModeScore[];
  community: { theme: string; mentions: string[] }[];
  hours: number; materials: { id: string; count: number }[];
  score: number;
}

/** 日常（主線、活動）：沒有固定敵人組成，以通用需求計分。 */
const DAILY_WEIGHT: Partial<Record<AbilityKey, number>> = { burst: 10, aoe: 8, heal: 8, stun: 6, freeze: 6, bind: 5, true: 6, arts: 4, spSupport: 6, shield: 6, summon: 4, slow: 3, shift: 3, dmgReduce: 4 };

const SKILL_REF = /(?:^|[^\d])([1-3一二三])\s*(?:技能|技)(?![術力])|技能\s*([1-3一二三])|[Ss]([1-3])(?![0-9])/gu;
const NUM: Record<string, number> = { '1': 0, '2': 1, '3': 2, 一: 0, 二: 1, 三: 2 };
/** 從社群理由找出提到的技能編號（0 起算）。 */
export function skillMentions(text: string): number[] {
  return [...new Set([...text.matchAll(SKILL_REF)].map(match => NUM[match[1] ?? match[2] ?? match[3]]).filter(index => index !== undefined))];
}

export interface AdviceContext { growth: GrowthCatalog; analyses: readonly (RogueAnalysis & { mode?: string })[]; community?: CommunityData | null; themeNames?: Record<string, string> }

export function skillAdvice(definition: OperatorDefinition, row: OwnedOperator | undefined, context: AdviceContext): SkillAdvice[] {
  const op = context.growth.operators[definition.id];
  return definition.skills.map((skill, skillIndex) => {
    const last = skill.levels?.at(-1);
    const own = last ? parseAbilityText(last.description, { kind: '技能', name: skill.name, skillIndex }) : [];
    const keys = [...new Set(own.map(item => item.key))];
    // 日常：技能本身的能力加權。
    const dailyReasons = keys.filter(key => DAILY_WEIGHT[key]).map(key => `${ABILITY_LABEL[key]}（+${DAILY_WEIGHT[key]}）`);
    // 輸出強度：攻擊倍率、攻速與目標數（同一技能內取最大值），讓「持續輸出型」技能也能被比較。
    const atkValue = Math.max(0, ...own.filter(item => item.key === 'atkBuff' || item.key === 'burst').map(item => item.value ?? 0));
    const aspdValue = Math.max(0, ...own.filter(item => item.key === 'aspdBuff').map(item => item.value ?? 0));
    const targets = Math.max(1, ...own.filter(item => item.key === 'aoe').map(item => item.count ?? 2));
    // 覆蓋率：持續型技能＝持續時間÷(持續時間＋技力消耗)；「下次攻擊」類只有一擊，以 0.2 計。
    const meta = op?.skillMeta?.[skill.id];
    const uptime = meta && meta.duration > 0 && meta.cost > 0 ? meta.duration / (meta.duration + meta.cost) : meta && meta.duration < 0 ? 1 : 0.2;
    const output = Math.min(25, Math.round((atkValue / 20 + aspdValue / 10) * Math.min(3, Math.sqrt(targets)) * (0.4 + uptime)));
    if (output > 0) dailyReasons.push(`輸出強度（攻擊 ${atkValue}%${aspdValue ? `・攻速 +${aspdValue}` : ''}${targets > 1 ? `・${targets} 個目標` : ''}・覆蓋率約 ${Math.round(Math.min(1, uptime) * 100)}%，+${output}）`);
    const daily: ModeScore = { mode: '日常', points: keys.reduce((sum, key) => sum + (DAILY_WEIGHT[key] ?? 0), 0) + output, reasons: dailyReasons };
    // 各模式：只保留這個技能時的契合度，只列出提到這個技能的理由。
    const single = { ...definition, skills: [skill] };
    const modes = context.analyses.map(analysis => {
      const fit = themeFit(single, context.growth, analysis, [], []);
      // 單獨評估時這個技能排在第 1 個，理由裡的編號要改回原本的技能編號。
      const mine = fit.reasons.filter(reason => reason.text.includes(`「${skill.name}」`)).map(reason => ({ ...reason, text: reason.text.replaceAll(`技能 1「${skill.name}」`, `技能 ${skillIndex + 1}「${skill.name}」`) }));
      const points = mine.reduce((sum, reason) => sum + reason.points, 0) + output;
      return { mode: analysis.name, points: Math.round(points * 10) / 10, reasons: [...mine.map(reason => reason.text), ...(output > 0 ? [`輸出強度 +${output}`] : [])] };
    });
    // 社群：該幹員在各主題的評價裡提到這個技能的條目。
    const community: SkillAdvice['community'] = [];
    for (const [themeId, theme] of Object.entries(context.community?.themes ?? {})) {
      const mentions = (theme.picks[definition.id] ?? []).filter(pick => pick.stance !== 'avoid' && skillMentions(pick.reason).includes(skillIndex)).map(pick => pick.reason);
      if (mentions.length) community.push({ theme: context.themeNames?.[themeId] ?? themeId, mentions });
    }
    const gain = masteryGain(skill);
    const steps = op?.masteries[skill.id] ?? [];
    const materials = new Map<string, number>();
    for (const step of steps) for (const cost of step.cost) materials.set(cost.id, (materials.get(cost.id) ?? 0) + cost.count);
    const entry = row?.fields[`mastery:${skill.id}`];
    const currentMastery = entry?.status === 'known' && typeof entry.value === 'number' ? entry.value : undefined;
    const bestMode = Math.max(daily.points, ...modes.map(item => item.points));
    const score = Math.round((bestMode + (gain?.score ?? 0) * 0.3 + community.reduce((sum, item) => sum + item.mentions.length, 0) * 10) * 10) / 10;
    return { skillId: skill.id, skillIndex, name: skill.name, ...(currentMastery !== undefined ? { currentMastery } : {}), gain, abilities: keys, daily, modes, community,
      hours: Math.round(steps.reduce((sum, step) => sum + step.seconds, 0) / 3600 * 10) / 10, materials: [...materials].map(([id, count]) => ({ id, count })), score };
  });
}

/** 全帳號排行：已精二、技能還沒專精 3 的幹員，依選定模式排序。 */
export interface RankedSkill { operatorId: string; name: string; advice: SkillAdvice; modePoints: number }
export function rankMastery(definitions: readonly OperatorDefinition[], roster: readonly OwnedOperator[], context: AdviceContext, mode: string): RankedSkill[] {
  const out: RankedSkill[] = [];
  for (const row of roster) {
    if (row.fields.owned?.status === 'known' && row.fields.owned.value === false) continue;
    const elite = row.fields.elite;
    if (!(elite?.status === 'known' && elite.value === 2)) continue;
    const definition = definitions.find(item => item.id === row.operatorId);
    if (!definition || !context.growth.operators[definition.id]) continue;
    for (const advice of skillAdvice(definition, row, context)) {
      if ((advice.currentMastery ?? 0) >= 3) continue;
      const modePoints = mode === '日常' ? advice.daily.points : mode === '全部' ? Math.max(advice.daily.points, ...advice.modes.map(item => item.points)) : advice.modes.find(item => item.mode === mode)?.points ?? 0;
      const community = advice.community.filter(item => mode === '全部' || mode === '日常' || item.theme === mode).reduce((sum, item) => sum + item.mentions.length, 0);
      out.push({ operatorId: definition.id, name: definition.displayName, advice, modePoints: Math.round((modePoints + (advice.gain?.score ?? 0) * 0.3 + community * 10) * 10) / 10 });
    }
  }
  return out.sort((a, b) => b.modePoints - a.modePoints).slice(0, 60);
}
