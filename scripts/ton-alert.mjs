/**
 * GRAM (TON) Telegram alert runner for GitHub Actions.
 * Smart stance + momentum alerts (no browser required).
 *
 * Required secrets:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 * Optional:
 *   WALLET_ADDRESS          required for wallet sync
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
const WALLET = process.env.WALLET_ADDRESS || "";
const ALERT_ABOVE = num(process.env.ALERT_ABOVE);
const ALERT_BELOW = num(process.env.ALERT_BELOW);
const PROFIT_PCTS = listNums(process.env.ALERT_PROFIT_PCTS);
const LOSS_PCTS = listNums(process.env.ALERT_LOSS_PCTS);
const START_CAP = num(process.env.STARTING_CAPITAL) || 0;
const STATE_PATH = process.env.STATE_PATH || ".alert-state.json";
const NOISE_PCT = num(process.env.NOISE_PCT) ?? 0.012;
const NOISE_FLOOR = num(process.env.NOISE_FLOOR) ?? 0.008;
const MIN_ACTION_PCT = num(process.env.MIN_ACTION_PCT) ?? 0.5;
const COOLDOWN_MS = 20 * 60 * 1000;
const COOL_MOM_MS = 12 * 60 * 1000;
const STON = "EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4";
let poolTonReserve = 1.7e6;
function noiseAbs(price) {
  const p = price || 1;
  return Math.max(NOISE_FLOOR, p * NOISE_PCT);
}
function estSlippagePct(gram) {
  const r = poolTonReserve || 1e6;
  if (!gram || gram <= 0) return 0;
  return Math.min(8, (gram / (r + gram)) * 100);
}
function estExecSellPrice(mid, gram) {
  return mid * (1 - estSlippagePct(gram) / 100);
}

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
  let dex = null, cex = null;
  try {
    const j = await fetchJson("https://api.ston.fi/v1/pools/" + STON);
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
  // realized tracked during loop would need accumulator — approximate via totalPnl without startCap
  const totalPnl = unrealized; // open PnL; full realized needs cost tracking on sells
  return {
    gram, cash, avg, invested, value, equity, unrealized, totalPnl, realized: 0,
    lastSwapType, lastSwapPrice,
  };
}

async function fetchWalletBalances(addr) {
  const acc = await fetchJson(`https://tonapi.io/v2/accounts/${encodeURIComponent(addr)}`, 12000);
  const ton = Number(acc.balance || 0) / 1e9;
  let usdt = 0;
  try {
    const jets = await fetchJson(`https://tonapi.io/v2/accounts/${encodeURIComponent(addr)}/jettons`, 12000);
    for (const b of jets.balances || []) {
      const j = b.jetton || {};
      if (isUsdt(j)) usdt += Number(b.balance || 0) / Math.pow(10, j.decimals || 6);
    }
  } catch (_) {}
  return { ton, usdt };
}

async function fetchWalletSwaps(addr) {
  let all = [], nextFrom = null;
  for (let i = 0; i < 8; i++) {
    let url = `https://tonapi.io/v2/accounts/${encodeURIComponent(addr)}/events?limit=100`;
    if (nextFrom != null) url += `&before_lt=${nextFrom}`;
    const j = await fetchJson(url, 20000);
    const batch = j.events || [];
    if (!batch.length) break;
    all = all.concat(batch);
    if (j.next_from == null || j.next_from === nextFrom) break;
    nextFrom = j.next_from;
  }
  return parseSwaps(all);
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
  if (!series || series.length < 4) return { dir: "flat", delta: 0, from: null, to: null, noise: NOISE_FLOOR };
  const shortN = Math.min(series.length, 20);
  const medN = Math.min(series.length, 60);
  const short = series.slice(-shortN);
  const med = series.slice(-medN);
  const nAbs = noiseAbs(short[short.length - 1].p);
  function win(arr) {
    const from = arr[0].p, to = arr[arr.length - 1].p, delta = to - from;
    let up = 0, down = 0;
    for (let i = 1; i < arr.length; i++) {
      const d = arr[i].p - arr[i - 1].p;
      if (d >= nAbs) up++;
      else if (d <= -nAbs) down++;
    }
    let dir = "flat";
    if (Math.abs(delta) >= nAbs) {
      if (delta > 0 && up >= down) dir = "up";
      else if (delta < 0 && down >= up) dir = "down";
    }
    return { dir, delta, from, to };
  }
  const s = win(short), m = win(med);
  let dir = s.dir;
  if (s.dir !== "flat" && m.dir !== "flat" && s.dir !== m.dir) dir = "flat";
  else if (s.dir === "flat" && m.dir !== "flat") dir = m.dir;
  return { dir, delta: s.delta, from: s.from, to: s.to, noise: nAbs, medDir: m.dir };
}

function positionStance(pos, live) {
  const hasGram = pos && pos.gram > 1e-6;
  const hasUsdt = pos && pos.cash > 1e-6;
  if (hasGram && !hasUsdt) {
    return { mode: "hold_gram", label: "GRAM داری", action: "sell" };
  }
  if (hasUsdt && !hasGram) {
    return { mode: "hold_usdt", label: "USDT داری", action: "buy" };
  }
  if (hasGram && hasUsdt) {
    const gVal = pos.gram * (live || pos.avg || 0);
    if (gVal >= pos.cash) {
      return { mode: "hold_gram", label: "بیشتر GRAM داری", action: "sell" };
    }
    return { mode: "hold_usdt", label: "بیشتر USDT داری", action: "buy" };
  }
  return { mode: "empty", label: "پوزیشن خالی", action: null };
}

function sellIsWorthwhile(pos, price) {
  if (!pos || !pos.avg || pos.gram <= 0 || !price) return false;
  const exec = estExecSellPrice(price, pos.gram);
  const pct = ((exec - pos.avg) / pos.avg) * 100;
  return pct >= MIN_ACTION_PCT && (exec - pos.avg) >= noiseAbs(price) * 0.5;
}

function buyIsWorthwhile(pos, price) {
  if (!price || !pos) return false;
  const ref = pos.lastSwapType === "sell" && pos.lastSwapPrice ? pos.lastSwapPrice : null;
  if (ref != null) {
    const pct = ((ref - price) / ref) * 100;
    return pct >= MIN_ACTION_PCT && (ref - price) >= noiseAbs(price) * 0.5;
  }
  return true;
}

/** Clear last-swap advice (approved beginner-friendly copy) */
function lastSwapAdviceBlock(pos, price) {
  if (!pos || !pos.lastSwapPrice || !pos.lastSwapType) return "";
  const ref = pos.lastSwapPrice;
  const ROUND = 0.2;
  const pad = 1 - ROUND / 100;
  const levels = [
    { pct: 0.5, tag: "کمی" },
    { pct: 1, tag: "بهتر" },
    { pct: 2, tag: "خوب" },
    { pct: 3, tag: "خیلی خوب" },
    { pct: 5, tag: "عالی" },
  ];
  let out = "\n\nپیشنهاد:";
  if (pos.lastSwapType === "buy") {
    const curPct = price ? ((price - ref) / ref) * 100 : null;
    out += `\nآخرین خرید تو: ${fmt(ref)} USDT`;
    if (price) out += `\nقیمت الان:     ${fmt(price)} USDT`;
    if (curPct != null) {
      out += `\nیعنی حدود ${curPct >= 0 ? "+" : "−"}${Math.abs(curPct).toFixed(2)}٪ ${curPct >= 0 ? "بالاتر" : "پایین‌تر"} از خرید`;
    }
    if (pos.gram > 0) out += `\n\nوضعیت تو: GRAM داری` + (pos.cash > 0 ? ` (و ${fmt(pos.cash, 2)} USDT)` : "");
    if (curPct != null && curPct >= MIN_ACTION_PCT) out += "\nاگر بفروشی، نسبت به خریدت در سودی (لغزش را در نظر بگیر).";
    else out += "\nبرای فروش بهتر است صبر کنی تا نزدیک اهداف زیر برسد.";
    out += "\n\nاهداف فروش پیشنهادی:";
    for (const L of levels) {
      const slip = pos.gram > 0 ? estSlippagePct(pos.gram) / 100 : 0;
      const midNeed = (ref * (1 + L.pct / 100)) / Math.max(0.5, 1 - slip) / pad;
      out += `\n• ${L.tag} (+${L.pct}٪): حدود ${fmt(midNeed)}`;
    }
  } else {
    const curPct = price ? ((ref - price) / ref) * 100 : null;
    out += `\nآخرین فروش تو: ${fmt(ref)} USDT`;
    if (price) out += `\nقیمت الان:     ${fmt(price)} USDT`;
    if (curPct != null) {
      out += `\nیعنی حدود ${curPct >= 0 ? "−" : "+"}${Math.abs(curPct).toFixed(2)}٪ ${curPct >= 0 ? "ارزان‌تر" : "گران‌تر"} از وقتی فروختی`;
    }
    out += `\n\nوضعیت تو: ${pos.cash > 0 ? `USDT داری (حدود ${fmt(pos.cash, 2)})` : "USDT کمی داری"}`;
    if (pos.gram > 1e-6) out += " · کمی هم GRAM داری";
    if (curPct != null && curPct >= MIN_ACTION_PCT) out += "\nاگر دوباره بخری، نسبت به فروش قبلی‌ات جا برای سود داری.";
    else out += "\nعجله نکن. برای خرید دوباره بهتر است صبر کنی تا نزدیک اهداف پایین بیاید:";
    out += "\n\nاهداف خرید پیشنهادی:";
    for (const L of levels) {
      const target = ref * (1 - L.pct / 100) * pad;
      out += `\n• ${L.tag} (−${L.pct}٪): حدود ${fmt(target)}`;
    }
  }
  return out;
}

