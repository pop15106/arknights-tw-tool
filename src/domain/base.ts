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
  /** 功能設施：線索蒐集速度（alone＝會客室只有自身工作時才生效）、聯絡速度（perDormLevel＝每間宿舍每級）、專精訓練速度、加工副產品機率。 */
  | { kind: 'clue'; value: number; alone?: boolean }
  | { kind: 'contact'; value: number; perDormLevel?: boolean }
  | { kind: 'training'; value: number; professions?: string[]; atMastery?: number }
  | { kind: 'byproduct'; value: number; category: 'elite' | 'skill' | 'base' | 'any' }
  /** 控制中樞對所有製造站／貿易站的加成；maxOnly 為「同種效果取最高」。 */
  | { kind: 'global'; target: 'MANUFACTURE' | 'TRADING' | 'MEETING' | 'HIRE'; value: number; product?: 'gold'; maxOnly: boolean }
  /** 依自身心情生效：high＝心情大於 12、low＝心情 12 以下（落差大於 12）。 */
  | { kind: 'whenMood'; cond: 'high' | 'low'; effect: SkillEffect }
  /** 每 per 點心情落差（上限－目前心情），effect 乘上倍數。 */
  | { kind: 'perMoodDrop'; per: number; effect: SkillEffect }
  /** 同設施除自身以外每名處於工作狀態（心情 > 0）的幹員給一次 effect。 */
  | { kind: 'perOtherWorking'; effect: SkillEffect }
  /** 宿舍：讓該宿舍某位心情未滿的其他幹員每小時恢復（同種效果取最高）。 */
  | { kind: 'dormSingle'; value: number }
  /** 依招募位、發電站數、本設施等級、宿舍總等級、貿易站數、會客室／訓練室等級倍增 effect；max 為加成上限。 */
  | { kind: 'scaleBy'; by: 'recruitSlots' | 'powerPlants' | 'roomLevel' | 'dormLevels' | 'tradingPosts' | 'meetingLevel' | 'trainingLevel' | 'roomOccupants' | 'productTypes'; per: number; effect: SkillEffect; max?: number }
  /** 同站幹員提供的生產力／訂單效率每 per% 再額外提供 value%（天道酬勤、配合意識）。 */
  | { kind: 'perRoomStat'; stat: 'productivity' | 'order'; per: number; value: number; max: number; others: boolean }
  /** 訓練室協助特定職業／專精等級時才生效。 */
  | { kind: 'whenTraining'; professions?: string[]; atMastery?: number; effect: SkillEffect }
  /** 消除心情消耗的影響：同站（可限陣營）或自身的技能心情消耗調整不計。 */
  | { kind: 'moodNeutral'; scope: 'room' | 'self'; group?: string }
  /** 同站幹員提升的訂單上限換算成訂單效率（招商引資、冠軍風采）。 */
  | { kind: 'perOrderLimit'; per: number; value: number; max?: number }
  /** 為當前貿易站提供赤金生產線。 */
  | { kind: 'goldLine'; value: number }
  /** 依赤金生產線數量（生產赤金的製造站＋技能提供）換算。 */
  | { kind: 'perGoldLines'; per: number; effect: SkillEffect }
  /** 同設施其他幹員提供的生產力／訂單效率歸零（依設施數量的加成不受影響）。 */
  | { kind: 'zeroOthers'; stat: 'productivity' | 'order' }
  /** 生產特定配方時才生效。 */
  | { kind: 'whenProduct'; product: 'gold' | 'record'; effect: SkillEffect }
  /** 指定幹員在某設施（或基建內、工作場所）時才生效。 */
  | { kind: 'ifPresent'; name: string; where: BaseRoomType | 'base' | 'work'; effect: SkillEffect }
  /** 同設施內有其他某陣營幹員時才生效。 */
  | { kind: 'ifGroupInRoom'; group: string; effect: SkillEffect }
  /** 控制中樞：所有宿舍內所有幹員心情恢復（同種效果取最高）。 */
  | { kind: 'globalDorm'; value: number }
  /** 隨進駐時間爬升：首小時 first，此後每小時 +perHour，最多 max。 */
  | { kind: 'ramp'; stat: 'productivity' | 'drone'; first: number; perHour: number; max: number }
  /** 控制中樞：其他設施內處於工作狀態的幹員心情每小時調整（負值＝恢復）。 */
  | { kind: 'workingMood'; value: number }
  /** 同設施內所有幹員的心情消耗調整（負值＝恢復）。 */
  | { kind: 'moodRoom'; value: number }
  /** 改變貿易站訂單內容的技能（品質、特殊訂單、違約、投資），數值依 PRTS 同步的訂單參數計算。 */
  /** 產生基建資源（人間煙火、熱情值、感知資訊等）。when 限定自身心情高（>12）或低（≤12）時。 */
  | { kind: 'resource'; resource: string; source: ResourceSource; amount: number; when?: 'high' | 'low'; group?: string; max?: number }
  /** 每 per 點 from 轉化為 1 點 to（推定會扣除原資源）。 */
  | { kind: 'convert'; from: string; to: string; per: number }
  /** 每 per 點資源，effect 的數值乘上倍數（effect 為任意一般效果）。 */
  | { kind: 'resourceScale'; resource: string; per: number; effect: SkillEffect }
  /** 資源達到 min 以上時 effect 生效。 */
  | { kind: 'resourceThreshold'; resource: string; min: number; effect: SkillEffect }
  | { kind: 'orderMod'; mod: 'qualityAlpha' | 'qualityBeta' | 'pepe' | 'closure' | 'twoGold' | 'breach' | 'breachBonus' | 'invest'; amount?: number };
/** 單純數值效果的值；倍增與跨設施效果需另依配置計算，這裡回傳 0。 */
export const scalar = (effect: SkillEffect): number => 'value' in effect ? effect.value : 0;
export type ResourceSource = 'flat' | 'perGroupOutsideDorm' | 'perDormOccupant' | 'perRoomOccupant' | 'perGroupInRoom' | 'perRoomLevel' | 'perFacilityLevel' | 'perRecruitSlot';
/** 已知的基建資源名稱；只有這些名稱會被當成資源解析，避免把一般數值誤判成資源。 */
export const BASE_RESOURCES = ['人間煙火', '熱情值', '感知資訊', '思維鏈環', '情報儲備', '烏薩斯特飲', '木天蓼', '無聲共鳴', '魔物料理', '夢境', '小節', '巫術結晶', '工程機器人', '記憶碎片'];
const RES = `(${BASE_RESOURCES.join('|')})`;

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

