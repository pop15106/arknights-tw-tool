import type { GrowthCatalog } from '../catalog/growth.ts';
import type { RogueAnalysis } from '../catalog/rogue.ts';
import type { OperatorDefinition } from './model.ts';
import type { DebuffLink } from './synergy.ts';

/* ------------------------------------------------------------------ */
/* 集成戰略主題契合度：只用資料可計算的因素，每一分都附理由。                 */
/* 敵人組成（出現次數加權）× 幹員能對應的方式、地塊比例、藏品點名的對象、     */
/* 資料明寫的主題專屬效果。分數只代表「這個主題的內容對他有利的程度」，不是強度。 */
/* ------------------------------------------------------------------ */
export interface FitReason { points: number; text: string }
export interface ThemeFit { score: number; reasons: FitReason[]; relics: string[] }
const pct = (value: number) => `${Math.round(value * 100)}%`;

export function themeFit(definition: OperatorDefinition, growth: GrowthCatalog, analysis: RogueAnalysis, debuffs: readonly DebuffLink[], themeTexts: readonly string[]): ThemeFit {
  const op = growth.operators[definition.id];
  const tags = op?.tags ?? [], position = op?.position;
  const reasons: FitReason[] = [];
  const add = (points: number, text: string) => { if (points > 0.5) reasons.push({ points: Math.round(points * 10) / 10, text }); };
  const dealer = tags.includes('輸出');
  const arts = op?.damage ? op.damage === 'arts' : definition.profession === '術師';
  const own = new Set(debuffs.filter(item => item.providerId === definition.id).map(item => item.status));
  const e = analysis.enemy;
  if (dealer && position === 'RANGED') add(e.fly * 100, `飛行敵人佔 ${pct(e.fly)}：遠程輸出打得到`);
  if (dealer && arts) add(e.highDef * 100, `高防禦敵人佔 ${pct(e.highDef)}：法術傷害無視防禦（特性：攻擊造成法術傷害）`);
  if (own.has('防禦力降低') || own.has('物理脆弱')) add(e.highDef * 60, `高防禦敵人佔 ${pct(e.highDef)}：能降低防禦／施加物理脆弱`);
  if (dealer && !arts && op?.damage !== 'heal') add(e.highRes * 100, `高法抗敵人佔 ${pct(e.highRes)}：物理輸出不受法抗影響`);
  if (own.has('法術抗性降低')) add(e.highRes * 60, `高法抗敵人佔 ${pct(e.highRes)}：能降低法術抗性`);
  if (tags.includes('治療')) add(e.magic * 60, `法術攻擊的敵人佔 ${pct(e.magic)}：治療壓力大`);
  if (tags.includes('防護') && (op?.stats?.res ?? 0) >= 10) add(e.magic * 60, `法術攻擊的敵人佔 ${pct(e.magic)}：本身法抗 ${op!.stats!.res}`);
  if (tags.includes('爆發')) add(e.elite * 50, `精英／領袖佔 ${pct(e.elite)}：爆發輸出能集中處理`);
  if (tags.includes('群攻')) add(Math.min(15, analysis.enemy.spawns / Math.max(1, analysis.analyzedStages) / 4), `平均每關 ${Math.round(analysis.enemy.spawns / Math.max(1, analysis.analyzedStages))} 隻敵人：群攻清場`);
  const tilesTotal = analysis.tiles.melee + analysis.tiles.ranged;
  const meleeShare = tilesTotal ? analysis.tiles.melee / tilesTotal : 0.5;
  if (position === 'MELEE') add((meleeShare - 0.6) * 40, `地面可部署格佔 ${pct(meleeShare)}：近戰位置多`);
  if (position === 'RANGED') add((0.4 - meleeShare) * 40, `高台可部署格佔 ${pct(1 - meleeShare)}：遠程位置多`);
  // 藏品：點名分支、召喚物、站位的才有區辨力；各職業各一件的通用藏品不加分。
  const relics: string[] = [];
  for (const relic of analysis.relics) {
    const usage = relic.usage;
    if (definition.branch && usage.includes(`【${definition.branch}】`)) { relics.push(`${relic.name}：${usage}`); add(8, `藏品「${relic.name}」點名【${definition.branch}】`); continue; }
    if (tags.includes('召喚') && usage.includes('【召喚物】')) { relics.push(`${relic.name}：${usage}`); add(5, `藏品「${relic.name}」強化召喚物`); continue; }
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
