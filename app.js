const API_ORIGIN = window.VAULTX_API_BASE || (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:4000"
  : `${window.location.protocol}//${window.location.hostname}:4000`);
const API_BASE = `${API_ORIGIN.replace(/\/+$/, "")}/api`;
const DEPOSIT_REQUEST_TTL_MS = 20 * 60 * 1000;

// Expose logout immediately for the existing inline button in index.html.
// Keeping this at top level also makes the handler available if auth setup
// later encounters a runtime error.
function logoutVaultX() {
  localStorage.removeItem("vaultx_token");
  localStorage.removeItem("vaultx_user");
  sessionStorage.removeItem("vaultxPendingDepositId");
  window.location.reload();
}

const plans = [
  ["VIP 1", 50], ["VIP 2", 100], ["VIP 3", 200], ["VIP 4", 500], ["VIP 5", 1000],
  ["VIP 6", 1500], ["VIP 7", 2000], ["VIP 8", 6000], ["VIP 9", 15000], ["VIP 10", 35000]
];

let backendBalance = 0;
let transactions = [];
let savedWithdrawalAddresses = {};
let preferredWithdrawalNetwork = null;
let investments = [];
let investmentConfig = { termDays: 91, dailyRate: 0.13 };
let marketPreviousPrices = {};
let marketCurrentPrices = {};
let marketPreviousTickerPrices = {};
let referralData = null;
let notificationData = [];
let notificationLoadVersion = 0;

const charts = {};
const ids = { BTC: "btc", ETH: "eth", SOL: "sol", BNB: "bnb" };

function token() {
  return localStorage.getItem("vaultx_token");
}

function createIdempotencyKey() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();

  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }

  // Idempotency keys are unique request identifiers, not authentication secrets.
  return `vx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;

  const response = await fetch(API_BASE + path, { ...options, headers });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || "Invalid server response" }; }

  if (response.status === 401 && t) {
    localStorage.removeItem("vaultx_token");
    localStorage.removeItem("vaultx_user");
    const auth = document.getElementById("authScreen");
    if (auth) auth.style.display = "flex";
    throw new Error(data.error || "Your session has expired. Please log in again.");
  }

  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.code = data.code;
    throw error;
  }
  return data;
}

function setLoginFeedback(message, success = false) {
  const box = document.getElementById("authError");
  if (!box) return;
  box.textContent = message || "";
  box.classList.toggle("show", !!message);
  box.classList.toggle("success", !!message && success);
}

function setLoginLoading(value) {
  const loading = document.getElementById("authLoading");
  if (loading) loading.style.display = value ? "block" : "none";
  document.querySelectorAll("#loginForm .auth-submit").forEach((button) => { button.disabled = value; });
}

// Capture the login submit before the form can fall back to a page reload.
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.id !== "loginForm") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  setLoginFeedback("");
  setLoginLoading(true);
  const email = document.getElementById("loginEmail")?.value.trim() || "";
  const password = document.getElementById("loginPassword")?.value || "";
  try {
    const data = await api("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    localStorage.setItem("vaultx_token", data.token);
    localStorage.setItem("vaultx_user", JSON.stringify(data.user || {}));
    const auth = document.getElementById("authScreen");
    if (auth) auth.style.display = "none";
    await refreshAccount();
  } catch (error) {
    setLoginFeedback(error instanceof Error ? error.message : "Login failed. Please try again.");
    const resend = document.getElementById("resendVerificationBtn");
    if (error?.code === "EMAIL_NOT_VERIFIED" && resend) resend.style.display = "block";
  } finally {
    setLoginLoading(false);
  }
}, true);

function formatUSDT(value) {
  return Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function amountToUnits(value) {
  if (!/^\d+(?:\.\d{1,8})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100000000n + BigInt((fraction + "00000000").slice(0, 8));
}

function formatUSDTUnits(units) {
  const whole = (units / 100000000n).toLocaleString();
  const fraction = (units % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}.${(fraction || "00").padEnd(2, "0")}`;
}

function formatUSDTPrecise(value) {
  const units = amountToUnits(String(value ?? ""));
  return units === null ? formatUSDT(value) : formatUSDTUnits(units);
}

function setAllBalances(value) {
  backendBalance = Number(value) || 0;
  document.querySelectorAll(".bigbalance").forEach((el) => {
    el.textContent = `${formatUSDT(backendBalance)} USDT`;
  });
  const withdrawBalance = document.getElementById("withdrawBalance");
  if (withdrawBalance) withdrawBalance.textContent = `${formatUSDT(backendBalance)} USDT`;
}

function statusLabel(status) {
  return String(status || "").replace(/_/g, " ");
}

function transactionDisplayStatus(tx) {
  return tx.type === "DEPOSIT" && tx.status === "COMPLETED" ? "Verified" : statusLabel(tx.status);
}

function isDepositVerificationExpired(tx) {
  const createdAt = new Date(tx.createdAt).getTime();
  return !Number.isFinite(createdAt) || Date.now() >= createdAt + DEPOSIT_REQUEST_TTL_MS;
}

function depositTimerText(tx) {
  const createdAt = new Date(tx.createdAt).getTime();
  if (!Number.isFinite(createdAt)) return "";
  const remaining = Math.max(0, createdAt + DEPOSIT_REQUEST_TTL_MS - Date.now());
  if (tx.status === "PENDING" && remaining > 0) {
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    return ` · ${minutes}:${String(seconds).padStart(2, "0")} remaining`;
  }
  if (tx.status === "PENDING") return " · expiry reached; waiting for status update";
  if (tx.status === "FAILED") return " · expired; verification window closed";
  return "";
}

function txTypeLabel(type) {
  const labels = {
    DEPOSIT: "Deposit",
    WITHDRAWAL: "Withdrawal",
    INVESTMENT: "VIP investment",
    INVESTMENT_RETURN: "Investment return",
    REFERRAL_REWARD: "Referral reward",
    ADJUSTMENT: "Balance adjustment"
  };
  return labels[type] || type;
}

function txSign(type) {
  return ["DEPOSIT", "INVESTMENT_RETURN", "REFERRAL_REWARD", "ADJUSTMENT"].includes(type) ? "+" : "−";
}

