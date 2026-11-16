import type { BaseCatalog, BaseRoom, BaseRoomType, BaseSkill, BaseSkillSlot } from '../catalog/base.ts';
import type { OperatorDefinition, OwnedOperator, Settings } from './model.ts';
import { DEFAULT_TRADING, NO_MODS, orderModel, type OrderMods } from '../catalog/trading.ts';

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
  | { kind: 'moodRecoverAll'; value: number }
  /** 依陣營人數倍增：scope=room 為同一設施、base 為整個基建（可有上限）。 */
  | { kind: 'perGroup'; scope: 'room' | 'base'; group: string; max?: number; per: SkillEffect }
  /** 控制中樞對其他設施中某陣營幹員的加成：每名符合者在其所在設施各給一次。 */
  | { kind: 'remote'; target: 'MANUFACTURE' | 'TRADING'; group: string; effects: SkillEffect[] }
  /** 改變貿易站訂單內容的技能（品質、特殊訂單、違約、投資），數值依 PRTS 同步的訂單參數計算。 */
  /** 產生人間煙火：flat 為固定值（可限心情高／低時）；perGroupOutsideDorm 為宿舍外每名某陣營幹員；perDormOccupant 為宿舍每名幹員。 */
  | { kind: 'resource'; resource: '人間煙火'; source: 'flat' | 'perGroupOutsideDorm' | 'perDormOccupant'; amount: number; when?: 'high' | 'low'; group?: string; max?: number }
  /** 依人間煙火數量給加成：每 per 點給 amount（生產力或訂單效率，%）。 */
  | { kind: 'resourceScale'; resource: '人間煙火'; per: number; target: 'productivity' | 'order'; amount: number }
  | { kind: 'orderMod'; mod: 'qualityAlpha' | 'qualityBeta' | 'pepe' | 'closure' | 'twoGold' | 'breach' | 'breachBonus' | 'invest'; amount?: number };
/** 單純數值效果的值；倍增與跨設施效果需另依配置計算，這裡回傳 0。 */
export const scalar = (effect: SkillEffect): number => 'value' in effect ? effect.value : 0;

/** 訂單技能換算成「龍門幣／時」相對常規 3 級貿易站的提升百分點，讓推薦能與訂單效率比較。 */
export function orderModScore(effects: SkillEffect[], catalog: Pick<BaseCatalog, 'trading'>): number {
  const mods: OrderMods = { ...NO_MODS };
  let any = false;
  for (const effect of effects) {
    if (effect.kind !== 'orderMod') continue;
    any = true;
    if (effect.mod === 'qualityAlpha') mods.alpha++; else if (effect.mod === 'qualityBeta') mods.beta++;
    else if (effect.mod === 'breachBonus') mods.breachBonus = Math.max(mods.breachBonus, effect.amount ?? 0);
    else if (effect.mod === 'invest') mods.invest = Math.max(mods.invest, effect.amount ?? 0);
    else mods[effect.mod] = true;
  }
  if (!any) return 0;
  const params = catalog.trading ?? DEFAULT_TRADING, level = params.probability.length;
  const rate = (m: OrderMods) => { const order = orderModel(level, m, params); return order.lmd / order.seconds; };
  return Math.round((rate(mods) / rate(NO_MODS) - 1) * 1000) / 10;
}

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
  { pattern: new RegExp(`^(?:自身)?心情每小時消耗${NUM}$`, 'u'), effect: m => ({ kind: 'moodCost', value: Number(m[1]) }) },
  { pattern: new RegExp(`^訂單(?:獲取|獲得)效率${NUM}%$`, 'u'), effect: m => ({ kind: 'order', value: Number(m[1]) }) },
  { pattern: new RegExp(`^且?訂單上限${NUM}$`, 'u'), effect: m => ({ kind: 'orderLimit', value: Number(m[1]) }) },
  { pattern: new RegExp(`^無人機充能速度${NUM}%$`, 'u'), effect: m => ({ kind: 'drone', value: Number(m[1]) }) },
  { pattern: new RegExp(`^自身心情每小時恢復${NUM}$`, 'u'), effect: m => ({ kind: 'moodRecoverSelf', value: Number(m[1]) }) },
  { pattern: new RegExp(`^該宿舍內所有幹員的心情每小時恢復${NUM}（同種效果取最高）$`, 'u'), effect: m => ({ kind: 'moodRecoverAll', value: Number(m[1]) }) },
];

