// tests/early-selection.test.js — 조기 포착 후보/확인 대상이 같은 기본 필터를 쓰는지 검증.

import { suite, test, assert, eq } from "./harness.js";
import { CONFIG } from "../js/config.js";
import { scoreEarly } from "../js/core/early-detect.js";
import {
  filterEarlyReviewCandidates,
  rankEarlyReviewCandidates,
  selectEarlyConfirmationTargets,
} from "../js/core/early-selection.js";
import { stage3EvaluateEarly } from "../js/scanner/prefilter.js";
import { candlesFromCloses } from "./fixtures.js";

function earlyResult(symbol, score, over = {}) {
  return {
    scanMode: "early",
    symbol,
    score,
    quoteVolume: 20_000_000,
    newListing: false,
    stage: { stage: 3 },
    ...over,
  };
}

export function run() {
  suite("early selection");

  test("1차 선별 우선순위는 최종 검증 점수와 같은 입력을 쓴다", () => {
    const now = Date.UTC(2026, 8, 19);
    const onboardDate = now - 100 * 86_400_000;
    const closes = Array.from({ length: 200 }, (_, i) => 100 * Math.pow(1.004, i));
    const candles = candlesFromCloses(closes, { spread: 0.05 });
    const item = { symbol: "PRIORITYUSDT", onboardDate, change24h: 16, quoteVolume: 20_000_000 };
    const prefilter = stage3EvaluateEarly(item, candles, CONFIG, now);
    const expected = scoreEarly({
      mom14Abs: Math.abs(prefilter.mom14),
      change24h: item.change24h,
      ageDays: 100,
      quoteVolume: item.quoteVolume,
    }, CONFIG).score;

    assert(prefilter.pass, "큰 14일 추세는 후보여야 한다");
    eq(prefilter.priority, expected, "압축률이 아닌 검증 점수로 우선순위를 계산한다");
  });

  test("확인 대상은 화면 기본 필터(점수·관심·제외·단계)를 모두 반영한다", () => {
    const results = [
      earlyResult("BETAUSDT", 80, { quoteVolume: 10_000_000 }),
      earlyResult("ALPHAUSDT", 80, { quoteVolume: 20_000_000 }),
      earlyResult("CHASEUSDT", 99, { stage: { stage: 5 } }),
      earlyResult("NEWUSDT", 95, { newListing: true }),
      earlyResult("LOWUSDT", CONFIG.earlyMinScore - 1),
      earlyResult("OFFUSDT", 94),
      { ...earlyResult("OTHERUSDT", 100), scanMode: "reversal" },
    ];
    const settings = {
      showFavoritesOnly: true,
      favorites: ["ALPHAUSDT", "BETAUSDT", "CHASEUSDT", "NEWUSDT", "LOWUSDT"],
      excluded: ["BETAUSDT"],
      excludeChaseBan: true,
      excludeNewListing: true,
      stageFilter: "3",
    };
    const selected = filterEarlyReviewCandidates(results, settings, CONFIG);

    eq(selected.length, 1, "모든 기본 필터를 통과한 후보만 남는다");
    eq(selected[0].symbol, "ALPHAUSDT");
  });

  test("동점 순위는 거래량·심볼로 안정화되고, 확인은 상위 N개만 한다", () => {
    const results = [
      earlyResult("BETAUSDT", 80, { quoteVolume: 10_000_000 }),
      earlyResult("ALPHAUSDT", 80, { quoteVolume: 10_000_000 }),
      earlyResult("GAMMAUSDT", 80, { quoteVolume: 20_000_000 }),
      earlyResult("DELTAUSDT", 79),
    ];
    const ranked = rankEarlyReviewCandidates(results);
    eq(ranked.map((r) => r.symbol).join(","), "GAMMAUSDT,ALPHAUSDT,BETAUSDT,DELTAUSDT");

    const top = selectEarlyConfirmationTargets(results, {}, { ...CONFIG, earlyKeepTop: 3 });
    eq(top.map((r) => r.symbol).join(","), "GAMMAUSDT,ALPHAUSDT,BETAUSDT");
  });
}
