/**
 * Cloudflare Worker — GRAM Telegram alerts (always-on)
 *
 * Same logic as scripts/ton-alert.mjs (GitHub Actions), adapted for:
 * - Cron Triggers (every 2 min by default)
 * - KV binding ALERT_STATE for cooldowns & price series
 * - HTTP: GET / health, GET /run force check, GET /report status+chart
 *
 * Secrets (wrangler secret put …):
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, WALLET_ADDRESS
 * Optional vars: ALERT_ABOVE, ALERT_BELOW, ALERT_PROFIT_PCTS, ALERT_LOSS_PCTS
 */

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
} from "../../scripts/gram-core.mjs";
import {
  stanceLine as tgStance,
  buildStatusMessage,
  msgCeiling,
  msgFloor,
  msgProfitBuy,
  msgLossBuy,
  msgProfitSell,
  msgLossSell,
  msgTrendUp,
  msgTrendDown,
  msgDrop,
  msgBounce,
  statusChartUrl,
} from "../../scripts/telegram-messages.mjs";

const COOLDOWN_MS = 20 * 60 * 1000;
const COOL_MOM_MS = 12 * 60 * 1000;
const STATE_KEY = "alert-state";
const GLOBAL_GAP_MS = 90 * 1000;

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
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

let poolTonReserve = 1.7e6;

