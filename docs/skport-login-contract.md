# SKPORT 網頁登入與幹員資料契約查核

查核日期：2026-11-13（Asia/Taipei）。對象：《明日方舟》本作繁中服。本文是公開前端的靜態研究紀錄，不是第三方接入規格，也不是帳號同步驗收。

**目前可確認 SKPORT 網站使用 GRYPHLINE 帳號登入，並有取得 SKPORT 憑證、延續登入、更新請求簽章及登出的程式鏈。本次沒有確認掃碼登入，也沒有取得允許本工具使用的第三方應用註冊／授權契約。** 公開 game-tools 包含本作幹員欄位，但本次沒有繁中服真實帳號回應，不能據此啟用同步或宣稱完整匯入。

## 1. 查核方式與範圍

- 使用本次未登入的 [SKPORT 首頁](https://www.skport.com/) 與登入視窗；未輸入帳密、送出表單、要求驗證碼或建立 QR 登入工作階段。
- GET 官方公開 HTML、其明確引用的靜態 JavaScript，以及既有研究指定的 game-tools 資產。只分析文字，沒有執行下載程式、攜帶 Cookie／token 或呼叫下列帳號、角色、遊戲資料接口。
- 普通 sandbox 與網頁工具無法讀取部分 JS，經工具核准的唯讀網路執行取得 HTTP 200。環境 DNS 失敗沒有被解讀成來源下架。
- 原始靜態資產只放在已由 `.gitignore` 排除的 `.local/skport-research/`；報告保留官方網址、雜湊、符號與字元位置，不將整包程式納入產品。
- 以 `skport.com`、`gryphline.com` 限定搜尋第三方開發者、OAuth、API、QR 與繁中關鍵字；本輪結果未取得適用本工具的接入文件。這不代表官方永遠不提供。

## 2. 登入畫面：有帳號登入，未確認掃碼登入

本次 登入視窗截圖（本機截圖 `validation/skport-login.jpg`，未隨儲存庫提供） 顯示信箱、密碼、註冊、忘記密碼，以及 Google、Apple、Facebook 三個登入選項。後方 QR 所屬區塊標示「下載 SKPORT App」，不能當成登入 QR。

公開 [SDK 入口](https://web-api.gryphline.com/static/gl_web_sdk/sdk.entry.js) 設定也列出上述三個外部帳號提供者。它的橫幅標示 `GL-WEB-SDK@2.1.4`，入口會載入帳號 SDK 與 Web SDK，並有依公開灰度設定選版的邏輯；因此 fallback 版本不等於所有使用者實際載入版本。沒有讀取灰度身分或瀏覽器儲存狀態。

本次檢查的登入工具與帳號 SDK 沒有找到具體 `qrcode`／`qrCode` 登入程式或可驗證的掃碼登入契約；僅憑字串搜尋不能證明所有官方端點均無此能力。

## 3. 目前首頁可追溯的登入鏈

本次首頁 HTML 明確引用 [main.8046b722.js](https://static.skport.com/skport-fe-static/skport-bbs/main.8046b722.js)。runtime 引用 bootstrap 與 shared chunks；下列不是只沿用附件中的舊資產名稱。

| 層級 | 已確認的公開程式行為 | 定位 |
| --- | --- | --- |
| 網站入口 | bootstrap 將 `Login` 的接口前綴設定為 `web`；登入／登出事件會重新載入或跳轉頁面 | [bootstrap.d7c01a63.js](https://static.skport.com/skport-fe-static/skport-bbs/bootstrap.d7c01a63.js)，module `63647`，字元 29137 |
| 主機設定 | 社群 API 為 `zonai.skport.com`；帳號服務為 `as.gryphline.com`；SDK 入口在 `web-api.gryphline.com`，另有 `web-api.skport.com` OAuth 主機設定 | 同 bootstrap，module `78596`；SDK 入口亦列出帳號主機 |
| 應用識別 | SKPORT 分支的公開 `appCode` 為 `6eb76d4e13aa36e6`、`grantType` 為 `0`，`appSecret` 是空字串 | [9369.7342a6e5.js](https://static.skport.com/skport-fe-static/skport-bbs/9369.7342a6e5.js)，`getOAuthInfo`／字元 38449 |
| 帳號登入 | 呼叫 SDK `user.auth`，要求 OAuth 與第三方帳號資訊；成功後消費 `oauthInfo.code`。另有 `user.inheritSession` | [338.413f28c0.js](https://static.skport.com/skport-fe-static/skport-bbs/338.413f28c0.js)，字元 117932、118809 |
| 社群憑證 | `getCredByCode` 將 code 送往 `/web/v1/user/auth/generate_cred_by_code`，成功取回 `cred`；同檔另有不同用途的 U8 token 分支 | 同 one-tools，字元 321000 |
| 網站請求 | bootstrap 的 fetch 設定會在登入後帶 `cred`，並設定社群簽章主機與語言 | bootstrap，module `21046`，字元 5691 |

上述 appCode 是官方站台公開應用識別，不是可任意借用的第三方接入授權。外部帳號提供者支援也不表示本工具可在自己的網域重用 SKPORT 憑證交換。未取得本工具專用的 appCode、核准 callback/origin、可讀 scope、授權畫面或契約，不把這條內部鏈包裝成已可使用的「標準 OAuth 登入」。

## 4. 更新、登出與解除授權不能混為一談

| 行為 | 靜態證據 | 未驗證事項 |
| --- | --- | --- |
| 請求簽章更新 | [2613.26af9795.js](https://static.skport.com/skport-fe-static/skport-bbs/2613.26af9795.js) 在特定錯誤分支呼叫 `/web/v1/auth/refresh`，成功後更新 sign context token 並重送請求 | 不是已證實的第三方 OAuth refresh-token grant；未驗證有效期、頻率、重試副作用或實際錯誤 |
| SKPORT 登出 | one-tools 呼叫 `/web/v1/user/auth/logout`，並呼叫帳號 SDK logout；登入類別接著清理本機 cred | 未實測伺服器端失效、跨分頁／裝置效果，不能只靠本機清除判定撤銷完成 |
| 帳號 SDK 登出 | [帳號 SDK](https://web-static.hg-cdn.com/gl_account_web_sdk/gl-account-web-sdk.min.js) 定義帳號 logout；同包有 grant、grant-info 與 cancel-unbind-grant 方法 | 未取得正式外部整合文件或失效保證；`cancel_unbind_grant` 是取消解除流程的線索，不能當成撤銷接口 |
| SKPORT 註銷／解除 app grant | one-tools 的 unregister 流程可見社群 `unregistration/precheck`，以及帳號 `can_unbind_grant`、`request_unbind_grant`；流程含驗證與確認畫面 | 這是帳號註銷流程中的動作，不能當作本工具一般「解除連結」按鈕；未執行任何一步 |

目前可描述程式有這些分支，但拒絕、取消、到期、重登、撤銷後存取與多人／多角色隔離都仍是未測項。研究或合成資料轉換不會觸發上述分支。

## 5. 本作與繁中服的證據邊界

指定 [game-tools 資產](https://assets.skport.com/_static_assets/game-tools/entry_index-CHOzYceS.js) 本次可讀且與前輪 hash 相同。它明確區分 `ak → arknights` 與 `ef → endfield`。但沒有追到目前遊戲工具頁 HTML 實際載入這個檔案，因此此包的帳號資料形狀仍是「指定公開資產靜態線索」，不能升級為現行繁中帳號介面驗證。

它的 binding 函式消費 `/api/v1/game/player/binding` 回應，以 `appCode` 建表，從 `bindingList` 選擇指定、預設或官方角色；本作資料分支使用所選 `uid`。僅憑社群頁面顯示「明日方舟」、中文介面、共用登入或 `isOfficial`，都不能確認該角色就是本作繁中服。不得把《終末地》的 serverId／roleId 契約套到本作。

[繁中服代理商變更公告](https://ak.gryphline.com/news/7149) 說明營運轉移不涉及重新綁定或轉移登入方式；公告沒有提供本工具的第三方資料授權，也不能證明舊程式庫或目前 SKPORT 回應完整性。

## 6. 離線 normalizer 可使用的最小形狀

本節服務本機研究轉換器；不是網路同步功能。`fetchAkGameData` 要求 `x-transformed: base64`。fetch 層可能先將 `data.content` 解碼並解析 JSON，之後函式才消費 `data.chars`。因此研究轉換器接受的是**已解碼、明確包裝的資料**，不能宣稱可直接接所有原始 HTTP 回應。

| 欄位來源 | 公開消費程式可證明 | 轉換時的限制 |
| --- | --- | --- |
| envelope | 成功分支判斷 `code === 0`，資料在 `data` | 只接受指定成功形狀；HTTP 200 不等於業務成功 |
| `data.chars[]` | 以 `charId` 建立幹員表 | 持有清單候選；沒有完整性／總數／分頁保證，固定標示 partial |
| `assistChars[]` | 另建助戰表，另有助戰呈現分支 | 不可代替 chars，不可覆蓋整庫事實 |
| scalar | 幹員分支消費 `level`、`evolvePhase`、`favorPercent`、`mainSkillLvl`、`potentialRank` | 欄位存在不等於數值範圍已獲官方 schema 證實；轉換器另依本工具已定義範圍檢查 |
| `skills[]` | 元素使用 `id`、`specializeLevel` | 必須對上既有技能穩定 ID；不能從技能順序猜 ID |
| `equip[]` | 元素至少使用 `id`，其他資料以 spread 傳到顯示物件 | 此處沒有充分證明 level／unlocked／available 語義，保持 unknown |
| 預設配備 | 使用 `defaultSkillId`、`defaultEquipId` | 只接受資料集中既有 ID；缺值、null、空字串不能擅自解讀為明確「無」 |
| 顯示資料 | `charInfoMap[id]` 使用名稱、稀有度、職業、分支；`equipmentInfoMap[id]` 使用名稱與圖示資訊 | 不從帳號回應建立正式資料包；稀有度編碼、翻譯與服別不能靠猜測 |

`potentialImgMap` 的索引為 0–5，但這不足以證明本工具 1–6 的潛能語義，因此本輪不自行加一。`gainTime`、造型、UID、信箱及帳號資訊不屬此工具本輪養成投影，輸出不保留。`charSkills`／`charEquips` 這兩個名稱在指定包中沒有找到；不能自行另造上游契約。

資料身份由呼叫方明確聲明 product=`arknights`、server=`tw`，該聲明是使用者提供的研究條件，**不是轉換器已驗證來源服別**。資料集、幹員、技能與模組使用本工具既有穩定 ID；缺欄、未知 ID、無法判定語義均回報或保留未知。測試使用合成 fixture，不含真實憑證或帳號樣本。

## 7. 證據索引與本輪可交付邊界

字元位置是 UTF-8 解碼後字串的零起算位置，配合完整 hash 定位；它不是 minified 檔案的行號。以下 hash 是本輪保存的 UTF-8 文字檔案位元組；不把檔名中的短 hash 當作內容雜湊。取回時間列 UTC。

| 本機證據檔（`.local/skport-research/`） | 取回時間／狀態 | 大小 bytes | SHA-256 |
| --- | --- | ---: | --- |
| `skport-home.html` | 2026-11-13；公開首頁 | 3,160 | `81ea6544f1655d2c2df5fba5fb93dc5ba3cb19f05b21144571365d3ed5a5c0e7` |
| `skport-main.js` | 05:13:23Z／200 | 16,572 | `9a48bd434b286a7e31540370a3b09f5f6b7d3934e088ce617c4a31f193d5c453` |
| `skport-bootstrap.js` | 05:14:33Z／200 | 42,161 | `0646c4c3ba330b7aeb5d1a772c6169c1039a7f68e7483789c65bbf745038119d` |
| `skport-one-tools.js` | 05:17:21Z／200 | 493,855 | `2cf9905687a969946d313aae0dc90d27b3ba8f5c05c7a364f310208b1657daf1` |
| `skport-one-utils.js` | 05:17:21Z／200 | 133,212 | `0fbb8766a900e8201ca427a25a7ac53dfb6fc6cdb3fe6080dcd2a4a49bba1128` |
| `skport-one-fetch.js` | 05:17:21Z／200 | 115,289 | `0fffd670279fcad504fb34c71a669e801f13d0ca5aab8679c805ff682af9c287` |
| `gryphline-sdk-entry.js` | 05:13:23Z／200 | 9,157 | `c227ce42b7a1d886676ff25c0bfde278888ca1a66ebe68ae1e6f0037520624c3` |
| `gl-account-sdk.js` | 05:14:34Z／200 | 153,754 | `3c731e234dd69e9516cd54951aaa752ed7f96e3fbe2707009008318a34c820fa` |
| `game-tools-entry.js` | 2026-11-13；指定資產本輪重讀 | 2,104,473 | `5febaf3d398ec1c47f669c9ef1d09bcdc244604bd30147180a333b6655b57705` |

其他取得的 boot／shared／Web SDK 檔案只用於確認依賴，完整 URL 與 hash 另列本機 `manifest.json`。本輪沒有輸出帳號 HTTP 回應、瀏覽器 storage、Cookie、授權 code、cred 或 token。

本輪完成的是公開登入鏈與最小資料投影的研究。要啟用帳號同步，仍需本工具可用的官方接入權限、明確角色／服別契約，以及使用者自行登入後的授權、拒絕、到期、撤銷與資料核對測試。當前可交付本機離線研究轉換器與合成測試；不能把它稱為掃碼登入、官方授權完成或真實大量匯入通過。
