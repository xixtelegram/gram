/**
 * GRAM — ماژول متن پیام‌های تلگرام
 * فقط کپی و ساختار پیام؛ منطق قیمت/پوزیشن در gram-core و app/ton-alert است.
 *
 * بخش‌ها:
 *   1) utils     — درصد، قالب عدد
 *   2) situation — وضعیت پوزیشن (عنوان + درصد + مبنا)
 *   3) advice    — پیشنهاد کار مشخص برای کاربر
 *   4) targets   — لیست قیمت‌های هدف
 *   5) status    — گزارش کامل دوره‌ای
 *   6) alerts    — هشدارهای سقف/کف/سود/ضرر/روند
 *   7) chart     — لینک چارت وضعیت
 */

import { ROUND, fmt, estSlippagePct } from "./gram-core.mjs";

// ─────────────────────────────────────────────
// 1) utils
// ─────────────────────────────────────────────

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

/** پاورقی کوتاه زیر هشدار — بدون تکرار عنوان طولانی */
function footer(stanceText) {
  if (!stanceText || !String(stanceText).trim()) return "";
  return "\n\n────────\n" + String(stanceText).trim();
}

// ─────────────────────────────────────────────
// 2) situation — کاربر الان کجاست؟
// ─────────────────────────────────────────────

/**
 * @returns {{ emoji: string, title: string, pct: number|null, kind: string, basis: string|null }}
 */
