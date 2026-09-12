/* Shared shell: password gate + side nav + small helpers.
   Included by every internal page (not remit.html, which is public). */

const NC_SESSION_KEY = "nanacaca_unlocked";

function ncFmt(n) {
  return "NT$" + Math.round(Number(n) || 0).toLocaleString("zh-TW");
}

function ncRequireUnlock() {
  const pw = DB.getSettings().password;
  if (!pw) return true; // no password set yet (first run) — let settings page set one
  return sessionStorage.getItem(NC_SESSION_KEY) === "1";
}

function ncRenderLockScreen(onUnlock) {
  document.body.innerHTML = `
    <div class="lock-screen">
      <div class="lock-card">
        <div class="brand-mark">${DB.getSettings().communityName || "好日集 NANACACA"}</div>
        <p>代購管理平台・僅供操作者使用</p>
        <input type="password" id="ncPwInput" placeholder="請輸入密碼" autofocus />
        <div class="lock-error" id="ncPwErr"></div>
        <button class="btn btn-primary" id="ncPwBtn" style="width:100%">進入</button>
      </div>
    </div>`;
  const tryUnlock = () => {
    const val = document.getElementById("ncPwInput").value;
    if (val === DB.getSettings().password) {
      sessionStorage.setItem(NC_SESSION_KEY, "1");
      onUnlock();
    } else {
      document.getElementById("ncPwErr").textContent = "密碼不正確";
    }
  };
  document.getElementById("ncPwBtn").addEventListener("click", tryUnlock);
  document.getElementById("ncPwInput").addEventListener("keydown", e => { if (e.key === "Enter") tryUnlock(); });
}

const NC_NAV_ITEMS = [
  { href: "index.html", label: "總覽" },
  { href: "products.html", label: "商品輸入" },
  { href: "order.html", label: "顧客入單" },
  { href: "orders.html", label: "訂單" },
  { href: "costs.html", label: "成本利潤" },
  { href: "reports.html", label: "報表" },
  { href: "settings.html", label: "設定" }
];

function ncRenderShell(activeHref, contentHtml) {
  const settings = DB.getSettings();
  const batches = DB.listBatches();
  document.body.innerHTML = `
    <div class="app-shell">
      <aside class="sidenav">
        <div class="brand">${settings.communityName || "好日集"}<small>代購管理平台</small></div>
        <nav>
          ${NC_NAV_ITEMS.map(i => `<a href="${i.href}" class="${i.href === activeHref ? "active" : ""}">${i.label}</a>`).join("")}
        </nav>
        <button class="lock-btn" id="ncLockBtn">鎖定畫面</button>
      </aside>
      <main class="main">
        <div class="main-header">
          <h1 id="ncPageTitle"></h1>
          ${batches.length ? `
            <select class="period-pill" id="ncPeriodSelect">
              ${batches.map(b => `<option value="${b.id}" ${b.id===settings.currentBatchId?"selected":""}>目前期別：${b.name}</option>`).join("")}
            </select>` : `<span class="period-pill">尚未建立期別</span>`}
        </div>
        <div id="ncContent">${contentHtml}</div>
      </main>
    </div>`;
  document.getElementById("ncLockBtn").addEventListener("click", () => {
    sessionStorage.removeItem(NC_SESSION_KEY);
    location.reload();
  });
  const periodSelect = document.getElementById("ncPeriodSelect");
  if (periodSelect) {
    periodSelect.addEventListener("change", () => {
      DB.saveSettings({ currentBatchId: periodSelect.value });
      location.reload();
    });
  }
}

/* Call this at the top of every internal page.
   render(container) receives the #ncContent-equivalent and should build the page. */
function ncBoot(activeHref, pageTitle, render) {
  function paint() {
    DB.releaseExpiredHolds();
    const start = () => {
      ncRenderShell(activeHref, "");
      document.getElementById("ncPageTitle").textContent = pageTitle;
      render(document.getElementById("ncContent"));
    };
    if (ncRequireUnlock()) start();
    else ncRenderLockScreen(start);
  }

  const cached = localStorage.getItem(NC_KEY);
  if (cached) {
    // 先用本機上一次的資料立刻畫面，不用每次都等後端回應（後端讀取
    // Google Sheet 本來就需要幾秒鐘，等待會讓每個頁面都感覺很慢）。
    try {
      DB.state = ncMigrate(JSON.parse(cached));
      paint();
    } catch (e) { /* 本機資料壞掉就照舊等後端 */ }
  }

  if (!DB.state) {
    document.body.innerHTML = `<div style="min-height:100vh; display:flex; align-items:center; justify-content:center; color:var(--ink-soft); font-family:var(--font-body,sans-serif);">連線中…</div>`;
    DB.init().then(paint);
  } else {
    // 已經先畫出本機資料了，背景偷偷跟後端同步最新版本，不會打斷畫面。
    // 如果你剛好在另一台裝置改過資料，重新整理一次就會抓到最新的。
    DB.init();
  }
}
