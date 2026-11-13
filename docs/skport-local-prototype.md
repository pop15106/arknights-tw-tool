# SKPORT 僅本機非官方原型：公開 SDK 契約

查核日期：2026-11-13。本文是實作前研究部分，沒有進行帳號登入、讀取瀏覽器 Cookie／token、交換憑證或請求玩家資料。

使用者已允許並行研究正式接入與僅本機非官方串接。**在 localhost 重用官方公開 SDK，仍屬非官方整合。**「SDK 來自官方」與「官方已支援本工具」是兩件需要分別證明的事。目前沒有本工具專用的正式 client、scope 或 callback 契約；正式路線可繼續詢問官方，而非官方本機研究可按以下已查到的介面進行，不以正式接入尚未取得而停止全部研究。

## 1. 已確認可供原型嘗試的 SDK API

[目前 SKPORT SDK adapter](https://static.skport.com/skport-fe-static/skport-bbs/175.3102bcf3.js) 的 `getSDKReadyFunc` 實際做法是先寫入初始化選項，再載入 script，等待 callback queue，最後取得全域 SDK。不是呼叫 `new SDK()` 或 `SDK.init()`。

| 項目 | 公開程式中的名稱／形狀 |
| --- | --- |
| 入口 URL | `https://web-api.gryphline.com/static/gl_web_sdk/sdk.entry.js` |
| 載入前選項 | `window._GL_WEB_SDK_INIT_OPTIONS`；繁中 `language: 'zh-tw'` |
| 載入完成佇列 | `window._GL_WEB_SDK_CALLBACK_QUEUE`，元素為無參數函式 |
| 完成後全域 | `window.GL_WEB_SDK`，包含帳號 SDK 的 `user`；帳號包另設 `window.GL_ACCOUNT_SDK` |
| 登入 UI | `sdk.user.auth(options, callback)` |
| options | `oauth: { appCode: '6eb76d4e13aa36e6', grantType: 0 }`；`thirdPartyInfo: false` 可避免額外取第三方帳號資訊；`requireEmail` 為可選條件 |
| callback | `(status, result)`；本包明確以 `0` 表成功、`2` 表取消。其他 API 分支另有無 session／到期等狀態，原型應保守處理所有非零結果 |
| 成功形狀 | `result.accountInfo`、`result.oauthInfo`；後者包含 `openId`、`code`、`token` |

上表回呼來自 [帳號 SDK](https://web-static.hg-cdn.com/gl_account_web_sdk/gl-account-web-sdk.min.js) 的 `user.auth` 與其 [登入 UI chunk](https://web-static.hg-cdn.com/gl_account_web_sdk/2.1.0/741.25b04103a524c192ad77.js)。原型只需要當次 `oauthInfo.code`，不能將整個 result 寫入 console、檔案、分析事件或 UI。`token` 存在不等於本工具必須接收或保存它。

以下是依消費契約另寫的示意程式，不是擷取官方實作，也尚未在帳號環境執行。`onCode` 由本機程式提供；它只接到一次性 code，不接受密碼或手動貼入的憑證。

```js
async function openSkportResearchLogin(onCode) {
  // 僅由使用者明確按下「非官方本機研究登入」按鈕觸發。
  const sdk = await new Promise((resolve, reject) => {
    if (window.GL_WEB_SDK) return resolve(window.GL_WEB_SDK);
    window._GL_WEB_SDK_INIT_OPTIONS = { language: 'zh-tw' };
    const timer = setTimeout(() => reject(new Error('SDK 載入逾時')), 15000);
    window._GL_WEB_SDK_CALLBACK_QUEUE ??= [];
    window._GL_WEB_SDK_CALLBACK_QUEUE.push(() => {
      clearTimeout(timer);
      resolve(window.GL_WEB_SDK);
    });
    const script = document.createElement('script');
    script.src = 'https://web-api.gryphline.com/static/gl_web_sdk/sdk.entry.js';
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error('官方 SDK 無法載入'));
    };
    document.head.appendChild(script);
  });
  return new Promise((resolve, reject) => {
    sdk.user.auth({
      oauth: { appCode: '6eb76d4e13aa36e6', grantType: 0 },
      thirdPartyInfo: false,
    }, (status, result) => {
      if (status === 2) return resolve({ cancelled: true });
      const code = status === 0 ? result?.oauthInfo?.code : undefined;
      if (typeof code !== 'string' || !code) return reject(new Error('登入未完成'));
      // 不 log result；onCode 只能呼叫同一個本機服務並立即丟棄 code。
      Promise.resolve(onCode(code)).then(resolve, reject);
    }).catch(() => reject(new Error('官方登入介面未完成')));
  });
}
```

SDK 本身會管理帳號登入與 session 準備，其可見視窗可能包含驗證、條款更新、綁定信箱或註冊流程。原型不得自動填寫、同意或代使用者完成這些畫面。若需要建立帳號或接受條款，應由使用者回到官方介面自行決定。

## 2. localhost／origin 的具體已知限制

帳號 UI 是官方 script 注入**目前網頁 DOM**，不是已證實的跨來源 iframe 隔離。即使原型不自行讀取密碼欄位，也不能宣稱「密碼與本機頁面完全隔離」。原型不得安裝表單攔截器、修改 SDK fetch、錄製登入畫面或記錄 network body；使用者若選這條路，介面必須清楚標示是本機非官方頁面載入官方 SDK。

目前公開 adapter、帳號主包與登入 UI 沒有看到明確禁止 localhost 的前端 hostname 檢查。因此不能在未測之前斷言「一定不能在 localhost 用」。以下仍會影響可行性：

| 條件 | 已查證實作 | 尚待的可驗證結果 |
| --- | --- | --- |
| 帳號主機 | 預設 `as.gryphline.com`；授權請求使用 appCode，並帶 `X-AppCode`／裝置／語言等 SDK 標頭 | 伺服器是否允許本機 origin、回應 CORS 是否成立 |
| SDK session | Web API 預設 `web-api.gryphline.com`；會使用 `/cookie_store/account_token`，請求 `credentials: 'include'` | 第三方 cookie 政策、SameSite、CORS 對 localhost 的實際影響；不能由成功載入 script 推定登入可用 |
| 社交登入 | SDK 用目前 `location.href` 形成 callback，經官方 third-party login API 取得跳轉 URL，通常開 popup | 官方服務／第三方提供者是否接受本機 callback、popup 是否被擋；不得猜登入 URL 或繞過 callback 驗證 |
| 網域選擇 | SDK 對已知根網域會選對應 Web API；localhost 留在預設主機 | 不應任意改成假 origin 或複製官方域名來掩蓋本機來源 |
| 版本 | SDK 入口有灰度選版與 fallback；本次主包為 Web SDK 2.1.4／Account SDK 2.1.0 | 記錄實際載入資產版本；不把此靜態研究當成永遠固定的契約 |

若某步失敗，保留去識別化的階段、HTTP status／業務 code、CORS 錯誤名稱與官方資產版本即可；不保存回應內容或完整授權 URL。不要透過本機代理接收帳號密碼來繞過登入 SDK 的跨來源限制。

## 3. code → SKPORT 憑證的靜態契約

本節供本機後端設計用；沒有執行下列請求。[目前 one-tools](https://static.skport.com/skport-fe-static/skport-bbs/338.413f28c0.js) 的 `getCredByCode` 與 [one-fetch](https://static.skport.com/skport-fe-static/skport-bbs/2613.26af9795.js) 可對出以下流程：

1. 向 `https://zonai.skport.com/web/v1/user/auth/generate_cred_by_code` POST JSON `{ kind: 1, code }`。官方程式另外可加 loginSource，但本機研究沒有需要就不加。
2. 此路由是簽章特例：會帶 `Content-Type: application/json`、`platform: '3'`、`vName: '1.0.0'`、`timestamp`（秒字串），但不以 sign token 簽名。
3. 只有業務 `code === 0` 才視為成功；`data.cred` 是社群憑證，`data.token` 被 fetch 層保存為請求簽章 key，回應頂層 `timestamp` 用來校正時鐘偏移。**SDK 回傳的 oauthInfo.token 與這裡的簽章 token 不可混用。**
4. 本機後端只在記憶體維持 cred、sign token 與時鐘校正，不把它們回傳瀏覽器或列入本工具備份。瀏覽器只拿本機工作階段的隨機識別；本機服務需要固定 origin、CSRF 驗證與僅 loopback 綁定。

SKPORT 本身還會做 `/web/v1/user/check`；若回覆新帳號或待同意政策，官方頁面會要求使用者確認。研究原型不得直接呼叫 policy-agree 或自動完成新帳號設定。這些是帳號狀態門檻，應在官方頁面解決後再重試。

## 4. 已確認的簽章組成與更新

one-fetch 使用的組合是：先 HMAC-SHA256，再對其**小寫十六進位字串**做 MD5。參數內容不是物件重新排序後的值，而是與實際請求一致的字串。

```text
headersToSign = { platform: "3", timestamp: secondsString, dId: "", vName: "1.0.0" }
payload = GET 的實際 query 字串（不含 ?）；其他方法為實際 body 字串或空字串
message = path + payload + secondsString + JSON.stringify(headersToSign)
hmacHex = HMAC_SHA256(key = signToken, message).hexLowercase
sign = MD5(hmacHex).hexLowercase
```

- `path` 不含主機、query、fragment；例如 `/api/v1/game/player/info`。
- 簽入標頭順序固定為 platform、timestamp、dId、vName；目前取得的 Web 發行版跳過 dId 取得分支，因此 HTTP 不必捏造裝置 ID，簽入值為空字串。不同版本若有變更需重驗。
- GET query 與 POST JSON 必須先建立一次，同時拿來簽章及發送；不能簽完又改參數順序或編碼。
- 一般請求帶 `cred` 與 `sign`；`sk-language` 是社群語言，繁中值為 `zh_Hant`，不同於 SDK 初始化的 `zh-tw`。
- 時間以本機秒數加上伺服器校正量。程式對某些錯誤分支讀取回應時間，不應無限重試。

原程式遇業務 `10000` 會 GET `/web/v1/auth/refresh`、以成功回應 `data.token` 更新簽章 key，再重送原請求；`10003` 有時間校正／重送分支。refresh 本身不帶遊戲資料參數，仍使用目前 cred／簽章上下文。`10002` 出現在憑證無效後登出處理。原型應限次重試，失敗要求重新登入，不模擬遊戲簽到、領獎或寫入動作。

這些是公開前端可推導的請求格式，尚未通過真實帳號或 localhost 往返驗證。可以先以合成 sign key／固定時間做本機 deterministic tests，不能將測試通過寫成帳號整合成功。

## 5. 角色與資料讀取：原型只開這條受限路線

公開 game-tools 的本作路線為角色綁定 → 使用者選角色 → 本作資料 → 已解碼候選資料。可讀路由線索如下，請求仍未實測：

| 路由 | 已知用途／欄位 | 原型限制 |
| --- | --- | --- |
| GET `/web/v2/user` | current one-tools 的社群使用者資訊；社群 ID 取自 `data.user.basicUser.id` | 若必須取得社群 ID，只取需要的 ID，不保存整份個資 |
| GET `/api/v1/game/player/binding` | game-tools 傳入 `{ uid: communityUserId }`；回應 `data.list[]` 按 `appCode` 分類，每類有 `bindingList` | 不接受任意貼入他人 ID；只呈現當次登入帳號回覆的本作 `arknights` 角色 |
| GET `/api/v1/game/player/info` | game-tools 使用 `{ uid: selectedGameUid, userId: communityUserId }`；帶 `x-transformed: base64` | selectedGameUid 必須是本次 binding 回應的一員；使用者明確選擇並確認本作繁中，不能從語言推服別 |
| 回應解碼 | `data.content` 若有值，fetch 層將 base64 UTF-8 解碼，再 JSON.parse | 解碼後只向本機 normalizer 投影必要 chars；不保存完整帳號回應 |

資料形狀與未知欄位處理見 [登入契約查核](skport-login-contract.md)。即使登入成功，沒有本作繁中角色、回應無 chars、資料有缺欄或 source 語義不清時，都不宣稱完整持有庫。原型不開簽到、show-config、asset-show、領獎、解除綁定或帳號註銷路由。

## 6. 預定操作順序與完成條件

以下是等待本機原型完成後的研究操作順序，尚非已驗收功能：

1. 啟動只監聽 loopback 的本機服務；頁面清楚顯示「非官方本機研究」，並提供清除本機工作階段。
2. 使用者點選登入後才載入官方 SDK；由使用者自行操作其可見 UI。研究代理不看輸入值、不代填、不擷取 session。
3. 成功回呼只將 code 送到同源本機後端；交換結果只留記憶體。若因 CORS／callback／政策而失敗，顯示具體階段並停止該分支。
4. 僅列出當次帳號的本作角色，由使用者選擇並確認服別。找不到本作繁中角色就結束，不改用《終末地》或其他服別資料。
5. 使用者按下讀取後只讀一次選定角色，投影為 partial 候選，走既有逐欄預覽、衝突確認與合併流程。
6. 驗證取消、失敗、重開頁面與清除本機 session 的行為；本機刪除不冒稱官方伺服器 token 已撤銷。

正式官方選項目前是由使用者在官方 SKPORT 介面查看遊戲資料，或申請本工具可用的正式第三方接入。前者不會自動授權本工具同步；後者仍待官方給出接入規格。若之後使用者要求我們讀取其官方頁面可見內容，需按當時明確範圍處理，不能因此默認擷取瀏覽器隱藏憑證。

## 7. 本輪新增靜態證據

既有檔案與 hash 見 [登入契約](skport-login-contract.md) 及 `.local/skport-research/manifest.json`。本輪新增：

| 本機檔 | 官方資產 | UTC／HTTP／大小 | SHA-256（保存的 UTF-8 bytes） |
| --- | --- | --- | --- |
| `skport-sdk-adapter-175.js` | 本文第 1 節 adapter 連結 | 2026-11-13T05:30:46Z／200／1,864 bytes | `c6aa57068753144ebd7cdc488ce1c2170c438e8828dc71a7eeca5c5845b2de09` |
| `gl-account-login-ui-741.js` | 本文第 1 節 login UI 連結 | 2026-11-13T05:30:47Z／200／218,757 bytes | `3893dc0e684acc5eb48d1be98872195239b7290795c34ae97956e57020a4ab88` |

所有結論來自靜態程式與依賴追蹤。本輪沒有帳號結果，不能填寫登入成功率、CORS 可用、讀取完整度或撤銷通過。
