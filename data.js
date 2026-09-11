/* ============================================================
   NANACACA 代購管理平台 — data layer
   -------------------------------------------------------------
   DEMO MODE: everything is read/written to localStorage so the
   whole app works immediately with no backend setup.

   GOING LIVE: replace the body of each function inside `DB` with
   a call to your GAS Web App (see Code.gs). Keep the function
   names/signatures the same and every page keeps working —
   that's the whole point of isolating this file. Look for
   "// --- swap point ---" comments below.
   ============================================================ */

const NC_KEY = "nanacaca_v1";

// 避免滑鼠滾輪／觸控板在數字欄位上意外改變數值
document.addEventListener("wheel", (e) => {
  if (document.activeElement && document.activeElement.type === "number") {
    document.activeElement.blur();
  }
}, { passive: true });

function defaultShippingMethods() {
  return [
    { id: ncId("SHP"), name: "郵寄（小於5KG）", fee: 100 },
    { id: ncId("SHP"), name: "郵寄（5-9KG）", fee: 180 },
    { id: ncId("SHP"), name: "賣貨便+39", fee: 39 },
    { id: ncId("SHP"), name: "特殊寄送（黑貓）", fee: 150 },
    { id: ncId("SHP"), name: "自取", fee: 0 }
  ];
}

function ncLoad() {
  const raw = localStorage.getItem(NC_KEY);
  const arrayFields = ["batches", "products", "seriesRules", "customers", "orders", "orderItems", "cartHolds", "costs", "remittances"];

  if (raw) {
    // Existing browsers may have saved data from before certain fields
    // existed (e.g. shippingMethods). Backfill anything missing so older
    // saves don't silently break newer features.
    const state = JSON.parse(raw);
    state.settings = state.settings || {};
    if (state.settings.communityName === undefined) state.settings.communityName = "好日集 NANACACA";
    if (state.settings.currentBatchId === undefined) state.settings.currentBatchId = null;
    if (state.settings.cartHoldHours === undefined) state.settings.cartHoldHours = 24;
    if (state.settings.password === undefined) state.settings.password = "";
    if (!Array.isArray(state.settings.shippingMethods)) state.settings.shippingMethods = defaultShippingMethods();
    arrayFields.forEach(k => { if (!Array.isArray(state[k])) state[k] = []; });
    ncSave(state);
    return state;
  }

  const seed = {
    settings: {
      communityName: "好日集 NANACACA",
      currentBatchId: null,
      cartHoldHours: 24,
      password: "", // set on first run via settings page
      shippingMethods: defaultShippingMethods()
    },
    batches: [],       // 期別
    products: [],       // 商品
    seriesRules: [],    // 系列組合價
    customers: [],       // 顧客
    orders: [],          // 訂單
    orderItems: [],      // 訂單明細
    cartHolds: [],       // 購物車暫存(預扣庫存)
    costs: [],           // 成本
    remittances: []      // 匯款回報
  };
  localStorage.setItem(NC_KEY, JSON.stringify(seed));
  return seed;
}

function ncSave(state) {
  localStorage.setItem(NC_KEY, JSON.stringify(state));
}

function ncId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ---------------- Business calculations (shared, pure functions) ---------------- */

// 成本(TWD) = 日幣金額 × (1 - 退稅手續費%/100) × (1 + 刷卡手續費%/100) × 匯率 + 運費
// 重量以「公斤」輸入，可填小數（例如200克 = 0.2），運費 = 重量(公斤) × 0.3
function calcCostTWD(p) {
  const jpy = Number(p.jpyAmount) || 0;
  const feePct = Number(p.cardFeePct) || 0;
  const taxRefundPct = Number(p.taxRefundFee) || 0;
  const rate = Number(p.exchangeRate) || 0;
  const weight = Number(p.weightKg) || 0;
  const shippingTWD = weight * 0.3;
  const netJPY = jpy * (1 - taxRefundPct / 100) * (1 + feePct / 100);
  const costTWD = netJPY * rate + shippingTWD;
  return { shippingTWD, costTWD: Math.round(costTWD * 100) / 100 };
}

// Given a series' rules + qty of that series in the cart, return unit price to charge
function tieredUnitPrice(basePrice, rules, seriesQty) {
  if (!rules || !rules.length) return basePrice;
  const applicable = rules
    .filter(r => seriesQty >= Number(r.thresholdQty))
    .sort((a, b) => Number(b.thresholdQty) - Number(a.thresholdQty))[0];
  return applicable ? Number(applicable.thresholdPrice) : basePrice;
}

/* ---------------- DB access object (the swap layer) ---------------- */

