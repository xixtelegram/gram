/**
 * Shared GRAM Swap core — pure logic only (no DOM, no localStorage, no Telegram).
 *
 * Professional swing-alert layer:
 *  - StrategyConfig (all thresholds in one place)
 *  - Position stance + worthwhile checks (slippage-aware)
 *  - Short-term momentum with volatility (noise) filter
 *  - Multi-timeframe range extremes (24h … 1y)
 *  - evaluateAlerts() — ranked, position-aware, cooldown-ready signals
 *  - Minimal risk helpers (stop distance, suggested size)
 */

export const STON_POOL = "EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4";
export const USDT_MASTER = "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe";
/** Chart/history token for tonapi rates (GRAM = historical name of TON) */
export const RATES_TOKEN = "ton";

export const ROUND = 0.2;
export const NOISE_PCT = 0.012;
export const NOISE_FLOOR = 1e-6;
export const MIN_ACTION_PCT = 0.5;
export const ADVICE_PCTS = [0.5, 1, 2, 3, 5];
/** @deprecated use ADVICE_PCTS */
export const ADVICE_LEVELS = ADVICE_PCTS.map((pct) => ({ pct, tag: String(pct) }));

// ─── Strategy config (single source of truth) ───

/**
 * Default professional thresholds for a personal TON↔USDT swing tool.
 * Override via env or UI; keep pure numbers here.
 */
export const DEFAULT_STRATEGY = Object.freeze({
  /** Min edge after slippage to call a trade "worthwhile" (%) */
  minActionPct: 0.5,
  /** Noise band as fraction of price */
  noisePct: 0.012,
  noiseFloor: 1e-6,
  /** Short momentum windows (sample counts on live series) */
  shortWindow: 16,
  prevWindow: 16,
  medWindow: 48,
  /** Reversal needs at least this move vs noise */
  reversalNoiseMult: 1.0,
  /** Rally/dump strength floor (% move) */
  phaseStrengthPct: 0.6,
  /** Stop-loss alert when underwater vs avg entry (%) */
  stopLossPct: 3.0,
  /** Max alerts of same family per day (soft limit) */
  maxAlertsPerFamilyDay: 4,
  /** Suggested position fractions */
  sizeFractions: [0.25, 0.5, 1.0],
  /** Multi-TF range analysis */
  rangePeriods: Object.freeze([
    { id: "24h",  seconds: 86400,      label: "۲۴ ساعت", priority: 2, extremePctOfRange: 0.85, moveVsRange: 0.35 },
    { id: "7d",   seconds: 604800,     label: "۷ روز",   priority: 2, extremePctOfRange: 0.88, moveVsRange: 0.30 },
    { id: "30d",  seconds: 2592000,    label: "۳۰ روز",  priority: 2, extremePctOfRange: 0.90, moveVsRange: 0.25 },
    { id: "90d",  seconds: 7776000,    label: "۳ ماه",   priority: 1, extremePctOfRange: 0.92, moveVsRange: 0.22 },
    { id: "180d", seconds: 15552000,   label: "۶ ماه",   priority: 1, extremePctOfRange: 0.93, moveVsRange: 0.20 },
    { id: "365d", seconds: 31536000,   label: "۱ سال",   priority: 1, extremePctOfRange: 0.95, moveVsRange: 0.18 },
  ]),
  /** Cooldowns (ms) — consumers may still apply their own */
  cool: Object.freeze({
    reversal: 8 * 60 * 1000,
    phase: 18 * 60 * 1000,
    rangeHigh: 45 * 60 * 1000,
    rangeLow: 45 * 60 * 1000,
    rangeMove: 30 * 60 * 1000,
    stop: 60 * 60 * 1000,
    level: 20 * 60 * 1000,
    /** Same profit/loss event must not re-fire for hours (prevents 1.5→2→2.5 spam) */
    profit: 3 * 60 * 60 * 1000,
    loss: 3 * 60 * 60 * 1000,
  }),
});

export function mergeStrategy(overrides = {}) {
  const base = { ...DEFAULT_STRATEGY, ...overrides };
  if (overrides.cool) base.cool = { ...DEFAULT_STRATEGY.cool, ...overrides.cool };
  if (overrides.rangePeriods) base.rangePeriods = overrides.rangePeriods;
  return base;
}

// ─── utils ───

export function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function fmt(n, d = 4) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(d);
}

