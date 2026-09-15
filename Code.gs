/**
 * NANACACA 代購管理平台 — Google Apps Script backend (v3)
 *
 * 這一版把資料存成一般的表格分頁（不是 JSON 整包），每個分頁對應一種資料、
 * 欄位全部用中文，你打開 Google Sheet 就能直接看懂、也可以自己手動檢查。
 *
 * 部署／更新方式
 * 1. 開啟你的 Google Sheet > 擴充功能 > Apps Script
 * 2. 把編輯器內容整個清空，貼上這個檔案
 * 3. 存檔（Cmd+S / Ctrl+S）
 * 4. 【第一次使用，或改過程式碼後都要做】選函式下拉選單裡的 authorize，
 *    點左邊的 ▶ 執行。第一次會跳出授權畫面：「檢閱權限」→選你的帳號→
 *    可能顯示「Google 尚未驗證這個應用程式」→點「進階」→
 *    「前往...（不安全）」→允許。這一步一定要做，否則網頁應用程式沒有
 *    權限讀寫你的試算表，所有存檔都會悄悄失敗。
 * 5. 部署 > 管理部署作業 > 點现有部署旁的鉛筆圖示 > 版本選「新版本」> 部署
 *    （這樣沿用同一個網址，config.js 不用改）
 *
 * 分頁會在第一次被讀取或寫入時自動建立，不用手動先建。
 *
 * 「匯款回報」分頁刻意跟其他資料分開處理：一般存檔（saveAll）不會去動它，
 * 只有 submitRemittance／confirmRemittance 這兩個動作會讀寫它，這樣顧客
 * 回報匯款的當下，不會被你在後台做的其他操作覆蓋掉。
 */

/* ---------------- 授權用（第一次執行一次即可） ---------------- */
function authorize() {
  SpreadsheetApp.getActiveSpreadsheet();
  MailApp.getRemainingDailyQuota();
}

/* ---------------- 欄位對照表（key 是前端用的英文欄位名，header 是中文欄名） ---------------- */

const SETTINGS_DEFS = [
  { key: "communityName", header: "代購品牌名稱" },
  { key: "currentBatchId", header: "目前期別ID" },
  { key: "cartHoldHours", header: "購物車保留時數" },
  { key: "password", header: "存取密碼" }
];

const SHIPPING_FIELDS = [
  { key: "id", header: "寄送方式ID" },
  { key: "name", header: "寄送方式名稱" },
  { key: "fee", header: "建議運費" }
];

const BATCH_FIELDS = [
  { key: "id", header: "期別ID" },
  { key: "name", header: "期別名稱" },
  { key: "status", header: "狀態" },
  { key: "bankCode", header: "銀行代碼" },
  { key: "bankAccount", header: "銀行帳號" },
  { key: "bankHolder", header: "戶名" }
];

const PRODUCT_FIELDS = [
  { key: "id", header: "商品ID" },
  { key: "batchId", header: "期別ID" },
  { key: "series", header: "系列" },
  { key: "name", header: "商品名稱" },
  { key: "jpyAmount", header: "日幣金額" },
  { key: "cardFeePct", header: "刷卡手續費%" },
  { key: "taxRefundFee", header: "退稅%" },
  { key: "agentFeePct", header: "代買%" },
  { key: "exchangeRate", header: "匯率" },
  { key: "weightG", header: "重量(公克)" },
  { key: "shippingTWD", header: "運費(TWD)" },
  { key: "costTWD", header: "成本(TWD)" },
  { key: "sellPrice", header: "售價" },
  { key: "stockQty", header: "庫存數量" },
  { key: "reserved", header: "已預留" },
  { key: "sold", header: "已售出" },
  { key: "isStanding", header: "常態商品" }
  // 注意：發票照片刻意不存進 Google Sheet — 一張照片的 base64 資料動輒
  // 十幾萬字元，遠超過單一儲存格 5 萬字元的上限，寫入會直接失敗，而且
  // 會連帶讓「這整批」商品都存不進去。發票照片只留在瀏覽器本機做備查。
];

const SERIES_RULE_FIELDS = [
  { key: "id", header: "規則ID" },
  { key: "batchId", header: "期別ID" },
  { key: "seriesName", header: "系列名稱" },
  { key: "thresholdQty", header: "門檻件數" },
  { key: "thresholdPrice", header: "門檻後單價" }
];

const CUSTOMER_FIELDS = [
  { key: "id", header: "顧客ID" },
  { key: "name", header: "姓名" },
  { key: "phone", header: "電話" },
  { key: "lineName", header: "Line名稱" },
  { key: "address", header: "地址" },
  { key: "birthday", header: "生日" }
];

