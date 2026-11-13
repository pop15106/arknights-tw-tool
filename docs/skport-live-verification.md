# SKPORT 非官方本機接入：實作與驗證

日期：2026-11-13（Asia/Taipei）。使用者已授權測試自己的帳號；不記錄帳密、授權碼、Cookie、cred、簽章 token 或完整帳號回應。

本文保留瀏覽器直接呼叫官方 API 的實測基線。使用者後續明確要求處理 CORS，新增本機代理的資料流與最新驗證見 [代理報告](skport-cors-proxy.md)；不能將下列直接接入失敗等同於代理已失敗，也不能以代理測試代替真實帳號驗收。

## 結果

已建立可操作的非官方本機研究頁與限定讀取後端。官方登入元件在本機頁正常顯示，但真實登入送出時顯示 `Failed to fetch`。**尚未收到 OAuth code，未完成 code 交換、角色清單或幹員讀取，沒有真實帳號 JSON。**

瀏覽器診斷只讀取警告／錯誤類型與不含參數的資產路徑；可見來自官方帳號 SDK 的 TypeError。後續無憑證 OPTIONS 檢查確認：對本次來源 `http://127.0.0.1:5187`，登入與 session 端點均未回傳 `Access-Control-Allow-Origin`，目前跨來源接入有明確阻礙。這與畫面錯誤一致，但沒有捕獲原本失敗請求，不能斷言原始失敗僅有這一個原因，也不能據此判定密碼錯誤、繁中不支援或所有 localhost 均被禁止。未攔截 SDK fetch、錄製請求 body、讀取隱藏憑證或繞過瀏覽器安全設定。

## 無憑證預檢診斷

執行時間：`2026-11-13T06:03:48.026Z`（臺灣時間 14:03）。依本輪保存的官方公開 `gl-account-sdk.js`，由 Node 發出三次 OPTIONS；`Origin` 如實填入本機頁面來源，不附 Cookie、Authorization、帳密、裝置識別值或 body，禁止跟隨重新導向。此檢查不會登入，也未實際執行下表所列 GET／POST。

| 端點 | 預檢的實際方法與標頭名稱 | HTTP | Allow-Origin | 其他 CORS 回應 |
| --- | --- | --- | --- | --- |
| `https://as.gryphline.com/user/auth/v1/token_by_email_password` | POST；`content-type,x-appcode,x-deviceid,x-devicemodel,x-devicetype,x-language,x-osver` | 204 | 缺少 | Allow-Methods、Allow-Headers、Allow-Credentials 均缺少 |
| `https://web-api.gryphline.com/cookie_store/account_token` | GET；`x-language` | 204 | 缺少 | Methods=`GET,POST,DELETE`；Headers=`x-language`；Credentials=`true` |
| 同上 | POST；`content-type,x-language` | 204 | 缺少 | Methods=`GET,POST,DELETE`；Headers=`content-type,x-language`；Credentials=`true` |

HTTP 204 只表示伺服器回應了 OPTIONS，不代表 CORS 通過。缺少 Allow-Origin 時，瀏覽器不能讓此頁完成相應的跨來源讀取。這是本次來源、端點與時間的證據，不是官方第三方接入政策聲明。後續依使用者要求，以本機限定代理改走伺服器請求；不偽造官方 Origin，也不停用瀏覽器安全功能。代理會短暫處理帳密，與本節原本的直接接入資料流不同。

## 已完成

- `scripts/skport-server.ts`：固定 loopback、Host／Origin／Fetch-Site 驗證、無 CORS 開放、CSRF、HttpOnly／SameSite=Strict Cookie、15 分鐘 TTL、登入後工作階段輪換、清除與限流。
- `scripts/skport-client.ts`：固定官方 HTTPS 路由、限次簽章更新、逾時與回應大小限制、禁止重新導向、只讀本次 binding 中的角色，僅回傳必要 chars 欄位。
- `src/skport/`、`skport.html`：官方 SDK 按需載入、明示非官方來源、角色確認、候選預覽與研究 JSON 下載。SDK 自身可能使用瀏覽器儲存；本工具不把憑證加入 localStorage、IndexedDB、檔案或備份。
- 清除時中止本機 client 的未完成請求；晚到的回覆不得恢復 session 或重新顯示資料。登入輪換使用新 session 物件，舊 Cookie／CSRF 已通過初驗但延遲傳 body 的請求仍會拒絕。
- 保留現有幹員庫與離線轉換器；新增頁面不把原始值自動升級為正式資料集、完整持有庫或已驗證服別。

## 驗證

| 檢查 | 實際結果 |
| --- | --- |
| `npm run build` | TypeScript 與 Vite 多頁建置通過 |
| `npm test` | 72／72 通過，無跳過；新增 12 項 client、7 項本機服務、5 項延遲 body 競速回歸 |
| 一般沙箱測試 | loopback 連線遭環境拒絕；使用工具允許的本機連線執行後通過。測試注入假 client，不連外部帳號 |
| Host 測試修正 | Node fetch 未按測試要求送出 hostile Host；改用 node:http 實際送出後確認回 403 |
| 本機頁 | 實際啟動 `127.0.0.1:5187`，頁面與 session bootstrap 正常 |
| 官方 SDK | 登入元件可載入；未自動沿用另一個官方站分頁的登入 |
| 真實登入 | 送出後顯示 `Failed to fetch`；已清空輸入欄位、取消視窗並清除本機連線，無資料讀取結果 |
| 無憑證 OPTIONS | 三次 HTTP 204 均缺少本機來源所需的 Allow-Origin；沒有重試帳密 |

清除後的頁面證據：畫面（本機截圖 `validation/skport-cleared.png`，未隨儲存庫提供）。此操作只清除本機工具的連線與結果，不等於官方帳號登出或撤銷授權。

專案尚未建立 Git repository，故不建立分支或 PR；本文件記錄本輪變更與驗證摘要。未新增套件、修改系統安全設定、正式部署或發送對外訊息。

## 待驗證

登入相容性、成功／拒絕授權、本作繁中角色、帳號資料形狀、與遊戲總數核對，以及 iPhone 真機。CAPTCHA 與新的條款畫面需由使用者處理；後續代理只轉送固定登入端點，不開放任意腳本來源或偽造官方 Origin。
