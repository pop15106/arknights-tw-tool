import type { EnemyCatalog, EnemyStats } from '../catalog/enemies.ts';
import type { OperatorInfo } from './squad.ts';
import type { DebuffLink } from './synergy.ts';

/* ------------------------------------------------------------------ */
/* 依關卡推薦：讀關卡敵人數值與特性，列出需要對應的威脅與可用的持有幹員。  */
/* 門檻（高防禦、高法抗、大量敵人）是本工具的判斷基準，畫面會列出實際數值。 */
/* ------------------------------------------------------------------ */
export const THRESHOLDS = { highDef: 800, highRes: 50, crowd: 30 };
export interface StageEnemy { id: string; level: number; count: number; name: string; rank: 'NORMAL' | 'ELITE' | 'BOSS'; damage: string[]; abilities: string[]; stats: EnemyStats }
export interface Threat { key: string; title: string; evidence: string; advice: string; candidates: { id: string; reason: string }[] }

export function stageEnemyList(raw: readonly { id: string; level: number; count: number }[], catalog: EnemyCatalog): StageEnemy[] {
  return raw.map(item => {
    const info = catalog[item.id];
    const stats = info?.levels[item.level] ?? info?.levels[0] ?? { hp: 0, atk: 0, def: 0, res: 0, motion: 'WALK' as const };
    return { ...item, name: info?.name ?? item.id, rank: info?.rank ?? 'NORMAL', damage: info?.damage ?? [], abilities: info?.abilities ?? [], stats };
  });
}

/** 關卡建議等級，例如「精英2 LV.1」→ { elite: 2, level: 1 }。 */
export function parseDangerLevel(text: string | undefined): { elite: number; level: number } | undefined {
  const m = text?.match(/精英\s*(\d)\s*LV\.?\s*(\d+)/u) ?? text?.match(/^LV\.?\s*(\d+)$/u);
  if (!m) return undefined;
  return m.length === 3 ? { elite: Number(m[1]), level: Number(m[2]) } : { elite: 0, level: Number(m[1]) };
}

export function analyzeStage(enemies: readonly StageEnemy[], infos: readonly OperatorInfo[], debuffs: readonly DebuffLink[], limit = 5): Threat[] {
  const owned = new Set(infos.map(info => info.id));
  const top = (filter: (info: OperatorInfo) => boolean, why: (info: OperatorInfo) => string) => infos.filter(filter).sort((a, b) => b.progress - a.progress).slice(0, limit).map(info => ({ id: info.id, reason: why(info) }));
  const progress = new Map(infos.map(info => [info.id, info.progress]));
  const debuffers = (statuses: string[]) => debuffs.filter(item => statuses.includes(item.status) && owned.has(item.providerId)).sort((a, b) => (progress.get(b.providerId) ?? 0) - (progress.get(a.providerId) ?? 0)).slice(0, limit).map(item => ({ id: item.providerId, reason: `${item.status}：${item.source.kind}「${item.source.name}」` }));
  const names = (list: readonly StageEnemy[], value: (enemy: StageEnemy) => string) => list.slice(0, 4).map(enemy => `${enemy.name}（${value(enemy)}）`).join('、') + (list.length > 4 ? ` 等 ${list.length} 種` : '');
  const threats: Threat[] = [];
  const fly = enemies.filter(enemy => enemy.stats.motion === 'FLY');
  if (fly.length) threats.push({ key: 'fly', title: '飛行敵人', evidence: names(fly, enemy => `${enemy.count} 隻`), advice: '地面近戰幹員打不到飛行單位，需要遠程輸出。',
    candidates: top(info => info.position === 'RANGED' && info.tags.includes('輸出'), info => `遠程輸出・${info.summary}`) });
  const highDef = enemies.filter(enemy => enemy.stats.def >= THRESHOLDS.highDef).sort((a, b) => b.stats.def - a.stats.def);
  if (highDef.length) threats.push({ key: 'def', title: '高防禦', evidence: names(highDef, enemy => `防禦 ${enemy.stats.def}`), advice: '物理傷害會被大幅減免，建議法術輸出，或搭配降低防禦／物理脆弱的幹員。',
    candidates: [...top(info => info.definition.profession === '術師' && info.tags.includes('輸出'), info => `術師輸出・${info.summary}`), ...debuffers(['防禦力降低', '物理脆弱'])] });
  const highRes = enemies.filter(enemy => enemy.stats.res >= THRESHOLDS.highRes).sort((a, b) => b.stats.res - a.stats.res);
  if (highRes.length) threats.push({ key: 'res', title: '高法術抗性', evidence: names(highRes, enemy => `法抗 ${enemy.stats.res}`), advice: '法術傷害會被大幅減免，建議物理輸出，或搭配降低法術抗性的幹員。',
    candidates: [...top(info => info.tags.includes('輸出') && info.definition.profession !== '術師', info => `${info.definition.profession}輸出・${info.summary}`), ...debuffers(['法術抗性降低'])] });
  const magic = enemies.filter(enemy => enemy.damage.includes('MAGIC'));
  if (magic.length) threats.push({ key: 'magic', title: '法術攻擊的敵人', evidence: names(magic, enemy => `${enemy.count} 隻`), advice: '法術傷害無視防禦，阻擋位容易被打穿，治療要跟得上。',
    candidates: top(info => info.tags.includes('治療'), info => `治療・${info.summary}`) });
  const total = enemies.reduce((sum, enemy) => sum + enemy.count, 0);
  if (total >= THRESHOLDS.crowd) threats.push({ key: 'crowd', title: '敵人數量多', evidence: `全關共 ${total} 隻`, advice: '帶群攻幹員清場，減輕阻擋位壓力。',
    candidates: top(info => info.tags.includes('群攻'), info => `群攻・${info.summary}`) });
  const boss = enemies.filter(enemy => enemy.rank === 'BOSS');
  if (boss.length) threats.push({ key: 'boss', title: '領袖級敵人', evidence: names(boss, enemy => `生命 ${enemy.stats.hp.toLocaleString('zh-TW')}`), advice: '血量高，需要爆發輸出集中處理。',
    candidates: top(info => info.tags.includes('爆發') || (info.tags.includes('輸出') && info.definition.rarity >= 6), info => `${info.tags.includes('爆發') ? '爆發' : '六星輸出'}・${info.summary}`) });
  const stealth = enemies.filter(enemy => enemy.abilities.some(text => /隱匿/u.test(text)));
  if (stealth.length) threats.push({ key: 'stealth', title: '隱匿敵人', evidence: names(stealth, enemy => enemy.abilities.find(text => /隱匿/u.test(text)) ?? ''), advice: '隱匿單位不會被一般遠程攻擊選為目標，需要阻擋它或能攻擊隱匿的手段（請看幹員說明）。', candidates: [] });
  // 同一幹員同時符合輸出與減益時合併理由。
  for (const threat of threats) {
    const merged = new Map<string, string[]>();
    for (const item of threat.candidates) merged.set(item.id, [...(merged.get(item.id) ?? []), item.reason]);
    threat.candidates = [...merged].map(([id, reasons]) => ({ id, reason: reasons.join('；') }));
  }
  return threats;
}
