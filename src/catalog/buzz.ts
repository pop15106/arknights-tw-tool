// 最新討論熱度的資料型別與「列入推薦」規則（頁面與本機服務共用）。
export interface BuzzPost { source: 'bahamut' | 'bilibili'; title: string; url: string; date?: string }
export interface BuzzMention { operatorId: string; count: number; posts: number }
export interface BuzzTheme { posts: BuzzPost[]; mentions: BuzzMention[]; errors: string[] }
export interface BuzzData { fetchedAt: string; themes: Record<string, BuzzTheme> }
export type BuzzMode = 'off' | 'reference' | 'recommend';

/** 「列入推薦」模式：至少在 2 篇文章、共 3 次以上被提到的前 5 名。 */
export function buzzPicks(theme: BuzzTheme | undefined): BuzzMention[] {
  return (theme?.mentions ?? []).filter(item => item.posts >= 2 && item.count >= 3).slice(0, 5);
}
