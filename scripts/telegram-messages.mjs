/**
 * GRAM — تنها منبع متن‌های کاربر (تلگرام + UI پیشنهاد)
 *
 * همهٔ کپی فارسی اینجا است. app / ton-alert فقط از این فایل import کنند.
 * gram-core نباید متن فارسی داشته باشد (فقط عدد و منطق).
 */

import {
  ROUND,
  MIN_ACTION_PCT,
  fmt,
  estSlippagePct,
  estExecSellPrice,
  estExecBuyPrice,
  positionStance,
} from "./gram-core.mjs";

// ─── utils ───

export function formatPctSigned(pct) {
  if (pct == null || !Number.isFinite(pct)) return "—";
  const a = Math.abs(pct).toFixed(2);
  return (pct >= 0 ? "+" : "−") + a + "٪";
}

function pctStr(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  return Number(n).toFixed(digits) + "٪";
}

function priceLine(label, value) {
  return label + ": " + (value != null && Number.isFinite(Number(value)) ? fmt(value, 4) : "—");
}

function footer(stanceText) {
  if (!stanceText || !String(stanceText).trim()) return "";
  return "\n\n────────\n" + String(stanceText).trim();
}

export const ADVICE_LEVELS = [
  { pct: 0.5, tag: "کمی" },
  { pct: 1, tag: "بهتر" },
  { pct: 2, tag: "خوب" },
  { pct: 3, tag: "خیلی خوب" },
  { pct: 5, tag: "عالی" },
];

// ─── stance labels ───

const STANCE_LABELS = {
  hold_gram: "بیشتر سرمایه‌ات GRAM است",
  hold_usdt: "بیشتر سرمایه‌ات تتر است",
  empty: "پوزیشن مشخصی نیست",
};

export function stanceLabel(mode) {
  return STANCE_LABELS[mode] || STANCE_LABELS.empty;
}

export function stanceOf(s, livePrice = null) {
  const st = positionStance(s, livePrice);
  return { ...st, label: stanceLabel(st.mode) };
}

// ─── situation ───

export function pnlHeadline(s, price, lastTrade) {
  if (!price) {
    return { emoji: "⚪", title: "قیمت هنوز مشخص نیست", pct: null, kind: "unknown", basis: null };
  }

  if (s.totalGram > 1e-6 && s.avgBuyPrice > 0) {
    const pct = ((price - s.avgBuyPrice) / s.avgBuyPrice) * 100;
    const basis = "قیمت میانگین خرید تو: " + fmt(s.avgBuyPrice, 4);
    if (pct >= 0.15) return { emoji: "🟢", title: "الان روی سود هستی (هنوز نفروختی)", pct, kind: "profit", basis };
    if (pct <= -0.15) return { emoji: "🔴", title: "قیمت از خریدت پایین‌تر آمده", pct, kind: "loss", basis };
    return { emoji: "⚪", title: "نزدیک نقطه سر‌به‌سر", pct, kind: "flat", basis };
  }

  const lt = lastTrade;
  if (lt && lt.type === "sell" && lt.price > 0) {
    const pct = ((price - lt.price) / lt.price) * 100;
    const basis = "قیمت آخرین فروشت: " + fmt(lt.price, 4);
    if (pct <= -0.15) return { emoji: "🟢", title: "ارزان‌تر از فروشت شده — فرصت خرید", pct, kind: "opportunity", basis };
    if (pct >= 0.15) return { emoji: "🟡", title: "بعد از فروشت قیمت رفته بالا", pct, kind: "missed", basis };
    return { emoji: "⚪", title: "نزدیک قیمت آخرین فروشت", pct, kind: "flat", basis };
  }

  if (lt && lt.type === "buy" && lt.price > 0) {
    const pct = ((price - lt.price) / lt.price) * 100;
    const basis = "قیمت آخرین خریدت: " + fmt(lt.price, 4);
    if (pct >= 0.15) return { emoji: "🟢", title: "بالاتر از آخرین خریدت", pct, kind: "profit", basis };
    if (pct <= -0.15) return { emoji: "🔴", title: "پایین‌تر از آخرین خریدت", pct, kind: "loss", basis };
    return { emoji: "⚪", title: "نزدیک آخرین خریدت", pct, kind: "flat", basis };
  }

  return {
    emoji: "⚪",
    title: "هنوز معامله‌ای ثبت نشده",
    pct: null,
    kind: "unknown",
    basis: "اول کیف‌پول را همگام کن یا یک سواپ ثبت کن",
  };
}

