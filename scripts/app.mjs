/**
 * GRAM Trader — UI app (render, events, wallet, chart, alerts wiring)
 */
import {
  stanceLine as tgStanceLine,
  buildStatusMessage as tgBuildStatus,
  msgCeiling,
  msgFloor,
  msgProfitBuy,
  msgLossBuy,
  msgProfitSell,
  msgLossSell,
  msgRallyPrepare,
  msgReversalSell,
  msgDumpWatch,
  msgReversalBuy,
  msgConnected,
} from "./telegram-messages.mjs";

// ROUND = safety margin on advice only (not P&L)
const ROUND = 0.2, STON = "EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4";
const SEED = [];
const KEY = "gram_trades_v2", TGKEY = "gram_telegram_v1", MEMKEY = "gram_alert_mem_v1", PKEY = "gram_price_cache_v1", WKEY = "gram_wallet_addr_v1", SERIESKEY = "gram_price_series_v1";
const DEFAULT_WALLET = ""; // no default — user must paste their own address
const USDT_MASTER = "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe";
// Noise as fraction of price (1.2%); floor avoids zero at tiny prices
const NOISE_PCT = 0.012, NOISE_FLOOR = 1e-6;
const MIN_ACTION_PCT = 0.5; // min edge over BE before suggesting sell/buy
// Rough pool TON reserve for slippage estimate (updated from STON when available)
let poolTonReserve = 1.7e6;

let trades = loadTrades();
let tg = loadTg();
let walletAddr = loadWallet();
let live = null, quote = null, cexPrice = null, dexPrice = null;
let walletBal = null; // { ton, usdt, at } — source of truth for balances
let tradeType = "buy", chartDays = 7, chartPts = [], confirmFn = null, fetching = false, syncing = false;

function noiseAbs(price) {
  const p = price || live || 1;
  return Math.max(NOISE_FLOOR, p * NOISE_PCT);
}
/** Simple constant-product slippage estimate for selling `gram` into pool */
function estSlippagePct(gram) {
  const r = poolTonReserve || 1e6;
  if (!gram || gram <= 0) return 0;
  // Δp/p ≈ Δx / (x+Δx) for small trades on xy=k when swapping x→y
  return Math.min(8, (gram / (r + gram)) * 100);
}
function estExecSellPrice(mid, gram) {
  const slip = estSlippagePct(gram) / 100;
  return mid * (1 - slip);
}
function estExecBuyPrice(mid, usdt) {
  const gramApprox = mid > 0 ? usdt / mid : 0;
  const slip = estSlippagePct(gramApprox) / 100;
  return mid * (1 + slip);
}

