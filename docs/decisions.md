# 決策紀錄

日期：2026-11-13（Asia/Taipei）。

| 決策 | 依據與結果 | 可重新評估的條件 |
| --- | --- | --- |
| 本機優先 | 一般幹員庫仍直接使用 IndexedDB；後續經授權新增只監聽 loopback 的 SKPORT 研究後端，憑證限記憶體 15 分鐘 | 正式部署或雲端同步需另提具體方案 |
| Preact＋TypeScript＋Vite | 使用者詢問更輕量框架及 Rust 後，明確選擇「先用 Preact，運算有瓶頸再加 Rust」 | 排班搜尋或辨識有可重現的效能瓶頸時，再比較 Rust／WASM 與 Web Worker |
| 只用原生 IndexedDB | 避免加入狀態管理、路由、UI 或資料庫包裝依賴；交易與版本衝突明確測試 | 真實資料量與維護需求超出目前邊界 |
| 資料核心與 UI 分離 | 本次採純 TypeScript 合併／驗證，可替換前端或未來運算實作 | 以版本化格式與回歸測試保持相容 |
| API 僅限授權的本機研究 | 使用者後續允許本帳號測試，並要求用本機代理處理 CORS；限定代理已通過無憑證連線與合成測試，真實帳號重新登入及 JSON 尚待驗證。這不構成官方第三方使用權證明 | 真實登入成功後驗證角色、服別與完整性；官方使用契約仍另列 |
| 截圖已小樣本實測、影片待測 | 已取得六張私人照片並以 Windows 本機 OCR 建立待核對候選；詳見多圖辨識實測。尚未完成影片或 iPhone 直接辨識 | 正式 ID 對應、影像校正與更大樣本驗證 |
| 示範與個人資料隔離 | 合成幹員不能冒充真實遊戲資料，也不能混入個人幹員庫 | 正式資料包需另核對穩定 ID、繁中可用性及使用權 |
| 私人素材排除版本控制 | 不將原圖、影片、備份或帳號資訊送入 Git／遠端分析 | 僅在使用者明確同意的具體資料範圍下另案處理 |
| 不部署 | 使用者要求正式部署選擇另行確認；本輪僅本機預覽 | 建置、真機測試與資料政策備妥，再提供平台、費用、存取與網址方案 |

## 工具與版本核對

- 本機 Node.js `22.22.0`、npm `10.9.4`。
- 套件版本依 npm 公開 registry 查詢，確切版本與完整依賴樹由 `package.json`／`package-lock.json` 鎖定。
- Preact 內含 TypeScript 型別；不安裝 React 或 React 相容層。參見 [Preact 官方 TypeScript 說明](https://preactjs.com/guide/v11/typescript/)。
- Vite 建置目標設定 Safari 17，但這只控制語法輸出，不等於 iPhone 真機相容驗收。參見 [Vite 官方指南](https://vite.dev/guide/)。
- Rust 候選可用 [Leptos CSR](https://book.leptos.dev/deployment/csr.html) 或 [Yew](https://yew.rs/docs/getting-started/introduction)，本輪未安裝或引入 Rust 工具鏈。