// 訂單分頁是攤平存的（收件資訊拆成獨立欄位），讀寫時會跟前端的巢狀
// order.recipient.{name,phone,address,shipMethod} 互相轉換。
const ORDER_FIELDS = [
  { key: "id", header: "訂單編號" },
  { key: "batchId", header: "期別ID" },
  { key: "customerId", header: "顧客ID" },
  { key: "recipientName", header: "收件人姓名" },
  { key: "recipientPhone", header: "收件人電話" },
  { key: "recipientAddress", header: "收件地址" },
  { key: "shipMethod", header: "寄送方式" },
  { key: "shippingFee", header: "運費" },
  { key: "status", header: "訂單狀態" },
  { key: "createdAt", header: "建立時間" },
  { key: "updatedAt", header: "更新時間" }
];

const ORDER_ITEM_FIELDS = [
  { key: "id", header: "明細ID" },
  { key: "orderId", header: "訂單編號" },
  { key: "productId", header: "商品ID" },
  { key: "qty", header: "數量" },
  { key: "unitPrice", header: "成交單價" },
  { key: "subtotal", header: "小計" }
];

const CART_HOLD_FIELDS = [
  { key: "id", header: "暫存ID" },
  { key: "productId", header: "商品ID" },
  { key: "qty", header: "數量" },
  { key: "createdAt", header: "建立時間" },
  { key: "status", header: "狀態" }
];

const COST_FIELDS = [
  { key: "id", header: "成本ID" },
  { key: "batchId", header: "期別ID" },
  { key: "flight", header: "機票" },
  { key: "hotel", header: "住宿" },
  { key: "transport", header: "交通" },
  { key: "freeShippingSubsidy", header: "免運負擔運費" },
  { key: "note", header: "備註" }
];

const REMITTANCE_FIELDS = [
  { key: "id", header: "回報ID" },
  { key: "orderId", header: "訂單編號" },
  { key: "name", header: "姓名" },
  { key: "phone", header: "電話" },
  { key: "amount", header: "回報金額" },
  { key: "last5", header: "後五碼" },
  { key: "createdAt", header: "回報時間" },
  { key: "status", header: "核對狀態" }
];

/* ---------------- 通用的表格讀寫工具 ---------------- */

function ensureSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

function readEntities_(sheetName, fieldDefs) {
  const headers = fieldDefs.map(f => f.header);
  const sheet = ensureSheet_(sheetName, headers);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headerRow = values[0];
  return values.slice(1)
    .filter(row => row.some(c => c !== "" && c !== null))
    .map(row => {
      const obj = {};
      fieldDefs.forEach(f => {
        const idx = headerRow.indexOf(f.header);
        obj[f.key] = idx >= 0 ? row[idx] : "";
      });
      return obj;
    });
}