function fmt(n, d) {
  if (n == null || n === "" || Number.isNaN(Number(n))) return "—";
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  try {
    return x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  } catch (_) {
    return x.toFixed(d);
  }
}
function faDate(iso) {
  try { return new Date(iso).toLocaleString("fa-IR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.style.display = "block";
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.style.display = "none"; }, 2800);
}
function loadTrades() {
  try {
    const raw = localStorage.getItem(KEY) || localStorage.getItem("gram_trades_v1");
    const p = raw ? JSON.parse(raw) : null;
    return Array.isArray(p) ? p : SEED.slice();
  } catch { return SEED.slice(); }
}
function saveTrades() { localStorage.setItem(KEY, JSON.stringify(trades)); }
function loadWallet() {
  try { return localStorage.getItem(WKEY) || ""; } catch { return ""; }
}
function saveWallet(a) {
  walletAddr = (a || "").trim();
  localStorage.setItem(WKEY, walletAddr);
}
function toLocalDatetime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function isUsdt(j) {
  if (!j) return false;
  const s = String(j.symbol || "").toUpperCase();
  // tonapi may show USD₮
  if (s.startsWith("USD")) return true;
  const addr = String(j.address || j.raw_address || "").toLowerCase();
  return addr.includes("b113a994");
}
function parseSwapsFromEvents(events) {
  const out = [];
  for (const e of events || []) {
    let ts;
    try {
      const sec = Number(e.timestamp);
      if (!Number.isFinite(sec) || sec <= 0) continue;
      ts = new Date(sec * 1000).toISOString();
    } catch (_) { continue; }
    const eid = e.event_id || "";
    const actions = e.actions || [];
    const acct = String((e.account && e.account.address) || "").toLowerCase();
    const sameAddr = (a) => String(a || "").toLowerCase() === acct;

    // --- JettonSwap (STON.fi etc.): amounts are already net of pool fee ---
    for (const a of actions) {
      if (a.status && a.status !== "ok") continue;
      if (a.type !== "JettonSwap") continue;
      const js = a.JettonSwap || {};
      if (isUsdt(js.jetton_master_in) && js.ton_out) {
        const usdt = Number(js.amount_in) / 1e6;
        const gram = Number(js.ton_out) / 1e9;
        if (usdt > 0.01 && gram > 0.01) {
          out.push({
            type: "buy", date: toLocalDatetime(ts), gram, usdt,
            networkFee: 0, dexFeeUsdt: 0, exact: true, eventId: eid, source: "wallet"
          });
        }
      } else if (isUsdt(js.jetton_master_out) && js.ton_in) {
        const usdt = Number(js.amount_out) / 1e6;
        const gram = Number(js.ton_in) / 1e9;
        if (usdt > 0.01 && gram > 0.01) {
          out.push({
            type: "sell", date: toLocalDatetime(ts), gram, usdt,
            networkFee: 0, dexFeeUsdt: 0, exact: true, eventId: eid, source: "wallet"
          });
        }
      }
    }
    if (actions.some((a) => a.type === "JettonSwap")) continue;

    // --- Omniston / multi-leg: measure exact net cashflows of the wallet ---
    // Also capture intermediate USDT that left the route (DEX fee) and small TON refunds (gas).
    let tonIn = 0, tonOut = 0, usdtIn = 0, usdtOut = 0;
    let usdtRoute = 0; // USDT seen in non-user legs (for fee estimate)
    for (const a of actions) {
      if (a.status && a.status !== "ok") continue;
      if (a.type === "TonTransfer") {
        const tt = a.TonTransfer || {};
        const amt = Number(tt.amount || 0) / 1e9;
        if (sameAddr(tt.sender && tt.sender.address)) tonOut += amt;
        if (sameAddr(tt.recipient && tt.recipient.address)) tonIn += amt;
      }
      if (a.type === "JettonTransfer") {
        const jt = a.JettonTransfer || {};
        if (!isUsdt(jt.jetton)) continue;
        const amt = Number(jt.amount || 0) / 1e6;
        const fromU = sameAddr(jt.sender && jt.sender.address);
        const toU = sameAddr(jt.recipient && jt.recipient.address);
        if (fromU) usdtOut += amt;
        if (toU) usdtIn += amt;
        if (!fromU && !toU) usdtRoute = Math.max(usdtRoute, amt);
      }
    }

    // event.extra ≈ fee-related nanoton delta
    const extraTon = typeof e.extra === "number" ? Math.abs(e.extra) / 1e9 : 0;

    if (tonOut > 1 && usdtIn > 0.5 && tonOut > tonIn) {
      // sell GRAM → USDT
      // Swap size ≈ large outbound; small inbound is gas refund (not "unsold GRAM")
      const refund = tonIn < 0.5 ? tonIn : 0;
      const gramSwapped = tonOut; // amount sent into swap route
      const gramInv = tonOut - refund; // net inventory leave
      const usdt = usdtIn - usdtOut;
      const dexFeeUsdt = usdtRoute > usdt ? +(usdtRoute - usdt).toFixed(6) : 0;
      const networkFee = +(Math.max(extraTon, refund > 0 ? 0 : 0)).toFixed(9);
      out.push({
        type: "sell", date: toLocalDatetime(ts),
        gram: +gramInv.toFixed(9),
        gramSwapped: +gramSwapped.toFixed(9),
        usdt: +usdt.toFixed(6),
        networkFee, dexFeeUsdt, exact: true, eventId: eid, source: "wallet"
      });
    } else if (tonIn > 1 && usdtOut > 0.5 && tonIn > tonOut) {
      // buy GRAM with USDT
      const gasOut = tonOut < 0.5 ? tonOut : 0;
      const gram = tonIn - (tonOut > 0.5 ? tonOut : 0); // net GRAM received
      const usdt = usdtOut - usdtIn;
      const networkFee = +Math.max(extraTon, gasOut).toFixed(9);
      out.push({
        type: "buy", date: toLocalDatetime(ts),
        gram: +gram.toFixed(9), usdt: +usdt.toFixed(6),
        networkFee, dexFeeUsdt: 0, exact: true, eventId: eid, source: "wallet"
      });
    }
  }
  const seen = new Set();
  return out.filter((s) => {
    const k = s.eventId || (s.date + s.type + s.gram.toFixed(4));
    if (seen.has(k)) return false;
    seen.add(k);
    return s.gram > 0.5 && s.usdt > 0.5;
  });
}
/** Simple reliable fetch — same idea as the first working version */
async function fetchWalletSwaps(addr, maxPages) {
  // Original path: one solid request. Extra pages only if tonapi gives a real next_from.
  const pages = Math.min(maxPages || 3, 5);
  let all = [];
  let nextFrom = null;
  for (let i = 0; i < pages; i++) {
    let url = "https://tonapi.io/v2/accounts/" + encodeURIComponent(addr) + "/events?limit=100";
    if (nextFrom) url += "&before_lt=" + nextFrom;
    const j = await fetchJson(url, 20000);
    const batch = j.events || [];
    if (!batch.length) break;
    all = all.concat(batch);
    const nf = Number(j.next_from);
    if (!Number.isFinite(nf) || nf <= 0) break;
    nextFrom = nf;
  }
  return parseSwapsFromEvents(all);
}
async function fetchWalletBalances(addr) {
  const acc = await fetchJson("https://tonapi.io/v2/accounts/" + encodeURIComponent(addr), 12000);
  const ton = Number(acc.balance || 0) / 1e9;
  let usdt = 0;
  try {
    const jets = await fetchJson("https://tonapi.io/v2/accounts/" + encodeURIComponent(addr) + "/jettons?currencies=usd", 12000);
    for (const b of jets.balances || []) {
      const j = b.jetton || {};
      if (isUsdt(j)) usdt += Number(b.balance || 0) / Math.pow(10, j.decimals || 6);
    }
  } catch (_) {}
  walletBal = { ton, usdt, at: Date.now() };
  return walletBal;
}
async function syncWallet(force) {
  if (syncing) {
    // allow manual retry after 2s if previous hung
    if (!syncWallet._since || Date.now() - syncWallet._since < 2000) return;
    syncing = false;
  }
  const addr = (document.getElementById("walletAddr").value || walletAddr || "").trim().replace(/\s+/g, "");
  if (!addr || addr.length < 40) { toast("آدرس کیف‌پول را وارد کن"); return; }
  saveWallet(addr);
  syncing = true;
  syncWallet._since = Date.now();
  const meta = document.getElementById("walletSyncMeta");
  if (meta) meta.textContent = "در حال خواندن تاریخچه و موجودی…";
  try {
    let bal = null;
    try { bal = await fetchWalletBalances(addr); } catch (_) {}
    const remote = await fetchWalletSwaps(addr, 3);
    if (!remote.length) {
      if (meta) {
        meta.textContent = bal
          ? ("سواپی یافت نشد · زنجیره: " + fmt(bal.ton, 4) + " GRAM · " + fmt(bal.usdt, 2) + " USDT")
          : "سواپی یافت نشد";
      }
      toast("سواپ GRAM/USDT در تاریخچه پیدا نشد");
      render();
      return;
    }
    // merge: keep manual trades, add/update wallet ones by eventId or close date+amounts
    const existingIds = new Set(trades.filter((t) => t.eventId).map((t) => t.eventId));
    let added = 0, updated = 0;
    for (const s of remote) {
      if (s.eventId && existingIds.has(s.eventId)) {
        // refresh exact fields on existing wallet trade
        const ex = trades.find((t) => t.eventId === s.eventId);
        if (ex) {
          ex.gram = s.gram; ex.usdt = s.usdt; ex.gramSwapped = s.gramSwapped;
          ex.price = s.usdt / (s.gramSwapped || s.gram || 1);
          ex.networkFee = s.networkFee || 0; ex.dexFeeUsdt = s.dexFeeUsdt || 0;
          ex.exact = true; ex.source = "wallet";
          updated++;
        }
        continue;
      }
      // fuzzy match existing manual entry → upgrade to exact wallet data
      const match = trades.find((t) => !t.eventId && t.type === s.type &&
        Math.abs(new Date(t.date) - new Date(s.date)) < 3600e3 &&
        Math.abs(t.gram - s.gram) / s.gram < 0.03 &&
        Math.abs(t.usdt - s.usdt) / s.usdt < 0.03);
      if (match) {
        match.eventId = s.eventId;
        match.source = "wallet";
        match.exact = true;
        match.gram = s.gram;
        match.usdt = s.usdt;
        match.gramSwapped = s.gramSwapped;
        match.price = s.usdt / (s.gramSwapped || s.gram || 1);
        match.networkFee = s.networkFee || 0;
        match.dexFeeUsdt = s.dexFeeUsdt || 0;
        delete match.dexFeePct;
        updated++;
        continue;
      }
      trades.push({
        id: Date.now() + added,
        type: s.type,
        date: s.date,
        gram: s.gram,
        gramSwapped: s.gramSwapped,
        usdt: s.usdt,
        networkFee: s.networkFee || 0,
        dexFeeUsdt: s.dexFeeUsdt || 0,
        exact: true,
        price: s.usdt / (s.gramSwapped || s.gram || 1),
        eventId: s.eventId,
        source: "wallet"
      });
      existingIds.add(s.eventId);
      added++;
    }
    // sort by date ascending
    trades.sort((a, b) => new Date(a.date) - new Date(b.date));
    saveTrades();
    try { render(); } catch (re) { console.error("render after sync", re); }
    let balTxt = "";
    if (bal) {
      balTxt = " · زنجیره: " + fmt(bal.ton, 4) + " GRAM / " + fmt(bal.usdt, 2) + " USDT";
      const s = calcState(trades, live);
      if (s.bookGram != null && Math.abs(s.bookGram - bal.ton) > 0.5) {
        balTxt += " · دفتر سواپ " + fmt(s.bookGram, 4) + " GRAM";
      }
    }
    if (meta) meta.textContent = remote.length + " سواپ · +" + added + " · ↻" + updated + balTxt;
    toast(added ? (added + " سواپ جدید اضافه شد") : (updated ? "سواپ‌ها به‌روز شدند" : "همه سواپ‌ها قبلاً ثبت شده‌اند"));
  } catch (err) {
    console.error(err);
    const msg = (err && err.message) ? String(err.message) : "خطای ناشناخته";
    let human = "خطا در خواندن کیف‌پول";
    if (/HTTP 429/.test(msg)) human = "محدودیت tonapi — ۳۰ ثانیه بعد دوباره بزن";
    else if (/HTTP 400/.test(msg)) human = "آدرس کیف‌پول نامعتبر است";
    else if (/HTTP 404/.test(msg)) human = "این آدرس در شبکه پیدا نشد";
    else if (/abort|AbortError|timeout/i.test(msg)) human = "زمان تمام شد — دوباره تلاش کن";
    else if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) human = "دسترسی شبکه/CORS — صفحه را با GitHub Pages یا یک سرور محلی باز کن (نه file://)";
    if (meta) meta.textContent = "خطا: " + human;
    toast(human + " (" + msg.slice(0, 80) + ")");
  } finally {
    syncing = false;
  }
}
// starting capital removed — balances & PnL come from wallet + trades only
function loadTg() {
  const d = { token: "", chatId: "", enabled: false, alertAbove: "", alertBelow: "", alertTargetPcts: [0.5, 1, 1.5, 2, 2.5, 3], alertLossPcts: [0.5, 1, 1.5, 2], priceReport30m: false };
  try {
    const raw = JSON.parse(localStorage.getItem(TGKEY) || "{}");
    const merged = { ...d, ...raw };
    // migrate old single alertTargetPct
    if (raw.alertTargetPct != null && (raw.alertTargetPcts == null || !Array.isArray(raw.alertTargetPcts))) {
      const n = Number(raw.alertTargetPct);
      merged.alertTargetPcts = Number.isFinite(n) && n > 0 ? [n] : [5];
    }
    if (!Array.isArray(merged.alertTargetPcts)) merged.alertTargetPcts = [5];
    if (!Array.isArray(merged.alertLossPcts)) merged.alertLossPcts = [];
    merged.alertTargetPcts = merged.alertTargetPcts.map(Number).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
    merged.alertLossPcts = merged.alertLossPcts.map(Number).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
    return merged;
  } catch { return d; }
}
function saveTg() { localStorage.setItem(TGKEY, JSON.stringify(tg)); }

function takeFromInv(inv, amount) {
  let rem = amount, cost = 0;
  while (rem > 1e-12 && inv.length) {
    const lot = inv[0];
    const take = Math.min(rem, lot.gram);
    cost += take * lot.costPer;
    lot.gram -= take;
    rem -= take;
    if (lot.gram < 1e-12) inv.shift();
  }
  return { taken: amount - rem, cost: cost };
}

function equityAt(cash, inv, price) {
  let g = 0; for (const lot of inv) g += lot.gram;
  return cash + (price ? g * price : 0);
}

/**
 * Trade ledger + wallet balances.
 * Balances shown = on-chain when walletBal is set; else inferred from trades.
 * PnL = realized (closed swaps) + unrealized (open cost vs mark).
 * No "starting capital".
 */
