// 社群評價（集成戰略）：整理自巴哈姆特、B 站、PRTS，每條都附出處。
// 資料檔放在 repo 的 data/community/rogue.json；「同步社群評價」會下載最新版，
// 所以這裡嚴格驗證：只接受已知來源的網址、限定欄位與長度，避免同步到不明內容。
export type CommunitySource = 'bahamut' | 'bilibili' | 'prts';
export type Stance = 'recommend' | 'situational' | 'avoid';
/** inferred：原文用暱稱或簡稱，幹員是整理時判讀的（未逐字出現在原文）。 */
export interface CommunityPick { source: CommunitySource; stance: Stance; reason: string; url: string; date?: string; author?: string; module?: boolean; inferred?: boolean }
export interface CommunityCounter { threat: string; needs: string; url: string }
export interface CommunityTheme { picks: Record<string, CommunityPick[]>; counters: CommunityCounter[]; notes?: string[] }
export interface CommunityData {
  format: 'arknights-community-picks'; version: 1; updatedAt: string;
  sources: { id: CommunitySource; name: string; note: string }[];
  themes: Record<string, CommunityTheme>;
}

const SOURCES: readonly CommunitySource[] = ['bahamut', 'bilibili', 'prts'];
const HOSTS = new Set(['forum.gamer.com.tw', 'www.bilibili.com', 'prts.wiki']);
export const COMMUNITY_SOURCE_LABEL: Record<CommunitySource, string> = { bahamut: '巴哈姆特', bilibili: 'B 站', prts: 'PRTS' };

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) throw new Error(`社群評價的${label}格式不正確。`);
  return value;
}
function link(value: unknown): string {
  const raw = text(value, 500, '出處網址');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('社群評價的出處網址無效。'); }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname)) throw new Error('社群評價只接受巴哈姆特、B 站、PRTS 的網址。');
  return url.href;
}

export function parseCommunity(value: unknown): CommunityData {
  if (!isObj(value) || value.format !== 'arknights-community-picks' || value.version !== 1) throw new Error('不是本工具的社群評價格式。');
  const updatedAt = text(value.updatedAt, 10, '更新日期');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(updatedAt)) throw new Error('社群評價的更新日期格式不正確。');
  if (!Array.isArray(value.sources) || !isObj(value.themes)) throw new Error('社群評價缺少必要欄位。');
  const sources = value.sources.map(item => {
    if (!isObj(item) || !SOURCES.includes(item.id as CommunitySource)) throw new Error('社群評價的來源不正確。');
    return { id: item.id as CommunitySource, name: text(item.name, 40, '來源名稱'), note: text(item.note, 300, '來源說明') };
  });
  const themes: Record<string, CommunityTheme> = {};
  for (const [themeId, theme] of Object.entries(value.themes)) {
    if (!/^rogue_\d{1,2}$/u.test(themeId) || !isObj(theme) || !isObj(theme.picks) || !Array.isArray(theme.counters)) throw new Error('社群評價的主題資料不正確。');
    const picks: Record<string, CommunityPick[]> = {};
    for (const [operatorId, list] of Object.entries(theme.picks)) {
      if (!/^char_[A-Za-z0-9_]{1,60}$/u.test(operatorId) || !Array.isArray(list) || list.length > 50) throw new Error('社群評價的幹員資料不正確。');
      picks[operatorId] = list.map(item => {
        if (!isObj(item) || !SOURCES.includes(item.source as CommunitySource) || !['recommend', 'situational', 'avoid'].includes(item.stance as string)) throw new Error('社群評價的評價項目不正確。');
        if (item.date !== undefined && (typeof item.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(item.date))) throw new Error('社群評價的日期格式不正確。');
        return { source: item.source as CommunitySource, stance: item.stance as Stance, reason: text(item.reason, 120, '理由'), url: link(item.url),
          ...(item.date ? { date: item.date as string } : {}), ...(item.author !== undefined ? { author: text(item.author, 60, '作者') } : {}), ...(item.module === true ? { module: true } : {}), ...(item.inferred === true ? { inferred: true } : {}) };
      });
    }
    const counters = theme.counters.slice(0, 100).map(item => {
      if (!isObj(item)) throw new Error('社群評價的應對資料不正確。');
      return { threat: text(item.threat, 120, '威脅'), needs: text(item.needs, 300, '應對'), url: link(item.url) };
    });
    const notes = Array.isArray(theme.notes) ? theme.notes.slice(0, 20).map(note => text(note, 300, '主題備註')) : undefined;
    themes[themeId] = { picks, counters, ...(notes ? { notes } : {}) };
  }
  return { format: 'arknights-community-picks', version: 1, updatedAt, sources, themes };
}

/** 依「推薦的來源數 → 推薦次數」排序一個主題的推薦幹員；同時列出有人說不推薦的情況。 */
export function rankCommunityPicks(theme: CommunityTheme | undefined): { operatorId: string; sources: CommunitySource[]; recommend: number; situational: number; avoid: number }[] {
  if (!theme) return [];
  return Object.entries(theme.picks).map(([operatorId, picks]) => ({
    operatorId,
    sources: [...new Set(picks.filter(pick => pick.stance !== 'avoid').map(pick => pick.source))],
    recommend: picks.filter(pick => pick.stance === 'recommend').length,
    situational: picks.filter(pick => pick.stance === 'situational').length,
    avoid: picks.filter(pick => pick.stance === 'avoid').length,
  })).filter(item => item.recommend + item.situational > 0)
    .sort((a, b) => b.sources.length - a.sources.length || b.recommend - a.recommend || b.situational - a.situational);
}

/** 發文超過兩年視為可能過時（遊戲改版、新幹員都會改變評價）。 */
export const isStale = (date: string | undefined, now = Date.now()) => !!date && now - Date.parse(`${date}T00:00:00Z`) > 730 * 86400_000;
