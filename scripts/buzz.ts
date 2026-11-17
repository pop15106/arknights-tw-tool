// 最新討論熱度：到巴哈姆特與 B 站搜尋各集成戰略主題的最新文章，統計文中提到的幹員次數。
// 只讀公開搜尋結果頁的標題／摘要／標籤，不登入、不執行頁面腳本、不存文章內文。
// 「被提到」不等於「被推薦」，畫面上會清楚標示。
import type { BuzzData, BuzzMention, BuzzPost, BuzzTheme } from '../src/catalog/buzz.ts';

/** 各主題的搜尋關鍵字。巴哈用繁中標題搜尋，B 站用簡中關鍵字。 */
export const BUZZ_THEMES: Record<string, { bahamut: string; bilibili: string }> = {
  rogue_1: { bahamut: '傀影', bilibili: '傀影肉鸽' },
  rogue_2: { bahamut: '水月', bilibili: '水月肉鸽' },
  rogue_3: { bahamut: '薩米', bilibili: '萨米肉鸽' },
  rogue_4: { bahamut: '薩卡茲', bilibili: '萨卡兹肉鸽' },
  rogue_5: { bahamut: '界園', bilibili: '界园肉鸽' },
};
/** 同時是主題簡稱的幹員名稱：文章裡多半指主題（例如「打水月」），所有主題都不計。 */
export const THEME_NAME_OPERATORS = ['傀影', '水月'];

const decode = (text: string) => text.replace(/<[^>]*>/gu, '').replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/\s+/gu, ' ').trim();
const unescapeJs = (text: string) => text.replace(/\\u([0-9a-fA-F]{4})/gu, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/\\(["\\/])/gu, '$1');

/** 巴哈搜尋結果：每篇取標題、摘要、最新回覆時間與文章連結。 */
export function parseBahamut(html: string): (BuzzPost & { text: string })[] {
  const posts: (BuzzPost & { text: string })[] = [];
  for (const row of html.split('<tr class="b-list__row').slice(1)) {
    const sn = /C\.php\?bsn=33651&(?:amp;)?snA=(\d+)/u.exec(row)?.[1];
    const title = /class="b-list__main__title"[^>]*>([\s\S]*?)<\/p>/u.exec(row)?.[1];
    if (!sn || !title) continue;
    const brief = /class="b-list__brief"[^>]*>([\s\S]*?)<\/p>/u.exec(row)?.[1] ?? '';
    const time = /class="b-list__time__edittime"[\s\S]*?>([^<>]{4,20})<\/a>/u.exec(row)?.[1]?.trim();
    const cleanTitle = decode(title).slice(0, 120);
    posts.push({ source: 'bahamut', title: cleanTitle, url: `https://forum.gamer.com.tw/C.php?bsn=33651&snA=${sn}`, ...(time ? { date: `最新回覆 ${time}` } : {}), text: `${cleanTitle} ${decode(brief)}` });
  }
  return posts.slice(0, 30);
}

/** B 站搜尋頁：資料嵌在壓縮過的腳本裡，只擷取字面字串欄位（不執行腳本）。 */
export function parseBilibili(html: string): (BuzzPost & { text: string })[] {
  const posts: (BuzzPost & { text: string })[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/bvid:"(BV[0-9A-Za-z]{10})"([\s\S]{0,1500}?)pubdate:(\d{9,11})/gu)) {
    const [, bvid, body, pubdate] = match;
    if (seen.has(bvid)) continue;
    seen.add(bvid);
    const title = /title:"((?:[^"\\]|\\.){1,200})"/u.exec(body)?.[1];
    const description = /description:"((?:[^"\\]|\\.){0,400})"/u.exec(body)?.[1] ?? '';
    const tag = /tag:"((?:[^"\\]|\\.){0,300})"/u.exec(body)?.[1] ?? '';
    const cleanTitle = title ? decode(unescapeJs(title)).slice(0, 120) : '';
    const text = `${cleanTitle} ${unescapeJs(description)} ${unescapeJs(tag)}`;
    posts.push({ source: 'bilibili', title: cleanTitle || `（影片 ${bvid}，標題未能擷取）`, url: `https://www.bilibili.com/video/${bvid}`, date: new Date(Number(pubdate) * 1000).toISOString().slice(0, 10), text });
  }
  return posts.slice(0, 30);
}

/**
 * 統計提到次數。名稱只有一個字的幹員（例如「年」「令」）太容易誤判，不列入；
 * 與主題關鍵字相同的名稱（例如水月主題的「水月」）也不計。
 */
export function countMentions(posts: { text: string }[], names: ReadonlyMap<string, string>, exclude: readonly string[]): BuzzMention[] {
  const usable = [...names].filter(([name]) => name.length >= 2 && !exclude.includes(name)).sort((a, b) => b[0].length - a[0].length);
  const totals = new Map<string, { count: number; posts: number }>();
  for (const post of posts) {
    let text = post.text;
    const inPost = new Map<string, number>();
    for (const [name, operatorId] of usable) {
      const parts = text.split(name);
      if (parts.length < 2) continue;
      inPost.set(operatorId, (inPost.get(operatorId) ?? 0) + parts.length - 1);
      text = parts.join(' ');  // 長名稱先比對並移除，避免「斯卡蒂」又被算進「濁心斯卡蒂」之外
    }
    for (const [operatorId, count] of inPost) { const item = totals.get(operatorId) ?? { count: 0, posts: 0 }; item.count += count; item.posts++; totals.set(operatorId, item); }
  }
  return [...totals].map(([operatorId, item]) => ({ operatorId, ...item })).sort((a, b) => b.posts - a.posts || b.count - a.count).slice(0, 40);
}

export interface BuzzOptions { fetch?: typeof fetch; names: ReadonlyMap<string, string>; delayMs?: number; now?: () => Date }
export async function collectBuzz(options: BuzzOptions): Promise<BuzzData> {
  const fetchImpl = options.fetch ?? fetch;
  const delay = options.delayMs ?? 1200;
  const get = async (url: string) => {
    const response = await fetchImpl(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Mozilla/5.0 (local Arknights tool)', Accept: 'text/html', Referer: new URL(url).origin } });
    if (!response.ok) throw new Error(String(response.status));
    const text = await response.text();
    if (text.length > 3 * 1024 * 1024) throw new Error('too large');
    return text;
  };
  const themes: Record<string, BuzzTheme> = {};
  for (const [themeId, keywords] of Object.entries(BUZZ_THEMES)) {
    const errors: string[] = [];
    const collected: (BuzzPost & { text: string })[] = [];
    try { collected.push(...parseBahamut(await get(`https://forum.gamer.com.tw/B.php?bsn=33651&qt=1&q=${encodeURIComponent(keywords.bahamut)}`))); }
    catch { errors.push('巴哈姆特搜尋失敗'); }
    await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const posts = parseBilibili(await get(`https://search.bilibili.com/all?keyword=${encodeURIComponent(keywords.bilibili)}&order=pubdate`));
      if (!posts.length) errors.push('B 站沒有回傳可讀的搜尋結果（可能被要求驗證）');
      collected.push(...posts);
    } catch { errors.push('B 站搜尋失敗'); }
    await new Promise(resolve => setTimeout(resolve, delay));
    themes[themeId] = { posts: collected.map(({ text: _text, ...post }) => post), mentions: countMentions(collected, options.names, THEME_NAME_OPERATORS), errors };
  }
  return { fetchedAt: (options.now?.() ?? new Date()).toISOString(), themes };
}