function calcState(list, price) {
  const sorted = list.slice().sort((a, b) => new Date(a.date) - new Date(b.date) || a.id - b.id);
  let totalFeesGram = 0, totalFeesUsdt = 0, realizedPnl = 0;
  const inv = [];
  let lastSwapPnl = null, lastSwapPct = null, lastSwapType = null, lastSwapPrice = null;
  let flowUsdt = 0; // net USDT from swaps only (buy negative, sell positive)

  for (const t of sorted) {
    const isExact = t.exact === true || t.source === "wallet";
    const netFeeGram = Math.max(0, t.networkFee || 0);
    const dexFeeUsdt = Math.max(0, t.dexFeeUsdt || 0);
    const legacyDexPct = (!isExact && t.dexFeePct != null) ? Math.max(0, t.dexFeePct) / 100 : 0;
    totalFeesGram += netFeeGram;
    totalFeesUsdt += dexFeeUsdt;
    const px = t.price > 0 ? t.price : (t.gram > 0 ? t.usdt / t.gram : null);

    let invBefore = 0;
    for (const lot of inv) invBefore += lot.gram;
    const costBefore = inv.reduce((s, lot) => s + lot.gram * lot.costPer, 0);

    if (t.type === "buy") {
      const payUsdt = t.usdt;
      const recvGram = isExact ? t.gram : Math.max(0, t.gram * (1 - legacyDexPct) - netFeeGram);
      flowUsdt -= payUsdt;
      if (recvGram > 1e-12) inv.push({ gram: recvGram, costPer: payUsdt / recvGram });
      lastSwapPnl = px != null ? recvGram * px - payUsdt : null;
    } else {
      let invGram = 0;
      for (const lot of inv) invGram += lot.gram;
      const wantSell = t.gram;
      const sellGram = Math.min(wantSell, invGram);
      const fillRatio = wantSell > 1e-12 ? sellGram / wantSell : 0;
      const recvUsdtFull = isExact ? t.usdt : t.usdt * (1 - legacyDexPct);
      const recvUsdt = recvUsdtFull * fillRatio;
      const sellTake = takeFromInv(inv, sellGram);
      flowUsdt += recvUsdt;
      const rp = recvUsdt - sellTake.cost;
      realizedPnl += rp;
      lastSwapPnl = rp;
    }

    lastSwapPct = (t.usdt > 0 && lastSwapPnl != null) ? (lastSwapPnl / t.usdt) * 100 : null;
    lastSwapType = t.type;
    lastSwapPrice = px;
  }

  let bookGram = 0, remainingCost = 0;
  for (const lot of inv) { bookGram += lot.gram; remainingCost += lot.gram * lot.costPer; }
  const avg = bookGram > 0 ? remainingCost / bookGram : 0;

  // Source of truth: chain balances when available
  const totalGram = walletBal ? walletBal.ton : bookGram;
  const cashUsdt = walletBal ? walletBal.usdt : Math.max(0, flowUsdt);
  const currentValue = price ? totalGram * price : 0;
  const equity = cashUsdt + currentValue;
  // Unrealized only on cost-basis inventory (capped by wallet ton)
  const costForMark = bookGram > 1e-12
    ? remainingCost * Math.min(1, totalGram / bookGram)
    : 0;
  const unrealizedPnl = currentValue - costForMark;
  const totalPnl = realizedPnl + unrealizedPnl;

  return {
    totalGram, cashUsdt, bookGram, avgBuyPrice: avg, investedUsdt: costForMark,
    currentValue, equity, totalPnl,
    unrealizedPnl, totalFeesGram, totalFeesUsdt, realizedPnl,
    lastSwapPnl, lastSwapPct, lastSwapType, lastSwapPrice,
    fromWallet: !!walletBal
  };
}

/** Last swap from ledger (most recent by date) */
function lastTrade() {
  if (!trades.length) return null;
  return trades.slice().sort((a, b) => new Date(b.date) - new Date(a.date) || b.id - a.id)[0];
}

/**
 * Suggestion card based on last swap.
 * buy last → show sell targets (+pct from last price)
 * sell last → show buy targets (−pct from last price)
 */
function nextAdvice(s, price) {
  const lt = lastTrade();
  const pad = 1 - ROUND / 100;
  if (!lt || !(lt.price > 0)) {
    return { breakEven: null, suggest: null, hint: "هنوز سواپی ثبت نشده — همگام‌سازی کیف‌پول را بزن", meta: "", rows: [] };
  }
  const ref = lt.price;
  const rows = [];

  if (lt.type === "buy") {
    // Holding GRAM after buy — when to sell
    const curPct = price > 0 ? ((price - ref) / ref) * 100 : null;
    const exec = (price > 0 && s.totalGram > 0) ? estExecSellPrice(price, s.totalGram) : null;
    const execPct = exec != null ? ((exec - ref) / ref) * 100 : null;
    let hint = "آخرین سواپ: خرید GRAM @ " + fmt(ref, 4);
    if (curPct != null) {
      hint += "\nالان mid: " + fmt(price, 4) + " → " + (curPct >= 0 ? "سود " : "ضرر ") + Math.abs(curPct).toFixed(2) + "٪ نسبت به خرید";
    }
    if (execPct != null) {
      hint += "\nبا لغزش تخمینی: " + fmt(exec, 4) + " (" + (execPct >= 0 ? "+" : "") + execPct.toFixed(2) + "٪)";
    }
    const levels = [0.5, 1, 1.5, 2, 3, 5];
    for (const pct of levels) {
      const midNeed = ref * (1 + pct / 100) / pad;
      const slip = s.totalGram > 0 ? estSlippagePct(s.totalGram) / 100 : 0;
      const midForExec = ref * (1 + pct / 100) / Math.max(0.5, 1 - slip);
      rows.push({
        label: "فروش +" + pct + "٪",
        price: midForExec,
        detail: "هدف mid ≈ " + fmt(midForExec, 4) + " تا بعد از لغزش حدود +" + pct + "٪ بماند"
      });
    }
    const suggest = (execPct != null && execPct >= MIN_ACTION_PCT) ? "to_usdt" : null;
    if (suggest) hint += "\n✅ بعد از لغزش در سود معنادار هستی — می‌توانی بفروشی";
    else if (curPct != null && curPct < 0) hint += "\nمنتظر برگشت بالای " + fmt(ref, 4) + " بمان";
    return { breakEven: ref / pad, beExact: ref, suggest, hint, meta: "مرجع = قیمت سواپ آخر (خرید)", rows, lastType: "buy", ref };
  }

  // last was sell — holding USDT, when to buy back
  const curPct = price > 0 ? ((ref - price) / ref) * 100 : null; // positive = cheaper than sell
  const execBuy = (price > 0 && s.cashUsdt > 0) ? estExecBuyPrice(price, s.cashUsdt) : null;
  let hint = "آخرین سواپ: فروش GRAM @ " + fmt(ref, 4);
  if (curPct != null) {
    hint += "\nالان mid: " + fmt(price, 4) + " → " + (curPct >= 0 ? (curPct.toFixed(2) + "٪ ارزان‌تر از فروش") : (Math.abs(curPct).toFixed(2) + "٪ گران‌تر از فروش"));
  }
  const levels = [0.5, 1, 1.5, 2, 3, 5];
  for (const pct of levels) {
    const target = ref * (1 - pct / 100) * pad;
    rows.push({
      label: "خرید −" + pct + "٪",
      price: target,
      detail: "زیر " + fmt(target, 4) + " نسبت به فروش آخر حدود +" + pct + "٪ جا برای سود دور بعد"
    });
  }
  const suggest = (curPct != null && curPct >= MIN_ACTION_PCT) ? "to_gram" : null;
  if (suggest) hint += "\n✅ نسبت به فروش آخر ارزان‌تر شده — می‌توانی دوباره بخری";
  else hint += "\nمنتظر ریزش زیر اهداف خرید بمان";
  return { breakEven: ref * pad, beExact: ref, suggest, hint, meta: "مرجع = قیمت سواپ آخر (فروش)", rows, lastType: "sell", ref };
}