const ROOM_PREFIX: Record<string, string> = { MANUFACTURE: '製造站', TRADING: '貿易站', POWER: '發電站', DORMITORY: '宿舍', CONTROL: '控制中樞', MEETING: '會客室', HIRE: '人力辦公室', TRAINING: '訓練室協助位' };
// 不影響可計算數值的尾句：保留前面的數值，尾句列為未計入。
const IGNORABLE_TAILS: RegExp[] = [/，當魔王進駐中樞時額外\+[\d.]+（與控制中樞加成有特殊比較規則）$/u, /[，；]?（與控制中樞加成有特殊比較規則）$/u, /[，；]且更容易獲得.+?線索$/u, /[，；]同時每個招募位(?:（不包含初始招募位）)?額外\+\d+%會客室線索蒐集速度$/u, /[，；]每產生\d+次聯絡次數，增加.+?線索的機率(?:（工作時長和招募位影響機率）)?$/u, /，如果訓練位幹員分支為.+?，則訓練速度額外\+\d+%$/u];
/** 去掉後仍需保留尾註的條件加成（例如宿舍「如果目標是某人」只計基礎值）。 */
const STRIPPED_CONDITIONS: [RegExp, string][] = [[/，如果目標是[^，]+?，則恢復效果額外\+[\d.]+(（同種效果取最高）)?$/u, '$1'], [/；同時該宿舍每有1名心情未滿的幹員，則恢復效果額外\+[\d.]+（同種效果只套用最高效果）$/u, '（同種效果取最高）']];
const WORKSHOP_CATEGORY: Record<string, 'elite' | 'skill' | 'base' | 'any'> = { 精英材料: 'elite', 技巧概要: 'skill', 基建材料: 'base', 任意類材料: 'any' };
const NUM = String.raw`([+-]?\d+(?:\.\d+)?)`;
const CLAUSES: { pattern: RegExp; effect: (match: RegExpMatchArray) => SkillEffect }[] = [
  { pattern: new RegExp(`^生產力${NUM}%$`, 'u'), effect: m => ({ kind: 'productivity', value: Number(m[1]) }) },
  { pattern: new RegExp(`^(作戰記錄|貴金屬|源石)類配方的生產力${NUM}%$`, 'u'), effect: m => ({ kind: 'productivity', value: Number(m[2]), product: m[1] === '作戰記錄' ? 'record' : m[1] === '貴金屬' ? 'gold' : 'originium' }) },
  { pattern: new RegExp(`^倉庫容量(?:上限)?${NUM}$`, 'u'), effect: m => ({ kind: 'capacity', value: Number(m[1]) }) },
  { pattern: new RegExp(`^(?:自身)?心情每小時消耗${NUM}$`, 'u'), effect: m => ({ kind: 'moodCost', value: Number(m[1]) }) },
  { pattern: new RegExp(`^訂單(?:獲取|獲得|取得)效率${NUM}%$`, 'u'), effect: m => ({ kind: 'order', value: Number(m[1]) }) },
  { pattern: new RegExp(`^且?訂單上限${NUM}(?:（訂單最少為1）)?$`, 'u'), effect: m => ({ kind: 'orderLimit', value: Number(m[1]) }) },
  { pattern: new RegExp(`^所有(製造站|貿易站)(?:生產力|訂單(?:獲取|獲得)?效率)${NUM}%（同種效果取最高）$`, 'u'), effect: m => ({ kind: 'global', target: m[1] === '製造站' ? 'MANUFACTURE' : 'TRADING', value: Number(m[2]), maxOnly: true }) },
  { pattern: new RegExp(`^人脈資源的聯絡速度${NUM}%（同種效果取最高）$`, 'u'), effect: m => ({ kind: 'global', target: 'HIRE', value: Number(m[1]), maxOnly: true }) },
  { pattern: new RegExp(`^會客室線索蒐集速度(?:提升)?\\+?(\\d+(?:\\.\\d+)?)%（同種效果取最高）$`, 'u'), effect: m => ({ kind: 'global', target: 'MEETING', value: Number(m[1]), maxOnly: true }) },
  { pattern: new RegExp(`^所有生產貴金屬類配方的製造站生產力${NUM}%$`, 'u'), effect: m => ({ kind: 'global', target: 'MANUFACTURE', value: Number(m[1]), product: 'gold', maxOnly: false }) },
  { pattern: new RegExp(`^控制中樞內所有幹員的?心情每小時恢復\\+([\\d.]+)$`, 'u'), effect: m => ({ kind: 'moodRoom', value: -Number(m[1]) }) },
  { pattern: new RegExp(`^線索(?:蒐集|搜集)速度(?:提升|\\+)(\\d+(?:\\.\\d+)?)%$`, 'u'), effect: m => ({ kind: 'clue', value: Number(m[1]) }) },
  { pattern: new RegExp(`^人脈資源的聯絡速度${NUM}%$`, 'u'), effect: m => ({ kind: 'contact', value: Number(m[1]) }) },
  { pattern: new RegExp(`^每個招募位（不包含初始招募位）${NUM}%人脈資源的聯絡速度$`, 'u'), effect: m => ({ kind: 'scaleBy', by: 'recruitSlots', per: 1, effect: { kind: 'contact', value: Number(m[1]) } }) },
  { pattern: new RegExp(`^(?:同時)?每個招募位（不包含初始招募位）使心情每小時消耗${NUM}$`, 'u'), effect: m => ({ kind: 'scaleBy', by: 'recruitSlots', per: 1, effect: { kind: 'moodCost', value: Number(m[1]) } }) },
  { pattern: new RegExp(`^(?:心情每小時消耗\\+[\\d.]+，)?基建內（[^）]*）每名(.+?)幹員為目前幹員的專精技能訓練速度\\+(\\d+)%（最多生效(\\d+)名）$`, 'u'), effect: m => ({ kind: 'perGroup', scope: 'base', group: m[1], max: Number(m[3]), per: { kind: 'training', value: Number(m[2]) } }) },
  { pattern: new RegExp(`^每間宿舍每級(?:額外)?${NUM}%人脈資源的聯絡速度$`, 'u'), effect: m => ({ kind: 'contact', value: Number(m[1]), perDormLevel: true }) },
  { pattern: new RegExp(`^(?:((?:先鋒|近衛|重裝|狙擊|術師|醫療|輔助|特種)(?:與(?:先鋒|近衛|重裝|狙擊|術師|醫療|輔助|特種))?))?幹員的專精技能訓練速度${NUM}%$`, 'u'), effect: m => ({ kind: 'training', value: Number(m[2]), ...(m[1] ? { professions: m[1].split('與') } : {}) }) },
  { pattern: new RegExp(`^如果本次訓練專精技能至(\\d)級，則訓練速度(?:額外)?${NUM}%$`, 'u'), effect: m => ({ kind: 'training', value: Number(m[2]), atMastery: Number(m[1]) }) },
  { pattern: new RegExp(`^副產品的產出機率提升(\\d+(?:\\.\\d+)?)%$`, 'u'), effect: m => ({ kind: 'byproduct', value: Number(m[1]), category: 'any' }) },
  { pattern: new RegExp(`^(?:貿易站|製造站|發電站)內全體幹員每小時心情消耗${NUM}$`, 'u'), effect: m => ({ kind: 'moodRoom', value: Number(m[1]) }) },
  { pattern: new RegExp(`^其他設施內處於工作狀態的幹員心情每小時恢復\\+([\\d.]+)$`, 'u'), effect: m => ({ kind: 'workingMood', value: -Number(m[1]) }) },
  { pattern: new RegExp(`^(?:貿易站|製造站)內除自身以外每名處於工作狀態的幹員${NUM}%訂單獲取效率$`, 'u'), effect: m => ({ kind: 'perOtherWorking', effect: { kind: 'order', value: Number(m[1]) } }) },
  { pattern: new RegExp(`^(?:目前|當前)製造站內所有幹員心情每小時消耗${NUM}$`, 'u'), effect: m => ({ kind: 'moodRoom', value: Number(m[1]) }) },
  { pattern: new RegExp(`^貿易站內幹員心情每小時消耗${NUM}$`, 'u'), effect: m => ({ kind: 'moodRoom', value: Number(m[1]) }) },
  { pattern: new RegExp(`^每間宿舍每級為貴金屬類配方的生產力${NUM}%$`, 'u'), effect: m => ({ kind: 'scaleBy', by: 'dormLevels', per: 1, effect: { kind: 'productivity', value: Number(m[1]), product: 'gold' } }) },
  { pattern: new RegExp(`^每間宿舍每級${NUM}%獲取效率$`, 'u'), effect: m => ({ kind: 'scaleBy', by: 'dormLevels', per: 1, effect: { kind: 'order', value: Number(m[1]) } }) },
  { pattern: new RegExp(`^每間宿舍每級為充能速度${NUM}%$`, 'u'), effect: m => ({ kind: 'scaleBy', by: 'dormLevels', per: 1, effect: { kind: 'drone', value: Number(m[1]) } }) },
  { pattern: new RegExp(`^每個貿易站為當前製造站貴金屬類配方的生產力${NUM}%$`, 'u'), effect: m => ({ kind: 'scaleBy', by: 'tradingPosts', per: 1, effect: { kind: 'productivity', value: Number(m[1]), product: 'gold' } }) },
  { pattern: new RegExp(`^所有宿舍內所有幹員的心情每小時恢復\\+([\\d.]+)（同種效果取最高）$`, 'u'), effect: m => ({ kind: 'globalDorm', value: Number(m[1]) }) },
  { pattern: new RegExp(`^控制中樞內每個(.+?)幹員可使控制中樞內所有幹員的心情每小時恢復\\+([\\d.]+)$`, 'u'), effect: m => ({ kind: 'perGroup', scope: 'room', group: m[1], per: { kind: 'moodRoom', value: -Number(m[2]) } }) },
  { pattern: new RegExp(`^無人機充能速度${NUM}%$`, 'u'), effect: m => ({ kind: 'drone', value: Number(m[1]) }) },
  { pattern: new RegExp(`^自身心情每小時恢復${NUM}$`, 'u'), effect: m => ({ kind: 'moodRecoverSelf', value: Number(m[1]) }) },
  { pattern: new RegExp(`^使該宿舍內除自身以外心情未滿的某個幹員每小時恢復\\+([\\d.]+)（同種效果取最高）$`, 'u'), effect: m => ({ kind: 'dormSingle', value: Number(m[1]) }) },
  { pattern: new RegExp(`^(?:同時)?每個招募位（不包含初始招募位）\\+([\\d.]+)恢復效果（疊加後的最終值同種效果取最高）$`, 'u'), effect: m => ({ kind: 'scaleBy', by: 'recruitSlots', per: 1, effect: { kind: 'moodRecoverAll', value: Number(m[1]) } }) },
  { pattern: new RegExp(`^(?:同時)?目前宿舍每級為恢復效果\\+([\\d.]+)（疊加後的最終值同種效果取最高）$`, 'u'), effect: m => ({ kind: 'scaleBy', by: 'roomLevel', per: 1, effect: { kind: 'moodRecoverAll', value: Number(m[1]) } }) },
  { pattern: new RegExp(`^基建內（不包含副手及活動室使用者）每名(.+?)幹員為該宿舍內所有幹員心情每小時恢復速度\\+([\\d.]+)（最多生效(\\d+)名，且同種效果取最高）$`, 'u'), effect: m => ({ kind: 'perGroup', scope: 'base', group: m[1], max: Number(m[3]), per: { kind: 'moodRecoverAll', value: Number(m[2]) } }) },
  { pattern: new RegExp(`^該宿舍內除自身以外所有幹員的心情每小時恢復${NUM}（同種效果取最高）$`, 'u'), effect: m => ({ kind: 'dormSingle', value: Number(m[1]) }) },
  { pattern: new RegExp(`^該宿舍內所有幹員(?:的)?心情每小時恢復${NUM}$`, 'u'), effect: m => ({ kind: 'moodRecoverAll', value: Number(m[1]) }) },
  { pattern: new RegExp(`^該宿舍內所有幹員的心情每小時恢復${NUM}（同種效果取最高）$`, 'u'), effect: m => ({ kind: 'moodRecoverAll', value: Number(m[1]) }) },
];

function parseClause(raw: string): SkillEffect | null {
  // 搭配條件中的「額外」只是語氣；「當前／目前貿易站」只是指本設施。
  const clause = raw.trim().replace(/^同時/u, '').replace(/額外(?=[+-]|提升)/u, '').replace(/^(?:當前|目前)(?:貿易站|製造站)(?!內)/u, '');
  const rule = CLAUSES.map(item => ({ item, match: clause.match(item.pattern) })).find(entry => entry.match);
  return rule?.match ? rule.item.effect(rule.match) : null;
}

