/**
 * Telegram message copy & structure for GRAM Trader.
 * Edit this file when you only need to change alert/status wording.
 */

import { ROUND, fmt, estSlippagePct } from "./gram-core.mjs";

export function formatPctSigned(pct) {
  if (pct == null || !Number.isFinite(pct)) return "—";
  const a = Math.abs(pct).toFixed(2);
  return (pct >= 0 ? "+" : "−") + a + "٪";
}

/** @param {object} s @param {number|null} price @param {{type?:string,price?:number}|null} lastTrade */
export function pnlHeadline(s, price, lastTrade) {
  if (!price) return { emoji: "⚪", title: "قیمت در دسترس نیست", pct: null, kind: "unknown" };

  if (s.totalGram > 1e-6 && s.avgBuyPrice > 0) {
    const pct = ((price - s.avgBuyPrice) / s.avgBuyPrice) * 100;
    if (pct >= 0.15) return { emoji: "🟢", title: "در سود شناور", pct, kind: "profit", basis: "میانگین ورود " + fmt(s.avgBuyPrice, 4) };
    if (pct <= -0.15) return { emoji: "🔴", title: "در ضرر شناور", pct, kind: "loss", basis: "میانگین ورود " + fmt(s.avgBuyPrice, 4) };
    return { emoji: "⚪", title: "نزدیک سر به سر", pct, kind: "flat", basis: "میانگین ورود " + fmt(s.avgBuyPrice, 4) };
  }

  const lt = lastTrade;
  if (lt && lt.type === "sell" && lt.price > 0) {
    const pct = ((price - lt.price) / lt.price) * 100;
    if (pct <= -0.15) return { emoji: "🟢", title: "فرصت خرید بهتر از فروش", pct, kind: "opportunity", basis: "آخرین فروش " + fmt(lt.price, 4) };
    if (pct >= 0.15) return { emoji: "🟡", title: "قیمت بالاتر از فروش تو", pct, kind: "missed", basis: "آخرین فروش " + fmt(lt.price, 4) };
    return { emoji: "⚪", title: "نزدیک قیمت فروش", pct, kind: "flat", basis: "آخرین فروش " + fmt(lt.price, 4) };
  }

  if (lt && lt.type === "buy" && lt.price > 0) {
    const pct = ((price - lt.price) / lt.price) * 100;
    if (pct >= 0.15) return { emoji: "🟢", title: "بالاتر از آخرین خرید", pct, kind: "profit", basis: "آخرین خرید " + fmt(lt.price, 4) };
    if (pct <= -0.15) return { emoji: "🔴", title: "پایین‌تر از آخرین خرید", pct, kind: "loss", basis: "آخرین خرید " + fmt(lt.price, 4) };
    return { emoji: "⚪", title: "نزدیک آخرین خرید", pct, kind: "flat", basis: "آخرین خرید " + fmt(lt.price, 4) };
  }

  return { emoji: "⚪", title: "مرجع کافی نیست", pct: null, kind: "unknown" };
}

export function actionAdvice(s, price, hl, checks) {
  if (!price) return "صبر کن تا قیمت معتبر شود.";
  if (hl.kind === "profit" && s.totalGram > 1e-6) {
    if (checks.sellIsWorthwhile(s, price)) return "می‌توانی فروش را در نظر بگیری (لغزش را حساب کن).";
    return "در سودی؛ برای فروش بهتر صبر کن تا به اهداف برسد.";
  }
  if (hl.kind === "loss" && s.totalGram > 1e-6) {
    return "ضرر هنوز قطعی نیست مگر بفروشی. عجله نکن.";
  }
  if (hl.kind === "opportunity") {
    if (checks.buyIsWorthwhile(s, price)) return "نسبت به فروش قبلی جا برای خرید بهتر داری.";
    return "کمی ارزان‌تر شده؛ هنوز برای ورود عجله نکن.";
  }
  if (hl.kind === "missed") {
    return "قیمت از فروش تو بالا رفته. برای خرید دوباره صبر کن.";
  }
  return "شرایط خنثی است. صبر منطقی‌تر از معامله عجولانه است.";
}

export function targetsBlock(s, lastTrade, poolReserve) {
  const lt = lastTrade;
  if (!lt || !(lt.price > 0)) return "";
  const ref = lt.price;
  const pad = 1 - ROUND / 100;
  const levels = [
    { pct: 1, tag: "۱٪" },
    { pct: 2, tag: "۲٪" },
    { pct: 3, tag: "۳٪" },
    { pct: 5, tag: "۵٪" },
  ];
  let out = "";
  if (lt.type === "buy") {
    out += "\n\nاهداف فروش:";
    for (const L of levels) {
      const slip = (s && s.totalGram > 0) ? estSlippagePct(s.totalGram, poolReserve) / 100 : 0;
      const midNeed = (ref * (1 + L.pct / 100)) / Math.max(0.5, 1 - slip) / pad;
      out += "\n• +" + L.tag + " → " + fmt(midNeed, 4);
    }
  } else {
    out += "\n\nاهداف خرید:";
    for (const L of levels) {
      const target = ref * (1 - L.pct / 100) * pad;
      out += "\n• −" + L.tag + " → " + fmt(target, 4);
    }
  }
  return out;
}

