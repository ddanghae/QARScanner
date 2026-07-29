// MFE/MAE 진단 — "시간 만료 693건은 최고 얼마까지 갔었나?"
//
// 2026-07-29 배포 규칙 백테스트 결말: 목표 124 / 손절 412 / 시간 693.
// 절반 이상이 아무것도 안 되고 만료된다. 그 구간에서 가격이 어디까지 갔었는지를 재면
// 다음 수정이 갈린다.
//   되돌아온 것이면  → 부분 익절 / 트레일링
//   안 움직인 것이면 → 조기 탈출(자본 회전)
//
// 신호와 손절 폭은 배포 규칙 그대로(plan). 청산 방식만 4가지로 갈라 같은 거래에 적용한다.
// 봉 안에서 손절과 목표가 같이 닿으면 손절을 먼저 본다(봉 내부 순서를 알 수 없다).
//
// 사용: node mfe.mjs [all|SYM,SYM,...]
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = globalThis;

const B = "../js/";
const { CONFIG } = await import(B + "config.js");
const { buildEarlyResult } = await import(B + "core/early-detect.js");

const FEE = 0.0005, SLIP = 0.0005, COST = (FEE + SLIP) * 2;
const EVAL_EVERY = 6;
const HOLD = CONFIG.earlyDetect.holdBars;      // 90봉
const TARGET_R = CONFIG.earlyDetect.targetR;   // 4R
const EARLY_EXIT_BARS = 30;                    // 조기 탈출 판정 시점 (5일)
const NOW = Date.now();

// 한 거래를 네 가지 청산 규칙으로 동시에 돌린다. 반환값은 규칙별 R 배수 + 결말.
// r 은 리스크(가격 단위). 모든 R 은 비용 차감 후.
function runExits(c, i, fill, risk) {
  const R = (px) => ((px - fill) / fill - COST) / (risk / fill);
  const end = Math.min(c.length, i + 1 + HOLD);
  const stop0 = fill - risk, target = fill + risk * TARGET_R;

  let mfe = 0, mae = 0;                       // R 단위 최대 유리/불리 폭
  const out = {};                             // 규칙별 { r, why, bars }
  let peakR = 0;
  // 부분 익절 상태
  let halfTaken = false, bStop = stop0;
  // 조기 탈출 상태
  let dDone = false;

  for (let k = i + 1; k < end; k++) {
    const bar = c[k];
    const hiR = (bar.high - fill) / risk, loR = (bar.low - fill) / risk;
    if (hiR > mfe) mfe = hiR;
    if (loR < mae) mae = loR;
    peakR = Math.max(peakR, hiR);

    // (a) 현행 — 고정 손절 -1R / 목표 4R
    if (!out.a) {
      if (bar.low <= stop0) out.a = { r: R(stop0), why: "stop", bars: k - i };
      else if (bar.high >= target) out.a = { r: R(target), why: "target", bars: k - i };
    }
    // (b) 부분 익절 — +1R 에서 절반 청산 후 손절을 본전으로. 나머지는 4R 목표.
    if (!out.b) {
      if (bar.low <= bStop) {
        const half = halfTaken ? 0.5 * 1 : 0;
        out.b = { r: half + (halfTaken ? 0.5 : 1) * R(bStop), why: halfTaken ? "본전" : "stop", bars: k - i };
      } else if (!halfTaken && bar.high >= fill + risk) {
        halfTaken = true; bStop = fill;       // 본전 이동
        if (bar.high >= target) out.b = { r: 0.5 * 1 + 0.5 * R(target), why: "target", bars: k - i };
      } else if (halfTaken && bar.high >= target) {
        out.b = { r: 0.5 * 1 + 0.5 * R(target), why: "target", bars: k - i };
      }
    }
    // (c) 트레일링 — +2R 넘긴 뒤 최고점에서 1R 되돌리면 청산. 그 전에는 고정 손절.
    if (!out.c) {
      const armed = peakR >= 2;
      const trail = armed ? fill + (peakR - 1) * risk : stop0;
      if (bar.low <= trail) out.c = { r: R(trail), why: armed ? "트레일" : "stop", bars: k - i };
    }
    // (d) 조기 탈출 — EARLY_EXIT_BARS 안에 +1R 못 가면 그 봉 종가로 나간다. 이후는 현행과 동일.
    if (!out.d) {
      if (bar.low <= stop0) out.d = { r: R(stop0), why: "stop", bars: k - i };
      else if (bar.high >= target) out.d = { r: R(target), why: "target", bars: k - i };
      else if (!dDone && k - i >= EARLY_EXIT_BARS && mfe < 1) {
        out.d = { r: R(bar.close), why: "조기탈출", bars: k - i };
      }
      if (k - i >= EARLY_EXIT_BARS) dDone = true;
    }
    if (out.a && out.b && out.c && out.d) break;
  }

  const lastIdx = Math.min(c.length - 1, i + HOLD);
  const lastPx = c[lastIdx].close;
  for (const key of ["a", "b", "c", "d"]) {
    if (out[key]) continue;
    const base = R(lastPx);
    // (b) 는 절반을 실제로 뺐을 때만 +0.5R 을 인정한다. halfTaken 을 안 보고 무조건 더하면
    // 시간 만료 거래 전부에 공짜 이익이 붙어 (b) 가 실제보다 훨씬 좋아 보인다(측정 오류였음).
    const r = key === "b" && halfTaken ? 0.5 * 1 + 0.5 * base : base;
    out[key] = { r, why: "time", bars: lastIdx - i };
  }
  return { mfe, mae, ...out };
}