// ─── advice ───

export function actionAdvice(s, price, hl, checks) {
  if (!price) return "صبر کن تا قیمت درست لود شود.";
  if (hl.kind === "profit" && s.totalGram > 1e-6) {
    if (checks && checks.sellIsWorthwhile(s, price)) {
      return "دستور: بفروووش — سود معنادار داری؛ فروش را اجرا کن.";
    }
    return "نگه دار؛ هنوز برای فروش قوی نیست. منتظر هدف بالاتر باش.";
  }
  if (hl.kind === "loss" && s.totalGram > 1e-6) {
    return "عجله نکن. تا نفروشی ضرر فقط روی کاغذ است — مگر حدضرر فعال شده باشد.";
  }
  if (hl.kind === "opportunity") {
    if (checks && checks.buyIsWorthwhile(s, price)) {
      return "دستور: بخرررر — نسبت به فروشت ارزان‌تر شده.";
    }
    return "کمی ارزان شده؛ هنوز برای خرید عجله نکن.";
  }
  if (hl.kind === "missed") return "الان نخر. صبر کن قیمت دوباره نزدیک فروشت شود.";
  if (hl.kind === "unknown") return "اول تاریخچه سواپ یا کیف‌پول را وصل کن.";
  return "شرایط عادی — معامله عجولانه لازم نیست.";
}

/** کارت پیشنهاد UI — تنها منبع متن hint/rows */
export function buildAdvice(s, price, lastTrade, poolTonReserve = 1.7e6) {
  const lt = lastTrade;
  const pad = 1 - ROUND / 100;
  if (!lt || !(lt.price > 0)) {
    return {
      hint: "هنوز سواپی ثبت نشده — همگام‌سازی کیف‌پول را بزن",
      meta: "",
      rows: [],
      lastType: null,
      ref: null,
      suggest: null,
      breakEven: null,
      beExact: null,
    };
  }

  const ref = lt.price;
  const rows = [];

  if (lt.type === "buy") {
    const curPct = price > 0 ? ((price - ref) / ref) * 100 : null;
    const exec = price > 0 && s.totalGram > 0 ? estExecSellPrice(price, s.totalGram, poolTonReserve) : null;
    const execPct = exec != null ? ((exec - ref) / ref) * 100 : null;

    let hint = "آخرین سواپ: خرید GRAM @ " + fmt(ref, 4);
    if (curPct != null) {
      hint += "\nقیمت الان: " + fmt(price, 4) + " → " + (curPct >= 0 ? "سود " : "ضرر ") + Math.abs(curPct).toFixed(2) + "٪ نسبت به خرید";
    }
    if (execPct != null) {
      hint += "\nبا هزینه معامله تقریبی: " + fmt(exec, 4) + " (" + (execPct >= 0 ? "+" : "") + execPct.toFixed(2) + "٪)";
    }

    for (const L of ADVICE_LEVELS) {
      const slip = s.totalGram > 0 ? estSlippagePct(s.totalGram, poolTonReserve) / 100 : 0;
      const midForExec = (ref * (1 + L.pct / 100)) / Math.max(0.5, 1 - slip) / pad;
      rows.push({
        label: "فروش +" + L.pct + "٪",
        price: midForExec,
        detail: L.tag + " — وقتی قیمت نزدیک " + fmt(midForExec, 4) + " شد حدود +" + L.pct + "٪ سود می‌ماند",
      });
    }

    const suggest = execPct != null && execPct >= MIN_ACTION_PCT ? "to_usdt" : null;
    if (suggest) hint += "\n✅ بعد از هزینه معامله در سود معناداری هستی — می‌توانی فروش را بررسی کنی";
    else if (curPct != null && curPct < 0) hint += "\nمنتظر برگشت بالای " + fmt(ref, 4) + " بمان";
    else hint += "\nبرای فروش بهتر صبر کن تا به هدف‌های زیر نزدیک شود";

    return { hint, meta: "مرجع = قیمت آخرین خرید", rows, lastType: "buy", ref, suggest, breakEven: ref / pad, beExact: ref };
  }

  const curPct = price > 0 ? ((ref - price) / ref) * 100 : null;
  let hint = "آخرین سواپ: فروش GRAM @ " + fmt(ref, 4);
  if (curPct != null) {
    hint += "\nقیمت الان: " + fmt(price, 4) + " → " + (curPct >= 0 ? curPct.toFixed(2) + "٪ ارزان‌تر از فروش" : Math.abs(curPct).toFixed(2) + "٪ گران‌تر از فروش");
  }

  for (const L of ADVICE_LEVELS) {
    const target = ref * (1 - L.pct / 100) * pad;
    rows.push({
      label: "خرید −" + L.pct + "٪",
      price: target,
      detail: L.tag + " — زیر " + fmt(target, 4) + " نسبت به فروش آخر حدود +" + L.pct + "٪ جا برای دور بعد",
    });
  }

  const suggest = curPct != null && curPct >= MIN_ACTION_PCT ? "to_gram" : null;
  if (suggest) hint += "\n✅ نسبت به فروش آخر ارزان‌تر شده — می‌توانی دوباره بخری";
  else hint += "\nعجله نکن — منتظر نزدیک شدن به هدف‌های خرید زیر بمان";

  return { hint, meta: "مرجع = قیمت آخرین فروش", rows, lastType: "sell", ref, suggest, breakEven: ref * pad, beExact: ref };
}

