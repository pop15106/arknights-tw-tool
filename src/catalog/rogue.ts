// 集成戰略：主題、關卡（含首領／精英標記）與藏品，取自 roguelike_topic_table；關卡內容另從關卡檔彙整。
import type { EnemyCatalog } from './enemies.ts';
import { parseLevelEnemies } from './enemies.ts';
type Row = Record<string, any>;

export interface RogueStage { id: string; code: string; name: string; levelId: string; boss: boolean; elite: boolean }
export interface RogueRelic { id: string; name: string; usage: string; rarity: string }
export interface RogueTheme { id: string; name: string; stages: RogueStage[]; relics: RogueRelic[] }

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
    themes.push({ id, name: plain(topic?.name) || id, stages, relics });
  }
  return themes.length ? themes.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })) : undefined;
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