export function noiseAbs(price, cfg = DEFAULT_STRATEGY) {
  const p = Number(price);
  const px = Number.isFinite(p) && p > 0 ? p : 1;
  const pct = cfg.noisePct != null ? cfg.noisePct : NOISE_PCT;
  const floor = cfg.noiseFloor != null ? cfg.noiseFloor : NOISE_FLOOR;
  return Math.max(floor, px * pct);
}

/** @param {number} poolTonReserve */
export function estSlippagePct(gram, poolTonReserve = 1.7e6) {
  const r = poolTonReserve || 1e6;
  if (!gram || gram <= 0) return 0;
  return Math.min(8, (gram / (r + gram)) * 100);
}

export function estExecSellPrice(mid, gram, poolTonReserve = 1.7e6) {
  return mid * (1 - estSlippagePct(gram, poolTonReserve) / 100);
}

export function estExecBuyPrice(mid, usdt, poolTonReserve = 1.7e6) {
  const gramApprox = mid > 0 ? usdt / mid : 0;
  return mid * (1 + estSlippagePct(gramApprox, poolTonReserve) / 100);
}

export function isUsdt(j) {
  if (!j) return false;
  const s = (j.symbol || "").toUpperCase();
  return s.startsWith("USD") || (j.address && String(j.address).toLowerCase().includes("b113a994"));
}

export function eventDate(tsSec) {
  return new Date(tsSec * 1000).toISOString();
}

// ─── wallet event → swap list ───

/**
 * Parse TON wallet events → swap list
 * @returns {Array<{type,date,gram,usdt,gramSwapped?,networkFee?,dexFeeUsdt?,exact,eventId,source,price?}>}
 */
export function parseSwapsFromEvents(events) {
  const out = [];
  for (const e of events || []) {
    const ts = e.timestamp;
    const date = eventDate(ts);
    const eid = e.event_id || "";
    const actions = e.actions || [];
    const acct = ((e.account && e.account.address) || "").toLowerCase();
    const sameAddr = (a) => (a || "").toLowerCase() === acct;

    for (const a of actions) {
      if (a.status && a.status !== "ok") continue;
      if (a.type !== "JettonSwap") continue;
      const js = a.JettonSwap || {};
      if (isUsdt(js.jetton_master_in) && js.ton_out) {
        const usdt = Number(js.amount_in) / 1e6;
        const gram = Number(js.ton_out) / 1e9;
        if (usdt > 0.01 && gram > 0.01) {
          out.push({
            type: "buy", date, gram, usdt,
            networkFee: 0, dexFeeUsdt: 0, exact: true, eventId: eid, source: "wallet",
            price: usdt / gram,
          });
        }
      } else if (isUsdt(js.jetton_master_out) && js.ton_in) {
        const usdt = Number(js.amount_out) / 1e6;
        const gram = Number(js.ton_in) / 1e9;
        if (usdt > 0.01 && gram > 0.01) {
          out.push({
            type: "sell", date, gram, usdt, gramSwapped: gram,
            networkFee: 0, dexFeeUsdt: 0, exact: true, eventId: eid, source: "wallet",
            price: usdt / gram,
          });
        }
      }
    }
    if (actions.some((a) => a.type === "JettonSwap")) continue;

    let tonIn = 0, tonOut = 0, usdtIn = 0, usdtOut = 0, usdtRoute = 0;
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
    const extraTon = typeof e.extra === "number" ? Math.abs(e.extra) / 1e9 : 0;

    if (tonOut > 1 && usdtIn > 0.5 && tonOut > tonIn) {
      const refund = tonIn < 0.5 ? tonIn : 0;
      const gramSwapped = tonOut;
      const gramInv = tonOut - refund;
      const usdt = usdtIn - usdtOut;
      const dexFeeUsdt = usdtRoute > usdt ? +(usdtRoute - usdt).toFixed(6) : 0;
      out.push({
        type: "sell", date,
        gram: +gramInv.toFixed(9),
        gramSwapped: +gramSwapped.toFixed(9),
        usdt: +usdt.toFixed(6),
        networkFee: +extraTon.toFixed(9),
        dexFeeUsdt, exact: true, eventId: eid, source: "wallet",
        price: usdt / (gramSwapped || gramInv),
      });
    } else if (tonIn > 1 && usdtOut > 0.5 && tonIn > tonOut) {
      const gasOut = tonOut < 0.5 ? tonOut : 0;
      const gram = tonIn - (tonOut > 0.5 ? tonOut : 0);
      const usdt = usdtOut - usdtIn;
      out.push({
        type: "buy", date,
        gram: +gram.toFixed(9), usdt: +usdt.toFixed(6),
        networkFee: +Math.max(extraTon, gasOut).toFixed(9),
        dexFeeUsdt: 0, exact: true, eventId: eid, source: "wallet",
        price: usdt / gram,
      });
    }
  }
  const seen = new Set();
  return out.filter((s) => {
    const k = s.eventId || (s.date + s.type + Number(s.gram).toFixed(4));
    if (seen.has(k)) return false;
    seen.add(k);
    return s.gram > 0.5 && s.usdt > 0.5;
  });
}

