# SKPORT 轉換器與登入接線範圍

日期：2026-11-13。本文記錄離線轉換器階段，該命令本身不連網。後續非官方本機研究頁已成功下載 409 筆真實研究 JSON；現已補齊版本化繁中圖鑑，主畫面可直接載入研究檔並預覽，見 [遊戲資料 API 與匯入](game-data-api.md)。逐欄核對、完整性及使用者確認保存仍是獨立步驟。

## 本輪實作

沿用 RIIC 的分工：官方登入、交換授權、選定角色、讀取資料、轉成候選、預覽確認。本文件所記階段只實作後兩步的離線資料轉換與既有預覽整合；後續本機研究頁的前四步實作與登入限制另列於上述實測報告。

`src/importers/skport.ts` 提供 `convertSkportOffline()`；`scripts/convert-skport.ts` 是不連網的命令列入口。它不會登入、不會要求 Cookie／Token，也不會擷取瀏覽器儲存。公開前端契約及登入缺口見 [登入契約查核](skport-login-contract.md)。

## 輸入不是官方匯出格式

研究封裝為：

```json
{
  "format": "skport-offline-research",
  "schemaVersion": 1,
  "gameData": {
    "code": 0,
    "data": { "chars": [] }
  }
}
```

`gameData` 必須是已解碼的研究回應，不是任意原始 HTTP 內容。公開前端存在 `x-transformed=base64` 的解碼路徑；本轉換器不讀 HTTP 標頭、不執行該網路流程，也不把單獨 `data.content` 猜成幹員資料。本封裝由本專案定義，不能稱為 SKPORT 官方 JSON 匯出功能。

另提供既有 v1 `Dataset`，命名空間須為 `personal`，包含可核對的幹員、技能及模組穩定 ID 和校驗值。未知 ID、缺少定義、重複 ID 或錯誤資料形狀會拒絕整批，不靠姓名猜測，也不靜默略過問題列。

## 轉換與證據邊界

- 只從 `data.chars` 取幹員；助戰清單不能代替持有庫。
- 依公開程式可確認的欄位投影：等級、精英、信賴、技能等級、技能 ID／專精及裝備 ID；仍需實際帳號逐欄驗證。
- 缺值保留未知；潛能基底、模組開放／解鎖／等級等尚未證實語義不自行補值。
- 採白名單建立候選。UID、暱稱等未需要的帳號資料不進結果；發現憑證相關欄位時拒絕輸入，不把來源值寫進錯誤訊息。
- 結果固定 `partial`，來源標為未驗證，信心值 `0` 只表示尚未驗證來源，並非量測的正確率。既有預覽要求對候選已知值作明確決策。
- `--confirm-arknights-tw` 是呼叫者核對產品／服別的聲明，不能替代 G0 使用權、服務端服別驗證或完整帳號驗收。

## 本機操作

在專案根目錄執行，將已合法取得且符合上述契約的研究輸入及資料集放在私人目錄：

```powershell
node --experimental-strip-types scripts/convert-skport.ts `
  --input private-fixtures/skport-research.json `
  --dataset private-fixtures/tw-dataset.json `
  --out private-fixtures/skport-candidates.json `
  --confirm-arknights-tw
```

輸出只能寫在本專案 `private-fixtures/`，父目錄必須存在，拒絕覆寫既有檔案。完成後在網站切到「個人工作區」→「匯入幹員」→選擇候選 JSON，經預覽與確認才保存。這個命令不會替使用者取得原始帳號資料。

## 真實登入尚缺的契約

原計畫要求先有適用第三方用途的官方允許，再由使用者在官方介面登入。現有公開程式證明 SKPORT 自己的前端有登入及資料流程，沒有證明本工具可以沿用其第一方 app code、取得合法第三方 redirect URI 或撤銷授權契約。離線轉換器不新增 OAuth callback、不接受帳密、不保存 session，也不把開啟官方網站寫成已連線。後續研究頁使用官方 SDK，並由本機後端暫存連線；兩者範圍不同。

仍需取得適用的官方第三方授權／匯出方式。最初直接登入因 CORS 失敗；後續本機代理已取得 409 筆資料，見 [audit 實測](skport-audit-log.md)。未聯絡官方或申請 QR／OTP。
