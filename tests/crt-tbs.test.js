import { suite, test, eq, assert, approx } from "./harness.js";
import { evaluateCrtTbs, crtMatchesCandidate } from "../js/core/crt-tbs.js";
import { crtBadge, crtSection } from "../js/ui/crt-tbs.js";
import { applyFilters } from "../js/ui/settings.js";
import { state } from "../js/state.js";
import { CONFIG } from "../js/config.js";

const M5 = 300000, H4 = 48 * M5, start = 1700006400000;
function bar(t, o, h, l, c, interval = M5) {
  return { openTime: t, closeTime: t + interval - 1, open: o, high: h, low: l, close: c, volume: 100 };
}
export function crtFixture(pattern = [[101, 102, 98, 99], [99, 102, 99, 101], [101, 104, 100, 103]]) {
  const h4 = [bar(start - H4, 105, 120, 100, 101, H4)];
  const m5 = Array.from({ length: 20 }, (_, i) => bar(start - (20 - i) * M5, 101, 102, 100, 101));
  m5.push(...pattern.map((p, i) => bar(start + i * M5, ...p)));
  return { h4, m5, now: start + pattern.length * M5 };
}
const evaluate = (f, options = {}) => evaluateCrtTbs(f.h4, f.m5, { now: f.now, ...options });
const mirror = (c) => ({ ...c, open: 220 - c.open, close: 220 - c.close, high: 220 - c.low, low: 220 - c.high });

