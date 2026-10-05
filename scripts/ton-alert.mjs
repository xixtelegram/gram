/**
 * GRAM Telegram alerts for GitHub Actions.
 * Shared logic: ./gram-core.mjs
 *
 * Required secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, WALLET_ADDRESS
 * Optional: ALERT_ABOVE, ALERT_BELOW, ALERT_PROFIT_PCTS, ALERT_LOSS_PCTS
 * REPORT=1 or workflow_dispatch → always send status
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  STON_POOL,
  parseSwapsFromEvents,
  calcState,
  stanceLine,
  positionStance,
  sellIsWorthwhile,
  buyIsWorthwhile,
  detectMomentum,
  noiseAbs,
  fmt,
  num,
  MIN_ACTION_PCT,
} from "./gram-core.mjs";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT = process.env.TELEGRAM_CHAT_ID || "";
const WALLET = process.env.WALLET_ADDRESS || "";
const ALERT_ABOVE = num(process.env.ALERT_ABOVE);
const ALERT_BELOW = num(process.env.ALERT_BELOW);
const PROFIT_PCTS = listNums(process.env.ALERT_PROFIT_PCTS);
const LOSS_PCTS = listNums(process.env.ALERT_LOSS_PCTS);
const STATE_PATH = process.env.STATE_PATH || ".alert-state.json";
const COOLDOWN_MS = 20 * 60 * 1000;
const COOL_MOM_MS = 12 * 60 * 1000;

function listNums(v) {
  if (!v) return [];
  return String(v)
    .split(/[,\s]+/)
    .map(Number)
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
}

async function fetchJson(url, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
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
  const url =
    `https://api.telegram.org/bot${TOKEN}/sendMessage` +
    `?chat_id=${encodeURIComponent(CHAT)}&text=${encodeURIComponent(text)}`;
  const j = await fetchJson(url, 15000);
  if (!j.ok) throw new Error(j.description || "telegram failed");
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
  const stance = positionStance(pos);
  const msgs = [];

  if (ALERT_ABOVE != null && live >= ALERT_ABOVE && !recently(mem, "above")) {
    mark(mem, "above");
    msgs.push(`🔺 قیمت به سقف مورد نظرت رسید\n\nسقف تو: ${fmt(ALERT_ABOVE)}\nقیمت الان: ${fmt(live)}\n\n${stanceLine(pos, live, poolTonReserve)}`);
  }
  if (ALERT_BELOW != null && live <= ALERT_BELOW && !recently(mem, "below")) {
    mark(mem, "below");
    msgs.push(`🔻 قیمت به کف مورد نظرت رسید\n\nکف تو: ${fmt(ALERT_BELOW)}\nقیمت الان: ${fmt(live)}\n\n${stanceLine(pos, live, poolTonReserve)}`);
  }

  // Last-swap relative alerts
  if (pos.lastSwapPrice > 0 && pos.lastSwapType) {
    const ref = pos.lastSwapPrice;
    const movePct = ((live - ref) / ref) * 100;
    if (pos.lastSwapType === "buy") {
      for (const target of PROFIT_PCTS) {
        const key = "ls_profit_buy_" + target;
        if (movePct >= target && !recently(mem, key)) {
          mark(mem, key);
          msgs.push(`✅ نسبت به خریدت در سودی\n\nآخرین خرید تو: ${fmt(ref)} USDT\nقیمت الان:     ${fmt(live)} USDT\nیعنی حدود +${movePct.toFixed(2)}٪ (هدف: +${target}٪)\n\n${stanceLine(pos, live, poolTonReserve)}`);
          break;
        }
      }
      for (const loss of LOSS_PCTS) {
        const key = "ls_loss_buy_" + loss;
        if (movePct <= -loss && !recently(mem, key)) {
          mark(mem, key);
          msgs.push(`⚠️ نسبت به خریدت کمی عقب افتادی\n\nآخرین خرید تو: ${fmt(ref)} USDT\nقیمت الان:     ${fmt(live)} USDT\nیعنی حدود ${movePct.toFixed(2)}٪ (آستانه: −${loss}٪)\nاین ضرر هنوز قطعی نشده مگر بفروشی.\n\n${stanceLine(pos, live, poolTonReserve)}`);
          break;
        }
      }
    } else if (pos.lastSwapType === "sell") {
      for (const target of PROFIT_PCTS) {
        const key = "ls_profit_sell_" + target;
        if (movePct <= -target && !recently(mem, key)) {
          mark(mem, key);
          msgs.push(`✅ فرصت خرید نزدیک است\n\nآخرین فروش تو: ${fmt(ref)} USDT\nقیمت الان:     ${fmt(live)} USDT\nیعنی حدود ${movePct.toFixed(2)}٪ نسبت به فروش (هدف: −${target}٪)\n\n${stanceLine(pos, live, poolTonReserve)}`);
          break;
        }
      }
      for (const loss of LOSS_PCTS) {
        const key = "ls_loss_sell_" + loss;
        if (movePct >= loss && !recently(mem, key)) {
          mark(mem, key);
          msgs.push(`⚠️ بعد از فروش تو، قیمت کمی بالا رفت\n\nآخرین فروش تو: ${fmt(ref)} USDT\nقیمت الان:     ${fmt(live)} USDT\nیعنی حدود +${movePct.toFixed(2)}٪ گران‌تر از وقتی فروختی (آستانه: +${loss}٪)\n\nعجله نکن — برای خرید دوباره صبر کن.\n\n${stanceLine(pos, live, poolTonReserve)}`);
          break;
        }
      }
    }
  }

  if (mom.dir === "up" && stance.action === "sell" && !recently(mem, "mom_up_sell", COOL_MOM_MS)) {
    if (sellIsWorthwhile(pos, live, poolTonReserve)) {
      mark(mem, "mom_up_sell");
      msgs.push(`📈 قیمت در حال بالا رفتن است\n\nاز ${fmt(mom.from)} به ${fmt(live)} (حدود +${fmt(Math.abs(mom.delta))})\n\n${stanceLine(pos, live, poolTonReserve)}`);
    }
  }
  if (mom.dir === "down" && stance.action === "sell" && !recently(mem, "mom_down_sell", COOL_MOM_MS)) {
    const drop = Math.abs(mom.delta);
    if (drop >= (mom.noise || noiseAbs(live))) {
      mark(mem, "mom_down_sell");
      msgs.push(`📉 قیمت در حال پایین آمدن است\n\nاز ${fmt(mom.from)} به ${fmt(live)} (حدود −${fmt(drop)})\n\n${stanceLine(pos, live, poolTonReserve)}`);
    }
  }
  if (mom.dir === "down" && stance.action === "buy" && !recently(mem, "mom_down_buy", COOL_MOM_MS)) {
    const drop = Math.abs(mom.delta);
    if (drop >= (mom.noise || noiseAbs(live)) && buyIsWorthwhile(pos, live, poolTonReserve)) {
      mark(mem, "mom_down_buy");
      msgs.push(`📉 قیمت پایین آمده\n\nاز ${fmt(mom.from)} به ${fmt(live)} (حدود −${fmt(drop)})\n\n${stanceLine(pos, live, poolTonReserve)}`);
    }
  }
  if (mom.dir === "up" && stance.action === "buy" && !recently(mem, "mom_up_buy", COOL_MOM_MS)) {
    const ref = pos.lastSwapType === "sell" ? pos.lastSwapPrice : null;
    const chasing = ref != null && live > ref + (mom.noise || noiseAbs(live));
    if (!chasing && (buyIsWorthwhile(pos, live, poolTonReserve) || Math.abs(mom.delta) >= (mom.noise || noiseAbs(live)))) {
      mark(mem, "mom_up_buy");
      msgs.push(`📈 قیمت بعد از ضعف دوباره بالا می‌آید\n\nحرکت حدود +${fmt(Math.abs(mom.delta))}\nقیمت الان: ${fmt(live)}\n\n${stanceLine(pos, live, poolTonReserve)}`);
    }
  }

  const forceReport = process.env.REPORT === "1" || process.env.EVENT_NAME === "workflow_dispatch";
  if (forceReport) {
    let msg = `📊 وضعیت الان\n\nقیمت: ${fmt(live)} USDT (${priceInfo.source})`;
    if (priceInfo.dexUsd != null && priceInfo.cexUsd != null) {
      msg += `\nDEX ${fmt(priceInfo.dexUsd)} · CEX ${fmt(priceInfo.cexUsd)}`;
    }
    if (pos.totalGram > 0) msg += `\nموجودی GRAM: ${fmt(pos.totalGram, 4)}`;
    if (pos.cashUsdt > 0) msg += `\nموجودی USDT: ${fmt(pos.cashUsdt, 2)}`;
    msg += `\nارزش تقریبی کل: ${fmt(pos.equity, 2)}`;
    msg += `\n\n${stanceLine(pos, live, poolTonReserve)}`;
    msgs.push(msg);
  }

  saveState(mem);
  if (!msgs.length) {
    console.log("No alerts to send (no threshold; scheduled without REPORT)");
    return;
  }
  for (const m of msgs) {
    console.log("Sending:", m.slice(0, 100).replace(/\n/g, " | "));
    await sendTelegram(m);
  }
  console.log(`Sent ${msgs.length} message(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
