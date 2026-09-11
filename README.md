# 好日集 NANACACA － 代購管理平台

## 這是什麼

一個給你自己（單人操作）使用的代購管理網站，涵蓋：

- **總覽** `index.html` — 期別、本期營收、待核對匯款、低庫存提醒
- **商品輸入** `products.html` — Excel風格快速輸入，自動算成本（含刷卡手續費%、退稅手續費、運費）、系列組合價規則
- **顧客入單** `order.html` — 選顧客、加入購物車（即時算組合價、預扣庫存）、收件資訊、送出訂單
- **訂單** `orders.html` — 訂單列表、一鍵複製匯款通知、A4出貨單列印、匯款回報核對
- **成本利潤** `costs.html` — 機票/住宿/交通/免運補貼手動輸入，自動彙總損益
- **設定** `settings.html` — 社群名稱、期別切換、購物車保留時數、存取密碼
- **顧客匯款回報頁** `remit.html` — 無密碼、透過訂單專屬連結開放給顧客
- **Code.gs** — Google Apps Script 後端範本，之後要接 Google Sheets 時用

整站是**響應式設計**：電腦上是左側選單＋內容區，手機上選單會變成頂部可橫向滑動的分頁列，商品輸入的表格在小螢幕上可以左右滑動查看。

## 目前是「展示模式」(Demo Mode)

現在打開這些檔案，資料是存在**瀏覽器的 localStorage**（同一台裝置、同一個瀏覽器才看得到），不是真的連到 Google Sheets。這樣的好處是你現在就可以直接打開 `index.html` 開始試用整個流程（建立期別、輸入商品、幫顧客建單、複製匯款通知），不用等後端設定好。

第一次使用：
1. 打開 `index.html`，建立第一個期別
2. 到 `products.html` 輸入幾筆商品
3. 到 `settings.html` 設定存取密碼（設定前不會要求密碼）
4. 到 `order.html` 練習幫顧客建單

## 之後要正式上線（接 Google Sheets）

1. 建立一個新的 Google Sheet
2. 「擴充功能 > Apps Script」，把 `Code.gs` 貼進去
3. 執行一次 `setupSheets()`，會自動建好所有分頁與欄位
4. 「部署 > 新增部署作業」，類型選「網頁應用程式」，執行身份選你自己，誰可以存取選「所有人」（因為 `remit.html` 要讓顧客免登入就能送出資料）
5. 複製部署後的網址
6. 把 `data.js` 裡 `DB`物件的每個函式，換成呼叫這個網址的 `fetch()`（`Code.gs` 裡的 `doGet`/`doPost` 已經用同樣的動作名稱對應，例如 `upsertProduct`、`submitOrder`、`submitRemittance`），這樣前端邏輯、頁面都不用改，只是資料來源從 localStorage 換成 Google Sheets

這一步我们可以之後一起做——先讓你在 demo 模式熟悉操作流程、確認欄位設計沒問題，再串接後端會比較有效率，不用改兩次。

## 上架到 GitHub Pages

1. 把這個資料夾整個 push 到一個 GitHub repo
2. repo 設定 > Pages > 選擇要發布的分支（例如 main）
3. 會得到一個 `https://你的帳號.github.io/repo名稱/` 網址

**⚠️ 提醒**：GitHub Pages 預設是公開網址，任何知道網址的人都能打開。整站密碼保護（`settings.html` 設定的密碼）只是基本防護、擋一般路人，不是銀行等級的加密，這點跟你先前討論時確認過的一致。

## 已知限制（demo 模式）

- 收據照片存在 localStorage 裡，檔案一多瀏覽器儲存空間可能不夠；正式上線後建議改存進 Google Drive，`Code.gs` 目前的 `receiptPhotoUrl` 欄位就是預留給 Drive 檔案連結用的
- `remit.html` 在 demo 模式下會讀到跟後台一樣的 localStorage，只是方便你自己測試整個流程；正式上線後這頁只會呼叫 Google Apps Script 的 API，不會像現在這樣共用本機資料
