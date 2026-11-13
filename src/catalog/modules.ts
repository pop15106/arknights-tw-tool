import type { ModuleDefinition } from '../domain/model.ts';
import { renderGameText } from './game-text.ts';

type Row = Record<string, unknown>;
type ModuleLevel = NonNullable<ModuleDefinition['levels']>[number];
type Effect = ModuleLevel['effects'][number];
const ATTRIBUTE_LABELS: Record<string, string> = {
  max_hp: '生命上限', atk: '攻擊力', def: '防禦力', magic_resistance: '法術抗性', attack_speed: '攻擊速度',
  block_cnt: '阻擋數', cost: '部署費用', respawn_time: '再部署時間', base_attack_time: '攻擊間隔',
};

function record(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`模組資料缺少有效${label}。`);
  return value as Row;
}
function optionalRecord(value: unknown, label: string): Row | undefined {
  return value === undefined || value === null ? undefined : record(value, label);
}
function array(value: unknown, label: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`模組${label}必須是陣列。`);
  return value;
}
function word(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`模組資料缺少${label}。`);
  return value;
}
function optionalText(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`模組${label}超出範圍。`);
  return value;
}
function elite(value: unknown): 0 | 1 | 2 {
  if (typeof value !== 'string' || !/^PHASE_[012]$/u.test(value)) throw new Error('模組精英階段無效。');
  return Number(value.slice(-1)) as 0 | 1 | 2;
}
function restrictions(part: Row, candidate: Row): Pick<Effect, 'target' | 'isToken' | 'validInGameTag' | 'validInMapTag' | 'validModeIndices'> {
  const result: ReturnType<typeof restrictions> = {};
  for (const key of ['target', 'validInGameTag', 'validInMapTag'] as const) if (part[key] !== undefined && part[key] !== null) result[key] = word(part[key], '效果來源條件');
  if (part.isToken !== undefined && part.isToken !== null) {
    if (typeof part.isToken !== 'boolean') throw new Error('模組召喚物條件必須為布林值。');
    result.isToken = part.isToken;
  }
  if (candidate.validModeIndices !== undefined && candidate.validModeIndices !== null) result.validModeIndices = array(candidate.validModeIndices, '型態索引').map(value => integer(value, 0, 100, '型態索引'));
  return result;
}

function trustPercent(points: unknown, favor: unknown): number | undefined {
  // 只接受信賴表的精確對照；不將點數、插值或陣列索引當成百分比。
  if (typeof points !== 'number' || !Number.isInteger(points) || points < 0 || !favor) return undefined;
  const frames = optionalRecord(favor, '信賴表')?.favorFrames;
  if (!Array.isArray(frames)) return undefined;
  const matches = frames.map(frame => optionalRecord(frame, '信賴列')).filter(frame => frame?.level === points)
    .map(frame => optionalRecord(frame?.data, '信賴資料')).filter(data => data?.favorPoint === points);
  if (matches.length !== 1) return undefined;
  const percent = matches[0]?.percent;
  return typeof percent === 'number' && Number.isInteger(percent) && percent >= 0 && percent <= 200 ? percent : undefined;
}

