// 幹員服裝（台服 skin_table）。只收有服裝名稱的時裝；預設立繪依精英階段另外處理。
export interface OperatorSkin { id: string; name: string; group: string }
export type SkinCatalog = Record<string, OperatorSkin[]>;

/** 時裝 ID，例如 char_002_amiya@winter#1。 */
export const SKIN_ID = /^char_[A-Za-z0-9_]+@[A-Za-z0-9_]+#\d+\+?$/u;

/** 立繪檔名規則：時裝 ID 的 @ 換成 _（台服 484 套全部符合）；本機檔名再把 # 換成 -、+ 換成 p，只用預覽伺服器接受的字元。 */
export const skinPortraitId = (skinId: string) => skinId.replace('@', '_');
export const skinFileName = (skinId: string) => `${skinPortraitId(skinId).replace(/#/gu, '-').replace(/\+/gu, 'p')}.png`;

export function buildSkinCatalog(table: unknown): SkinCatalog {
  const skins = (table as { charSkins?: Record<string, { skinId?: unknown; charId?: unknown; displaySkin?: { skinName?: unknown; skinGroupName?: unknown } | null }> })?.charSkins ?? {};
  const result: SkinCatalog = {};
  for (const skin of Object.values(skins)) {
    const name = skin.displaySkin?.skinName;
    if (typeof skin.skinId !== 'string' || !SKIN_ID.test(skin.skinId) || typeof name !== 'string' || !name.trim()) continue;
    // 依時裝 ID 前段分組：阿米婭的近衛／醫療形態在 skin_table 共用 charId，但時裝屬於各自的形態。
    const owner = skin.skinId.slice(0, skin.skinId.indexOf('@'));
    (result[owner] ??= []).push({ id: skin.skinId, name: name.trim(), group: typeof skin.displaySkin?.skinGroupName === 'string' ? skin.displaySkin.skinGroupName : '' });
  }
  return result;
}
