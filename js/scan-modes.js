// scan-modes.js — 스캔 모드 식별자와 표시 메타데이터의 단일 출처.

// 제품에서는 조기 포착 하나만 실행한다. 예전 전략 코어는 연구 비교용으로만 보존한다.
export const SCAN_MODES = ["early"];

export const SCAN_MODE_META = {
  early: { label: "조기 포착", shortLabel: "조기", badge: "early" },
  // 과거 모의 기록/회귀 결과를 읽기 위한 표시 메타데이터. 새 스캔에는 포함되지 않는다.
  reversal: { label: "급락 반등 (과거)", shortLabel: "반등", badge: "reversal" },
  pump_fade: { label: "급등 후 급락 (과거)", shortLabel: "급락", badge: "pump-fade" },
  sweep_retest: { label: "스윕 후 첫 눌림 확인", shortLabel: "첫 눌림", badge: "sweep" },
};

export function resultMode(result) {
  return result?.scanMode && SCAN_MODE_META[result.scanMode] ? result.scanMode : "early";
}

export function modesForScan(scanMode) {
  return [SCAN_MODES.includes(scanMode) ? scanMode : "early"];
}

export function resultKey(result) {
  return `${resultMode(result)}:${result?.symbol || ""}`;
}

export default { SCAN_MODES, SCAN_MODE_META, resultMode, modesForScan, resultKey };