// ─── targets ───

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
    out += "\n\nاگر بخواهی بفروشی، این قیمت‌ها را در نظر بگیر:";
    for (const L of levels) {
      const slip = s && s.totalGram > 0 ? estSlippagePct(s.totalGram, poolReserve) / 100 : 0;
      const midNeed = (ref * (1 + L.pct / 100)) / Math.max(0.5, 1 - slip) / pad;
      out += "\n• حدود +" + L.tag + " سود ← قیمت نزدیک " + fmt(midNeed, 4);
    }
  } else {
    out += "\n\nاگر بخواهی دوباره بخری، این قیمت‌ها را در نظر بگیر:";
    for (const L of levels) {
      const target = ref * (1 - L.pct / 100) * pad;
      out += "\n• حدود −" + L.tag + " ارزان‌تر ← قیمت نزدیک " + fmt(target, 4);
    }
  }
  return out;
}

// ─── stanceLine ───

/**
 * Short footer for alert messages — matches position action only.
 * Avoids contradictory lines like "ضرر روی کاغذ" under a buy-opportunity alert
 * when a leftover GRAM bag is underwater but the user is mainly in USDT.
 */
export function alertStanceFooter(s, price) {
  const st = stanceOf(s, price);
  if (st.action === "buy") {
    return st.label + "\nسمت تو: خرید (تتر داری)";
  }
  if (st.action === "sell") {
    return st.label + "\nسمت تو: فروش (GRAM داری)";
  }
  return st.label || "";
}

/** Format projection block from analyzeTradeOpportunity result */
function projectionBlock(opp) {
  if (!opp) return "";
  let t = "";
  if (opp.targetUpPct != null || opp.targetDownPct != null) {
    t += "\n\n📐 تخمین حرکت بعدی";
    if (opp.horizon) t += " (افق: " + opp.horizon + ")";
    t += ":";
    if (opp.targetUpPct != null) {
      t += "\n• رشد ممکن: حدود +" + pctStr(opp.targetUpPct, 1);
      if (opp.targetUpPrice != null) t += " → نزدیک " + fmt(opp.targetUpPrice, 4);
    }
    if (opp.targetDownPct != null) {
      t += "\n• ریزش ممکن: حدود −" + pctStr(opp.targetDownPct, 1);
      if (opp.targetDownPrice != null) t += " → نزدیک " + fmt(opp.targetDownPrice, 4);
    }
  }
  if (opp.confidence != null) {
    t += "\n• اطمینان سیگنال: " + Math.round(opp.confidence) + "٪";
  }
  return t;
}

