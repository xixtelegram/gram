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
 *   REPORT=1                          — force full status + chart this run
 *   REPORT_EVERY_HOURS=6              — periodic status when PC is off (default 0=off)
 *   STATE_PATH                        — default .alert-state.json
 *   EVENT_NAME                        — set by workflow (schedule | workflow_dispatch)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  STON_POOL,
  parseSwapsFromEvents,
  calcState,
  positionStance,
  sellIsWorthwhile,
  buyIsWorthwhile,
  detectMomentum,
  noiseAbs,
  fmt,
  num,
} from "./gram-core.mjs";
import {
  stanceLine as tgStance,
  buildStatusMessage,
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
const COOLDOWN_MS = 20 * 60 * 1000;
const COOL_MOM_MS = 12 * 60 * 1000;
const FETCH_RETRIES = 3;

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
  if (!dex && !cex) throw new Error("no price source");
  const primary = dex || cex;
  return {
    usd: primary.usd,
    source: primary.source,
    dexUsd: dex ? dex.usd : null,
    cexUsd: cex ? cex.usd : null,
  };
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

/** Text + optional chart image (caption max ~1024 chars) */
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
  return { series: [], marks: {} };
}
function saveState(st) {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(st));
  } catch (e) {
    console.warn("state save failed", e.message);
  }
}
function recently(mem, k, cool) {
  const t = mem.marks && mem.marks[k];
  return t && Date.now() - t < (cool || COOLDOWN_MS);
}
function mark(mem, k) {
  if (!mem.marks) mem.marks = {};
  mem.marks[k] = Date.now();
}
function pushSample(mem, p) {
  if (!Array.isArray(mem.series)) mem.series = [];
  mem.series.push({ t: Date.now(), p });
  if (mem.series.length > 80) mem.series = mem.series.slice(-80);
  return mem.series;
}

function lastTradeFromPos(pos) {
  if (!pos || !(pos.lastSwapPrice > 0) || !pos.lastSwapType) return null;
  return { type: pos.lastSwapType, price: pos.lastSwapPrice };
}

function checks() {
  return {
    sellIsWorthwhile: (s, p) => sellIsWorthwhile(s, p, poolTonReserve),
    buyIsWorthwhile: (s, p) => buyIsWorthwhile(s, p, poolTonReserve),
  };
}

