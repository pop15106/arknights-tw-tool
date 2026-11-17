// 新手導覽：由幹員 Q 版小人帶路介紹各功能。
// 小人動畫與語音是遊戲素材，不放進 repo：按「下載導覽素材」時才存到本機（public/assets/guide）。
export type GuideLang = 'voice' | 'voice_cn' | 'voice_kr' | 'voice_en';
export const GUIDE_LANGS: { id: GuideLang; label: string }[] = [
  { id: 'voice', label: '日文' }, { id: 'voice_cn', label: '中文' }, { id: 'voice_kr', label: '韓文' }, { id: 'voice_en', label: '英文' },
];

export interface GuideCast {
  charId: string; name: string;
  /** 對應的頁面（App 的導覽名稱）。 */
  page: string; feature: string;
  /** 本工具自己寫的介紹（不是遊戲台詞）。 */
  pitch: string; points: string[];
  /** 播放的遊戲語音（charword_table 的 voiceId）。 */
  voices: string[];
}

export const GUIDE_HOST = 'char_002_amiya';
export const GUIDE_CAST: GuideCast[] = [
  { charId: 'char_002_amiya', name: '阿米婭', page: '幹員庫', feature: '幹員庫', voices: ['CN_001', 'CN_002'],
    pitch: '先把你的幹員帶進來吧！之後所有計算都會用到這份名單。',
    points: ['匯入 SKPORT 研究資料或 MAA 幹員辨識結果，合併前會先預覽', '每個欄位都標示來源，不確定的值會保持「未知」', '點幹員可看圖鑑、選服裝、修正紀錄'] },
  { charId: 'char_311_mudrok', name: '泥岩', page: '基建', feature: '基建', voices: ['CN_001', 'CN_002'],
    pitch: '基建排班交給這裡，產量、心情、換班時間都幫你算好。',
    points: ['727 個基建技能全部解析計入，推薦配置與整體最佳化', '一圖流、赤金／經驗／龍門幣統計、心情曲線', '多班輪替可匯出 MAA 排班檔，換班時間可推播到 Telegram'] },
  { charId: 'char_4179_monstr', name: 'Mon3tr', page: '養成', feature: '養成', voices: ['CN_001', 'CN_002'],
    pitch: '想練誰、要多少材料和龍門幣，一次列清楚。',
    points: ['材料、龍門幣、經驗需求計算', '匯入 MAA 倉庫辨識結果，扣掉已有的材料', '理智規劃：用線性規劃算出最省理智的刷圖組合'] },
  { charId: 'char_103_angel', name: '能天使', page: '關卡', feature: '關卡', voices: ['CN_001', 'CN_002'],
    pitch: '活動什麼時候開、材料去哪刷，這裡都查得到。',
    points: ['台服活動時間表與掉落來源', '依陸服進度預估台服未來活動', '掉率參考企鵝物流（陸服數據）'] },
  { charId: 'char_1035_wisdel', name: '維什戴爾', page: '搭配', feature: '搭配', voices: ['CN_001', 'CN_002'],
    pitch: '誰跟誰搭、集成戰略帶誰，資料分析加上社群評價一起看。',
    points: ['幹員相性、編隊建議、依關卡推薦', '集成戰略／保全派駐／生息演算的模式分析', '巴哈姆特、B 站、PRTS 的社群評價與最新討論熱度'] },
  { charId: 'char_003_kalts', name: '凱爾希', page: '工具', feature: '工具與設定', voices: ['CN_001', 'CN_002'],
    pitch: '公招、專精、帳號體檢，還有資料備份，記得定期做。',
    points: ['公開招募標籤計算、專精規劃、帳號體檢', '「設定」可更新遊戲資料、同步立繪與備份', '所有資料只存在你的電腦，不需要登入任何帳號'] },
];

/** 導覽步驟（主持人阿米婭依序介紹）。 */
export const GUIDE_STEPS: { title: string; text: string; charId: string; page?: string }[] = [
  { title: '歡迎來到幹員檔案室', text: '這是給繁中服博士用的本機工具。我會帶你看一遍主要功能，隨時可以按「跳過」。', charId: 'char_002_amiya' },
  { title: '第一步：匯入幹員', text: '到「幹員庫」按右上角「匯入」，放入 SKPORT 研究資料或 MAA 辨識結果。合併前都會先讓你預覽。', charId: 'char_002_amiya', page: '幹員庫' },
  { title: '第二步：更新遊戲資料', text: '到「設定」按「更新遊戲資料」，再按「同步幹員立繪」，幹員卡就會顯示精二立繪。', charId: 'char_003_kalts', page: '設定' },
  { title: '第三步：排基建', text: '「基建」選好布局後按「產生推薦」或「整體最佳化」，權重可以依你重視的產出調整。', charId: 'char_311_mudrok', page: '基建' },
  { title: '第四步：規劃養成', text: '「養成」加入想練的幹員，就會算出材料缺口，還能幫你排刷圖計畫。', charId: 'char_4179_monstr', page: '養成' },
  { title: '第五步：看搭配與集成戰略', text: '「搭配 → 模式分析」可以看每個主題的敵人組成、社群推薦和最新討論。', charId: 'char_1035_wisdel', page: '搭配' },
  { title: '完成！', text: '記得定期到「設定」備份資料。想再看一次導覽，點左側的「導覽」就好。祝博士武運昌隆！', charId: 'char_002_amiya' },
];

export interface GuideLine { voiceId: string; title: string; text: string; file?: string }
export interface GuideManifest { lang: GuideLang; syncedAt: string; chibi: Record<string, string>; lines: Record<string, GuideLine[]> }

/** 本機檔名（只用預覽伺服器接受的字元）。 */
export const chibiFile = (charId: string) => `${charId}.webm`;
export const voiceFile = (charId: string, lang: GuideLang, voiceId: string) => `${charId}_${lang}_${voiceId.toLowerCase()}.mp3`;
