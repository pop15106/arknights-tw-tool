import type { BaseCatalog, BaseRoom, BaseRoomType, BaseSkill, BaseSkillSlot } from '../catalog/base.ts';
import type { OperatorDefinition, OwnedOperator, Settings } from './model.ts';

export type Facility = Settings['base']['facilities'][number];
export type FacilityType = Facility['type'];
export const ROOM_OF: Record<FacilityType, BaseRoomType> = { control: 'CONTROL', power: 'POWER', manufacturing: 'MANUFACTURE', trading: 'TRADING', dormitory: 'DORMITORY' };
export const FACILITY_LABEL: Record<FacilityType, string> = { control: '控制中樞', power: '發電站', manufacturing: '製造站', trading: '貿易站', dormitory: '宿舍' };
export const PRODUCT_LABEL = { gold: '赤金（貴金屬）', record: '作戰記錄', lmd: '龍門幣訂單' } as const;

/* ------------------------------------------------------------------ */
/* 技能說明解析：白名單句型。任何一個子句不在白名單，整個技能標為「未計入」。 */
/* ------------------------------------------------------------------ */
export type SkillEffect =
  | { kind: 'productivity'; value: number; product?: 'gold' | 'record' | 'originium' }
  | { kind: 'capacity'; value: number }
  | { kind: 'moodCost'; value: number }
  | { kind: 'order'; value: number }
  | { kind: 'orderLimit'; value: number }
  | { kind: 'drone'; value: number }
  | { kind: 'moodRecoverSelf'; value: number }
  | { kind: 'moodRecoverAll'; value: number };
export interface ParsedSkill { supported: boolean; effects: SkillEffect[] }

const ROOM_PREFIX: Record<string, string> = { MANUFACTURE: '製造站', TRADING: '貿易站', POWER: '發電站', DORMITORY: '宿舍', CONTROL: '控制中樞' };
const NUM = String.raw`([+-]?\d+(?:\.\d+)?)`;
const CLAUSES: { pattern: RegExp; effect: (match: RegExpMatchArray) => SkillEffect }[] = [
  { pattern: new RegExp(`^生產力${NUM}%$`, 'u'), effect: m => ({ kind: 'productivity', value: Number(m[1]) }) },
  { pattern: new RegExp(`^(作戰記錄|貴金屬|源石)類配方的生產力${NUM}%$`, 'u'), effect: m => ({ kind: 'productivity', value: Number(m[2]), product: m[1] === '作戰記錄' ? 'record' : m[1] === '貴金屬' ? 'gold' : 'originium' }) },
  { pattern: new RegExp(`^倉庫容量上限${NUM}$`, 'u'), effect: m => ({ kind: 'capacity', value: Number(m[1]) }) },
  { pattern: new RegExp(`^心情每小時消耗${NUM}$`, 'u'), effect: m => ({ kind: 'moodCost', value: Number(m[1]) }) },
  { pattern: new RegExp(`^訂單獲取效率${NUM}%$`, 'u'), effect: m => ({ kind: 'order', value: Number(m[1]) }) },
  { pattern: new RegExp(`^且訂單上限${NUM}$`, 'u'), effect: m => ({ kind: 'orderLimit', value: Number(m[1]) }) },
  { pattern: new RegExp(`^無人機充能速度${NUM}%$`, 'u'), effect: m => ({ kind: 'drone', value: Number(m[1]) }) },
  { pattern: new RegExp(`^自身心情每小時恢復${NUM}$`, 'u'), effect: m => ({ kind: 'moodRecoverSelf', value: Number(m[1]) }) },
  { pattern: new RegExp(`^該宿舍內所有幹員的心情每小時恢復${NUM}（同種效果取最高）$`, 'u'), effect: m => ({ kind: 'moodRecoverAll', value: Number(m[1]) }) },
];

export function parseSkill(skill: Pick<BaseSkill, 'roomType' | 'description'>): ParsedSkill {
  const prefix = ROOM_PREFIX[skill.roomType];
  const head = prefix && `進駐${prefix}時，`;
  if (!head || !skill.description.startsWith(head)) return { supported: false, effects: [] };
  const effects: SkillEffect[] = [];
  for (const clause of skill.description.slice(head.length).split('，')) {
    const rule = CLAUSES.map(item => ({ item, match: clause.trim().match(item.pattern) })).find(entry => entry.match);
    if (!rule?.match) return { supported: false, effects: [] };
    effects.push(rule.item.effect(rule.match));
  }
  return { supported: effects.length > 0, effects };
}

/* ------------------------------------------------------------------ */
/* 解鎖判斷：只用已知的精英階段與等級；未知不推論為已解鎖或未解鎖。        */
/* ------------------------------------------------------------------ */
export type UnlockState = 'ready' | 'locked' | 'unknown';
const knownNumber = (row: OwnedOperator, field: string) => { const e = row.fields[field]; return e?.status === 'known' && typeof e.value === 'number' ? e.value : undefined; };