const ROOM_NAME: Record<string, BaseRoomType> = { 貿易站: 'TRADING', 製造站: 'MANUFACTURE', 發電站: 'POWER', 會客室: 'MEETING', 控制中樞: 'CONTROL', 訓練室協助位: 'TRAINING', 訓練室: 'TRAINING' };
/** 條件句（產品、他人在場、陣營同房、設施等級上限、時間爬升）；回傳 undefined 表示不是條件句。 */
function parseConditionClause(parts: string[], index: number): { effects: SkillEffect[]; consumed: number } | null | undefined {
  const part = parts[index], next = parts[index + 1] ?? '';
  const after = (raw: string) => parseClause(raw.replace(/^則/u, ''));
  let m: RegExpMatchArray | null;
  if ((m = part.match(/^生產(作戰記錄|貴金屬)類配方時$/u))) {
    const rest = parts.slice(index + 1).map(after);
    return rest.length && rest.every(Boolean) ? { effects: rest.map(effect => ({ kind: 'whenProduct', product: m![1] === '貴金屬' ? 'gold' : 'record', effect: effect! })), consumed: 1 + rest.length } : null;
  }
  const presence: [RegExp, (m: RegExpMatchArray) => { name: string; where: BaseRoomType | 'base' | 'work' }][] = [
    [/^若(.+?)在(貿易站|製造站|發電站|會客室|控制中樞)$/u, x => ({ name: x[1], where: ROOM_NAME[x[2]] })],
    [/^如果(.+?)進駐在(控制中樞|訓練室協助位|發電站|製造站|貿易站)$/u, x => ({ name: x[1], where: ROOM_NAME[x[2]] })],
    [/^當(.+?)在基建內時（不包含副手及活動室使用者）$/u, x => ({ name: x[1], where: 'base' })],
    [/^當([^、]+?)入駐工作場所時（不包含副手）$/u, x => ({ name: x[1], where: 'work' })],
    [/^當與([^、]+?)一起進駐控制中樞時$/u, x => ({ name: x[1], where: 'CONTROL' })],
    [/^當與([^、]+?)進駐控制中樞一起工作時$/u, x => ({ name: x[1], where: 'CONTROL' })],
  ];
  for (const [pattern, build] of presence) {
    if (!(m = part.match(pattern))) continue;
    // 名稱必須像單一幹員：不含數字、不以「有」開頭、不是陣營或作業平台。
    if (/幹員$|作業平台|^有|\d/u.test(m[1])) break;
    const effect = after(next);
    return effect ? { effects: [{ kind: 'ifPresent', ...build(m), effect }], consumed: 2 } : null;
  }
  if ((m = part.match(/^(?:目前貿易站內存在(.+?)幹員時|當與(.+?)幹員進駐控制中樞一起工作時)$/u))) {
    const effect = after(next);
    return effect ? { effects: [{ kind: 'ifGroupInRoom', group: (m[1] ?? m[2]), effect }], consumed: 2 } : null;
  }
  if (part === '同一貿易站中' && (m = next.match(/^每有1名(.+?)幹員$/u))) {
    const effect = parseClause(parts[index + 2] ?? '');
    return effect ? { effects: [{ kind: 'remote', target: 'TRADING', group: m[1], effects: [effect] }], consumed: 3 } : null;
  }
  if ((m = part.match(/^(會客室|訓練室)每級(?:額外提供|為目前製造站\+)(\d+)%(獲取效率|生產力)$/u))) {
    const cap = next.match(/^最多(?:提供)?(\d+)%(?:效率)?$/u);
    const effect: SkillEffect = m[3] === '生產力' ? { kind: 'productivity', value: Number(m[2]) } : { kind: 'order', value: Number(m[2]) };
    return { effects: [{ kind: 'scaleBy', by: m[1] === '會客室' ? 'meetingLevel' : 'trainingLevel', per: 1, effect, ...(cap ? { max: Number(cap[1]) } : {}) }], consumed: cap ? 2 : 1 };
  }
  if ((m = part.match(/^(生產力|無人機充能速度)(首小時|每小時)\+(\d+(?:\.\d+)?)%$/u))) {
    const stat = m[1] === '生產力' ? 'productivity' : 'drone';
    const first = Number(m[3]);
    let perHour = m[2] === '每小時' ? first : 0, consumed = 1;
    const later = next.match(/^此後每小時\+(\d+(?:\.\d+)?)%$/u);
    if (later) { perHour = Number(later[1]); consumed++; }
    const final = (parts[index + consumed] ?? '').match(/^最終達到\+(\d+(?:\.\d+)?)%$/u);
    if (!final) return null;
    return { effects: [{ kind: 'ramp', stat, first, perHour, max: Number(final[1]) }], consumed: consumed + 1 };
  }
  return undefined;
}

const reRes = (body: string) => new RegExp(`^(?:同時)?${body.replaceAll('RES', RES)}$`, 'u');
/** 解析資源相關子句；回傳 undefined 表示不是資源句，null 表示是資源句但無法解析。consumed 為用掉的子句數。 */
function parseResourceClause(parts: string[], index: number, previous: SkillEffect[]): { effects: SkillEffect[]; consumed: number } | null | undefined {
  const part = parts[index], next = parts[index + 1] ?? '';
  const lastValue = [...previous].reverse().find(effect => 'value' in effect) as (SkillEffect & { value: number }) | undefined;
  const reuse = (value: number): SkillEffect | null => lastValue ? { ...lastValue, value } as SkillEffect : null;
  let m: RegExpMatchArray | null;
  if ((m = part.match(reRes('RES\\+(\\d+)')))) return { effects: [{ kind: 'resource', resource: m[1], source: 'flat', amount: Number(m[2]) }], consumed: 1 };
  if ((m = part.match(reRes('(該)?宿舍內每有1名幹員(?:則RES\\+(\\d+))?')))) {
    const inline = m[2] ? [m[2], m[3]] : next.match(reRes('RES\\+(\\d+)'))?.slice(1);
    return inline ? { effects: [{ kind: 'resource', resource: inline[0], source: m[1] ? 'perRoomOccupant' : 'perDormOccupant', amount: Number(inline[1]) }], consumed: m[2] ? 1 : 2 } : null;
  }
  if ((m = part.match(/^控制中樞內每有1名(.+?)幹員$/u))) {
    const gain = next.match(reRes('則RES\\+(\\d+)'));
    return gain ? { effects: [{ kind: 'resource', resource: gain[1], source: 'perGroupInRoom', group: m[1], amount: Number(gain[2]) }], consumed: 2 } : null;
  }
  if ((m = part.match(/^當自身心情(大於12|處於12以下|落差大於12)時$/u))) {
    const cond = m[1] === '大於12' ? 'high' : 'low';
    const gain = next.match(reRes('RES\\+(\\d+)'));
    if (gain) return { effects: [{ kind: 'resource', resource: gain[1], source: 'flat', amount: Number(gain[2]), when: cond }], consumed: 2 };
    // 其後所有子句都只在該心情狀態下生效。
    const rest = parts.slice(index + 1).map(raw => parseClause(raw));
    return rest.length && rest.every(Boolean) ? { effects: rest.map(effect => ({ kind: 'whenMood', cond, effect: effect! })), consumed: 1 + rest.length } : null;
  }
  if ((m = part.match(/^自身每有(\d+)點心情落差$/u))) {
    const effect = parseClause(next);
    return effect ? { effects: [{ kind: 'perMoodDrop', per: Number(m[1]), effect }], consumed: 2 } : null;
  }
  if ((m = part.match(reRes('(?:目前|當前)宿舍每級提供1(?:層|個)RES')))) return { effects: [{ kind: 'resource', resource: m[1], source: 'perRoomLevel', amount: 1 }], consumed: 1 };
  if ((m = part.match(reRes('基建內除活動室外每間設施每級\\+(\\d+)個RES')))) {
    const cap = next.match(/^上限(\d+)個$/u);
    return { effects: [{ kind: 'resource', resource: m[2], source: 'perFacilityLevel', amount: Number(m[1]), ...(cap ? { max: Number(cap[1]) } : {}) }], consumed: cap ? 2 : 1 };
  }
  if ((m = part.match(reRes('每個招募位（不包含初始招募位）\\+(\\d+)點<?RES')))) return { effects: [{ kind: 'resource', resource: m[2], source: 'perRecruitSlot', amount: Number(m[1]) }], consumed: 1 };
  if ((m = part.match(reRes('每(\\d+)(?:點|層|個)RES轉化為1點RES')))) return { effects: [{ kind: 'convert', from: m[2], to: m[3], per: Number(m[1]) }], consumed: 1 };
  if ((m = part.match(reRes('每(\\d+)(?:點|個)RES\\+(\\d+(?:\\.\\d+)?)%(生產力|訂單效率|專精技能訓練速度)')))) {
    const kind = m[4] === '生產力' ? 'productivity' : m[4] === '訂單效率' ? 'order' : 'training';
    return { effects: [{ kind: 'resourceScale', resource: m[2], per: Number(m[1]), effect: { kind, value: Number(m[3]) } as SkillEffect }], consumed: 1 };
  }
  if ((m = part.match(reRes('每(\\d+)(?:點|瓶)RES(?:額外)?\\+(\\d+(?:\\.\\d+)?)%聯絡速度')))) return { effects: [{ kind: 'resourceScale', resource: m[2], per: Number(m[1]), effect: { kind: 'contact', value: Number(m[3]) } }], consumed: 1 };
  if ((m = part.match(reRes('每(\\d+)點RES額外提升(\\d+(?:\\.\\d+)?)%')))) { const effect = reuse(Number(m[3])); return effect ? { effects: [{ kind: 'resourceScale', resource: m[2], per: Number(m[1]), effect }], consumed: 1 } : null; }
  // 「每有／每擁有 N 點資源」之後的所有子句都按數量倍增；「則(額外)±N」沿用前一個效果的種類。
  if ((m = part.match(reRes('每(?:有|擁有)(\\d+)(?:點|個|瓶)RES')))) {
    const rest = parts.slice(index + 1);
    const scaled: SkillEffect[] = [];
    for (const raw of rest) {
      const bare = raw.match(/^則(?:額外)?([+-][\d.]+)$/u);
      const effect = bare ? reuse(Number(bare[1])) : parseClause(raw.replace(/^則/u, ''));
      if (!effect) return null;
      scaled.push(effect);
    }
    return scaled.length ? { effects: scaled.map(effect => ({ kind: 'resourceScale', resource: m![2], per: Number(m![1]), effect })), consumed: 1 + rest.length } : null;
  }
  if ((m = part.match(reRes('(?:如果)?RES(?:達到|處於)(\\d+)(?:點|瓶)(?:及以上時)?')))) {
    const bonus = next.match(/^則額外提升(\d+(?:\.\d+)?)%$/u);
    const effect = bonus ? reuse(Number(bonus[1])) : parseClause(next);
    return effect ? { effects: [{ kind: 'resourceThreshold', resource: m[1], min: Number(m[2]), effect }], consumed: 2 } : null;
  }
  return /人間煙火|熱情值|感知資訊|思維鏈環|情報儲備|特飲|木天蓼|無聲共鳴|魔物料理|夢境|小節|巫術結晶|工程機器人|記憶碎片/u.test(part) ? null : undefined;
}

