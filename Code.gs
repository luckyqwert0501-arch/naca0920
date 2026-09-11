/**
 * NANACACA 代購管理平台 — Google Apps Script backend template.
 *
 * HOW TO USE
 * 1. Create a new Google Sheet. Extensions > Apps Script, paste this file in as Code.gs.
 * 2. Run `setupSheets()` once (select it in the function dropdown, click ▶). This creates
 *    every tab and header row matching data.js's schema.
 * 3. Deploy > New deployment > type "Web app". Execute as: Me. Who has access:
 *    "Anyone" (needed so remit.html can submit without a Google login) — this is the
 *    same public/no-password tradeoff discussed for the remittance page; the admin
 *    pages themselves stay behind the site's own password screen, not a Google login.
 * 4. Copy the deployment URL. In the frontend, that becomes the base URL the app
 *    fetch()'s instead of reading/writing localStorage.
 *
 * This file implements the same actions as the DB object in data.js
 * (listProducts, upsertProduct, submitOrder, submitRemittance, etc.) so
 * porting the frontend later is a matter of swapping each DB.* function
 * body for a fetch() call to doPost(action, payload) below.
 */

const SHEET_NAMES = {
  settings: "Settings", batches: "Batches", products: "Products",
  seriesRules: "SeriesRules", customers: "Customers", orders: "Orders",
  orderItems: "OrderItems", cartHolds: "CartHolds", costs: "Costs",
  remittances: "Remittances"
};

const HEADERS = {
  Settings: ["key", "value"],
  Batches: ["id", "name", "status", "bankCode", "bankAccount", "bankHolder"],
  Products: ["id", "batchId", "purchaseType", "series", "name", "jpyAmount", "cardFeePct",
    "taxRefundFee", "exchangeRate", "weightKg", "shippingTWD", "costTWD", "sellPrice",
    "stockQty", "reserved", "sold", "receiptPhotoUrl"],
  SeriesRules: ["id", "batchId", "seriesName", "thresholdQty", "thresholdPrice"],
  Customers: ["id", "name", "phone", "lineName", "address"],
  Orders: ["id", "batchId", "customerId", "recipientName", "recipientPhone", "recipientAddress",
    "shipMethod", "shippingFee", "status", "createdAt", "updatedAt"],
  OrderItems: ["id", "orderId", "productId", "qty", "unitPrice", "subtotal"],
  CartHolds: ["id", "productId", "qty", "createdAt", "status"],
  Costs: ["id", "batchId", "flight", "hotel", "transport", "freeShippingSubsidy", "note"],
  Remittances: ["id", "orderId", "name", "phone", "amount", "last5", "createdAt", "status"]
};

function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.values(SHEET_NAMES).forEach(name => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
  });
}

function sheetByName(name) { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name); }

function readAll(name) {
  const sheet = sheetByName(name);
  const values = sheet.getDataRange().getValues();
  const headers = values.shift();
  return values.map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
}

function appendRow(name, obj) {
  const sheet = sheetByName(name);
  const headers = HEADERS[name];
  sheet.appendRow(headers.map(h => obj[h] !== undefined ? obj[h] : ""));
}

function updateRowById(name, id, patch) {
  const sheet = sheetByName(name);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf("id");
  for (let r = 1; r < data.length; r++) {
    if (data[r][idCol] === id) {
      headers.forEach((h, c) => { if (patch[h] !== undefined) sheet.getRange(r + 1, c + 1).setValue(patch[h]); });
      return true;
    }
  }
  return false;
}

function newId(prefix) { return prefix + new Date().getTime() + Math.floor(Math.random() * 1000); }

/* ---------------- Cost / pricing helpers (mirrors data.js) ---------------- */

function calcCostTWD(p) {
  const jpy = Number(p.jpyAmount) || 0;
  const feePct = Number(p.cardFeePct) || 0;
  const taxRefundPct = Number(p.taxRefundFee) || 0;
  const rate = Number(p.exchangeRate) || 0;
  const weight = Number(p.weightKg) || 0;
  const shippingTWD = weight * 0.3;
  const netJPY = jpy * (1 - taxRefundPct / 100) * (1 + feePct / 100);
  return { shippingTWD, costTWD: Math.round((netJPY * rate + shippingTWD) * 100) / 100 };
}

/* ---------------- Web app entry points ---------------- */

function doGet(e) {
  const action = e.parameter.action;
  let result;
  switch (action) {
    case "listProducts": result = readAll(SHEET_NAMES.products).filter(p => !e.parameter.batchId || p.batchId === e.parameter.batchId); break;
    case "listOrders": result = readAll(SHEET_NAMES.orders).filter(o => !e.parameter.batchId || o.batchId === e.parameter.batchId); break;
    case "getOrder": result = readAll(SHEET_NAMES.orders).find(o => o.id === e.parameter.id); break;
    default: result = { error: "unknown action" };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const action = body.action;
  let result;
  switch (action) {
    case "upsertProduct": result = upsertProduct(body.payload); break;
    case "submitRemittance": result = submitRemittance(body.payload); break;
    case "submitOrder": result = submitOrder(body.payload); break;
    default: result = { error: "unknown action" };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function upsertProduct(p) {
  const calc = calcCostTWD(p);
  const record = Object.assign({}, p, calc);
  if (!record.id) {
    record.id = newId("PRD");
    appendRow(SHEET_NAMES.products, record);
  } else {
    updateRowById(SHEET_NAMES.products, record.id, record);
  }
  return record;
}

function submitOrder(payload) {
  // payload: { customer, batchId, cartLines, shippingFee, recipient }
  const customers = readAll(SHEET_NAMES.customers);
  let customer = customers.find(c => c.phone === payload.customer.phone);
  if (!customer) {
    customer = Object.assign({ id: newId("CUS") }, payload.customer);
    appendRow(SHEET_NAMES.customers, customer);
  }
  const orders = readAll(SHEET_NAMES.orders);
  let order = orders.find(o => o.customerId === customer.id && o.batchId === payload.batchId && o.status !== "已取消");
  const now = new Date().getTime();
  if (!order) {
    order = {
      id: newId("ORD"), batchId: payload.batchId, customerId: customer.id,
      recipientName: payload.recipient.name, recipientPhone: payload.recipient.phone,
      recipientAddress: payload.recipient.address, shipMethod: payload.recipient.shipMethod,
      shippingFee: payload.shippingFee || 0, status: "待付款", createdAt: now, updatedAt: now
    };
    appendRow(SHEET_NAMES.orders, order);
  }
  payload.cartLines.forEach(line => {
    appendRow(SHEET_NAMES.orderItems, {
      id: newId("ITM"), orderId: order.id, productId: line.productId,
      qty: line.qty, unitPrice: line.unitPrice, subtotal: line.qty * line.unitPrice
    });
  });
  return { order };
}

function submitRemittance(payload) {
  const record = Object.assign({ id: newId("RMT"), createdAt: new Date().getTime(), status: "待核對" }, payload);
  appendRow(SHEET_NAMES.remittances, record);

  // Email notification — set your own address below.
  const notifyEmail = Session.getActiveUser().getEmail();
  MailApp.sendEmail({
    to: notifyEmail,
    subject: "[代購] 新的匯款回報 － 訂單 " + payload.orderId,
    body: "顧客：" + payload.name + "（" + payload.phone + "）\n" +
          "訂單編號：" + payload.orderId + "\n" +
          "回報金額：" + payload.amount + "\n" +
          "後五碼：" + payload.last5 + "\n\n請至系統核對後標記為已付款。"
  });

  return record;
}
