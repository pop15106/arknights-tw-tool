# SKPORT 本機 CORS 代理

日期：2026-11-13。使用者在直接接入失敗後明確要求「就是繞過 cors」。本輪將官方 SDK 的 API host 指向本機限定路徑，由 Node 服務呼叫固定官方 HTTPS 端點。瀏覽器安全設定、TLS 驗證與官方帳號驗證均維持正常。

後續更新：使用者已在此頁登入並取得本作角色清單，截圖顯示接著停在 `roster` 回應解析；下方表格保留代理建置當時的驗證範圍。最新欄位診斷與獨立 audit log 見 [後續處理](skport-audit-log.md)。

## 資料流

```text
官方 SDK 表單（本機頁面）
  → http://127.0.0.1:5187/api/sdk/account/<限定路徑>
  → https://as.gryphline.com/<同一限定路徑>
  → 官方原始業務結果返回 SDK

SDK 的 cookie_store/account_token
  → /api/sdk/web/cookie_store/account_token
  → 本機 session 記憶體儲存（不連官方 cookie-store）

SDK 回傳 code → 原有 /api/login → SKPORT 角色與唯讀幹員流程
```

官方表單會將帳密及帳號 token 送到這台電腦的代理，短暫轉送後不落盤、不記錄。帳號 token 的本機儲存適配只保存真實登入結果，沒有產生假 token、角色或授權成功回應。工作階段 15 分鐘失效；清除、停止服務或到期都會銷毀代理記憶體並中止未完成請求。JavaScript 記憶體回收不等於可保證的硬體位元抹除。

## 限定契約

| 路徑 | 方法 | 輸入 |
| --- | --- | --- |
| `/account/user/auth/v1/token_by_email_password` | POST | `email,password,captcha?` |
| `/account/user/info/v1/basic` | GET | query `token` |
| `/account/user/oauth2/v2/grant` | POST | `token,appCode,type,captcha?`；appCode 與 type 固定為現有 SKPORT 流程 |
| `/web/cookie_store/account_token` | GET／POST／DELETE | GET 無內容；POST 僅 `content`；DELETE 無內容 |

前綴統一為 `/api/sdk`。不接受任意 URL、其他帳號、遊戲寫入、註冊、重設密碼、發送驗證信、帳號設定或條款更新端點。官方若要求額外步驟，回報未支援，不偽造成功。CAPTCHA 挑戰仍由官方元件與使用者處理。

公開保存 SDK 提供 `_GL_ACCOUNT_SDK_INIT_OPTIONS.devOptions.accountServerHost/webApiServerHost` 與 `hostConfig.*.setHost()`。初始化時使用這些設定，載入完成後再次確認 host；沒有改寫全域 `fetch` 或修改官方套件。SDK entry、公開資產與灰度設定仍從官方下載。

## 本機入口防護

- 只監聽 `127.0.0.1`，固定 Host；代理不開 CORS。
- 先經原有 CSRF 保護的 `/api/sdk-start` 明確啟用；代理路由不能自行建立 session。
- SDK 路由必須有有效 HttpOnly／SameSite=Strict session Cookie、`Sec-Fetch-Site: same-origin`、`Sec-Fetch-Dest: empty`；缺值直接拒絕。
- POST／DELETE 必須有精確本機 Origin，GET 若帶 Origin 亦必須匹配。SDK 沒有自訂 CSRF header hook，因此使用瀏覽器產生的 Fetch Metadata 保護這個分支；原有其他 API 仍要求 CSRF header。
- 固定上游、方法、欄位及標頭白名單，禁止重導向；不傳瀏覽器 Cookie／Origin／Referer，不向瀏覽器轉送上游 Cookie、Location 或 HTML。
- 請求、回應、等待時間與重試頻率受限。讀完請求與上游回覆後重新確認 session；過期、清除或重新開始後，晚到結果不得恢復舊連線。

這些條件防止其他網站利用本機代理，不能防護已能任意執行本機程式的攻擊者。代理只限個人本機研究，沒有公開部署。

## 驗證狀態

| 檢查 | 結果與證據 |
| --- | --- |
| 完整合成回歸 | 102／102 通過、無跳過；包含 13 項 proxy、10 項 server proxy、7 項 SDK 取消測試。[測試紀錄](validation/cors-tests.txt) |
| 型別與建置 | `npm run build` 通過 TypeScript 與 Vite；[建置紀錄](validation/cors-build.txt) |
| 官方 SDK 瀏覽器實測 | 本機頁可啟用代理、套用 SDK host 並開啟官方登入表單；取消後顯示未讀取幹員資料 |
| 載入期間清除 | 實際按登入後立刻清除，後端先失效、頁面重新載入，沒有再次開啟舊登入視窗；相同時序另有合成測試 |
| 無憑證上游探測 | 專用空 session 經代理送出刻意無效的測試 token，官方回 HTTP 400，說明 Token 未通過 base64 格式驗證；HTTP 400 與原本 JSON 可回到呼叫端。沒有使用真實帳密／token，診斷 session 已清除 |
| 真實帳號 | 本輪沒有重送使用者帳密；成功登入、授權、本作繁中角色與幹員 JSON 仍未驗證 |

無憑證探測最初發現官方 HTTP 400 JSON 只有 `message`，沒有數字 `status`；代理原先將其判成格式錯誤。依 SDK 的 HTTPError 處理補上非 2xx `message`／`msg` 契約並新增回歸後，已確認保留官方 400，不把錯誤改成成功。2xx 回應仍要求已查核的業務 `status`。

本次證明本機轉送路徑可與官方交換 HTTP 回應，且瀏覽器 SDK 初始化走同源路徑；不以這項結果替代真實帳號登入驗收。使用者可在 [本機頁面](http://127.0.0.1:5187/skport.html) 按「透過本機代理登入」繼續。介面現況見 畫面（本機截圖 `validation/skport-proxy-ready.png`，未隨儲存庫提供）。