function renderTransactions() {
  const el = document.getElementById("transactionHistory");
  if (!el) return;

  if (!transactions.length) {
    el.innerHTML = '<div class="empty">No transactions yet.</div>';
    return;
  }

  el.innerHTML = transactions.slice(0, 30).map((tx) => {
    let quantifyKind = "";
    if (tx.type === "INVESTMENT_RETURN" && tx.description) {
      try { quantifyKind = JSON.parse(tx.description).kind || ""; } catch {}
    }
    const isQuantifyClaim = ["daily_quantify_claim", "daily_quantify_credit"].includes(quantifyKind);
    const transactionLabel = quantifyKind === "daily_quantify_credit"
      ? "Daily quantify credit"
      : quantifyKind === "daily_quantify_claim"
        ? "Daily quantify request"
        : txTypeLabel(tx.type);
    const incoming = quantifyKind === "daily_quantify_credit" || (!isQuantifyClaim && ["DEPOSIT", "INVESTMENT_RETURN", "REFERRAL_REWARD"].includes(tx.type));
    const color = incoming ? "green" : "";
    const amount = Number(tx.amount || 0);
    const date = tx.createdAt ? new Date(tx.createdAt).toLocaleString() : "";
    let withdrawalDetails = "";
    if (tx.type === "WITHDRAWAL" && tx.description) {
      try {
        const detail = JSON.parse(tx.description);
        if (typeof detail.feeAmount === "string" && typeof detail.netAmount === "string") {
          withdrawalDetails = `Fee ${formatUSDTPrecise(detail.feeAmount)} · net ${formatUSDTPrecise(detail.netAmount)} USDT`;
        }
      } catch { /* Older transaction descriptions may not be JSON. */ }
    }
    const canVerifyDeposit = tx.type === "DEPOSIT" && ["PENDING", "FAILED", "REJECTED"].includes(tx.status);
    const verificationExpired = canVerifyDeposit && isDepositVerificationExpired(tx);
    const verifyDetails = canVerifyDeposit ? `
      <details class="transaction-verify${verificationExpired ? " is-expired" : ""}" data-verify-transaction-id="${tx.id}"${verificationExpired ? " inert" : ""}>
        <summary${verificationExpired ? ' tabindex="-1" aria-disabled="true"' : ""}>${verificationExpired ? "Verification window expired" : "Verify transaction"}</summary>
        <label for="historyTxHash-${tx.id}">Transaction ID / hash</label>
        <input id="historyTxHash-${tx.id}" autocomplete="off" placeholder="Paste the transaction ID from Binance"${verificationExpired ? " disabled" : ""}>
        <button class="btn primary full" type="button" onclick="verifyTransactionFromHistory('${tx.id}')"${verificationExpired ? " disabled" : ""}>Verify on blockchain</button>
        <small class="muted" id="historyVerifyMessage-${tx.id}">${verificationExpired ? "The 20-minute verification window has expired." : "An incorrect ID won’t change the pending timer or credit your balance."}</small>
      </details>` : "";
    return `
      <div class="row">
        <span style="display:flex;align-items:center;gap:9px">
          <span class="txicon">${incoming ? "↓" : "↑"}</span>
          <span>
            <b>${transactionLabel}</b>
            <small class="muted" style="display:block">${date}</small>
            ${withdrawalDetails ? `<small class="muted" style="display:block">${withdrawalDetails}</small>` : ""}
          </span>
        </span>
        <span style="text-align:right">
          <b class="${color}">${quantifyKind === "daily_quantify_claim" ? "Request " : txSign(tx.type)}${formatUSDT(amount)} ${tx.asset || "USDT"}</b>
          <small class="muted transaction-status${["PENDING", "FAILED", "REJECTED"].includes(tx.status) ? " is-attention" : ""}" data-transaction-id="${tx.id}" style="display:block">${transactionDisplayStatus(tx)}${tx.type === "DEPOSIT" ? depositTimerText(tx) : ""}</small>
        </span>
      </div>${verifyDetails}`;
  }).join("");
}

function updateDepositCountdowns() {
  document.querySelectorAll(".transaction-status[data-transaction-id]").forEach((element) => {
    const transaction = transactions.find((item) => item.id === element.dataset.transactionId);
    if (!transaction || transaction.type !== "DEPOSIT") return;
    element.textContent = `${transactionDisplayStatus(transaction)}${depositTimerText(transaction)}`;
    element.classList.toggle("is-attention", ["PENDING", "FAILED", "REJECTED"].includes(transaction.status));
    const verifyDetails = document.querySelector(`[data-verify-transaction-id="${transaction.id}"]`);
    if (verifyDetails && isDepositVerificationExpired(transaction) && !verifyDetails.inert) {
      verifyDetails.inert = true;
      verifyDetails.open = false;
      verifyDetails.classList.add("is-expired");
      const summary = verifyDetails.querySelector("summary");
      if (summary) {
        summary.textContent = "Verification window expired";
        summary.tabIndex = -1;
        summary.setAttribute("aria-disabled", "true");
      }
      verifyDetails.querySelectorAll("input, button").forEach((control) => { control.disabled = true; });
      const message = verifyDetails.querySelector("small");
      if (message) message.textContent = "The 20-minute verification window has expired.";
    }
  });
}

function renderRecentActivity() {
  const deposits = transactions.filter((x) => x.type === "DEPOSIT").slice(0, 3);
  const withdrawals = transactions.filter((x) => x.type === "WITHDRAWAL").slice(0, 3);
  const cards = document.querySelectorAll("#home .activity .card");
  if (cards.length < 2) return;

  const render = (items, positive) => items.length ? items.map((tx) => `
    <div class="row">
      <span>You</span>
      <span>${positive ? "+" : "−"}${formatUSDT(tx.amount)} USDT</span>
      <span class="status${["PENDING", "FAILED", "REJECTED"].includes(tx.status) ? " status-attention" : ""}">${statusLabel(tx.status)}</span>
    </div>`).join("") : '<div class="empty">No requests yet.</div>';

  cards[0].innerHTML = `<div class="label">Recent deposits</div>${render(deposits, true)}`;
  cards[1].innerHTML = `<div class="label">Recent withdrawals</div>${render(withdrawals, false)}`;
}

function calculateStats() {
  const totalDeposited = transactions.filter((x) => x.type === "DEPOSIT" && ["COMPLETED", "CONFIRMED"].includes(x.status))
    .reduce((sum, x) => sum + Number(x.amount), 0);
  const totalWithdrawn = transactions.filter((x) => x.type === "WITHDRAWAL" && x.status === "COMPLETED")
    .reduce((sum, x) => sum + Number(x.amount), 0);
  const totalReturns = transactions.filter((x) => x.type === "INVESTMENT_RETURN" && x.status === "COMPLETED")
    .reduce((sum, x) => sum + Number(x.amount), 0);
  const totalReferralRewards = transactions.filter((x) => x.type === "REFERRAL_REWARD" && x.status === "COMPLETED")
    .reduce((sum, x) => sum + Number(x.amount), 0);
  const active = investments.filter((x) => x.status === "ACTIVE");
  const projectedDaily = active.reduce((sum, x) => sum + Number(x.principal) * Number(x.dailyRate), 0);

  const stat = document.querySelectorAll("#home .stats .card");
  if (stat[0]) stat[0].querySelector(".value").textContent = `${formatUSDT(backendBalance)} USDT`;
  if (stat[1]) stat[1].querySelector(".value").textContent = `+${formatUSDT(projectedDaily)} USDT`;
  if (stat[2]) stat[2].querySelector(".value").textContent = String(active.length);
  if (stat[2]) stat[2].querySelector(".muted").textContent = active.length ? active.map((x) => `VIP${x.planLevel}`).join(" · ") : "No active plans";

  const meCards = document.querySelectorAll("#me .walletgrid .card");
  if (meCards[0]) meCards[0].querySelector(".value").textContent = `${formatUSDT(totalDeposited)} USDT`;
  if (meCards[1]) meCards[1].querySelector(".value").textContent = `${formatUSDT(totalWithdrawn)} USDT`;
  if (meCards[2]) meCards[2].querySelector(".value").textContent = `+${formatUSDT(totalReturns)} USDT`;
  if (meCards[3]) meCards[3].querySelector(".value").textContent = `${formatUSDT(totalReferralRewards)} USDT`;

  const meVipPill = document.getElementById("meVipPill");
  if (meVipPill) {
    meVipPill.textContent = active.length
      ? active.map((x) => `VIP ${x.planLevel}`).join(" · ")
      : "No active VIP plans";
  }
}

