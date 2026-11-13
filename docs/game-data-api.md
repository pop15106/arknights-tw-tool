# 繁中遊戲資料 API 與 SKPORT 匯入

查核日期：2026-11-13。這是本工具的本機資料 API；上游採用繁中遊戲資料公開鏡像，**不是官方提供的第三方 API**。幹員圖片直接來自官方繁中 CDN。資料與圖片的公開可讀性不等於取得再散布授權，目前只在本機使用，資料包授權欄保留 `unknown`。

## 已完成的範圍

- SKPORT 研究 JSON 可直接選入主畫面，依穩定 ID 補上繁中名稱、職業、星級、技能各等級說明、天賦條件及圖片，再產生預覽。
- 固定資料版本收錄 417 個幹員／轉職形態、3,388 個關卡、286 筆活動定義。活動定義包含歷史項目；不能把筆數解讀為目前開放活動數量。
- 417 張幹員圖片均已下載並由 Pillow 驗證 PNG 可解碼，合計 57,387,521 bytes。技能共有 9,139 個等級說明，天賦共有 1,782 個條件版本；遊戲文字參數已解析成純文字，無未解析占位符。
- 真實 409 筆研究檔全部可對應；其中近衛／醫療阿米婭由轉職表補齊，模組按 `tmplId` 優先對應，沒有靠姓名猜測或混入另一形態。
- 未裝備欄位的空字串保留未知；潛能與模組狀態仍維持原研究邊界，不藉由補齊圖鑑推定個人養成數值。

## 來源與版本

| 內容 | 可追溯來源 |
| --- | --- |
| 繁中資料鏡像 | [arkntools/arknights-data-tw-for-maa 固定版本](https://github.com/arkntools/arknights-data-tw-for-maa/tree/b5516d9473240718126662387dff6e059c4f39ff) |
| 來源版本時間 | 2026-11-02 05:13:24 UTC |
| 資料表 | `character_table`、`char_patch_table`、`skill_table`、`uniequip_table`、`stage_table`、`activity_table` |
| 官方圖片規則 | [官方公開程式](https://static.skport.com/skport-fe-static/skport-bbs/338.413f28c0.js) 的 TW host 與 GameAssets URL builder |
| 官方圖片範例 | [阿米婭肖像](https://ak-tw.hg-cdn.com/arknights/game/assets/char/portrait/char_002_amiya.png) |

主來源的新版本以 Git commit 固定。模組效果／信賴表另使用固定繁中鏡像版本，分開記錄來源與版本，詳見 [模組與批次修正驗證](module-batch-verification.md)。未用簡轉繁代替繁中服名稱，也未把鏡像版本時間當作官方即時更新保證。資料包的 `availability` 保持未知，實際遊戲開放狀態另行核對。

## 啟動與同步

在專案根目錄分別啟動：

```powershell
npm run game-data
npm run dev
```

已建置時可使用 `npm run preview -- --port 5173`。資料服務只監聽 `127.0.0.1:5188`；Vite 開發／預覽服務將 `/api/game-data` 代理到該服務。修改 Vite 設定後需要重啟預覽服務。

到設定的「遊戲資料」按「更新遊戲資料」。這是明確呼叫的同步 API，尚未設置定時排程，也不會自動重新登入帳號或讀取個人幹員。首次同步需要下載公開資料表及圖片；之後在主版本、解析版本與模組補表版本皆相同時保留既有快取；解析版本變更會重新建立。

| 方法與路徑 | 回應 |
| --- | --- |
| `GET /api/game-data/status` | 來源種類、commit、來源時間、本機同步時間與三類筆數 |
| `GET /api/game-data/operators` | 版本化 `Dataset`，包含幹員、技能、天賦及圖片路徑 |
| `GET /api/game-data/stages?limit=20&offset=0&q=0-1` | `{items,total,offset,limit,version}`；關卡名稱、代碼、理智、區域與來源掉落分類 |
| `GET /api/game-data/events?limit=20&offset=0` | 同樣的分頁封裝；活動名稱、類型、起迄及獎勵結束時間 |
| `POST /api/game-data/sync` | 同步成功後的狀態；要求 `X-Game-Data-Sync: 1` 與本機頁面 Origin，不接受內容或任意上游 URL |

分頁 `limit` 為 1–1000，預設 100；`offset` 為非負安全整數，`q` 最多 100 字。未初始化時回 503，無效查詢回 400，同步來源失敗回 502。API 不開放跨站 CORS、不接受 Authorization，不讀取或轉送瀏覽器 Cookie。

## 更新與資料保護

同步只使用固定 GitHub repo 與官方圖片 host，拒絕 redirect，限制每份資料表 24 MiB、圖片 2 MiB、單次請求 45 秒，圖片並行數 4。所有資料表、定義檢查和圖片取得完成後，才以原子指標切換版本；失敗保留舊版本。快照以內容 SHA-256 命名及校驗，僅作毀損檢查，不是官方簽章。

- 快照與指標：`.local/game-data/`。
- 圖片：`public/assets/operators/`，已排除版本控制；建置時複製到 `dist/`。
- 同一服務中的並發同步共用工作，不重複下載。
- 帳號 JSON 只在瀏覽器轉換。查詢圖鑑 API 不傳送帳號檔案、UID 或養成數值。
- 同步不直接改個人庫。重新開啟幹員詳情會唯讀載入最新本機圖鑑供顯示；下次匯入可接受較新的同系列資料集；新定義必須能驗證既有幹員及完整批次歷史，否則拒絕升版。
- 撤銷還原幹員庫。純名稱變更可回到舊資料集；若保留的歷史引用新版新增 ID，保留新版定義以維持歷史可讀，不刪除歷史。

## 匯入操作與驗證

切到「個人庫」→「匯入幹員」→確認本作繁中服→選擇原研究 JSON。預覽不寫入；明確選擇批次採用新值後，仍須按「確認合併並保存」。批次採用不會把來源低信心改成人工已確認；既有不同值、人工確認值或重複矛盾仍需另外決定。可在候選清單檢視圖片、技能與天賦。

實際檔案預覽：新增 409 筆、3,489 個待接受來源欄位、3,210 個未知欄位。這些未知包含潛能與未驗證模組狀態，不是新發現的遊戲帳號缺漏。

隔離記憶體 IndexedDB 使用該 409 筆檔完成合併、關閉重開、備份往返、重複匯入去重及撤銷；人工確認數仍為 0，結果見 [驗證摘要](validation/catalog-real-fixture-check.json)。這不是 Safari／iPhone 真機保存驗收，也沒有替使用者提交瀏覽器個人庫。

同步階段的自動化測試與建置結果保存於 [測試紀錄](validation/catalog-tests.txt)、[建置紀錄](validation/catalog-build.txt)。瀏覽器已實測主入口同步按鈕與 409 筆預覽。初次建立 4173 分頁時曾被用戶端阻擋；後續使用者已匯入，並在 4173 完成幹員庫與隔離示範庫保存／復原驗收，詳見 [幹員庫驗證](roster-verification.md)。

仍待完成：逐欄與遊戲內數值對照、完整持有總數驗收、iPhone 實機、正式官方第三方 API 契約、定時排程及正式部署。關卡與活動目前提供 API，尚未新增專用瀏覽頁面。