function buildLevels(raw: Row, source: Row, items: Row | undefined, favor: unknown): ModuleLevel[] {
  const phases = array(source.phases, '戰鬥階段').map(value => record(value, '戰鬥階段'))
    .map(phase => ({ phase, level: integer(phase.equipLevel, 1, 3, '等級') as 1 | 2 | 3 })).sort((left, right) => left.level - right.level);
  if (new Set(phases.map(value => value.level)).size !== phases.length) throw new Error('模組戰鬥階段有重複等級。');
  const itemCosts = optionalRecord(raw.itemCost, '材料表'), favors = optionalRecord(raw.unlockFavors, '信賴門檻');
  return phases.map(({ phase, level }) => {
    const attributes = array(phase.attributeBlackboard, '屬性').map(value => {
      const attribute = record(value, '屬性'); const key = word(attribute.key, '屬性 key');
      if (typeof attribute.value !== 'number' || !Number.isFinite(attribute.value)) throw new Error('模組屬性必須是有限數值。');
      return { key, label: ATTRIBUTE_LABELS[key] ?? key, value: attribute.value };
    });
    const effects: Effect[] = [];
    for (const inputPart of array(phase.parts, '效果組')) {
      const part = record(inputPart, '效果組');
      for (const kind of ['trait', 'talent'] as const) {
        const bundle = optionalRecord(part[kind === 'trait' ? 'overrideTraitDataBundle' : 'addOrOverrideTalentDataBundle'], '效果候選組');
        for (const inputCandidate of array(bundle?.candidates, '效果候選')) {
          const candidate = record(inputCandidate, '效果候選');
          if (candidate.isHideTalent === true) continue;
          const condition = optionalRecord(candidate.unlockCondition, '效果解鎖條件');
          // 沒有條件或文字的效果保持缺漏，不補上「精英零／潛能一」等猜測值。
          if (!condition || candidate.requiredPotentialRank === undefined || candidate.requiredPotentialRank === null) continue;
          const effectElite = elite(condition.phase), effectLevel = integer(condition.level, 1, 90, '效果解鎖等級');
          const potential = integer(candidate.requiredPotentialRank, 0, 5, '效果潛能索引') + 1 as Effect['potential'];
          const limits = restrictions(part, candidate);
          // 全空候選可能是型態或內部數值控制，不能跨級繼承其他效果文案。
          const template = kind === 'talent' ? optionalText(candidate.upgradeDescription) ?? optionalText(candidate.description)
            : [optionalText(candidate.overrideDescripton), optionalText(candidate.additionalDescription)].filter(Boolean).join('\n') || undefined;
          if (!template) continue;
          const text = renderGameText(template, candidate.blackboard);
          if (!text) continue;
          const name = optionalText(candidate.name) ?? (kind === 'trait' ? '特性變化' : '模組天賦');
          effects.push({ kind, name, description: text, elite: effectElite, level: effectLevel, potential, ...limits });
        }
      }
    }
    const costs = array(itemCosts?.[String(level)], '材料').map(value => {
      const cost = record(value, '材料'); const id = word(cost.id, '材料 ID');
      const item = optionalRecord(items?.[id], '材料名稱');
      return { id, name: optionalText(item?.name) ?? id, count: integer(cost.count, 1, Number.MAX_SAFE_INTEGER, '材料數量') };
    });
    const trust = trustPercent(favors?.[String(level)], favor);
    return { level, attributes, effects, costs, ...(trust !== undefined ? { trust } : {}) };
  });
}

export function buildModules(operatorId: string, modulesTable: unknown, battleEquip?: unknown, items?: unknown, favor?: unknown): ModuleDefinition[] {
  const table = record(modulesTable, '模組表'), definitions = record(table.equipDict, '模組定義');
  const missions = optionalRecord(table.missionList, '任務表'), battle = optionalRecord(battleEquip, '戰鬥表');
  const itemDefinitions = optionalRecord(optionalRecord(items, '物品表')?.items, '物品定義');
  return Object.entries(definitions).filter(([, value]) => { const raw = record(value, '模組定義'); return (raw.tmplId ?? raw.charId) === operatorId; })
    .sort(([left], [right]) => left.localeCompare(right)).map(([id, value]) => {
      const raw = record(value, '模組定義');
      const type = raw.type === 'INITIAL' || raw.typeName1 === 'ORIGINAL' ? 'original' : raw.type === 'ADVANCED' ? 'advanced' : undefined;
      const description = renderGameText(optionalText(raw.uniEquipDesc) ?? '', {});
      const result: ModuleDefinition = { id, name: word(raw.uniEquipName, '名稱'), kind: [raw.typeName1, raw.typeName2].filter(value => typeof value === 'string' && value.trim()).join('-') || '未提供',
        ...(type ? { type } : {}), ...(description ? { description } : {}),
      };
      if (type !== 'original' && raw.unlockEvolvePhase !== undefined && raw.unlockLevel !== undefined) result.unlock = { elite: elite(raw.unlockEvolvePhase), level: integer(raw.unlockLevel, 1, 90, '解鎖等級') };
      if (Array.isArray(raw.missionList)) result.missions = raw.missionList.flatMap(value => {
        const id = word(value, '任務 ID'); const mission = optionalRecord(missions?.[id], '任務');
        const text = renderGameText(optionalText(mission?.desc) ?? '', {});
        return text ? [{ id, description: text }] : [];
      });
      const battleModule = optionalRecord(battle?.[id], '模組戰鬥定義');
      if (type !== 'original' && battleModule) result.levels = buildLevels(raw, battleModule, itemDefinitions, favor);
      return result;
    });
}
