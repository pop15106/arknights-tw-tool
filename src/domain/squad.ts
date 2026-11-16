import type { GrowthCatalog } from '../catalog/growth.ts';
import type { OperatorDefinition, OwnedOperator } from './model.ts';
import { currentState } from './growth.ts';

/* ------------------------------------------------------------------ */
/* 編隊建議：依官方招募標籤分配職責，再依已知養成度挑人。不使用主觀強度。   */
/* ------------------------------------------------------------------ */
export interface RoleSlot { key: string; label: string; count: number; test: (info: OperatorInfo) => boolean }
export interface OperatorInfo { id: string; definition: OperatorDefinition; tags: string[]; position?: string; damage?: 'arts' | 'heal' | 'physical'; progress: number; summary: string; unknown: boolean }
export interface SquadPick { id: string; role: string; reason: string }
export interface SquadResult { picks: SquadPick[]; missing: { role: string; need: number; got: number }[] }

const has = (tag: string) => (info: OperatorInfo) => info.tags.includes(tag);
/** 預設模板：一般關卡 12 人。count 為最少人數；「彈性」補滿剩下的位置。 */
export const TEMPLATES: Record<string, { label: string; note: string; roles: RoleSlot[] }> = {
  general: { label: '一般關卡', note: '費用、阻擋、治療、遠程輸出與群攻各有人負責。', roles: [
    { key: 'cost', label: '費用回復', count: 2, test: has('費用回復') },
    { key: 'tank', label: '防護（阻擋）', count: 2, test: has('防護') },
    { key: 'heal', label: '治療', count: 2, test: has('治療') },
    { key: 'ranged', label: '遠程輸出', count: 2, test: info => info.tags.includes('輸出') && info.position === 'RANGED' },
    { key: 'aoe', label: '群攻', count: 1, test: has('群攻') },
    { key: 'control', label: '控場／減速', count: 1, test: info => info.tags.includes('控場') || info.tags.includes('減速') },
  ] },
  defensive: { label: '高壓防守', note: '多一名防護與治療，適合敵人強度高的關卡。', roles: [
    { key: 'cost', label: '費用回復', count: 2, test: has('費用回復') },
    { key: 'tank', label: '防護（阻擋）', count: 3, test: has('防護') },
    { key: 'heal', label: '治療', count: 3, test: has('治療') },
    { key: 'ranged', label: '遠程輸出', count: 2, test: info => info.tags.includes('輸出') && info.position === 'RANGED' },
    { key: 'control', label: '控場／減速', count: 1, test: info => info.tags.includes('控場') || info.tags.includes('減速') },
  ] },
  offensive: { label: '速攻輸出', note: '多帶輸出與爆發，壓縮防守位置。', roles: [
    { key: 'cost', label: '費用回復', count: 2, test: has('費用回復') },
    { key: 'tank', label: '防護（阻擋）', count: 1, test: has('防護') },
    { key: 'heal', label: '治療', count: 1, test: has('治療') },
    { key: 'ranged', label: '遠程輸出', count: 3, test: info => info.tags.includes('輸出') && info.position === 'RANGED' },
    { key: 'burst', label: '爆發', count: 2, test: has('爆發') },
    { key: 'aoe', label: '群攻', count: 1, test: has('群攻') },
  ] },
};

/** 養成度：只用幹員庫的已知欄位（精英、等級、技能、專精、模組）與星級。未知以最低值計並標示。 */
export function operatorInfo(definition: OperatorDefinition, row: OwnedOperator | undefined, catalog: GrowthCatalog): OperatorInfo {
  const { state, unknown } = currentState(row, definition);
  const masteries = Object.values(state.masteries).reduce((sum, value) => sum + value, 0);
  const modules = Object.values(state.modules).reduce((sum, value) => Math.max(sum, value), 0);
  const progress = definition.rarity * 20 + state.elite * 100 + state.level + state.skillLevel * 5 + masteries * 10 + modules * 15;
  const op = catalog.operators[definition.id];
  const summary = [`${definition.rarity}★`, `精${state.elite} ${state.level} 級`, `技能 ${state.skillLevel}`, masteries ? `專精合計 ${masteries}` : '', modules ? `模組 ${modules} 級` : ''].filter(Boolean).join('・');
  return { id: definition.id, definition, tags: op?.tags ?? [], ...(op?.position ? { position: op.position } : {}), ...(op?.damage ? { damage: op.damage } : {}), progress, summary, unknown: unknown.includes('精英階段') || unknown.includes('等級') };
}

/**
 * 先依職責缺口由「最難補」的職責開始挑（候選最少者優先），每位幹員只佔一個位置；
 * 同一職業最多 maxPerProfession 名；剩下位置以養成度補滿。locked 為使用者指定必帶。
 */
export function buildSquad(infos: readonly OperatorInfo[], roles: readonly RoleSlot[], options: { size?: number; locked?: readonly string[]; exclude?: ReadonlySet<string>; maxPerProfession?: number } = {}): SquadResult {
  const size = options.size ?? 12, maxPer = options.maxPerProfession ?? 4;
  const pool = infos.filter(info => !options.exclude?.has(info.id)).sort((a, b) => b.progress - a.progress || a.definition.displayName?.localeCompare(b.definition.displayName ?? '', 'zh-Hant') || a.id.localeCompare(b.id));
  const picks: SquadPick[] = [];
  const taken = new Set<string>(), perProfession = new Map<string, number>();
  const take = (info: OperatorInfo, role: string, reason: string) => { picks.push({ id: info.id, role, reason }); taken.add(info.id); perProfession.set(info.definition.profession, (perProfession.get(info.definition.profession) ?? 0) + 1); };
  const filled = new Map<string, number>();
  const order = [...roles].sort((a, b) => pool.filter(a.test).length - pool.filter(b.test).length);
  for (const id of options.locked ?? []) {
    const info = pool.find(item => item.id === id);
    if (!info || taken.has(id) || picks.length >= size) continue;
    const role = order.find(slot => slot.test(info) && (filled.get(slot.key) ?? 0) < slot.count);
    if (role) filled.set(role.key, (filled.get(role.key) ?? 0) + 1);
    take(info, role?.label ?? '指定', `你指定必帶・${info.summary}`);
  }
  for (const slot of order) {
    while ((filled.get(slot.key) ?? 0) < slot.count && picks.length < size) {
      const info = pool.find(item => !taken.has(item.id) && slot.test(item) && (perProfession.get(item.definition.profession) ?? 0) < maxPer);
      if (!info) break;
      filled.set(slot.key, (filled.get(slot.key) ?? 0) + 1);
      take(info, slot.label, `標籤「${info.tags.join('、')}」・${info.summary}`);
    }
  }
  for (const info of pool) {
    if (picks.length >= size) break;
    if (taken.has(info.id) || (perProfession.get(info.definition.profession) ?? 0) >= maxPer) continue;
    take(info, '彈性', `養成度最高的其餘幹員・${info.summary}`);
  }
  const missing = roles.map(slot => ({ role: slot.label, need: slot.count, got: filled.get(slot.key) ?? 0 })).filter(item => item.got < item.need);
  return { picks, missing };
}