function stanceText(pos, live) {
  return tgStance(pos, live, lastTradeFromPos(pos), checks());
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
  console.log(`Price ${live} from ${priceInfo.source}`);

  const [swaps, bal] = await Promise.all([
    fetchWalletSwaps(WALLET),
    fetchWalletBalances(WALLET).catch(() => null),
  ]);
  console.log(`Swaps: ${swaps.length}`);
  const pos = calcState(swaps, live, bal);
  console.log(`Pos GRAM=${pos.totalGram} USDT=${pos.cashUsdt} avg=${pos.avgBuyPrice}`);

  const mem = loadState();
  const series = pushSample(mem, live);
  const mom = detectMomentum(series);
  const stance = positionStance(pos, live);
  const lt = lastTradeFromPos(pos);
  const quote = { source: priceInfo.source, dexUsd: priceInfo.dexUsd, cexUsd: priceInfo.cexUsd };
  /** @type {{text:string, photo?:boolean, key?:string, urgent?:boolean}[]} */
  const msgs = [];
  const st = () => stanceText(pos, live);
  const nAbs = mom.noise || noiseAbs(live);
  const movePct = mom.movePct != null ? mom.movePct : (mom.from > 0 ? ((live - mom.from) / mom.from) * 100 : 0);
  const COOL_REV_MS = 8 * 60 * 1000;
  const COOL_PHASE_MS = 18 * 60 * 1000;

  console.log(`Stance=${stance.mode}/${stance.action} phase=${mom.phase} dir=${mom.dir} movePct=${movePct.toFixed(2)}`);

  // Priority 0: برگشت روند فوری (وابسته به پوزیشن)
  if (stance.action === "sell" && mom.phase === "reversal_down" && !recently(mem, "phase_rev_sell", COOL_REV_MS)) {
    if (Math.abs(mom.delta) >= nAbs) {
      msgs.push({
        key: "phase_rev_sell",
        urgent: true,
        text: msgReversalSell(mom.from, live, Math.abs(mom.delta), Math.abs(movePct), st()),
      });
    }
  }
  if (stance.action === "buy" && mom.phase === "reversal_up" && !recently(mem, "phase_rev_buy", COOL_REV_MS)) {
    if (Math.abs(mom.delta) >= nAbs) {
      msgs.push({
        key: "phase_rev_buy",
        urgent: true,
        text: msgReversalBuy(mom.from, live, Math.abs(movePct), st()),
      });
    }
  }

  // Priority 1: سقف / کف
  if (ALERT_ABOVE != null && live >= ALERT_ABOVE && !recently(mem, "above")) {
    msgs.push({ key: "above", text: msgCeiling(ALERT_ABOVE, live, st()) });
  }
  if (ALERT_BELOW != null && live <= ALERT_BELOW && !recently(mem, "below")) {
    msgs.push({ key: "below", text: msgFloor(ALERT_BELOW, live, st()) });
  }

  // Priority 2: درصد نسبت به آخرین سواپ — فقط هم‌جهت با پوزیشن
  if (lt && lt.price > 0) {
    const ref = lt.price;
    const vsSwap = ((live - ref) / ref) * 100;
    if (stance.action === "sell" && lt.type === "buy") {
      for (const target of PROFIT_PCTS) {
        const key = "ls_profit_buy_" + target;
        if (vsSwap >= target && !recently(mem, key)) {
          msgs.push({ key, text: msgProfitBuy(vsSwap, target, ref, live, st()) });
          break;
        }
      }
      for (const loss of LOSS_PCTS) {
        const key = "ls_loss_buy_" + loss;
        if (vsSwap <= -loss && !recently(mem, key)) {
          msgs.push({ key, text: msgLossBuy(vsSwap, loss, ref, live, st()) });
          break;
        }
      }
    }
    if (stance.action === "buy" && lt.type === "sell") {
      for (const target of PROFIT_PCTS) {
        const key = "ls_profit_sell_" + target;
        if (vsSwap <= -target && !recently(mem, key)) {
          msgs.push({ key, text: msgProfitSell(vsSwap, target, ref, live, st()) });
          break;
        }
      }
      for (const loss of LOSS_PCTS) {
        const key = "ls_loss_sell_" + loss;
        if (vsSwap >= loss && !recently(mem, key)) {
          msgs.push({ key, text: msgLossSell(vsSwap, loss, ref, live, st()) });
          break;
        }
      }
    }
  }

  // Priority 3: ادامه روند — آماده‌باش
  if (stance.action === "sell" && mom.phase === "rally" && !recently(mem, "phase_rally", COOL_PHASE_MS)) {
    if (Math.abs(mom.delta) >= nAbs || (mom.strength || 0) >= 0.6) {
      msgs.push({ key: "phase_rally", text: msgRallyPrepare(mom.from, live, Math.abs(movePct), st()) });
    }
  }
  if (stance.action === "buy" && mom.phase === "dump" && !recently(mem, "phase_dump", COOL_PHASE_MS)) {
    if (Math.abs(mom.delta) >= nAbs || (mom.strength || 0) >= 0.6) {
      msgs.push({ key: "phase_dump", text: msgDumpWatch(mom.from, live, Math.abs(movePct), st()) });
    }
  }

  // Force report (manual) or periodic status while PC is offline
  const forceReport = process.env.REPORT === "1";
  const reportEveryMs = REPORT_EVERY_HOURS > 0 ? REPORT_EVERY_HOURS * 60 * 60 * 1000 : 0;
  const lastReportAt = (mem.marks && mem.marks._lastReport) || 0;
  const duePeriodic =
    reportEveryMs > 0 && Date.now() - lastReportAt >= reportEveryMs;

  if (forceReport || duePeriodic) {
    const status = buildStatusMessage(pos, live, quote, lt, checks(), poolTonReserve);
    msgs.push({ key: "_lastReport", text: status, photo: true });
    console.log(forceReport ? "Forced status report" : `Periodic report due (every ${REPORT_EVERY_HOURS}h)`);
  }

  // یک پیام اولویت‌دار در هر اجرا
  // اولویت: urgent (برگشت روند) > بقیه هشدارها > گزارش دوره‌ای
  let out = msgs;
  if (out.length > 1) {
    const urgent = out.find((m) => m.urgent);
    const status = out.find((m) => m.photo);
    if (urgent) out = [urgent];
    else if ((forceReport || duePeriodic) && status) out = [status];
    else out = [out[0]];
  }

  // Always persist price series; cooldown marks only after successful send
  saveState(mem);
  if (!out.length) {
    console.log("No alerts to send");
    return;
  }

  const chart = statusChartUrl(series, live);
  const dryRun = process.env.DRY_RUN === "1";
  let sent = 0;
  for (const m of out) {
    console.log((dryRun ? "[DRY] " : "") + "Sending:", m.text.slice(0, 120).replace(/\n/g, " | "));
    if (dryRun) {
      if (m.key) mark(mem, m.key);
      sent++;
      continue;
    }
    try {
      if (m.photo && chart) await sendTelegramPhoto(m.text, chart);
      else await sendTelegram(m.text);
      if (m.key) mark(mem, m.key);
      sent++;
    } catch (e) {
      console.error("Send failed:", e.message || e);
    }
  }
  saveState(mem);
  console.log(`${dryRun ? "Dry-run prepared" : "Sent"} ${sent}/${out.length} message(s)`);
  if (!dryRun && sent === 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
