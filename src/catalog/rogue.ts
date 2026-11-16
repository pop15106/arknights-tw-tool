// 集成戰略：主題、關卡（含首領／精英標記）與藏品，取自 roguelike_topic_table；關卡內容另從關卡檔彙整。
import type { EnemyCatalog } from './enemies.ts';
import { parseLevelEnemies } from './enemies.ts';
type Row = Record<string, any>;

export interface RogueStage { id: string; code: string; name: string; levelId: string; boss: boolean; elite: boolean }
export interface RogueRelic { id: string; name: string; usage: string; rarity: string }
export type ModeKind = 'roguelike' | 'security' | 'reclamation';
export interface RogueTheme { id: string; name: string; mode?: ModeKind; stages: RogueStage[]; relics: RogueRelic[] }
export const MODE_THEME_ID = /^(?:rogue_\d{1,2}|tower_[a-z]{1,3}_\d{1,3}|sandbox_\d{1,2})$/u;

const plain = (text: unknown) => typeof text === 'string' ? text.replace(/<[@$][^>]*>|<\/>/gu, '').trim() : '';

export function buildRogueThemes(table: unknown): RogueTheme[] | undefined {
  const data = table as Row | undefined;
  if (!data?.topics || !data?.details) return undefined;
  const themes: RogueTheme[] = [];
  for (const [id, topic] of Object.entries(data.topics as Row)) {
    const detail = (data.details as Row)[id] as Row | undefined;
    if (!detail || !/^rogue_\d+$/u.test(id)) continue;
    const seen = new Set<string>();
    const stages = Object.values((detail.stages ?? {}) as Row).filter((stage: Row) => typeof stage?.levelId === 'string' && /^[A-Za-z0-9_/-]{1,120}$/u.test(stage.levelId) && !stage.levelId.includes('..'))
      .filter((stage: Row) => { const key = String(stage.levelId).toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; })
      .map((stage: Row) => ({ id: String(stage.id), code: String(stage.code ?? ''), name: plain(stage.name), levelId: String(stage.levelId), boss: !!stage.isBoss, elite: !!stage.isElite }));
    const relics = Object.values((detail.items ?? {}) as Row).filter((item: Row) => item?.type === 'RELIC' && plain(item.usage))
      .map((item: Row) => ({ id: String(item.id), name: plain(item.name), usage: plain(item.usage), rarity: String(item.rarity ?? '') }));
    themes.push({ id, name: plain(topic?.name) || id, mode: 'roguelike', stages, relics });
  }
  return themes.length ? themes.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })) : undefined;
}

const validLevel = (levelId: unknown): levelId is string => typeof levelId === 'string' && /^[A-Za-z0-9_/-]{1,120}$/u.test(levelId) && !levelId.includes('..');
/** 保全派駐：每座戰鬥塔（不含訓練場）一個主題；一般與高難關卡都納入；主卡／副卡（戰術裝備）視同藏品。 */
export function buildSecurityThemes(table: unknown): RogueTheme[] {
  const data = table as Row | undefined;
  const levels = (data?.levels ?? {}) as Row;
  const cards = [...Object.values((data?.mainCards ?? {}) as Row), ...Object.values((data?.subCards ?? {}) as Row)].map((card: Row) => ({ id: String(card.id), name: plain(card.name), usage: plain(card.desc).replace(/\n+/gu, ' '), rarity: String(card.type ?? '') })).filter(card => card.usage);
  return Object.values((data?.towers ?? {}) as Row).filter((tower: Row) => tower?.towerType !== 'TRAINING' && Array.isArray(tower?.levels)).map((tower: Row) => ({
    id: String(tower.id), name: plain(tower.name), mode: 'security' as const, relics: cards,
    stages: [...tower.levels, ...(Array.isArray(tower.hardLevels) ? tower.hardLevels : [])].map((id: string) => levels[id]).filter((level: Row) => validLevel(level?.levelId))
      .map((level: Row) => ({ id: String(level.id), code: String(level.code ?? ''), name: plain(level.name), levelId: String(level.levelId), boss: false, elite: false })),
  })).filter(theme => theme.stages.length && /^tower_[a-z]{1,3}_\d{1,3}$/u.test(theme.id));
}
/** 生息演算：每個主題一組，關卡檔路徑取自 sandbox_perm_table 內出現的 Obt/Sandbox/<主題>/ 路徑。 */
export function buildReclamationThemes(table: unknown): RogueTheme[] {
  const data = table as Row | undefined;
  const text = JSON.stringify(data?.detail ?? {});
  return Object.values((data?.basicInfo ?? {}) as Row).filter((info: Row) => /^sandbox_\d{1,2}$/u.test(String(info?.topicId))).map((info: Row) => {
    const id = String(info.topicId);
    const paths = [...new Set([...text.matchAll(new RegExp(`Obt/Sandbox/${id}/level_[A-Za-z0-9_-]+`, 'gu'))].map(match => match[0]))].filter(validLevel);
    return { id, name: plain(info.topicName) || id, mode: 'reclamation' as const, relics: [], stages: paths.map(levelId => ({ id: levelId.split('/').at(-1)!, code: levelId.split('/').at(-1)!.replace(/^level_/u, ''), name: '', levelId, boss: false, elite: false })) };
  }).filter(theme => theme.stages.length);
}

