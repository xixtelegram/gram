/**
 * GRAM (TON) Telegram alert runner for GitHub Actions.
 * Reads config from env (secrets). Sends price / P&L alerts without a browser.
 *
 * Required secrets:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 * Optional:
 *   WALLET_ADDRESS          (default: project wallet)
 *   ALERT_ABOVE             e.g. 1.60
 *   ALERT_BELOW             e.g. 1.40
 *   ALERT_PROFIT_PCTS       e.g. "5,10"  (needs STARTING_CAPITAL + wallet)
 *   ALERT_LOSS_PCTS         e.g. "5,10"
 *   STARTING_CAPITAL        e.g. 200
 *   STATE_PATH              path to persist last-sent markers (default: .alert-state.json)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT = process.env.TELEGRAM_CHAT_ID || "";
const WALLET = process.env.WALLET_ADDRESS || "EQCw1-hJcfl_YlneBdXmw2OHNx9CO76r5fDrl4gCI4uaf7wR";
const ALERT_ABOVE = num(process.env.ALERT_ABOVE);
const ALERT_BELOW = num(process.env.ALERT_BELOW);
const PROFIT_PCTS = listNums(process.env.ALERT_PROFIT_PCTS);
const LOSS_PCTS = listNums(process.env.ALERT_LOSS_PCTS);
const START_CAP = num(process.env.STARTING_CAPITAL) || 0;
const STATE_PATH = process.env.STATE_PATH || ".alert-state.json";
const COOLDOWN_MS = 20 * 60 * 1000;
const USDT_MASTER = "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function listNums(v) {
  if (!v) return [];
  return String(v)
    .split(/[,\s]+/)
    .map(Number)
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
}

async function fetchJson(url, ms = 12000) {
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

async function getPrice() {
  // Kraken TONUSD first
  try {
    const j = await fetchJson("https://api.kraken.com/0/public/Ticker?pair=TONUSD");
    const row = j.result && j.result.TONUSD;
    const last = Number(row && row.c && row.c[0]);
    if (last) return { usd: last, source: "Kraken" };
  } catch (_) {}
  try {
    const j = await fetchJson("https://api.coinbase.com/v2/prices/TON-USD/spot");
    const usd = Number(j.data && j.data.amount);
    if (usd) return { usd, source: "Coinbase" };
  } catch (_) {}
  try {
    const j = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd");
    const usd = j["the-open-network"] && j["the-open-network"].usd;
    if (usd) return { usd, source: "CoinGecko" };
  } catch (_) {}
  throw new Error("no price source");
}

function isUsdt(j) {
  if (!j) return false;
  const s = (j.symbol || "").toUpperCase();
  return s.startsWith("USD") || (j.address && j.address.toLowerCase().includes("b113a994"));
}

function parseSwaps(events) {
  const out = [];
  for (const e of events || []) {
    const ts = new Date(e.timestamp * 1000).toISOString();
    const eid = e.event_id || "";
    const actions = e.actions || [];
    const acct = (e.account && e.account.address || "").toLowerCase();
    const same = (a) => (a || "").toLowerCase() === acct;

    for (const a of actions) {
      if (a.status && a.status !== "ok") continue;
      if (a.type !== "JettonSwap") continue;
      const js = a.JettonSwap || {};
      if (isUsdt(js.jetton_master_in) && js.ton_out) {
        const usdt = Number(js.amount_in) / 1e6;
        const gram = Number(js.ton_out) / 1e9;
        if (usdt > 0.01 && gram > 0.01) out.push({ type: "buy", date: ts, gram, usdt, eventId: eid });
      } else if (isUsdt(js.jetton_master_out) && js.ton_in) {
        const usdt = Number(js.amount_out) / 1e6;
        const gram = Number(js.ton_in) / 1e9;
        if (usdt > 0.01 && gram > 0.01) out.push({ type: "sell", date: ts, gram, usdt, eventId: eid });
      }
    }
    if (actions.some((a) => a.type === "JettonSwap")) continue;

    let tonIn = 0, tonOut = 0, usdtIn = 0, usdtOut = 0;
    for (const a of actions) {
      if (a.status && a.status !== "ok") continue;
      if (a.type === "TonTransfer") {
        const tt = a.TonTransfer || {};
        const amt = Number(tt.amount || 0) / 1e9;
        if (same(tt.sender && tt.sender.address)) tonOut += amt;
        if (same(tt.recipient && tt.recipient.address)) tonIn += amt;
      }
      if (a.type === "JettonTransfer") {
        const jt = a.JettonTransfer || {};
        if (!isUsdt(jt.jetton)) continue;
        const amt = Number(jt.amount || 0) / 1e6;
        if (same(jt.sender && jt.sender.address)) usdtOut += amt;
        if (same(jt.recipient && jt.recipient.address)) usdtIn += amt;
      }
    }
    if (tonOut > 1 && usdtIn > 0.5 && tonOut > tonIn) {
      out.push({ type: "sell", date: ts, gram: tonOut - tonIn, usdt: usdtIn - usdtOut, eventId: eid });
    } else if (tonIn > 1 && usdtOut > 0.5 && tonIn > tonOut) {
      out.push({ type: "buy", date: ts, gram: tonIn - tonOut, usdt: usdtOut - usdtIn, eventId: eid });
    }
  }
  const seen = new Set();
  return out.filter((s) => {
    const k = s.eventId || s.date + s.type;
    if (seen.has(k)) return false;
    seen.add(k);
    return s.gram > 0.5 && s.usdt > 0.5;
  });
}

function calcPosition(swaps, price, startCap) {
  const sorted = swaps.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  let cash = startCap || 0;
  let gram = 0, cost = 0;
  for (const t of sorted) {
    if (t.type === "buy") {
      cash -= t.usdt;
      const newCost = cost + t.usdt;
      const newGram = gram + t.gram;
      cost = newCost;
      gram = newGram;
    } else {
      if (gram <= 0) continue;
      const ratio = Math.min(1, t.gram / gram);
      const soldCost = cost * ratio;
      cash += t.usdt;
      gram -= t.gram;
      cost -= soldCost;
      if (gram < 1e-12) { gram = 0; cost = 0; }
    }
  }
  const avg = gram > 0 ? cost / gram : 0;
  const value = gram * (price || 0);
  const equity = cash + value;
  const invested = cost;
  const unrealized = value - invested;
  const totalPnl = equity - (startCap || 0);
  return { gram, cash, avg, invested, value, equity, unrealized, totalPnl };
}

async function fetchWalletSwaps(addr) {
  const j = await fetchJson(`https://tonapi.io/v2/accounts/${encodeURIComponent(addr)}/events?limit=100`, 20000);
  return parseSwaps(j.events || []);
}

async function sendTelegram(text) {
  if (!TOKEN || !CHAT) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing");
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview: true }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.description || "telegram failed");
  return j;
}

function loadState() {
  try {
    if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch (_) {}
  return {};
}
function saveState(s) {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}
function recently(mem, key) {
  return mem[key] && Date.now() - mem[key] < COOLDOWN_MS;
}
function mark(mem, key) {
  mem[key] = Date.now();
}

function fmt(n, d = 4) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

async function main() {
  if (!TOKEN || !CHAT) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
    process.exit(1);
  }

  const priceInfo = await getPrice();
  const live = priceInfo.usd;
  console.log(`Price ${live} from ${priceInfo.source}`);

  let pos = null;
  try {
    const swaps = await fetchWalletSwaps(WALLET);
    console.log(`Wallet swaps: ${swaps.length}`);
    pos = calcPosition(swaps, live, START_CAP);
    console.log(`Position GRAM=${pos.gram} cash=${pos.cash} avg=${pos.avg} equity=${pos.equity}`);
  } catch (e) {
    console.warn("Wallet fetch failed:", e.message);
  }

  const mem = loadState();
  const msgs = [];

  if (ALERT_ABOVE != null && live >= ALERT_ABOVE && !recently(mem, "above")) {
    mark(mem, "above");
    msgs.push(`🔺 GRAM به ${fmt(live)} رسید (سقف ${fmt(ALERT_ABOVE)})`);
  }
  if (ALERT_BELOW != null && live <= ALERT_BELOW && !recently(mem, "below")) {
    mark(mem, "below");
    msgs.push(`🔻 GRAM به ${fmt(live)} رسید (کف ${fmt(ALERT_BELOW)})`);
  }

  if (pos && pos.invested > 0) {
    const curPct = (pos.unrealized / pos.invested) * 100;
    for (const target of PROFIT_PCTS) {
      const key = `profit_${target}`;
      if (curPct >= target && !recently(mem, key)) {
        mark(mem, key);
        msgs.push(`✅ هدف سود ${target}٪ رسید. سود فعلی ${curPct.toFixed(2)}٪ · قیمت ${fmt(live)}`);
        break;
      }
    }
    for (const loss of LOSS_PCTS) {
      const key = `loss_${loss}`;
      if (curPct <= -loss && !recently(mem, key)) {
        mark(mem, key);
        msgs.push(`⚠️ هشدار ضرر ${loss}٪. زیان فعلی ${curPct.toFixed(2)}٪ · قیمت ${fmt(live)}`);
        break;
      }
    }
  }

  // Optional heartbeat every run when REPORT=1
  if (process.env.REPORT === "1") {
    let msg = `📊 گزارش GRAM\nقیمت: ${fmt(live)} USDT (${priceInfo.source})`;
    if (pos) {
      if (pos.gram > 0) msg += `\nموجودی: ${fmt(pos.gram, 4)} GRAM`;
      if (pos.cash > 0) msg += `\nUSDT: ${fmt(pos.cash, 2)}`;
      msg += `\nارزش کل: ${fmt(pos.equity, 2)}`;
      if (START_CAP > 0) {
        const p = (pos.totalPnl / START_CAP) * 100;
        msg += `\nسود/زیان: ${pos.totalPnl >= 0 ? "+" : ""}${fmt(pos.totalPnl, 2)} (${p >= 0 ? "+" : ""}${p.toFixed(2)}٪)`;
      }
    }
    msgs.push(msg);
  }

  saveState(mem);

  if (!msgs.length) {
    console.log("No alerts to send");
    return;
  }

  for (const m of msgs) {
    console.log("Sending:", m);
    await sendTelegram(m);
  }
  console.log(`Sent ${msgs.length} message(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