function reasonFa(key) {
  const map = {
    pos_usdt: "بیشتر سرمایه‌ات تتر است",
    pos_gram: "بیشتر سرمایه‌ات GRAM است",
    rev_up: "برگشت صعودی بعد از ریزش",
    rev_down: "برگشت نزولی بعد از رشد",
    rally: "روند رشد فعال",
    dump: "روند ریزش فعال",
    asymm_up: "جا برای رشد بیشتر از ریزش",
    asymm_down: "جا برای ریزش بیشتر از رشد",
  };
  if (map[key]) return map[key];
  if (key.startsWith("near_low_")) return "نزدیک کف بازهٔ " + key.replace("near_low_", "");
  if (key.startsWith("near_high_")) return "نزدیک سقف بازهٔ " + key.replace("near_high_", "");
  if (key.startsWith("violent_drop_")) return "ریزش تند در " + key.replace("violent_drop_", "");
  if (key.startsWith("violent_rally_")) return "رشد تند در " + key.replace("violent_rally_", "");
  return key;
}

function reasonsLine(opp) {
  if (!opp || !opp.reasons || !opp.reasons.length) return "";
  const uniq = [];
  for (const r of opp.reasons) {
    const fa = reasonFa(r);
    if (fa && !uniq.includes(fa)) uniq.push(fa);
  }
  if (!uniq.length) return "";
  return "\n\nدلیل: " + uniq.slice(0, 4).join(" · ");
}

export function stanceLine(s, price, lastTrade, checks) {
  const st = stanceOf(s, price);
  const hl = pnlHeadline(s, price, lastTrade);
  let line = st.label;
  line += "\n" + hl.emoji + " " + hl.title;
  if (hl.pct != null) line += "  " + formatPctSigned(hl.pct);
  if (hl.basis) line += "\n" + hl.basis;
  line += "\n" + actionAdvice(s, price, hl, checks);
  return line;
}

export function lastSwapAdviceBlock(s, price, lastTrade, poolReserve = 1.7e6) {
  const adv = buildAdvice(s, price, lastTrade, poolReserve);
  if (!adv.lastType) return "\n\n" + adv.hint;
  let out = "\n\n" + adv.hint;
  if (adv.rows && adv.rows.length) {
    out += adv.lastType === "buy" ? "\n\nاهداف فروش:" : "\n\nاهداف خرید:";
    for (const r of adv.rows) out += "\n• " + r.label + " → " + fmt(r.price, 4);
  }
  return out;
}

// ─── status ───

export function buildStatusMessage(s, live, quote, lastTrade, checks, poolReserve) {
  const price = live;
  const hl = pnlHeadline(s, price, lastTrade);
  const st = stanceOf(s, price);

  let msg = "📊 گزارش وضعیت GRAM\n\n";
  msg += st.label + "\n";
  msg += hl.emoji + " " + hl.title;
  if (hl.pct != null) msg += "  " + formatPctSigned(hl.pct);
  msg += "\n";
  if (hl.basis) msg += hl.basis + "\n";
  msg += "\n" + priceLine("قیمت الان", price);
  if (quote && quote.source) msg += "  (" + quote.source + ")";

  const bits = [];
  if (s.cashUsdt > 0) bits.push(fmt(s.cashUsdt, 2) + " USDT");
  if (s.totalGram > 1e-6) bits.push(fmt(s.totalGram, 4) + " GRAM");
  if (bits.length) msg += "\nدارایی تو: " + bits.join("  ·  ");
  if (s.equity) msg += "\nارزش تقریبی: " + fmt(s.equity, 2) + " USDT";
  msg += "\n\n" + actionAdvice(s, price, hl, checks);
  if (["profit", "loss", "opportunity", "missed", "flat"].includes(hl.kind)) {
    msg += targetsBlock(s, lastTrade, poolReserve);
  }
  return msg;
}

// ─── alerts (explicit BUY / SELL language) ───

