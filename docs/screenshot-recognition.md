# 多圖本機 OCR 核對研究

這一版提供 Windows 本機文字辨識、跨圖片候選分組與網頁核對介面。六張獲授權的私人截圖已實際送入已安裝的 `Windows.Media.Ocr`；不是把手抄姓名包裝成 OCR。辨識結果仍須人工核對，不會直接寫入持有幹員庫。

## 支援範圍

- 目前只驗證 589 × 1280、繁體中文幹員清單的六張樣本。解析器拒絕其他尺寸；同尺寸其他頁面也不保證可辨識。
- 僅提取姓名、等級、信賴值與 `RANK` 文字的技能等級。精英化、專精、潛能、技能選取、模組解鎖／裝備／等級均沒有圖示分類器，維持未知。
- 每個候選值保留原圖 SHA-256、來源圖片、原圖座標、辨識變體與原始文字。放大／裁切後的座標回算至原圖。
- 同一圖片按 SHA-256 去重；不同圖片只有完整 OCR 姓名一致才做核對分組。分組不產生正式幹員 ID，不代表持有或身分驗證。
- 姓名變體出現分歧時設為未知；數字只接受欄位範圍內的純數字。多個合法但不同的值標為衝突，不取最大值、不以多數決掩蓋差異。
- 圖片原檔在使用者選取後只透過暫時 Blob URL 顯示，核對頁不保存圖片、不寫入資料庫。iPhone 直接選多圖並在裝置上 OCR 尚未完成。

## 本機執行

前提為本機已有 Python、Pillow、Node 22.22 以上、Windows PowerShell 5.1 與 `zh-Hant-TW` Windows OCR 語言。工具不下載語言包、不安裝程式、不變更 ExecutionPolicy。Python 啟動自撰 PowerShell 命令文字，不使用 `Bypass`。

每次選擇新的輸出目錄；輸出只允許在本專案 `private-fixtures` 內，拒絕符號連結／junction 與既有輸出，保護原圖和先前結果。

```powershell
python scripts/ocr-batch.py `
  --input-directory '<獲授權圖片目錄>' `
  --pattern 'photo_[1-6]_2026-11-13_12-54-38.jpg' `
  --output-directory private-fixtures/my-new-run `
  --variants original,upscale2,invert2,namecolumn2

node --experimental-strip-types scripts/ocr-review.ts `
  --input private-fixtures/my-new-run/raw-ocr.json `
  --output private-fixtures/my-new-run/review.json
```

打開工具的「多圖辨識核對」，選擇 `review.json`；再選取當次原圖，即可依來源列查看框線。原圖以 SHA-256 驗證配對，檔名不作為身分依據。結果 JSON 限 10 MB。介面顯示的候選與統計仍是未核准資料。

`namecolumn2` 只裁切姓名／等級欄並放大兩倍，以降低旁邊圖示干擾；沒有改寫文字。`scripts/ocr-review.ts` 可以用多個 `--input` 合併同一引擎、同一圖片的不同辨識變體。它先驗證各檔，再轉換與重讀核對格式，最後用 exclusive create 寫入新檔。已有輸出不覆蓋。

## 資料契約

原始引擎輸出格式為 `arknights-local-ocr` / `schemaVersion: 1`，核對格式為 `arknights-screenshot-review` / `schemaVersion: 1`。後者固定 `product: arknights`、`server: tw`；這是本次研究的資料命名空間，不是從截圖辨識得出的官方服別證明。

`rows` 的 `candidateId` 只供本次核對介面定位；`mappingStatus` 固定 `unmapped`，沒有 `operatorId`。每個 `OcrField` 為 `candidate`、`unknown` 或 `conflict`；只有 `candidate` 帶 `value`。`sources.rowIndex` 由上往下、以 1 起算，即使中間漏一整列也保留原圖列次。

匯入核對 JSON 時會驗證欄位白名單、產品／服別／版本、來源圖片、界內座標、欄位範圍、統計一致性，以及數值／姓名是否與所帶文字證據一致。證據也必須落在該列所列的圖片、變體與框線內。這只能檢查文件內部一致性；不能證明文件或 OCR 結果未被整份改寫。

## 私人實測與證據

