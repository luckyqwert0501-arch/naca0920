/* ============================================================
   NANACACA 代購管理平台 — data layer
   -------------------------------------------------------------
   LIVE MODE: on page load, DB.init() fetches the full state from
   your Google Apps Script backend (see Code.gs / config.js). After
   that, every DB.* method below reads/writes the in-memory
   `DB.state` object exactly like before — instant, no waiting —
   and DB.save() pushes the change to the backend in the
   background (fire-and-forget) plus keeps a local copy in
   localStorage as an offline fallback if the network is down.
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

// 補齊萬一缺少的欄位（例如舊資料、或後端剛建立還沒有任何資料時）
function ncMigrate(state) {
  state = state || {};
  const arrayFields = ["batches", "products", "seriesRules", "customers", "orders", "orderItems", "cartHolds", "costs", "remittances"];
  state.settings = state.settings || {};
  if (state.settings.communityName === undefined) state.settings.communityName = "好日集 NANACACA";
  if (state.settings.currentBatchId === undefined) state.settings.currentBatchId = null;
  if (state.settings.cartHoldHours === undefined) state.settings.cartHoldHours = 24;
  if (state.settings.password === undefined) state.settings.password = "";
  if (!Array.isArray(state.settings.shippingMethods)) state.settings.shippingMethods = defaultShippingMethods();
  arrayFields.forEach(k => { if (!Array.isArray(state[k])) state[k] = []; });
  return state;
}

// 本機備份/離線後援：只有在連不到後端時才會用到
function ncLoad() {
  const raw = localStorage.getItem(NC_KEY);
  const state = ncMigrate(raw ? JSON.parse(raw) : {});
  localStorage.setItem(NC_KEY, JSON.stringify(state));
  return state;
}

function ncId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ---------------- Business calculations (shared, pure functions) ---------------- */