async function fetchJson(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 4000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function fromKraken() {
  const j = await fetchJson("https://api.kraken.com/0/public/Ticker?pair=TONUSD", 4000);
  const row = j.result && j.result.TONUSD;
  const last = Number(row && row.c && row.c[0]);
  const open = Number(row && row.o);
  if (!last) throw new Error("kraken");
  return { usd: last, change24h: open ? ((last - open) / open) * 100 : null, source: "Kraken" };
}
async function fromCoinbase() {
  const spot = await fetchJson("https://api.coinbase.com/v2/prices/TON-USD/spot");
  const usd = Number(spot.data && spot.data.amount);
  if (!usd) throw new Error("coinbase");
  let change = null;
  try {
    const st = await fetchJson("https://api.exchange.coinbase.com/products/TON-USD/stats");
    const open = Number(st.open), last = Number(st.last);
    if (open && last) change = ((last - open) / open) * 100;
  } catch (_) {}
  return { usd, change24h: change, source: "Coinbase" };
}
async function fromSton() {
  const j = await fetchJson("https://api.ston.fi/v1/pools/" + STON, 4000);
  const pool = j.pool || j;
  const r0 = Number(pool.reserve0), r1 = Number(pool.reserve1);
  if (!r0 || !r1) throw new Error("ston");
  // token0 USDT (6dec), token1 native TON (9dec)
  if (r1 > 0) poolTonReserve = r1 / 1e9;
  const usd = (r0 / 1e6) / (r1 / 1e9);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("ston bad price");
  return { usd, change24h: null, source: "STON.fi DEX", dex: true };
}
async function fromTonapi() {
  // Same host as wallet sync — usually works when STON/Kraken are blocked
  const j = await fetchJson("https://tonapi.io/v2/rates?tokens=ton&currencies=usd", 4000);
  const row = j.rates && j.rates.TON;
  const usd = row && row.prices && Number(row.prices.USD);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("tonapi rates");
  let change = null;
  const d = row.diff_24h && row.diff_24h.USD;
  if (d != null) {
    const n = parseFloat(String(d).replace(/[%＋+]/g, "").replace("−", "-").replace("–", "-"));
    if (Number.isFinite(n)) change = n;
  }
  return { usd, change24h: change, source: "tonapi" };
}
async function fromLlama() {
  const j = await fetchJson("https://coins.llama.fi/prices/current/coingecko:the-open-network");
  const usd = j.coins && j.coins["coingecko:the-open-network"] && j.coins["coingecko:the-open-network"].price;
  if (!usd) throw new Error("llama");
  return { usd, change24h: null, source: "DefiLlama" };
}
async function fromGecko() {
  const j = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd&include_24hr_change=true");
  const row = j["the-open-network"];
  if (!row || !row.usd) throw new Error("gecko");
  return { usd: row.usd, change24h: row.usd_24h_change ?? null, source: "CoinGecko" };
}


function paintPrice() {
  const el = document.getElementById("livePrice");
  const meta = document.getElementById("priceMeta");
  const pill = document.getElementById("chgPill");
  if (el) el.textContent = (live != null && Number.isFinite(Number(live))) ? fmt(live, 4) : "—";
  if (quote && meta) {
    let m = (quote.source || "بازار") + (quote.cached ? " · کش" : "") + (quote.stale ? " · قدیمی" : "");
    if (quote.dexUsd != null && quote.cexUsd != null) {
      const sp = quote.dexUsd - quote.cexUsd;
      m += " · CEX " + fmt(quote.cexUsd, 4) + " · اختلاف " + (sp >= 0 ? "+" : "") + fmt(sp, 4);
    }
    meta.textContent = m;
  } else if (meta && live == null) {
    meta.textContent = "در حال دریافت قیمت…";
  }
  if (pill) {
    if (quote && quote.change24h != null) {
      const ch = quote.change24h;
      pill.className = "pill " + (ch >= 0 ? "up" : "down");
      pill.textContent = (ch >= 0 ? "▲ " : "▼ ") + Math.abs(ch).toFixed(2) + "٪";
      pill.classList.remove("hidden");
    } else {
      pill.classList.add("hidden");
      pill.textContent = "";
    }
  }
}

function applyQuote(q, opts) {
  opts = opts || {};
  quote = Object.assign({}, q, {
    cached: !!opts.cached,
    stale: !!opts.stale
  });
  live = Number(quote.usd);
  if (!Number.isFinite(live)) live = null;
  if (quote.dexUsd != null) dexPrice = quote.dexUsd;
  if (quote.cexUsd != null) cexPrice = quote.cexUsd;
  try { if (live != null) pushPriceSample(live); } catch (_) {}
  try {
    if (live != null) {
      localStorage.setItem(PKEY, JSON.stringify({ at: Date.now(), q: {
        usd: quote.usd,
        change24h: quote.change24h,
        source: quote.source,
        dexUsd: quote.dexUsd,
        cexUsd: quote.cexUsd
      }}));
    }
  } catch (_) {}
  // Critical: paint immediately so user never depends on full render / button
  try { paintPrice(); } catch (_) {}
}

async function getPrice(force) {
  const now = Date.now();
  // Serve cache instantly (even on force we show it first, then refresh)
  try {
    const cached = JSON.parse(localStorage.getItem(PKEY) || "null");
    if (cached && cached.q && cached.q.usd && now - cached.at < 120000) {
      applyQuote(cached.q, { cached: true, stale: now - cached.at > 45000 });
      if (!force && now - cached.at < 15000) return quote; // fresh enough
    }
  } catch (_) {}

  // Race the two fastest sources — first valid wins UI
  const sources = [
    fromSton,
    fromTonapi,
    fromKraken,
    fromCoinbase
  ];

  let primary = null;
  let errors = [];
  // parallel race: first success
  primary = await new Promise((resolve) => {
    let done = false;
    let pending = sources.length;
    sources.forEach((fn) => {
      fn().then((r) => {
        if (!done && r && r.usd > 0) {
          done = true;
          resolve(r);
        }
      }).catch((e) => {
        errors.push(String(e && e.message || e));
      }).finally(() => {
        pending -= 1;
        if (!done && pending === 0) resolve(null);
      });
    });
  });

  if (!primary) {
    if (live != null && Number.isFinite(live)) {
      // keep existing
      return quote;
    }
    throw new Error("no price: " + errors.slice(0, 2).join("; "));
  }

  const isDex = !!primary.dex || (primary.source && String(primary.source).indexOf("STON") >= 0);
  applyQuote({
    usd: primary.usd,
    change24h: primary.change24h != null ? primary.change24h : (quote && quote.change24h),
    source: primary.source,
    dexUsd: isDex ? primary.usd : null,
    cexUsd: !isDex ? primary.usd : (quote && quote.cexUsd)
  });

  // Background: enrich with the other type (DEX/CEX) without blocking UI
  (async () => {
    try {
      if (isDex) {
        let ref = null;
        try { ref = await fromTonapi(); } catch (_) {
          try { ref = await fromKraken(); } catch (_) {}
        }
        if (ref && ref.usd) {
          quote.cexUsd = ref.usd;
          cexPrice = ref.usd;
          if (ref.change24h != null) quote.change24h = ref.change24h;
          try { localStorage.setItem(PKEY, JSON.stringify({ at: Date.now(), q: quote })); } catch (_) {}
          try { render(); } catch (_) {}
        }
      } else {
        try {
          const dex = await fromSton();
          if (dex && dex.usd) {
            // Prefer DEX mid for trading once available
            applyQuote({
              usd: dex.usd,
              change24h: quote.change24h,
              source: dex.source,
              dexUsd: dex.usd,
              cexUsd: primary.usd
            });
            try { render(); } catch (_) {}
          }
        } catch (_) {}
      }
    } catch (_) {}
  })();

  return quote;
}

async function getChart(days) {
  const interval = days <= 1 ? 15 : days <= 7 ? 60 : 240;
  try {
    const j = await fetchJson("https://api.kraken.com/0/public/OHLC?pair=TONUSD&interval=" + interval, 10000);
    const rows = j.result && j.result.TONUSD;
    if (!Array.isArray(rows) || !rows.length) throw new Error("empty");
    const cutoff = Date.now() - days * 86400000;
    return rows.map((r) => ({ t: r[0] * 1000, p: Number(r[4]) })).filter((p) => p.t >= cutoff && Number.isFinite(p.p));
  } catch (_) {
    const j = await fetchJson("https://coins.llama.fi/chart/coingecko:the-open-network?span=" + days + "&period=1d", 10000);
    const prices = j.coins && j.coins["coingecko:the-open-network"] && j.coins["coingecko:the-open-network"].prices;
    if (!prices || !prices.length) throw new Error("chart");
    return prices.map((p) => ({ t: p.timestamp * 1000, p: p.price }));
  }
}

function drawChart(pts, avg) {
  const c = document.getElementById("chart");
  const ctx = c.getContext("2d");
  const r = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  c.width = w * r; c.height = h * r; ctx.scale(r, r);
  ctx.clearRect(0, 0, w, h);
  if (!pts.length) {
    ctx.fillStyle = "#6b7a8d"; ctx.font = "13px Vazirmatn"; ctx.textAlign = "center";
    ctx.fillText("نمودار در دسترس نیست", w / 2, h / 2); return;
  }
  const pad = { t: 12, r: 12, b: 22, l: 48 };
  const min = Math.min(...pts.map((p) => p.p), avg || Infinity);
  const max = Math.max(...pts.map((p) => p.p), avg || -Infinity);
  const span = max - min || 0.01;
  const x = (i) => pad.l + (i / (pts.length - 1)) * (w - pad.l - pad.r);
  const y = (p) => pad.t + (1 - (p - min) / span) * (h - pad.t - pad.b);
  ctx.strokeStyle = "#243041"; ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const yy = pad.t + ((h - pad.t - pad.b) * i) / 3;
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
    ctx.fillStyle = "#6b7a8d"; ctx.font = "11px Vazirmatn"; ctx.textAlign = "left";
    ctx.fillText((max - (span * i) / 3).toFixed(3), 4, yy + 4);
  }
  if (avg) {
    ctx.setLineDash([5, 5]); ctx.strokeStyle = "#6b7a8d";
    ctx.beginPath(); ctx.moveTo(pad.l, y(avg)); ctx.lineTo(w - pad.r, y(avg)); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.beginPath();
  pts.forEach((p, i) => { i ? ctx.lineTo(x(i), y(p.p)) : ctx.moveTo(x(i), y(p.p)); });
  ctx.strokeStyle = "#14b8a6"; ctx.lineWidth = 2; ctx.stroke();
  const g = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  g.addColorStop(0, "rgba(20,184,166,.22)"); g.addColorStop(1, "rgba(20,184,166,0)");
  ctx.lineTo(x(pts.length - 1), h - pad.b); ctx.lineTo(x(0), h - pad.b); ctx.closePath();
  ctx.fillStyle = g; ctx.fill();
}

function sendTelegram(text) {
  const token = (tg.token || "").trim(), chat = (tg.chatId || "").trim();
  if (!token || !chat) return Promise.reject(new Error("توکن و Chat ID لازم است"));
  const bodyText = String(text == null ? "" : text).slice(0, 4096);
  if (!bodyText) return Promise.reject(new Error("پیام خالی است"));
  const api = "https://api.telegram.org/bot" + token + "/sendMessage";
  const form = new URLSearchParams();
  form.set("chat_id", chat);
  form.set("text", bodyText);
  const formBody = form.toString();

  // POST avoids URL length limits and keeps token out of the query string
  return fetch(api, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody,
  })
    .then(async (r) => {
      let j = null;
      try { j = await r.json(); } catch (_) {}
      if (!r.ok || (j && j.ok === false)) {
        const desc = (j && j.description) ? j.description : ("HTTP " + r.status);
        throw new Error(desc || "ارسال ناموفق");
      }
      return j || true;
    })
    .catch((err) => {
      const msg = String((err && err.message) || err || "");
      // Real API / auth errors we could read — surface them
      if (/unauthorized|not found|chat not found|forbidden|bot token|HTTP [4-5]|ناموفق|لازم است|too long|message is too long/i.test(msg)) {
        return Promise.reject(err instanceof Error ? err : new Error(msg));
      }
      // Likely CORS (browser cannot read api.telegram.org). Fire-and-forget still delivers.
      try {
        if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
          if (navigator.sendBeacon(api, new Blob([formBody], { type: "application/x-www-form-urlencoded" }))) {
            return true;
          }
        }
      } catch (_) {}
      // Short-message GET fallback: Telegram processes the request even if response is unreadable
      if (bodyText.length <= 1500) {
        const getUrl = api + "?chat_id=" + encodeURIComponent(chat) + "&text=" + encodeURIComponent(bodyText);
        return new Promise((resolve) => {
          const img = new Image();
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(true); } };
          img.onload = img.onerror = finish;
          img.src = getUrl;
          setTimeout(finish, 2000);
        });
      }
      return Promise.reject(err instanceof Error ? err : new Error(msg || "ارسال ناموفق"));
    });
}