原始截圖不進公開程式包；`private-fixtures/` 已列入忽略規則。三個全圖變體的實測資料保存在 `private-fixtures/screenshots-2026-11-13/`：

- `input-manifest.json`：原圖雜湊、尺寸與處理變體。
- `raw-ocr.json`：引擎實際回傳的文字與座標。
- `run-summary.json`：六圖、三種變體的辨識時間。
- `review-final.json`：整合四種變體的最終核對結果；`review-initial.json`、`review-current.json` 是保留的中間產物，不供驗收。
- `reference-labels.json`：助理逐張視讀的暫定參考，與 OCR 產物分開保存。第二圖第二列的字形待人員確認，因此排除該列的姓名精確比較。
- `evaluate.py`、`comparison-final.json`：可重現的欄位比較，不會用參考標記修正或回填 OCR。

姓名欄裁切的另一個實際執行紀錄位於 `private-fixtures/screenshots-namecolumn-2026-11-13/`，也有獨立的 manifest、raw OCR 與 run-summary。其來源快照與原檔位元組相同、SHA-256 相同。全圖三種變體耗時 14.752 秒、姓名欄裁切耗時 6.656 秒；兩次本機辨識共 21.408 秒，不含人工核對時間。引擎為 Windows.Media.Ocr / zh-Hant-TW / Windows 10.0.26300.0。

視讀可見 60 次姓名，跨圖有兩組重疊，對應 58 位顯示姓名。全圖三變體曾漏掉第五圖末列；增加姓名欄裁切後，由引擎實際讀到該列。最終結果為 60 列、58 候選組、2 重疊列、6 個邊緣半列，58 組皆未對應正式 ID。沒有用參考姓名回填結果。

最終結果與暫定參考比較：

| 欄位 | 參考筆數 | 候選精確相同 | 不同 | 未知 | 衝突 | 整列漏失 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 姓名 | 59 | 47 | 1 | 11 | 0 | 0 |
| 等級 | 54 | 54 | 0 | 0 | 0 | 0 |
| 信賴 | 54 | 39 | 0 | 13 | 2 | 0 |
| 技能等級 | 54 | 36 | 0 | 18 | 0 | 0 |

比較按來源列計數，將跨圖分組結果對應回各來源列。數字比較只取每圖前九列的完整可見文字；底部遮蔽值不納入分母。以上是單一樣本、助理暫定參考下的候選涵蓋量，不能宣稱通用正確率或人工核准真值。圖示欄位沒有辨識結果。

本次實際合併與比較命令（重跑需另取新輸出檔名）：

```powershell
node --experimental-strip-types scripts/ocr-review.ts `
  --input private-fixtures/screenshots-2026-11-13/raw-ocr.json `
  --input private-fixtures/screenshots-namecolumn-2026-11-13/raw-ocr.json `
  --output private-fixtures/screenshots-2026-11-13/review-final.json

python -X utf8 private-fixtures/screenshots-2026-11-13/evaluate.py `
  --review private-fixtures/screenshots-2026-11-13/review-final.json `
  --output private-fixtures/screenshots-2026-11-13/comparison-final.json
```

自動驗證涵蓋重複圖、跨圖精確同名、異格不合併、缺漏、超範圍、數值衝突、姓名變體分歧、放大座標、半列、中間漏列保留原圖列次、錯誤格式與來源證據範圍。檔案 guard 另外驗證新目錄／exclusive create、EXIF、來源快照、變體尺寸與位移、重新解析點拒絕等。真正建立 junction 的整合測試在此權限環境跳過；有合成屬性測試，不能宣稱完成真 junction 實測。

## 已知限制與後續驗證

目前無繁中服正式姓名／穩定 ID 資料集，因此無法驗證候選是否對應真正幹員；也沒有登入、同步或讀取帳號 API。純姓名分組可能受 OCR 錯字、同名與異格影響，必須保留原文核對。欄位位置與列間距是此版型的研究參數，尚未驗證其他解析度、字級、主題、裝置或版本。

OCR 程式沒有網路呼叫，這項聲明來自程式實作與執行範圍；本次未進行封包側錄。圖片也未送至付費服務。現階段宜作為有證據的離線核對原型，不能視為可直接在 iPhone 完成全自動匯入的正式版本。
