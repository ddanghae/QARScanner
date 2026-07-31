// tests/strategies.test.js — 기존 두 모드 밖의 매매 방식 4종.
// 전부 미측정 전략이라 "리프트가 맞나" 는 여기서 못 본다. 대신 각 전략이
// **자기 정의를 배반하지 않는지** 를 본다 — 추세 추종이 하락에 점수를 주거나,
// 그리드가 수수료에 먹히는 계획을 내주면 그건 측정 이전의 결함이다.

import { suite, test, assert, approx, eq } from "./harness.js";
import { scoreTrendFollow, scoreNewListing, rangeGridPlan, pairDivergence } from "../js/core/strategies.js";

const bar = (c, t) => ({ openTime: t, time: t, open: c, high: c, low: c, close: c, volume: 1 });
const fromCloses = (closes) => closes.map((c, i) => bar(c, i * 3600_000));

export function run() {
  suite("추세 추종");

  // 조기 포착은 절대값을 써서 하락에도 점수를 준다. 이 전략이 그걸 물려받으면 존재 이유가 없다.
  test("하락에는 0점 — 절대값을 쓰면 조기 포착과 같아진다", () => {
    const up = { mom14: 40, change24h: 15, volExpand: 2.5, quoteVolume: 5e7 };
    const down = { mom14: -40, change24h: -15, volExpand: 2.5, quoteVolume: 5e7 };
    const u = scoreTrendFollow(up);
    // 조기 포착이었다면 절대값이라 up 과 down 이 같은 점수를 받는다. 그 대비가 이 테스트의 핵심.
    assert(u.score >= 50, `상승은 중간 이상 (${u.score})`);
    const d = scoreTrendFollow(down);
    assert(d.score < u.score / 2, `같은 크기의 하락은 절반 미만이어야 한다 (${d.score} vs ${u.score})`);
    eq(d.breakdown.find((b) => b.key === "mom14").got, 0, "하락 추세는 0점");
    eq(d.breakdown.find((b) => b.key === "chg24").got, 0, "하락 변동도 0점");
  });

  test("과열 감점 — 이미 크게 오른 건 추세 추종이 아니라 꼭지 잡기", () => {
    const hot = { mom14: 80, change24h: 150, volExpand: 3, quoteVolume: 5e7 };
    const p = scoreTrendFollow(hot).penalties;
    assert(p.some((x) => x.key === "runaway"), "runawayPct 초과 시 감점이 붙어야 한다");
  });

  test("거래대금 부족 감점 · 점수는 0~100 밖으로 안 나간다", () => {
    const thin = { mom14: 60, change24h: 30, volExpand: 4, quoteVolume: 1e5 };
    const r = scoreTrendFollow(thin);
    assert(r.penalties.some((x) => x.key === "thinLiquidity"));
    assert(r.score >= 0 && r.score <= 100, `범위 안 (${r.score})`);
    eq(scoreTrendFollow({}).score, 0, "값이 없으면 0점 — 결측을 중립으로 대우하지 않는다");
  });

  suite("신규 상장");

  test("대상 밖 · 봉 부족은 점수를 매기지 않고 보류한다", () => {
    eq(scoreNewListing({ ageDays: 300 }).eligible, false, "오래된 종목은 대상 아님");
    const few = scoreNewListing({ ageDays: 2, barCount: 6, quoteVolume: 1e8, boxWidthPct: 30 });
    eq(few.eligible, false, "봉 6개로 지표를 믿으면 안 된다");
    assert(few.reason.includes("6"), "몇 개인지 알려줘야 한다");
    eq(few.score, 0);
  });

  test("상장 직후일수록 높다", () => {
    const m = (d, bars = 100) => ({ ageDays: d, barCount: bars, quoteVolume: 5e7, boxWidthPct: 20 });
    const d2 = scoreNewListing(m(2)).score, d10 = scoreNewListing(m(10)).score;
    assert(d2 > d10, `2일차(${d2}) > 10일차(${d10})`);
  });

  // 상장 초기의 진짜 위험은 점수가 아니라 "warm-up 못 채운 지표를 믿는 것" 이다.
  test("봉 수에 따라 못 믿을 지표를 지목한다", () => {
    eq(scoreNewListing({ ageDays: 1, barCount: 35, quoteVolume: 5e7, boxWidthPct: 20 }).unreliable
      .includes("ema200"), true, "35봉으로 EMA200 은 불가");
    const many = scoreNewListing({ ageDays: 1, barCount: 250, quoteVolume: 5e7, boxWidthPct: 20 });
    eq(many.unreliable.length, 0, "250봉이면 다 쓸 수 있다");
  });

  suite("횡보 그리드");

  // 이 전략에서 유일하게 구조적인 손실 원인. 칸을 촘촘히 깔수록 수수료에 먹힌다.
  test("칸 수익이 왕복 비용을 못 넘으면 계획을 내주지 않는다", () => {
    // 박스 폭 4%, 20칸 → 칸당 0.2% = 비용과 동일 → 남는 게 없다
    const tight = rangeGridPlan(
      { boxHigh: 104, boxLow: 100, boxWidthPct: 4, squeezePct: 20 },
      { grids: 20, roundTripCostPct: 0.2 });
    eq(tight.viable, false, "칸당 0.2% 로는 비용도 못 건진다");
    assert(tight.reason.includes("비용"), "이유가 비용임을 밝혀야 한다");

    // 같은 박스를 5칸으로 → 칸당 0.8%
    const ok = rangeGridPlan(
      { boxHigh: 104, boxLow: 100, boxWidthPct: 4, squeezePct: 20 },
      { grids: 5, roundTripCostPct: 0.2 });
    eq(ok.viable, true);
    approx(ok.plan.perGridPct, 0.8, 1e-9);
    approx(ok.plan.netPerGridPct, 0.6, 1e-9, "비용 뺀 실수익");
  });

  test("박스가 아니면 거른다 — 넓으면 추세, 변동성 확장 중이면 곧 깨진다", () => {
    eq(rangeGridPlan({ boxHigh: 150, boxLow: 100, boxWidthPct: 50, squeezePct: 20 }).viable, false);
    eq(rangeGridPlan({ boxHigh: 104, boxLow: 100, boxWidthPct: 4, squeezePct: 90 }).viable, false);
    eq(rangeGridPlan({}).viable, false, "박스 없음도 안전하게");
  });

  test("격자와 이탈 손절 — 위아래 둘 다 있어야 한다", () => {
    const r = rangeGridPlan({ boxHigh: 110, boxLow: 100, boxWidthPct: 10, squeezePct: 20 },
      { grids: 5, roundTripCostPct: 0.2, stopBufferPct: 1.5 });
    eq(r.plan.levels.length, 6, "5칸이면 경계는 6개");
    approx(r.plan.levels[0], 100, 1e-9);
    approx(r.plan.levels[5], 110, 1e-9);
    assert(r.plan.stopAbove > 110 && r.plan.stopBelow < 100, "박스 이탈은 양방향 손실이다");
  });

  suite("페어 트레이딩");

  test("상관이 낮으면 신호를 내지 않는다", () => {
    // 서로 무관하게 움직이는 두 종목 — 우연히 벌어져도 페어가 아니다
    const a = fromCloses([100, 110, 105, 118, 112, 125, 120, 135, 130, 145, 140, 155,
      150, 165, 160, 175, 170, 185, 180, 195, 190, 205, 200, 215, 210, 225, 220, 235, 230, 245, 240]);
    const b = fromCloses([100, 95, 103, 92, 105, 90, 108, 88, 110, 86, 112, 84,
      114, 82, 116, 80, 118, 78, 120, 76, 122, 74, 124, 72, 126, 70, 128, 68, 130, 66, 132]);
    const r = pairDivergence(a, b, { lookback: 30, minCorr: 0.7, minSamples: 25 });
    eq(r.signal, false);
    assert(r.reason.includes("상관"), "상관 때문임을 밝혀야 한다");
  });

  test("같이 가다 벌어지면 앞서간 쪽을 숏, 뒤처진 쪽을 롱", () => {
    // 30봉을 ±3% 로 똑같이 흔들리다가, 마지막 6봉에서 A 만 매번 0.6% 씩 더 간다.
    // 이탈은 공통 변동보다 작아야 한다 — 크게 잡으면 A 의 분산이 공통 움직임을 덮어
    // 상관이 무너지고, 그건 "같이 움직이던 둘" 이라는 전제 자체가 깨진 것이다.
    const common = 0.03, drift = 0.006;
    const aCloses = [100], bCloses = [50];   // 단가가 달라도 수익률로 비교하므로 상관없다
    const step = (i) => (i % 2 ? common : -common * 0.85);
    for (let i = 1; i < 31; i++) {
      aCloses.push(aCloses[i - 1] * (1 + step(i)));
      bCloses.push(bCloses[i - 1] * (1 + step(i)));
    }
    for (let i = 0; i < 6; i++) {
      aCloses.push(aCloses[aCloses.length - 1] * (1 + step(i) + drift));
      bCloses.push(bCloses[bCloses.length - 1] * (1 + step(i)));
    }
    const r = pairDivergence(fromCloses(aCloses), fromCloses(bCloses),
      { lookback: 30, minCorr: 0.7, minZ: 1.2, minSamples: 25 });
    eq(r.signal, true, `신호가 떠야 한다 (${r.reason})`);
    assert(r.corr > 0.9, `공통 변동이 크므로 상관은 높게 유지 (${r.corr?.toFixed(3)})`);
    assert(r.z > 0, `A 가 앞서갔으므로 z 양수 (${r.z?.toFixed(2)})`);
    eq(r.short, "A", "앞서간 쪽을 숏");
    eq(r.long, "B", "뒤처진 쪽을 롱");
  });

  test("평소 범위 안이면 신호 없음 · 표본 부족도 안전", () => {
    const same = fromCloses(Array.from({ length: 40 }, (_, i) => 100 * (1 + (i % 2 ? 0.01 : -0.01))));
    eq(pairDivergence(same, same, { lookback: 30, minSamples: 25 }).signal, false,
      "완전히 같이 움직이면 벌어진 게 없다");
    eq(pairDivergence(fromCloses([100, 101]), fromCloses([100, 101]), { lookback: 30 }).signal, false);
  });
}