export function run() {
  suite("CRT + TBS");
  test("롱: 몸통 이탈 → 복귀 → 다음 봉 전환 및 비용 반영 계획", () => {
    const c = evaluate(crtFixture());
    eq(c.status, "confirmed"); eq(c.direction, "long");
    assert(c.plan.invalidation < 98); eq(c.plan.entry, 103);
    eq(c.plan.tp1, 110); eq(c.plan.tp2, 120);
    assert(c.plan.netRR < c.plan.riskReward);
    approx(c.plan.lossPct, c.plan.stopPct + 0.2);
  });
  test("숏은 가격 반사 시 롱과 대칭적인 경계·방향", () => {
    const f = crtFixture(); const long = evaluate(f);
    f.h4 = f.h4.map(mirror); f.m5 = f.m5.map(mirror);
    const short = evaluate(f);
    eq(short.status, "confirmed"); eq(short.direction, "short");
    approx(short.plan.invalidation, 220 - long.plan.invalidation);
    eq(short.plan.tp1, 110); eq(short.plan.tp2, 100);
  });
  test("꼬리만 넘거나 경계에 딱 닿은 봉은 TBS가 아니다", () => {
    eq(evaluate(crtFixture([[101, 102, 98, 101]])).status, "range");
    eq(evaluate(crtFixture([[101, 102, 100, 100]])).status, "range");
  });
  test("복귀 봉만으로 확인하지 않고 이후 봉 전환을 요구", () => {
    eq(evaluate(crtFixture([[101, 102, 98, 99]])).status, "sweep");
    eq(evaluate(crtFixture([[101, 102, 98, 99], [99, 102, 99, 101]])).status, "reclaim");
  });
  test("진행 중 4h/5m와 미래 봉은 판정에 영향을 주지 않는다", () => {
    const f = crtFixture(), expected = evaluate(f);
    f.h4.push(bar(start, 101, 200, 1, 150, H4));
    f.m5.push(bar(f.now, 103, 200, 1, 150));
    eq(JSON.stringify(evaluate(f)), JSON.stringify(expected));
  });
  test("동일 봉 양방향 이탈은 순서를 추측하지 않는다", () => {
    eq(evaluate(crtFixture([[101, 121, 98, 99]])).status, "ambiguous");
  });
  test("복귀 이후 범위를 다시 잃으면 무효화", () => {
    eq(evaluate(crtFixture([[101, 102, 98, 99], [99, 102, 99, 101], [101, 102, 99, 99]])).status, "invalidated");
  });
  test("이미 중앙 목표를 찍은 확인은 추격에서 제외", () => {
    eq(evaluate(crtFixture([[101, 102, 98, 99], [99, 102, 99, 101], [101, 111, 100, 103]])).status, "late");
  });
  test("확인 이후 목표 도달과 손절 도달을 각각 처리", () => {
    const f = crtFixture();
    f.m5.push(bar(f.now, 103, 111, 102, 104)); f.now += M5;
    eq(evaluate(f).status, "late");
    f.m5[f.m5.length - 1] = bar(f.now - M5, 103, 104, 97, 101);
    eq(evaluate(f).status, "invalidated");
  });
  test("몸통 복귀 시간 제한", () => {
    const pattern = [[101, 102, 98, 99], ...Array.from({ length: 7 }, () => [99, 100, 98.5, 99])];
    eq(evaluate(crtFixture(pattern)).status, "expired");
  });
  test("복귀 후 전환 시간 제한", () => {
    const pattern = [[101, 102, 98, 99], [99, 102, 99, 101], ...Array.from({ length: 7 }, () => [101, 102, 100.5, 101])];
    eq(evaluate(crtFixture(pattern)).status, "expired");
  });
  test("오래된 확인을 새 진입으로 재사용하지 않는다", () => {
    const f = crtFixture();
    for (let i = 0; i < 4; i++) { f.m5.push(bar(f.now, 103, 104, 102, 103)); f.now += M5; }
    eq(evaluate(f).status, "expired");
  });
  test("비용 반영 손익비 문턱 미달이면 계획을 제시하지 않는다", () => {
    const f = crtFixture(); f.h4[0].high = 110;
    const c = evaluate(f); eq(c.status, "risk"); eq(c.plan, null);
  });
  test("현재 가격의 과도한 손절 거리를 배제", () => {
    const c = evaluate(crtFixture(), { config: { ...CONFIG, crtTbs: { ...CONFIG.crtTbs, maxStopPct: 1 } } });
    eq(c.status, "risk");
  });
  test("누락·중복·비정상 가격·오래된 시세는 보류", () => {
    const f = crtFixture(); f.m5.splice(20, 1); eq(evaluate(f).status, "unavailable");
    const d = crtFixture(); d.m5.push(d.m5.at(-1)); eq(evaluate(d).status, "unavailable");
    const n = crtFixture(); n.m5[10].close = NaN; eq(evaluate(n).status, "unavailable");
    const old = crtFixture(); old.now += M5 + 1; eq(evaluate(old).status, "unavailable");
  });
  test("새 4시간 봉이 마감되면 이전 범위 신호를 버린다", () => {
    const f = crtFixture();
    for (let i = 3; i < 48; i++) f.m5.push(bar(start + i * M5, 103, 104, 102, 103));
    f.h4.push(bar(start, 101, 104, 98, 103, H4)); f.now = start + H4;
    const c = evaluate(f); eq(c.status, "range"); eq(c.range.low, 98);
  });
  test("방향 일치한 확인만 필터에 통과하고 높은 반대 점수보다 우선", () => {
    const c = evaluate(crtFixture());
    const rows = [
      { symbol: "MATCH", scanMode: "early", direction: "long", score: 50, stage: { stage: 1 }, crtTbs: c },
      { symbol: "CONFLICT", scanMode: "early", direction: "long", score: 90, stage: { stage: 1 }, crtTbs: { ...c, direction: "short" } },
      { symbol: "OLD", scanMode: "early", direction: "long", score: 80, stage: { stage: 1 } },
    ];
    assert(crtMatchesCandidate(rows[0])); assert(!crtMatchesCandidate(rows[1]));
    const before = state.settings;
    try {
      state.settings = { ...before, scanMode: "early", crtTbsOnly: true, excluded: [], favorites: [], stageFilter: "all", showFavoritesOnly: false };
      const filtered = applyFilters(rows); eq(filtered.length, 1); eq(filtered[0].symbol, "MATCH");
    } finally { state.settings = before; }
  });
  test("상세에는 전용 손절·손실률·중앙 목표와 실험 안내가 나타난다", () => {
    const r = { direction: "long", crtTbs: evaluate(crtFixture()) };
    const html = crtSection(r);
    for (const word of ["손절 손실률", "목표 1", "목표 2", "비용 반영", "아직 측정하지"]) assert(html.includes(word));
    assert(crtBadge({ ...r, direction: "short" }).includes("방향 충돌"));
    assert(!crtSection({ crtTbs: { status: "unavailable", reason: "자료 부족" } }).includes("CRT 전용 검토 가격"));
  });
}