function takeFromInv(inv, amount) {
  let left = amount, cost = 0;
  while (left > 1e-12 && inv.length) {
    const lot = inv[0];
    const take = Math.min(lot.gram, left);
    cost += take * lot.costPer;
    lot.gram -= take;
    left -= take;
    if (lot.gram <= 1e-12) inv.shift();
  }
  return { cost, filled: amount - left };
}

/**
 * Ledger + optional chain balances.
 * @param {object} [walletBal] { ton, usdt }
 */
export function calcState(list, price, walletBal = null) {
  const sorted = (list || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date) || (a.id || 0) - (b.id || 0));
  let totalFeesGram = 0, totalFeesUsdt = 0, realizedPnl = 0;
  const inv = [];
  let lastSwapPnl = null, lastSwapPct = null, lastSwapType = null, lastSwapPrice = null;
  let flowUsdt = 0;

  for (const t of sorted) {
    const isExact = t.exact === true || t.source === "wallet";
    const netFeeGram = Math.max(0, t.networkFee || 0);
    const dexFeeUsdt = Math.max(0, t.dexFeeUsdt || 0);
    const legacyDexPct = (!isExact && t.dexFeePct != null) ? Math.max(0, t.dexFeePct) / 100 : 0;
    totalFeesGram += netFeeGram;
    totalFeesUsdt += dexFeeUsdt;
    const px = t.price > 0 ? t.price : (t.gram > 0 ? t.usdt / t.gram : null);

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
  for (const lot of inv) {
    bookGram += lot.gram;
    remainingCost += lot.gram * lot.costPer;
  }
  const avg = bookGram > 0 ? remainingCost / bookGram : 0;
  const totalGram = walletBal ? walletBal.ton : bookGram;
  const cashUsdt = walletBal ? walletBal.usdt : Math.max(0, flowUsdt);
  const currentValue = price ? totalGram * price : 0;
  const equity = cashUsdt + currentValue;
  const costForMark = bookGram > 1e-12 ? remainingCost * Math.min(1, totalGram / bookGram) : 0;
  const unrealizedPnl = currentValue - costForMark;
  const totalPnl = realizedPnl + unrealizedPnl;

  return {
    totalGram,
    cashUsdt,
    bookGram,
    avgBuyPrice: avg,
    investedUsdt: costForMark,
    currentValue,
    equity,
    totalPnl,
    unrealizedPnl,
    totalFeesGram,
    totalFeesUsdt,
    realizedPnl,
    lastSwapPnl,
    lastSwapPct,
    lastSwapType,
    lastSwapPrice,
    fromWallet: !!walletBal,
    gram: totalGram,
    cash: cashUsdt,
    avg,
    invested: costForMark,
    value: currentValue,
  };
}

export function lastTrade(list) {
  if (!list || !list.length) return null;
  return list.slice().sort((a, b) => new Date(b.date) - new Date(a.date) || (b.id || 0) - (a.id || 0))[0];
}

/**
 * @param {object} s calcState result
 * @param {number|null} [livePrice]
 */
export function positionStance(s, livePrice = null) {
  const hasGram = s && s.totalGram > 1e-6;
  const hasUsdt = s && s.cashUsdt > 1e-6;
  if (hasGram && !hasUsdt) return { mode: "hold_gram", action: "sell" };
  if (hasUsdt && !hasGram) return { mode: "hold_usdt", action: "buy" };
  if (hasGram && hasUsdt) {
    const px = (livePrice != null && livePrice > 0) ? livePrice : (s.avgBuyPrice || 0);
    const gVal = s.totalGram * px;
    if (gVal >= (s.cashUsdt || 0)) return { mode: "hold_gram", action: "sell" };
    return { mode: "hold_usdt", action: "buy" };
  }
  return { mode: "empty", action: null };
}