/** Primary command messages from analyzeTradeOpportunity */
export function msgTradeBuy(payload, stanceText) {
  const opp = (payload && payload.opportunity) || {};
  const live = payload && payload.live;
  let t =
    "🟢🟢 بخرررر\n\n" +
    "سیگنال خرید فعال شد.\n" +
    priceLine("قیمت الان", live);
  t += projectionBlock(opp);
  t += reasonsLine(opp);
  t += "\n\nدستور: همین الان خرید را اجرا کن (یا حداقل بخشی از تترت را وارد کن).";
  return t + footer(stanceText);
}

export function msgTradeSell(payload, stanceText) {
  const opp = (payload && payload.opportunity) || {};
  const live = payload && payload.live;
  let t =
    "🔴🔴 بفروووش\n\n" +
    "سیگنال فروش فعال شد.\n" +
    priceLine("قیمت الان", live);
  t += projectionBlock(opp);
  t += reasonsLine(opp);
  t += "\n\nدستور: همین الان فروش را اجرا کن (حداقل بخشی از GRAM را خارج کن).";
  return t + footer(stanceText);
}

export function msgCeiling(above, live, stanceText, opportunity) {
  return (
    "🔺 سقف شخصی رد شد — بفروووش\n\n" +
    "سقفی که گذاشته بودی: " + fmt(above, 4) + "\n" +
    "قیمت الان: " + fmt(live, 4) + "\n\n" +
    "دستور: اگر GRAM داری فروش را اجرا کن." +
    projectionBlock(opportunity) +
    footer(stanceText)
  );
}

export function msgFloor(below, live, stanceText, opportunity) {
  return (
    "🔻 کف شخصی رسید — بخرررر\n\n" +
    "کفی که گذاشته بودی: " + fmt(below, 4) + "\n" +
    "قیمت الان: " + fmt(live, 4) + "\n\n" +
    "دستور: اگر تتر داری خرید را اجرا کن." +
    projectionBlock(opportunity) +
    footer(stanceText)
  );
}

export function msgProfitBuy(movePct, targetPct, ref, live, stanceText, opportunity) {
  return (
    "🟢 به هدف سود رسیدی — بفروووش\n\n" +
    "از خریدت حدود +" + pctStr(movePct) + " بالاتر\n" +
    "(هدف: +" + pctStr(targetPct, 2) + ")\n\n" +
    priceLine("قیمت خریدت", ref) + "\n" +
    priceLine("قیمت الان", live) + "\n\n" +
    "دستور: سود را قطعی کن — فروش را اجرا کن." +
    projectionBlock(opportunity) +
    footer(stanceText)
  );
}

export function msgLossBuy(movePct, lossPct, ref, live, stanceText, opportunity) {
  return (
    "🔴 زیر خریدت — مدیریت ریسک\n\n" +
    "حدود " + pctStr(movePct) + " نسبت به خریدت\n" +
    "(آستانه: −" + pctStr(lossPct, 2) + ")\n\n" +
    priceLine("قیمت خریدت", ref) + "\n" +
    priceLine("قیمت الان", live) + "\n\n" +
    "تا نفروشی ضرر قطعی نیست. اگر حدضرر شخصی داری → بفروووش." +
    projectionBlock(opportunity) +
    footer(stanceText)
  );
}

export function msgProfitSell(movePct, targetPct, ref, live, stanceText, opportunity) {
  return (
    "🟢 ارزان‌تر از فروشت — بخرررر\n\n" +
    "از فروشت حدود " + pctStr(movePct) + " ارزان‌تر\n" +
    "(هدف: −" + pctStr(targetPct, 2) + ")\n\n" +
    priceLine("قیمت فروشت", ref) + "\n" +
    priceLine("قیمت الان", live) + "\n\n" +
    "دستور: خرید دوباره را اجرا کن." +
    projectionBlock(opportunity) +
    footer(stanceText)
  );
}

