// tests/indicators.test.js — 지표 계산 검증 (고정 데이터).

import { suite, test, assert, approx, close, eq } from "./harness.js";
import { sma, ema, rsi, mfi, atr, bollinger, dailyVwap, macd, obv, last } from "../js/core/indicators.js";
import { cvdDivergence, volumeSpikes, spikeVerdict } from "../js/core/volume-analysis.js";
import { candlesFromCloses, mkCandle } from "./fixtures.js";

// MFI 는 거래량을 곱하므로 종가만으로는 못 만든다 — h/l/c/v 를 직접 준다.
const mfiBar = (c, v) => ({ open: c, high: c, low: c, close: c, volume: v });

export function run() {
  suite("indicators");

  test("MFI — 계속 오르면 100, 계속 내리면 0", () => {
    const up = Array.from({ length: 20 }, (_, i) => mfiBar(100 + i, 10));
    approx(last(mfi(up, 14)), 100, 1e-9, "매도 쪽 유입이 0 이면 100");
    const down = Array.from({ length: 20 }, (_, i) => mfiBar(100 - i, 10));
    approx(last(mfi(down, 14)), 0, 1e-9, "매수 쪽 유입이 0 이면 0");
    eq(mfi(up, 14)[13], null, "period 이전은 null");
  });

  // RSI 와 갈리는 지점이 이 지표의 존재 이유다 — 같은 가격 경로라도 물량이 실린 방향이 이긴다.
  test("MFI — 거래량이 방향을 가른다 (RSI 로는 구분 안 됨)", () => {
    // 가격은 지그재그로 같지만 오르는 봉에만 큰 거래량
    const bars = [mfiBar(100, 10)];
    for (let i = 0; i < 20; i++) bars.push(i % 2 === 0 ? mfiBar(101, 100) : mfiBar(100, 10));
    const m = last(mfi(bars, 14));
    assert(m > 80, `물량이 매수 쪽에 실리면 과매수권 (${m?.toFixed(1)})`);
    // 같은 가격 경로, 거래량만 반대로
    const flip = [mfiBar(100, 10)];
    for (let i = 0; i < 20; i++) flip.push(i % 2 === 0 ? mfiBar(101, 10) : mfiBar(100, 100));
    const m2 = last(mfi(flip, 14));
    assert(m2 < 20, `물량이 매도 쪽이면 과매도권 (${m2?.toFixed(1)})`);
  });

  // 0/100 만 보면 창에서 빼는 산수가 틀려도 통과한다 — 중간값을 손으로 계산해 박는다.
  // period=3, 대표가 [10,12,11,13,12], 거래량 [100,200,150,300,250]
  //   유입 = 대표가×거래량       [1000, 2400, 1650, 3900, 3000]
  //   부호 = 대표가 전봉 대비    [ -  , +2400, -1650, +3900, -3000]
  //   i=3 창=부호[1..3] → 매수 6300 / 매도 1650 → 100×6300/7950 = 79.2453
  //   i=4 창=부호[2..4] → 매수 3900 / 매도 4650 → 100×3900/8550 = 45.6140
  //       (부호[1]=+2400 이 창에서 빠지며 매수에서 정확히 차감돼야 한다)
  test("MFI — 창에서 빼는 산수 (손계산 대조)", () => {
    const px = [10, 12, 11, 13, 12], vol = [100, 200, 150, 300, 250];
    const m = mfi(px.map((p, i) => mfiBar(p, vol[i])), 3);
    eq(m[2], null, "period 이전은 null");
    approx(m[3], 100 * 6300 / 7950, 1e-9, "첫 출력");
    approx(m[4], 100 * 3900 / 8550, 1e-9, "부호[1] 이 창에서 정확히 빠져야 한다");
  });

  test("MFI — 완전 보합은 null (50 으로 때우면 거짓 신호)", () => {
    const flat = Array.from({ length: 20 }, () => mfiBar(100, 10));
    eq(last(mfi(flat, 14)), null, "대표가격이 안 변하면 압력을 정의할 수 없다");
  });

  suite("cvd");

  // low 와 CVD 델타를 직접 지정한다. high 는 low+1 로 붙여 고점 피봇이 저점과 같은 자리에 생기게.
  const vbar = (low, delta) => ({
    open: low + 0.5, high: low + 1, low, close: low + 0.5,
    volume: 10, takerBuyBase: (10 + delta) / 2, takerSellBase: (10 - delta) / 2,
  });

  test("CVD 상승 다이버전스 — 가격은 저점 하락, CVD 는 저점 상승", () => {
    //          idx  0    1    2*   3    4    5    6    7    8*   9   10   11
    const lows = [100,  99,  95,  99, 100, 101, 102, 100,  93,  99, 100, 101];
    // 앞구간은 강한 매도, 뒤구간은 매수 우위 → CVD 저점이 올라간다
    const dels = [-10, -10, -10,  +5,  +5,  +5,  +5,  +5,  +5,   0,   0,   0];
    const cs = lows.map((l, i) => vbar(l, dels[i]));
    const d = cvdDivergence(cs, 2, 40);

    assert(d.bullish, "가격 95→93 (하락) · CVD -30→0 (상승) 이면 상승 다이버전스");
    eq(d.bearish, false, "고점 피봇이 하나뿐이면 하락 다이버전스는 성립 안 함");
    eq(d.lows.prevIdx, 2);
    eq(d.lows.lastIdx, 8);
    assert(d.lows.lastCvd > d.lows.prevCvd, "CVD 저점이 더 높다");
    assert(d.lows.lastPrice < d.lows.prevPrice, "가격 저점은 더 낮다");
  });

  test("CVD — 가격·CVD 가 같이 내려가면 다이버전스 아님", () => {
    const lows = [100,  99,  95,  99, 100, 101, 102, 100,  93,  99, 100, 101];
    const dels = [-10, -10, -10, -10, -10, -10, -10, -10, -10,   0,   0,   0];
    const d = cvdDivergence(lows.map((l, i) => vbar(l, dels[i])), 2, 40);
    eq(d.bullish, false, "매도 압력이 계속 강해지면 그냥 하락이다");
  });

  // 피봇 확정에 좌우 length 봉이 필요하므로 진행 중인 봉이 피봇이 되면 안 된다 — 리페인트 방지.
  test("CVD 다이버전스 — 최근 length 봉은 피봇이 될 수 없다", () => {
    const lows = [100,  99,  95,  99, 100, 101, 102, 100,  93,  99, 100, 101];
    const dels = [-10, -10, -10,  +5,  +5,  +5,  +5,  +5,  +5,   0,   0,   0];
    const cs = lows.map((l, i) => vbar(l, dels[i]));
    const d = cvdDivergence(cs, 2, 40);
    assert(d.lows.lastIdx <= cs.length - 1 - 2, `마지막 피봇이 끝에서 2봉 이상 떨어져야 함 (${d.lows.lastIdx})`);
  });

  // maxBars 로 오래된 피봇이 잘리면 slice(-2) 가 인접하지 않은 짝을 만들 수 있다.
  test("CVD 다이버전스 — maxBars 밖 피봇은 짝에서 빠진다", () => {
    //          idx  0    1    2*   3    4    5    6    7    8*   9   10   11   12   13   14*  15   16   17
    const lows = [100,  99,  90,  99, 100, 101, 102, 100,  95,  99, 100, 101, 102, 100,  93,  99, 100, 101];
    const dels = [-10, -10, -10,  +5,  +5,  +5,  +5,  +5,  +5,   0,   0,   0,   0,   0,   0,   0,   0,   0];
    const cs = lows.map((l, i) => vbar(l, dels[i]));

    // 창이 넓으면 최근 두 개(8, 14)가 짝 — 90 은 창 안에 있어도 slice(-2) 가 버린다.
    const wide = cvdDivergence(cs, 2, 40);
    eq(wide.lows.prevIdx, 8, "가장 오래된 90 이 아니라 직전 피봇 95 와 짝지어야 한다");
    eq(wide.lows.lastIdx, 14);

    // 창을 좁히면 8 이 잘리고 피봇 하나만 남는다 → 짝 없음
    const narrow = cvdDivergence(cs, 2, 6);
    eq(narrow.lows, null, "창 안 피봇이 하나뿐이면 null — 억지로 짝을 만들지 않는다");
    eq(narrow.bullish, false);
  });

  test("CVD 다이버전스 — 봉이 모자라면 조용히 false", () => {
    const d = cvdDivergence([vbar(100, 1), vbar(99, 1)], 3, 40);
    eq(d.bullish, false);
    eq(d.lows, null, "피봇 짝이 없으면 null — 없는 값을 0 으로 때우지 않는다");
    eq(cvdDivergence(null, 3, 40).bullish, false, "입력 없음도 안전");
  });

  suite("volume-spike");

  // 대량거래 봉. buyRatio 와 종가 위치를 따로 지정한다.
  const sbar = (vol, buyRatio, closePos, lowPx = 100, rangePx = 10) => ({
    openTime: 0,
    low: lowPx, high: lowPx + rangePx,
    open: lowPx + rangePx / 2, close: lowPx + rangePx * closePos,
    volume: vol,
    takerBuyBase: vol * buyRatio,
    takerSellBase: vol * (1 - buyRatio),
  });
  const normal = (n, vol = 10) => Array.from({ length: n }, () => sbar(vol, 0.5, 0.5));

  test("급증 판정 — 기준선에 자기 봉을 넣지 않는다", () => {
    // 평균 10 인 봉 20개 뒤에 100 짜리 한 방. 이전 봉만 보면 정확히 10배다.
    const cs = [...normal(20), sbar(100, 0.8, 0.9)];
    const sp = volumeSpikes(cs, { period: 20, minRel: 3 });
    eq(sp.length, 1, "급증 봉 1개");
    approx(sp[0].relVol, 10, 1e-9, "자기 봉을 평균에 넣으면 10배가 아니라 6.7배로 깎인다");
    eq(sp[0].barsAgo, 0, "마지막 봉");
  });

  test("급증 판정 — 임계 미달은 안 잡는다", () => {
    const cs = [...normal(20), sbar(25, 0.8, 0.9)];   // 2.5배
    eq(volumeSpikes(cs, { period: 20, minRel: 3 }).length, 0, "3배 미만");
    eq(volumeSpikes(cs, { period: 20, minRel: 2 }).length, 1, "임계 내리면 잡힌다");
  });

  // 이 4분면이 이 기능의 핵심이다 — 매수비율만 보면 흡수를 상승으로 오독한다.
  test("매수/매도 비율 해석 — 흡수 두 경우를 방향과 구분", () => {
    eq(spikeVerdict(0.75, 0.9), "매수 우위", "공격적 매수 + 고가 마감");
    eq(spikeVerdict(0.25, 0.1), "매도 우위", "공격적 매도 + 저가 마감");
    eq(spikeVerdict(0.75, 0.1), "매수 흡수", "매수가 들어왔는데 저가 마감 = 다 먹혔다");
    eq(spikeVerdict(0.25, 0.9), "매도 흡수", "매도가 나왔는데 고가 마감 = 다 받았다");
    eq(spikeVerdict(0.5, 0.5), "혼재", "물량만 크고 방향 없음");
  });

  // 임계가 실측 분포와 안 맞으면 컬럼이 상수가 된다 — 처음 0.6/0.4 로 잡았다가 전부 "혼재" 였다.
  test("매수/매도 비율 임계 — 실측 분포(p25 0.468 / p75 0.511)에서 갈린다", () => {
    eq(spikeVerdict(0.53, 0.9), "매수 우위", "0.53 은 p90 근처 = 매수 우위");
    eq(spikeVerdict(0.45, 0.1), "매도 우위", "0.45 는 p10 근처 = 매도 우위");
    eq(spikeVerdict(0.53, 0.1), "매수 흡수", "매수 우위인데 저가 마감");
    eq(spikeVerdict(0.45, 0.9), "매도 흡수", "매도 우위인데 고가 마감");
    eq(spikeVerdict(0.49, 0.9), "혼재", "중앙값 부근은 방향 없음 — 종가가 높아도 혼재");
  });

  test("급증 봉 이후 가격 유지율 — level 위 종가 비율", () => {
    // 급증 봉 range 100~110 → level 105. 이후 3봉 종가 전부 105 위.
    const cs = [...normal(20), sbar(100, 0.8, 0.9), sbar(10, 0.5, 0.5, 108), sbar(10, 0.5, 0.5, 108), sbar(10, 0.5, 0.5, 108)];
    const sp = volumeSpikes(cs, { period: 20, minRel: 3 });
    eq(sp.length, 1);
    approx(sp[0].level, 105, 1e-9);
    approx(sp[0].pctAbove, 1, 1e-9, "이후 종가가 전부 level 위 = 지지로 작동");
    eq(sp[0].barsAgo, 3);
  });

  // 길이 가드가 아니라 루프 안 minSamples continue 를 실제로 태운다.
  test("급증 판정 — 기준선 표본이 모자란 앞쪽 봉은 건너뛴다", () => {
    // 전체 14봉이라 길이 가드(minSamples+2=12)는 통과. 앞쪽 봉들은 이전 봉이 10개가 안 된다.
    const cs = [sbar(100, 0.8, 0.9), ...normal(13)];
    const sp = volumeSpikes(cs, { period: 20, minRel: 3, lookback: 30, minSamples: 10 });
    eq(sp.length, 0, "idx 0 의 100 짜리 봉은 기준선 표본이 0 이라 배수를 못 매긴다");

    // 앞에 10봉을 채워주면 같은 급증이 잡힌다 — 가드가 데이터 부족에만 반응하는지 확인.
    const ok = [...normal(10), sbar(100, 0.8, 0.9), ...normal(3)];
    eq(volumeSpikes(ok, { period: 20, minRel: 3, lookback: 30, minSamples: 10 }).length, 1);
  });

  test("급증 배수 — 기준선에 급증 봉 이후 봉이 섞이면 안 된다", () => {
    const base = [...normal(20), sbar(100, 0.8, 0.9)];
    const first = volumeSpikes(base, { period: 20, minRel: 3 })[0].relVol;
    // 뒤에 더 큰 봉을 붙여도 앞 급증의 배수는 그대로여야 한다.
    const later = [...base, sbar(500, 0.8, 0.9)];
    const again = volumeSpikes(later, { period: 20, minRel: 3 }).find((x) => x.idx === 20).relVol;
    approx(again, first, 1e-9, "미래 봉이 과거 봉의 기준선을 바꾸면 룩어헤드다");
  });

  test("급증 봉 — 최근 것이 먼저, 표본 부족하면 빈 배열", () => {
    const cs = [...normal(20), sbar(100, 0.8, 0.9), ...normal(5), sbar(200, 0.2, 0.1)];
    const sp = volumeSpikes(cs, { period: 20, minRel: 3 });
    assert(sp.length >= 2, `급증 2개 이상 (${sp.length})`);
    assert(sp[0].barsAgo < sp[1].barsAgo, "최근 것이 [0]");
    eq(volumeSpikes(normal(5), { period: 20, minRel: 3 }).length, 0, "봉 모자라면 빈 배열");
    eq(volumeSpikes(null).length, 0, "입력 없음도 안전");
  });

  suite("indicators");

  test("SMA 마지막값", () => {
    const s = sma([1, 2, 3, 4, 5], 3);
    approx(s[4], 4, 1e-9, "SMA(3) of [3,4,5]");
    eq(s[1], null, "period 이전은 null");
  });

  test("EMA 시드=SMA", () => {
    const e = ema([1, 2, 3, 4, 5], 3);
    approx(e[2], 2, 1e-9, "첫 EMA=SMA(3)=2");
    assert(e[4] > e[3], "EMA 증가");
  });

  test("RSI 단조증가 → 100", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 10 + i);
    const r = rsi(closes, 14);
    approx(last(r), 100, 1e-6, "모두 상승이면 RSI 100");
  });

  test("RSI 단조감소 → 0", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 30 - i);
    const r = rsi(closes, 14);
    approx(last(r), 0, 1e-6, "모두 하락이면 RSI 0");
  });

  test("ATR 일정 레인지", () => {
    // 매 캔들 high-low=2, 갭 없음 → ATR≈2
    const candles = Array.from({ length: 30 }, (_, i) => mkCandle(10, 11, 9, 10, i));
    const a = atr(candles, 14);
    approx(last(a), 2, 1e-6, "일정 TR=2 → ATR=2");
  });

  test("Bollinger 중심=SMA", () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i));
    const bb = bollinger(closes, 20, 2);
    const s = sma(closes, 20);
    approx(last(bb.mid), last(s), 1e-9, "BB mid = SMA20");
    assert(last(bb.upper) > last(bb.mid), "upper>mid");
    assert(last(bb.lower) < last(bb.mid), "lower<mid");
  });

  test("VWAP UTC 일 리셋", () => {
    // 하루 경계 넘는 캔들: 두 번째 날 첫 캔들 VWAP = 그 캔들 typical
    const day = 86_400_000;
    const c = [
      { openTime: 0, high: 10, low: 10, close: 10, volume: 5 },
      { openTime: day, high: 20, low: 20, close: 20, volume: 3 }, // 새 날
    ];
    const v = dailyVwap(c);
    approx(v[1], 20, 1e-9, "새 날 첫 캔들 VWAP=typical");
  });

  test("MACD 라인 길이/히스토그램", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    const m = macd(closes, 12, 26, 9);
    eq(m.macdLine.length, closes.length, "길이 일치");
    assert(last(m.macdLine) > 0, "상승추세 MACD>0");
  });

  test("OBV 방향", () => {
    const c = candlesFromCloses([10, 11, 12, 11, 13], { vol: 100 });
    const o = obv(c);
    assert(last(o) != null, "OBV 계산됨");
  });
}
