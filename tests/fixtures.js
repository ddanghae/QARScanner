// tests/fixtures.js — 고정 OHLCV 샘플 생성 헬퍼.

const HOUR = 3600_000;

// closes 배열 → 캔들 배열 (간단: high/low 를 close 주변으로 생성, taker 절반)
export function candlesFromCloses(closes, opts = {}) {
  const { start = 1_700_000_000_000, step = HOUR, spread = 0.5, buyRatio = 0.5, vol = 100 } = opts;
  let prev = closes[0];
  return closes.map((c, i) => {
    const open = i === 0 ? c : prev;
    prev = c;
    // high/low 를 close 기준으로 만들어 인접 캔들 간 극값 동률(tie)을 피한다.
    // (합성 데이터에서 pivot 이 사라지는 문제 방지 — 실거래 데이터는 동률이 드묾)
    const high = c + spread;
    const low = c - spread;
    const volume = typeof vol === "function" ? vol(i) : vol;
    const takerBuyBase = volume * (typeof buyRatio === "function" ? buyRatio(i) : buyRatio);
    return {
      openTime: start + i * step,
      open, high, low, close: c,
      volume, closeTime: start + (i + 1) * step - 1,
      quoteVolume: volume * c, trades: 100,
      takerBuyBase, takerBuyQuote: takerBuyBase * c,
      takerSellBase: volume - takerBuyBase,
    };
  });
}

// 명시적 OHLC 캔들
export function mkCandle(o, h, l, c, i = 0, volume = 100, buy = 50) {
  return {
    openTime: 1_700_000_000_000 + i * HOUR,
    open: o, high: h, low: l, close: c,
    volume, closeTime: 0, quoteVolume: volume * c, trades: 100,
    takerBuyBase: buy, takerBuyQuote: buy * c, takerSellBase: volume - buy,
  };
}

// 지그재그 생성기: 스윙 앵커 사이를 선형 보간. 4봉 레그 → length2 pivot 이 앵커에 정확히 잡힘.
export function zigzag(anchors, legLen = 4) {
  const closes = [];
  for (let a = 0; a < anchors.length - 1; a++) {
    const from = anchors[a], to = anchors[a + 1];
    for (let s = 0; s < legLen; s++) closes.push(from + (to - from) * (s / legLen));
  }
  closes.push(anchors[anchors.length - 1]);
  return closes;
}

// 상승 추세 (HH/HL): 저점 10→12→14, 고점 15→18→21
export const uptrend = candlesFromCloses(
  zigzag([10, 15, 12, 18, 14, 21, 16, 24]), { spread: 0.4 }
);

// 하락 후 저점 스윕 + 회복 시나리오
export const sweepRecovery = candlesFromCloses(
  [20,19,18,17,16,15,14.5,15,16,15.5,15,14.8,14.9,15.2,15,14.7, /* prior low ~14.7 */
   15.1,15.3,15.0,14.6, /* dip below then... */ 15.4,15.8,16.2,16.0,16.5,17.0,16.8,17.2,17.5,17.3]
);