export function unlockState(version: Pick<BaseSkillSlot, 'elite' | 'level'>, row: OwnedOperator): UnlockState {
  const elite = knownNumber(row, 'elite'), level = knownNumber(row, 'level');
  if (elite === undefined) return 'unknown';
  if (elite > version.elite) return 'ready';
  if (elite < version.elite) return 'locked';
  if (level === undefined) return 'unknown';
  return level >= version.level ? 'ready' : 'locked';
}

export interface SlotResult {
  /** 目前確定生效的版本；尚無確定版本時為 undefined。 */
  active?: BaseSkill;
  state: UnlockState;
  /** 下一個版本是否可能已解鎖（養成數值未知）。 */
  maybeUpgraded?: BaseSkill;
  /** 尚未生效時顯示的第一個版本與條件。 */
  next?: { skill: BaseSkill; elite: number; level: number };
}

export function slotResult(slot: BaseSkillSlot[], row: OwnedOperator, catalog: BaseCatalog): SlotResult {
  let active: BaseSkill | undefined, maybeUpgraded: BaseSkill | undefined, next: SlotResult['next'];
  for (const version of slot) {
    const skill = catalog.skills[version.buffId];
    if (!skill) continue;
    const state = unlockState(version, row);
    if (state === 'ready') { active = skill; maybeUpgraded = undefined; }
    else if (state === 'unknown' && !maybeUpgraded) maybeUpgraded = skill;
    else if (state === 'locked' && !next) next = { skill, elite: version.elite, level: version.level };
  }
  if (active) return { active, state: 'ready', maybeUpgraded };
  if (maybeUpgraded) return { state: 'unknown', maybeUpgraded };
  return { state: 'locked', next };
}

/* ------------------------------------------------------------------ */
/* 配置評估                                                              */
/* ------------------------------------------------------------------ */
export interface OperatorInRoom {
  operatorId: string;
  name: string;
  skills: (SlotResult & { parsed?: ParsedSkill; applies: boolean })[];
}
export interface FacilityResult {
  facility: Facility;
  label: string;
  room?: BaseRoom;
  capacity: number;
  operators: OperatorInRoom[];
  /** 已計入的數值；只包含白名單技能與資料表提供的基礎加成。 */
  totals: { basic: number; productivity: number; order: number; drone: number; moodRecoverAll: number; moodCost: number[] };
  /** 已生效但句型未支援、因此沒有計入的技能。 */
  unsupported: { operatorId: string; skill: BaseSkill }[];
  /** 解鎖狀態未知的技能。 */
  uncertain: { operatorId: string; skill: BaseSkill }[];
  /** 生效但不適用目前產品的技能（例如生產作戰記錄時的赤金技能）。 */
  notApplicable: { operatorId: string; skill: BaseSkill }[];
  issues: string[];
}
export interface BaseEvaluation { facilities: FacilityResult[]; electricity: { produced: number; consumed: number }; issues: string[] }

function roomSkillApplies(skill: BaseSkill, roomType: BaseRoomType): boolean { return skill.roomType === roomType; }
export function productMatches(effect: SkillEffect, facility: Pick<Facility, 'product'>): boolean {
  return effect.kind !== 'productivity' || !effect.product || effect.product === facility.product;
}

