import type { BaseCatalog, BaseRoom, BaseRoomType, BaseSkill, BaseSkillSlot } from '../catalog/base.ts';
import type { OperatorDefinition, OwnedOperator, Settings } from './model.ts';
import { DEFAULT_TRADING, expectedOrder } from '../catalog/trading.ts';

export type Facility = Settings['base']['facilities'][number];
export type FacilityType = Facility['type'];
export const ROOM_OF: Record<FacilityType, BaseRoomType> = { control: 'CONTROL', power: 'POWER', manufacturing: 'MANUFACTURE', trading: 'TRADING', dormitory: 'DORMITORY', meeting: 'MEETING', office: 'HIRE', training: 'TRAINING', workshop: 'WORKSHOP' };
export const FACILITY_LABEL: Record<FacilityType, string> = { control: '控制中樞', power: '發電站', manufacturing: '製造站', trading: '貿易站', dormitory: '宿舍', meeting: '會客室', office: '辦公室', training: '訓練室', workshop: '加工站' };
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
export interface ParsedSkill {
  supported: boolean;
  /** 無條件生效的效果。 */
  effects: SkillEffect[];
  /** 「當與某幹員在同一個設施時」才生效的效果；partner 為說明文字中的幹員名稱。 */
  conditional?: { partner: string; effects: SkillEffect[] };
  /** 無法計算而略過的條件（例如陣營人數），只顯示說明。 */
  ignoredCondition?: string;
}

const ROOM_PREFIX: Record<string, string> = { MANUFACTURE: '製造站', TRADING: '貿易站', POWER: '發電站', DORMITORY: '宿舍', CONTROL: '控制中樞' };
const NUM = String.raw`([+-]?\d+(?:\.\d+)?)`;
const CLAUSES: { pattern: RegExp; effect: (match: RegExpMatchArray) => SkillEffect }[] = [
  { pattern: new RegExp(`^生產力${NUM}%$`, 'u'), effect: m => ({ kind: 'productivity', value: Number(m[1]) }) },
  { pattern: new RegExp(`^(作戰記錄|貴金屬|源石)類配方的生產力${NUM}%$`, 'u'), effect: m => ({ kind: 'productivity', value: Number(m[2]), product: m[1] === '作戰記錄' ? 'record' : m[1] === '貴金屬' ? 'gold' : 'originium' }) },
  { pattern: new RegExp(`^倉庫容量上限${NUM}$`, 'u'), effect: m => ({ kind: 'capacity', value: Number(m[1]) }) },
  { pattern: new RegExp(`^心情每小時消耗${NUM}$`, 'u'), effect: m => ({ kind: 'moodCost', value: Number(m[1]) }) },
  { pattern: new RegExp(`^訂單(?:獲取|獲得)效率${NUM}%$`, 'u'), effect: m => ({ kind: 'order', value: Number(m[1]) }) },
  { pattern: new RegExp(`^且?訂單上限${NUM}$`, 'u'), effect: m => ({ kind: 'orderLimit', value: Number(m[1]) }) },
  { pattern: new RegExp(`^無人機充能速度${NUM}%$`, 'u'), effect: m => ({ kind: 'drone', value: Number(m[1]) }) },
  { pattern: new RegExp(`^自身心情每小時恢復${NUM}$`, 'u'), effect: m => ({ kind: 'moodRecoverSelf', value: Number(m[1]) }) },
  { pattern: new RegExp(`^該宿舍內所有幹員的心情每小時恢復${NUM}（同種效果取最高）$`, 'u'), effect: m => ({ kind: 'moodRecoverAll', value: Number(m[1]) }) },
];

function parseClauses(text: string): SkillEffect[] | null {
  const effects: SkillEffect[] = [];
  for (const raw of text.split('，')) {
    // 搭配條件中的「額外」只是語氣，數值與一般句型相同。
    const clause = raw.trim().replace(/額外(?=[+-])/u, '');
    if (!clause) continue;
    const rule = CLAUSES.map(item => ({ item, match: clause.match(item.pattern) })).find(entry => entry.match);
    if (!rule?.match) return null;
    effects.push(rule.item.effect(rule.match));
  }
  return effects;
}