function stanceLine(stance, pos, price) {
  let line = "";
  if (stance.mode === "hold_gram") {
    line = "وضعیت تو: GRAM داری";
    if (pos && pos.avg) {
      line += `\nمیانگین ورود: ${fmt(pos.avg)}`;
      if (price) {
        const pct = ((price - pos.avg) / pos.avg) * 100;
        line += `\nنسبت به ورود: ${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}٪`;
      }
    }
  } else if (stance.mode === "hold_usdt") {
    line = "وضعیت تو: USDT داری" + (pos && pos.cash > 0 ? ` (حدود ${fmt(pos.cash, 2)})` : "");
    if (pos && pos.gram > 1e-6) line += `\nکمی هم GRAM داری: ${fmt(pos.gram, 4)}`;
  } else {
    line = "وضعیت تو: پوزیشن مشخصی نیست";
  }
  line += lastSwapAdviceBlock(pos, price);
  return line;
}

async function main() {
  if (!TOKEN || !CHAT) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
    process.exit(1);
  }
  if (!WALLET) {
    console.error("Missing WALLET_ADDRESS secret — set your TON wallet address in repo secrets");
    process.exit(1);
  }

  const priceInfo = await getPrice();
  const live = priceInfo.usd;
  console.log(`Price ${live} from ${priceInfo.source}`);

  let pos = null;
  try {
    const [swaps, bal] = await Promise.all([
      fetchWalletSwaps(WALLET),
      fetchWalletBalances(WALLET).catch(() => null),
    ]);
    console.log(`Wallet swaps: ${swaps.length}`);
    pos = calcPosition(swaps, live, 0);
    if (bal) {
      pos.gram = bal.ton;
      pos.cash = bal.usdt;
      pos.value = bal.ton * live;
      pos.equity = bal.usdt + pos.value;
      pos.unrealized = pos.value - pos.invested;
      pos.totalPnl = pos.realized != null ? pos.realized + pos.unrealized : pos.unrealized;
      console.log(`Chain bal TON=${bal.ton} USDT=${bal.usdt}`);
    }
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
    msgs.push(`🔺 قیمت به سقف مورد نظرت رسید

سقف تو: ${fmt(ALERT_ABOVE)}
قیمت الان: ${fmt(live)}

${stanceLine(stance, pos, live)}`);
  }
  if (ALERT_BELOW != null && live <= ALERT_BELOW && !recently(mem, "below")) {
    mark(mem, "below");
    msgs.push(`🔻 قیمت به کف مورد نظرت رسید\n\nکف تو: ${fmt(ALERT_BELOW)}\nقیمت الان: ${fmt(live)}\n\n${stanceLine(stance, pos, live)}`);
  }

  // Profit / loss targets
  if (pos && pos.invested > 0) {
    const curPct = (pos.unrealized / pos.invested) * 100;
    for (const target of PROFIT_PCTS) {
      const key = `profit_${target}`;
      if (curPct >= target && !recently(mem, key)) {
        mark(mem, key);
        msgs.push(`✅ نسبت به خریدت در سودی\n\nقیمت الان: ${fmt(live)}\nسود شناور حدود +${curPct.toFixed(2)}٪ (هدف: +${target}٪)\n\n${stanceLine(stance, pos, live)}`);
        break;
      }
    }
    for (const loss of LOSS_PCTS) {
      const key = `loss_${loss}`;
      if (curPct <= -loss && !recently(mem, key)) {
        mark(mem, key);
        msgs.push(`⚠️ نسبت به خریدت کمی عقب افتادی\n\nقیمت الان: ${fmt(live)}\nزیان شناور حدود ${curPct.toFixed(2)}٪ (آستانه: −${loss}٪)\nاین ضرر هنوز قطعی نشده مگر بفروشی.\n\n${stanceLine(stance, pos, live)}`);
        break;
      }
    }
  }

  // Momentum alerts (noise-filtered, stance-aware, break-even aware)
  if (mom.dir === "up" && stance.action === "sell" && !recently(mem, "mom_up_sell", COOL_MOM_MS)) {
    if (sellIsWorthwhile(pos, live)) {
      mark(mem, "mom_up_sell");
      msgs.push(`📈 قیمت در حال بالا رفتن است\n\nاز ${fmt(mom.from)} به ${fmt(live)} (حدود +${fmt(Math.abs(mom.delta))})\n\n${stanceLine(stance, pos, live)}`);
    }
  }
  if (mom.dir === "down" && stance.action === "sell" && !recently(mem, "mom_down_sell", COOL_MOM_MS)) {
    const drop = Math.abs(mom.delta);
    if (drop >= (mom.noise || noiseAbs(live))) {
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
    if (drop >= (mom.noise || noiseAbs(live)) && buyIsWorthwhile(pos, live)) {
      mark(mem, "mom_down_buy");
      msgs.push(`📉 قیمت پایین آمده\n\nاز ${fmt(mom.from)} به ${fmt(live)} (حدود −${fmt(drop)})\n\n${stanceLine(stance, pos, live)}`);
    }
  }
  if (mom.dir === "up" && stance.action === "buy" && !recently(mem, "mom_up_buy", COOL_MOM_MS)) {
    const ref = pos && pos.lastSwapType === "sell" && pos.lastSwapPrice ? pos.lastSwapPrice : null;
    const chasing = ref != null && live > ref + (mom.noise || noiseAbs(live));
    if (!chasing && (buyIsWorthwhile(pos, live) || Math.abs(mom.delta) >= (mom.noise || noiseAbs(live)))) {
      mark(mem, "mom_up_buy");
      msgs.push(`📈 قیمت بعد از ضعف دوباره بالا می‌آید\n\nحرکت حدود +${fmt(Math.abs(mom.delta))}\nقیمت الان: ${fmt(live)}\n\n${stanceLine(stance, pos, live)}`);
    }
  }

  // Forced / manual report — always send status so user sees the bot works
  const forceReport = process.env.REPORT === "1" || process.env.EVENT_NAME === "workflow_dispatch";
  if (forceReport) {
    let msg = `📊 وضعیت الان

قیمت: ${fmt(live)} USDT (${priceInfo.source})`;
    if (priceInfo.dexUsd != null && priceInfo.cexUsd != null) {
      msg += `
DEX ${fmt(priceInfo.dexUsd)} · CEX ${fmt(priceInfo.cexUsd)}`;
    }
    if (pos) {
      if (pos.gram > 0) msg += `
موجودی GRAM: ${fmt(pos.gram, 4)}`;
      if (pos.cash > 0) msg += `
موجودی USDT: ${fmt(pos.cash, 2)}`;
      msg += `
ارزش تقریبی کل: ${fmt(pos.equity, 2)}`;
    }
    msg += `

${stanceLine(stance, pos, live)}`;
    msgs.push(msg);
  }

  saveState(mem);

  if (!msgs.length) {
    console.log("No alerts to send (no threshold hit; scheduled run without REPORT)");
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