/** Record price samples for momentum (keep ~2h at 45s interval) */
function pushPriceSample(price) {
  if (price == null || !Number.isFinite(price)) return [];
  let series = [];
  try { series = JSON.parse(localStorage.getItem(SERIESKEY) || "[]"); } catch (_) {}
  if (!Array.isArray(series)) series = [];
  const now = Date.now();
  series.push({ t: now, p: price });
  // drop older than 3 hours, keep max 200 points
  const cutoff = now - 3 * 60 * 60 * 1000;
  series = series.filter((x) => x.t >= cutoff).slice(-200);
  try { localStorage.setItem(SERIESKEY, JSON.stringify(series)); } catch (_) {}
  return series;
}

/**
 * Trend phases (aligned with gram-core):
 *   rally | dump | reversal_down | reversal_up | flat
 * Conflict short vs prior/medium = REVERSAL (urgent), not flat.
 */
function detectMomentum(series) {
  const empty = { dir: "flat", phase: "flat", delta: 0, from: null, to: null, noise: NOISE_FLOOR, medDir: "flat", prevDir: "flat", strength: 0, movePct: 0 };
  if (!series || series.length < 6) return empty;
  const lastP = series[series.length - 1].p;
  const nAbs = noiseAbs(lastP);
  const shortN = Math.min(series.length, 16);
  const prevN = Math.min(Math.max(0, series.length - shortN), 16);
  const medN = Math.min(series.length, 48);
  function win(arr) {
    if (!arr || arr.length < 2) return { dir: "flat", delta: 0, from: null, to: null, movePct: 0 };
    const from = arr[0].p, to = arr[arr.length - 1].p, delta = to - from;
    let up = 0, down = 0;
    const step = nAbs * 0.45;
    for (let i = 1; i < arr.length; i++) {
      const d = arr[i].p - arr[i - 1].p;
      if (d >= step) up++;
      else if (d <= -step) down++;
    }
    let dir = "flat";
    if (Math.abs(delta) >= nAbs) {
      if (delta > 0 && up >= down) dir = "up";
      else if (delta < 0 && down >= up) dir = "down";
    }
    return { dir, delta, from, to, movePct: from > 0 ? (delta / from) * 100 : 0 };
  }
  const short = win(series.slice(-shortN));
  const prev = prevN >= 4 ? win(series.slice(-(shortN + prevN), -shortN || undefined)) : { dir: "flat", delta: 0, movePct: 0 };
  const med = win(series.slice(-medN));
  let phase = "flat", dir = short.dir;
  if (short.dir === "down" && Math.abs(short.delta) >= nAbs && (prev.dir === "up" || med.dir === "up")) {
    phase = "reversal_down"; dir = "down";
  } else if (short.dir === "up" && Math.abs(short.delta) >= nAbs && (prev.dir === "down" || med.dir === "down")) {
    phase = "reversal_up"; dir = "up";
  } else if (short.dir === "up" && (med.dir === "up" || prev.dir === "up" || med.dir === "flat")) {
    if (Math.abs(short.delta) >= nAbs || Math.abs(med.delta) >= nAbs * 1.4) { phase = "rally"; dir = "up"; }
  } else if (short.dir === "down" && (med.dir === "down" || prev.dir === "down" || med.dir === "flat")) {
    if (Math.abs(short.delta) >= nAbs || Math.abs(med.delta) >= nAbs * 1.4) { phase = "dump"; dir = "down"; }
  } else if (short.dir === "flat" && med.dir === "up") { phase = "rally"; dir = "up"; }
  else if (short.dir === "flat" && med.dir === "down") { phase = "dump"; dir = "down"; }
  return {
    dir, phase, delta: short.delta, from: short.from, to: short.to, noise: nAbs,
    medDir: med.dir, prevDir: prev.dir, strength: Math.abs(short.movePct || 0), movePct: short.movePct || 0,
  };
}

/** Position from real balances + live price (not only last swap) */
function positionStance(s) {
  const hasGram = s.totalGram > 1e-6;
  const hasUsdt = s.cashUsdt > 1e-6;
  if (hasGram && !hasUsdt) return { mode: "hold_gram", label: "بیشتر سرمایه‌ات GRAM است", action: "sell" };
  if (hasUsdt && !hasGram) return { mode: "hold_usdt", label: "بیشتر سرمایه‌ات تتر است", action: "buy" };
  if (hasGram && hasUsdt) {
    const px = (live > 0 ? live : null) || s.avgBuyPrice || 0;
    const gVal = s.totalGram * px;
    if (gVal >= s.cashUsdt) return { mode: "hold_gram", label: "بیشتر سرمایه‌ات GRAM است", action: "sell" };
    return { mode: "hold_usdt", label: "بیشتر سرمایه‌ات تتر است", action: "buy" };
  }
  return { mode: "empty", label: "پوزیشن مشخصی نیست", action: null };
}

/** True if a sell at live would be meaningfully above break-even (not just noise) */
function sellIsWorthwhile(s, price) {
  if (!s.avgBuyPrice || s.totalGram <= 0 || !price) return false;
  // Use estimated execution price after slippage on full position
  const exec = estExecSellPrice(price, s.totalGram);
  const pct = ((exec - s.avgBuyPrice) / s.avgBuyPrice) * 100;
  return pct >= MIN_ACTION_PCT && (exec - s.avgBuyPrice) >= noiseAbs(price) * 0.5;
}

/** True if buy at live is meaningfully below last sell / reference */
function buyIsWorthwhile(s, price) {
  if (!price) return false;
  const ref = (s.lastSwapType === "sell" && s.lastSwapPrice) ? s.lastSwapPrice : null;
  const exec = s.cashUsdt > 0 ? estExecBuyPrice(price, s.cashUsdt) : price;
  if (ref != null) {
    const pct = ((ref - exec) / ref) * 100;
    return pct >= MIN_ACTION_PCT && (ref - exec) >= noiseAbs(price) * 0.5;
  }
  return true;
}



function tgChecks() {
  return { sellIsWorthwhile, buyIsWorthwhile };
}
function stanceLine(stance, s, price) {
  return tgStanceLine(s, price, lastTrade(), tgChecks());
}
function buildStatusMessage(s) {
  return tgBuildStatus(s, live, quote, lastTrade(), tgChecks(), poolTonReserve);
}

// Page-open grace + global gap so reopening the tab does not spam Telegram
const ALERT_BOOT_GRACE_MS = 12000;
const ALERT_GLOBAL_GAP_MS = 90 * 1000;
const alertBootAt = Date.now();