async function loadWallet() {
  if (!token()) return;
  const data = await api("/wallet");
  setAllBalances(data.wallet?.availableBalance ?? data.wallet?.balance ?? 0);
}

async function loadTransactions() {
  if (!token()) return;
  const data = await api("/transactions?limit=50");
  transactions = data.transactions || [];
  savedWithdrawalAddresses = {};
  preferredWithdrawalNetwork = null;
  for (const transaction of transactions) {
    if (transaction.type !== "WITHDRAWAL" || !transaction.description) continue;
    try {
      const detail = JSON.parse(transaction.description);
      if (detail.network === "BEP20" && typeof detail.address === "string" && detail.address.trim() && !savedWithdrawalAddresses[detail.network]) {
        savedWithdrawalAddresses[detail.network] = detail.address.trim();
        if (!preferredWithdrawalNetwork) preferredWithdrawalNetwork = detail.network;
      }
    } catch { /* Older withdrawal records may not include structured address details. */ }
  }
  renderSavedWithdrawalDetails();
  const selectedNetwork = preferredWithdrawalNetwork || document.getElementById("withdrawNetwork")?.value || "";
  const networkSelect = document.getElementById("withdrawNetwork");
  if (networkSelect && preferredWithdrawalNetwork) networkSelect.value = preferredWithdrawalNetwork;
  const withdrawalAddressInput = document.getElementById("withdrawAddress");
  if (withdrawalAddressInput && selectedNetwork) withdrawalAddressInput.value = savedWithdrawalAddresses[selectedNetwork] || "";
  updateWithdrawalAddressHint();
  renderTransactions();
  renderRecentActivity();
  calculateStats();
}

function renderSavedWithdrawalDetails() {
  const networkNode = document.getElementById("walletDetailsNetwork");
  const addressNode = document.getElementById("walletDetailsAddress");
  if (!networkNode || !addressNode) return;
  let latest = null;
  for (const latestWithdrawal of transactions) {
    if (latestWithdrawal.type !== "WITHDRAWAL" || !latestWithdrawal.description) continue;
    try {
      const detail = JSON.parse(latestWithdrawal.description);
      if (detail.network === "BEP20" && typeof detail.address === "string" && detail.address.trim()) {
        latest = detail;
        break;
      }
    } catch { /* Ignore legacy descriptions without a saved address. */ }
  }
  if (!latest) {
    networkNode.textContent = "No saved withdrawal address";
    addressNode.textContent = "No saved withdrawal address";
    networkNode.classList.add("muted");
    addressNode.classList.add("muted");
    return;
  }
  networkNode.textContent = "BNB Smart Chain (BEP20)";
  addressNode.textContent = latest.address.trim();
  networkNode.classList.remove("muted");
  addressNode.classList.remove("muted");
}

async function loadRecentWithdrawals() {
  const feed = document.getElementById("recentWithdrawalsFeed");
  if (!feed || !token()) return;

  try {
    const data = await api("/transactions/recent-withdrawals");
    const withdrawals = data.withdrawals || [];
    if (!withdrawals.length) {
      feed.innerHTML = '<div class="empty">No completed withdrawals yet.</div>';
      return;
    }

    feed.replaceChildren(...withdrawals.map((withdrawal) => {
      const row = document.createElement("div");
      row.className = "row";
      const account = document.createElement("span");
      account.textContent = withdrawal.account;
      const amount = document.createElement("b");
      amount.textContent = `${Number(withdrawal.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${withdrawal.asset}`;
      row.append(account, amount);
      return row;
    }));
  } catch {
    feed.innerHTML = '<div class="empty">Recent withdrawals are unavailable.</div>';
  }
}

async function loadInvestments() {
  if (!token()) return;
  const [data, plansData] = await Promise.all([
    api("/investments"),
    api("/investments/plans")
  ]);
  investments = data.investments || [];
  investmentConfig = plansData || investmentConfig;
  renderVIPs();
  calculateStats();
}

function updateGreeting() {
  const el = document.getElementById("greetingTitle");
  if (!el) return;
  const hour = new Date().getHours();
  const greeting = hour >= 5 && hour < 12 ? "Good morning" : hour >= 12 && hour < 17 ? "Good afternoon" : hour >= 17 && hour < 22 ? "Good evening" : "Good night";
  let name = "";
  try { name = JSON.parse(localStorage.getItem("vaultx_user") || "{}").name || ""; } catch {}
  el.textContent = `${greeting}${name ? `, ${name.split(" ")[0]}` : ""}`;
}

async function loadReferrals() {
  if (!token()) return;
  try {
    referralData = await api("/referrals");
    const code = referralData.referralCode || "—";
    const codeEl = document.getElementById("myReferralCode");
    if (codeEl) codeEl.textContent = code;
    const linkEl = document.getElementById("myReferralLink");
    if (linkEl) linkEl.textContent = `${location.origin}${location.pathname}?ref=${encodeURIComponent(code)}`;
    document.getElementById("refLevel1")?.replaceChildren(document.createTextNode(String(referralData.counts?.level1 || 0)));
    document.getElementById("refLevel2")?.replaceChildren(document.createTextNode(String(referralData.counts?.level2 || 0)));
    document.getElementById("refLevel3")?.replaceChildren(document.createTextNode(String(referralData.counts?.level3 || 0)));
    const team = document.querySelector("#home .stats .card:nth-child(4) .value");
    if (team) team.textContent = String(referralData.counts?.total || 0);
  } catch (error) { console.error("Referral load error:", error); }
}

function renderNotifications() {
  const list = document.getElementById("notificationList");
  const dot = document.getElementById("notifyDot");
  if (!list) return;
  if (!notificationData.length) { list.innerHTML = '<div class="empty">No notifications yet.</div>'; if (dot) dot.classList.add("hidden"); return; }
  const unread = notificationData.filter((n) => !n.readAt).length;
  if (dot) { dot.textContent = String(unread); dot.classList.toggle("hidden", unread === 0); }
  list.innerHTML = notificationData.map((n) => {
    const date = n.createdAt ? new Date(n.createdAt).toLocaleString() : "";
    return `<div class="notice-item ${n.readAt ? "" : "unread"}" data-notification-id="${String(n.id).replace(/[^a-zA-Z0-9_-]/g, "")}"><div class="notice-icon">✓</div><div><b>${String(n.title).replace(/[<>]/g, "")}</b><small>${String(n.body).replace(/[<>]/g, "")} · ${date}</small></div></div>`;
  }).join("");
}

async function loadNotifications() {
  if (!token()) return;
  const requestVersion = ++notificationLoadVersion;
  try {
    const data = await api("/notifications");
    if (requestVersion !== notificationLoadVersion) return;
    notificationData = data.notifications || [];
    renderNotifications();
  }
  catch (error) { console.error("Notification load error:", error); }
}

async function refreshAccount() {
  try {
    await Promise.all([loadWallet(), loadTransactions(), loadRecentWithdrawals(), loadInvestments(), loadReferrals(), loadNotifications()]);
    setAllBalances(backendBalance);
  } catch (error) {
    console.error("VaultX account refresh error:", error);
    showVaultToast("Account refresh", error.message);
  }
}

