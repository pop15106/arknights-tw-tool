import type { BaseCatalog, BaseSkill } from '../catalog/base.ts';
import type { GrowthCatalog } from '../catalog/growth.ts';
import type { OperatorDefinition } from './model.ts';
import { parseSkill, type SkillEffect } from './base.ts';
import { operatorTexts } from './synergy.ts';

/* ------------------------------------------------------------------ */
/* 幹員簡評：只整理資料表寫明的事實與可計算的比較，不做主觀強度評分。         */
/* 日常＝數值在同分支的排位、費用、技能觸發；基建＝技能解析；各模式＝明寫效果。 */
/* ------------------------------------------------------------------ */
export const IS_THEMES = ['傀影與猩紅孤鑽', '水月與深藍之樹', '探索者的銀淞止境', '薩卡茲的無終奇語', '歲的界園志異'];
/** 與 IS_THEMES 同順序的主題 ID（roguelike_topic_table）。社群評價以 ID 對應，不必等關卡分析完成。 */
export const IS_THEME_IDS = ['rogue_1', 'rogue_2', 'rogue_3', 'rogue_4', 'rogue_5'];
const SKILL_TYPE: Record<string, string> = { PASSIVE: '被動', MANUAL: '手動', AUTO: '自動' };
const SP_TYPE: Record<string, string> = { INCREASE_WITH_TIME: '自然回復', INCREASE_WHEN_ATTACK: '攻擊回復', INCREASE_WHEN_TAKEN_DAMAGE: '受擊回復', '8': '被動' };
type Text = { kind: string; name: string; description: string };

export interface OperatorReview {
  daily: { facts: string[]; skills: string[]; peers: number };
  base: { room: string; skill: string; effects: string; note?: string }[];
  roguelike: { theme: string; effects: Text[] }[];
  roguelikeGeneral: Text[];
  reclamation: Text[];
  security: Text[];
}

const percentile = (values: number[], value: number) => values.filter(item => item < value).length / Math.max(1, values.length - 1);

export function operatorReview(definition: OperatorDefinition, all: readonly OperatorDefinition[], growth: GrowthCatalog, base: BaseCatalog | null, effectText: (effect: SkillEffect) => string): OperatorReview {
  const op = growth.operators[definition.id];
  const peers = all.filter(def => def.branch === definition.branch && growth.operators[def.id]?.stats);
  const facts: string[] = [];
  if (op?.stats && peers.length >= 3) {
    const stats = op.stats;
    const rank = (key: keyof typeof stats, label: string, lowIsGood = false) => {
      const values = peers.map(def => growth.operators[def.id].stats![key]);
      const p = percentile(values, stats[key]);
      if (values.every(value => value === values[0])) return;
      const good = lowIsGood ? p <= 0.25 : p >= 0.75, bad = lowIsGood ? p >= 0.75 : p <= 0.25;
      if (good || bad) facts.push(`${label} ${stats[key]}，在同分支 ${peers.length} 名中${p >= 0.75 ? '偏高（前 25%）' : '偏低（後 25%）'}`);
    };
    rank('hp', '生命'); rank('atk', '攻擊'); rank('def', '防禦'); rank('res', '法抗');
    const costs = peers.map(def => growth.operators[def.id].stats!.cost).sort((a, b) => a - b), median = costs[Math.floor(costs.length / 2)];
    facts.push(`部署費用 ${stats.cost}（同分支中位數 ${median}）・阻擋 ${stats.block}・再部署 ${stats.redeploy} 秒・攻擊間隔 ${stats.interval} 秒`);
  }
  if (op?.tags?.length) facts.push(`招募標籤：${op.tags.join('、')}`);
  const skills = definition.skills.map((skill, index) => {
    const meta = op?.skillMeta?.[skill.id];
    return meta ? `技能 ${index + 1}「${skill.name}」：${SKILL_TYPE[meta.type] ?? meta.type}觸發・${SP_TYPE[meta.sp] ?? meta.sp}${meta.cost ? `・技力 ${meta.init}/${meta.cost}` : ''}${meta.duration > 0 ? `・持續 ${meta.duration} 秒` : ''}` : `技能 ${index + 1}「${skill.name}」`;
  });
  const baseSkills: OperatorReview['base'] = [];
  for (const slot of base?.operators[definition.id] ?? []) {
    const last = slot.at(-1);
    const skill: BaseSkill | undefined = last ? base!.skills[last.buffId] : undefined;
    if (!skill) continue;
    const parsed = parseSkill(skill);
    const room = ({ CONTROL: '控制中樞', POWER: '發電站', MANUFACTURE: '製造站', TRADING: '貿易站', DORMITORY: '宿舍', MEETING: '會客室', HIRE: '辦公室', TRAINING: '訓練室', WORKSHOP: '加工站' } as Record<string, string>)[skill.roomType] ?? skill.roomType;
    baseSkills.push({ room, skill: `${skill.name}（精英 ${last!.elite}・${last!.level} 級解鎖）`, effects: parsed.supported ? parsed.effects.map(effectText).filter(Boolean).join('、') : '本工具尚未計入', ...(parsed.conditional ? { note: `與${parsed.conditional.partner}同房時另有加成` } : parsed.estimate ? { note: `估計：${parsed.estimate}` } : {}) });
  }
  const texts = operatorTexts(definition);
  const moduleTags = definition.modules.flatMap(module => (module.levels?.at(-1)?.effects ?? []).filter(effect => effect.validInGameTag || effect.validInMapTag).map(effect => ({ kind: '模組', name: module.name, description: effect.description, tag: `${effect.validInGameTag ?? ''}|${effect.validInMapTag ?? ''}` })));
  const roguelike = IS_THEMES.map(theme => ({ theme, effects: texts.filter(text => text.description.includes(`【${theme}】`)) }));
  const roguelikeGeneral = [...texts.filter(text => /集成戰略/u.test(text.description)), ...moduleTags.filter(item => /roguelike|rogue_/u.test(item.tag) && !texts.some(text => text.description === item.description))];
  const reclamation = [...texts.filter(text => /生息演算/u.test(text.description)), ...moduleTags.filter(item => /sandbox/u.test(item.tag) && !texts.some(text => text.description === item.description))];
  const security = texts.filter(text => /保全派駐/u.test(text.description));
  const unique = <T extends Text>(list: T[]) => list.filter((item, index) => list.findIndex(other => other.description === item.description) === index);
  return { daily: { facts, skills, peers: peers.length }, base: baseSkills, roguelike: roguelike.map(item => ({ ...item, effects: unique(item.effects) })), roguelikeGeneral: unique(roguelikeGeneral), reclamation: unique(reclamation), security: unique(security) };
}