// 成本(JPY) = 日幣金額 × (1 + 刷卡手續費% + 代買% － 退稅%)
// 成本(TWD) = 成本(JPY) × 匯率 ＋ 運費(重量公克 × 0.3)
function calcCostTWD(p) {
  const jpy = Number(p.jpyAmount) || 0;
  const feePct = Number(p.cardFeePct) || 0;
  const taxRefundPct = Number(p.taxRefundFee) || 0;
  const agentPct = Number(p.agentFeePct) || 0;
  const rate = Number(p.exchangeRate) || 0;
  const weight = Number(p.weightG) || 0;
  const shippingTWD = weight * 0.3;
  const jpyCost = jpy * (1 + feePct / 100 + agentPct / 100 - taxRefundPct / 100);
  const costTWD = jpyCost * rate + shippingTWD;
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
  state: null,
  ready: null,

  // 一定要在頁面渲染前呼叫並等待這個，會從後端抓最新資料填進 this.state
  init() {
    if (this.ready) return this.ready;
    this.ready = fetch(NC_GAS_URL + "?action=loadAll")
      .then(res => res.json())
      .then(data => {
        this.state = ncMigrate(data);
        localStorage.setItem(NC_KEY, JSON.stringify(this.state));
      })
      .catch(err => {
        console.error("無法連線到後端，暫時改用本機備份資料：", err);
        this.state = ncLoad();
      });
    return this.ready;
  },

  save() {
    localStorage.setItem(NC_KEY, JSON.stringify(this.state));
    // 發票照片只留在本機備份，不送到後端（單一儲存格放不下一張照片的
    // base64 資料，硬塞進去會讓整包同步失敗）。
    const syncState = { ...this.state, products: this.state.products.map(p => {
      const { receiptPhoto, ...rest } = p;
      return rest;
    }) };
    return fetch(NC_GAS_URL, {
      method: "POST",
      body: JSON.stringify({ action: "saveAll", payload: syncState })
    })
      .then(res => res.json())
      .then(data => {
        if (data && data.error) {
          console.error("後端存檔失敗：", data.error);
          throw new Error(data.error);
        }
        return data;
      })
      .catch(err => {
        console.error("同步到後端失敗（本機已經有存，但雲端可能沒更新到）：", err);
        throw err; // 讓真正需要「等存檔完成再繼續」的地方（例如送出訂單）能抓到失敗
      });
  },

  // 跟 init() 不同：一定會真的重新跟後端要一次最新資料（init() 只抓第一次，
  // 之後就重複用同一份）。顧客回報匯款是後端直接寫入的，不會自動反映在
  // 畫面上，需要時可以呼叫這個手動/自動刷新一次。
  refresh() {
    return fetch(NC_GAS_URL + "?action=loadAll")
      .then(res => res.json())
      .then(data => {
        this.state = ncMigrate(data);
        localStorage.setItem(NC_KEY, JSON.stringify(this.state));
      })
      .catch(err => console.error("重新整理失敗：", err));
  },

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
  // 注意：這裡故意不呼叫 this.save()。upsertCustomer 目前只會被 submitOrder
  // 呼叫，如果這裡自己也存檔一次，會跟 submitOrder 最後的存檔變成兩個各自
  // 送出的網路請求，彼此沒有先後保證，偶爾會讓比較早送出、但資料比較舊的
  // 這一次「後到」蓋掉後面才送出、資料完整的那一次，導致訂單看起來憑空
  // 消失。改成只更新本機資料，交給呼叫端（submitOrder）最後一次存檔。
  upsertCustomer(c) {
    let existing = c.phone ? this.findCustomerByPhone(c.phone) : null;
    if (existing) {
      // 生日只在第一次輸入時設定，之後即使再傳新值也不會覆蓋掉
      const patch = { ...c };
      if (existing.birthday) delete patch.birthday;
      Object.assign(existing, patch);
      return existing;
    }
    const record = { id: ncId("CUS"), ...c };
    this.state.customers.push(record);
    return record;
  },
  searchCustomers(query) {
    const q = (query || "").trim().toLowerCase();
    if (!q) return [];
    return this.state.customers.filter(c =>
      (c.name && c.name.toLowerCase().includes(q)) ||
      (c.lineName && c.lineName.toLowerCase().includes(q))
    ).slice(0, 8);
  },
  // 用來在訂單頁面補齊/修正顧客資料（例如當初急件沒填電話、生日）。
  // 電話/Line名稱/地址可以自由修改；生日一旦已經有值就不會被這裡覆蓋。
  updateCustomerFields(id, patch) {
    const c = this.state.customers.find(x => x.id === id);
    if (!c) return null;
    const safePatch = { ...patch };
    if (c.birthday) delete safePatch.birthday;
    Object.assign(c, safePatch);
    this.save();
    return c;
  },
  customerOrderCount(customerId) {
    return this.state.orders.filter(o => o.customerId === customerId).length;
  },
  // 刪除顧客本身，不會動到他過去的訂單紀錄（訂單上還是會留著這個顧客
  // 的名字/電話，只是這筆顧客資料以後不會再出現在搜尋或自動帶入裡）。
  deleteCustomer(id) {
    this.state.customers = this.state.customers.filter(c => c.id !== id);
    return this.save();
  },

  // ---- cart holds (預扣庫存, expire after settings.cartHoldHours) ----
  releaseExpiredHolds() {
    const hours = Number(this.state.settings.cartHoldHours) || 24;
    const cutoff = Date.now() - hours * 3600 * 1000;
    let releasedAny = false;
    this.state.cartHolds.forEach(h => {
      if (h.status === "保留中" && h.createdAt < cutoff) {
        h.status = "已釋放";
        releasedAny = true;
        const p = this.state.products.find(x => x.id === h.productId);
        if (p) { p.reserved = Math.max(0, (Number(p.reserved) || 0) - Number(h.qty)); }
      }
    });
    // 這裡以前不管有沒有真的釋放任何東西都會存檔一次——代表你只是「打開頁面」
    // 就會把瀏覽器裡當下這份（可能是舊的）資料整包回傳蓋掉後端，如果剛好是
    // 用很久沒開、資料比較舊的分頁/裝置打開，就會把其他裝置後來新增的訂單蓋掉。
    // 這正是訂單「不穩定、有時候不見」的根本原因，現在改成真的有變化才存檔。
    if (releasedAny) this.save();
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

    const saved = this.save();
    return { order, isFirstForCustomer, saved };
  },

  // ---- order editing ----
  // 這幾個都只改本機資料、不各自存檔，避免一次改好幾樣東西時觸發好幾個
  // 各自送出的網路請求互相搶（就是訂單消失那個 bug 的成因）。改完後由
  // 畫面上的「儲存訂單修改」按鈕統一呼叫一次 DB.save()。
  updateOrderRecipient(orderId, patch) {
    const o = this.getOrder(orderId);
    if (!o) return null;
    o.recipient = { ...o.recipient, ...(patch.recipient || {}) };
    if (patch.shippingFee !== undefined) o.shippingFee = patch.shippingFee;
    o.updatedAt = Date.now();
    return o;
  },
  setOrderItemQty(itemId, qty) {
    const item = this.state.orderItems.find(i => i.id === itemId);
    if (!item) return;
    const p = this.state.products.find(x => x.id === item.productId);
    const delta = qty - item.qty;
    if (p) p.sold = Math.max(0, (Number(p.sold) || 0) + delta);
    item.qty = qty;
    item.subtotal = qty * item.unitPrice;
  },
  removeOrderItem(itemId) {
    const idx = this.state.orderItems.findIndex(i => i.id === itemId);
    if (idx < 0) return;
    const item = this.state.orderItems[idx];
    const p = this.state.products.find(x => x.id === item.productId);
    if (p) p.sold = Math.max(0, (Number(p.sold) || 0) - item.qty);
    this.state.orderItems.splice(idx, 1);
  },
  addOrderItem(orderId, productId, qty, unitPrice) {
    this.state.orderItems.push({ id: ncId("ITM"), orderId, productId, qty, unitPrice, subtotal: qty * unitPrice });
    const p = this.state.products.find(x => x.id === productId);
    if (p) p.sold = (Number(p.sold) || 0) + qty;
  },
  // 刪除訂單是單一、獨立的操作，跟前面幾個不一樣：這裡直接存檔一次就好。
  deleteOrder(orderId) {
    const items = this.orderItemsFor(orderId);
    items.forEach(i => {
      const p = this.state.products.find(x => x.id === i.productId);
      if (p) p.sold = Math.max(0, (Number(p.sold) || 0) - i.qty);
    });
    this.state.orderItems = this.state.orderItems.filter(i => i.orderId !== orderId);
    this.state.orders = this.state.orders.filter(o => o.id !== orderId);
    return this.save();
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
  // 注意：正式上線後，顧客端的 remit.html 不會呼叫這個方法，而是直接打
  // Code.gs 的 submitRemittance 動作（避免公開頁面需要載入整包後台資料）。
  // 這裡保留是給後台自己需要時用，一樣會同步到後端。
  submitRemittance(r) {
    const record = { id: ncId("RMT"), createdAt: Date.now(), status: "待核對", ...r };
    this.state.remittances.push(record);
    this.save();
    fetch(NC_GAS_URL, {
      method: "POST",
      body: JSON.stringify({ action: "submitRemittance", payload: r })
    }).catch(err => console.error("回報同步失敗：", err));
    return record;
  },
  listRemittances(orderId) { return this.state.remittances.filter(r => !orderId || r.orderId === orderId); },
  confirmRemittance(id) {
    const r = this.state.remittances.find(x => x.id === id);
    if (r) {
      r.status = "已核對";
      this.save();
      fetch(NC_GAS_URL, {
        method: "POST",
        body: JSON.stringify({ action: "confirmRemittance", payload: { id } })
      }).catch(err => console.error("同步失敗：", err));
    }
    return r;
  }
};

/* ---------------- Profit summary for a batch ---------------- */
function batchProfitSummary(batchId) {
  const orders = DB.listOrders(batchId);
  const revenue = orders.reduce((s, o) => s + DB.orderTotal(o.id), 0);
  const products = DB.listProducts(batchId);
  // 進貨成本＝已經入單賣出的商品成本 × 數量（庫存常設成 9999 方便下單，不能拿來當作採購量）
  const cogs = products.reduce((s, p) => s + (Number(p.costTWD) || 0) * (Number(p.sold) || 0), 0);
  const cost = DB.costsFor(batchId)[0] || {};
  const tripCosts = ["flight", "hotel", "transport", "freeShippingSubsidy"]
    .reduce((s, k) => s + (Number(cost[k]) || 0), 0);
  return { revenue, cogs, tripCosts, profit: revenue - cogs - tripCosts };
}

/* ---------------- 顧客累計消費／利潤（跨所有期別） ---------------- */
function customerSummaries(batchId) {
  return DB.state.customers.map(c => {
    const orders = DB.state.orders.filter(o => o.customerId === c.id && o.status !== "已取消" && (!batchId || o.batchId === batchId));
    let totalSpent = 0, totalProfit = 0;
    orders.forEach(o => {
      const total = DB.orderTotal(o.id);
      totalSpent += total;
      const itemsCost = DB.orderItemsFor(o.id).reduce((s, i) => {
        const p = DB.state.products.find(x => x.id === i.productId);
        return s + (p ? Number(p.costTWD) || 0 : 0) * Number(i.qty);
      }, 0);
      totalProfit += total - itemsCost;
    });
    return { customer: c, orderCount: orders.length, totalSpent, totalProfit };
  }).filter(r => r.orderCount > 0).sort((a, b) => b.totalSpent - a.totalSpent);
}

/* ---------------- 每個期別的損益報表（本期＋過去） ---------------- */
function allBatchReports() {
  return DB.listBatches().map(b => ({
    batch: b,
    orderCount: DB.listOrders(b.id).length,
    ...batchProfitSummary(b.id)
  }));
}