async function getPrice() {
  let dex = null;
  let cex = null;
  try {
    const j = await fetchJson("https://api.ston.fi/v1/pools/" + STON_POOL);
    const pool = j.pool || j;
    const r0 = Number(pool.reserve0);
    const r1 = Number(pool.reserve1);
    if (r0 && r1) {
      poolTonReserve = r1 / 1e9;
      dex = { usd: r0 / 1e6 / (r1 / 1e9), source: "STON.fi DEX" };
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
  let all = [];
  let nextFrom = null;
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
    const jets = await fetchJson(
      `https://tonapi.io/v2/accounts/${encodeURIComponent(addr)}/jettons`,
      12000
    );
    for (const b of jets.balances || []) {
      const j = b.jetton || {};
      if (
        (j.symbol || "").toUpperCase().startsWith("USD") ||
        (j.address || "").toLowerCase().includes("b113a994")
      ) {
        usdt += Number(b.balance || 0) / Math.pow(10, j.decimals || 6);
      }
    }
  } catch (_) {}
  return { ton, usdt };
}

async function sendTelegram(env, text) {
  const TOKEN = env.TELEGRAM_BOT_TOKEN || "";
  const CHAT = env.TELEGRAM_CHAT_ID || "";
  if (!TOKEN || !CHAT) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing");
  const url =
    `https://api.telegram.org/bot${TOKEN}/sendMessage` +
    `?chat_id=${encodeURIComponent(CHAT)}&text=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) {
    throw new Error((j && j.description) || `Telegram HTTP ${res.status}`);
  }
  return j;
}

async function sendTelegramPhoto(env, caption, photoUrl) {
  const TOKEN = env.TELEGRAM_BOT_TOKEN || "";
  const CHAT = env.TELEGRAM_CHAT_ID || "";
  if (!TOKEN || !CHAT) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing");
  const body = new URLSearchParams({
    chat_id: CHAT,
    photo: photoUrl,
    caption: caption.slice(0, 1024),
  });
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) {
    // fallback to text if photo fails
    return sendTelegram(env, caption);
  }
  return j;
}

async function loadState(env) {
  try {
    if (!env.ALERT_STATE) return { series: [] };
    const raw = await env.ALERT_STATE.get(STATE_KEY);
    if (!raw) return { series: [] };
    const mem = JSON.parse(raw);
    if (!mem || typeof mem !== "object") return { series: [] };
    if (!Array.isArray(mem.series)) mem.series = [];
    return mem;
  } catch (_) {
    return { series: [] };
  }
}

async function saveState(env, mem) {
  if (!env.ALERT_STATE) return;
  try {
    await env.ALERT_STATE.put(STATE_KEY, JSON.stringify(mem), {
      expirationTtl: 60 * 60 * 24 * 14, // 14 days
    });
  } catch (e) {
    console.error("KV save failed", e);
  }
}

function recently(mem, k, cool = COOLDOWN_MS) {
  const t = mem[k];
  return t != null && Date.now() - t < cool;
}

function mark(mem, k) {
  mem[k] = Date.now();
  mem._lastAny = Date.now();
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

/**
 * @param {object} env
 * @param {{ forceReport?: boolean }} opts
 */
async function runAlert(env, opts = {}) {
  const TOKEN = env.TELEGRAM_BOT_TOKEN || "";
  const CHAT = env.TELEGRAM_CHAT_ID || "";
  const WALLET = env.WALLET_ADDRESS || "";
  const ALERT_ABOVE = num(env.ALERT_ABOVE);
  const ALERT_BELOW = num(env.ALERT_BELOW);
  const PROFIT_PCTS = listNums(env.ALERT_PROFIT_PCTS);
  const LOSS_PCTS = listNums(env.ALERT_LOSS_PCTS);
  const forceReport = !!opts.forceReport;

  if (!TOKEN || !CHAT) {
    return { ok: false, error: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" };
  }
  if (!WALLET) {
    return { ok: false, error: "Missing WALLET_ADDRESS" };
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

  const mem = await loadState(env);
  const series = pushSample(mem, live);
  const mom = detectMomentum(series);
  const stance = positionStance(pos);
  const lt = lastTradeFromPos(pos);
  const quote = {
    source: priceInfo.source,
    dexUsd: priceInfo.dexUsd,
    cexUsd: priceInfo.cexUsd,
  };

  /** @type {{text:string, photo?:boolean}[]} */
  const msgs = [];

  // Global gap (skip threshold spam unless forced report)
  if (!forceReport && mem._lastAny && Date.now() - mem._lastAny < GLOBAL_GAP_MS) {
    await saveState(env, mem);
    return {
      ok: true,
      skipped: "global_gap",
      price: live,
      source: priceInfo.source,
    };
  }

  if (ALERT_ABOVE != null && live >= ALERT_ABOVE && !recently(mem, "above")) {
    mark(mem, "above");
    msgs.push({ text: msgCeiling(ALERT_ABOVE, live, stanceText(pos, live)) });
  }
  if (ALERT_BELOW != null && live <= ALERT_BELOW && !recently(mem, "below")) {
    mark(mem, "below");
    msgs.push({ text: msgFloor(ALERT_BELOW, live, stanceText(pos, live)) });
  }

  if (lt && lt.price > 0) {
    const ref = lt.price;
    const movePct = ((live - ref) / ref) * 100;
    if (lt.type === "buy") {
      for (const target of PROFIT_PCTS) {
        const key = "ls_profit_buy_" + target;
        if (movePct >= target && !recently(mem, key)) {
          mark(mem, key);
          msgs.push({
            text: msgProfitBuy(movePct, target, ref, live, stanceText(pos, live)),
          });
          break;
        }
      }
      for (const loss of LOSS_PCTS) {
        const key = "ls_loss_buy_" + loss;
        if (movePct <= -loss && !recently(mem, key)) {
          mark(mem, key);
          msgs.push({
            text: msgLossBuy(movePct, loss, ref, live, stanceText(pos, live)),
          });
          break;
        }
      }
    } else if (lt.type === "sell") {
      for (const target of PROFIT_PCTS) {
        const key = "ls_profit_sell_" + target;
        if (movePct <= -target && !recently(mem, key)) {
          mark(mem, key);
          msgs.push({
            text: msgProfitSell(movePct, target, ref, live, stanceText(pos, live)),
          });
          break;
        }
      }
      for (const loss of LOSS_PCTS) {
        const key = "ls_loss_sell_" + loss;
        if (movePct >= loss && !recently(mem, key)) {
          mark(mem, key);
          msgs.push({
            text: msgLossSell(movePct, loss, ref, live, stanceText(pos, live)),
          });
          break;
        }
      }
    }
  }

  if (mom.dir === "up" && stance.action === "sell" && !recently(mem, "mom_up_sell", COOL_MOM_MS)) {
    if (sellIsWorthwhile(pos, live, poolTonReserve)) {
      mark(mem, "mom_up_sell");
      msgs.push({
        text: msgTrendUp(mom.from, live, mom.delta, stanceText(pos, live)),
      });
    }
  }
  if (mom.dir === "down" && stance.action === "sell" && !recently(mem, "mom_down_sell", COOL_MOM_MS)) {
    const drop = Math.abs(mom.delta);
    if (drop >= (mom.noise || noiseAbs(live))) {
      mark(mem, "mom_down_sell");
      msgs.push({
        text: msgTrendDown(mom.from, live, drop, stanceText(pos, live)),
      });
    }
  }
  if (mom.dir === "down" && stance.action === "buy" && !recently(mem, "mom_down_buy", COOL_MOM_MS)) {
    const drop = Math.abs(mom.delta);
    if (
      drop >= (mom.noise || noiseAbs(live)) &&
      buyIsWorthwhile(pos, live, poolTonReserve)
    ) {
      mark(mem, "mom_down_buy");
      msgs.push({
        text: msgDrop(mom.from, live, drop, stanceText(pos, live)),
      });
    }
  }
  if (mom.dir === "up" && stance.action === "buy" && !recently(mem, "mom_up_buy", COOL_MOM_MS)) {
    const ref = pos.lastSwapType === "sell" ? pos.lastSwapPrice : null;
    const chasing = ref != null && live > ref + (mom.noise || noiseAbs(live));
    if (
      !chasing &&
      (buyIsWorthwhile(pos, live, poolTonReserve) ||
        Math.abs(mom.delta) >= (mom.noise || noiseAbs(live)))
    ) {
      mark(mem, "mom_up_buy");
      msgs.push({
        text: msgBounce(mom.delta, live, stanceText(pos, live)),
      });
    }
  }

  if (forceReport) {
    const status = buildStatusMessage(pos, live, quote, lt, checks(), poolTonReserve);
    msgs.push({ text: status, photo: true });
  }

  let out = msgs;
  if (!forceReport && out.length > 1) out = [out[0]];
  else if (forceReport && out.length > 1) {
    const status = out.find((m) => m.photo) || out[out.length - 1];
    out = [status];
  }

  await saveState(env, mem);

  if (!out.length) {
    return {
      ok: true,
      sent: 0,
      price: live,
      source: priceInfo.source,
      gram: pos.totalGram,
      usdt: pos.cashUsdt,
      message: "No alerts to send",
    };
  }

  const chart = statusChartUrl(series, live);
  for (const m of out) {
    console.log("Sending:", m.text.slice(0, 120).replace(/\n/g, " | "));
    if (m.photo && chart) await sendTelegramPhoto(env, m.text, chart);
    else await sendTelegram(env, m.text);
  }

  return {
    ok: true,
    sent: out.length,
    price: live,
    source: priceInfo.source,
    gram: pos.totalGram,
    usdt: pos.cashUsdt,
  };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runAlert(env, { forceReport: false }).then((r) => {
        console.log("cron result", JSON.stringify(r));
      }).catch((e) => {
        console.error("cron error", e);
      })
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" || path === "/health") {
      return Response.json({
        ok: true,
        service: "gram-telegram-alert",
        cron: "*/2 * * * *",
        hasToken: !!(env.TELEGRAM_BOT_TOKEN),
        hasChat: !!(env.TELEGRAM_CHAT_ID),
        hasWallet: !!(env.WALLET_ADDRESS),
        hasKV: !!env.ALERT_STATE,
      });
    }

    if (path === "/run" || path === "/check") {
      try {
        const result = await runAlert(env, { forceReport: false });
        return Response.json(result);
      } catch (e) {
        return Response.json(
          { ok: false, error: String(e && e.message ? e.message : e) },
          { status: 500 }
        );
      }
    }

    if (path === "/report") {
      try {
        const result = await runAlert(env, { forceReport: true });
        return Response.json(result);
      } catch (e) {
        return Response.json(
          { ok: false, error: String(e && e.message ? e.message : e) },
          { status: 500 }
        );
      }
    }

    return Response.json({ ok: false, error: "not found", paths: ["/", "/run", "/report"] }, { status: 404 });
  },
};