export function msgLossSell(movePct, lossPct, ref, live, stanceText, opportunity) {
  return (
    "🟡 بعد از فروشت قیمت بالا رفته\n\n" +
    "حدود +" + pctStr(movePct) + " بالاتر از فروشت\n" +
    "(آستانه: +" + pctStr(lossPct, 2) + ")\n\n" +
    priceLine("قیمت فروشت", ref) + "\n" +
    priceLine("قیمت الان", live) + "\n\n" +
    "دستور: الان تعقیب نکن — صبر تا نزدیک فروشت." +
    projectionBlock(opportunity) +
    footer(stanceText)
  );
}

export function msgRallyPrepare(from, live, movePct, stanceText, opportunity) {
  return (
    "📈 رشد فعال\n\n" +
    "از " + fmt(from, 4) + " → " + fmt(live, 4) +
    " (حدود +" + pctStr(Math.abs(movePct)) + ")\n\n" +
    "اگر GRAM داری: فعلاً نگه دار؛ با برگشت نزولی → بفروووش.\n" +
    "اگر تتر داری: تعقیب نکن." +
    projectionBlock(opportunity) +
    footer(stanceText)
  );
}

export function msgReversalSell(from, live, drop, movePct, stanceText, opportunity) {
  return (
    "🚨 برگشت نزولی — بفروووش\n\n" +
    "از " + fmt(from, 4) + " برگشته به " + fmt(live, 4) + "\n" +
    "(حدود −" + pctStr(Math.abs(movePct || 0)) + " از اوج اخیر)\n\n" +
    "دستور: فروش را همین حالا اجرا کن تا سود از دست نرود." +
    projectionBlock(opportunity) +
    footer(stanceText)
  );
}

export function msgDumpWatch(from, live, movePct, stanceText, opportunity) {
  return (
    "📉 ریزش فعال\n\n" +
    "از " + fmt(from, 4) + " → " + fmt(live, 4) +
    " (حدود −" + pctStr(Math.abs(movePct)) + ")\n\n" +
    "اگر تتر داری: وسط سقوط عجله نکن؛ با برگشت صعودی → بخرررر.\n" +
    "اگر GRAM داری: سایز و حدضرر را چک کن." +
    projectionBlock(opportunity) +
    footer(stanceText)
  );
}

export function msgReversalBuy(from, live, movePct, stanceText, opportunity) {
  return (
    "🚨 برگشت صعودی — بخرررر\n\n" +
    "از " + fmt(from, 4) + " برگشته به " + fmt(live, 4) + "\n" +
    "(حدود +" + pctStr(Math.abs(movePct || 0)) + " از کف اخیر)\n\n" +
    "دستور: خرید را همین حالا اجرا کن تا جا نمانی." +
    projectionBlock(opportunity) +
    footer(stanceText)
  );
}

export function msgTrendUp(from, live, delta, stanceText) {
  const movePct = from > 0 ? (Math.abs(delta) / from) * 100 : 0;
  return msgRallyPrepare(from, live, movePct, stanceText);
}
export function msgTrendDown(from, live, drop, stanceText) {
  const movePct = from > 0 ? (Math.abs(drop) / from) * 100 : 0;
  return msgReversalSell(from, live, drop, movePct, stanceText);
}
export function msgDrop(from, live, drop, stanceText) {
  const movePct = from > 0 ? (Math.abs(drop) / from) * 100 : 0;
  return msgDumpWatch(from, live, movePct, stanceText);
}
export function msgBounce(delta, live, stanceText) {
  const from = live - Math.abs(delta);
  const movePct = from > 0 ? (Math.abs(delta) / from) * 100 : 0;
  return msgReversalBuy(from, live, movePct, stanceText);
}

export function msgConnected() {
  return (
    "✅ اتصال تلگرام برقرار شد\n\n" +
    "ربات تحلیل‌گر معامله GRAM فعال است.\n" +
    "منطق:\n" +
    "• بخرررر / بفروووش صریح بر اساس نمودار چندبازه‌ای\n" +
    "• تخمین رشد و ریزش بعدی (۲۴س · ۳روز · هفته · ماه · سال)\n" +
    "• حدضرر + سقف/کف شخصی\n" +
    "• وابسته به پوزیشن تو (GRAM یا تتر)"
  );
}

