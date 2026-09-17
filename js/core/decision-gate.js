// core/decision-gate.js — 점수를 바꾸지 않는 후보 검토 체크리스트.
// 검증되지 않은 새 가중치를 만들지 않고 계획·국면·전망·확인 신호의 충돌만 설명한다.

import { resultMode } from "../scan-modes.js";
import { currentCrtStatus } from "./crt-tbs.js";

const finite = Number.isFinite;

function item(key, level, label, detail) {
  return { key, level, label, detail };
}

function validGeometry(result) {
  const p = result?.plan;
  const entry = Number(p?.entry), stop = Number(p?.invalidation), target = Number(p?.tp2);
  if (!p?.valid || ![entry, stop, target].every(finite) || !(entry > 0)) return false;
  return result.direction === "short"
    ? stop > entry && target < entry
    : stop < entry && target > entry;
}

export function buildDecisionGate(result, now = Date.now()) {
  const checks = [];
  const mode = resultMode(result);
  const direction = result?.direction === "short" ? "short" : "long";

  if (mode === "sweep_retest") return buildSweepGate(result, now);

  if (validGeometry(result)) {
    checks.push(item("plan", "pass", "계획 유효", "진입·손절·목표의 방향과 거리가 유효합니다."));
  } else {
    checks.push(item("plan", "block", "계획 무효", "진입·손절·목표를 다시 계산해야 합니다."));
  }

  const stage = Number(result?.stage?.stage);
  if (mode === "reversal" && stage === 5) {
    checks.push(item("stage", "block", "추격 위험", "이미 늦은 구간으로 분류됐습니다."));
  } else if (mode === "pump_fade" && stage < 3) {
    checks.push(item("stage", "warn", "급락 확인 전", "고점 거절 뒤 구조 붕괴 확인이 아직 부족합니다."));
  } else if (mode === "early" && stage === 1) {
    checks.push(item("stage", "warn", "초기 관찰", "아직 임박·돌파 단계가 아닙니다."));
  } else {
    checks.push(item("stage", "pass", "단계 확인", result?.stage?.label || "현재 단계를 확인했습니다."));
  }

  if (result?.provisional) {
    checks.push(item("realtime", "warn", "진행 봉 포함", "캔들 마감 전 결과라 바뀔 수 있습니다."));
  }

  const regime = result?.marketRegime;
  const fit = result?.regimeFit;
  if (!regime?.available) {
    checks.push(item("regime", "info", "시장국면 보류", regime?.reason || "BTC 국면 자료가 부족합니다."));
  } else if (fit?.key === "counter") {
    checks.push(item("regime", "warn", "시장 흐름 역행", regime.label));
  } else if (fit?.key === "aligned") {
    checks.push(item("regime", "pass", "시장 흐름 우호", regime.label));
  } else {
    checks.push(item("regime", "info", "시장국면 중립", regime.label));
  }

  const forecast = result?.forecast;
  const expectedLead = direction === "short" ? "down" : "up";
  if (!forecast?.available) {
    checks.push(item("forecast", "info", "24h 전망 보류", forecast?.reason || "사용 가능한 전망이 없습니다."));
  } else if (forecast.lead === expectedLead) {
    checks.push(item("forecast", "pass", "24h 방향 일치", `${direction === "long" ? "상승" : "하락"} ${forecast[expectedLead]}% · 신뢰도 ${forecast.confidence}`));
  } else if (forecast.lead === "neutral") {
    checks.push(item("forecast", "warn", "24h 횡보 우세", `횡보 ${forecast.neutral}% · 계획 방향의 우세가 뚜렷하지 않습니다.`));
  } else {
    checks.push(item("forecast", "warn", "24h 방향 충돌", `후보는 ${direction.toUpperCase()}이지만 전망은 ${forecast.lead === "up" ? "상승" : "하락"} 우세입니다.`));
  }

  const crt = currentCrtStatus(result?.crtTbs, now);
  if (crt?.confirmed && crt.direction === direction) {
    checks.push(item("crt", "pass", "CRT 방향 확인", `${direction.toUpperCase()} 범위 복귀·전환 확인`));
  } else if (crt?.confirmed && crt.direction && crt.direction !== direction) {
    checks.push(item("crt", "warn", "CRT 방향 충돌", `CRT는 ${crt.direction.toUpperCase()} 방향입니다.`));
  } else {
    checks.push(item("crt", "info", "CRT 추가 확인 없음", crt?.reason || crt?.label || "독립 확인 신호가 없습니다."));
  }

  if ((result?.correlatedWith || []).length) {
    checks.push(item("correlation", "warn", "상관 위험", "함께 표시된 후보와 같은 방향으로 움직일 수 있습니다."));
  }

  const blockers = checks.filter((x) => x.level === "block").length;
  const warnings = checks.filter((x) => x.level === "warn").length;
  const passes = checks.filter((x) => x.level === "pass").length;
  const status = blockers ? "risk" : warnings ? "wait" : "review";
  const label = status === "risk" ? "리스크 높음" : status === "wait" ? "확인 대기" : "검토 후보";
  return {
    status,
    label,
    blockers,
    warnings,
    passes,
    checks,
    note: "후보 검토 체크리스트이며 매수·매도 지시나 성공 확률이 아닙니다.",
  };
}

function buildSweepGate(result, now) {
  const p = result?.sweepRetest || {};
  const expired = p.confirmed && (!finite(p.expiresAt) || now >= p.expiresAt);
  const stage = expired ? 4 : Number(p.stage || result?.stage?.stage || 0);
  const labels = ["급락 뒤 저거래량 매집", "15분 W·스윕·회수", "넥라인 돌파·거래량", "첫 눌림·Higher Low", "5분 전환·BTC 방어"];
  const checks = labels.map((label, i) => item(`pattern-${i + 1}`, stage > i ? "pass" : i === stage ? "warn" : "info",
    stage > i ? label : `${label} 대기`, stage > i ? "발생 순서와 마감봉 조건을 충족했습니다." : "앞 단계가 끝난 뒤에만 판정합니다."));
  const statusKey = expired ? "expired" : p.status;
  if (["invalid", "blocked"].includes(statusKey)) {
    checks.push(item("pattern-state", "block", p.label || "패턴 제외", p.reason || "무효화 조건이 발생했습니다."));
  } else if (["unavailable", "expired"].includes(statusKey)) {
    checks.push(item("pattern-state", "warn", p.label || "판정 보류", p.reason || "새 마감봉으로 다시 스캔해야 합니다."));
  }
  const blockers = checks.filter(x => x.level === "block").length;
  const warnings = checks.filter(x => x.level === "warn").length;
  const passes = checks.filter(x => x.level === "pass").length;
  const status = blockers ? "risk" : p.confirmed && !expired ? "review" : "wait";
  return { status, label: status === "risk" ? "패턴 제외" : status === "review" ? "검토 후보" : "순서 대기",
    blockers, warnings, passes, checks,
    note: "1~5는 패턴 진행도이며 점수·성공 확률·매수 지시가 아닙니다." };
}

export default { buildDecisionGate };