function writeEntities_(sheetName, fieldDefs, list) {
  const headers = fieldDefs.map(f => f.header);
  const sheet = ensureSheet_(sheetName, headers);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (list && list.length) {
    const rows = list.map(obj => fieldDefs.map(f => (obj[f.key] !== undefined ? obj[f.key] : "")));
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
}

function newId_(prefix) {
  return prefix + new Date().getTime() + Math.floor(Math.random() * 1000);
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- 快速讀取用的整包快取 ----------------
   每次 saveAll／匯款回報動作之後，都會把「當下完整的一份資料」存成一份
   JSON 塞進 Cache 分頁的 A1 儲存格。之後 loadAll 只需要讀這一格就好，
   不用一次讀 9 個分頁，頁面切換會快很多。分頁本身還是各自獨立、可以直接
   打開來看──快取只是額外多存一份「方便快速讀取」的副本，不是取代分頁。 */

function readCache_() {
  const sheet = ensureSheet_("Cache", ["json"]);
  const raw = sheet.getRange(2, 1).getValue();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function writeCache_(state) {
  const sheet = ensureSheet_("Cache", ["json"]);
  sheet.getRange(2, 1).setValue(JSON.stringify(state));
}

/* ---------------- 設定（key/value 分頁）＋寄送方式（自己的分頁） ---------------- */

function defaultShippingMethods_() {
  return [
    { id: "SHP1", name: "郵寄（小於5KG）", fee: 100 },
    { id: "SHP2", name: "郵寄（5-9KG）", fee: 180 },
    { id: "SHP3", name: "賣貨便+39", fee: 39 },
    { id: "SHP4", name: "特殊寄送（黑貓）", fee: 150 },
    { id: "SHP5", name: "自取", fee: 0 }
  ];
}

function readSettings_() {
  const headers = ["項目", "內容"];
  const sheet = ensureSheet_("設定", headers);
  const values = sheet.getDataRange().getValues();
  const map = {};
  values.slice(1).forEach(row => { if (row[0]) map[row[0]] = row[1]; });

  const settings = {};
  SETTINGS_DEFS.forEach(d => { settings[d.key] = map[d.header] !== undefined ? map[d.header] : ""; });
  if (!settings.communityName) settings.communityName = "好日集 NANACACA";
  settings.currentBatchId = settings.currentBatchId || null;
  settings.cartHoldHours = Number(settings.cartHoldHours) || 24;
  settings.password = settings.password || "";

  let shippingMethods = readEntities_("寄送方式設定", SHIPPING_FIELDS);
  if (!shippingMethods.length) shippingMethods = defaultShippingMethods_();
  settings.shippingMethods = shippingMethods;
  return settings;
}

function writeSettings_(settings) {
  settings = settings || {};
  const sheet = ensureSheet_("設定", ["項目", "內容"]);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 2).setValues([["項目", "內容"]]);
  const rows = SETTINGS_DEFS.map(d => [d.header, settings[d.key] !== undefined ? settings[d.key] : ""]);
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  writeEntities_("寄送方式設定", SHIPPING_FIELDS, settings.shippingMethods || defaultShippingMethods_());
}

/* ---------------- 訂單：巢狀 recipient 物件 <-> 攤平欄位 ---------------- */

function readOrders_() {
  return readEntities_("訂單", ORDER_FIELDS).map(o => ({
    id: o.id, batchId: o.batchId, customerId: o.customerId,
    recipient: { name: o.recipientName, phone: o.recipientPhone, address: o.recipientAddress, shipMethod: o.shipMethod },
    shippingFee: o.shippingFee, status: o.status, createdAt: o.createdAt, updatedAt: o.updatedAt
  }));
}

function writeOrders_(orders) {
  const flat = (orders || []).map(o => ({
    id: o.id, batchId: o.batchId, customerId: o.customerId,
    recipientName: o.recipient && o.recipient.name,
    recipientPhone: o.recipient && o.recipient.phone,
    recipientAddress: o.recipient && o.recipient.address,
    shipMethod: o.recipient && o.recipient.shipMethod,
    shippingFee: o.shippingFee, status: o.status, createdAt: o.createdAt, updatedAt: o.updatedAt
  }));
  writeEntities_("訂單", ORDER_FIELDS, flat);
}

/* ---------------- 整包讀取（給後台頁面 loadAll 用） ---------------- */

function loadAllState_() {
  return {
    settings: readSettings_(),
    batches: readEntities_("期別", BATCH_FIELDS),
    products: readEntities_("商品", PRODUCT_FIELDS),
    seriesRules: readEntities_("系列組合價", SERIES_RULE_FIELDS),
    customers: readEntities_("顧客", CUSTOMER_FIELDS),
    orders: readOrders_(),
    orderItems: readEntities_("訂單明細", ORDER_ITEM_FIELDS),
    cartHolds: readEntities_("購物車暫存", CART_HOLD_FIELDS),
    costs: readEntities_("成本", COST_FIELDS),
    remittances: readEntities_("匯款回報", REMITTANCE_FIELDS)
  };
}

/* ---------------- Web app 入口 ---------------- */

function doGet(e) {
  try {
    const action = e.parameter.action;

    if (action === "loadAll") {
      const cached = readCache_();
      if (cached) return jsonOut_(cached);
      // 快取是空的（例如第一次使用）：從各分頁組出完整資料，同時順便把快取建起來
      const fresh = loadAllState_();
      writeCache_(fresh);
      return jsonOut_(fresh);
    }

    if (action === "orderSummary") {
      const cached = readCache_();
      const state = cached || loadAllState_();
      const order = state.orders.find(o => o.id === e.parameter.id);
      if (!order) return jsonOut_({ exists: false });
      const items = state.orderItems.filter(i => i.orderId === order.id).map(i => {
        const p = state.products.find(x => x.id === i.productId);
        return { name: p ? p.name : "商品", qty: i.qty, unitPrice: Number(i.unitPrice) || 0, subtotal: Number(i.subtotal) || 0 };
      });
      const itemsSubtotal = items.reduce((s, i) => s + i.subtotal, 0);
      const shippingFee = Number(order.shippingFee) || 0;
      const hasShippingInfo = !!(order.recipient && order.recipient.shipMethod);
      const batch = state.batches.find(b => b.id === order.batchId) || {};
      const priorRemittances = (state.remittances || []).filter(r => r.orderId === order.id);
      const reportedTotal = priorRemittances.reduce((s, r) => s + (Number(r.amount) || 0), 0);
      const total = itemsSubtotal + shippingFee;
      return jsonOut_({
        exists: true, id: order.id, communityName: state.settings.communityName,
        items: items, itemsSubtotal: itemsSubtotal, shippingFee: shippingFee, total: total,
        hasShippingInfo: hasShippingInfo, recipient: order.recipient || {},
        shippingMethods: state.settings.shippingMethods || [],
        bankCode: batch.bankCode || "", bankAccount: batch.bankAccount || "", bankHolder: batch.bankHolder || "",
        reportedCount: priorRemittances.length, reportedTotal: reportedTotal,
        remainingDue: Math.max(0, total - reportedTotal)
      });
    }

    return jsonOut_({ error: "unknown action" });
  } catch (err) {
    return jsonOut_({ error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    const payload = body.payload;

    if (action === "saveAll") {
      writeSettings_(payload.settings);
      writeEntities_("期別", BATCH_FIELDS, payload.batches);
      writeEntities_("商品", PRODUCT_FIELDS, payload.products);
      writeEntities_("系列組合價", SERIES_RULE_FIELDS, payload.seriesRules);
      writeEntities_("顧客", CUSTOMER_FIELDS, payload.customers);
      writeOrders_(payload.orders);
      writeEntities_("訂單明細", ORDER_ITEM_FIELDS, payload.orderItems);
      writeEntities_("購物車暫存", CART_HOLD_FIELDS, payload.cartHolds);
      writeEntities_("成本", COST_FIELDS, payload.costs);
      // 注意：這裡刻意不去動「匯款回報」分頁，交給下面兩個專屬動作處理。
      // 快取要重新整個組一次（不能直接拿 payload 存，因為 payload 裡的
      // remittances 可能是舊的——一定要用「匯款回報」分頁目前實際的內容）。
      const fresh = {
        settings: payload.settings, batches: payload.batches, products: payload.products,
        seriesRules: payload.seriesRules, customers: payload.customers, orders: payload.orders,
        orderItems: payload.orderItems, cartHolds: payload.cartHolds, costs: payload.costs,
        remittances: readEntities_("匯款回報", REMITTANCE_FIELDS)
      };
      writeCache_(fresh);
      return jsonOut_({ ok: true });
    }

    if (action === "submitShippingInfo") {
      const orders = readOrders_();
      const order = orders.find(o => o.id === payload.orderId);
      if (!order) return jsonOut_({ error: "訂單不存在" });
      const methods = readEntities_("寄送方式設定", SHIPPING_FIELDS);
      const method = methods.find(m => m.name === payload.shipMethod);
      order.recipient = { name: payload.name, phone: payload.phone, address: payload.address, shipMethod: payload.shipMethod };
      order.shippingFee = method ? (Number(method.fee) || 0) : (Number(payload.shippingFee) || 0);
      order.updatedAt = new Date().getTime();
      writeOrders_(orders);
      // 順便更新快取裡的這一筆，這樣後台不用等下一次 saveAll 才看得到
      const cached = readCache_();
      if (cached) {
        const idx = (cached.orders || []).findIndex(o => o.id === order.id);
        if (idx >= 0) cached.orders[idx] = order; else (cached.orders = cached.orders || []).push(order);
        writeCache_(cached);
      }
      return jsonOut_({ ok: true, shippingFee: order.shippingFee });
    }

    if (action === "submitRemittance") {
      const list = readEntities_("匯款回報", REMITTANCE_FIELDS);
      const record = Object.assign(
        { id: newId_("RMT"), createdAt: new Date().getTime(), status: "待核對" },
        payload
      );
      list.push(record);
      writeEntities_("匯款回報", REMITTANCE_FIELDS, list);
      const cached = readCache_();
      if (cached) { cached.remittances = list; writeCache_(cached); }
      try {
        MailApp.sendEmail({
          to: Session.getActiveUser().getEmail(),
          subject: "[代購] 新的匯款回報 － 訂單 " + payload.orderId,
          body: "顧客：" + payload.name + "（" + payload.phone + "）\n" +
                "訂單編號：" + payload.orderId + "\n" +
                "回報金額：" + payload.amount + "\n" +
                "後五碼：" + payload.last5 + "\n\n請至系統核對後標記為已付款。"
        });
      } catch (mailErr) {
        // 寄信失敗不影響回報本身已經存檔成功
      }
      return jsonOut_({ ok: true, record: record });
    }

    if (action === "confirmRemittance") {
      const list = readEntities_("匯款回報", REMITTANCE_FIELDS);
      const r = list.find(x => x.id === payload.id);
      if (r) {
        r.status = "已核對";
        writeEntities_("匯款回報", REMITTANCE_FIELDS, list);
        const cached = readCache_();
        if (cached) { cached.remittances = list; writeCache_(cached); }
      }
      return jsonOut_({ ok: true });
    }

    return jsonOut_({ error: "unknown action" });
  } catch (err) {
    return jsonOut_({ error: String(err) });
  }
}