/** Stop-loss vs average entry */
export function msgStopLoss(pct, avg, live, stanceText, opportunity) {
  return (
    "🛑 حد ضرر — بفروووش\n\n" +
    "ضرر تحقق‌نیافته حدود " + formatPctSigned(pct) + "\n" +
    priceLine("میانگین خرید", avg) + "\n" +
    priceLine("قیمت الان", live) + "\n\n" +
    "دستور: فروش را جدی اجرا کن (مدیریت ریسک)." +
    projectionBlock(opportunity) +
    footer(stanceText)
  );
}

/** Near period high (24h … 1y) */
export function msgRangeNearHigh(ex, stanceText, opportunity) {
  const posPct = ex.posInRange != null ? (ex.posInRange * 100).toFixed(0) : "—";
  return (
    "📍 نزدیک سقف " + (ex.label || ex.periodId) + " — بفروووش\n\n" +
    "موقعیت در دامنه: حدود " + posPct + "٪\n" +
    priceLine("سقف بازه", ex.high) + "\n" +
    priceLine("کف بازه", ex.low) + "\n" +
    priceLine("قیمت الان", ex.live) + "\n\n" +
    (ex.fromHighPct != null ? "فاصله از سقف: " + formatPctSigned(ex.fromHighPct) + "\n\n" : "") +
    "دستور: اگر GRAM داری فروش را اجرا کن." +
    projectionBlock(opportunity || (ex && ex.opportunity)) +
    footer(stanceText)
  );
}

/** Near period low */
export function msgRangeNearLow(ex, stanceText, opportunity) {
  const posPct = ex.posInRange != null ? (ex.posInRange * 100).toFixed(0) : "—";
  return (
    "📍 نزدیک کف " + (ex.label || ex.periodId) + " — بخرررر\n\n" +
    "موقعیت در دامنه: حدود " + posPct + "٪ (نزدیک کف)\n" +
    priceLine("سقف بازه", ex.high) + "\n" +
    priceLine("کف بازه", ex.low) + "\n" +
    priceLine("قیمت الان", ex.live) + "\n\n" +
    (ex.fromLowPct != null ? "فاصله از کف: " + formatPctSigned(ex.fromLowPct) + "\n\n" : "") +
    "دستور: اگر تتر داری خرید را اجرا کن." +
    projectionBlock(opportunity || (ex && ex.opportunity)) +
    footer(stanceText)
  );
}

/** Violent drop relative to period range */
export function msgRangeViolentDrop(ex, stanceText, opportunity) {
  const vs = ex.moveVsRange != null ? (ex.moveVsRange * 100).toFixed(0) : "—";
  return (
    "⚡ ریزش تند — " + (ex.label || ex.periodId) + "\n\n" +
    "حرکت اخیر حدود " + vs + "٪ از کل دامنهٔ این بازه.\n" +
    priceLine("سقف بازه", ex.high) + "\n" +
    priceLine("کف بازه", ex.low) + "\n" +
    priceLine("قیمت الان", ex.live) + "\n\n" +
    "اگر تتر داری: عجله نکن؛ منتظر تثبیت یا برگشت باش → بعد بخرررر.\n" +
    "اگر GRAM داری: سایز و حدضرر را چک کن." +
    projectionBlock(opportunity || (ex && ex.opportunity)) +
    footer(stanceText)
  );
}

/** Violent rally relative to period range */
export function msgRangeViolentRally(ex, stanceText, opportunity) {
  const vs = ex.moveVsRange != null ? (ex.moveVsRange * 100).toFixed(0) : "—";
  return (
    "⚡ رشد تند — " + (ex.label || ex.periodId) + "\n\n" +
    "حرکت اخیر حدود " + vs + "٪ از کل دامنهٔ این بازه.\n" +
    priceLine("سقف بازه", ex.high) + "\n" +
    priceLine("کف بازه", ex.low) + "\n" +
    priceLine("قیمت الان", ex.live) + "\n\n" +
    "اگر GRAM داری: سود جزئی بگیر → بفروووش (بخشی).\n" +
    "اگر تتر داری: تعقیب نکن." +
    projectionBlock(opportunity || (ex && ex.opportunity)) +
    footer(stanceText)
  );
}

