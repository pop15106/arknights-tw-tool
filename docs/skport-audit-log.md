# SKPORT 本機 audit log 與解析診斷

日期：2026-11-13。依使用者要求增加獨立 audit log，定位並修正技能 ID 方括號驗證錯誤。15:25:07（Asia/Taipei）的真實重試已成功取得 409 筆幹員資料，頁面、audit 與下載 JSON 的數量一致。仍未對照遊戲內總數及逐欄數值，也未寫入個人庫。

## 輸出位置與使用

透過 `npm run skport` 啟動時，預設輸出到：

```text
.local/audit/skport-audit.jsonl
```

每行一筆 JSON，時間使用 UTC ISO 8601。即時觀察：

```powershell
Get-Content -LiteralPath '.local/audit/skport-audit.jsonl' -Tail 20 -Wait
```

每檔上限 1 MiB，保留目前檔與 `.1`、`.2` 兩份輪替檔；最舊一份在輪替時被取代。`.local/` 已列於 `.gitignore`，不由 HTTP 靜態服務提供。這是本機除錯紀錄，沒有簽章、防竄改或不可否認性保證。

## 記錄內容

| 欄位 | 意義 |
| --- | --- |
| `schemaVersion`、`timestamp` | 格式版本與 UTC 記錄時間 |
| `event` | 服務啟停、session 到期、API 請求完成 |
| `requestId` | 每次請求獨立 UUID；同時回傳 `X-Audit-Request-Id`，頁面錯誤顯示為追蹤碼 |
| `operation`、`method` | 固定白名單的操作名稱與 HTTP 方法；不保存原始網址與 query |
| `outcome`、`status`、`durationMs` | 成功／失敗／中斷、HTTP 狀態與耗時；499 表示本機未完成回應 |
| `code`、`stage` | 固定錯誤代碼與階段；不保存上游任意錯誤文字 |
| `diagnostic` | 已知欄位路徑、預期型別、實際型別；不包含實際欄位值 |
| `count` | 登入回傳角色數或讀取回傳幹員數；不包含角色或幹員明細 |

不保存帳密、授權碼、Token、Cookie、CSRF、session ID、UID、角色名稱、帳號信箱、請求 body、完整 headers、query 或原始回應。輸出採白名單投影，額外欄位不會落盤。`requestId` 只用於單筆操作，不是登入憑證。

檔案寫入失敗會在服務終端顯示固定錯誤，不回顯系統例外或秘密。HTTP 回應與磁碟寫入不是原子交易；程式崩潰、磁碟滿或權限異動時可能缺少紀錄。正常關閉會等待已排入的寫入，不能保證強制終止後的完整性。

## 解析修正與證據界線

- `content` 缺省、`null` 或空字串且存在合法 `chars` 時，允許驗證並使用 `chars`；其他 `content` 型別或無效 Base64／JSON 仍拒絕。
- 格式錯誤可顯示例如 `data.chars[0].favorPercent` 與 `number`；不把該值或其他原始回應放進訊息。
- 07:03:13 UTC 的真實重試已定位 `data.chars[0].skills[0].id` 不符合 identifier；當時診斷只記錄 `string`，尚不能由此判斷是否為空字串。空 `content` 修正不是已確認的本次根因。
- 07:10:26 UTC 再試仍在同一技能 ID 失敗，新增分類確認為非空字串；空技能 ID 的假設未成立，最終實作未保留略過技能列的行為。
- 公開 [API 原始樣本](https://github.com/ProbiusOfficial/Skland_API/blob/main/dump.json) 有 `skcom_atk_up[2]` 等共用技能 ID，原本英數、底線、點、連字號的驗證錯拒方括號。修正只允許技能 ID 與預設技能 ID 使用尾端 `[數字]`；幹員、模組及角色 ID 的規則不放寬。
- 已再用固定版本的 [skill_table.json](https://github.com/Kengxxiao/ArknightsGameData/blob/6f63c14e27b847ef74b53b00fe51fc322b3cd7ff/zh_CN/gamedata/excel/skill_table.json#L1787) 核對 `skcom_atk_up[3]`；同檔 L2 為 `skcom_charge_cost[1]`、L4301 為 `skcom_heal_up[3]`，JSON key 與內部 `skillId` 一致。這是公開遊戲資料鏡像，並非官方維護 API schema。
- 套用後端修正需重啟服務，記憶體中的登入會失效；重新登入後的幹員讀取才可驗證真實格式。
- 一併修正登入回應與清除連線的競態：輪換前的 Cookie 加原 CSRF，僅能撤銷同次登入的後繼工作階段，不能取得角色、幹員或重新登入。撤銷關聯最多保留 15 分鐘，且不超過原工作階段期限；一般舊 Cookie 仍無讀取權。

## 驗證

| 驗證 | 實際結果 |
| --- | --- |
| 完整合成回歸 | 130／130 通過、無跳過；[輸出](validation/audit-tests.txt) |
| TypeScript 與 Vite | `npm run build` 通過；[輸出](validation/audit-build.txt) |
| audit writer | 9 項測試涵蓋安全白名單、診斷原值剔除、並行順序、三檔輪替、IO 失敗與真 junction／hardlink 拒絕 |
| API 整合 | 追蹤碼與紀錄對應；合成登入、roster 502、清除與服務啟停不包含憑證值 |
| 清除競態 | 新增 6 項；原先「延遲 clear 必須保留新登入」的測試改為驗證撤銷同次登入，其他舊 Cookie 讀取拒絕測試維持通過 |
| 實際本機服務 | 已重啟並寫入 service_start、瀏覽器 `/api/session` 紀錄；更新後頁面（本機截圖 `validation/skport-audit-ready.png`，未隨儲存庫提供） |
| 真實幹員 JSON | 15:25:07（Asia/Taipei）HTTP 200，409 筆，耗時 1139 ms；頁面及下載檔均一致，409 個不重複幹員 ID |

測試中的登入與資料皆為合成值。日誌啟用前的失敗無法追溯補寫；重新操作才會有對應紀錄。

## 真實下載檔核對

- 原始研究檔私人保存，已確認與瀏覽器下載檔逐位元組一致；原檔、識別雜湊及截圖不隨儲存庫提供。
- 409 筆皆具有 level、evolvePhase、favorPercent、mainSkillLvl、potentialRank、skills、equip 欄位；欄位存在不代表遊戲語意或數值已逐項驗收。
- 實際回應中的技能 ID 包含尾端方括號數字格式，確認原驗證規則是本次解析失敗原因；不保留玩家逐筆樣本。
- 遞迴檢查研究封裝、幹員、技能與模組的欄位白名單通過，未包含 UID、角色名稱、帳密或憑證欄位。Audit 仍不記錄技能 ID 原值。
- 409 是不同幹員 ID 的資料筆數，可能包含不同形態；未宣稱等於遊戲介面顯示的持有總數。服別依回傳標籤及使用者確認，尚無獨立服別驗證。