function parseClauses(text: string): SkillEffect[] | null {
  const effects: SkillEffect[] = [];
  // 以逗號／分號分句，但不切開全形括號內的逗號（例如「（最多生效2名，且同種效果取最高）」）。
  const parts: string[] = [];
  let depth = 0, current = '';
  for (const char of text) {
    if (char === '（') depth++; else if (char === '）') depth = Math.max(0, depth - 1);
    if ((char === '，' || char === '；') && depth === 0) { if (current.trim()) parts.push(current.trim()); current = ''; } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
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
    const conditional = parseConditionClause(parts, index);
    if (conditional === null) return null;
    if (conditional) { effects.push(...conditional.effects); index += conditional.consumed - 1; continue; }
    const resource = parseResourceClause(parts, index, effects);
    if (resource === null) return null;
    if (resource) { effects.push(...resource.effects); index += resource.consumed - 1; continue; }
    const plants = part.match(/^同時每有(\d+)間發電站$/u);
    const plantBonus = plants && parts[index + 1]?.match(/^則恢復效果(?:額外)?\+([\d.]+)（疊加後的最終值同種效果取最高）$/u);
    if (plants) { if (!plantBonus) return null; effects.push({ kind: 'scaleBy', by: 'powerPlants', per: Number(plants[1]), effect: { kind: 'moodRecoverAll', value: Number(plantBonus[1]) } }); index++; continue; }
    if (part === '如果該宿舍內有其他幹員') {
      const each = parts[index + 1]?.match(/^則每人(?:額外)?為自身心情每小時恢復\+([\d.]+)$/u);
      if (!each) return null;
      effects.push({ kind: 'perOtherWorking', effect: { kind: 'moodRecoverSelf', value: Number(each[1]) } }); index++; continue;
    }
    // 「如果本次訓練專精技能至N級，則訓練速度(額外)+M%」被逗號拆成兩句，在此接回。
    const mastery = part.match(/^如果本次訓練專精技能至(\d)級$/u);
    if (mastery) {
      const bonus = parts[index + 1]?.match(/^則訓練速度(?:額外)?\+(\d+(?:\.\d+)?)%$/u);
      if (!bonus) return null;
      effects.push({ kind: 'training', value: Number(bonus[1]), atMastery: Number(mastery[1]) });
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
  { room: 'TRADING', pattern: /^進駐貿易站時，宿舍內每有1名幹員則人間煙火\+(\d+)，同時每有1點人間煙火，則訂單獲取效率\+(\d+)%$/u, effects: m => [{ kind: 'resource', resource: '人間煙火', source: 'perDormOccupant', amount: Number(m[1]) }, { kind: 'resourceScale', resource: '人間煙火', per: 1, effect: { kind: 'order', value: Number(m[2]) } }] },
  { room: 'MANUFACTURE', pattern: /^進駐製造站時，每(\d+)點人間煙火\+(\d+)%生產力$/u, effects: m => [{ kind: 'resourceScale', resource: '人間煙火', per: Number(m[1]), effect: { kind: 'productivity', value: Number(m[2]) } }] },
];

/** 整句比對的特殊技能（消除心情消耗、訂單上限、赤金生產線）。 */
function parseSpecial(text: string): SkillEffect[] | null {
  let m: RegExpMatchArray | null;
  if (/^進駐製造站時，消除當前製造站內所有幹員自身心情消耗的影響$/u.test(text)) return [{ kind: 'moodNeutral', scope: 'room' }];
  if ((m = text.match(/^進駐控制中樞時，消除當前控制中樞內所有(.+?)幹員自身心情消耗的影響$/u))) return [{ kind: 'moodNeutral', scope: 'room', group: m[1] }];
  if ((m = text.match(/^(?:進駐控制中樞時，)?當與(.+?)一起進駐控制中樞時，消除自身心情消耗的影響$/u))) return [{ kind: 'ifPresent', name: m[1], where: 'CONTROL', effect: { kind: 'moodNeutral', scope: 'self' } }];
  if ((m = text.match(/^進駐貿易站時，當前貿易站內幹員提供的每(\d+)%訂單獲取效率，額外提供(\d+)%效率，最多提供(\d+)%效率$/u))) return [{ kind: 'perRoomStat', stat: 'order', per: Number(m[1]), value: Number(m[2]), max: Number(m[3]), others: false }];
  if ((m = text.match(/^進駐製造站時，當前製造站內其他幹員提供的每(\d+)%生產力（不包含根據設施數量提供加成的生產力），額外提供(\d+)%生產力，最多提供(\d+)%生產力$/u))) return [{ kind: 'perRoomStat', stat: 'productivity', per: Number(m[1]), value: Number(m[2]), max: Number(m[3]), others: true }];
  if ((m = text.match(/^進駐貿易站時，訂單獲取效率\+(\d+)%，製造站每有1類配方進行加工，則當前貿易站訂單獲取效率額外\+(\d+)%$/u))) return [{ kind: 'order', value: Number(m[1]) }, { kind: 'scaleBy', by: 'productTypes', per: 1, effect: { kind: 'order', value: Number(m[2]) } }];
  if ((m = text.match(/^進駐訓練室協助位時，如果本次訓練專精技能至(\d)級，專精技能訓練速度\+(\d+)%$/u))) return [{ kind: 'training', value: Number(m[2]), atMastery: Number(m[1]) }];
  if ((m = text.match(/^進駐訓練室協助(先鋒|近衛|重裝|狙擊|術師|醫療|輔助|特種)幹員訓練專精技能至(\d)級時，心情每小時消耗([+-][\d.]+)$/u))) return [{ kind: 'whenTraining', professions: [m[1]], atMastery: Number(m[2]), effect: { kind: 'moodCost', value: Number(m[3]) } }];
  if ((m = text.match(/^進駐貿易站時，當前貿易站每級\+(\d+)個訂單上限$/u))) return [{ kind: 'scaleBy', by: 'roomLevel', per: 1, effect: { kind: 'orderLimit', value: Number(m[1]) } }];
  if ((m = text.match(/^進駐貿易站時，當前貿易站內幹員提升的每(\d+)?個訂單上限，提供(\d+)%訂單(?:獲取|取得)效率(?:，最多提供(\d+)%效率)?$/u))) return [{ kind: 'perOrderLimit', per: Number(m[1] ?? 1), value: Number(m[2]), ...(m[3] ? { max: Number(m[3]) } : {}) }];
  if ((m = text.match(/^進駐貿易站時，基建內（不包含副手及活動室使用者）每1名(.+?)族?幹員（最多(\d+)名）為目前貿易站提供(\d+)條赤金生產線$/u))) return [{ kind: 'perGroup', scope: 'base', group: m[1].replace(/族$/u, ''), max: Number(m[2]), per: { kind: 'goldLine', value: Number(m[3]) } }];
  if ((m = text.match(/^進駐貿易站時，(?:訂單獲取效率\+(\d+)%，)?每有(\d+)條赤金生產線，則(?:為當前貿易站額外提供(\d+)條赤金生產線|當前貿易站訂單獲取效率(?:額外)?\+(\d+)%)$/u))) return [
    ...(m[1] ? [{ kind: 'order', value: Number(m[1]) } as SkillEffect] : []),
    { kind: 'perGoldLines', per: Number(m[2]), effect: m[3] ? { kind: 'goldLine', value: Number(m[3]) } : { kind: 'order', value: Number(m[4]) } }];
  return null;
}

export function parseSkill(skill: Pick<BaseSkill, 'roomType' | 'description'>): ParsedSkill {
  for (const [pattern, keep] of STRIPPED_CONDITIONS) {
    const match = skill.description.match(pattern);
    if (match) { const parsed = parseSkill({ ...skill, description: skill.description.replace(pattern, keep) }); return parsed.supported ? { ...parsed, ignoredCondition: match[0].replace(/^[，；]/u, '').replace(/（同種效果[^）]*）$/u, '') } : parsed; }
  }
  // 「當與某人／某陣營幹員一起進駐控制中樞時，……」視同中樞技能的條件句。
  if (skill.roomType === 'CONTROL' && /^當與.+?(?:一起進駐控制中樞時|進駐控制中樞一起工作時)，/u.test(skill.description)) return parseSkill({ ...skill, description: `進駐控制中樞時，${skill.description}` });
  for (const tail of IGNORABLE_TAILS) {
    const match = skill.description.match(tail);
    if (match) { const parsed = parseSkill({ ...skill, description: skill.description.slice(0, match.index) }); return parsed.supported ? { ...parsed, ignoredCondition: match[0].replace(/^[，；]/u, '') } : parsed; }
  }
  if (skill.roomType === 'WORKSHOP') {
    const match = skill.description.match(/^進駐加工站加工(精英材料|技巧概要|基建材料|任意類材料)時，(.+)$/u);
    const effects = match ? parseClauses(match[2]) : null;
    return effects?.length ? { supported: true, effects: effects.map(effect => effect.kind === 'byproduct' ? { ...effect, category: WORKSHOP_CATEGORY[match![1]] } : effect) } : { supported: false, effects: [] };
  }
  if (skill.roomType === 'MEETING') {
    const match = skill.description.match(/^進駐會客室時，如果會客室內只有自身處於工作狀態時，(.+)$/u);
    if (match) { const effects = parseClauses(match[1]); return effects?.length ? { supported: true, effects: effects.map(effect => effect.kind === 'clue' ? { ...effect, alone: true } : effect) } : { supported: false, effects: [] }; }
  }
  for (const rule of RESOURCE_SKILLS) { if (rule.room !== skill.roomType) continue; const match = skill.description.match(rule.pattern); if (match) return { supported: true, effects: rule.effects(match), ...(rule.ignored ? { ignoredCondition: rule.ignored } : {}) }; }
  const special = parseSpecial(skill.description);
  if (special) return { supported: true, effects: special };
  const zero = skill.description.match(/^進駐製造站時，(?:當前|目前)製造站內其他幹員提供的生產力全部歸零（不包含根據設施數量提供加成的生產力），(.+)$/u);
  if (zero) {
    const rest = zero[1];
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^每個發電站為當前製造站\+(\d+)%的生產力$/u))) return { supported: true, effects: [{ kind: 'zeroOthers', stat: 'productivity' }, { kind: 'scaleBy', by: 'powerPlants', per: 1, effect: { kind: 'productivity', value: Number(m[1]) } }] };
    if ((m = rest.match(/^每個目前製造站內幹員為目前製造站(?:\+(\d+)%生產力、)?倉庫容量上限\+(\d+)$/u))) return { supported: true, effects: [{ kind: 'zeroOthers', stat: 'productivity' }, ...(m[1] ? [{ kind: 'scaleBy', by: 'roomOccupants', per: 1, effect: { kind: 'productivity', value: Number(m[1]) } } as SkillEffect] : []), { kind: 'scaleBy', by: 'roomOccupants', per: 1, effect: { kind: 'capacity', value: Number(m[2]) } }] };
    return { supported: false, effects: [] };
  }
  const wulian = skill.description.match(/^進駐貿易站時，當前貿易站內其他幹員提供的訂單獲取效率全部歸零，且每人為自身\+(\d+)%訂單獲取效率，同時全體心情每小時消耗\+([\d.]+)$/u);
  if (wulian) return { supported: true, effects: [{ kind: 'zeroOthers', stat: 'order' }, { kind: 'scaleBy', by: 'roomOccupants', per: 1, effect: { kind: 'order', value: Number(wulian[1]) } }, { kind: 'moodRoom', value: Number(wulian[2]) }] };
  if (skill.roomType === 'TRADING') for (const rule of ORDER_SKILLS) { const match = skill.description.match(rule.pattern); if (match) return { supported: true, effects: rule.effects(match) }; }
  const prefix = ROOM_PREFIX[skill.roomType];
  const unsupported = { supported: false, effects: [] };
  if (!prefix) return unsupported;
  const head = skill.description.startsWith(`進駐${prefix}後，`) ? `進駐${prefix}後，` : `進駐${prefix}時，`;
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
  totals: { basic: number; productivity: number; order: number; drone: number; moodRecoverAll: number; moodCost: number[]; clue: number; contact: number; training: number; byproduct: number; dormSingle: number; orderLimit: number };
  /** 各幹員提供的全宿舍恢復合計（疊加後再於幹員間取最高）。 */
  allByOp: Record<string, number>;
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
export interface BaseEvaluation { facilities: FacilityResult[]; electricity: { produced: number; consumed: number }; issues: string[]; resources: { name: string; high: number; low: number; used: number; sources: string[] }[] }