/**
 * Map evaluateAlerts() item → Persian text.
 * @param {object} alert from evaluateAlerts
 * @param {string} stanceText
 */
export function renderAlertMessage(alert, stanceText) {
  if (!alert) return "";
  const p = alert.payload || {};
  const opp = p.opportunity || null;
  switch (alert.type) {
    case "trade_buy":
      return msgTradeBuy(p, stanceText);
    case "trade_sell":
      return msgTradeSell(p, stanceText);
    case "stop_loss":
      return msgStopLoss(p.pct, p.avg, p.live, stanceText, opp);
    case "reversal_sell":
      return msgReversalSell(p.from, p.live, p.delta, p.movePct, stanceText, opp);
    case "reversal_buy":
      return msgReversalBuy(p.from, p.live, p.movePct, stanceText, opp);
    case "ceiling":
      return msgCeiling(p.level, p.live, stanceText, opp);
    case "floor":
      return msgFloor(p.level, p.live, stanceText, opp);
    case "profit_buy":
      return msgProfitBuy(p.vsSwap, p.target, p.ref, p.live, stanceText, opp);
    case "loss_buy":
      return msgLossBuy(p.vsSwap, p.loss, p.ref, p.live, stanceText, opp);
    case "profit_sell":
      return msgProfitSell(p.vsSwap, p.target, p.ref, p.live, stanceText, opp);
    case "loss_sell":
      return msgLossSell(p.vsSwap, p.loss, p.ref, p.live, stanceText, opp);
    case "rally_prepare":
      return msgRallyPrepare(p.from, p.live, p.movePct, stanceText, opp);
    case "dump_watch":
      return msgDumpWatch(p.from, p.live, p.movePct, stanceText, opp);
    case "range_near_high":
      return msgRangeNearHigh(p, stanceText, opp);
    case "range_near_low":
      return msgRangeNearLow(p, stanceText, opp);
    case "range_violent_drop":
      return msgRangeViolentDrop(p, stanceText, opp);
    case "range_violent_rally":
      return msgRangeViolentRally(p, stanceText, opp);
    default:
      return "هشدار: " + (alert.type || alert.key || "?") + footer(stanceText);
  }
}

export function reconcileNote(s) {
  if (!s || !s.fromWallet) return "بعد از همگام‌سازی، موجودی از کیف‌پول خوانده می‌شود.";
  const d = Math.abs((s.bookGram || 0) - (s.totalGram || 0));
  if (d > 0.5) {
    return "✓ موجودی از کیف‌پول · دفتر سواپ‌ها " + fmt(s.bookGram, 4) + " GRAM (اختلاف " + fmt(d, 4) + " احتمالاً واریز/برداشت غیرسواپ یا تاریخچه ناقص)";
  }
  return "✓ موجودی از کیف‌پول · دفتر سواپ با زنجیره هم‌خوان است";
}

export function statusChartUrl(series, live) {
  const pts = Array.isArray(series) ? series.map((x) => Number(x.p)).filter((n) => Number.isFinite(n)) : [];
  if (live != null && Number.isFinite(live)) pts.push(Number(live));
  if (pts.length < 2) return null;
  const data = pts.slice(-40);
  const cfg = {
    type: "line",
    data: {
      labels: data.map(() => ""),
      datasets: [{
        data,
        borderColor: "#14b8a6",
        backgroundColor: "rgba(20,184,166,0.15)",
        fill: true,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.3,
      }],
    },
    options: {
      legend: { display: false },
      scales: {
        xAxes: [{ display: false }],
        yAxes: [{ display: true, ticks: { fontColor: "#94a3b8", fontSize: 10 } }],
      },
      title: {
        display: true,
        text: live != null ? ("GRAM · " + Number(live).toFixed(4)) : "GRAM",
        fontColor: "#e2e8f0",
        fontSize: 14,
      },
    },
  };
  return "https://quickchart.io/chart?w=600&h=320&bkg=%23070a0e&c=" + encodeURIComponent(JSON.stringify(cfg));
}