async function j(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1500 * (i + 1))); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await new Promise((s) => setTimeout(s, 800 * (i + 1))); }
  }
  return null;
}

const mode = process.argv[2] || "all";
const info = await j("https://fapi.binance.com/fapi/v1/exchangeInfo");
const meta = new Map(info.symbols.map((s) => [s.symbol, s]));
const symbols = mode === "all"
  ? info.symbols.filter((s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING").map((s) => s.symbol)
  : mode.split(",");
console.log(`MFE 진단 symbols=${symbols.length}  손절 ATR×${CONFIG.earlyDetect.stopAtr} · 목표 ${TARGET_R}R · 보유 ${HOLD}봉\n`);

const trades = [];
let done = 0;
for (const sym of symbols) {
  if (++done % 50 === 0) console.error(`  ${done}/${symbols.length}`);
  const raw = await j(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=4h&limit=1000`);
  if (!raw || raw.length < 300) continue;
  const c = raw.map((k) => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], quoteVolume: +k[7] }));
  const onboard = +(meta.get(sym)?.onboardDate || 0);
  let cooldown = -1;

  for (let i = 240; i < c.length - 2; i += EVAL_EVERY) {
    if (i <= cooldown) continue;
    const bar = c[i], prev = c[Math.max(0, i - 6)];
    const item = {
      symbol: sym, baseAsset: sym.replace(/USDT$/, ""),
      quoteVolume: c.slice(Math.max(0, i - 5), i + 1).reduce((s, x) => s + x.quoteVolume, 0),
      change24h: ((bar.close - prev.close) / prev.close) * 100,
      newListing: false,
      onboardDate: onboard ? onboard + (NOW - bar.time) : 0,
    };
    const r = buildEarlyResult(item, c.slice(0, i + 1), [], null, CONFIG);
    if (!r || r.score < CONFIG.earlyMinScore) continue;
    const fill = c[i + 1].open;
    const risk = fill - (r.plan.stop / r.plan.entry) * fill;
    if (!(risk > 0)) continue;
    const t = runExits(c, i, fill, risk);
    trades.push({ sym, score: r.score, ...t });
    cooldown = i + t.a.bars;                 // 현행 규칙 기준 쿨다운 — 표본을 맞춘다
  }
}

// ---- 리포트 ----
const q = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
function mfeBlock(label, list) {
  if (!list.length) { console.log(`${label}: 없음`); return; }
  const m = list.map((t) => t.mfe);
  const over = (x) => (m.filter((v) => v >= x).length / m.length * 100).toFixed(0);
  console.log(`${label.padEnd(14)} n=${String(list.length).padStart(4)}  MFE 중앙 ${q(m, .5).toFixed(2)}R  ` +
    `p75 ${q(m, .75).toFixed(2)}R  p90 ${q(m, .9).toFixed(2)}R  |  ` +
    `1R+ ${over(1)}%  2R+ ${over(2)}%  3R+ ${over(3)}%  4R+ ${over(4)}%`);
}

console.log(`거래 ${trades.length}건\n`);
console.log("── 최대 유리 폭(MFE) 분포 — 청산 안 했으면 어디까지 갔었나");
mfeBlock("전체", trades);
for (const w of ["target", "stop", "time"]) {
  mfeBlock(`현행 ${w}`, trades.filter((t) => t.a.why === w));
}

function stats(label, key) {
  const list = trades.map((t) => t[key]);
  const n = list.length;
  const wins = list.filter((t) => t.r > 0);
  const total = list.reduce((s, t) => s + t.r, 0);
  const gp = wins.reduce((s, t) => s + t.r, 0);
  const gl = -list.filter((t) => t.r <= 0).reduce((s, t) => s + t.r, 0);
  let peak = 0, dd = 0, cum = 0;
  for (const t of list) { cum += t.r; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  const avgBars = list.reduce((s, t) => s + t.bars, 0) / n;
  console.log(`${label.padEnd(22)} 평균 ${total / n >= 0 ? " " : ""}${(total / n).toFixed(3)}R  ` +
    `승률 ${(wins.length / n * 100).toFixed(0).padStart(3)}%  PF ${(gl > 0 ? gp / gl : Infinity).toFixed(2)}  ` +
    `MDD ${dd.toFixed(1).padStart(7)}R  평균보유 ${avgBars.toFixed(0)}봉`);
}

console.log("\n── 청산 규칙 비교 (같은 거래, 같은 손절 폭)");
stats("(a) 현행 4R 고정", "a");
stats("(b) 1R 절반+본전이동", "b");
stats("(c) 2R 후 1R 트레일", "c");
stats(`(d) ${EARLY_EXIT_BARS}봉 무반응 탈출`, "d");

console.log("\n── 최대 불리 폭(MAE) — 손절을 좁혀도 되는가");
// MAE 는 음수라 백분위를 그대로 쓰면 방향이 뒤집힌다. 깊이(절대값)로 바꿔서 잰다.
const depth = trades.filter((t) => t.a.r > 0).map((t) => Math.abs(t.mae));
console.log(`  이긴 거래가 역행한 깊이 — 중앙 ${q(depth, .5).toFixed(2)}R · p90 ${q(depth, .9).toFixed(2)}R`);
console.log(`  손절을 ${q(depth, .9).toFixed(2)}R 보다 좁게 잡으면 지금 이기는 거래의 10% 이상을 손절로 잃는다.`);