function parseClause(raw: string): SkillEffect | null {
  // 搭配條件中的「額外」只是語氣；「當前／目前貿易站」只是指本設施。
  const clause = raw.trim().replace(/額外(?=[+-])/u, '').replace(/^(?:當前|目前)(?:貿易站|製造站)/u, '');
  const rule = CLAUSES.map(item => ({ item, match: clause.match(item.pattern) })).find(entry => entry.match);
  return rule?.match ? rule.item.effect(rule.match) : null;
}

function parseClauses(text: string): SkillEffect[] | null {
  const effects: SkillEffect[] = [];
  const parts = text.split(/[，；]/u).map(part => part.trim()).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    // 控制中樞：「每個進駐在製造站的某陣營幹員(，)生產力+N%(，……)」，其後子句都是對該陣營幹員的效果。
    const remote = part.match(/^每個進駐在(製造站|貿易站)的(.+?)幹員(.*)$/u);
    if (remote) {
      const rest = [remote[3], ...parts.slice(index + 1)].map(item => item.replace(/^，/u, '').trim()).filter(Boolean);
      const each = rest.map(parseClause);
      if (!each.length || each.some(effect => !effect)) return null;
      effects.push({ kind: 'remote', target: remote[1] === '製造站' ? 'MANUFACTURE' : 'TRADING', group: remote[2], effects: each as SkillEffect[] });
      return effects;
    }
    // 同設施或全基建的陣營人數：只倍增緊接的下一個子句。
    const room = part.match(/^同個(?:貿易站|製造站)中每有1名(.+?)幹員$/u);
    const base = part.match(/^基建內（[^）]*）每有1名(.+?)幹員（最多(\d+)名）$/u);
    if (room || base) {
      const per = parts[index + 1] ? parseClause(parts[index + 1]) : null;
      if (!per) return null;
      effects.push(room ? { kind: 'perGroup', scope: 'room', group: room[1], per } : { kind: 'perGroup', scope: 'base', group: base![1], max: Number(base![2]), per });
      index++;
      continue;
    }
    const effect = parseClause(part);
    if (!effect) return null;
    effects.push(effect);
  }
  return effects;
}

// 訂單類技能的完整句型（台服原文）；比對成功才視為可計算。
const ORDER_SKILLS: { pattern: RegExp; effects: (m: RegExpMatchArray) => SkillEffect[] }[] = [
  { pattern: /^進駐貿易站時，(小幅)?提升當前貿易站高品質貴金屬訂單的出現機率（工作時長影響機率），心情每小時消耗([+-][\d.]+)$/u, effects: m => [{ kind: 'orderMod', mod: m[1] ? 'qualityAlpha' : 'qualityBeta' }, { kind: 'moodCost', value: Number(m[2]) }] },
  { pattern: /^進駐貿易站時，固定獲取特別獨佔訂單（不視作違約訂單），且該類訂單不受任何訂單獲取效率的影響$/u, effects: () => [{ kind: 'orderMod', mod: 'pepe' }] },
  { pattern: /^進駐貿易站時，訂單(?:獲得|獲取)效率\+(\d+)%，固定獲得可露希爾特別訂單（不視作違約訂單）$/u, effects: m => [{ kind: 'order', value: Number(m[1]) }, { kind: 'orderMod', mod: 'closure' }] },
  { pattern: /^進駐貿易站時，訂單(?:獲得|獲取)效率\+(\d+)%，當前貿易站赤金訂單的赤金交付數必定為2（不視作違約訂單）$/u, effects: m => [{ kind: 'order', value: Number(m[1]) }, { kind: 'orderMod', mod: 'twoGold' }] },
  { pattern: /^進駐貿易站時，如果下筆赤金訂單交付數小於4，則視為違約訂單$/u, effects: () => [{ kind: 'orderMod', mod: 'breach' }] },
  { pattern: /^進駐貿易站時，如果下筆赤金訂單是違約訂單，則赤金交付數額外\+(\d+)$/u, effects: m => [{ kind: 'orderMod', mod: 'breachBonus', amount: Number(m[1]) }] },
  { pattern: /^進駐貿易站後，如果下筆赤金訂單交付數大於3（違約訂單不視作赤金訂單），則其龍門幣收益\+(\d+)，心情每小時消耗([+-][\d.]+)$/u, effects: m => [{ kind: 'orderMod', mod: 'invest', amount: Number(m[1]) }, { kind: 'moodCost', value: Number(m[2]) }] },
];