function maybeAlert(state) {
  if (!tg.enabled || !live || !tg.token || !tg.chatId) return false;
  // Skip noisy boot (price retries + multiple render calls)
  if (Date.now() - alertBootAt < ALERT_BOOT_GRACE_MS) return false;

  const series = pushPriceSample(live);
  const mom = detectMomentum(series);
  const stance = positionStance(state);
  const above = Number(tg.alertAbove), below = Number(tg.alertBelow);
  const profitPcts = Array.isArray(tg.alertTargetPcts) ? tg.alertTargetPcts : [];
  const lossPcts = Array.isArray(tg.alertLossPcts) ? tg.alertLossPcts : [];
  let mem = null;
  try { mem = JSON.parse(localStorage.getItem(MEMKEY) || "null"); } catch (_) {}
  if (!mem || typeof mem !== "object") mem = {};
  const now = Date.now();
  const cool = 20 * 60 * 1000;       // درصد نسبت به سواپ / سقف‌کف
  const coolPhase = 18 * 60 * 1000;  // rally / dump (آماده‌باش)
  const coolRev = 8 * 60 * 1000;     // برگشت روند — فوری‌تر، cooldown کوتاه‌تر
  const recently = (k, c) => mem[k] && now - mem[k] < (c || cool);
  // Global gap: at most one Telegram message every ALERT_GLOBAL_GAP_MS
  // استثنا: برگشت فوری می‌تواند gap را کمی بشکند (نیمه gap)
  const isUrgentPhase =
    (mom.phase === "reversal_down" && stance.action === "sell") ||
    (mom.phase === "reversal_up" && stance.action === "buy");
  const gapMs = isUrgentPhase ? Math.min(ALERT_GLOBAL_GAP_MS, 45 * 1000) : ALERT_GLOBAL_GAP_MS;
  if (mem._lastAny && now - mem._lastAny < gapMs) return false;
  if (maybeAlert._inFlight) return false;
  const mark = (k) => {
    mem[k] = now;
    mem._lastAny = now;
    try { localStorage.setItem(MEMKEY, JSON.stringify(mem)); } catch (_) {}
  };
  /** Soft-lock gap while request is in flight; full key mark only after success */
  const sendOne = (key, msg, okToast) => {
    maybeAlert._inFlight = true;
    mem._lastAny = now;
    try { localStorage.setItem(MEMKEY, JSON.stringify(mem)); } catch (_) {}
    sendTelegram(msg)
      .then(() => {
        mark(key);
        if (okToast) toast(okToast);
      })
      .catch(() => {
        if (mem._lastAny === now) delete mem._lastAny;
        try { localStorage.setItem(MEMKEY, JSON.stringify(mem)); } catch (_) {}
        toast("هشدار ارسال نشد");
      })
      .finally(() => { maybeAlert._inFlight = false; });
    return true;
  };

  const stText = () => stanceLine(stance, state, live);
  const nAbs = mom.noise || noiseAbs(live);
  const movePct = mom.movePct != null ? mom.movePct : (mom.from > 0 ? ((live - mom.from) / mom.from) * 100 : 0);

  // ── Priority 0: برگشت روند (فوری) — وابسته به پوزیشن واقعی ──
  if (stance.action === "sell" && mom.phase === "reversal_down" && !recently("phase_rev_sell", coolRev)) {
    if (Math.abs(mom.delta) >= nAbs) {
      return sendOne(
        "phase_rev_sell",
        msgReversalSell(mom.from, live, Math.abs(mom.delta), Math.abs(movePct), stText()),
        "هشدار: ریزش بعد از رشد"
      );
    }
  }
  if (stance.action === "buy" && mom.phase === "reversal_up" && !recently("phase_rev_buy", coolRev)) {
    if (Math.abs(mom.delta) >= nAbs) {
      return sendOne(
        "phase_rev_buy",
        msgReversalBuy(mom.from, live, Math.abs(movePct), stText()),
        "هشدار: برگشت برای خرید"
      );
    }
  }

  // ── Priority 1: سقف / کف دستی ──
  if (above > 0 && live >= above && !recently("above")) {
    return sendOne("above", msgCeiling(above, live, stText()), "هشدار سقف قیمت");
  }
  if (below > 0 && live <= below && !recently("below")) {
    return sendOne("below", msgFloor(below, live, stText()), "هشدار کف قیمت");
  }

  // ── Priority 2: درصد نسبت به آخرین سواپ — فقط هم‌جهت با پوزیشن ──
  const lt = lastTrade();
  if (lt && lt.price > 0) {
    const ref = lt.price;
    const vsSwap = ((live - ref) / ref) * 100;
    // GRAM داری + آخرین سواپ خرید → سود/ضرر روی خرید
    if (stance.action === "sell" && lt.type === "buy") {
      for (const targetPct of profitPcts) {
        const key = "ls_profit_buy_" + targetPct;
        if (vsSwap >= targetPct && !recently(key)) {
          return sendOne(key, msgProfitBuy(vsSwap, targetPct, ref, live, stText()), "هشدار هدف سود");
        }
      }
      for (const lossPct of lossPcts) {
        const key = "ls_loss_buy_" + lossPct;
        if (vsSwap <= -lossPct && !recently(key)) {
          return sendOne(key, msgLossBuy(vsSwap, lossPct, ref, live, stText()), "هشدار افت از خرید");
        }
      }
    }
    // تتر داری + آخرین سواپ فروش → فرصت خرید / رشد بعد از فروش
    if (stance.action === "buy" && lt.type === "sell") {
      for (const targetPct of profitPcts) {
        const key = "ls_profit_sell_" + targetPct;
        if (vsSwap <= -targetPct && !recently(key)) {
          return sendOne(key, msgProfitSell(vsSwap, targetPct, ref, live, stText()), "هشدار فرصت خرید");
        }
      }
      for (const lossPct of lossPcts) {
        const key = "ls_loss_sell_" + lossPct;
        if (vsSwap >= lossPct && !recently(key)) {
          return sendOne(key, msgLossSell(vsSwap, lossPct, ref, live, stText()), "هشدار رشد بعد از فروش");
        }
      }
    }
  }

  // ── Priority 3: ادامه روند — آماده‌باش (اسپم کم) ──
  if (stance.action === "sell" && mom.phase === "rally" && !recently("phase_rally", coolPhase)) {
    if (Math.abs(mom.delta) >= nAbs || mom.strength >= 0.6) {
      return sendOne(
        "phase_rally",
        msgRallyPrepare(mom.from, live, Math.abs(movePct), stText()),
        "آماده‌باش: رشد GRAM"
      );
    }
  }
  if (stance.action === "buy" && mom.phase === "dump" && !recently("phase_dump", coolPhase)) {
    if (Math.abs(mom.delta) >= nAbs || mom.strength >= 0.6) {
      return sendOne(
        "phase_dump",
        msgDumpWatch(mom.from, live, Math.abs(movePct), stText()),
        "حواست باشد: ریزش قیمت"
      );
    }
  }

  return false;
}

function stat(label, value, sub, tone) {
  return '<div class="stat-tile">'
    + '<span class="stat-label">' + label + '</span>'
    + '<p class="stat-v' + (tone ? ' ' + tone : '') + '">' + value + '</p>'
    + (sub ? '<span class="stat-sub">' + sub + '</span>' : '')
    + '</div>';
}

