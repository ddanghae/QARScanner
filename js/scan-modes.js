// scan-modes.js — 스캔 모드 식별자와 표시 메타데이터의 단일 출처.

export const SCAN_MODES = ["reversal", "early", "pump_fade", "sweep_retest"];

export const SCAN_MODE_META = {
  reversal: { label: "급락 반등", shortLabel: "반등", badge: "reversal" },
  early: { label: "조기 포착", shortLabel: "조기", badge: "early" },
  pump_fade: { label: "급등 후 급락", shortLabel: "급락", badge: "pump-fade" },
  sweep_retest: { label: "스윕 후 첫 눌림", shortLabel: "첫 눌림", badge: "sweep" },
};

export function resultMode(result) {
  return SCAN_MODES.includes(result?.scanMode) ? result.scanMode : "reversal";
}

export function modesForScan(scanMode) {
  return scanMode === "all" ? SCAN_MODES.slice()
    : [SCAN_MODES.includes(scanMode) ? scanMode : "reversal"];
}

export function resultKey(result) {
  return `${resultMode(result)}:${result?.symbol || ""}`;
}

export default { SCAN_MODES, SCAN_MODE_META, resultMode, modesForScan, resultKey };