function renderVIPs() {
  const grid = document.getElementById("vipgrid");
  if (!grid) return;

  const activeInvestments = new Map(
    investments
      .filter((x) => x.status === "ACTIVE")
      .map((x) => [Number(x.planLevel), x])
  );

  // Frontend display only: show projections for the requested 91-day term.
  // This does not change the backend's investment or crediting rules.
  const dailyRate = Number(investmentConfig.dailyRate || 0.13);
  const termDays = 91;

  grid.innerHTML = plans.map((plan, index) => {
    const level = index + 1;
    const amount = Number(plan[1]);
    const activeInvestment = activeInvestments.get(level);
    const active = Boolean(activeInvestment);
    const canFund = backendBalance >= amount;
    const daily = amount * dailyRate;
    const profit = daily * termDays;
    const total = amount + profit;

    return `
      <div class="card vip ${active ? "unlocked" : "locked"}" style="position:relative;overflow:hidden;">
        <h3>${plan[0]}</h3>

        <div class="amount">
          ${amount.toLocaleString()} USDT
        </div>

        <div class="daily">
          +${formatUSDT(daily)} USDT / day*
        </div>

        <div class="meta">
          <div>
            <b>91 days</b>
            <span>Configured term</span>
          </div>
          <div>
            <b>${formatUSDT(profit)} USDT</b>
            <span>Projected profit*</span>
          </div>
        </div>

        <div class="meta">
          <div>
            <b>${formatUSDT(total)} USDT</b>
            <span>Projected maturity total*</span>
          </div>
          <div>
            <b>Principal returned</b>
            <span>At maturity</span>
          </div>
        </div>

        ${active
          ? `
            <div class="btn secondary full" aria-label="VIP plan active">✓ Active</div>
            <div class="quantify-note">Daily credit window: 15:00–15:30 EAT.</div>
            <button class="btn primary full quantify-btn"
              data-investment-id="${String(activeInvestment.id).replace(/[^a-zA-Z0-9_-]/g, "")}" 
              data-claimed-today="${activeInvestment.quantifiedToday ? "true" : "false"}"
              onclick="quantifyInvestment('${String(activeInvestment.id).replace(/[^a-zA-Z0-9_-]/g, "")}')">
              Quantify
            </button>
          `
          : `
            <div class="vip-lock-panel">
              <div class="lock-box">
                <div class="lock">🔒</div>
                <b>VIP locked</b>
                <span>Fund ${amount.toLocaleString()} USDT to activate</span>
                <button
                  class="btn ${canFund ? "primary" : "secondary"} unlock-btn"
                  onclick="unlockVIP(${level})"
                  ${canFund ? "" : "disabled"}
                >
                  ${canFund ? "Activate plan" : "Insufficient balance"}
                </button>
              </div>
            </div>
          `}
      </div>
    `;
  }).join("");
  refreshQuantifyButtons();
}

function eatClock() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { hour: Number(values.hour), minute: Number(values.minute) };
}

function refreshQuantifyButtons() {
  const { hour, minute } = eatClock();
  const isOpen = hour === 15 && minute < 30;
  document.querySelectorAll(".quantify-btn").forEach((button) => {
    const claimed = button.dataset.claimedToday === "true";
    button.disabled = claimed || !isOpen;
    button.textContent = "Quantify";
    button.title = claimed
      ? "Today's return has already been credited."
      : isOpen
        ? "Credit today's return."
        : "Available daily from 15:00 to 15:30 EAT.";
    button.classList.toggle("secondary", claimed || !isOpen);
    button.classList.toggle("primary", !claimed && isOpen);
  });
}

function showQuantifySuccess(amount) {
  let modal = document.getElementById("quantifySuccessModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "quantifySuccessModal";
    modal.className = "modal hidden";
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="modal-content quantify-success-card" role="dialog" aria-modal="true" aria-labelledby="quantifySuccessTitle">
        <button type="button" class="modal-close" aria-label="Close" data-quantify-close>×</button>
        <div class="quantify-success-icon" aria-hidden="true">✓</div>
        <h2 id="quantifySuccessTitle">Quantify successful</h2>
        <p class="quantify-success-caption">You have received</p>
        <div class="quantify-success-amount" id="quantifySuccessAmount">0.00 USDT</div>
        <p class="quantify-success-caption">Your wallet balance has been refreshed.</p>
        <button type="button" class="btn primary full" data-quantify-close>Done</button>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (event) => {
      if (event.target === modal || event.target.closest("[data-quantify-close]")) {
        modal.classList.add("hidden");
        modal.setAttribute("aria-hidden", "true");
        if (!document.querySelector(".modal:not(.hidden)")) document.body.classList.remove("modal-open");
      }
    });
    const style = document.createElement("style");
    style.id = "quantifySuccessStyles";
    style.textContent = `
      #quantifySuccessModal { z-index: 10050; display: flex; align-items: center; justify-content: center; padding: 20px; }
      #quantifySuccessModal.hidden { display: none; }
      #quantifySuccessModal .quantify-success-card { position: relative; width: min(100%, 390px); padding: 30px 24px 24px; border-radius: 20px; text-align: center; background: var(--card, #101a25); color: var(--text, #fff); box-shadow: 0 22px 70px rgba(0,0,0,.38); }
      #quantifySuccessModal .modal-close { position: absolute; top: 10px; right: 14px; border: 0; background: transparent; color: inherit; font-size: 28px; cursor: pointer; }
      #quantifySuccessModal .quantify-success-icon { display: grid; place-items: center; width: 58px; height: 58px; margin: 0 auto 14px; border-radius: 50%; background: rgba(53,208,160,.16); color: #35d0a0; font-size: 32px; font-weight: 700; }
      #quantifySuccessModal h2 { margin: 0 0 16px; }
      #quantifySuccessModal .quantify-success-caption { margin: 8px 0; opacity: .75; }
      #quantifySuccessModal .quantify-success-amount { margin: 8px 0 18px; color: #35d0a0; font-size: clamp(25px, 7vw, 34px); font-weight: 800; overflow-wrap: anywhere; }
    `;
    document.head.appendChild(style);
  }
  document.getElementById("quantifySuccessAmount").textContent = `${formatUSDT(amount)} USDT`;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

async function quantifyInvestment(investmentId) {
  const button = document.querySelector(`.quantify-btn[data-investment-id="${CSS.escape(investmentId)}"]`);
  if (!button || button.disabled) return;
  button.disabled = true;
  try {
    const result = await api(`/investments/${encodeURIComponent(investmentId)}/quantify`, { method: "POST" });
    button.dataset.claimedToday = "true";
    await refreshAccount();
    const investment = investments.find((item) => String(item.id) === String(investmentId));
    const responseAmount = result.amount ?? result.creditedAmount ?? result.creditAmount ?? result.transaction?.amount;
    const displayAmount = responseAmount != null
      ? Number(responseAmount)
      : Number(investment?.principal || 0) * Number(investment?.dailyRate ?? investmentConfig.dailyRate ?? 0.13);
    refreshQuantifyButtons();
    showQuantifySuccess(displayAmount);
  } catch (error) {
    showVaultToast("Quantify unavailable", error.message || "Could not submit the request.");
    await loadInvestments().catch(() => {});
  } finally {
    refreshQuantifyButtons();
  }
}

window.setInterval(refreshQuantifyButtons, 15_000);

