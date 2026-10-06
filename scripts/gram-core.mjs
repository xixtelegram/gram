/**
 * Shared GRAM Swap core — used by ton-alert.mjs and (via import) the web app.
 * Pure logic only: no DOM, no localStorage, no Telegram.
 */

export const STON_POOL = "EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4";
export const USDT_MASTER = "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe";
export const ROUND = 0.2;
export const NOISE_PCT = 0.012;
/** Absolute floor kept tiny so low-priced tokens (e.g. GRAM ~0.01) still detect moves */
export const NOISE_FLOOR = 1e-6;
export const MIN_ACTION_PCT = 0.5;
/** Percent steps only — Persian labels live in telegram-messages.mjs */
export const ADVICE_PCTS = [0.5, 1, 2, 3, 5];
/** @deprecated use ADVICE_PCTS; kept for older imports */
export const ADVICE_LEVELS = ADVICE_PCTS.map((pct) => ({ pct, tag: String(pct) }));

export function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function fmt(n, d = 4) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(d);
}

export function noiseAbs(price) {
  const p = Number(price);
  const px = Number.isFinite(p) && p > 0 ? p : 1;
  // Primary: percent of price; floor only avoids zero at pathological prices
  return Math.max(NOISE_FLOOR, px * NOISE_PCT);
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

/** ISO or local-ish datetime string for event timestamp */
export function eventDate(tsSec) {
  return new Date(tsSec * 1000).toISOString();
}

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
    // aliases for alert script
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
 * @param {number|null} [livePrice] current mid — for mixed bags use live value, not avg entry
 */
export function positionStance(s, livePrice = null) {
  const hasGram = s && s.totalGram > 1e-6;
  const hasUsdt = s && s.cashUsdt > 1e-6;
  // Labels are in telegram-messages.stanceLabel — core stays language-free
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

export function sellIsWorthwhile(s, price, poolTonReserve = 1.7e6) {
  if (!s || !s.avgBuyPrice || s.totalGram <= 0 || !price) return false;
  const exec = estExecSellPrice(price, s.totalGram, poolTonReserve);
  const pct = ((exec - s.avgBuyPrice) / s.avgBuyPrice) * 100;
  return pct >= MIN_ACTION_PCT && (exec - s.avgBuyPrice) >= noiseAbs(price) * 0.5;
}

export function buyIsWorthwhile(s, price, poolTonReserve = 1.7e6) {
  if (!price || !s) return false;
  const ref = s.lastSwapType === "sell" && s.lastSwapPrice ? s.lastSwapPrice : null;
  const exec = s.cashUsdt > 0 ? estExecBuyPrice(price, s.cashUsdt, poolTonReserve) : price;
  if (ref != null) {
    const pct = ((ref - exec) / ref) * 100;
    return pct >= MIN_ACTION_PCT && (ref - exec) >= noiseAbs(price) * 0.5;
  }
  return true;
}

/**
 * Trend phases for position-aware alerts:
 *   rally          — قیمت مدام بالا می‌رود
 *   dump           — قیمت مدام پایین می‌آید
 *   reversal_down  — بعد از صعود، برگشت نزولی (سیگنال فروش فوری)
 *   reversal_up    — بعد از نزول، برگشت صعودی (سیگنال خرید فوری)
 *   flat           — بدون جهت واضح
 *
 * IMPORTANT: short-vs-medium conflict is treated as REVERSAL, not flat.
 */
export function detectMomentum(series) {
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
  };
  if (!series || series.length < 6) return empty;

  const lastP = series[series.length - 1].p;
  const nAbs = noiseAbs(lastP);
  const shortN = Math.min(series.length, 16);
  const prevN = Math.min(Math.max(0, series.length - shortN), 16);
  const medN = Math.min(series.length, 48);

  function win(arr) {
    if (!arr || arr.length < 2) {
      return { dir: "flat", delta: 0, from: null, to: null, movePct: 0 };
    }
    const from = arr[0].p;
    const to = arr[arr.length - 1].p;
    const delta = to - from;
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
    const movePct = from > 0 ? (delta / from) * 100 : 0;
    return { dir, delta, from, to, movePct };
  }

  const short = win(series.slice(-shortN));
  const prev = prevN >= 4 ? win(series.slice(-(shortN + prevN), -shortN || undefined)) : { dir: "flat", delta: 0, movePct: 0 };
  const med = win(series.slice(-medN));

  let phase = "flat";
  let dir = short.dir;

  // Reversal first — this is the urgent trade signal
  if (short.dir === "down" && Math.abs(short.delta) >= nAbs && (prev.dir === "up" || med.dir === "up")) {
    phase = "reversal_down";
    dir = "down";
  } else if (short.dir === "up" && Math.abs(short.delta) >= nAbs && (prev.dir === "down" || med.dir === "down")) {
    phase = "reversal_up";
    dir = "up";
  } else if (short.dir === "up" && (med.dir === "up" || prev.dir === "up" || med.dir === "flat")) {
    if (Math.abs(short.delta) >= nAbs || Math.abs(med.delta) >= nAbs * 1.4) {
      phase = "rally";
      dir = "up";
    }
  } else if (short.dir === "down" && (med.dir === "down" || prev.dir === "down" || med.dir === "flat")) {
    if (Math.abs(short.delta) >= nAbs || Math.abs(med.delta) >= nAbs * 1.4) {
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
  };
}

/* reconcileNote moved to telegram-messages.mjs — single copy source */