export function parseSkill(skill: Pick<BaseSkill, 'roomType' | 'description'>): ParsedSkill {
  const prefix = ROOM_PREFIX[skill.roomType];
  const unsupported = { supported: false, effects: [] };
  if (!prefix) return unsupported;
  const head = `進駐${prefix}時，`;
  // 搭配條件：「當與【單一幹員名稱】在同一個（本設施）時，……」。陣營或多人條件不支援。
  const combo = skill.description.match(new RegExp(`[，；]?當與([^，；、或和]+?)在同一個${prefix}時，(.+)$`, 'u'));
  const before = combo ? skill.description.slice(0, combo.index) : skill.description;
  let unconditional: SkillEffect[] = [];
  if (before.startsWith(head)) {
    const parsed = parseClauses(before.slice(head.length));
    if (!parsed) return unsupported;
    unconditional = parsed;
  } else if (before !== '' && before !== head.slice(0, -1)) return unsupported;
  if (!combo) return { supported: unconditional.length > 0, effects: unconditional };
  // 陣營條件（「……幹員」）無法對應單一幹員：保留無條件部分，條件加成標為未計入。
  if (/幹員$/u.test(combo[1])) return unconditional.length ? { supported: true, effects: unconditional, ignoredCondition: `與${combo[1]}同房時的加成` } : unsupported;
  const conditional = parseClauses(combo[2]);
  if (!conditional?.length) return unsupported;
  return { supported: true, effects: unconditional, conditional: { partner: combo[1].trim(), effects: conditional } };
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
  /** applied：實際計入的效果（已依產品與搭配條件過濾）；combo：搭配條件與是否成立。 */
  skills: (SlotResult & { parsed?: ParsedSkill; applies: boolean; applied?: SkillEffect[]; combo?: { partner: string; active: boolean } })[];
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
  /** 搭配技能的搭檔不在同一設施，條件效果沒有計入。 */
  comboMissing: { operatorId: string; skill: BaseSkill; partner: string }[];
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
    const result: FacilityResult = { facility, label, room, capacity: 0, operators: [], totals: { basic: 0, productivity: 0, order: 0, drone: 0, moodRecoverAll: 0, moodCost: [] }, unsupported: [], uncertain: [], notApplicable: [], comboMissing: [], issues: [] };
    if (!room) { result.issues.push('資料包沒有此設施的資料。'); return result; }
    const phase = room.phases[facility.level - 1];
    if (!phase) { result.issues.push(`等級超過資料上限（最高 ${room.phases.length} 級）。`); }
    else {
      result.capacity = phase.maxStationedNum;
      if (phase.electricity >= 0) produced += phase.electricity; else consumed -= phase.electricity;
    }
    if (facility.type === 'manufacturing' && facility.product !== 'gold' && facility.product !== 'record') result.issues.push('請選擇製造產品（赤金或作戰記錄）。');
    const assigned = base.assignments?.[facility.id] ?? [];
    const roomNames = new Set(assigned.map(id => definitions.get(id)?.displayName).filter((value): value is string => !!value));
    if (result.capacity && assigned.length > result.capacity) result.issues.push(`進駐 ${assigned.length} 人，超過此等級上限 ${result.capacity} 人。`);
    for (const operatorId of assigned) {
      const row = rows.get(operatorId), definition = definitions.get(operatorId);
      const name = definition?.displayName ?? operatorId;
      if (!row) { result.issues.push(`${name} 不在目前幹員庫。`); continue; }
      const previous = seen.get(operatorId);
      if (previous) issues.push(`${name} 同時被安排在「${previous}」與「${label}」。`); else seen.set(operatorId, label);
      const slots = catalog.operators[operatorId] ?? [];
      const skills: OperatorInRoom['skills'] = slots.map(slot => {
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
        const partner = skill.parsed.conditional?.partner;
        const comboActive = !!partner && partner !== name && roomNames.has(partner);
        if (partner) skill.combo = { partner, active: comboActive };
        const candidates = [...skill.parsed.effects, ...(comboActive ? skill.parsed.conditional!.effects : [])];
        skill.applied = candidates.filter(effect => productMatches(effect, facility));
        let applied = false;
        for (const effect of skill.applied) {
          applied = true;
          if (effect.kind === 'productivity') result.totals.productivity += effect.value;
          else if (effect.kind === 'order') result.totals.order += effect.value;
          else if (effect.kind === 'drone') result.totals.drone += effect.value;
          else if (effect.kind === 'moodRecoverAll') result.totals.moodRecoverAll = Math.max(result.totals.moodRecoverAll, effect.value);
          else if (effect.kind === 'moodCost') result.totals.moodCost.push(effect.value);
        }
        if (!applied && !(partner && !comboActive)) result.notApplicable.push({ operatorId, skill: skill.active });
        if (partner && !comboActive) result.comboMissing.push({ operatorId, skill: skill.active, partner });
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

/* ------------------------------------------------------------------ */
/* 推薦配置：只用「已解鎖且可解析」的技能，全域貪婪分配。                  */
/* 不模擬心情與輪班；控制中樞等無法計算的設施不推薦人選。                  */
/* ------------------------------------------------------------------ */
export interface RecommendationPick { facilityId: string; operatorId: string; name: string; score: number; summary: string }
export interface FacilityRecommendation {
  facilityId: string; label: string; picks: RecommendationPick[];
  /** 未被選上、但同樣有可計算技能的前幾名。 */
  alternatives: RecommendationPick[];
  /** 解鎖狀態未知、若已解鎖可能值得考慮的人選。 */
  maybe: { operatorId: string; name: string; summary: string }[];
  note?: string;
}
export interface BaseRecommendation { assignments: Record<string, string[]>; facilities: FacilityRecommendation[]; pool: number; picked: number }

const RECOMMENDABLE: ReadonlySet<BaseRoomType> = new Set(['MANUFACTURE', 'TRADING', 'POWER', 'DORMITORY']);

export function recommendBase(base: Settings['base'], catalog: BaseCatalog, roster: readonly OwnedOperator[], definitions: ReadonlyMap<string, OperatorDefinition>): BaseRecommendation {
  const rooms = new Map(catalog.rooms.map(room => [room.id, room]));
  const capacity = (facility: Facility) => rooms.get(ROOM_OF[facility.type])?.phases[facility.level - 1]?.maxStationedNum ?? 0;
  const owned = roster.filter(row => !(row.fields.owned?.status === 'known' && row.fields.owned.value === false));
  // 每座可推薦設施的完整候選（含分數），之後全域依分數由高到低分配，避免先處理的設施搶走更適合別處的人。
  type Option = RecommendationPick & { order: number; perSeat: number; partner?: RecommendationPick };
  const options: Option[] = [];
  const candidateLists = new Map<string, Candidate[]>();
  const nameOf = (id: string) => definitions.get(id)?.displayName ?? id;
  const idByName = new Map(owned.map(row => [nameOf(row.operatorId), row.operatorId]));
  // 某幹員在設施中的可計算數值；partnerName 存在時一併計入「與該幹員同房」的條件效果。
  const value = (row: OwnedOperator, facility: Facility, partnerName?: string) => {
    let total = 0;
    for (const slot of catalog.operators[row.operatorId] ?? []) {
      const active = slotResult(slot, row, catalog).active;
      if (!active || active.roomType !== ROOM_OF[facility.type]) continue;
      const parsed = parseSkill(active);
      const effects = [...parsed.effects, ...(parsed.conditional && partnerName && parsed.conditional.partner === partnerName ? parsed.conditional.effects : [])];
      for (const effect of effects) if (productMatches(effect, facility) && ['productivity', 'order', 'drone', 'moodRecoverAll', 'moodRecoverSelf'].includes(effect.kind)) total += effect.value;
    }
    return round(total);
  };
  base.facilities.forEach((facility, order) => {
    if (!RECOMMENDABLE.has(ROOM_OF[facility.type])) return;
    const list = candidatesFor(facility, catalog, owned, definitions, new Set());
    candidateLists.set(facility.id, list);
    for (const item of list) if (item.state === 'ready' && item.score > 0) options.push({ facilityId: facility.id, operatorId: item.operatorId, name: item.name, score: item.score, perSeat: item.score, summary: item.summary, order });
    // 搭檔組合：兩人同房的總分換算成每個位置的分數，與單人候選一起排序。
    for (const row of owned) {
      for (const slot of catalog.operators[row.operatorId] ?? []) {
        const active = slotResult(slot, row, catalog).active;
        const partnerName = active && active.roomType === ROOM_OF[facility.type] ? parseSkill(active).conditional?.partner : undefined;
        const partnerId = partnerName ? idByName.get(partnerName) : undefined;
        if (!partnerId || partnerId === row.operatorId) continue;
        const partnerRow = owned.find(item => item.operatorId === partnerId)!;
        const self = value(row, facility, partnerName), mate = value(partnerRow, facility, nameOf(row.operatorId));
        const total = round(self + mate);
        if (total <= Math.max(value(row, facility), value(partnerRow, facility))) continue;
        options.push({ facilityId: facility.id, operatorId: row.operatorId, name: nameOf(row.operatorId), score: self, perSeat: total / 2, summary: `${active!.name}（與${partnerName}同房）`, order,
          partner: { facilityId: facility.id, operatorId: partnerId, name: partnerName!, score: mate, summary: `搭配${nameOf(row.operatorId)}` } });
      }
    }
  });
  options.sort((a, b) => b.perSeat - a.perSeat || b.score - a.score || a.order - b.order || a.name.localeCompare(b.name, 'zh-Hant'));
  const assignments: Record<string, string[]> = Object.fromEntries(base.facilities.map(facility => [facility.id, []]));
  const used = new Set<string>();
  const picks = new Map<string, RecommendationPick[]>();
  // 「全宿舍恢復」為同種效果取最高，同一間宿舍放第二位不會增加效果，因此每間只放一位。
  const allDorm = (operatorId: string) => {
    const row = owned.find(item => item.operatorId === operatorId);
    return !!row && (catalog.operators[operatorId] ?? []).some(slot => { const active = slotResult(slot, row, catalog).active; return !!active && active.roomType === 'DORMITORY' && parseSkill(active).effects.some(effect => effect.kind === 'moodRecoverAll'); });
  };
  const dormWithAll = new Set<string>();
  for (const option of options) {
    const facility = base.facilities.find(item => item.id === option.facilityId)!;
    if (used.has(option.operatorId) || assignments[facility.id].length >= capacity(facility)) continue;
    if (option.partner) {
      if (used.has(option.partner.operatorId) || assignments[facility.id].length + 2 > capacity(facility)) continue;
      assignments[facility.id].push(option.operatorId, option.partner.operatorId); used.add(option.operatorId); used.add(option.partner.operatorId);
      picks.set(facility.id, [...(picks.get(facility.id) ?? []), option, option.partner]);
      continue;
    }
    if (facility.type === 'dormitory' && allDorm(option.operatorId)) { if (dormWithAll.has(facility.id)) continue; dormWithAll.add(facility.id); }
    assignments[facility.id].push(option.operatorId); used.add(option.operatorId);
    picks.set(facility.id, [...(picks.get(facility.id) ?? []), option]);
  }
  const labels = evaluateBase(base, catalog, [], definitions).facilities;
  const facilities = base.facilities.map((facility, index): FacilityRecommendation => {
    const label = labels[index].label;
    if (!RECOMMENDABLE.has(ROOM_OF[facility.type])) return { facilityId: facility.id, label, picks: [], alternatives: [], maybe: [], note: `${FACILITY_LABEL[facility.type]}的技能多為跨設施或條件效果，無法用可追溯數值比較，因此不推薦人選。` };
    const list = candidateLists.get(facility.id) ?? [];
    const alternatives = list.filter(item => item.state === 'ready' && item.score > 0 && !assignments[facility.id].includes(item.operatorId)).slice(0, 3)
      .map(item => ({ facilityId: facility.id, operatorId: item.operatorId, name: item.name, score: item.score, summary: used.has(item.operatorId) ? `${item.summary}（已排在其他設施）` : item.summary }));
    const maybe = list.filter(item => item.state === 'unknown').slice(0, 3).map(item => ({ operatorId: item.operatorId, name: item.name, summary: item.summary }));
    const chosen = picks.get(facility.id) ?? [];
    const open = capacity(facility) - chosen.length;
    const note = open > 0 ? `還有 ${open} 個空位沒有可計算技能的人選${ROOM_OF[facility.type] === 'MANUFACTURE' || ROOM_OF[facility.type] === 'TRADING' ? '；放任何幹員都有基礎加成' : ''}。` : undefined;
    return { facilityId: facility.id, label, picks: chosen, alternatives, maybe, note };
  });
  return { assignments, facilities, pool: owned.length, picked: used.size };
}

/* ------------------------------------------------------------------ */
/* 練卡建議：哪些幹員練到下一階段，就能解鎖或升級基建技能。                 */
/* 只計可解析的數值；條件型技能列出但不排名。                             */
/* ------------------------------------------------------------------ */
export interface TrainingEntry {
  operatorId: string; name: string; owned: boolean;
  room: BaseRoomType; roomLabel: string;
  from?: BaseSkill; to: BaseSkill;
  requirement: { elite: number; level: number };
  current?: { elite?: number; level?: number };
  /** 練成後此技能欄增加的可計算數值；undefined 表示無法計算。 */
  gain?: number;
  /** 需要跨幾個精英階段（越少越容易）。 */
  step: number;
}
export interface DomainAnalysis { room: BaseRoomType; label: string; currentBest: number; potentialBest: number; owners: number }

const ROOM_LABEL: Record<string, string> = { CONTROL: '控制中樞', POWER: '發電站', MANUFACTURE: '製造站', TRADING: '貿易站', DORMITORY: '宿舍', MEETING: '會客室', HIRE: '辦公室', TRAINING: '訓練室', WORKSHOP: '加工站' };
function skillValue(skill: BaseSkill | undefined): number | undefined {
  if (!skill) return 0;
  const parsed = parseSkill(skill);
  if (!parsed.supported) return undefined;
  return parsed.effects.reduce((sum, effect) => sum + (['productivity', 'order', 'drone', 'moodRecoverAll', 'moodRecoverSelf'].includes(effect.kind) ? effect.value : 0), 0);
}

export function trainingAdvice(catalog: BaseCatalog, roster: readonly OwnedOperator[], definitions: ReadonlyMap<string, OperatorDefinition>, options: { ownedOnly: boolean; rooms?: ReadonlySet<BaseRoomType> }): { entries: TrainingEntry[]; domains: DomainAnalysis[] } {
  const rows = new Map(roster.filter(row => !(row.fields.owned?.status === 'known' && row.fields.owned.value === false)).map(row => [row.operatorId, row]));
  const entries: TrainingEntry[] = [];
  const best = new Map<BaseRoomType, { current: number; potential: number; owners: Set<string> }>();
  const touch = (room: BaseRoomType) => { if (!best.has(room)) best.set(room, { current: 0, potential: 0, owners: new Set() }); return best.get(room)!; };
  for (const [operatorId, slots] of Object.entries(catalog.operators)) {
    const row = rows.get(operatorId);
    if (!row && (options.ownedOnly || !definitions.has(operatorId))) continue;
    const name = definitions.get(operatorId)?.displayName ?? operatorId;
    const elite = row ? (row.fields.elite?.status === 'known' ? Number(row.fields.elite.value) : undefined) : undefined;
    const level = row ? (row.fields.level?.status === 'known' ? Number(row.fields.level.value) : undefined) : undefined;
    for (const slot of slots) {
      const versions = slot.map(version => ({ version, skill: catalog.skills[version.buffId] })).filter(item => item.skill);
      if (!versions.length) continue;
      const room = versions[0].skill.roomType as BaseRoomType;
      if (options.rooms && !options.rooms.has(room)) continue;
      const stats = touch(room);
      const states = versions.map(item => row ? unlockState(item.version, row) : 'locked' as UnlockState);
      const activeIndex = states.lastIndexOf('ready');
      const active = activeIndex >= 0 ? versions[activeIndex].skill : undefined;
      const activeValue = skillValue(active) ?? 0;
      if (row && active) { stats.current = Math.max(stats.current, activeValue); stats.owners.add(operatorId); }
      const top = skillValue(versions[versions.length - 1].skill);
      if (top !== undefined) stats.potential = Math.max(stats.potential, top);
      // 只列出「確定未解鎖」的下一個版本；未知狀態先請使用者補資料，不硬給建議。
      const nextIndex = states.findIndex((state, index) => index > activeIndex && state === 'locked');
      if (nextIndex < 0) continue;
      const next = versions[nextIndex];
      const nextValue = skillValue(next.skill);
      entries.push({
        operatorId, name, owned: !!row, room, roomLabel: ROOM_LABEL[room] ?? room, from: active, to: next.skill,
        requirement: { elite: next.version.elite, level: next.version.level },
        ...(row ? { current: { ...(elite !== undefined ? { elite } : {}), ...(level !== undefined ? { level } : {}) } } : {}),
        ...(nextValue !== undefined ? { gain: round(nextValue - activeValue) } : {}),
        step: Math.max(0, next.version.elite - (elite ?? 0)),
      });
    }
  }
  entries.sort((a, b) => Number(b.gain !== undefined) - Number(a.gain !== undefined) || (b.gain ?? 0) - (a.gain ?? 0) || Number(b.owned) - Number(a.owned) || a.step - b.step || a.name.localeCompare(b.name, 'zh-Hant'));
  const domains = [...best.entries()].map(([room, value]) => ({ room, label: ROOM_LABEL[room] ?? room, currentBest: round(value.current), potentialBest: round(value.potential), owners: value.owners.size }))
    .sort((a, b) => BASE_ORDER.indexOf(a.room) - BASE_ORDER.indexOf(b.room));
  return { entries, domains };
}
const BASE_ORDER: BaseRoomType[] = ['MANUFACTURE', 'TRADING', 'POWER', 'DORMITORY', 'CONTROL', 'MEETING', 'HIRE', 'TRAINING', 'WORKSHOP'];

/* ------------------------------------------------------------------ */
/* 基建統計：赤金、經驗產量與換班建議。                                   */
/* 產量＝每日秒數 ×（1＋已計入生產力）÷ 配方秒數；只用已計入的加成。         */
/* 換班＝心情上限 ÷（設施基礎消耗＋技能的自身消耗調整）。                   */
/* ------------------------------------------------------------------ */
export interface ManufactureStat { facilityId: string; label: string; product: 'gold' | 'record'; itemName: string; productivity: number; perDay: number; goldPerDay: number; expPerDay: number; storageItems: number; hoursToFull: number }
export interface TradingStat { facilityId: string; label: string; efficiency: number; ordersPerDay: number; lmdPerDay: number; goldPerDay: number; hoursToFull: number; qualitySkills: number }
export interface ShiftStat { facilityId: string; label: string; hours: number; operator: string; rate: number }
export interface BaseStatistics {
  available: boolean;
  manufacture: ManufactureStat[];
  goldPerDay: number; expPerDay: number;
  trading: TradingStat[]; lmdPerDay: number; goldConsumedPerDay: number;
  shifts: ShiftStat[];
  suggestion?: { hours: number; shifts: number; text: string };
  storageWarnings: string[];
}

export function baseStatistics(evaluation: BaseEvaluation, catalog: BaseCatalog): BaseStatistics {
  const empty: BaseStatistics = { available: false, manufacture: [], goldPerDay: 0, expPerDay: 0, trading: [], lmdPerDay: 0, goldConsumedPerDay: 0, shifts: [], storageWarnings: [] };
  if (!catalog.formulas || !catalog.mood) return empty;
  const { gold, records } = catalog.formulas;
  const manufacture: ManufactureStat[] = [];
  const shifts: ShiftStat[] = [];
  const trading: TradingStat[] = [];
  for (const result of evaluation.facilities) {
    const { facility } = result;
    const roomType = ROOM_OF[facility.type];
    if (roomType === 'MANUFACTURE' && result.operators.length && (facility.product === 'gold' || facility.product === 'record')) {
      const record = [...records].reverse().find(item => item.level <= facility.level) ?? records[0];
      const formula = facility.product === 'gold' ? gold : record;
      const productivity = round(result.totals.basic + result.totals.productivity);
      const perDay = 86400 * (1 + productivity / 100) / formula.seconds;
      const capacityBonus = result.operators.reduce((sum, op) => sum + op.skills.reduce((inner, skill) => inner + (skill.applies ? (skill.applied ?? []).filter(effect => effect.kind === 'capacity').reduce((a, effect) => a + effect.value, 0) : 0), 0), 0);
      const capacity = (catalog.outputCapacity?.[facility.level - 1] ?? 0) + capacityBonus;
      const storageItems = Math.floor(capacity / formula.weight);
      manufacture.push({ facilityId: facility.id, label: result.label, product: facility.product, itemName: formula.name, productivity, perDay: round(perDay),
        goldPerDay: facility.product === 'gold' ? round(perDay) : 0, expPerDay: facility.product === 'record' ? Math.round(perDay * record.exp) : 0,
        storageItems, hoursToFull: perDay > 0 ? round(storageItems / (perDay / 24)) : 0 });
    }
    if (roomType === 'TRADING' && result.operators.length) {
      // 訂單效率＝每名工作幹員 1%＋可解析技能；一筆訂單的期望時間與報酬依等級機率加權（PRTS 數據）。
      const efficiency = round(result.totals.basic + result.totals.order);
      const params = catalog.trading ?? DEFAULT_TRADING;
      const order = expectedOrder(facility.level, params);
      const ordersPerDay = 86400 * (1 + efficiency / 100) / order.seconds;
      const qualitySkills = result.unsupported.filter(item => item.skill.description.includes('訂單的出現機率')).length;
      trading.push({ facilityId: facility.id, label: result.label, efficiency, ordersPerDay: round(ordersPerDay), lmdPerDay: Math.round(ordersPerDay * order.lmd), goldPerDay: round(ordersPerDay * order.gold),
        hoursToFull: round((params.limits[facility.level - 1] ?? params.limits[params.limits.length - 1]) / (ordersPerDay / 24)), qualitySkills });
    }
    const base = catalog.mood.costPerHour[roomType]?.[facility.level - 1] ?? 0;
    if (base <= 0 || !result.operators.length) continue;
    let worst: ShiftStat | undefined;
    for (const op of result.operators) {
      const delta = op.skills.reduce((sum, skill) => sum + (skill.applies ? (skill.applied ?? []).filter(effect => effect.kind === 'moodCost').reduce((a, effect) => a + effect.value, 0) : 0), 0);
      const rate = Math.max(0.05, base + delta);
      const max = catalog.mood.maxByOperator?.[op.operatorId] ?? catalog.mood.max;
      const hours = round(max / rate);
      if (!worst || hours < worst.hours) worst = { facilityId: facility.id, label: result.label, hours, operator: op.name, rate: round(rate) };
    }
    if (worst) shifts.push(worst);
  }
  const goldPerDay = round(manufacture.reduce((sum, item) => sum + item.goldPerDay, 0));
  const expPerDay = manufacture.reduce((sum, item) => sum + item.expPerDay, 0);
  const minHours = shifts.length ? Math.min(...shifts.map(item => item.hours)) : undefined;
  const fullHours = [...manufacture, ...trading].filter(item => item.hoursToFull > 0).map(item => item.hoursToFull);
  const minStorage = fullHours.length ? Math.min(...fullHours) : undefined;
  let suggestion: BaseStatistics['suggestion'];
  const limit = minHours === undefined ? minStorage : minStorage === undefined ? minHours : Math.min(minHours, minStorage);
  if (limit !== undefined) {
    // 取「心情耗盡」與「倉庫滿」較早者，選能整除 24 小時的班數，讓每天固定時間換班並順便收取。
    const count = [1, 2, 3, 4, 6, 8, 12, 24].find(n => 24 / n <= limit) ?? 24;
    const hours = 24 / count;
    const base = count === 1 ? '每 24 小時換班一次（兩組人隔日輪替）' : count <= 3 ? `${count === 2 ? '兩' : '三'}班制，每 ${hours} 小時換班` : `每 ${hours} 小時換班一次（一天 ${count} 班）`;
    const reason = minStorage !== undefined && (minHours === undefined || minStorage < minHours) ? `；倉庫或訂單最快約 ${round(minStorage)} 小時滿，換班時一併收取` : `；最先累的人約 ${round(minHours!)} 小時心情耗盡`;
    suggestion = { hours, shifts: count, text: base + reason };
  }
  const storageWarnings: string[] = [];
  const lmdPerDay = trading.reduce((sum, item) => sum + item.lmdPerDay, 0);
  const goldConsumedPerDay = round(trading.reduce((sum, item) => sum + item.goldPerDay, 0));
  return { available: true, manufacture, goldPerDay, expPerDay, trading, lmdPerDay, goldConsumedPerDay, shifts: shifts.sort((a, b) => a.hours - b.hours), suggestion, storageWarnings };
}