function render() {
  const hasWallet = !!(walletAddr && walletAddr.trim());
  const walletHint = document.getElementById("walletHint");
  if (walletHint) walletHint.classList.toggle("hidden", hasWallet);
  const walletDot = document.getElementById("walletDot");
  const btnWallet = document.getElementById("btnWallet");
  if (walletDot) walletDot.hidden = !hasWallet;
  if (btnWallet) {
    btnWallet.classList.toggle("is-connected", hasWallet);
    btnWallet.title = hasWallet ? "کیف‌پول متصل · تنظیمات" : "اتصال کیف‌پول";
    btnWallet.setAttribute("aria-label", hasWallet ? "تنظیمات کیف‌پول متصل" : "اتصال کیف‌پول");
  }
  const s = calcState(trades, live);
  const adv = nextAdvice(s, live);
  const hint = document.getElementById("autoFeeHint");
  if (hint) {
    const feeG = s.totalFeesGram || 0;
    const feeU = s.totalFeesUsdt || 0;
    hint.textContent = feeG > 0 || feeU > 0
      ? ("کارمزد دقیق از زنجیره: شبکه " + fmt(feeG, 6) + " GRAM" + (feeU > 0 ? " · DEX " + fmt(feeU, 4) + " USDT" : "") + " · بدون تخمین")
      : "مبالغ سواپ از زنجیره دقیق‌اند · کارمزد DEX داخل مبلغ خالص لحاظ شده";
  }
  const adviceEl = document.getElementById("adviceText");
  if (adviceEl) adviceEl.innerHTML = (adv.hint || "").replace(/\n/g, "<br>");
  const adviceMeta = document.getElementById("adviceMeta");
  if (adviceMeta) {
    adviceMeta.textContent = adv.meta
      ? (adv.meta + (adv.ref ? " · " + fmt(adv.ref, 4) : "") + (adv.suggest === "to_usdt" ? " · پیشنهاد: فروش" : adv.suggest === "to_gram" ? " · پیشنهاد: خرید" : ""))
      : "";
  }
  const adviceTargets = document.getElementById("adviceTargets");
  if (adviceTargets) {
    if (adv.rows && adv.rows.length) {
      adviceTargets.innerHTML = adv.rows.map((r) =>
        '<button class="target" type="button" data-p="' + r.price + '"><span class="' + (adv.lastType === "buy" ? "profit" : "loss") + '" style="font-weight:800">' + r.label + '</span><span><b style="display:block;font-variant-numeric:tabular-nums">' + fmt(r.price, 4) + '</b><span class="muted">' + r.detail + "</span></span></button>"
      ).join("");
      adviceTargets.querySelectorAll(".target").forEach((b) => {
        b.onclick = () => {
          const p = Number(b.dataset.p);
          document.getElementById("simPrice").value = p.toFixed(4);
          if (adv.lastType === "buy") runSim(p);
          else toast("هدف خرید: " + fmt(p, 4) + " — وقتی mid نزدیک این عدد شد بخر");
        };
      });
    } else {
      adviceTargets.innerHTML = "";
    }
  }
  document.getElementById("livePrice").textContent = live != null ? fmt(live, 4) : "—";
  const pill = document.getElementById("chgPill");
  if (pill) {
    if (quote && quote.change24h != null) {
      const ch = quote.change24h;
      pill.className = "pill " + (ch >= 0 ? "up" : "down");
      pill.textContent = (ch >= 0 ? "▲ " : "▼ ") + Math.abs(ch).toFixed(2) + "٪";
      pill.classList.remove("hidden");
    } else {
      pill.classList.add("hidden");
      pill.textContent = "";
    }
  }
  if (quote) {
    let meta = quote.source + (quote.cached ? " · کش ۴۵ث" : "") + (quote.stale ? " · قدیمی" : "");
    if (quote.dexUsd != null && quote.cexUsd != null) {
      const sp = quote.dexUsd - quote.cexUsd;
      meta += " · CEX " + fmt(quote.cexUsd, 4) + " · اختلاف " + (sp >= 0 ? "+" : "") + fmt(sp, 4);
    }
    if (s.totalGram > 0 && live) {
      meta += " · تخمین اجرا فروش: " + fmt(estExecSellPrice(live, s.totalGram), 4) + " (لغزش ~" + estSlippagePct(s.totalGram).toFixed(2) + "٪)";
    }
    document.getElementById("priceMeta").textContent = meta;
  } else {
    document.getElementById("priceMeta").textContent = "در حال اتصال به بازار…";
  }
  const balLine = document.getElementById("walletBalLine");
  if (balLine) {
    if (walletBal) {
      let txt = "✓ موجودی کیف‌پول: " + fmt(walletBal.ton, 4) + " GRAM · " + fmt(walletBal.usdt, 2) + " USDT";
      if (s.bookGram != null) {
        const d = Math.abs(s.bookGram - walletBal.ton);
        if (d > 0.5) {
          txt += " · ⚠️ دفتر سواپ‌ها " + fmt(s.bookGram, 4) + " GRAM (اختلاف " + fmt(d, 4) + " — واریز/برداشت غیرسواپ یا تاریخچه ناقص)";
        } else {
          txt += " · دفتر سواپ با زنجیره هم‌خوان";
        }
      }
      balLine.textContent = txt;
    } else {
      balLine.textContent = "همگام‌سازی کن تا موجودی دقیق از کیف‌پول خوانده شود";
    }
  }

  const base = s.investedUsdt > 0 ? s.investedUsdt : (Math.abs(s.realizedPnl) + s.investedUsdt);
  const pnlPct = s.investedUsdt > 0 ? (s.unrealizedPnl / s.investedUsdt) * 100
    : (s.realizedPnl != null && Math.abs(s.realizedPnl) > 0 ? null : null);
  const totalPct = (s.realizedPnl + s.unrealizedPnl);
  document.getElementById("stats1").innerHTML =
    stat("موجودی GRAM", fmt(s.totalGram, 4), s.fromWallet ? "از کیف‌پول" : "از سواپ‌ها") +
    stat("موجودی USDT", fmt(s.cashUsdt, 2), s.fromWallet ? "از کیف‌پول" : "برآورد سواپ‌ها") +
    stat("ارزش کل", live != null ? fmt(s.equity, 2) : "—", "USDT") +
    stat("سود/زیان کل", (s.totalPnl >= 0 ? "+" : "") + fmt(s.totalPnl, 2),
      s.investedUsdt > 0 ? (("شناور " + (s.unrealizedPnl >= 0 ? "+" : "") + ((s.unrealizedPnl / s.investedUsdt) * 100).toFixed(2) + "٪") + " · محقق " + (s.realizedPnl >= 0 ? "+" : "") + fmt(s.realizedPnl, 2)) : ("محقق " + (s.realizedPnl >= 0 ? "+" : "") + fmt(s.realizedPnl, 2)),
      s.totalPnl >= 0 ? "profit" : "loss");
  document.getElementById("stats2").innerHTML =
    stat("سود/زیان سواپ آخر", s.lastSwapPnl != null ? ((s.lastSwapPnl >= 0 ? "+" : "") + fmt(s.lastSwapPnl, 2)) : "—", s.lastSwapPct != null ? ((s.lastSwapPct >= 0 ? "+" : "") + s.lastSwapPct.toFixed(2) + "٪") : "", s.lastSwapPnl != null ? (s.lastSwapPnl >= 0 ? "profit" : "loss") : "") +
    stat("میانگین ورود", s.avgBuyPrice ? fmt(s.avgBuyPrice, 4) : "—", "USDT / GRAM") +
    stat("هزینه پوزیشن باز", s.investedUsdt ? fmt(s.investedUsdt, 2) : "—", "USDT");

  const box = document.getElementById("targets");
  if (box) {
  if (s.totalGram <= 0 || !s.avgBuyPrice) box.innerHTML = '<p class="empty">بعد از سواپ به GRAM، اهداف اینجا می‌آید</p>';
  else {
    const slip = estSlippagePct(s.totalGram) / 100;
    box.innerHTML = [1, 2, 3, 5, 7, 10, 15, 20].map((pct) => {
      // mid needed so that AFTER slippage, profit ≈ pct%
      const neededMid = (s.avgBuyPrice * (1 + pct / 100)) / Math.max(0.5, 1 - slip) / (1 - ROUND / 100);
      const exec = estExecSellPrice(neededMid, s.totalGram);
      const usdtOut = s.totalGram * exec;
      const net = usdtOut - s.investedUsdt;
      return '<button class="target" type="button" data-p="' + neededMid + '"><span class="profit" style="font-weight:800">+' + pct + '٪</span><span><b style="display:block;font-variant-numeric:tabular-nums">' + fmt(neededMid, 4) + ' mid</b><span class="muted">≈ ' + fmt(usdtOut, 2) + ' بعد از لغزش</span></span><span class="profit" style="font-weight:800">+' + fmt(net, 2) + "</span></button>";
    }).join("");
    box.querySelectorAll(".target").forEach((b) => b.onclick = () => runSim(Number(b.dataset.p)));
  }
  }

  const hist = document.getElementById("history");
  if (hist) {
  if (!trades.length) hist.innerHTML = '<div class="empty-state"><h3>هنوز سواپی نیست</h3><p>از دکمه «خواندن از کیف‌پول» استفاده کن تا سواپ‌ها از زنجیره بیایند.</p></div>';
  else hist.innerHTML = trades.slice().reverse().map((t, i, arr) => {
    const feeBits = [];
    if ((t.networkFee || 0) > 0) feeBits.push("شبکه " + fmt(t.networkFee, 6) + " TON");
    if ((t.dexFeeUsdt || 0) > 0) feeBits.push("DEX " + fmt(t.dexFeeUsdt, 4) + " USDT");
    const feeTxt = feeBits.length ? feeBits.join(" · ") : ((t.exact || t.source === "wallet") ? "مبالغ خالص زنجیره" : "");
    const isBuy = t.type === "buy";
    const title = isBuy
      ? ("خرید " + fmt(t.gram, 4) + " GRAM")
      : ("فروش " + fmt(t.gram, 4) + " GRAM");
    const amount = isBuy
      ? ("پرداخت " + fmt(t.usdt, 2) + " USDT")
      : ("دریافت " + fmt(t.usdt, 2) + " USDT");
    const sub = faDate(t.date)
      + (t.source === "wallet" ? " · کیف‌پول" : " · دستی")
      + (feeTxt ? " · " + feeTxt : "");
    return '<div class="hist' + (i < arr.length - 1 ? ' hist-sep' : '') + '" role="listitem">'
      + '<span class="badge ' + (isBuy ? "up" : "down") + '" aria-label="' + (isBuy ? "خرید" : "فروش") + '">' + (isBuy ? "خرید" : "فروش") + '</span>'
      + '<div class="hist-body">'
      + '<p class="hist-title">' + title + '</p>'
      + '<p class="hist-amount">' + amount + '</p>'
      + '<p class="hist-sub">' + sub + '</p>'
      + '</div>'
      + '<div class="hist-meta">'
      + '<p class="hist-price">' + fmt(t.price, 4) + '</p>'
      + '<p class="hist-price-label">قیمت اجرا</p>'
      + '<button class="btn btn-danger btn-xs" data-id="' + t.id + '" type="button" aria-label="حذف این سواپ">حذف</button>'
      + '</div></div>';
  }).join("");
  hist.querySelectorAll("[data-id]").forEach((b) => b.onclick = () => ask("حذف معامله", "این معامله حذف شود؟", () => {
    trades = trades.filter((x) => x.id !== Number(b.dataset.id)); saveTrades(); render();
  }));
  }

  try { drawChart(chartPts, s.avgBuyPrice || null); } catch (e) { console.error(e); }
  try { maybeAlert(s); } catch (e) { console.error(e); }
}

function runSim(price) {
  const s = calcState(trades, live);
  if (s.totalGram <= 0) { toast("موجودی GRAM نداری"); return; }
  if (!price || price <= 0) { toast("قیمت معتبر وارد کن"); return; }
  const slip = estSlippagePct(s.totalGram);
  const exec = estExecSellPrice(price, s.totalGram);
  const usdtIdeal = s.totalGram * price;
  const usdtNet = s.totalGram * exec;
  const profit = usdtNet - s.investedUsdt;
  const pct = s.investedUsdt > 0 ? (profit / s.investedUsdt) * 100 : 0;
  document.getElementById("simPrice").value = price.toFixed(4);
  const el = document.getElementById("simOut");
  el.classList.remove("hidden");
  el.innerHTML =
    "<div><b>" + fmt(usdtNet, 2) + '</b><span class="muted">USDT بعد از لغزش ~' + slip.toFixed(2) + "٪</span></div>" +
    "<div><b class=\"" + (profit >= 0 ? "profit" : "loss") + '">' + (profit >= 0 ? "+" : "") + fmt(profit, 2) + '</b><span class="muted">سود/زیان واقعی‌تر</span></div>' +
    "<div><b class=\"" + (pct >= 0 ? "profit" : "loss") + '">' + (pct >= 0 ? "+" : "") + pct.toFixed(2) + '٪</b><span class="muted">mid بدون لغزش: ' + fmt(usdtIdeal, 2) + "</span></div>";
}

function ask(title, text, fn) {
  confirmFn = fn;
  const modal = document.getElementById("modal");
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalText").textContent = text;
  modal.hidden = false;
  modal.classList.add("on");
  const yes = document.getElementById("modalYes");
  if (yes) yes.focus();
}

function closeModal() {
  const modal = document.getElementById("modal");
  modal.classList.remove("on");
  modal.hidden = true;
}

function setType(t) {
  tradeType = t;
  const buy = document.getElementById("typeBuy");
  const sell = document.getElementById("typeSell");
  buy.className = t === "buy" ? "on-buy" : "";
  sell.className = t === "sell" ? "on-sell" : "";
  buy.setAttribute("aria-pressed", t === "buy" ? "true" : "false");
  sell.setAttribute("aria-pressed", t === "sell" ? "true" : "false");
  document.getElementById("gramLbl").textContent = t === "buy" ? "GRAM دریافتی" : "GRAM پرداختی";
  document.getElementById("usdtLbl").textContent = t === "buy" ? "USDT پرداختی" : "USDT دریافتی";
}

function renderPctChips(containerId, list, kind) {
  const el = document.getElementById(containerId);
  if (!list.length) {
    el.innerHTML = '<span class="muted" style="font-size:12px">هنوز موردی نیست</span>';
    return;
  }
  el.innerHTML = list.map((p) =>
    '<span class="pill ' + (kind === "profit" ? "up" : "down") + '" style="gap:6px">' +
    (kind === "profit" ? "+" : "−") + p + "٪" +
    '<button type="button" data-pct="' + p + '" data-kind="' + kind + '" style="background:none;border:0;color:inherit;padding:0;font-size:14px;line-height:1;cursor:pointer" title="حذف">×</button></span>'
  ).join("");
  el.querySelectorAll("button[data-pct]").forEach((b) => {
    b.onclick = () => {
      const pct = Number(b.dataset.pct);
      if (b.dataset.kind === "profit") {
        tg.alertTargetPcts = tg.alertTargetPcts.filter((x) => x !== pct);
      } else {
        tg.alertLossPcts = tg.alertLossPcts.filter((x) => x !== pct);
      }
      saveTg();
      renderPctChips("profitPctList", tg.alertTargetPcts, "profit");
      renderPctChips("lossPctList", tg.alertLossPcts, "loss");
    };
  });
}

