import { buildModules } from './modules.ts';
import { renderGameText } from './game-text.ts';
import { buildBaseCatalog, type BaseCatalog } from './base.ts';
import { buildGrowthCatalog, type GrowthCatalog } from './growth.ts';
import { buildEnemyCatalog, type EnemyCatalog } from './enemies.ts';
import { buildRecruitCatalog, type RecruitCatalog } from './recruit.ts';
export { renderGameText } from './game-text.ts';
import { sealDataset, type Dataset, type OperatorDefinition } from '../domain/model.ts';

// 上游資料只作欄位投影；不執行遊戲標記、HTML 或動態程式。
type Row = Record<string, any>;
export interface GameDataTables { characters: Row; patches: Row; skills: Row; modules: Row; stages: Row; activities: Row; battleEquip?: Row; items?: Row; favor?: Row; building?: Row; teams?: Row; constants?: Row; gacha?: Row; enemyHandbook?: Row; enemyDatabase?: Row }
export interface GameDataStatus {
  version: string; sourceUpdatedAt: string; syncedAt: string;
  counts: { operators: number; stages: number; events: number };
  sourceKind: 'public-mirror'; sourceUrl: string; lastError?: string; catalogRevision?: number; moduleSource?: { version: string; sourceUrl: string; sourceUpdatedAt: string };
}
export interface GameDataSnapshot { dataset: Dataset; stages: Row[]; events: Row[]; status: GameDataStatus; base?: BaseCatalog; growth?: GrowthCatalog; enemies?: EnemyCatalog; recruit?: RecruitCatalog }
export const DATA_REPO = 'arkntools/arknights-data-tw-for-maa';
export const CATALOG_REVISION = 14;
export const MODULE_DATA_REPO = 'ArknightsAssets/ArknightsGamedata';
export const MODULE_DATA_COMMIT = '624d3fa212dabc40bdbc2a873d87d0c7dbdf4fe5';
export const MODULE_DATA_DATE = '2026-11-02T09:23:25Z';
const PROFESSIONS: Record<string, string> = { PIONEER: '先鋒', WARRIOR: '近衛', SNIPER: '狙擊', TANK: '重裝', MEDIC: '醫療', SUPPORT: '輔助', CASTER: '術師', SPECIAL: '特種' };

