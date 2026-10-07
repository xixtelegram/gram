/**
 * GRAM Telegram alerts for GitHub Actions / any always-on runner.
 * Shared logic: ./gram-core.mjs + ./telegram-messages.mjs
 *
 * Required secrets/env:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, WALLET_ADDRESS
 *
 * Optional env:
 *   ALERT_ABOVE, ALERT_BELOW          — absolute price ceiling / floor
 *   ALERT_PROFIT_PCTS, ALERT_LOSS_PCTS — comma lists e.g. "0.5,1,2,3"
 *   STOP_LOSS_PCT                    — default 3
 *   REPORT=1                          — force full status + chart this run
 *   REPORT_EVERY_HOURS=6              — periodic status when PC is off (default 0=off)
 *   STATE_PATH                        — default .alert-state.json
 *   EVENT_NAME                        — set by workflow (schedule | workflow_dispatch)
 *   DRY_RUN=1                         — log only, no Telegram send
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  STON_POOL,
  RATES_TOKEN,
  DEFAULT_STRATEGY,
  mergeStrategy,
  parseSwapsFromEvents,
  calcState,
  sellIsWorthwhile,
  buyIsWorthwhile,
  detectMomentum,
  analyzeMultiTimeframe,
  normalizePriceSeries,
  evaluateAlerts,
  cooldownFor,
  cooldownKeys,
  noiseAbs,
  fmt,
  num,
  positionStance,
} from "./gram-core.mjs";
import {
  stanceLine as tgStance,
  stanceOf,
  buildStatusMessage,
  renderAlertMessage,
  alertStanceFooter,
  statusChartUrl,
} from "./telegram-messages.mjs";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT = process.env.TELEGRAM_CHAT_ID || "";
const WALLET = process.env.WALLET_ADDRESS || "";
const ALERT_ABOVE = num(process.env.ALERT_ABOVE);
const ALERT_BELOW = num(process.env.ALERT_BELOW);
const PROFIT_PCTS = listNums(process.env.ALERT_PROFIT_PCTS);
const LOSS_PCTS = listNums(process.env.ALERT_LOSS_PCTS);
const STATE_PATH = process.env.STATE_PATH || ".alert-state.json";
const REPORT_EVERY_HOURS = num(process.env.REPORT_EVERY_HOURS) || 0;
const FETCH_RETRIES = 3;

const STRATEGY = mergeStrategy({
  stopLossPct: num(process.env.STOP_LOSS_PCT) || DEFAULT_STRATEGY.stopLossPct,
});

function listNums(v) {
  if (!v) return [];
  return String(v)
    .split(/[,\s]+/)
    .map(Number)
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
}

async function fetchJson(url, ms = 15000) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      console.warn(`fetch attempt ${attempt}/${FETCH_RETRIES} failed:`, e.message || e);
      if (attempt < FETCH_RETRIES) await new Promise((r) => setTimeout(r, 800 * attempt));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr || new Error("fetch failed");
}

let poolTonReserve = 1.7e6;

async function getPrice() {
  let dex = null, cex = null;
  try {
    const j = await fetchJson("https://api.ston.fi/v1/pools/" + STON_POOL);
    const pool = j.pool || j;
    const r0 = Number(pool.reserve0), r1 = Number(pool.reserve1);
    if (r0 && r1) {
      poolTonReserve = r1 / 1e9;
      dex = { usd: (r0 / 1e6) / (r1 / 1e9), source: "STON.fi DEX" };
    }
  } catch (_) {}
  try {
    const j = await fetchJson("https://api.kraken.com/0/public/Ticker?pair=TONUSD");
    const row = j.result && j.result.TONUSD;
    const last = Number(row && row.c && row.c[0]);
    if (last) cex = { usd: last, source: "Kraken" };
  } catch (_) {}
  if (!cex) {
    try {
      const j = await fetchJson("https://api.coinbase.com/v2/prices/TON-USD/spot");
      const usd = Number(j.data && j.data.amount);
      if (usd) cex = { usd, source: "Coinbase" };
    } catch (_) {}
  }
  let tonapi = null;
  try {
    const j = await fetchJson("https://tonapi.io/v2/rates?tokens=" + RATES_TOKEN + "&currencies=usd");
    const row = j.rates && (j.rates.TON || j.rates.ton);
    const usd = row && row.prices && Number(row.prices.USD);
    if (usd) tonapi = { usd, source: "tonapi", diff24h: row.diff_24h && row.diff_24h.USD };
  } catch (_) {}

  if (!dex && !cex && !tonapi) throw new Error("no price source");
  const primary = dex || cex || tonapi;
  return {
    usd: primary.usd,
    source: primary.source,
    dexUsd: dex ? dex.usd : null,
    cexUsd: cex ? cex.usd : null,
    tonapiUsd: tonapi ? tonapi.usd : null,
    diff24h: tonapi && tonapi.diff24h,
  };
}

async function fetchPriceHistory() {
  const end = Math.floor(Date.now() / 1000);
  const start = end - 365 * 86400;
  try {
    const j = await fetchJson(
      `https://tonapi.io/v2/rates/chart?token=${RATES_TOKEN}&currency=usd&points_count=200&start_date=${start}&end_date=${end}`,
      20000
    );
    return normalizePriceSeries(j.points || []);
  } catch (e) {
    console.warn("history fetch failed:", e.message || e);
    return [];
  }
}

async function fetchWalletSwaps(addr) {
  let all = [], nextFrom = null;
  for (let i = 0; i < 15; i++) {
    let url = `https://tonapi.io/v2/accounts/${encodeURIComponent(addr)}/events?limit=100`;
    if (nextFrom != null) url += `&before_lt=${nextFrom}`;
    const j = await fetchJson(url, 20000);
    const batch = j.events || [];
    if (!batch.length) break;
    all = all.concat(batch);
    if (j.next_from == null || j.next_from === nextFrom) break;
    nextFrom = j.next_from;
  }
  return parseSwapsFromEvents(all);
}

async function fetchWalletBalances(addr) {
  const acc = await fetchJson(`https://tonapi.io/v2/accounts/${encodeURIComponent(addr)}`, 12000);
  const ton = Number(acc.balance || 0) / 1e9;
  let usdt = 0;
  try {
    const jets = await fetchJson(`https://tonapi.io/v2/accounts/${encodeURIComponent(addr)}/jettons`, 12000);
    for (const b of jets.balances || []) {
      const j = b.jetton || {};
      if ((j.symbol || "").toUpperCase().startsWith("USD") || (j.address || "").toLowerCase().includes("b113a994")) {
        usdt += Number(b.balance || 0) / Math.pow(10, j.decimals || 6);
      }
    }
  } catch (_) {}
  return { ton, usdt };
}

async function sendTelegram(text) {
  if (!TOKEN || !CHAT) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing");
  const body = new URLSearchParams();
  body.set("chat_id", CHAT);
  body.set("text", String(text == null ? "" : text).slice(0, 4096));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      signal: ctrl.signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) throw new Error(j.description || ("HTTP " + res.status));
  } finally {
    clearTimeout(t);
  }
}

async function sendTelegramPhoto(caption, photoUrl) {
  if (!TOKEN || !CHAT) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing");
  if (!photoUrl) return sendTelegram(caption);
  const cap = String(caption || "").slice(0, 1024);
  const body = new URLSearchParams();
  body.set("chat_id", CHAT);
  body.set("photo", photoUrl);
  body.set("caption", cap);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      signal: ctrl.signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) throw new Error(j.description || ("HTTP " + res.status));
  } catch (e) {
    console.warn("sendPhoto failed, fallback text:", e.message);
    await sendTelegram(caption);
  } finally {
    clearTimeout(t);
  }
}

function loadState() {
  try {
    if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch (_) {}
  return { series: [], marks: {}, version: 2 };
}
function saveState(st) {
  try {
    st.version = 2;
    st.updatedAt = Date.now();
    writeFileSync(STATE_PATH, JSON.stringify(st));
  } catch (e) {
    console.warn("state save failed", e.message);
  }
}
function recently(mem, k, cool) {
  const t = mem.marks && mem.marks[k];
  return t && Date.now() - t < (cool || STRATEGY.cool.level);
}
function mark(mem, k) {
  if (!mem.marks) mem.marks = {};
  mem.marks[k] = Date.now();
}
function pushSample(mem, p) {
  if (!Array.isArray(mem.series)) mem.series = [];
  mem.series.push({ t: Date.now(), p });
  if (mem.series.length > 120) mem.series = mem.series.slice(-120);
  return mem.series;
}

function lastTradeFromPos(pos) {
  if (!pos || !(pos.lastSwapPrice > 0) || !pos.lastSwapType) return null;
  return { type: pos.lastSwapType, price: pos.lastSwapPrice };
}

function checks() {
  return {
    sellIsWorthwhile: (s, p) => sellIsWorthwhile(s, p, poolTonReserve, STRATEGY),
    buyIsWorthwhile: (s, p) => buyIsWorthwhile(s, p, poolTonReserve, STRATEGY),
  };
}

function stanceText(pos, live) {
  return tgStance(pos, live, lastTradeFromPos(pos), checks());
}

function logEvent(obj) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));
}

async function main() {
  if (!TOKEN || !CHAT) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
    process.exit(1);
  }
  if (!WALLET) {
    console.error("Missing WALLET_ADDRESS secret");
    process.exit(1);
  }

  const priceInfo = await getPrice();
  const live = priceInfo.usd;
  logEvent({
    event: "price",
    live,
    source: priceInfo.source,
    dex: priceInfo.dexUsd,
    cex: priceInfo.cexUsd,
    tonapi: priceInfo.tonapiUsd,
    diff24h: priceInfo.diff24h,
  });

  const [swaps, bal, hist] = await Promise.all([
    fetchWalletSwaps(WALLET),
    fetchWalletBalances(WALLET).catch(() => null),
    fetchPriceHistory(),
  ]);
  logEvent({ event: "wallet", swaps: swaps.length, ton: bal && bal.ton, usdt: bal && bal.usdt, histPoints: hist.length });

  const pos = calcState(swaps, live, bal);
  const mem = loadState();
  const series = pushSample(mem, live);
  const mom = detectMomentum(series, STRATEGY);
  const mtf = analyzeMultiTimeframe(live, hist, STRATEGY);
  const stance = stanceOf(pos, live);
  const lt = lastTradeFromPos(pos);
  const quote = {
    source: priceInfo.source,
    dexUsd: priceInfo.dexUsd,
    cexUsd: priceInfo.cexUsd,
  };

  logEvent({
    event: "analysis",
    stance: stance.mode + "/" + stance.action,
    phase: mom.phase,
    dir: mom.dir,
    movePct: +Number(mom.movePct || 0).toFixed(3),
    avg: pos.avgBuyPrice,
    gram: pos.totalGram,
    usdt: pos.cashUsdt,
    mtfExtremes: (mtf.extremes || []).map((e) => e.kind + ":" + e.periodId),
  });

  const candidates = evaluateAlerts({
    pos,
    live,
    mom,
    mtf,
    lastTrade: lt,
    profitPcts: PROFIT_PCTS,
    lossPcts: LOSS_PCTS,
    alertAbove: ALERT_ABOVE,
    alertBelow: ALERT_BELOW,
    poolTonReserve,
    cfg: STRATEGY,
  });

  const ready = candidates.filter((a) => {
    const cool = cooldownFor(a, STRATEGY);
    // Family-level cooldown: any key in cooldownKeys blocks the alert
    for (const k of cooldownKeys(a)) {
      if (recently(mem, k, cool)) return false;
    }
    return true;
  });

  // Short footer aligned with position — avoids contradictory "ضرر روی کاغذ" under buy alerts
  const st = () => alertStanceFooter(pos, live);
  const msgs = ready.map((a) => ({
    key: a.key,
    family: a.family,
    urgent: !!a.urgent,
    text: renderAlertMessage(a, st()),
    priority: a.priority,
    type: a.type,
  }));

  const forceReport = process.env.REPORT === "1";
  const reportEveryMs = REPORT_EVERY_HOURS > 0 ? REPORT_EVERY_HOURS * 60 * 60 * 1000 : 0;
  const lastReportAt = (mem.marks && mem.marks._lastReport) || 0;
  const duePeriodic = reportEveryMs > 0 && Date.now() - lastReportAt >= reportEveryMs;

  if (forceReport || duePeriodic) {
    const status = buildStatusMessage(pos, live, quote, lt, checks(), poolTonReserve);
    msgs.push({ key: "_lastReport", text: status, photo: true, priority: 99 });
    console.log(forceReport ? "Forced status report" : `Periodic report due (every ${REPORT_EVERY_HOURS}h)`);
  }

  let out = msgs;
  if (out.length > 1) {
    const urgent = out.find((m) => m.urgent);
    const status = out.find((m) => m.photo);
    if (urgent) out = [urgent];
    else if ((forceReport || duePeriodic) && status) out = [status];
    else {
      out.sort((a, b) => (a.priority || 50) - (b.priority || 50));
      out = [out[0]];
    }
  }

  saveState(mem);
  if (!out.length) {
    logEvent({ event: "no_alert", candidates: candidates.length, cooled: candidates.length - ready.length });
    return;
  }

  const chart = statusChartUrl(series, live);
  const dryRun = process.env.DRY_RUN === "1";
  let sent = 0;
  for (const m of out) {
    console.log((dryRun ? "[DRY] " : "") + "Sending:", (m.type || m.key || "") + " | " + m.text.slice(0, 100).replace(/\n/g, " · "));
    const markAll = () => {
      for (const k of cooldownKeys(m)) mark(mem, k);
    };
    if (dryRun) {
      markAll();
      sent++;
      continue;
    }
    try {
      if (m.photo && chart) await sendTelegramPhoto(m.text, chart);
      else await sendTelegram(m.text);
      markAll();
      sent++;
      logEvent({ event: "sent", key: m.key, family: m.family, type: m.type, urgent: !!m.urgent });
    } catch (e) {
      console.error("Send failed:", e.message || e);
      logEvent({ event: "send_failed", key: m.key, error: String(e.message || e) });
    }
  }
  saveState(mem);
  console.log(`${dryRun ? "Dry-run prepared" : "Sent"} ${sent}/${out.length} message(s)`);
  if (!dryRun && sent === 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  logEvent({ event: "fatal", error: String(e.message || e) });
  process.exit(1);
});