async function unlockVIP(level) {
  const plan = plans[level - 1];
  if (!plan) return;

  const amount = Number(plan[1]);

  if (backendBalance < amount) {
    alert(`Insufficient wallet balance. ${plan[0]} requires ${amount.toLocaleString()} USDT.`);
    show("me");
    return;
  }

  try {
    const data = await api("/investments", {
      method: "POST",
      body: JSON.stringify({ planLevel: level })
    });

    alert(
      `${plan[0]} activated successfully.\n\n` +
      `Investment: ${formatUSDT(amount)} USDT\n` +
      `Term: 91 days`
    );

    await refreshAccount();
  } catch (error) {
    alert(error.message || "Could not activate the VIP plan.");
  }
}

async function toggleNotifications() {
  const panel = document.getElementById("notifyPanel");
  panel?.classList.toggle("hidden");
  if (!panel?.classList.contains("hidden")) {
    const unread = notificationData.filter((notification) => !notification.readAt);
    if (!unread.length) return;

    // Ignore notification refreshes that started before these read updates complete.
    notificationLoadVersion += 1;
    const readAt = new Date().toISOString();
    const results = await Promise.allSettled(unread.map((notification) =>
      api(`/notifications/${encodeURIComponent(notification.id)}/read`, { method: "POST" })
    ));
    const markedRead = new Set();
    results.forEach((result, index) => {
      if (result.status === "fulfilled") markedRead.add(unread[index].id);
      else console.error("Notification read update error:", result.reason);
    });
    notificationData = notificationData.map((notification) =>
      markedRead.has(notification.id) ? { ...notification, readAt } : notification
    );
    renderNotifications();
  }
}

function show(id) {
  document.querySelectorAll("main section").forEach((s) => s.classList.add("hidden"));
  document.getElementById(id)?.classList.remove("hidden");
  document.querySelectorAll("nav a,.bottom a").forEach((a) => a.classList.remove("active"));
  document.querySelectorAll(`[href="#${id}"]`).forEach((a) => a.classList.add("active"));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function copyCode() {
  const code = referralData?.referralCode || document.getElementById("myReferralCode")?.textContent || "";
  if (!code || code === "Loading…") return;
  navigator.clipboard?.writeText(code);
  alert(`Invite code copied: ${code}`);
}

function copyReferralLink() {
  const code = referralData?.referralCode || "";
  if (!code) return;
  const link = `${location.origin}${location.pathname}?ref=${encodeURIComponent(code)}`;
  navigator.clipboard?.writeText(link);
  alert("Referral link copied.");
}

async function copyDepositAddress() {
  const display = document.getElementById("depositAddressDisplay");
  const address = display?.textContent.trim().split(/\s+·\s+/)[0] || "";
  if (!address) return;
  try {
    await navigator.clipboard.writeText(address);
    showVaultToast("Address copied", "Deposit address copied to clipboard.");
  } catch {
    alert("Unable to copy the deposit address. Please select and copy it manually.");
  }
}

function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("hidden");
  el.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add("hidden");
  el.setAttribute("aria-hidden", "true");
  if (!document.querySelector(".modal:not(.hidden)")) document.body.classList.remove("modal-open");
}

let loadedDepositAddress = "";
let loadedDepositNetwork = "";

function openDeposit() {
  openModal("depositModal");
  document.getElementById("depositQrBox")?.classList.add("hidden");
  const qrToggle = document.getElementById("depositQrToggle");
  if (qrToggle) qrToggle.textContent = "Show QR code";
  const manualCheck = document.getElementById("depositManualCheck");
  const requestButton = document.getElementById("submitDepositButton");
  if (activeDepositRequestId) {
    manualCheck?.classList.remove("hidden");
    if (manualCheck) manualCheck.open = true;
    if (requestButton) { requestButton.disabled = true; requestButton.textContent = "Request created · pending"; }
    document.getElementById("depositStatus").textContent = "This request is pending. After the transfer confirms, paste its transaction ID in Transaction history to verify it.";
  } else {
    document.getElementById("depositManualCheck")?.classList.add("hidden");
    document.getElementById("depositStatus").textContent = "Enter the amount you plan to send, then create a request. Verification uses the transfer’s transaction ID.";
    if (requestButton) { requestButton.disabled = false; requestButton.textContent = "Create deposit request"; }
  }
  void loadDepositAddress();
}

async function loadDepositAddress() {
  const network = document.getElementById("depositNetwork")?.value || "";
  const display = document.getElementById("depositAddressDisplay");
  const copyButton = document.querySelector("#depositModal button[onclick='copyDepositAddress()']");
  const qrToggle = document.getElementById("depositQrToggle");
  if (!network || !display) return;
  document.getElementById("depositQrBox")?.classList.add("hidden");
  if (qrToggle) qrToggle.textContent = "Show QR code";
  loadedDepositAddress = "";
  loadedDepositNetwork = "";
  display.textContent = "Loading deposit address…";
  if (copyButton) copyButton.disabled = true;
  if (qrToggle) qrToggle.disabled = true;
  try {
    const data = await api(`/wallet/deposit-address?network=${encodeURIComponent(network)}`);
    if (document.getElementById("depositNetwork")?.value !== network) return;
    loadedDepositAddress = data.depositAddress;
    loadedDepositNetwork = data.network;
    display.textContent = `${data.depositAddress} · ${data.network}`;
    window.renderDepositQr(data.depositAddress, document.getElementById("depositQrCode"));
    if (copyButton) copyButton.disabled = false;
    if (qrToggle) qrToggle.disabled = false;
  } catch (error) {
    if (document.getElementById("depositNetwork")?.value !== network) return;
    display.textContent = error.message || "Could not load the deposit address.";
    if (qrToggle) qrToggle.disabled = true;
  }
}

function toggleDepositQr() {
  if (!loadedDepositAddress) return;
  const panel = document.getElementById("depositQrBox");
  const button = document.getElementById("depositQrToggle");
  if (!panel || !button) return;
  const isHidden = panel.classList.toggle("hidden");
  button.textContent = isHidden ? "Show QR code" : "Hide QR code";
}

function openWithdraw() {
  setAllBalances(backendBalance);
  updateWithdrawalQuote();
  const withdrawalPasswordInput = document.getElementById("withdrawalPassword");
  if (withdrawalPasswordInput) withdrawalPasswordInput.value = "";
  const networkSelect = document.getElementById("withdrawNetwork");
  if (networkSelect && preferredWithdrawalNetwork && savedWithdrawalAddresses[preferredWithdrawalNetwork]) networkSelect.value = preferredWithdrawalNetwork;
  const network = networkSelect?.value || "BEP20";
  const addressInput = document.getElementById("withdrawAddress");
  if (addressInput) addressInput.value = savedWithdrawalAddresses[network] || "";
  updateWithdrawalAddressHint();
  openModal("withdrawModal");
}
function forceCloseWithdrawal() { closeModal("withdrawModal"); }
function setAmount(id, value) { const el = document.getElementById(id); if (el) el.value = value; }
let activeDepositRequestId = null;
let depositStatusTimer = null;

function clearDepositStatusMonitor() {
  if (depositStatusTimer) clearInterval(depositStatusTimer);
  depositStatusTimer = null;
  activeDepositRequestId = null;
  sessionStorage.removeItem("vaultxPendingDepositId");
}