export function sellIsWorthwhile(s, price, poolTonReserve = 1.7e6, cfg = DEFAULT_STRATEGY) {
  if (!s || !s.avgBuyPrice || s.totalGram <= 0 || !price) return false;
  const minPct = cfg.minActionPct != null ? cfg.minActionPct : MIN_ACTION_PCT;
  const exec = estExecSellPrice(price, s.totalGram, poolTonReserve);
  const pct = ((exec - s.avgBuyPrice) / s.avgBuyPrice) * 100;
  return pct >= minPct && (exec - s.avgBuyPrice) >= noiseAbs(price, cfg) * 0.5;
}

export function buyIsWorthwhile(s, price, poolTonReserve = 1.7e6, cfg = DEFAULT_STRATEGY) {
  if (!price || !s) return false;
  const minPct = cfg.minActionPct != null ? cfg.minActionPct : MIN_ACTION_PCT;
  const ref = s.lastSwapType === "sell" && s.lastSwapPrice ? s.lastSwapPrice : null;
  const exec = s.cashUsdt > 0 ? estExecBuyPrice(price, s.cashUsdt, poolTonReserve) : price;
  if (ref != null) {
    const pct = ((ref - exec) / ref) * 100;
    return pct >= minPct && (ref - exec) >= noiseAbs(price, cfg) * 0.5;
  }
  return true;
}

/**
 * Suggested trade size fractions of available side (GRAM for sell, USDT for buy).
 * Filters out sizes that wouldn't clear minAction after slippage for sells.
 */
export function suggestedSizes(s, price, action, poolTonReserve = 1.7e6, cfg = DEFAULT_STRATEGY) {
  const fracs = cfg.sizeFractions || [0.25, 0.5, 1];
  if (!s || !price || !action) return [];
  if (action === "sell" && s.totalGram > 0) {
    return fracs.map((f) => {
      const gram = s.totalGram * f;
      const exec = estExecSellPrice(price, gram, poolTonReserve);
      const pct = s.avgBuyPrice > 0 ? ((exec - s.avgBuyPrice) / s.avgBuyPrice) * 100 : null;
      return { fraction: f, gram, usdtEst: gram * exec, edgePct: pct, slipPct: estSlippagePct(gram, poolTonReserve) };
    });
  }
  if (action === "buy" && s.cashUsdt > 0) {
    return fracs.map((f) => {
      const usdt = s.cashUsdt * f;
      const exec = estExecBuyPrice(price, usdt, poolTonReserve);
      const gramEst = exec > 0 ? usdt / exec : 0;
      return { fraction: f, usdt, gramEst, slipPct: estSlippagePct(gramEst, poolTonReserve) };
    });
  }
  return [];
}

/** Unrealized % vs average entry (negative = underwater). */
export function unrealizedPct(s, price) {
  if (!s || !s.avgBuyPrice || s.avgBuyPrice <= 0 || !price || s.totalGram <= 0) return null;
  return ((price - s.avgBuyPrice) / s.avgBuyPrice) * 100;
}

export function isStopTriggered(s, price, cfg = DEFAULT_STRATEGY) {
  const pct = unrealizedPct(s, price);
  if (pct == null) return false;
  return pct <= -(cfg.stopLossPct || 3);
}

// ─── short-term momentum ───

/**
 * Trend phases (position-aware alerts use these):
 *   rally | dump | reversal_down | reversal_up | flat
 *
 * Uses short / previous / medium windows and a noise threshold
 * derived from current price (and optional strategy config).
 */