const DB = {
  state: ncLoad(),

  save() { ncSave(this.state); },

  // ---- settings ----
  getSettings() { return this.state.settings; },
  saveSettings(s) { Object.assign(this.state.settings, s); this.save(); },

  // ---- shipping methods (使用者可自訂新增/刪除) ----
  listShippingMethods() { return this.state.settings.shippingMethods || []; },
  upsertShippingMethod(m) {
    const list = this.state.settings.shippingMethods;
    const idx = list.findIndex(x => x.id === m.id);
    let saved;
    if (idx >= 0) { list[idx] = { ...list[idx], ...m }; saved = list[idx]; }
    else { saved = { id: ncId("SHP"), ...m }; list.push(saved); }
    this.save();
    return saved;
  },
  deleteShippingMethod(id) {
    this.state.settings.shippingMethods = this.state.settings.shippingMethods.filter(x => x.id !== id);
    this.save();
  },

  // ---- batches (期別) ----
  listBatches() { return this.state.batches; },
  createBatch(b) {
    const batch = { id: ncId("BAT"), status: "進行中", ...b };
    this.state.batches.push(batch);
    this.state.settings.currentBatchId = batch.id;
    // 常態商品：把最新一筆同名的常態商品複製到新期別，避免每次重打
    const latestByName = {};
    this.state.products.filter(p => p.isStanding).forEach(p => { latestByName[p.name] = p; });
    Object.values(latestByName).forEach(src => {
      const clone = { ...src, id: ncId("PRD"), batchId: batch.id, reserved: 0, sold: 0 };
      this.state.products.push(clone);
    });
    this.save();
    return batch;
  },
  updateBatch(id, patch) {
    const b = this.state.batches.find(x => x.id === id);
    if (b) { Object.assign(b, patch); this.save(); }
    return b;
  },

  // ---- products (商品) ----
  listProducts(batchId) { return this.state.products.filter(p => !batchId || p.batchId === batchId); },
  upsertProduct(p) {
    const calc = calcCostTWD(p);
    const record = { ...p, ...calc };
    const idx = this.state.products.findIndex(x => x.id === record.id);
    if (idx >= 0) this.state.products[idx] = record;
    else { record.id = record.id || ncId("PRD"); record.reserved = record.reserved || 0; record.sold = record.sold || 0; this.state.products.push(record); }
    this.save();
    return record;
  },
  deleteProduct(id) { this.state.products = this.state.products.filter(p => p.id !== id); this.save(); },
  availableStock(p) { return (Number(p.stockQty) || 0) - (Number(p.reserved) || 0) - (Number(p.sold) || 0); },

  // ---- series rules (組合價) ----
  rulesForSeries(seriesName, batchId) {
    return this.state.seriesRules.filter(r => r.seriesName === seriesName && r.batchId === batchId);
  },
  upsertSeriesRule(r) {
    const record = { id: r.id || ncId("RUL"), ...r };
    const idx = this.state.seriesRules.findIndex(x => x.id === record.id);
    if (idx >= 0) this.state.seriesRules[idx] = record; else this.state.seriesRules.push(record);
    this.save();
    return record;
  },
  deleteSeriesRule(id) { this.state.seriesRules = this.state.seriesRules.filter(r => r.id !== id); this.save(); },

  // ---- customers (顧客, matched by phone) ----
  findCustomerByPhone(phone) { return this.state.customers.find(c => c.phone === phone); },
  upsertCustomer(c) {
    let existing = c.phone ? this.findCustomerByPhone(c.phone) : null;
    if (existing) { Object.assign(existing, c); this.save(); return existing; }
    const record = { id: ncId("CUS"), ...c };
    this.state.customers.push(record);
    this.save();
    return record;
  },

  // ---- cart holds (預扣庫存, expire after settings.cartHoldHours) ----
  releaseExpiredHolds() {
    const hours = Number(this.state.settings.cartHoldHours) || 24;
    const cutoff = Date.now() - hours * 3600 * 1000;
    this.state.cartHolds.forEach(h => {
      if (h.status === "保留中" && h.createdAt < cutoff) {
        h.status = "已釋放";
        const p = this.state.products.find(x => x.id === h.productId);
        if (p) { p.reserved = Math.max(0, (Number(p.reserved) || 0) - Number(h.qty)); }
      }
    });
    this.save();
  },
  holdStock(productId, qty) {
    this.releaseExpiredHolds();
    const p = this.state.products.find(x => x.id === productId);
    if (!p) return { ok: false, msg: "找不到商品" };
    if (this.availableStock(p) < qty) return { ok: false, msg: "庫存不足" };
    p.reserved = (Number(p.reserved) || 0) + qty;
    const hold = { id: ncId("HLD"), productId, qty, createdAt: Date.now(), status: "保留中" };
    this.state.cartHolds.push(hold);
    this.save();
    return { ok: true, hold };
  },
  releaseHold(holdId) {
    const h = this.state.cartHolds.find(x => x.id === holdId);
    if (!h || h.status !== "保留中") return;
    h.status = "已釋放";
    const p = this.state.products.find(x => x.id === h.productId);
    if (p) p.reserved = Math.max(0, (Number(p.reserved) || 0) - Number(h.qty));
    this.save();
  },

  // ---- orders ----
  listOrders(batchId) { return this.state.orders.filter(o => !batchId || o.batchId === batchId); },
  getOrder(id) { return this.state.orders.find(o => o.id === id); },
  orderItemsFor(orderId) { return this.state.orderItems.filter(i => i.orderId === orderId); },

  findOpenOrderForCustomer(customerId, batchId) {
    return this.state.orders.find(o => o.customerId === customerId && o.batchId === batchId && o.status !== "已取消");
  },

  // cartLines: [{productId, qty, unitPrice}] ; holds: matching hold ids to convert
  submitOrder({ customer, batchId, cartLines, holdIds, shippingTWD, recipient }) {
    const cust = this.upsertCustomer(customer);
    let order = this.findOpenOrderForCustomer(cust.id, batchId);
    let isFirstForCustomer = false;
    if (!order) {
      isFirstForCustomer = true;
      order = {
        id: ncId("ORD"), batchId, customerId: cust.id,
        recipient: recipient || {}, shippingFee: shippingTWD || 0,
        status: "待付款", createdAt: Date.now(), updatedAt: Date.now()
      };
      this.state.orders.push(order);
    } else {
      order.updatedAt = Date.now();
      if (recipient) order.recipient = recipient; // allow updating recipient info
    }

    cartLines.forEach(line => {
      this.state.orderItems.push({
        id: ncId("ITM"), orderId: order.id, productId: line.productId,
        qty: line.qty, unitPrice: line.unitPrice, subtotal: line.qty * line.unitPrice
      });
      const p = this.state.products.find(x => x.id === line.productId);
      if (p) {
        p.sold = (Number(p.sold) || 0) + line.qty;
      }
    });

    (holdIds || []).forEach(hid => {
      const h = this.state.cartHolds.find(x => x.id === hid);
      if (h && h.status === "保留中") {
        h.status = "已轉訂單";
        const p = this.state.products.find(x => x.id === h.productId);
        if (p) p.reserved = Math.max(0, (Number(p.reserved) || 0) - Number(h.qty));
      }
    });

    this.save();
    return { order, isFirstForCustomer };
  },

  updateOrderStatus(orderId, status) {
    const o = this.getOrder(orderId);
    if (o) { o.status = status; o.updatedAt = Date.now(); this.save(); }
    return o;
  },

  orderTotal(orderId) {
    const items = this.orderItemsFor(orderId);
    const o = this.getOrder(orderId);
    const itemsTotal = items.reduce((s, i) => s + i.subtotal, 0);
    return itemsTotal + (o ? Number(o.shippingFee) || 0 : 0);
  },

  // ---- costs (成本) ----
  costsFor(batchId) { return this.state.costs.filter(c => c.batchId === batchId); },
  saveCost(batchId, cost) {
    let record = this.state.costs.find(c => c.batchId === batchId);
    if (!record) { record = { id: ncId("CST"), batchId }; this.state.costs.push(record); }
    Object.assign(record, cost);
    this.save();
    return record;
  },

  // ---- remittance reports (匯款回報, submitted from the public page) ----
  // --- swap point --- on the real backend this is written by the GAS
  // doPost() handler, not by the browser directly, to keep write access
  // off the public page. See Code.gs > submitRemittance().
  submitRemittance(r) {
    const record = { id: ncId("RMT"), createdAt: Date.now(), status: "待核對", ...r };
    this.state.remittances.push(record);
    this.save();
    return record;
  },
  listRemittances(orderId) { return this.state.remittances.filter(r => !orderId || r.orderId === orderId); },
  confirmRemittance(id) {
    const r = this.state.remittances.find(x => x.id === id);
    if (r) { r.status = "已核對"; this.save(); }
    return r;
  }
};

/* ---------------- Profit summary for a batch ---------------- */
function batchProfitSummary(batchId) {
  const orders = DB.listOrders(batchId);
  const revenue = orders.reduce((s, o) => s + DB.orderTotal(o.id), 0);
  const products = DB.listProducts(batchId);
  // 進貨成本＝本期所有商品的成本 × 庫存數量（採購當下就已花費，不論賣出與否）
  const cogs = products.reduce((s, p) => s + (Number(p.costTWD) || 0) * (Number(p.stockQty) || 0), 0);
  const cost = DB.costsFor(batchId)[0] || {};
  const tripCosts = ["flight", "hotel", "transport", "freeShippingSubsidy"]
    .reduce((s, k) => s + (Number(cost[k]) || 0), 0);
  return { revenue, cogs, tripCosts, profit: revenue - cogs - tripCosts };
}
