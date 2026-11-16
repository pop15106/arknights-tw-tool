// 由 building_data.json 投影出基建頁需要的欄位；不執行任何遊戲標記。
type Row = Record<string, any>;

export type BaseRoomType = 'CONTROL' | 'POWER' | 'MANUFACTURE' | 'TRADING' | 'DORMITORY';
export const BASE_ROOM_TYPES: readonly BaseRoomType[] = ['CONTROL', 'POWER', 'MANUFACTURE', 'TRADING', 'DORMITORY'];

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
}

/** 移除 <@cc.vup>、<$cc.bd_b1>、</> 等遊戲標記，只保留文字。 */
export function plainGameText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/<[@$][^>]*>|<\/>/gu, '').replace(/[\u0000-\u0008\u000b-\u001f]/gu, '').trim() : '';
}

function obj(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`基建資料缺少${label}。`);
  return value as Row;
}

export function buildBaseCatalog(building: unknown, operatorIds: readonly string[], version: string, source: string): BaseCatalog {
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
  return { source, version, rooms, basicSpeedPercent: { MANUFACTURE: percent(data.manufactData?.basicSpeedBuff), TRADING: percent(data.tradingData?.basicSpeedBuff) }, skills, operators };
}