export function detectMomentum(series, cfg = DEFAULT_STRATEGY) {
  const empty = {
    dir: "flat",
    phase: "flat",
    delta: 0,
    from: null,
    to: null,
    noise: NOISE_FLOOR,
    medDir: "flat",
    prevDir: "flat",
    strength: 0,
    movePct: 0,
    volatility: 0,
  };
  if (!series || series.length < 6) return empty;

  const lastP = series[series.length - 1].p;
  const nAbs = noiseAbs(lastP, cfg);
  const shortN = Math.min(series.length, cfg.shortWindow || 16);
  const prevN = Math.min(Math.max(0, series.length - shortN), cfg.prevWindow || 16);
  const medN = Math.min(series.length, cfg.medWindow || 48);

  function win(arr) {
    if (!arr || arr.length < 2) {
      return { dir: "flat", delta: 0, from: null, to: null, movePct: 0, vol: 0 };
    }
    const from = arr[0].p;
    const to = arr[arr.length - 1].p;
    const delta = to - from;
    let up = 0, down = 0;
    let sumAbs = 0;
    const step = nAbs * 0.45;
    for (let i = 1; i < arr.length; i++) {
      const d = arr[i].p - arr[i - 1].p;
      sumAbs += Math.abs(d);
      if (d >= step) up++;
      else if (d <= -step) down++;
    }
    let dir = "flat";
    if (Math.abs(delta) >= nAbs) {
      if (delta > 0 && up >= down) dir = "up";
      else if (delta < 0 && down >= up) dir = "down";
    }
    const movePct = from > 0 ? (delta / from) * 100 : 0;
    const vol = arr.length > 1 ? sumAbs / (arr.length - 1) : 0;
    return { dir, delta, from, to, movePct, vol };
  }

  const short = win(series.slice(-shortN));
  const prev = prevN >= 4 ? win(series.slice(-(shortN + prevN), -shortN || undefined)) : { dir: "flat", delta: 0, movePct: 0, vol: 0 };
  const med = win(series.slice(-medN));

  let phase = "flat";
  let dir = short.dir;
  const revMult = cfg.reversalNoiseMult != null ? cfg.reversalNoiseMult : 1;
  const strengthFloor = cfg.phaseStrengthPct != null ? cfg.phaseStrengthPct : 0.6;

  if (short.dir === "down" && Math.abs(short.delta) >= nAbs * revMult && (prev.dir === "up" || med.dir === "up")) {
    phase = "reversal_down";
    dir = "down";
  } else if (short.dir === "up" && Math.abs(short.delta) >= nAbs * revMult && (prev.dir === "down" || med.dir === "down")) {
    phase = "reversal_up";
    dir = "up";
  } else if (short.dir === "up" && (med.dir === "up" || prev.dir === "up" || med.dir === "flat")) {
    if (Math.abs(short.delta) >= nAbs || Math.abs(med.delta) >= nAbs * 1.4 || Math.abs(short.movePct) >= strengthFloor) {
      phase = "rally";
      dir = "up";
    }
  } else if (short.dir === "down" && (med.dir === "down" || prev.dir === "down" || med.dir === "flat")) {
    if (Math.abs(short.delta) >= nAbs || Math.abs(med.delta) >= nAbs * 1.4 || Math.abs(short.movePct) >= strengthFloor) {
      phase = "dump";
      dir = "down";
    }
  } else if (short.dir === "flat" && med.dir === "up") {
    phase = "rally";
    dir = "up";
  } else if (short.dir === "flat" && med.dir === "down") {
    phase = "dump";
    dir = "down";
  }

  return {
    dir,
    phase,
    delta: short.delta,
    from: short.from,
    to: short.to,
    noise: nAbs,
    medDir: med.dir,
    prevDir: prev.dir,
    strength: Math.abs(short.movePct || 0),
    movePct: short.movePct || 0,
    volatility: short.vol || 0,
  };
}

// ─── multi-timeframe range analysis ───

/**
 * Normalize chart points from tonapi `{points:[[ts,price],...]}` or series `{t,p}`.
 * Returns sorted ascending by time: [{t: ms, p: number}, ...]
 */
