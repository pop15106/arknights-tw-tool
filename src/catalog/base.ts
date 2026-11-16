// 由 building_data.json 投影出基建頁需要的欄位；不執行任何遊戲標記。
import type { TradingParams } from './trading.ts';
type Row = Record<string, any>;

export type BaseRoomType = 'CONTROL' | 'POWER' | 'MANUFACTURE' | 'TRADING' | 'DORMITORY' | 'MEETING' | 'HIRE' | 'TRAINING' | 'WORKSHOP';
export const BASE_ROOM_TYPES: readonly BaseRoomType[] = ['CONTROL', 'POWER', 'MANUFACTURE', 'TRADING', 'DORMITORY', 'MEETING', 'HIRE', 'TRAINING', 'WORKSHOP'];

export interface BaseRoom { id: BaseRoomType; name: string; maxCount: number; phases: { maxStationedNum: number; electricity: number }[] }
export interface BaseSkill { id: string; name: string; roomType: string; description: string }
export interface BaseSkillSlot { buffId: string; elite: 0 | 1 | 2; level: number }
export interface BaseCatalog {
  source: string;
  version: string;
  rooms: BaseRoom[];
  /** 每名進駐幹員的基礎加成（manufactData／tradingData.basicSpeedBuff，以百分比表示）。 */
  basicSpeedPercent: { MANUFACTURE: number; TRADING: number };
  skills: Record<string, BaseSkill>;
  /** 幹員 → 技能欄；每欄依序是同一技能的升級版本，後者解鎖後取代前者。 */
  operators: Record<string, BaseSkillSlot[][]>;
  /** 製造配方（秒數為 100% 生產力時每件所需時間；weight 為倉庫佔用量）。 */
  formulas?: { gold: BaseFormula; records: (BaseFormula & { level: number; exp: number })[] };
  /** 製造站各等級倉庫容量。 */
  outputCapacity?: number[];
  /** 心情：上限與各設施各等級的基礎每小時消耗（皆換算成遊戲顯示單位）。 */
  /** 貿易站訂單參數（PRTS 同步結果）；未同步時由畫面使用內建值。 */
  trading?: TradingParams;
  mood?: { max: number; costPerHour: Partial<Record<BaseRoomType, number[]>>; maxByOperator?: Record<string, number> };
}
export interface BaseFormula { itemId: string; name: string; seconds: number; weight: number }

/** 移除 <@cc.vup>、<$cc.bd_b1>、</> 等遊戲標記，只保留文字。 */
export function plainGameText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/<[@$][^>]*>|<\/>/gu, '').replace(/[\u0000-\u0008\u000b-\u001f]/gu, '').trim() : '';
}

function obj(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`基建資料缺少${label}。`);
  return value as Row;
}

export function buildBaseCatalog(building: unknown, operatorIds: readonly string[], version: string, source: string, items?: unknown): BaseCatalog {
  const data = obj(building, '基建表');
  const roomsRaw = obj(data.rooms, '設施表'), buffsRaw = obj(data.buffs, '技能表'), charsRaw = obj(data.chars, '幹員基建表');
  const rooms = BASE_ROOM_TYPES.map(id => {
    const room = obj(roomsRaw[id], `設施 ${id}`);
    if (!Array.isArray(room.phases) || !room.phases.length) throw new Error(`基建設施 ${id} 沒有等級資料。`);
    return {
      id, name: plainGameText(room.name) || id, maxCount: Number(room.maxCount) || 0,
      phases: room.phases.map((phase: Row) => ({ maxStationedNum: Number(phase.maxStationedNum) || 0, electricity: Number(phase.electricity) || 0 })),
    };
  });
  const operators: BaseCatalog['operators'] = {};
  const used = new Set<string>();
  for (const id of operatorIds) {
    const char = charsRaw[id];
    if (!char || !Array.isArray(char.buffChar)) continue;
    const slots = char.buffChar.map((slot: Row) => (Array.isArray(slot.buffData) ? slot.buffData : [])
      .filter((entry: Row) => typeof entry.buffId === 'string' && buffsRaw[entry.buffId])
      .map((entry: Row) => {
        const elite = Number(String(entry.cond?.phase ?? 'PHASE_0').replace('PHASE_', ''));
        used.add(entry.buffId);
        return { buffId: entry.buffId, elite: (elite === 1 || elite === 2 ? elite : 0) as 0 | 1 | 2, level: Number(entry.cond?.level) || 1 };
      })).filter((slot: BaseSkillSlot[]) => slot.length);
    if (slots.length) operators[id] = slots;
  }
  const skills = Object.fromEntries([...used].sort().map(id => {
    const buff = buffsRaw[id];
    return [id, { id, name: plainGameText(buff.buffName) || id, roomType: String(buff.roomType ?? ''), description: plainGameText(buff.description) || '來源未提供說明。' }];
  }));
  const percent = (value: unknown) => Math.round((Number(value) || 0) * 10000) / 100;
  // 心情單位：manpowerDisplayFactor（360000）＝顯示的 1 點；manpowerCost 為每秒消耗。
  const factor = Number(data.manpowerDisplayFactor) || 0;
  const mood = factor > 0 ? {
    max: 24,
    costPerHour: Object.fromEntries(BASE_ROOM_TYPES.map(id => [id, (roomsRaw[id]?.phases ?? []).map((phase: Row) => Math.round((Number(phase.manpowerCost) || 0) * 3600 / factor * 1000) / 1000)])),
    maxByOperator: Object.fromEntries(operatorIds.filter(id => Number(charsRaw[id]?.maxManpower) > 0 && Math.abs(Number(charsRaw[id].maxManpower) / factor - 24) > 1e-6).map(id => [id, Number(charsRaw[id].maxManpower) / factor])),
  } : undefined;
  const formulaRows = Object.values(data.manufactFormulas ?? {}) as Row[];
  const formula = (row: Row | undefined): BaseFormula | undefined => row && Number(row.costPoint) > 0 ? { itemId: String(row.itemId), name: plainGameText((items as Row | undefined)?.items?.[row.itemId]?.name) || String(row.itemId), seconds: Number(row.costPoint), weight: Number(row.weight) || 1 } : undefined;
  const gold = formula(formulaRows.find(row => row.formulaType === 'F_GOLD'));
  const expItems = (items as Row | undefined)?.expItems ?? {};
  const records = formulaRows.filter(row => row.formulaType === 'F_EXP' && Number(expItems[row.itemId]?.gainExp) > 0)
    .map(row => ({ ...formula(row)!, level: Number(row.requireRooms?.[0]?.roomLevel) || 1, exp: Number(expItems[row.itemId].gainExp) })).sort((a, b) => a.level - b.level);
  const capacity = Array.isArray(data.manufactData?.phases) ? data.manufactData.phases.map((phase: Row) => Number(phase.outputCapacity) || 0) : undefined;
  return { source, version, rooms, basicSpeedPercent: { MANUFACTURE: percent(data.manufactData?.basicSpeedBuff), TRADING: percent(data.tradingData?.basicSpeedBuff) }, skills, operators,
    ...(gold && records.length ? { formulas: { gold, records } } : {}), ...(capacity ? { outputCapacity: capacity } : {}), ...(mood ? { mood } : {}) };
}