function bindTg() {
  document.getElementById("tgToken").value = tg.token;
  document.getElementById("tgChat").value = tg.chatId;
  document.getElementById("tgEnabled").checked = !!tg.enabled;
  document.getElementById("tgAbove").value = tg.alertAbove;
  document.getElementById("tgBelow").value = tg.alertBelow;
  document.getElementById("tgPriceReport").checked = !!tg.priceReport30m;
  ["tgToken", "tgChat", "tgAbove", "tgBelow"].forEach((id) => {
    const map = { tgToken: "token", tgChat: "chatId", tgAbove: "alertAbove", tgBelow: "alertBelow" };
    document.getElementById(id).oninput = (e) => { tg[map[id]] = e.target.value; saveTg(); };
  });
  document.getElementById("tgEnabled").onchange = (e) => { tg.enabled = e.target.checked; saveTg(); toast(tg.enabled ? "هشدار فعال شد" : "هشدار خاموش شد"); };
  document.getElementById("tgPriceReport").onchange = (e) => {
    tg.priceReport30m = e.target.checked;
    saveTg();
    toast(tg.priceReport30m ? "گزارش هر ۳۰ دقیقه فعال شد" : "گزارش هر ۳۰ دقیقه خاموش شد");
  };
  renderPctChips("profitPctList", tg.alertTargetPcts, "profit");
  renderPctChips("lossPctList", tg.alertLossPcts, "loss");
  document.getElementById("btnAddProfitPct").onclick = () => {
    const n = Number(document.getElementById("tgPctAdd").value);
    if (!Number.isFinite(n) || n <= 0) { toast("درصد معتبر وارد کن"); return; }
    if (tg.alertTargetPcts.includes(n)) { toast("این درصد از قبل هست"); return; }
    tg.alertTargetPcts.push(n);
    tg.alertTargetPcts.sort((a, b) => a - b);
    saveTg();
    document.getElementById("tgPctAdd").value = "";
    renderPctChips("profitPctList", tg.alertTargetPcts, "profit");
    toast("هشدار سود +" + n + "٪ اضافه شد");
  };
  document.getElementById("btnAddLossPct").onclick = () => {
    const n = Number(document.getElementById("tgLossAdd").value);
    if (!Number.isFinite(n) || n <= 0) { toast("درصد معتبر وارد کن"); return; }
    if (tg.alertLossPcts.includes(n)) { toast("این درصد از قبل هست"); return; }
    tg.alertLossPcts.push(n);
    tg.alertLossPcts.sort((a, b) => a - b);
    saveTg();
    document.getElementById("tgLossAdd").value = "";
    renderPctChips("lossPctList", tg.alertLossPcts, "loss");
    toast("هشدار ضرر −" + n + "٪ اضافه شد");
  };
}

async function refreshPrice(force) {
  if (fetching && !force) return;
  fetching = true;
  const btn = document.getElementById("btnPrice");
  if (btn) btn.disabled = true;
  try {
    await getPrice(!!force);
    try { paintPrice(); } catch (_) {}
    try { render(); } catch (re) { console.error(re); }
  } catch (e) {
    console.error("price", e);
    try { paintPrice(); } catch (_) {}
    const meta = document.getElementById("priceMeta");
    if (!(live != null && Number.isFinite(Number(live)))) {
      if (meta) meta.textContent = "در حال اتصال…";
    } else if (meta) {
      meta.textContent = "آخرین قیمت · در حال تلاش دوباره";
    }
  } finally {
    fetching = false;
    if (btn) btn.disabled = false;
  }
}
async function refreshChart() {
  document.getElementById("chartMeta").textContent = "در حال بارگذاری نمودار…";
  try {
    chartPts = await getChart(chartDays);
    document.getElementById("chartMeta").textContent = chartPts.length ? (chartPts.length + " نقطه · منبع Kraken/DefiLlama") : "";
  } catch { chartPts = []; document.getElementById("chartMeta").textContent = "نمودار در دسترس نیست"; }
  render();
}

document.getElementById("typeBuy").onclick = () => setType("buy");
document.getElementById("typeSell").onclick = () => setType("sell");
document.getElementById("btnSave").onclick = () => {
  const g = Number(document.getElementById("tGram").value);
  const u = Number(document.getElementById("tUsdt").value);
  const date = document.getElementById("tDate").value;
  if (!date || !g || !u || g <= 0 || u <= 0) { toast("مقدار GRAM و USDT را وارد کن"); return; }
  // Manual entry is treated as exact amounts you observed (no estimated fee overlay)
  trades.push({
    id: Date.now(), type: tradeType, date, gram: g, usdt: u,
    networkFee: 0, dexFeeUsdt: 0, exact: true,
    price: u / g, source: "manual"
  });
  saveTrades();
  document.getElementById("tGram").value = "";
  document.getElementById("tUsdt").value = "";
  toast("سواپ ذخیره شد"); render();
};

document.getElementById("btnSim").onclick = () => runSim(Number(document.getElementById("simPrice").value));
document.getElementById("btnClear").onclick = () => ask("پاک‌سازی کامل", "تمام معاملات حذف می‌شود.", () => { trades = []; saveTrades(); render(); toast("تاریخچه پاک شد"); });
document.getElementById("modalNo").onclick = () => closeModal();
document.getElementById("modalYes").onclick = () => { closeModal(); if (confirmFn) confirmFn(); };
document.getElementById("modal").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); closeModal(); }
});
document.getElementById("btnPrice").onclick = () => { refreshPrice(true); };
function openWalletSheet() {
  const sheet = document.getElementById("walletSheet");
  if (!sheet) return;
  sheet.hidden = false;
  sheet.classList.add("on");
  const input = document.getElementById("walletAddr");
  if (input) setTimeout(() => input.focus(), 50);
}
function closeWalletSheet() {
  const sheet = document.getElementById("walletSheet");
  if (!sheet) return;
  sheet.classList.remove("on");
  sheet.hidden = true;
}
document.getElementById("btnWallet").onclick = () => openWalletSheet();
document.getElementById("btnWalletClose").onclick = () => closeWalletSheet();
document.getElementById("walletSheet").addEventListener("click", (e) => {
  if (e.target.id === "walletSheet") closeWalletSheet();
});
document.getElementById("walletSheet").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); closeWalletSheet(); }
});
document.getElementById("btnSyncWallet").onclick = () => syncWallet(true);
document.getElementById("btnSyncNow").onclick = () => syncWallet(true);
document.getElementById("walletAddr").onchange = () => {
  saveWallet(document.getElementById("walletAddr").value);
  render();
};
document.getElementById("walletAddr").onkeydown = (e) => {
  if (e.key === "Enter") { e.preventDefault(); syncWallet(true); }
};
document.getElementById("btnTgTest").onclick = () => {
  sendTelegram(msgConnected())
    .then(() => toast("پیام تست ارسال شد"))
    .catch((e) => toast(e.message || "ارسال ناموفق"));
};
document.getElementById("chartDays").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  chartDays = Number(b.dataset.d);
  document.querySelectorAll("#chartDays button").forEach((x) => {
    const on = x === b;
    x.classList.toggle("on", on);
    x.setAttribute("aria-pressed", on ? "true" : "false");
  });
  refreshChart();
};

const now = new Date(); now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
document.getElementById("tDate").value = now.toISOString().slice(0, 16);
document.getElementById("walletAddr").value = walletAddr || "";
bindTg();
// ---- boot price (automatic, no click) ----
function loadCachedPrice() {
  try {
    const cached = JSON.parse(localStorage.getItem(PKEY) || "null");
    if (cached && cached.q && cached.q.usd) {
      applyQuote(cached.q, { cached: true, stale: false });
      return true;
    }
  } catch (_) {}
  return false;
}
loadCachedPrice();
try { render(); } catch (_) {}

async function autoPriceOnce(reason) {
  fetching = false;
  try {
    await getPrice(true);
    try { paintPrice(); } catch (_) {}
    try { render(); } catch (_) {}
    return true;
  } catch (e) {
    console.error("autoPrice", reason, e);
    return false;
  }
}

// fire immediately + retries (covers slow network / first-paint races)
autoPriceOnce("boot");
setTimeout(() => { if (live == null) autoPriceOnce("retry-1s"); }, 1000);
setTimeout(() => { autoPriceOnce("retry-3s"); }, 3000);
setTimeout(() => { if (live == null) autoPriceOnce("retry-6s"); }, 6000);

setTimeout(() => { refreshChart(); }, 1000);
setTimeout(() => { if (walletAddr && walletAddr.trim()) syncWallet(false); }, 2500);
setInterval(() => { refreshPrice(false); }, 15000);
// auto re-sync wallet every 10 minutes
setInterval(() => { if (walletAddr && !syncing) syncWallet(false); }, 10 * 60 * 1000);
setInterval(async () => {
  if (!tg.priceReport30m || !tg.enabled || !tg.token || !tg.chatId) return;
  try {
    await refreshPrice(true);
    const s = calcState(trades, live);
    await sendTelegram(buildStatusMessage(s));
  } catch (_) {}
}, 30 * 60 * 1000);
window.addEventListener("resize", () => drawChart(chartPts, calcState(trades, live).avgBuyPrice || null));