export function pnlHeadline(s, price, lastTrade) {
  if (!price) {
    return { emoji: "⚪", title: "قیمت هنوز مشخص نیست", pct: null, kind: "unknown", basis: null };
  }

  // GRAM داری → نسبت به میانگین خرید
  if (s.totalGram > 1e-6 && s.avgBuyPrice > 0) {
    const pct = ((price - s.avgBuyPrice) / s.avgBuyPrice) * 100;
    const basis = "قیمت میانگین خرید تو: " + fmt(s.avgBuyPrice, 4);
    if (pct >= 0.15) return { emoji: "🟢", title: "الان روی سود هستی (هنوز نفروختی)", pct, kind: "profit", basis };
    if (pct <= -0.15) return { emoji: "🔴", title: "قیمت از خریدت پایین‌تر آمده", pct, kind: "loss", basis };
    return { emoji: "⚪", title: "نزدیک نقطه سر‌به‌سر", pct, kind: "flat", basis };
  }

  const lt = lastTrade;

  // آخرین معامله فروش بوده → USDT داری
  if (lt && lt.type === "sell" && lt.price > 0) {
    const pct = ((price - lt.price) / lt.price) * 100;
    const basis = "قیمت آخرین فروشت: " + fmt(lt.price, 4);
    if (pct <= -0.15) return { emoji: "🟢", title: "ارزان‌تر از فروشت شده — فرصت خرید", pct, kind: "opportunity", basis };
    if (pct >= 0.15) return { emoji: "🟡", title: "بعد از فروشت قیمت رفته بالا", pct, kind: "missed", basis };
    return { emoji: "⚪", title: "نزدیک قیمت آخرین فروشت", pct, kind: "flat", basis };
  }

  // آخرین معامله خرید بوده ولی موجودی GRAM نداریم (یا خیلی کم)
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

// ─────────────────────────────────────────────
// 3) advice — الان چه کار کنی؟
// ─────────────────────────────────────────────

export function actionAdvice(s, price, hl, checks) {
  if (!price) return "صبر کن تا قیمت درست لود شود.";

  if (hl.kind === "profit" && s.totalGram > 1e-6) {
    if (checks.sellIsWorthwhile(s, price)) {
      return "پیشنهاد: فروش را بررسی کن. (با فروش واقعی ممکن است کمی کمتر از این عدد بگیری.)";
    }
    return "پیشنهاد: فعلاً نگه دار؛ برای فروش بهتر صبر کن تا به هدف‌های پایین برسد.";
  }

  if (hl.kind === "loss" && s.totalGram > 1e-6) {
    return "پیشنهاد: عجله نکن. تا نفروشی ضرر فقط روی کاغذ است.";
  }

  if (hl.kind === "opportunity") {
    if (checks.buyIsWorthwhile(s, price)) {
      return "پیشنهاد: نسبت به فروشت ارزان‌تر شده — خرید را بررسی کن.";
    }
    return "پیشنهاد: کمی ارزان شده؛ هنوز برای خرید عجله نکن.";
  }

  if (hl.kind === "missed") {
    return "پیشنهاد: الان نخر. صبر کن قیمت دوباره نزدیک فروشت شود.";
  }

  if (hl.kind === "unknown") {
    return "پیشنهاد: اول تاریخچه سواپ یا کیف‌پول را وصل کن.";
  }

  return "پیشنهاد: شرایط عادی است — معامله عجولانه لازم نیست.";
}

// ─────────────────────────────────────────────
// 4) targets — قیمت هدف ساده
// ─────────────────────────────────────────────

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
      // قیمت mid تقریبی برای رسیدن به حدود L٪ سود بعد از هزینه معامله
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

// ─────────────────────────────────────────────
// خلاصه وضعیت (برای پاورقی هشدارها و UI)
// ─────────────────────────────────────────────

export function stanceLine(s, price, lastTrade, checks) {
  const hl = pnlHeadline(s, price, lastTrade);
  let line = hl.emoji + " " + hl.title;
  if (hl.pct != null) line += "  " + formatPctSigned(hl.pct);
  if (hl.basis) line += "\n" + hl.basis;
  line += "\n" + actionAdvice(s, price, hl, checks);
  return line;
}

// ─────────────────────────────────────────────
// 5) status — گزارش کامل
// ─────────────────────────────────────────────

export function buildStatusMessage(s, live, quote, lastTrade, checks, poolReserve) {
  const price = live;
  const hl = pnlHeadline(s, price, lastTrade);

  let msg = "📊 گزارش وضعیت GRAM\n\n";

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

  if (hl.kind === "profit" || hl.kind === "loss" || hl.kind === "opportunity" || hl.kind === "missed" || hl.kind === "flat") {
    msg += targetsBlock(s, lastTrade, poolReserve);
  }

  return msg;
}

// ─────────────────────────────────────────────
// 6) alerts — هر پیام: چه شد؟ عددها؟ چه کار کنی؟
// ─────────────────────────────────────────────

/** قیمت به سقف تعیین‌شده رسید */
export function msgCeiling(above, live, stanceText) {
  return (
    "🔺 قیمت به سقف رسید\n\n" +
    "سقفی که گذاشته بودی: " + fmt(above, 4) + "\n" +
    "قیمت الان: " + fmt(live, 4) + "\n\n" +
    "یعنی قیمت از حد بالای تنظیم‌شده بالاتر رفته.\n" +
    "اگر GRAM داری، فروش را بررسی کن؛ اگر نداری فقط اطلاع است." +
    footer(stanceText)
  );
}

/** قیمت به کف تعیین‌شده رسید */
export function msgFloor(below, live, stanceText) {
  return (
    "🔻 قیمت به کف رسید\n\n" +
    "کفی که گذاشته بودی: " + fmt(below, 4) + "\n" +
    "قیمت الان: " + fmt(live, 4) + "\n\n" +
    "یعنی قیمت از حد پایین تنظیم‌شده پایین‌تر آمده.\n" +
    "اگر می‌خواستی ارزان‌تر بخری، الان نزدیک همان محدوده است." +
    footer(stanceText)
  );
}

/** GRAM خریدی و قیمت بالا رفته تا هدف سود */
export function msgProfitBuy(movePct, targetPct, ref, live, stanceText) {
  return (
    "🟢 به هدف سود رسیدی\n\n" +
    "از وقتی خریدی حدود +" + pctStr(movePct) + " بالاتر آمده\n" +
    "(هدف تو: +" + pctStr(targetPct, 2) + ")\n\n" +
    priceLine("قیمت خریدت", ref) + "\n" +
    priceLine("قیمت الان", live) + "\n\n" +
    "پیشنهاد: اگر می‌خواهی سود را قطعی کنی، فروش را بررسی کن.\n" +
    "تا نفروشی این سود فقط روی کاغذ است." +
    footer(stanceText)
  );
}

/** GRAM خریدی و قیمت پایین آمده تا آستانه ضرر */
export function msgLossBuy(movePct, lossPct, ref, live, stanceText) {
  return (
    "🔴 قیمت از خریدت پایین‌تر آمده\n\n" +
    "حدود " + pctStr(movePct) + " نسبت به خریدت\n" +
    "(آستانه‌ای که گذاشته بودی: −" + pctStr(lossPct, 2) + ")\n\n" +
    priceLine("قیمت خریدت", ref) + "\n" +
    priceLine("قیمت الان", live) + "\n\n" +
    "مهم: تا نفروشی ضرر قطعی نیست.\n" +
    "پیشنهاد: عجله نکن؛ مگر خودت تصمیم به خروج گرفته باشی." +
    footer(stanceText)
  );
}

/** قبلاً فروختی و قیمت پایین آمده — فرصت خرید مجدد */
export function msgProfitSell(movePct, targetPct, ref, live, stanceText) {
  return (
    "🟢 فرصت خرید دوباره\n\n" +
    "از فروشت حدود " + pctStr(movePct) + " ارزان‌تر شده\n" +
    "(هدف تو: −" + pctStr(targetPct, 2) + ")\n\n" +
    priceLine("قیمت فروشت", ref) + "\n" +
    priceLine("قیمت الان", live) + "\n\n" +
    "پیشنهاد: اگر هنوز USDT داری، خرید را بررسی کن." +
    footer(stanceText)
  );
}

/** قبلاً فروختی و قیمت رفته بالا — از دست دادن فرصت */
export function msgLossSell(movePct, lossPct, ref, live, stanceText) {
  return (
    "🟡 بعد از فروشت قیمت بالا رفته\n\n" +
    "حدود +" + pctStr(movePct) + " بالاتر از فروشت\n" +
    "(آستانه اطلاع: +" + pctStr(lossPct, 2) + ")\n\n" +
    priceLine("قیمت فروشت", ref) + "\n" +
    priceLine("قیمت الان", live) + "\n\n" +
    "پیشنهاد: الان دنبال خرید عجولانه نرو.\n" +
    "صبر کن قیمت دوباره نزدیک فروشت شود." +
    footer(stanceText)
  );
}

/** روند صعودی کوتاه‌مدت — معمولاً وقتی GRAM داری */
export function msgTrendUp(from, live, delta, stanceText) {
  return (
    "📈 قیمت در حال بالا رفتن است\n\n" +
    "از " + fmt(from, 4) + " رسیده به " + fmt(live, 4) + "\n" +
    "(حدود +" + fmt(Math.abs(delta), 4) + ")\n\n" +
    "اگر GRAM داری و به هدف سود نزدیک شده‌ای، فروش را بررسی کن." +
    footer(stanceText)
  );
}

/** روند نزولی — وقتی GRAM داری */
export function msgTrendDown(from, live, drop, stanceText) {
  return (
    "📉 قیمت در حال پایین آمدن است\n\n" +
    "از " + fmt(from, 4) + " رسیده به " + fmt(live, 4) + "\n" +
    "(حدود −" + fmt(drop, 4) + ")\n\n" +
    "اگر GRAM داری: عجله برای فروش از ترس لازم نیست مگر خودت برنامه خروج داری." +
    footer(stanceText)
  );
}

/** افت قیمت — وقتی USDT داری و ممکن است فرصت خرید باشد */
export function msgDrop(from, live, drop, stanceText) {
  return (
    "📉 قیمت آمده پایین — ممکن است فرصت خرید باشد\n\n" +
    "از " + fmt(from, 4) + " رسیده به " + fmt(live, 4) + "\n" +
    "(حدود −" + fmt(drop, 4) + ")\n\n" +
    "اگر USDT داری و دنبال ورود هستی، خرید را بررسی کن.\n" +
    "اگر هنوز مطمئن نیستی، صبر کن افت بیشتر یا تثبیت ببینی." +
    footer(stanceText)
  );
}

/** برگشت رو به بالا بعد از افت — برای کسی که می‌خواهد بخرد */
export function msgBounce(delta, live, stanceText) {
  return (
    "📈 قیمت برگشت رو به بالا\n\n" +
    "حرکت اخیر حدود +" + fmt(Math.abs(delta), 4) + "\n" +
    priceLine("قیمت الان", live) + "\n\n" +
    "اگر منتظر خرید بودی: فقط در صورتی وارد شو که هنوز نسبت به برنامه خودت قیمت مناسب است.\n" +
    "اگر قیمت از هدف خریدت بالاتر رفته، تعقیب نکن." +
    footer(stanceText)
  );
}

export function msgConnected() {
  return (
    "✅ اتصال تلگرام برقرار شد\n\n" +
    "از این به بعد هشدارها و گزارش‌های GRAM همین‌جا می‌آید.\n" +
    "اگر پیام نیامد، تنظیمات سقف/کف و درصدها را در برنامه چک کن."
  );
}

// ─────────────────────────────────────────────
// 7) chart
// ─────────────────────────────────────────────

/**
 * QuickChart URL برای اسپارک‌لاین (بدون API key)
 * @param {Array<{t?:number,p:number}>} series
 * @param {number|null} live
 */
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