// 人間煙火相關的完整句型（台服原文）。
const RESOURCE_SKILLS: { room: string; pattern: RegExp; effects: (m: RegExpMatchArray) => SkillEffect[]; ignored?: string }[] = [
  { room: 'CONTROL', pattern: /^進駐控制中樞時，當自身心情大於12時，人間煙火\+(\d+)；當自身心情處於12以下時，感知資訊\+\d+$/u, effects: m => [{ kind: 'resource', resource: '人間煙火', source: 'flat', amount: Number(m[1]), when: 'high' }], ignored: '心情 12 以下時的感知資訊' },
  { room: 'CONTROL', pattern: /^進駐控制中樞時，控制中樞內所有幹員的心情每小時恢復\+[\d.]+；當自身心情處於12以下時，人間煙火\+(\d+)$/u, effects: m => [{ kind: 'resource', resource: '人間煙火', source: 'flat', amount: Number(m[1]), when: 'low' }], ignored: '控制中樞全體心情恢復' },
  { room: 'CONTROL', pattern: /^進駐控制中樞時，自身心情每小時消耗\+([\d.]+)；每個歲幹員進駐在宿舍和活動室以外的設施則人間煙火\+(\d+)（最多(\d+)名）$/u, effects: m => [{ kind: 'moodCost', value: Number(m[1]) }, { kind: 'resource', resource: '人間煙火', source: 'perGroupOutsideDorm', group: '歲', amount: Number(m[2]), max: Number(m[3]) }] },
  { room: 'TRADING', pattern: /^進駐貿易站時，宿舍內每有1名幹員則人間煙火\+(\d+)，同時每有1點人間煙火，則訂單獲取效率\+(\d+)%$/u, effects: m => [{ kind: 'resource', resource: '人間煙火', source: 'perDormOccupant', amount: Number(m[1]) }, { kind: 'resourceScale', resource: '人間煙火', per: 1, target: 'order', amount: Number(m[2]) }] },
  { room: 'MANUFACTURE', pattern: /^進駐製造站時，每(\d+)點人間煙火\+(\d+)%生產力$/u, effects: m => [{ kind: 'resourceScale', resource: '人間煙火', per: Number(m[1]), target: 'productivity', amount: Number(m[2]) }] },
];

export function parseSkill(skill: Pick<BaseSkill, 'roomType' | 'description'>): ParsedSkill {
  for (const rule of RESOURCE_SKILLS) { if (rule.room !== skill.roomType) continue; const match = skill.description.match(rule.pattern); if (match) return { supported: true, effects: rule.effects(match), ...(rule.ignored ? { ignoredCondition: rule.ignored } : {}) }; }
  if (skill.roomType === 'TRADING') for (const rule of ORDER_SKILLS) { const match = skill.description.match(rule.pattern); if (match) return { supported: true, effects: rule.effects(match) }; }
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
  /** 來自控制中樞的跨設施加成。 */
  remote: { from: string; skill: string; text: string; value: number; kind: 'productivity' | 'order' }[];
  /** 解鎖狀態未知的技能。 */
  uncertain: { operatorId: string; skill: BaseSkill }[];
  /** 生效但不適用目前產品的技能（例如生產作戰記錄時的赤金技能）。 */
  notApplicable: { operatorId: string; skill: BaseSkill }[];
  issues: string[];
}
export interface BaseEvaluation { facilities: FacilityResult[]; electricity: { produced: number; consumed: number }; issues: string[]; resources: { name: '人間煙火'; high: number; low: number; used: number; sources: string[] }[] }

