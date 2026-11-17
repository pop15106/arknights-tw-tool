import type { BaseCatalog } from '../catalog/base.ts';
import type { GrowthCatalog } from '../catalog/growth.ts';
import type { OperatorDefinition, OwnedOperator, Settings } from './model.ts';
import { evaluateBase, slotResult } from './base.ts';

/* ------------------------------------------------------------------ */
/* 專精規劃：專精所需秒數取自技能表；訓練速度＝1＋基礎＋協助者技能＋中樞加成。 */
/* 協助者加成以基建評估計算（同一套技能解析），會依職業與目標專精等級判斷。   */
/* 基礎加成（trainingData.basicSpeedBuff）假設在有協助者時生效。             */
/* ------------------------------------------------------------------ */
export interface MasteryTarget { operatorId: string; skillId: string; from: number; to: number }
export interface AssistantOption { id: string; name: string; bonus: number[]; hours: number[]; total: number }
export interface MasteryPlan { steps: { level: number; baseHours: number }[]; roomLevel: number; limit: number; assistants: AssistantOption[]; none: { hours: number[]; total: number }; notes: string[] }

export function planMastery(base: Settings['base'], baseCatalog: BaseCatalog, growth: GrowthCatalog, roster: readonly OwnedOperator[], definitions: ReadonlyMap<string, OperatorDefinition>, target: MasteryTarget, limit = 8): MasteryPlan {
  const notes: string[] = [];
  const definition = definitions.get(target.operatorId);
  const seconds = growth.operators[target.operatorId]?.masteries[target.skillId] ?? [];
  const steps = Array.from({ length: Math.max(0, target.to - target.from) }, (_, index) => target.from + index + 1).filter(level => seconds[level - 1]).map(level => ({ level, baseHours: seconds[level - 1].seconds / 3600 }));
  const training = base.facilities.find(facility => facility.type === 'training');
  const roomLevel = training?.level ?? 3;
  if (!training) notes.push('配置中沒有訓練室，以 3 級訓練室計算。');
  const maxLevel = roomLevel; // 訓練室 1／2／3 級可專精到 1／2／3 級（trainingData.specSkillLvlLimit）
  if (steps.some(step => step.level > maxLevel)) notes.push(`${roomLevel} 級訓練室最多只能專精到 ${maxLevel} 級。`);
  const basic = 5; // building_data trainingData.basicSpeedBuff 0.05
  const facility = training ?? { id: '__training', type: 'training' as const, level: 3 };
  const facilities = training ? base.facilities : [...base.facilities, facility];
  const characterOf = (id: string) => baseCatalog.meta?.[id]?.character ?? id;
  const candidates = roster.filter(row => !(row.fields.owned?.status === 'known' && row.fields.owned.value === false) && characterOf(row.operatorId) !== characterOf(target.operatorId)
    && (baseCatalog.operators[row.operatorId] ?? []).some(slot => slotResult(slot, row, baseCatalog).active?.roomType === 'TRAINING'));
  const others = Object.fromEntries(Object.entries(base.assignments ?? {}).map(([id, list]) => [id, id === facility.id ? [] : list]));
  const bonusFor = (assistant: string | null, level: number) => {
    const assignments = { ...others, [facility.id]: assistant ? [assistant] : [] };
    const result = evaluateBase({ ...base, facilities, assignments, training: { profession: definition?.profession, mastery: level as 1 | 2 | 3 } }, baseCatalog, roster, definitions).facilities.find(item => item.facility.id === facility.id);
    return result?.totals.training ?? 0;
  };
  const hoursAt = (bonus: number, step: { baseHours: number }, withAssistant: boolean) => step.baseHours / (1 + ((withAssistant ? basic : 0) + bonus) / 100);
  const assistants = candidates.map(row => {
    const bonus = steps.map(step => bonusFor(row.operatorId, step.level));
    const hours = steps.map((step, index) => Math.round(hoursAt(bonus[index], step, true) * 100) / 100);
    return { id: row.operatorId, name: definitions.get(row.operatorId)?.displayName ?? row.operatorId, bonus, hours, total: Math.round(hours.reduce((sum, value) => sum + value, 0) * 100) / 100 };
  }).sort((a, b) => a.total - b.total).slice(0, limit);
  const noneBonus = steps.map(step => bonusFor(null, step.level));
  const noneHours = steps.map((step, index) => Math.round(hoursAt(noneBonus[index], step, false) * 100) / 100);
  if (assistants.some(item => item.hours.some(value => value > 24))) notes.push('部分步驟超過 24 小時：協助者心情可能在訓練中耗盡，耗盡後加成消失，實際會更久。');
  return { steps, roomLevel, limit: maxLevel, assistants, none: { hours: noneHours, total: Math.round(noneHours.reduce((sum, value) => sum + value, 0) * 100) / 100 }, notes };
}