export function normalizePriceSeries(raw) {
  if (!raw || !raw.length) return [];
  const out = [];
  for (const row of raw) {
    if (Array.isArray(row) && row.length >= 2) {
      const t = Number(row[0]);
      const p = Number(row[1]);
      if (Number.isFinite(t) && Number.isFinite(p) && p > 0) {
        out.push({ t: t < 1e12 ? t * 1000 : t, p });
      }
    } else if (row && typeof row === "object") {
      const t = Number(row.t != null ? row.t : row.ts != null ? row.ts : row.time);
      const p = Number(row.p != null ? row.p : row.price != null ? row.price : row.usd);
      if (Number.isFinite(t) && Number.isFinite(p) && p > 0) {
        out.push({ t: t < 1e12 ? t * 1000 : t, p });
      }
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Analyze price position vs high/low of each configured period.
 *
 * @param {number} live current mid
 * @param {Array<{t:number,p:number}>} hist normalized historical series (ms timestamps)
 * @param {object} [cfg]
 * @returns {{ periods: Array<object>, extremes: Array<object>, summary: object }}
 */
export function analyzeMultiTimeframe(live, hist, cfg = DEFAULT_STRATEGY) {
  const periodsCfg = cfg.rangePeriods || DEFAULT_STRATEGY.rangePeriods;
  const now = Date.now();
  const periods = [];
  const extremes = [];

  for (const pc of periodsCfg) {
    const since = now - pc.seconds * 1000;
    const slice = (hist || []).filter((x) => x.t >= since);
    if (slice.length < 3) {
      periods.push({
        id: pc.id,
        label: pc.label,
        priority: pc.priority,
        ok: false,
        reason: "insufficient_data",
      });
      continue;
    }
    let hi = -Infinity, lo = Infinity, hiT = 0, loT = 0;
    for (const pt of slice) {
      if (pt.p > hi) { hi = pt.p; hiT = pt.t; }
      if (pt.p < lo) { lo = pt.p; loT = pt.t; }
    }
    const range = hi - lo;
    const mid = (hi + lo) / 2;
    const posInRange = range > 0 ? (live - lo) / range : 0.5; // 0 = at low, 1 = at high
    const fromHighPct = hi > 0 ? ((live - hi) / hi) * 100 : 0;
    const fromLowPct = lo > 0 ? ((live - lo) / lo) * 100 : 0;
    const rangePct = mid > 0 ? (range / mid) * 100 : 0;

    // Recent move magnitude vs full period range (last ~10% of samples or last 6 points)
    const tailN = Math.max(6, Math.floor(slice.length * 0.1));
    const tail = slice.slice(-tailN);
    const moveAbs = tail.length >= 2 ? Math.abs(tail[tail.length - 1].p - tail[0].p) : 0;
    const moveVsRange = range > 0 ? moveAbs / range : 0;
    const moveDir = tail.length >= 2
      ? (tail[tail.length - 1].p >= tail[0].p ? "up" : "down")
      : "flat";

    const nearHigh = posInRange >= (pc.extremePctOfRange || 0.9);
    const nearLow = posInRange <= (1 - (pc.extremePctOfRange || 0.9));
    const violentMove = moveVsRange >= (pc.moveVsRange || 0.25) && moveAbs >= noiseAbs(live, cfg);

    const row = {
      id: pc.id,
      label: pc.label,
      priority: pc.priority,
      ok: true,
      high: hi,
      low: lo,
      highAt: hiT,
      lowAt: loT,
      range,
      rangePct,
      posInRange,
      fromHighPct,
      fromLowPct,
      nearHigh,
      nearLow,
      moveVsRange,
      moveDir,
      moveAbs,
      violentMove,
      samples: slice.length,
    };
    periods.push(row);

    if (nearHigh) {
      extremes.push({
        kind: "near_high",
        periodId: pc.id,
        label: pc.label,
        priority: pc.priority,
        live,
        high: hi,
        low: lo,
        posInRange,
        fromHighPct,
        urgency: pc.priority >= 2 ? "high" : "normal",
      });
    }
    if (nearLow) {
      extremes.push({
        kind: "near_low",
        periodId: pc.id,
        label: pc.label,
        priority: pc.priority,
        live,
        high: hi,
        low: lo,
        posInRange,
        fromLowPct,
        urgency: pc.priority >= 2 ? "high" : "normal",
      });
    }
    if (violentMove) {
      extremes.push({
        kind: moveDir === "down" ? "violent_drop" : "violent_rally",
        periodId: pc.id,
        label: pc.label,
        priority: pc.priority,
        live,
        high: hi,
        low: lo,
        moveVsRange,
        moveDir,
        moveAbs,
        urgency: pc.priority >= 2 ? "high" : "normal",
      });
    }
  }

  // Prefer highest-priority / most extreme for summary
  extremes.sort((a, b) => {
    const u = (x) => (x.urgency === "high" ? 2 : 1);
    return u(b) - u(a) || b.priority - a.priority;
  });

  const bestHigh = extremes.find((e) => e.kind === "near_high");
  const bestLow = extremes.find((e) => e.kind === "near_low");
  const bestViolent = extremes.find((e) => e.kind === "violent_drop" || e.kind === "violent_rally");

  return {
    periods,
    extremes,
    summary: {
      nearPeriodHigh: bestHigh || null,
      nearPeriodLow: bestLow || null,
      violent: bestViolent || null,
    },
  };
}

// ─── unified alert evaluation ───

/**
 * Pure alert engine. Returns ranked list of candidate alerts (caller applies cooldown + send).
 *
 * @param {object} ctx
 * @param {object} ctx.pos - calcState result
 * @param {number} ctx.live
 * @param {object} ctx.mom - detectMomentum result
 * @param {object} [ctx.mtf] - analyzeMultiTimeframe result
 * @param {object|null} [ctx.lastTrade] - { type, price }
 * @param {number[]} [ctx.profitPcts]
 * @param {number[]} [ctx.lossPcts]
 * @param {number|null} [ctx.alertAbove]
 * @param {number|null} [ctx.alertBelow]
 * @param {number} [ctx.poolTonReserve]
 * @param {object} [ctx.cfg]
 * @returns {Array<{key:string, family:string, urgent:boolean, priority:number, type:string, payload:object}>}
 */
export function evaluateAlerts(ctx) {
  const {
    pos,
    live,
    mom,
    mtf = null,
    lastTrade: lt = null,
    profitPcts = [],
    lossPcts = [],
    alertAbove = null,
    alertBelow = null,
    poolTonReserve = 1.7e6,
    cfg = DEFAULT_STRATEGY,
  } = ctx;

  const stance = positionStance(pos, live);
  const nAbs = (mom && mom.noise) || noiseAbs(live, cfg);
  const movePct = mom && mom.movePct != null
    ? mom.movePct
    : (mom && mom.from > 0 ? ((live - mom.from) / mom.from) * 100 : 0);
  const out = [];

  const push = (item) => {
    out.push({
      urgent: false,
      priority: 5,
      family: item.family || item.type,
      ...item,
    });
  };

  // 0) Stop-loss (position has GRAM underwater)
  if (stance.action === "sell" && isStopTriggered(pos, live, cfg)) {
    const pct = unrealizedPct(pos, live);
    push({
      key: "stop_loss",
      family: "stop",
      type: "stop_loss",
      urgent: true,
      priority: 0,
      payload: { pct, avg: pos.avgBuyPrice, live, stance },
    });
  }

  // 1) Reversal (short-term, position-aligned)
  if (stance.action === "sell" && mom && mom.phase === "reversal_down") {
    if (Math.abs(mom.delta) >= nAbs) {
      push({
        key: "phase_rev_sell",
        family: "reversal",
        type: "reversal_sell",
        urgent: true,
        priority: 1,
        payload: { from: mom.from, live, delta: Math.abs(mom.delta), movePct: Math.abs(movePct), stance },
      });
    }
  }
  if (stance.action === "buy" && mom && mom.phase === "reversal_up") {
    if (Math.abs(mom.delta) >= nAbs) {
      push({
        key: "phase_rev_buy",
        family: "reversal",
        type: "reversal_buy",
        urgent: true,
        priority: 1,
        payload: { from: mom.from, live, movePct: Math.abs(movePct), stance },
      });
    }
  }

  // 2) Absolute ceiling / floor
  if (alertAbove != null && live >= alertAbove) {
    push({
      key: "above",
      family: "level",
      type: "ceiling",
      priority: 2,
      payload: { level: alertAbove, live, stance },
    });
  }
  if (alertBelow != null && live <= alertBelow) {
    push({
      key: "below",
      family: "level",
      type: "floor",
      priority: 2,
      payload: { level: alertBelow, live, stance },
    });
  }

  // 3) Multi-timeframe extremes (near high/low of period, violent move)
  if (mtf && mtf.extremes && mtf.extremes.length) {
    for (const ex of mtf.extremes) {
      // Position filter: near high matters more when holding GRAM; near low when holding USDT
      if (ex.kind === "near_high") {
        if (stance.action !== "sell" && stance.mode !== "empty") continue;
        push({
          key: "range_high_" + ex.periodId,
          family: "range_high",
          type: "range_near_high",
          urgent: ex.urgency === "high" && (ex.periodId === "24h" || ex.periodId === "7d"),
          priority: ex.urgency === "high" ? 2 : 4,
          payload: { ...ex, stance },
        });
      } else if (ex.kind === "near_low") {
        if (stance.action !== "buy" && stance.mode !== "empty") continue;
        push({
          key: "range_low_" + ex.periodId,
          family: "range_low",
          type: "range_near_low",
          urgent: ex.urgency === "high" && (ex.periodId === "24h" || ex.periodId === "7d"),
          priority: ex.urgency === "high" ? 2 : 4,
          payload: { ...ex, stance },
        });
      } else if (ex.kind === "violent_drop") {
        // Violent drop: useful for both (prepare buy if USDT, caution if GRAM)
        push({
          key: "range_drop_" + ex.periodId,
          family: "range_move",
          type: "range_violent_drop",
          urgent: ex.urgency === "high" && ex.periodId === "24h",
          priority: ex.urgency === "high" ? 3 : 5,
          payload: { ...ex, stance },
        });
      } else if (ex.kind === "violent_rally") {
        push({
          key: "range_rally_" + ex.periodId,
          family: "range_move",
          type: "range_violent_rally",
          urgent: ex.urgency === "high" && ex.periodId === "24h",
          priority: ex.urgency === "high" ? 3 : 5,
          payload: { ...ex, stance },
        });
      }
    }
  }

  // 4) Profit / loss vs last swap (position-aligned)
  // IMPORTANT: only ONE alert per family — the strongest crossed threshold.
  // Otherwise 1.5% then 2% then 2.5% spam every few minutes on the same move.
  if (lt && lt.price > 0) {
    const ref = lt.price;
    const vsSwap = ((live - ref) / ref) * 100;
    const profits = (profitPcts || []).slice().filter((x) => x > 0).sort((a, b) => a - b);
    const losses = (lossPcts || []).slice().filter((x) => x > 0).sort((a, b) => a - b);

    if (stance.action === "sell" && lt.type === "buy") {
      // highest profit target that price has already reached
      let bestProfit = null;
      for (const target of profits) {
        if (vsSwap >= target) bestProfit = target;
      }
      if (bestProfit != null) {
        push({
          key: "ls_profit_buy",
          family: "profit",
          type: "profit_buy",
          priority: 3,
          payload: { vsSwap, target: bestProfit, ref, live, stance },
        });
      }
      // deepest loss threshold crossed
      let bestLoss = null;
      for (const loss of losses) {
        if (vsSwap <= -loss) bestLoss = loss;
      }
      if (bestLoss != null) {
        push({
          key: "ls_loss_buy",
          family: "loss",
          type: "loss_buy",
          priority: 3,
          payload: { vsSwap, loss: bestLoss, ref, live, stance },
        });
      }
    }
    if (stance.action === "buy" && lt.type === "sell") {
      // strongest "cheaper than sell" target (most negative vsSwap)
      let bestProfit = null;
      for (const target of profits) {
        if (vsSwap <= -target) bestProfit = target;
      }
      if (bestProfit != null) {
        push({
          key: "ls_profit_sell",
          family: "profit",
          type: "profit_sell",
          priority: 3,
          payload: { vsSwap, target: bestProfit, ref, live, stance },
        });
      }
      let bestLoss = null;
      for (const loss of losses) {
        if (vsSwap >= loss) bestLoss = loss;
      }
      if (bestLoss != null) {
        push({
          key: "ls_loss_sell",
          family: "loss",
          type: "loss_sell",
          priority: 3,
          payload: { vsSwap, loss: bestLoss, ref, live, stance },
        });
      }
    }
  }

  // 5) Trend continuation (prepare)
  if (stance.action === "sell" && mom && mom.phase === "rally") {
    if (Math.abs(mom.delta) >= nAbs || (mom.strength || 0) >= (cfg.phaseStrengthPct || 0.6)) {
      push({
        key: "phase_rally",
        family: "phase",
        type: "rally_prepare",
        priority: 6,
        payload: { from: mom.from, live, movePct: Math.abs(movePct), stance },
      });
    }
  }
  if (stance.action === "buy" && mom && mom.phase === "dump") {
    if (Math.abs(mom.delta) >= nAbs || (mom.strength || 0) >= (cfg.phaseStrengthPct || 0.6)) {
      push({
        key: "phase_dump",
        family: "phase",
        type: "dump_watch",
        priority: 6,
        payload: { from: mom.from, live, movePct: Math.abs(movePct), stance },
      });
    }
  }

  // Sort: urgent first, then lower priority number, then key
  out.sort((a, b) => {
    if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return String(a.key).localeCompare(String(b.key));
  });

  return out;
}

/**
 * Pick cooldown ms for an alert key/family from strategy config.
 */
export function cooldownFor(alert, cfg = DEFAULT_STRATEGY) {
  const c = cfg.cool || DEFAULT_STRATEGY.cool;
  const fam = alert.family || "";
  if (fam === "stop") return c.stop;
  if (fam === "reversal") return c.reversal;
  if (fam === "phase") return c.phase;
  if (fam === "range_high") return c.rangeHigh;
  if (fam === "range_low") return c.rangeLow;
  if (fam === "range_move") return c.rangeMove;
  if (fam === "level") return c.level;
  if (fam === "profit") return c.profit != null ? c.profit : 3 * 60 * 60 * 1000;
  if (fam === "loss") return c.loss != null ? c.loss : c.profit != null ? c.profit : 3 * 60 * 60 * 1000;
  return c.level;
}

/**
 * Keys to check/mark for cooldown.
 * Always includes family key so threshold cascades (1.5→2→2.5) cannot spam.
 */
export function cooldownKeys(alert) {
  if (!alert) return [];
  const keys = [];
  if (alert.key) keys.push(String(alert.key));
  if (alert.family) keys.push("fam_" + alert.family);
  return keys;
}