function roomSkillApplies(skill: BaseSkill, roomType: BaseRoomType): boolean { return skill.roomType === roomType; }
export function productMatches(effect: SkillEffect, facility: Pick<Facility, 'product'>): boolean {
  return effect.kind !== 'productivity' || !effect.product || effect.product === facility.product;
}

/** moods：各幹員目前心情（模擬用）。省略時視為班次開始、心情全滿；心情 0 者視為停工。 */
/** elapsed：班次已經過的小時數（模擬用，影響隨時間爬升的技能）；省略時以 12 小時班的平均值計。 */
export function evaluateBase(base: Settings['base'], catalog: BaseCatalog, roster: readonly OwnedOperator[], definitions: ReadonlyMap<string, OperatorDefinition>, moods?: Readonly<Record<string, number>>, elapsed?: number): BaseEvaluation {
  const rampValue = (effect: Extract<SkillEffect, { kind: 'ramp' }>, hours: number) => Math.min(effect.max, effect.first + effect.perHour * Math.max(0, Math.floor(hours)));
  const rampAverage = (effect: Extract<SkillEffect, { kind: 'ramp' }>) => { let sum = 0; for (let h = 0; h < 12; h++) sum += rampValue(effect, h); return round(sum / 12); };
  const nameOf = (id: string) => definitions.get(id)?.displayName ?? id;
  const assignedIn = (filter: (facility: Facility) => boolean) => new Set(base.facilities.filter(filter).flatMap(facility => (base.assignments?.[facility.id] ?? []).filter(id => facility.type === 'dormitory' || (moods?.[id] ?? 1) > 0)).map(nameOf));
  const maxMood = (id: string) => catalog.mood?.maxByOperator?.[id] ?? catalog.mood?.max ?? 24;
  const moodOf = (id: string) => moods?.[id] ?? maxMood(id);
  const rows = new Map(roster.map(row => [row.operatorId, row]));
  const rooms = new Map(catalog.rooms.map(room => [room.id, room]));
  const issues: string[] = [];
  const seen = new Map<string, { label: string; operatorId: string }>();
  let produced = 0, consumed = 0;
  // 陣營判斷：名稱需真的出現在某位幹員的陣營清單中；騎士等隱藏標籤沒有成員資料，視為無法計算。
  const groupsOf = (id: string) => catalog.meta?.[id]?.groups ?? [];
  const knownGroups = new Set(Object.values(catalog.meta ?? {}).flatMap(meta => meta.groups));
  const characterOf = (id: string) => catalog.meta?.[id]?.character ?? id;
  const countBased = new WeakSet<object>();
  const allAssigned = [...new Set(Object.values(base.assignments ?? {}).flat())];
  const dormLevels = base.facilities.filter(facility => facility.type === 'dormitory').reduce((sum, facility) => sum + facility.level, 0);
  const baseMembers = (group: string) => new Set(allAssigned.filter(id => groupsOf(id).includes(group)).map(characterOf)).size;
  const counts = new Map<BaseRoomType, number>();
  const facilities = base.facilities.map((facility, index): FacilityResult => {
    const roomType = ROOM_OF[facility.type], room = rooms.get(roomType);
    const label = `${FACILITY_LABEL[facility.type]} ${base.facilities.slice(0, index + 1).filter(item => item.type === facility.type).length}`;
    counts.set(roomType, (counts.get(roomType) ?? 0) + 1);
    const result: FacilityResult = { facility, label, room, capacity: 0, operators: [], totals: { basic: 0, productivity: 0, order: 0, drone: 0, moodRecoverAll: 0, moodCost: [], clue: 0, contact: 0, training: 0, byproduct: 0, dormSingle: 0, orderLimit: 0 }, allByOp: {}, unsupported: [], uncertain: [], notApplicable: [], comboMissing: [], remote: [], issues: [] };
    if (!room) { result.issues.push('資料包沒有此設施的資料。'); return result; }
    const phase = room.phases[facility.level - 1];
    if (!phase) { result.issues.push(`等級超過資料上限（最高 ${room.phases.length} 級）。`); }
    else {
      result.capacity = phase.maxStationedNum;
      if (phase.electricity >= 0) produced += phase.electricity; else consumed -= phase.electricity;
    }
    if (facility.type === 'manufacturing' && facility.product !== 'gold' && facility.product !== 'record') result.issues.push('請選擇製造產品（赤金或作戰記錄）。');
    const assigned = (base.assignments?.[facility.id] ?? []).filter(id => facility.type === 'dormitory' || moodOf(id) > 0);
    const roomNames = new Set(assigned.map(id => definitions.get(id)?.displayName).filter((value): value is string => !!value));
    const contributions: { operatorId: string; stat: 'productivity' | 'order'; value: number; countBased: boolean }[] = [];
    const zeroers: { operatorId: string; stat: 'productivity' | 'order' }[] = [];
    const neutral = new Set<string>();
    const deferred: { operatorId: string; effect: Extract<SkillEffect, { kind: 'perOrderLimit' | 'perGoldLines' }> }[] = [];
    const stacked: { operatorId: string; effect: Extract<SkillEffect, { kind: 'perRoomStat' }> }[] = [];
    let raisedLimit = 0, extraLines = 0;
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
        if (candidates.some(effect => (effect.kind === 'perGroup' || effect.kind === 'remote' || effect.kind === 'ifGroupInRoom' || (effect.kind === 'moodNeutral' && !!effect.group)) && !knownGroups.has(effect.group!))) { result.unsupported.push({ operatorId, skill: skill.active }); skill.applied = []; continue; }
        // 陣營倍增換算成目前配置下的實際數值。
        skill.applied = candidates.map(effect => {
          // 心情條件：依目前心情決定是否生效或倍數。
          if (effect.kind === 'whenMood') return (moodOf(operatorId) > 12) === (effect.cond === 'high') ? effect.effect : null;
          if (effect.kind === 'perMoodDrop') { const count = Math.floor((maxMood(operatorId) - moodOf(operatorId)) / effect.per); return count && 'value' in effect.effect ? { ...effect.effect, value: round(effect.effect.value * count) } as SkillEffect : null; }
          if (effect.kind === 'scaleBy') {
            const levelOf = (type: FacilityType) => Math.max(0, ...base.facilities.filter(item => item.type === type).map(item => item.level));
            const source = { recruitSlots: base.recruitSlots ?? 0, powerPlants: base.facilities.filter(item => item.type === 'power').length, roomLevel: facility.level, dormLevels, tradingPosts: base.facilities.filter(item => item.type === 'trading').length, meetingLevel: levelOf('meeting'), trainingLevel: levelOf('training'), roomOccupants: assigned.length, productTypes: new Set(base.facilities.filter(item => item.type === 'manufacturing' && item.product && (base.assignments?.[item.id]?.length ?? 0) > 0).map(item => item.product)).size }[effect.by];
            const count = Math.floor(source / effect.per);
            if (!count || !('value' in effect.effect)) return null;
            const scaled = { ...effect.effect, value: round(Math.min(effect.max ?? Infinity, effect.effect.value * count)) } as SkillEffect;
            // 依其他設施數量／等級的加成不受「其他幹員加成歸零」影響；依同站人數的加成屬於技能持有者本人。
            if (effect.by !== 'roomOccupants' && effect.by !== 'recruitSlots') countBased.add(scaled);
            return scaled;
          }
          if (effect.kind === 'whenProduct') return facility.product === effect.product ? effect.effect : null;
          if (effect.kind === 'whenTraining') return (!effect.professions || (!!base.training?.profession && effect.professions.includes(base.training.profession))) && (!effect.atMastery || base.training?.mastery === effect.atMastery) ? effect.effect : null;
          if (effect.kind === 'ifPresent') {
            const pool = effect.where === 'base' ? assignedIn(() => true) : effect.where === 'work' ? assignedIn(item => item.type !== 'dormitory') : assignedIn(item => ROOM_OF[item.type] === effect.where);
            return pool.has(effect.name) && effect.name !== name ? effect.effect : null;
          }
          if (effect.kind === 'ifGroupInRoom') return assigned.some(id => id !== operatorId && groupsOf(id).includes(effect.group)) ? effect.effect : null;
          if (effect.kind === 'ramp') return { kind: effect.stat, value: elapsed === undefined ? rampAverage(effect) : rampValue(effect, elapsed) } as SkillEffect;
          if (effect.kind === 'perOtherWorking') return 'value' in effect.effect && assigned.length > 1 ? { ...effect.effect, value: round(effect.effect.value * (assigned.length - 1)) } as SkillEffect : null;
          return effect;
        }).filter((effect): effect is SkillEffect => !!effect).map(effect => {
          if (effect.kind !== 'perGroup' || !('value' in effect.per)) return effect;
          const count = effect.scope === 'room' ? assigned.filter(id => groupsOf(id).includes(effect.group)).length : Math.min(effect.max ?? Infinity, baseMembers(effect.group));
          return { ...effect.per, value: round(effect.per.value * count) } as SkillEffect;
        }).filter(effect => effect.kind !== 'perGroup' && productMatches(effect, facility));
        let applied = false;
        for (const effect of skill.applied) {
          applied = true;
          if (effect.kind === 'productivity') { result.totals.productivity += effect.value; contributions.push({ operatorId, stat: 'productivity', value: effect.value, countBased: countBased.has(effect) }); }
          else if (effect.kind === 'order') { result.totals.order += effect.value; contributions.push({ operatorId, stat: 'order', value: effect.value, countBased: countBased.has(effect) }); }
          else if (effect.kind === 'zeroOthers') zeroers.push({ operatorId, stat: effect.stat });
          else if (effect.kind === 'orderLimit') { result.totals.orderLimit += effect.value; if (effect.value > 0) raisedLimit += effect.value; }
          else if (effect.kind === 'moodNeutral') { for (const id of effect.scope === 'self' ? [operatorId] : assigned.filter(id => !effect.group || groupsOf(id).includes(effect.group))) neutral.add(id); }
          else if (effect.kind === 'goldLine') extraLines += effect.value;
          else if (effect.kind === 'perOrderLimit' || effect.kind === 'perGoldLines') deferred.push({ operatorId, effect });
          else if (effect.kind === 'perRoomStat') stacked.push({ operatorId, effect });
          else if (effect.kind === 'drone') result.totals.drone += effect.value;
          else if (effect.kind === 'moodRecoverAll') { result.allByOp[operatorId] = round((result.allByOp[operatorId] ?? 0) + effect.value); result.totals.moodRecoverAll = Math.max(result.totals.moodRecoverAll, result.allByOp[operatorId]); }
          else if (effect.kind === 'dormSingle') result.totals.dormSingle = Math.max(result.totals.dormSingle, effect.value);
          else if (effect.kind === 'moodCost') result.totals.moodCost.push(effect.value);
          else if (effect.kind === 'clue') { if (!effect.alone || assigned.length === 1) result.totals.clue += effect.value; }
          else if (effect.kind === 'contact') result.totals.contact += effect.perDormLevel ? effect.value * dormLevels : effect.value;
          else if (effect.kind === 'training') { if ((!effect.professions || (!!base.training?.profession && effect.professions.includes(base.training.profession))) && (!effect.atMastery || base.training?.mastery === effect.atMastery)) result.totals.training += effect.value; }
          else if (effect.kind === 'byproduct') { if (effect.category === 'any' || effect.category === base.workshop) result.totals.byproduct += effect.value; }
        }
        if (!applied && !(partner && !comboActive)) result.notApplicable.push({ operatorId, skill: skill.active });
        if (partner && !comboActive) result.comboMissing.push({ operatorId, skill: skill.active, partner });
      }
      result.operators.push({ operatorId, name, skills });
    }
    // 消除心情消耗的影響：受影響者的技能心情消耗調整不計。
    if (neutral.size) {
      for (const op of result.operators) if (neutral.has(op.operatorId)) for (const skill of op.skills) if (skill.applied) skill.applied = skill.applied.filter(effect => effect.kind !== 'moodCost');
      result.totals.moodCost = result.operators.flatMap(op => op.skills.flatMap(skill => (skill.applied ?? []).filter(effect => effect.kind === 'moodCost').map(effect => (effect as { value: number }).value)));
      result.issues.push(`${[...neutral].map(id => definitions.get(id)?.displayName ?? id).join('、')}的技能心情消耗調整被消除。`);
    }
    // 赤金生產線＝生產赤金的製造站數量＋技能提供的生產線（先算基礎線數，再算「每有 N 條額外提供」，最後算依線數的效率）。
    const goldLines = base.facilities.filter(item => item.type === 'manufacturing' && item.product === 'gold').length + extraLines;
    const addOrder = (operatorId: string, value: number) => { result.totals.order += value; contributions.push({ operatorId, stat: 'order', value, countBased: false }); };
    let bonusLines = 0;
    for (const { effect } of deferred) if (effect.kind === 'perGoldLines' && effect.effect.kind === 'goldLine') bonusLines += Math.floor(goldLines / effect.per) * effect.effect.value;
    for (const { operatorId, effect } of deferred) {
      if (effect.kind === 'perGoldLines' && effect.effect.kind === 'order') addOrder(operatorId, round(Math.floor((goldLines + bonusLines) / effect.per) * effect.effect.value));
      if (effect.kind === 'perOrderLimit') addOrder(operatorId, round(Math.min(effect.max ?? Infinity, Math.floor(raisedLimit / effect.per) * effect.value)));
    }
    if (deferred.some(item => item.effect.kind === 'perGoldLines')) result.issues.push(`赤金生產線 ${goldLines + bonusLines} 條（生產赤金的製造站 ${goldLines - extraLines} 座${extraLines + bonusLines ? `＋技能提供 ${extraLines + bonusLines} 條` : ''}；估計）。`);
    // 「每 N% 額外提供 M%」：以其他技能提供的加成計算（配合意識不含依設施數量的加成），彼此不疊算。
    const before = [...contributions];
    for (const { operatorId, effect } of stacked) {
      const pool = before.filter(item => item.stat === effect.stat && (!effect.others || (item.operatorId !== operatorId && !item.countBased))).reduce((sum, item) => sum + item.value, 0);
      const value = round(Math.min(effect.max, Math.floor(Math.max(0, pool) / effect.per) * effect.value));
      if (effect.stat === 'order') result.totals.order += value; else result.totals.productivity += value;
      contributions.push({ operatorId, stat: effect.stat, value, countBased: false });
    }
    // 其他幹員加成歸零：只保留歸零技能持有者本人的加成與依設施數量的加成（每名進駐幹員的基礎 1% 不受影響）。
    for (const zero of zeroers) {
      const kept = contributions.filter(item => item.stat === zero.stat && (item.operatorId === zero.operatorId || item.countBased)).reduce((sum, item) => sum + item.value, 0);
      if (zero.stat === 'productivity') result.totals.productivity = kept; else result.totals.order = kept;
      result.issues.push(`${definitions.get(zero.operatorId)?.displayName ?? zero.operatorId}使同站其他幹員的${zero.stat === 'productivity' ? '生產力' : '訂單效率'}加成歸零。`);
    }
    const basic = roomType === 'MANUFACTURE' ? catalog.basicSpeedPercent.MANUFACTURE : roomType === 'TRADING' ? catalog.basicSpeedPercent.TRADING : 0;
    result.totals.basic = round(basic * result.operators.length);
    result.totals.productivity = round(result.totals.productivity);
    result.totals.order = round(result.totals.order);
    result.totals.drone = round(result.totals.drone);
    return result;
  });
  // 基建資源：①加總所有產生來源（分心情高／低）②依序轉化 ③依數量或門檻套用加成（取高低兩情況的較低值，保守）。
  const dormFacilities = facilities.filter(result => result.facility.type === 'dormitory');
  const dormOccupants = dormFacilities.reduce((sum, result) => sum + result.operators.length, 0);
  const outsideDorm = facilities.filter(result => result.facility.type !== 'dormitory').flatMap(result => result.operators.map(op => op.operatorId));
  const facilityLevels = base.facilities.reduce((sum, facility) => sum + facility.level, 0);
  const pools = { high: new Map<string, number>(), low: new Map<string, number>() };
  const sources = new Map<string, string[]>();
  const add = (map: Map<string, number>, key: string, value: number) => map.set(key, (map.get(key) ?? 0) + value);
  for (const result of facilities) for (const op of result.operators) for (const skill of op.skills) for (const effect of skill.applied ?? []) {
    if (effect.kind !== 'resource') continue;
    const members = (list: string[]) => new Set(list.filter(id => groupsOf(id).includes(effect.group ?? '')).map(characterOf)).size;
    const raw = effect.source === 'flat' ? effect.amount
      : effect.source === 'perDormOccupant' ? effect.amount * dormOccupants
      : effect.source === 'perRoomOccupant' ? effect.amount * result.operators.length
      : effect.source === 'perRoomLevel' ? effect.amount * result.facility.level
      : effect.source === 'perFacilityLevel' ? effect.amount * facilityLevels
      : effect.source === 'perRecruitSlot' ? effect.amount * (base.recruitSlots ?? 0)
      : effect.source === 'perGroupInRoom' ? effect.amount * Math.min(effect.max ?? Infinity, members(result.operators.map(item => item.operatorId)))
      : effect.amount * Math.min(effect.max ?? Infinity, members(outsideDorm));
    // 陣營類的 max 為「最多幾名」（已在上面處理）；其他類的 max 為總量上限。
    const capped = effect.source === 'perGroupOutsideDorm' || effect.source === 'perGroupInRoom' ? raw : Math.min(raw, effect.max ?? Infinity);
    if (moods && effect.when) {
      // 模擬時依實際心情判斷，高低兩池相同。
      if ((moodOf(op.operatorId) > 12) === (effect.when === 'high')) { add(pools.high, effect.resource, capped); add(pools.low, effect.resource, capped); }
    } else {
      if (effect.when !== 'low') add(pools.high, effect.resource, capped);
      if (effect.when !== 'high') add(pools.low, effect.resource, capped);
    }
    sources.set(effect.resource, [...(sources.get(effect.resource) ?? []), `${op.name}「${skill.active!.name}」${effect.when === 'high' ? '（心情 > 12）' : effect.when === 'low' ? '（心情 ≤ 12）' : ''} +${capped}`]);
  }
  const conversions = facilities.flatMap(result => result.operators.flatMap(op => op.skills.flatMap(skill => (skill.applied ?? []).filter(effect => effect.kind === 'convert').map(effect => ({ effect: effect as Extract<SkillEffect, { kind: 'convert' }>, label: `${op.name}「${skill.active!.name}」` })))));
  for (let round2 = 0; round2 < 3; round2++) for (const { effect, label } of conversions) for (const pool of [pools.high, pools.low]) {
    const units = Math.floor((pool.get(effect.from) ?? 0) / effect.per);
    if (!units) continue;
    add(pool, effect.from, -units * effect.per); add(pool, effect.to, units);
    if (pool === pools.high && round2 === 0) sources.set(effect.to, [...(sources.get(effect.to) ?? []), `${label} 由${effect.from}轉化 +${units}`]);
  }
  const used = (resource: string) => Math.min(pools.high.get(resource) ?? 0, pools.low.get(resource) ?? 0);
  const addToTotals = (result: FacilityResult, effect: SkillEffect, operatorId?: string) => {
    if (!('value' in effect)) return;
    if (effect.kind === 'moodRecoverAll' && operatorId) { result.allByOp[operatorId] = round((result.allByOp[operatorId] ?? 0) + effect.value); result.totals.moodRecoverAll = Math.max(result.totals.moodRecoverAll, result.allByOp[operatorId]); return; }
    if (effect.kind === 'productivity' && productMatches(effect, result.facility)) result.totals.productivity = round(result.totals.productivity + effect.value);
    else if (effect.kind === 'order') result.totals.order = round(result.totals.order + effect.value);
    else if (effect.kind === 'clue') result.totals.clue = round(result.totals.clue + effect.value);
    else if (effect.kind === 'contact') result.totals.contact = round(result.totals.contact + effect.value);
    else if (effect.kind === 'training') result.totals.training = round(result.totals.training + effect.value);
    else if (effect.kind === 'byproduct') result.totals.byproduct = round(result.totals.byproduct + effect.value);
  };
  for (const result of facilities) for (const op of result.operators) for (const skill of op.skills) {
    const extra: SkillEffect[] = [];
    for (const effect of skill.applied ?? []) {
      if (effect.kind === 'resourceScale') {
        const count = Math.floor(used(effect.resource) / effect.per);
        if (!count || !('value' in effect.effect)) continue;
        const scaled = { ...effect.effect, value: round(effect.effect.value * count) } as SkillEffect;
        extra.push(scaled); addToTotals(result, scaled, op.operatorId);
        result.remote.push({ from: op.name, skill: skill.active!.name, text: `${effect.resource} ${used(effect.resource)} 點`, value: scalar(scaled), kind: scaled.kind === 'order' ? 'order' : 'productivity' });
      } else if (effect.kind === 'resourceThreshold' && used(effect.resource) >= effect.min) { extra.push(effect.effect); addToTotals(result, effect.effect, op.operatorId); }
    }
    if (extra.length) skill.applied = [...(skill.applied ?? []), ...extra];
  }
  const resourceList = [...new Set([...pools.high.keys(), ...pools.low.keys()])].filter(name => (sources.get(name) ?? []).length)
    .map(name => ({ name, high: round(pools.high.get(name) ?? 0), low: round(pools.low.get(name) ?? 0), used: round(used(name)), sources: sources.get(name) ?? [] }));
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
  // 控制中樞的全域加成：同種效果取最高者只取最大值，其餘相加。
  const globals = new Map<string, { max: number; sum: number; sources: string[] }>();
  for (const control of facilities.filter(result => result.facility.type === 'control')) for (const op of control.operators) for (const skill of op.skills) for (const effect of skill.applied ?? []) {
    if (effect.kind !== 'global') continue;
    const key = `${effect.target}:${effect.product ?? ''}`;
    const entry = globals.get(key) ?? { max: 0, sum: 0, sources: [] };
    if (effect.maxOnly) entry.max = Math.max(entry.max, effect.value); else entry.sum += effect.value;
    entry.sources.push(`${op.name}「${skill.active!.name}」`);
    globals.set(key, entry);
  }
  for (const [key, entry] of globals) {
    const [target, product] = key.split(':');
    for (const result of facilities.filter(item => ROOM_OF[item.facility.type] === target && (!product || item.facility.product === product))) {
      const value = round(entry.max + entry.sum);
      if (target === 'MANUFACTURE') result.totals.productivity = round(result.totals.productivity + value);
      else if (target === 'TRADING') result.totals.order = round(result.totals.order + value);
      else if (target === 'MEETING') result.totals.clue = round(result.totals.clue + value);
      else result.totals.contact = round(result.totals.contact + value);
      result.remote.push({ from: '控制中樞', skill: entry.sources.join('、'), text: '全域加成', value, kind: target === 'MANUFACTURE' ? 'productivity' : 'order' });
    }
  }
  for (const [roomType, count] of counts) {
    const room = rooms.get(roomType);
    if (room && room.maxCount && count > room.maxCount) issues.push(`${room.name}最多 ${room.maxCount} 座，目前設定 ${count} 座。`);
  }
  if (consumed > produced) issues.push(`電力不足：需要 ${consumed}，發電 ${produced}。`);
  return { facilities, electricity: { produced, consumed }, issues, resources: resourceList };
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
        for (const effect of parsed.effects) if (productMatches(effect, facility) && (effect.kind === 'productivity' || effect.kind === 'order' || effect.kind === 'drone' || effect.kind === 'moodRecoverAll' || effect.kind === 'moodRecoverSelf' || effect.kind === 'clue' || effect.kind === 'contact' || effect.kind === 'training' || effect.kind === 'byproduct')) score += effect.value;
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
        hoursToFull: round(Math.max(1, (params.limits[facility.level - 1] ?? params.limits[params.limits.length - 1]) + result.totals.orderLimit) / (ordersPerDay / 24)), notes: order.notes });
    }
    const base = catalog.mood.costPerHour[roomType]?.[facility.level - 1] ?? 0;
    if (base <= 0 || !result.operators.length) continue;
    let worst: ShiftStat | undefined;
    const roomMood = result.operators.reduce((sum, op) => sum + op.skills.reduce((inner, skill) => inner + (skill.applies ? (skill.applied ?? []).filter(effect => effect.kind === 'moodRoom').reduce((a, effect) => a + scalar(effect), 0) : 0), 0), 0);
    for (const op of result.operators) {
      const delta = op.skills.reduce((sum, skill) => sum + (skill.applies ? (skill.applied ?? []).filter(effect => effect.kind === 'moodCost').reduce((a, effect) => a + effect.value, 0) : 0), 0);
      const rate = Math.max(0.05, base + delta + roomMood);
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
export interface BaseObjective { total: number; manufacture: number; gold: number; record: number; trading: number; power: number; clue: number; contact: number; training: number; byproduct: number; goldFactor: number }
/** 各產出的權重（1 為標準）；整體效益＝赤金站生產力×gold＋記錄站生產力×record＋龍門幣提升×trading＋無人機×power。 */
export interface ObjectiveWeights { gold: number; record: number; trading: number; power: number; clue: number; contact: number; training: number; byproduct: number }
export const DEFAULT_WEIGHTS: ObjectiveWeights = { gold: 1, record: 1, trading: 1, power: 1, clue: 1, contact: 1, training: 1, byproduct: 1 };

export function baseObjective(evaluation: BaseEvaluation, catalog: BaseCatalog, weights: Partial<ObjectiveWeights> = DEFAULT_WEIGHTS): BaseObjective {
  const stats = baseStatistics(evaluation, catalog);
  const params = catalog.trading ?? DEFAULT_TRADING;
  let gold = 0, record = 0, power = 0, clue = 0, contact = 0, training = 0, byproduct = 0;
  for (const result of evaluation.facilities) {
    if (!result.operators.length) continue;
    if (result.facility.type === 'manufacturing') { const value = result.totals.basic + result.totals.productivity; if (result.facility.product === 'record') record += value; else gold += value; }
    if (result.facility.type === 'power') power += result.totals.drone;
    clue += result.totals.clue; contact += result.totals.contact; training += result.totals.training; byproduct += result.totals.byproduct;
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
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const total = round(gold * w.gold + record * w.record + trading * w.trading + power * w.power + clue * w.clue + contact * w.contact + training * w.training + byproduct * w.byproduct);
  return { total, manufacture: round(gold + record), gold: round(gold), record: round(record), trading: round(trading), power: round(power), clue: round(clue), contact: round(contact), training: round(training), byproduct: round(byproduct), goldFactor: round(goldFactor) };
}

export interface OptimizeResult { assignments: Record<string, string[]>; products: Record<string, 'gold' | 'record'>; moodFilled: string[]; objective: BaseObjective; start: BaseObjective; moves: number; evaluations: number; timedOut: boolean }

export function optimizeBase(base: Settings['base'], catalog: BaseCatalog, roster: readonly OwnedOperator[], definitions: ReadonlyMap<string, OperatorDefinition>, options: { timeBudgetMs?: number; start?: Record<string, string[]>; weights?: Partial<ObjectiveWeights> } = {}): OptimizeResult {
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
  // 控制中樞剩餘空位：以心情技能補滿（中樞全員恢復×人數＋自身消耗減少），不影響整體效益。
  const moodFilled: string[] = [];
  for (const facility of base.facilities.filter(item => item.type === 'control')) {
    const free = capacity(facility) - current[facility.id].length;
    if (free <= 0) continue;
    const used = usedCharacters(current);
    const benefit = (row: OwnedOperator) => (catalog.operators[row.operatorId] ?? []).reduce((sum, slot) => {
      const active = slotResult(slot, row, catalog).active;
      if (!active || active.roomType !== 'CONTROL') return sum;
      return sum + parseSkill(active).effects.reduce((inner, effect) => inner + (effect.kind === 'moodRoom' ? -effect.value * capacity(facility) : effect.kind === 'moodCost' ? -effect.value : 0), 0);
    }, 0);
    const picks = owned.filter(row => !used.has(characterOf(row.operatorId))).map(row => ({ id: row.operatorId, value: benefit(row) })).filter(item => item.value > 0).sort((a, b) => b.value - a.value);
    for (const pick of picks.slice(0, free)) { current[facility.id].push(pick.id); moodFilled.push(pick.id); }
  }
  return { assignments: current, products, moodFilled, objective: best, start: startObjective, moves, evaluations, timedOut };
}

/* ------------------------------------------------------------------ */
/* 布局比較：對每種常見布局各自跑整體最佳化，比較產出與整體效益。           */
/* ------------------------------------------------------------------ */
export interface LayoutTemplate { id: string; label: string; layout: [FacilityType, number, number, Facility['product']?][] }
const FUNCTION_ROOMS: LayoutTemplate['layout'] = [['meeting', 1, 3], ['office', 1, 3], ['training', 1, 3], ['workshop', 1, 3], ['dormitory', 4, 5]];
export const LAYOUTS: LayoutTemplate[] = [
  { id: '243', label: '243（貿易 2、製造 4、發電 3）', layout: [['control', 1, 5], ['trading', 2, 3], ['manufacturing', 2, 3, 'gold'], ['manufacturing', 2, 3, 'record'], ['power', 3, 3], ...FUNCTION_ROOMS] },
  { id: '153', label: '153（貿易 1、製造 5、發電 3）', layout: [['control', 1, 5], ['trading', 1, 3], ['manufacturing', 2, 3, 'gold'], ['manufacturing', 3, 3, 'record'], ['power', 3, 3], ...FUNCTION_ROOMS] },
  { id: '252', label: '252（貿易 2、製造 5、發電 2）', layout: [['control', 1, 5], ['trading', 2, 3], ['manufacturing', 2, 3, 'gold'], ['manufacturing', 3, 3, 'record'], ['power', 2, 3], ...FUNCTION_ROOMS] },
];
export function layoutFacilities(template: LayoutTemplate, idPrefix = template.id): Facility[] {
  return template.layout.flatMap(([type, count, level, product], group) => Array.from({ length: count }, (_, index) => ({ id: `${idPrefix}-${group}-${index}`, type, level, ...(product ? { product } : {}) })));
}

export interface LayoutComparison {
  template: LayoutTemplate; facilities: Facility[]; assignments: Record<string, string[]>;
  objective: BaseObjective; gold: number; exp: number; lmd: number; goldConsumed: number; electricity: { produced: number; consumed: number }; issues: string[];
}

export function compareLayout(template: LayoutTemplate, catalog: BaseCatalog, roster: readonly OwnedOperator[], definitions: ReadonlyMap<string, OperatorDefinition>, options: { weights?: Partial<ObjectiveWeights>; timeBudgetMs?: number } = {}): LayoutComparison {
  const facilities = layoutFacilities(template);
  const optimized = optimizeBase({ facilities, onlineSlots: [] }, catalog, roster, definitions, { weights: options.weights, timeBudgetMs: options.timeBudgetMs ?? 3000 });
  const finalFacilities = facilities.map(f => optimized.products[f.id] ? { ...f, product: optimized.products[f.id] } : f);
  const evaluation = evaluateBase({ facilities: finalFacilities, onlineSlots: [], assignments: optimized.assignments }, catalog, roster, definitions);
  const stats = baseStatistics(evaluation, catalog);
  return { template, facilities: finalFacilities, assignments: optimized.assignments, objective: optimized.objective, gold: stats.goldPerDay, exp: stats.expPerDay, lmd: stats.lmdPerDay, goldConsumed: stats.goldConsumedPerDay, electricity: evaluation.electricity, issues: evaluation.issues };
}

/* ------------------------------------------------------------------ */
/* 班次心情模擬：每 step 小時依目前心情重新評估產出，並依當下生效的技能     */
/* 更新心情（設施基礎消耗＋自身／同設施調整＋中樞對工作中幹員的恢復）。     */
/* 宿舍恢復＝基礎（資料表）＋0.0004×氛圍（PRTS）＋全宿舍恢復技能（取最高）。*/
/* ------------------------------------------------------------------ */
export interface ShiftSimulation {
  hours: number; step: number;
  /** 整班平均（換算成每日）與班次開始時（靜態）的比較。 */
  average: { goldPerDay: number; expPerDay: number; lmdPerDay: number };
  start: { goldPerDay: number; expPerDay: number; lmdPerDay: number };
  facilities: { facilityId: string; label: string; start: number; average: number; unit: string }[];
  zeroAt: { operatorId: string; name: string; label: string; hours: number }[];
  rest: { consumed: number; dormRate: number; restHours: number; available: number; feasible: boolean } | null;
}

export function simulateShift(base: Settings['base'], catalog: BaseCatalog, roster: readonly OwnedOperator[], definitions: ReadonlyMap<string, OperatorDefinition>, options: { hours: number; step?: number }): ShiftSimulation {
  const step = options.step ?? 0.5, hours = options.hours;
  const maxMood = (id: string) => catalog.mood?.maxByOperator?.[id] ?? catalog.mood?.max ?? 24;
  const working = base.facilities.filter(facility => facility.type !== 'dormitory');
  const moods: Record<string, number> = {};
  for (const facility of working) for (const id of base.assignments?.[facility.id] ?? []) moods[id] = maxMood(id);
  const valueOf = (result: FacilityResult): [number, string] => {
    const room = ROOM_OF[result.facility.type];
    if (room === 'MANUFACTURE') return [result.operators.length ? result.totals.basic + result.totals.productivity : 0, '生產力 %'];
    if (room === 'TRADING') return [result.operators.length ? result.totals.basic + result.totals.order : 0, '訂單效率 %'];
    if (room === 'POWER') return [result.totals.drone, '無人機 %'];
    if (room === 'MEETING') return [result.totals.clue, '線索 %'];
    if (room === 'HIRE') return [result.totals.contact, '聯絡 %'];
    if (room === 'TRAINING') return [result.totals.training, '訓練 %'];
    if (room === 'WORKSHOP') return [result.totals.byproduct, '副產品 %'];
    return [0, ''];
  };
  const sums = new Map<string, { start: number; total: number; unit: string; label: string }>();
  const totals = { goldPerDay: 0, expPerDay: 0, lmdPerDay: 0 };
  let start = { goldPerDay: 0, expPerDay: 0, lmdPerDay: 0 };
  const zeroAt = new Map<string, { label: string; hours: number }>();
  const steps = Math.max(1, Math.round(hours / step));
  const names = new Map(base.facilities.map((facility, index) => [facility.id, evaluateBase(base, catalog, [], definitions).facilities[index]?.label ?? facility.id]));
  for (let i = 0; i < steps; i++) {
    const evaluation = evaluateBase(base, catalog, roster, definitions, moods, i * step + step / 2);
    const stats = baseStatistics(evaluation, catalog);
    if (i === 0) start = { goldPerDay: stats.goldPerDay, expPerDay: stats.expPerDay, lmdPerDay: stats.lmdPerDay };
    totals.goldPerDay += stats.goldPerDay; totals.expPerDay += stats.expPerDay; totals.lmdPerDay += stats.lmdPerDay;
    for (const result of evaluation.facilities) {
      const [value, unit] = valueOf(result);
      if (!unit) continue;
      const entry = sums.get(result.facility.id) ?? { start: value, total: 0, unit, label: result.label };
      entry.total += value; sums.set(result.facility.id, entry);
    }
    // 中樞對其他設施工作中幹員的恢復：取單一幹員合計最強者（PRTS 註明有特殊比較規則，此處為估計）。
    const workingMood = Math.min(0, ...evaluation.facilities.filter(result => result.facility.type === 'control').flatMap(result => result.operators.map(op => op.skills.reduce((sum, skill) => sum + (skill.applied ?? []).filter(effect => effect.kind === 'workingMood').reduce((a, effect) => a + scalar(effect), 0), 0))));
    for (const result of evaluation.facilities) {
      if (result.facility.type === 'dormitory') continue;
      const baseCost = catalog.mood?.costPerHour[ROOM_OF[result.facility.type]]?.[result.facility.level - 1] ?? 0;
      const roomMood = result.operators.reduce((sum, op) => sum + op.skills.reduce((inner, skill) => inner + (skill.applied ?? []).filter(effect => effect.kind === 'moodRoom').reduce((a, effect) => a + scalar(effect), 0), 0), 0);
      for (const op of result.operators) {
        const self = op.skills.reduce((sum, skill) => sum + (skill.applied ?? []).filter(effect => effect.kind === 'moodCost').reduce((a, effect) => a + scalar(effect), 0), 0);
        const rate = baseCost + self + roomMood + (result.facility.type === 'control' ? 0 : workingMood);
        const next = Math.min(maxMood(op.operatorId), Math.max(0, moods[op.operatorId] - rate * step));
        if (next <= 0 && !zeroAt.has(op.operatorId)) zeroAt.set(op.operatorId, { label: result.label, hours: round((i + 1) * step) });
        moods[op.operatorId] = next;
      }
    }
  }
  const average = { goldPerDay: round(totals.goldPerDay / steps), expPerDay: Math.round(totals.expPerDay / steps), lmdPerDay: Math.round(totals.lmdPerDay / steps) };
  // 休息：本班消耗最多者在宿舍回滿所需時間，與輪替中可休息的時間比較。
  const dorms = base.facilities.filter(facility => facility.type === 'dormitory');
  const finalEval = evaluateBase(base, catalog, roster, definitions);
  // 中樞「所有宿舍」恢復，同種效果取最高。
  const globalDorm = Math.max(0, ...finalEval.facilities.filter(result => result.facility.type === 'control').flatMap(result => result.operators.flatMap(op => op.skills.flatMap(skill => (skill.applied ?? []).filter(effect => effect.kind === 'globalDorm').map(scalar)))));
  const dormRates = dorms.map(facility => {
    const result = finalEval.facilities.find(item => item.facility.id === facility.id);
    const atmosphere = Math.min(facility.atmosphere ?? facility.level * 1000, facility.level * 1000);
    // 最累的人安排在該宿舍，單人恢復技能也給他。
    return (catalog.mood?.dormRecover?.[facility.level - 1] ?? 0) + 0.0004 * atmosphere + (result?.totals.moodRecoverAll ?? 0) + (result?.totals.dormSingle ?? 0) + globalDorm;
  }).filter(rate => rate > 0);
  const consumed = Math.max(0, ...Object.entries(moods).map(([id, mood]) => maxMood(id) - mood));
  const dormRate = dormRates.length ? round(Math.max(...dormRates)) : 0;
  const shifts = Math.max(1, Math.round(24 / hours));
  const available = round(hours * Math.max(1, shifts - 1));
  const rest = dormRate > 0 ? { consumed: round(consumed), dormRate, restHours: round(consumed / dormRate), available, feasible: consumed / dormRate <= available } : null;
  return {
    hours, step, average, start,
    facilities: [...sums].map(([facilityId, entry]) => ({ facilityId, label: entry.label, start: round(entry.start), average: round(entry.total / steps), unit: entry.unit })),
    zeroAt: [...zeroAt].map(([operatorId, entry]) => ({ operatorId, name: definitions.get(operatorId)?.displayName ?? operatorId, ...entry })).sort((a, b) => a.hours - b.hours),
    rest,
  };
}