function rows(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`遊戲資料缺少${label}。`);
  return value as Row;
}
function word(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`遊戲資料缺少${label}。`);
  return value;
}
function board(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return Object.fromEntries(value.map(x => [String(x.key).toLowerCase(), x.value]));
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k.toLowerCase(),v])) : {};
}
export async function buildGameData(tables: GameDataTables, source: { commit: string; sourceUpdatedAt: string; syncedAt: string }): Promise<GameDataSnapshot> {
  if (!/^[a-f0-9]{40}$/u.test(source.commit) || !Number.isFinite(Date.parse(source.sourceUpdatedAt)) || !Number.isFinite(Date.parse(source.syncedAt))) throw new Error('遊戲資料版本或時間無效。');
  const characters = { ...rows(tables.characters, '幹員表'), ...rows(tables.patches.patchChars, '轉職表') };
  const skills = rows(tables.skills, '技能表');
  rows(tables.modules.equipDict, '模組表');
  const branches = rows(tables.modules.subProfDict, '分支表');
  const operators: OperatorDefinition[] = Object.entries(characters)
    .filter(([id, char]) => id.startsWith('char_') && !char.isNotObtainable)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, char]) => {
      const rarity = Number(String(char.rarity).replace('TIER_', ''));
      if (!Number.isInteger(rarity) || rarity < 1 || rarity > 6) throw new Error('稀有度不支援。');
      const profession = PROFESSIONS[char.profession];
      if (!profession) throw new Error('幹員職業尚未支援。');
      const talents = (char.talents ?? []).flatMap((talent: Row) => (talent.candidates ?? []).filter((item: Row) => !item.isHideTalent && item.name && item.description).map((item: Row) => ({
        name: word(item.name, '天賦名稱'), description: renderGameText(item.description, item.blackboard),
        elite: Number(String(item.unlockCondition?.phase).replace('PHASE_', '')) as 0 | 1 | 2,
        level: item.unlockCondition?.level, potential: (item.requiredPotentialRank ?? 0) + 1,
      })));
      return {
        id, displayName: word(char.name, '幹員名稱'), aliases: char.appellation && char.appellation !== char.name ? [char.appellation] : [], rarity: rarity as OperatorDefinition['rarity'],
        profession, branch: word(branches[char.subProfessionId]?.subProfessionName, '職業分支'), faction: char.nationId ?? char.groupId ?? char.teamId ?? '未提供',
        availability: 'unknown', portrait: `/assets/operators/${id}.png`, talents,
        skills: (char.skills ?? []).filter((skill: Row) => skill.skillId).map((skill: Row) => {
          const entry = skills[skill.skillId];
          if (!entry?.levels?.length) throw new Error('找不到幹員對應的技能定義。');
          return { id: skill.skillId, name: word(entry.levels[0].name, '技能名稱'), levels: entry.levels.map((level: Row, index: number) => ({ level: index + 1, description: renderGameText(level.description, { duration: level.duration, ...board(level.blackboard) }) || '來源未提供技能說明。' })) };
        }),
        modules: buildModules(id, tables.modules, tables.battleEquip, tables.items, tables.favor),
      };
    });
  if (!operators.length) throw new Error('遊戲資料沒有可用幹員定義。');
  const dataset = await sealDataset({ metadata: { id: 'arknights-tw-public-catalog', version: source.commit, product: 'arknights', server: 'tw', namespace: 'personal', validFrom: source.sourceUpdatedAt, acquiredAt: source.syncedAt, source: tables.battleEquip ? '繁中公開鏡像 arkntools；模組效果 ArknightsAssets TW 固定版本；圖片官方 CDN；未經官方 API 授權' : '繁中遊戲資料公開鏡像 arkntools；圖片來自官方 CDN，未經官方 API 授權', licenseStatus: 'unknown' }, operators });
  const stages = Object.entries(rows(tables.stages.stages, '關卡表')).map(([id, row]) => ({ id, code: String(row.code ?? id), name: String(row.name ?? '未提供名稱'), ...(typeof row.levelId === 'string' && /^[A-Za-z0-9_/-]{1,120}$/u.test(row.levelId) && !row.levelId.includes('..') ? { levelId: row.levelId } : {}), type: String(row.stageType ?? ''), zoneId: String(row.zoneId ?? ''), apCost: typeof row.apCost === 'number' ? row.apCost : null, description: renderGameText(row.description, {}), dangerLevel: String(row.dangerLevel ?? ''), drops: (row.stageDropInfo?.displayDetailRewards ?? []).map((drop: Row) => ({ id: String(drop.id), type: String(drop.type), dropType: String(drop.dropType), occurrence: String(drop.occPercent ?? '') })) }));
  const events = Object.entries(rows(tables.activities.basicInfo, '活動表')).map(([id, row]) => ({ id, name: String(row.name ?? '未提供名稱'), type: String(row.type ?? ''), startTime: Number.isFinite(row.startTime) ? new Date(row.startTime * 1000).toISOString() : null, endTime: Number.isFinite(row.endTime) ? new Date(row.endTime * 1000).toISOString() : null, rewardEndTime: Number.isFinite(row.rewardEndTime) ? new Date(row.rewardEndTime * 1000).toISOString() : null, hasStage: row.hasStage === true, isRerun: row.isReplicate === true }));
  if (!stages.length || !events.length) throw new Error('關卡或活動資料為空，拒絕取代既有快取。');
  // 陣營名稱取自 handbook_team_table；轉職形態（如阿米婭）以 char_patch_table 對應回同一角色。
  const teamName = (code: unknown) => typeof code === 'string' ? tables.teams?.[code]?.powerName : undefined;
  const patchOwner = new Map<string, string>();
  for (const [owner, info] of Object.entries((tables.patches?.infos ?? {}) as Row)) for (const id of info?.tmplIds ?? []) patchOwner.set(id, info.default ?? owner);
  const operatorMeta = Object.fromEntries(operators.map(op => {
    const char = characters[op.id] ?? {};
    const ids = [char.nationId, char.groupId, char.teamId].filter((value): value is string => typeof value === 'string');
    return [op.id, { name: op.displayName, ids, groups: ids.map(teamName).filter((value): value is string => typeof value === 'string'), ...(char.isSpChar ? { alter: true } : {}), ...(patchOwner.get(op.id) ? { character: patchOwner.get(op.id) } : {}) }];
  }));
  const base = tables.building ? buildBaseCatalog(tables.building, operators.map(op => op.id), source.commit, `繁中公開鏡像 ${DATA_REPO} building_data.json`, tables.items, operatorMeta, tables.constants) : undefined;
  const dropItems = [...new Set(stages.flatMap(stage => stage.drops.filter((drop: Row) => drop.type === 'MATERIAL' || drop.type === 'CARD_EXP').map((drop: Row) => String(drop.id))))];
  const growth = buildGrowthCatalog(tables, operators.map(op => op.id), source.commit, `繁中公開鏡像 ${DATA_REPO} character_table／gamedata_const／item_table`, dropItems);
  const recruit = tables.gacha ? buildRecruitCatalog(tables.gacha, tables.characters) : undefined;
  const enemies = tables.enemyHandbook && tables.enemyDatabase ? buildEnemyCatalog(tables.enemyHandbook, tables.enemyDatabase) : undefined;
  return { dataset, stages, events, ...(base ? { base } : {}), ...(growth ? { growth } : {}), ...(enemies ? { enemies } : {}), ...(recruit ? { recruit } : {}), status: { catalogRevision: CATALOG_REVISION, ...(tables.battleEquip ? { moduleSource: { version: MODULE_DATA_COMMIT, sourceUrl: `https://github.com/${MODULE_DATA_REPO}/tree/${MODULE_DATA_COMMIT}/tw/gamedata/excel`, sourceUpdatedAt: MODULE_DATA_DATE } } : {}), version: source.commit, sourceUpdatedAt: source.sourceUpdatedAt, syncedAt: source.syncedAt, counts: { operators: operators.length, stages: stages.length, events: events.length }, sourceKind: 'public-mirror', sourceUrl: `https://github.com/${DATA_REPO}/tree/${source.commit}` } };
}