export function evaluateBase(base: Settings['base'], catalog: BaseCatalog, roster: readonly OwnedOperator[], definitions: ReadonlyMap<string, OperatorDefinition>): BaseEvaluation {
  const rows = new Map(roster.map(row => [row.operatorId, row]));
  const rooms = new Map(catalog.rooms.map(room => [room.id, room]));
  const issues: string[] = [];
  const seen = new Map<string, string>();
  let produced = 0, consumed = 0;
  const counts = new Map<BaseRoomType, number>();
  const facilities = base.facilities.map((facility, index): FacilityResult => {
    const roomType = ROOM_OF[facility.type], room = rooms.get(roomType);
    const label = `${FACILITY_LABEL[facility.type]} ${base.facilities.slice(0, index + 1).filter(item => item.type === facility.type).length}`;
    counts.set(roomType, (counts.get(roomType) ?? 0) + 1);
    const result: FacilityResult = { facility, label, room, capacity: 0, operators: [], totals: { basic: 0, productivity: 0, order: 0, drone: 0, moodRecoverAll: 0, moodCost: [] }, unsupported: [], uncertain: [], notApplicable: [], issues: [] };
    if (!room) { result.issues.push('資料包沒有此設施的資料。'); return result; }
    const phase = room.phases[facility.level - 1];
    if (!phase) { result.issues.push(`等級超過資料上限（最高 ${room.phases.length} 級）。`); }
    else {
      result.capacity = phase.maxStationedNum;
      if (phase.electricity >= 0) produced += phase.electricity; else consumed -= phase.electricity;
    }
    if (facility.type === 'manufacturing' && facility.product !== 'gold' && facility.product !== 'record') result.issues.push('請選擇製造產品（赤金或作戰記錄）。');
    const assigned = base.assignments?.[facility.id] ?? [];
    if (result.capacity && assigned.length > result.capacity) result.issues.push(`進駐 ${assigned.length} 人，超過此等級上限 ${result.capacity} 人。`);
    for (const operatorId of assigned) {
      const row = rows.get(operatorId), definition = definitions.get(operatorId);
      const name = definition?.displayName ?? operatorId;
      if (!row) { result.issues.push(`${name} 不在目前幹員庫。`); continue; }
      const previous = seen.get(operatorId);
      if (previous) issues.push(`${name} 同時被安排在「${previous}」與「${label}」。`); else seen.set(operatorId, label);
      const slots = catalog.operators[operatorId] ?? [];
      const skills = slots.map(slot => {
        const resolved = slotResult(slot, row, catalog);
        const skill = resolved.active ?? resolved.maybeUpgraded ?? resolved.next?.skill;
        const applies = !!skill && roomSkillApplies(skill, roomType);
        return { ...resolved, applies, parsed: resolved.active && applies ? parseSkill(resolved.active) : undefined };
      });
      for (const skill of skills) {
        if (!skill.applies) continue;
        if (skill.maybeUpgraded) result.uncertain.push({ operatorId, skill: skill.maybeUpgraded });
        if (!skill.active || !skill.parsed) continue;
        if (!skill.parsed.supported) { result.unsupported.push({ operatorId, skill: skill.active }); continue; }
        let applied = false;
        for (const effect of skill.parsed.effects) {
          if (!productMatches(effect, facility)) continue;
          applied = true;
          if (effect.kind === 'productivity') result.totals.productivity += effect.value;
          else if (effect.kind === 'order') result.totals.order += effect.value;
          else if (effect.kind === 'drone') result.totals.drone += effect.value;
          else if (effect.kind === 'moodRecoverAll') result.totals.moodRecoverAll = Math.max(result.totals.moodRecoverAll, effect.value);
          else if (effect.kind === 'moodCost') result.totals.moodCost.push(effect.value);
        }
        if (!applied) result.notApplicable.push({ operatorId, skill: skill.active });
      }
      result.operators.push({ operatorId, name, skills });
    }
    const basic = roomType === 'MANUFACTURE' ? catalog.basicSpeedPercent.MANUFACTURE : roomType === 'TRADING' ? catalog.basicSpeedPercent.TRADING : 0;
    result.totals.basic = round(basic * result.operators.length);
    result.totals.productivity = round(result.totals.productivity);
    result.totals.order = round(result.totals.order);
    result.totals.drone = round(result.totals.drone);
    return result;
  });
  for (const [roomType, count] of counts) {
    const room = rooms.get(roomType);
    if (room && room.maxCount && count > room.maxCount) issues.push(`${room.name}最多 ${room.maxCount} 座，目前設定 ${count} 座。`);
  }
  if (consumed > produced) issues.push(`電力不足：需要 ${consumed}，發電 ${produced}。`);
  return { facilities, electricity: { produced, consumed }, issues };
}
const round = (value: number) => Math.round(value * 100) / 100;

/* ------------------------------------------------------------------ */
/* 候選名單：只依已生效且可解析的技能排序，未知解鎖排在已確認之後。         */
/* ------------------------------------------------------------------ */
export interface Candidate { operatorId: string; name: string; score: number; state: UnlockState | 'none'; summary: string }

export function candidatesFor(facility: Facility, catalog: BaseCatalog, roster: readonly OwnedOperator[], definitions: ReadonlyMap<string, OperatorDefinition>, exclude: ReadonlySet<string>): Candidate[] {
  const roomType = ROOM_OF[facility.type];
  const list: Candidate[] = [];
  for (const row of roster) {
    if (exclude.has(row.operatorId)) continue;
    const owned = row.fields.owned;
    if (owned?.status === 'known' && owned.value === false) continue;
    const name = definitions.get(row.operatorId)?.displayName ?? row.operatorId;
    let score = 0, state: Candidate['state'] = 'none';
    const names: string[] = [];
    for (const slot of catalog.operators[row.operatorId] ?? []) {
      const resolved = slotResult(slot, row, catalog);
      const skill = resolved.active ?? resolved.maybeUpgraded;
      if (!skill || skill.roomType !== roomType) continue;
      if (resolved.state === 'ready') {
        state = 'ready'; names.push(skill.name);
        const parsed = parseSkill(skill);
        for (const effect of parsed.effects) if (productMatches(effect, facility) && (effect.kind === 'productivity' || effect.kind === 'order' || effect.kind === 'drone' || effect.kind === 'moodRecoverAll' || effect.kind === 'moodRecoverSelf')) score += effect.value;
      } else if (resolved.state === 'unknown') { if (state === 'none') state = 'unknown'; names.push(`${skill.name}（解鎖待核對）`); }
    }
    list.push({ operatorId: row.operatorId, name, score: round(score), state, summary: names.join('、') });
  }
  const rank = { ready: 0, unknown: 1, locked: 2, none: 3 } as const;
  return list.sort((a, b) => rank[a.state] - rank[b.state] || b.score - a.score || a.name.localeCompare(b.name, 'zh-Hant'));
}