/* ------------------------------------------------------------------ */
/* 主題分析：彙整所有關卡的敵人（出現次數加權）、首領、可部署地塊與藏品對象。  */
/* ------------------------------------------------------------------ */
export const ROGUE_THRESHOLDS = { highDef: 800, highRes: 50 };
export interface RogueAnalysis {
  id: string; name: string; stageCount: number; analyzedStages: number;
  /** 敵人出現次數加權的比例（0～1）。 */
  enemy: { spawns: number; fly: number; highDef: number; highRes: number; magic: number; elite: number };
  topEnemies: { name: string; count: number; fly: boolean; def: number; res: number; magic: boolean }[];
  bosses: { name: string; stage: string; hp: number; atk: number; def: number; res: number; fly: boolean; magic: boolean; abilities: string[] }[];
  /** 可部署地塊：近戰（地面）與遠程（高台）格數。 */
  tiles: { melee: number; ranged: number; both: number };
  relics: RogueRelic[];
}

export function analyzeRogueTheme(theme: RogueTheme, levels: ReadonlyMap<string, unknown>, enemies: EnemyCatalog): RogueAnalysis {
  const totals = { spawns: 0, fly: 0, highDef: 0, highRes: 0, magic: 0, elite: 0 };
  const counts = new Map<string, number>();
  const bosses = new Map<string, RogueAnalysis['bosses'][number]>();
  const tiles = { melee: 0, ranged: 0, both: 0 };
  let analyzed = 0;
  for (const stage of theme.stages) {
    const level = levels.get(stage.levelId.toLowerCase());
    if (!level) continue;
    analyzed++;
    for (const tile of ((level as Row).mapData?.tiles ?? []) as Row[]) {
      if (tile?.buildableType === 'MELEE') tiles.melee++; else if (tile?.buildableType === 'RANGED') tiles.ranged++; else if (tile?.buildableType === 'ALL') tiles.both++;
    }
    for (const item of parseLevelEnemies(level)) {
      const info = enemies[item.id];
      if (!info || !item.count) continue;
      const stats = info.levels[item.level] ?? info.levels[0];
      totals.spawns += item.count;
      if (stats?.motion === 'FLY') totals.fly += item.count;
      if ((stats?.def ?? 0) >= ROGUE_THRESHOLDS.highDef) totals.highDef += item.count;
      if ((stats?.res ?? 0) >= ROGUE_THRESHOLDS.highRes) totals.highRes += item.count;
      if (info.damage.includes('MAGIC')) totals.magic += item.count;
      if (info.rank !== 'NORMAL') totals.elite += item.count;
      counts.set(item.id, (counts.get(item.id) ?? 0) + item.count);
      if (info.rank === 'BOSS' && stats && !bosses.has(info.name)) bosses.set(info.name, { name: info.name, stage: `${stage.code} ${stage.name}`, hp: stats.hp, atk: stats.atk, def: stats.def, res: stats.res, fly: stats.motion === 'FLY', magic: info.damage.includes('MAGIC'), abilities: info.abilities.slice(0, 4) });
    }
  }
  const share = (value: number) => totals.spawns ? Math.round(value / totals.spawns * 1000) / 1000 : 0;
  const topEnemies = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, count]) => { const info = enemies[id]!; const stats = info.levels[0]; return { name: info.name, count, fly: stats.motion === 'FLY', def: stats.def, res: stats.res, magic: info.damage.includes('MAGIC') }; });
  return { id: theme.id, name: theme.name, stageCount: theme.stages.length, analyzedStages: analyzed, enemy: { spawns: totals.spawns, fly: share(totals.fly), highDef: share(totals.highDef), highRes: share(totals.highRes), magic: share(totals.magic), elite: share(totals.elite) }, topEnemies, bosses: [...bosses.values()], tiles, relics: theme.relics };
}
