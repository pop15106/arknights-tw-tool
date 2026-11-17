// 敵人圖鑑（enemy_handbook_table）＋敵人資料庫（enemy_database）投影：名稱、等級、傷害類型、能力說明與各等級數值。
type Row = Record<string, any>;

export interface EnemyStats { hp: number; atk: number; def: number; res: number; motion: 'WALK' | 'FLY' }
export interface EnemyInfo {
  name: string;
  /** NORMAL＝一般、ELITE＝精英、BOSS＝領袖。 */
  rank: 'NORMAL' | 'ELITE' | 'BOSS';
  damage: string[];
  attackType?: string;
  abilities: string[];
  /** 依關卡指定的等級（enemyDbRefs.level）取用；後面的等級只覆寫有定義的欄位。 */
  levels: EnemyStats[];
}
export type EnemyCatalog = Record<string, EnemyInfo>;

const defined = (field: Row | undefined) => field && field.m_defined ? field.m_value : undefined;
const plain = (value: unknown) => typeof value === 'string' ? value.replace(/<[@$][^>]*>|<\/>/gu, '').trim() : '';

export function buildEnemyCatalog(handbook: unknown, database: unknown): EnemyCatalog | undefined {
  const data = (handbook as Row | undefined)?.enemyData as Row | undefined;
  if (!data || !database || typeof database !== 'object') return undefined;
  const db = database as Row;
  const out: EnemyCatalog = {};
  for (const [id, entries] of Object.entries(db)) {
    if (!/^enemy_[A-Za-z0-9_]+$/u.test(id) || !Array.isArray(entries) || !entries.length) continue;
    const handbookId = data[id] ? id : id.replace(/_\d+$/u, '');
    const book = data[handbookId] as Row | undefined;
    const levels: EnemyStats[] = [];
    let current: EnemyStats = { hp: 0, atk: 0, def: 0, res: 0, motion: 'WALK' };
    for (const entry of [...entries].sort((a: Row, b: Row) => (a.level ?? 0) - (b.level ?? 0))) {
      const enemy = entry?.enemyData as Row | undefined, attributes = enemy?.attributes as Row | undefined;
      current = {
        hp: Number(defined(attributes?.maxHp) ?? current.hp) || 0,
        atk: Number(defined(attributes?.atk) ?? current.atk) || 0,
        def: Number(defined(attributes?.def) ?? current.def) || 0,
        res: Number(defined(attributes?.magicResistance) ?? current.res) || 0,
        motion: (defined(enemy?.motion) ?? current.motion) === 'FLY' ? 'FLY' : 'WALK',
      };
      levels[Number(entry.level) || 0] = { ...current };
    }
    const name = plain(defined((entries[0] as Row)?.enemyData?.name)) || plain(book?.name) || id;
    out[id] = {
      name, rank: book?.enemyLevel === 'BOSS' ? 'BOSS' : book?.enemyLevel === 'ELITE' ? 'ELITE' : 'NORMAL',
      damage: Array.isArray(book?.damageType) ? book!.damageType.filter((item: unknown): item is string => typeof item === 'string') : [],
      ...(typeof book?.attackType === 'string' && book.attackType ? { attackType: plain(book.attackType) } : {}),
      abilities: Object.values((book?.abilityList ?? {}) as Row).map((item: Row) => plain(item?.text)).filter(Boolean),
      levels: Array.from({ length: levels.length }, (_, index) => levels[index] ?? levels[0]),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/** 從關卡檔取出敵人與出現次數：enemyDbRefs 給等級，waves 的 SPAWN 動作給數量。 */
export function parseLevelEnemies(level: unknown): { id: string; level: number; count: number }[] {
  const row = level as Row | undefined;
  const refs = new Map<string, number>((Array.isArray(row?.enemyDbRefs) ? row!.enemyDbRefs : []).filter((ref: Row) => typeof ref?.id === 'string').map((ref: Row) => [ref.id, Number(ref.level) || 0]));
  const counts = new Map<string, number>();
  for (const wave of Array.isArray(row?.waves) ? row!.waves : []) for (const fragment of Array.isArray(wave?.fragments) ? wave.fragments : []) for (const action of Array.isArray(fragment?.actions) ? fragment.actions : []) {
    if (action?.actionType !== 'SPAWN' || typeof action.key !== 'string' || !/^enemy_/u.test(action.key)) continue;
    counts.set(action.key, (counts.get(action.key) ?? 0) + (Number(action.count) || 0));
  }
  return [...counts].map(([id, count]) => ({ id, level: refs.get(id) ?? 0, count })).sort((a, b) => b.count - a.count);
}