async function pollDepositStatus() {
  if (!activeDepositRequestId || !token()) return;
  const status = document.getElementById("depositStatus");
  try {
    const data = await api("/transactions?limit=100");
    const transaction = (data.transactions || []).find((item) => item.id === activeDepositRequestId);
    if (!transaction) {
      if (status) status.textContent = "Still checking for this deposit request…";
      return;
    }
    if (transaction.status === "COMPLETED") {
      if (status) status.textContent = "Transfer confirmed and credited to your VaultX balance.";
      clearDepositStatusMonitor();
      document.getElementById("depositNetwork").disabled = false;
      const requestButton = document.getElementById("submitDepositButton");
      if (requestButton) { requestButton.disabled = false; requestButton.textContent = "Create deposit request"; }
      showVaultToast("Deposit credited", "The confirmed USDT transfer was added to your balance.");
      await refreshAccount();
      return;
    }
    if (transaction.status === "FAILED" || transaction.status === "CANCELLED") {
      if (status) status.textContent = transaction.status === "FAILED"
        ? "Deposit request expired after 20 minutes. If you sent the transfer before expiry, verify it from Transaction history with the transaction ID."
        : "Deposit request cancelled.";
      clearDepositStatusMonitor();
      document.getElementById("depositNetwork").disabled = false;
      const requestButton = document.getElementById("submitDepositButton");
      if (requestButton) { requestButton.disabled = false; requestButton.textContent = "Create deposit request"; }
      try { await refreshAccount(); } catch { /* Keep the failed deposit status visible if account refresh fails. */ }
      return;
    }
    if (status) status.textContent = "Request pending. After the transfer confirms, verify it with its transaction ID in Transaction history.";
  } catch {
    if (status) status.textContent = "Transfer monitoring is temporarily unavailable. You can keep this request open or verify manually below.";
  }
}

function startDepositStatusMonitor(requestId) {
  activeDepositRequestId = requestId;
  sessionStorage.setItem("vaultxPendingDepositId", requestId);
  if (depositStatusTimer) clearInterval(depositStatusTimer);
  void pollDepositStatus();
  depositStatusTimer = setInterval(() => void pollDepositStatus(), 10_000);
}

function resumeDepositStatusMonitor() {
  const requestId = sessionStorage.getItem("vaultxPendingDepositId");
  if (requestId && token()) startDepositStatusMonitor(requestId);
}

