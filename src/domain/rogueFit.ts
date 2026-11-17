import type { GrowthCatalog } from '../catalog/growth.ts';
import type { RogueAnalysis } from '../catalog/rogue.ts';
import type { OperatorDefinition } from './model.ts';
import type { DebuffLink } from './synergy.ts';
import { operatorAbilities, sourceText, type Ability, type AbilityKey } from './abilities.ts';

/* ------------------------------------------------------------------ */
/* 集成戰略主題契合度：只用資料可計算的因素，每一分都附理由。                 */
/* 敵人組成（出現次數加權）× 幹員能對應的方式、地塊比例、藏品點名的對象、     */
/* 資料明寫的主題專屬效果。分數只代表「這個主題的內容對他有利的程度」，不是強度。 */
/* ------------------------------------------------------------------ */
export interface FitReason { points: number; text: string }
export interface ThemeFit { score: number; reasons: FitReason[]; relics: string[] }
const pct = (value: number) => `${Math.round(value * 100)}%`;

export function themeFit(definition: OperatorDefinition, growth: GrowthCatalog, analysis: RogueAnalysis, debuffs: readonly DebuffLink[], themeTexts: readonly string[], groups: readonly string[] = []): ThemeFit {
  const op = growth.operators[definition.id];
  const tags = op?.tags ?? [], position = op?.position;
  const reasons: FitReason[] = [];
  const add = (points: number, text: string) => { if (points > 0.5) reasons.push({ points: Math.round(points * 10) / 10, text }); };
  const dealer = tags.includes('輸出');
  const arts = op?.damage ? op.damage === 'arts' : definition.profession === '術師';
  const own = new Set(debuffs.filter(item => item.providerId === definition.id).map(item => item.status));
  // 技能、天賦、模組的能力解析：每條理由都標出是哪個技能或天賦。
  const abilities = operatorAbilities(definition);
  const pick = (...keys: AbilityKey[]) => abilities.filter(item => keys.includes(item.key));
  const cite = (list: Ability[]) => [...new Set(list.map(sourceText))].slice(0, 2).join('、');
  const e = analysis.enemy;
  const antiAir = pick('antiAir');
  if (dealer && position === 'RANGED') add(e.fly * 100, `飛行敵人佔 ${pct(e.fly)}：遠程輸出打得到`);
  else if (antiAir.length) add(e.fly * 100, `飛行敵人佔 ${pct(e.fly)}：${cite(antiAir)}可以攻擊空中單位`);
  const trueDamage = pick('true');
  if (dealer && arts) add(e.highDef * 100, `高防禦敵人佔 ${pct(e.highDef)}：法術傷害無視防禦（特性：攻擊造成法術傷害）`);
  else if (pick('arts').some(item => item.source.kind === '技能')) add(e.highDef * 70, `高防禦敵人佔 ${pct(e.highDef)}：${cite(pick('arts').filter(item => item.source.kind === '技能'))}造成法術傷害`);
  if (trueDamage.length) add(e.highDef * 50 + e.highRes * 50, `高防禦／高法抗敵人佔 ${pct(e.highDef + e.highRes)}：${cite(trueDamage)}造成真實傷害`);
  const breakDef = pick('ignoreDef', 'defDown', 'fragile');
  if (breakDef.length || own.has('防禦力降低') || own.has('物理脆弱')) add(e.highDef * 60, `高防禦敵人佔 ${pct(e.highDef)}：${breakDef.length ? cite(breakDef) : '技能或天賦'}能無視或降低防禦`);
  if (dealer && !arts && op?.damage !== 'heal') add(e.highRes * 100, `高法抗敵人佔 ${pct(e.highRes)}：物理輸出不受法抗影響`);
  const breakRes = pick('resDown');
  if (breakRes.length || own.has('法術抗性降低')) add(e.highRes * 60, `高法抗敵人佔 ${pct(e.highRes)}：${breakRes.length ? cite(breakRes) : '技能或天賦'}能降低法術抗性`);
  const sustain = pick('heal', 'shield', 'dmgReduce');
  if (sustain.length) add(e.magic * 60, `法術攻擊的敵人佔 ${pct(e.magic)}：${cite(sustain)}提供治療／護盾／減傷`);
  if (tags.includes('防護') && (op?.stats?.res ?? 0) >= 10) add(e.magic * 60, `法術攻擊的敵人佔 ${pct(e.magic)}：本身法抗 ${op!.stats!.res}`);
  const burst = pick('burst', 'eliteBonus');
  if (burst.length) add(e.elite * 50, `精英／領袖佔 ${pct(e.elite)}：${cite(burst)}高倍率爆發`);
  const hardControl = pick('stun', 'freeze', 'bind');
  if (hardControl.length) add(e.elite * 40, `精英／領袖佔 ${pct(e.elite)}：${cite(hardControl)}可以控場`);
  const perStage = analysis.enemy.spawns / Math.max(1, analysis.analyzedStages);
  const aoe = pick('aoe');
  if (aoe.length) add(Math.min(15, perStage / 4), `平均每關 ${Math.round(perStage)} 隻敵人：${cite(aoe)}群體攻擊`);
  const crowd = pick('slow', 'shift');
  if (crowd.length) add(Math.min(8, perStage / 8), `平均每關 ${Math.round(perStage)} 隻敵人：${cite(crowd)}能減速或推拉`);
  if (pick('reveal').length && analysis.topEnemies.some(enemy => /隱匿|潛行|幽靈/u.test(enemy.name))) add(6, `常見敵人含隱匿單位：${cite(pick('reveal'))}能看穿隱匿`);
  // 首領：依實際數值逐一比對（防禦 1000 以上、法抗 50 以上、飛行）。
  for (const boss of analysis.bosses.slice(0, 6)) {
    if (boss.def >= 1000 && ((dealer && arts) || trueDamage.length || breakDef.length)) add(6, `首領「${boss.name}」防禦 ${boss.def}：${dealer && arts ? '法術輸出' : cite(trueDamage.length ? trueDamage : breakDef)}可以應對`);
    else if (boss.res >= 50 && ((dealer && !arts && op?.damage !== 'heal') || trueDamage.length || breakRes.length)) add(6, `首領「${boss.name}」法抗 ${boss.res}：${dealer && !arts ? '物理輸出' : cite(trueDamage.length ? trueDamage : breakRes)}可以應對`);
    if (boss.fly && (position === 'RANGED' && dealer || antiAir.length)) add(4, `首領「${boss.name}」會飛行：${antiAir.length ? cite(antiAir) : '遠程輸出'}打得到`);
  }
  const tilesTotal = analysis.tiles.melee + analysis.tiles.ranged;
  const meleeShare = tilesTotal ? analysis.tiles.melee / tilesTotal : 0.5;
  if (position === 'MELEE') add((meleeShare - 0.6) * 40, `地面可部署格佔 ${pct(meleeShare)}：近戰位置多`);
  if (position === 'RANGED') add((0.4 - meleeShare) * 40, `高台可部署格佔 ${pct(1 - meleeShare)}：遠程位置多`);
  // 藏品：點名分支、召喚物、站位的才有區辨力；各職業各一件的通用藏品不加分。
  const relics: string[] = [];
  const groupPoints = new Map<string, number>();
  for (const relic of analysis.relics) {
    const usage = relic.usage;
    if (definition.branch && usage.includes(`【${definition.branch}】`)) { relics.push(`${relic.name}：${usage}`); add(8, `藏品「${relic.name}」點名【${definition.branch}】`); continue; }
    const group = groups.find(name => name.length >= 2 && (usage.includes(`【${name}】`) || usage.includes(`${name}幹員`)));
    if (group) { relics.push(`${relic.name}：${usage}`); const used = groupPoints.get(group) ?? 0, points = Math.min(6, 10 - used); groupPoints.set(group, used + points); add(points, `「${relic.name}」點名${group}幹員${points < 6 ? '（同陣營加分上限 10）' : ''}`); continue; }
    if ((tags.includes('召喚') || abilities.some(item => item.key === 'summon')) && usage.includes('【召喚物】')) { relics.push(`${relic.name}：${usage}`); add(5, `藏品「${relic.name}」強化召喚物`); continue; }
    if ((position === 'MELEE' && usage.includes('【近戰】')) || (position === 'RANGED' && usage.includes('【遠程】'))) { relics.push(`${relic.name}：${usage}`); add(3, `藏品「${relic.name}」點名${position === 'MELEE' ? '近戰' : '遠程'}`); }
  }
  themeTexts.slice(0, 3).forEach((text, index) => add(index ? 5 : 20, `主題專屬效果：${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`));
  return { score: Math.round(reasons.reduce((sum, item) => sum + item.points, 0) * 10) / 10, reasons: reasons.sort((a, b) => b.points - a.points), relics };
}

/** 依同主題所有幹員的分數排位分級：前 15% 高、接下來 35% 中、其餘低。 */
export function fitLevel(score: number, all: readonly number[]): '高' | '中' | '低' {
  const sorted = [...all].sort((a, b) => b - a);
  const rank = sorted.findIndex(value => value <= score);
  const p = (rank < 0 ? sorted.length : rank) / Math.max(1, sorted.length);
  return p < 0.15 ? '高' : p < 0.5 ? '中' : '低';
}