export function stanceLine(s, price, lastTrade, checks) {
  const hl = pnlHeadline(s, price, lastTrade);
  let line = hl.emoji + " " + hl.title;
  if (hl.pct != null) line += "  " + formatPctSigned(hl.pct);
  if (hl.basis) line += "\n" + hl.basis;
  line += "\n" + actionAdvice(s, price, hl, checks);
  return line;
}

export function buildStatusMessage(s, live, quote, lastTrade, checks, poolReserve) {
  const price = live;
  const hl = pnlHeadline(s, price, lastTrade);
  let msg = "📊 GRAM · وضعیت\n\n";

  msg += hl.emoji + " " + hl.title;
  if (hl.pct != null) msg += "  " + formatPctSigned(hl.pct);
  msg += "\n";
  if (hl.basis) msg += hl.basis + "\n";

  msg += "\nقیمت: " + (price != null ? fmt(price, 4) : "—");
  if (quote && quote.source) msg += " · " + quote.source;

  const bits = [];
  if (s.cashUsdt > 0) bits.push(fmt(s.cashUsdt, 2) + " USDT");
  if (s.totalGram > 1e-6) bits.push(fmt(s.totalGram, 4) + " GRAM");
  if (bits.length) msg += "\nپوزیشن: " + bits.join(" · ");
  if (s.equity) msg += "\nارزش ≈ " + fmt(s.equity, 2) + " USDT";

  msg += "\n\nپیشنهاد: " + actionAdvice(s, price, hl, checks);

  if (hl.kind === "profit" || hl.kind === "loss" || hl.kind === "opportunity" || hl.kind === "missed" || hl.kind === "flat") {
    msg += targetsBlock(s, lastTrade, poolReserve);
  }

  return msg;
}

export function msgCeiling(above, live, stanceText) {
  return "🔺 سقف قیمت\n\nسقف: " + fmt(above, 4) + " · الان: " + fmt(live, 4) + "\n\n" + stanceText;
}
export function msgFloor(below, live, stanceText) {
  return "🔻 کف قیمت\n\nکف: " + fmt(below, 4) + " · الان: " + fmt(live, 4) + "\n\n" + stanceText;
}
export function msgProfitBuy(movePct, targetPct, ref, live, stanceText) {
  return "🟢 سود نسبت به خرید\n\n+" + movePct.toFixed(2) + "٪ · هدف +" + targetPct + "٪\nخرید: " + fmt(ref, 4) + " · الان: " + fmt(live, 4) + "\n\n" + stanceText;
}
export function msgLossBuy(movePct, lossPct, ref, live, stanceText) {
  return "🔴 عقب‌نشینی نسبت به خرید\n\n" + movePct.toFixed(2) + "٪ · آستانه −" + lossPct + "٪\nخرید: " + fmt(ref, 4) + " · الان: " + fmt(live, 4) + "\nضرر قطعی نیست مگر بفروشی.\n\n" + stanceText;
}
export function msgProfitSell(movePct, targetPct, ref, live, stanceText) {
  return "🟢 فرصت خرید\n\n" + movePct.toFixed(2) + "٪ نسبت به فروش · هدف −" + targetPct + "٪\nفروش: " + fmt(ref, 4) + " · الان: " + fmt(live, 4) + "\n\n" + stanceText;
}
export function msgLossSell(movePct, lossPct, ref, live, stanceText) {
  return "🟡 قیمت بالاتر از فروش تو\n\n+" + movePct.toFixed(2) + "٪ · آستانه +" + lossPct + "٪\nفروش: " + fmt(ref, 4) + " · الان: " + fmt(live, 4) + "\n\n" + stanceText;
}
export function msgTrendUp(from, live, delta, stanceText) {
  return "📈 روند صعودی\n\nاز " + fmt(from, 4) + " → " + fmt(live, 4) + " (+" + fmt(Math.abs(delta), 4) + ")\n\n" + stanceText;
}
export function msgTrendDown(from, live, drop, stanceText) {
  return "📉 روند نزولی\n\nاز " + fmt(from, 4) + " → " + fmt(live, 4) + " (−" + fmt(drop, 4) + ")\n\n" + stanceText;
}
export function msgDrop(from, live, drop, stanceText) {
  return "📉 افت قیمت\n\nاز " + fmt(from, 4) + " → " + fmt(live, 4) + " (−" + fmt(drop, 4) + ")\n\n" + stanceText;
}
export function msgBounce(delta, live, stanceText) {
  return "📈 برگشت قیمت\n\nحرکت +" + fmt(Math.abs(delta), 4) + " · الان " + fmt(live, 4) + "\n\n" + stanceText;
}
export function msgConnected() {
  return "✅ اتصال برقرار شد\nهشدارهای GRAM از این به بعد اینجا می‌آیند.";
}