async function submitDeposit() {
  if (activeDepositRequestId) return alert("A deposit request is already being monitored. Wait for it to finish or verify it below.");
  const amount = document.getElementById("depositAmount")?.value.trim() || "";
  const network = document.getElementById("depositNetwork")?.value || "";
  if (!/^\d+(?:\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) return alert("Enter a valid USDT amount with up to 6 decimal places.");
  if (!token()) return alert("Please log in again before making a deposit.");
  if (loadedDepositNetwork !== network || !loadedDepositAddress) return alert("Wait for the deposit address to load before creating a request.");

  try {
    const data = await api("/wallet/deposit", {
      method: "POST",
      headers: { "Idempotency-Key": createIdempotencyKey() },
      body: JSON.stringify({ amount, network })
    });
    const tx = data.transaction;
    startDepositStatusMonitor(tx.id);
    document.getElementById("depositAddressDisplay").textContent = `${tx.depositAddress} · ${tx.network}`;
    loadedDepositAddress = tx.depositAddress;
    loadedDepositNetwork = tx.network;
    window.renderDepositQr(tx.depositAddress, document.getElementById("depositQrCode"));
    document.getElementById("depositManualCheck").classList.remove("hidden");
    document.getElementById("depositStatus").textContent = tx.automaticMonitoring
      ? "Waiting for the transfer to arrive and receive network confirmations…"
      : "Request created. After the transfer confirms, verify it with its transaction ID in Transaction history.";
    document.getElementById("depositTxHash").value = "";
    document.getElementById("depositNetwork").disabled = true;
    const requestButton = document.getElementById("submitDepositButton");
    if (requestButton) { requestButton.disabled = true; requestButton.textContent = "Request created · pending"; }
    showVaultToast("Deposit request created", `Send about ${formatUSDT(tx.amount)} USDT on ${tx.network}. After it confirms, verify it with the transaction ID in Transaction history.`);
    document.getElementById("depositAmount").value = "";
    await refreshAccount();
    closeModal("depositModal");
    show("me");
    window.setTimeout(() => document.getElementById("transactionHistory")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
  } catch (error) {
    alert(error.message);
  }
}

async function verifyDeposit() {
  if (!activeDepositRequestId) return alert("Create a deposit request first.");
  const txHash = document.getElementById("depositTxHash")?.value.trim() || "";
  if (!txHash) return alert("Paste the transaction ID from your wallet.");
  try {
    const data = await api(`/wallet/deposit/${encodeURIComponent(activeDepositRequestId)}/verify`, {
      method: "POST", body: JSON.stringify({ txHash })
    });
    showVaultToast("Deposit verified", data.message || "The confirmed on-chain transfer was credited.");
    clearDepositStatusMonitor();
    document.getElementById("depositManualCheck").classList.add("hidden");
    document.getElementById("depositNetwork").disabled = false;
    const requestButton = document.getElementById("submitDepositButton");
    if (requestButton) { requestButton.disabled = false; requestButton.textContent = "Create deposit request"; }
    closeModal("depositModal");
    await refreshAccount();
  } catch (error) { alert(error.message); }
}

async function verifyTransactionFromHistory(transactionId) {
  const transaction = transactions.find((item) => item.id === transactionId);
  if (!transaction || isDepositVerificationExpired(transaction)) {
    const message = document.getElementById(`historyVerifyMessage-${transactionId}`);
    if (message) message.textContent = "The 20-minute verification window has expired.";
    return;
  }
  const input = document.getElementById(`historyTxHash-${transactionId}`);
  const message = document.getElementById(`historyVerifyMessage-${transactionId}`);
  const txHash = input?.value.trim() || "";
  if (!txHash) {
    if (message) message.textContent = "Paste the transaction ID from Binance first.";
    return;
  }
  const button = input?.parentElement?.querySelector("button");
  if (button) { button.disabled = true; button.textContent = "Checking blockchain…"; }
  if (message) message.textContent = "Checking the transaction, network, and receiving address…";
  try {
    const data = await api(`/wallet/deposit/${encodeURIComponent(transactionId)}/verify`, {
      method: "POST", body: JSON.stringify({ txHash })
    });
    if (message) message.textContent = data.message || "Transaction verified and deposit credited.";
    showVaultToast("Deposit verified", data.message || "The confirmed transfer was credited.");
    if (activeDepositRequestId === transactionId) clearDepositStatusMonitor();
    await refreshAccount();
  } catch (error) {
    if (message) message.textContent = error.message || "Transaction could not be verified. The request timer continues.";
  } finally {
    if (button) { button.disabled = false; button.textContent = "Verify on blockchain"; }
  }
}

async function submitWithdraw() {
  const amount = document.getElementById("withdrawAmount")?.value.trim() || "";
  const address = document.getElementById("withdrawAddress")?.value.trim();
  const network = document.getElementById("withdrawNetwork")?.value || "";
  const withdrawalPassword = document.getElementById("withdrawalPassword")?.value || "";

  if (!/^\d+(?:\.\d{1,8})?$/.test(amount) || Number(amount) <= 0) return alert("Enter a valid withdrawal amount with up to 8 decimal places.");
  if (Number(amount) < 1) return alert("Minimum withdrawal is 1.00 USDT.");
  const addressError = withdrawalAddressError(address, network);
  if (addressError) return alert(addressError);
  if (!withdrawalPassword) return alert("Enter your withdrawal password.");
  if (Number(amount) > backendBalance) return alert("Insufficient available wallet balance.");

  try {
    const data = await api("/wallet/withdraw", {
      method: "POST",
      headers: { "Idempotency-Key": createIdempotencyKey() },
      body: JSON.stringify({ amount, address, network, withdrawalPassword })
    });
    const tx = data.transaction;
    showVaultToast("Withdrawal request submitted", `${formatUSDTPrecise(tx.netAmount)} USDT net payout · ${formatUSDTPrecise(tx.feeAmount)} USDT fee.`);
    document.getElementById("withdrawAmount").value = "";
    document.getElementById("withdrawalPassword").value = "";
    closeModal("withdrawModal");
    await refreshAccount();
  } catch (error) {
    alert(error.message);
  }
}

function withdrawalAddressError(address, network) {
  const value = String(address || "").trim();
  if (!value) return "Enter a destination wallet address.";
  if (network === "BEP20" && !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return "This doesn’t look like a BNB Smart Chain address. It should start with 0x and contain 40 hexadecimal characters.";
  }
  if (network !== "BEP20") return "VaultX currently supports USDT withdrawals on BNB Smart Chain (BEP20) only.";
  return "";
}

function updateWithdrawalAddressHint() {
  const input = document.getElementById("withdrawAddress");
  const network = document.getElementById("withdrawNetwork")?.value || "";
  const hint = document.getElementById("withdrawAddressHint");
  if (!input || !hint) return;
  const address = input.value.trim();
  if (!address) {
    hint.textContent = "Enter the destination address for BNB Smart Chain (BEP20).";
    hint.className = "muted";
    input.removeAttribute("aria-invalid");
    return;
  }
  const error = withdrawalAddressError(address, network);
  hint.textContent = error || "Address format matches BNB Smart Chain (BEP20). Double-check the network before submitting.";
  hint.className = error ? "form-error" : "muted";
  if (error) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

function updateWithdrawBalance() { setAllBalances(backendBalance); }

document.getElementById("withdrawAddress")?.addEventListener("input", updateWithdrawalAddressHint);
document.getElementById("withdrawNetwork")?.addEventListener("change", () => {
  const network = document.getElementById("withdrawNetwork")?.value || "";
  const addressInput = document.getElementById("withdrawAddress");
  if (addressInput) addressInput.value = savedWithdrawalAddresses[network] || "";
  updateWithdrawalAddressHint();
});

window.showVaultToast = function(title, message) {
  const stack = document.getElementById("toastStack");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = "vx-toast";
  el.innerHTML = `<strong>${String(title).replace(/[<>]/g, "")}</strong><small>${String(message).replace(/[<>]/g, "")}</small>`;
  stack.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateY(6px)"; el.style.transition = ".25s"; setTimeout(() => el.remove(), 260); }, 3500);
};

window.loadBackendWallet = loadWallet;
window.openDeposit = openDeposit;
window.openWithdraw = openWithdraw;
window.closeModal = closeModal;
window.forceCloseWithdrawal = forceCloseWithdrawal;
window.submitDeposit = submitDeposit;
window.submitWithdraw = submitWithdraw;
window.unlockVIP = unlockVIP;
window.quantifyInvestment = quantifyInvestment;
window.show = show;
window.setAmount = setAmount;
window.copyCode = copyCode;
window.copyReferralLink = copyReferralLink;
window.copyDepositAddress = copyDepositAddress;
window.loadDepositAddress = loadDepositAddress;
window.toggleDepositQr = toggleDepositQr;
window.toggleNotifications = toggleNotifications;

async function market() {
  try {
    const r = await fetch(`${API_BASE}/market`);
    const j = await r.json();
    const prices = {};
    (j.prices || []).forEach((item) => { prices[item.symbol] = Number(item.price); });
    marketCurrentPrices = prices;

    (j.history || []).forEach((item) => {
      const symbol = item.symbol;
      const history = item.history || [];
      if (!history.length) return;
      const last = Number(history[history.length - 1].price);
      const previous = marketPreviousPrices[symbol] ?? Number(history[Math.max(0, history.length - 2)]?.price || last);
      const rising = last >= previous;
      if (!charts[symbol]) draw(symbol, last, rising);
      const chart = charts[symbol];
      chart.data.labels = history.map((point) => new Date(point.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      chart.data.datasets[0].data = history.map((point) => point.price);
      chart.data.datasets[0].borderColor = rising ? "#35d0a0" : "#ff667d";
      chart.data.datasets[0].backgroundColor = rising ? "#35d0a0" : "#ff667d";
      chart.update("none");
      marketPreviousPrices[symbol] = last;
    });

    Object.entries(prices).forEach(([symbol, price]) => {
      const el = document.getElementById(ids[symbol]);
      if (!el) return;
      const previous = marketPreviousTickerPrices[symbol];
      const rising = previous == null || price >= previous;
      el.textContent = "$" + Number(price).toLocaleString(undefined, { maximumFractionDigits: 2 });
      el.dataset.direction = previous == null || price === previous ? "flat" : rising ? "up" : "down";
      el.title = previous == null || price === previous
        ? "No change since the previous tick"
        : rising ? "Price rising" : "Price falling";
      el.style.color = previous == null || price === previous ? "" : rising ? "#35d0a0" : "#ff667d";
      const chart = charts[symbol];
      if (chart) {
        chart.data.labels.push(new Date().toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }));
        chart.data.datasets[0].data.push(price);
        while (chart.data.labels.length > 60) { chart.data.labels.shift(); chart.data.datasets[0].data.shift(); }
        chart.data.datasets[0].borderColor = rising ? "#35d0a0" : "#ff667d";
        chart.data.datasets[0].backgroundColor = rising ? "#35d0a0" : "#ff667d";
        chart.update("none");
      }
      marketPreviousTickerPrices[symbol] = price;
    });
  } catch (error) {
    console.error("Market data error:", error);
  }
}

function draw(symbol, value, rising = true) {
  const canvas = document.getElementById(symbol.toLowerCase() + "Chart");
  if (!canvas || charts[symbol]) return;
  charts[symbol] = new Chart(canvas, {
    type: "line",
    data: { labels: [""], datasets: [{ data: [value], borderWidth: 2, pointRadius: 0, tension: .35, borderColor: rising ? "#35d0a0" : "#ff667d", backgroundColor: rising ? "#35d0a0" : "#ff667d" }] },
    options: { plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }
  });
}

market();
setInterval(market, 1000);

/* Modal controls */
document.addEventListener("click", (event) => {
  const close = event.target.closest?.("[data-close-modal]");
  if (close) { event.preventDefault(); closeModal(close.getAttribute("data-close-modal")); return; }
  if (event.target.classList?.contains("modal")) closeModal(event.target.id);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    const open = document.querySelector(".modal:not(.hidden)");
    if (open) closeModal(open.id);
  }
});

function updateWithdrawalQuote() {
  const amount = amountToUnits(document.getElementById("withdrawAmount")?.value || "");
  const fee = amount === null ? 0n : (amount + 5n) / 10n;
  const net = amount === null ? 0n : amount - fee;
  const feeElement = document.getElementById("withdrawFee");
  const receiveElement = document.getElementById("withdrawReceive");
  if (feeElement) feeElement.textContent = `${formatUSDTUnits(fee)} USDT`;
  if (receiveElement) receiveElement.textContent = `${formatUSDTUnits(net)} USDT`;
}

document.getElementById("withdrawAmount")?.addEventListener("input", updateWithdrawalQuote);

/* Authentication */
(function initAuth() {
  const authScreen = document.getElementById("authScreen");
  const loginForm = document.getElementById("loginForm");
  const registerForm = document.getElementById("registerForm");
  const loginTab = document.getElementById("loginTab");
  const registerTab = document.getElementById("registerTab");
  const authError = document.getElementById("authError");
  const authLoading = document.getElementById("authLoading");
  const forgotPasswordLink = document.getElementById("forgotPasswordLink");
  const forgotPasswordForm = document.getElementById("forgotPasswordForm");
  const resetPasswordForm = document.getElementById("resetPasswordForm");
  const backToLogin = document.getElementById("backToLogin");
  const resendVerificationBtn = document.getElementById("resendVerificationBtn");

  function error(message, success = false) {
    if (authError) {
      authError.textContent = message || "";
      authError.classList.toggle("show", !!message);
      authError.classList.toggle("success", !!message && success);
    }
  }
  function loading(value) { if (authLoading) authLoading.style.display = value ? "block" : "none"; document.querySelectorAll(".auth-submit").forEach((b) => b.disabled = value); }
  function tab(login) {
    loginTab?.classList.toggle("active", login); registerTab?.classList.toggle("active", !login);
    if (loginForm) loginForm.style.display = login ? "grid" : "none";
    if (registerForm) registerForm.style.display = login ? "none" : "grid";
    if (forgotPasswordForm) forgotPasswordForm.style.display = "none";
    if (resetPasswordForm) resetPasswordForm.style.display = "none";
    if (forgotPasswordLink) forgotPasswordLink.style.display = login ? "block" : "none";
    if (resendVerificationBtn) resendVerificationBtn.style.display = "none";
    error("");
  }

  loginTab?.addEventListener("click", () => tab(true));
  registerTab?.addEventListener("click", () => tab(false));

  resendVerificationBtn?.addEventListener("click", async () => {
    const email = document.getElementById("loginEmail").value.trim();
    if (!email) return error("Enter your account email above first.");
    loading(true);
    try {
      const data = await api("/auth/resend-verification", { method: "POST", body: JSON.stringify({ email }) });
      error(data.message || "If that account needs verification, a link has been sent.", true);
    } catch (e) { error(e.message); } finally { loading(false); }
  });

  registerForm?.addEventListener("submit", async (event) => {
    event.preventDefault(); error(""); loading(true);
    try {
      const email = document.getElementById("registerEmail").value.trim();
      const data = await api("/auth/register", { method: "POST", body: JSON.stringify({ name: document.getElementById("registerName").value.trim(), email, password: document.getElementById("registerPassword").value, confirmPassword: document.getElementById("registerConfirmPassword").value, referralCode: document.getElementById("registerReferralCode").value.trim() || undefined }) });
      registerForm.reset();
      tab(true);
      document.getElementById("loginEmail").value = email;
      error(data.message || "Account created. Check your email for a verification link.", true);
    } catch (e) { error(e.message); } finally { loading(false); }
  });

  forgotPasswordLink?.addEventListener("click", () => {
    loginForm.style.display = "none";
    registerForm.style.display = "none";
    forgotPasswordForm.style.display = "grid";
    resetPasswordForm.style.display = "none";
    forgotPasswordLink.style.display = "none";
    error("");
  });

  backToLogin?.addEventListener("click", () => tab(true));

  forgotPasswordForm?.addEventListener("submit", async (event) => {
    event.preventDefault(); error(""); loading(true);
    try {
      const data = await api("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email: document.getElementById("forgotEmail").value.trim() }) });
      error(data.message || "If an account exists, password reset instructions have been sent.", true);
    } catch (e) { error(e.message); } finally { loading(false); }
  });

  resetPasswordForm?.addEventListener("submit", async (event) => {
    event.preventDefault(); error(""); loading(true);
    try {
      const data = await api("/auth/reset-password", { method: "POST", body: JSON.stringify({ token: document.getElementById("resetToken").value.trim(), password: document.getElementById("resetPassword").value, confirmPassword: document.getElementById("resetConfirmPassword").value }) });
      alert(data.message || "Password updated successfully.");
      resetPasswordForm.reset();
      tab(true);
    } catch (e) { error(e.message); } finally { loading(false); }
  });

  document.addEventListener("click", (event) => {
    const toggle = event.target.closest?.(".password-toggle");
    if (!toggle) return;
    const input = document.getElementById(toggle.dataset.target);
    if (!input) return;
    input.type = input.type === "password" ? "text" : "password";
    toggle.textContent = input.type === "password" ? "Show" : "Hide";
    toggle.setAttribute("aria-label", input.type === "password" ? "Show password" : "Hide password");
  });

  document.getElementById("withdrawalPasswordForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = await api("/me/withdrawal-password", { method: "POST", body: JSON.stringify({ currentPassword: document.getElementById("securityCurrentPassword").value, withdrawalPassword: document.getElementById("securityWithdrawalPassword").value, confirmWithdrawalPassword: document.getElementById("securityConfirmWithdrawalPassword").value }) });
      alert(data.message || "Withdrawal password updated successfully.");
      event.target.reset();
      await loadNotifications();
    } catch (e) { alert(e.message); }
  });

  window.logoutVaultX = logoutVaultX;

  updateGreeting();
  setInterval(updateGreeting, 60000);
  setInterval(() => { if (token()) loadNotifications(); }, 10000);
  setInterval(updateDepositCountdowns, 1000);
  const referralFromUrl = new URLSearchParams(location.search).get("ref");
  const referralInput = document.getElementById("registerReferralCode");
  if (referralInput && referralFromUrl) referralInput.value = referralFromUrl;
  const mailAction = location.hash.match(/^#(verify|reset)=([a-f0-9]{40,100})$/i);
  if (mailAction) {
    localStorage.removeItem("vaultx_token");
    localStorage.removeItem("vaultx_user");
    history.replaceState(null, "", location.pathname + location.search);
    authScreen.style.display = "flex";
    tab(true);
    if (mailAction[1].toLowerCase() === "reset") {
      loginForm.style.display = "none";
      registerForm.style.display = "none";
      forgotPasswordLink.style.display = "none";
      resetPasswordForm.style.display = "grid";
      document.getElementById("resetToken").value = mailAction[2];
      error("Choose a new password to finish resetting your account.", true);
    } else {
      api("/auth/verify-email", { method: "POST", body: JSON.stringify({ token: mailAction[2] }) })
        .then((data) => error(data.message || "Email verified. You can now log in.", true))
        .catch((e) => error(e.message));
    }
  } else if (token()) {
    authScreen.style.display = "none";
    refreshAccount();
    resumeDepositStatusMonitor();
  } else {
    authScreen.style.display = "flex";
    tab(true);
  }
})();

/* Keep the existing navigation appearance and open Home first. */
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".modal").forEach((el) => { el.classList.add("hidden"); el.setAttribute("aria-hidden", "true"); });
  document.body.classList.remove("modal-open");
  show("home");
});
