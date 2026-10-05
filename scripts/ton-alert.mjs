/**
 * GRAM (TON) Telegram alert runner for GitHub Actions.
 * Smart stance + momentum alerts (no browser required).
 *
 * Required secrets:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 * Optional:
 *   WALLET_ADDRESS          (default: project wallet)
 *   ALERT_ABOVE             e.g. 1.60
 *   ALERT_BELOW             e.g. 1.40
 *   ALERT_PROFIT_PCTS       e.g. "5,10"
 *   ALERT_LOSS_PCTS         e.g. "5,10"
 *   STARTING_CAPITAL        e.g. 200
 *   NOISE                   absolute price noise floor (default 0.02)
 *   MIN_ACTION_PCT          min % edge over break-even to suggest action (default 0.4)
 *   STATE_PATH              default .alert-state.json
 *   REPORT=1                force a full status message
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
const NOISE = num(process.env.NOISE) ?? 0.02;
const MIN_ACTION_PCT = num(process.env.MIN_ACTION_PCT) ?? 0.4;
const COOLDOWN_MS = 20 * 60 * 1000;
const COOL_MOM_MS = 12 * 60 * 1000;

function num(v) {
  if (v === undefined || v === null || v === "") return null;
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
  let lastSwapType = null, lastSwapPrice = null;
  for (const t of sorted) {
    if (t.type === "buy") {
      cash -= t.usdt;
      cost += t.usdt;
      gram += t.gram;
      lastSwapType = "buy";
      lastSwapPrice = t.usdt / t.gram;
    } else {
      if (gram <= 0) continue;
      const ratio = Math.min(1, t.gram / gram);
      const soldCost = cost * ratio;
      cash += t.usdt;
      gram -= t.gram;
      cost -= soldCost;
      if (gram < 1e-12) { gram = 0; cost = 0; }
      lastSwapType = "sell";
      lastSwapPrice = t.usdt / t.gram;
    }
  }
  const avg = gram > 0 ? cost / gram : 0;
  const value = gram * (price || 0);
  const equity = cash + value;
  const invested = cost;
  const unrealized = value - invested;
  const totalPnl = equity - (startCap || 0);
  return {
    gram, cash, avg, invested, value, equity, unrealized, totalPnl,
    lastSwapType, lastSwapPrice,
  };
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
function recently(mem, key, cool = COOLDOWN_MS) {
  return mem[key] && Date.now() - mem[key] < cool;
}
function mark(mem, key) {
  mem[key] = Date.now();
}

function fmt(n, d = 4) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function pushSeries(mem, price) {
  if (!Array.isArray(mem.series)) mem.series = [];
  const now = Date.now();
  mem.series.push({ t: now, p: price });
  const cutoff = now - 3 * 60 * 60 * 1000;
  mem.series = mem.series.filter((x) => x.t >= cutoff).slice(-200);
  return mem.series;
}

function detectMomentum(series) {
  if (!series || series.length < 3) return { dir: "flat", delta: 0, from: null, to: null };
  const recent = series.slice(-12);
  const from = recent[0].p;
  const to = recent[recent.length - 1].p;
  const delta = to - from;
  let up = 0, down = 0;
  for (let i = 1; i < recent.length; i++) {
    const d = recent[i].p - recent[i - 1].p;
    if (d >= NOISE) up++;
    else if (d <= -NOISE) down++;
  }
  if (Math.abs(delta) < NOISE) return { dir: "flat", delta, from, to };
  if (delta > 0 && up >= down) return { dir: "up", delta, from, to };
  if (delta < 0 && down >= up) return { dir: "down", delta, from, to };
  return { dir: "flat", delta, from, to };
}

function positionStance(pos, live) {
  const hasGram = pos && pos.gram > 1e-6;
  const hasUsdt = pos && pos.cash > 1e-6;
  if (hasGram && !hasUsdt) {
    return { mode: "hold_gram", label: "الان GRAM داری — منتظر اوج سود برای فروش", action: "sell" };
  }
  if (hasUsdt && !hasGram) {
    return { mode: "hold_usdt", label: "الان USDT داری — منتظر ریزش GRAM برای خرید", action: "buy" };
  }
  if (hasGram && hasUsdt) {
    const gVal = pos.gram * (live || pos.avg || 0);
    if (gVal >= pos.cash) {
      return { mode: "hold_gram", label: "بیشتر GRAM داری — تمرکز روی فروش در اوج", action: "sell" };
    }
    return { mode: "hold_usdt", label: "بیشتر USDT داری — تمرکز روی خرید در کف", action: "buy" };
  }
  return { mode: "empty", label: "پوزیشن خالی", action: null };
}

function sellIsWorthwhile(pos, price) {
  if (!pos || !pos.avg || pos.gram <= 0 || !price) return false;
  const pct = ((price - pos.avg) / pos.avg) * 100;
  return pct >= MIN_ACTION_PCT && (price - pos.avg) >= NOISE * 0.5;
}

function buyIsWorthwhile(pos, price) {
  if (!price || !pos) return false;
  const ref = pos.lastSwapType === "sell" && pos.lastSwapPrice ? pos.lastSwapPrice : null;
  if (ref != null) {
    const pct = ((ref - price) / ref) * 100;
    return pct >= MIN_ACTION_PCT && (ref - price) >= NOISE * 0.5;
  }
  return true;
}

function stanceLine(stance, pos, price) {
  let line = "📍 " + stance.label;
  if (stance.mode === "hold_gram" && pos && pos.avg) {
    const pct = price ? ((price - pos.avg) / pos.avg) * 100 : null;
    line += `\nمیانگین ورود: ${fmt(pos.avg)}`;
    if (pct != null) line += ` · سود/زیان شناور: ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}٪`;
    if (price && !sellIsWorthwhile(pos, price)) line += "\n⚠️ هنوز نزدیک سربه‌سر — فروش الکی پیشنهاد نمی‌شود";
  }
  if (stance.mode === "hold_usdt" && pos) {
    if (pos.lastSwapType === "sell" && pos.lastSwapPrice) {
      line += `\nآخرین فروش: ${fmt(pos.lastSwapPrice)}`;
      if (price) {
        const pct = ((pos.lastSwapPrice - price) / pos.lastSwapPrice) * 100;
        line += ` · فاصله: ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}٪ ارزان‌تر`;
      }
    }
    line += `\nموجودی USDT: ${fmt(pos.cash, 2)}`;
  }
  return line;
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
  const series = pushSeries(mem, live);
  const mom = detectMomentum(series);
  const stance = positionStance(pos, live);
  const msgs = [];

  console.log(`Momentum: ${mom.dir} delta=${mom.delta} stance=${stance.mode}`);

  // Fixed thresholds
  if (ALERT_ABOVE != null && live >= ALERT_ABOVE && !recently(mem, "above")) {
    mark(mem, "above");
    let msg = `🔺 GRAM به ${fmt(live)} رسید (سقف ${fmt(ALERT_ABOVE)})\n${stanceLine(stance, pos, live)}`;
    if (stance.action === "sell" && sellIsWorthwhile(pos, live)) msg += "\n✅ الان بالای هدف — آماده فروش باش";
    msgs.push(msg);
  }
  if (ALERT_BELOW != null && live <= ALERT_BELOW && !recently(mem, "below")) {
    mark(mem, "below");
    let msg = `🔻 GRAM به ${fmt(live)} رسید (کف ${fmt(ALERT_BELOW)})\n${stanceLine(stance, pos, live)}`;
    if (stance.action === "buy" && buyIsWorthwhile(pos, live)) msg += "\n✅ قیمت پایین آمده — آماده خرید GRAM باش";
    msgs.push(msg);
  }

  // Profit / loss targets
  if (pos && pos.invested > 0) {
    const curPct = (pos.unrealized / pos.invested) * 100;
    for (const target of PROFIT_PCTS) {
      const key = `profit_${target}`;
      if (curPct >= target && !recently(mem, key)) {
        mark(mem, key);
        msgs.push(`✅ هدف سود ${target}٪ رسید\nسود فعلی ${curPct.toFixed(2)}٪ · قیمت ${fmt(live)}\n${stanceLine(stance, pos, live)}\nاگر روند صعودی ادامه دارد کمی صبر کن؛ اگر برگشت، بفروش`);
        break;
      }
    }
    for (const loss of LOSS_PCTS) {
      const key = `loss_${loss}`;
      if (curPct <= -loss && !recently(mem, key)) {
        mark(mem, key);
        msgs.push(`⚠️ هشدار ضرر ${loss}٪\nزیان فعلی ${curPct.toFixed(2)}٪ · قیمت ${fmt(live)}\n${stanceLine(stance, pos, live)}`);
        break;
      }
    }
  }

  // Momentum alerts (noise-filtered, stance-aware, break-even aware)
  if (mom.dir === "up" && stance.action === "sell" && !recently(mem, "mom_up_sell", COOL_MOM_MS)) {
    if (sellIsWorthwhile(pos, live)) {
      mark(mem, "mom_up_sell");
      msgs.push(`📈 GRAM در حال رشد است (+${fmt(Math.abs(mom.delta))} از ${fmt(mom.from)})\nقیمت الان: ${fmt(live)}\n${stanceLine(stance, pos, live)}\n🟢 آماده‌باش فروش — نزدیک اوج می‌توانی بفروشی`);
    }
  }
  if (mom.dir === "down" && stance.action === "sell" && !recently(mem, "mom_down_sell", COOL_MOM_MS)) {
    const drop = Math.abs(mom.delta);
    if (drop >= NOISE) {
      mark(mem, "mom_down_sell");
      let msg = `📉 GRAM در حال ریزش است (−${fmt(drop)} از ${fmt(mom.from)})\nقیمت الان: ${fmt(live)}\n${stanceLine(stance, pos, live)}`;
      if (sellIsWorthwhile(pos, live)) {
        msg += "\n🟠 هنوز در سود هستی — اگر ریزش ادامه دارد قبل از از دست رفتن سود بفروش";
      } else {
        msg += "\nنزدیک سربه‌سر یا زیر آن — فروش فقط برای بستن ریسک";
      }
      msgs.push(msg);
    }
  }
  if (mom.dir === "down" && stance.action === "buy" && !recently(mem, "mom_down_buy", COOL_MOM_MS)) {
    const drop = Math.abs(mom.delta);
    if (drop >= NOISE && buyIsWorthwhile(pos, live)) {
      mark(mem, "mom_down_buy");
      msgs.push(`📉 GRAM ریزش کرده (−${fmt(drop)} از ${fmt(mom.from)})\nقیمت الان: ${fmt(live)}\n${stanceLine(stance, pos, live)}\n🟢 فرصت خرید نزدیک است`);
    }
  }
  if (mom.dir === "up" && stance.action === "buy" && !recently(mem, "mom_up_buy", COOL_MOM_MS)) {
    const ref = pos && pos.lastSwapType === "sell" && pos.lastSwapPrice ? pos.lastSwapPrice : null;
    const chasing = ref != null && live > ref + NOISE;
    if (!chasing && (buyIsWorthwhile(pos, live) || Math.abs(mom.delta) >= NOISE)) {
      mark(mem, "mom_up_buy");
      msgs.push(`📈 GRAM بعد از ضعف دوباره رشد می‌کند (+${fmt(Math.abs(mom.delta))})\nقیمت الان: ${fmt(live)}\n${stanceLine(stance, pos, live)}\n🟢 وقت خرید است — قبل از رشد بیشتر`);
    }
  }

  // Forced report
  if (process.env.REPORT === "1") {
    let msg = `📊 وضعیت GRAM\nقیمت: ${fmt(live)} USDT (${priceInfo.source})`;
    if (mom.dir === "up") msg += `\nروند کوتاه: صعودی (+${fmt(Math.abs(mom.delta))})`;
    else if (mom.dir === "down") msg += `\nروند کوتاه: نزولی (−${fmt(Math.abs(mom.delta))})`;
    else msg += `\nروند کوتاه: خنثی (نوسان < ${NOISE})`;
    msg += `\n${stanceLine(stance, pos, live)}`;
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
    console.log("Sending:", m.slice(0, 120).replace(/\n/g, " | "));
    await sendTelegram(m);
  }
  console.log(`Sent ${msgs.length} message(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
