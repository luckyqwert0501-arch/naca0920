/**
 * NANACACA 代購管理平台 — Google Apps Script backend (v2, single-state design)
 *
 * 這一版把整個系統的資料存成「一包 JSON」放在一個叫 State 的分頁裡，
 * 不再拆成十幾個關聯式分頁。對單人使用的系統來說這樣更簡單也更不容易壞掉。
 *
 * 部署方式
 * 1. 開啟你的 Google Sheet > 擴充功能 > Apps Script
 * 2. 把整個編輯器內容清空，貼上這個檔案
 * 3. 存檔（Cmd+S / Ctrl+S）
 * 4. 部署 > 管理部署作業 > 點編輯（鉛筆圖示）> 版本選「新版本」> 部署
 *    （這樣可以沿用同一個網址，不用换新的）
 *    如果是第一次部署：部署 > 新增部署作業 > 類型選「網頁應用程式」>
 *    執行身份「我」> 誰可以存取「所有人」> 部署，複製網址貼到 config.js
 *
 * 資料結構（除了 remittances 以外都由前台整包覆寫，remittances 只透過
 * submitRemittance / confirmRemittance 這兩個專屬動作讀寫，避免顧客回報
 * 匯款的同時你在後台編輯商品，兩邊互相覆蓋掉對方的資料）：
 *   { settings, batches, products, seriesRules, customers,
 *     orders, orderItems, cartHolds, costs, remittances }
 */

const STATE_SHEET_NAME = "State";

function defaultState_() {
  return {
    settings: {
      communityName: "好日集 NANACACA",
      currentBatchId: null,
      cartHoldHours: 24,
      password: "",
      shippingMethods: [
        { id: "SHP1", name: "郵寄（小於5KG）", fee: 100 },
        { id: "SHP2", name: "郵寄（5-9KG）", fee: 180 },
        { id: "SHP3", name: "賣貨便+39", fee: 39 },
        { id: "SHP4", name: "特殊寄送（黑貓）", fee: 150 },
        { id: "SHP5", name: "自取", fee: 0 }
      ]
    },
    batches: [], products: [], seriesRules: [], customers: [],
    orders: [], orderItems: [], cartHolds: [], costs: [], remittances: []
  };
}

function getStateSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(STATE_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(STATE_SHEET_NAME);
  return sheet;
}

function readState_() {
  const raw = getStateSheet_().getRange("A1").getValue();
  if (!raw) return defaultState_();
  try {
    const parsed = JSON.parse(raw);
    // 補齊萬一缺少的欄位（例如手動改過分頁內容）
    return Object.assign(defaultState_(), parsed);
  } catch (e) {
    return defaultState_();
  }
}

function writeState_(state) {
  getStateSheet_().getRange("A1").setValue(JSON.stringify(state));
}

function newId_(prefix) {
  return prefix + new Date().getTime() + Math.floor(Math.random() * 1000);
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* 第一次使用可以手動執行這個函式，會建立空白的 State 分頁（非必要，
   loadAll 在沒有資料時本來就會回傳預設值）。 */
function setupState() {
  writeState_(defaultState_());
}

function doGet(e) {
  const action = e.parameter.action;

  if (action === "loadAll") {
    return jsonOut_(readState_());
  }

  if (action === "orderSummary") {
    const state = readState_();
    const order = state.orders.find(o => o.id === e.parameter.id);
    if (!order) return jsonOut_({ exists: false });
    const items = state.orderItems.filter(i => i.orderId === order.id);
    const itemsTotal = items.reduce((s, i) => s + (Number(i.subtotal) || 0), 0);
    const total = itemsTotal + (Number(order.shippingFee) || 0);
    return jsonOut_({ exists: true, id: order.id, total: total, communityName: state.settings.communityName });
  }

  return jsonOut_({ error: "unknown action" });
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const action = body.action;
  const payload = body.payload;

  if (action === "saveAll") {
    const existing = readState_();
    const incoming = payload;
    // remittances 永遠保留伺服器現有的版本，不接受前台整包覆寫，
    // 避免顧客回報匯款的當下被後台的其他操作蓋掉。
    incoming.remittances = existing.remittances || [];
    writeState_(incoming);
    return jsonOut_({ ok: true });
  }

  if (action === "submitRemittance") {
    const state = readState_();
    const record = Object.assign(
      { id: newId_("RMT"), createdAt: new Date().getTime(), status: "待核對" },
      payload
    );
    state.remittances.push(record);
    writeState_(state);
    try {
      MailApp.sendEmail({
        to: Session.getActiveUser().getEmail(),
        subject: "[代購] 新的匯款回報 － 訂單 " + payload.orderId,
        body: "顧客：" + payload.name + "（" + payload.phone + "）\n" +
              "訂單編號：" + payload.orderId + "\n" +
              "回報金額：" + payload.amount + "\n" +
              "後五碼：" + payload.last5 + "\n\n請至系統核對後標記為已付款。"
      });
    } catch (err) {
      // 寄信失敗不影響回報本身已經存檔成功
    }
    return jsonOut_({ ok: true, record: record });
  }

  if (action === "confirmRemittance") {
    const state = readState_();
    const r = state.remittances.find(x => x.id === payload.id);
    if (r) { r.status = "已核對"; writeState_(state); }
    return jsonOut_({ ok: true });
  }

  return jsonOut_({ error: "unknown action" });
}