function roomSkillApplies(skill: BaseSkill, roomType: BaseRoomType): boolean { return skill.roomType === roomType; }
export function productMatches(effect: SkillEffect, facility: Pick<Facility, 'product'>): boolean {
  return effect.kind !== 'productivity' || !effect.product || effect.product === facility.product;
}

export function evaluateBase(base: Settings['base'], catalog: BaseCatalog, roster: readonly OwnedOperator[], definitions: ReadonlyMap<string, OperatorDefinition>): BaseEvaluation {
  const rows = new Map(roster.map(row => [row.operatorId, row]));
  const rooms = new Map(catalog.rooms.map(room => [room.id, room]));
  const issues: string[] = [];
  const seen = new Map<string, { label: string; operatorId: string }>();
  let produced = 0, consumed = 0;
  // 陣營判斷：名稱需真的出現在某位幹員的陣營清單中；騎士等隱藏標籤沒有成員資料，視為無法計算。
  const groupsOf = (id: string) => catalog.meta?.[id]?.groups ?? [];
  const knownGroups = new Set(Object.values(catalog.meta ?? {}).flatMap(meta => meta.groups));
  const characterOf = (id: string) => catalog.meta?.[id]?.character ?? id;
  const allAssigned = [...new Set(Object.values(base.assignments ?? {}).flat())];
  const baseMembers = (group: string) => new Set(allAssigned.filter(id => groupsOf(id).includes(group)).map(characterOf)).size;
  const counts = new Map<BaseRoomType, number>();
  const facilities = base.facilities.map((facility, index): FacilityResult => {
    const roomType = ROOM_OF[facility.type], room = rooms.get(roomType);
    const label = `${FACILITY_LABEL[facility.type]} ${base.facilities.slice(0, index + 1).filter(item => item.type === facility.type).length}`;
    counts.set(roomType, (counts.get(roomType) ?? 0) + 1);
    const result: FacilityResult = { facility, label, room, capacity: 0, operators: [], totals: { basic: 0, productivity: 0, order: 0, drone: 0, moodRecoverAll: 0, moodCost: [] }, unsupported: [], uncertain: [], notApplicable: [], comboMissing: [], remote: [], issues: [] };
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
      const previous = seen.get(characterOf(operatorId));
      if (!previous) seen.set(characterOf(operatorId), { label, operatorId });
      else if (previous.operatorId === operatorId) issues.push(`${name} 同時被安排在「${previous.label}」與「${label}」。`);
      else issues.push(`${name}的不同形態是同一位幹員，不能同時進駐「${previous.label}」與「${label}」。`);
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
        if (candidates.some(effect => (effect.kind === 'perGroup' || effect.kind === 'remote') && !knownGroups.has(effect.group))) { result.unsupported.push({ operatorId, skill: skill.active }); skill.applied = []; continue; }
        // 陣營倍增換算成目前配置下的實際數值。
        skill.applied = candidates.map(effect => {
          if (effect.kind !== 'perGroup' || !('value' in effect.per)) return effect;
          const count = effect.scope === 'room' ? assigned.filter(id => groupsOf(id).includes(effect.group)).length : Math.min(effect.max ?? Infinity, baseMembers(effect.group));
          return { ...effect.per, value: round(effect.per.value * count) } as SkillEffect;
        }).filter(effect => effect.kind !== 'perGroup' && productMatches(effect, facility));
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
  // 人間煙火：先加總全基建產量（分心情高／低兩種情況），再套用到依數量加成的技能，取兩者較低值（保守）。
  const dormOccupants = facilities.filter(result => result.facility.type === 'dormitory').reduce((sum, result) => sum + result.operators.length, 0);
  const outsideDorm = facilities.filter(result => result.facility.type !== 'dormitory').flatMap(result => result.operators.map(op => op.operatorId));
  const smoke = { high: 0, low: 0, sources: [] as string[] };
  for (const result of facilities) for (const op of result.operators) for (const skill of op.skills) for (const effect of skill.applied ?? []) {
    if (effect.kind !== 'resource') continue;
    const amount = effect.source === 'flat' ? effect.amount
      : effect.source === 'perDormOccupant' ? effect.amount * dormOccupants
      : effect.amount * Math.min(effect.max ?? Infinity, new Set(outsideDorm.filter(id => groupsOf(id).includes(effect.group ?? '')).map(characterOf)).size);
    if (effect.when !== 'low') smoke.high += amount;
    if (effect.when !== 'high') smoke.low += amount;
    smoke.sources.push(`${op.name}「${skill.active!.name}」${effect.when === 'high' ? '（心情 > 12）' : effect.when === 'low' ? '（心情 ≤ 12）' : ''} +${amount}`);
  }
  const smokeUsed = Math.min(smoke.high, smoke.low);
  for (const result of facilities) for (const op of result.operators) for (const skill of op.skills) for (const effect of skill.applied ?? []) {
    if (effect.kind !== 'resourceScale' || !smokeUsed) continue;
    const value = round(Math.floor(smokeUsed / effect.per) * effect.amount);
    if (effect.target === 'productivity') result.totals.productivity = round(result.totals.productivity + value);
    else result.totals.order = round(result.totals.order + value);
    result.remote.push({ from: op.name, skill: skill.active!.name, text: `人間煙火 ${smokeUsed} 點`, value, kind: effect.target });
  }
  // 第二輪：控制中樞對其他設施中特定陣營幹員的加成，記在被加成的設施上。
  for (const control of facilities.filter(result => result.facility.type === 'control')) {
    for (const op of control.operators) for (const skill of op.skills) for (const effect of skill.applied ?? []) {
      if (effect.kind !== 'remote') continue;
      for (const target of facilities.filter(result => ROOM_OF[result.facility.type] === effect.target)) {
        const members = target.operators.filter(member => groupsOf(member.operatorId).includes(effect.group)).length;
        if (!members) continue;
        for (const each of effect.effects) {
          if (!('value' in each) || !productMatches(each, target.facility)) continue;
          const value = round(each.value * members);
          if (each.kind === 'productivity') target.totals.productivity = round(target.totals.productivity + value);
          else if (each.kind === 'order') target.totals.order = round(target.totals.order + value);
          else continue;
          target.remote.push({ from: op.name, skill: skill.active!.name, text: `${effect.group} ${members} 名`, value, kind: each.kind });
        }
      }
    }
  }
  for (const [roomType, count] of counts) {
    const room = rooms.get(roomType);
    if (room && room.maxCount && count > room.maxCount) issues.push(`${room.name}最多 ${room.maxCount} 座，目前設定 ${count} 座。`);
  }
  if (consumed > produced) issues.push(`電力不足：需要 ${consumed}，發電 ${produced}。`);
  return { facilities, electricity: { produced, consumed }, issues, resources: smoke.sources.length ? [{ name: '人間煙火', high: smoke.high, low: smoke.low, used: smokeUsed, sources: smoke.sources }] : [] };
}
const round = (value: number) => Math.round(value * 100) / 100;

/* ------------------------------------------------------------------ */
/* 候選名單：只依已生效且可解析的技能排序，未知解鎖排在已確認之後。         */
/* ------------------------------------------------------------------ */
export interface Candidate { operatorId: string; name: string; score: number; state: UnlockState | 'none'; summary: string }

export function candidatesFor(facility: Facility, catalog: BaseCatalog, roster: readonly OwnedOperator[], definitions: ReadonlyMap<string, OperatorDefinition>, exclude: ReadonlySet<string>): Candidate[] {
  const roomType = ROOM_OF[facility.type];
  const list: Candidate[] = [];
  const characterOf = (id: string) => catalog.meta?.[id]?.character ?? id;
  const excludedCharacters = new Set([...exclude].map(characterOf));
  for (const row of roster) {
    if (exclude.has(row.operatorId) || excludedCharacters.has(characterOf(row.operatorId))) continue;
    const owned = row.fields.owned;
    if (owned?.status === 'known' && owned.value === false) continue;
    const name = definitions.get(row.operatorId)?.displayName ?? row.operatorId;
    let score = 0, state: Candidate['state'] = 'none';
    const names: string[] = [];
    // 訂單技能可能分在不同技能欄（如但書的合約法＋違約索賠），合起來才算得出效果。
    const orderEffects: SkillEffect[] = [];
    for (const slot of catalog.operators[row.operatorId] ?? []) {
      const resolved = slotResult(slot, row, catalog);
      const skill = resolved.active ?? resolved.maybeUpgraded;
      if (!skill || skill.roomType !== roomType) continue;
      if (resolved.state === 'ready') {
        state = 'ready'; names.push(skill.name);
        const parsed = parseSkill(skill);
        for (const effect of parsed.effects) if (productMatches(effect, facility) && (effect.kind === 'productivity' || effect.kind === 'order' || effect.kind === 'drone' || effect.kind === 'moodRecoverAll' || effect.kind === 'moodRecoverSelf')) score += effect.value;
        if (roomType === 'TRADING') orderEffects.push(...parsed.effects);
      } else if (resolved.state === 'unknown') { if (state === 'none') state = 'unknown'; names.push(`${skill.name}（解鎖待核對）`); }
    }
    if (orderEffects.length) score += orderModScore(orderEffects, catalog);
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
    const orderEffects: SkillEffect[] = [];
    for (const slot of catalog.operators[row.operatorId] ?? []) {
      const active = slotResult(slot, row, catalog).active;
      if (!active || active.roomType !== ROOM_OF[facility.type]) continue;
      const parsed = parseSkill(active);
      const effects = [...parsed.effects, ...(parsed.conditional && partnerName && parsed.conditional.partner === partnerName ? parsed.conditional.effects : [])];
      for (const effect of effects) if (productMatches(effect, facility) && ['productivity', 'order', 'drone', 'moodRecoverAll', 'moodRecoverSelf'].includes(effect.kind)) total += scalar(effect);
      if (ROOM_OF[facility.type] === 'TRADING') orderEffects.push(...effects);
    }
    if (orderEffects.length) total += orderModScore(orderEffects, catalog);
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
  // 以「角色」記錄已安排者：同一角色的不同形態（如阿米婭）只能排一處。
  const characterKey = (id: string) => catalog.meta?.[id]?.character ?? id;
  const usedCharacters = new Set<string>();
  const used = { has: (id: string) => usedCharacters.has(characterKey(id)), add: (id: string) => { usedCharacters.add(characterKey(id)); }, get size() { return usedCharacters.size; } };
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
  return parsed.effects.reduce((sum, effect) => sum + (['productivity', 'order', 'drone', 'moodRecoverAll', 'moodRecoverSelf'].includes(effect.kind) ? scalar(effect) : 0), 0);
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
export interface TradingStat { facilityId: string; label: string; efficiency: number; ordersPerDay: number; lmdPerDay: number; goldPerDay: number; hoursToFull: number; notes: string[] }
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
      const mods: OrderMods = { ...NO_MODS };
      for (const op of result.operators) for (const skill of op.skills) for (const effect of skill.applied ?? []) {
        if (effect.kind !== 'orderMod') continue;
        if (effect.mod === 'qualityAlpha') mods.alpha++; else if (effect.mod === 'qualityBeta') mods.beta++;
        else if (effect.mod === 'breachBonus') mods.breachBonus = Math.max(mods.breachBonus, effect.amount ?? 0);
        else if (effect.mod === 'invest') mods.invest = Math.max(mods.invest, effect.amount ?? 0);
        else mods[effect.mod] = true;
      }
      const order = orderModel(facility.level, mods, params);
      const ordersPerDay = 86400 * (order.fixedTime ? 1 : 1 + efficiency / 100) / order.seconds;
      trading.push({ facilityId: facility.id, label: result.label, efficiency, ordersPerDay: round(ordersPerDay), lmdPerDay: Math.round(ordersPerDay * order.lmd), goldPerDay: round(ordersPerDay * order.gold),
        hoursToFull: round((params.limits[facility.level - 1] ?? params.limits[params.limits.length - 1]) / (ordersPerDay / 24)), notes: order.notes });
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

/* ------------------------------------------------------------------ */
/* 整體最佳化：以完整評估（陣營、控制中樞、搭配、人間煙火、訂單技能、       */
/* 赤金收支）計算整體效益，從推薦配置出發逐格替換／交換，直到無法再提升。    */
/* 屬於局部搜尋，不保證全域最佳；不模擬心情與換班。                         */
/* ------------------------------------------------------------------ */
export interface BaseObjective { total: number; manufacture: number; gold: number; record: number; trading: number; power: number; goldFactor: number }
/** 各產出的權重（1 為標準）；整體效益＝赤金站生產力×gold＋記錄站生產力×record＋龍門幣提升×trading＋無人機×power。 */
export interface ObjectiveWeights { gold: number; record: number; trading: number; power: number }
export const DEFAULT_WEIGHTS: ObjectiveWeights = { gold: 1, record: 1, trading: 1, power: 1 };

export function baseObjective(evaluation: BaseEvaluation, catalog: BaseCatalog, weights: ObjectiveWeights = DEFAULT_WEIGHTS): BaseObjective {
  const stats = baseStatistics(evaluation, catalog);
  const params = catalog.trading ?? DEFAULT_TRADING;
  let gold = 0, record = 0, power = 0;
  for (const result of evaluation.facilities) {
    if (!result.operators.length) continue;
    if (result.facility.type === 'manufacturing') { const value = result.totals.basic + result.totals.productivity; if (result.facility.product === 'record') record += value; else gold += value; }
    if (result.facility.type === 'power') power += result.totals.drone;
  }
  // 貿易站：龍門幣相對「常規訂單、效率 0」的提升；赤金不足時按供應比例打折（佩佩等不耗赤金的訂單不受影響）。
  const goldFactor = stats.goldConsumedPerDay > 0 ? Math.min(1, stats.goldPerDay / stats.goldConsumedPerDay) : 1;
  let trading = 0;
  for (const item of stats.trading) {
    const facility = evaluation.facilities.find(result => result.facility.id === item.facilityId)!.facility;
    const normal = orderModel(facility.level, NO_MODS, params);
    const baseline = 86400 / normal.seconds * normal.lmd;
    const goldShare = item.goldPerDay > 0 ? goldFactor : 1;
    trading += (item.lmdPerDay * goldShare / baseline - 1) * 100;
  }
  const total = round(gold * weights.gold + record * weights.record + trading * weights.trading + power * weights.power);
  return { total, manufacture: round(gold + record), gold: round(gold), record: round(record), trading: round(trading), power: round(power), goldFactor: round(goldFactor) };
}

export interface OptimizeResult { assignments: Record<string, string[]>; products: Record<string, 'gold' | 'record'>; objective: BaseObjective; start: BaseObjective; moves: number; evaluations: number; timedOut: boolean }

export function optimizeBase(base: Settings['base'], catalog: BaseCatalog, roster: readonly OwnedOperator[], definitions: ReadonlyMap<string, OperatorDefinition>, options: { timeBudgetMs?: number; start?: Record<string, string[]>; weights?: ObjectiveWeights } = {}): OptimizeResult {
  const deadline = Date.now() + (options.timeBudgetMs ?? 4000);
  const owned = roster.filter(row => !(row.fields.owned?.status === 'known' && row.fields.owned.value === false));
  const rooms = new Map(catalog.rooms.map(room => [room.id, room]));
  const capacity = (facility: Facility) => rooms.get(ROOM_OF[facility.type])?.phases[facility.level - 1]?.maxStationedNum ?? 0;
  const characterOf = (id: string) => catalog.meta?.[id]?.character ?? id;
  // 宿舍維持推薦結果（恢復效果不在整體效益內），其餘設施參與搜尋。
  const searchable = base.facilities.filter(facility => facility.type !== 'dormitory' && capacity(facility) > 0);
  const start = options.start ?? recommendBase(base, catalog, owned, definitions).assignments;
  let current: Record<string, string[]> = Object.fromEntries(base.facilities.map(facility => [facility.id, [...(start[facility.id] ?? [])].slice(0, capacity(facility))]));
  let evaluations = 0;
  // 製造站產品也是搜尋的一部分：權重偏重龍門幣時可能多開赤金站，偏重經驗時則相反。
  let products: Record<string, 'gold' | 'record'> = Object.fromEntries(base.facilities.filter(f => f.type === 'manufacturing').map(f => [f.id, f.product === 'record' ? 'record' : 'gold']));
  const withProducts = (map: Record<string, 'gold' | 'record'>) => ({ ...base, facilities: base.facilities.map(f => f.type === 'manufacturing' ? { ...f, product: map[f.id] } : f) });
  const score = (assignments: Record<string, string[]>, map = products) => { evaluations++; return baseObjective(evaluateBase({ ...withProducts(map), assignments }, catalog, owned, definitions), catalog, options.weights); };
  // 候選池：有該設施（含控制中樞）已解鎖技能者，加上任何技能提到的陣營成員；產出設施另外允許任何人（基礎加成）。
  const referencedGroups = new Set<string>();
  for (const skill of Object.values(catalog.skills)) for (const effect of parseSkill(skill).effects) {
    if (effect.kind === 'perGroup' || effect.kind === 'remote') referencedGroups.add(effect.group);
    if (effect.kind === 'resource' && effect.group) referencedGroups.add(effect.group);
  }
  const groupMembers = owned.filter(row => (catalog.meta?.[row.operatorId]?.groups ?? []).some(group => referencedGroups.has(group))).map(row => row.operatorId);
  const pools = new Map(searchable.map(facility => {
    const skilled = candidatesFor(facility, catalog, owned, definitions, new Set()).filter(item => item.state === 'ready').map(item => item.operatorId);
    return [facility.id, [...new Set([...skilled, ...groupMembers])]];
  }));
  let best = score(current);
  const startObjective = best;
  let moves = 0, timedOut = false, improved = true;
  const usedCharacters = (assignments: Record<string, string[]>) => new Set(Object.values(assignments).flat().map(characterOf));
  while (improved && !timedOut) {
    improved = false;
    for (const facilityId of Object.keys(products)) {
      const next = { ...products, [facilityId]: products[facilityId] === 'gold' ? 'record' as const : 'gold' as const };
      const value = score(current, next);
      if (value.total > best.total + 0.001) { best = value; products = next; moves++; improved = true; }
    }
    for (const facility of searchable) {
      const slots = capacity(facility);
      for (let slot = 0; slot < slots && !timedOut; slot++) {
        const occupant = current[facility.id][slot];
        const used = usedCharacters(current);
        for (const candidate of pools.get(facility.id) ?? []) {
          if (Date.now() > deadline) { timedOut = true; break; }
          if (candidate === occupant) continue;
          const next: Record<string, string[]> = Object.fromEntries(Object.entries(current).map(([id, list]) => [id, [...list]]));
          if (used.has(characterOf(candidate))) {
            // 已在其他位置：嘗試與目前格子的人交換。
            const [otherId, otherIndex] = Object.entries(next).flatMap(([id, list]) => list.map((op, index) => [id, index] as const)).find(([id, index]) => characterOf(next[id][index]) === characterOf(candidate)) ?? [];
            if (otherId === undefined || otherIndex === undefined || otherId === facility.id) continue;
            if (occupant) next[otherId][otherIndex] = occupant; else next[otherId].splice(otherIndex, 1);
          }
          if (slot < next[facility.id].length) next[facility.id][slot] = candidate; else next[facility.id].push(candidate);
          const value = score(next);
          if (value.total > best.total + 0.001) { best = value; current = next; moves++; improved = true; break; }
        }
      }
    }
  }
  return { assignments: current, products, objective: best, start: startObjective, moves, evaluations, timedOut };
}
