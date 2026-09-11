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
  DB.releaseExpiredHolds();
  const start = () => {
    ncRenderShell(activeHref, "");
    document.getElementById("ncPageTitle").textContent = pageTitle;
    render(document.getElementById("ncContent"));
  };
  if (ncRequireUnlock()) start();
  else ncRenderLockScreen(start);
}
